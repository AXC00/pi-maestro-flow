import {
  FabricAdmissionManager,
  FabricConnectionManager,
  FabricDirectory,
  FabricPresenceManager,
  FabricStoreCoordinator,
  TransportRegistry,
} from "pi-maestro-fabric";
import type { FabricProtocolLimits } from "pi-maestro-fabric-core/v1";
import type { GatewayFabricControlRuntime } from "./control-support.ts";
import type { GatewayFabricStore } from "./store.ts";
import { GatewayFabricRegistrationAuthority } from "./registration.ts";
import { GatewayFabricAdvertisementStore } from "./advertisement-store.ts";

/** The default Gateway-owned Fabric kernel. Every manager shares these authorities. */
export interface GatewayFabricComposition extends GatewayFabricControlRuntime {
  readonly coordinator: FabricStoreCoordinator;
  readonly registration: GatewayFabricRegistrationAuthority;
  readonly advertisements: GatewayFabricAdvertisementStore;
  readonly transports: TransportRegistry;
  readonly directory: FabricDirectory;
  readonly connections: FabricConnectionManager;
  readonly admissions: FabricAdmissionManager;
  readonly presence: FabricPresenceManager;
  readonly assertAuthorityGraph: (runtime: GatewayFabricControlRuntime, expected: {
    readonly store: unknown;
    readonly audience: string;
  }) => void;
}

export function createGatewayFabricComposition(
  store: GatewayFabricStore,
  options: { readonly limits?: FabricProtocolLimits; readonly now?: () => number; readonly audience?: string } = {},
): GatewayFabricComposition {
  const coordinator = new FabricStoreCoordinator(store);
  const registration = new GatewayFabricRegistrationAuthority(coordinator, {
    audience: options.audience ?? "fabric",
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const advertisements = new GatewayFabricAdvertisementStore(coordinator);
  const transports = new TransportRegistry();
  const directory = new FabricDirectory();
  const connections = new FabricConnectionManager(directory, transports, {
    coordinator,
    advertisementAdmission: { kind: "durable", persist: (candidate) => advertisements.persist(candidate) },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const admissions = new FabricAdmissionManager(directory, connections, {
    coordinator,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const presence = new FabricPresenceManager(directory, connections, coordinator, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const composition: GatewayFabricComposition = {
    coordinator,
    registration,
    advertisements,
    transports,
    directory,
    connections,
    admissions,
    presence,
    resolveLocalWorkspaceAuthorization: (fabricWorkspaceId) => admissions.resolveLocalWorkspaceAuthorization(fabricWorkspaceId),
    resolveLocalWorkspaceBindingAuthorization: (bindingId) => admissions.resolveLocalWorkspaceBindingAuthorization(bindingId),
    assertAuthorityGraph(runtime, expected): void {
      const expectedAudience = options.audience ?? "fabric";
      if (
        runtime !== composition || expected.store !== store || expected.audience !== expectedAudience ||
        composition.coordinator !== coordinator || composition.registration !== registration || composition.advertisements !== advertisements ||
        composition.transports !== transports || runtime.directory !== directory || runtime.connections !== connections ||
        runtime.admissions !== admissions || runtime.presence !== presence ||
        runtime.resolveLocalWorkspaceAuthorization !== composition.resolveLocalWorkspaceAuthorization ||
        runtime.resolveLocalWorkspaceBindingAuthorization !== composition.resolveLocalWorkspaceBindingAuthorization || coordinator.store !== store ||
        registration.coordinator !== coordinator || registration.audience !== expectedAudience ||
        advertisements.coordinator !== coordinator || connections.directory !== directory ||
        admissions.directory !== directory || admissions.connections !== connections ||
        presence.directory !== directory || presence.connections !== connections || presence.coordinator !== coordinator
      ) {
        throw new Error("Gateway Fabric composition does not form one exact authority graph");
      }
    },
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  return composition;
}
