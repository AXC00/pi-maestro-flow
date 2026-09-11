import type {
  ConnectionId,
  DeviceId,
  WorkspaceBindingId,
  WorkspaceId,
} from "./common.ts";
import type { EndpointId } from "./common.ts";

export const FABRIC_WORKSPACE_MODES = ["lease", "permanent"] as const;
export type FabricWorkspaceMode = (typeof FABRIC_WORKSPACE_MODES)[number];

export interface WorkspaceRecord {
  workspaceId: WorkspaceId;
  deviceId: DeviceId;
  localWorkspaceId: string;
  label: string;
  mode: FabricWorkspaceMode;
  generation: number;
  policyDigest: string;
  endpointIds: readonly EndpointId[];
  revision: number;
}

export interface WorkspaceBinding {
  bindingId: WorkspaceBindingId;
  connectionId: ConnectionId;
  deviceId: DeviceId;
  workspaceId: WorkspaceId;
  connectionGeneration: number;
  workspaceGeneration: number;
  policyDigest: string;
  issuedAt: number;
  expiresAt: number;
  revision: number;
}
