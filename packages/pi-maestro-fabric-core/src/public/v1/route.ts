import type {
  ConnectionId,
  EndpointId,
  RouteId,
  WorkspaceBindingId,
} from "./common.ts";

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
