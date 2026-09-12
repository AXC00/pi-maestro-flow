import {
  FABRIC_PROTOCOL_VERSION,
  FabricContractError,
  assertEpochMilliseconds,
  assertFabricIdentifier,
  assertValidFabricEnvelope,
  type EndpointRouteHandle,
  type FabricCancellationSignal,
  type FabricConnectRequest,
  type FabricEnvelopeV1,
  type FabricLiveConnection,
  type FabricMessageKind,
  type FabricTransportProvider,
  type JsonValue,
} from "pi-maestro-fabric-core/v1";
import type { FabricRouteValidator } from "./stream-channel.ts";

/** The one route path this transport serves. */
export const FABRIC_EDGE_RELAY_PATH = "edge-relay" as const;

/** Kinds the protocol requires to name the route they belong to. */
const ROUTE_BOUND_KINDS: ReadonlySet<FabricMessageKind> = new Set([
  "invoke",
  "stream",
  "artifact",
  "cancel",
  "receipt",
]);

export interface FabricEdgeRelayTransportOptions {
  /** The admitted route this relay serves. Its identity is fixed for this transport. */
  readonly route: EndpointRouteHandle;
  /** Current route authority: generations are revalidated on every exchange. */
  readonly routes: FabricRouteValidator;
  /**
   * The established outbound-WSS path this relay rides on.
   *
   * Injected rather than re-implemented: the Edge Connector owns TLS trust, its
   * enrolled key, and its own reconnect policy.
   */
  readonly outbound: FabricTransportProvider;
  readonly now?: () => number;
}

function sameRouteIdentity(left: EndpointRouteHandle, right: EndpointRouteHandle): boolean {
  return left.routeId === right.routeId
    && left.connectionId === right.connectionId
    && left.deviceId === right.deviceId
    && left.endpointId === right.endpointId
    && left.workspaceBindingId === right.workspaceBindingId
    && left.connectionGeneration === right.connectionGeneration
    && left.workspaceGeneration === right.workspaceGeneration
    && left.endpointGeneration === right.endpointGeneration;
}

/**
 * The `edge-relay` path over the existing outbound-WSS transport.
 *
 * Every exchange is bound to one admitted route: a frame for another route,
 * Device, Endpoint, or generation is refused before it leaves, and the route is
 * revalidated again before the answer is published.
 */
export class FabricEdgeRelayTransport implements FabricTransportProvider {
  readonly kind = FABRIC_EDGE_RELAY_PATH;
  readonly #route: EndpointRouteHandle;
  readonly #routes: FabricRouteValidator;
  readonly #outbound: FabricTransportProvider;
  readonly #now: () => number;

  constructor(options: FabricEdgeRelayTransportOptions) {
    if (options.route.selectedPath !== FABRIC_EDGE_RELAY_PATH) {
      throw new FabricContractError(
        "permission_denied",
        "The edge-relay transport only serves a route that selected edge-relay",
        "selectedPath",
      );
    }
    if (options.route.deviceId === undefined) {
      throw new FabricContractError("permission_denied", "An edge-relay route must name a Device", "deviceId");
    }
    this.#route = { ...options.route };
    this.#routes = options.routes;
    this.#outbound = options.outbound;
    this.#now = options.now ?? Date.now;
  }

  async connect(request: FabricConnectRequest, signal: FabricCancellationSignal): Promise<FabricLiveConnection> {
    assertFabricIdentifier(request.deviceId, "deviceId");
    assertEpochMilliseconds(request.deadlineAt, "deadlineAt");
    this.#requireRoute();
    if (request.deviceId !== this.#route.deviceId) {
      throw new FabricContractError("conflict", "Fabric connect request names another Device than this route", "deviceId");
    }
    const live = await this.#outbound.connect(request, signal);
    return new FabricEdgeRelayConnection(live, this.#route, this.#routes, this.#now);
  }

  /** The current route, or a terminal refusal. */
  #requireRoute(): EndpointRouteHandle {
    const current = this.#routes.validateRoute(this.#route.routeId);
    if (current.state !== "open") {
      throw new FabricContractError("invalid_state", "Route must be open", "state");
    }
    if (current.selectedPath !== FABRIC_EDGE_RELAY_PATH) {
      throw new FabricContractError("stale_generation", "Route no longer selects edge-relay", "selectedPath");
    }
    if (!sameRouteIdentity(current, this.#route)) {
      throw new FabricContractError("stale_generation", "Route identity or generation changed", "routeId");
    }
    return current;
  }
}

/** One established relay connection, fenced by its own route until closed. */
class FabricEdgeRelayConnection implements FabricLiveConnection {
  readonly descriptor: FabricLiveConnection["descriptor"];
  readonly #live: FabricLiveConnection;
  readonly #route: EndpointRouteHandle;
  readonly #routes: FabricRouteValidator;
  readonly #now: () => number;
  #closed = false;

  constructor(
    live: FabricLiveConnection,
    route: EndpointRouteHandle,
    routes: FabricRouteValidator,
    now: () => number,
  ) {
    this.#live = live;
    this.#route = route;
    this.#routes = routes;
    this.#now = now;
    this.descriptor = live.descriptor;
  }

  async exchange(envelope: FabricEnvelopeV1, signal: FabricCancellationSignal): Promise<FabricEnvelopeV1> {
    if (this.#closed) throw new FabricContractError("invalid_state", "Fabric relay connection is closed");
    assertValidFabricEnvelope(envelope);
    // Validated before the frame is sent and again before the answer is
    // published: a route that moved mid-exchange cannot commit its result.
    this.#requireRoute();
    this.#assertRouteBound(envelope);
    if (envelope.deadlineAt !== undefined && envelope.deadlineAt <= this.#now()) {
      throw new FabricContractError("deadline_exceeded", "Fabric envelope deadline has passed", "deadlineAt");
    }
    if (signal.aborted) throw new FabricContractError("cancelled", "Fabric relay exchange was cancelled");
    const response = await this.#live.exchange(envelope, signal);
    assertValidFabricEnvelope(response);
    this.#requireRoute();
    this.#assertRouteBound(response);
    if (this.#closed) throw new FabricContractError("invalid_state", "Fabric relay connection was closed during the exchange");
    return response;
  }

  async close(reason: string): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#live.close(reason);
  }

  get closed(): boolean {
    return this.#closed;
  }

  #requireRoute(): void {
    const current = this.#routes.validateRoute(this.#route.routeId);
    if (current.state !== "open") {
      throw new FabricContractError("invalid_state", "Route must be open", "state");
    }
    if (current.selectedPath !== FABRIC_EDGE_RELAY_PATH || !sameRouteIdentity(current, this.#route)) {
      throw new FabricContractError("stale_generation", "Route authority changed during the relay exchange", "routeId");
    }
  }

  #assertRouteBound(envelope: FabricEnvelopeV1): void {
    if (!ROUTE_BOUND_KINDS.has(envelope.kind)) return;
    const routeId = envelope.payload.routeId;
    if (typeof routeId !== "string" || routeId.length === 0) {
      throw new FabricContractError(
        "invalid_argument",
        `A Fabric ${envelope.kind} frame must name the route it belongs to`,
        "routeId",
      );
    }
    if (routeId !== this.#route.routeId) {
      throw new FabricContractError("conflict", "Fabric frame names another route than this relay serves", "routeId");
    }
    const deviceId = envelope.payload.deviceId;
    if (deviceId !== undefined && deviceId !== this.#route.deviceId) {
      throw new FabricContractError("conflict", "Fabric frame names another Device than this route", "deviceId");
    }
    const endpointId = envelope.payload.endpointId;
    if (endpointId !== undefined && endpointId !== this.#route.endpointId) {
      throw new FabricContractError("conflict", "Fabric frame names another Endpoint than this route", "endpointId");
    }
    const endpointGeneration = envelope.payload.endpointGeneration;
    if (endpointGeneration !== undefined && endpointGeneration !== this.#route.endpointGeneration) {
      throw new FabricContractError("stale_generation", "Fabric frame names a superseded Endpoint generation", "endpointGeneration");
    }
  }
}

/** Envelope helper for callers that build their own route-bound frames. */
export function fabricEdgeRelayEnvelope(
  kind: FabricEnvelopeV1["kind"],
  routeId: string,
  payload: Readonly<Record<string, JsonValue>>,
  now: () => number = Date.now,
): FabricEnvelopeV1 {
  return {
    version: FABRIC_PROTOCOL_VERSION,
    messageId: `edge-relay-${now().toString(36)}`,
    kind,
    sentAt: now(),
    payload: { ...payload, routeId },
  };
}
