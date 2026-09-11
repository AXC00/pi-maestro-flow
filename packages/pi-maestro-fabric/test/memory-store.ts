import {
  FABRIC_STORE_KINDS,
  assertValidFabricStoreTransaction,
  type FabricStoreKind,
  type FabricStoreTransactionV1,
  type JsonValue,
} from "pi-maestro-fabric-core/v1";
import type {
  FabricDurableStore,
  FabricLogicalStoreSnapshot,
  FabricStoredRecord,
} from "../src/store-coordinator.ts";

interface MutableState {
  storeKind: FabricStoreKind;
  revision: number;
  records: Record<string, Record<string, JsonValue>>;
  highWaterMark: number;
}

export class MemoryFabricStore implements FabricDurableStore {
  readonly #states = new Map<FabricStoreKind, MutableState>();
  beforeTransact?: (transaction: FabricStoreTransactionV1) => void | Promise<void>;

  constructor() {
    for (const storeKind of FABRIC_STORE_KINDS) {
      this.#states.set(storeKind, { storeKind, revision: 0, records: {}, highWaterMark: 0 });
    }
  }

  async readStore(storeKind: FabricStoreKind): Promise<FabricLogicalStoreSnapshot> {
    return structuredClone(this.#states.get(storeKind)!);
  }

  async transact(transaction: FabricStoreTransactionV1): Promise<void> {
    assertValidFabricStoreTransaction(transaction);
    await this.beforeTransact?.(transaction);
    const state = this.#states.get(transaction.storeKind)!;
    if (state.revision !== transaction.expectedRevision) throw Object.assign(new Error("stale CAS revision"), { name: "FabricStoreConflictError" });
    if (transaction.nextRevision !== state.revision + 1) throw new Error("invalid next revision");
    let sequence = state.highWaterMark + 1;
    for (const event of transaction.events) {
      if (event.sequence !== sequence) throw new Error("invalid event sequence");
      sequence += 1;
    }
    const next = structuredClone(state);
    for (const mutation of transaction.mutations) {
      const current = next.records[mutation.subjectId];
      if (mutation.expectedRevision === undefined ? current !== undefined : current?.revision !== mutation.expectedRevision) {
        throw Object.assign(new Error("stale subject revision"), { name: "FabricStoreConflictError" });
      }
      if (mutation.kind === "delete") delete next.records[mutation.subjectId];
      else next.records[mutation.subjectId] = structuredClone(mutation.value as Record<string, JsonValue>);
    }
    next.revision = transaction.nextRevision;
    next.highWaterMark = transaction.events.at(-1)?.sequence ?? next.highWaterMark;
    this.#states.set(transaction.storeKind, next);
  }

  async record(storeKind: FabricStoreKind, subjectId: string): Promise<FabricStoredRecord | undefined> {
    return (await this.readStore(storeKind)).records[subjectId];
  }
}
