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

/** The default Gateway-owned Fabric kernel. Every manager shares these authorities. */
export interface GatewayFabricComposition extends GatewayFabricControlRuntime {
  readonly coordinator: FabricStoreCoordinator;
  readonly transports: TransportRegistry;
  readonly directory: FabricDirectory;
  readonly connections: FabricConnectionManager;
  readonly admissions: FabricAdmissionManager;
  readonly presence: FabricPresenceManager;
}

export function createGatewayFabricComposition(
  store: GatewayFabricStore,
  options: { readonly limits?: FabricProtocolLimits; readonly now?: () => number } = {},
): GatewayFabricComposition {
  const coordinator = new FabricStoreCoordinator(store);
  const transports = new TransportRegistry();
  const directory = new FabricDirectory();
  const connections = new FabricConnectionManager(directory, transports, {
    coordinator,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const admissions = new FabricAdmissionManager(directory, connections, {
    coordinator,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const presence = new FabricPresenceManager(directory, connections, coordinator, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return {
    coordinator,
    transports,
    directory,
    connections,
    admissions,
    presence,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
}
