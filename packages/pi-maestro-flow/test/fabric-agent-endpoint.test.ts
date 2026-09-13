import assert from "node:assert/strict";
import test from "node:test";
import type { AttemptOutcome, BackendCapabilities } from "pi-maestro-backend-core/v1/backend";
import type { SingleResult } from "pi-maestro-backend-core/v1/spec";
import { FABRIC_AGENT_ATTEMPT_VERSION, type FabricAgentStartRequestV1 } from "pi-maestro-backends/fabric";
import type { FabricTeammateAttemptRequest, FabricTeammateRuntimePort } from "pi-maestro-teammate/v1/fabric-runtime";
import type { AgentRuntimeEndpoint, EndpointRouteHandle, JsonValue, PublicWorkspaceRecord } from "pi-maestro-fabric-core/v1";
import { FabricAgentEndpointBridge } from "../src/gateway/fabric/agent-endpoint.ts";
import { GatewayFabricControlSupport, type GatewayFabricControlRuntime } from "../src/gateway/fabric/control-support.ts";
import { FabricEndpointDispatcher } from "../src/gateway/fabric/endpoint-dispatcher.ts";
import { createGatewayPrincipal } from "../src/gateway/principal.ts";
import type { GatewayPolicy } from "../src/gateway/policy.ts";
import type { WorkspaceRegistry } from "../src/gateway/workspace-registry.ts";

const NOW = Date.now();
const CAPABILITIES: BackendCapabilities = {
  outputSchema: "native", forkContext: "unsupported", modelSelection: "native", thinkingLevel: "native",
  todoBinding: "unsupported", toolFilter: "unsupported", steer: "native", followUp: "native", abort: "native",
};
const ENDPOINT: AgentRuntimeEndpoint = {
  endpointId: "agent-endpoint-1", deviceId: "device-1", connectorId: "connector-1",
  scope: { kind: "workspace", workspaceId: "fabric-workspace-1" }, generation: 1,
  contractHash: "a".repeat(64), status: "online", revision: 1, kind: "agent",
  roles: ["general"], taskTypes: ["development"], models: ["model-a"], maxConcurrency: 1,
};
const ROUTE: EndpointRouteHandle = {
  routeId: "route-1", connectionId: "connection-1", workspaceBindingId: "binding-1",
  endpointId: ENDPOINT.endpointId, connectionGeneration: 1, workspaceGeneration: 1,
  endpointGeneration: 1, issuedAt: NOW - 1_000, expiresAt: NOW + 120_000,
  state: "open", revision: 1,
};
const WORKSPACE: PublicWorkspaceRecord = {
  workspaceId: "fabric-workspace-1", deviceId: "device-1", label: "workspace",
  mode: "permanent", generation: 1, policyDigest: "b".repeat(64), endpointIds: [ENDPOINT.endpointId], revision: 1,
};
const START: FabricAgentStartRequestV1 = {
  version: FABRIC_AGENT_ATTEMPT_VERSION,
  attemptId: "attempt-1",
  placement: {
    version: "fabric.placement.v1", placementId: "placement-1", routeId: ROUTE.routeId,
    workspaceBindingId: ROUTE.workspaceBindingId, endpointId: ENDPOINT.endpointId,
    connectionGeneration: 1, workspaceGeneration: 1, endpointGeneration: 1,
    requestedModel: "model-a", requestedRole: "general", requestedTaskType: "development",
    deadlineAt: NOW + 60_000,
  },
  spec: { agent: "general", task: "inspect the source", model: "model-a" },
};

function result(): SingleResult {
  return {
    agent: "general", task: "inspect the source", exitCode: 0,
    messages: [{ role: "assistant", content: "source done" }],
    usage: { inputTokens: 2, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 },
    model: "model-a", correlationId: "attempt-1", durationMs: 10, terminalStatus: "completed",
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

class FakeRuntime implements FabricTeammateRuntimePort {
  readonly starts: FabricTeammateAttemptRequest[] = [];
  readonly sends: Array<{ message: string; mode: string }> = [];
  aborts = 0;
  readonly completion = deferred<AttemptOutcome>();

  async startAttempt(request: FabricTeammateAttemptRequest) {
    this.starts.push(request);
    // These arrive before startAttempt resolves. The bridge must still publish
    // start-ack first so the origin never observes output for an unacknowledged run.
    request.onChildEvent?.({ type: "text", text: "working" });
    request.onTurnComplete?.(result(), "completed");
    return {
      acceptedBackend: "pi-subprocess",
      acceptedModel: "model-a",
      acceptedCapabilities: CAPABILITIES,
      outcome: this.completion.promise,
      send: (message: string, mode: "prompt" | "follow_up" | "steer") => {
        this.sends.push({ message, mode });
        return true;
      },
      abort: () => { this.aborts += 1; },
    };
  }
}

function harness(runtime: FakeRuntime, endpoint: AgentRuntimeEndpoint = structuredClone(ENDPOINT)) {
  const registry = {
    async get(id: string) {
      return id === "local-workspace-1" ? {
        version: 1, id, path: "C:/source/workspace", canonicalPath: "C:/source/workspace",
        mode: "permanent", generation: 3, registeredAt: NOW - 1_000, updatedAt: NOW - 1_000,
      } : undefined;
    },
  } as unknown as WorkspaceRegistry;
  const controlRuntime = {
    directory: {
      getWorkspace: (id: string) => id === WORKSPACE.workspaceId ? structuredClone(WORKSPACE) : undefined,
      getEndpoint: (id: string) => id === endpoint.endpointId ? structuredClone(endpoint) : undefined,
    },
    admissions: {
      validateRoute: (id: string) => {
        if (id !== ROUTE.routeId) throw new Error("route missing");
        return structuredClone(ROUTE);
      },
    },
    resolveLocalWorkspaceId: async (id: string) => id === WORKSPACE.workspaceId ? "local-workspace-1" : undefined,
  } as unknown as GatewayFabricControlRuntime;
  const policy = {
    async authorizeWorkspace() { return { allowed: true, reason: "test" }; },
  } as unknown as GatewayPolicy;
  const support = new GatewayFabricControlSupport(controlRuntime, policy, registry);
  const bridge = new FabricAgentEndpointBridge({ support, runtimeOf: () => runtime });
  const dispatcher = new FabricEndpointDispatcher({
    routes: controlRuntime.admissions,
    endpoints: controlRuntime.directory,
    registrations: [{ endpointId: endpoint.endpointId, kind: "agent", handler: bridge }],
    now: () => NOW,
  });
  const principal = createGatewayPrincipal("http", "paired-source", { authenticated: true, scopes: ["fabric.data"] });
  let requestSequence = 0;
  const dispatch = (
    operation: string,
    input: Record<string, JsonValue>,
    signal: AbortSignal = new AbortController().signal,
  ) => dispatcher.dispatch({
    version: "fabric.endpoint-request.v1",
    requestId: `request-${++requestSequence}`,
    routeId: ROUTE.routeId,
    endpointId: endpoint.endpointId,
    endpointKind: "agent",
    endpointGeneration: endpoint.generation,
    deadlineAt: START.placement.deadlineAt,
    operation,
    input,
  }, principal, signal);
  return { bridge, dispatch };
}

const asInput = (value: unknown): Record<string, JsonValue> => structuredClone(value) as Record<string, JsonValue>;
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("agent.start links relay cancellation through start settlement", async () => {
  class PendingStartRuntime extends FakeRuntime {
    override async startAttempt(request: FabricTeammateAttemptRequest): Promise<never> {
      this.starts.push(request);
      return new Promise<never>((_resolve, reject) => {
        const cancelled = (): void => reject(new Error("source start observed cancellation"));
        request.signal.addEventListener("abort", cancelled, { once: true });
        if (request.signal.aborted) cancelled();
      });
    }
  }
  const runtime = new PendingStartRuntime();
  const { dispatch } = harness(runtime);
  const controller = new AbortController();
  const starting = dispatch("agent.start", asInput(START), controller.signal);
  while (runtime.starts.length === 0) await flush();
  controller.abort(new Error("relay cancelled"));
  await assert.rejects(() => starting, /cancelled/u);
  assert.equal(runtime.starts[0]!.signal.aborted, true);
});

test("Agent Endpoint starts one source attempt, ACKs first, and keeps canonical publication at origin", async () => {
  const runtime = new FakeRuntime();
  const { dispatch } = harness(runtime);

  const ack = await dispatch("agent.start", asInput(START)) as Record<string, unknown>;
  const duplicate = await dispatch("agent.start", asInput(START)) as Record<string, unknown>;
  assert.equal(runtime.starts.length, 1, "idempotent start created a replacement source attempt");
  assert.equal(ack.receiptRef, duplicate.receiptRef);
  assert.equal(runtime.starts[0]?.spec.cwd, "C:/source/workspace");
  assert.equal(runtime.starts[0]?.spec.placement, undefined);
  assert.equal(runtime.starts[0]?.spec.backend, undefined);

  const firstPage = await dispatch("agent.events", asInput({
    version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: "attempt-1", placementId: "placement-1", afterSequence: 0,
  })) as { events: Array<{ kind: string }> };
  assert.deepEqual(firstPage.events.map((event) => event.kind), ["start-ack", "output", "turn-complete"]);

  runtime.completion.resolve({
    result: result(),
    recovery: {
      settlementAuthority: "authoritative", completedToolCount: 1, inFlightToolCount: 0,
      preActivityInfrastructureExit: false, externalReplayRisk: false,
    },
    reclamation: Promise.resolve({ status: "reclaimed" }),
  });
  await flush();
  await flush();
  const recovery = await dispatch("agent.recover", asInput({
    version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: "attempt-1", placementId: "placement-1",
  })) as Record<string, unknown>;
  assert.equal((recovery.recovery as Record<string, unknown>).completedToolCount, 1);
  assert.equal((recovery.result as Record<string, unknown>).publicationId, undefined, "source invented a canonical publication");
  const reclaim = await dispatch("agent.reclaim", asInput({
    version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: "attempt-1", placementId: "placement-1",
  })) as { reclamation: { status: string } };
  assert.equal(reclaim.reclamation.status, "reclaimed");
});

test("Agent Endpoint routes send and abort to the one acknowledged source handle", async () => {
  const runtime = new FakeRuntime();
  const { dispatch } = harness(runtime);
  await dispatch("agent.start", asInput(START));

  const send = await dispatch("agent.send", asInput({
    version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: "attempt-1", placementId: "placement-1",
    message: "continue", mode: "follow_up",
  })) as Record<string, unknown>;
  assert.equal(send.state, "queued");
  assert.deepEqual(runtime.sends, [{ message: "continue", mode: "follow_up" }]);

  const abort = await dispatch("agent.abort", asInput({
    version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: "attempt-1", placementId: "placement-1",
  })) as Record<string, unknown>;
  assert.equal(abort.state, "accepted");
  assert.equal(runtime.aborts, 1);
});

test("Agent Endpoint rejects route capability conflict before source runtime start", async () => {
  const runtime = new FakeRuntime();
  const endpoint = { ...structuredClone(ENDPOINT), models: [] };
  const { dispatch } = harness(runtime, endpoint);

  await assert.rejects(() => dispatch("agent.start", asInput(START)), /does not advertise the requested model/);
  assert.equal(runtime.starts.length, 0);
});

test("Agent Endpoint rejects wire-only backend/cwd fields and enforces advertised concurrency", async () => {
  const runtime = new FakeRuntime();
  const { dispatch } = harness(runtime);
  const smuggled = structuredClone(START) as unknown as Record<string, unknown>;
  smuggled.spec = { ...(smuggled.spec as object), backend: "pi-subprocess", cwd: "C:/caller/chosen" };
  await assert.rejects(() => dispatch("agent.start", asInput(smuggled)), /unsupported field/);
  assert.equal(runtime.starts.length, 0);

  await dispatch("agent.start", asInput(START));
  const second = structuredClone(START);
  second.attemptId = "attempt-2";
  second.placement.placementId = "placement-2";
  await assert.rejects(() => dispatch("agent.start", asInput(second)), /concurrency is full/);
  assert.equal(runtime.starts.length, 1);
});

test("unconfirmed source release remains unreaped and is not evicted", async () => {
  const runtime = new FakeRuntime();
  const { bridge, dispatch } = harness(runtime);
  await dispatch("agent.start", asInput(START));
  runtime.completion.resolve({
    result: { ...result(), exitCode: 1, terminalStatus: "failed" },
    recovery: {
      settlementAuthority: "unknown", completedToolCount: 0, inFlightToolCount: 0,
      preActivityInfrastructureExit: false, externalReplayRisk: true,
    },
    reclamation: Promise.resolve({ status: "unreaped", reason: "child release not confirmed" }),
  });
  await flush();
  await flush();

  const reclaim = await dispatch("agent.reclaim", asInput({
    version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: "attempt-1", placementId: "placement-1",
  })) as { reclamation: { status: string; reason?: string } };
  assert.equal(reclaim.reclamation.status, "unreaped");
  assert.match(reclaim.reclamation.reason ?? "", /not confirmed/);
  assert.equal(bridge.attemptCount, 1);
});
