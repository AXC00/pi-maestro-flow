import {
  FABRIC_STORE_EVENT_VERSION,
  FABRIC_STORE_TRANSACTION_VERSION,
  FabricContractError,
  assertEpochMilliseconds,
  assertFabricIdentifier,
  assertRevision,
  type FabricStoreEventV1,
  type FabricStoreKind,
  type FabricStoreMutationV1,
  type FabricStoreTransactionV1,
  type JsonValue,
} from "pi-maestro-fabric-core/v1";

export type FabricStoredRecord = Readonly<Record<string, JsonValue>>;

export interface FabricLogicalStoreSnapshot {
  readonly storeKind: FabricStoreKind;
  readonly revision: number;
  readonly records: Readonly<Record<string, FabricStoredRecord>>;
  readonly highWaterMark: number;
}

export interface FabricDurableStore {
  readStore(storeKind: FabricStoreKind): Promise<FabricLogicalStoreSnapshot>;
  transact(transaction: FabricStoreTransactionV1): Promise<unknown>;
}

export interface FabricCoordinatedMutation {
  readonly kind: "upsert" | "delete";
  readonly subjectId: string;
  readonly expectedRevision?: number;
  readonly value?: FabricStoredRecord;
  readonly eventKind: string;
  readonly payload?: FabricStoredRecord;
}

export interface FabricStoreCommitPlan<T> {
  readonly mutations: readonly FabricCoordinatedMutation[];
  readonly value: T;
}

export interface FabricStoreCoordinatorOptions {
  createId?: () => string;
}

function defaultCreateId(): string {
  return crypto.randomUUID();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function conflictFromStore(error: unknown): never {
  if (error instanceof FabricContractError) throw error;
  if (error instanceof Error && (error.name === "FabricStoreConflictError" || /\b(?:CAS|revision)\b.*\b(?:stale|conflict|is)\b/iu.test(error.message))) {
    throw new FabricContractError("conflict", "Durable Fabric state changed concurrently");
  }
  throw error;
}

/**
 * Host-independent adapter over the five versioned logical stores.
 * Domain managers validate records; this class only builds one-shot CAS transactions.
 */
export class FabricStoreCoordinator {
  readonly store: FabricDurableStore;
  readonly #createId: () => string;

  constructor(store: FabricDurableStore, options: FabricStoreCoordinatorOptions = {}) {
    this.store = store;
    this.#createId = options.createId ?? defaultCreateId;
  }

  async readStore(storeKind: FabricStoreKind): Promise<FabricLogicalStoreSnapshot> {
    const state = await this.store.readStore(storeKind);
    if (state.storeKind !== storeKind) {
      throw new FabricContractError("protocol_violation", "Durable store returned the wrong logical authority", "storeKind");
    }
    assertRevision(state.revision, "store.revision");
    assertRevision(state.highWaterMark, "store.highWaterMark");
    return clone(state);
  }

  async get(storeKind: FabricStoreKind, subjectId: string): Promise<FabricStoredRecord | undefined> {
    assertFabricIdentifier(subjectId, "subjectId");
    const record = (await this.readStore(storeKind)).records[subjectId];
    return record === undefined ? undefined : clone(record);
  }

  async commit<T>(
    storeKind: FabricStoreKind,
    committedAt: number,
    prepare: (snapshot: FabricLogicalStoreSnapshot) => FabricStoreCommitPlan<T>,
  ): Promise<T> {
    assertEpochMilliseconds(committedAt, "committedAt");
    const snapshot = await this.readStore(storeKind);
    const plan = prepare(snapshot);
    if (plan.mutations.length === 0) return clone(plan.value);

    const subjects = new Set<string>();
    const mutations: FabricStoreMutationV1[] = [];
    const events: FabricStoreEventV1[] = [];
    let sequence = snapshot.highWaterMark + 1;
    for (const mutation of plan.mutations) {
      assertFabricIdentifier(mutation.subjectId, "subjectId");
      assertFabricIdentifier(mutation.eventKind, "eventKind");
      if (subjects.has(mutation.subjectId)) {
        throw new FabricContractError("invalid_argument", "A coordinated transaction cannot mutate one subject twice", "subjectId");
      }
      subjects.add(mutation.subjectId);
      const current = snapshot.records[mutation.subjectId];
      const currentRevision = current?.revision;
      if (currentRevision !== undefined) assertRevision(currentRevision, `records.${mutation.subjectId}.revision`);
      const expectedRevision = mutation.expectedRevision;
      if (expectedRevision === undefined ? current !== undefined : currentRevision !== expectedRevision) {
        throw new FabricContractError("conflict", "Durable Fabric subject revision is stale", mutation.subjectId);
      }
      const subjectRevision = (expectedRevision ?? 0) + 1;
      if (mutation.kind === "upsert") {
        if (mutation.value === undefined || mutation.value.revision !== subjectRevision) {
          throw new FabricContractError("invalid_argument", "Upsert value must carry the next subject revision", "revision");
        }
      } else if (mutation.value !== undefined) {
        throw new FabricContractError("invalid_argument", "Delete mutation cannot carry a value", "value");
      }
      mutations.push({
        kind: mutation.kind,
        subjectId: mutation.subjectId,
        expectedRevision,
        value: mutation.value === undefined ? undefined : clone(mutation.value),
      });
      events.push({
        version: FABRIC_STORE_EVENT_VERSION,
        eventId: this.#newId("eventId"),
        storeKind,
        sequence,
        eventKind: mutation.eventKind,
        subjectId: mutation.subjectId,
        subjectRevision,
        occurredAt: committedAt,
        payload: clone(mutation.payload ?? {}),
      });
      sequence += 1;
    }

    const transaction: FabricStoreTransactionV1 = {
      version: FABRIC_STORE_TRANSACTION_VERSION,
      transactionId: this.#newId("transactionId"),
      storeKind,
      expectedRevision: snapshot.revision,
      nextRevision: snapshot.revision + 1,
      committedAt,
      mutations,
      events,
    };
    try {
      await this.store.transact(transaction);
    } catch (error) {
      conflictFromStore(error);
    }
    return clone(plan.value);
  }

  #newId(path: string): string {
    const id = this.#createId();
    assertFabricIdentifier(id, path);
    return id;
  }
}
