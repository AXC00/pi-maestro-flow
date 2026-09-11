import assert from "node:assert/strict";
import test from "node:test";
import {
  FABRIC_STREAM_VERSION,
  FabricContractError,
  type EndpointRouteHandle,
  type FabricStreamChannel,
  type FabricStreamFrameV1,
} from "pi-maestro-fabric-core/v1";
import {
  FabricChannelRouter,
  RouteBoundFabricStreamChannel,
  type FabricRouteValidator,
  type FabricStreamChannelIo,
  type FabricStreamChannelLimits,
} from "../src/index.ts";

const route: EndpointRouteHandle = {
  routeId: "route-a",
  connectionId: "connection-a",
  endpointId: "endpoint-a",
  connectionGeneration: 1,
  endpointGeneration: 1,
  issuedAt: 100,
  expiresAt: 10_000,
  state: "open",
  revision: 1,
};
const signal = new AbortController().signal;
const defaultLimits: FabricStreamChannelLimits = {
  maxFrameBytes: 4_096,
  maxBufferedFrames: 4,
  maxResultBytes: 4_096,
};

function expectCode(error: unknown, code: FabricContractError["code"]): boolean {
  return error instanceof FabricContractError && error.code === code;
}

function validator(state: { stale?: boolean } = {}): FabricRouteValidator {
  return {
    validateRoute(routeId: string): EndpointRouteHandle {
      assert.equal(routeId, route.routeId);
      if (state.stale) throw new FabricContractError("stale_generation", "Route authority is stale", "routeId");
      return { ...route };
    },
  };
}

function frame(
  sequence: number,
  kind: FabricStreamFrameV1["kind"],
  payload: FabricStreamFrameV1["payload"] = {},
  identity: Partial<Pick<FabricStreamFrameV1, "streamId" | "routeId" | "operationId">> = {},
): FabricStreamFrameV1 {
  return {
    version: FABRIC_STREAM_VERSION,
    streamId: identity.streamId ?? "stream-a",
    routeId: identity.routeId ?? "route-a",
    operationId: identity.operationId ?? "operation-a",
    sequence,
    kind,
    sentAt: 200 + sequence,
    payload,
  };
}

function channel(input: {
  admissions?: FabricRouteValidator;
  io?: Partial<FabricStreamChannelIo>;
  limits?: Partial<FabricStreamChannelLimits>;
  deadlineAt?: number;
  now?: () => number;
} = {}): RouteBoundFabricStreamChannel {
  return new RouteBoundFabricStreamChannel(input.admissions ?? validator(), {
    streamId: "stream-a",
    routeId: "route-a",
    operationId: "operation-a",
    deadlineAt: input.deadlineAt ?? 5_000,
    limits: { ...defaultLimits, ...input.limits },
    io: {
      send: input.io?.send ?? (async () => undefined),
      close: input.io?.close ?? (async () => undefined),
    },
    now: input.now ?? (() => 1_000),
  });
}

test("route-bound channels exchange correlated frames bidirectionally", async () => {
  let left!: RouteBoundFabricStreamChannel;
  let right!: RouteBoundFabricStreamChannel;
  left = channel({ io: { send: async (value) => right.accept(value) } });
  right = channel({ io: { send: async (value) => left.accept(value) } });

  await left.send(frame(0, "open", { side: "left" }), signal);
  await left.send(frame(1, "data", { request: "ping" }), signal);
  assert.equal((await right.receive(signal))?.kind, "open");
  assert.deepEqual((await right.receive(signal))?.payload, { request: "ping" });

  await right.send(frame(0, "ack", { accepted: true }), signal);
  await right.send(frame(1, "data", { response: "pong" }), signal);
  await right.send(frame(2, "end"), signal);
  assert.equal((await left.receive(signal))?.kind, "ack");
  assert.deepEqual((await left.receive(signal))?.payload, { response: "pong" });
  assert.equal((await left.receive(signal))?.kind, "end");
  assert.equal(await left.receive(signal), undefined);
});

test("wrong stream, route, operation, and non-monotonic sequences fail closed", async () => {
  for (const [key, value] of [
    ["streamId", "stream-wrong"],
    ["routeId", "route-wrong"],
    ["operationId", "operation-wrong"],
  ] as const) {
    const target = channel();
    assert.throws(() => target.accept(frame(0, "open", {}, { [key]: value })), (error) => expectCode(error, "conflict"));
  }

  const inbound = channel();
  inbound.accept(frame(2, "open"));
  assert.throws(() => inbound.accept(frame(2, "ack")), (error) => expectCode(error, "protocol_violation"));

  const outbound = channel();
  await outbound.send(frame(2, "open"), signal);
  await assert.rejects(outbound.send(frame(1, "data"), signal), (error) => expectCode(error, "protocol_violation"));
});

test("route authority is revalidated after an asynchronous send", async () => {
  const state = { stale: false };
  const target = channel({
    admissions: validator(state),
    io: { send: async () => { state.stale = true; } },
  });
  await assert.rejects(target.send(frame(0, "open"), signal), (error) => expectCode(error, "stale_generation"));
});

test("absolute deadlines and local cancellation terminate pending work", async () => {
  const clock = { value: 1_000 };
  const expired = channel({ deadlineAt: 1_001, now: () => clock.value });
  clock.value = 1_001;
  await assert.rejects(expired.send(frame(0, "open"), signal), (error) => expectCode(error, "deadline_exceeded"));

  const cancelled = channel();
  const controller = new AbortController();
  const receiving = cancelled.receive(controller.signal);
  controller.abort("stop");
  await assert.rejects(receiving, (error) => expectCode(error, "cancelled"));
});

test("frame and cumulative result byte limits are enforced", async () => {
  const oversizedFrame = channel({ limits: { maxFrameBytes: 180 } });
  assert.throws(
    () => oversizedFrame.accept(frame(0, "data", { chunk: "x".repeat(256) })),
    (error) => expectCode(error, "resource_exhausted"),
  );
  const oversizedOutboundFrame = channel({ limits: { maxFrameBytes: 180 } });
  await assert.rejects(
    oversizedOutboundFrame.send(frame(0, "data", { chunk: "x".repeat(256) }), signal),
    (error) => expectCode(error, "resource_exhausted"),
  );

  const oversizedResult = channel({ limits: { maxResultBytes: 30 } });
  oversizedResult.accept(frame(0, "data", { chunk: "12345" }));
  assert.equal((await oversizedResult.receive(signal))?.sequence, 0);
  assert.throws(
    () => oversizedResult.accept(frame(1, "data", { chunk: "67890" })),
    (error) => expectCode(error, "resource_exhausted"),
  );
});

test("inbound and outbound queue overflow fail closed", async () => {
  const inbound = channel({ limits: { maxBufferedFrames: 1 } });
  inbound.accept(frame(0, "open"));
  assert.throws(() => inbound.accept(frame(1, "ack")), (error) => expectCode(error, "resource_exhausted"));

  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const writing = new Promise<void>((resolve) => { entered = resolve; });
  const outbound = channel({
    limits: { maxBufferedFrames: 1 },
    io: { send: async () => { entered(); await gate; } },
  });
  const first = outbound.send(frame(0, "open"), signal);
  await writing;
  await assert.rejects(outbound.send(frame(1, "ack"), signal), (error) => expectCode(error, "resource_exhausted"));
  release();
  await assert.rejects(first, (error) => expectCode(error, "resource_exhausted"));
});

test("remote cancel and error are observable and terminal in both directions", async () => {
  const cancelled = channel();
  cancelled.accept(frame(0, "cancel", { reason: "remote-stop" }));
  assert.equal((await cancelled.receive(signal))?.kind, "cancel");
  assert.equal(await cancelled.receive(signal), undefined);
  await assert.rejects(cancelled.send(frame(0, "ack"), signal), (error) => expectCode(error, "invalid_state"));

  const failed = channel();
  failed.accept(frame(0, "error", { message: "remote-failure" }));
  assert.equal((await failed.receive(signal))?.kind, "error");
  assert.equal(await failed.receive(signal), undefined);
  assert.throws(() => failed.accept(frame(1, "data")), (error) => expectCode(error, "invalid_state"));
});

test("close is idempotent and settles pending receives", async () => {
  let closes = 0;
  const target = channel({ io: { close: async () => { closes += 1; } } });
  const receiving = target.receive(signal);
  const first = target.close("done");
  const second = target.close("ignored");
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(await receiving, undefined);
  assert.equal(closes, 1);
});

test("close waits for the captured in-flight send before transport close completes", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const order: string[] = [];
  const target = channel({ io: {
    send: async () => { order.push("send-start"); entered(); await gate; order.push("send-end"); },
    close: async () => { order.push("close"); },
  } });
  const sending = target.send(frame(0, "open"), signal);
  await started;
  const closing = target.close("done");
  let closeSettled = false;
  void closing.then(() => { closeSettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closeSettled, false);
  release();
  await closing;
  await assert.rejects(sending, (error) => expectCode(error, "invalid_state"));
  assert.deepEqual(order, ["send-start", "send-end", "close"]);
});

test("router rejects duplicate or mismatched bindings and cleans up route channels", async () => {
  const admissions = validator();
  const router = new FabricChannelRouter(admissions);
  const closes: string[] = [];
  const makeChannel = (streamId: string, routeId = "route-a", operationId = "operation-a"): FabricStreamChannel => ({
    streamId,
    routeId,
    operationId,
    send: async () => undefined,
    receive: async () => undefined,
    close: async (reason) => { closes.push(`${streamId}:${reason}`); },
  });
  const first = makeChannel("stream-1");
  router.bind("route-a", "operation-a", first);
  assert.equal(router.get("route-a", "operation-a"), first);
  assert.throws(() => router.bind("route-a", "operation-a", makeChannel("stream-2")), (error) => expectCode(error, "conflict"));
  assert.throws(() => router.bind("route-a", "operation-b", makeChannel("stream-3")), (error) => expectCode(error, "conflict"));

  assert.equal(router.unbind("route-a", "operation-a"), first);
  assert.equal(router.get("route-a", "operation-a"), undefined);
  router.bind("route-a", "operation-a", first);
  router.bind("route-a", "operation-b", makeChannel("stream-2", "route-a", "operation-b"));
  await router.closeRoute("route-a", "route closed");
  assert.deepEqual(closes.sort(), ["stream-1:route closed", "stream-2:route closed"]);
  assert.equal(router.get("route-a", "operation-a"), undefined);
  await router.closeRoute("route-a", "route closed again");
  assert.equal(closes.length, 2);
  assert.throws(() => router.bind("route-a", "operation-a", first), (error) => expectCode(error, "invalid_state"));
});
