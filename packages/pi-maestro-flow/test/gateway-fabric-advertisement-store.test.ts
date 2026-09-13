import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  FabricAdvertisementDelta,
  FabricAdvertisementSnapshot,
  FabricStagedAdvertisementCandidate,
  PublicConnectionLease,
} from "pi-maestro-fabric";
import { FabricContractError, type FabricProtocolLimits } from "pi-maestro-fabric-core/v1";
import { createGatewayFabricComposition, type GatewayFabricComposition } from "../src/gateway/fabric/composition.ts";
import { GatewayFabricStore } from "../src/gateway/fabric/store.ts";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";

const NOW = 10_000;
const LIMITS: FabricProtocolLimits = {
  maxFrameBytes: 256 * 1024,
  maxInFlightOperations: 32,
  heartbeatIntervalMs: 1_000,
  heartbeatTimeoutMs: 5_000,
  maxAdvertisementItems: 1_024,
  maxResultBytes: 1024 * 1024,
};

interface AdmissionFixture {
  readonly composition: GatewayFabricComposition;
  readonly lease: PublicConnectionLease;
  readonly ownerCloses: string[];
}

async function enrollAndAdmit(composition: GatewayFabricComposition): Promise<AdmissionFixture> {
  const publicKeySpki = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
  await composition.registration.enroll({
    requestId: "enroll-1",
    pairingId: "pair-1",
    rawToken: "not-persisted-bootstrap-token",
    connector: { connectorId: "connector-1", label: "Connector One", transport: "outbound-wss" },
    devices: [{ deviceId: "device-1", label: "Device One", connectionMode: "https", enabled: true }],
    keyId: "key-1",
    publicKeySpki,
  });
  await composition.registration.hydrate(composition.directory);
  const ownerCloses: string[] = [];
  const lease = await composition.connections.acceptInbound({
    requestId: "connection-request-1",
    connectorId: "connector-1",
    expectedCredentialGeneration: 1,
    connectorInstanceNonce: "instance-1",
    capabilityDigest: "capability-digest-1",
    limits: LIMITS,
    establishedAt: NOW,
    expiresAt: NOW + 5_000,
  }, { close: async (reason) => { ownerCloses.push(reason); } });
  return { composition, lease, ownerCloses };
}

function snapshot(lease: PublicConnectionLease): FabricAdvertisementSnapshot {
  return {
    connectionId: lease.connectionId,
    connectionGeneration: lease.generation,
    capabilityDigest: "capability-digest-1",
    advertisementRevision: 1,
    devices: [{
      deviceId: "device-1", connectorId: "connector-1", label: "Device One", connectionMode: "https",
      enabled: true, revision: 1,
    }],
    workspaces: [{
      workspaceId: "workspace-1", deviceId: "device-1", localWorkspaceId: "local-workspace-1", label: "Workspace One",
      mode: "permanent", generation: 1, policyDigest: "policy-digest-1", endpointIds: ["endpoint-1"], revision: 1,
    }],
    endpoints: [{
      endpointId: "endpoint-1", deviceId: "device-1", connectorId: "connector-1",
      scope: { kind: "workspace", workspaceId: "workspace-1" }, generation: 1, contractHash: "contract-1",
      status: "online", revision: 1, kind: "mcp", serverName: "source-mcp", protocolVersion: "2025-11-25",
      transport: "streamable-http", durableDeduplication: false,
    }],
    capabilities: [{
      capabilityId: "capability-1", kind: "tool", endpointId: "endpoint-1", contractHash: "contract-1",
      trustLevel: "paired", priority: 10,
    }],
  };
}

async function until(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not observed");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("Gateway persistence rejects aggregate offline tombstones before committing restart-invalid rows", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-advertisement-tombstone-bound-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new GatewayFabricStore({ path: join(root, "fabric.json") });
  const composition = createGatewayFabricComposition(store, { now: () => NOW });
  const candidate: FabricStagedAdvertisementCandidate = {
    kind: "snapshot",
    connectorId: "connector-1",
    connectionId: "connection-1",
    connectionGeneration: 1,
    credentialGeneration: 1,
    capabilityDigest: "digest-1",
    advertisementRevision: 1,
    preparedAt: NOW,
    devices: [],
    workspaces: [],
    endpoints: [],
    capabilities: [],
    removals: {
      workspaces: Array.from({ length: 10_001 }, (_unused, index) => ({
        subjectId: `workspace-tombstone-${index}`,
        generation: 1,
        revision: 1,
      })),
      endpoints: [],
      capabilities: [],
    },
  };
  await assert.rejects(
    () => composition.advertisements.persist(candidate),
    (error: unknown) => error instanceof FabricContractError && error.code === "resource_exhausted",
  );
  const registry = await store.readStore("registry");
  assert.equal(registry.revision, 0);
  assert.deepEqual(registry.records, {});
});

test("Gateway advertisement admission commits strict atomic rows, tombstones, and restart-only offline inventory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-advertisement-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new GatewayFabricStore({ path: join(root, "fabric.json") });
  const composition = createGatewayFabricComposition(store, { now: () => NOW });
  const fixture = await enrollAndAdmit(composition);

  const advertised = snapshot(fixture.lease);
  const workspace = advertised.workspaces[0]! as FabricAdvertisementSnapshot["workspaces"][number] & { path: string; ownerToken: string };
  workspace.path = "C:\\private\\workspace";
  workspace.ownerToken = "workspace-owner-secret";
  const endpoint = advertised.endpoints[0]! as FabricAdvertisementSnapshot["endpoints"][number] & { principal: string; handler: string };
  endpoint.principal = "private-principal";
  endpoint.handler = "private-handler";
  await composition.connections.admitAdvertisement(advertised);
  const afterSnapshot = await store.readStore("registry");
  assert.deepEqual(Object.keys(afterSnapshot.records).filter((subject) => /^(?:workspace|endpoint|capability|advertisement):/u.test(subject)).sort(), [
    "advertisement:connector-1", "capability:capability-1", "endpoint:endpoint-1", "workspace:workspace-1",
  ]);
  const advertisement = afterSnapshot.records["advertisement:connector-1"]!;
  assert.equal(advertisement.version, 1);
  assert.equal(advertisement.connectionId, fixture.lease.connectionId);
  assert.equal(advertisement.connectionGeneration, fixture.lease.generation);
  assert.equal(advertisement.credentialGeneration, 1);
  assert.equal(advertisement.advertisementRevision, 1);
  assert.equal(advertisement.capabilityDigest, "capability-digest-1");
  assert.equal(advertisement.acceptedAt, NOW);
  assert.equal(JSON.stringify(afterSnapshot.records).includes("not-persisted-bootstrap-token"), false);
  const persistedRegistry = JSON.stringify(afterSnapshot.records);
  assert.equal(persistedRegistry.includes("instance-1"), false);
  assert.equal(persistedRegistry.includes("workspace-owner-secret"), false);
  assert.equal(persistedRegistry.includes("private-principal"), false);
  assert.equal(persistedRegistry.includes("private-handler"), false);
  assert.equal(persistedRegistry.includes("C:\\\\private"), false);
  assert.equal(JSON.stringify(await store.pendingOutbox()).includes("localWorkspaceId"), false, "outbox leaked inventory records");

  const delta: FabricAdvertisementDelta = {
    connectionId: fixture.lease.connectionId,
    connectionGeneration: fixture.lease.generation,
    capabilityDigest: "capability-digest-1",
    baseRevision: 1,
    advertisementRevision: 2,
    removals: { workspaceIds: ["workspace-1"], endpointIds: ["endpoint-1"], capabilityIds: ["capability-1"] },
  };
  await composition.connections.admitAdvertisementDelta(delta);
  const afterDelta = await store.readStore("registry");
  assert.equal(afterDelta.revision, afterSnapshot.revision + 1, "delta rows did not share one registry commit");
  assert.equal(afterDelta.records["workspace:workspace-1"]?.tombstone, true);
  assert.equal(afterDelta.records["endpoint:endpoint-1"]?.tombstone, true);
  assert.equal(afterDelta.records["capability:capability-1"]?.tombstone, true);
  assert.deepEqual(afterDelta.records["advertisement:connector-1"]?.workspaceTombstoneIds, ["workspace-1"]);
  assert.deepEqual(afterDelta.records["advertisement:connector-1"]?.endpointTombstoneIds, ["endpoint-1"]);
  assert.deepEqual(afterDelta.records["advertisement:connector-1"]?.capabilityTombstoneIds, ["capability-1"]);

  await composition.connections.disconnect(fixture.lease.connectionId, fixture.lease.generation, "restart");
  const config = createTestGatewayConfig(root);
  config.fabric = { enabled: true };
  const restarted = await GatewayRuntime.create({ config, cwd: root, fabricStore: store });
  t.after(() => restarted.close());
  const offline = restarted.fabricControlRuntime?.directory.getOfflineInventory("connector-1");
  assert(offline);
  assert.equal(offline.advertisementRevision, 2);
  assert.deepEqual(offline.workspaces, []);
  assert.deepEqual(offline.endpoints, []);
  assert.deepEqual(offline.capabilities, []);
  assert.deepEqual(offline.tombstones.workspaces.map((entry) => entry.subjectId), ["workspace-1"]);
  assert.deepEqual(restarted.fabricControlRuntime?.directory.listAcceptedExecutionViews(), []);
  assert.equal(restarted.fabricControlRuntime?.directory.getWorkspace("workspace-1"), undefined);
  assert.equal(restarted.fabricControlRuntime?.directory.getEndpoint("endpoint-1"), undefined);
});

test("unknown registry subjects stay inert while malformed recognized advertisement rows fail startup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-advertisement-validation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new GatewayFabricStore({ path: join(root, "fabric.json") });
  const seed = createGatewayFabricComposition(store, { now: () => NOW });
  await seed.coordinator.commit("registry", NOW, () => ({
    mutations: [{ kind: "upsert", subjectId: "legacy-inventory", value: { revision: 1, label: "inert" }, eventKind: "legacy.updated", payload: {} }],
    value: undefined,
  }));
  const config = createTestGatewayConfig(root);
  config.fabric = { enabled: true };
  const inert = await GatewayRuntime.create({ config, cwd: root, fabricStore: store });
  await inert.close();

  await seed.coordinator.commit("registry", NOW, () => ({
    mutations: [{ kind: "upsert", subjectId: "workspace:broken", value: { revision: 1 }, eventKind: "advertisement.corrupted", payload: {} }],
    value: undefined,
  }));
  await assert.rejects(
    () => GatewayRuntime.create({ config, cwd: root, fabricStore: store }),
    /registry\.workspace:broken/,
  );
});

test("Gateway store commit failure fences and closes without publishing readiness or ACK authority", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-advertisement-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let rejectWrites = false;
  const store = new GatewayFabricStore({
    path: join(root, "fabric.json"),
    fault: (point) => { if (rejectWrites && point === "before-write") throw new Error("registry commit failed"); },
  });
  const fixture = await enrollAndAdmit(createGatewayFabricComposition(store, { now: () => NOW }));
  rejectWrites = true;
  await assert.rejects(() => fixture.composition.connections.admitAdvertisement(snapshot(fixture.lease)), /registry commit failed/);
  await until(() => fixture.ownerCloses.length === 1);
  assert.throws(() => fixture.composition.connections.requireReady(fixture.lease.connectionId, fixture.lease.generation), /not current|not ready|closed|readiness/u);
  assert.equal(fixture.composition.directory.getAcceptedAdvertisement("connector-1"), undefined);
  assert.equal(fixture.composition.directory.getOfflineInventory("connector-1"), undefined);
  rejectWrites = false;
  await fixture.composition.connections.disconnect(fixture.lease.connectionId, fixture.lease.generation, "retry cleanup after store recovery");
  const registry = await store.readStore("registry");
  assert.equal(registry.records["advertisement:connector-1"], undefined);
});

test("blocked persistence plus credential rotation fences the old owner after commit without executable publication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-advertisement-rotation-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let blockWrites = false;
  let releaseWrite!: () => void;
  let enteredWrite!: () => void;
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const entered = new Promise<void>((resolve) => { enteredWrite = resolve; });
  const store = new GatewayFabricStore({
    path: join(root, "fabric.json"),
    fault: async (point) => {
      if (!blockWrites || point !== "before-write") return;
      enteredWrite();
      await writeGate;
    },
  });
  const fixture = await enrollAndAdmit(createGatewayFabricComposition(store, { now: () => NOW }));
  blockWrites = true;
  const admission = fixture.composition.connections.admitAdvertisement(snapshot(fixture.lease));
  await entered;
  fixture.composition.directory.seedAuthority({
    connector: {
      connectorId: "connector-1", label: "Connector One", transport: "outbound-wss",
      credentialGeneration: 2, enabled: true, revision: 2,
    },
    devices: [{
      deviceId: "device-1", connectorId: "connector-1", label: "Device One", connectionMode: "https",
      enabled: true, revision: 1,
    }],
  });
  releaseWrite();
  await assert.rejects(() => admission, /authority changed|stale/u);
  await until(() => fixture.ownerCloses.length === 1);
  await fixture.composition.connections.disconnect(fixture.lease.connectionId, fixture.lease.generation, "finish rotation cleanup");
  assert.equal(fixture.composition.directory.getAcceptedAdvertisement("connector-1"), undefined);
  assert.equal(fixture.composition.directory.getOfflineInventory("connector-1")?.credentialGeneration, 1);
  assert.equal((await store.readStore("registry")).records["advertisement:connector-1"]?.credentialGeneration, 1);
});

test("blocked persistence plus disconnect records commit evidence but never publishes executable readiness", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-advertisement-disconnect-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let blockWrites = false;
  let releaseWrite!: () => void;
  let enteredWrite!: () => void;
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const entered = new Promise<void>((resolve) => { enteredWrite = resolve; });
  const store = new GatewayFabricStore({
    path: join(root, "fabric.json"),
    fault: async (point) => {
      if (!blockWrites || point !== "before-write") return;
      enteredWrite();
      await writeGate;
    },
  });
  const fixture = await enrollAndAdmit(createGatewayFabricComposition(store, { now: () => NOW }));
  blockWrites = true;
  const admission = fixture.composition.connections.admitAdvertisement(snapshot(fixture.lease));
  await entered;
  const disconnect = fixture.composition.connections.disconnect(fixture.lease.connectionId, fixture.lease.generation, "socket closed while commit blocked");
  await until(() => fixture.ownerCloses.length === 1);
  assert.throws(() => fixture.composition.connections.requireReady(fixture.lease.connectionId, fixture.lease.generation), /not current|not ready|closed|readiness/u);
  releaseWrite();
  await assert.rejects(() => admission, /changed during lifecycle work|not current|owner changed|connected, non-draining/u);
  await disconnect;
  assert.equal(fixture.composition.directory.getAcceptedAdvertisement("connector-1"), undefined);
  assert.equal(fixture.composition.directory.getOfflineInventory("connector-1")?.advertisementRevision, 1);
  assert.equal((await store.readStore("registry")).records["advertisement:connector-1"]?.advertisementRevision, 1);
});
