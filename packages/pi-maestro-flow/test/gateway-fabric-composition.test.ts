import assert from "node:assert/strict";
import test from "node:test";
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
    acceptAdvertisement: (value: unknown) => { calls.push({ kind: "snapshot", value }); },
    acceptAdvertisementDelta: (value: unknown) => { calls.push({ kind: "delta", value }); },
    renewInboundLease: async (...value: unknown[]) => { calls.push({ kind: "heartbeat", value }); },
    drain: (...value: unknown[]) => { calls.push({ kind: "drain", value }); },
    disconnect: async (...value: unknown[]) => { calls.push({ kind: "close", value }); },
  };
  const authority = createFabricWssAuthority({ fabricControlRuntime: { connections } } as unknown as GatewayRuntime);
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

test("an explicit Fabric control runtime wins without partial default composition", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-fabric-injected-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const injectedStore = new GatewayFabricStore({ path: join(root, "injected-fabric.json") });
  const injected = createGatewayFabricComposition(injectedStore);
  const config = createTestGatewayConfig(root);
  config.fabric = { enabled: true };
  const runtime = await GatewayRuntime.create({ config, cwd: root, fabricControlRuntime: injected });
  t.after(() => runtime.close());
  assert.equal(runtime.fabricComposition, undefined);
  assert.equal(runtime.fabricControlRuntime, injected);
  assert.notEqual(injected.coordinator.store, runtime.fabricStore);
});
