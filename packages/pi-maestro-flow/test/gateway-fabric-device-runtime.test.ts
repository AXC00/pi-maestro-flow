import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { AttemptOutcome, BackendCapabilities } from "pi-maestro-backend-core/v1/backend";
import type { SingleResult } from "pi-maestro-backend-core/v1/spec";
import { FABRIC_AGENT_ATTEMPT_VERSION, type FabricAgentStartRequestV1 } from "pi-maestro-backends/fabric";
import type { FabricTeammateAttemptRequest, FabricTeammateRuntimePort } from "pi-maestro-teammate/v1/fabric-runtime";
import type { FabricHubRelayAuthorityV1, JsonValue } from "pi-maestro-fabric-core/v1";
import { GatewayPolicy } from "../src/gateway/policy.ts";
import { WorkspaceRegistry } from "../src/gateway/workspace-registry.ts";
import { FabricConnectorInventory } from "../src/gateway/fabric/connector-inventory.ts";
import { FabricDeviceAgentRuntime } from "../src/gateway/fabric/device-runtime.ts";
import type { FabricConnectorConfigV1 } from "../src/gateway/fabric/connector-config.ts";

const CAPABILITIES: BackendCapabilities = {
  outputSchema: "native", forkContext: "unsupported", modelSelection: "native", thinkingLevel: "native",
  todoBinding: "unsupported", toolFilter: "unsupported", steer: "native", followUp: "native", abort: "native",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function result(attemptId = "attempt-1"): SingleResult {
  return {
    agent: "general", task: "device work", exitCode: 0,
    messages: [{ role: "assistant", content: "done" }],
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 },
    model: "device/model", correlationId: attemptId, durationMs: 1, terminalStatus: "completed",
  };
}

class FakePort implements FabricTeammateRuntimePort {
  readonly starts: FabricTeammateAttemptRequest[] = [];
  readonly outcomes: Array<ReturnType<typeof deferred<AttemptOutcome>>> = [];
  aborts = 0;

  async startAttempt(request: FabricTeammateAttemptRequest) {
    this.starts.push(request);
    request.onChildEvent?.({ text: "one" });
    request.onChildEvent?.({ text: "two" });
    request.onChildEvent?.({ text: "three" });
    const outcome = deferred<AttemptOutcome>();
    this.outcomes.push(outcome);
    return {
      acceptedBackend: "device-only",
      acceptedModel: "device/model",
      acceptedCapabilities: CAPABILITIES,
      outcome: outcome.promise,
      send: () => true,
      abort: () => { this.aborts += 1; },
    };
  }
}

async function fixture(t: TestContext, restricted = true) {
  const root = await mkdtemp(join(tmpdir(), "fabric-device-runtime-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const registry = new WorkspaceRegistry({ path: join(root, "registry.json") });
  const local = await registry.register(join(root, "workspace"), { mode: "permanent", id: "local-workspace-1" });
  const policy = new GatewayPolicy({ workspaceRoot: root, registry, workspaces: [] });
  const config: FabricConnectorConfigV1 = {
    version: "fabric.connector-config.v1", enabled: true,
    hubUrl: "wss://hub.example.test/fabric/v1/connector", connectorId: "connector-1", keyId: "key-1",
    audience: "fabric", credentialGeneration: 1, privateKeyPath: join(root, "key.pem"),
    devices: [{ deviceId: "device-1", connectorId: "connector-1", label: "Device", connectionMode: "https", enabled: true, revision: 1 }],
    localDeviceId: "device-1", workspaceIds: [local.id], revision: 1,
  };
  const sourceAvailability = {
    roles: ["general", "reviewer"], taskTypes: ["development", "review"], models: ["device/model", "other/model"],
    backends: [{ name: "device-only", capabilities: CAPABILITIES }, { name: "other-backend", capabilities: CAPABILITIES }],
  };
  const sourceRestrictions = restricted ? {
    roles: ["general"], taskTypes: ["development"], models: ["device/model"], backends: ["device-only"], maxConcurrency: 1,
  } : undefined;
  const prepared = await new FabricConnectorInventory({
    root, registry, policy, sourceAvailability,
    ...(sourceRestrictions === undefined ? {} : { sourceRestrictions }),
    platform: "win32", windowsAclRunner: async () => undefined,
  }).prepare(config);
  return { root, registry, policy, prepared, local };
}

function setupContext(prepared: Awaited<ReturnType<FabricConnectorInventory["prepare"]>>) {
  const payload = prepared.advertisement.payload as unknown as {
    endpoints: Array<{ endpointId: string; generation: number; scope: { workspaceId: string } }>;
    workspaces: Array<{ workspaceId: string; generation: number }>;
  };
  const endpoint = payload.endpoints[0]!;
  const workspace = payload.workspaces[0]!;
  const now = Date.now();
  const authority: FabricHubRelayAuthorityV1 = {
    version: "fabric.hub-relay.v1", hubRuntimeEpoch: "hub-1", connectorId: prepared.connectorId,
    deviceId: prepared.deviceId, connectionId: "connection-1", connectionGeneration: 7,
    routeId: "route-1", routeRevision: 1, workspaceBindingId: "binding-1",
    workspaceGeneration: workspace.generation, endpointId: endpoint.endpointId, endpointGeneration: endpoint.generation,
    requestId: "request-1", correlationId: "request-1", operationId: "operation-1", streamId: "stream-1",
    sequence: 0, deadlineAt: now + 60_000,
  };
  const start: FabricAgentStartRequestV1 = {
    version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: "attempt-1",
    placement: {
      version: "fabric.placement.v1", placementId: "placement-1", routeId: authority.routeId,
      workspaceBindingId: authority.workspaceBindingId, endpointId: authority.endpointId,
      connectionGeneration: authority.connectionGeneration, workspaceGeneration: authority.workspaceGeneration,
      endpointGeneration: authority.endpointGeneration, requestedModel: "device/model", requestedRole: "general",
      requestedTaskType: "development", deadlineAt: authority.deadlineAt,
    },
    spec: { agent: "general", task: "device work", model: "device/model" },
  };
  const input = (value: unknown) => structuredClone(value) as Readonly<Record<string, JsonValue>>;
  return { authority, start, input };
}

function outcome(status: "reclaimed" | "unreaped" = "reclaimed"): AttemptOutcome {
  return {
    result: result(),
    recovery: { settlementAuthority: "authoritative", completedToolCount: 0, inFlightToolCount: 0, preActivityInfrastructureExit: false, externalReplayRisk: false },
    reclamation: Promise.resolve(status === "reclaimed" ? { status } : { status, reason: "release not confirmed" }),
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("Device runtime executes only the proven local backend and preserves Agent event paging identities", async (t) => {
  const value = await fixture(t);
  const port = new FakePort();
  let fences = 0;
  const runtime = new FabricDeviceAgentRuntime({ ...value, runtime: port, assertCurrent: async () => { fences += 1; } });
  t.after(async () => { await runtime.close(); });
  const { authority, start, input } = setupContext(value.prepared);
  const ack = await runtime.handle({ operation: "agent.start", input: input(start), authority, originSubject: "origin-opaque-1", signal: new AbortController().signal }) as Record<string, unknown>;
  assert.equal(ack.acceptedBackend, "device-only");
  assert.equal(port.starts.length, 1);
  assert.equal(port.starts[0]!.baseCwd, value.local.path);
  assert.equal(port.starts[0]!.spec.backend, undefined);
  assert.ok(fences >= 4);

  const page1 = await runtime.handle({
    operation: "agent.events", input: input({ version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: "attempt-1", placementId: "placement-1", afterSequence: 0, limit: 2 }),
    authority: { ...authority, requestId: "request-events-1", operationId: "operation-events-1", correlationId: "request-events-1", streamId: "stream-events-1" },
    originSubject: "origin-opaque-1", signal: new AbortController().signal,
  }) as { nextSequence: number; events: Array<{ sequence: number; kind: string }> };
  assert.deepEqual(page1.events.map((event) => event.kind), ["start-ack", "output"]);
  const page2 = await runtime.handle({
    operation: "agent.events", input: input({ version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: "attempt-1", placementId: "placement-1", afterSequence: page1.nextSequence, limit: 3 }),
    authority: { ...authority, requestId: "request-events-2", operationId: "operation-events-2", correlationId: "request-events-2", streamId: "stream-events-2" },
    originSubject: "origin-opaque-1", signal: new AbortController().signal,
  }) as { events: Array<{ sequence: number }> };
  assert.deepEqual(page2.events.map((event) => event.sequence), [3, 4]);
  port.outcomes[0]!.resolve(outcome());
  await flush();
});

test("concurrent Agent controls share only the stable route owner tuple", async (t) => {
  const value = await fixture(t);
  const port = new FakePort();
  const entered = deferred<void>();
  const release = deferred<void>();
  let blocked = false;
  const runtime = new FabricDeviceAgentRuntime({
    ...value,
    runtime: port,
    assertCurrent: async (current) => {
      if (current.requestId === "request-events-concurrent" && !blocked) {
        blocked = true;
        entered.resolve(undefined);
        await release.promise;
      }
    },
  });
  t.after(async () => { release.resolve(undefined); port.outcomes[0]?.resolve(outcome()); await runtime.close(); });
  const { authority, start, input } = setupContext(value.prepared);
  await runtime.handle({
    operation: "agent.start", input: input(start), authority,
    originSubject: "origin-opaque-1", signal: new AbortController().signal,
  });

  const events = runtime.handle({
    operation: "agent.events",
    input: input({ version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: "attempt-1", placementId: "placement-1", afterSequence: 0, limit: 2 }),
    authority: {
      ...authority,
      requestId: "request-events-concurrent", operationId: "operation-events-concurrent",
      correlationId: "request-events-concurrent", streamId: "stream-events-concurrent",
    },
    originSubject: "origin-opaque-1", signal: new AbortController().signal,
  });
  await entered.promise;
  const sent = await runtime.handle({
    operation: "agent.send",
    input: input({
      version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: "attempt-1", placementId: "placement-1",
      message: "continue", mode: "follow_up",
    }),
    authority: {
      ...authority,
      requestId: "request-send-concurrent", operationId: "operation-send-concurrent",
      correlationId: "request-send-concurrent", streamId: "stream-send-concurrent",
    },
    originSubject: "origin-opaque-1", signal: new AbortController().signal,
  }) as { accepted: boolean };
  assert.equal(sent.accepted, true);
  release.resolve(undefined);
  await events;
  port.outcomes[0]!.resolve(outcome());
  await flush();
});

test("Device runtime rejects foreign/stale endpoints and missing runtime/source restriction", async (t) => {
  const value = await fixture(t);
  const port = new FakePort();
  const runtime = new FabricDeviceAgentRuntime({ ...value, runtime: port });
  t.after(async () => { await runtime.close(); });
  const { authority, start, input } = setupContext(value.prepared);
  await assert.rejects(() => runtime.handle({
    operation: "agent.start", input: input(start), authority: { ...authority, endpointGeneration: authority.endpointGeneration + 1 },
    originSubject: "origin-opaque-1", signal: new AbortController().signal,
  }), /exact advertised online Agent Endpoint/u);
  await assert.rejects(() => runtime.handle({
    operation: "agent.start", input: input(start), authority: { ...authority, deviceId: "device-foreign" },
    originSubject: "origin-opaque-1", signal: new AbortController().signal,
  }), /another Connector or Device/u);
  assert.equal(port.starts.length, 0);

  assert.throws(() => new FabricDeviceAgentRuntime({ ...value, runtime: undefined as unknown as FabricTeammateRuntimePort }), /explicit teammate runtime port/u);
  const unrestricted = await fixture(t, false);
  const unrestrictedPayload = unrestricted.prepared.advertisement.payload as unknown as { endpoints: unknown[] };
  assert.deepEqual(unrestrictedPayload.endpoints, [], "missing restrictions advertised execution");
  const forged = structuredClone(value.prepared) as typeof value.prepared & { source?: undefined };
  delete forged.source;
  assert.throws(() => new FabricDeviceAgentRuntime({ ...value, prepared: forged, runtime: port }), /without proven source restrictions/u);
});

test("abort receipt is not reclamation and recover/reclaim retain attempt versus placement identity", async (t) => {
  const value = await fixture(t);
  const port = new FakePort();
  const runtime = new FabricDeviceAgentRuntime({ ...value, runtime: port });
  t.after(async () => { await runtime.close(); });
  const { authority, start, input } = setupContext(value.prepared);
  await runtime.handle({ operation: "agent.start", input: input(start), authority, originSubject: "origin-opaque-1", signal: new AbortController().signal });
  const ids = { version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: "attempt-1", placementId: "placement-1" };
  const abort = await runtime.handle({
    operation: "agent.abort", input: input(ids), authority: { ...authority, requestId: "request-abort", operationId: "operation-abort", correlationId: "request-abort", streamId: "stream-abort" },
    originSubject: "origin-opaque-1", signal: new AbortController().signal,
  }) as Record<string, unknown>;
  assert.equal(abort.state, "accepted");
  assert.equal("reclamation" in abort, false);
  assert.equal(port.aborts, 1);
  port.outcomes[0]!.resolve(outcome("unreaped"));
  await flush(); await flush();
  const recover = await runtime.handle({
    operation: "agent.recover", input: input(ids), authority: { ...authority, requestId: "request-recover", operationId: "operation-recover", correlationId: "request-recover", streamId: "stream-recover" },
    originSubject: "origin-opaque-1", signal: new AbortController().signal,
  }) as Record<string, unknown>;
  assert.equal(recover.attemptId, "attempt-1");
  assert.equal(recover.placementId, "placement-1");
  const reclaim = await runtime.handle({
    operation: "agent.reclaim", input: input(ids), authority: { ...authority, requestId: "request-reclaim", operationId: "operation-reclaim", correlationId: "request-reclaim", streamId: "stream-reclaim" },
    originSubject: "origin-opaque-1", signal: new AbortController().signal,
  }) as { reclamation: { status: string } };
  assert.equal(reclaim.reclamation.status, "unreaped");
});

test("reentrant close fences late cleanup without touching a successor generation", async (t) => {
  const value = await fixture(t);
  const firstPort = new FakePort();
  const first = new FabricDeviceAgentRuntime({ ...value, runtime: firstPort });
  const { authority, start, input } = setupContext(value.prepared);
  await first.handle({ operation: "agent.start", input: input(start), authority, originSubject: "origin-opaque-1", signal: new AbortController().signal });
  const closing = first.close();
  assert.equal(first.close(), closing);
  firstPort.outcomes[0]!.resolve(outcome());
  await closing;
  assert.equal(first.active, false);

  const successorPort = new FakePort();
  const successor = new FabricDeviceAgentRuntime({ ...value, runtime: successorPort });
  t.after(async () => { successorPort.outcomes[0]?.resolve(outcome()); await successor.close(); });
  await successor.handle({ operation: "agent.start", input: input(start), authority, originSubject: "origin-opaque-1", signal: new AbortController().signal });
  assert.equal(successorPort.starts.length, 1);
  await assert.rejects(() => first.handle({ operation: "agent.start", input: input(start), authority, originSubject: "origin-opaque-1", signal: new AbortController().signal }), /retired/u);
  firstPort.outcomes[0]!.resolve(outcome());
  assert.equal(successor.active, true);
});
