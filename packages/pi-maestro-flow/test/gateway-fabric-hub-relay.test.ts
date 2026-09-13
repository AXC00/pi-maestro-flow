import assert from "node:assert/strict";
import test from "node:test";
import {
  FABRIC_AGENT_ATTEMPT_VERSION,
  type FabricAgentStartRequestV1,
} from "pi-maestro-backends/fabric";
import {
  FABRIC_HUB_RELAY_VERSION,
  FabricContractError,
  assertValidFabricHubRelayPayload,
  type AgentRuntimeEndpoint,
  type EndpointRouteHandle,
  type FabricEnvelopeV1,
  type FabricHubRelayInvokeV1,
  type FabricHubRelayStreamV1,
  type JsonValue,
} from "pi-maestro-fabric-core/v1";
import { createLocalGatewayPrincipal } from "../src/gateway/principal.ts";
import { FABRIC_ENDPOINT_REQUEST_VERSION, FabricEndpointDispatcher } from "../src/gateway/fabric/endpoint-dispatcher.ts";
import {
  FabricDeviceRelayOwner,
  FabricHubRelay,
  type FabricDeviceRelayExecutionHandler,
  type FabricRelaySessionIdentity,
} from "../src/gateway/fabric/hub-relay.ts";

const endpoint: AgentRuntimeEndpoint = {
  kind: "agent",
  endpointId: "agent-endpoint-1",
  deviceId: "device-1",
  connectorId: "connector-1",
  scope: { kind: "workspace", workspaceId: "workspace-1" },
  generation: 1,
  contractHash: "agent-contract",
  status: "online",
  revision: 1,
  roles: ["general"],
  taskTypes: ["development"],
  models: ["test/model"],
  maxConcurrency: 2,
};

const route: EndpointRouteHandle = {
  routeId: "route-1",
  connectionId: "connection-1",
  workspaceBindingId: "binding-1",
  endpointId: endpoint.endpointId,
  deviceId: endpoint.deviceId,
  connectionGeneration: 1,
  workspaceGeneration: 1,
  endpointGeneration: endpoint.generation,
  issuedAt: Date.now() - 100,
  expiresAt: Date.now() + 60_000,
  state: "open",
  revision: 7,
};

const principal = createLocalGatewayPrincipal("relay-test", { authenticated: true, scopes: ["fabric.data"] });

function jsonValue(value: object): JsonValue {
  return JSON.parse(JSON.stringify(value));
}

function jsonRecord(value: object): Readonly<Record<string, JsonValue>> {
  return JSON.parse(JSON.stringify(value));
}

function session(connectionId = route.connectionId, generation = route.connectionGeneration, instanceNonce = "instance-1"): FabricRelaySessionIdentity {
  return {
    connectorId: endpoint.connectorId,
    deviceId: endpoint.deviceId,
    connectionId,
    connectionGeneration: generation,
    instanceNonce,
    state: "ready",
    current: true,
    relayVersion: FABRIC_HUB_RELAY_VERSION,
  };
}

function setup(handler: FabricDeviceRelayExecutionHandler, limits?: { maxResultBytes?: number; maxActiveOperations?: number }): {
  hub: FabricHubRelay;
  device: FabricDeviceRelayOwner;
  dispatcher: FabricEndpointDispatcher;
  owner: FabricRelaySessionIdentity;
  hubWrites: FabricEnvelopeV1[];
  failNextHubSend(error: Error): void;
} {
  const routes = {
    validateRoute(routeId: string): EndpointRouteHandle {
      if (routeId !== route.routeId) throw new FabricContractError("not_found", "route not found");
      if (route.state !== "open") throw new FabricContractError("invalid_state", "route must be open");
      return { ...route };
    },
  };
  const endpoints = { getEndpoint: (id: string) => id === endpoint.endpointId ? structuredClone(endpoint) : undefined };
  const dispatcher = new FabricEndpointDispatcher({ routes, endpoints });
  const hub = new FabricHubRelay({ dispatcher, hubRuntimeEpoch: "hub-epoch-1", originSubjectOf: () => "origin-subject-1", limits });
  const owner = session();
  let device!: FabricDeviceRelayOwner;
  const hubWrites: FabricEnvelopeV1[] = [];
  let nextHubSendFailure: Error | undefined;
  const hubTransport = {
    send(outgoing: FabricEnvelopeV1): void {
      hubWrites.push(outgoing);
      if (nextHubSendFailure !== undefined) {
        const failure = nextHubSendFailure;
        nextHubSendFailure = undefined;
        throw failure;
      }
      device.accept(outgoing);
    },
    get bufferedAmount(): number { return 0; },
  };
  device = new FabricDeviceRelayOwner({
    identity: owner,
    hubRuntimeEpoch: hub.hubRuntimeEpoch,
    handler,
    limits,
    transport: {
      send(outgoing: FabricEnvelopeV1): void { hub.accept(owner, outgoing); },
      get bufferedAmount(): number { return 0; },
    },
  });
  device.activate();
  hub.accepted(owner, hubTransport);
  hub.ready(owner, { endpoints: [jsonValue(endpoint)] });
  return {
    hub,
    device,
    dispatcher,
    owner,
    hubWrites,
    failNextHubSend: (error) => { nextHubSendFailure = error; },
  };
}

function dispatchInput(
  dispatcher: FabricEndpointDispatcher,
  requestId: string,
  input: Readonly<Record<string, JsonValue>>,
  signal = new AbortController().signal,
  deadlineAt = Date.now() + 10_000,
  operation = "agent.recover",
): Promise<JsonValue> {
  return dispatcher.dispatch({
    version: FABRIC_ENDPOINT_REQUEST_VERSION,
    requestId,
    routeId: route.routeId,
    endpointId: endpoint.endpointId,
    endpointKind: "agent",
    endpointGeneration: endpoint.generation,
    deadlineAt,
    operation,
    input,
  }, principal, signal);
}

function dispatch(dispatcher: FabricEndpointDispatcher, requestId: string, signal = new AbortController().signal): Promise<JsonValue> {
  return dispatchInput(
    dispatcher,
    requestId,
    { version: "fabric.agent-attempt.v1", attemptId: "attempt-1", placementId: "placement-1" },
    signal,
  );
}

function startRequest(attemptId = "attempt-1", placementId = "placement-1"): FabricAgentStartRequestV1 {
  return {
    version: FABRIC_AGENT_ATTEMPT_VERSION,
    attemptId,
    placement: {
      version: "fabric.placement.v1",
      placementId,
      routeId: route.routeId,
      workspaceBindingId: route.workspaceBindingId,
      endpointId: endpoint.endpointId,
      connectionGeneration: route.connectionGeneration,
      workspaceGeneration: route.workspaceGeneration,
      endpointGeneration: endpoint.generation,
      requestedModel: "test/model",
      requestedRole: "general",
      requestedTaskType: "development",
      deadlineAt: Date.now() + 30_000,
    },
    spec: { agent: "general", task: "hold until route cleanup", model: "test/model" },
  };
}

function startAck(request: FabricAgentStartRequestV1): JsonValue {
  return jsonValue({
    version: FABRIC_AGENT_ATTEMPT_VERSION,
    attemptId: request.attemptId,
    placementId: request.placement.placementId,
    routeId: request.placement.routeId,
    endpointId: request.placement.endpointId,
    connectionGeneration: request.placement.connectionGeneration,
    workspaceGeneration: request.placement.workspaceGeneration,
    endpointGeneration: request.placement.endpointGeneration,
    acceptedBackend: "fixture-backend",
    acceptedModel: "test/model",
    acceptedCapabilities: {
      outputSchema: "native", forkContext: "unsupported", modelSelection: "native", thinkingLevel: "native",
      todoBinding: "unsupported", toolFilter: "unsupported", steer: "native", followUp: "native", abort: "native",
    },
    receiptRef: `${request.placement.placementId}:start:1`,
  });
}

test("ready negotiated owners register and execute only existing Agent operations", async () => {
  const seen: string[] = [];
  const { dispatcher, device } = setup({ handle: async (context) => {
    seen.push(`${context.operation}:${context.originSubject}:${context.authority.routeRevision}`);
    assert.equal("principal" in context.input, false);
    return { recovered: true };
  } });
  assert.deepEqual(await dispatch(dispatcher, "operation-ready"), { recovered: true });
  assert.deepEqual(seen, ["agent.recover:origin-subject-1:7"]);
  assert.equal(device.activeOperationCount, 0);
  assert.equal(dispatcher.pendingRequestCount, 0);
});

test("durable Route close uses only the retained open snapshot to await an ordinary Agent abort", async () => {
  const operations: string[] = [];
  const request = startRequest("attempt-route-close", "placement-route-close");
  const { hub, dispatcher } = setup({ handle: async (context) => {
    operations.push(context.operation);
    if (context.operation === "agent.start") return startAck(request);
    assert.equal(context.operation, "agent.abort");
    return jsonValue({
      version: FABRIC_AGENT_ATTEMPT_VERSION,
      attemptId: request.attemptId,
      placementId: request.placement.placementId,
      action: "abort",
      accepted: true,
      state: "accepted",
      receiptRef: `${request.placement.placementId}:abort:2`,
    });
  } });
  await dispatchInput(
    dispatcher,
    "operation-start-route-close",
    request as unknown as Readonly<Record<string, JsonValue>>,
    new AbortController().signal,
    request.placement.deadlineAt,
    "agent.start",
  );
  const previousState = route.state;
  const previousRevision = route.revision;
  try {
    route.state = "closed";
    route.revision += 1;
    await Promise.all([
      hub.closeRoute(route.routeId, "Fabric route closed"),
      hub.closeRoute(route.routeId, "concurrent duplicate close"),
    ]);
    assert.deepEqual(operations, ["agent.start", "agent.abort"]);
    await hub.closeRoute(route.routeId, "later duplicate close");
    assert.deepEqual(operations, ["agent.start", "agent.abort"], "duplicate close retained leaked attempt metadata");
    await assert.rejects(dispatch(dispatcher, "ordinary-call-after-close"), /open|closed/i);
  } finally {
    route.state = previousState;
    route.revision = previousRevision;
  }
});

test("failed Route cleanup retains exact attempt authority for one later retry", async () => {
  const operations: string[] = [];
  const request = startRequest("attempt-route-retry", "placement-route-retry");
  const { hub, dispatcher, hubWrites, failNextHubSend } = setup({ handle: async (context) => {
    operations.push(context.operation);
    if (context.operation === "agent.start") return startAck(request);
    assert.equal(context.operation, "agent.abort");
    return jsonValue({
      version: FABRIC_AGENT_ATTEMPT_VERSION,
      attemptId: request.attemptId,
      placementId: request.placement.placementId,
      action: "abort",
      accepted: true,
      state: "accepted",
      receiptRef: `${request.placement.placementId}:abort:retry`,
    });
  } });
  await dispatchInput(
    dispatcher,
    "operation-start-route-retry",
    request as unknown as Readonly<Record<string, JsonValue>>,
    new AbortController().signal,
    request.placement.deadlineAt,
    "agent.start",
  );
  const abortWrites = (): number => hubWrites.filter((write) =>
    write.kind === "invoke" && (write.payload as FabricHubRelayInvokeV1).operation === "agent.abort"
  ).length;
  const previousState = route.state;
  const previousRevision = route.revision;
  try {
    route.state = "closed";
    route.revision += 1;
    failNextHubSend(new Error("deterministic abort transport refusal"));
    const failures = await Promise.allSettled([
      hub.closeRoute(route.routeId, "first cleanup attempt"),
      hub.closeRoute(route.routeId, "concurrent cleanup attempt"),
    ]);
    for (const result of failures) {
      assert.equal(result.status, "rejected", "the first cleanup error must reach every concurrent closer");
      if (result.status === "rejected") assert.match(String(result.reason), /Fabric stream send failed/);
    }
    assert.equal(abortWrites(), 1, "concurrent cleanup duplicated the failed abort send");

    await hub.closeRoute(route.routeId, "retry cleanup after transport restoration");
    assert.equal(abortWrites(), 2, "retry did not issue one new ordinary abort");
    assert.deepEqual(operations, ["agent.start", "agent.abort"]);
    await hub.closeRoute(route.routeId, "post-success duplicate cleanup");
    assert.equal(abortWrites(), 2, "successful abort retained cleanup metadata");
  } finally {
    route.state = previousState;
    route.revision = previousRevision;
  }
});

test("replaced Hub session cannot receive cleanup for a predecessor attempt", async () => {
  const request = startRequest("attempt-replaced", "placement-replaced");
  const { hub, dispatcher, owner } = setup({ handle: async (context) => {
    if (context.operation === "agent.start") return startAck(request);
    throw new Error("predecessor cleanup must not be dispatched");
  } });
  await dispatchInput(
    dispatcher,
    "operation-start-replaced",
    request as unknown as Readonly<Record<string, JsonValue>>,
    new AbortController().signal,
    request.placement.deadlineAt,
    "agent.start",
  );
  const successor = { ...owner, instanceNonce: "instance-successor" };
  const successorWrites: FabricEnvelopeV1[] = [];
  hub.accepted(successor, {
    send: (outgoing) => { successorWrites.push(outgoing); },
    get bufferedAmount(): number { return 0; },
  });
  hub.ready(successor, { endpoints: [endpoint] });
  await hub.closeRoute(route.routeId, "closed after replacement");
  assert.deepEqual(successorWrites, []);
});

test("Endpoint retirement drops retained attempt cleanup metadata", async () => {
  const operations: string[] = [];
  const request = startRequest("attempt-endpoint-retired", "placement-endpoint-retired");
  const { hub, dispatcher, owner } = setup({ handle: async (context) => {
    operations.push(context.operation);
    if (context.operation === "agent.start") return startAck(request);
    throw new Error("retired Endpoint attempt must not receive Route cleanup");
  } });
  await dispatchInput(
    dispatcher,
    "operation-start-endpoint-retired",
    request as unknown as Readonly<Record<string, JsonValue>>,
    new AbortController().signal,
    request.placement.deadlineAt,
    "agent.start",
  );
  hub.advertisement(owner, { removals: { endpointIds: [endpoint.endpointId] } });
  await hub.closeRoute(route.routeId, "close after Endpoint retirement");
  assert.deepEqual(operations, ["agent.start"]);
});

test("successful Agent reclaim removes retained attempt cleanup metadata", async () => {
  const operations: string[] = [];
  const request = startRequest("attempt-reclaimed", "placement-reclaimed");
  const { hub, dispatcher } = setup({ handle: async (context) => {
    operations.push(context.operation);
    if (context.operation === "agent.start") return startAck(request);
    if (context.operation === "agent.reclaim") return jsonValue({
      version: FABRIC_AGENT_ATTEMPT_VERSION,
      attemptId: request.attemptId,
      placementId: request.placement.placementId,
      reclamation: { status: "reclaimed" },
      receiptRef: `${request.placement.placementId}:reclamation:3`,
    });
    throw new Error("reclaimed attempt must not receive route cleanup");
  } });
  await dispatchInput(
    dispatcher,
    "operation-start-reclaim",
    request as unknown as Readonly<Record<string, JsonValue>>,
    new AbortController().signal,
    request.placement.deadlineAt,
    "agent.start",
  );
  await dispatchInput(
    dispatcher,
    "operation-reclaim",
    jsonRecord({ version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: request.attemptId, placementId: request.placement.placementId }),
    new AbortController().signal,
    request.placement.deadlineAt,
    "agent.reclaim",
  );
  await hub.closeRoute(route.routeId, "close after reclaim");
  assert.deepEqual(operations, ["agent.start", "agent.reclaim"]);
});

test("cancel is delivered while a Device handler is blocked and releases operation capacity", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let aborted = false;
  const { dispatcher, device } = setup({ handle: async ({ signal }) => {
    entered();
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
    });
    return { late: true };
  } }, { maxActiveOperations: 1 });
  const controller = new AbortController();
  const operation = dispatch(dispatcher, "operation-cancel", controller.signal);
  await started;
  await assert.rejects(dispatch(dispatcher, "operation-over-capacity"),
    (error) => error instanceof FabricContractError && error.code === "resource_exhausted");
  controller.abort();
  await assert.rejects(operation, (error) => error instanceof FabricContractError && error.code === "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(aborted, true);
  assert.equal(device.activeOperationCount, 0);
});

test("cancellation before invoke delivery does not send a foreign cancel or retire the session", async () => {
  const dispatcher = new FabricEndpointDispatcher({
    routes: { validateRoute: () => ({ ...route }) },
    endpoints: { getEndpoint: () => structuredClone(endpoint) },
  });
  let controller!: AbortController;
  const writes: FabricEnvelopeV1["kind"][] = [];
  const hub = new FabricHubRelay({
    dispatcher,
    hubRuntimeEpoch: "hub-pre-invoke-cancel",
    originSubjectOf: () => {
      controller.abort();
      return "origin-pre-invoke-cancel";
    },
  });
  const owner = session();
  hub.accepted(owner, {
    send: (outgoing) => { writes.push(outgoing.kind); },
    get bufferedAmount(): number { return 0; },
  });
  hub.ready(owner, { endpoints: [endpoint] });
  controller = new AbortController();
  await assert.rejects(dispatch(dispatcher, "operation-pre-invoke-cancel", controller.signal),
    (error) => error instanceof FabricContractError && error.code === "cancelled");
  assert.deepEqual(writes, []);
  assert.equal(hub.activeSessionCount, 1);
});

test("result bounds fail only the operation with resource_exhausted and clean terminals", async () => {
  const { dispatcher, device, hub } = setup({ handle: async () => ({ output: "x".repeat(4_096) }) }, { maxResultBytes: 256 });
  await assert.rejects(dispatch(dispatcher, "operation-overflow"), (error) => error instanceof FabricContractError && error.code === "resource_exhausted");
  assert.equal(device.activeOperationCount, 0);
  assert.equal(hub.activeSessionCount, 1, "operation overflow must not retire an authenticated session");
});

test("socket backpressure fails only the operation and preserves the relay session", async () => {
  const routes = { validateRoute: () => ({ ...route }) };
  const endpoints = { getEndpoint: () => structuredClone(endpoint) };
  const dispatcher = new FabricEndpointDispatcher({ routes, endpoints });
  const hub = new FabricHubRelay({
    dispatcher,
    hubRuntimeEpoch: "hub-backpressure",
    originSubjectOf: () => "origin-backpressure",
    limits: { maxSocketBufferedBytes: 1, maxActiveOperations: 1 },
  });
  const owner = session();
  hub.accepted(owner, {
    send: () => { throw new Error("operation send must not pass the backpressure fence"); },
    get bufferedAmount(): number { return 2; },
  });
  hub.ready(owner, { endpoints: [endpoint] });
  await assert.rejects(dispatch(dispatcher, "operation-backpressure"),
    (error) => error instanceof FabricContractError && error.code === "resource_exhausted");
  assert.equal(hub.activeSessionCount, 1);
});

test("foreign direction, session generation, correlation, and duplicate opens fail closed", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { hub, dispatcher, owner } = setup({ handle: async () => { await gate; return { ok: true }; } });
  const operation = dispatch(dispatcher, "operation-foreign");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const active = {
    version: "fabric.v1",
    messageId: "forged-message",
    kind: "invoke",
    sentAt: Date.now(),
    connectionId: owner.connectionId,
    connectionGeneration: owner.connectionGeneration,
    correlationId: "operation-foreign",
    operationId: "operation-foreign",
    deadlineAt: Date.now() + 10_000,
    payload: {},
  } as FabricEnvelopeV1;
  assert.throws(() => hub.accept(owner, active), /valid|direction|relay/i);
  assert.throws(() => hub.accept({ ...owner, connectionGeneration: 2 }, active), /valid|direction|relay/i);
  release();
  await operation;
});

test("generation-owned registration cleanup cannot remove its successor", async () => {
  const routes = { validateRoute: () => ({ ...route }) };
  const endpoints = { getEndpoint: () => structuredClone(endpoint) };
  const dispatcher = new FabricEndpointDispatcher({ routes, endpoints });
  const firstRegistration = {
    endpointId: endpoint.endpointId,
    kind: "agent" as const,
    handler: { handle: async () => ({ generation: 1 }) },
    ownerId: "owner-1",
    connectionId: route.connectionId,
    connectionGeneration: route.connectionGeneration,
    endpointGeneration: endpoint.generation,
  };
  const disposeFirst = dispatcher.register(firstRegistration);
  assert.equal(disposeFirst(), true);
  dispatcher.register({ ...firstRegistration, handler: { handle: async () => ({ generation: 2 }) }, ownerId: "owner-2" });
  assert.equal(disposeFirst(), false, "late generation-one disposer removed its replacement");
  assert.deepEqual(await dispatch(dispatcher, "operation-generation-2"), { generation: 2 });
});

test("stale session retirement cannot remove a successor with the same connection tuple", () => {
  const dispatcher = new FabricEndpointDispatcher({
    routes: { validateRoute: () => ({ ...route }) },
    endpoints: { getEndpoint: () => structuredClone(endpoint) },
  });
  const hub = new FabricHubRelay({ dispatcher, hubRuntimeEpoch: "hub-session-owner", originSubjectOf: () => "origin-session-owner" });
  const first = session(route.connectionId, route.connectionGeneration, "instance-old");
  const successor = session(route.connectionId, route.connectionGeneration, "instance-new");
  const transport = { send: () => undefined, get bufferedAmount(): number { return 0; } };
  hub.accepted(first, transport);
  hub.ready(first, { endpoints: [endpoint] });
  hub.accepted(successor, transport);
  hub.ready(successor, { endpoints: [endpoint] });
  hub.retire({ ...first, current: false }, "late old-session cleanup");
  assert.doesNotThrow(() => hub.advertisement(successor, { upserts: { endpoints: [] } }));
  assert.equal(hub.activeSessionCount, 1);
});

test("pre-ready and unnegotiated owners cannot publish executable registrations", () => {
  const dispatcher = new FabricEndpointDispatcher({
    routes: { validateRoute: () => ({ ...route }) },
    endpoints: { getEndpoint: () => structuredClone(endpoint) },
  });
  const hub = new FabricHubRelay({ dispatcher, hubRuntimeEpoch: "hub-pre-ready", originSubjectOf: () => "origin-1" });
  assert.throws(() => hub.ready({ ...session(), relayVersion: undefined }, { endpoints: [endpoint] }),
    (error) => error instanceof FabricContractError && error.code === "stale_generation");
  assert.throws(() => hub.ready(session(), { endpoints: [endpoint] }),
    (error) => error instanceof FabricContractError && error.code === "stale_generation");
});

test("foreign session and correlation responses cannot complete an active Hub operation", async () => {
  const routes = { validateRoute: () => ({ ...route }) };
  const endpoints = { getEndpoint: () => structuredClone(endpoint) };
  const dispatcher = new FabricEndpointDispatcher({ routes, endpoints });
  const hub = new FabricHubRelay({ dispatcher, hubRuntimeEpoch: "hub-correlation", originSubjectOf: () => "origin-correlation" });
  const owner = session();
  let captured: FabricEnvelopeV1 | undefined;
  hub.accepted(owner, {
    send: (outgoing) => { captured = outgoing; },
    get bufferedAmount(): number { return 0; },
  });
  hub.ready(owner, { endpoints: [endpoint] });
  const pending = dispatch(dispatcher, "operation-correlation");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(captured && captured.kind === "invoke");
  const candidate = captured.payload;
  assertValidFabricHubRelayPayload(candidate, "invoke");
  if (!("operation" in candidate)) throw new Error("captured relay payload is not invoke");
  const invoke: FabricHubRelayInvokeV1 = candidate;
  let duplicateStarts = 0;
  const duplicateOwner = new FabricDeviceRelayOwner({
    identity: owner,
    hubRuntimeEpoch: "hub-correlation",
    transport: { send: () => undefined, get bufferedAmount(): number { return 0; } },
    handler: { handle: async ({ signal }) => {
      duplicateStarts += 1;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { late: true };
    } },
  });
  duplicateOwner.activate();
  duplicateOwner.accept(captured);
  assert.doesNotThrow(() => duplicateOwner.accept(captured));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(duplicateStarts, 1, "duplicate invoke started a second Device handler");
  duplicateOwner.retire("duplicate-open test complete");
  const { operation: _operation, originSubject: _originSubject, input: _input, frame: _open, ...authority } = invoke;
  const terminal = { ...invoke.frame, sequence: 0, kind: "end" as const, sentAt: Date.now(), payload: { result: { exact: true } } };
  const responsePayload: FabricHubRelayStreamV1 = { ...authority, direction: "device-to-hub", sequence: 0, frame: terminal };
  const response: FabricEnvelopeV1 = {
    ...captured,
    messageId: "response-correlation",
    kind: "stream",
    sentAt: Date.now(),
    payload: jsonRecord(responsePayload),
  };
  assert.throws(() => hub.accept({ ...owner, connectionGeneration: 2 }, response),
    (error) => error instanceof FabricContractError && error.code === "stale_generation");
  const foreignPayload: FabricHubRelayStreamV1 = {
    ...responsePayload,
    operationId: "foreign-operation",
    frame: { ...terminal, operationId: "foreign-operation" },
  };
  assert.throws(() => hub.accept(owner, {
    ...response,
    operationId: "foreign-operation",
    payload: jsonRecord(foreignPayload),
  }), (error) => error instanceof FabricContractError && error.code === "conflict");
  hub.accept(owner, response);
  assert.deepEqual(await pending, { exact: true });
});

test("Endpoint removal blocks new calls synchronously and cancels its exact active generation", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let aborted = false;
  const { hub, device, dispatcher, owner } = setup({ handle: async ({ signal }) => {
    entered();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    return { late: true };
  } });
  const operation = dispatch(dispatcher, "operation-endpoint-remove");
  await started;
  hub.advertisement(owner, { removals: { endpointIds: [endpoint.endpointId] } });
  await assert.rejects(dispatch(dispatcher, "operation-after-remove"), /no local transport registration/i);
  await assert.rejects(operation, (error) => error instanceof FabricContractError && error.code === "stale_generation");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(aborted, true);
  assert.equal(device.activeOperationCount, 0);
});

test("route revision fencing rejects late results without retiring the current session", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const { hub, device, dispatcher } = setup({ handle: async () => {
    entered();
    await gate;
    return { stale: true };
  } });
  const operation = dispatch(dispatcher, "operation-route-fence");
  await started;
  route.revision += 1;
  release();
  await assert.rejects(operation, (error) => error instanceof FabricContractError && error.code === "stale_generation");
  assert.equal(hub.activeSessionCount, 1);
  assert.equal(device.activeOperationCount, 0);
  route.revision -= 1;
});

test("workspace and Endpoint generation changes fence late operation results", async () => {
  for (const mutate of [
    () => { route.workspaceGeneration = 2; },
    () => { route.endpointGeneration = 2; endpoint.generation = 2; },
  ]) {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const { dispatcher } = setup({ handle: async () => { entered(); await gate; return { stale: true }; } });
    const operation = dispatch(dispatcher, `operation-generation-fence-${route.endpointGeneration}-${route.workspaceGeneration}`);
    await started;
    mutate();
    release();
    await assert.rejects(operation, (error) => error instanceof FabricContractError && error.code === "stale_generation");
    route.workspaceGeneration = 1;
    route.endpointGeneration = 1;
    endpoint.generation = 1;
  }
});

test("owned dispatch revalidates connection generation after the handler settles", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const dispatcher = new FabricEndpointDispatcher({
    routes: { validateRoute: () => ({ ...route }) },
    endpoints: { getEndpoint: () => structuredClone(endpoint) },
  });
  dispatcher.register({
    endpointId: endpoint.endpointId,
    kind: "agent",
    handler: { handle: async () => { entered(); await gate; return { stale: true }; } },
    ownerId: "owned-dispatch-1",
    connectionId: route.connectionId,
    connectionGeneration: route.connectionGeneration,
    endpointGeneration: endpoint.generation,
  });
  const operation = dispatch(dispatcher, "operation-owned-generation-fence");
  await started;
  const previousConnectionId = route.connectionId;
  const previousGeneration = route.connectionGeneration;
  try {
    route.connectionId = "connection-successor";
    route.connectionGeneration = previousGeneration + 1;
    release();
    await assert.rejects(operation,
      (error) => error instanceof FabricContractError && error.code === "stale_generation");
  } finally {
    route.connectionId = previousConnectionId;
    route.connectionGeneration = previousGeneration;
  }
});

test("local Agent input authority fields fail only the dispatch before any relay write", async () => {
  const dispatcher = new FabricEndpointDispatcher({
    routes: { validateRoute: () => ({ ...route }) },
    endpoints: { getEndpoint: () => structuredClone(endpoint) },
  });
  const hub = new FabricHubRelay({ dispatcher, hubRuntimeEpoch: "hub-input-fence", originSubjectOf: () => "origin-input-fence" });
  const owner = session();
  let writes = 0;
  hub.accepted(owner, {
    send: () => { writes += 1; },
    get bufferedAmount(): number { return 0; },
  });
  hub.ready(owner, { endpoints: [endpoint] });
  for (const [requestId, input] of [
    ["operation-cwd", { version: "fabric.agent-attempt.v1", attemptId: "attempt-1", placementId: "placement-1", cwd: "C:/secret" }],
    ["operation-principal", { version: "fabric.agent-attempt.v1", attemptId: "attempt-1", placementId: "placement-1", principal: { id: "forged" } }],
    ["operation-owner-token", { version: "fabric.agent-attempt.v1", attemptId: "attempt-1", placementId: "placement-1", ownerToken: "secret" }],
  ] as const) {
    await assert.rejects(
      dispatchInput(dispatcher, requestId, jsonRecord(input)),
      (error) => error instanceof FabricContractError && error.code === "permission_denied",
    );
  }
  assert.equal(writes, 0);
  assert.equal(hub.activeSessionCount, 1);
});

test("the exact relay deadline aborts the Device handler and duplicate cancel stays operation-local", async () => {
  const dispatcher = new FabricEndpointDispatcher({
    routes: { validateRoute: () => ({ ...route }) },
    endpoints: { getEndpoint: () => structuredClone(endpoint) },
  });
  const hub = new FabricHubRelay({ dispatcher, hubRuntimeEpoch: "hub-deadline", originSubjectOf: () => "origin-deadline" });
  const owner = session();
  let device!: FabricDeviceRelayOwner;
  let cancelEnvelope: FabricEnvelopeV1 | undefined;
  let abortAt = 0;
  let abortCode = "";
  const started = new Promise<void>((resolve) => {
    device = new FabricDeviceRelayOwner({
      identity: owner,
      hubRuntimeEpoch: hub.hubRuntimeEpoch,
      handler: { handle: async ({ signal }) => {
        resolve();
        await new Promise<void>((settle) => signal.addEventListener("abort", () => {
          abortAt = Date.now();
          abortCode = signal.reason instanceof FabricContractError ? signal.reason.code : "unknown";
          settle();
        }, { once: true }));
        return { late: true };
      } },
      transport: {
        send: (outgoing) => hub.accept(owner, outgoing),
        get bufferedAmount(): number { return 0; },
      },
    });
  });
  device.activate();
  hub.accepted(owner, {
    send: (outgoing) => {
      if (outgoing.kind === "cancel") cancelEnvelope = outgoing;
      device.accept(outgoing);
    },
    get bufferedAmount(): number { return 0; },
  });
  hub.ready(owner, { endpoints: [endpoint] });
  const deadlineAt = Date.now() + 60;
  const operation = dispatchInput(
    dispatcher,
    "operation-exact-deadline",
    { version: "fabric.agent-attempt.v1", attemptId: "attempt-1", placementId: "placement-1" },
    new AbortController().signal,
    deadlineAt,
  );
  await started;
  await assert.rejects(operation, (error) => error instanceof FabricContractError && error.code === "deadline_exceeded");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(abortCode, "deadline_exceeded");
  assert(abortAt >= deadlineAt && abortAt - deadlineAt < 150, `Device abort missed exact deadline by ${abortAt - deadlineAt}ms`);
  assert(cancelEnvelope !== undefined);
  assert.doesNotThrow(() => device.accept(cancelEnvelope!));
  assert.equal(device.activeOperationCount, 0);
  assert.equal(hub.activeSessionCount, 1);
});

test("late duplicate terminal frames are absorbed after deadline without route revalidation", async () => {
  const routes = {
    validateRoute: (routeId: string): EndpointRouteHandle => {
      if (routeId !== route.routeId) throw new FabricContractError("not_found", "route not found");
      return { ...route };
    },
  };
  const dispatcher = new FabricEndpointDispatcher({ routes, endpoints: { getEndpoint: () => structuredClone(endpoint) } });
  const hub = new FabricHubRelay({ dispatcher, hubRuntimeEpoch: "hub-late-terminal", originSubjectOf: () => "origin-late-terminal" });
  const owner = session();
  let invokeEnvelope: FabricEnvelopeV1 | undefined;
  hub.accepted(owner, {
    send: (outgoing) => { if (outgoing.kind === "invoke") invokeEnvelope = outgoing; },
    get bufferedAmount(): number { return 0; },
  });
  hub.ready(owner, { endpoints: [endpoint] });
  const operation = dispatchInput(
    dispatcher,
    "operation-late-terminal",
    { version: "fabric.agent-attempt.v1", attemptId: "attempt-1", placementId: "placement-1" },
    new AbortController().signal,
    Date.now() + 40,
  );
  await assert.rejects(operation, (error) => error instanceof FabricContractError && error.code === "deadline_exceeded");
  assert(invokeEnvelope?.kind === "invoke");
  route.revision += 1;
  try {
    const invokePayload = invokeEnvelope.payload;
    assertValidFabricHubRelayPayload(invokePayload, "invoke");
    if (!("operation" in invokePayload)) throw new Error("captured relay payload is not invoke");
    const { operation: _operation, originSubject: _origin, input: _input, frame: _frame, ...authority } = invokePayload;
    const terminal: FabricHubRelayStreamV1 = {
      ...authority,
      direction: "device-to-hub",
      sequence: 0,
      frame: { ...invokePayload.frame, kind: "end", sentAt: Date.now(), payload: { result: { late: true } } },
    };
    const late: FabricEnvelopeV1 = {
      ...invokeEnvelope,
      messageId: "late-terminal-1",
      kind: "stream",
      sentAt: Date.now(),
      payload: jsonRecord(terminal),
    };
    assert.doesNotThrow(() => hub.accept(owner, late));
    assert.doesNotThrow(() => hub.accept(owner, { ...late, messageId: "late-terminal-2" }));
    assert.equal(hub.activeSessionCount, 1);
  } finally {
    route.revision -= 1;
  }
});

test("negotiated operation, frame, and result limits narrow both relay owners", async () => {
  const negotiated = {
    maxFrameBytes: 512,
    maxInFlightOperations: 1,
    heartbeatIntervalMs: 1_000,
    heartbeatTimeoutMs: 5_000,
    maxAdvertisementItems: 10,
    maxResultBytes: 64,
  };
  const owner = { ...session(), negotiatedLimits: negotiated };
  const device = new FabricDeviceRelayOwner({
    identity: owner,
    hubRuntimeEpoch: "hub-negotiated",
    negotiatedLimits: negotiated,
    limits: { maxActiveOperations: 9, maxBufferedFrames: 9, maxFrameBytes: 4_096, maxResultBytes: 4_096 },
    handler: { handle: async () => ({ ok: true }) },
    transport: { send: () => undefined, get bufferedAmount(): number { return 0; } },
  });
  assert.equal(device.limits.maxActiveOperations, 1);
  assert.equal(device.limits.maxBufferedFrames, 1);
  assert.equal(device.limits.maxFrameBytes, 512);
  assert.equal(device.limits.maxResultBytes, 64);

  const dispatcher = new FabricEndpointDispatcher({
    routes: { validateRoute: () => ({ ...route }) },
    endpoints: { getEndpoint: () => structuredClone(endpoint) },
  });
  const hub = new FabricHubRelay({ dispatcher, hubRuntimeEpoch: "hub-negotiated", originSubjectOf: () => "origin-negotiated" });
  hub.accepted(owner, { send: () => undefined, get bufferedAmount(): number { return 0; } });
  hub.ready(owner, { endpoints: [endpoint] });
  const first = dispatch(dispatcher, "operation-negotiated-first");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(dispatch(dispatcher, "operation-negotiated-second"),
    (error) => error instanceof FabricContractError && error.code === "resource_exhausted");
  hub.retire(owner, "negotiated limit test complete");
  await assert.rejects(first, /uncertain|unavailable/i);
});

test("Device execution does not start after receipt delivery reentrantly retires its owner", async () => {
  const dispatcher = new FabricEndpointDispatcher({
    routes: { validateRoute: () => ({ ...route }) },
    endpoints: { getEndpoint: () => structuredClone(endpoint) },
  });
  const hub = new FabricHubRelay({ dispatcher, hubRuntimeEpoch: "hub-device-start-fence", originSubjectOf: () => "origin-device-start-fence" });
  const owner = session();
  let invokeEnvelope: FabricEnvelopeV1 | undefined;
  hub.accepted(owner, {
    send: (outgoing) => { if (outgoing.kind === "invoke") invokeEnvelope = outgoing; },
    get bufferedAmount(): number { return 0; },
  });
  hub.ready(owner, { endpoints: [endpoint] });
  const pending = dispatch(dispatcher, "operation-device-start-fence");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(invokeEnvelope?.kind === "invoke");
  let starts = 0;
  let device!: FabricDeviceRelayOwner;
  device = new FabricDeviceRelayOwner({
    identity: owner,
    hubRuntimeEpoch: hub.hubRuntimeEpoch,
    handler: { handle: async () => { starts += 1; return { late: true }; } },
    transport: {
      send: () => device.retire("receipt transport retired"),
      get bufferedAmount(): number { return 0; },
    },
  });
  device.activate();
  device.accept(invokeEnvelope);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(starts, 0);
  assert.equal(device.activeOperationCount, 0);
  hub.retire(owner, "test cleanup");
  await assert.rejects(pending, /uncertain|unavailable/i);
});

test("hard disconnect reports uncertainty, removes registration synchronously, and never retries", async () => {
  let starts = 0;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const { hub, device, dispatcher, owner } = setup({ handle: async ({ signal }) => {
    starts += 1;
    entered();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    return { mustNotPublish: true };
  } });
  const operation = dispatch(dispatcher, "operation-disconnect");
  await started;
  hub.retire(owner, "socket disconnected");
  device.retire("socket disconnected");
  await assert.rejects(operation, /uncertain|disconnected|cancelled/i);
  await assert.rejects(dispatch(dispatcher, "operation-after-disconnect"), /no local transport registration/i);
  assert.equal(starts, 1);
  assert.equal(hub.activeSessionCount, 0);
  assert.equal(device.activeOperationCount, 0);
});
