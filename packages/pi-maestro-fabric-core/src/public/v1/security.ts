import type { DeviceId, EndpointId, RouteId, WorkspaceBindingId } from "./common.ts";
import type { FabricOperationClass } from "./control.ts";

export const FABRIC_ROUTE_TICKET_VERSION = "fabric.route-ticket.v1" as const;

export interface FabricRouteTicketClaimsV1 {
  version: typeof FABRIC_ROUTE_TICKET_VERSION;
  ticketId: string;
  keyId: string;
  subject: string;
  audience: string;
  routeId: RouteId;
  deviceId: DeviceId;
  endpointId: EndpointId;
  workspaceBindingId?: WorkspaceBindingId;
  connectionGeneration: number;
  workspaceGeneration?: number;
  endpointGeneration: number;
  operationClasses: readonly FabricOperationClass[];
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}

/** Opaque proof format is selected by the security adapter, not Fabric Core. */
export interface FabricRouteTicketV1 {
  claims: FabricRouteTicketClaimsV1;
  proof: string;
}

export type PublicFabricRouteTicketV1 = FabricRouteTicketClaimsV1;
