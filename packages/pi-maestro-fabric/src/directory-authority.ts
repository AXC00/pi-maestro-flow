import type { FabricProtocolLimits } from "pi-maestro-fabric-core/v1";

export const FABRIC_DIRECTORY_ADVERTISEMENT_AUTHORITY: unique symbol = Symbol("fabric-directory-advertisement-authority");
export const FABRIC_DIRECTORY_STAGE_ADVERTISEMENT: unique symbol = Symbol("fabric-directory-stage-advertisement");
export const FABRIC_DIRECTORY_RECORD_PERSISTED_ADVERTISEMENT: unique symbol = Symbol("fabric-directory-record-persisted-advertisement");
export const FABRIC_DIRECTORY_PUBLISH_ADVERTISEMENT: unique symbol = Symbol("fabric-directory-publish-advertisement");
export const FABRIC_DIRECTORY_WITHDRAW_ADVERTISEMENT: unique symbol = Symbol("fabric-directory-withdraw-advertisement");
export const FABRIC_DIRECTORY_REGISTRY_AUTHORITY: unique symbol = Symbol("fabric-directory-registry-authority");
export const FABRIC_DIRECTORY_REGISTER_PRESENCE: unique symbol = Symbol("fabric-directory-register-presence");

export interface DirectoryAdvertisementAuthorityContext {
  connectionId: string;
  connectionGeneration: number;
  connectorId: string;
  credentialGeneration: number;
  capabilityDigest: string;
  limits: FabricProtocolLimits;
  preparedAt: number;
}
