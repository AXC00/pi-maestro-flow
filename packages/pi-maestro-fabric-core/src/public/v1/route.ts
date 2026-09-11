import type {
  ConnectionId,
  DeviceId,
  EndpointId,
  RouteId,
  WorkspaceBindingId,
} from "./common.ts";
import type { FabricOperationClass } from "./control.ts";

export const FABRIC_ROUTE_PATHS = ["hub", "lan-direct", "edge-relay", "vps-relay"] as const;
export type FabricRoutePath = (typeof FABRIC_ROUTE_PATHS)[number];

export const FABRIC_ROUTE_STATES = ["open", "draining", "closed"] as const;
export type FabricRouteState = (typeof FABRIC_ROUTE_STATES)[number];

export interface EndpointRouteHandle {
  routeId: RouteId;
  connectionId: ConnectionId;
  workspaceBindingId?: WorkspaceBindingId;
  endpointId: EndpointId;
  connectionGeneration: number;
  workspaceGeneration?: number;
  endpointGeneration: number;
  issuedAt: number;
  expiresAt: number;
  state: FabricRouteState;
  revision: number;
  /** Additive v1 admission metadata; absent on Phase 0-2 handles. */
  deviceId?: DeviceId;
  operationClass?: FabricOperationClass;
  pathCandidates?: readonly FabricRoutePath[];
  selectedPath?: FabricRoutePath;
}

export interface RouteValidationContext {
  connectionId: ConnectionId;
  connectionGeneration: number;
  endpointId: EndpointId;
  endpointGeneration: number;
  workspaceBindingId?: WorkspaceBindingId;
  workspaceGeneration?: number;
  now: number;
}
