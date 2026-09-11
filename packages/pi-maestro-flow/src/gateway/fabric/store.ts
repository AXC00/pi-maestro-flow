/** Gateway-owned durable Fabric state, CAS transactions, cursors, and outbox. */
import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  FABRIC_STORE_CURSOR_VERSION,
  FABRIC_STORE_KINDS,
  FABRIC_STORE_SHAPE_VERSION,
  assertFabricIdentifier,
  assertRevision,
  assertValidFabricStoreCursor,
  assertValidFabricStoreEvent,
  assertValidFabricStoreTransaction,
  migrateFabricPersistedStoreState,
  sanitizeFabricProjectionText,
  type FabricPersistedStoreStateV1,
  type FabricStoreCursorV1,
  type FabricStoreEventV1,
  type FabricStoreKind,
  type FabricStoreTransactionV1,
  type JsonValue,
} from "pi-maestro-fabric-core/v1";
import { readGatewayJson, writeGatewayJsonAtomic } from "../state-paths.ts";

export const GATEWAY_FABRIC_STORE_VERSION = 1 as const;
export const GATEWAY_FABRIC_OUTBOX_CONSUMER_ID = "gateway-event-journal" as const;
const DEFAULT_MAXIMUM_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_MAX_OUTBOX_EVENTS = 20_000;
const DEFAULT_MAX_TRANSACTIONS = 1_024;
const tails = new Map<string, Promise<void>>();

const properLockfile = createRequire(import.meta.url)("proper-lockfile") as {
  lock(filePath: string, options: {
    realpath: boolean;
    stale: number;
    update: number;
    retries: { retries: number; factor: number; minTimeout: number; maxTimeout: number; randomize: boolean };
  }): Promise<() => Promise<void>>;
};

type FabricRecord = Readonly<Record<string, JsonValue>>;
type MutableFabricRecord = Record<string, JsonValue>;

export interface GatewayFabricLogicalStoreStateV1 extends FabricPersistedStoreStateV1 {
  readonly records: Readonly<Record<string, FabricRecord>>;
  readonly highWaterMark: number;
}

export interface GatewayFabricTransactionReceiptV1 {
  readonly transactionId: string;
  readonly storeKind: FabricStoreKind;
  readonly revision: number;
  readonly committedAt: number;
  readonly digest: string;
}

export interface GatewayFabricStoreDocumentV1 {
  readonly version: typeof GATEWAY_FABRIC_STORE_VERSION;
  readonly revision: number;
  readonly stores: Readonly<Record<FabricStoreKind, GatewayFabricLogicalStoreStateV1>>;
  readonly outbox: readonly FabricStoreEventV1[];
  readonly transactions: readonly GatewayFabricTransactionReceiptV1[];
}

interface MutableLogicalStore {
  shapeVersion: typeof FABRIC_STORE_SHAPE_VERSION;
  storeKind: FabricStoreKind;
  revision: number;
  records: Record<string, MutableFabricRecord>;
  events: FabricStoreEventV1[];
  cursors: FabricStoreCursorV1[];
  highWaterMark: number;
}

interface MutableDocument {
  version: typeof GATEWAY_FABRIC_STORE_VERSION;
  revision: number;
  stores: Record<FabricStoreKind, MutableLogicalStore>;
  outbox: FabricStoreEventV1[];
  transactions: GatewayFabricTransactionReceiptV1[];
}

export interface GatewayFabricStoreOptions {
  path: string;
  maximumBytes?: number;
  maxEventsPerStore?: number;
  maxOutboxEvents?: number;
  maxTransactions?: number;
  /** Test-only durable-boundary seam. */
  fault?: (point: "before-write" | "before-rename" | "after-rename" | "after-write") => void | Promise<void>;
  write?: (path: string, value: GatewayFabricStoreDocumentV1, maximumBytes: number) => Promise<void>;
}

export interface GatewayFabricCommitResult {
  readonly replayed: boolean;
  readonly store: GatewayFabricLogicalStoreStateV1;
  readonly events: readonly FabricStoreEventV1[];
}

export interface GatewayFabricEventPage {
  readonly events: readonly FabricStoreEventV1[];
  readonly oldestSequence: number;
  readonly highWaterMark: number;
  readonly nextSequence: number;
  readonly gap?: { readonly fromSequence: number; readonly toSequence: number; readonly resumeSequence: number };
}

export class FabricStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "FabricStoreError"; }
}

export class FabricStoreConflictError extends FabricStoreError {
  readonly storeKind: FabricStoreKind;
  readonly currentRevision: number;
  constructor(storeKind: FabricStoreKind, currentRevision: number, message = `Fabric ${storeKind} store revision is ${currentRevision}`) {
    super(message);
    this.name = "FabricStoreConflictError";
    this.storeKind = storeKind;
    this.currentRevision = currentRevision;
  }
}

export class FabricStoreCapacityError extends FabricStoreError {
  constructor(message: string) { super(message); this.name = "FabricStoreCapacityError"; }
}

export class FabricStoreRedactionError extends FabricStoreError {
  constructor(path: string) { super(`Fabric outbox payload contains forbidden private field: ${path}`); this.name = "FabricStoreRedactionError"; }
}

function positiveBound(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new FabricStoreError(`${label} must be a positive safe integer`);
  return result;
}

function clone<T>(value: T): T { return structuredClone(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex"); }

const SAFE_EVENT_KEYS = new Set([
  "version", "storekind", "eventid", "eventkind", "subjectid", "subjectrevision", "revision", "generation",
  "connectorid", "deviceid", "connectionid", "workspaceid", "workspacebindingid", "bindingid", "endpointid", "routeid",
  "mountid", "operationid", "placementid", "artifactid", "consumerid", "capabilityid", "ticketid", "keyid",
  "label", "transport", "connectionmode", "platform", "architecture", "enabled", "state", "status", "kind", "scope", "mode",
  "credentialgeneration", "connectiongeneration", "workspacegeneration", "endpointgeneration", "evidencerevision", "routerevision",
  "capabilitydigest", "contracthash", "policydigest", "roles", "tasktypes", "models", "maxconcurrency", "servername",
  "protocolversion", "durablededuplication", "endpointids", "trustlevel", "locality", "priority", "sequence", "nextsequence",
  "snapshotrevision", "establishedat", "expiresat", "issuedat", "updatedat", "createdat", "occurredat", "observedat", "lastseenat",
  "revokedat", "replayclass", "endpointreceiptref", "resultref", "operationclass", "pathcandidates", "selectedpath",
  "subject", "audience", "nonce", "operationclasses", "mediatype", "bytelength", "digest", "storage",
  "recovery", "previousstate", "nextstate", "errorcode", "code", "message", "reason", "outcome", "healthy",
  "record", "previous", "current", "items", "count", "truncated",
]);

function safeEventValue(value: JsonValue, path: string): JsonValue {
  if (typeof value === "string") return sanitizeFabricProjectionText(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry, index) => safeEventValue(entry, `${path}[${index}]`));
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/[\u0000-\u001f\u007f]/u.test(key)) throw new FabricStoreRedactionError(`${path}.${key}`);
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
    if (!SAFE_EVENT_KEYS.has(normalizedKey)) throw new FabricStoreRedactionError(`${path}.${key}`);
    result[key] = safeEventValue(entry, `${path}.${key}`);
  }
  return result;
}

function sanitizeEvent(event: FabricStoreEventV1): FabricStoreEventV1 {
  const sanitized = { ...event, payload: safeEventValue(event.payload, "payload") as Readonly<Record<string, JsonValue>> };
  assertValidFabricStoreEvent(sanitized);
  return sanitized;
}

function validateRecord(subjectId: string, value: unknown): MutableFabricRecord {
  assertFabricIdentifier(subjectId, "subjectId");
  if (!isRecord(value)) throw new FabricStoreError(`Fabric record ${subjectId} must be an object`);
  assertRevision(value.revision, `records.${subjectId}.revision`);
  if (value.revision < 1) throw new FabricStoreError(`Fabric record ${subjectId} revision must be positive`);
  assertValidFabricStoreTransaction({
    version: "fabric.store.transaction.v1",
    transactionId: "record-validation",
    storeKind: "registry",
    expectedRevision: 0,
    nextRevision: 1,
    committedAt: 0,
    mutations: [{ kind: "upsert", subjectId, value: value as FabricRecord }],
    events: [],
  });
  return clone(value as MutableFabricRecord);
}

function emptyLogicalStore(storeKind: FabricStoreKind): MutableLogicalStore {
  return { shapeVersion: FABRIC_STORE_SHAPE_VERSION, storeKind, revision: 0, records: {}, events: [], cursors: [], highWaterMark: 0 };
}

function emptyDocument(): MutableDocument {
  return {
    version: GATEWAY_FABRIC_STORE_VERSION,
    revision: 0,
    stores: {
      registry: emptyLogicalStore("registry"),
      lease: emptyLogicalStore("lease"),
      presence: emptyLogicalStore("presence"),
      invocation: emptyLogicalStore("invocation"),
      event: emptyLogicalStore("event"),
    },
    outbox: [],
    transactions: [],
  };
}

function assertEventLog(events: readonly FabricStoreEventV1[], highWaterMark: number, storeKind: FabricStoreKind): void {
  if (events.length === 0) {
    if (highWaterMark !== 0) throw new FabricStoreError(`Fabric ${storeKind} high-water mark has no retained boundary`);
    return;
  }
  let priorSequence = events[0]!.sequence - 1;
  const eventIds = new Set<string>();
  for (const event of events) {
    if (event.sequence !== priorSequence + 1) throw new FabricStoreError(`Fabric ${storeKind} event sequence is not contiguous`);
    if (eventIds.has(event.eventId)) throw new FabricStoreError(`Fabric ${storeKind} eventId is duplicated`);
    eventIds.add(event.eventId);
    priorSequence = event.sequence;
  }
  if (priorSequence !== highWaterMark) throw new FabricStoreError(`Fabric ${storeKind} high-water mark disagrees with its retained boundary`);
}

function normalizeLogicalStore(raw: unknown, expectedKind: FabricStoreKind): MutableLogicalStore {
  if (!isRecord(raw)) throw new FabricStoreError(`Fabric ${expectedKind} store must be an object`);
  const canonical = migrateFabricPersistedStoreState(raw);
  if (canonical.storeKind !== expectedKind) throw new FabricStoreError(`Fabric store kind disagreement for ${expectedKind}`);
  if (raw.shapeVersion !== FABRIC_STORE_SHAPE_VERSION) throw new FabricStoreError(`Fabric ${expectedKind} store must use canonical shapeVersion 1`);
  if (!isRecord(raw.records)) throw new FabricStoreError(`Fabric ${expectedKind} records must be an object`);
  const records: Record<string, MutableFabricRecord> = {};
  for (const [subjectId, value] of Object.entries(raw.records)) records[subjectId] = validateRecord(subjectId, value);
  if (!Number.isSafeInteger(raw.highWaterMark) || (raw.highWaterMark as number) < 0) throw new FabricStoreError(`Fabric ${expectedKind} highWaterMark is invalid`);
  const highWaterMark = raw.highWaterMark as number;
  const events = canonical.events.map(sanitizeEvent);
  assertEventLog(events, highWaterMark, expectedKind);
  const consumers = new Set<string>();
  for (const cursor of canonical.cursors) {
    if (consumers.has(cursor.consumerId)) throw new FabricStoreError(`Fabric ${expectedKind} cursor consumer is duplicated`);
    if (cursor.nextSequence > highWaterMark + 1) throw new FabricStoreError(`Fabric ${expectedKind} cursor exceeds its high-water mark`);
    if (cursor.snapshotRevision > canonical.revision) throw new FabricStoreError(`Fabric ${expectedKind} cursor exceeds its snapshot revision`);
    consumers.add(cursor.consumerId);
  }
  return {
    shapeVersion: FABRIC_STORE_SHAPE_VERSION,
    storeKind: expectedKind,
    revision: canonical.revision,
    records,
    events: events.map(clone),
    cursors: canonical.cursors.map(clone),
    highWaterMark,
  };
}

function normalizeDocument(raw: unknown): MutableDocument {
  if (!isRecord(raw)) throw new FabricStoreError("Gateway Fabric store must be an object");
  if (raw.version === undefined && raw.storeKind !== undefined) {
    const migrated = migrateFabricPersistedStoreState(raw);
    const document = emptyDocument();
    const target = document.stores[migrated.storeKind];
    const events = migrated.events.map(sanitizeEvent);
    const highWaterMark = events.at(-1)?.sequence ?? 0;
    assertEventLog(events, highWaterMark, migrated.storeKind);
    target.revision = migrated.revision;
    target.events = events.map(clone);
    target.cursors = migrated.cursors.map(clone);
    target.highWaterMark = highWaterMark;
    document.outbox = events.map(clone);
    return document;
  }
  if (raw.version !== GATEWAY_FABRIC_STORE_VERSION) throw new FabricStoreError("Unsupported Gateway Fabric store version");
  assertRevision(raw.revision, "revision");
  if (!isRecord(raw.stores)) throw new FabricStoreError("Gateway Fabric stores must be an object");
  const stores = {} as Record<FabricStoreKind, MutableLogicalStore>;
  for (const kind of FABRIC_STORE_KINDS) stores[kind] = normalizeLogicalStore(raw.stores[kind], kind);
  if (!Array.isArray(raw.outbox)) throw new FabricStoreError("Gateway Fabric outbox must be an array");
  const outbox = raw.outbox.map((input, index) => {
    assertValidFabricStoreEvent(input);
    const event = sanitizeEvent(input);
    const retained = stores[event.storeKind].events.find((candidate) => candidate.eventId === event.eventId && candidate.sequence === event.sequence);
    if (!retained) throw new FabricStoreError(`Gateway Fabric outbox event ${index} is not retained by its logical store`);
    if (digest(retained) !== digest(event)) throw new FabricStoreError(`Gateway Fabric outbox event ${index} disagrees with its logical store`);
    return clone(event);
  });
  if (new Set(outbox.map((event) => event.eventId)).size !== outbox.length) throw new FabricStoreError("Gateway Fabric outbox contains duplicate event IDs");
  const outboxSequences = new Map<FabricStoreKind, number>();
  for (const event of outbox) {
    const previous = outboxSequences.get(event.storeKind);
    if (previous !== undefined && event.sequence !== previous + 1) throw new FabricStoreError(`Gateway Fabric ${event.storeKind} outbox is not contiguous`);
    if (previous === undefined) {
      const cursor = stores[event.storeKind].cursors.find((candidate) => candidate.consumerId === GATEWAY_FABRIC_OUTBOX_CONSUMER_ID);
      if (cursor && cursor.nextSequence !== event.sequence) throw new FabricStoreError(`Gateway Fabric ${event.storeKind} outbox disagrees with its delivery cursor`);
    }
    outboxSequences.set(event.storeKind, event.sequence);
  }
  if (!Array.isArray(raw.transactions)) throw new FabricStoreError("Gateway Fabric transaction ledger must be an array");
  const transactionIds = new Set<string>();
  const transactions = raw.transactions.map((input, index): GatewayFabricTransactionReceiptV1 => {
    if (!isRecord(input)) throw new FabricStoreError(`Gateway Fabric transaction receipt ${index} must be an object`);
    assertFabricIdentifier(input.transactionId, `transactions[${index}].transactionId`);
    if (!FABRIC_STORE_KINDS.includes(input.storeKind as FabricStoreKind)) throw new FabricStoreError(`Gateway Fabric transaction receipt ${index} has invalid storeKind`);
    assertRevision(input.revision, `transactions[${index}].revision`);
    if (!Number.isSafeInteger(input.committedAt) || (input.committedAt as number) < 0) throw new FabricStoreError(`Gateway Fabric transaction receipt ${index} has invalid committedAt`);
    if (typeof input.digest !== "string" || !/^[a-f0-9]{64}$/u.test(input.digest)) throw new FabricStoreError(`Gateway Fabric transaction receipt ${index} has invalid digest`);
    if (transactionIds.has(input.transactionId)) throw new FabricStoreError("Gateway Fabric transactionId is duplicated");
    transactionIds.add(input.transactionId);
    return input as unknown as GatewayFabricTransactionReceiptV1;
  });
  return { version: GATEWAY_FABRIC_STORE_VERSION, revision: raw.revision, stores, outbox, transactions };
}

function validateMutationEvents(transaction: FabricStoreTransactionV1, events: readonly FabricStoreEventV1[]): void {
  const mutations = new Map<string, FabricStoreTransactionV1["mutations"][number]>();
  for (const mutation of transaction.mutations) {
    if (mutations.has(mutation.subjectId)) throw new FabricStoreConflictError(transaction.storeKind, transaction.expectedRevision, "A Fabric transaction cannot mutate one subject twice");
    mutations.set(mutation.subjectId, mutation);
  }
  if (events.length < mutations.size) throw new FabricStoreError("Every Fabric mutation must append a durable event");
  const covered = new Set<string>();
  for (const event of events) {
    const mutation = mutations.get(event.subjectId);
    if (!mutation) throw new FabricStoreError(`Fabric event ${event.eventId} has no matching mutation`);
    const nextSubjectRevision = (mutation.expectedRevision ?? 0) + 1;
    if (event.subjectRevision !== nextSubjectRevision) throw new FabricStoreError(`Fabric event ${event.eventId} has a stale subject revision`);
    covered.add(event.subjectId);
  }
  if (covered.size !== mutations.size) throw new FabricStoreError("Every Fabric mutation must be represented by an event");
}

export class GatewayFabricStore {
  readonly path: string;
  readonly maximumBytes: number;
  readonly maxEventsPerStore: number;
  readonly maxOutboxEvents: number;
  readonly maxTransactions: number;
  private readonly fault?: GatewayFabricStoreOptions["fault"];
  private readonly write: NonNullable<GatewayFabricStoreOptions["write"]>;

  constructor(options: GatewayFabricStoreOptions) {
    if (!options.path) throw new FabricStoreError("Gateway Fabric store path is required");
    this.path = options.path;
    this.maximumBytes = positiveBound(options.maximumBytes, DEFAULT_MAXIMUM_BYTES, "maximumBytes");
    this.maxEventsPerStore = positiveBound(options.maxEventsPerStore, DEFAULT_MAX_EVENTS, "maxEventsPerStore");
    this.maxOutboxEvents = positiveBound(options.maxOutboxEvents, DEFAULT_MAX_OUTBOX_EVENTS, "maxOutboxEvents");
    this.maxTransactions = positiveBound(options.maxTransactions, DEFAULT_MAX_TRANSACTIONS, "maxTransactions");
    this.fault = options.fault;
    this.write = options.write ?? ((path, value, maximumBytes) => writeGatewayJsonAtomic(path, value, {
      mode: 0o600,
      maximumBytes,
      fault: (point) => this.fault?.(point),
    }));
  }

  async load(): Promise<GatewayFabricStoreDocumentV1> {
    const raw = await this.readRaw();
    return clone(raw === undefined ? emptyDocument() : normalizeDocument(raw));
  }

  async readStore(storeKind: FabricStoreKind): Promise<GatewayFabricLogicalStoreStateV1> {
    return clone((await this.load()).stores[storeKind]);
  }

  async get(storeKind: FabricStoreKind, subjectId: string): Promise<FabricRecord | undefined> {
    assertFabricIdentifier(subjectId, "subjectId");
    const value = (await this.readStore(storeKind)).records[subjectId];
    return value === undefined ? undefined : clone(value);
  }

  async pendingOutbox(limit = this.maxOutboxEvents): Promise<readonly FabricStoreEventV1[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.maxOutboxEvents) throw new FabricStoreError(`outbox limit must be in [1, ${this.maxOutboxEvents}]`);
    return clone((await this.load()).outbox.slice(0, limit));
  }

  async pageEvents(storeKind: FabricStoreKind, afterSequence = 0, limit = 256): Promise<GatewayFabricEventPage> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new FabricStoreError("afterSequence must be a non-negative safe integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.maxEventsPerStore) throw new FabricStoreError(`event limit must be in [1, ${this.maxEventsPerStore}]`);
    const state = await this.readStore(storeKind);
    const oldestSequence = state.events[0]?.sequence ?? state.highWaterMark + 1;
    const gap = afterSequence < oldestSequence - 1
      ? { fromSequence: afterSequence + 1, toSequence: oldestSequence - 1, resumeSequence: oldestSequence - 1 }
      : undefined;
    const effective = gap?.resumeSequence ?? afterSequence;
    const events = state.events.filter((event) => event.sequence > effective).slice(0, limit);
    return { events: clone(events), oldestSequence, highWaterMark: state.highWaterMark, nextSequence: events.at(-1)?.sequence ?? effective, ...(gap ? { gap } : {}) };
  }

  async transact(input: FabricStoreTransactionV1): Promise<GatewayFabricCommitResult> {
    assertValidFabricStoreTransaction(input);
    const events = input.events.map((event) => sanitizeEvent(event));
    validateMutationEvents(input, events);
    const canonicalInput = { ...clone(input), events } as FabricStoreTransactionV1;
    const transactionDigest = digest(canonicalInput);
    return this.serialized(async () => {
      const document = await this.loadUnlocked();
      const prior = document.transactions.find((receipt) => receipt.transactionId === input.transactionId);
      if (prior) {
        if (prior.digest !== transactionDigest || prior.storeKind !== input.storeKind) {
          throw new FabricStoreConflictError(input.storeKind, document.stores[input.storeKind].revision, "Fabric transactionId is already bound to different content");
        }
        return { replayed: true, store: clone(document.stores[input.storeKind]), events: clone(events) };
      }
      const current = document.stores[input.storeKind];
      if (current.revision !== input.expectedRevision) throw new FabricStoreConflictError(input.storeKind, current.revision);
      let nextSequence = current.highWaterMark + 1;
      for (const event of events) {
        if (event.sequence !== nextSequence) throw new FabricStoreConflictError(input.storeKind, current.revision, `Fabric event sequence must be ${nextSequence}`);
        nextSequence += 1;
      }
      const next = clone(document) as MutableDocument;
      const target = next.stores[input.storeKind];
      for (const mutation of canonicalInput.mutations) {
        const existing = target.records[mutation.subjectId];
        if (mutation.expectedRevision === undefined) {
          if (existing !== undefined) throw new FabricStoreConflictError(input.storeKind, current.revision, `Fabric subject already exists: ${mutation.subjectId}`);
        } else {
          const existingRevision = existing?.revision;
          if (existing === undefined || existingRevision !== mutation.expectedRevision) {
            throw new FabricStoreConflictError(input.storeKind, current.revision, `Fabric subject revision is stale: ${mutation.subjectId}`);
          }
        }
        if (mutation.kind === "delete") {
          if (existing === undefined) throw new FabricStoreConflictError(input.storeKind, current.revision, `Fabric subject does not exist: ${mutation.subjectId}`);
          delete target.records[mutation.subjectId];
        } else {
          const record = validateRecord(mutation.subjectId, mutation.value);
          const requiredRevision = (mutation.expectedRevision ?? 0) + 1;
          if (record.revision !== requiredRevision) throw new FabricStoreConflictError(input.storeKind, current.revision, `Fabric subject revision must be ${requiredRevision}: ${mutation.subjectId}`);
          target.records[mutation.subjectId] = record;
        }
      }
      target.revision = input.nextRevision;
      target.events.push(...events.map(clone));
      if (events.length > 0) target.highWaterMark = events.at(-1)!.sequence;
      next.outbox.push(...events.map(clone));
      next.revision += 1;
      next.transactions.push({
        transactionId: input.transactionId,
        storeKind: input.storeKind,
        revision: input.nextRevision,
        committedAt: input.committedAt,
        digest: transactionDigest,
      });
      next.transactions = next.transactions.slice(-this.maxTransactions);
      this.enforceRetention(next);
      const validated = normalizeDocument(next);
      await this.persist(validated);
      return { replayed: false, store: clone(validated.stores[input.storeKind]), events: clone(events) };
    });
  }

  async acknowledgeOutbox(eventId: string, consumerId: string = GATEWAY_FABRIC_OUTBOX_CONSUMER_ID): Promise<boolean> {
    assertFabricIdentifier(eventId, "eventId");
    assertFabricIdentifier(consumerId, "consumerId");
    if (consumerId !== GATEWAY_FABRIC_OUTBOX_CONSUMER_ID) throw new FabricStoreError("Fabric outbox has exactly one Gateway journal delivery consumer");
    return this.serialized(async () => {
      const document = await this.loadUnlocked();
      const index = document.outbox.findIndex((event) => event.eventId === eventId);
      if (index < 0) return false;
      const event = document.outbox[index]!;
      const target = document.stores[event.storeKind];
      const cursorIndex = target.cursors.findIndex((cursor) => cursor.consumerId === consumerId);
      const cursor = cursorIndex < 0 ? undefined : target.cursors[cursorIndex];
      if (cursor && cursor.nextSequence < event.sequence) throw new FabricStoreConflictError(event.storeKind, target.revision, "Fabric outbox acknowledgement would skip an event");
      const next = clone(document) as MutableDocument;
      const nextStore = next.stores[event.storeKind];
      if (!cursor || cursor.nextSequence === event.sequence) {
        const advanced: FabricStoreCursorV1 = {
          version: FABRIC_STORE_CURSOR_VERSION,
          consumerId,
          storeKind: event.storeKind,
          nextSequence: event.sequence + 1,
          snapshotRevision: target.revision,
          updatedAt: Math.max(cursor?.updatedAt ?? 0, event.occurredAt),
        };
        assertValidFabricStoreCursor(advanced);
        if (cursorIndex < 0) nextStore.cursors.push(advanced);
        else nextStore.cursors[cursorIndex] = advanced;
      }
      next.outbox.splice(index, 1);
      next.revision += 1;
      this.enforceRetention(next);
      const validated = normalizeDocument(next);
      await this.persist(validated);
      return true;
    });
  }

  async advanceCursor(cursor: FabricStoreCursorV1, expectedNextSequence: number): Promise<FabricStoreCursorV1> {
    assertValidFabricStoreCursor(cursor);
    if (cursor.consumerId === GATEWAY_FABRIC_OUTBOX_CONSUMER_ID) throw new FabricStoreError("Gateway journal cursor advances only through outbox acknowledgement");
    if (!Number.isSafeInteger(expectedNextSequence) || expectedNextSequence < 1) throw new FabricStoreError("expectedNextSequence must be a positive safe integer");
    return this.serialized(async () => {
      const document = await this.loadUnlocked();
      const target = document.stores[cursor.storeKind];
      if (cursor.nextSequence > target.highWaterMark + 1) throw new FabricStoreConflictError(cursor.storeKind, target.revision, "Fabric cursor exceeds its high-water mark");
      if (cursor.snapshotRevision !== target.revision) throw new FabricStoreConflictError(cursor.storeKind, target.revision, "Fabric cursor snapshot revision is stale");
      const index = target.cursors.findIndex((candidate) => candidate.consumerId === cursor.consumerId);
      const current = index < 0 ? undefined : target.cursors[index];
      const currentNextSequence = current?.nextSequence ?? 1;
      if (currentNextSequence !== expectedNextSequence) throw new FabricStoreConflictError(cursor.storeKind, target.revision, "Fabric cursor CAS is stale");
      if (cursor.nextSequence < currentNextSequence) throw new FabricStoreConflictError(cursor.storeKind, target.revision, "Fabric cursor cannot move backwards");
      const next = clone(document) as MutableDocument;
      if (index < 0) next.stores[cursor.storeKind].cursors.push(clone(cursor));
      else next.stores[cursor.storeKind].cursors[index] = clone(cursor);
      next.revision += 1;
      this.enforceRetention(next);
      const validated = normalizeDocument(next);
      await this.persist(validated);
      return clone(cursor);
    });
  }

  private async loadUnlocked(): Promise<MutableDocument> {
    const raw = await this.readRaw();
    return raw === undefined ? emptyDocument() : normalizeDocument(raw);
  }

  private async readRaw(): Promise<unknown | undefined> {
    try {
      const metadata = await lstat(this.path);
      if (metadata.isSymbolicLink()) throw new FabricStoreError(`Gateway Fabric store path must not be a symbolic link: ${this.path}`);
      if (!metadata.isFile()) throw new FabricStoreError(`Gateway Fabric store path must be a file: ${this.path}`);
      if (metadata.size > this.maximumBytes) throw new FabricStoreCapacityError(`Gateway Fabric store exceeds ${this.maximumBytes} bytes`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return readGatewayJson<unknown>(this.path, this.maximumBytes);
  }

  private enforceRetention(document: MutableDocument): void {
    if (document.outbox.length > this.maxOutboxEvents) throw new FabricStoreCapacityError("Fabric outbox retention capacity reached; undelivered events were preserved");
    const pending = new Set(document.outbox.map((event) => event.eventId));
    for (const kind of FABRIC_STORE_KINDS) {
      const state = document.stores[kind];
      while (state.events.length > this.maxEventsPerStore) {
        const oldest = state.events[0]!;
        if (pending.has(oldest.eventId) || state.cursors.length === 0 || state.cursors.some((cursor) => cursor.nextSequence <= oldest.sequence)) {
          throw new FabricStoreCapacityError(`Fabric ${kind} event retention capacity reached; required events were preserved`);
        }
        state.events.shift();
      }
    }
  }

  private async persist(document: MutableDocument): Promise<void> {
    await this.fault?.("before-write");
    await this.write(this.path, clone(document), this.maximumBytes);
    await this.fault?.("after-write");
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    let releaseLocal!: () => void;
    const previous = tails.get(this.path) ?? Promise.resolve();
    const current = new Promise<void>((resolve) => { releaseLocal = resolve; });
    tails.set(this.path, current);
    await previous;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    let releaseFile: (() => Promise<void>) | undefined;
    try {
      releaseFile = await properLockfile.lock(this.path, {
        realpath: false,
        stale: 10_000,
        update: 2_000,
        retries: { retries: 50, factor: 1.2, minTimeout: 10, maxTimeout: 100, randomize: true },
      });
      return await operation();
    } finally {
      try { if (releaseFile) await releaseFile(); }
      finally {
        releaseLocal();
        if (tails.get(this.path) === current) tails.delete(this.path);
      }
    }
  }
}
