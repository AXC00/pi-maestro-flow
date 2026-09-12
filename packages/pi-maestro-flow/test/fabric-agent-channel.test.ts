import assert from "node:assert/strict";
import test from "node:test";
import type { BackendRunOptions, BackendCapabilities } from "pi-maestro-backend-core/v1/backend";
import type { SingleResult, TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import {
  FABRIC_AGENT_ATTEMPT_VERSION,
  createFabricBackend,
  fabricPlacementEvent,
} from "pi-maestro-backends/fabric";
import type {
  AgentRuntimeEndpoint,
  EndpointRecord,
  EndpointRouteHandle,
  FabricPlacementEventV1,
  JsonValue,
  TeammatePlacementV1,
} from "pi-maestro-fabric-core/v1";
import {
  FabricAgentRouteResolver,
  registerFabricAgentRouteResolver,
  type FabricAgentChannelAuthority,
  type FabricAgentChannelTransport,
} from "../src/gateway/fabric/agent-channel.ts";
import { getFabricRouteResolverProvider } from "pi-maestro-teammate/v1/fabric-runtime";
import type { FabricHttpsDispatchInput, FabricHttpsEventsResultV1 } from "../src/gateway/fabric/https-transport.ts";

const NOW = Date.now();
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
  deadlineAt: NOW + 120_000,
};
const ROUTE: EndpointRouteHandle = {
  routeId: PLACEMENT.routeId, connectionId: "connection-1", workspaceBindingId: PLACEMENT.workspaceBindingId,
  endpointId: PLACEMENT.endpointId, connectionGeneration: 1, workspaceGeneration: 1, endpointGeneration: 1,
  issuedAt: NOW - 1_000, expiresAt: NOW + 600_000, state: "open", revision: 1,
};
const ENDPOINT: AgentRuntimeEndpoint = {
  endpointId: PLACEMENT.endpointId, deviceId: "device-1", connectorId: "connector-1",
  scope: { kind: "workspace", workspaceId: "workspace-1" }, generation: 1,
  contractHash: "a".repeat(64), status: "online", revision: 1, kind: "agent",
  roles: ["general"], taskTypes: ["development"], models: ["model-a"], maxConcurrency: 1,
};
const CAPABILITIES: BackendCapabilities = {
  outputSchema: "native", forkContext: "unsupported", modelSelection: "native", thinkingLevel: "native",
  todoBinding: "unsupported", toolFilter: "unsupported", steer: "native", followUp: "native", abort: "native",
};
const SPEC: TeammateRunSpec = {
  agent: "general", task: "inspect the source workspace", model: "model-a", placement: PLACEMENT,
};

function result(): SingleResult {
  return {
    agent: SPEC.agent, task: SPEC.task, exitCode: 0,
    messages: [{ role: "assistant", content: "source done" }],
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 },
    model: "model-a", correlationId: "attempt-1", durationMs: 5, terminalStatus: "completed",
  };
}

/** A transport that answers exactly the Agent Endpoint operations this host sends. */
class FakeTransport implements FabricAgentChannelTransport {
  readonly dispatched: Array<{ operation: string; input: Record<string, JsonValue> }> = [];
  readonly queue: FabricPlacementEventV1[] = [];
  eventsFailure?: Error;
  sequence = 0;

  push(kind: FabricPlacementEventV1["kind"], payload: Readonly<Record<string, JsonValue>>): void {
    this.sequence += 1;
    this.queue.push(fabricPlacementEvent("placement-1", this.sequence, kind, NOW + this.sequence, payload));
  }

  async dispatch(input: FabricHttpsDispatchInput): Promise<JsonValue> {
    this.dispatched.push({ operation: input.operation, input: structuredClone(input.input) as Record<string, JsonValue> });
    switch (input.operation) {
      case "agent.start":
        return {
          version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: "attempt-1", placementId: "placement-1",
          routeId: ROUTE.routeId, endpointId: ENDPOINT.endpointId, connectionGeneration: 1,
          workspaceGeneration: 1, endpointGeneration: 1, acceptedBackend: "pi-subprocess",
          acceptedModel: "model-a", acceptedCapabilities: CAPABILITIES as unknown as JsonValue,
          receiptRef: "placement-1:start:1",
        } as unknown as JsonValue;
      case "agent.send":
        return {
          version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: "attempt-1", placementId: "placement-1",
          action: "send", accepted: true, state: "queued", receiptRef: "placement-1:send:2",
        } as unknown as JsonValue;
      case "agent.abort":
        return {
          version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: "attempt-1", placementId: "placement-1",
          action: "abort", accepted: true, state: "accepted", receiptRef: "placement-1:abort:2",
        } as unknown as JsonValue;
      case "agent.recover":
        return {
          version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: "attempt-1", placementId: "placement-1",
          startAcknowledged: true, terminal: true, lastSequence: this.sequence,
          recovery: {
            settlementAuthority: "authoritative", completedToolCount: 1, inFlightToolCount: 0,
            preActivityInfrastructureExit: false, externalReplayRisk: false,
          },
          result: result() as unknown as JsonValue, receiptRef: "placement-1:recovery:9",
        } as unknown as JsonValue;
      case "agent.reclaim":
        return {
          version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: "attempt-1", placementId: "placement-1",
          reclamation: { status: "reclaimed" }, receiptRef: "placement-1:reclamation:9",
        } as unknown as JsonValue;
      default:
        throw new Error(`unexpected operation ${input.operation}`);
    }
  }

  async events(input: { afterSequence: number; limit?: number }): Promise<FabricHttpsEventsResultV1> {
    if (this.eventsFailure !== undefined) throw this.eventsFailure;
    const events = this.queue.filter((event) => event.sequence > input.afterSequence).slice(0, input.limit ?? 32);
    return {
      version: "fabric.https.events.v1", kind: "events", requestId: "events-1", routeId: ROUTE.routeId,
      endpointId: ENDPOINT.endpointId, endpointKind: "agent", endpointGeneration: 1,
      deadlineAt: PLACEMENT.deadlineAt, nextSequence: events.at(-1)?.sequence ?? input.afterSequence,
      events: events as unknown as FabricHttpsEventsResultV1["events"],
    };
  }
}

const authority: FabricAgentChannelAuthority = {
  routeOf: (routeId: string) => {
    if (routeId !== ROUTE.routeId) throw new Error("route not admitted by this host");
    return structuredClone(ROUTE);
  },
  endpointOf: (endpointId: string): EndpointRecord | undefined =>
    endpointId === ENDPOINT.endpointId ? structuredClone(ENDPOINT) : undefined,
};

function options(): BackendRunOptions {
  return { correlationId: "attempt-1", baseCwd: process.cwd(), host: {}, config: {} };
}

test("the origin resolver drives the Fabric backend over the paired transport", async () => {
  const transport = new FakeTransport();
  const resolver = new FabricAgentRouteResolver({ transport, authority, now: () => NOW, pollIntervalMs: 5 });
  const backend = createFabricBackend(resolver, { now: () => NOW });
  const completions: string[] = [];

  const run = await backend.start(SPEC, { ...options(), onTurnComplete: (settled) => completions.push(settled.correlationId) });
  assert.deepEqual(
    transport.dispatched.map((entry) => entry.operation),
    ["agent.start"],
    "start must be the only dispatch before any source event arrives",
  );

  transport.push("output", { event: { type: "text", text: "working" } as JsonValue });
  transport.push("turn-complete", { result: result() as never, terminalStatus: "completed" });

  // Sent while the attempt is still live: the completion event has not arrived,
  // so the source still accepts input.
  assert.equal(run.send("keep going", "follow_up"), true);
  await new Promise((resolve) => setImmediate(resolve));

  transport.push("recovery-facts", {
    settlementAuthority: "authoritative", completedToolCount: 1, inFlightToolCount: 0,
    preActivityInfrastructureExit: false, externalReplayRisk: false,
  });
  transport.push("reclamation", { status: "reclaimed" });
  transport.push("completion", { terminalStatus: "completed" });

  const outcome = await run.outcome;
  assert.equal(outcome.result.exitCode, 0);
  assert.equal(outcome.result.messages[0]?.content, "source done");
  assert.deepEqual(completions, ["attempt-1"]);
  assert.deepEqual(await outcome.reclamation, { status: "reclaimed" });

  assert.equal(run.send("must be refused after settlement", "follow_up"), false);
  await new Promise((resolve) => setImmediate(resolve));
  // The origin asks the source for recovery facts and release evidence at
  // settlement, and never for a second attempt.
  assert.deepEqual(transport.dispatched.map((entry) => entry.operation), [
    "agent.start", "agent.send", "agent.recover", "agent.reclaim",
  ]);
});

test("a dropped event stream is reported as transport loss, not as release", async () => {
  const transport = new FakeTransport();
  transport.eventsFailure = new Error("the paired Gateway connection dropped");
  const resolver = new FabricAgentRouteResolver({ transport, authority, now: () => NOW, pollIntervalMs: 5 });
  const backend = createFabricBackend(resolver, { now: () => NOW });

  const run = await backend.start(SPEC, options());
  const outcome = await run.outcome;

  assert.equal(outcome.result.exitCode, 1);
  assert.equal(outcome.recovery.externalReplayRisk, true);
  const reclamation = await outcome.reclamation;
  assert.equal(reclamation.status, "unreaped");
  assert.match(reclamation.status === "unreaped" ? reclamation.reason : "", /dropped|reclamation/);
});

test("the registration helper installs the host resolver and its disposer removes it", () => {
  const transport = new FakeTransport();
  const dispose = registerFabricAgentRouteResolver({ transport, authority, now: () => NOW, pollIntervalMs: 5 });
  assert.notEqual(getFabricRouteResolverProvider(), undefined);
  assert.equal(getFabricRouteResolverProvider()?.() instanceof FabricAgentRouteResolver, true);
  dispose();
  assert.equal(getFabricRouteResolverProvider(), undefined, "the disposer left a stale resolver installed");
});

test("preparation refuses a route this host never admitted and an unknown Endpoint", async () => {
  const transport = new FakeTransport();
  const resolver = new FabricAgentRouteResolver({ transport, authority, now: () => NOW, pollIntervalMs: 5 });
  const backend = createFabricBackend(resolver, { now: () => NOW });

  await assert.rejects(
    () => backend.start(
      { ...SPEC, placement: { ...PLACEMENT, routeId: "route-never-opened" } },
      options(),
    ),
    /route not admitted by this host/,
  );
  await assert.rejects(
    () => backend.start(
      { ...SPEC, placement: { ...PLACEMENT, endpointId: "agent-endpoint-unknown" } },
      options(),
    ),
    /Agent Endpoint is not known to this host/,
  );
  assert.deepEqual(transport.dispatched, []);
});
