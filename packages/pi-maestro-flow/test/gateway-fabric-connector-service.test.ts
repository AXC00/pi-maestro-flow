import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { BackendCapabilities } from "pi-maestro-backend-core/v1/backend";
import type { FabricConnectorRuntimeOptions } from "../src/gateway/fabric/connector-runtime.ts";
import {
  FabricConnectorService,
  type FabricConnectorRuntimePort,
  type FabricDeviceRelayHandlerFactory,
} from "../src/gateway/fabric/connector-service.ts";
import type {
  FabricDeviceSourceAvailabilityProvider,
  FabricDeviceSourceRestrictionsProvider,
} from "../src/gateway/fabric/connector-inventory.ts";
import type { FabricConnectorConfigV1 } from "../src/gateway/fabric/connector-config.ts";
import { GatewayPolicy } from "../src/gateway/policy.ts";
import { WorkspaceRegistry } from "../src/gateway/workspace-registry.ts";

interface FakeRuntime extends FabricConnectorRuntimePort {
  options: FabricConnectorRuntimeOptions;
  starts: number;
  stops: number;
  resolveStart?: () => void;
  emitConnected(generation?: number): void;
  emitReady(generation?: number): void;
  emitClosed(): void;
}

interface FixtureOverrides {
  resolveSourceAvailability?: FabricDeviceSourceAvailabilityProvider;
  resolveSourceRestrictions?: FabricDeviceSourceRestrictionsProvider;
  deviceRelayHandlerFactory?: FabricDeviceRelayHandlerFactory;
}

async function fixture(t: TestContext, deferredStart = false, cleanupTimeoutMs?: number, overrides: FixtureOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "connector-service-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, ".pi"), { recursive: true });
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = join(root, ".pi", "key.pem");
  await writeFile(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
  const registry = new WorkspaceRegistry({ path: join(root, "registry.json") });
  const workspace = await registry.register(join(root, "workspace-secret-path"), { mode: "permanent", id: "local-workspace-1" });
  const policy = new GatewayPolicy({ workspaceRoot: root, registry, workspaces: [] });
  const config: FabricConnectorConfigV1 = {
    version: "fabric.connector-config.v1", enabled: true,
    hubUrl: "wss://hub.example.test/fabric/v1/connector", connectorId: "connector-1", keyId: "key-1", audience: "fabric",
    credentialGeneration: 1, privateKeyPath,
    devices: [{ deviceId: "device-1", connectorId: "connector-1", label: "Device", connectionMode: "https", enabled: true, revision: 1 }],
    localDeviceId: "device-1", workspaceIds: [workspace.id], revision: 1,
  };
  const configPath = join(root, ".pi", "fabric-connector.json");
  await writeFile(configPath, JSON.stringify(config));
  const runtimes: FakeRuntime[] = [];
  const service = new FabricConnectorService({
    root, registry, policy, owner: { ownerToken: "owner-token-123456", ownerEpoch: 1 }, initialConfig: config,
    assertOwner: async (owner) => { assert.equal(owner.ownerEpoch, 1); },
    refreshIntervalMs: 60_000,
    ...(cleanupTimeoutMs === undefined ? {} : { cleanupTimeoutMs }),
    ...(overrides.resolveSourceAvailability === undefined ? {} : { resolveSourceAvailability: overrides.resolveSourceAvailability }),
    ...(overrides.resolveSourceRestrictions === undefined ? {} : { resolveSourceRestrictions: overrides.resolveSourceRestrictions }),
    ...(overrides.deviceRelayHandlerFactory === undefined ? {} : { deviceRelayHandlerFactory: overrides.deviceRelayHandlerFactory }),
    runtimeFactory: (options) => {
      let resolveStart: (() => void) | undefined;
      const runtime: FakeRuntime = {
        options, state: "connecting", connectionGeneration: 0, starts: 0, stops: 0,
        start(): Promise<void> {
          runtime.starts += 1;
          if (!deferredStart) {
            runtime.emitConnected(runtimes.length);
            runtime.emitReady(runtimes.length);
            return Promise.resolve();
          }
          return new Promise<void>((resolve) => { resolveStart = resolve; runtime.resolveStart = resolve; });
        },
        async stop(): Promise<void> { runtime.stops += 1; },
        emitConnected(generation = 1): void { options.onConnected?.({ connectionId: `connection-${generation}`, connectionGeneration: generation }); },
        emitReady(generation = 1): void { options.onReady?.({ connectionId: `connection-${generation}`, connectionGeneration: generation, advertisementRevision: options.advertisementOf!().advertisementRevision }); },
        emitClosed(): void { options.onClosed?.("closed"); },
        resolveStart,
      };
      runtimes.push(runtime);
      return runtime;
    },
  });
  t.after(async () => { await service.shutdown().catch(() => undefined); });
  return { root, registry, workspace, config, service, runtimes };
}

test("start is single-flight, reaches connected/ready, and passes only a signer plus full snapshot", async (t) => {
  const value = await fixture(t, true);
  const first = value.service.start();
  const second = value.service.start();
  assert.equal(first, second);
  while (value.runtimes.length === 0) await new Promise((resolve) => setImmediate(resolve));
  const runtime = value.runtimes[0]!;
  assert.equal(runtime.starts, 1);
  assert.equal("privateKey" in runtime.options, false);
  assert.equal(typeof runtime.options.sign, "function");
  const payload = runtime.options.advertisementOf!().payload as Record<string, unknown>;
  assert.equal(Array.isArray(payload.devices), true);
  assert.equal(Array.isArray(payload.workspaces), true);
  assert.deepEqual(payload.endpoints, []);
  assert.deepEqual(payload.capabilities, []);
  runtime.emitConnected(7);
  assert.equal(value.service.status().state, "connected");
  runtime.emitReady(7);
  runtime.resolveStart!();
  assert.equal((await first).state, "ready");
  assert.equal((await second).connectionGeneration, 7);
});

test("stop fences stale callbacks and cleans only the exact runtime", async (t) => {
  const value = await fixture(t);
  await value.service.start();
  const old = value.runtimes[0]!;
  assert.equal((await value.service.stop()).state, "stopped");
  assert.equal(old.stops, 1);
  old.emitReady(99);
  old.emitClosed();
  assert.equal(value.service.status().state, "stopped");

  await value.service.start();
  const successor = value.runtimes[1]!;
  old.emitClosed();
  assert.equal(value.service.status().state, "ready");
  assert.equal(successor.stops, 0);
  await value.service.stop();
  assert.equal(successor.stops, 1);
});

test("inventory change stops the current generation and reconnects with a fresh full snapshot", async (t) => {
  const value = await fixture(t);
  await value.service.start();
  const first = value.runtimes[0]!;
  assert.equal(((first.options.advertisementOf!().payload as Record<string, unknown>).workspaces as unknown[]).length, 1);
  await value.registry.unregister(value.workspace.id);
  await value.service.refresh();
  assert.equal(first.stops, 1);
  assert.equal(value.runtimes.length, 2);
  const second = value.runtimes[1]!;
  assert.deepEqual((second.options.advertisementOf!().payload as Record<string, unknown>).workspaces, []);
  assert.equal(value.service.status().state, "ready");
});

test("refresh resolves source availability and restrictions for every generation", async (t) => {
  const capabilities: BackendCapabilities = {
    outputSchema: "native", forkContext: "native", modelSelection: "native", thinkingLevel: "native",
    todoBinding: "native", toolFilter: "native", steer: "native", followUp: "native", abort: "native",
  };
  let availability = {
    roles: ["general"], taskTypes: ["development"], models: ["provider/model"],
    backends: [{ name: "source-local", capabilities }],
  };
  let restrictions = {
    roles: ["general"], taskTypes: ["development"], models: ["provider/model"],
    backends: ["source-local"], maxConcurrency: 2,
  };
  const value = await fixture(t, false, undefined, {
    resolveSourceAvailability: () => structuredClone(availability),
    resolveSourceRestrictions: () => structuredClone(restrictions),
  });
  await value.service.start();
  const endpointsOf = (index: number): unknown[] =>
    (value.runtimes[index]!.options.advertisementOf!().payload as Record<string, unknown>).endpoints as unknown[];
  assert.equal(endpointsOf(0).length, 1);

  availability = { ...availability, backends: [] };
  await value.service.refresh();
  assert.deepEqual(endpointsOf(1), [], "removed source backend remained advertised");

  availability = { ...availability, backends: [{ name: "source-local", capabilities }] };
  await value.service.refresh();
  assert.equal(endpointsOf(2).length, 1);

  restrictions = { ...restrictions, backends: [] };
  await value.service.refresh();
  assert.deepEqual(endpointsOf(3), [], "removed source restriction remained advertised");
});

test("unexpected runtime close fences and bounded-closes the exact relay before a successor", async (t) => {
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
  const handlers: Array<{ closes: number; close(): Promise<void> }> = [];
  const value = await fixture(t, false, 1_000, {
    deviceRelayHandlerFactory: () => {
      const index = handlers.length;
      const handler = {
        closes: 0,
        async close(): Promise<void> {
          handler.closes += 1;
          if (index === 0) await closeGate;
        },
      };
      handlers.push(handler);
      return handler;
    },
  });
  await value.service.start();
  const predecessor = value.runtimes[0]!;
  predecessor.emitClosed();
  assert.equal(value.service.status().state, "failed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handlers[0]!.closes, 1);
  await assert.rejects(() => value.service.start(), /refresh still settling|already started/u);
  releaseClose();
  await value.service.stop();
  assert.equal(predecessor.stops, 1);
  await value.service.start();
  predecessor.emitClosed();
  assert.equal(value.service.status().state, "ready");
  assert.equal(handlers[1]!.closes, 0, "stale close callback closed the successor relay");
});

test("start remains blocked until a predecessor refresh settles", async (t) => {
  let calls = 0;
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const value = await fixture(t, false, undefined, {
    resolveSourceAvailability: async () => {
      calls += 1;
      if (calls === 2) {
        await refreshGate;
        throw new Error("stale refresh failed");
      }
      return undefined;
    },
  });
  await value.service.start();
  const refreshing = value.service.refresh();
  while (calls < 2) await new Promise((resolve) => setImmediate(resolve));
  const stopping = value.service.stop();
  await assert.rejects(() => value.service.start(), /refresh still settling|already started/u);
  releaseRefresh();
  await refreshing;
  await stopping;
  await value.service.start();
  assert.equal(value.service.status().state, "ready");
  assert.equal(value.runtimes.length, 2);
});

test("stop joins refresh-detached runtime cleanup before reaching stopped", async (t) => {
  const value = await fixture(t);
  await value.service.start();
  const first = value.runtimes[0]!;
  let releaseStop!: () => void;
  const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
  first.stop = async () => { first.stops += 1; await stopGate; };
  await value.registry.unregister(value.workspace.id);
  const refreshing = value.service.refresh();
  while (first.stops === 0) await new Promise((resolve) => setImmediate(resolve));
  const stopping = value.service.stop();
  let settled = false;
  void stopping.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(value.runtimes.length, 1);
  releaseStop();
  await refreshing;
  assert.equal((await stopping).state, "stopped");
  assert.equal(value.runtimes.length, 1);
});

test("refresh cleanup rejection becomes terminal failed and blocks a successor", async (t) => {
  const value = await fixture(t);
  await value.service.start();
  const first = value.runtimes[0]!;
  first.stop = async () => { first.stops += 1; throw new Error("cleanup rejected"); };
  await value.registry.unregister(value.workspace.id);
  await assert.rejects(() => value.service.refresh(), /runtime cleanup failed/u);
  assert.equal(value.service.status().state, "failed");
  assert.equal(value.service.status().running, false);
  await assert.rejects(() => value.service.start(), /already started or stopping/u);
  assert.equal(value.runtimes.length, 1);
});

test("refresh cleanup timeout becomes terminal failed and cannot publish a successor", async (t) => {
  const value = await fixture(t, false, 20);
  await value.service.start();
  const first = value.runtimes[0]!;
  first.stop = async () => { first.stops += 1; await new Promise<void>(() => undefined); };
  await value.registry.unregister(value.workspace.id);
  await assert.rejects(() => value.service.refresh(), /runtime cleanup failed/u);
  assert.equal(value.service.status().state, "failed");
  assert.equal(value.service.status().running, false);
  assert.equal(value.runtimes.length, 1);
});

test("credential read failure is redacted and never creates a runtime", async (t) => {
  const value = await fixture(t);
  await rm(value.config.privateKeyPath);
  await assert.rejects(() => value.service.start(), /credentials could not be loaded/u);
  assert.equal(value.runtimes.length, 0);
  assert.equal(value.service.status().state, "failed");
  assert.doesNotMatch(value.service.status().reason ?? "", /key\.pem|connector-service-/u);
});

test("shutdown synchronously rejects successor publication", async (t) => {
  const value = await fixture(t, true);
  const starting = value.service.start();
  while (value.runtimes.length === 0) await new Promise((resolve) => setImmediate(resolve));
  const runtime = value.runtimes[0]!;
  const shutdown = value.service.shutdown();
  assert.equal(value.service.status().state, "stopped");
  runtime.emitReady(8);
  assert.equal(value.service.status().state, "stopped");
  await shutdown;
  runtime.resolveStart!();
  await assert.rejects(starting, /fenced|cancelled/u);
  await assert.rejects(() => value.service.start(), /shutting down/u);
});
