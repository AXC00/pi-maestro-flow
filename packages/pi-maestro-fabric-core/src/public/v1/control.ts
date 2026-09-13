import type { ConnectionId, ConnectorId, DeviceId, EndpointId, JsonValue, RouteId, WorkspaceBindingId, WorkspaceId } from "./common.ts";
import type { FabricEndpointStatus } from "./endpoint.ts";
import type { FabricRoutePath } from "./route.ts";

export const FABRIC_CONTROL_VERSION = "fabric.control.v1" as const;

export const FABRIC_CONTROL_ACTIONS = [
  "device.list",
  "device.get",
  "device.pair",
  "device.connect",
  "device.disconnect",
  "device.status",
  "device.workspaces",
  "workspace.list",
  "workspace.bind",
  "workspace.renew",
  "workspace.unbind",
  "endpoint.list",
  "endpoint.describe",
  "endpoint.select",
  "route.open",
  "route.renew",
  "route.close",
] as const;

export type FabricControlAction = (typeof FABRIC_CONTROL_ACTIONS)[number];

export const FABRIC_OPERATION_CLASSES = ["agent-placement", "mcp-read", "mcp-mutation", "artifact-read"] as const;
export type FabricOperationClass = (typeof FABRIC_OPERATION_CLASSES)[number];

export interface FabricControlRequestV1 {
  version: typeof FABRIC_CONTROL_VERSION;
  requestId: string;
  action: FabricControlAction;
  deadlineAt: number;
  deviceId?: DeviceId;
  connectorId?: ConnectorId;
  connectionId?: ConnectionId;
  workspaceId?: WorkspaceId;
  /** Host-local Gateway workspace selected when creating a durable binding. */
  localWorkspaceId?: WorkspaceId;
  workspaceBindingId?: WorkspaceBindingId;
  endpointId?: EndpointId;
  routeId?: RouteId;
  pairingRef?: string;
  expectedRevision?: number;
  expectedCredentialGeneration?: number;
  expectedConnectionGeneration?: number;
  expectedWorkspaceGeneration?: number;
  /** Generation fence for localWorkspaceId. */
  expectedLocalWorkspaceGeneration?: number;
  expectedEndpointGeneration?: number;
  requestedTtlMs?: number;
  endpointKind?: "agent" | "mcp";
  endpointStatus?: FabricEndpointStatus;
  operationClass?: FabricOperationClass;
  pathCandidates?: readonly FabricRoutePath[];
}

export interface FabricControlResponseV1 {
  version: typeof FABRIC_CONTROL_VERSION;
  requestId: string;
  action: FabricControlAction;
  acceptedAt: number;
  result: Readonly<Record<string, JsonValue>>;
}
