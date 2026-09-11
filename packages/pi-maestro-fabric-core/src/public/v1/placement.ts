import type { EndpointId, JsonValue, RouteId, WorkspaceBindingId, WorkspaceId } from "./common.ts";

export const FABRIC_PLACEMENT_VERSION = "fabric.placement.v1" as const;
export const FABRIC_TASK_AUTHORITIES = ["pi-todo", "gateway-todo", "board"] as const;
export type FabricTaskAuthority = (typeof FABRIC_TASK_AUTHORITIES)[number];

export interface QualifiedTaskReferenceV1 {
  authority: FabricTaskAuthority;
  workspaceId: WorkspaceId;
  taskId: string;
}

export const FABRIC_TASK_SNAPSHOT_STATUSES = ["pending", "in_progress", "blocked", "completed", "cancelled"] as const;
export type FabricTaskSnapshotStatus = (typeof FABRIC_TASK_SNAPSHOT_STATUSES)[number];

/** Bounded read-only context. It never transfers task write authority. */
export interface QualifiedTaskSnapshotV1 {
  reference: QualifiedTaskReferenceV1;
  subject: string;
  status: FabricTaskSnapshotStatus;
  summary?: string;
  revision: number;
  capturedAt: number;
  truncated: boolean;
}

export interface TeammatePlacementV1 {
  version: typeof FABRIC_PLACEMENT_VERSION;
  placementId: string;
  routeId: RouteId;
  workspaceBindingId?: WorkspaceBindingId;
  endpointId: EndpointId;
  connectionGeneration: number;
  workspaceGeneration?: number;
  endpointGeneration: number;
  task?: QualifiedTaskReferenceV1;
  requestedModel?: string;
  requestedRole?: string;
  requestedTaskType?: string;
  deadlineAt: number;
}

export const FABRIC_PLACEMENT_EVENT_KINDS = [
  "start-ack",
  "output",
  "turn-complete",
  "recovery-facts",
  "reclamation",
  "completion",
  "error",
] as const;
export type FabricPlacementEventKind = (typeof FABRIC_PLACEMENT_EVENT_KINDS)[number];

export interface FabricPlacementEventV1 {
  version: typeof FABRIC_PLACEMENT_VERSION;
  placementId: string;
  sequence: number;
  kind: FabricPlacementEventKind;
  occurredAt: number;
  payload: Readonly<Record<string, JsonValue>>;
}
