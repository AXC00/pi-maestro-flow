import type { ConnectionLease } from "./connection.ts";
import type { ConnectorRecord, DeviceRecord } from "./device.ts";
import type { EndpointRecord } from "./endpoint.ts";
import type { WorkspaceRecord } from "./workspace.ts";

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
    label: record.label,
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
    label: record.label,
    connectorId: record.connectorId,
    connectionMode: record.connectionMode,
    platform: record.platform,
    architecture: record.architecture,
    enabled: record.enabled,
    revision: record.revision,
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
    label: record.label,
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
    serverName: record.serverName,
    protocolVersion: record.protocolVersion,
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
