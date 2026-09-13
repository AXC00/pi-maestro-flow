import assert from "node:assert/strict";
import test from "node:test";
import {
  FABRIC_STORE_EVENT_VERSION,
  FABRIC_STORE_TRANSACTION_VERSION,
  FabricContractError,
  type FabricStoreKind,
  type FabricStoreTransactionV1,
} from "pi-maestro-fabric-core/v1";
import {
  FabricStoreCoordinator,
  type FabricDurableStore,
  type FabricLogicalStoreSnapshot,
} from "../src/store-coordinator.ts";
import { MemoryFabricStore } from "./memory-store.ts";

function emptySnapshot(storeKind: FabricStoreKind, revision = 0): FabricLogicalStoreSnapshot {
  return { storeKind, revision, records: {}, highWaterMark: revision };
}

function storeConflict(message: string): Error {
  return Object.assign(new Error(message), { name: "FabricStoreConflictError" });
}

test("commit retries one unrelated logical-store revision race and commits only the successful plan", async () => {
  const memory = new MemoryFabricStore();
  const transactions: FabricStoreTransactionV1[] = [];
  let injected = false;
  const store: FabricDurableStore = {
    readStore: (storeKind) => memory.readStore(storeKind),
    transact: async (transaction) => {
      transactions.push(structuredClone(transaction));
      if (!injected) {
        injected = true;
        await memory.transact({
          version: FABRIC_STORE_TRANSACTION_VERSION,
          transactionId: "race-transaction",
          storeKind: transaction.storeKind,
          expectedRevision: 0,
          nextRevision: 1,
          committedAt: 1_000,
          mutations: [{
            kind: "upsert",
            subjectId: "unrelated-subject",
            expectedRevision: undefined,
            value: { revision: 1, label: "unrelated" },
          }],
          events: [{
            version: FABRIC_STORE_EVENT_VERSION,
            eventId: "race-event",
            storeKind: transaction.storeKind,
            sequence: 1,
            eventKind: "unrelated.updated",
            subjectId: "unrelated-subject",
            subjectRevision: 1,
            occurredAt: 1_000,
            payload: {},
          }],
        });
      }
      await memory.transact(transaction);
    },
  };
  let id = 0;
  let prepareCalls = 0;
  const coordinator = new FabricStoreCoordinator(store, { createId: () => `coordinator-${++id}` });

  const result = await coordinator.commit("lease", 1_001, (snapshot) => {
    prepareCalls += 1;
    const currentRevision = snapshot.records["target-subject"]?.revision as number | undefined;
    return {
      mutations: [{
        kind: "upsert" as const,
        subjectId: "target-subject",
        expectedRevision: currentRevision,
        value: { revision: (currentRevision ?? 0) + 1, preparedOn: snapshot.revision },
        eventKind: "target.updated",
      }],
      value: `prepared-${snapshot.revision}`,
    };
  });

  assert.equal(result, "prepared-1");
  assert.equal(prepareCalls, 2);
  assert.equal(transactions.length, 2);
  assert.deepEqual(transactions.map((transaction) => transaction.expectedRevision), [0, 1]);
  assert.deepEqual(transactions.map((transaction) => transaction.events[0]?.sequence), [1, 2]);
  assert.notEqual(transactions[0]?.transactionId, transactions[1]?.transactionId);
  assert.notEqual(transactions[0]?.events[0]?.eventId, transactions[1]?.events[0]?.eventId);
  const snapshot = await memory.readStore("lease");
  assert.equal(snapshot.revision, 2);
  assert.equal(snapshot.highWaterMark, 2);
  assert.equal(snapshot.records["target-subject"]?.preparedOn, 1);
  assert.equal(snapshot.records["unrelated-subject"]?.label, "unrelated");
});

test("commit stops after three repeated store-wide revision conflicts", async () => {
  let reads = 0;
  let transacts = 0;
  let prepares = 0;
  const store: FabricDurableStore = {
    readStore: async (storeKind) => {
      reads += 1;
      return emptySnapshot(storeKind, reads - 1);
    },
    transact: async () => {
      transacts += 1;
      throw storeConflict(`Fabric lease store revision is ${transacts}`);
    },
  };
  let id = 0;
  const coordinator = new FabricStoreCoordinator(store, { createId: () => `bounded-${++id}` });

  await assert.rejects(
    () => coordinator.commit("lease", 1_000, (snapshot) => {
      prepares += 1;
      return {
        mutations: [{
          kind: "upsert",
          subjectId: "target-subject",
          expectedRevision: undefined,
          value: { revision: 1, preparedOn: snapshot.revision },
          eventKind: "target.updated",
        }],
        value: snapshot.revision,
      };
    }),
    (error: unknown) => {
      assert.ok(error instanceof FabricContractError);
      assert.equal(error.code, "conflict");
      assert.equal(error.message, "Durable Fabric state changed concurrently");
      return true;
    },
  );
  assert.equal(reads, 3);
  assert.equal(prepares, 3);
  assert.equal(transacts, 3);
});

test("subject-revision conflicts are not retried before or after transact", async (t) => {
  await t.test("prepare-detected conflict invokes transact zero times", async () => {
    let transacts = 0;
    const store: FabricDurableStore = {
      readStore: async (storeKind) => emptySnapshot(storeKind),
      transact: async () => { transacts += 1; },
    };
    const coordinator = new FabricStoreCoordinator(store, { createId: () => "unused-id" });

    await assert.rejects(
      () => coordinator.commit("lease", 1_000, () => ({
        mutations: [{
          kind: "upsert",
          subjectId: "target-subject",
          expectedRevision: 1,
          value: { revision: 2 },
          eventKind: "target.updated",
        }],
        value: undefined,
      })),
      (error: unknown) => error instanceof FabricContractError
        && error.code === "conflict"
        && error.message === "Durable Fabric subject revision is stale",
    );
    assert.equal(transacts, 0);
  });

  await t.test("store-reported subject conflict invokes transact once", async () => {
    let reads = 0;
    let prepares = 0;
    let transacts = 0;
    const store: FabricDurableStore = {
      readStore: async (storeKind) => {
        reads += 1;
        return emptySnapshot(storeKind);
      },
      transact: async () => {
        transacts += 1;
        throw storeConflict("stale subject revision");
      },
    };
    let id = 0;
    const coordinator = new FabricStoreCoordinator(store, { createId: () => `subject-${++id}` });

    await assert.rejects(
      () => coordinator.commit("lease", 1_000, () => {
        prepares += 1;
        return {
          mutations: [{
            kind: "upsert",
            subjectId: "target-subject",
            expectedRevision: undefined,
            value: { revision: 1 },
            eventKind: "target.updated",
          }],
          value: undefined,
        };
      }),
      (error: unknown) => error instanceof FabricContractError && error.code === "conflict",
    );
    assert.equal(reads, 1);
    assert.equal(prepares, 1);
    assert.equal(transacts, 1);
  });
});

test("commit does not retry an arbitrary storage error", async () => {
  const storageError = new Error("storage unavailable");
  let reads = 0;
  let prepares = 0;
  let transacts = 0;
  const store: FabricDurableStore = {
    readStore: async (storeKind) => {
      reads += 1;
      return emptySnapshot(storeKind);
    },
    transact: async () => {
      transacts += 1;
      throw storageError;
    },
  };
  let id = 0;
  const coordinator = new FabricStoreCoordinator(store, { createId: () => `storage-${++id}` });

  await assert.rejects(
    () => coordinator.commit("lease", 1_000, () => {
      prepares += 1;
      return {
        mutations: [{
          kind: "upsert",
          subjectId: "target-subject",
          expectedRevision: undefined,
          value: { revision: 1 },
          eventKind: "target.updated",
        }],
        value: undefined,
      };
    }),
    (error: unknown) => error === storageError,
  );
  assert.equal(reads, 1);
  assert.equal(prepares, 1);
  assert.equal(transacts, 1);
});
