import type { JsonValue } from "./common.ts";

export const FABRIC_STORE_SHAPE_VERSION = 1 as const;
export const FABRIC_STORE_EVENT_VERSION = "fabric.store.event.v1" as const;
export const FABRIC_STORE_TRANSACTION_VERSION = "fabric.store.transaction.v1" as const;
export const FABRIC_STORE_CURSOR_VERSION = "fabric.store.cursor.v1" as const;

export const FABRIC_STORE_KINDS = ["registry", "lease", "presence", "invocation", "event"] as const;
export type FabricStoreKind = (typeof FABRIC_STORE_KINDS)[number];

export const FABRIC_STORE_MUTATIONS = ["upsert", "delete"] as const;
export type FabricStoreMutationKind = (typeof FABRIC_STORE_MUTATIONS)[number];

export interface FabricStoreMutationV1 {
  kind: FabricStoreMutationKind;
  subjectId: string;
  expectedRevision?: number;
  value?: Readonly<Record<string, JsonValue>>;
}

export interface FabricStoreEventV1 {
  version: typeof FABRIC_STORE_EVENT_VERSION;
  eventId: string;
  storeKind: FabricStoreKind;
  sequence: number;
  eventKind: string;
  subjectId: string;
  subjectRevision: number;
  occurredAt: number;
  payload: Readonly<Record<string, JsonValue>>;
}

export interface FabricStoreTransactionV1 {
  version: typeof FABRIC_STORE_TRANSACTION_VERSION;
  transactionId: string;
  storeKind: FabricStoreKind;
  expectedRevision: number;
  nextRevision: number;
  committedAt: number;
  mutations: readonly FabricStoreMutationV1[];
  events: readonly FabricStoreEventV1[];
}

export interface FabricStoreCursorV1 {
  version: typeof FABRIC_STORE_CURSOR_VERSION;
  consumerId: string;
  storeKind: FabricStoreKind;
  nextSequence: number;
  snapshotRevision: number;
  updatedAt: number;
}

/** Canonical persisted shape. Implementations write only this version. */
export interface FabricPersistedStoreStateV1 {
  shapeVersion: typeof FABRIC_STORE_SHAPE_VERSION;
  storeKind: FabricStoreKind;
  revision: number;
  events: readonly FabricStoreEventV1[];
  cursors: readonly FabricStoreCursorV1[];
}

/** Read-boundary-only input retained for migration of Phase 0-2 fixtures. */
export interface FabricPersistedStoreStateLegacyV0 {
  storeKind: FabricStoreKind;
  revision: number;
  events: readonly FabricStoreEventV1[];
  cursor?: FabricStoreCursorV1;
}
