import type { DeviceId, EndpointId, JsonValue, OperationId, RouteId } from "./common.ts";

export const FABRIC_ARTIFACT_VERSION = "fabric.artifact.v1" as const;
export const FABRIC_ARTIFACT_STATES = ["available", "transferring", "complete", "expired", "revoked"] as const;
export type FabricArtifactState = (typeof FABRIC_ARTIFACT_STATES)[number];

export const FABRIC_ARTIFACT_STORAGE = ["source"] as const;
export type FabricArtifactStorage = (typeof FABRIC_ARTIFACT_STORAGE)[number];

export interface FabricArtifactDescriptorV1 {
  version: typeof FABRIC_ARTIFACT_VERSION;
  artifactId: string;
  operationId: OperationId;
  routeId: RouteId;
  deviceId: DeviceId;
  endpointId: EndpointId;
  connectionGeneration: number;
  endpointGeneration: number;
  mediaType: string;
  byteLength: number;
  digest: string;
  storage: FabricArtifactStorage;
  state: FabricArtifactState;
  createdAt: number;
  expiresAt: number;
  metadata?: Readonly<Record<string, JsonValue>>;
  sourceRef?: string;
}

export interface FabricArtifactChunkV1 {
  version: typeof FABRIC_ARTIFACT_VERSION;
  artifactId: string;
  offset: number;
  byteLength: number;
  digest: string;
  encodedData: string;
  final: boolean;
}

/** Redacted metadata projection; source-local references are never public. */
export type PublicFabricArtifactDescriptorV1 = Omit<FabricArtifactDescriptorV1, "sourceRef">;
