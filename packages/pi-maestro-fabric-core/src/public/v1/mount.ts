import type { ConnectionId, EndpointId, RouteId, WorkspaceBindingId } from "./common.ts";
import type { FabricMcpTransport } from "./endpoint.ts";

export const FABRIC_MOUNT_VERSION = "fabric.mount.v1" as const;
export const FABRIC_MOUNT_STATES = ["active", "revoking", "closed"] as const;
export type FabricMountState = (typeof FABRIC_MOUNT_STATES)[number];

export interface FabricMountLeaseV1 {
  version: typeof FABRIC_MOUNT_VERSION;
  mountId: string;
  sessionId: string;
  routeId: RouteId;
  routeRevision: number;
  connectionId: ConnectionId;
  workspaceBindingId?: WorkspaceBindingId;
  endpointId: EndpointId;
  connectionGeneration: number;
  workspaceGeneration?: number;
  endpointGeneration: number;
  providerNamespace: string;
  serverName: string;
  transport: FabricMcpTransport;
  issuedAt: number;
  expiresAt: number;
  state: FabricMountState;
  revision: number;
  credentialRef?: string;
}

/** Safe descriptor handed to discovery/UI; credential references never cross this projection. */
export type PublicFabricMountLeaseV1 = Omit<FabricMountLeaseV1, "credentialRef">;
