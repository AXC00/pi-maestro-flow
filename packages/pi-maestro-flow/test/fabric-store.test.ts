import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FABRIC_STORE_CURSOR_VERSION,
  FABRIC_STORE_EVENT_VERSION,
  FABRIC_STORE_TRANSACTION_VERSION,
  type FabricStoreTransactionV1,
} from "pi-maestro-fabric-core/v1";
import {
  FabricStoreConflictError,
  FabricStoreRedactionError,
  GatewayFabricStore,
} from "../src/gateway/fabric/store.ts";

async function fixture(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fabric-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "fabric", "state.json");
}

function transaction(overrides: Partial<FabricStoreTransactionV1> = {}): FabricStoreTransactionV1 {
  return {
    version: FABRIC_STORE_TRANSACTION_VERSION,
    transactionId: "tx-1",
    storeKind: "registry",
    expectedRevision: 0,
    nextRevision: 1,
    committedAt: 100,
    mutations: [{ kind: "upsert", subjectId: "device-1", value: { revision: 1, label: "Desk\r\n\u001b[31m", enabled: true } }],
    events: [{
      version: FABRIC_STORE_EVENT_VERSION,
      eventId: "event-1",
      storeKind: "registry",
      sequence: 1,
      eventKind: "device.updated",
      subjectId: "device-1",
      subjectRevision: 1,
      occurredAt: 100,
      payload: { label: "Desk\r\n\u001b[31m" },
    }],
    ...overrides,
  };
}

test("Fabric store commits state and a sanitized outbox atomically, then rejects stale CAS", async (t) => {
  const path = await fixture(t);
  const store = new GatewayFabricStore({ path });

  const committed = await store.transact(transaction());
  assert.equal(committed.replayed, false);
  assert.equal(committed.store.revision, 1);
  assert.equal(committed.store.records["device-1"]?.revision, 1);
  assert.equal(committed.events[0]?.payload.label, "Desk [31m");
  assert.equal((await store.pendingOutbox()).length, 1);

  const stale = transaction({
    transactionId: "tx-stale",
    committedAt: 101,
    mutations: [{ kind: "upsert", subjectId: "device-2", value: { revision: 1 } }],
    events: [{
      version: FABRIC_STORE_EVENT_VERSION,
      eventId: "event-stale",
      storeKind: "registry",
      sequence: 2,
      eventKind: "device.updated",
      subjectId: "device-2",
      subjectRevision: 1,
      occurredAt: 101,
      payload: {},
    }],
  });
  await assert.rejects(store.transact(stale), FabricStoreConflictError);
  assert.equal((await store.readStore("registry")).records["device-2"], undefined);

  await assert.rejects(store.transact(transaction({
    transactionId: "tx-secret",
    expectedRevision: 1,
    nextRevision: 2,
    mutations: [{ kind: "upsert", subjectId: "device-2", value: { revision: 1 } }],
    events: [{
      version: FABRIC_STORE_EVENT_VERSION,
      eventId: "event-secret",
      storeKind: "registry",
      sequence: 2,
      eventKind: "device.updated",
      subjectId: "device-2",
      subjectRevision: 1,
      occurredAt: 102,
      payload: { record: { access_token: "must-not-persist" } },
    }],
  })), FabricStoreRedactionError);
  assert.doesNotMatch(await readFile(path, "utf8"), /must-not-persist/u);
});

test("Fabric store recovers crash-before and crash-after atomic rename without false success", async (t) => {
  const beforePath = await fixture(t);
  const before = new GatewayFabricStore({
    path: beforePath,
    fault: (point) => { if (point === "before-rename") throw new Error("crash-before-rename"); },
  });
  await assert.rejects(before.transact(transaction()), /crash-before-rename/u);
  assert.equal((await new GatewayFabricStore({ path: beforePath }).readStore("registry")).revision, 0);

  const afterPath = join(await mkdtemp(join(tmpdir(), "fabric-store-after-")), "fabric", "state.json");
  t.after(() => rm(join(afterPath, "..", ".."), { recursive: true, force: true }));
  let failAfterRename = true;
  const after = new GatewayFabricStore({
    path: afterPath,
    fault: (point) => {
      if (point === "after-rename" && failAfterRename) {
        failAfterRename = false;
        throw new Error("crash-after-rename");
      }
    },
  });
  const input = transaction({ transactionId: "tx-after" });
  await assert.rejects(after.transact(input), /crash-after-rename/u);

  const restarted = new GatewayFabricStore({ path: afterPath });
  assert.equal((await restarted.readStore("registry")).revision, 1);
  const replay = await restarted.transact(input);
  assert.equal(replay.replayed, true);
  assert.equal((await restarted.pendingOutbox()).length, 1);
});

test("Fabric store migrates legacy cursor shape and fails closed on unknown versions", async (t) => {
  const path = await fixture(t);
  await writeFile(path, JSON.stringify({ storeKind: "event", revision: 0, events: [] }), { encoding: "utf8", flag: "w" }).catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, JSON.stringify({ storeKind: "event", revision: 0, events: [] }), "utf8");
  });
  const migrated = await new GatewayFabricStore({ path }).readStore("event");
  assert.deepEqual(migrated.cursors, []);

  const legacyEvent = transaction().events[0]!;
  const legacyCursor = {
    version: FABRIC_STORE_CURSOR_VERSION,
    consumerId: "legacy-consumer",
    storeKind: "registry" as const,
    nextSequence: 1,
    snapshotRevision: 1,
    updatedAt: 100,
  };
  await writeFile(path, JSON.stringify({ storeKind: "registry", revision: 1, events: [legacyEvent], cursor: legacyCursor }), "utf8");
  const preserved = await new GatewayFabricStore({ path }).readStore("registry");
  assert.deepEqual(preserved.cursors, [legacyCursor]);
  assert.equal(preserved.events[0]?.payload.label, "Desk [31m");

  await writeFile(path, JSON.stringify({
    storeKind: "registry",
    revision: 1,
    events: [{ ...legacyEvent, eventId: "legacy-event-2", sequence: 2 }, legacyEvent],
  }), "utf8");
  await assert.rejects(new GatewayFabricStore({ path }).load(), /not contiguous/u);
  await writeFile(path, JSON.stringify({ storeKind: "event", revision: 0, events: [], cursor: null }), "utf8");
  await assert.rejects(new GatewayFabricStore({ path }).load(), /storeCursor must be an object/u);
  await writeFile(path, JSON.stringify({ version: 99, revision: 0, stores: {}, outbox: [], transactions: [] }), "utf8");
  await assert.rejects(new GatewayFabricStore({ path }).load(), /Unsupported Gateway Fabric store version/u);
  await writeFile(path, "{not-json", "utf8");
  await assert.rejects(new GatewayFabricStore({ path }).load(), /Invalid Gateway JSON/u);
  await writeFile(path, "x".repeat(256), "utf8");
  await assert.rejects(new GatewayFabricStore({ path, maximumBytes: 64 }).load(), /exceeds 64 bytes/u);
});

test("Fabric event retention never discards undelivered events", async (t) => {
  const path = await fixture(t);
  const store = new GatewayFabricStore({ path, maxEventsPerStore: 1, maxOutboxEvents: 4 });
  await store.transact(transaction());
  await assert.rejects(store.transact(transaction({
    transactionId: "tx-2",
    expectedRevision: 1,
    nextRevision: 2,
    committedAt: 101,
    mutations: [{ kind: "upsert", subjectId: "device-1", expectedRevision: 1, value: { revision: 2 } }],
    events: [{
      version: FABRIC_STORE_EVENT_VERSION,
      eventId: "event-2",
      storeKind: "registry",
      sequence: 2,
      eventKind: "device.updated",
      subjectId: "device-1",
      subjectRevision: 2,
      occurredAt: 101,
      payload: {},
    }],
  })), /retention capacity/u);
  assert.deepEqual((await store.pendingOutbox()).map((event) => event.eventId), ["event-1"]);
});

test("Fabric cursors require CAS and the journal outbox has one delivery consumer", async (t) => {
  const path = await fixture(t);
  const store = new GatewayFabricStore({ path });
  await store.transact(transaction());
  await assert.rejects(store.acknowledgeOutbox("event-1", "other-consumer"), /exactly one Gateway journal/u);

  const cursor = {
    version: FABRIC_STORE_CURSOR_VERSION,
    consumerId: "projection-consumer",
    storeKind: "registry" as const,
    nextSequence: 2,
    snapshotRevision: 1,
    updatedAt: 100,
  };
  await store.advanceCursor(cursor, 1);
  await assert.rejects(store.advanceCursor({ ...cursor, updatedAt: 101 }, 1), /cursor CAS is stale/u);

  const raw = JSON.parse(await readFile(path, "utf8")) as { stores: { registry: { highWaterMark: number } } };
  raw.stores.registry.highWaterMark = 10;
  await writeFile(path, JSON.stringify(raw), "utf8");
  await assert.rejects(store.load(), /high-water mark disagrees/u);
});

test("Fabric persisted outbox ordering must match each logical event stream", async (t) => {
  const path = await fixture(t);
  const store = new GatewayFabricStore({ path });
  await store.transact(transaction());
  await store.transact(transaction({
    transactionId: "tx-2",
    expectedRevision: 1,
    nextRevision: 2,
    committedAt: 101,
    mutations: [{ kind: "upsert", subjectId: "device-1", expectedRevision: 1, value: { revision: 2 } }],
    events: [{
      version: FABRIC_STORE_EVENT_VERSION,
      eventId: "event-2",
      storeKind: "registry",
      sequence: 2,
      eventKind: "device.updated",
      subjectId: "device-1",
      subjectRevision: 2,
      occurredAt: 101,
      payload: {},
    }],
  }));
  const raw = JSON.parse(await readFile(path, "utf8")) as { outbox: unknown[] };
  raw.outbox.reverse();
  await writeFile(path, JSON.stringify(raw), "utf8");
  await assert.rejects(store.load(), /outbox is not contiguous/u);
});
