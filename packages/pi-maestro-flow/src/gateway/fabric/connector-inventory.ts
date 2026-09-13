import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BackendCapabilities } from "pi-maestro-backend-core/v1/backend";
import {
  FabricContractError,
  assertFabricIdentifier,
  assertGeneration,
  assertRevision,
  assertValidCapabilityBinding,
  assertValidEndpointRecord,
  assertValidWorkspaceRecord,
  type AgentRuntimeEndpoint,
  type CapabilityBinding,
  type DeviceRecord,
  type JsonValue,
  type WorkspaceRecord,
} from "pi-maestro-fabric-core/v1";
import type { GatewayPolicy } from "../policy.ts";
import { createLocalGatewayPrincipal } from "../principal.ts";
import { enforceGatewayPrivatePath, type GatewayWindowsAclRunner } from "../private-path.ts";
import { writeGatewayJsonAtomic } from "../state-paths.ts";
import type { WorkspaceRegistry } from "../workspace-registry.ts";
import type { FabricConnectorConfigV1 } from "./connector-config.ts";
import type { FabricConnectorAdvertisement } from "./connector-runtime.ts";

export const FABRIC_CONNECTOR_INVENTORY_MANIFEST_VERSION = "fabric.connector-inventory-manifest.v1" as const;
export const FABRIC_CONNECTOR_INVENTORY_MANIFEST_FILE = "fabric-connector-inventory.json";
const MAX_MANIFEST_BYTES = 256 * 1024;
const DEFAULT_PREPARE_TIMEOUT_MS = 30_000;

interface InventoryWorkspaceHighWater {
  readonly localIdentityDigest: string;
  readonly workspaceId: string;
  readonly identityDigest: string;
  readonly policyDigest: string;
  readonly generation: number;
  readonly revision: number;
  readonly active: boolean;
}

export interface FabricConnectorInventoryManifestV1 {
  readonly version: typeof FABRIC_CONNECTOR_INVENTORY_MANIFEST_VERSION;
  readonly connectorId: string;
  readonly deviceId: string;
  readonly identityDigest: string;
  readonly policyDigest: string;
  readonly snapshotDigest: string;
  readonly generation: number;
  readonly revision: number;
  readonly workspaces: readonly InventoryWorkspaceHighWater[];
}

export interface FabricDeviceSourceBackendAvailability {
  readonly name: string;
  readonly capabilities: BackendCapabilities;
}

/** Positive, source-local facts supplied by the runtime owner. */
export interface FabricDeviceSourceAvailability {
  readonly roles: readonly string[];
  readonly taskTypes: readonly string[];
  readonly models: readonly string[];
  readonly backends: readonly FabricDeviceSourceBackendAvailability[];
}

/** Explicit export policy. Omission is fail-closed and exports no Agent Endpoint. */
export interface FabricDeviceSourceRestrictions {
  readonly roles: readonly string[];
  readonly taskTypes: readonly string[];
  readonly models: readonly string[];
  readonly backends: readonly string[];
  readonly maxConcurrency: number;
}

export interface ResolvedFabricDeviceSourceProjection {
  readonly roles: readonly string[];
  readonly taskTypes: readonly string[];
  readonly models: readonly string[];
  readonly backends: readonly FabricDeviceSourceBackendAvailability[];
  readonly maxConcurrency: number;
  readonly digest: string;
}

export interface PreparedFabricWorkspaceBinding {
  readonly workspaceId: string;
  readonly workspaceGeneration: number;
  readonly localWorkspaceId: string;
  readonly localWorkspaceGeneration: number;
}

export interface PreparedFabricConnectorInventory {
  readonly connectorId: string;
  readonly deviceId: string;
  readonly identityDigest: string;
  readonly policyDigest: string;
  readonly snapshotDigest: string;
  readonly manifestGeneration: number;
  readonly manifestRevision: number;
  /** Host-private mapping retained only in the daemon-owned prepared snapshot. */
  readonly workspaceBindings: readonly PreparedFabricWorkspaceBinding[];
  readonly source?: ResolvedFabricDeviceSourceProjection;
  readonly advertisement: FabricConnectorAdvertisement;
}

export type FabricDeviceSourceAvailabilityProvider = (
  config: FabricConnectorConfigV1,
  signal: AbortSignal,
) => FabricDeviceSourceAvailability | undefined | Promise<FabricDeviceSourceAvailability | undefined>;

export type FabricDeviceSourceRestrictionsProvider = (
  config: FabricConnectorConfigV1,
  signal: AbortSignal,
) => FabricDeviceSourceRestrictions | undefined | Promise<FabricDeviceSourceRestrictions | undefined>;

export interface FabricConnectorInventoryOptions {
  readonly root: string;
  readonly registry: WorkspaceRegistry;
  readonly policy: GatewayPolicy;
  readonly sourceAvailability?: FabricDeviceSourceAvailability;
  readonly sourceRestrictions?: FabricDeviceSourceRestrictions;
  /** Live source authorities resolved once for each prepare generation. */
  readonly resolveSourceAvailability?: FabricDeviceSourceAvailabilityProvider;
  readonly resolveSourceRestrictions?: FabricDeviceSourceRestrictionsProvider;
  readonly manifestPath?: string;
  readonly prepareTimeoutMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly windowsAclRunner?: GatewayWindowsAclRunner;
}

interface InventoryOperationOwner {
  readonly generation: number;
  readonly controller: AbortController;
}

interface InventoryInFlight {
  readonly owner: InventoryOperationOwner;
  readonly configDigest: string;
  readonly promise: Promise<PreparedFabricConnectorInventory>;
}

interface ProjectedWorkspace {
  readonly localIdentityDigest: string;
  readonly localWorkspaceId: string;
  readonly localWorkspaceGeneration: number;
  readonly workspaceId: string;
  readonly identityDigest: string;
  readonly policyDigest: string;
  readonly mode: "lease" | "permanent";
}

const principal = createLocalGatewayPrincipal("fabric-connector-inventory", {
  authenticated: true,
  source: "fabric-connector-inventory",
  scopes: ["gateway"],
});

function digest(namespace: string, value: unknown): string {
  return createHash("sha256")
    .update(namespace, "utf8")
    .update("\0", "utf8")
    .update(JSON.stringify(canonical(value)), "utf8")
    .digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonical(entry)]));
}

function opaqueId(prefix: "workspace" | "local", ...identity: readonly string[]): string {
  return `${prefix}-${createHash("sha256").update(`pi-maestro.fabric.${prefix}.v1\0`, "utf8")
    .update(identity.join("\0"), "utf8").digest("hex").slice(0, 48)}`;
}

function intersect(actual: readonly string[], allowed: readonly string[]): string[] {
  const permitted = new Set(allowed);
  return [...new Set(actual)].filter((value) => permitted.has(value)).sort((left, right) => left.localeCompare(right));
}

function assertBackendCapabilities(capabilities: BackendCapabilities, path: string): void {
  const keys: readonly (keyof BackendCapabilities)[] = [
    "outputSchema", "forkContext", "modelSelection", "thinkingLevel", "todoBinding",
    "toolFilter", "steer", "followUp", "abort",
  ];
  for (const key of keys) {
    if (!(["native", "emulated", "unsupported"] as const).includes(capabilities[key])) {
      throw new FabricContractError("invalid_argument", `${path}.${key} is invalid`, `${path}.${key}`);
    }
  }
}

/** Resolve the one capability projection used by both advertisement and execution. */
export function resolveFabricDeviceSourceProjection(
  availability: FabricDeviceSourceAvailability | undefined,
  restrictions: FabricDeviceSourceRestrictions | undefined,
): ResolvedFabricDeviceSourceProjection | undefined {
  if (availability === undefined || restrictions === undefined) return undefined;
  if (!Number.isSafeInteger(restrictions.maxConcurrency) || restrictions.maxConcurrency < 1) {
    throw new FabricContractError("invalid_argument", "sourceRestrictions.maxConcurrency must be positive", "sourceRestrictions.maxConcurrency");
  }
  const roles = intersect(availability.roles, restrictions.roles);
  const taskTypes = intersect(availability.taskTypes, restrictions.taskTypes);
  const models = intersect(availability.models, restrictions.models);
  const allowedBackends = new Set(restrictions.backends);
  const backends = availability.backends
    .filter((backend) => allowedBackends.has(backend.name))
    .map((backend, index) => {
      assertFabricIdentifier(backend.name, `sourceAvailability.backends[${index}].name`);
      assertBackendCapabilities(backend.capabilities, `sourceAvailability.backends[${index}].capabilities`);
      return { name: backend.name, capabilities: structuredClone(backend.capabilities) };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  if (roles.length === 0 || taskTypes.length === 0 || models.length === 0 || backends.length === 0) return undefined;
  const projection = { roles, taskTypes, models, backends, maxConcurrency: restrictions.maxConcurrency };
  // Endpoint validation below is the canonical syntax check for role/task/model lists.
  return { ...projection, digest: digest("pi-maestro.fabric.device-source-projection.v1", projection) };
}

function exactKeys(value: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new FabricContractError("invalid_argument", `${path}.${key} is not supported`, `${path}.${key}`);
  }
}

function record(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FabricContractError("invalid_argument", `${path} must be an object`, path);
  }
  return value as Readonly<Record<string, unknown>>;
}

function requiredPositiveRevision(value: unknown, path: string): number {
  assertRevision(value, path);
  if (value < 1) throw new FabricContractError("invalid_argument", `${path} must be positive`, path);
  return value;
}

function requiredDigest(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new FabricContractError("invalid_argument", `${path} must be a SHA-256 digest`, path);
  }
  return value;
}

function parseManifest(input: unknown): FabricConnectorInventoryManifestV1 {
  const source = record(input, "manifest");
  exactKeys(source, new Set(["version", "connectorId", "deviceId", "identityDigest", "policyDigest", "snapshotDigest", "generation", "revision", "workspaces"]), "manifest");
  if (source.version !== FABRIC_CONNECTOR_INVENTORY_MANIFEST_VERSION) {
    throw new FabricContractError("unsupported_version", "Unsupported Connector inventory manifest version", "manifest.version");
  }
  assertFabricIdentifier(source.connectorId, "manifest.connectorId");
  assertFabricIdentifier(source.deviceId, "manifest.deviceId");
  assertGeneration(source.generation, "manifest.generation");
  const manifestRevision = requiredPositiveRevision(source.revision, "manifest.revision");
  if (!Array.isArray(source.workspaces) || source.workspaces.length > 256) {
    throw new FabricContractError("invalid_argument", "manifest.workspaces must be a bounded array", "manifest.workspaces");
  }
  const workspaces = source.workspaces.map((entry, index): InventoryWorkspaceHighWater => {
    const item = record(entry, `manifest.workspaces[${index}]`);
    exactKeys(item, new Set(["localIdentityDigest", "workspaceId", "identityDigest", "policyDigest", "generation", "revision", "active"]), `manifest.workspaces[${index}]`);
    assertFabricIdentifier(item.workspaceId, `manifest.workspaces[${index}].workspaceId`);
    assertGeneration(item.generation, `manifest.workspaces[${index}].generation`);
    const workspaceRevision = requiredPositiveRevision(item.revision, `manifest.workspaces[${index}].revision`);
    if (typeof item.active !== "boolean") throw new FabricContractError("invalid_argument", "manifest workspace active must be a boolean", `manifest.workspaces[${index}].active`);
    return {
      localIdentityDigest: requiredDigest(item.localIdentityDigest, `manifest.workspaces[${index}].localIdentityDigest`),
      workspaceId: item.workspaceId,
      identityDigest: requiredDigest(item.identityDigest, `manifest.workspaces[${index}].identityDigest`),
      policyDigest: requiredDigest(item.policyDigest, `manifest.workspaces[${index}].policyDigest`),
      generation: item.generation,
      revision: workspaceRevision,
      active: item.active,
    };
  });
  if (new Set(workspaces.map((entry) => entry.localIdentityDigest)).size !== workspaces.length ||
    new Set(workspaces.map((entry) => entry.workspaceId)).size !== workspaces.length) {
    throw new FabricContractError("invalid_argument", "manifest workspace identities must be unique", "manifest.workspaces");
  }
  return {
    version: FABRIC_CONNECTOR_INVENTORY_MANIFEST_VERSION,
    connectorId: source.connectorId,
    deviceId: source.deviceId,
    identityDigest: requiredDigest(source.identityDigest, "manifest.identityDigest"),
    policyDigest: requiredDigest(source.policyDigest, "manifest.policyDigest"),
    snapshotDigest: requiredDigest(source.snapshotDigest, "manifest.snapshotDigest"),
    generation: source.generation,
    revision: manifestRevision,
    workspaces,
  };
}

function cloneDevices(devices: readonly DeviceRecord[]): DeviceRecord[] {
  return [...devices]
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
    .map((device) => structuredClone(device));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Readonly<Record<string, unknown>>)) deepFreeze(child);
  return value;
}

export function fabricConnectorInventoryManifestPath(root: string): string {
  return join(root, ".pi", FABRIC_CONNECTOR_INVENTORY_MANIFEST_FILE);
}

/**
 * Builds the Connector's complete authority snapshot from only enrollment
 * metadata plus the live local registry/policy. Paths and local owner evidence
 * never enter either the manifest or the wire projection.
 */
export class FabricConnectorInventory {
  readonly manifestPath: string;
  readonly #options: FabricConnectorInventoryOptions;
  readonly #timeoutMs: number;
  #operationGeneration = 0;
  #inFlight?: InventoryInFlight;

  constructor(options: FabricConnectorInventoryOptions) {
    this.#options = options;
    this.manifestPath = options.manifestPath ?? fabricConnectorInventoryManifestPath(options.root);
    this.#timeoutMs = options.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60_000) {
      throw new FabricContractError("invalid_argument", "prepareTimeoutMs must be in [1, 60000]", "prepareTimeoutMs");
    }
  }

  /** One bounded single-flight preparation. No previous snapshot is cached. */
  prepare(config: FabricConnectorConfigV1): Promise<PreparedFabricConnectorInventory> {
    const configSnapshot = structuredClone(config);
    const requestedDigest = digest("pi-maestro.fabric.connector-inventory-operation.v1", configSnapshot);
    const current = this.#inFlight;
    if (current !== undefined) {
      if (current.configDigest !== requestedDigest) {
        return Promise.reject(new FabricContractError("conflict", "A different Connector inventory configuration is already being prepared"));
      }
      return this.#bounded(current);
    }
    const owner: InventoryOperationOwner = {
      generation: ++this.#operationGeneration,
      controller: new AbortController(),
    };
    const operation: InventoryInFlight = {
      owner,
      configDigest: requestedDigest,
      promise: Promise.resolve().then(() => this.#prepare(configSnapshot, owner)),
    };
    this.#inFlight = operation;
    void operation.promise.finally(() => {
      if (this.#inFlight === operation) this.#inFlight = undefined;
    }).catch(() => undefined);
    return this.#bounded(operation);
  }

  async #bounded(operation: InventoryInFlight): Promise<PreparedFabricConnectorInventory> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation.promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            if (this.#inFlight === operation) {
              operation.owner.controller.abort();
              this.#inFlight = undefined;
            }
            reject(new FabricContractError("unavailable", "Connector inventory preparation timed out"));
          }, this.#timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #prepare(config: FabricConnectorConfigV1, owner: InventoryOperationOwner): Promise<PreparedFabricConnectorInventory> {
    this.#assertOperation(owner);
    if (!config.enabled) throw new FabricContractError("permission_denied", "Fabric Connector configuration is disabled");
    if (config.devices === undefined || config.localDeviceId === undefined || config.workspaceIds === undefined) {
      throw new FabricContractError("invalid_state", "Fabric Connector configuration lacks Device enrollment metadata");
    }
    const localDevice = config.devices.find((device) => device.deviceId === config.localDeviceId);
    if (localDevice === undefined || localDevice.connectorId !== config.connectorId || !localDevice.enabled) {
      throw new FabricContractError("permission_denied", "The local Device is not enabled authority for this Connector", "localDeviceId");
    }

    const sourceAvailability = this.#options.resolveSourceAvailability === undefined
      ? this.#options.sourceAvailability
      : await this.#options.resolveSourceAvailability(structuredClone(config), owner.controller.signal);
    this.#assertOperation(owner);
    const sourceRestrictions = this.#options.resolveSourceRestrictions === undefined
      ? this.#options.sourceRestrictions
      : await this.#options.resolveSourceRestrictions(structuredClone(config), owner.controller.signal);
    this.#assertOperation(owner);
    const source = resolveFabricDeviceSourceProjection(
      sourceAvailability === undefined ? undefined : structuredClone(sourceAvailability),
      sourceRestrictions === undefined ? undefined : structuredClone(sourceRestrictions),
    );
    const allowed = new Set(config.workspaceIds);
    this.#assertOperation(owner);
    const live = await this.#options.registry.list();
    this.#assertOperation(owner);
    const projected: ProjectedWorkspace[] = [];
    for (const workspace of live) {
      if (!allowed.has(workspace.id)) continue;
      this.#assertOperation(owner);
      const decision = await this.#options.policy.authorizeWorkspace(principal, workspace.id);
      this.#assertOperation(owner);
      if (!decision.allowed || decision.workspaceId !== workspace.id) continue;
      const localIdentityDigest = digest("pi-maestro.fabric.local-workspace-identity.v1", {
        connectorId: config.connectorId,
        deviceId: localDevice.deviceId,
        localWorkspaceId: workspace.id,
      });
      const workspaceId = opaqueId("workspace", config.connectorId, localDevice.deviceId, workspace.id);
      const identityDigest = digest("pi-maestro.fabric.workspace-identity.v1", {
        connectorId: config.connectorId,
        deviceId: localDevice.deviceId,
        localIdentityDigest,
        workspaceId,
      });
      const policyDigest = digest("pi-maestro.fabric.workspace-policy.v1", {
        mode: workspace.mode,
        localGeneration: workspace.generation,
        sourceDigest: source?.digest ?? null,
        ...(workspace.expiresAt === undefined ? {} : { expiresAt: workspace.expiresAt }),
      });
      projected.push({
        localIdentityDigest,
        localWorkspaceId: workspace.id,
        localWorkspaceGeneration: workspace.generation,
        workspaceId,
        identityDigest,
        policyDigest,
        mode: workspace.mode,
      });
    }
    projected.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));

    this.#assertOperation(owner);
    const previous = await this.#readManifest(owner);
    this.#assertOperation(owner);
    const identityDigest = digest("pi-maestro.fabric.connector-inventory-identity.v1", {
      connectorId: config.connectorId,
      deviceId: localDevice.deviceId,
      credentialGeneration: config.credentialGeneration,
      devices: cloneDevices(config.devices),
    });
    const priorByLocal = new Map(previous?.workspaces.map((entry) => [entry.localIdentityDigest, entry]));
    const active = new Set(projected.map((entry) => entry.localIdentityDigest));
    const highWater: InventoryWorkspaceHighWater[] = [];
    const records: WorkspaceRecord[] = [];
    const endpoints: AgentRuntimeEndpoint[] = [];
    const capabilities: CapabilityBinding[] = [];

    for (const workspace of projected) {
      const prior = priorByLocal.get(workspace.localIdentityDigest);
      const unchanged = prior !== undefined && prior.active && prior.identityDigest === workspace.identityDigest && prior.policyDigest === workspace.policyDigest;
      const generation = prior === undefined ? 1 : unchanged ? prior.generation : prior.generation + 1;
      const revision = prior === undefined ? 1 : unchanged ? prior.revision : prior.revision + 1;
      if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(revision)) throw new FabricContractError("resource_exhausted", "Connector workspace inventory high-water is exhausted");
      const entry: InventoryWorkspaceHighWater = {
        localIdentityDigest: workspace.localIdentityDigest,
        workspaceId: workspace.workspaceId,
        identityDigest: workspace.identityDigest,
        policyDigest: workspace.policyDigest,
        generation,
        revision,
        active: true,
      };
      highWater.push(entry);
      const endpointIds: string[] = [];
      if (source !== undefined) {
        const endpointId = `agent-${createHash("sha256")
          .update("pi-maestro.fabric.device-agent-endpoint.v1\0", "utf8")
          .update(config.connectorId, "utf8").update("\0", "utf8")
          .update(localDevice.deviceId, "utf8").update("\0", "utf8")
          .update(workspace.localIdentityDigest, "utf8").digest("hex").slice(0, 48)}`;
        const endpoint: AgentRuntimeEndpoint = {
          endpointId,
          deviceId: localDevice.deviceId,
          connectorId: config.connectorId,
          scope: { kind: "workspace", workspaceId: workspace.workspaceId },
          generation,
          contractHash: source.digest,
          status: "online",
          revision,
          kind: "agent",
          roles: [...source.roles],
          taskTypes: [...source.taskTypes],
          models: [...source.models],
          maxConcurrency: source.maxConcurrency,
        };
        assertValidEndpointRecord(endpoint);
        endpoints.push(endpoint);
        endpointIds.push(endpointId);
        source.backends.forEach((backend, index) => {
          const capability: CapabilityBinding = {
            capabilityId: `capability-${createHash("sha256")
              .update("pi-maestro.fabric.device-agent-capability.v1\0", "utf8")
              .update(endpointId, "utf8").update("\0", "utf8")
              .update(backend.name, "utf8").digest("hex").slice(0, 48)}`,
            kind: "agent-competency",
            endpointId,
            inputSchema: {
              backend: backend.name,
              capabilities: backend.capabilities as unknown as JsonValue,
            },
            // Directory admission requires every capability binding to carry
            // the exact contract of its owning Endpoint. That Endpoint digest
            // already commits to the complete backend/capability projection.
            contractHash: source.digest,
            trustLevel: "source-local-proven",
            locality: "device",
            priority: index,
          };
          assertValidCapabilityBinding(capability);
          capabilities.push(capability);
        });
      }
      const wire: WorkspaceRecord = {
        workspaceId: workspace.workspaceId,
        deviceId: localDevice.deviceId,
        localWorkspaceId: opaqueId("local", localDevice.deviceId, workspace.localIdentityDigest),
        label: `Workspace ${workspace.workspaceId.slice(-12)}`,
        mode: workspace.mode,
        generation,
        policyDigest: workspace.policyDigest,
        endpointIds,
        revision,
      };
      assertValidWorkspaceRecord(wire);
      records.push(wire);
    }
    for (const prior of previous?.workspaces ?? []) {
      if (active.has(prior.localIdentityDigest)) continue;
      if (!prior.active) highWater.push(prior);
      else {
        if (!Number.isSafeInteger(prior.revision + 1)) throw new FabricContractError("resource_exhausted", "Connector workspace inventory high-water is exhausted");
        highWater.push({ ...prior, revision: prior.revision + 1, active: false });
      }
    }
    highWater.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
    if (highWater.length > 256) {
      throw new FabricContractError("resource_exhausted", "Connector workspace inventory high-water exceeds 256 entries", "manifest.workspaces");
    }

    const policyDigest = digest("pi-maestro.fabric.connector-inventory-policy.v1", records.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      generation: workspace.generation,
      policyDigest: workspace.policyDigest,
      revision: workspace.revision,
    })));
    const devices = cloneDevices(config.devices);
    endpoints.sort((left, right) => left.endpointId.localeCompare(right.endpointId));
    capabilities.sort((left, right) => left.capabilityId.localeCompare(right.capabilityId));
    const payload = { devices, workspaces: records, endpoints, capabilities };
    const snapshotDigest = digest("pi-maestro.fabric.connector-advertisement.v1", payload);
    const identityChanged = previous !== undefined && previous.identityDigest !== identityDigest;
    const contentChanged = previous === undefined || previous.snapshotDigest !== snapshotDigest || identityChanged;
    const generation = previous === undefined ? 1 : identityChanged ? previous.generation + 1 : previous.generation;
    const revision = previous === undefined ? 1 : contentChanged ? previous.revision + 1 : previous.revision;
    if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(revision)) throw new FabricContractError("resource_exhausted", "Connector inventory manifest high-water is exhausted");
    const manifest: FabricConnectorInventoryManifestV1 = {
      version: FABRIC_CONNECTOR_INVENTORY_MANIFEST_VERSION,
      connectorId: config.connectorId,
      deviceId: localDevice.deviceId,
      identityDigest,
      policyDigest,
      snapshotDigest,
      generation,
      revision,
      workspaces: highWater,
    };
    this.#assertOperation(owner);
    if (previous === undefined || JSON.stringify(previous) !== JSON.stringify(manifest)) await this.#writeManifest(manifest, owner);
    this.#assertOperation(owner);

    return deepFreeze({
      connectorId: config.connectorId,
      deviceId: localDevice.deviceId,
      identityDigest,
      policyDigest,
      snapshotDigest,
      manifestGeneration: generation,
      manifestRevision: revision,
      workspaceBindings: projected.map((workspace) => {
        const manifestWorkspace = highWater.find((entry) => entry.localIdentityDigest === workspace.localIdentityDigest && entry.active);
        if (manifestWorkspace === undefined) throw new FabricContractError("invalid_state", "Prepared workspace mapping lost its manifest generation");
        return {
          workspaceId: workspace.workspaceId,
          workspaceGeneration: manifestWorkspace.generation,
          localWorkspaceId: workspace.localWorkspaceId,
          localWorkspaceGeneration: workspace.localWorkspaceGeneration,
        };
      }),
      ...(source === undefined ? {} : { source }),
      advertisement: {
        advertisementRevision: revision,
        capabilityDigest: snapshotDigest,
        payload: payload as unknown as Readonly<Record<string, JsonValue>>,
      },
    });
  }

  async #readManifest(owner: InventoryOperationOwner): Promise<FabricConnectorInventoryManifestV1 | undefined> {
    this.#assertOperation(owner);
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try { metadata = await lstat(this.manifestPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    this.#assertOperation(owner);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new FabricContractError("invalid_argument", "Connector inventory manifest must be a regular private file", "manifest");
    }
    if (metadata.size > MAX_MANIFEST_BYTES) {
      throw new FabricContractError("resource_exhausted", "Connector inventory manifest exceeds its serialized-size limit", "manifest");
    }
    await enforceGatewayPrivatePath(dirname(this.manifestPath), "directory", this.#privacyOptions());
    this.#assertOperation(owner);
    await enforceGatewayPrivatePath(this.manifestPath, "file", this.#privacyOptions());
    this.#assertOperation(owner);
    const raw = await readFile(this.manifestPath, "utf8");
    this.#assertOperation(owner);
    if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) {
      throw new FabricContractError("resource_exhausted", "Connector inventory manifest exceeds its serialized-size limit", "manifest");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new FabricContractError("invalid_argument", "Connector inventory manifest is not valid JSON"); }
    return parseManifest(parsed);
  }

  async #writeManifest(manifest: FabricConnectorInventoryManifestV1, owner: InventoryOperationOwner): Promise<void> {
    this.#assertOperation(owner);
    if (manifest.workspaces.length > 256) {
      throw new FabricContractError("resource_exhausted", "Connector workspace inventory high-water exceeds 256 entries", "manifest.workspaces");
    }
    parseManifest(manifest);
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_MANIFEST_BYTES) {
      throw new FabricContractError("resource_exhausted", "Connector inventory manifest exceeds its serialized-size limit", "manifest");
    }
    await mkdir(dirname(this.manifestPath), { recursive: true, mode: 0o700 });
    this.#assertOperation(owner);
    await enforceGatewayPrivatePath(dirname(this.manifestPath), "directory", this.#privacyOptions());
    this.#assertOperation(owner);
    await writeGatewayJsonAtomic(this.manifestPath, manifest, {
      mode: 0o600,
      maximumBytes: MAX_MANIFEST_BYTES,
      signal: owner.controller.signal,
    });
    this.#assertOperation(owner);
    await enforceGatewayPrivatePath(this.manifestPath, "file", this.#privacyOptions());
    this.#assertOperation(owner);
  }

  #assertOperation(owner: InventoryOperationOwner): void {
    if (this.#inFlight?.owner !== owner || owner.generation !== this.#operationGeneration || owner.controller.signal.aborted) {
      throw new FabricContractError("cancelled", "Connector inventory preparation owner was fenced");
    }
  }

  #privacyOptions(): { platform?: NodeJS.Platform; windowsAclRunner?: GatewayWindowsAclRunner } {
    return {
      ...(this.#options.platform === undefined ? {} : { platform: this.#options.platform }),
      ...(this.#options.windowsAclRunner === undefined ? {} : { windowsAclRunner: this.#options.windowsAclRunner }),
    };
  }
}
