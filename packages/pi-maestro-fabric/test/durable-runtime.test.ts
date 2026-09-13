import assert from "node:assert/strict";
import test from "node:test";
import {
  FabricContractError,
  type DeviceRecord,
  type EndpointRouteHandle,
  type FabricConnectRequest,
  type FabricLiveConnection,
  type InvocationReceipt,
  type WorkspaceBinding,
} from "pi-maestro-fabric-core/v1";
import {
  FabricAdmissionManager,
  FabricConnectionManager,
  FabricDirectory,
  FabricInvocationManager,
  FabricPresenceManager,
  FabricStoreCoordinator,
  TransportRegistry,
  type FabricAdvertisementSnapshot,
  type FabricAllocatedConnectRequest,
} from "../src/index.ts";
import { MemoryFabricStore } from "./memory-store.ts";

const limits = {
  maxFrameBytes: 1024,
  maxInFlightOperations: 4,
  heartbeatIntervalMs: 10,
  heartbeatTimeoutMs: 20,
  maxAdvertisementItems: 100,
  maxResultBytes: 2048,
};

const devices: readonly DeviceRecord[] = [{
  deviceId: "device-a", connectorId: "connector-a", label: "Device A", connectionMode: "ssh", enabled: true, revision: 1,
}, {
  deviceId: "device-b", connectorId: "connector-a", label: "Device B", connectionMode: "ssh", enabled: true, revision: 1,
}];

function advertisement(connectionId: string, generation: number, advertisementRevision = 1): FabricAdvertisementSnapshot {
  return {
    connectionId,
    connectionGeneration: generation,
    capabilityDigest: "digest-a",
    advertisementRevision,
    devices,
    workspaces: [{
      workspaceId: "workspace-b", deviceId: "device-b", localWorkspaceId: "local-b", label: "Workspace B",
      mode: "permanent", generation: 1, policyDigest: "policy-b", endpointIds: ["endpoint-b"], revision: advertisementRevision,
    }],
    endpoints: [{
      endpointId: "endpoint-b", deviceId: "device-b", connectorId: "connector-a",
      scope: { kind: "workspace", workspaceId: "workspace-b" }, generation: 1,
      contractHash: "contract-b", status: "online", revision: advertisementRevision,
      kind: "mcp", serverName: "remote-b", protocolVersion: "2025-06-18", transport: "http", durableDeduplication: true,
    }],
    capabilities: [{
      capabilityId: "capability-b", kind: "tool", endpointId: "endpoint-b", contractHash: "contract-b",
      trustLevel: "owner", priority: 1,
    }],
  };
}

function binding(): WorkspaceBinding {
  return {
    bindingId: "binding-b", connectionId: "placeholder", deviceId: "device-b", workspaceId: "workspace-b",
    connectionGeneration: 1, workspaceGeneration: 1, policyDigest: "policy-b",
    issuedAt: 1000, expiresAt: 2500, revision: 0,
  };
}

function route(connectionId: string, generation: number): EndpointRouteHandle {
  return {
    routeId: "route-b", connectionId, workspaceBindingId: "binding-b", endpointId: "endpoint-b",
    connectionGeneration: generation, workspaceGeneration: 1, endpointGeneration: 1,
    issuedAt: 1000, expiresAt: 2400, state: "open", revision: 0,
    deviceId: "device-b", operationClass: "mcp-read", pathCandidates: ["hub", "edge-relay"], selectedPath: "hub",
  };
}

interface RuntimeFixture {
  now: { value: number };
  closes: string[];
  store: MemoryFabricStore;
  coordinator: FabricStoreCoordinator;
  directory: FabricDirectory;
  connections: FabricConnectionManager;
  admissions: FabricAdmissionManager;
  presence: FabricPresenceManager;
  invocations: FabricInvocationManager;
  connectionId: string;
  generation: number;
}

async function createFixture(store = new MemoryFabricStore()): Promise<RuntimeFixture> {
  const now = { value: 1100 };
  const closes: string[] = [];
  let id = 0;
  const coordinator = new FabricStoreCoordinator(store, { createId: () => `durable-${++id}` });
  const directory = new FabricDirectory();
  directory.seedAuthority({
    connector: {
      connectorId: "connector-a", label: "Connector A", transport: "ssh", credentialGeneration: 1,
      instanceNonce: "nonce-a", enabled: true, revision: 1,
    },
    devices,
  });
  const transports = new TransportRegistry();
  transports.register({
    kind: "ssh",
    connect: async (request: FabricConnectRequest): Promise<FabricLiveConnection> => {
      const allocated = request as FabricAllocatedConnectRequest;
      return {
        descriptor: {
          protocolVersion: "fabric.v1",
          limits,
          lease: {
            connectionId: allocated.allocatedConnectionId,
            deviceId: request.deviceId,
            connectorId: request.connectorId,
            connectorInstanceNonce: "nonce-a",
            generation: allocated.allocatedConnectionGeneration,
            state: "connected",
            capabilityDigest: "digest-a",
            establishedAt: 1000,
            expiresAt: 5000,
            revision: 0,
          },
        },
        exchange: async (envelope) => envelope,
        close: async (reason) => { closes.push(reason); },
      };
    },
  });
  const connections = new FabricConnectionManager(directory, transports, { now: () => now.value, coordinator });
  const connected = await connections.connect({
    requestId: "connect-a", deviceId: "device-a", connectorId: "connector-a", expectedCredentialGeneration: 1,
    deadlineAt: 3000, limits,
  }, new AbortController().signal);
  connections.acceptAdvertisement(advertisement(connected.connectionId, connected.generation));
  const admissions = new FabricAdmissionManager(directory, connections, { now: () => now.value, coordinator });
  return {
    now,
    closes,
    store,
    coordinator,
    directory,
    connections,
    admissions,
    presence: new FabricPresenceManager(directory, connections, coordinator, { now: () => now.value }),
    invocations: new FabricInvocationManager(admissions, coordinator, { now: () => now.value }),
    connectionId: connected.connectionId,
    generation: connected.generation,
  };
}

function expectCode(action: () => unknown, code: FabricContractError["code"]): void {
  assert.throws(action, (error: unknown) => error instanceof FabricContractError && error.code === code);
}

async function expectAsyncCode(action: Promise<unknown>, code: FabricContractError["code"]): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof FabricContractError && error.code === code);
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
}

test("durable connection allocation survives manager restart while physical close is independent", async () => {
  const first = await createFixture();
  const entered = deferred();
  const release = deferred();
  first.store.beforeTransact = async (transaction) => {
    if (transaction.events.some((event) => event.eventKind === "connection.closed")) {
      entered.resolve();
      await release.promise;
    }
  };
  const closing = first.connections.disconnect(first.connectionId, first.generation);
  await entered.promise;
  assert.equal(first.connections.get(first.connectionId)?.state, "closed", "memory is fenced before cleanup awaits");
  assert.deepEqual(first.closes, ["explicit disconnect"], "owner close does not wait for durable cleanup");
  release.resolve();
  await closing;
  assert.equal(first.closes.length, 1);
  assert.equal((await first.store.record("lease", "connector-a"))?.state, "closed");

  first.store.beforeTransact = undefined;
  const second = await createFixture(first.store);
  assert.equal(second.generation, first.generation + 1);
  assert.notEqual(second.connectionId, first.connectionId);
});

test("rejected post-open channels persist their terminal fence before physical close", async () => {
  const store = new MemoryFabricStore();
  let id = 0;
  const coordinator = new FabricStoreCoordinator(store, { createId: () => `reject-${++id}` });
  const directory = new FabricDirectory();
  directory.seedAuthority({
    connector: { connectorId: "connector-a", label: "Connector A", transport: "ssh", credentialGeneration: 1, instanceNonce: "nonce-a", enabled: true, revision: 1 },
    devices: [devices[0]!],
  });
  const closes: string[] = [];
  const transports = new TransportRegistry();
  transports.register({
    kind: "ssh",
    connect: async (request) => {
      const allocated = request as FabricAllocatedConnectRequest;
      return {
        descriptor: {
          protocolVersion: "fabric.v1",
          limits,
          lease: {
            connectionId: `${allocated.allocatedConnectionId}-wrong`,
            deviceId: request.deviceId,
            connectorId: request.connectorId,
            connectorInstanceNonce: "nonce-a",
            generation: allocated.allocatedConnectionGeneration,
            state: "connected",
            capabilityDigest: "digest-a",
            establishedAt: 1000,
            expiresAt: 5000,
            revision: 0,
          },
        },
        exchange: async (envelope) => envelope,
        close: async (reason) => { closes.push(reason); },
      };
    },
  });
  const entered = deferred();
  const release = deferred();
  store.beforeTransact = async (transaction) => {
    if (transaction.events.some((event) => event.eventKind === "connection.closed")) {
      entered.resolve();
      await release.promise;
    }
  };
  const manager = new FabricConnectionManager(directory, transports, { now: () => 1100, coordinator });
  const rejected = manager.connect({
    requestId: "connect-rejected", deviceId: "device-a", connectorId: "connector-a",
    expectedCredentialGeneration: 1, deadlineAt: 3000, limits,
  }, new AbortController().signal);
  await entered.promise;
  assert.deepEqual(closes, []);
  release.resolve();
  await expectAsyncCode(rejected, "protocol_violation");
  assert.equal((await store.record("lease", "connector-a"))?.state, "closed");
  assert.equal(closes.length, 1);
});

test("one Connector connection admits every advertised allowlisted Device, rejects others, and applies deltas atomically", async () => {
  const fixture = await createFixture();
  assert.equal(fixture.connections.requireReadyForDevice(fixture.connectionId, fixture.generation, "device-b").connectorId, "connector-a");
  expectCode(() => fixture.connections.requireReadyForDevice(fixture.connectionId, fixture.generation, "device-x"), "permission_denied");
  const view = fixture.connections.getAcceptedExecutionView(fixture.connectionId, fixture.generation, "device-b");
  assert.deepEqual(view.devices.map((entry) => entry.deviceId), ["device-b"]);
  assert.deepEqual(view.endpoints.map((entry) => entry.endpointId), ["endpoint-b"]);

  fixture.connections.acceptAdvertisementDelta({
    connectionId: fixture.connectionId,
    connectionGeneration: fixture.generation,
    capabilityDigest: "digest-a",
    baseRevision: 1,
    advertisementRevision: 2,
    upserts: { endpoints: [{ ...advertisement(fixture.connectionId, fixture.generation, 2).endpoints[0]!, status: "offline" }] },
  });
  assert.equal(fixture.directory.getEndpoint("endpoint-b")?.status, "offline");
  expectCode(() => fixture.connections.acceptAdvertisementDelta({
    connectionId: fixture.connectionId,
    connectionGeneration: fixture.generation,
    capabilityDigest: "digest-a",
    baseRevision: 1,
    advertisementRevision: 3,
  }), "stale_generation");
  assert.equal(fixture.directory.getAdvertisementRevision("connector-a"), 2);
});

test("durable binding and route renewals preserve identity while stale revisions and unadmitted paths fail", async () => {
  const fixture = await createFixture();
  const bindingInput = { ...binding(), connectionId: fixture.connectionId, connectionGeneration: fixture.generation };
  expectCode(() => fixture.admissions.bind(bindingInput), "invalid_state");
  const issued = await fixture.admissions.bindDurable(bindingInput);
  assert.equal(issued.revision, 1);
  const renewed = await fixture.admissions.renewBinding(issued.bindingId, 1, 2800);
  assert.equal(renewed.revision, 2);
  assert.equal(renewed.bindingId, issued.bindingId);
  await expectAsyncCode(fixture.admissions.renewBinding(issued.bindingId, 1, 2900), "conflict");

  const routeInput = route(fixture.connectionId, fixture.generation);
  expectCode(() => fixture.admissions.openRoute(routeInput), "invalid_state");
  const opened = await fixture.admissions.openRouteDurable(routeInput);
  const switched = await fixture.admissions.switchRoutePath(opened.routeId, 1, "edge-relay");
  assert.equal(switched.selectedPath, "edge-relay");
  assert.equal(switched.endpointId, opened.endpointId);
  await expectAsyncCode(fixture.admissions.switchRoutePath(opened.routeId, 2, "lan-direct"), "permission_denied");
  const extended = await fixture.admissions.renewRoute(opened.routeId, 2, 2900);
  assert.equal(extended.revision, 3);
  assert.equal((await fixture.admissions.closeRoute(opened.routeId, 3)).state, "closed");
  await expectAsyncCode(fixture.admissions.renewRoute(opened.routeId, 4, 3000), "invalid_state");
  assert.equal((await fixture.admissions.unbind(issued.bindingId, 2)).revision, 3);
  assert.equal(await fixture.admissions.getBindingDurable(issued.bindingId), undefined);
});

test("disconnect wins the shared lease-store CAS against an in-flight durable bind", async () => {
  const fixture = await createFixture();
  const entered = deferred();
  const release = deferred();
  fixture.store.beforeTransact = async (transaction) => {
    if (transaction.events.some((event) => event.eventKind === "binding.issued")) {
      entered.resolve();
      await release.promise;
    }
  };
  const pending = fixture.admissions.bindDurable({ ...binding(), connectionId: fixture.connectionId, connectionGeneration: fixture.generation });
  await entered.promise;
  await fixture.connections.disconnect(fixture.connectionId, fixture.generation);
  release.resolve();
  await expectAsyncCode(pending, "conflict");
  assert.equal(await fixture.store.record("lease", "binding-b"), undefined);
});

test("presence heartbeat sequence and lease are generation-fenced without inferring Device presence", async () => {
  const fixture = await createFixture();
  const connector = await fixture.presence.heartbeat({
    subjectKind: "connector", subjectId: "connector-a", connectionId: fixture.connectionId,
    connectionGeneration: fixture.generation, sequence: 1, status: "online", observedAt: 1090, expiresAt: 1200,
  });
  assert.equal(connector.revision, 1);
  assert.equal(await fixture.presence.get("device-b"), undefined);
  await expectAsyncCode(fixture.presence.heartbeat({ ...connector, sequence: 1 }), "stale_generation");

  fixture.now.value = 1300;
  assert.equal((await fixture.presence.get("connector-a"))?.status, "offline");
  assert.equal((await fixture.presence.expire("connector-a", 1)).revision, 2);
});

test("invocation receipts are unique, monotonic, terminal-immutable, and recheck a late route fence", async () => {
  const fixture = await createFixture();
  await fixture.admissions.bindDurable({ ...binding(), connectionId: fixture.connectionId, connectionGeneration: fixture.generation });
  await fixture.admissions.openRouteDurable(route(fixture.connectionId, fixture.generation));
  const accepted: InvocationReceipt = {
    operationId: "operation-a", routeId: "route-b", endpointId: "endpoint-b",
    connectionGeneration: fixture.generation, endpointGeneration: 1,
    state: "accepted", replayClass: "durable-dedup", revision: 0, updatedAt: 1100,
  };
  assert.equal((await fixture.invocations.admit(accepted)).revision, 1);
  assert.equal((await fixture.invocations.admit(accepted)).revision, 1);
  await expectAsyncCode(fixture.invocations.admit({ ...accepted, replayClass: "readonly" }), "conflict");
  const running = await fixture.invocations.transition("operation-a", { state: "running", expectedRevision: 1, updatedAt: 1101 });
  const succeeded = await fixture.invocations.transition("operation-a", { state: "succeeded", expectedRevision: 2, updatedAt: 1102, endpointReceiptRef: "receipt-a", resultRef: "artifact-a" });
  assert.equal(succeeded.revision, 3);
  assert.equal((await fixture.invocations.transition("operation-a", { state: "succeeded", expectedRevision: 3, resultRef: "artifact-a" })).revision, 3);
  await expectAsyncCode(fixture.invocations.transition("operation-a", { state: "failed", expectedRevision: 3 }), "invalid_state");
  assert.equal(running.state, "running");

  const late = await fixture.invocations.admit({ ...accepted, operationId: "operation-late", replayClass: "readonly" });
  const entered = deferred();
  const release = deferred();
  fixture.store.beforeTransact = async (transaction) => {
    if (transaction.storeKind === "invocation" && transaction.events.some((event) => event.eventKind === "invocation.succeeded")) {
      entered.resolve();
      await release.promise;
    }
  };
  const completion = fixture.invocations.transition(late.operationId, { state: "succeeded", expectedRevision: 1, updatedAt: 1103, resultRef: "late-result" });
  await entered.promise;
  fixture.connections.drain(fixture.connectionId, fixture.generation, 1500);
  release.resolve();
  await expectAsyncCode(completion, "invalid_state");
});
