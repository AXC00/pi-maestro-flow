import assert from "node:assert/strict";
import test from "node:test";
import {
  FabricContractError,
  type ConnectorRecord,
  type DeviceRecord,
} from "pi-maestro-fabric-core/v1";
import {
  FabricConnectionManager,
  FabricDirectory,
  FabricStoreCoordinator,
  TransportRegistry,
  type FabricAdvertisementDelta,
  type FabricAdvertisementSnapshot,
  type FabricDurableAdvertisementAdmission,
  type FabricOfflineInventorySeed,
  type FabricStagedAdvertisementCandidate,
} from "../src/index.ts";
import {
  FABRIC_DIRECTORY_RECORD_PERSISTED_ADVERTISEMENT,
  FABRIC_DIRECTORY_STAGE_ADVERTISEMENT,
} from "../src/directory-authority.ts";
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
    connectorId: "connector-a", label: "Connector A", transport: "ssh", credentialGeneration: 1,
    enabled: true, revision: 1, ...overrides,
  };
}

function device(): DeviceRecord {
  return {
    deviceId: "device-a", connectorId: "connector-a", label: "Device A", connectionMode: "ssh",
    enabled: true, revision: 1,
  };
}

function snapshot(
  connectionId: string,
  connectionGeneration: number,
  advertisementRevision = 1,
  recordRevision = 1,
): FabricAdvertisementSnapshot {
  return {
    connectionId,
    connectionGeneration,
    capabilityDigest: "digest-a",
    advertisementRevision,
    devices: [device()],
    workspaces: [{
      workspaceId: "workspace-a", deviceId: "device-a", localWorkspaceId: "local-a",
      label: "Workspace A", mode: "permanent", generation: 1, policyDigest: "policy-a",
      endpointIds: ["endpoint-a"], revision: recordRevision,
    }],
    endpoints: [{
      endpointId: "endpoint-a", deviceId: "device-a", connectorId: "connector-a",
      scope: { kind: "workspace", workspaceId: "workspace-a" }, generation: 1,
      contractHash: "contract-a", status: "online", revision: recordRevision,
      kind: "agent", roles: ["general"], taskTypes: ["development"], models: ["provider/model"], maxConcurrency: 1,
    }],
    capabilities: [{
      capabilityId: "capability-a", kind: "agent-competency", endpointId: "endpoint-a",
      contractHash: "contract-a", trustLevel: "owner", priority: 1,
    }],
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
}

interface Fixture {
  directory: FabricDirectory;
  manager: FabricConnectionManager;
  lease: { connectionId: string; generation: number };
  closes: string[];
}

async function fixture(
  admission: FabricDurableAdvertisementAdmission,
  options: { directory?: FabricDirectory; coordinator?: FabricStoreCoordinator; nonce?: string } = {},
): Promise<Fixture> {
  const directory = options.directory ?? new FabricDirectory();
  if (directory.getConnector("connector-a") === undefined) directory.seedAuthority({ connector: connector(), devices: [device()] });
  const closes: string[] = [];
  const manager = new FabricConnectionManager(directory, new TransportRegistry(), {
    now: () => 1_100,
    advertisementAdmission: admission,
    ...(options.coordinator === undefined ? {} : { coordinator: options.coordinator }),
  });
  const lease = await manager.acceptInbound({
    requestId: `request-${options.nonce ?? "a"}`,
    connectorId: "connector-a",
    expectedCredentialGeneration: 1,
    connectorInstanceNonce: `nonce-${options.nonce ?? "a"}`,
    capabilityDigest: "digest-a",
    limits,
    establishedAt: 1_000,
    expiresAt: 2_000,
  }, { close: async (reason) => { closes.push(reason); } });
  return { directory, manager, lease, closes };
}

function offlineSeed(candidate: FabricStagedAdvertisementCandidate): FabricOfflineInventorySeed {
  return {
    connectorId: candidate.connectorId,
    connectionId: candidate.connectionId,
    connectionGeneration: candidate.connectionGeneration,
    credentialGeneration: candidate.credentialGeneration,
    capabilityDigest: candidate.capabilityDigest,
    advertisementRevision: candidate.advertisementRevision,
    acceptedAt: candidate.preparedAt,
    devices: candidate.devices,
    workspaces: candidate.workspaces,
    endpoints: candidate.endpoints,
    capabilities: candidate.capabilities,
    tombstones: candidate.removals,
  };
}

async function expectFabricFailure(promise: Promise<unknown>, codes: readonly FabricContractError["code"][]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof FabricContractError && codes.includes(error.code));
}

test("durable configuration rejects the legacy synchronous publication API", async () => {
  let persisted = false;
  const current = await fixture({ kind: "durable", persist: async () => { persisted = true; } });
  assert.throws(
    () => current.manager.acceptAdvertisement(snapshot(current.lease.connectionId, current.lease.generation)),
    (error: unknown) => error instanceof FabricContractError && error.code === "invalid_state",
  );
  assert.equal(persisted, false);
  assert.equal(current.directory.getWorkspace("workspace-a"), undefined);
});

test("durable admission keeps the candidate immutable and invisible while persistence is blocked", async () => {
  const entered = deferred();
  const release = deferred();
  let captured: FabricStagedAdvertisementCandidate | undefined;
  const current = await fixture({ kind: "durable", persist: async (candidate) => {
    captured = candidate;
    entered.resolve();
    await release.promise;
  } });
  const pending = current.manager.admitAdvertisement(snapshot(current.lease.connectionId, current.lease.generation));
  await entered.promise;
  assert.ok(captured);
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(Object.isFrozen(captured.workspaces[0]), true);
  assert.equal(current.directory.getWorkspace("workspace-a"), undefined);
  assert.equal(current.directory.getOfflineInventory("connector-a"), undefined);
  assert.throws(() => current.manager.requireReady(current.lease.connectionId, current.lease.generation), {
    name: "FabricContractError",
  });
  release.resolve();
  await pending;
  assert.equal(current.directory.getWorkspace("workspace-a")?.workspaceId, "workspace-a");
  assert.equal(current.directory.getOfflineInventory("connector-a")?.workspaces[0]?.workspaceId, "workspace-a");
});

test("shutdown admission epoch fences in-flight persistence and withdraws executable publication", async () => {
  const entered = deferred();
  const release = deferred();
  const current = await fixture({ kind: "durable", persist: async () => {
    entered.resolve();
    await release.promise;
  } });
  const pending = current.manager.admitAdvertisement(snapshot(current.lease.connectionId, current.lease.generation));
  await entered.promise;
  current.manager.fenceAdvertisementAdmission("Gateway shutdown started");
  release.resolve();
  await expectFabricFailure(pending, ["unavailable"]);
  assert.equal(current.directory.getWorkspace("workspace-a"), undefined);
  assert.equal(current.directory.getOfflineInventory("connector-a"), undefined);
  assert.throws(
    () => current.manager.acceptAdvertisement(snapshot(current.lease.connectionId, current.lease.generation)),
    (error: unknown) => error instanceof FabricContractError && error.code === "unavailable",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(current.closes.length, 1);
});

test("disconnect or owner replacement during blocked persistence prevents publish but retains committed offline evidence", async () => {
  for (const boundary of ["disconnect", "replacement"] as const) {
    const entered = deferred();
    const release = deferred();
    let calls = 0;
    const admission: FabricDurableAdvertisementAdmission = { kind: "durable", persist: async () => {
      calls += 1;
      if (calls === 1) {
        entered.resolve();
        await release.promise;
      }
    } };
    const current = await fixture(admission);
    const pending = current.manager.admitAdvertisement(snapshot(current.lease.connectionId, current.lease.generation));
    await entered.promise;
    let disconnect: Promise<unknown> | undefined;
    let successor: { connectionId: string; generation: number } | undefined;
    if (boundary === "disconnect") {
      disconnect = current.manager.disconnect(current.lease.connectionId, current.lease.generation, "disconnect wins admission");
    } else {
      successor = await current.manager.acceptInbound({
        requestId: "request-successor", connectorId: "connector-a", expectedCredentialGeneration: 1,
        connectorInstanceNonce: "nonce-successor", capabilityDigest: "digest-a", limits,
        establishedAt: 1_000, expiresAt: 2_000,
      }, { close: async () => undefined });
    }
    release.resolve();
    await expectFabricFailure(pending, ["invalid_state", "stale_generation"]);
    await disconnect;
    assert.equal(current.directory.getWorkspace("workspace-a"), undefined);
    assert.equal(current.directory.getOfflineInventory("connector-a")?.connectionGeneration, current.lease.generation);
    if (successor !== undefined) {
      await current.manager.admitAdvertisement(snapshot(successor.connectionId, successor.generation));
      assert.equal(current.manager.requireReady(successor.connectionId, successor.generation).generation, successor.generation);
    }
  }
});

test("commit success immediately before disconnect is offline evidence but never executable readiness", async () => {
  let manager!: FabricConnectionManager;
  let disconnect: Promise<unknown> | undefined;
  const current = await fixture({ kind: "durable", persist: async (candidate) => {
    assert.equal(candidate.connectionGeneration, 1, "the persistence callback observes the exact staged owner");
    disconnect = manager.disconnect(candidate.connectionId, candidate.connectionGeneration, "disconnect after durable commit");
  } });
  manager = current.manager;
  await expectFabricFailure(
    manager.admitAdvertisement(snapshot(current.lease.connectionId, current.lease.generation)),
    ["invalid_state", "stale_generation"],
  );
  await disconnect;
  assert.equal(current.directory.getWorkspace("workspace-a"), undefined);
  assert.equal(current.directory.getOfflineInventory("connector-a")?.advertisementRevision, 1);
  assert.equal(current.closes.length, 1);
});

test("credential rotation during persistence fails closed and does not publish ready", async () => {
  const entered = deferred();
  const release = deferred();
  const current = await fixture({ kind: "durable", persist: async () => {
    entered.resolve();
    await release.promise;
  } });
  const pending = current.manager.admitAdvertisement(snapshot(current.lease.connectionId, current.lease.generation));
  await entered.promise;
  current.directory.seedAuthority({ connector: connector({ credentialGeneration: 2, revision: 2 }), devices: [device()] });
  release.resolve();
  await expectFabricFailure(pending, ["stale_generation"]);
  assert.equal(current.directory.getWorkspace("workspace-a"), undefined);
  assert.equal(current.directory.getOfflineInventory("connector-a")?.credentialGeneration, 1);
  assert.equal(current.closes.length, 1);
});

test("persistence rejection is exposed, closes the owner, and leaves no partial inventory", async () => {
  const failure = new Error("registry commit failed");
  const current = await fixture({ kind: "durable", persist: async () => { throw failure; } });
  await assert.rejects(
    current.manager.admitAdvertisement(snapshot(current.lease.connectionId, current.lease.generation)),
    (error: unknown) => error === failure,
  );
  assert.equal(current.directory.getWorkspace("workspace-a"), undefined);
  assert.equal(current.directory.getOfflineInventory("connector-a"), undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(current.closes.length, 1);
});

test("a committed delta is atomic and a failed successor never exposes partial executable or offline state", async () => {
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  const current = await fixture({ kind: "durable", persist: async () => {
    calls += 1;
    if (calls === 3) {
      entered.resolve();
      await release.promise;
      throw new Error("delta commit failed");
    }
  } });
  await current.manager.admitAdvertisement(snapshot(current.lease.connectionId, current.lease.generation));
  const committed: FabricAdvertisementDelta = {
    connectionId: current.lease.connectionId,
    connectionGeneration: current.lease.generation,
    capabilityDigest: "digest-a",
    baseRevision: 1,
    advertisementRevision: 2,
    upserts: {
      endpoints: [{ ...snapshot(current.lease.connectionId, current.lease.generation, 2, 2).endpoints[0]!, status: "offline" }],
    },
  };
  await current.manager.admitAdvertisementDelta(committed);
  assert.equal(current.directory.getEndpoint("endpoint-a")?.status, "offline");
  assert.equal(current.directory.getOfflineInventory("connector-a")?.advertisementRevision, 2);

  const pending = current.manager.admitAdvertisementDelta({
    ...committed,
    baseRevision: 2,
    advertisementRevision: 3,
    upserts: {
      endpoints: [{ ...snapshot(current.lease.connectionId, current.lease.generation, 3, 3).endpoints[0]!, status: "online" }],
    },
  });
  await entered.promise;
  assert.equal(current.directory.getEndpoint("endpoint-a")?.status, "offline");
  assert.equal(current.directory.getOfflineInventory("connector-a")?.endpoints[0]?.status, "offline");
  release.resolve();
  await assert.rejects(pending, /delta commit failed/);
  assert.equal(current.directory.getEndpoint("endpoint-a"), undefined, "failure fences executable visibility");
  assert.equal(current.directory.getOfflineInventory("connector-a")?.advertisementRevision, 2);
  assert.equal(current.directory.getOfflineInventory("connector-a")?.endpoints[0]?.status, "offline");
});

test("durable removal tombstones survive hydration and fence same-generation resurrection", async () => {
  let latest: FabricStagedAdvertisementCandidate | undefined;
  const current = await fixture({ kind: "durable", persist: async (candidate) => { latest = candidate; } });
  await current.manager.admitAdvertisement(snapshot(current.lease.connectionId, current.lease.generation));
  await current.manager.admitAdvertisementDelta({
    connectionId: current.lease.connectionId,
    connectionGeneration: current.lease.generation,
    capabilityDigest: "digest-a",
    baseRevision: 1,
    advertisementRevision: 2,
    removals: {
      workspaceIds: ["workspace-a"],
      endpointIds: ["endpoint-a"],
      capabilityIds: ["capability-a"],
    },
  });
  const persistedRemoval = latest;
  assert.ok(persistedRemoval);
  assert.deepEqual(current.directory.getOfflineInventory("connector-a")?.workspaces, []);
  assert.deepEqual(current.directory.getOfflineInventory("connector-a")?.tombstones.workspaces, [
    { subjectId: "workspace-a", generation: 1, revision: 1 },
  ]);

  const restarted = new FabricDirectory();
  restarted.seedAuthority({ connector: connector(), devices: [device()] });
  restarted.hydrateOfflineInventory(offlineSeed(persistedRemoval));
  const stale = snapshot("connection-2", 2);
  assert.throws(() => restarted.hydrateOfflineInventory({
    ...offlineSeed(persistedRemoval),
    connectionId: stale.connectionId,
    connectionGeneration: stale.connectionGeneration,
    advertisementRevision: 1,
    devices: stale.devices,
    workspaces: stale.workspaces,
    endpoints: stale.endpoints,
    capabilities: stale.capabilities,
    tombstones: undefined,
  }), (error: unknown) => error instanceof FabricContractError && error.code === "stale_generation");

  const advancedBase = snapshot("connection-2", 2);
  const advanced: FabricAdvertisementSnapshot = {
    ...advancedBase,
    workspaces: [{ ...advancedBase.workspaces[0]!, generation: 2 }],
    endpoints: [{ ...advancedBase.endpoints[0]!, generation: 2 }],
  };
  restarted.hydrateOfflineInventory({
    ...offlineSeed(persistedRemoval),
    connectionId: advanced.connectionId,
    connectionGeneration: advanced.connectionGeneration,
    advertisementRevision: 1,
    devices: advanced.devices,
    workspaces: advanced.workspaces,
    endpoints: advanced.endpoints,
    capabilities: advanced.capabilities,
    tombstones: undefined,
  });
  assert.equal(restarted.getOfflineInventory("connector-a")?.workspaces[0]?.workspaceId, "workspace-a");
});

test("restart hydration is offline-only and requires a newer connection plus a full snapshot", async () => {
  const store = new MemoryFabricStore();
  let id = 0;
  const coordinator = new FabricStoreCoordinator(store, { createId: () => `event-${++id}` });
  let durableCandidate: FabricStagedAdvertisementCandidate | undefined;
  const first = await fixture({ kind: "durable", persist: async (candidate) => { durableCandidate = candidate; } }, { coordinator, nonce: "first" });
  await first.manager.admitAdvertisement(snapshot(first.lease.connectionId, first.lease.generation));
  assert.ok(durableCandidate);
  await first.manager.disconnect(first.lease.connectionId, first.lease.generation, "restart");

  const restartedDirectory = new FabricDirectory();
  restartedDirectory.seedAuthority({ connector: connector(), devices: [device()] });
  restartedDirectory.hydrateOfflineInventory(offlineSeed(durableCandidate));
  assert.equal(restartedDirectory.getOfflineInventory("connector-a")?.workspaces[0]?.workspaceId, "workspace-a");
  assert.equal(restartedDirectory.getWorkspace("workspace-a"), undefined);
  assert.equal(restartedDirectory.getEndpoint("endpoint-a"), undefined);
  assert.deepEqual(restartedDirectory.list().workspaces, []);

  const second = await fixture({ kind: "durable", persist: async () => undefined }, {
    directory: restartedDirectory,
    coordinator,
    nonce: "second",
  });
  assert.ok(second.lease.generation > first.lease.generation);
  await expectFabricFailure(second.manager.admitAdvertisementDelta({
    connectionId: second.lease.connectionId,
    connectionGeneration: second.lease.generation,
    capabilityDigest: "digest-a",
    baseRevision: 1,
    advertisementRevision: 2,
  }), ["invalid_state"]);
  assert.throws(() => second.manager.requireReady(second.lease.connectionId, second.lease.generation), {
    name: "FabricContractError",
  });
  await second.manager.admitAdvertisement(snapshot(second.lease.connectionId, second.lease.generation));
  assert.equal(second.manager.requireReady(second.lease.connectionId, second.lease.generation).state, "connected");
  assert.equal(restartedDirectory.getWorkspace("workspace-a")?.workspaceId, "workspace-a");
});

test("offline tombstone aggregation rejects the 10,001st identity before in-memory publication", () => {
  const directory = new FabricDirectory();
  directory.seedAuthority({ connector: connector(), devices: [device()] });
  const presentWorkspace = {
    workspaceId: "workspace-present", deviceId: "device-a", localWorkspaceId: "local-present",
    label: "Present Workspace", mode: "permanent" as const, generation: 1, policyDigest: "policy-present",
    endpointIds: [], revision: 1,
  };
  const tombstones = Array.from({ length: 10_000 }, (_unused, index) => ({
    subjectId: `workspace-tombstone-${index}`,
    generation: 1,
    revision: 1,
  }));
  directory.hydrateOfflineInventory({
    connectorId: "connector-a",
    connectionId: "connection-1",
    connectionGeneration: 1,
    credentialGeneration: 1,
    capabilityDigest: "digest-old",
    advertisementRevision: 1,
    acceptedAt: 1_000,
    devices: [device()],
    workspaces: [presentWorkspace],
    endpoints: [],
    capabilities: [],
    tombstones: { workspaces: tombstones },
  });
  const candidate = directory[FABRIC_DIRECTORY_STAGE_ADVERTISEMENT]({
    connectorId: "connector-a",
    connectionId: "connection-2",
    connectionGeneration: 2,
    credentialGeneration: 1,
    capabilityDigest: "digest-new",
    limits,
    preparedAt: 1_100,
  }, {
    connectionId: "connection-2",
    connectionGeneration: 2,
    capabilityDigest: "digest-new",
    advertisementRevision: 1,
    devices: [device()],
    workspaces: [],
    endpoints: [],
    capabilities: [],
  });
  assert.throws(
    () => directory[FABRIC_DIRECTORY_RECORD_PERSISTED_ADVERTISEMENT](candidate),
    (error: unknown) => error instanceof FabricContractError && error.code === "resource_exhausted",
  );
  assert.equal(directory.getOfflineInventory("connector-a")?.workspaces[0]?.workspaceId, "workspace-present");
  assert.equal(directory.getOfflineInventory("connector-a")?.tombstones.workspaces.length, 10_000);
});
