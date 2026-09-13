import assert from "node:assert/strict";
import test from "node:test";
import {
  FabricContractError,
  type ConnectorRecord,
  type DeviceRecord,
  type FabricConnectRequest,
  type FabricLiveConnection,
  type FabricTransportProvider,
} from "pi-maestro-fabric-core/v1";
import {
  FabricConnectionManager,
  FabricDirectory,
  FabricStoreCoordinator,
  TransportRegistry,
  type FabricAdvertisementSnapshot,
  type FabricDeadlineScheduler,
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

function connector(overrides: Partial<ConnectorRecord> = {}): ConnectorRecord {
  return {
    connectorId: "connector-a", label: "Connector A", transport: "ssh", credentialGeneration: 2,
    instanceNonce: "nonce-a", enabled: true, revision: 1, ...overrides,
  };
}

function device(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    deviceId: "device-a", connectorId: "connector-a", label: "Device A", connectionMode: "ssh",
    enabled: true, revision: 1, ...overrides,
  };
}

function advertisement(generation = 1, overrides: Partial<FabricAdvertisementSnapshot> = {}): FabricAdvertisementSnapshot {
  return {
    connectionId: `connection-${generation}`,
    connectionGeneration: generation,
    capabilityDigest: "digest-a",
    advertisementRevision: 1,
    devices: [device()],
    workspaces: [], endpoints: [], capabilities: [],
    ...overrides,
  };
}

function request(overrides: Partial<FabricConnectRequest> = {}): FabricConnectRequest {
  return {
    requestId: "request-a", deviceId: "device-a", connectorId: "connector-a",
    expectedCredentialGeneration: 2, deadlineAt: 1500, limits, ...overrides,
  };
}

function channel(
  generation: number,
  close: (reason: string) => Promise<void>,
  leaseOverrides: Partial<FabricLiveConnection["descriptor"]["lease"]> = {},
  descriptorLimits = limits,
): FabricLiveConnection {
  return {
    descriptor: {
      protocolVersion: "fabric.v1", limits: descriptorLimits,
      lease: {
        connectionId: `connection-${generation}`, deviceId: "device-a", connectorId: "connector-a",
        connectorInstanceNonce: "nonce-a", generation, state: "connected", capabilityDigest: "digest-a",
        establishedAt: 1000, expiresAt: 2000, revision: 0, ...leaseOverrides,
      },
    },
    exchange: async (envelope) => envelope,
    close,
  };
}

function setup(provider: FabricTransportProvider, options: ConstructorParameters<typeof FabricConnectionManager>[2] = {}): {
  directory: FabricDirectory;
  manager: FabricConnectionManager;
} {
  const directory = new FabricDirectory();
  directory.seedAuthority({ connector: connector(), devices: [device()] });
  const transports = new TransportRegistry();
  transports.register(provider);
  return { directory, manager: new FabricConnectionManager(directory, transports, { now: () => 1000, ...options }) };
}

async function expectCode(action: Promise<unknown>, code: FabricContractError["code"]): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof FabricContractError && error.code === code);
}

function expectSyncCode(action: () => unknown, code: FabricContractError["code"]): void {
  assert.throws(action, (error: unknown) => error instanceof FabricContractError && error.code === code);
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not reached within the bounded wait");
}

test("connected is not ready until a connection-fenced advertisement is atomically accepted", async () => {
  const closes: string[] = [];
  const { manager } = setup({ kind: "ssh", connect: async () => channel(1, async (reason) => { closes.push(reason); }) });
  const connected = await manager.connect(request(), new AbortController().signal);
  assert.equal(connected.state, "connected");
  expectSyncCode(() => manager.requireReady("connection-1", 1), "invalid_state");
  expectSyncCode(() => manager.acceptAdvertisement(advertisement(2)), "stale_generation");
  expectSyncCode(() => manager.acceptAdvertisement(advertisement(1, { capabilityDigest: "wrong" })), "stale_generation");
  assert.equal(manager.acceptAdvertisement(advertisement(1)).connectionId, "connection-1");
  assert.equal(manager.requireReady("connection-1", 1).generation, 1);
  assert.equal("connectorInstanceNonce" in connected, false);
  assert.deepEqual(closes, []);
});

test("manager owns durable inbound allocation, renewal, and replacement fencing", async () => {
  let now = 1_000;
  let id = 0;
  const directory = new FabricDirectory();
  directory.seedAuthority({ connector: connector(), devices: [device()] });
  const coordinator = new FabricStoreCoordinator(new MemoryFabricStore(), { createId: () => `event-${++id}` });
  const manager = new FabricConnectionManager(directory, new TransportRegistry(), { now: () => now, coordinator });
  const closed: string[] = [];
  const first = await manager.acceptInbound({
    requestId: "inbound-1", connectorId: "connector-a", expectedCredentialGeneration: 2,
    connectorInstanceNonce: "ephemeral-1", capabilityDigest: "digest-a", limits,
    establishedAt: now, expiresAt: 2_000,
  }, { close: async (reason) => { closed.push(reason); } });
  assert.equal(first.generation, 1);
  assert.match(first.connectionId, /^connection-/);
  manager.acceptAdvertisement(advertisement(first.generation, { connectionId: first.connectionId }));

  now = 1_100;
  const renewed = await manager.renewInboundLease(first.connectionId, first.generation, 2_100);
  assert.equal(renewed.expiresAt, 2_100);
  assert.equal(renewed.revision, 1);

  const second = await manager.acceptInbound({
    requestId: "inbound-2", connectorId: "connector-a", expectedCredentialGeneration: 2,
    connectorInstanceNonce: "ephemeral-2", capabilityDigest: "digest-a", limits,
    establishedAt: now, expiresAt: 2_200,
  }, { close: async (reason) => { closed.push(`second:${reason}`); } });
  assert.equal(second.generation, 2);
  assert.notEqual(second.connectionId, first.connectionId);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(closed, ["superseded by a newer connection generation"]);
  expectSyncCode(() => manager.requireReady(first.connectionId, first.generation), "stale_generation");
  await expectCode(manager.renewInboundLease(first.connectionId, first.generation, 2_300), "stale_generation");
});

test("failed inbound commit keeps the durable fence, retires old authority, and permits physical-close retry", async () => {
  let now = 1_000;
  let event = 0;
  let closeAttempts = 0;
  const store = new MemoryFabricStore();
  const directory = new FabricDirectory();
  directory.seedAuthority({ connector: connector(), devices: [device()] });
  const manager = new FabricConnectionManager(directory, new TransportRegistry(), {
    now: () => now,
    coordinator: new FabricStoreCoordinator(store, { createId: () => `event-${++event}` }),
  });
  const first = await manager.acceptInbound({
    requestId: "inbound-1", connectorId: "connector-a", expectedCredentialGeneration: 2,
    connectorInstanceNonce: "ephemeral-1", capabilityDigest: "digest-a", limits,
    establishedAt: now, expiresAt: 2_000,
  }, { close: async () => {
    closeAttempts += 1;
    if (closeAttempts === 1) throw new Error("close fault");
  } });
  manager.acceptAdvertisement(advertisement(first.generation, { connectionId: first.connectionId }));

  store.beforeTransact = (transaction) => {
    const value = transaction.mutations[0]?.value as Record<string, unknown> | undefined;
    if (value?.state === "connected" && value.generation === 2) throw new Error("connected commit fault");
  };
  now = 1_100;
  await assert.rejects(manager.acceptInbound({
    requestId: "inbound-2", connectorId: "connector-a", expectedCredentialGeneration: 2,
    connectorInstanceNonce: "ephemeral-2", capabilityDigest: "digest-a", limits,
    establishedAt: now, expiresAt: 2_100,
  }, { close: async () => undefined }), /connected commit fault/);
  await new Promise((resolve) => setImmediate(resolve));
  expectSyncCode(() => manager.requireReady(first.connectionId, first.generation), "stale_generation");
  assert.equal(closeAttempts, 1);
  store.beforeTransact = undefined;
  assert.equal((await manager.disconnect(first.connectionId, first.generation, "retry superseded close")).state, "closed");
  assert.equal(closeAttempts, 2);
  const durable = await store.record("lease", "connector-a");
  assert.equal(durable?.generation, 2);
  assert.equal(durable?.state, "closed");
});

test("durable cleanup failure still closes the physical owner and each step retries independently", async () => {
  let event = 0;
  let closes = 0;
  const store = new MemoryFabricStore();
  const directory = new FabricDirectory();
  directory.seedAuthority({ connector: connector(), devices: [device()] });
  const manager = new FabricConnectionManager(directory, new TransportRegistry(), {
    now: () => 1_100,
    coordinator: new FabricStoreCoordinator(store, { createId: () => `cleanup-${++event}` }),
  });
  const lease = await manager.acceptInbound({
    requestId: "cleanup-independent", connectorId: "connector-a", expectedCredentialGeneration: 2,
    connectorInstanceNonce: "cleanup-nonce", capabilityDigest: "digest-a", limits,
    establishedAt: 1_000, expiresAt: 2_000,
  }, { close: async () => { closes += 1; } });

  store.beforeTransact = (transaction) => {
    if (transaction.events.some((candidate) => candidate.eventKind === "connection.closed")) {
      throw new Error("durable close fault");
    }
  };
  await expectCode(manager.disconnect(lease.connectionId, lease.generation), "unavailable");
  assert.equal(closes, 1, "durable failure must not skip physical owner finalization");
  assert.equal(manager.get(lease.connectionId)?.state, "closed", "memory fencing is monotonic while cleanup remains pending");
  assert.equal((await store.record("lease", "connector-a"))?.state, "connected");

  store.beforeTransact = undefined;
  assert.equal((await manager.disconnect(lease.connectionId, lease.generation, "retry durable cleanup")).state, "closed");
  assert.equal(closes, 1, "successful owner cleanup is not repeated while durable cleanup retries");
  assert.equal((await store.record("lease", "connector-a"))?.state, "closed");
});

test("synchronous reentrant disconnect coalesces physical owner cleanup", async () => {
  let manager!: FabricConnectionManager;
  let closes = 0;
  let nestedDisconnect: Promise<unknown> | undefined;
  ({ manager } = setup({
    kind: "ssh",
    connect: async () => channel(1, async () => {
      closes += 1;
      nestedDisconnect = manager.disconnect("connection-1", 1, "reentrant disconnect");
    }),
  }));
  await manager.connect(request(), new AbortController().signal);
  manager.acceptAdvertisement(advertisement(1));

  await manager.disconnect("connection-1", 1);
  assert.ok(nestedDisconnect);
  await nestedDisconnect;
  assert.equal(closes, 1);
  assert.equal(manager.get("connection-1")?.state, "closed");
});

test("hung drain persistence cannot block deadline or disconnect owner cleanup", async () => {
  for (const trigger of ["deadline", "disconnect"] as const) {
    let event = 0;
    let deadlineCallback: (() => void) | undefined;
    let closes = 0;
    const store = new MemoryFabricStore();
    const directory = new FabricDirectory();
    directory.seedAuthority({ connector: connector(), devices: [device()] });
    const scheduler: FabricDeadlineScheduler = {
      schedule(_deadlineAt, callback) { deadlineCallback = callback; return "timer"; },
      cancel() { /* the hung durable operation deliberately retains the active record */ },
    };
    const manager = new FabricConnectionManager(directory, new TransportRegistry(), {
      now: () => 1_000,
      scheduler,
      coordinator: new FabricStoreCoordinator(store, { createId: () => `${trigger}-${++event}` }),
    });
    const lease = await manager.acceptInbound({
      requestId: `hung-drain-${trigger}`, connectorId: "connector-a", expectedCredentialGeneration: 2,
      connectorInstanceNonce: `hung-drain-${trigger}`, capabilityDigest: "digest-a", limits,
      establishedAt: 1_000, expiresAt: 2_000,
    }, { close: async () => { closes += 1; } });

    let entered!: () => void;
    const enteredPersistence = new Promise<void>((resolve) => { entered = resolve; });
    const neverSettles = new Promise<void>(() => undefined);
    store.beforeTransact = async (transaction) => {
      if (!transaction.events.some((candidate) => candidate.eventKind === "connection.draining")) return;
      entered();
      await neverSettles;
    };
    manager.drain(lease.connectionId, lease.generation, 1_100);
    await enteredPersistence;

    if (trigger === "deadline") {
      deadlineCallback?.();
    } else {
      void manager.disconnect(lease.connectionId, lease.generation, "forced while drain persistence is hung").then(
        () => undefined,
        () => undefined,
      );
    }
    await waitForCondition(() => closes === 1);
    assert.equal(manager.get(lease.connectionId)?.state, "closed");
    assert.equal((await store.record("lease", "connector-a"))?.state, "connected", "hung persistence never publishes durable success");
  }
});

test("inbound admission preserves commit and rollback failures and leaves recoverable durable evidence", async () => {
  let event = 0;
  let ownerCloses = 0;
  const store = new MemoryFabricStore();
  const directory = new FabricDirectory();
  directory.seedAuthority({ connector: connector(), devices: [device()] });
  const manager = new FabricConnectionManager(directory, new TransportRegistry(), {
    now: () => 1_000,
    coordinator: new FabricStoreCoordinator(store, { createId: () => `rollback-${++event}` }),
  });
  store.beforeTransact = (transaction) => {
    const next = transaction.mutations[0]?.value as Record<string, unknown> | undefined;
    if (next?.state === "connected") throw new Error("admission commit fault");
    if (next?.state === "closed") throw new Error("reservation rollback fault");
  };

  const failure = await manager.acceptInbound({
    requestId: "rollback-double-fault", connectorId: "connector-a", expectedCredentialGeneration: 2,
    connectorInstanceNonce: "rollback-nonce", capabilityDigest: "digest-a", limits,
    establishedAt: 1_000, expiresAt: 2_000,
  }, { close: async () => { ownerCloses += 1; } }).then(() => undefined, (error: unknown) => error);
  assert.ok(failure instanceof AggregateError);
  assert.match(failure.cause instanceof Error ? failure.cause.message : "", /admission commit fault/);
  assert.deepEqual(failure.errors.map((error) => error instanceof Error ? error.message : String(error)), [
    "admission commit fault",
    "reservation rollback fault",
  ]);
  assert.equal(ownerCloses, 1);
  const orphan = await store.record("lease", "connector-a");
  assert.equal(orphan?.state, "connecting");
  assert.equal(orphan?.generation, 1);

  store.beforeTransact = undefined;
  const recovered = await manager.acceptInbound({
    requestId: "rollback-recovery", connectorId: "connector-a", expectedCredentialGeneration: 2,
    connectorInstanceNonce: "recovery-nonce", capabilityDigest: "digest-a", limits,
    establishedAt: 1_000, expiresAt: 2_000,
  }, { close: async () => undefined });
  assert.equal(recovered.generation, 2, "the next authenticated admission durably fences the orphan reservation");
  assert.equal((await store.record("lease", "connector-a"))?.state, "connected");
});

test("inbound admission rechecks directory authority and lease expiry after durable awaits", async () => {
  let now = 1_000;
  let event = 0;
  const store = new MemoryFabricStore();
  const directory = new FabricDirectory();
  directory.seedAuthority({ connector: connector(), devices: [device()] });
  const manager = new FabricConnectionManager(directory, new TransportRegistry(), {
    now: () => now,
    coordinator: new FabricStoreCoordinator(store, { createId: () => `event-${++event}` }),
  });
  let transactionCount = 0;
  store.beforeTransact = () => {
    transactionCount += 1;
    if (transactionCount === 1) {
      directory.seedAuthority({ connector: connector({ enabled: false, revision: 2 }), devices: [device()] });
    }
  };
  await expectCode(manager.acceptInbound({
    requestId: "authority-race", connectorId: "connector-a", expectedCredentialGeneration: 2,
    connectorInstanceNonce: "ephemeral-1", capabilityDigest: "digest-a", limits,
    establishedAt: now, expiresAt: 1_100,
  }, { close: async () => undefined }), "stale_generation");
  assert.equal((await store.record("lease", "connector-a"))?.state, "closed");

  directory.seedAuthority({ connector: connector({ revision: 3 }), devices: [device()] });
  transactionCount = 0;
  store.beforeTransact = (transaction) => {
    transactionCount += 1;
    const value = transaction.mutations[0]?.value as Record<string, unknown> | undefined;
    if (value?.state === "connected") now = 1_200;
  };
  await expectCode(manager.acceptInbound({
    requestId: "expiry-race", connectorId: "connector-a", expectedCredentialGeneration: 2,
    connectorInstanceNonce: "ephemeral-2", capabilityDigest: "digest-a", limits,
    establishedAt: 1_000, expiresAt: 1_150,
  }, { close: async () => undefined }), "expired");
  assert.equal((await store.record("lease", "connector-a"))?.state, "closed");
});

test("inbound renewal rechecks authority, expiry, and lifecycle state", async () => {
  for (const boundary of ["disabled", "expired", "draining"] as const) {
    let now = 1_000;
    let event = 0;
    const store = new MemoryFabricStore();
    const directory = new FabricDirectory();
    directory.seedAuthority({ connector: connector(), devices: [device()] });
    const manager = new FabricConnectionManager(directory, new TransportRegistry(), {
      now: () => now,
      coordinator: new FabricStoreCoordinator(store, { createId: () => `${boundary}-${++event}` }),
    });
    const lease = await manager.acceptInbound({
      requestId: `renew-${boundary}`, connectorId: "connector-a", expectedCredentialGeneration: 2,
      connectorInstanceNonce: `nonce-${boundary}`, capabilityDigest: "digest-a", limits,
      establishedAt: now, expiresAt: 1_200,
    }, { close: async () => undefined });
    if (boundary === "disabled") {
      directory.seedAuthority({ connector: connector({ enabled: false, revision: 2 }), devices: [device()] });
      await expectCode(manager.renewInboundLease(lease.connectionId, lease.generation, 1_300), "stale_generation");
    } else if (boundary === "expired") {
      now = 1_200;
      await expectCode(manager.renewInboundLease(lease.connectionId, lease.generation, 1_300), "expired");
    } else {
      manager.drain(lease.connectionId, lease.generation, 1_100);
      await expectCode(manager.renewInboundLease(lease.connectionId, lease.generation, 1_300), "invalid_state");
    }
  }
});

test("inbound renewal rechecks directory authority and prior expiry after its durable await", async () => {
  for (const boundary of ["directory", "expiry"] as const) {
    let now = 1_000;
    let event = 0;
    const store = new MemoryFabricStore();
    const directory = new FabricDirectory();
    directory.seedAuthority({ connector: connector(), devices: [device()] });
    const manager = new FabricConnectionManager(directory, new TransportRegistry(), {
      now: () => now,
      coordinator: new FabricStoreCoordinator(store, { createId: () => `renew-post-${boundary}-${++event}` }),
    });
    let closes = 0;
    const lease = await manager.acceptInbound({
      requestId: `renew-post-${boundary}`, connectorId: "connector-a", expectedCredentialGeneration: 2,
      connectorInstanceNonce: `renew-post-${boundary}`, capabilityDigest: "digest-a", limits,
      establishedAt: now, expiresAt: 1_100,
    }, { close: async () => { closes += 1; } });
    store.beforeTransact = (transaction) => {
      if (!transaction.events.some((candidate) => candidate.eventKind === "connection.renewed")) return;
      store.beforeTransact = undefined;
      if (boundary === "directory") {
        directory.seedAuthority({ connector: connector({ enabled: false, revision: 2 }), devices: [device()] });
      } else {
        now = 1_100;
      }
    };
    await expectCode(
      manager.renewInboundLease(lease.connectionId, lease.generation, 1_300),
      boundary === "directory" ? "stale_generation" : "expired",
    );
    await waitForCondition(() => closes === 1);
    assert.equal((await store.record("lease", "connector-a"))?.state, "closed");
  }
});

test("disconnect wins a renewal paused inside durable persistence", async () => {
  let now = 1_000;
  let event = 0;
  const store = new MemoryFabricStore();
  const directory = new FabricDirectory();
  directory.seedAuthority({ connector: connector(), devices: [device()] });
  const manager = new FabricConnectionManager(directory, new TransportRegistry(), {
    now: () => now,
    coordinator: new FabricStoreCoordinator(store, { createId: () => `renew-race-${++event}` }),
  });
  let closes = 0;
  const lease = await manager.acceptInbound({
    requestId: "renew-race", connectorId: "connector-a", expectedCredentialGeneration: 2,
    connectorInstanceNonce: "renew-race-nonce", capabilityDigest: "digest-a", limits,
    establishedAt: now, expiresAt: 1_500,
  }, { close: async () => { closes += 1; } });
  let entered!: () => void;
  const enteredCommit = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const commitGate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  store.beforeTransact = async (transaction) => {
    if (!held && transaction.events.some((candidate) => candidate.eventKind === "connection.renewed")) {
      held = true;
      entered();
      await commitGate;
    }
  };
  const renewal = manager.renewInboundLease(lease.connectionId, lease.generation, 1_700);
  await enteredCommit;
  const disconnect = manager.disconnect(lease.connectionId, lease.generation, "closure wins");
  release();
  await expectCode(renewal, "invalid_state");
  assert.equal((await disconnect).state, "closed");
  assert.equal(closes, 1);
  const durable = await store.record("lease", "connector-a");
  assert.equal(durable?.state, "closed");
  assert.equal(durable?.expiresAt, 1_500, "closure overwrote the in-flight renewal rather than publishing it");
});

test("inbound admission fails closed on malformed prior durable connection records", async () => {
  for (const malformed of [
    { connectionId: "old", connectorId: "connector-a", deviceId: "device-a", generation: 1, state: "unknown", expiresAt: 2_000 },
    { connectionId: "old", connectorId: "connector-other", deviceId: "device-a", generation: 1, state: "closed", expiresAt: 2_000 },
    {
      connectionId: "old", connectorId: "connector-a", deviceId: "device-a", generation: 1, state: "closed", expiresAt: 2_000,
      connectorInstanceNonce: "bad nonce", capabilityDigest: "digest-a", establishedAt: 1_000, connectionRevision: 0,
    },
    { connectionId: "bad identity", connectorId: "connector-a", deviceId: "device-a", generation: 1, state: "closed", expiresAt: 2_000 },
  ] as Array<Record<string, string | number>>) {
    let event = 0;
    const store = new MemoryFabricStore();
    const coordinator = new FabricStoreCoordinator(store, { createId: () => `malformed-${++event}` });
    await coordinator.commit("lease", 1_000, () => ({
      mutations: [{
        kind: "upsert", subjectId: "connector-a", expectedRevision: undefined,
        value: { revision: 1, kind: "connection", ...malformed },
        eventKind: "test.seed", payload: {},
      }],
      value: undefined,
    }));
    const directory = new FabricDirectory();
    directory.seedAuthority({ connector: connector(), devices: [device()] });
    const manager = new FabricConnectionManager(directory, new TransportRegistry(), { now: () => 1_000, coordinator });
    await expectCode(manager.acceptInbound({
      requestId: "malformed-prior", connectorId: "connector-a", expectedCredentialGeneration: 2,
      connectorInstanceNonce: "nonce", capabilityDigest: "digest-a", limits,
      establishedAt: 1_000, expiresAt: 2_000,
    }, { close: async () => undefined }), "protocol_violation");
    assert.deepEqual(await store.record("lease", "connector-a"), { revision: 1, kind: "connection", ...malformed });
  }
});

test("provider descriptor limits, nonce, identity, and generation are verified with bounded errors", async () => {
  const closeReasons: string[] = [];
  const invalidLimits = { ...limits, maxFrameBytes: limits.maxFrameBytes + 1 };
  const badLimits = setup({ kind: "ssh", connect: async () => channel(1, async (reason) => { closeReasons.push(reason); }, {}, invalidLimits) });
  await expectCode(badLimits.manager.connect(request(), new AbortController().signal), "protocol_violation");

  const badNonce = setup({ kind: "ssh", connect: async () => channel(1, async () => undefined, { connectorInstanceNonce: "wrong" }) });
  await expectCode(badNonce.manager.connect(request(), new AbortController().signal), "conflict");

  const unsafe = setup({ kind: "ssh", connect: async () => { throw new Error("secret:" + "x".repeat(5000)); } });
  await assert.rejects(unsafe.manager.connect(request(), new AbortController().signal), (error: unknown) => {
    return error instanceof FabricContractError && error.code === "unavailable" && error.message.length < 1024 && !error.message.includes("secret");
  });
  assert.equal(closeReasons.length, 1);
});

test("provider descriptor digest and negotiated limits are revalidated at readiness and later admission", async () => {
  const mutable = channel(1, async () => undefined);
  const { manager } = setup({ kind: "ssh", connect: async () => mutable });
  await manager.connect(request(), new AbortController().signal);
  manager.acceptAdvertisement(advertisement(1));
  mutable.descriptor.lease.capabilityDigest = "changed-digest";
  expectSyncCode(() => manager.requireReady("connection-1", 1), "protocol_violation");

  const mutableLimits = channel(1, async () => undefined, {}, { ...limits });
  const second = setup({ kind: "ssh", connect: async () => mutableLimits });
  await second.manager.connect(request(), new AbortController().signal);
  mutableLimits.descriptor.limits.maxResultBytes += 1;
  expectSyncCode(() => second.manager.acceptAdvertisement(advertisement(1)), "protocol_violation");
});

test("directory authority is re-read after provider await", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const closes: string[] = [];
  const { directory, manager } = setup({
    kind: "ssh",
    connect: async () => {
      await gate;
      return channel(1, async (reason) => { closes.push(reason); });
    },
  });
  const pending = manager.connect(request(), new AbortController().signal);
  directory.seedAuthority({ connector: connector(), devices: [device({ enabled: false, revision: 2 })] });
  release?.();
  await expectCode(pending, "stale_generation");
  assert.equal(closes.length, 1);
});

test("every ready/admission check fences device and connector ownership revisions and credentials", async () => {
  const cases: Array<{ name: string; connector: ConnectorRecord; device: DeviceRecord }> = [
    { name: "device enabled", connector: connector(), device: device({ enabled: false, revision: 2 }) },
    { name: "device revision", connector: connector(), device: device({ label: "renamed", revision: 2 }) },
    { name: "connector enabled", connector: connector({ enabled: false, revision: 2 }), device: device() },
    { name: "credential generation", connector: connector({ credentialGeneration: 3, revision: 2 }), device: device() },
    { name: "instance nonce", connector: connector({ instanceNonce: "nonce-b", revision: 2 }), device: device() },
  ];
  for (const entry of cases) {
    const closes: string[] = [];
    const { directory, manager } = setup({ kind: "ssh", connect: async () => channel(1, async (reason) => { closes.push(reason); }) });
    await manager.connect(request(), new AbortController().signal);
    manager.acceptAdvertisement(advertisement(1));
    directory.seedAuthority({ connector: entry.connector, devices: [entry.device] });
    expectSyncCode(() => manager.requireReady("connection-1", 1), "stale_generation");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closes.length, 1, entry.name);
  }
});

test("one current connection per Connector is enforced even across different owned Devices", async () => {
  const directory = new FabricDirectory();
  directory.seedAuthority({ connector: connector(), devices: [device(), device({ deviceId: "device-b", label: "Device B" })] });
  const transports = new TransportRegistry();
  transports.register({ kind: "ssh", connect: async (input) => channel(1, async () => undefined, { deviceId: input.deviceId }) });
  const manager = new FabricConnectionManager(directory, transports, { now: () => 1000 });
  await manager.connect(request(), new AbortController().signal);
  await expectCode(manager.connect(request({ requestId: "request-b", deviceId: "device-b" }), new AbortController().signal), "conflict");
});

test("closing reservation blocks replacement; failed close is retryable and releases only after success", async () => {
  let closeAttempts = 0;
  let generation = 1;
  const { manager } = setup({
    kind: "ssh",
    connect: async () => channel(generation, async () => {
      closeAttempts += 1;
      if (closeAttempts === 1) throw new Error("still open");
    }),
  });
  await manager.connect(request(), new AbortController().signal);
  manager.acceptAdvertisement(advertisement(1));
  await expectCode(manager.disconnect("connection-1", 1), "unavailable");
  generation = 2;
  await expectCode(manager.connect(request({ requestId: "replacement" }), new AbortController().signal), "conflict");
  assert.equal((await manager.disconnect("connection-1", 1)).state, "closed");
  assert.equal(closeAttempts, 2);
  await manager.connect(request({ requestId: "replacement" }), new AbortController().signal);
});

test("drain stops admission and an injected deadline scheduler fences and closes automatically", async () => {
  let callback: (() => void) | undefined;
  let scheduledAt = 0;
  const scheduler: FabricDeadlineScheduler = {
    schedule(deadlineAt, action) { scheduledAt = deadlineAt; callback = action; return "timer"; },
    cancel() { /* observable cancellation is not needed for this deterministic scheduler */ },
  };
  const closes: string[] = [];
  const { manager } = setup(
    { kind: "ssh", connect: async () => channel(1, async (reason) => { closes.push(reason); }) },
    { scheduler },
  );
  await manager.connect(request(), new AbortController().signal);
  manager.acceptAdvertisement(advertisement(1));
  assert.equal(manager.drain("connection-1", 1, 1200).state, "draining");
  assert.equal(scheduledAt, 1200);
  expectSyncCode(() => manager.requireReady("connection-1", 1), "invalid_state");
  callback?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closes.length, 1);
  assert.equal(manager.get("connection-1")?.state, "closed");
});

test("closed channels are released into bounded terminal metadata with explicit compaction", async () => {
  let generation = 1;
  const { manager } = setup(
    { kind: "ssh", connect: async () => channel(generation, async () => undefined) },
    { terminalCapacity: 1 },
  );
  await manager.connect(request(), new AbortController().signal);
  manager.acceptAdvertisement(advertisement(1));
  await manager.disconnect("connection-1", 1);
  generation = 2;
  await manager.connect(request({ requestId: "request-2" }), new AbortController().signal);
  manager.acceptAdvertisement(advertisement(2));
  await manager.disconnect("connection-2", 2);
  assert.equal(manager.get("connection-1"), undefined);
  assert.equal(manager.get("connection-2")?.state, "closed");
  assert.equal(manager.compactTerminals(), 1);
  assert.equal(manager.list().length, 0);
});

test("terminal capacity zero returns the closed projection without retaining metadata", async () => {
  const { manager } = setup(
    { kind: "ssh", connect: async () => channel(1, async () => undefined) },
    { terminalCapacity: 0 },
  );
  await manager.connect(request(), new AbortController().signal);
  manager.acceptAdvertisement(advertisement(1));
  const closed = await manager.disconnect("connection-1", 1);
  assert.equal(closed.connectionId, "connection-1");
  assert.equal(closed.state, "closed");
  assert.equal(manager.get("connection-1"), undefined);
});

test("readiness always uses the manager-owned clock", async () => {
  let now = 1000;
  const { manager } = setup(
    { kind: "ssh", connect: async () => channel(1, async () => undefined) },
    { now: () => now },
  );
  await manager.connect(request(), new AbortController().signal);
  manager.acceptAdvertisement(advertisement(1));
  now = 2000;
  expectSyncCode(() => manager.requireReady("connection-1", 1), "expired");
});

test("abort and pre-open authority errors fail closed", async () => {
  let opens = 0;
  const { manager } = setup({ kind: "ssh", connect: async () => { opens += 1; return channel(1, async () => undefined); } });
  await expectCode(manager.connect(request({ expectedCredentialGeneration: 1 }), new AbortController().signal), "stale_generation");
  await expectCode(manager.connect(request({ deadlineAt: 1000 }), new AbortController().signal), "deadline_exceeded");
  const aborted = new AbortController();
  aborted.abort();
  await expectCode(manager.connect(request(), aborted.signal), "cancelled");
  assert.equal(opens, 0);
});
