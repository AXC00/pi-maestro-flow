/** Lifecycle owner for the one packaged Gateway daemon. */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GatewayConfig } from "./config.ts";
import { gatewayTunnelProfileInput, FABRIC_DEFAULT_AUDIENCE, loadGatewayConfig } from "./config.ts";
import { GATEWAY_PROTOCOL_VERSION, type GatewayOwnerRecord } from "./contracts.ts";
import type { GatewayHttpServerHandle } from "./http-server.ts";
import { GatewayHttpAuth, isLoopbackHost } from "./auth.ts";
import { gatewayIpcAddress, startGatewayIpcServer, type GatewayIpcServerHandle } from "./ipc.ts";
import { GatewayOwnerStore } from "./owner-store.ts";
import { GatewayRuntime, type GatewayRuntimeOptions } from "./runtime.ts";
import { FabricConnectorSecurity } from "./fabric/security.ts";
import { FabricWssServer, type FabricWssAuthority } from "./fabric/wss-server.ts";
import { FabricHubRelay, type FabricDeviceRelayExecutionHandler } from "./fabric/hub-relay.ts";
import { principalKey } from "./principal.ts";
import { FABRIC_PAIRING_AUDIENCE } from "./fabric/pairing-adapter.ts";
import { FABRIC_ENROLL_SCOPE, FABRIC_PAIRING_PROVIDER, FABRIC_ROTATE_SCOPE } from "./fabric/registration.ts";
import { fabricConnectorConfigPath, loadFabricConnectorConfig, type FabricConnectorConfigV1 } from "./fabric/connector-config.ts";
import { FabricConnectorService } from "./fabric/connector-service.ts";
import {
  FabricOriginDataPlaneGrantAuthority,
  type FabricOriginGrantAcquireRequest,
  type FabricOriginGrantIdentity,
} from "./fabric/origin-runtime.ts";
import { createFabricDeviceRelayHandler } from "./fabric/device-runtime.ts";
import type {
  FabricDeviceSourceAvailability,
  FabricDeviceSourceRestrictions,
} from "./fabric/connector-inventory.ts";
import type { FabricAdvertisementDelta, FabricAdvertisementSnapshot, FabricConnectionManager } from "pi-maestro-fabric";
import { FabricContractError, assertFabricIdentifier, type JsonValue } from "pi-maestro-fabric-core/v1";
import {
  createFabricTeammateRuntimePort,
  getFabricTeammateRuntimePort,
  registerFabricTeammateRuntimePort,
  type FabricTeammateRuntimePort,
  type FabricTeammateRuntimeRegistration,
} from "pi-maestro-teammate/v1/fabric-runtime";
import { GatewayControlDispatcher, type GatewayControlHandler, type GatewayTunnelControlAction } from "./control-dispatcher.ts";
import type { GatewayTunnelProvider } from "./tunnel/contracts.ts";
import { GatewayTunnelManager } from "./tunnel/provider.ts";
import { CloudflareQuickTunnelProvider } from "./tunnel/providers/cloudflare.ts";
import { OpenAiTunnelProvider } from "./tunnel/providers/openai.ts";
import { SshReverseTunnelProvider } from "./tunnel/providers/ssh-reverse.ts";
import {
  GATEWAY_TUNNEL_AUDIENCE,
  gatewayTunnelMcpCredentialPolicy,
} from "./tunnel/mcp-access.ts";
import { canonicalizeGatewayPairingAudience } from "./pairing-store.ts";

interface FabricTeammateRuntimeSourcePort extends FabricTeammateRuntimePort {
  getSourceAvailability?(request: { readonly cwd: string }): Promise<FabricDeviceSourceAvailability | undefined>;
}

export class GatewayDaemonOwnershipError extends Error {
  constructor(message = "Gateway daemon ownership changed during startup") {
    super(message);
    this.name = "GatewayDaemonOwnershipError";
  }
}

export interface GatewayDaemonOptions extends Omit<GatewayRuntimeOptions, "config"> {
  config?: GatewayConfig;
  ownerStore?: GatewayOwnerStore;
  ipcAddress?: string;
  http?: boolean;
  httpHost?: string;
  httpPort?: number;
  httpPath?: string;
  commandIdentity?: string;
  /** Provider-neutral tunnels always enter through the audited local dispatcher. */
  tunnelProviders?: readonly GatewayTunnelProvider[];
  tunnelManager?: GatewayTunnelManager;
  tunnelStateRoot?: string;
  tunnelControlHandlers?: Partial<Record<GatewayTunnelControlAction, GatewayControlHandler>>;
  /** Explicit Connector lifecycle seam; production composes from local enrollment config. */
  fabricConnectorService?: FabricConnectorService;
  /** Explicit daemon-local execution port; it is never rediscovered by the Device runtime. */
  fabricTeammateRuntimePort?: FabricTeammateRuntimeSourcePort;
  fabricDeviceSourceAvailability?: FabricDeviceSourceAvailability;
  fabricDeviceSourceRestrictions?: FabricDeviceSourceRestrictions;
  /** Compatibility/test seam. Production constructs the handler from the exact prepared inventory. */
  fabricDeviceRelayHandler?: FabricDeviceRelayExecutionHandler;
  shutdownTimeoutMs?: number;
}

export class GatewayDaemon {
  readonly options: GatewayDaemonOptions;
  config?: GatewayConfig;
  runtime?: GatewayRuntime;
  owner?: GatewayOwnerRecord;
  ipc?: GatewayIpcServerHandle;
  http?: GatewayHttpServerHandle;
  /** Optional loopback-only MCP/OAuth listener used by enabled tunnel profiles. */
  tunnelHttp?: GatewayHttpServerHandle;
  controlDispatcher?: GatewayControlDispatcher;
  tunnelManager?: GatewayTunnelManager;
  fabricSecurity?: FabricConnectorSecurity;
  fabricWss?: FabricWssServer;
  fabricConnectorService?: FabricConnectorService;
  fabricOriginDataPlaneGrants?: FabricOriginDataPlaneGrantAuthority;
  private fabricConnectorConfigurationInvalid = false;
  private fabricTeammateRuntime?: FabricTeammateRuntimeRegistration;
  private disposeFabricRemoteRouteCloser?: () => void;
  private ownerStore?: GatewayOwnerStore;
  private stopping?: Promise<void>;
  private stopped: Promise<void> = Promise.resolve();
  private resolveStopped?: () => void;

  constructor(options: GatewayDaemonOptions = {}) {
    this.options = options;
  }

  async start(): Promise<this> {
    if (this.owner) return this;
    this.stopped = new Promise<void>((resolve) => { this.resolveStopped = resolve; });
    const config = this.options.config ?? await loadGatewayConfig(this.options.configPath);
    assertGatewayTunnelMcpAccessContracts(config);
    this.config = config;
    const enableHttp = this.options.http ?? config.transport.http.enabled;
    if (config.fabric.enabled && (!enableHttp || config.transport.http.tls?.enabled !== true)) {
      throw new Error("Fabric requires the Gateway HTTPS listener; enable transport.http.tls or disable fabric");
    }
    const store = this.options.ownerStore ?? new GatewayOwnerStore({
      ownerPath: config.state.ownerPath,
      commandIdentity: this.options.commandIdentity ?? (process.argv.join(" ") || process.execPath),
    });
    this.ownerStore = store;
    const address = this.options.ipcAddress ?? gatewayIpcAddress(undefined, store.ownerPath);
    const commandIdentity = this.options.commandIdentity ?? (process.argv.join(" ") || process.execPath);
    const owner = await store.claim({ socket: address, commandIdentity });
    this.owner = owner;
    const assertOwnerCurrent = async (): Promise<void> => {
      const current = await store.read();
      if (current?.ownerToken !== owner.ownerToken || current.startedAt !== owner.startedAt) {
        throw new GatewayDaemonOwnershipError();
      }
    };
    try {
      const hubRuntimeEpoch = `hub-${randomUUID()}`;
      const daemonGeneration = `daemon-${randomUUID()}`;
      let runtimeAuthority: GatewayRuntime | undefined;
      const fabricOriginDataPlaneGrants = !config.fabric.enabled ? undefined : new FabricOriginDataPlaneGrantAuthority({
        hubRuntimeEpoch,
        daemonGeneration,
        maxActiveGrants: config.limits.maxConcurrentRequests,
        authority: {
          routeOf: (routeId) => {
            const admissions = runtimeAuthority?.fabricControlRuntime?.admissions;
            if (admissions === undefined) throw new FabricContractError("unavailable", "Fabric origin route authority is unavailable");
            return admissions.validateRoute(routeId);
          },
          endpointOf: (endpointId) => runtimeAuthority?.fabricControlRuntime?.directory.getEndpoint(endpointId),
        },
      });
      const runtime = await GatewayRuntime.create({
        ...this.options,
        config,
        fabricOriginDataPlaneGrants,
        fabricHttpChannelEnabled: this.options.fabricHttpChannelEnabled ?? config.fabric.enabled,
      });
      runtimeAuthority = runtime;
      this.runtime = runtime;
      this.fabricOriginDataPlaneGrants = fabricOriginDataPlaneGrants;
      if (config.fabric.enabled) this.fabricTeammateRuntime = registerDefaultFabricTeammateRuntime();
      const deviceTeammateRuntime = (this.options.fabricTeammateRuntimePort
        ?? this.fabricTeammateRuntime?.port
        ?? getFabricTeammateRuntimePort()
        ?? createFabricTeammateRuntimePort()) as FabricTeammateRuntimeSourcePort;
      this.fabricConnectorService = this.options.fabricConnectorService;
      if (this.fabricConnectorService === undefined) {
        let connectorConfig: FabricConnectorConfigV1 | undefined;
        try {
          connectorConfig = await loadFabricConnectorConfig(fabricConnectorConfigPath(runtime.cwd));
        } catch {
          // Connector configuration cannot authorize an outbound connection,
          // but it does not take down the otherwise generic local Gateway.
          this.fabricConnectorConfigurationInvalid = true;
        }
        await assertOwnerCurrent();
        if (connectorConfig !== undefined && !this.fabricConnectorConfigurationInvalid) {
          try {
            this.fabricConnectorService = new FabricConnectorService({
              root: runtime.cwd,
              registry: runtime.registry,
              policy: runtime.policy,
              owner: { ownerToken: owner.ownerToken, ownerEpoch: owner.startedAt },
              initialConfig: connectorConfig,
              resolveSourceAvailability: async (_currentConfig, signal) => {
                if (signal.aborted) throw new FabricContractError("cancelled", "Connector source availability resolution was cancelled");
                if (this.options.fabricDeviceSourceAvailability !== undefined) {
                  return structuredClone(this.options.fabricDeviceSourceAvailability);
                }
                try {
                  const availability = await deviceTeammateRuntime.getSourceAvailability?.({ cwd: runtime.cwd });
                  if (signal.aborted) throw new FabricContractError("cancelled", "Connector source availability resolution was cancelled");
                  return availability === undefined ? undefined : structuredClone(availability);
                } catch (error) {
                  if (signal.aborted) throw error;
                  return undefined;
                }
              },
              resolveSourceRestrictions: (currentConfig) => {
                const restrictions = this.options.fabricDeviceSourceRestrictions ?? currentConfig.agentSources;
                return restrictions === undefined ? undefined : structuredClone(restrictions);
              },
              ...(this.options.fabricDeviceRelayHandler === undefined ? {
                deviceRelayHandlerFactory: (prepared, lifecycle) => createFabricDeviceRelayHandler({
                  prepared,
                  registry: runtime.registry,
                  policy: runtime.policy,
                  runtime: deviceTeammateRuntime,
                  assertCurrent: (authority) => lifecycle.assertCurrent(authority.connectionGeneration),
                }),
              } : { deviceRelayHandler: this.options.fabricDeviceRelayHandler }),
              assertOwner: async (expected) => {
                const current = await store.read();
                if (current?.ownerToken !== expected.ownerToken || current.startedAt !== expected.ownerEpoch) {
                  throw new GatewayDaemonOwnershipError("Gateway daemon ownership changed");
                }
              },
            });
          } catch {
            this.fabricConnectorConfigurationInvalid = true;
          }
        }
      }
      if (config.fabric.enabled) {
        const credentialAuthority = runtime.fabricRegistration;
        if (credentialAuthority === undefined) throw new Error("Fabric requires the runtime registration authority");
        this.fabricSecurity = new FabricConnectorSecurity({
          audience: config.fabric.audience ?? FABRIC_DEFAULT_AUDIENCE,
          credentialAuthority,
        });
        runtime.setFabricPostCommitFence(async (connectorId, operation) => {
          if (operation !== "rotate" && operation !== "revoke") return { cleanupComplete: true };
          this.fabricOriginDataPlaneGrants?.fenceConnector(connectorId);
          this.fabricSecurity?.invalidateChallenges(connectorId);
          const cleanupComplete = await this.fabricWss?.retireConnector(connectorId, `Connector registration ${operation} committed`) ?? true;
          return { cleanupComplete };
        });
      }
      const localTunnelPort = this.options.httpPort ?? config.transport.http.port;
      const openAiConfig = config.tunnels.openai;
      const tunnelProviders = this.options.tunnelProviders ?? [
        new CloudflareQuickTunnelProvider({ defaultLocalPort: localTunnelPort, probePath: config.transport.http.path }),
        // Registered after Cloudflare and kept experimental/disabled unless the
        // administrator explicitly configures the supported external CLI and
        // credential references. This provider never downloads or provisions.
        new OpenAiTunnelProvider({
          enabled: openAiConfig.enabled,
          binaryPath: openAiConfig.binaryPath,
          minimumVersion: openAiConfig.minimumVersion,
          tunnelIdEnv: openAiConfig.tunnelIdEnv,
          runtimeKeyEnv: openAiConfig.runtimeKeyEnv,
          credentialTtlMs: openAiConfig.credentialTtlMs,
          defaultLocalPort: localTunnelPort,
          mcpPath: config.transport.http.path,
          issueGatewayCredential: async (request, ttlMs) => {
            // Access policy is projected exclusively from the canonical
            // configured profile. Provider input is deliberately absent from
            // this lookup, so generic provider/instance overrides cannot
            // select scopes or workspace.
            const profile = config.tunnels.profiles.find((candidate) => candidate.provider === "openai" && candidate.mode === "secure" && candidate.id === request.instance);
            if (profile === undefined) throw new Error("OpenAI Tunnel credentials require a configured Secure profile issuer");
            const policy = gatewayTunnelMcpCredentialPolicy(profile.mcpAccess);
            return runtime.pairingStore.issue({
              ttlMs,
              audience: GATEWAY_TUNNEL_AUDIENCE,
              scopes: policy.scopes,
              provider: "openai",
              instance: profile.id,
              generation: request.generation,
              ...(policy.workspaceId === undefined ? {} : { workspaceId: policy.workspaceId }),
              label: `openai-tunnel:${request.instance}`,
            });
          },
          revokeGatewayCredential: async (id) => { await runtime.pairingStore.revoke(id, { revokedBy: "openai-tunnel-provider" }); },
        }),
        new SshReverseTunnelProvider({ defaultLocalPort: localTunnelPort, mcpPath: config.transport.http.path }),
      ];
      const tunnelProfiles = config.tunnels.profiles.map((profile) => ({
        id: profile.id,
        provider: profile.provider,
        mode: profile.mode,
        lifecycle: profile.lifecycle,
        enabled: profile.enabled,
        input: gatewayTunnelProfileInput(profile, { port: localTunnelPort, path: config.transport.http.path }),
      }));
      const tunnelManager = this.options.tunnelManager ?? new GatewayTunnelManager({
        providers: tunnelProviders,
        profiles: tunnelProfiles,
        stateRoot: this.options.tunnelStateRoot ?? (config.state.ownerPath ? join(dirname(config.state.ownerPath), "tunnels") : undefined),
        observer: runtime.observer,
      });
      this.tunnelManager = tunnelManager;
      // OpenAI credentials are process-local and cannot be adopted after a
      // daemon restart. Fence every configured profile (including disabled
      // profiles) before recovery may issue a successor generation. Pairing
      // store mutation serialization leaves credentials issued after this
      // save untouched.
      for (const profile of config.tunnels.profiles) {
        if (profile.provider !== "openai" || profile.mode !== "secure") continue;
        await runtime.pairingStore.revokeOpenAiTunnelPairings(profile.id, `daemon-startup-recovery:${profile.id}`);
      }
      const issuePair = async (data: Record<string, unknown> | undefined, bootstrap: boolean): Promise<unknown> => {
        const http = config.transport.http;
        const effectiveHost = this.options.httpHost ?? http.host;
        const reverseProxyHttps = isLoopbackHost(effectiveHost) && config.server.trustProxyHeaders && config.auth.oauth?.serverUrl?.startsWith("https://");
        if (!http.tls?.enabled && !reverseProxyHttps && !isLoopbackHost(effectiveHost)) throw new Error("Pairing is refused for non-loopback plaintext HTTP");
        if (bootstrap && (!this.http?.secure || !this.http.server.listening || !runtime.isReady)) throw new Error("Secure Gateway HTTPS is not ready for pairing");
        const purpose = data?.purpose;
        if (purpose !== undefined) {
          if (purpose !== "fabric-enrollment" && purpose !== "fabric-rotation") throw new Error("pairing purpose is invalid");
          if (!config.fabric.enabled || runtime.fabricRegistrationGate === undefined || !runtime.fabricAdmissionReady ||
            !this.http?.secure || !this.http.server.listening || !runtime.isReady) {
            throw new Error("Secure Fabric enrollment is not ready for purpose-token issuance");
          }
          const connectorId = data?.connectorId;
          assertFabricIdentifier(connectorId, "connectorId");
          for (const forbidden of ["audience", "scopes", "provider", "instance", "workspace", "workspaceId", "replacesId"]) {
            if (data?.[forbidden] !== undefined) throw new Error(`Fabric purpose tokens do not accept ${forbidden} overrides`);
          }
          const ttlMs = data?.ttlMs === undefined ? 600_000 : Number(data.ttlMs);
          if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 600_000) throw new Error("Fabric purpose-token ttlMs must be in [1, 600000]");
          const rotation = purpose === "fabric-rotation";
          const generation = rotation ? Number(data?.generation) : 1;
          if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Fabric rotation purpose requires a positive generation");
          if (!rotation && data?.generation !== undefined) throw new Error("Fabric enrollment purpose does not accept generation");
          const issued = await runtime.fabricRegistrationGate.run(() => runtime.pairingStore.issue({
            ttlMs,
            audience: FABRIC_PAIRING_AUDIENCE,
            scopes: [rotation ? FABRIC_ROTATE_SCOPE : FABRIC_ENROLL_SCOPE],
            provider: FABRIC_PAIRING_PROVIDER,
            instance: connectorId,
            generation,
            ...(typeof data?.label === "string" ? { label: data.label } : { label: `${purpose}:${connectorId}` }),
          }));
          return bootstrap
            ? { ...issued, endpoint: this.http.url, serverName: "pi-maestro-gateway", protocolVersion: GATEWAY_PROTOCOL_VERSION }
            : issued;
        }
        if (config.auth.mode === "open") throw new Error("Pairing requires authenticated Gateway HTTP");
        const scopes = data?.scopes;
        if (scopes !== undefined && (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string"))) throw new Error("pairing scopes are invalid");
        // Canonicalize before the security comparison and before forwarding to
        // the store. This closes whitespace/newline aliases of tunnel.audience.
        const audience = data?.audience === undefined ? undefined : canonicalizeGatewayPairingAudience(data.audience);
        // Tunnel credentials are minted only by the canonical configured
        // OpenAI profile issuer above. The generic pairing boundary must not
        // become a policy-injection seam for audience/scopes/workspace.
        if (audience === GATEWAY_TUNNEL_AUDIENCE) throw new Error("gateway.tunnel credentials require a configured tunnel profile");
        const issued = await runtime.pairingStore.issue({
          ...(data?.ttlMs === undefined ? {} : { ttlMs: Number(data.ttlMs) }),
          ...(data?.label === undefined ? {} : { label: data.label as string }),
          ...(scopes === undefined ? {} : { scopes: scopes as string[] }),
          ...(audience === undefined ? {} : { audience }),
          ...(data?.workspaceId === undefined && data?.workspace === undefined ? {} : { workspaceId: (data.workspaceId ?? data.workspace) as string }),
          ...(data?.provider === undefined ? {} : { provider: data.provider as string }),
          ...(data?.instance === undefined ? {} : { instance: data.instance as string }),
          ...(data?.generation === undefined ? {} : { generation: Number(data.generation) }),
          ...(data?.replacesId === undefined ? {} : { replacesId: data.replacesId as string }),
        });
        return bootstrap
          ? { ...issued, endpoint: this.http!.url, serverName: "pi-maestro-gateway", protocolVersion: GATEWAY_PROTOCOL_VERSION }
          : issued;
      };
      this.controlDispatcher = new GatewayControlDispatcher({
        audit: runtime.audit,
        handlers: {
          status: async () => {
            const host = runtime.host.test();
            const httpEnabled = this.options.http ?? config.transport.http.enabled;
            const httpReady = !httpEnabled || Boolean(this.http?.server.listening && runtime.isReady);
            return {
              ...host,
              readiness: { ipc: true, http: httpReady, ready: httpReady },
              lifecycle: { phase: runtime.isQuiescing ? "quiescing" : runtime.isReady ? "running" : "closed", inFlight: runtime.inFlightRequestCount },
              metrics: {
                observations: runtime.observer.snapshot(),
                stream: runtime.eventStream.stats(),
                audit: { enabled: Boolean(runtime.audit.path) },
              },
            };
          },
          stop: () => { void this.stop(); },
          pair: (data) => issuePair(data, false),
          "pair-bootstrap": (data) => issuePair(data, true),
          "pair-list": (data) => runtime.pairingStore.list({ includeInactive: data?.includeInactive === true }),
          "pair-revoke": async (data) => {
            if (typeof data?.id !== "string" || !data.id) throw new Error("pair-revoke requires an id");
            if (runtime.fabricPairingAdapter !== undefined) {
              const result = await runtime.fabricPairingAdapter.revokePairing(data.id, {
                ...(typeof data.requestId === "string" ? { requestId: data.requestId } : {}),
                ...(Number.isSafeInteger(data.expectedRevision) ? { expectedRevision: Number(data.expectedRevision) } : {}),
                ...(typeof data.revokedBy === "string" ? { revokedBy: data.revokedBy } : {}),
                ...(typeof data.replacementId === "string" ? { replacementId: data.replacementId } : {}),
              });
              return {
                revoked: result.revoked,
                ...(result.receipt === undefined ? {} : { connector: result.receipt }),
                ...(result.cleanupStatus === undefined ? {} : { cleanupStatus: result.cleanupStatus }),
              };
            }
            return { revoked: await runtime.pairingStore.revoke(data.id, {
              ...(typeof data.revokedBy === "string" ? { revokedBy: data.revokedBy } : {}),
              ...(typeof data.replacementId === "string" ? { replacementId: data.replacementId } : {}),
            }) };
          },
          "fabric-connector-revoke": async (data) => {
            if (runtime.fabricPairingAdapter === undefined) throw new Error("Fabric registration is disabled");
            if (typeof data?.connectorId !== "string" || !data.connectorId) throw new Error("fabric-connector-revoke requires connectorId");
            if (typeof data.requestId !== "string" || !data.requestId) throw new Error("fabric-connector-revoke requires requestId");
            if (!Number.isSafeInteger(data.expectedRevision) || Number(data.expectedRevision) < 1) throw new Error("fabric-connector-revoke requires a positive expectedRevision");
            return runtime.fabricPairingAdapter.revokeConnector({
              connectorId: data.connectorId,
              requestId: data.requestId,
              expectedRevision: Number(data.expectedRevision),
            });
          },
          "fabric-connector-status": () => this.fabricConnectorService?.status() ?? {
            configured: false,
            state: this.fabricConnectorConfigurationInvalid ? "failed" : "stopped",
            running: false,
            ...(this.fabricConnectorConfigurationInvalid ? { reason: "Connector configuration is invalid" } : {}),
          },
          "fabric-connector-start": () => {
            if (this.fabricConnectorService === undefined) throw connectorControlUnavailable(this.fabricConnectorConfigurationInvalid);
            return this.fabricConnectorService.start();
          },
          "fabric-connector-stop": () => {
            if (this.fabricConnectorService === undefined) throw connectorControlUnavailable(this.fabricConnectorConfigurationInvalid);
            return this.fabricConnectorService.stop();
          },
          "fabric-origin-grant-acquire": (data) => {
            if (this.fabricOriginDataPlaneGrants === undefined) throw new FabricContractError("unavailable", "Fabric origin grants are disabled");
            return this.fabricOriginDataPlaneGrants.acquire(data as unknown as FabricOriginGrantAcquireRequest);
          },
          "fabric-origin-grant-renew": (data) => {
            if (this.fabricOriginDataPlaneGrants === undefined) throw new FabricContractError("unavailable", "Fabric origin grants are disabled");
            return this.fabricOriginDataPlaneGrants.renew(data as unknown as FabricOriginGrantIdentity);
          },
          "fabric-origin-grant-release": (data) => {
            if (this.fabricOriginDataPlaneGrants === undefined) return { released: false };
            return this.fabricOriginDataPlaneGrants.release(data as unknown as FabricOriginGrantIdentity);
          },
          "workspace-list": (data) => runtime.workspace.control("workspace-list", data),
          "workspace-register": (data) => runtime.workspace.control("workspace-register", data),
          "workspace-renew": (data) => runtime.workspace.control("workspace-renew", data),
          "workspace-remove": (data) => runtime.workspace.control("workspace-remove", data),
          ...(tunnelManager ? {
            "tunnel-status": (data: Record<string, unknown> | undefined) => tunnelManager.control("tunnel-status", data),
            "tunnel-start": (data: Record<string, unknown> | undefined) => {
              assertLivePublicTunnelConfig(config, tunnelManager, data);
              return tunnelManager.control("tunnel-start", data);
            },
            "tunnel-stop": (data: Record<string, unknown> | undefined) => tunnelManager.control("tunnel-stop", data),
            "tunnel-restart": (data: Record<string, unknown> | undefined) => {
              assertLivePublicTunnelConfig(config, tunnelManager, data);
              return tunnelManager.control("tunnel-restart", data);
            },
            "tunnel-doctor": (data: Record<string, unknown> | undefined) => tunnelManager.doctor({ deadlineAt: typeof data?.deadlineAt === "number" ? data.deadlineAt : undefined }),
          } : {}),
          ...this.options.tunnelControlHandlers,
        },
      });
      if (enableHttp) {
        const { startGatewayHttpServer } = await import("./http-server.ts");
        // Both listeners are views over the same runtime and auth state. The
        // tunnel listener is created only for an explicitly enabled MCP access
        // profile, preserving legacy profiles that target the primary listener.
        const sharedAuth = new GatewayHttpAuth(runtime.config.auth, runtime.pairingStore, runtime.fabricOriginDataPlaneGrants);
        this.http = await startGatewayHttpServer(runtime, {
          host: this.options.httpHost,
          port: this.options.httpPort,
          path: this.options.httpPath,
          auth: sharedAuth,
        });
        if (config.tunnels.profiles.some((profile) => profile.mcpAccess?.enabled === true)) {
          this.tunnelHttp = await startGatewayHttpServer(runtime, {
            mode: "tunnel-ingress",
            host: "127.0.0.1",
            port: 0,
            path: this.http.path,
            auth: sharedAuth,
          });
        }
        if (config.fabric.enabled) {
          const origin = new URL(this.http.url);
          origin.pathname = "/";
          origin.search = "";
          origin.hash = "";
          const ca = config.transport.http.tls?.certFile === undefined
            ? undefined
            : await readFile(config.transport.http.tls.certFile, "utf8");
          this.fabricOriginDataPlaneGrants?.configureHttps({ baseUrl: origin.href, ...(ca === undefined ? {} : { ca }) });
        }
      } else if (config.tunnels.profiles.some((profile) => profile.mcpAccess?.enabled === true)) {
        // A tunnel ingress may be the only HTTP surface when explicitly
        // requested; it remains loopback-only and still shares runtime/auth.
        const sharedAuth = new GatewayHttpAuth(runtime.config.auth, runtime.pairingStore, runtime.fabricOriginDataPlaneGrants);
        const { startGatewayHttpServer } = await import("./http-server.ts");
        this.tunnelHttp = await startGatewayHttpServer(runtime, {
          mode: "tunnel-ingress", host: "127.0.0.1", port: 0,
          path: this.options.httpPath ?? runtime.config.transport.http.path,
          auth: sharedAuth,
        });
      }
      // Owner IPC is the grant acquisition boundary, so it is published only
      // after the authoritative Fabric HTTPS listener and grant URL are ready.
      await assertOwnerCurrent();
      this.ipc = await startGatewayIpcServer(runtime, {
        ownerToken: owner.ownerToken,
        address,
        onControl: (action, data) => this.controlDispatcher!.dispatch(action, data),
      });
      try {
        await assertOwnerCurrent();
      } catch (error) {
        await this.ipc.close().catch(() => undefined);
        this.ipc = undefined;
        throw error;
      }
      if (config.fabric.enabled) {
        // Fabric rides the Gateway's own TLS listener: a Connector channel on a
        // plaintext socket would authenticate a key over a link anyone can
        // rewrite, and the pairing rules already refuse that for HTTP.
        if (this.http === undefined || !this.http.secure) {
          throw new Error(
            "Fabric requires the Gateway HTTPS listener; enable transport.http.tls or disable fabric",
          );
        }
        if (this.fabricSecurity === undefined) throw new Error("Fabric WSS requires the runtime registration security");
        if (runtime.fabricEndpointDispatcher === undefined) throw new Error("Fabric WSS relay requires the runtime Endpoint dispatcher");
        const relay = new FabricHubRelay({
          dispatcher: runtime.fabricEndpointDispatcher,
          hubRuntimeEpoch,
          originSubjectOf: (principal) => `origin-${createHash("sha256")
            .update(hubRuntimeEpoch, "utf8").update("\0", "utf8").update(principalKey(principal), "utf8")
            .digest("hex").slice(0, 48)}`,
          limits: {
            maxActiveOperations: config.limits.maxConcurrentRequests,
            maxFrameBytes: config.fabric.limits?.maxFrameBytes ?? 256 * 1024,
            maxResultBytes: config.limits.maxOutputBytes,
          },
        });
        const fabricWss = new FabricWssServer({
          security: this.fabricSecurity,
          server: this.http.server,
          limits: config.fabric.limits,
          authority: createFabricWssAuthority(runtime),
          relay,
        });
        this.fabricWss = fabricWss;
        this.disposeFabricRemoteRouteCloser = runtime.installFabricRemoteRouteCloser(
          (routeId, reason) => fabricWss.closeRoute(routeId, reason),
        );
        fabricWss.start();
      }
      // Profiles are finalized only after the listeners publish their actual
      // bound ports. This prevents a configured port=0 (or a collision) from
      // leaking an unusable provider input and ensures providers never start
      // before ingress binding succeeds.
      if (tunnelManager) {
        for (const profile of config.tunnels.profiles) {
          const ingress = profile.mcpAccess?.enabled === true && this.tunnelHttp !== undefined ? this.tunnelHttp : this.http;
          if (ingress !== undefined) {
            tunnelManager.updateProfileInput(profile.id, gatewayTunnelProfileInput(profile, { port: ingress.port, path: ingress.path }, {
              boundPort: ingress.port,
              forceBoundPort: profile.mcpAccess?.enabled === true,
            }));
          }
        }
      }
      // Recovery is asynchronous so an external ingress failure never takes
      // down the local HTTPS/stdio Gateway. Supervisor state retains verified
      // ownership failures; do not discard a recovery rejection here.
      if (tunnelManager) void tunnelManager.recoverAll();
      return this;
    } catch (error) {
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      const ownerToken = this.owner?.ownerToken;
      const deadlineAt = Date.now() + (this.options.shutdownTimeoutMs ?? 5_000);
      // Fence admission synchronously at shutdown entry. beginQuiesce changes
      // runtime phase before its first await, so HTTP registration and WSS
      // admission both reject while existing Connector channels drain.
      this.http?.setReady(false);
      this.tunnelHttp?.setReady(false);
      this.runtime?.fenceFabricAdmission();
      const runtimeQuiesce = this.runtime?.beginQuiesce(deadlineAt);
      const tunnelQuiesce = this.tunnelManager?.closeAll(deadlineAt);
      // shutdown() fences publication, refresh, and reconnect synchronously
      // before any transport drain is awaited.
      const connectorQuiesce = this.fabricConnectorService?.shutdown();
      this.disposeFabricRemoteRouteCloser?.();
      this.disposeFabricRemoteRouteCloser = undefined;
      await this.fabricWss?.close("the Gateway is shutting down").catch(() => undefined);
      this.fabricWss = undefined;
      this.fabricSecurity = undefined;
      await Promise.allSettled([runtimeQuiesce, tunnelQuiesce, connectorQuiesce]);
      await this.tunnelHttp?.close().catch(() => undefined);
      this.tunnelHttp = undefined;
      await this.http?.close().catch(() => undefined);
      this.http = undefined;
      await this.ipc?.close().catch(() => undefined);
      this.ipc = undefined;
      await this.runtime?.close().catch(() => undefined);
      this.runtime = undefined;
      this.fabricTeammateRuntime?.dispose();
      this.fabricTeammateRuntime = undefined;
      this.fabricConnectorService = undefined;
      this.fabricOriginDataPlaneGrants = undefined;
      this.fabricConnectorConfigurationInvalid = false;
      this.controlDispatcher = undefined;
      this.tunnelManager = undefined;
      if (ownerToken) await this.ownerStore?.release(ownerToken).catch(() => undefined);
      this.owner = undefined;
    })();
    try { await this.stopping; }
    finally {
      this.stopping = undefined;
      this.resolveStopped?.();
      this.resolveStopped = undefined;
    }
  }

  waitUntilStopped(): Promise<void> { return this.stopped; }

  async close(): Promise<void> { await this.stop(); }
}

export async function startGatewayDaemon(options: GatewayDaemonOptions = {}): Promise<GatewayDaemon> {
  return new GatewayDaemon(options).start();
}

let defaultFabricTeammateRuntime: FabricTeammateRuntimeRegistration | undefined;
let defaultFabricTeammateRuntimeConsumers = 0;

export function registerDefaultFabricTeammateRuntime(): FabricTeammateRuntimeRegistration | undefined {
  const current = getFabricTeammateRuntimePort();
  if (defaultFabricTeammateRuntime !== undefined && current === defaultFabricTeammateRuntime.port) {
    defaultFabricTeammateRuntimeConsumers += 1;
    return defaultFabricTeammateRuntimeLease(defaultFabricTeammateRuntime);
  }
  if (current !== undefined) return undefined;
  const registration = registerFabricTeammateRuntimePort(createFabricTeammateRuntimePort());
  defaultFabricTeammateRuntime = registration;
  defaultFabricTeammateRuntimeConsumers = 1;
  return defaultFabricTeammateRuntimeLease(registration);
}

function defaultFabricTeammateRuntimeLease(
  registration: FabricTeammateRuntimeRegistration,
): FabricTeammateRuntimeRegistration {
  let disposed = false;
  return {
    port: registration.port,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (defaultFabricTeammateRuntime !== registration || defaultFabricTeammateRuntimeConsumers === 0) return;
      defaultFabricTeammateRuntimeConsumers -= 1;
      if (defaultFabricTeammateRuntimeConsumers > 0) return;
      defaultFabricTeammateRuntime = undefined;
      registration.dispose();
    },
  };
}

interface FabricWssRuntimeView {
  readonly isReady: boolean;
  readonly fabricAdmissionReady: boolean;
  readonly fabricControlRuntime?: {
    readonly connections: Pick<FabricConnectionManager,
      "acceptInbound" | "admitAdvertisement" | "admitAdvertisementDelta" |
      "renewInboundLease" | "drain" | "disconnect">;
  };
}

export function createFabricWssAuthority(runtime: FabricWssRuntimeView): FabricWssAuthority {
  const control = runtime.fabricControlRuntime;
  if (control === undefined) throw new Error("Fabric WSS requires the runtime Fabric managers");
  const assertAdmissionOpen = (): void => {
    if (!runtime.isReady || runtime.fabricAdmissionReady === false) {
      throw new FabricContractError("unavailable", "Fabric admission is blocked while the Gateway is quiescing or registration authority is unavailable");
    }
  };
  return {
    admit: async (input, owner) => {
      assertAdmissionOpen();
      const lease = await control.connections.acceptInbound(input, owner);
      try {
        assertAdmissionOpen();
        return lease;
      } catch (error) {
        // Roll back only the exact lease returned by this admission. A late
        // cleanup cannot disconnect a successor generation.
        try {
          await control.connections.disconnect(
            lease.connectionId,
            lease.generation,
            "Fabric admission was fenced after connection acceptance",
          );
        } catch (cleanupError) {
          if (!(cleanupError instanceof FabricContractError && ["not_found", "stale_generation"].includes(cleanupError.code))) {
            throw new AggregateError([error, cleanupError], "Fabric admission fencing cleanup failed", { cause: error });
          }
        }
        throw error;
      }
    },
    acceptSnapshot: async (session, payload) => {
      assertAdmissionOpen();
      const snapshot: FabricAdvertisementSnapshot = {
        connectionId: session.connectionId,
        connectionGeneration: session.connectionGeneration,
        capabilityDigest: requiredString(payload.capabilityDigest, "capabilityDigest"),
        advertisementRevision: requiredNumber(payload.advertisementRevision, "advertisementRevision"),
        devices: jsonArray(payload.devices, "devices"),
        workspaces: jsonArray(payload.workspaces, "workspaces"),
        endpoints: jsonArray(payload.endpoints, "endpoints"),
        capabilities: jsonArray(payload.capabilities, "capabilities"),
      };
      await control.connections.admitAdvertisement(snapshot);
      assertAdmissionOpen();
    },
    acceptDelta: async (session, payload) => {
      assertAdmissionOpen();
      const upserts = jsonObject(payload.upserts, "upserts", true);
      const removals = jsonObject(payload.removals, "removals", true);
      const delta: FabricAdvertisementDelta = {
        connectionId: session.connectionId,
        connectionGeneration: session.connectionGeneration,
        capabilityDigest: requiredString(payload.capabilityDigest, "capabilityDigest"),
        baseRevision: requiredNumber(payload.baseRevision, "baseRevision"),
        advertisementRevision: requiredNumber(payload.advertisementRevision, "advertisementRevision"),
        ...(upserts === undefined ? {} : { upserts: {
          ...(upserts.workspaces === undefined ? {} : { workspaces: jsonArray(upserts.workspaces, "upserts.workspaces") }),
          ...(upserts.endpoints === undefined ? {} : { endpoints: jsonArray(upserts.endpoints, "upserts.endpoints") }),
          ...(upserts.capabilities === undefined ? {} : { capabilities: jsonArray(upserts.capabilities, "upserts.capabilities") }),
        } }),
        ...(removals === undefined ? {} : { removals: {
          ...(removals.workspaceIds === undefined ? {} : { workspaceIds: jsonArray(removals.workspaceIds, "removals.workspaceIds") }),
          ...(removals.endpointIds === undefined ? {} : { endpointIds: jsonArray(removals.endpointIds, "removals.endpointIds") }),
          ...(removals.capabilityIds === undefined ? {} : { capabilityIds: jsonArray(removals.capabilityIds, "removals.capabilityIds") }),
        } }),
      };
      await control.connections.admitAdvertisementDelta(delta);
      assertAdmissionOpen();
    },
    heartbeat: async (session, input) => {
      await control.connections.renewInboundLease(
        session.connectionId,
        session.connectionGeneration,
        input.leaseExpiresAt,
      );
    },
    drain: async (session, deadlineAt) => {
      control.connections.drain(session.connectionId, session.connectionGeneration, deadlineAt);
    },
    close: async (session, reason) => {
      try {
        await control.connections.disconnect(session.connectionId, session.connectionGeneration, reason);
      } catch (error) {
        if (error instanceof FabricContractError && ["not_found", "stale_generation"].includes(error.code)) return;
        throw error;
      }
    },
  };
}

function connectorControlUnavailable(invalid: boolean): Error & { code: string } {
  const error = new Error(invalid
    ? "Fabric Connector configuration is invalid; repair it and restart the Gateway daemon"
    : "Fabric Connector is not configured; enroll it and restart the Gateway daemon") as Error & { code: string };
  error.code = invalid ? "connector_configuration_invalid" : "connector_not_configured";
  return error;
}

function requiredString(value: JsonValue | undefined, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new FabricContractError("invalid_argument", `${path} must be a non-empty string`, path);
  }
  return value;
}

function requiredNumber(value: JsonValue | undefined, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new FabricContractError("invalid_argument", `${path} must be a safe integer`, path);
  }
  return value;
}

function jsonObject(
  value: JsonValue | undefined,
  path: string,
  optional = false,
): Readonly<Record<string, JsonValue>> | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FabricContractError("invalid_argument", `${path} must be an object`, path);
  }
  return value as Readonly<Record<string, JsonValue>>;
}

function jsonArray<T>(value: JsonValue | undefined, path: string): readonly T[] {
  if (!Array.isArray(value)) throw new FabricContractError("invalid_argument", `${path} must be an array`, path);
  return value as unknown as readonly T[];
}

function assertGatewayTunnelMcpAccessContracts(config: GatewayConfig): void {
  for (const profile of config.tunnels.profiles) {
    const access = profile.mcpAccess;
    if (access === undefined) continue;
    if (access.auth.kind === "gateway") {
      if (access.actions.length > 0) throw new Error(`Tunnel profile ${profile.id} gateway MCP auth cannot define actions/scopes`);
      if (access.enabled && profile.provider === "openai" && profile.mode === "secure") {
        throw new Error(`Tunnel profile ${profile.id} OpenAI Secure MCP access requires managed-forward auth`);
      }
      continue;
    }
    if (profile.provider !== "openai" || profile.mode !== "secure") {
      throw new Error(`Tunnel profile ${profile.id} managed-forward MCP auth is only supported by OpenAI Secure profiles`);
    }
    if (access.enabled && access.actions.length === 0) {
      throw new Error(`Tunnel profile ${profile.id} enabled managed-forward MCP access requires explicit actions`);
    }
  }
}

function assertLivePublicTunnelConfig(
  config: GatewayConfig,
  manager: GatewayTunnelManager,
  data?: Record<string, unknown>,
): void {
  const profile = typeof data?.profile === "string" ? manager.profile(data.profile) : undefined;
  const rawInput = profile?.input ?? (data?.input && typeof data.input === "object" && !Array.isArray(data.input)
    ? data.input as Readonly<Record<string, unknown>>
    : undefined);
  const publicUrl = rawInput?.publicUrl;
  if (publicUrl === undefined) return;
  if (typeof publicUrl !== "string"
    || (config.auth.mode !== "oauth" && config.auth.mode !== "dual")
    || config.auth.oauth?.serverUrl !== publicUrl
    || !config.server.disableLocalhostProtection
    || !config.server.trustProxyHeaders) {
    throw new Error("Public tunnel start requires the live Gateway to use the matching OAuth origin and trusted reverse-proxy settings");
  }
}
