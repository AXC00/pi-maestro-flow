import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GatewayTunnelExit, GatewayTunnelProvider, GatewayTunnelStartResult } from "../src/gateway/tunnel/contracts.ts";
import { GatewayTunnelProcessOwner, gatewayTunnelInvocationDigest } from "../src/gateway/tunnel/process-owner.ts";
import { GatewayTunnelStateConflictError, GatewayTunnelStateStore } from "../src/gateway/tunnel/state-store.ts";
import { GatewayTunnelManager } from "../src/gateway/tunnel/provider.ts";
import { GatewayTunnelSupervisor } from "../src/gateway/tunnel/supervisor.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface FakeHarness {
  supervisor: GatewayTunnelSupervisor;
  starts: number;
  stops: number;
  exits: Array<ReturnType<typeof deferred<GatewayTunnelExit>>>;
  deadlines: number[];
  observations: Map<number, { alive: boolean; executableRealpath?: string; processStartIdentity?: string; invocationDigest?: string }>;
}

async function harness(root: string, options: { maxRestarts?: number; terminalProbe?: boolean } = {}): Promise<FakeHarness> {
  const executable = "/fake/provider-tunnel";
  const observations = new Map<number, { alive: boolean; executableRealpath?: string; processStartIdentity?: string; invocationDigest?: string }>();
  const exits: Array<ReturnType<typeof deferred<GatewayTunnelExit>>> = [];
  const deadlines: number[] = [];
  let starts = 0;
  let stops = 0;
  const provider: GatewayTunnelProvider = {
    name: "fake",
    async doctor(context) { deadlines.push(context.deadlineAt); return { ok: true }; },
    async start(context): Promise<GatewayTunnelStartResult> {
      deadlines.push(context.deadlineAt);
      starts += 1;
      const pid = 10_000 + starts;
      const args = ["serve", `--generation=${starts}`];
      const processStartIdentity = `boot:${starts}`;
      observations.set(pid, { alive: true, executableRealpath: executable, processStartIdentity, invocationDigest: gatewayTunnelInvocationDigest(executable, args) });
      const exit = deferred<GatewayTunnelExit>();
      exits.push(exit);
      return { pid, executablePath: executable, args, processStartIdentity, exited: exit.promise };
    },
    async probe(context) { deadlines.push(context.deadlineAt); return options.terminalProbe ? { ready: false, terminal: true, detail: "not ready" } : { ready: true, endpoint: "https://tunnel.invalid" }; },
    async stop(context, identity) {
      deadlines.push(context.deadlineAt);
      stops += 1;
      const observed = observations.get(identity.pid);
      if (observed) observed.alive = false;
    },
  };
  const stateStore = new GatewayTunnelStateStore({ path: join(root, "fake.json"), provider: "fake" });
  const processOwner = new GatewayTunnelProcessOwner({ inspect: async (pid) => observations.get(pid) ?? { alive: false } });
  const supervisor = new GatewayTunnelSupervisor({
    provider,
    stateStore,
    processOwner,
    restartBudget: { maxRestarts: options.maxRestarts ?? 1, windowMs: 10_000 },
    canonicalizeExecutable: async (path) => path,
  });
  return {
    supervisor,
    exits,
    deadlines,
    observations,
    get starts() { return starts; },
    get stops() { return stops; },
  };
}

test("double start is single-flight and persists separated desired/observed identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-tunnel-supervisor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = await harness(root);
  const [first, second] = await Promise.all([fake.supervisor.start(), fake.supervisor.start()]);
  assert.equal(fake.starts, 1);
  assert.equal(first.generation, 1);
  assert.deepEqual(second, first);
  assert.equal(first.desiredState, "running");
  assert.equal(first.observed.phase, "ready");
  assert.equal(first.executableRealpath, "/fake/provider-tunnel");
  assert.match(first.processStartIdentity!, /^boot:/u);
  assert.match(first.invocationDigest!, /^[a-f0-9]{64}$/u);
  assert.ok(first.ownerToken.length >= 16);
});

test("stale generations and PID reuse are fenced before stop", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-tunnel-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = await harness(root);
  const ready = await fake.supervisor.start();
  await assert.rejects(() => fake.supervisor.stop({ expectedGeneration: ready.generation + 1 }), GatewayTunnelStateConflictError);
  const observed = fake.observations.get(ready.pid!)!;
  observed.processStartIdentity = "reused:later";
  await assert.rejects(() => fake.supervisor.stop({ expectedGeneration: ready.generation }), /start_identity_mismatch/u);
  assert.equal(fake.stops, 0, "an unverified PID is never handed to provider.stop");
  const failed = await fake.supervisor.status();
  assert.equal(failed?.desiredState, "stopped", "explicit stop fences restart before ownership verification");
  assert.equal(failed?.observed.phase, "failed");
});

test("unexpected exits restart only within the hard crash budget", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-tunnel-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = await harness(root, { maxRestarts: 1 });
  await fake.supervisor.start();
  fake.exits[0]!.resolve({ code: 1 });
  await until(() => fake.starts === 2);
  assert.equal((await fake.supervisor.status())?.generation, 2);
  fake.exits[1]!.resolve({ code: 2 });
  await until(async () => (await fake.supervisor.status())?.observed.phase === "failed");
  assert.equal(fake.starts, 2, "the second crash exhausts a one-restart budget");
  assert.match((await fake.supervisor.status())?.observed.detail ?? "", /budget exhausted/u);
});

test("explicit stop sets desired=stopped before exit and suppresses auto-restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-tunnel-explicit-stop-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const fake = await harness(root);
  const ready = await fake.supervisor.start();
  const stopped = await fake.supervisor.stop({ expectedGeneration: ready.generation });
  fake.exits[0]!.resolve({ code: 0 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.starts, 1);
  assert.equal(stopped.desiredState, "stopped");
  assert.equal(stopped.observed.phase, "stopped");
});

test("daemon close stops the process but preserves persistent running intent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-tunnel-quiesce-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const fake = await harness(root);
  await fake.supervisor.start();
  await fake.supervisor.close(Date.now() + 1_000, undefined, true);
  const suspended = await fake.supervisor.status();
  assert.equal(fake.stops, 1);
  assert.equal(suspended?.desiredState, "running");
  assert.equal(suspended?.observed.phase, "stopped");
  assert.equal(suspended?.pid, undefined);
  assert.match(suspended?.observed.detail ?? "", /shutdown/u);
});

test("default close keeps ephemeral tunnel behavior stopped", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-tunnel-ephemeral-close-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const fake = await harness(root);
  await fake.supervisor.start();
  await fake.supervisor.close(Date.now() + 1_000);
  const stopped = await fake.supervisor.status();
  assert.equal(stopped?.desiredState, "stopped");
  assert.equal(stopped?.observed.phase, "stopped");
});

test("persistent profile reconcile restores named instances after graceful manager shutdown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-tunnel-profile-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const executable = "/fake/profile-tunnel";
  const observations = new Map<number, { alive: boolean; executableRealpath: string; processStartIdentity: string; invocationDigest: string }>();
  const inputs: Array<Readonly<Record<string, unknown>> | undefined> = [];
  let starts = 0;
  let stops = 0;
  const provider: GatewayTunnelProvider = {
    name: "profile-provider",
    async doctor() { return { ok: true }; },
    async start(_context, request) {
      starts += 1;
      inputs.push(request.input);
      const pid = 20_000 + starts;
      const args = ["run", String(request.input?.label)];
      const processStartIdentity = `profile:${starts}`;
      observations.set(pid, { alive: true, executableRealpath: executable, processStartIdentity, invocationDigest: gatewayTunnelInvocationDigest(executable, args) });
      return { pid, executablePath: executable, args, processStartIdentity };
    },
    async probe() { return { ready: true, endpoint: "https://profile.invalid" }; },
    async stop(_context, identity) {
      stops += 1;
      const observation = observations.get(identity.pid);
      if (observation) observation.alive = false;
    },
  };
  const processOwner = new GatewayTunnelProcessOwner({ inspect: async (pid) => observations.get(pid) ?? { alive: false } });
  const options = {
    providers: [provider],
    profiles: [{ id: "production", provider: provider.name, lifecycle: "persistent" as const, enabled: true, input: { label: "configured" } }],
    stateRoot: root,
    processOwner,
    supervisorOptions: { canonicalizeExecutable: async (path: string) => path },
  };
  const first = new GatewayTunnelManager(options);
  await first.recoverAll();
  await until(() => starts === 1);
  const ready = await first.control("tunnel-status", { profile: "production" }) as { desiredState: string; observed: { phase: string } };
  assert.equal(ready.desiredState, "running");
  assert.equal(ready.observed.phase, "ready");
  assert.deepEqual(inputs, [{ label: "configured" }]);

  await first.closeAll(Date.now() + 1_000);
  const suspended = await first.control("tunnel-status", { profile: "production" }) as { desiredState: string; observed: { phase: string } };
  assert.equal(stops, 1);
  assert.equal(suspended.desiredState, "running");
  assert.equal(suspended.observed.phase, "stopped");

  const second = new GatewayTunnelManager(options);
  await second.recoverAll();
  await until(async () => ((await second.control("tunnel-status", { profile: "production" })) as { observed: { phase: string } }).observed.phase === "ready");
  const restored = await second.control("tunnel-status", { profile: "production" }) as { generation: number; observed: { phase: string } };
  assert.equal(restored.generation, 2);
  assert.equal(restored.observed.phase, "ready");
  assert.deepEqual(inputs, [{ label: "configured" }, { label: "configured" }]);
  await second.control("tunnel-stop", { profile: "production" });
  assert.equal(stops, 2);
});

test("profile recovery stops a previously running ephemeral tunnel instead of adopting it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-tunnel-ephemeral-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const executable = "/fake/ephemeral-tunnel";
  const args = ["quick"];
  const identity = {
    alive: true,
    executableRealpath: executable,
    processStartIdentity: "ephemeral:1",
    invocationDigest: gatewayTunnelInvocationDigest(executable, args),
  };
  let stops = 0;
  const provider: GatewayTunnelProvider = {
    name: "ephemeral-provider",
    async doctor() { throw new Error("ephemeral recovery must not start"); },
    async start() { throw new Error("ephemeral recovery must not start"); },
    async probe() { throw new Error("ephemeral recovery must not probe"); },
    async stop() { stops += 1; identity.alive = false; },
  };
  const store = new GatewayTunnelStateStore({ path: join(root, provider.name, "quick.json"), provider: provider.name, instance: "quick" });
  await store.save({
    version: 1,
    provider: provider.name,
    instance: "quick",
    desiredState: "running",
    observed: { phase: "ready", changedAt: 1, endpoint: "https://quick.invalid" },
    generation: 1,
    ownerToken: "ephemeral-owner-token-0001",
    pid: 30_001,
    executableRealpath: executable,
    processStartIdentity: identity.processStartIdentity,
    invocationDigest: identity.invocationDigest,
    restartHistory: [],
    updatedAt: 1,
  }, { expectedGeneration: 0 });
  const manager = new GatewayTunnelManager({
    providers: [provider],
    profiles: [{ id: "quick", provider: provider.name, lifecycle: "ephemeral", enabled: true, input: { mode: "quick" } }],
    stateRoot: root,
    processOwner: new GatewayTunnelProcessOwner({ inspect: async () => identity }),
  });
  await manager.recoverAll();
  const stopped = await manager.control("tunnel-status", { profile: "quick" }) as { desiredState: string; observed: { phase: string } };
  assert.equal(stops, 1);
  assert.equal(stopped.desiredState, "stopped");
  assert.equal(stopped.observed.phase, "stopped");
});

test("provider adoption refusal performs a verified stop before persistent restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-tunnel-fresh-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const executable = "/fake/fresh-tunnel";
  const oldArgs = ["run", "old"];
  const observations = new Map<number, { alive: boolean; executableRealpath: string; processStartIdentity: string; invocationDigest: string }>();
  observations.set(40_001, { alive: true, executableRealpath: executable, processStartIdentity: "fresh:old", invocationDigest: gatewayTunnelInvocationDigest(executable, oldArgs) });
  let starts = 0;
  let stops = 0;
  const provider: GatewayTunnelProvider = {
    name: "fresh-provider",
    async doctor() { return { ok: true }; },
    async start() {
      starts += 1;
      const args = ["run", "new"];
      observations.set(40_002, { alive: true, executableRealpath: executable, processStartIdentity: "fresh:new", invocationDigest: gatewayTunnelInvocationDigest(executable, args) });
      return { pid: 40_002, executablePath: executable, args, processStartIdentity: "fresh:new" };
    },
    async probe() { return { ready: true, endpoint: "https://fresh.invalid" }; },
    async stop(_context, process) { stops += 1; observations.get(process.pid)!.alive = false; },
    async adopt() { return undefined; },
  };
  const store = new GatewayTunnelStateStore({ path: join(root, provider.name, "production.json"), provider: provider.name, instance: "production" });
  await store.save({
    version: 1,
    provider: provider.name,
    instance: "production",
    desiredState: "running",
    observed: { phase: "ready", changedAt: 1, endpoint: "https://fresh.invalid" },
    generation: 1,
    ownerToken: "fresh-owner-token-00000001",
    pid: 40_001,
    executableRealpath: executable,
    processStartIdentity: "fresh:old",
    invocationDigest: gatewayTunnelInvocationDigest(executable, oldArgs),
    restartHistory: [],
    updatedAt: 1,
  }, { expectedGeneration: 0 });
  const manager = new GatewayTunnelManager({
    providers: [provider],
    profiles: [{ id: "production", provider: provider.name, lifecycle: "persistent", enabled: true, input: { mode: "secure" } }],
    stateRoot: root,
    processOwner: new GatewayTunnelProcessOwner({ inspect: async (pid) => observations.get(pid) ?? { alive: false } }),
    supervisorOptions: { canonicalizeExecutable: async (path: string) => path },
  });
  await manager.recoverAll();
  await until(async () => ((await manager.control("tunnel-status", { profile: "production" })) as { observed: { phase: string } }).observed.phase === "ready");
  const ready = await manager.control("tunnel-status", { profile: "production" }) as { generation: number; observed: { phase: string } };
  assert.equal(stops, 1);
  assert.equal(starts, 1);
  assert.equal(ready.generation, 2);
  assert.equal(ready.observed.phase, "ready");
});

test("a stale start generation cannot overwrite a newer endpoint publication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-tunnel-stale-endpoint-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = "/fake/cloudflared";
  const args = ["tunnel", "--url", "http://127.0.0.1:9090"];
  const release = deferred<void>();
  let probes = 0;
  const provider: GatewayTunnelProvider = {
    name: "fake",
    async doctor() { return { ok: true }; },
    async start() { return { pid: 55, executablePath: executable, args, processStartIdentity: "boot:55" }; },
    async probe() {
      probes += 1;
      if (probes === 1) return { ready: false, endpoint: "https://old.invalid", retryAfterMs: 1 };
      await release.promise;
      return { ready: true, endpoint: "https://old.invalid" };
    },
    async stop() {},
  };
  const store = new GatewayTunnelStateStore({ path: join(root, "fake.json"), provider: "fake" });
  const owner = new GatewayTunnelProcessOwner({ inspect: async () => ({
    alive: true,
    executableRealpath: executable,
    processStartIdentity: "boot:55",
    invocationDigest: gatewayTunnelInvocationDigest(executable, args),
  }) });
  const supervisor = new GatewayTunnelSupervisor({ provider, stateStore: store, processOwner: owner, canonicalizeExecutable: async (path) => path });
  const starting = supervisor.start({ timeoutMs: 2_000 });
  await until(async () => (await store.read())?.observed.endpoint === "https://old.invalid");
  const old = (await store.read())!;
  await store.save({
    ...old,
    generation: old.generation + 1,
    ownerToken: "new-owner-token-00000001",
    observed: { phase: "starting", changedAt: Date.now(), endpoint: "https://new.invalid" },
    updatedAt: Date.now(),
  }, { expectedGeneration: old.generation, expectedOwnerToken: old.ownerToken });
  release.resolve();
  await assert.rejects(() => starting, GatewayTunnelStateConflictError);
  const current = await store.read();
  assert.equal(current?.generation, old.generation + 1);
  assert.equal(current?.observed.endpoint, "https://new.invalid");
});

test("startup cleanup reserves a fresh bounded deadline after the operation fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-tunnel-deadline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = await harness(root, { terminalProbe: true });
  const deadlineAt = Date.now() + 1_000;
  await assert.rejects(() => fake.supervisor.start({ deadlineAt }), /not ready/u);
  assert.equal(fake.stops, 1);
  assert.ok(fake.deadlines.length >= 4);
  assert.deepEqual(fake.deadlines.slice(0, 3), [deadlineAt, deadlineAt, deadlineAt]);
  assert.ok(fake.deadlines.at(-1)! > deadlineAt, "cleanup is not trapped behind the failed operation deadline");
});

test("an expired readiness probe still stops the published owned process", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-tunnel-timeout-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = "/fake/timeout-tunnel";
  const args = ["run"];
  let alive = true;
  let stops = 0;
  const provider: GatewayTunnelProvider = {
    name: "timeout-provider",
    async doctor() { return { ok: true }; },
    async start() { return { pid: 70_001, executablePath: executable, args, processStartIdentity: "timeout:1" }; },
    async probe() { return new Promise(() => undefined); },
    async stop(context) {
      context.throwIfExpired("cleanup");
      stops += 1;
      alive = false;
    },
  };
  const stateStore = new GatewayTunnelStateStore({ path: join(root, "timeout.json"), provider: provider.name });
  const processOwner = new GatewayTunnelProcessOwner({ inspect: async () => alive ? {
    alive: true,
    executableRealpath: executable,
    processStartIdentity: "timeout:1",
    invocationDigest: gatewayTunnelInvocationDigest(executable, args),
  } : { alive: false } });
  const supervisor = new GatewayTunnelSupervisor({ provider, stateStore, processOwner, canonicalizeExecutable: async (path) => path });
  await assert.rejects(() => supervisor.start({ timeoutMs: 2_000 }), /deadline/u);
  assert.equal(stops, 1);
  assert.equal(alive, false);
  const failed = await supervisor.status();
  assert.equal(failed?.observed.phase, "failed");
  assert.equal(failed?.pid, undefined);
});

test("canonicalization failure kills an unpublished child handle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-tunnel-unpublished-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let kills = 0;
  const child = { pid: 70_002, kill(signal?: NodeJS.Signals | number) { assert.equal(signal, "SIGKILL"); kills += 1; return true; } };
  const provider: GatewayTunnelProvider = {
    name: "unpublished-provider",
    async doctor() { return { ok: true }; },
    async start() { return { pid: child.pid, executablePath: "/fake/unpublished", args: ["run"], child }; },
    async probe() { throw new Error("probe must not run"); },
    async stop() { throw new Error("unpublished process has no verified identity"); },
  };
  const stateStore = new GatewayTunnelStateStore({ path: join(root, "unpublished.json"), provider: provider.name });
  const supervisor = new GatewayTunnelSupervisor({
    provider,
    stateStore,
    canonicalizeExecutable: async () => { throw new Error("canonicalization failed"); },
  });
  await assert.rejects(() => supervisor.start(), /canonicalization failed/u);
  assert.equal(kills, 1);
  assert.equal((await supervisor.status())?.observed.phase, "failed");
});
