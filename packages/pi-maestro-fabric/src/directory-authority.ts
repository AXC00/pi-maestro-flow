import type { FabricProtocolLimits } from "pi-maestro-fabric-core/v1";

export const FABRIC_DIRECTORY_ADVERTISEMENT_AUTHORITY: unique symbol = Symbol("fabric-directory-advertisement-authority");
export const FABRIC_DIRECTORY_REGISTRY_AUTHORITY: unique symbol = Symbol("fabric-directory-registry-authority");

export interface DirectoryAdvertisementAuthorityContext {
  connectionId: string;
  connectionGeneration: number;
  connectorId: string;
  capabilityDigest: string;
  limits: FabricProtocolLimits;
}
