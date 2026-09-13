import {
  FabricContractError,
  assertBoundedString,
  assertEpochMilliseconds,
  assertFabricIdentifier,
  assertGeneration,
  assertRevision,
  assertValidCapabilityBinding,
  assertValidConnectorRecord,
  assertValidDeviceRecord,
  assertValidEndpointRecord,
  assertValidWorkspaceRecord,
  projectCapability,
  projectConnector,
  projectDevice,
  projectEndpoint,
  projectWorkspace,
  type CapabilityBinding,
  type CapabilityCandidate,
  type ConnectorRecord,
  type DeviceRecord,
  type EndpointRecord,
  type FabricCapabilityKind,
  type PublicConnectorRecord,
  type PublicWorkspaceRecord,
  type WorkspaceRecord,
} from "pi-maestro-fabric-core/v1";
import {
  FABRIC_DIRECTORY_ADVERTISEMENT_AUTHORITY,
  FABRIC_DIRECTORY_PUBLISH_ADVERTISEMENT,
  FABRIC_DIRECTORY_RECORD_PERSISTED_ADVERTISEMENT,
  FABRIC_DIRECTORY_REGISTRY_AUTHORITY,
  FABRIC_DIRECTORY_STAGE_ADVERTISEMENT,
  FABRIC_DIRECTORY_WITHDRAW_ADVERTISEMENT,
  type DirectoryAdvertisementAuthorityContext,
} from "./directory-authority.ts";

export interface FabricAuthoritySeed {
  connector: ConnectorRecord;
  devices: readonly DeviceRecord[];
}

export interface FabricAdvertisementSnapshot {
  connectionId: string;
  connectionGeneration: number;
  capabilityDigest: string;
  advertisementRevision: number;
  devices: readonly DeviceRecord[];
  workspaces: readonly WorkspaceRecord[];
  endpoints: readonly EndpointRecord[];
  capabilities: readonly CapabilityBinding[];
}

export interface FabricAdvertisementDeltaRecords {
  workspaces?: readonly WorkspaceRecord[];
  endpoints?: readonly EndpointRecord[];
  capabilities?: readonly CapabilityBinding[];
}

export interface FabricAdvertisementDeltaRemovals {
  workspaceIds?: readonly string[];
  endpointIds?: readonly string[];
  capabilityIds?: readonly string[];
}

export interface FabricAdvertisementDelta {
  connectionId: string;
  connectionGeneration: number;
  capabilityDigest: string;
  baseRevision: number;
  advertisementRevision: number;
  upserts?: FabricAdvertisementDeltaRecords;
  removals?: FabricAdvertisementDeltaRemovals;
}

export interface AcceptedAdvertisementMetadata {
  connectionId: string;
  connectionGeneration: number;
  connectorId: string;
  capabilityDigest: string;
  advertisementRevision: number;
}

export interface FabricAdvertisementRemovalTombstone {
  readonly subjectId: string;
  readonly generation: number;
  readonly revision: number;
}

export interface FabricCapabilityRemovalTombstone {
  readonly capabilityId: string;
  readonly endpointGeneration: number;
}

export interface FabricAdvertisementRemovalSet {
  readonly workspaces: readonly FabricAdvertisementRemovalTombstone[];
  readonly endpoints: readonly FabricAdvertisementRemovalTombstone[];
  readonly capabilities: readonly FabricCapabilityRemovalTombstone[];
}

/**
 * Immutable, fully validated persistence input. Production adapters commit all
 * rows represented here in one registry transaction before returning.
 */
export interface FabricStagedAdvertisementCandidate extends AcceptedAdvertisementMetadata {
  readonly kind: "snapshot" | "delta";
  readonly credentialGeneration: number;
  readonly preparedAt: number;
  readonly devices: readonly DeviceRecord[];
  readonly workspaces: readonly WorkspaceRecord[];
  readonly endpoints: readonly EndpointRecord[];
  readonly capabilities: readonly CapabilityBinding[];
  readonly removals: FabricAdvertisementRemovalSet;
}

export interface FabricOfflineInventorySeed extends AcceptedAdvertisementMetadata {
  readonly credentialGeneration: number;
  readonly acceptedAt: number;
  readonly devices: readonly DeviceRecord[];
  readonly workspaces: readonly WorkspaceRecord[];
  readonly endpoints: readonly EndpointRecord[];
  readonly capabilities: readonly CapabilityBinding[];
  readonly tombstones?: Partial<FabricAdvertisementRemovalSet>;
}

/** Durable evidence only. This view never authorizes execution or readiness. */
export interface FabricOfflineInventoryView extends AcceptedAdvertisementMetadata {
  readonly credentialGeneration: number;
  readonly acceptedAt: number;
  readonly devices: readonly DeviceRecord[];
  readonly workspaces: readonly PublicWorkspaceRecord[];
  readonly endpoints: readonly EndpointRecord[];
  readonly capabilities: readonly CapabilityBinding[];
  readonly tombstones: FabricAdvertisementRemovalSet;
}

export interface FabricDirectorySnapshot {
  connectors: readonly PublicConnectorRecord[];
  devices: readonly DeviceRecord[];
  workspaces: readonly PublicWorkspaceRecord[];
  endpoints: readonly EndpointRecord[];
  capabilities: readonly CapabilityBinding[];
}

export interface FabricAcceptedExecutionView extends AcceptedAdvertisementMetadata {
  devices: readonly DeviceRecord[];
  workspaces: readonly PublicWorkspaceRecord[];
  endpoints: readonly EndpointRecord[];
  capabilities: readonly CapabilityBinding[];
}

export interface CapabilityQuery {
  capabilityId?: string;
  kind?: FabricCapabilityKind;
  deviceId?: string;
  onlineOnly?: boolean;
}

interface OwnedSnapshot extends AcceptedAdvertisementMetadata {
  credentialGeneration: number;
  acceptedAt: number;
  devices: readonly DeviceRecord[];
  workspaces: readonly WorkspaceRecord[];
  endpoints: readonly EndpointRecord[];
  capabilities: readonly CapabilityBinding[];
}

interface StoredOfflineInventory extends OwnedSnapshot {
  tombstones: FabricAdvertisementRemovalSet;
}

interface GenerationFence {
  generation: number;
  revision: number;
  fingerprint: string;
  recordFingerprint: string;
  present: boolean;
  connectorId: string;
}

interface CapabilityFence {
  fingerprint: string;
  present: boolean;
  connectorId: string;
  endpointGeneration: number;
}

const OFFLINE_INVENTORY_MAX_ITEMS = 10_000;
const STAGED_OWNER = Symbol("fabric-staged-advertisement-owner");
const STAGED_PREVIOUS = Symbol("fabric-staged-advertisement-previous");
const STAGED_OFFLINE_PREVIOUS = Symbol("fabric-staged-advertisement-offline-previous");

interface InternalStagedAdvertisement extends FabricStagedAdvertisementCandidate {
  readonly [STAGED_OWNER]: FabricDirectory;
  readonly [STAGED_PREVIOUS]: OwnedSnapshot | undefined;
  readonly [STAGED_OFFLINE_PREVIOUS]: StoredOfflineInventory | undefined;
}

function conflict(message: string, path: string): never {
  throw new FabricContractError("conflict", message, path);
}

function uniqueBy<T>(items: readonly T[], identity: (item: T) => string, path: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const [index, item] of items.entries()) {
    const id = identity(item);
    if (result.has(id)) conflict(`${path} contains duplicate identity '${id}'`, `${path}[${index}]`);
    result.set(id, item);
  }
  return result;
}

function sameRecord(left: object, right: object): boolean {
  if ("credentialGeneration" in left && "credentialGeneration" in right) {
    const a = left as ConnectorRecord;
    const b = right as ConnectorRecord;
    return a.connectorId === b.connectorId && a.label === b.label && a.transport === b.transport &&
      a.credentialGeneration === b.credentialGeneration && a.instanceNonce === b.instanceNonce &&
      a.lastSeenAt === b.lastSeenAt && a.enabled === b.enabled && a.revision === b.revision;
  }
  if ("deviceId" in left && "deviceId" in right) {
    const a = left as DeviceRecord;
    const b = right as DeviceRecord;
    return a.deviceId === b.deviceId && a.connectorId === b.connectorId && a.label === b.label &&
      a.connectionMode === b.connectionMode && a.platform === b.platform && a.architecture === b.architecture &&
      a.enabled === b.enabled && a.revision === b.revision;
  }
  return false;
}

function workspaceFingerprint(record: WorkspaceRecord): string {
  return JSON.stringify({
    deviceId: record.deviceId,
    localWorkspaceId: record.localWorkspaceId,
    policyDigest: record.policyDigest,
    mode: record.mode,
  });
}

function endpointFingerprint(record: EndpointRecord): string {
  const projected = projectEndpoint(record);
  return JSON.stringify({ ...projected, generation: undefined, revision: undefined, status: undefined });
}

function generationRecordFingerprint(record: WorkspaceRecord | EndpointRecord): string {
  if ("workspaceId" in record) {
    return JSON.stringify({
      workspaceId: record.workspaceId,
      deviceId: record.deviceId,
      localWorkspaceId: record.localWorkspaceId,
      label: record.label,
      mode: record.mode,
      generation: record.generation,
      policyDigest: record.policyDigest,
      endpointIds: [...record.endpointIds],
      revision: record.revision,
    });
  }
  return JSON.stringify(projectEndpoint(record));
}

function capabilityFingerprint(record: CapabilityBinding): string {
  return JSON.stringify(projectCapability(record));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function cloneOwnedSnapshot(
  snapshot: FabricAdvertisementSnapshot,
  connectorId: string,
  credentialGeneration: number,
  acceptedAt: number,
): OwnedSnapshot {
  return {
    connectionId: snapshot.connectionId,
    connectionGeneration: snapshot.connectionGeneration,
    connectorId,
    credentialGeneration,
    acceptedAt,
    capabilityDigest: snapshot.capabilityDigest,
    advertisementRevision: snapshot.advertisementRevision,
    devices: snapshot.devices.map(projectDevice),
    workspaces: snapshot.workspaces.map((workspace) => ({ ...workspace, endpointIds: [...workspace.endpointIds] })),
    endpoints: snapshot.endpoints.map(projectEndpoint),
    capabilities: snapshot.capabilities.map(projectCapability),
  };
}

function sameAcceptedOwner(left: OwnedSnapshot | undefined, right: OwnedSnapshot | undefined): boolean {
  return left === right;
}

function removedGenerationRecords<T extends { generation: number; revision: number }>(
  before: readonly T[],
  after: readonly T[],
  identity: (record: T) => string,
): readonly FabricAdvertisementRemovalTombstone[] {
  const nextIds = new Set(after.map(identity));
  return before.filter((record) => !nextIds.has(identity(record))).map((record) => ({
    subjectId: identity(record), generation: record.generation, revision: record.revision,
  }));
}

function removedCapabilities(
  before: readonly CapabilityBinding[],
  after: readonly CapabilityBinding[],
  beforeEndpoints: readonly EndpointRecord[],
): readonly FabricCapabilityRemovalTombstone[] {
  const nextIds = new Set(after.map((record) => record.capabilityId));
  const endpointById = new Map(beforeEndpoints.map((record) => [record.endpointId, record]));
  return before.filter((record) => !nextIds.has(record.capabilityId)).map((record) => ({
    capabilityId: record.capabilityId,
    endpointGeneration: endpointById.get(record.endpointId)!.generation,
  }));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function applyDeltaRecords<T>(
  current: readonly T[],
  upserts: readonly T[],
  removals: readonly string[],
  identity: (record: T) => string,
  path: string,
): readonly T[] {
  const next = new Map(current.map((record) => [identity(record), record]));
  const upserted = uniqueBy(upserts, identity, `${path}.upserts`);
  const removed = new Set<string>();
  for (const [index, id] of removals.entries()) {
    assertFabricIdentifier(id, `${path}.removals[${index}]`);
    if (removed.has(id)) conflict(`Duplicate ${path} removal '${id}'`, `${path}.removals[${index}]`);
    if (upserted.has(id)) conflict(`${path} cannot upsert and remove '${id}'`, path);
    if (!next.has(id)) conflict(`${path} cannot remove unknown identity '${id}'`, `${path}.removals[${index}]`);
    removed.add(id);
    next.delete(id);
  }
  for (const [id, record] of upserted) next.set(id, record);
  return [...next.values()];
}

/** Host-owned durable authority plus connection-scoped advertisement projections. */
export class FabricDirectory {
  readonly #connectors = new Map<string, ConnectorRecord>();
  readonly #devices = new Map<string, DeviceRecord>();
  readonly #connectorRevisionHighWater = new Map<string, number>();
  readonly #deviceRevisionHighWater = new Map<string, number>();
  readonly #advertisements = new Map<string, OwnedSnapshot>();
  readonly #offlineInventories = new Map<string, StoredOfflineInventory>();
  readonly #workspaceFences = new Map<string, GenerationFence>();
  readonly #endpointFences = new Map<string, GenerationFence>();
  readonly #capabilityFences = new Map<string, CapabilityFence>();

  /** Seeds durable host authority. It never makes advertisement data executable. */
  seedAuthority(seed: FabricAuthoritySeed): void {
    assertValidConnectorRecord(seed.connector);
    const devices = uniqueBy(seed.devices, (device) => device.deviceId, "devices");
    for (const device of seed.devices) {
      assertValidDeviceRecord(device);
      if (device.connectorId !== seed.connector.connectorId) {
        conflict("Seeded device is not owned by the seeded connector", "devices.connectorId");
      }
      const owner = this.#devices.get(device.deviceId);
      if (owner !== undefined && owner.connectorId !== device.connectorId) {
        conflict("Device identity is already owned by another connector", "devices.deviceId");
      }
      const highWater = this.#deviceRevisionHighWater.get(device.deviceId);
      if (highWater !== undefined && device.revision <= highWater && !sameRecord(owner ?? {}, device)) {
        throw new FabricContractError("stale_generation", "Device revision must increase for authority changes", "devices.revision");
      }
    }

    const currentConnector = this.#connectors.get(seed.connector.connectorId);
    const connectorHighWater = this.#connectorRevisionHighWater.get(seed.connector.connectorId);
    if (
      connectorHighWater !== undefined &&
      seed.connector.revision <= connectorHighWater &&
      !sameRecord(currentConnector ?? {}, seed.connector)
    ) {
      throw new FabricContractError("stale_generation", "Connector revision must increase for authority changes", "connector.revision");
    }

    const nextDevices = new Map(this.#devices);
    for (const [deviceId, device] of this.#devices) {
      if (device.connectorId === seed.connector.connectorId && !devices.has(deviceId)) nextDevices.delete(deviceId);
    }
    for (const device of seed.devices) nextDevices.set(device.deviceId, projectDevice(device));
    this.#connectors.set(seed.connector.connectorId, { ...seed.connector });
    this.#connectorRevisionHighWater.set(seed.connector.connectorId, Math.max(connectorHighWater ?? -1, seed.connector.revision));
    for (const device of seed.devices) {
      this.#deviceRevisionHighWater.set(
        device.deviceId,
        Math.max(this.#deviceRevisionHighWater.get(device.deviceId) ?? -1, device.revision),
      );
    }
    const accepted = this.#advertisements.get(seed.connector.connectorId);
    const acceptedAuthorityChanged = accepted !== undefined && (
      !sameRecord(currentConnector ?? {}, seed.connector) ||
      accepted.devices.length !== seed.devices.length ||
      accepted.devices.some((advertised) => {
        const current = devices.get(advertised.deviceId);
        return current === undefined || !sameRecord(advertised, current);
      })
    );
    this.#devices.clear();
    for (const [deviceId, device] of nextDevices) this.#devices.set(deviceId, device);
    if (acceptedAuthorityChanged) this.#advertisements.delete(seed.connector.connectorId);
  }

  /** Compatibility seam for explicit synchronous in-memory embeddings. */
  [FABRIC_DIRECTORY_ADVERTISEMENT_AUTHORITY](
    context: DirectoryAdvertisementAuthorityContext,
    input: FabricAdvertisementSnapshot | FabricAdvertisementDelta,
  ): AcceptedAdvertisementMetadata {
    const candidate = this[FABRIC_DIRECTORY_STAGE_ADVERTISEMENT](context, input);
    return this[FABRIC_DIRECTORY_PUBLISH_ADVERTISEMENT](candidate);
  }

  /** Validates and clones an immutable candidate without changing executable Directory state. */
  [FABRIC_DIRECTORY_STAGE_ADVERTISEMENT](
    context: DirectoryAdvertisementAuthorityContext,
    input: FabricAdvertisementSnapshot | FabricAdvertisementDelta,
  ): FabricStagedAdvertisementCandidate {
    if (!("baseRevision" in input)) return this.#stageSnapshot(context, input, "snapshot");
    const delta = input;
    assertFabricIdentifier(delta.connectionId, "connectionId");
    assertGeneration(delta.connectionGeneration, "connectionGeneration");
    assertBoundedString(delta.capabilityDigest, "capabilityDigest", 256);
    assertRevision(delta.baseRevision, "baseRevision");
    assertRevision(delta.advertisementRevision, "advertisementRevision");
    const previous = this.#advertisements.get(context.connectorId);
    if (
      previous === undefined || previous.connectionId !== context.connectionId ||
      previous.connectionGeneration !== context.connectionGeneration ||
      previous.capabilityDigest !== context.capabilityDigest ||
      delta.connectionId !== context.connectionId || delta.connectionGeneration !== context.connectionGeneration ||
      delta.capabilityDigest !== context.capabilityDigest
    ) {
      throw new FabricContractError("stale_generation", "Advertisement delta requires the exact current accepted snapshot; reconnects require a full snapshot", "connectionId");
    }
    if (delta.baseRevision !== previous.advertisementRevision || delta.advertisementRevision !== delta.baseRevision + 1) {
      throw new FabricContractError("stale_generation", "Advertisement delta must advance the current revision by exactly one", "baseRevision");
    }
    const upserts = delta.upserts ?? {};
    const removals = delta.removals ?? {};
    return this.#stageSnapshot(context, {
      connectionId: delta.connectionId,
      connectionGeneration: delta.connectionGeneration,
      capabilityDigest: delta.capabilityDigest,
      advertisementRevision: delta.advertisementRevision,
      devices: previous.devices,
      workspaces: applyDeltaRecords(previous.workspaces, upserts.workspaces ?? [], removals.workspaceIds ?? [], (record) => record.workspaceId, "workspaces"),
      endpoints: applyDeltaRecords(previous.endpoints, upserts.endpoints ?? [], removals.endpointIds ?? [], (record) => record.endpointId, "endpoints"),
      capabilities: applyDeltaRecords(previous.capabilities, upserts.capabilities ?? [], removals.capabilityIds ?? [], (record) => record.capabilityId, "capabilities"),
    }, "delta");
  }

  #stageSnapshot(
    context: DirectoryAdvertisementAuthorityContext,
    snapshot: FabricAdvertisementSnapshot,
    kind: "snapshot" | "delta",
  ): InternalStagedAdvertisement {
    assertFabricIdentifier(snapshot.connectionId, "connectionId");
    assertGeneration(snapshot.connectionGeneration, "connectionGeneration");
    assertGeneration(context.credentialGeneration, "credentialGeneration");
    assertEpochMilliseconds(context.preparedAt, "preparedAt");
    assertBoundedString(snapshot.capabilityDigest, "capabilityDigest", 256);
    assertRevision(snapshot.advertisementRevision, "advertisementRevision");
    if (
      snapshot.connectionId !== context.connectionId ||
      snapshot.connectionGeneration !== context.connectionGeneration ||
      snapshot.capabilityDigest !== context.capabilityDigest
    ) {
      throw new FabricContractError("stale_generation", "Advertisement does not match current connection authority", "connectionId");
    }
    this.#assertSnapshotBounds(snapshot, context.limits.maxAdvertisementItems);

    const currentConnector = this.#connectors.get(context.connectorId);
    if (currentConnector === undefined) throw new FabricContractError("not_found", "Connector authority is not registered", "connectorId");
    if (currentConnector.credentialGeneration !== context.credentialGeneration) {
      throw new FabricContractError("stale_generation", "Advertisement credential generation is stale", "credentialGeneration");
    }
    const previous = this.#advertisements.get(context.connectorId);
    const persistedPrevious = this.#offlineInventories.get(context.connectorId);
    if (previous === undefined && persistedPrevious !== undefined && snapshot.connectionGeneration <= persistedPrevious.connectionGeneration) {
      throw new FabricContractError("stale_generation", "A reconnect must use a newer connection generation and a full snapshot", "connectionGeneration");
    }
    if (previous !== undefined) {
      if (snapshot.connectionGeneration < previous.connectionGeneration) {
        throw new FabricContractError("stale_generation", "Advertisement connection generation cannot roll back", "connectionGeneration");
      }
      if (
        snapshot.connectionGeneration === previous.connectionGeneration &&
        (snapshot.connectionId !== previous.connectionId || snapshot.advertisementRevision <= previous.advertisementRevision)
      ) {
        throw new FabricContractError("stale_generation", "Advertisement revision must increase on the current connection", "advertisementRevision");
      }
    }

    this.#assertSnapshotRecords(context.connectorId, snapshot);
    this.#assertGenerationFences(snapshot.workspaces, context.connectorId, this.#workspaceFences, (record) => record.workspaceId, workspaceFingerprint);
    this.#assertGenerationFences(snapshot.endpoints, context.connectorId, this.#endpointFences, (record) => record.endpointId, endpointFingerprint);
    this.#assertCapabilityFences(snapshot.capabilities, snapshot.endpoints, context.connectorId);

    const owned = cloneOwnedSnapshot(snapshot, context.connectorId, context.credentialGeneration, context.preparedAt);
    this.#assertCandidateGloballyUnique(context.connectorId, owned);
    const durableBefore = previous ?? this.#offlineInventories.get(context.connectorId);
    const candidate: InternalStagedAdvertisement = {
      kind,
      connectorId: context.connectorId,
      credentialGeneration: context.credentialGeneration,
      preparedAt: context.preparedAt,
      connectionId: snapshot.connectionId,
      connectionGeneration: snapshot.connectionGeneration,
      capabilityDigest: snapshot.capabilityDigest,
      advertisementRevision: snapshot.advertisementRevision,
      devices: owned.devices,
      workspaces: owned.workspaces,
      endpoints: owned.endpoints,
      capabilities: owned.capabilities,
      removals: {
        workspaces: removedGenerationRecords(durableBefore?.workspaces ?? [], owned.workspaces, (record) => record.workspaceId),
        endpoints: removedGenerationRecords(durableBefore?.endpoints ?? [], owned.endpoints, (record) => record.endpointId),
        capabilities: removedCapabilities(durableBefore?.capabilities ?? [], owned.capabilities, durableBefore?.endpoints ?? []),
      },
      [STAGED_OWNER]: this,
      [STAGED_PREVIOUS]: previous,
      [STAGED_OFFLINE_PREVIOUS]: this.#offlineInventories.get(context.connectorId),
    };
    return deepFreeze(candidate);
  }

  /** Records a successful durable commit as non-executable evidence before owner revalidation. */
  [FABRIC_DIRECTORY_RECORD_PERSISTED_ADVERTISEMENT](candidate: FabricStagedAdvertisementCandidate): void {
    const staged = this.#requireStagedCandidate(candidate);
    if (this.#offlineInventories.get(staged.connectorId) !== staged[STAGED_OFFLINE_PREVIOUS]) {
      throw new FabricContractError("stale_generation", "Offline inventory changed while admission was persisted", "advertisementRevision");
    }
    this.#assertGenerationFences(staged.workspaces, staged.connectorId, this.#workspaceFences, (record) => record.workspaceId, workspaceFingerprint);
    this.#assertGenerationFences(staged.endpoints, staged.connectorId, this.#endpointFences, (record) => record.endpointId, endpointFingerprint);
    this.#assertCapabilityFences(staged.capabilities, staged.endpoints, staged.connectorId);
    this.#assertCandidateGloballyUnique(staged.connectorId, this.#ownedFromCandidate(staged));
    const offline = this.#offlineFromCandidate(staged);
    this.#commitCandidateFences(staged);
    this.#offlineInventories.set(staged.connectorId, offline);
  }

  /** Publishes only the still-current staged owner. Persistence is handled by the caller. */
  [FABRIC_DIRECTORY_PUBLISH_ADVERTISEMENT](candidate: FabricStagedAdvertisementCandidate): AcceptedAdvertisementMetadata {
    const staged = this.#requireStagedCandidate(candidate);
    if (!sameAcceptedOwner(this.#advertisements.get(staged.connectorId), staged[STAGED_PREVIOUS])) {
      throw new FabricContractError("stale_generation", "Executable advertisement changed while admission was staged", "advertisementRevision");
    }
    this.#assertGenerationFences(staged.workspaces, staged.connectorId, this.#workspaceFences, (record) => record.workspaceId, workspaceFingerprint);
    this.#assertGenerationFences(staged.endpoints, staged.connectorId, this.#endpointFences, (record) => record.endpointId, endpointFingerprint);
    this.#assertCapabilityFences(staged.capabilities, staged.endpoints, staged.connectorId);
    const owned = this.#ownedFromCandidate(staged);
    this.#assertCandidateGloballyUnique(staged.connectorId, owned);
    this.#commitCandidateFences(staged);
    this.#advertisements.set(staged.connectorId, owned);
    return {
      connectorId: staged.connectorId,
      connectionId: staged.connectionId,
      connectionGeneration: staged.connectionGeneration,
      capabilityDigest: staged.capabilityDigest,
      advertisementRevision: staged.advertisementRevision,
    };
  }

  /** Removes only an exact connection generation from executable visibility. */
  [FABRIC_DIRECTORY_WITHDRAW_ADVERTISEMENT](connectionId: string, connectionGeneration: number, connectorId: string): void {
    const current = this.#advertisements.get(connectorId);
    if (current?.connectionId === connectionId && current.connectionGeneration === connectionGeneration) {
      this.#advertisements.delete(connectorId);
    }
  }

  #assertSnapshotBounds(snapshot: FabricAdvertisementSnapshot, maximum: number): void {
    const categories = [snapshot.devices, snapshot.workspaces, snapshot.endpoints, snapshot.capabilities] as const;
    for (const [index, items] of categories.entries()) {
      if (items.length > maximum) {
        throw new FabricContractError("resource_exhausted", "Advertisement category exceeds negotiated item limit", `advertisement[${index}]`);
      }
    }
    if (categories.reduce((sum, items) => sum + items.length, 0) > maximum) {
      throw new FabricContractError("resource_exhausted", "Advertisement exceeds negotiated total item limit", "advertisement");
    }
  }

  #assertSnapshotRecords(connectorId: string, snapshot: FabricAdvertisementSnapshot): void {
    for (const device of snapshot.devices) assertValidDeviceRecord(device);
    for (const workspace of snapshot.workspaces) assertValidWorkspaceRecord(workspace);
    for (const endpoint of snapshot.endpoints) assertValidEndpointRecord(endpoint);
    for (const capability of snapshot.capabilities) assertValidCapabilityBinding(capability);
    const devices = uniqueBy(snapshot.devices, (device) => device.deviceId, "devices");
    const authorityDevices = [...this.#devices.values()].filter((device) => device.connectorId === connectorId);
    if (devices.size !== authorityDevices.length) conflict("Advertisement devices must exactly match durable connector authority", "devices");
    for (const device of authorityDevices) {
      const advertised = devices.get(device.deviceId);
      if (advertised === undefined || !sameRecord(device, advertised)) conflict("Advertised device authority differs from the durable registry", "devices");
    }
    const workspaces = uniqueBy(snapshot.workspaces, (workspace) => workspace.workspaceId, "workspaces");
    const endpoints = uniqueBy(snapshot.endpoints, (endpoint) => endpoint.endpointId, "endpoints");
    uniqueBy(snapshot.capabilities, (capability) => capability.capabilityId, "capabilities");
    const localWorkspaceIds = new Set<string>();
    for (const workspace of snapshot.workspaces) {
      if (!devices.has(workspace.deviceId)) conflict("Workspace references a device outside this connector", "workspaces.deviceId");
      const localKey = `${workspace.deviceId}\0${workspace.localWorkspaceId}`;
      if (localWorkspaceIds.has(localKey)) conflict("Duplicate device-local workspace identity", "workspaces.localWorkspaceId");
      localWorkspaceIds.add(localKey);
      for (const endpointId of workspace.endpointIds) {
        const endpoint = endpoints.get(endpointId);
        if (endpoint === undefined || endpoint.deviceId !== workspace.deviceId || endpoint.scope.kind !== "workspace" || endpoint.scope.workspaceId !== workspace.workspaceId) {
          conflict("Workspace endpointIds must reference scoped endpoints on the same device", "workspaces.endpointIds");
        }
      }
    }
    for (const endpoint of snapshot.endpoints) {
      if (!devices.has(endpoint.deviceId) || endpoint.connectorId !== connectorId) conflict("Advertised endpoint ownership does not match this connector", "endpoints");
      if (endpoint.scope.kind === "workspace") {
        const workspace = workspaces.get(endpoint.scope.workspaceId);
        if (workspace === undefined || workspace.deviceId !== endpoint.deviceId || !workspace.endpointIds.includes(endpoint.endpointId)) {
          conflict("Workspace-scoped endpoint references a foreign or missing workspace", "endpoints.scope.workspaceId");
        }
      }
    }
    for (const capability of snapshot.capabilities) {
      const endpoint = endpoints.get(capability.endpointId);
      if (endpoint === undefined) conflict("Capability references an endpoint outside this snapshot", "capabilities.endpointId");
      if (capability.contractHash !== endpoint.contractHash) conflict("Capability contractHash must match its Endpoint contractHash", "capabilities.contractHash");
    }
  }

  #assertGenerationFences<T extends WorkspaceRecord | EndpointRecord>(
    records: readonly T[],
    connectorId: string,
    fences: ReadonlyMap<string, GenerationFence>,
    identity: (record: T) => string,
    fingerprint: (record: T) => string,
  ): void {
    for (const record of records) {
      const id = identity(record);
      const prior = fences.get(id);
      if (prior === undefined) continue;
      if (prior.connectorId !== connectorId || record.generation < prior.generation) {
        throw new FabricContractError("stale_generation", "Registry generation cannot roll back or change ownership", id);
      }
      if (record.generation === prior.generation) {
        if (!prior.present) throw new FabricContractError("stale_generation", "A tombstoned identity requires a newer generation", id);
        if (fingerprint(record) !== prior.fingerprint) {
          throw new FabricContractError("stale_generation", "Contract or policy change requires a newer generation", id);
        }
        if (record.revision < prior.revision) {
          throw new FabricContractError("stale_generation", "Record revision cannot roll back within a generation", id);
        }
        if (record.revision === prior.revision && generationRecordFingerprint(record) !== prior.recordFingerprint) {
          throw new FabricContractError("stale_generation", "A record change must advance its revision", id);
        }
      }
    }
  }

  #commitGenerationFences<T extends WorkspaceRecord | EndpointRecord>(
    records: readonly T[],
    connectorId: string,
    fences: Map<string, GenerationFence>,
    identity: (record: T) => string,
    fingerprint: (record: T) => string,
  ): void {
    const nextIds = new Set(records.map(identity));
    for (const [id, fence] of fences) {
      if (fence.connectorId === connectorId && !nextIds.has(id)) fences.set(id, { ...fence, present: false });
    }
    for (const record of records) {
      fences.set(identity(record), {
        generation: record.generation,
        revision: record.revision,
        fingerprint: fingerprint(record),
        recordFingerprint: generationRecordFingerprint(record),
        present: true,
        connectorId,
      });
    }
  }

  #assertCapabilityFences(
    records: readonly CapabilityBinding[],
    endpoints: readonly EndpointRecord[],
    connectorId: string,
  ): void {
    const endpointById = new Map(endpoints.map((record) => [record.endpointId, record]));
    for (const record of records) {
      const prior = this.#capabilityFences.get(record.capabilityId);
      if (prior === undefined) continue;
      if (prior.connectorId !== connectorId) conflict("Capability identity is already owned", "capabilities.capabilityId");
      const endpointGeneration = endpointById.get(record.endpointId)?.generation;
      if (endpointGeneration === undefined) conflict("Capability endpoint is missing", "capabilities.endpointId");
      if (endpointGeneration < prior.endpointGeneration) {
        throw new FabricContractError("stale_generation", "Capability endpoint generation cannot roll back", record.capabilityId);
      }
      if ((!prior.present || prior.fingerprint !== capabilityFingerprint(record)) && endpointGeneration <= prior.endpointGeneration) {
        throw new FabricContractError("stale_generation", "Capability resurrection or change requires a newer Endpoint generation", record.capabilityId);
      }
    }
  }

  #commitCapabilityFences(
    records: readonly CapabilityBinding[],
    endpoints: readonly EndpointRecord[],
    connectorId: string,
  ): void {
    const nextIds = new Set(records.map((record) => record.capabilityId));
    const endpointById = new Map(endpoints.map((record) => [record.endpointId, record]));
    for (const [id, fence] of this.#capabilityFences) {
      if (fence.connectorId === connectorId && !nextIds.has(id)) this.#capabilityFences.set(id, { ...fence, present: false });
    }
    for (const record of records) {
      this.#capabilityFences.set(record.capabilityId, {
        connectorId,
        fingerprint: capabilityFingerprint(record),
        present: true,
        endpointGeneration: endpointById.get(record.endpointId)!.generation,
      });
    }
  }

  #assertGloballyUnique(snapshots: ReadonlyMap<string, OwnedSnapshot>): void {
    const workspaceIds = new Set<string>();
    const endpointIds = new Set<string>();
    const capabilityIds = new Set<string>();
    const localWorkspaceIds = new Set<string>();
    for (const snapshot of snapshots.values()) {
      for (const workspace of snapshot.workspaces) {
        if (workspaceIds.has(workspace.workspaceId)) conflict("Workspace identity is already owned", "workspaces.workspaceId");
        workspaceIds.add(workspace.workspaceId);
        const localKey = `${workspace.deviceId}\0${workspace.localWorkspaceId}`;
        if (localWorkspaceIds.has(localKey)) conflict("Device-local workspace identity must be unique", "workspaces.localWorkspaceId");
        localWorkspaceIds.add(localKey);
      }
      for (const endpoint of snapshot.endpoints) {
        if (endpointIds.has(endpoint.endpointId)) conflict("Endpoint identity is already owned", "endpoints.endpointId");
        endpointIds.add(endpoint.endpointId);
      }
      for (const capability of snapshot.capabilities) {
        if (capabilityIds.has(capability.capabilityId)) conflict("Capability identity is already owned", "capabilities.capabilityId");
        capabilityIds.add(capability.capabilityId);
      }
    }
  }

  #requireStagedCandidate(candidate: FabricStagedAdvertisementCandidate): InternalStagedAdvertisement {
    const staged = candidate as InternalStagedAdvertisement;
    if (staged[STAGED_OWNER] !== this) {
      throw new FabricContractError("permission_denied", "Staged advertisement was not prepared by this Directory", "candidate");
    }
    return staged;
  }

  #ownedFromCandidate(candidate: FabricStagedAdvertisementCandidate): OwnedSnapshot {
    return cloneOwnedSnapshot({
      connectionId: candidate.connectionId,
      connectionGeneration: candidate.connectionGeneration,
      capabilityDigest: candidate.capabilityDigest,
      advertisementRevision: candidate.advertisementRevision,
      devices: candidate.devices,
      workspaces: candidate.workspaces,
      endpoints: candidate.endpoints,
      capabilities: candidate.capabilities,
    }, candidate.connectorId, candidate.credentialGeneration, candidate.preparedAt);
  }

  #assertCandidateGloballyUnique(connectorId: string, candidate: OwnedSnapshot): void {
    const snapshots = new Map<string, OwnedSnapshot>(this.#offlineInventories);
    for (const [id, snapshot] of this.#advertisements) snapshots.set(id, snapshot);
    snapshots.set(connectorId, candidate);
    this.#assertGloballyUnique(snapshots);
  }

  #commitCandidateFences(candidate: FabricStagedAdvertisementCandidate): void {
    this.#commitGenerationFences(candidate.workspaces, candidate.connectorId, this.#workspaceFences, (record) => record.workspaceId, workspaceFingerprint);
    this.#commitGenerationFences(candidate.endpoints, candidate.connectorId, this.#endpointFences, (record) => record.endpointId, endpointFingerprint);
    this.#commitCapabilityFences(candidate.capabilities, candidate.endpoints, candidate.connectorId);
  }

  #offlineFromCandidate(candidate: FabricStagedAdvertisementCandidate): StoredOfflineInventory {
    const previous = this.#offlineInventories.get(candidate.connectorId);
    const workspaces = new Map((previous?.tombstones.workspaces ?? []).map((entry) => [entry.subjectId, entry]));
    const endpoints = new Map((previous?.tombstones.endpoints ?? []).map((entry) => [entry.subjectId, entry]));
    const capabilities = new Map((previous?.tombstones.capabilities ?? []).map((entry) => [entry.capabilityId, entry]));
    for (const record of candidate.workspaces) workspaces.delete(record.workspaceId);
    for (const record of candidate.endpoints) endpoints.delete(record.endpointId);
    for (const record of candidate.capabilities) capabilities.delete(record.capabilityId);
    for (const entry of candidate.removals.workspaces) workspaces.set(entry.subjectId, { ...entry });
    for (const entry of candidate.removals.endpoints) endpoints.set(entry.subjectId, { ...entry });
    for (const entry of candidate.removals.capabilities) capabilities.set(entry.capabilityId, { ...entry });
    const owned = this.#ownedFromCandidate(candidate);
    const tombstones: FabricAdvertisementRemovalSet = {
      workspaces: [...workspaces.values()].sort((a, b) => compareText(a.subjectId, b.subjectId)),
      endpoints: [...endpoints.values()].sort((a, b) => compareText(a.subjectId, b.subjectId)),
      capabilities: [...capabilities.values()].sort((a, b) => compareText(a.capabilityId, b.capabilityId)),
    };
    this.#assertTombstones(candidate.connectorId, owned, tombstones);
    return { ...owned, tombstones };
  }

  /** Atomically hydrates durable advertisement rows as offline-only inventory. */
  hydrateOfflineInventory(seed: FabricOfflineInventorySeed): void {
    assertFabricIdentifier(seed.connectorId, "connectorId");
    assertFabricIdentifier(seed.connectionId, "connectionId");
    assertGeneration(seed.connectionGeneration, "connectionGeneration");
    assertGeneration(seed.credentialGeneration, "credentialGeneration");
    assertRevision(seed.advertisementRevision, "advertisementRevision");
    assertEpochMilliseconds(seed.acceptedAt, "acceptedAt");
    assertBoundedString(seed.capabilityDigest, "capabilityDigest", 256);
    if (this.#advertisements.has(seed.connectorId)) {
      throw new FabricContractError("invalid_state", "Offline inventory cannot replace a live executable advertisement", "connectorId");
    }
    const connector = this.#connectors.get(seed.connectorId);
    if (connector === undefined) throw new FabricContractError("not_found", "Offline inventory Connector is not registered", "connectorId");
    if (seed.credentialGeneration > connector.credentialGeneration) {
      throw new FabricContractError("stale_generation", "Offline inventory credential generation exceeds current authority", "credentialGeneration");
    }
    const snapshot: FabricAdvertisementSnapshot = {
      connectionId: seed.connectionId,
      connectionGeneration: seed.connectionGeneration,
      capabilityDigest: seed.capabilityDigest,
      advertisementRevision: seed.advertisementRevision,
      devices: seed.devices,
      workspaces: seed.workspaces,
      endpoints: seed.endpoints,
      capabilities: seed.capabilities,
    };
    this.#assertSnapshotBounds(snapshot, OFFLINE_INVENTORY_MAX_ITEMS);
    this.#assertSnapshotRecords(seed.connectorId, snapshot);
    const owned = cloneOwnedSnapshot(snapshot, seed.connectorId, seed.credentialGeneration, seed.acceptedAt);
    this.#assertGenerationFences(owned.workspaces, seed.connectorId, this.#workspaceFences, (record) => record.workspaceId, workspaceFingerprint);
    this.#assertGenerationFences(owned.endpoints, seed.connectorId, this.#endpointFences, (record) => record.endpointId, endpointFingerprint);
    this.#assertCapabilityFences(owned.capabilities, owned.endpoints, seed.connectorId);
    this.#assertCandidateGloballyUnique(seed.connectorId, owned);
    const tombstones: FabricAdvertisementRemovalSet = {
      workspaces: (seed.tombstones?.workspaces ?? []).map((entry) => ({ ...entry })),
      endpoints: (seed.tombstones?.endpoints ?? []).map((entry) => ({ ...entry })),
      capabilities: (seed.tombstones?.capabilities ?? []).map((entry) => ({ ...entry })),
    };
    this.#assertTombstones(seed.connectorId, owned, tombstones);
    this.#commitGenerationFences(owned.workspaces, seed.connectorId, this.#workspaceFences, (record) => record.workspaceId, workspaceFingerprint);
    this.#commitGenerationFences(owned.endpoints, seed.connectorId, this.#endpointFences, (record) => record.endpointId, endpointFingerprint);
    this.#commitCapabilityFences(owned.capabilities, owned.endpoints, seed.connectorId);
    this.#commitTombstones(seed.connectorId, tombstones);
    this.#offlineInventories.set(seed.connectorId, { ...owned, tombstones });
  }

  #assertTombstones(connectorId: string, owned: OwnedSnapshot, tombstones: FabricAdvertisementRemovalSet): void {
    const tombstoneTotal = tombstones.workspaces.length + tombstones.endpoints.length + tombstones.capabilities.length;
    if (tombstoneTotal > OFFLINE_INVENTORY_MAX_ITEMS || [tombstones.workspaces, tombstones.endpoints, tombstones.capabilities].some((items) => items.length > OFFLINE_INVENTORY_MAX_ITEMS)) {
      throw new FabricContractError("resource_exhausted", "Offline inventory tombstones exceed the durable inventory limit", "tombstones");
    }
    const workspaceIds = new Set(owned.workspaces.map((record) => record.workspaceId));
    const endpointIds = new Set(owned.endpoints.map((record) => record.endpointId));
    const capabilityIds = new Set(owned.capabilities.map((record) => record.capabilityId));
    const workspaceTombstoneIds = new Set<string>();
    const endpointTombstoneIds = new Set<string>();
    const capabilityTombstoneIds = new Set<string>();
    for (const [index, entry] of tombstones.workspaces.entries()) {
      assertFabricIdentifier(entry.subjectId, `tombstones.workspaces[${index}].subjectId`);
      assertGeneration(entry.generation, `tombstones.workspaces[${index}].generation`);
      assertRevision(entry.revision, `tombstones.workspaces[${index}].revision`);
      if (workspaceIds.has(entry.subjectId)) conflict("Workspace cannot be both present and tombstoned", `tombstones.workspaces[${index}]`);
      if (workspaceTombstoneIds.has(entry.subjectId)) conflict("Workspace tombstone identity is duplicated", `tombstones.workspaces[${index}]`);
      workspaceTombstoneIds.add(entry.subjectId);
      this.#assertTombstoneFence(connectorId, entry, this.#workspaceFences);
    }
    for (const [index, entry] of tombstones.endpoints.entries()) {
      assertFabricIdentifier(entry.subjectId, `tombstones.endpoints[${index}].subjectId`);
      assertGeneration(entry.generation, `tombstones.endpoints[${index}].generation`);
      assertRevision(entry.revision, `tombstones.endpoints[${index}].revision`);
      if (endpointIds.has(entry.subjectId)) conflict("Endpoint cannot be both present and tombstoned", `tombstones.endpoints[${index}]`);
      if (endpointTombstoneIds.has(entry.subjectId)) conflict("Endpoint tombstone identity is duplicated", `tombstones.endpoints[${index}]`);
      endpointTombstoneIds.add(entry.subjectId);
      this.#assertTombstoneFence(connectorId, entry, this.#endpointFences);
    }
    for (const [index, entry] of tombstones.capabilities.entries()) {
      assertFabricIdentifier(entry.capabilityId, `tombstones.capabilities[${index}].capabilityId`);
      assertGeneration(entry.endpointGeneration, `tombstones.capabilities[${index}].endpointGeneration`);
      if (capabilityIds.has(entry.capabilityId)) conflict("Capability cannot be both present and tombstoned", `tombstones.capabilities[${index}]`);
      if (capabilityTombstoneIds.has(entry.capabilityId)) conflict("Capability tombstone identity is duplicated", `tombstones.capabilities[${index}]`);
      capabilityTombstoneIds.add(entry.capabilityId);
      const prior = this.#capabilityFences.get(entry.capabilityId);
      if (prior !== undefined && (prior.connectorId !== connectorId || entry.endpointGeneration < prior.endpointGeneration)) {
        throw new FabricContractError("stale_generation", "Capability tombstone high-water cannot roll back or change ownership", `tombstones.capabilities[${index}]`);
      }
    }
  }

  #assertTombstoneFence(connectorId: string, entry: FabricAdvertisementRemovalTombstone, fences: ReadonlyMap<string, GenerationFence>): void {
    const prior = fences.get(entry.subjectId);
    if (prior === undefined) return;
    if (prior.connectorId !== connectorId || entry.generation < prior.generation || (entry.generation === prior.generation && entry.revision < prior.revision)) {
      throw new FabricContractError("stale_generation", "Tombstone high-water cannot roll back or change ownership", entry.subjectId);
    }
  }

  #commitTombstones(connectorId: string, tombstones: FabricAdvertisementRemovalSet): void {
    for (const entry of tombstones.workspaces) {
      const prior = this.#workspaceFences.get(entry.subjectId);
      this.#workspaceFences.set(entry.subjectId, {
        connectorId, generation: entry.generation, revision: entry.revision, present: false,
        fingerprint: prior?.fingerprint ?? "", recordFingerprint: prior?.recordFingerprint ?? "",
      });
    }
    for (const entry of tombstones.endpoints) {
      const prior = this.#endpointFences.get(entry.subjectId);
      this.#endpointFences.set(entry.subjectId, {
        connectorId, generation: entry.generation, revision: entry.revision, present: false,
        fingerprint: prior?.fingerprint ?? "", recordFingerprint: prior?.recordFingerprint ?? "",
      });
    }
    for (const entry of tombstones.capabilities) {
      const prior = this.#capabilityFences.get(entry.capabilityId);
      this.#capabilityFences.set(entry.capabilityId, {
        connectorId,
        present: false,
        fingerprint: prior?.fingerprint ?? "",
        endpointGeneration: entry.endpointGeneration,
      });
    }
  }

  getOfflineInventory(connectorId: string): FabricOfflineInventoryView | undefined {
    const entry = this.#offlineInventories.get(connectorId);
    if (entry === undefined) return undefined;
    return {
      connectorId,
      connectionId: entry.connectionId,
      connectionGeneration: entry.connectionGeneration,
      credentialGeneration: entry.credentialGeneration,
      capabilityDigest: entry.capabilityDigest,
      advertisementRevision: entry.advertisementRevision,
      acceptedAt: entry.acceptedAt,
      devices: entry.devices.map(projectDevice).sort((a, b) => compareText(a.deviceId, b.deviceId)),
      workspaces: entry.workspaces.map(projectWorkspace).sort((a, b) => compareText(a.workspaceId, b.workspaceId)),
      endpoints: entry.endpoints.map(projectEndpoint).sort((a, b) => compareText(a.endpointId, b.endpointId)),
      capabilities: entry.capabilities.map(projectCapability).sort((a, b) => compareText(a.capabilityId, b.capabilityId)),
      tombstones: structuredClone(entry.tombstones),
    };
  }

  listOfflineInventories(): readonly FabricOfflineInventoryView[] {
    return [...this.#offlineInventories.keys()].sort(compareText).flatMap((connectorId) => {
      const view = this.getOfflineInventory(connectorId);
      return view === undefined ? [] : [view];
    });
  }

  getAdvertisementRevision(connectorId: string): number | undefined {
    return this.#advertisements.get(connectorId)?.advertisementRevision;
  }

  getAcceptedAdvertisement(connectorId: string): AcceptedAdvertisementMetadata | undefined {
    const entry = this.#advertisements.get(connectorId);
    if (entry === undefined) return undefined;
    const { connectionId, connectionGeneration, capabilityDigest, advertisementRevision } = entry;
    return { connectorId, connectionId, connectionGeneration, capabilityDigest, advertisementRevision };
  }

  getAcceptedExecutionView(connectorId: string, deviceId?: string): FabricAcceptedExecutionView | undefined {
    const entry = this.#advertisements.get(connectorId);
    if (entry === undefined) return undefined;
    const devices = entry.devices.filter((device) => deviceId === undefined || device.deviceId === deviceId);
    if (deviceId !== undefined && devices.length === 0) return undefined;
    const deviceIds = new Set(devices.map((device) => device.deviceId));
    const workspaces = entry.workspaces.filter((workspace) => deviceIds.has(workspace.deviceId));
    const workspaceIds = new Set(workspaces.map((workspace) => workspace.workspaceId));
    const endpoints = entry.endpoints.filter((endpoint) => deviceIds.has(endpoint.deviceId) && (endpoint.scope.kind !== "workspace" || workspaceIds.has(endpoint.scope.workspaceId)));
    const endpointIds = new Set(endpoints.map((endpoint) => endpoint.endpointId));
    return {
      connectorId,
      connectionId: entry.connectionId,
      connectionGeneration: entry.connectionGeneration,
      capabilityDigest: entry.capabilityDigest,
      advertisementRevision: entry.advertisementRevision,
      devices: devices.map(projectDevice).sort((a, b) => compareText(a.deviceId, b.deviceId)),
      workspaces: workspaces.map(projectWorkspace).sort((a, b) => compareText(a.workspaceId, b.workspaceId)),
      endpoints: endpoints.map(projectEndpoint).sort((a, b) => compareText(a.endpointId, b.endpointId)),
      capabilities: entry.capabilities.filter((capability) => endpointIds.has(capability.endpointId)).map(projectCapability)
        .sort((a, b) => compareText(a.capabilityId, b.capabilityId)),
    };
  }

  listAcceptedExecutionViews(): readonly FabricAcceptedExecutionView[] {
    return [...this.#advertisements.keys()].sort(compareText).flatMap((connectorId) => {
      const view = this.getAcceptedExecutionView(connectorId);
      return view === undefined ? [] : [view];
    });
  }

  getConnector(connectorId: string): PublicConnectorRecord | undefined {
    const record = this.#connectors.get(connectorId);
    return record === undefined ? undefined : projectConnector(record);
  }

  /** Symbol-keyed package seam keeps nonce-bearing registry authority out of the public Directory API. */
  [FABRIC_DIRECTORY_REGISTRY_AUTHORITY](connectorId: string): ConnectorRecord | undefined {
    const record = this.#connectors.get(connectorId);
    return record === undefined ? undefined : { ...record };
  }

  getDevice(deviceId: string): DeviceRecord | undefined {
    const record = this.#devices.get(deviceId);
    return record === undefined ? undefined : projectDevice(record);
  }

  getWorkspace(workspaceId: string): PublicWorkspaceRecord | undefined {
    for (const snapshot of this.#advertisements.values()) {
      const record = snapshot.workspaces.find((workspace) => workspace.workspaceId === workspaceId);
      if (record !== undefined) return projectWorkspace(record);
    }
    return undefined;
  }

  getEndpoint(endpointId: string): EndpointRecord | undefined {
    for (const snapshot of this.#advertisements.values()) {
      const record = snapshot.endpoints.find((endpoint) => endpoint.endpointId === endpointId);
      if (record !== undefined) return projectEndpoint(record);
    }
    return undefined;
  }

  list(): FabricDirectorySnapshot {
    const snapshots = [...this.#advertisements.values()];
    return {
      connectors: [...this.#connectors.values()].map(projectConnector).sort((a, b) => compareText(a.connectorId, b.connectorId)),
      devices: [...this.#devices.values()].map(projectDevice).sort((a, b) => compareText(a.deviceId, b.deviceId)),
      workspaces: snapshots.flatMap((entry) => entry.workspaces.map(projectWorkspace)).sort((a, b) => compareText(a.workspaceId, b.workspaceId)),
      endpoints: snapshots.flatMap((entry) => entry.endpoints.map(projectEndpoint)).sort((a, b) => compareText(a.endpointId, b.endpointId)),
      capabilities: snapshots.flatMap((entry) => entry.capabilities.map(projectCapability)).sort((a, b) => compareText(a.capabilityId, b.capabilityId)),
    };
  }

  resolveCapabilities(query: CapabilityQuery = {}): readonly CapabilityCandidate[] {
    const listed = this.list();
    const deviceByEndpoint = new Map(listed.endpoints.map((endpoint) => [endpoint.endpointId, endpoint]));
    return listed.capabilities
      .filter((binding) => query.capabilityId === undefined || binding.capabilityId === query.capabilityId)
      .filter((binding) => query.kind === undefined || binding.kind === query.kind)
      .filter((binding) => query.deviceId === undefined || deviceByEndpoint.get(binding.endpointId)?.deviceId === query.deviceId)
      .filter((binding) => query.onlineOnly !== true || deviceByEndpoint.get(binding.endpointId)?.status === "online")
      .sort((left, right) => right.priority - left.priority || compareText(left.capabilityId, right.capabilityId) || compareText(left.endpointId, right.endpointId))
      .map((binding) => ({ binding: projectCapability(binding), reason: `advertised priority ${binding.priority}` }));
  }
}
