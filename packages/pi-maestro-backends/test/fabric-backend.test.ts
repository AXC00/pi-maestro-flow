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
  startFailure?: Error;
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

  async close(): Promise<void> {}
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
