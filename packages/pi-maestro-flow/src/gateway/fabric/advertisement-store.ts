/** Durable Gateway registry adapter for staged Fabric advertisements. */
import {
  FabricStoreCoordinator,
  type FabricDirectory,
  type FabricLogicalStoreSnapshot,
  type FabricOfflineInventorySeed,
  type FabricStagedAdvertisementCandidate,
  type FabricStoredRecord,
} from "pi-maestro-fabric";
import {
  FabricContractError,
  assertBoundedString,
  assertEpochMilliseconds,
  assertFabricIdentifier,
  assertGeneration,
  assertRevision,
  assertValidCapabilityBinding,
  assertValidEndpointRecord,
  assertValidWorkspaceRecord,
  type CapabilityBinding,
  type EndpointRecord,
  type JsonValue,
  type WorkspaceRecord,
} from "pi-maestro-fabric-core/v1";

export const GATEWAY_FABRIC_ADVERTISEMENT_RECORD_VERSION = 1 as const;
export const GATEWAY_FABRIC_ADVERTISEMENT_PREFIXES = Object.freeze({
  workspace: "workspace:",
  endpoint: "endpoint:",
  capability: "capability:",
  advertisement: "advertisement:",
});

const RECORD_TYPES = Object.freeze({
  workspace: "gateway.fabric.advertisement.workspace",
  endpoint: "gateway.fabric.advertisement.endpoint",
  capability: "gateway.fabric.advertisement.capability",
  advertisement: "gateway.fabric.advertisement",
});

const COMMON_KEYS = [
  "recordType", "version", "revision", "connectorId", "connectionId", "connectionGeneration",
  "credentialGeneration", "advertisementRevision", "capabilityDigest", "acceptedAt",
] as const;
const MAX_INVENTORY_ITEMS = 10_000;

type AdvertisementKind = keyof typeof GATEWAY_FABRIC_ADVERTISEMENT_PREFIXES;
type FabricRecord = Readonly<Record<string, unknown>>;

interface CommonRecord {
  readonly recordType: string;
  readonly version: typeof GATEWAY_FABRIC_ADVERTISEMENT_RECORD_VERSION;
  readonly revision: number;
  readonly connectorId: string;
  readonly connectionId: string;
  readonly connectionGeneration: number;
  readonly credentialGeneration: number;
  readonly advertisementRevision: number;
  readonly capabilityDigest: string;
  readonly acceptedAt: number;
}

interface StoredWorkspace extends CommonRecord {
  readonly kind: "workspace";
  readonly workspaceId: string;
  readonly tombstone: boolean;
  readonly workspace?: WorkspaceRecord;
  readonly workspaceGeneration?: number;
  readonly workspaceRevision?: number;
}

interface StoredEndpoint extends CommonRecord {
  readonly kind: "endpoint";
  readonly endpointId: string;
  readonly tombstone: boolean;
  readonly endpoint?: EndpointRecord;
  readonly endpointGeneration?: number;
  readonly endpointRevision?: number;
}

interface StoredCapability extends CommonRecord {
  readonly kind: "capability";
  readonly capabilityId: string;
  readonly tombstone: boolean;
  readonly capability?: CapabilityBinding;
  readonly endpointGeneration?: number;
}

interface StoredAdvertisement extends CommonRecord {
  readonly kind: "advertisement";
  readonly deviceIds: readonly string[];
  readonly workspaceIds: readonly string[];
  readonly endpointIds: readonly string[];
  readonly capabilityIds: readonly string[];
  readonly workspaceTombstoneIds: readonly string[];
  readonly endpointTombstoneIds: readonly string[];
  readonly capabilityTombstoneIds: readonly string[];
}

interface ParsedAdvertisementRegistry {
  readonly workspaces: ReadonlyMap<string, StoredWorkspace>;
  readonly endpoints: ReadonlyMap<string, StoredEndpoint>;
  readonly capabilities: ReadonlyMap<string, StoredCapability>;
  readonly advertisements: ReadonlyMap<string, StoredAdvertisement>;
}

function fail(path: string, message: string): never {
  throw new FabricContractError("protocol_violation", message, path);
}

function recordOf(value: unknown, path: string): FabricRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, `${path} must be an object`);
  return value as FabricRecord;
}

function exactKeys(record: FabricRecord, required: readonly string[], optional: readonly string[], path: string): void {
  const requiredSet = new Set(required);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!(key in record)) fail(`${path}.${key}`, `${path}.${key} is required`);
  for (const key of Object.keys(record)) if (!allowed.has(key)) fail(`${path}.${key}`, `${path}.${key} is not recognized`);
  for (const key of optional) if (requiredSet.has(key)) fail(path, `${path} has an invalid schema`);
}

function requiredString(record: FabricRecord, key: string, path: string, maximum = 256): string {
  const value = record[key];
  if (typeof value !== "string") fail(`${path}.${key}`, `${path}.${key} must be a string`);
  try { assertBoundedString(value, `${path}.${key}`, maximum); }
  catch { fail(`${path}.${key}`, `${path}.${key} is invalid`); }
  if (value.length === 0) fail(`${path}.${key}`, `${path}.${key} must not be empty`);
  return value;
}

function requiredIdentifier(record: FabricRecord, key: string, path: string): string {
  const value = record[key];
  try { assertFabricIdentifier(value, `${path}.${key}`); }
  catch { fail(`${path}.${key}`, `${path}.${key} is not a Fabric identifier`); }
  return value;
}

function requiredRevision(record: FabricRecord, key: string, path: string, positive = false): number {
  const value = record[key];
  try { assertRevision(value, `${path}.${key}`); }
  catch { fail(`${path}.${key}`, `${path}.${key} is not a revision`); }
  if (positive && value < 1) fail(`${path}.${key}`, `${path}.${key} must be positive`);
  return value;
}

function requiredGeneration(record: FabricRecord, key: string, path: string): number {
  const value = record[key];
  try { assertGeneration(value, `${path}.${key}`); }
  catch { fail(`${path}.${key}`, `${path}.${key} is not a generation`); }
  return value;
}

function requiredTimestamp(record: FabricRecord, key: string, path: string): number {
  const value = record[key];
  try { assertEpochMilliseconds(value, `${path}.${key}`); }
  catch { fail(`${path}.${key}`, `${path}.${key} is not an epoch timestamp`); }
  return value;
}

function requiredBoolean(record: FabricRecord, key: string, path: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") fail(`${path}.${key}`, `${path}.${key} must be boolean`);
  return value;
}

function identifierList(record: FabricRecord, key: string, path: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length > MAX_INVENTORY_ITEMS) fail(`${path}.${key}`, `${path}.${key} must be a bounded array`);
  const result = value.map((entry, index) => {
    try { assertFabricIdentifier(entry, `${path}.${key}[${index}]`); }
    catch { fail(`${path}.${key}[${index}]`, `${path}.${key}[${index}] is not a Fabric identifier`); }
    return entry;
  });
  if (new Set(result).size !== result.length) fail(`${path}.${key}`, `${path}.${key} contains duplicates`);
  if (result.some((entry, index) => index > 0 && result[index - 1]! >= entry)) fail(`${path}.${key}`, `${path}.${key} must be canonically sorted`);
  return result;
}

function commonOf(record: FabricRecord, subjectId: string, kind: AdvertisementKind): CommonRecord {
  const path = `registry.${subjectId}`;
  const recordType = requiredString(record, "recordType", path);
  if (recordType !== RECORD_TYPES[kind]) fail(`${path}.recordType`, `${path}.recordType is unsupported`);
  if (record.version !== GATEWAY_FABRIC_ADVERTISEMENT_RECORD_VERSION) fail(`${path}.version`, `${path}.version is unsupported`);
  return {
    recordType,
    version: GATEWAY_FABRIC_ADVERTISEMENT_RECORD_VERSION,
    revision: requiredRevision(record, "revision", path, true),
    connectorId: requiredIdentifier(record, "connectorId", path),
    connectionId: requiredIdentifier(record, "connectionId", path),
    connectionGeneration: requiredGeneration(record, "connectionGeneration", path),
    credentialGeneration: requiredGeneration(record, "credentialGeneration", path),
    advertisementRevision: requiredRevision(record, "advertisementRevision", path, true),
    capabilityDigest: requiredString(record, "capabilityDigest", path),
    acceptedAt: requiredTimestamp(record, "acceptedAt", path),
  };
}

function exactWorkspace(value: unknown, path: string): WorkspaceRecord {
  const record = recordOf(value, path);
  exactKeys(record, ["workspaceId", "deviceId", "localWorkspaceId", "label", "mode", "generation", "policyDigest", "endpointIds", "revision"], [], path);
  try { assertValidWorkspaceRecord(record); }
  catch { fail(path, `${path} is not a valid Workspace record`); }
  return structuredClone(record);
}

function exactEndpoint(value: unknown, path: string): EndpointRecord {
  const record = recordOf(value, path);
  const kind = record.kind;
  if (kind === "agent") {
    exactKeys(record, ["endpointId", "deviceId", "connectorId", "scope", "generation", "contractHash", "status", "revision", "kind", "roles", "taskTypes", "models", "maxConcurrency"], [], path);
  } else if (kind === "mcp") {
    exactKeys(record, ["endpointId", "deviceId", "connectorId", "scope", "generation", "contractHash", "status", "revision", "kind", "serverName", "protocolVersion", "transport", "durableDeduplication"], [], path);
  } else {
    fail(`${path}.kind`, `${path}.kind is unsupported`);
  }
  const scope = recordOf(record.scope, `${path}.scope`);
  if (scope.kind === "device") exactKeys(scope, ["kind"], [], `${path}.scope`);
  else if (scope.kind === "workspace") exactKeys(scope, ["kind", "workspaceId"], [], `${path}.scope`);
  else fail(`${path}.scope.kind`, `${path}.scope.kind is unsupported`);
  try { assertValidEndpointRecord(record); }
  catch { fail(path, `${path} is not a valid Endpoint record`); }
  return structuredClone(record);
}

function exactCapability(value: unknown, path: string): CapabilityBinding {
  const record = recordOf(value, path);
  exactKeys(record, ["capabilityId", "kind", "endpointId", "contractHash", "trustLevel", "priority"], ["inputSchema", "locality"], path);
  try { assertValidCapabilityBinding(record); }
  catch { fail(path, `${path} is not a valid Capability binding`); }
  return structuredClone(record);
}

function subjectIdentity(subjectId: string, prefix: string, path: string): string {
  const identity = subjectId.slice(prefix.length);
  try { assertFabricIdentifier(identity, path); }
  catch { fail(path, `${path} has an invalid subject identity`); }
  return identity;
}

function parseWorkspace(subjectId: string, value: unknown): StoredWorkspace {
  const path = `registry.${subjectId}`;
  const record = recordOf(value, path);
  const tombstone = requiredBoolean(record, "tombstone", path);
  exactKeys(record, [...COMMON_KEYS, "workspaceId", "tombstone", ...(tombstone ? ["workspaceGeneration", "workspaceRevision"] : ["workspace"])], [], path);
  const common = commonOf(record, subjectId, "workspace");
  const workspaceId = requiredIdentifier(record, "workspaceId", path);
  if (workspaceId !== subjectIdentity(subjectId, GATEWAY_FABRIC_ADVERTISEMENT_PREFIXES.workspace, path)) fail(`${path}.workspaceId`, "Workspace row identity disagrees with its subject");
  if (tombstone) return { ...common, kind: "workspace", workspaceId, tombstone, workspaceGeneration: requiredGeneration(record, "workspaceGeneration", path), workspaceRevision: requiredRevision(record, "workspaceRevision", path) };
  const workspace = exactWorkspace(record.workspace, `${path}.workspace`);
  if (workspace.workspaceId !== workspaceId) fail(`${path}.workspace.workspaceId`, "Workspace row identity disagrees with its record");
  return { ...common, kind: "workspace", workspaceId, tombstone, workspace };
}

function parseEndpoint(subjectId: string, value: unknown): StoredEndpoint {
  const path = `registry.${subjectId}`;
  const record = recordOf(value, path);
  const tombstone = requiredBoolean(record, "tombstone", path);
  exactKeys(record, [...COMMON_KEYS, "endpointId", "tombstone", ...(tombstone ? ["endpointGeneration", "endpointRevision"] : ["endpoint"])], [], path);
  const common = commonOf(record, subjectId, "endpoint");
  const endpointId = requiredIdentifier(record, "endpointId", path);
  if (endpointId !== subjectIdentity(subjectId, GATEWAY_FABRIC_ADVERTISEMENT_PREFIXES.endpoint, path)) fail(`${path}.endpointId`, "Endpoint row identity disagrees with its subject");
  if (tombstone) return { ...common, kind: "endpoint", endpointId, tombstone, endpointGeneration: requiredGeneration(record, "endpointGeneration", path), endpointRevision: requiredRevision(record, "endpointRevision", path) };
  const endpoint = exactEndpoint(record.endpoint, `${path}.endpoint`);
  if (endpoint.endpointId !== endpointId || endpoint.connectorId !== common.connectorId) fail(`${path}.endpoint`, "Endpoint row ownership disagrees with its record");
  return { ...common, kind: "endpoint", endpointId, tombstone, endpoint };
}

function parseCapability(subjectId: string, value: unknown): StoredCapability {
  const path = `registry.${subjectId}`;
  const record = recordOf(value, path);
  const tombstone = requiredBoolean(record, "tombstone", path);
  exactKeys(record, [...COMMON_KEYS, "capabilityId", "tombstone", ...(tombstone ? ["endpointGeneration"] : ["capability"])], [], path);
  const common = commonOf(record, subjectId, "capability");
  const capabilityId = requiredIdentifier(record, "capabilityId", path);
  if (capabilityId !== subjectIdentity(subjectId, GATEWAY_FABRIC_ADVERTISEMENT_PREFIXES.capability, path)) fail(`${path}.capabilityId`, "Capability row identity disagrees with its subject");
  if (tombstone) return { ...common, kind: "capability", capabilityId, tombstone, endpointGeneration: requiredGeneration(record, "endpointGeneration", path) };
  const capability = exactCapability(record.capability, `${path}.capability`);
  if (capability.capabilityId !== capabilityId) fail(`${path}.capability.capabilityId`, "Capability row identity disagrees with its record");
  return { ...common, kind: "capability", capabilityId, tombstone, capability };
}

function parseAdvertisement(subjectId: string, value: unknown): StoredAdvertisement {
  const path = `registry.${subjectId}`;
  const record = recordOf(value, path);
  const listKeys = ["deviceIds", "workspaceIds", "endpointIds", "capabilityIds", "workspaceTombstoneIds", "endpointTombstoneIds", "capabilityTombstoneIds"] as const;
  exactKeys(record, [...COMMON_KEYS, ...listKeys], [], path);
  const common = commonOf(record, subjectId, "advertisement");
  if (common.connectorId !== subjectIdentity(subjectId, GATEWAY_FABRIC_ADVERTISEMENT_PREFIXES.advertisement, path)) fail(`${path}.connectorId`, "Advertisement ownership disagrees with its subject");
  return {
    ...common,
    kind: "advertisement",
    deviceIds: identifierList(record, "deviceIds", path),
    workspaceIds: identifierList(record, "workspaceIds", path),
    endpointIds: identifierList(record, "endpointIds", path),
    capabilityIds: identifierList(record, "capabilityIds", path),
    workspaceTombstoneIds: identifierList(record, "workspaceTombstoneIds", path),
    endpointTombstoneIds: identifierList(record, "endpointTombstoneIds", path),
    capabilityTombstoneIds: identifierList(record, "capabilityTombstoneIds", path),
  };
}

function sameAdmission(left: CommonRecord, right: CommonRecord): boolean {
  return left.connectorId === right.connectorId && left.connectionId === right.connectionId &&
    left.connectionGeneration === right.connectionGeneration && left.credentialGeneration === right.credentialGeneration &&
    left.advertisementRevision === right.advertisementRevision && left.capabilityDigest === right.capabilityDigest &&
    left.acceptedAt === right.acceptedAt;
}

function listed(ids: readonly string[], id: string): boolean { return ids.includes(id); }

function validateRelationships(parsed: ParsedAdvertisementRegistry): void {
  for (const [id, row] of parsed.workspaces) {
    const owner = parsed.advertisements.get(row.connectorId);
    if (owner === undefined) fail(`registry.workspace:${id}`, `Workspace ${id} has no advertisement owner`);
    const inPresent = listed(owner.workspaceIds, id);
    const inTombstones = listed(owner.workspaceTombstoneIds, id);
    if (inPresent === inTombstones || inPresent === row.tombstone) fail(`registry.workspace:${id}`, `Workspace ${id} presence disagrees with its advertisement`);
    if (!row.tombstone && !sameAdmission(row, owner)) fail(`registry.workspace:${id}`, `Workspace ${id} admission metadata disagrees with its advertisement`);
  }
  for (const [id, row] of parsed.endpoints) {
    const owner = parsed.advertisements.get(row.connectorId);
    if (owner === undefined) fail(`registry.endpoint:${id}`, `Endpoint ${id} has no advertisement owner`);
    const inPresent = listed(owner.endpointIds, id);
    const inTombstones = listed(owner.endpointTombstoneIds, id);
    if (inPresent === inTombstones || inPresent === row.tombstone) fail(`registry.endpoint:${id}`, `Endpoint ${id} presence disagrees with its advertisement`);
    if (!row.tombstone && !sameAdmission(row, owner)) fail(`registry.endpoint:${id}`, `Endpoint ${id} admission metadata disagrees with its advertisement`);
  }
  for (const [id, row] of parsed.capabilities) {
    const owner = parsed.advertisements.get(row.connectorId);
    if (owner === undefined) fail(`registry.capability:${id}`, `Capability ${id} has no advertisement owner`);
    const inPresent = listed(owner.capabilityIds, id);
    const inTombstones = listed(owner.capabilityTombstoneIds, id);
    if (inPresent === inTombstones || inPresent === row.tombstone) fail(`registry.capability:${id}`, `Capability ${id} presence disagrees with its advertisement`);
    if (!row.tombstone && !sameAdmission(row, owner)) fail(`registry.capability:${id}`, `Capability ${id} admission metadata disagrees with its advertisement`);
  }
  for (const [connectorId, owner] of parsed.advertisements) {
    for (const id of owner.workspaceIds) if (parsed.workspaces.get(id)?.connectorId !== connectorId) fail(`registry.advertisement:${connectorId}.workspaceIds`, `Advertisement references an unowned Workspace ${id}`);
    for (const id of owner.endpointIds) if (parsed.endpoints.get(id)?.connectorId !== connectorId) fail(`registry.advertisement:${connectorId}.endpointIds`, `Advertisement references an unowned Endpoint ${id}`);
    for (const id of owner.capabilityIds) if (parsed.capabilities.get(id)?.connectorId !== connectorId) fail(`registry.advertisement:${connectorId}.capabilityIds`, `Advertisement references an unowned Capability ${id}`);
    for (const id of owner.workspaceTombstoneIds) if (parsed.workspaces.get(id)?.connectorId !== connectorId) fail(`registry.advertisement:${connectorId}.workspaceTombstoneIds`, `Advertisement references an unowned Workspace tombstone ${id}`);
    for (const id of owner.endpointTombstoneIds) if (parsed.endpoints.get(id)?.connectorId !== connectorId) fail(`registry.advertisement:${connectorId}.endpointTombstoneIds`, `Advertisement references an unowned Endpoint tombstone ${id}`);
    for (const id of owner.capabilityTombstoneIds) if (parsed.capabilities.get(id)?.connectorId !== connectorId) fail(`registry.advertisement:${connectorId}.capabilityTombstoneIds`, `Advertisement references an unowned Capability tombstone ${id}`);
  }
}

function parseRegistry(snapshot: FabricLogicalStoreSnapshot): ParsedAdvertisementRegistry {
  const workspaces = new Map<string, StoredWorkspace>();
  const endpoints = new Map<string, StoredEndpoint>();
  const capabilities = new Map<string, StoredCapability>();
  const advertisements = new Map<string, StoredAdvertisement>();
  for (const [subjectId, value] of Object.entries(snapshot.records)) {
    if (subjectId.startsWith(GATEWAY_FABRIC_ADVERTISEMENT_PREFIXES.workspace)) {
      const row = parseWorkspace(subjectId, value); workspaces.set(row.workspaceId, row);
    } else if (subjectId.startsWith(GATEWAY_FABRIC_ADVERTISEMENT_PREFIXES.endpoint)) {
      const row = parseEndpoint(subjectId, value); endpoints.set(row.endpointId, row);
    } else if (subjectId.startsWith(GATEWAY_FABRIC_ADVERTISEMENT_PREFIXES.capability)) {
      const row = parseCapability(subjectId, value); capabilities.set(row.capabilityId, row);
    } else if (subjectId.startsWith(GATEWAY_FABRIC_ADVERTISEMENT_PREFIXES.advertisement)) {
      const row = parseAdvertisement(subjectId, value); advertisements.set(row.connectorId, row);
    }
  }
  const parsed = { workspaces, endpoints, capabilities, advertisements };
  validateRelationships(parsed);
  return parsed;
}

function commonValue(candidate: FabricStagedAdvertisementCandidate, recordType: string, revision: number): Record<string, JsonValue> {
  return {
    recordType,
    version: GATEWAY_FABRIC_ADVERTISEMENT_RECORD_VERSION,
    revision,
    connectorId: candidate.connectorId,
    connectionId: candidate.connectionId,
    connectionGeneration: candidate.connectionGeneration,
    credentialGeneration: candidate.credentialGeneration,
    advertisementRevision: candidate.advertisementRevision,
    capabilityDigest: candidate.capabilityDigest,
    acceptedAt: candidate.preparedAt,
  };
}

function nextRevision(record: FabricStoredRecord | undefined): number {
  const revision = record?.revision;
  if (revision === undefined) return 1;
  try { assertRevision(revision, "revision"); }
  catch { fail("revision", "Stored advertisement record revision is invalid"); }
  return revision + 1;
}

function expectedRevision(record: FabricStoredRecord | undefined): number | undefined {
  if (record === undefined) return undefined;
  const revision = record.revision;
  try { assertRevision(revision, "revision"); }
  catch { fail("revision", "Stored advertisement record revision is invalid"); }
  return revision;
}

function jsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry, index) => jsonValue(entry, `${path}[${index}]`));
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) if (entry !== undefined) result[key] = jsonValue(entry, `${path}.${key}`);
    return result;
  }
  throw new FabricContractError("invalid_argument", `${path} is not JSON-safe`, path);
}

function workspaceValue(workspace: WorkspaceRecord): JsonValue {
  return {
    workspaceId: workspace.workspaceId,
    deviceId: workspace.deviceId,
    localWorkspaceId: workspace.localWorkspaceId,
    label: workspace.label,
    mode: workspace.mode,
    generation: workspace.generation,
    policyDigest: workspace.policyDigest,
    endpointIds: [...workspace.endpointIds],
    revision: workspace.revision,
  };
}

function endpointValue(endpoint: EndpointRecord): JsonValue {
  const base: Record<string, JsonValue> = {
    endpointId: endpoint.endpointId,
    deviceId: endpoint.deviceId,
    connectorId: endpoint.connectorId,
    scope: endpoint.scope.kind === "device" ? { kind: "device" } : { kind: "workspace", workspaceId: endpoint.scope.workspaceId },
    generation: endpoint.generation,
    contractHash: endpoint.contractHash,
    status: endpoint.status,
    revision: endpoint.revision,
    kind: endpoint.kind,
  };
  if (endpoint.kind === "agent") {
    return { ...base, roles: [...endpoint.roles], taskTypes: [...endpoint.taskTypes], models: [...endpoint.models], maxConcurrency: endpoint.maxConcurrency };
  }
  return {
    ...base,
    serverName: endpoint.serverName,
    protocolVersion: endpoint.protocolVersion,
    transport: endpoint.transport,
    durableDeduplication: endpoint.durableDeduplication,
  };
}

function capabilityValue(capability: CapabilityBinding): JsonValue {
  return {
    capabilityId: capability.capabilityId,
    kind: capability.kind,
    endpointId: capability.endpointId,
    ...(capability.inputSchema === undefined ? {} : { inputSchema: jsonValue(capability.inputSchema, "capability.inputSchema") }),
    contractHash: capability.contractHash,
    trustLevel: capability.trustLevel,
    ...(capability.locality === undefined ? {} : { locality: capability.locality }),
    priority: capability.priority,
  };
}

function jsonRecord(value: Record<string, JsonValue>): FabricStoredRecord { return value; }
function sorted(values: Iterable<string>): string[] { return [...values].sort((left, right) => left.localeCompare(right)); }

function assertTombstoneBounds(
  workspaces: ReadonlySet<string>,
  endpoints: ReadonlySet<string>,
  capabilities: ReadonlySet<string>,
): void {
  if (
    workspaces.size > MAX_INVENTORY_ITEMS || endpoints.size > MAX_INVENTORY_ITEMS ||
    capabilities.size > MAX_INVENTORY_ITEMS || workspaces.size + endpoints.size + capabilities.size > MAX_INVENTORY_ITEMS
  ) {
    throw new FabricContractError("resource_exhausted", "Offline inventory tombstones exceed the durable inventory limit", "tombstones");
  }
}

/** One adapter over the exact Gateway coordinator; it never creates or owns a second store. */
export class GatewayFabricAdvertisementStore {
  readonly coordinator: FabricStoreCoordinator;

  constructor(coordinator: FabricStoreCoordinator) { this.coordinator = coordinator; }

  async persist(candidate: FabricStagedAdvertisementCandidate): Promise<void> {
    await this.coordinator.commit("registry", candidate.preparedAt, (snapshot) => {
      const parsed = parseRegistry(snapshot);
      const priorAdvertisement = parsed.advertisements.get(candidate.connectorId);
      if (priorAdvertisement !== undefined) {
        if (candidate.connectionGeneration < priorAdvertisement.connectionGeneration || candidate.credentialGeneration < priorAdvertisement.credentialGeneration) {
          throw new FabricContractError("stale_generation", "Durable advertisement ownership cannot roll back", "connectionGeneration");
        }
        if (candidate.connectionGeneration === priorAdvertisement.connectionGeneration &&
          (candidate.connectionId !== priorAdvertisement.connectionId || candidate.advertisementRevision <= priorAdvertisement.advertisementRevision)) {
          throw new FabricContractError("stale_generation", "Durable advertisement revision is stale", "advertisementRevision");
        }
      }

      const mutations: Array<{
        kind: "upsert";
        subjectId: string;
        expectedRevision?: number;
        value: FabricStoredRecord;
        eventKind: string;
        payload: FabricStoredRecord;
      }> = [];
      const workspaceIds = new Set(candidate.workspaces.map((record) => record.workspaceId));
      const endpointIds = new Set(candidate.endpoints.map((record) => record.endpointId));
      const capabilityIds = new Set(candidate.capabilities.map((record) => record.capabilityId));
      const workspaceRemovals = new Map(candidate.removals.workspaces.map((removal) => [removal.subjectId, removal]));
      const endpointRemovals = new Map(candidate.removals.endpoints.map((removal) => [removal.subjectId, removal]));
      const capabilityRemovals = new Map(candidate.removals.capabilities.map((removal) => [removal.capabilityId, removal]));
      for (const row of parsed.workspaces.values()) {
        if (row.connectorId === candidate.connectorId && !row.tombstone && !workspaceIds.has(row.workspaceId) && row.workspace !== undefined) {
          workspaceRemovals.set(row.workspaceId, { subjectId: row.workspaceId, generation: row.workspace.generation, revision: row.workspace.revision });
        }
      }
      for (const row of parsed.endpoints.values()) {
        if (row.connectorId === candidate.connectorId && !row.tombstone && !endpointIds.has(row.endpointId) && row.endpoint !== undefined) {
          endpointRemovals.set(row.endpointId, { subjectId: row.endpointId, generation: row.endpoint.generation, revision: row.endpoint.revision });
        }
      }
      for (const row of parsed.capabilities.values()) {
        if (row.connectorId !== candidate.connectorId || row.tombstone || capabilityIds.has(row.capabilityId) || row.capability === undefined) continue;
        const generation = parsed.endpoints.get(row.capability.endpointId)?.endpoint?.generation;
        if (generation === undefined) fail(`registry.capability:${row.capabilityId}`, `Capability ${row.capabilityId} has no present Endpoint generation`);
        capabilityRemovals.set(row.capabilityId, { capabilityId: row.capabilityId, endpointGeneration: generation });
      }
      const workspaceTombstoneIds = new Set([...parsed.workspaces.values()].filter((row) => row.connectorId === candidate.connectorId && row.tombstone).map((row) => row.workspaceId));
      const endpointTombstoneIds = new Set([...parsed.endpoints.values()].filter((row) => row.connectorId === candidate.connectorId && row.tombstone).map((row) => row.endpointId));
      const capabilityTombstoneIds = new Set([...parsed.capabilities.values()].filter((row) => row.connectorId === candidate.connectorId && row.tombstone).map((row) => row.capabilityId));

      for (const workspace of candidate.workspaces) {
        const subjectId = `${GATEWAY_FABRIC_ADVERTISEMENT_PREFIXES.workspace}${workspace.workspaceId}`;
        const current = snapshot.records[subjectId];
        const owned = parsed.workspaces.get(workspace.workspaceId);
        if (owned !== undefined && owned.connectorId !== candidate.connectorId) throw new FabricContractError("conflict", "Workspace registry identity is owned by another Connector", workspace.workspaceId);
        const revision = nextRevision(current);
        workspaceTombstoneIds.delete(workspace.workspaceId);
        mutations.push({
          kind: "upsert", subjectId, expectedRevision: expectedRevision(current),
          value: jsonRecord({ ...commonValue(candidate, RECORD_TYPES.workspace, revision), workspaceId: workspace.workspaceId, tombstone: false, workspace: workspaceValue(workspace) }),
          eventKind: "advertisement.workspace.upserted", payload: { connectorId: candidate.connectorId, workspaceId: workspace.workspaceId, connectionId: candidate.connectionId, connectionGeneration: candidate.connectionGeneration, state: "present" },
        });
      }
      for (const removal of workspaceRemovals.values()) {
        const subjectId = `${GATEWAY_FABRIC_ADVERTISEMENT_PREFIXES.workspace}${removal.subjectId}`;
        const current = snapshot.records[subjectId];
        const owned = parsed.workspaces.get(removal.subjectId);
        if (owned !== undefined && owned.connectorId !== candidate.connectorId) throw new FabricContractError("conflict", "Workspace tombstone identity is owned by another Connector", removal.subjectId);
        const revision = nextRevision(current);
        workspaceIds.delete(removal.subjectId);
        workspaceTombstoneIds.add(removal.subjectId);
        mutations.push({
          kind: "upsert", subjectId, expectedRevision: expectedRevision(current),
          value: jsonRecord({ ...commonValue(candidate, RECORD_TYPES.workspace, revision), workspaceId: removal.subjectId, tombstone: true, workspaceGeneration: removal.generation, workspaceRevision: removal.revision }),
          eventKind: "advertisement.workspace.tombstoned", payload: { connectorId: candidate.connectorId, workspaceId: removal.subjectId, connectionId: candidate.connectionId, connectionGeneration: candidate.connectionGeneration, state: "tombstoned" },
        });
      }
      for (const endpoint of candidate.endpoints) {
        const subjectId = `${GATEWAY_FABRIC_ADVERTISEMENT_PREFIXES.endpoint}${endpoint.endpointId}`;
        const current = snapshot.records[subjectId];
        const owned = parsed.endpoints.get(endpoint.endpointId);
        if (owned !== undefined && owned.connectorId !== candidate.connectorId) throw new FabricContractError("conflict", "Endpoint registry identity is owned by another Connector", endpoint.endpointId);
        const revision = nextRevision(current);
        endpointTombstoneIds.delete(endpoint.endpointId);
        mutations.push({
          kind: "upsert", subjectId, expectedRevision: expectedRevision(current),
          value: jsonRecord({ ...commonValue(candidate, RECORD_TYPES.endpoint, revision), endpointId: endpoint.endpointId, tombstone: false, endpoint: endpointValue(endpoint) }),
          eventKind: "advertisement.endpoint.upserted", payload: { connectorId: candidate.connectorId, endpointId: endpoint.endpointId, connectionId: candidate.connectionId, connectionGeneration: candidate.connectionGeneration, state: "present" },
        });
      }
      for (const removal of endpointRemovals.values()) {
        const subjectId = `${GATEWAY_FABRIC_ADVERTISEMENT_PREFIXES.endpoint}${removal.subjectId}`;
        const current = snapshot.records[subjectId];
        const owned = parsed.endpoints.get(removal.subjectId);
        if (owned !== undefined && owned.connectorId !== candidate.connectorId) throw new FabricContractError("conflict", "Endpoint tombstone identity is owned by another Connector", removal.subjectId);
        const revision = nextRevision(current);
        endpointIds.delete(removal.subjectId);
        endpointTombstoneIds.add(removal.subjectId);
        mutations.push({
          kind: "upsert", subjectId, expectedRevision: expectedRevision(current),
          value: jsonRecord({ ...commonValue(candidate, RECORD_TYPES.endpoint, revision), endpointId: removal.subjectId, tombstone: true, endpointGeneration: removal.generation, endpointRevision: removal.revision }),
          eventKind: "advertisement.endpoint.tombstoned", payload: { connectorId: candidate.connectorId, endpointId: removal.subjectId, connectionId: candidate.connectionId, connectionGeneration: candidate.connectionGeneration, state: "tombstoned" },
        });
      }
      const endpointGeneration = new Map(candidate.endpoints.map((endpoint) => [endpoint.endpointId, endpoint.generation]));
      for (const capability of candidate.capabilities) {
        const subjectId = `${GATEWAY_FABRIC_ADVERTISEMENT_PREFIXES.capability}${capability.capabilityId}`;
        const current = snapshot.records[subjectId];
        const owned = parsed.capabilities.get(capability.capabilityId);
        if (owned !== undefined && owned.connectorId !== candidate.connectorId) throw new FabricContractError("conflict", "Capability registry identity is owned by another Connector", capability.capabilityId);
        const revision = nextRevision(current);
        capabilityTombstoneIds.delete(capability.capabilityId);
        mutations.push({
          kind: "upsert", subjectId, expectedRevision: expectedRevision(current),
          value: jsonRecord({ ...commonValue(candidate, RECORD_TYPES.capability, revision), capabilityId: capability.capabilityId, tombstone: false, capability: capabilityValue(capability) }),
          eventKind: "advertisement.capability.upserted", payload: { connectorId: candidate.connectorId, capabilityId: capability.capabilityId, connectionId: candidate.connectionId, connectionGeneration: candidate.connectionGeneration, generation: endpointGeneration.get(capability.endpointId) ?? 0, state: "present" },
        });
      }
      for (const removal of capabilityRemovals.values()) {
        const subjectId = `${GATEWAY_FABRIC_ADVERTISEMENT_PREFIXES.capability}${removal.capabilityId}`;
        const current = snapshot.records[subjectId];
        const owned = parsed.capabilities.get(removal.capabilityId);
        if (owned !== undefined && owned.connectorId !== candidate.connectorId) throw new FabricContractError("conflict", "Capability tombstone identity is owned by another Connector", removal.capabilityId);
        const revision = nextRevision(current);
        capabilityIds.delete(removal.capabilityId);
        capabilityTombstoneIds.add(removal.capabilityId);
        mutations.push({
          kind: "upsert", subjectId, expectedRevision: expectedRevision(current),
          value: jsonRecord({ ...commonValue(candidate, RECORD_TYPES.capability, revision), capabilityId: removal.capabilityId, tombstone: true, endpointGeneration: removal.endpointGeneration }),
          eventKind: "advertisement.capability.tombstoned", payload: { connectorId: candidate.connectorId, capabilityId: removal.capabilityId, connectionId: candidate.connectionId, connectionGeneration: candidate.connectionGeneration, generation: removal.endpointGeneration, state: "tombstoned" },
        });
      }
      assertTombstoneBounds(workspaceTombstoneIds, endpointTombstoneIds, capabilityTombstoneIds);

      const advertisementSubject = `${GATEWAY_FABRIC_ADVERTISEMENT_PREFIXES.advertisement}${candidate.connectorId}`;
      const currentAdvertisement = snapshot.records[advertisementSubject];
      const advertisementRevision = nextRevision(currentAdvertisement);
      mutations.push({
        kind: "upsert", subjectId: advertisementSubject, expectedRevision: expectedRevision(currentAdvertisement),
        value: jsonRecord({
          ...commonValue(candidate, RECORD_TYPES.advertisement, advertisementRevision),
          deviceIds: sorted(candidate.devices.map((device) => device.deviceId)),
          workspaceIds: sorted(workspaceIds), endpointIds: sorted(endpointIds), capabilityIds: sorted(capabilityIds),
          workspaceTombstoneIds: sorted(workspaceTombstoneIds), endpointTombstoneIds: sorted(endpointTombstoneIds), capabilityTombstoneIds: sorted(capabilityTombstoneIds),
        }),
        eventKind: "advertisement.committed", payload: { connectorId: candidate.connectorId, connectionId: candidate.connectionId, connectionGeneration: candidate.connectionGeneration, state: "offline-inventory" },
      });
      return { mutations, value: undefined };
    });
  }

  /** Startup preflight validates every recognized row before recovery publishes events. */
  async validate(): Promise<void> {
    parseRegistry(await this.coordinator.readStore("registry"));
  }

  /** Strictly loads recognized rows, then hydrates only non-executable inventory. */
  async hydrate(directory: FabricDirectory): Promise<readonly FabricOfflineInventorySeed[]> {
    const parsed = parseRegistry(await this.coordinator.readStore("registry"));
    const authorityDevices = directory.list().devices;
    const seeds = [...parsed.advertisements.values()].sort((left, right) => left.connectorId.localeCompare(right.connectorId)).map((advertisement): FabricOfflineInventorySeed => {
      const devices = advertisement.deviceIds.map((deviceId) => {
        const device = authorityDevices.find((candidate) => candidate.deviceId === deviceId && candidate.connectorId === advertisement.connectorId);
        if (device === undefined) fail(`registry.advertisement:${advertisement.connectorId}.deviceIds`, `Advertisement references unregistered Device ${deviceId}`);
        return device;
      });
      const ownedAuthorityIds = authorityDevices.filter((device) => device.connectorId === advertisement.connectorId).map((device) => device.deviceId).sort((left, right) => left.localeCompare(right));
      if (ownedAuthorityIds.length !== advertisement.deviceIds.length || ownedAuthorityIds.some((id, index) => id !== advertisement.deviceIds[index])) {
        fail(`registry.advertisement:${advertisement.connectorId}.deviceIds`, "Advertisement Devices disagree with durable registration authority");
      }
      const workspaces = advertisement.workspaceIds.map((id) => parsed.workspaces.get(id)?.workspace).filter((record): record is WorkspaceRecord => record !== undefined);
      const endpoints = advertisement.endpointIds.map((id) => parsed.endpoints.get(id)?.endpoint).filter((record): record is EndpointRecord => record !== undefined);
      const capabilities = advertisement.capabilityIds.map((id) => parsed.capabilities.get(id)?.capability).filter((record): record is CapabilityBinding => record !== undefined);
      const seed: FabricOfflineInventorySeed = {
        connectorId: advertisement.connectorId,
        connectionId: advertisement.connectionId,
        connectionGeneration: advertisement.connectionGeneration,
        credentialGeneration: advertisement.credentialGeneration,
        capabilityDigest: advertisement.capabilityDigest,
        advertisementRevision: advertisement.advertisementRevision,
        acceptedAt: advertisement.acceptedAt,
        devices,
        workspaces,
        endpoints,
        capabilities,
        tombstones: {
          workspaces: advertisement.workspaceTombstoneIds.map((id) => {
            const row = parsed.workspaces.get(id)!;
            return { subjectId: id, generation: row.workspaceGeneration!, revision: row.workspaceRevision! };
          }),
          endpoints: advertisement.endpointTombstoneIds.map((id) => {
            const row = parsed.endpoints.get(id)!;
            return { subjectId: id, generation: row.endpointGeneration!, revision: row.endpointRevision! };
          }),
          capabilities: advertisement.capabilityTombstoneIds.map((id) => {
            const row = parsed.capabilities.get(id)!;
            return { capabilityId: id, endpointGeneration: row.endpointGeneration! };
          }),
        },
      };
      directory.hydrateOfflineInventory(seed);
      return seed;
    });
    return seeds;
  }
}
