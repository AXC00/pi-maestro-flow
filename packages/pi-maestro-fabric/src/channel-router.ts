import {
  FABRIC_ERROR_MESSAGE_MAX_BYTES,
  FabricContractError,
  assertBoundedString,
  assertFabricIdentifier,
  type FabricStreamChannel,
} from "pi-maestro-fabric-core/v1";
import type { FabricRouteValidator } from "./stream-channel.ts";

/** Registry for channels keyed by their exact route and operation correlation. */
export class FabricChannelRouter {
  readonly #routes = new Map<string, Map<string, FabricStreamChannel>>();
  readonly #closedRoutes = new Set<string>();

  constructor(readonly admissions: FabricRouteValidator) {}

  bind(routeId: string, operationId: string, channel: FabricStreamChannel): void {
    assertFabricIdentifier(routeId, "routeId");
    assertFabricIdentifier(operationId, "operationId");
    if (channel.routeId !== routeId || channel.operationId !== operationId) {
      throw new FabricContractError("conflict", "Channel identity does not match the router correlation key", "channel");
    }
    assertFabricIdentifier(channel.streamId, "channel.streamId");
    if (this.#closedRoutes.has(routeId)) {
      throw new FabricContractError("invalid_state", "Route channel registry is closed", "routeId");
    }
    this.admissions.validateRoute(routeId);
    let operations = this.#routes.get(routeId);
    if (operations === undefined) {
      operations = new Map();
      this.#routes.set(routeId, operations);
    }
    if (operations.has(operationId)) {
      throw new FabricContractError("conflict", "Route and operation already have a bound channel", "operationId");
    }
    operations.set(operationId, channel);
  }

  get(routeId: string, operationId: string): FabricStreamChannel | undefined {
    assertFabricIdentifier(routeId, "routeId");
    assertFabricIdentifier(operationId, "operationId");
    const channel = this.#routes.get(routeId)?.get(operationId);
    if (channel !== undefined) this.admissions.validateRoute(routeId);
    return channel;
  }

  unbind(routeId: string, operationId: string): FabricStreamChannel | undefined {
    assertFabricIdentifier(routeId, "routeId");
    assertFabricIdentifier(operationId, "operationId");
    const operations = this.#routes.get(routeId);
    const channel = operations?.get(operationId);
    if (channel === undefined) return undefined;
    operations!.delete(operationId);
    if (operations!.size === 0) this.#routes.delete(routeId);
    return channel;
  }

  async closeRoute(routeId: string, reason: string): Promise<void> {
    assertFabricIdentifier(routeId, "routeId");
    assertBoundedString(reason, "reason", FABRIC_ERROR_MESSAGE_MAX_BYTES);
    this.#closedRoutes.add(routeId);
    const channels = [...(this.#routes.get(routeId)?.values() ?? [])];
    this.#routes.delete(routeId);
    const results = await Promise.allSettled(channels.map((channel) => channel.close(reason)));
    if (results.some((result) => result.status === "rejected")) {
      throw new FabricContractError("unavailable", "One or more route channels failed to close", "routeId");
    }
  }
}
