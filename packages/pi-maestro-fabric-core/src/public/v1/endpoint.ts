import type { ConnectorId, DeviceId, EndpointId, WorkspaceId } from "./common.ts";

export const FABRIC_ENDPOINT_STATUSES = ["unknown", "online", "offline", "disabled"] as const;
export type FabricEndpointStatus = (typeof FABRIC_ENDPOINT_STATUSES)[number];

export type EndpointScope = { kind: "device" } | { kind: "workspace"; workspaceId: WorkspaceId };

export interface EndpointBase {
  endpointId: EndpointId;
  deviceId: DeviceId;
  connectorId: ConnectorId;
  scope: EndpointScope;
  generation: number;
  contractHash: string;
  status: FabricEndpointStatus;
  revision: number;
}

export interface AgentRuntimeEndpoint extends EndpointBase {
  kind: "agent";
  roles: readonly string[];
  taskTypes: readonly string[];
  models: readonly string[];
  maxConcurrency: number;
}

export const FABRIC_MCP_TRANSPORTS = ["stdio", "http", "streamable-http", "edge-relay"] as const;
export type FabricMcpTransport = (typeof FABRIC_MCP_TRANSPORTS)[number];

export interface McpServiceEndpoint extends EndpointBase {
  kind: "mcp";
  serverName: string;
  protocolVersion: string;
  transport: FabricMcpTransport;
  durableDeduplication: boolean;
}

export type EndpointRecord = AgentRuntimeEndpoint | McpServiceEndpoint;
