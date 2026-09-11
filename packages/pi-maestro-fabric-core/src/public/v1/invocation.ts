import type { JsonValue, OperationId } from "./common.ts";
import type { EndpointRouteHandle } from "./route.ts";

export const FABRIC_REPLAY_CLASSES = ["readonly", "durable-dedup", "non-replayable"] as const;
export type FabricReplayClass = (typeof FABRIC_REPLAY_CLASSES)[number];

export interface AgentPlacementRequest {
  kind: "agent-placement";
  attemptId: string;
  route: EndpointRouteHandle;
  deadlineAt: number;
}

export interface McpInvocationRequest {
  kind: "mcp-call";
  operationId: OperationId;
  route: EndpointRouteHandle;
  toolName: string;
  arguments: Readonly<Record<string, JsonValue>>;
  deadlineAt: number;
  replayClass: FabricReplayClass;
}

export type FabricExecutionRequest = AgentPlacementRequest | McpInvocationRequest;

export const FABRIC_INVOCATION_STATES = [
  "accepted",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "outcome-unknown",
] as const;
export type FabricInvocationState = (typeof FABRIC_INVOCATION_STATES)[number];

export interface InvocationReceipt {
  operationId: OperationId;
  routeId: string;
  endpointId: string;
  connectionGeneration: number;
  endpointGeneration: number;
  state: FabricInvocationState;
  replayClass: FabricReplayClass;
  endpointReceiptRef?: string;
  resultRef?: string;
  revision: number;
  updatedAt: number;
}
