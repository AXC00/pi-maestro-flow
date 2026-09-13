import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendRunOptions, BackendCapabilities } from "pi-maestro-backend-core/v1/backend";
import type { TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import {
  FABRIC_BACKEND,
  dispatchFabricPlacementRegistrySync,
  dispatchRegistrySync,
  forgetBackendRegistryConfigSync,
} from "../src/backends/registry-host.ts";
import type { FabricBackendRouteResolver } from "pi-maestro-backends/fabric";
import { normalizeTeammateParams } from "../src/runs/execution-infra.ts";
import { runGraph, runSingleTeammate } from "../src/runs/execution.ts";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "teammate-fabric-agent-"));

const CAPABILITIES: BackendCapabilities = {
  outputSchema: "native", forkContext: "unsupported", modelSelection: "native", thinkingLevel: "native",
  todoBinding: "unsupported", toolFilter: "unsupported", steer: "native", followUp: "native", abort: "native",
};

/** A placement the Fabric contract accepts, bound to one route tuple. */
function placement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "fabric.placement.v1",
    placementId: "placement-1",
    routeId: "route-1",
    workspaceBindingId: "binding-1",
    endpointId: "agent-endpoint-1",
    connectionGeneration: 1,
    workspaceGeneration: 1,
    endpointGeneration: 1,
    requestedRole: "general",
    requestedTaskType: "development",
    deadlineAt: Date.now() + 60_000,
    ...overrides,
  };
}

function workspace(document: string): string {
  const root = mkdtempSync(join(tmpdir(), "teammate-fabric-"));
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi", "teammate-backends.json"), document, "utf-8");
  forgetBackendRegistryConfigSync(root);
  return root;
}

const extras = (): never => {
  throw new Error("no run is started in these tests");
};

const registryDocument = JSON.stringify({
  mode: "backend-registry",
  default: "pi-subprocess",
  backends: {
    "pi-subprocess": { module: "pi-subprocess" },
    [FABRIC_BACKEND]: { module: FABRIC_BACKEND },
  },
});

test("placement reaches the Fabric backend registration instead of the default", async () => {
  const root = workspace(registryDocument);
  let prepared = 0;
  const resolver: FabricBackendRouteResolver = {
    async prepare() {
      prepared += 1;
      throw new Error("prepare must not run during resolution");
    },
  };
  const registry = dispatchRegistrySync(root, extras, undefined, undefined, () => resolver);
  assert.notEqual(registry, undefined);

  const spec: TeammateRunSpec = {
    agent: "general",
    task: "inspect the remote workspace",
    backend: FABRIC_BACKEND,
    placement: placement() as never,
  };
  const resolved = await registry!.resolve(spec, spec.backend);
  assert.equal(resolved.backend.name, "fabric");
  assert.equal(prepared, 0, "resolution must not prepare a route");
  assert.deepEqual(resolved.backend.capabilities(resolved.config), {
    outputSchema: "native", forkContext: "unsupported", modelSelection: "native", thinkingLevel: "native",
    todoBinding: "unsupported", toolFilter: "unsupported", steer: "native", followUp: "native", abort: "native",
  });
  assert.equal(Object.keys(CAPABILITIES).length, Object.keys(resolved.backend.capabilities(resolved.config)).length);
});

test("a live provider overlays the reserved Fabric backend in legacy mode without persisting config", async () => {
  const root = workspace(JSON.stringify({
    mode: "legacy",
    default: "pi-subprocess",
    backends: { "pi-subprocess": { module: "pi-subprocess" } },
  }));
  let prepared = 0;
  const resolver: FabricBackendRouteResolver = {
    async prepare() { prepared += 1; throw new Error("prepare must not run during resolution"); },
  };
  const registry = dispatchFabricPlacementRegistrySync(root, extras, () => resolver);
  const resolved = await registry.resolve({
    agent: "general", task: "placed", backend: FABRIC_BACKEND, placement: placement() as never,
  }, FABRIC_BACKEND);
  assert.equal(resolved.backend.name, FABRIC_BACKEND);
  assert.equal(prepared, 0);
  assert.equal(dispatchRegistrySync(root, extras), undefined, "placement overlay must not change legacy behavior");
});

test("a conflicting operator Fabric registration is rejected instead of overwritten", () => {
  const root = workspace(JSON.stringify({
    mode: "backend-registry",
    default: "pi-subprocess",
    backends: { [FABRIC_BACKEND]: { module: "operator-fabric" } },
  }));
  const resolver: FabricBackendRouteResolver = {
    async prepare() { throw new Error("unused"); },
  };
  assert.throws(
    () => dispatchFabricPlacementRegistrySync(root, extras, () => resolver),
    /reserved for placed Fabric dispatches.*conflicting module "operator-fabric"/,
  );
});

test("a placed dispatch with no live provider fails closed before local execution", async () => {
  const root = workspace(JSON.stringify({
    mode: "legacy",
    default: "pi-subprocess",
    backends: { "pi-subprocess": { module: "pi-subprocess" } },
  }));
  const published: string[] = [];
  const result = await runSingleTeammate({
    agent: "general",
    task: "must remain remote",
    placement: placement() as never,
  }, {
    baseCwd: root,
    onResultPublished(value) { published.push(value.messages.at(-1)?.content ?? ""); },
  });
  assert.match(result.messages.at(-1)?.content ?? "", /no live Fabric route resolver provider/);
  assert.match(result.messages.at(-1)?.content ?? "", /refusing to run a placed task on this machine/);
  assert.equal(published.length, 1);
});

test("mixed legacy graph preflights placed and placementless tasks against their own registries", async () => {
  const root = workspace(JSON.stringify({
    mode: "legacy",
    default: "remote-default",
    backends: {
      "remote-default": {
        module: "remote-workers",
        config: { targetId: "beta", driver: "pi-rpc" },
      },
    },
  }));
  let prepared = 0;
  const resolver: FabricBackendRouteResolver = {
    async prepare() { prepared += 1; throw new Error("unknown agents must fail before route preparation"); },
  };
  const results = await runGraph([
    { agent: "missing-local-agent", prompt: "legacy local" },
    { agent: "missing-placed-agent", prompt: "Fabric placed", placement: placement() as never },
  ], 2, {
    baseCwd: root,
    fabricRouteResolverOf: () => resolver,
  });

  assert.equal(results.length, 2);
  for (const result of results) {
    assert.match(result.messages.at(-1)?.content ?? "", /Unknown teammate agent/);
    assert.doesNotMatch(result.messages.at(-1)?.content ?? "", /backend could not be resolved for this graph/);
  }
  assert.equal(prepared, 0);
});

test("a dispatch without Fabric wiring refuses the Fabric backend by name", async () => {
  const root = workspace(registryDocument);
  const registry = dispatchRegistrySync(root, extras, undefined, undefined, undefined);
  assert.notEqual(registry, undefined);

  await assert.rejects(
    () => registry!.resolve({ agent: "general", task: "placed", backend: FABRIC_BACKEND }, FABRIC_BACKEND),
    (error: Error) => {
      // The registry reports the unloadable registration and keeps the reason as
      // its cause; the point of the check is that the dispatch refuses instead
      // of falling back to a local backend.
      assert.match(error.message, /could not be loaded/);
      const cause = (error as Error & { cause?: unknown }).cause;
      assert.match(cause instanceof Error ? cause.message : String(cause), /needs the host's Fabric route resolver/);
      assert.match(cause instanceof Error ? cause.message : String(cause), /cannot run on this machine/);
      return true;
    },
  );
});

test("normalization carries a placement through and refuses the shapes it cannot serve", () => {
  const carried = normalizeTeammateParams({
    tasks: [{ prompt: "placed task", placement: placement() as never }],
  });
  assert.equal(carried.error, undefined);
  assert.equal(carried.tasks[0]?.placement?.placementId, "placement-1");

  const invalid = normalizeTeammateParams({
    tasks: [{ prompt: "placed task", placement: placement({ version: "fabric.placement.v2" }) as never }],
  });
  assert.match(invalid.error ?? "", /invalid Fabric placement/);

  const expired = normalizeTeammateParams({
    tasks: [{ prompt: "placed task", placement: placement({ deadlineAt: Date.now() - 1 }) as never }],
  });
  assert.match(expired.error ?? "", /invalid Fabric placement/);

  // Origin Todo ids are origin authority: a placed Endpoint cannot serve them,
  // and accepting the binding would leave the queue stalled at in_progress.
  const withTodo = normalizeTeammateParams({
    tasks: [{ prompt: "placed task", placement: placement() as never, todo: ["#12"] }],
  });
  assert.match(withTodo.error ?? "", /binds Todo ids together with a Fabric placement/);
});

test("a task without a placement normalizes exactly as before", () => {
  const plain = normalizeTeammateParams({ tasks: [{ prompt: "local task", model: "m-1" }] });
  assert.equal(plain.error, undefined);
  assert.equal(plain.tasks[0]?.placement, undefined);
  assert.equal(plain.tasks[0]?.model, "m-1");
});

function withBackendRunOptions(): BackendRunOptions {
  return { correlationId: "corr-1", baseCwd: process.cwd(), host: {}, config: {} };
}

test("the Fabric backend refuses a spec that carries no placement", async () => {
  const root = workspace(registryDocument);
  const resolver: FabricBackendRouteResolver = {
    async prepare() {
      throw new Error("a placementless spec must not reach preparation");
    },
  };
  const registry = dispatchRegistrySync(root, extras, undefined, undefined, () => resolver);
  const resolved = await registry!.resolve({ agent: "general", task: "x", backend: FABRIC_BACKEND }, FABRIC_BACKEND);
  await assert.rejects(
    () => resolved.backend.start({ agent: "general", task: "x" }, withBackendRunOptions()),
    /requires an explicit placement/,
  );
});
