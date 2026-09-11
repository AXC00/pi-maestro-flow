/** Startup fencing and replay for Gateway-owned Fabric durable state. */
import { randomUUID } from "node:crypto";
import {
  FABRIC_STORE_EVENT_VERSION,
  FABRIC_STORE_TRANSACTION_VERSION,
  type FabricStoreEventV1,
  type FabricStoreKind,
  type FabricStoreMutationV1,
  type JsonValue,
} from "pi-maestro-fabric-core/v1";
import { GatewayFabricEventAdapter } from "./event-adapter.ts";
import { GatewayFabricStore, type GatewayFabricLogicalStoreStateV1 } from "./store.ts";

export interface GatewayFabricRecoveryOptions {
  store: GatewayFabricStore;
  eventAdapter: GatewayFabricEventAdapter;
  now?: () => number;
  deliveryBatchSize?: number;
}

export interface GatewayFabricRecoveryResult {
  readonly fencedRecords: number;
  readonly outcomeUnknownReceipts: number;
  readonly replayedEvents: number;
  readonly deliveredEvents: number;
}

type FabricRecord = Readonly<Record<string, JsonValue>>;

function revisionOf(record: FabricRecord, subjectId: string): number {
  const revision = record.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw new Error(`Fabric recovery record has invalid revision: ${subjectId}`);
  return revision;
}

function effectiveRecordTime(record: FabricRecord, at: number): number {
  let effective = at;
  for (const key of ["createdAt", "updatedAt", "issuedAt", "establishedAt", "observedAt", "revokedAt"] as const) {
    const value = record[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) effective = Math.max(effective, value);
  }
  return effective;
}

function recoveryEvent(input: {
  storeKind: FabricStoreKind;
  sequence: number;
  subjectId: string;
  subjectRevision: number;
  eventKind: string;
  occurredAt: number;
  previousState: string;
  nextState: string;
}): FabricStoreEventV1 {
  return {
    version: FABRIC_STORE_EVENT_VERSION,
    eventId: randomUUID(),
    storeKind: input.storeKind,
    sequence: input.sequence,
    eventKind: input.eventKind,
    subjectId: input.subjectId,
    subjectRevision: input.subjectRevision,
    occurredAt: input.occurredAt,
    payload: { recovery: true, previousState: input.previousState, nextState: input.nextState },
  };
}

async function commitRecovery(
  store: GatewayFabricStore,
  state: GatewayFabricLogicalStoreStateV1,
  mutations: FabricStoreMutationV1[],
  events: FabricStoreEventV1[],
  at: number,
): Promise<number> {
  if (mutations.length === 0) return 0;
  await store.transact({
    version: FABRIC_STORE_TRANSACTION_VERSION,
    transactionId: randomUUID(),
    storeKind: state.storeKind,
    expectedRevision: state.revision,
    nextRevision: state.revision + 1,
    committedAt: events.reduce((latest, event) => Math.max(latest, event.occurredAt), at),
    mutations,
    events,
  });
  return mutations.length;
}

async function fenceLeases(store: GatewayFabricStore, at: number): Promise<number> {
  const state = await store.readStore("lease");
  const mutations: FabricStoreMutationV1[] = [];
  const events: FabricStoreEventV1[] = [];
  let sequence = state.highWaterMark + 1;
  for (const [subjectId, record] of Object.entries(state.records)) {
    const revision = revisionOf(record, subjectId);
    const effectiveAt = effectiveRecordTime(record, at);
    let next: Record<string, JsonValue> | undefined;
    let previousState: string | undefined;
    if (typeof record.state === "string" && record.state !== "closed") {
      previousState = record.state;
      next = { ...record, state: "closed", revision: revision + 1 };
      if (typeof record.connectionId === "string" && typeof record.expiresAt === "number") {
        const establishedAt = typeof record.establishedAt === "number" ? record.establishedAt : 0;
        next.expiresAt = Math.max(establishedAt + 1, Math.min(record.expiresAt, effectiveAt));
      }
    } else if (typeof record.bindingId === "string" && record.revokedAt === undefined) {
      previousState = "bound";
      next = { ...record, revokedAt: effectiveAt, revision: revision + 1 };
    }
    if (!next || previousState === undefined) continue;
    mutations.push({ kind: "upsert", subjectId, expectedRevision: revision, value: next });
    events.push(recoveryEvent({
      storeKind: "lease",
      sequence,
      subjectId,
      subjectRevision: revision + 1,
      eventKind: "recovery.fenced",
      occurredAt: effectiveAt,
      previousState,
      nextState: typeof next.state === "string" ? next.state : "revoked",
    }));
    sequence += 1;
  }
  return commitRecovery(store, state, mutations, events, at);
}

async function markInvocationOutcomesUnknown(store: GatewayFabricStore, at: number): Promise<number> {
  const state = await store.readStore("invocation");
  const mutations: FabricStoreMutationV1[] = [];
  const events: FabricStoreEventV1[] = [];
  let sequence = state.highWaterMark + 1;
  for (const [subjectId, record] of Object.entries(state.records)) {
    if (!new Set(["accepted", "running"]).has(String(record.state)) || record.replayClass === "readonly") continue;
    const revision = revisionOf(record, subjectId);
    const effectiveAt = effectiveRecordTime(record, at);
    const next: Record<string, JsonValue> = { ...record, state: "outcome-unknown", revision: revision + 1, updatedAt: effectiveAt };
    mutations.push({ kind: "upsert", subjectId, expectedRevision: revision, value: next });
    events.push(recoveryEvent({
      storeKind: "invocation",
      sequence,
      subjectId,
      subjectRevision: revision + 1,
      eventKind: "invocation.outcome-unknown",
      occurredAt: effectiveAt,
      previousState: String(record.state),
      nextState: "outcome-unknown",
    }));
    sequence += 1;
  }
  return commitRecovery(store, state, mutations, events, at);
}

export async function recoverGatewayFabric(options: GatewayFabricRecoveryOptions): Promise<GatewayFabricRecoveryResult> {
  const at = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(at) || at < 0) throw new Error("Fabric recovery timestamp must be a non-negative safe integer");
  const fencedRecords = await fenceLeases(options.store, at);
  const outcomeUnknownReceipts = await markInvocationOutcomesUnknown(options.store, at);
  const replayedEvents = await options.eventAdapter.replayRetained();
  const batchSize = options.deliveryBatchSize ?? Math.min(256, options.store.maxOutboxEvents);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > options.store.maxOutboxEvents) throw new Error("Fabric recovery deliveryBatchSize is invalid");
  let deliveredEvents = 0;
  while (true) {
    const delivered = await options.eventAdapter.deliverPending(batchSize);
    deliveredEvents += delivered;
    if (delivered < batchSize) break;
  }
  return { fencedRecords, outcomeUnknownReceipts, replayedEvents, deliveredEvents };
}
