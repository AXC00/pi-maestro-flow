import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FABRIC_STORE_EVENT_VERSION,
  FABRIC_STORE_TRANSACTION_VERSION,
  type FabricStoreKind,
  type FabricStoreTransactionV1,
} from "pi-maestro-fabric-core/v1";
import { GatewayEventJournal } from "../src/gateway/event-journal.ts";
import { GatewayFabricEventAdapter } from "../src/gateway/fabric/event-adapter.ts";
import { recoverGatewayFabric } from "../src/gateway/fabric/recovery.ts";
import { GatewayFabricStore } from "../src/gateway/fabric/store.ts";

async function fixture(t: test.TestContext): Promise<GatewayFabricStore> {
  const root = await mkdtemp(join(tmpdir(), "fabric-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new GatewayFabricStore({ path: join(root, "fabric", "state.json") });
}

function transaction(input: {
  id: string;
  kind: FabricStoreKind;
  subjectId: string;
  value: Record<string, never | string | number | boolean | null>;
  at?: number;
}): FabricStoreTransactionV1 {
  const at = input.at ?? 100;
  return {
    version: FABRIC_STORE_TRANSACTION_VERSION,
    transactionId: input.id,
    storeKind: input.kind,
    expectedRevision: 0,
    nextRevision: 1,
    committedAt: at,
    mutations: [{ kind: "upsert", subjectId: input.subjectId, value: input.value }],
    events: [{
      version: FABRIC_STORE_EVENT_VERSION,
      eventId: `${input.id}-event`,
      storeKind: input.kind,
      sequence: 1,
      eventKind: "record.updated",
      subjectId: input.subjectId,
      subjectRevision: Number(input.value.revision),
      occurredAt: at,
      payload: {},
    }],
  };
}

test("startup recovery fences live leases and unresolved mutating receipts before journal delivery", async (t) => {
  const store = await fixture(t);
  await store.transact(transaction({
    id: "lease-start",
    kind: "lease",
    subjectId: "connection-1",
    value: {
      revision: 1,
      connectionId: "connection-1",
      connectorId: "connector-1",
      connectorInstanceNonce: "instance-1",
      generation: 3,
      state: "connected",
      capabilityDigest: "sha256:abc",
      establishedAt: 10,
      expiresAt: 1_000,
    },
  }));
  await store.transact(transaction({
    id: "invocation-start",
    kind: "invocation",
    subjectId: "operation-1",
    value: {
      revision: 1,
      operationId: "operation-1",
      routeId: "route-1",
      endpointId: "endpoint-1",
      connectionGeneration: 3,
      endpointGeneration: 2,
      state: "running",
      replayClass: "non-replayable",
      updatedAt: 700,
    },
  }));

  const journal = new GatewayEventJournal();
  const interrupted = new GatewayFabricEventAdapter({
    store,
    journal,
    fault: (point) => { if (point === "before-append") throw new Error("journal unavailable"); },
  });
  await assert.rejects(recoverGatewayFabric({ store, eventAdapter: interrupted, now: () => 500 }), /journal unavailable/u);

  assert.equal((await store.get("lease", "connection-1"))?.state, "closed");
  assert.equal((await store.get("invocation", "operation-1"))?.state, "outcome-unknown");
  assert.equal((await store.get("invocation", "operation-1"))?.updatedAt, 700);
  assert.equal(journal.stats().events, 0);
  assert.equal((await store.pendingOutbox()).length, 4);

  const adapter = new GatewayFabricEventAdapter({ store, journal });
  const recovered = await recoverGatewayFabric({ store, eventAdapter: adapter, now: () => 600 });
  assert.deepEqual(recovered, { fencedRecords: 0, outcomeUnknownReceipts: 0, replayedEvents: 4, deliveredEvents: 4 });
  assert.equal((await store.pendingOutbox()).length, 0);
  assert.deepEqual(journal.page("fabric:lease", 0, 10).events.map((event) => event.cursor), [1, 2]);
  assert.deepEqual(journal.page("fabric:invocation", 0, 10).events.map((event) => event.cursor), [1, 2]);
});

test("journal delivery is idempotent across crash after append but before outbox acknowledgement", async (t) => {
  const store = await fixture(t);
  await store.transact(transaction({
    id: "registry-start",
    kind: "registry",
    subjectId: "device-1",
    value: { revision: 1, label: "Desk", enabled: true },
  }));
  const journal = new GatewayEventJournal();
  let fail = true;
  const crashing = new GatewayFabricEventAdapter({
    store,
    journal,
    fault: (point) => {
      if (point === "after-append" && fail) {
        fail = false;
        throw new Error("crash-after-journal-delivery");
      }
    },
  });
  await assert.rejects(crashing.deliverPending(), /crash-after-journal-delivery/u);
  assert.equal(journal.page("fabric:registry", 0, 10).events.length, 1);
  assert.equal((await store.pendingOutbox()).length, 1);

  const restarted = new GatewayFabricEventAdapter({ store, journal });
  assert.equal(await restarted.deliverPending(), 1);
  assert.equal(journal.page("fabric:registry", 0, 10).events.length, 1);
  assert.equal((await store.pendingOutbox()).length, 0);
  assert.equal((await store.readStore("registry")).cursors[0]?.nextSequence, 2);

  const freshJournal = new GatewayEventJournal();
  const recovered = await recoverGatewayFabric({
    store,
    eventAdapter: new GatewayFabricEventAdapter({ store, journal: freshJournal }),
    now: () => 200,
  });
  assert.deepEqual(recovered, { fencedRecords: 0, outcomeUnknownReceipts: 0, replayedEvents: 1, deliveredEvents: 0 });
  assert.equal(freshJournal.page("fabric:registry", 0, 10).events.length, 1);
});
