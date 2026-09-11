import {
  FabricContractError,
  assertBoundedString,
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
  FABRIC_DIRECTORY_REGISTRY_AUTHORITY,
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

export interface AcceptedAdvertisementMetadata {
  connectionId: string;
  connectionGeneration: number;
  connectorId: string;
  capabilityDigest: string;
  advertisementRevision: number;
}

export interface FabricDirectorySnapshot {
  connectors: readonly PublicConnectorRecord[];
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
  workspaces: readonly WorkspaceRecord[];
  endpoints: readonly EndpointRecord[];
  capabilities: readonly CapabilityBinding[];
}

interface GenerationFence {
  generation: number;
  fingerprint: string;
  present: boolean;
  connectorId: string;
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

function cloneOwnedSnapshot(
  snapshot: FabricAdvertisementSnapshot,
  connectorId: string,
): OwnedSnapshot {
  return {
    connectionId: snapshot.connectionId,
    connectionGeneration: snapshot.connectionGeneration,
    connectorId,
    capabilityDigest: snapshot.capabilityDigest,
    advertisementRevision: snapshot.advertisementRevision,
    workspaces: snapshot.workspaces.map((workspace) => ({ ...workspace, endpointIds: [...workspace.endpointIds] })),
    endpoints: snapshot.endpoints.map(projectEndpoint),
    capabilities: snapshot.capabilities.map(projectCapability),
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Host-owned durable authority plus connection-scoped advertisement projections. */
export class FabricDirectory {
  readonly #connectors = new Map<string, ConnectorRecord>();
  readonly #devices = new Map<string, DeviceRecord>();
  readonly #connectorRevisionHighWater = new Map<string, number>();
  readonly #deviceRevisionHighWater = new Map<string, number>();
  readonly #advertisements = new Map<string, OwnedSnapshot>();
  readonly #workspaceFences = new Map<string, GenerationFence>();
  readonly #endpointFences = new Map<string, GenerationFence>();

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
    this.#devices.clear();
    for (const [deviceId, device] of nextDevices) this.#devices.set(deviceId, device);
  }

  /** Internal package seam: only FabricConnectionManager supplies this symbol-keyed authority context. */
  [FABRIC_DIRECTORY_ADVERTISEMENT_AUTHORITY](
    context: DirectoryAdvertisementAuthorityContext,
    snapshot: FabricAdvertisementSnapshot,
  ): AcceptedAdvertisementMetadata {
    assertFabricIdentifier(snapshot.connectionId, "connectionId");
    assertGeneration(snapshot.connectionGeneration, "connectionGeneration");
    assertBoundedString(snapshot.capabilityDigest, "capabilityDigest", 256);
    assertRevision(snapshot.advertisementRevision, "advertisementRevision");
    if (
      snapshot.connectionId !== context.connectionId ||
      snapshot.connectionGeneration !== context.connectionGeneration ||
      snapshot.capabilityDigest !== context.capabilityDigest
    ) {
      throw new FabricContractError("stale_generation", "Advertisement does not match current connection authority", "connectionId");
    }

    const categories = [snapshot.devices, snapshot.workspaces, snapshot.endpoints, snapshot.capabilities] as const;
    for (const [index, items] of categories.entries()) {
      if (items.length > context.limits.maxAdvertisementItems) {
        throw new FabricContractError("resource_exhausted", "Advertisement category exceeds negotiated item limit", `advertisement[${index}]`);
      }
    }
    const total = categories.reduce((sum, items) => sum + items.length, 0);
    if (total > context.limits.maxAdvertisementItems) {
      throw new FabricContractError("resource_exhausted", "Advertisement exceeds negotiated total item limit", "advertisement");
    }

    const currentConnector = this.#connectors.get(context.connectorId);
    if (currentConnector === undefined) throw new FabricContractError("not_found", "Connector authority is not registered", "connectorId");
    const previous = this.#advertisements.get(context.connectorId);
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

    for (const device of snapshot.devices) assertValidDeviceRecord(device);
    for (const workspace of snapshot.workspaces) assertValidWorkspaceRecord(workspace);
    for (const endpoint of snapshot.endpoints) assertValidEndpointRecord(endpoint);
    for (const capability of snapshot.capabilities) assertValidCapabilityBinding(capability);

    const devices = uniqueBy(snapshot.devices, (device) => device.deviceId, "devices");
    const authorityDevices = [...this.#devices.values()].filter((device) => device.connectorId === context.connectorId);
    if (devices.size !== authorityDevices.length) {
      conflict("Advertisement devices must exactly match durable connector authority", "devices");
    }
    for (const device of authorityDevices) {
      const advertised = devices.get(device.deviceId);
      if (advertised === undefined || !sameRecord(device, advertised)) {
        conflict("Advertised device authority differs from the durable registry", "devices");
      }
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
        if (
          endpoint === undefined || endpoint.deviceId !== workspace.deviceId ||
          endpoint.scope.kind !== "workspace" || endpoint.scope.workspaceId !== workspace.workspaceId
        ) {
          conflict("Workspace endpointIds must reference scoped endpoints on the same device", "workspaces.endpointIds");
        }
      }
    }
    for (const endpoint of snapshot.endpoints) {
      if (!devices.has(endpoint.deviceId) || endpoint.connectorId !== context.connectorId) {
        conflict("Advertised endpoint ownership does not match this connector", "endpoints");
      }
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
      if (capability.contractHash !== endpoint.contractHash) {
        conflict("Capability contractHash must match its Endpoint contractHash", "capabilities.contractHash");
      }
    }

    this.#assertGenerationFences(
      snapshot.workspaces,
      new Set(previous?.workspaces.map((record) => record.workspaceId) ?? []),
      context.connectorId,
      this.#workspaceFences,
      (record) => record.workspaceId,
      workspaceFingerprint,
    );
    this.#assertGenerationFences(
      snapshot.endpoints,
      new Set(previous?.endpoints.map((record) => record.endpointId) ?? []),
      context.connectorId,
      this.#endpointFences,
      (record) => record.endpointId,
      endpointFingerprint,
    );
    const candidate = new Map(this.#advertisements);
    candidate.set(context.connectorId, cloneOwnedSnapshot(snapshot, context.connectorId));
    this.#assertGloballyUnique(candidate);

    this.#commitGenerationFences(snapshot.workspaces, context.connectorId, this.#workspaceFences, (record) => record.workspaceId, workspaceFingerprint);
    this.#commitGenerationFences(snapshot.endpoints, context.connectorId, this.#endpointFences, (record) => record.endpointId, endpointFingerprint);
    this.#advertisements.set(context.connectorId, cloneOwnedSnapshot(snapshot, context.connectorId));
    return {
      connectorId: context.connectorId,
      connectionId: snapshot.connectionId,
      connectionGeneration: snapshot.connectionGeneration,
      capabilityDigest: snapshot.capabilityDigest,
      advertisementRevision: snapshot.advertisementRevision,
    };
  }

  #assertGenerationFences<T extends { generation: number }>(
    records: readonly T[],
    previousIds: ReadonlySet<string>,
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
        if (fingerprint(record) !== prior.fingerprint) {
          throw new FabricContractError("stale_generation", "Contract or policy change requires a newer generation", id);
        }
        if (!prior.present || !previousIds.has(id)) {
          throw new FabricContractError("stale_generation", "A tombstoned identity requires a newer generation", id);
        }
      }
    }
  }

  #commitGenerationFences<T extends { generation: number }>(
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
        fingerprint: fingerprint(record),
        present: true,
        connectorId,
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

  getAdvertisementRevision(connectorId: string): number | undefined {
    return this.#advertisements.get(connectorId)?.advertisementRevision;
  }

  getAcceptedAdvertisement(connectorId: string): AcceptedAdvertisementMetadata | undefined {
    const entry = this.#advertisements.get(connectorId);
    if (entry === undefined) return undefined;
    const { connectionId, connectionGeneration, capabilityDigest, advertisementRevision } = entry;
    return { connectorId, connectionId, connectionGeneration, capabilityDigest, advertisementRevision };
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
