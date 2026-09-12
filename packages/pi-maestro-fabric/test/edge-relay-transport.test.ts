import assert from "node:assert/strict";
import test from "node:test";
import {
  FABRIC_PROTOCOL_VERSION,
  FabricContractError,
  type EndpointRouteHandle,
  type FabricCancellationSignal,
  type FabricConnectRequest,
  type FabricEnvelopeV1,
  type FabricLiveConnection,
  type FabricTransportProvider,
} from "pi-maestro-fabric-core/v1";
import { FabricEdgeRelayTransport, fabricEdgeRelayEnvelope } from "../src/edge-relay-transport.ts";
import type { FabricRouteValidator } from "../src/stream-channel.ts";
import { TransportRegistry } from "../src/transport-registry.ts";

const NOW = 1_000_000;

const route: EndpointRouteHandle = {
  routeId: "route-relay",
  connectionId: "connection-a",
  endpointId: "endpoint-a",
  connectionGeneration: 2,
  endpointGeneration: 3,
  issuedAt: NOW,
  expiresAt: NOW + 60_000,
  state: "open",
  revision: 1,
  deviceId: "device-a",
  operationClass: "mcp-read",
  pathCandidates: ["hub", "edge-relay"],
  selectedPath: "edge-relay",
};

const live = { aborted: false } as const;

function expectCode(error: unknown, code: FabricContractError["code"]): boolean {
  return error instanceof FabricContractError && error.code === code;
}

function request(overrides: Partial<FabricConnectRequest> = {}): FabricConnectRequest {
  return {
    requestId: "request-1",
    deviceId: "device-a",
    connectorId: "connector-1",
    expectedCredentialGeneration: 1,
    deadlineAt: NOW + 60_000,
    limits: {
      maxFrameBytes: 64 * 1024,
      maxInFlightOperations: 8,
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 5_000,
      maxAdvertisementItems: 32,
      maxResultBytes: 64 * 1024,
    },
    ...overrides,
  };
}

function envelope(kind: FabricEnvelopeV1["kind"], payload: Record<string, string | number> = {}): FabricEnvelopeV1 {
  return { version: FABRIC_PROTOCOL_VERSION, messageId: `m-${kind}`, kind, sentAt: NOW, payload };
}

/** The current route authority, mutable so a test can move the route mid-exchange. */
function validator(state: { route: EndpointRouteHandle }): FabricRouteValidator {
  return {
    validateRoute(routeId: string): EndpointRouteHandle {
      if (routeId !== state.route.routeId) {
        throw new FabricContractError("not_found", "Route is not known", "routeId");
      }
      return { ...state.route };
    },
  };
}

class FakeOutbound implements FabricTransportProvider {
  readonly kind = "outbound-wss";
  exchanges = 0;
  readonly closed: string[] = [];
  response: FabricEnvelopeV1 = envelope("control_response");
  onExchange?: () => void;

  async connect(request: FabricConnectRequest): Promise<FabricLiveConnection> {
    return {
      descriptor: {
        protocolVersion: FABRIC_PROTOCOL_VERSION,
        limits: request.limits,
        lease: {
          connectionId: "connection-a",
          deviceId: request.deviceId,
          connectorId: request.connectorId,
          connectorInstanceNonce: "nonce-a",
          generation: 2,
          state: "connected",
          capabilityDigest: "digest-a",
          establishedAt: NOW,
          expiresAt: NOW + 60_000,
          revision: 0,
        },
      },
      exchange: async (): Promise<FabricEnvelopeV1> => {
        this.exchanges += 1;
        this.onExchange?.();
        return this.response;
      },
      close: async (reason: string): Promise<void> => { this.closed.push(reason); },
    };
  }
}

function relay(options: { state?: { route: EndpointRouteHandle }; outbound?: FakeOutbound } = {}): {
  transport: FabricEdgeRelayTransport;
  state: { route: EndpointRouteHandle };
  outbound: FakeOutbound;
} {
  const state = options.state ?? { route };
  const outbound = options.outbound ?? new FakeOutbound();
  return {
    transport: new FabricEdgeRelayTransport({ route, routes: validator(state), outbound, now: () => NOW }),
    state,
    outbound,
  };
}

test("the edge-relay transport registers under its own kind and refuses a duplicate", () => {
  const built = relay();
  assert.equal(built.transport.kind, "edge-relay");

  const registry = new TransportRegistry();
  registry.register(built.transport);
  assert.deepEqual(registry.list(), ["edge-relay"]);
  assert.equal(registry.find("edge-relay"), built.transport);
  assert.throws(() => registry.register(built.transport), (error) => expectCode(error, "conflict"));
});

test("the relay only serves a route that selected edge-relay and named a Device", () => {
  const outbound = new FakeOutbound();
  assert.throws(
    () => new FabricEdgeRelayTransport({ route: { ...route, selectedPath: "hub" }, routes: validator({ route }), outbound }),
    (error) => expectCode(error, "permission_denied"),
  );
  assert.throws(
    () => new FabricEdgeRelayTransport({ route: { ...route, deviceId: undefined }, routes: validator({ route }), outbound }),
    (error) => expectCode(error, "permission_denied"),
  );
});

test("connect is fenced by the current route and by the request's Device", async () => {
  const built = relay();
  const connection = await built.transport.connect(request(), live);
  assert.equal(connection.descriptor.lease.generation, 2);
  assert.equal(connection.descriptor.lease.connectorId, "connector-1");

  built.state.route = { ...route, endpointGeneration: 4 };
  await assert.rejects(built.transport.connect(request(), live), (error) => expectCode(error, "stale_generation"));

  built.state.route = { ...route, selectedPath: "hub" };
  await assert.rejects(built.transport.connect(request(), live), (error) => expectCode(error, "stale_generation"));

  built.state.route = { ...route };
  await assert.rejects(
    built.transport.connect(request({ deviceId: "device-b" }), live),
    (error) => expectCode(error, "conflict"),
  );
});

test("every route-bound frame must name this relay's route, Device, Endpoint, and generation", async () => {
  const built = relay();
  const connection = await built.transport.connect(request(), live);

  await assert.rejects(
    connection.exchange(envelope("invoke", { routeId: "route-other" }), live),
    (error) => expectCode(error, "conflict"),
  );
  await assert.rejects(
    connection.exchange(envelope("invoke", {}), live),
    (error) => expectCode(error, "invalid_argument"),
  );
  await assert.rejects(
    connection.exchange(envelope("invoke", { routeId: "route-relay", deviceId: "device-b" }), live),
    (error) => expectCode(error, "conflict"),
  );
  await assert.rejects(
    connection.exchange(envelope("invoke", { routeId: "route-relay", endpointId: "endpoint-b" }), live),
    (error) => expectCode(error, "conflict"),
  );
  await assert.rejects(
    connection.exchange(envelope("stream", { routeId: "route-relay", endpointGeneration: 4 }), live),
    (error) => expectCode(error, "stale_generation"),
  );
  assert.equal(built.outbound.exchanges, 0, "a refused frame reached the transport");

  // A kind that carries no route identity is passed through unchanged.
  const response = await connection.exchange(envelope("control_request", { requestId: "request-1" }), live);
  assert.equal(response.kind, "control_response");
  assert.equal(built.outbound.exchanges, 1);

  // And the route-bound frame for this route is accepted.
  await connection.exchange(envelope("invoke", { routeId: "route-relay", operationId: "operation-a" }), live);
  assert.equal(built.outbound.exchanges, 2);
});

test("an answer is not published when the route moved during the exchange", async () => {
  const built = relay();
  const connection = await built.transport.connect(request(), live);
  built.outbound.onExchange = () => { built.state.route = { ...route, selectedPath: "hub" }; };

  await assert.rejects(
    connection.exchange(envelope("invoke", { routeId: "route-relay" }), live),
    (error) => expectCode(error, "stale_generation"),
  );
  assert.equal(built.outbound.exchanges, 1, "the exchange did not reach the transport");
});

test("close is idempotent and fences every later exchange", async () => {
  const built = relay();
  const connection = await built.transport.connect(request(), live);
  await connection.exchange(envelope("invoke", { routeId: "route-relay" }), live);

  await connection.close("test complete");
  assert.deepEqual(built.outbound.closed, ["test complete"]);
  await connection.close("again");
  assert.deepEqual(built.outbound.closed, ["test complete"]);

  await assert.rejects(
    connection.exchange(envelope("invoke", { routeId: "route-relay" }), live),
    (error) => expectCode(error, "invalid_state"),
  );
  assert.equal(built.outbound.exchanges, 1);
});

test("the envelope helper builds a frame that already names its route", () => {
  const built = fabricEdgeRelayEnvelope("invoke", "route-relay", { operationId: "operation-a" }, () => NOW);
  assert.equal(built.version, FABRIC_PROTOCOL_VERSION);
  assert.equal(built.payload.routeId, "route-relay");
  assert.equal(built.payload.operationId, "operation-a");
  assert.equal(built.sentAt, NOW);
});
