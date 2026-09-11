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
  TransportRegistry,
  type FabricAdvertisementSnapshot,
  type FabricDeadlineScheduler,
} from "../src/index.ts";

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
