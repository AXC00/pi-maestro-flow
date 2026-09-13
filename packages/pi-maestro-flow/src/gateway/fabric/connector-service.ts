import { createHash, createPrivateKey, sign as signPayload, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { FabricContractError } from "pi-maestro-fabric-core/v1";
import type { GatewayPolicy } from "../policy.ts";
import type { GatewayWindowsAclRunner } from "../private-path.ts";
import type { WorkspaceRegistry } from "../workspace-registry.ts";
import {
  fabricConnectorConfigPath,
  loadFabricConnectorConfig,
  type FabricConnectorConfigV1,
} from "./connector-config.ts";
import {
  FabricConnectorInventory,
  type FabricDeviceSourceAvailability,
  type FabricDeviceSourceAvailabilityProvider,
  type FabricDeviceSourceRestrictions,
  type FabricDeviceSourceRestrictionsProvider,
  type PreparedFabricConnectorInventory,
} from "./connector-inventory.ts";
import {
  FabricConnectorRuntime,
  type FabricConnectorRuntimeOptions,
} from "./connector-runtime.ts";
import type { FabricDeviceRelayExecutionHandler, FabricHubRelayLimits } from "./hub-relay.ts";
import { requireIdentityMetadata } from "./connector-registration-cli.ts";

export const FABRIC_CONNECTOR_SERVICE_STATES = ["configured", "starting", "connected", "ready", "stopped", "failed"] as const;
export type FabricConnectorServiceState = (typeof FABRIC_CONNECTOR_SERVICE_STATES)[number];

export interface FabricConnectorServiceStatus {
  readonly configured: true;
  readonly enabled: boolean;
  readonly state: FabricConnectorServiceState;
  readonly running: boolean;
  readonly connectorId: string;
  readonly hubUrl: string;
  readonly keyId: string;
  readonly credentialGeneration: number;
  readonly serviceGeneration: number;
  readonly connectionGeneration?: number;
  readonly advertisementRevision?: number;
  readonly reason?: string;
}

export interface FabricConnectorRuntimePort {
  readonly state: string;
  readonly connectionGeneration: number;
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
}

export type FabricConnectorRuntimeFactory = (options: FabricConnectorRuntimeOptions) => FabricConnectorRuntimePort;

export interface FabricConnectorRelayLifecycle {
  readonly serviceGeneration: number;
  assertCurrent(connectionGeneration: number): void | Promise<void>;
}

export type FabricDeviceRelayHandlerFactory = (
  prepared: PreparedFabricConnectorInventory,
  lifecycle: FabricConnectorRelayLifecycle,
) => FabricDeviceRelayExecutionHandler;

export interface FabricConnectorServiceOwner {
  readonly ownerToken: string;
  readonly ownerEpoch: number;
}

export interface FabricConnectorServiceOptions {
  readonly root: string;
  readonly registry: WorkspaceRegistry;
  readonly policy: GatewayPolicy;
  readonly owner: FabricConnectorServiceOwner;
  /** Revalidates the exact daemon owner token and epoch after every await. */
  readonly assertOwner: (owner: FabricConnectorServiceOwner) => void | Promise<void>;
  readonly initialConfig: FabricConnectorConfigV1;
  readonly configPath?: string;
  readonly loadConfig?: (path: string) => Promise<FabricConnectorConfigV1 | undefined>;
  readonly inventory?: FabricConnectorInventory;
  readonly runtimeFactory?: FabricConnectorRuntimeFactory;
  readonly sourceAvailability?: FabricDeviceSourceAvailability;
  readonly sourceRestrictions?: FabricDeviceSourceRestrictions;
  readonly resolveSourceAvailability?: FabricDeviceSourceAvailabilityProvider;
  readonly resolveSourceRestrictions?: FabricDeviceSourceRestrictionsProvider;
  /** Compatibility seam for inventory-only relays. Production uses the exact-prepared factory. */
  readonly deviceRelayHandler?: FabricDeviceRelayExecutionHandler;
  readonly deviceRelayHandlerFactory?: FabricDeviceRelayHandlerFactory;
  readonly relayLimits?: Partial<FabricHubRelayLimits>;
  readonly readCredentialFile?: (path: string) => Promise<Buffer>;
  readonly refreshIntervalMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly windowsAclRunner?: GatewayWindowsAclRunner;
}

interface DetachedRuntimeCleanup {
  readonly generation: number;
  readonly runtime: FabricConnectorRuntimePort;
  readonly relayHandler?: FabricDeviceRelayExecutionHandler;
  readonly reason: string;
  operation?: Promise<void>;
}

interface OwnedRuntime {
  readonly generation: number;
  readonly config: FabricConnectorConfigV1;
  readonly configDigest: string;
  readonly prepared: PreparedFabricConnectorInventory;
  readonly runtime: FabricConnectorRuntimePort;
  readonly relayHandler?: FabricDeviceRelayExecutionHandler;
  connectionGeneration?: number;
}

const DEFAULT_REFRESH_INTERVAL_MS = 1_000;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Readonly<Record<string, unknown>>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonical(entry)]));
}

function configDigest(config: FabricConnectorConfigV1): string {
  return createHash("sha256").update("pi-maestro.fabric.connector-service-config.v1\0", "utf8")
    .update(JSON.stringify(canonical(config)), "utf8").digest("hex");
}

function boundedPositive(value: number | undefined, fallback: number, path: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 60_000) {
    throw new FabricContractError("invalid_argument", `${path} must be in [1, 60000]`, path);
  }
  return result;
}

function serviceError(message: string, code = "connector_failed"): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function readEd25519PrivateKey(pem: Buffer): KeyObject {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw serviceError("Connector credentials are invalid", "connector_credentials_invalid");
  return key;
}

/**
 * Daemon-owned lifecycle for exactly one outbound Connector runtime.
 *
 * Each asynchronous continuation is fenced by a monotonically increasing
 * service generation and the exact daemon owner token/epoch. Publication and
 * refresh are stopped synchronously before runtime cleanup is awaited.
 */
export class FabricConnectorService {
  readonly #options: FabricConnectorServiceOptions;
  readonly #configPath: string;
  readonly #loadConfig: NonNullable<FabricConnectorServiceOptions["loadConfig"]>;
  readonly #inventory: FabricConnectorInventory;
  readonly #runtimeFactory: FabricConnectorRuntimeFactory;
  readonly #readCredentialFile: NonNullable<FabricConnectorServiceOptions["readCredentialFile"]>;
  readonly #refreshIntervalMs: number;
  readonly #cleanupTimeoutMs: number;
  #config: FabricConnectorConfigV1;
  #state: FabricConnectorServiceState = "configured";
  #reason?: string;
  #generation = 0;
  #requested = false;
  #shutdown = false;
  #current?: OwnedRuntime;
  #detachedCleanup?: DetachedRuntimeCleanup;
  #startOperation?: Promise<FabricConnectorServiceStatus>;
  #stopOperation?: Promise<FabricConnectorServiceStatus>;
  #refreshOperation?: Promise<void>;
  #refreshTimer?: NodeJS.Timeout;

  constructor(options: FabricConnectorServiceOptions) {
    if (options.deviceRelayHandler !== undefined && options.deviceRelayHandlerFactory !== undefined) {
      throw new FabricContractError("invalid_argument", "Specify only one Device relay handler seam", "deviceRelayHandlerFactory");
    }
    this.#options = options;
    this.#config = structuredClone(options.initialConfig);
    this.#configPath = options.configPath ?? fabricConnectorConfigPath(options.root);
    this.#loadConfig = options.loadConfig ?? loadFabricConnectorConfig;
    this.#runtimeFactory = options.runtimeFactory ?? ((runtimeOptions) => new FabricConnectorRuntime(runtimeOptions));
    this.#readCredentialFile = options.readCredentialFile ?? readFile;
    this.#refreshIntervalMs = boundedPositive(options.refreshIntervalMs, DEFAULT_REFRESH_INTERVAL_MS, "refreshIntervalMs");
    this.#cleanupTimeoutMs = boundedPositive(options.cleanupTimeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS, "cleanupTimeoutMs");
    this.#inventory = options.inventory ?? new FabricConnectorInventory({
      root: options.root,
      registry: options.registry,
      policy: options.policy,
      ...(options.sourceAvailability === undefined ? {} : { sourceAvailability: options.sourceAvailability }),
      ...(options.sourceRestrictions === undefined ? {} : { sourceRestrictions: options.sourceRestrictions }),
      ...(options.resolveSourceAvailability === undefined ? {} : { resolveSourceAvailability: options.resolveSourceAvailability }),
      ...(options.resolveSourceRestrictions === undefined ? {} : { resolveSourceRestrictions: options.resolveSourceRestrictions }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.windowsAclRunner === undefined ? {} : { windowsAclRunner: options.windowsAclRunner }),
    });
  }

  status(): FabricConnectorServiceStatus {
    const current = this.#current;
    return {
      configured: true,
      enabled: this.#config.enabled,
      state: this.#state,
      running: this.#state === "starting" || this.#state === "connected" || this.#state === "ready",
      connectorId: this.#config.connectorId,
      hubUrl: this.#config.hubUrl,
      keyId: this.#config.keyId,
      credentialGeneration: this.#config.credentialGeneration,
      serviceGeneration: this.#generation,
      ...(current?.connectionGeneration === undefined ? {} : { connectionGeneration: current.connectionGeneration }),
      ...(current === undefined ? {} : { advertisementRevision: current.prepared.advertisement.advertisementRevision }),
      ...(this.#reason === undefined ? {} : { reason: this.#reason }),
    };
  }

  /** Concurrent calls join one start; a later start against an owned runtime conflicts. */
  start(): Promise<FabricConnectorServiceStatus> {
    if (this.#shutdown) return Promise.reject(serviceError("Fabric Connector service is shutting down", "connector_shutdown"));
    if (this.#startOperation !== undefined) return this.#startOperation;
    if (this.#stopOperation !== undefined || this.#refreshOperation !== undefined || this.#current !== undefined || this.#detachedCleanup !== undefined || this.#requested) {
      return Promise.reject(serviceError("Fabric Connector is already started or stopping (refresh still settling)", "connector_start_conflict"));
    }
    this.#requested = true;
    const operation = this.#launch();
    this.#startOperation = operation;
    void operation.finally(() => {
      if (this.#startOperation === operation) this.#startOperation = undefined;
    }).catch(() => undefined);
    return operation;
  }

  /** Fence synchronously, then join cleanup of the exact current or refresh-detached runtime. */
  stop(reason = "the operator stopped the Connector"): Promise<FabricConnectorServiceStatus> {
    if (this.#stopOperation !== undefined) return this.#stopOperation;
    this.#requested = false;
    this.#clearRefresh();
    const detached = this.#fenceCurrent("stopped", reason);
    const cleanup = detached === undefined ? Promise.resolve() : this.#cleanupDetached(detached, reason);
    const refresh = this.#refreshOperation;
    const operation = Promise.allSettled([cleanup, ...(refresh === undefined ? [] : [refresh])]).then((results) => {
      const failure = results.find((result) => result.status === "rejected");
      if (failure !== undefined) {
        this.#state = "failed";
        this.#reason = "Connector runtime cleanup failed";
        throw serviceError("Connector runtime cleanup failed", "connector_cleanup_failed");
      }
      if (this.#state !== "failed") {
        this.#state = "stopped";
        this.#reason = undefined;
      }
      return this.status();
    });
    this.#stopOperation = operation;
    void operation.finally(() => {
      if (this.#stopOperation === operation) this.#stopOperation = undefined;
    }).catch(() => undefined);
    return operation;
  }

  /** Permanent daemon-shutdown fence; it cannot be reversed by an IPC start. */
  shutdown(reason = "the Gateway daemon is shutting down"): Promise<FabricConnectorServiceStatus> {
    this.#shutdown = true;
    return this.stop(reason);
  }

  /** Test/control seam for the same bounded single-flight refresh used by the timer. */
  refresh(): Promise<void> {
    if (!this.#requested || this.#shutdown || this.#current === undefined) return Promise.resolve();
    if (this.#refreshOperation !== undefined) return this.#refreshOperation;
    const operation = this.#refreshCurrent(this.#current);
    this.#refreshOperation = operation;
    void operation.finally(() => {
      if (this.#refreshOperation === operation) this.#refreshOperation = undefined;
      if (this.#requested && !this.#shutdown && this.#current !== undefined) this.#scheduleRefresh();
    }).catch(() => undefined);
    return operation;
  }

  async #launch(configInput?: FabricConnectorConfigV1, preparedInput?: PreparedFabricConnectorInventory): Promise<FabricConnectorServiceStatus> {
    const generation = ++this.#generation;
    this.#state = "starting";
    this.#reason = undefined;
    let runtime: FabricConnectorRuntimePort | undefined;
    let relayHandler: FabricDeviceRelayExecutionHandler | undefined;
    try {
      await this.#assertCurrentOwner(generation);
      const loaded = configInput ?? await this.#loadConfig(this.#configPath);
      this.#assertGeneration(generation);
      await this.#assertCurrentOwner(generation);
      if (loaded === undefined) throw serviceError("Fabric Connector is not configured", "connector_not_configured");
      if (!loaded.enabled) throw serviceError("Fabric Connector is disabled", "connector_disabled");
      requireIdentityMetadata(loaded);
      const loadedDigest = configDigest(loaded);
      const prepared = preparedInput ?? await this.#inventory.prepare(loaded);
      this.#assertGeneration(generation);
      await this.#assertCurrentOwner(generation);
      if (prepared.connectorId !== loaded.connectorId || prepared.deviceId !== loaded.localDeviceId) {
        throw serviceError("Connector inventory identity does not match its configuration", "connector_inventory_conflict");
      }
      let privateKey: KeyObject;
      let ca: Buffer | undefined;
      try {
        privateKey = readEd25519PrivateKey(await this.#readCredentialFile(loaded.privateKeyPath));
        ca = loaded.caPath === undefined ? undefined : await this.#readCredentialFile(loaded.caPath);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "connector_credentials_invalid") throw error;
        throw serviceError("Connector credentials could not be loaded", "connector_credentials_unavailable");
      }
      this.#assertGeneration(generation);
      await this.#assertCurrentOwner(generation);
      relayHandler = this.#options.deviceRelayHandlerFactory?.(prepared, {
        serviceGeneration: generation,
        assertCurrent: (connectionGeneration) => this.#assertRelayCurrent(generation, prepared, connectionGeneration),
      }) ?? this.#options.deviceRelayHandler;
      const runtimeOptions: FabricConnectorRuntimeOptions = {
        url: loaded.hubUrl,
        connectorId: loaded.connectorId,
        keyId: loaded.keyId,
        audience: loaded.audience,
        credentialGeneration: loaded.credentialGeneration,
        ...(ca === undefined ? {} : { ca }),
        ...(loaded.heartbeatIntervalMs === undefined ? {} : { limits: { heartbeatIntervalMs: loaded.heartbeatIntervalMs } }),
        ...(loaded.reconnectDelayMs === undefined ? {} : { reconnectDelayMs: loaded.reconnectDelayMs }),
        ...(loaded.maxReconnectAttempts === undefined ? {} : { maxReconnectAttempts: loaded.maxReconnectAttempts }),
        sign: (payload) => signPayload(null, Buffer.from(payload, "utf8"), privateKey).toString("base64"),
        advertisementOf: () => prepared.advertisement,
        ...(relayHandler === undefined ? {} : { relayHandler }),
        ...(this.#options.relayLimits === undefined ? {} : { relayLimits: this.#options.relayLimits }),
        onConnected: (info) => {
          const current = this.#current;
          if (current?.generation !== generation || current.runtime !== runtime || !this.#requested || this.#shutdown) return;
          current.connectionGeneration = info.connectionGeneration;
          this.#state = "connected";
          this.#reason = undefined;
        },
        onReady: (info) => {
          const current = this.#current;
          if (current?.generation !== generation || current.runtime !== runtime || !this.#requested || this.#shutdown) return;
          current.connectionGeneration = info.connectionGeneration;
          this.#state = "ready";
          this.#reason = undefined;
        },
        onError: () => {
          const current = this.#current;
          if (current?.generation !== generation || current.runtime !== runtime || !this.#requested || this.#shutdown) return;
          this.#state = "starting";
          this.#reason = "Hub connection interrupted; reconnecting";
        },
        onClosed: () => {
          const current = this.#current;
          if (current?.generation !== generation || current.runtime !== runtime || !this.#requested || this.#shutdown) return;
          // Fence and detach the exact relay authority synchronously. A new
          // start remains blocked by detachedCleanup until bounded cleanup of
          // both this handler and this runtime settles.
          this.#requested = false;
          this.#clearRefresh();
          const detached = this.#detachOwned(current, "Hub connection failed", "failed");
          this.#reason = "Hub connection failed";
          void this.#cleanupDetached(detached).catch(() => {
            if (this.#detachedCleanup === detached && this.#current === undefined) {
              this.#reason = "Connector runtime cleanup failed";
            }
          });
        },
      };
      runtime = this.#runtimeFactory(runtimeOptions);
      this.#assertGeneration(generation);
      this.#config = structuredClone(loaded);
      this.#current = {
        generation,
        config: structuredClone(loaded),
        configDigest: loadedDigest,
        prepared,
        runtime,
        ...(relayHandler === undefined ? {} : { relayHandler }),
      };
      await runtime.start();
      this.#assertGeneration(generation);
      await this.#assertCurrentOwner(generation);
      if (this.#current?.runtime !== runtime || !this.#requested || this.#shutdown) throw serviceError("Connector start was fenced", "connector_start_fenced");
      this.#state = "ready";
      this.#reason = undefined;
      this.#scheduleRefresh();
      return this.status();
    } catch (error) {
      const exact = this.#current?.generation === generation && this.#current.runtime === runtime;
      if (exact && runtime !== undefined) {
        const detached: DetachedRuntimeCleanup = {
          generation,
          runtime,
          reason: "Connector start failed",
          ...(relayHandler === undefined ? {} : { relayHandler }),
        };
        this.#detachedCleanup = detached;
        this.#current = undefined;
        try { await this.#cleanupDetached(detached); }
        catch {
          this.#requested = false;
          this.#state = "failed";
          this.#reason = "Connector runtime cleanup failed";
          throw serviceError("Connector runtime cleanup failed", "connector_cleanup_failed");
        }
      }
      if (generation === this.#generation && this.#requested && !this.#shutdown) {
        this.#requested = false;
        this.#state = "failed";
        this.#reason = error instanceof Error && error.message === "Fabric Connector is disabled"
          ? "Connector configuration is disabled"
          : error instanceof Error && error.message === "Fabric Connector is not configured"
            ? "Connector configuration is unavailable"
            : "Connector could not start";
      }
      if (error instanceof Error && "code" in error && typeof error.code === "string") throw error;
      throw serviceError("Connector could not start");
    }
  }

  async #refreshCurrent(owned: OwnedRuntime): Promise<void> {
    const generation = owned.generation;
    try {
      await this.#assertCurrentOwner(generation);
      const loaded = await this.#loadConfig(this.#configPath);
      this.#assertExact(owned);
      await this.#assertCurrentOwner(generation);
      if (loaded === undefined || !loaded.enabled) throw serviceError("Connector configuration is unavailable", "connector_configuration_changed");
      requireIdentityMetadata(loaded);
      const prepared = await this.#inventory.prepare(loaded);
      this.#assertExact(owned);
      await this.#assertCurrentOwner(generation);
      const nextConfigDigest = configDigest(loaded);
      if (nextConfigDigest === owned.configDigest && prepared.snapshotDigest === owned.prepared.snapshotDigest) return;

      // Represent detached ownership before clearing current. Stop/shutdown can
      // now join this exact cleanup, and no successor exists until it succeeds.
      this.#clearRefresh();
      const detached = this.#detachOwned(owned, "Connector inventory changed", "starting");
      await this.#cleanupDetached(detached);
      if (!this.#requested || this.#shutdown) return;
      await this.#launch(loaded, prepared);
    } catch (error) {
      if (!this.#requested || this.#shutdown) return;
      const ownsCurrent = this.#current === owned;
      const ownsDetached = this.#detachedCleanup?.runtime === owned.runtime;
      // A predecessor refresh must never mutate a successor generation.
      if (!ownsCurrent && !ownsDetached) return;
      let cleanupFailed = ownsDetached;
      if (ownsCurrent) {
        this.#clearRefresh();
        const detached = this.#detachOwned(owned, "Connector inventory refresh failed", "failed");
        const failureGeneration = this.#generation;
        try { await this.#cleanupDetached(detached); }
        catch { cleanupFailed = true; }
        if (this.#generation !== failureGeneration || this.#current !== undefined || !this.#requested || this.#shutdown) return;
      } else if (this.#current !== undefined) {
        return;
      }
      this.#requested = false;
      this.#state = "failed";
      this.#reason = cleanupFailed ? "Connector runtime cleanup failed" : "Connector inventory refresh failed";
      if (cleanupFailed) throw serviceError("Connector runtime cleanup failed", "connector_cleanup_failed");
      if (error instanceof Error && "code" in error && typeof error.code === "string") throw error;
      throw serviceError("Connector inventory refresh failed");
    }
  }

  #scheduleRefresh(): void {
    this.#clearRefresh();
    if (!this.#requested || this.#shutdown || this.#current === undefined) return;
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined;
      void this.refresh().catch(() => undefined);
    }, this.#refreshIntervalMs);
    this.#refreshTimer.unref?.();
  }

  #clearRefresh(): void {
    if (this.#refreshTimer !== undefined) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = undefined;
  }

  #fenceCurrent(state: "stopped", reason: string): DetachedRuntimeCleanup | undefined {
    this.#generation += 1;
    const owned = this.#current;
    let detached = this.#detachedCleanup;
    if (owned !== undefined) {
      if (detached !== undefined && detached.runtime !== owned.runtime) {
        throw serviceError("Connector cleanup ownership conflicted", "connector_cleanup_conflict");
      }
      detached ??= {
        generation: owned.generation,
        runtime: owned.runtime,
        reason,
        ...(owned.relayHandler === undefined ? {} : { relayHandler: owned.relayHandler }),
      };
      this.#detachedCleanup = detached;
      this.#current = undefined;
    }
    this.#state = state;
    this.#reason = undefined;
    return detached;
  }

  #detachOwned(owned: OwnedRuntime, reason: string, state: "starting" | "failed"): DetachedRuntimeCleanup {
    if (this.#current !== owned) throw serviceError("Connector runtime owner changed", "connector_operation_fenced");
    if (this.#detachedCleanup !== undefined && this.#detachedCleanup.runtime !== owned.runtime) {
      throw serviceError("Connector cleanup ownership conflicted", "connector_cleanup_conflict");
    }
    const detached = this.#detachedCleanup ?? {
      generation: owned.generation,
      runtime: owned.runtime,
      reason,
      ...(owned.relayHandler === undefined ? {} : { relayHandler: owned.relayHandler }),
    };
    this.#detachedCleanup = detached;
    this.#current = undefined;
    this.#generation += 1;
    this.#state = state;
    return detached;
  }

  #cleanupDetached(detached: DetachedRuntimeCleanup, reason = detached.reason): Promise<void> {
    if (detached.operation !== undefined) return detached.operation;
    const operation = this.#stopExact(detached, reason).then(() => {
      if (this.#detachedCleanup === detached) this.#detachedCleanup = undefined;
    }, (error: unknown) => {
      if (this.#detachedCleanup === detached) detached.operation = undefined;
      throw error;
    });
    detached.operation = operation;
    return operation;
  }

  async #stopExact(detached: DetachedRuntimeCleanup, reason: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const cleanup = Promise.allSettled([
        Promise.resolve().then(() => detached.relayHandler?.close?.(reason)),
        Promise.resolve().then(() => detached.runtime.stop(reason)),
      ]).then((results) => {
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      });
      await Promise.race([
        cleanup,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(serviceError("Connector runtime cleanup timed out", "connector_cleanup_timeout")), this.#cleanupTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #assertRelayCurrent(
    generation: number,
    prepared: PreparedFabricConnectorInventory,
    connectionGeneration: number,
  ): Promise<void> {
    const current = this.#current;
    if (current === undefined || current.generation !== generation || current.prepared !== prepared ||
      current.connectionGeneration !== connectionGeneration || current.relayHandler === undefined ||
      !this.#requested || this.#shutdown) {
      throw serviceError("Connector relay authority was fenced", "connector_operation_fenced");
    }
    await this.#options.assertOwner(this.#options.owner);
    const after = this.#current;
    if (after !== current || after.connectionGeneration !== connectionGeneration || !this.#requested || this.#shutdown) {
      throw serviceError("Connector relay authority was fenced", "connector_operation_fenced");
    }
  }

  async #assertCurrentOwner(generation: number): Promise<void> {
    this.#assertGeneration(generation);
    await this.#options.assertOwner(this.#options.owner);
    this.#assertGeneration(generation);
  }

  #assertGeneration(generation: number): void {
    if (generation !== this.#generation || !this.#requested || this.#shutdown) {
      throw serviceError("Connector operation was fenced", "connector_operation_fenced");
    }
  }

  #assertExact(owned: OwnedRuntime): void {
    this.#assertGeneration(owned.generation);
    if (this.#current !== owned) throw serviceError("Connector runtime owner changed", "connector_operation_fenced");
  }
}
