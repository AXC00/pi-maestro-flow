import assert from "node:assert/strict";
import test from "node:test";
import type { AttemptRecoveryFacts, BackendCapabilities, BackendRunOptions } from "pi-maestro-backend-core/v1/backend";
import type { SingleResult, TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import type { AgentRuntimeEndpoint, EndpointRouteHandle, FabricPlacementEventV1, TeammatePlacementV1 } from "pi-maestro-fabric-core/v1";
import { createFabricBackend } from "../src/fabric/backend.ts";
import {
  FABRIC_AGENT_ATTEMPT_VERSION,
  fabricPlacementEvent,
  type FabricAgentControlReceiptV1,
  type FabricAgentRecoveryReceiptV1,
  type FabricAgentReclamationReceiptV1,
  type FabricAgentStartAckV1,
  type FabricAgentStartRequestV1,
  type FabricBackendRouteResolver,
  type FabricBackendRouteResolverAcquirer,
  type PreparedFabricBackendChannel,
} from "../src/fabric/channel.ts";

const NOW = 10_000;
const CAPABILITIES: BackendCapabilities = {
  outputSchema: "native", forkContext: "unsupported", modelSelection: "native", thinkingLevel: "native",
  todoBinding: "unsupported", toolFilter: "unsupported", steer: "native", followUp: "native", abort: "native",
};
const PLACEMENT: TeammatePlacementV1 = {
  version: "fabric.placement.v1",
  placementId: "placement-1",
  routeId: "route-1",
  workspaceBindingId: "binding-1",
  endpointId: "agent-endpoint-1",
  connectionGeneration: 1,
  workspaceGeneration: 1,
  endpointGeneration: 1,
  requestedModel: "model-a",
  requestedRole: "general",
  requestedTaskType: "development",
  deadlineAt: NOW + 60_000,
};
const ROUTE: EndpointRouteHandle = {
  routeId: PLACEMENT.routeId,
  connectionId: "connection-1",
  workspaceBindingId: PLACEMENT.workspaceBindingId,
  endpointId: PLACEMENT.endpointId,
  connectionGeneration: PLACEMENT.connectionGeneration,
  workspaceGeneration: PLACEMENT.workspaceGeneration,
  endpointGeneration: PLACEMENT.endpointGeneration,
  issuedAt: NOW - 1_000,
  expiresAt: NOW + 120_000,
  state: "open",
  revision: 1,
};
const ENDPOINT: AgentRuntimeEndpoint = {
  endpointId: PLACEMENT.endpointId,
  deviceId: "device-1",
  connectorId: "connector-1",
  scope: { kind: "workspace", workspaceId: "workspace-1" },
  generation: 1,
  contractHash: "a".repeat(64),
  status: "online",
  revision: 1,
  kind: "agent",
  roles: ["general"],
  taskTypes: ["development"],
  models: ["model-a"],
  maxConcurrency: 1,
};
const SPEC: TeammateRunSpec = {
  agent: "general",
  task: "inspect the workspace",
  model: "model-a",
  placement: PLACEMENT,
};

function result(): SingleResult {
  return {
    agent: SPEC.agent,
    task: SPEC.task,
    exitCode: 0,
    messages: [{ role: "assistant", content: "done" }],
    usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 },
    model: "model-a",
    correlationId: "attempt-1",
    durationMs: 25,
    terminalStatus: "completed",
  };
}

const RECOVERY: AttemptRecoveryFacts = {
  settlementAuthority: "authoritative",
  completedToolCount: 0,
  inFlightToolCount: 0,
  preActivityInfrastructureExit: false,
  externalReplayRisk: false,
};

class FakeChannel implements PreparedFabricBackendChannel {
  readonly route = structuredClone(ROUTE);
  readonly endpoint = structuredClone(ENDPOINT);
  readonly order: string[] = [];
  readonly sends: Array<{ message: string; mode: string }> = [];
  aborts = 0;
  closed = false;
  startFailure?: Error;
  waitGate?: Promise<void>;
  ackCapabilities: BackendCapabilities = CAPABILITIES;
  listener?: (event: FabricPlacementEventV1) => void;

  subscribe(listener: (event: FabricPlacementEventV1) => void): () => void {
    this.order.push("subscribe");
    this.listener = listener;
    return () => { this.listener = undefined; };
  }

  async start(request: FabricAgentStartRequestV1): Promise<FabricAgentStartAckV1> {
    this.order.push("start");
    if (this.startFailure) throw this.startFailure;
    return {
      version: FABRIC_AGENT_ATTEMPT_VERSION,
      attemptId: request.attemptId,
      placementId: request.placement.placementId,
      routeId: request.placement.routeId,
      endpointId: request.placement.endpointId,
      connectionGeneration: request.placement.connectionGeneration,
      workspaceGeneration: request.placement.workspaceGeneration,
      endpointGeneration: request.placement.endpointGeneration,
      acceptedBackend: "pi-subprocess",
      acceptedModel: "model-a",
      acceptedCapabilities: this.ackCapabilities,
      receiptRef: "placement-1:start:1",
    };
  }

  async wait(): Promise<{ status: "completed" }> {
    await this.waitGate;
    if (!this.startFailure) {
      this.listener?.(fabricPlacementEvent("placement-1", 1, "start-ack", NOW + 1, { receiptRef: "placement-1:start:1" }));
      this.listener?.(fabricPlacementEvent("placement-1", 2, "turn-complete", NOW + 2, { result: result() as never }));
      this.listener?.(fabricPlacementEvent("placement-1", 3, "recovery-facts", NOW + 3, RECOVERY));
      this.listener?.(fabricPlacementEvent("placement-1", 4, "reclamation", NOW + 4, { status: "reclaimed" }));
      this.listener?.(fabricPlacementEvent("placement-1", 5, "completion", NOW + 5, { terminalStatus: "completed" }));
    }
    return { status: "completed" };
  }

  async send(request: { message: string; mode: string }): Promise<FabricAgentControlReceiptV1> {
    this.sends.push(request);
    return {
      version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: "attempt-1", placementId: "placement-1",
      action: "send", accepted: true, state: "queued", receiptRef: "placement-1:send:1",
    };
  }

  async abort(): Promise<FabricAgentControlReceiptV1> {
    this.aborts += 1;
    return {
      version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: "attempt-1", placementId: "placement-1",
      action: "abort", accepted: true, state: "accepted", receiptRef: "placement-1:abort:1",
    };
  }

  async recover(): Promise<FabricAgentRecoveryReceiptV1> {
    if (this.startFailure) throw new Error("recovery channel unavailable");
    return {
      version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: "attempt-1", placementId: "placement-1",
      startAcknowledged: true, terminal: true, lastSequence: 5, recovery: RECOVERY, result: result(),
      receiptRef: "placement-1:recovery:5",
    };
  }

  async reclaim(): Promise<FabricAgentReclamationReceiptV1> {
    if (this.startFailure) throw new Error("release unknown");
    return {
      version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: "attempt-1", placementId: "placement-1",
      reclamation: { status: "reclaimed" }, receiptRef: "placement-1:reclamation:5",
    };
  }

  async close(): Promise<void> { this.closed = true; }
}

function options(overrides: Partial<BackendRunOptions> = {}): BackendRunOptions {
  return { correlationId: "attempt-1", baseCwd: process.cwd(), host: {}, config: {}, ...overrides };
}

function resolver(channel: FakeChannel, count: { value: number }): FabricBackendRouteResolver {
  return {
    async prepare(): Promise<PreparedFabricBackendChannel> {
      count.value += 1;
      return channel;
    },
  };
}

function acquirer(
  channel: FakeChannel,
  acquired: { value: number },
  released: { value: number },
): FabricBackendRouteResolverAcquirer {
  return {
    acquire(request) {
      acquired.value += 1;
      assert.equal(request.correlationId, "attempt-1");
      assert.equal(request.placement.placementId, "placement-1");
      return {
        resolver: resolver(channel, { value: 0 }),
        generation: 7,
        ownerId: "origin-owner-1",
        release() {
          assert.equal(channel.closed, true, "resolver released before channel cleanup");
          released.value += 1;
        },
      };
    },
  };
}

test("Fabric backend subscribes before start ACK and reports turn completion before outcome", async () => {
  const channel = new FakeChannel();
  const prepared = { value: 0 };
  const milestones: string[] = [];
  const backend = createFabricBackend(resolver(channel, prepared), { now: () => NOW });
  const run = await backend.start(SPEC, options({
    onTurnComplete: () => milestones.push("turn-complete"),
  }));
  milestones.push("start-returned");
  const outcome = await run.outcome;
  milestones.push("outcome");

  assert.deepEqual(channel.order, ["subscribe", "start"]);
  assert.equal(prepared.value, 1);
  assert.ok(milestones.indexOf("turn-complete") < milestones.indexOf("outcome"));
  assert.ok(milestones.indexOf("start-returned") < milestones.indexOf("outcome"));
  assert.equal(outcome.result.exitCode, 0);
  assert.equal(outcome.recovery.settlementAuthority, "authoritative");
  assert.deepEqual(await outcome.reclamation, { status: "reclaimed" });
});

test("Fabric control is optimistic but emits bounded source receipts", async () => {
  const channel = new FakeChannel();
  const progress: string[] = [];
  const backend = createFabricBackend(resolver(channel, { value: 0 }), { now: () => NOW });
  const run = await backend.start(SPEC, options({ onProgress: (entry) => progress.push(String(entry.lastMessage)) }));

  assert.equal(run.send("continue", "follow_up"), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(channel.sends, [{
    version: FABRIC_AGENT_ATTEMPT_VERSION,
    attemptId: "attempt-1",
    placementId: "placement-1",
    message: "continue",
    mode: "follow_up",
  }]);
  assert.ok(progress.some((message) => message.includes("queued")));
  await run.outcome;
});

test("a lost start ACK stays one attempt with unknown replay risk and unreaped release", async () => {
  const channel = new FakeChannel();
  channel.startFailure = new Error("ACK response lost");
  const prepared = { value: 0 };
  const backend = createFabricBackend(resolver(channel, prepared), { now: () => NOW });
  const run = await backend.start(SPEC, options());
  const outcome = await run.outcome;

  assert.equal(prepared.value, 1, "ACK loss prepared a replacement attempt");
  assert.ok(channel.aborts >= 1);
  assert.equal(outcome.recovery.preActivityInfrastructureExit, false);
  assert.equal(outcome.recovery.externalReplayRisk, true);
  const reclamation = await outcome.reclamation;
  assert.equal(reclamation.status, "unreaped");
  assert.match(reclamation.status === "unreaped" ? reclamation.reason : "", /release|reclamation/i);
});

test("source capability conflict withholds buffered output and settles as failure", async () => {
  const channel = new FakeChannel();
  channel.ackCapabilities = { ...CAPABILITIES, outputSchema: "unsupported" };
  let turnCompletions = 0;
  const backend = createFabricBackend(resolver(channel, { value: 0 }), { now: () => NOW });
  const run = await backend.start(
    { ...SPEC, outputSchema: { type: "object" } },
    options({ onTurnComplete: () => { turnCompletions += 1; } }),
  );
  const outcome = await run.outcome;

  assert.equal(turnCompletions, 0, "a rejected source capability published its buffered turn");
  assert.equal(outcome.result.exitCode, 1);
  assert.equal(run.send("must not deliver", "follow_up"), false);
});

test("route capability conflicts fail before source start", async () => {
  const channel = new FakeChannel();
  channel.endpoint.models = [];
  const backend = createFabricBackend(resolver(channel, { value: 0 }), { now: () => NOW });

  await assert.rejects(() => backend.start(SPEC, options()), /does not advertise the requested model/);
  assert.deepEqual(channel.order, [], "a rejected Endpoint selection still subscribed or started");
});

test("dispatch-scoped resolver acquisition and release are exactly once on success", async () => {
  const channel = new FakeChannel();
  const acquired = { value: 0 };
  const released = { value: 0 };
  const backend = createFabricBackend(acquirer(channel, acquired, released), { now: () => NOW });

  const run = await backend.start(SPEC, options());
  const [first, second] = await Promise.all([run.outcome, run.outcome]);

  assert.equal(first, second);
  assert.equal(acquired.value, 1);
  assert.equal(released.value, 1);
});

test("missing dispatch-scoped resolver fails closed without preparing a route", async () => {
  let acquired = 0;
  const backend = createFabricBackend({
    acquire(request) {
      acquired += 1;
      assert.equal(request.correlationId, "attempt-1");
      assert.equal(request.placement.placementId, "placement-1");
      return undefined;
    },
  }, { now: () => NOW });

  await assert.rejects(
    () => backend.start(SPEC, options()),
    /resolver provider is unavailable.*placed dispatch/,
  );
  assert.equal(acquired, 1);
});

test("resolver lease releases exactly once when route preparation fails", async () => {
  let acquired = 0;
  let released = 0;
  const backend = createFabricBackend({
    acquire() {
      acquired += 1;
      return {
        generation: 9,
        ownerId: "origin-owner-prepare-failure",
        resolver: { async prepare() { throw new Error("route prepare failed"); } },
        release() { released += 1; },
      };
    },
  }, { now: () => NOW });

  await assert.rejects(() => backend.start(SPEC, options()), /route prepare failed/);
  assert.equal(acquired, 1);
  assert.equal(released, 1);
});

test("ACK loss remains unreaped while its provider lease is released exactly once", async () => {
  const channel = new FakeChannel();
  channel.startFailure = new Error("ACK response lost");
  const acquired = { value: 0 };
  const released = { value: 0 };
  const backend = createFabricBackend(acquirer(channel, acquired, released), { now: () => NOW });

  const outcome = await (await backend.start(SPEC, options())).outcome;

  assert.equal(acquired.value, 1);
  assert.equal(released.value, 1);
  assert.equal((await outcome.reclamation).status, "unreaped");
});

test("abort does not release the provider before wait, recovery, reclamation, and close", async () => {
  const channel = new FakeChannel();
  let finishWait!: () => void;
  channel.waitGate = new Promise<void>((resolve) => { finishWait = resolve; });
  const acquired = { value: 0 };
  const released = { value: 0 };
  const backend = createFabricBackend(acquirer(channel, acquired, released), { now: () => NOW });
  const run = await backend.start(SPEC, options());

  run.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(channel.aborts, 1);
  assert.equal(released.value, 0, "abort released dispatch wiring before settlement cleanup");
  finishWait();
  await run.outcome;

  assert.equal(acquired.value, 1);
  assert.equal(released.value, 1);
});
