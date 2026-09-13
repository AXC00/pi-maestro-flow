import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import {
  createFabricWssAuthority,
  registerDefaultFabricTeammateRuntime,
} from "../src/gateway/daemon.ts";
import {
  getFabricTeammateRuntimePort,
  registerFabricTeammateRuntimePort,
  type FabricTeammateRuntimePort,
} from "pi-maestro-teammate/v1/fabric-runtime";
import { createGatewayFabricComposition } from "../src/gateway/fabric/composition.ts";
import { GatewayFabricStore } from "../src/gateway/fabric/store.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";

test("fabric.enabled composes one durable manager kernel and disabled remains uncomposed", async (t) => {
  const disabledRoot = await mkdtemp(join(tmpdir(), "gateway-fabric-disabled-"));
  const enabledRoot = await mkdtemp(join(tmpdir(), "gateway-fabric-enabled-"));
  t.after(async () => {
    await Promise.all([
      rm(disabledRoot, { recursive: true, force: true }),
      rm(enabledRoot, { recursive: true, force: true }),
    ]);
  });

  const disabled = await GatewayRuntime.create({ config: createTestGatewayConfig(disabledRoot), cwd: disabledRoot });
  t.after(() => disabled.close());
  assert.equal(disabled.fabricComposition, undefined);
  assert.equal(disabled.fabricControlRuntime, undefined);

  const config = createTestGatewayConfig(enabledRoot);
  config.fabric = { enabled: true };
  const enabled = await GatewayRuntime.create({ config, cwd: enabledRoot });
  t.after(() => enabled.close());
  const composition = enabled.fabricComposition;
  assert(composition);
  assert.equal(enabled.fabricControlRuntime, composition);
  assert.equal(composition.coordinator.store, enabled.fabricStore);
  assert.equal(composition.connections.directory, composition.directory);
  assert.equal(composition.connections.transports, composition.transports);
  assert.equal(composition.admissions.directory, composition.directory);
  assert.equal(composition.admissions.connections, composition.connections);
  assert.equal(composition.presence.directory, composition.directory);
  assert.equal(composition.presence.connections, composition.connections);
  assert.equal(composition.presence.coordinator, composition.coordinator);
});

test("runtime startup hydrates durable Connector and Device authority without live readiness", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-fabric-hydration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new GatewayFabricStore({ path: join(root, "fabric.json") });
  const initial = createGatewayFabricComposition(store, { audience: "fabric" });
  const publicKeySpki = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  await initial.registration.enroll({
    requestId: "enroll-1", pairingId: "pair-1", rawToken: "bootstrap-secret",
    connector: { connectorId: "connector-1", label: "Connector One", transport: "outbound-wss" },
    devices: [{ deviceId: "device-1", label: "Device One", connectionMode: "https", enabled: true }],
    keyId: "key-1", publicKeySpki,
  });

  const config = createTestGatewayConfig(root);
  config.fabric = { enabled: true };
  const runtime = await GatewayRuntime.create({ config, cwd: root, fabricStore: store });
  t.after(() => runtime.close());
  assert.equal(runtime.fabricComposition?.registration.credentialOf("connector-1")?.credentialGeneration, 1);
  assert.equal(runtime.fabricComposition?.directory.getDevice("device-1")?.connectorId, "connector-1");
  assert.deepEqual(runtime.fabricComposition?.directory.listAcceptedExecutionViews(), []);
});

test("daemon owns a default Fabric teammate runtime without replacing an injected port", () => {
  assert.equal(getFabricTeammateRuntimePort(), undefined);
  const installed = registerDefaultFabricTeammateRuntime();
  const secondLease = registerDefaultFabricTeammateRuntime();
  assert(installed);
  assert(secondLease);
  assert.equal(getFabricTeammateRuntimePort(), installed.port);
  assert.equal(secondLease.port, installed.port);
  installed.dispose();
  assert.equal(getFabricTeammateRuntimePort(), secondLease.port);
  installed.dispose();
  assert.equal(getFabricTeammateRuntimePort(), secondLease.port);
  secondLease.dispose();
  assert.equal(getFabricTeammateRuntimePort(), undefined);

  const injected: FabricTeammateRuntimePort = {
    async startAttempt() { throw new Error("not invoked"); },
  };
  const registration = registerFabricTeammateRuntimePort(injected);
  try {
    assert.equal(registerDefaultFabricTeammateRuntime(), undefined);
    assert.equal(getFabricTeammateRuntimePort(), injected);
  } finally {
    registration.dispose();
  }
});

test("daemon WSS authority maps exact connection fences and advertisement payloads", async () => {
  const calls: Array<{ kind: string; value: unknown }> = [];
  const connections = {
    acceptInbound: async (input: unknown) => {
      calls.push({ kind: "admit", value: input });
      return {
        connectionId: "connection-9", deviceId: "device-9", connectorId: "connector-1", generation: 9,
        state: "connected", capabilityDigest: "digest", establishedAt: 1, expiresAt: 20, revision: 0,
      };
    },
    admitAdvertisement: async (value: unknown) => { calls.push({ kind: "snapshot", value }); },
    admitAdvertisementDelta: async (value: unknown) => { calls.push({ kind: "delta", value }); },
    renewInboundLease: async (...value: unknown[]) => { calls.push({ kind: "heartbeat", value }); },
    drain: (...value: unknown[]) => { calls.push({ kind: "drain", value }); },
    disconnect: async (...value: unknown[]) => { calls.push({ kind: "close", value }); },
  };
  const authority = createFabricWssAuthority({ isReady: true, fabricAdmissionReady: true, fabricControlRuntime: { connections } });
  const owner = { close: async () => undefined };
  assert.deepEqual(await authority.admit({
    requestId: "request-1", connectorId: "connector-1", expectedCredentialGeneration: 1,
    connectorInstanceNonce: "nonce", capabilityDigest: "digest", limits: {
      maxFrameBytes: 1, maxInFlightOperations: 1, heartbeatIntervalMs: 1, heartbeatTimeoutMs: 2,
      maxAdvertisementItems: 1, maxResultBytes: 1,
    }, establishedAt: 1, expiresAt: 2,
  }, owner), {
    connectionId: "connection-9", deviceId: "device-9", connectorId: "connector-1", generation: 9,
    state: "connected", capabilityDigest: "digest", establishedAt: 1, expiresAt: 20, revision: 0,
  });
  const session = {
    connectorId: "connector-1", connectionId: "connection-9", connectionGeneration: 9,
    instanceNonce: "nonce", state: "ready" as const, advertisementRevision: 1,
    lastHeartbeatAt: 1, current: true,
  };
  await authority.acceptSnapshot(session, {
    capabilityDigest: "digest", advertisementRevision: 1,
    devices: [], workspaces: [], endpoints: [], capabilities: [],
  });
  await authority.acceptDelta(session, {
    capabilityDigest: "digest", baseRevision: 1, advertisementRevision: 2,
    upserts: { endpoints: [] }, removals: { workspaceIds: [] },
  });
  await authority.heartbeat(session, { sequence: 4, observedAt: 10, leaseExpiresAt: 20 });
  await authority.drain(session, 19, "draining");
  await authority.close(session, "done");
  assert.deepEqual(calls[1], { kind: "snapshot", value: {
    connectionId: "connection-9", connectionGeneration: 9, capabilityDigest: "digest", advertisementRevision: 1,
    devices: [], workspaces: [], endpoints: [], capabilities: [],
  } });
  assert.deepEqual(calls[2], { kind: "delta", value: {
    connectionId: "connection-9", connectionGeneration: 9, capabilityDigest: "digest",
    baseRevision: 1, advertisementRevision: 2,
    upserts: { endpoints: [] }, removals: { workspaceIds: [] },
  } });
  assert.deepEqual(calls[3], { kind: "heartbeat", value: ["connection-9", 9, 20] });
  assert.deepEqual(calls[4], { kind: "drain", value: ["connection-9", 9, 19] });
  assert.deepEqual(calls[5], { kind: "close", value: ["connection-9", 9, "done"] });
});

test("WSS admission rollback disconnects only the accepted lease when fencing wins after await", async () => {
  let admissionReady = true;
  let resolveAdmission!: (value: {
    connectionId: string; deviceId: string; connectorId: string; generation: number;
    state: "connected"; capabilityDigest: string; establishedAt: number; expiresAt: number; revision: number;
  }) => void;
  const accepted = new Promise<{
    connectionId: string; deviceId: string; connectorId: string; generation: number;
    state: "connected"; capabilityDigest: string; establishedAt: number; expiresAt: number; revision: number;
  }>((resolve) => { resolveAdmission = resolve; });
  const disconnects: unknown[][] = [];
  const authority = createFabricWssAuthority({
    isReady: true,
    get fabricAdmissionReady(): boolean { return admissionReady; },
    fabricControlRuntime: { connections: {
      acceptInbound: async () => accepted,
      admitAdvertisement: async () => undefined,
      admitAdvertisementDelta: async () => undefined,
      renewInboundLease: async () => undefined,
      drain: () => undefined,
      disconnect: async (...args: unknown[]) => { disconnects.push(args); },
    } },
  });
  const pending = authority.admit({
    requestId: "request-late-admit", connectorId: "connector-1", expectedCredentialGeneration: 1,
    connectorInstanceNonce: "nonce", capabilityDigest: "digest", limits: {
      maxFrameBytes: 1, maxInFlightOperations: 1, heartbeatIntervalMs: 1, heartbeatTimeoutMs: 2,
      maxAdvertisementItems: 1, maxResultBytes: 1,
    }, establishedAt: 1, expiresAt: 2,
  }, { close: async () => undefined });
  admissionReady = false;
  resolveAdmission({
    connectionId: "connection-late", deviceId: "device-1", connectorId: "connector-1", generation: 17,
    state: "connected", capabilityDigest: "digest", establishedAt: 1, expiresAt: 2, revision: 0,
  });
  await assert.rejects(() => pending, /admission is blocked/u);
  assert.deepEqual(disconnects, [["connection-late", 17, "Fabric admission was fenced after connection acceptance"]]);
});

test("shutdown-fenced WSS authority refuses snapshots and deltas before manager admission", async () => {
  let admissions = 0;
  const unavailable = async (): Promise<never> => { throw new Error("not invoked"); };
  const connections = {
    acceptInbound: unavailable,
    admitAdvertisement: async () => { admissions += 1; },
    admitAdvertisementDelta: async () => { admissions += 1; },
    renewInboundLease: unavailable,
    drain: (): never => { throw new Error("not invoked"); },
    disconnect: unavailable,
  };
  const authority = createFabricWssAuthority({
    isReady: true,
    fabricAdmissionReady: false,
    fabricControlRuntime: { connections },
  });
  const session = {
    connectorId: "connector-1", connectionId: "connection-1", connectionGeneration: 1,
    instanceNonce: "nonce", state: "connected" as const, advertisementRevision: 0,
    lastHeartbeatAt: 1, current: true,
  };
  await assert.rejects(() => authority.acceptSnapshot(session, {
    capabilityDigest: "digest", advertisementRevision: 1,
    devices: [], workspaces: [], endpoints: [], capabilities: [],
  }), /admission is blocked/u);
  await assert.rejects(() => authority.acceptDelta(session, {
    capabilityDigest: "digest", baseRevision: 1, advertisementRevision: 2,
  }), /admission is blocked/u);
  assert.equal(admissions, 0);
});

test("WSS authority rechecks the shutdown fence after in-flight snapshot persistence", async () => {
  let admissionReady = true;
  let entered!: () => void;
  let release!: () => void;
  const enteredAdmission = new Promise<void>((resolve) => { entered = resolve; });
  const persistence = new Promise<void>((resolve) => { release = resolve; });
  const runtimeLike = {
    isReady: true,
    get fabricAdmissionReady(): boolean { return admissionReady; },
    fabricControlRuntime: {
      connections: {
        acceptInbound: async (): Promise<never> => { throw new Error("not invoked"); },
        admitAdvertisement: async () => { entered(); await persistence; },
        admitAdvertisementDelta: async (): Promise<never> => { throw new Error("not invoked"); },
        renewInboundLease: async (): Promise<never> => { throw new Error("not invoked"); },
        drain: (): never => { throw new Error("not invoked"); },
        disconnect: async (): Promise<never> => { throw new Error("not invoked"); },
      },
    },
  };
  const authority = createFabricWssAuthority(runtimeLike);
  const session = {
    connectorId: "connector-1", connectionId: "connection-1", connectionGeneration: 1,
    instanceNonce: "nonce", state: "connected" as const, advertisementRevision: 0,
    lastHeartbeatAt: 1, current: true,
  };
  const pending = authority.acceptSnapshot(session, {
    capabilityDigest: "digest", advertisementRevision: 1,
    devices: [], workspaces: [], endpoints: [], capabilities: [],
  });
  await enteredAdmission;
  admissionReady = false;
  release();
  await assert.rejects(() => pending, /admission is blocked/u);
});

test("an injected enabled Fabric runtime must prove one exact composition authority graph", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-fabric-injected-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const injectedStore = new GatewayFabricStore({ path: join(root, "injected-fabric.json") });
  const injected = createGatewayFabricComposition(injectedStore);
  const config = createTestGatewayConfig(root);
  config.fabric = { enabled: true };
  await assert.rejects(
    () => GatewayRuntime.create({ config, cwd: root, fabricControlRuntime: injected }),
    /one exact authority graph/,
  );
  const { coordinator: _coordinator, registration: _registration, advertisements: _advertisements, ...splitRuntime } = injected;
  await assert.rejects(
    () => GatewayRuntime.create({ config, cwd: root, fabricStore: injectedStore, fabricControlRuntime: splitRuntime }),
    /explicit composition assertion plus registration, advertisement, and coordinator authorities/,
  );

  const foreign = createGatewayFabricComposition(injectedStore);
  for (const split of [
    { ...injected, directory: foreign.directory },
    { ...injected, connections: foreign.connections },
    { ...injected, admissions: foreign.admissions },
    { ...injected, presence: foreign.presence },
    { ...injected, advertisements: foreign.advertisements },
  ]) {
    await assert.rejects(
      () => GatewayRuntime.create({ config, cwd: root, fabricStore: injectedStore, fabricControlRuntime: split }),
      /one exact authority graph/,
    );
  }

  const wrongAudience = createGatewayFabricComposition(injectedStore, { audience: "other-hub" });
  await assert.rejects(
    () => GatewayRuntime.create({ config, cwd: root, fabricStore: injectedStore, fabricControlRuntime: wrongAudience }),
    /one exact authority graph/,
  );

  const runtime = await GatewayRuntime.create({ config, cwd: root, fabricStore: injectedStore, fabricControlRuntime: injected });
  t.after(() => runtime.close());
  assert.equal(runtime.fabricComposition, undefined);
  assert.equal(runtime.fabricControlRuntime, injected);
  assert.equal(runtime.fabricRegistration, injected.registration);
  assert.equal(injected.coordinator.store, runtime.fabricStore);
});
