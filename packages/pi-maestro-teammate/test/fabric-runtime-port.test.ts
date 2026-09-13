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
import type {
  FabricRouteResolverProviderAcquireRequest,
  FabricTeammateRuntimePort,
} from "../src/public/v1/fabric-runtime.ts";
import {
  createFabricTeammateRuntimePort,
  getFabricRouteResolverProviderBinding,
  getFabricTeammateRuntimePort,
  registerFabricRouteResolverProvider,
  registerFabricTeammateRuntimePort,
} from "../src/public/v1/fabric-runtime.ts";
import {
  forgetBackendRegistryConfigSync,
  modelRegistryPairSync,
} from "../src/backends/registry-host.ts";
import { runSingleTeammate } from "../src/runs/execution.ts";

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

interface SourceProbeOptions {
  backendName?: string;
  capabilities?: unknown;
}

function writeModelRegistryManifest(
  root: string,
  models: Record<string, Record<string, unknown>>,
): void {
  const modulePath = join(root, "source-probe.mjs");
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
}

function modelRegistryWorkspace(
  models: Record<string, Record<string, unknown>>,
  options: SourceProbeOptions = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "teammate-fabric-source-model-"));
  mkdirSync(join(root, ".pi"), { recursive: true });
  const modulePath = join(root, "source-probe.mjs");
  writeFileSync(modulePath, `
const key = Symbol.for("pi-maestro.test.fabric-source-models");
const capabilities = ${JSON.stringify(options.capabilities ?? CAPABILITIES)};
export default {
  name: ${JSON.stringify(options.backendName ?? "local-source-probe")},
  protocolVersion: 1,
  recoveryShape: "replay",
  capabilities: () => capabilities,
  async start(spec, options) {
    globalThis[key].push({ ...spec });
    const settled = {
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
    };
    options.onTurnComplete?.(settled.result, "completed");
    return {
      outcome: Promise.resolve(settled),
      send: () => false,
      abort: () => undefined,
    };
  },
};
`, "utf8");
  writeModelRegistryManifest(root, models);
  forgetBackendRegistryConfigSync(root);
  return root;
}

function availabilityWorkspace(
  registration: Record<string, unknown> = { module: "pi-subprocess" },
  selector: Record<string, unknown> = { kind: "adapter-model", value: "provider/model" },
): string {
  const root = mkdtempSync(join(tmpdir(), "teammate-fabric-availability-"));
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi", "teammate-backends.json"), JSON.stringify({
    version: 2,
    mode: "model-registry",
    default: "source-local",
    defaultModel: "provider/model",
    backends: { "source-local": registration },
    models: {
      "provider/model": {
        modelId: "provider/model",
        deployment: "source-local",
        selector,
        deploymentDefault: true,
      },
    },
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

test("Fabric source availability and execution agree on the loaded backend identity", async () => {
  const cwd = modelRegistryWorkspace({
    "fixture/model": {
      modelId: "fixture/intrinsic",
      deployment: "source-local",
      selector: { kind: "adapter-model", value: "fixture/adapter" },
      deploymentDefault: true,
    },
  });
  const runtime = createFabricTeammateRuntimePort();
  const availability = await runtime.getSourceAvailability?.({ cwd });
  assert.ok(availability);
  assert.ok(availability.roles.includes("general"));
  assert.ok(availability.taskTypes.includes("development"));
  assert.deepEqual(availability.models, ["fixture/model"]);
  assert.deepEqual(availability.backends, [{ name: "local-source-probe", capabilities: CAPABILITIES }]);

  const recorded: TeammateRunSpec[] = [];
  (globalThis as typeof globalThis & Record<symbol, unknown>)[SOURCE_PROBE_KEY] = recorded;
  try {
    const attempt = await runtime.startAttempt({
      placement: placement(),
      spec: { agent: "general", task: "source identity", model: "fixture/model", cwd },
      correlationId: "attempt-backend-identity",
      baseCwd: cwd,
      signal: new AbortController().signal,
    });
    assert.equal(attempt.acceptedBackend, availability.backends[0]?.name);
    assert.deepEqual(attempt.acceptedCapabilities, availability.backends[0]?.capabilities);
  } finally {
    delete (globalThis as typeof globalThis & Record<symbol, unknown>)[SOURCE_PROBE_KEY];
  }
});

test("Fabric source availability fails closed without a model registry or a loadable backend", async () => {
  const legacy = mkdtempSync(join(tmpdir(), "teammate-fabric-availability-legacy-"));
  assert.equal(
    await createFabricTeammateRuntimePort().getSourceAvailability?.({ cwd: legacy }),
    undefined,
  );
  const invalid = availabilityWorkspace({ module: "pi-subprocess", config: { unsupportedField: true } });
  assert.equal(
    await createFabricTeammateRuntimePort().getSourceAvailability?.({ cwd: invalid }),
    undefined,
  );
});

test("Fabric source availability rejects reserved identities exported by custom modules", async () => {
  for (const backendName of ["fabric", "remote-workers"]) {
    const cwd = modelRegistryWorkspace({
      "fixture/model": {
        modelId: "fixture/intrinsic",
        deployment: "custom-local",
        selector: { kind: "adapter-model", value: "fixture/adapter" },
        deploymentDefault: true,
      },
    }, { backendName });
    assert.equal(
      await createFabricTeammateRuntimePort().getSourceAvailability?.({ cwd }),
      undefined,
    );
  }
});

test("Fabric source availability filters adapter-model routes unsupported by the loaded backend", async () => {
  const cwd = modelRegistryWorkspace({
    "fixture/default": {
      modelId: "fixture/default",
      deployment: "source-local",
      selector: { kind: "deployment-default" },
      deploymentDefault: true,
    },
    "fixture/adapter": {
      modelId: "fixture/adapter",
      deployment: "source-local",
      selector: { kind: "adapter-model", value: "runtime/adapter" },
    },
  }, { capabilities: { ...CAPABILITIES, modelSelection: "unsupported" } });
  const availability = await createFabricTeammateRuntimePort().getSourceAvailability?.({ cwd });
  assert.ok(availability);
  assert.deepEqual(availability.models, ["fixture/default"]);
  assert.equal(availability.backends[0]?.capabilities.modelSelection, "unsupported");
});

test("Fabric source availability refreshes valid and invalid model-registry edits", async () => {
  const first = {
    "fixture/first": {
      modelId: "fixture/first",
      deployment: "source-local",
      selector: { kind: "adapter-model", value: "runtime/first" },
      deploymentDefault: true,
    },
  };
  const cwd = modelRegistryWorkspace(first);
  const runtime = createFabricTeammateRuntimePort();
  assert.deepEqual((await runtime.getSourceAvailability?.({ cwd }))?.models, ["fixture/first"]);

  const second = {
    "fixture/second": {
      modelId: "fixture/second",
      deployment: "source-local",
      selector: { kind: "adapter-model", value: "runtime/second" },
      deploymentDefault: true,
    },
  };
  writeModelRegistryManifest(cwd, second);
  assert.deepEqual((await runtime.getSourceAvailability?.({ cwd }))?.models, ["fixture/second"]);

  writeFileSync(join(cwd, ".pi", "teammate-backends.json"), "{ invalid", "utf8");
  assert.equal(await runtime.getSourceAvailability?.({ cwd }), undefined);

  writeModelRegistryManifest(cwd, first);
  assert.deepEqual((await runtime.getSourceAvailability?.({ cwd }))?.models, ["fixture/first"]);
});

test("Fabric source availability refuses non-local and recursive routes", async () => {
  const routes = [
    {
      registration: { module: "pi-maestro-backends/dsh", config: { mode: "ssh", host: "build-box", user: "ci" } },
      selector: { kind: "adapter-model", value: "provider/model" },
    },
    {
      registration: { module: "pi-maestro-teammate/v1/acp-cli", config: { mode: "ssh", sshHostRef: "managed-1" } },
      selector: { kind: "adapter-model", value: "provider/model" },
    },
    {
      registration: { module: "remote-workers", config: { driver: "pi-rpc", targetId: "remote-1" } },
      selector: { kind: "fixed" },
    },
    {
      registration: { module: "fabric" },
      selector: { kind: "adapter-model", value: "provider/model" },
    },
  ];
  for (const route of routes) {
    assert.equal(
      await createFabricTeammateRuntimePort().getSourceAvailability?.({
        cwd: availabilityWorkspace(route.registration, route.selector),
      }),
      undefined,
    );
  }
});

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

test("Fabric resolver provider registration rejects live overlap", () => {
  const resolver = { async prepare(): Promise<never> { throw new Error("unused"); } };
  const first = registerFabricRouteResolverProvider(() => resolver, { ownerId: "owner-overlap-1" });
  try {
    assert.throws(
      () => registerFabricRouteResolverProvider(() => resolver, { ownerId: "owner-overlap-2" }),
      /generation .*owner-overlap-1.*still live/,
    );
  } finally {
    first.dispose();
  }
});

test("Fabric resolver stale disposer cannot remove a successor generation", () => {
  const resolver = { async prepare(): Promise<never> { throw new Error("unused"); } };
  const first = registerFabricRouteResolverProvider(() => resolver, { ownerId: "owner-stale-1" });
  first();
  const second = registerFabricRouteResolverProvider(() => resolver, { ownerId: "owner-stale-2" });
  try {
    assert.ok(second.generation > first.generation);
    first.dispose();
    const binding = getFabricRouteResolverProviderBinding();
    assert.equal(binding?.generation, second.generation);
    assert.equal(binding?.ownerId, "owner-stale-2");
  } finally {
    second.dispose();
  }
});

test("Fabric resolver acquisition carries identity and stale release stays with its owner", async () => {
  const resolver = { async prepare(): Promise<never> { throw new Error("unused"); } };
  const requests: FabricRouteResolverProviderAcquireRequest[] = [];
  let firstReleases = 0;
  let secondReleases = 0;
  const first = registerFabricRouteResolverProvider({
    acquire(request) {
      requests.push(request);
      return { resolver, release() { firstReleases += 1; } };
    },
  }, { ownerId: "owner-lease-1" });
  const binding = getFabricRouteResolverProviderBinding();
  assert.ok(binding);
  const lease = await binding.acquire({
    correlationId: "correlation-lease-1",
    placement: placement(),
  }, new AbortController().signal);
  assert.ok(lease);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.correlationId, "correlation-lease-1");
  assert.equal(requests[0]?.placement.placementId, "placement-1");
  assert.equal(requests[0]?.generation, first.generation);
  assert.equal(requests[0]?.ownerId, "owner-lease-1");

  first.dispose();
  const second = registerFabricRouteResolverProvider({
    acquire() { return { resolver, release() { secondReleases += 1; } }; },
  }, { ownerId: "owner-lease-2" });
  try {
    await lease.release();
    await lease.release();
    assert.equal(firstReleases, 1);
    assert.equal(secondReleases, 0, "stale release reached the successor provider");
    assert.equal(getFabricRouteResolverProviderBinding()?.generation, second.generation);
  } finally {
    second.dispose();
  }
});

test("placed model-registry dispatch sends canonical registration ids for every selector kind", async () => {
  const models = {
    "fixture/adapter": {
      modelId: "fixture/adapter-intrinsic",
      deployment: "dep-adapter",
      selector: { kind: "adapter-model", value: "runtime/adapter" },
      deploymentDefault: true,
    },
    "fixture/default": {
      modelId: "fixture/default-intrinsic",
      deployment: "dep-default",
      selector: { kind: "deployment-default" },
      deploymentDefault: true,
    },
    "fixture/fixed": {
      modelId: "fixture/fixed-intrinsic",
      deployment: "dep-fixed",
      selector: { kind: "fixed" },
      deploymentDefault: true,
    },
  };
  const cwd = modelRegistryWorkspace(models);
  const module = pathToFileURL(join(cwd, "source-probe.mjs")).href;
  writeFileSync(join(cwd, ".pi", "teammate-backends.json"), JSON.stringify({
    version: 2,
    mode: "model-registry",
    default: "dep-adapter",
    defaultModel: "fixture/adapter",
    backends: {
      "dep-adapter": { module },
      "dep-default": { module },
      "dep-fixed": { module: "remote-workers", config: { driver: "pi-rpc", targetId: "remote-1" } },
    },
    models,
  }), "utf8");
  const authority = modelRegistryPairSync(cwd)?.dispatch;
  assert.ok(authority);

  const wireSpecs: TeammateRunSpec[] = [];
  const backend: TeammateBackend = {
    name: "origin-fabric-probe",
    protocolVersion: 1,
    recoveryShape: "replay",
    capabilities: () => CAPABILITIES,
    async start(spec, options) {
      wireSpecs.push({ ...spec });
      return {
        outcome: Promise.resolve({
          result: { ...result(cwd), model: spec.model ?? "missing", correlationId: options.correlationId },
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
  const registry: BackendRegistry = {
    async resolve(_spec, requestedBackend) {
      assert.equal(requestedBackend, "fabric");
      return { backend, config: {}, capabilities: CAPABILITIES };
    },
    async capabilitiesOf() { return CAPABILITIES; },
    listBackendNames() { return ["fabric"]; },
    defaultBackendName() { return "fabric"; },
  };

  for (const model of Object.keys(models)) {
    const dispatched = await runSingleTeammate({
      agent: "general",
      task: `dispatch ${model}`,
      model,
      placement: placement(),
    }, {
      baseCwd: cwd,
      backendRegistry: registry,
      modelRegistryAuthority: authority,
      authorizeRemoteModelDispatch: () => true,
      fabricRouteResolverOf: () => ({
        async prepare() { throw new Error("injected registry owns the route"); },
      }),
      enableRetryBackoff: false,
    });
    assert.equal(dispatched.exitCode, 0);
    assert.equal(dispatched.model, model);
  }
  assert.deepEqual(wireSpecs.map((spec) => ({ backend: spec.backend, model: spec.model })), [
    { backend: "fabric", model: "fixture/adapter" },
    { backend: "fabric", model: "fixture/default" },
    { backend: "fabric", model: "fixture/fixed" },
  ]);
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

test("source model registry keeps selector translation private and accepts canonical wire identity", async () => {
  const cwd = modelRegistryWorkspace({
    "fixture/model": {
      modelId: "fixture/intrinsic",
      deployment: "source-local",
      selector: { kind: "adapter-model", value: "fixture/adapter" },
      deploymentDefault: true,
    },
    "fixture/default": {
      modelId: "fixture/default-intrinsic",
      deployment: "source-local",
      selector: { kind: "deployment-default" },
    },
  });
  const recorded: TeammateRunSpec[] = [];
  const completedModels: string[] = [];
  (globalThis as typeof globalThis & Record<symbol, unknown>)[SOURCE_PROBE_KEY] = recorded;
  try {
    for (const [model, expectedLocalModel, expectedAcceptedModel] of [
      ["fixture/model", "fixture/adapter", "fixture/model"],
      ["fixture/default", undefined, "fixture/default"],
      [undefined, "fixture/adapter", "fixture/model"],
    ] as const) {
      const attempt = await createFabricTeammateRuntimePort().startAttempt({
        placement: placement(),
        spec: {
          agent: "general",
          task: "source model",
          ...(model === undefined ? {} : { model }),
          cwd,
        },
        correlationId: `attempt-${model?.replace("/", "-") ?? "default"}`,
        baseCwd: cwd,
        signal: new AbortController().signal,
        onTurnComplete: (settled) => completedModels.push(settled.model),
      });
      assert.equal(recorded.at(-1)?.backend, "source-local");
      assert.equal(recorded.at(-1)?.model, expectedLocalModel);
      assert.equal(attempt.acceptedModel, expectedAcceptedModel);
      assert.equal((await attempt.outcome).result.model, expectedAcceptedModel);
    }
    assert.equal(recorded.length, 3);
    assert.deepEqual(completedModels, ["fixture/model", "fixture/default", "fixture/model"]);
  } finally {
    delete (globalThis as typeof globalThis & Record<symbol, unknown>)[SOURCE_PROBE_KEY];
  }
});

test("Fabric source execution rejects malformed capability tables before backend start", async () => {
  for (const capabilities of [{}, { ...CAPABILITIES, extra: "native" }]) {
    const cwd = modelRegistryWorkspace({
      "fixture/model": {
        modelId: "fixture/intrinsic",
        deployment: "source-local",
        selector: { kind: "deployment-default" },
        deploymentDefault: true,
      },
    }, { capabilities });
    assert.equal(
      await createFabricTeammateRuntimePort().getSourceAvailability?.({ cwd }),
      undefined,
    );
    const recorded: TeammateRunSpec[] = [];
    (globalThis as typeof globalThis & Record<symbol, unknown>)[SOURCE_PROBE_KEY] = recorded;
    try {
      await assert.rejects(
        () => createFabricTeammateRuntimePort().startAttempt({
          placement: placement(),
          spec: { agent: "general", task: "reject malformed capabilities", model: "fixture/model", cwd },
          correlationId: "attempt-malformed-capabilities",
          baseCwd: cwd,
          signal: new AbortController().signal,
        }),
        /exactly the nine valid BackendCapabilities entries/,
      );
      assert.equal(recorded.length, 0);
    } finally {
      delete (globalThis as typeof globalThis & Record<symbol, unknown>)[SOURCE_PROBE_KEY];
    }
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
