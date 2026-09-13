import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type {
  AttemptOutcome,
  BackendCapabilities,
  BackendRunOptions,
  TeammateBackend,
} from "pi-maestro-backend-core/v1/backend";
import type { BackendRegistry } from "pi-maestro-backend-core/v1/registry";
import type { SingleResult, TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import type { FabricTeammateRuntimePort } from "../src/public/v1/fabric-runtime.ts";
import {
  createFabricTeammateRuntimePort,
  getFabricTeammateRuntimePort,
  registerFabricTeammateRuntimePort,
} from "../src/public/v1/fabric-runtime.ts";
import { forgetBackendRegistryConfigSync } from "../src/backends/registry-host.ts";

const CAPABILITIES: BackendCapabilities = {
  outputSchema: "native", forkContext: "native", modelSelection: "native", thinkingLevel: "native",
  todoBinding: "native", toolFilter: "native", steer: "native", followUp: "native", abort: "native",
};

function placement() {
  return {
    version: "fabric.placement.v1" as const,
    placementId: "placement-1",
    routeId: "route-1",
    workspaceBindingId: "binding-1",
    endpointId: "endpoint-1",
    connectionGeneration: 1,
    workspaceGeneration: 1,
    endpointGeneration: 1,
    deadlineAt: Date.now() + 60_000,
  };
}

function result(cwd: string): SingleResult {
  return {
    agent: "general", task: "source work", exitCode: 0, messages: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 },
    model: "provider/model", correlationId: "attempt-1", durationMs: 1, originCwd: cwd,
  };
}

function port(label: string): FabricTeammateRuntimePort {
  return {
    async startAttempt() {
      throw new Error(`unused ${label}`);
    },
  };
}

const SOURCE_PROBE_KEY = Symbol.for("pi-maestro.test.fabric-source-models");

function modelRegistryWorkspace(models: Record<string, Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), "teammate-fabric-source-model-"));
  mkdirSync(join(root, ".pi"), { recursive: true });
  const modulePath = join(root, "source-probe.mjs");
  writeFileSync(modulePath, `
const key = Symbol.for("pi-maestro.test.fabric-source-models");
const capabilities = {
  outputSchema: "native", forkContext: "native", modelSelection: "native", thinkingLevel: "native",
  todoBinding: "native", toolFilter: "native", steer: "native", followUp: "native", abort: "native",
};
export default {
  name: "local-source-probe",
  protocolVersion: 1,
  recoveryShape: "replay",
  capabilities: () => capabilities,
  async start(spec, options) {
    globalThis[key].push({ ...spec });
    return {
      outcome: Promise.resolve({
        result: {
          agent: spec.agent, task: spec.task, exitCode: 0, messages: [],
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 },
          model: spec.model ?? "runtime-default", correlationId: options.correlationId, durationMs: 1,
        },
        recovery: {
          settlementAuthority: "authoritative", completedToolCount: 0, inFlightToolCount: 0,
          preActivityInfrastructureExit: false, externalReplayRisk: false,
        },
        reclamation: Promise.resolve({ status: "reclaimed" }),
      }),
      send: () => false,
      abort: () => undefined,
    };
  },
};
`, "utf8");
  const deployments = new Set(Object.values(models).map((model) => String(model.deployment)));
  writeFileSync(join(root, ".pi", "teammate-backends.json"), JSON.stringify({
    version: 2,
    mode: "model-registry",
    default: String(models[Object.keys(models)[0]!]!.deployment),
    defaultModel: Object.keys(models)[0],
    backends: Object.fromEntries([...deployments].map((deployment) => [
      deployment,
      { module: pathToFileURL(modulePath).href },
    ])),
    models,
  }), "utf8");
  forgetBackendRegistryConfigSync(root);
  return root;
}

function backendRegistryWorkspace(registration: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "teammate-fabric-source-backend-"));
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi", "teammate-backends.json"), JSON.stringify({
    mode: "backend-registry",
    default: "source-default",
    backends: { "source-default": registration },
  }), "utf8");
  forgetBackendRegistryConfigSync(root);
  return root;
}

test("Fabric source runtime registration is replaceable without stale disposer removal", () => {
  const first = port("first");
  const second = port("second");
  const firstRegistration = registerFabricTeammateRuntimePort(first);
  const secondRegistration = registerFabricTeammateRuntimePort(second);

  assert.equal(getFabricTeammateRuntimePort(), second);
  firstRegistration.dispose();
  assert.equal(getFabricTeammateRuntimePort(), second, "stale disposer removed the replacement runtime");
  secondRegistration.dispose();
  assert.equal(getFabricTeammateRuntimePort(), undefined);
});

test("Fabric source runtime registration rejects a non-port", () => {
  assert.throws(
    () => registerFabricTeammateRuntimePort({} as FabricTeammateRuntimePort),
    /must implement startAttempt/,
  );
});

test("production Fabric runtime starts exactly one backend and passes through its live handle", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "teammate-fabric-source-"));
  const settled = Promise.resolve<AttemptOutcome>({
    result: result(cwd),
    recovery: {
      settlementAuthority: "authoritative", completedToolCount: 0, inFlightToolCount: 0,
      preActivityInfrastructureExit: false, externalReplayRisk: false,
    },
    reclamation: Promise.resolve({ status: "reclaimed" }),
  });
  const starts: Array<{ spec: TeammateRunSpec; options: BackendRunOptions }> = [];
  const sends: Array<{ message: string; mode: string }> = [];
  let aborts = 0;
  const backend: TeammateBackend = {
    name: "local-source",
    protocolVersion: 1,
    recoveryShape: "replay",
    capabilities: () => CAPABILITIES,
    async start(spec, options) {
      starts.push({ spec, options });
      options.onChildEvent?.({ type: "text", text: "working" });
      options.onTurnComplete?.(result(cwd), "completed");
      return {
        outcome: settled,
        send(message, mode) { sends.push({ message, mode }); return true; },
        abort() { aborts += 1; },
      };
    },
  };
  let resolves = 0;
  const registry: BackendRegistry = {
    async resolve() { resolves += 1; return { backend, config: {}, capabilities: CAPABILITIES }; },
    async capabilitiesOf() { return CAPABILITIES; },
    listBackendNames() { return ["local-source"]; },
    defaultBackendName() { return "local-source"; },
  };
  const childEvents: Record<string, unknown>[] = [];
  const turns: SingleResult[] = [];
  const controller = new AbortController();
  const runtime = createFabricTeammateRuntimePort({ backendRegistry: registry });
  const attempt = await runtime.startAttempt({
    placement: placement(),
    spec: { agent: "general", task: "source work", model: "provider/model", cwd },
    correlationId: "attempt-1",
    baseCwd: cwd,
    signal: controller.signal,
    onChildEvent: (event) => childEvents.push(event),
    onTurnComplete: (turn) => turns.push(turn),
  });

  assert.equal(resolves, 1);
  assert.equal(starts.length, 1);
  assert.equal(starts[0]?.options.correlationId, "attempt-1");
  assert.equal(attempt.acceptedBackend, "local-source");
  assert.equal(attempt.acceptedModel, "provider/model");
  assert.equal(attempt.outcome, settled, "the backend outcome must pass through unchanged");
  assert.deepEqual(childEvents, [{ type: "text", text: "working" }]);
  assert.equal(turns.length, 1);
  assert.equal(attempt.send("next", "follow_up"), true);
  assert.deepEqual(sends, [{ message: "next", mode: "follow_up" }]);
  attempt.abort();
  assert.equal(aborts, 1);
  assert.equal((await attempt.outcome).result.publicationId, undefined, "source runtime must not publish a result");
});

test("production Fabric runtime does not start when cancellation wins during registry preparation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "teammate-fabric-source-"));
  let releaseResolution!: () => void;
  const resolutionStarted = new Promise<void>((resolve) => { releaseResolution = resolve; });
  let finishResolution!: () => void;
  const resolutionGate = new Promise<void>((resolve) => { finishResolution = resolve; });
  let starts = 0;
  const backend: TeammateBackend = {
    name: "local-source",
    protocolVersion: 1,
    recoveryShape: "replay",
    capabilities: () => CAPABILITIES,
    async start() { starts += 1; throw new Error("cancelled backend must not start"); },
  };
  const registry: BackendRegistry = {
    async resolve() {
      releaseResolution();
      await resolutionGate;
      return { backend, config: {}, capabilities: CAPABILITIES };
    },
    async capabilitiesOf() { return CAPABILITIES; },
    listBackendNames() { return ["local-source"]; },
    defaultBackendName() { return "local-source"; },
  };
  const controller = new AbortController();
  const pending = createFabricTeammateRuntimePort({ backendRegistry: registry }).startAttempt({
    placement: placement(),
    spec: { agent: "general", task: "source work", cwd },
    correlationId: "attempt-1",
    baseCwd: cwd,
    signal: controller.signal,
  });

  await resolutionStarted;
  controller.abort("cancel during resolve");
  finishResolution();
  await assert.rejects(pending, /aborted while preparing its local backend/);
  assert.equal(starts, 0);
});

test("production Fabric runtime rejects leaked origin authority and non-local cwd before resolution", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "teammate-fabric-source-"));
  const other = mkdtempSync(join(tmpdir(), "teammate-fabric-other-"));
  let resolves = 0;
  const registry: BackendRegistry = {
    async resolve() { resolves += 1; throw new Error("must not resolve"); },
    async capabilitiesOf() { return CAPABILITIES; },
    listBackendNames() { return []; },
    defaultBackendName() { return "unused"; },
  };
  const runtime = createFabricTeammateRuntimePort({ backendRegistry: registry });
  const base = {
    placement: placement(), correlationId: "attempt-1", baseCwd: cwd, signal: new AbortController().signal,
  };
  await assert.rejects(
    () => runtime.startAttempt({ ...base, spec: { agent: "general", task: "x", cwd, backend: "fabric" } }),
    /forbidden field "backend"/,
  );
  await assert.rejects(
    () => runtime.startAttempt({ ...base, spec: { agent: "general", task: "x", cwd: other } }),
    /must equal the trusted source-local baseCwd/,
  );
  await assert.rejects(
    () => runtime.startAttempt({ ...base, spec: { agent: "general", task: "x", cwd, todos: ["#1"] } }),
    /forbidden field "todos"/,
  );
  assert.equal(resolves, 0);
});

test("production Fabric runtime refuses recursive Fabric and remote backends", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "teammate-fabric-source-"));
  for (const name of ["fabric", "remote-workers"]) {
    let starts = 0;
    const backend: TeammateBackend = {
      name,
      protocolVersion: 1,
      recoveryShape: "replay",
      capabilities: () => CAPABILITIES,
      async start() { starts += 1; throw new Error("must not start"); },
    };
    const registry: BackendRegistry = {
      async resolve() { return { backend, config: {}, capabilities: CAPABILITIES }; },
      async capabilitiesOf() { return CAPABILITIES; },
      listBackendNames() { return [name]; },
      defaultBackendName() { return name; },
    };
    await assert.rejects(
      () => createFabricTeammateRuntimePort({ backendRegistry: registry }).startAttempt({
        placement: placement(),
        spec: { agent: "general", task: "x", cwd },
        correlationId: "attempt-1",
        baseCwd: cwd,
        signal: new AbortController().signal,
      }),
      /refuses recursive backend/,
    );
    assert.equal(starts, 0);
  }
});

test("source model registry accepts canonical ids and unique adapter selectors at one wire identity", async () => {
  for (const requestedModel of ["pi/default", "openai/gpt-default"]) {
    const cwd = modelRegistryWorkspace({
      "pi/default": {
        modelId: "intrinsic/default",
        deployment: "source-local",
        selector: { kind: "adapter-model", value: "openai/gpt-default" },
        deploymentDefault: true,
      },
    });
    const recorded: TeammateRunSpec[] = [];
    (globalThis as typeof globalThis & Record<symbol, unknown>)[SOURCE_PROBE_KEY] = recorded;
    const attempt = await createFabricTeammateRuntimePort().startAttempt({
      placement: placement(),
      spec: { agent: "general", task: "source model", model: requestedModel, cwd },
      correlationId: "attempt-1",
      baseCwd: cwd,
      signal: new AbortController().signal,
    });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.backend, "source-local");
    assert.equal(recorded[0]?.model, "openai/gpt-default");
    assert.equal(attempt.acceptedModel, "openai/gpt-default");
    assert.equal((await attempt.outcome).result.model, "openai/gpt-default");
    delete (globalThis as typeof globalThis & Record<symbol, unknown>)[SOURCE_PROBE_KEY];
  }
});

test("source model registry rejects an adapter selector that is not globally unique", async () => {
  const cwd = modelRegistryWorkspace({
    "first/model": {
      modelId: "intrinsic/first",
      deployment: "first-local",
      selector: { kind: "adapter-model", value: "shared/selector" },
      deploymentDefault: true,
    },
    "second/model": {
      modelId: "intrinsic/second",
      deployment: "second-local",
      selector: { kind: "adapter-model", value: "shared/selector" },
      deploymentDefault: true,
    },
  });
  await assert.rejects(
    () => createFabricTeammateRuntimePort().startAttempt({
      placement: placement(),
      spec: { agent: "general", task: "ambiguous source model", model: "shared/selector", cwd },
      correlationId: "attempt-1",
      baseCwd: cwd,
      signal: new AbortController().signal,
    }),
    /selector "shared\/selector" is ambiguous.*"first\/model".*"second\/model"/,
  );
});

test("source backend registry rejects both direct-SSH transports before backend resolution", async () => {
  const registrations = [
    { module: "pi-maestro-backends/dsh", config: { mode: "ssh", host: "build-box", user: "ci" } },
    { module: "pi-maestro-teammate/v1/acp-cli", config: { mode: "ssh", sshHostRef: "managed-1" } },
  ];
  for (const registration of registrations) {
    const cwd = backendRegistryWorkspace(registration);
    await assert.rejects(
      () => createFabricTeammateRuntimePort().startAttempt({
        placement: placement(),
        spec: { agent: "general", task: "must stay source-local", cwd },
        correlationId: "attempt-1",
        baseCwd: cwd,
        signal: new AbortController().signal,
      }),
      /refuses non-local deployment "source-default" with transport "(?:dsh|acp)-direct-ssh"/,
    );
  }
});
