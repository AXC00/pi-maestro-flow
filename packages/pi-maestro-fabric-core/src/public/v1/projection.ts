import type { FabricArtifactDescriptorV1, PublicFabricArtifactDescriptorV1 } from "./artifact.ts";
import type { CapabilityBinding } from "./capability.ts";
import type { JsonValue } from "./common.ts";
import type { ConnectionLease } from "./connection.ts";
import type { ConnectorRecord, DeviceRecord } from "./device.ts";
import type { EndpointRecord } from "./endpoint.ts";
import type { FabricMountLeaseV1, PublicFabricMountLeaseV1 } from "./mount.ts";
import type { QualifiedTaskSnapshotV1 } from "./placement.ts";
import type { FabricRouteTicketV1, PublicFabricRouteTicketV1 } from "./security.ts";
import type { WorkspaceRecord } from "./workspace.ts";

/** CR/LF become spaces; every other C0 control, ESC, and DEL is stripped. */
export function sanitizeFabricProjectionText(value: string): string {
  return value
    .replace(/[\r\n]+/gu, " ")
    .replace(/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}

export interface PublicConnectorRecord {
  connectorId: string;
  label: string;
  transport: ConnectorRecord["transport"];
  credentialGeneration: number;
  lastSeenAt?: number;
  enabled: boolean;
  revision: number;
}

export interface PublicConnectionLease {
  connectionId: string;
  deviceId: string;
  connectorId: string;
  generation: number;
  state: ConnectionLease["state"];
  capabilityDigest: string;
  establishedAt: number;
  expiresAt: number;
  revision: number;
}

export interface PublicWorkspaceRecord {
  workspaceId: string;
  deviceId: string;
  label: string;
  mode: WorkspaceRecord["mode"];
  generation: number;
  policyDigest: string;
  endpointIds: readonly string[];
  revision: number;
}

export function projectConnector(record: ConnectorRecord): PublicConnectorRecord {
  return {
    connectorId: record.connectorId,
    label: sanitizeFabricProjectionText(record.label),
    transport: record.transport,
    credentialGeneration: record.credentialGeneration,
    lastSeenAt: record.lastSeenAt,
    enabled: record.enabled,
    revision: record.revision,
  };
}

export function projectDevice(record: DeviceRecord): DeviceRecord {
  return {
    deviceId: record.deviceId,
    label: sanitizeFabricProjectionText(record.label),
    connectorId: record.connectorId,
    connectionMode: record.connectionMode,
    platform: record.platform === undefined ? undefined : sanitizeFabricProjectionText(record.platform),
    architecture: record.architecture === undefined ? undefined : sanitizeFabricProjectionText(record.architecture),
    enabled: record.enabled,
    revision: record.revision,
  };
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  const clone: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) clone[key] = cloneJsonValue(entry);
  return clone;
}

/** Explicit allowlist projection for data originating in capability advertisements. */
export function projectCapability(record: CapabilityBinding): CapabilityBinding {
  let inputSchema: Readonly<Record<string, JsonValue>> | undefined;
  if (record.inputSchema !== undefined) {
    const clone: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(record.inputSchema)) clone[key] = cloneJsonValue(entry);
    inputSchema = clone;
  }
  return {
    capabilityId: record.capabilityId,
    kind: record.kind,
    endpointId: record.endpointId,
    inputSchema,
    contractHash: record.contractHash,
    trustLevel: sanitizeFabricProjectionText(record.trustLevel),
    locality: record.locality === undefined ? undefined : sanitizeFabricProjectionText(record.locality),
    priority: record.priority,
  };
}

export function projectConnection(record: ConnectionLease): PublicConnectionLease {
  return {
    connectionId: record.connectionId,
    deviceId: record.deviceId,
    connectorId: record.connectorId,
    generation: record.generation,
    state: record.state,
    capabilityDigest: record.capabilityDigest,
    establishedAt: record.establishedAt,
    expiresAt: record.expiresAt,
    revision: record.revision,
  };
}

export function projectWorkspace(record: WorkspaceRecord): PublicWorkspaceRecord {
  return {
    workspaceId: record.workspaceId,
    deviceId: record.deviceId,
    label: sanitizeFabricProjectionText(record.label),
    mode: record.mode,
    generation: record.generation,
    policyDigest: record.policyDigest,
    endpointIds: [...record.endpointIds],
    revision: record.revision,
  };
}

export function projectEndpoint(record: EndpointRecord): EndpointRecord {
  const base = {
    endpointId: record.endpointId,
    deviceId: record.deviceId,
    connectorId: record.connectorId,
    scope: record.scope.kind === "device"
      ? { kind: "device" as const }
      : { kind: "workspace" as const, workspaceId: record.scope.workspaceId },
    generation: record.generation,
    contractHash: record.contractHash,
    status: record.status,
    revision: record.revision,
  };
  if (record.kind === "agent") {
    return {
      ...base,
      kind: "agent",
      roles: [...record.roles],
      taskTypes: [...record.taskTypes],
      models: [...record.models],
      maxConcurrency: record.maxConcurrency,
    };
  }
  return {
    ...base,
    kind: "mcp",
    serverName: sanitizeFabricProjectionText(record.serverName),
    protocolVersion: sanitizeFabricProjectionText(record.protocolVersion),
    transport: record.transport,
    durableDeduplication: record.durableDeduplication,
  };
}

export interface FabricPublicSnapshot {
  connectors: readonly PublicConnectorRecord[];
  devices: readonly DeviceRecord[];
  connections: readonly PublicConnectionLease[];
  workspaces: readonly PublicWorkspaceRecord[];
  endpoints: readonly EndpointRecord[];
}

export function projectFabricSnapshot(input: {
  connectors: readonly ConnectorRecord[];
  devices: readonly DeviceRecord[];
  connections: readonly ConnectionLease[];
  workspaces: readonly WorkspaceRecord[];
  endpoints: readonly EndpointRecord[];
}): FabricPublicSnapshot {
  return {
    connectors: input.connectors.map(projectConnector),
    devices: input.devices.map(projectDevice),
    connections: input.connections.map(projectConnection),
    workspaces: input.workspaces.map(projectWorkspace),
    endpoints: input.endpoints.map(projectEndpoint),
  };
}

export function projectFabricMount(record: FabricMountLeaseV1): PublicFabricMountLeaseV1 {
  return {
    version: record.version,
    mountId: record.mountId,
    sessionId: record.sessionId,
    routeId: record.routeId,
    routeRevision: record.routeRevision,
    connectionId: record.connectionId,
    workspaceBindingId: record.workspaceBindingId,
    endpointId: record.endpointId,
    connectionGeneration: record.connectionGeneration,
    workspaceGeneration: record.workspaceGeneration,
    endpointGeneration: record.endpointGeneration,
    providerNamespace: record.providerNamespace,
    serverName: sanitizeFabricProjectionText(record.serverName),
    transport: record.transport,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    state: record.state,
    revision: record.revision,
  };
}

export function projectQualifiedTaskSnapshot(record: QualifiedTaskSnapshotV1): QualifiedTaskSnapshotV1 {
  return {
    reference: { ...record.reference },
    subject: sanitizeFabricProjectionText(record.subject),
    status: record.status,
    summary: record.summary === undefined ? undefined : sanitizeFabricProjectionText(record.summary),
    revision: record.revision,
    capturedAt: record.capturedAt,
    truncated: record.truncated,
  };
}

export function projectFabricArtifact(record: FabricArtifactDescriptorV1): PublicFabricArtifactDescriptorV1 {
  let metadata: Readonly<Record<string, JsonValue>> | undefined;
  if (record.metadata !== undefined) {
    const clone: Record<string, JsonValue> = {};
    for (const [key, value] of Object.entries(record.metadata)) clone[key] = cloneJsonValue(value);
    metadata = clone;
  }
  return {
    version: record.version,
    artifactId: record.artifactId,
    operationId: record.operationId,
    routeId: record.routeId,
    deviceId: record.deviceId,
    endpointId: record.endpointId,
    connectionGeneration: record.connectionGeneration,
    endpointGeneration: record.endpointGeneration,
    mediaType: sanitizeFabricProjectionText(record.mediaType),
    byteLength: record.byteLength,
    digest: record.digest,
    storage: record.storage,
    state: record.state,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    metadata,
  };
}

export function projectFabricRouteTicket(ticket: FabricRouteTicketV1): PublicFabricRouteTicketV1 {
  const claims = ticket.claims;
  return {
    version: claims.version,
    ticketId: claims.ticketId,
    keyId: claims.keyId,
    subject: claims.subject,
    audience: claims.audience,
    routeId: claims.routeId,
    deviceId: claims.deviceId,
    endpointId: claims.endpointId,
    workspaceBindingId: claims.workspaceBindingId,
    connectionGeneration: claims.connectionGeneration,
    workspaceGeneration: claims.workspaceGeneration,
    endpointGeneration: claims.endpointGeneration,
    operationClasses: [...claims.operationClasses],
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
    nonce: claims.nonce,
  };
}
