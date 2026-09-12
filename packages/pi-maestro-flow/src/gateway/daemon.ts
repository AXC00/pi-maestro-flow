/** Lifecycle owner for the one packaged Gateway daemon. */
import { dirname, join } from "node:path";
import type { GatewayConfig } from "./config.ts";
import { gatewayTunnelProfileInput, FABRIC_DEFAULT_AUDIENCE, loadGatewayConfig } from "./config.ts";
import { GATEWAY_PROTOCOL_VERSION, type GatewayOwnerRecord } from "./contracts.ts";
import type { GatewayHttpServerHandle } from "./http-server.ts";
import { isLoopbackHost } from "./auth.ts";
import { gatewayIpcAddress, startGatewayIpcServer, type GatewayIpcServerHandle } from "./ipc.ts";
import { GatewayOwnerStore } from "./owner-store.ts";
import { GatewayRuntime, type GatewayRuntimeOptions } from "./runtime.ts";
import { FabricConnectorSecurity } from "./fabric/security.ts";
import { FabricWssServer } from "./fabric/wss-server.ts";
import { GatewayControlDispatcher, type GatewayControlHandler, type GatewayTunnelControlAction } from "./control-dispatcher.ts";
import type { GatewayTunnelProvider } from "./tunnel/contracts.ts";
import { GatewayTunnelManager } from "./tunnel/provider.ts";
import { CloudflareQuickTunnelProvider } from "./tunnel/providers/cloudflare.ts";
import { OpenAiTunnelProvider } from "./tunnel/providers/openai.ts";
import { SshReverseTunnelProvider } from "./tunnel/providers/ssh-reverse.ts";

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
  shutdownTimeoutMs?: number;
}

export class GatewayDaemon {
  readonly options: GatewayDaemonOptions;
  config?: GatewayConfig;
  runtime?: GatewayRuntime;
  owner?: GatewayOwnerRecord;
  ipc?: GatewayIpcServerHandle;
  http?: GatewayHttpServerHandle;
  controlDispatcher?: GatewayControlDispatcher;
  tunnelManager?: GatewayTunnelManager;
  fabricSecurity?: FabricConnectorSecurity;
  fabricWss?: FabricWssServer;
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
    this.config = config;
    const store = this.options.ownerStore ?? new GatewayOwnerStore({
      ownerPath: config.state.ownerPath,
      commandIdentity: this.options.commandIdentity ?? (process.argv.join(" ") || process.execPath),
    });
    this.ownerStore = store;
    const address = this.options.ipcAddress ?? gatewayIpcAddress(undefined, store.ownerPath);
    const commandIdentity = this.options.commandIdentity ?? (process.argv.join(" ") || process.execPath);
    const owner = await store.claim({ socket: address, commandIdentity });
    this.owner = owner;
    try {
      const runtime = await GatewayRuntime.create({ ...this.options, config });
      this.runtime = runtime;
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
          issueGatewayCredential: async (request, ttlMs) => runtime.pairingStore.issue({
            ttlMs,
            audience: "gateway.tunnel",
            scopes: ["gateway.host.status"],
            provider: "openai",
            instance: request.instance,
            generation: request.generation,
            label: `openai-tunnel:${request.instance}`,
          }),
          revokeGatewayCredential: async (id) => { await runtime.pairingStore.revoke(id, { revokedBy: "openai-tunnel-provider" }); },
        }),
        new SshReverseTunnelProvider({ defaultLocalPort: localTunnelPort, mcpPath: config.transport.http.path }),
      ];
      const tunnelProfiles = config.tunnels.profiles.map((profile) => ({
        id: profile.id,
        provider: profile.provider,
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
      const issuePair = async (data: Record<string, unknown> | undefined, bootstrap: boolean): Promise<unknown> => {
        const http = config.transport.http;
        const effectiveHost = this.options.httpHost ?? http.host;
        const reverseProxyHttps = isLoopbackHost(effectiveHost) && config.server.trustProxyHeaders && config.auth.oauth?.serverUrl?.startsWith("https://");
        if (config.auth.mode === "open") throw new Error("Pairing requires authenticated Gateway HTTP");
        if (!http.tls?.enabled && !reverseProxyHttps && !isLoopbackHost(effectiveHost)) throw new Error("Pairing is refused for non-loopback plaintext HTTP");
        if (bootstrap && (!this.http?.secure || !this.http.server.listening || !runtime.isReady)) throw new Error("Secure Gateway HTTPS is not ready for pairing");
        const scopes = data?.scopes;
        if (scopes !== undefined && (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string"))) throw new Error("pairing scopes are invalid");
        const issued = await runtime.pairingStore.issue({
          ...(data?.ttlMs === undefined ? {} : { ttlMs: Number(data.ttlMs) }),
          ...(data?.label === undefined ? {} : { label: data.label as string }),
          ...(scopes === undefined ? {} : { scopes: scopes as string[] }),
          ...(data?.audience === undefined ? {} : { audience: data.audience as string }),
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
            return { revoked: await runtime.pairingStore.revoke(data.id, {
              ...(typeof data.revokedBy === "string" ? { revokedBy: data.revokedBy } : {}),
              ...(typeof data.replacementId === "string" ? { replacementId: data.replacementId } : {}),
            }) };
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
          } : {}),
          ...this.options.tunnelControlHandlers,
        },
      });
      this.ipc = await startGatewayIpcServer(runtime, {
        ownerToken: owner.ownerToken,
        address,
        onControl: (action, data) => this.controlDispatcher!.dispatch(action, data),
      });
      const enableHttp = this.options.http ?? config.transport.http.enabled;
      if (enableHttp) {
        const { startGatewayHttpServer } = await import("./http-server.ts");
        this.http = await startGatewayHttpServer(runtime, {
          host: this.options.httpHost,
          port: this.options.httpPort,
          path: this.options.httpPath,
        });
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
        this.fabricSecurity = new FabricConnectorSecurity({ audience: config.fabric.audience ?? FABRIC_DEFAULT_AUDIENCE });
        this.fabricWss = new FabricWssServer({
          security: this.fabricSecurity,
          server: this.http.server,
          limits: config.fabric.limits,
        });
        this.fabricWss.start();
      }
      // Recovery is fail-soft: an external ingress failure never takes down the
      // local HTTPS/stdio Gateway.
      if (tunnelManager) void tunnelManager.recoverAll().catch(() => undefined);
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
      this.http?.setReady(false);
      // Drain Connector channels before the listener goes away, so a peer sees a
      // deliberate close rather than a dropped socket.
      await this.fabricWss?.close("the Gateway is shutting down").catch(() => undefined);
      this.fabricWss = undefined;
      this.fabricSecurity = undefined;
      await Promise.allSettled([
        this.runtime?.beginQuiesce(deadlineAt),
        this.tunnelManager?.closeAll(deadlineAt),
      ]);
      await this.http?.close().catch(() => undefined);
      this.http = undefined;
      await this.ipc?.close().catch(() => undefined);
      this.ipc = undefined;
      await this.runtime?.close().catch(() => undefined);
      this.runtime = undefined;
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
