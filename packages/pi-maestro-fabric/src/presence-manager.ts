import {
  FabricContractError,
  assertEpochMilliseconds,
  assertFabricIdentifier,
  assertGeneration,
  assertRevision,
  type JsonValue,
} from "pi-maestro-fabric-core/v1";
import { FabricConnectionManager } from "./connection-manager.ts";
import { FabricDirectory } from "./directory.ts";
import { FabricStoreCoordinator, type FabricStoredRecord } from "./store-coordinator.ts";

export const FABRIC_PRESENCE_SUBJECT_KINDS = ["connector", "device", "endpoint"] as const;
export type FabricPresenceSubjectKind = (typeof FABRIC_PRESENCE_SUBJECT_KINDS)[number];
export const FABRIC_PRESENCE_STATUSES = ["unknown", "online", "degraded", "offline"] as const;
export type FabricPresenceStatus = (typeof FABRIC_PRESENCE_STATUSES)[number];

export interface FabricPresenceHeartbeat {
  subjectKind: FabricPresenceSubjectKind;
  subjectId: string;
  connectionId: string;
  connectionGeneration: number;
  sequence: number;
  status: FabricPresenceStatus;
  observedAt: number;
  expiresAt: number;
}

export interface FabricPresenceRecord extends FabricPresenceHeartbeat {
  evidenceRevision: number;
  revision: number;
}

export interface FabricPresenceManagerOptions {
  now?: () => number;
}

function recordRevision(record: FabricStoredRecord): number {
  assertRevision(record.revision, "presence.revision");
  if (record.revision < 1) throw new FabricContractError("protocol_violation", "Presence revision must be positive", "revision");
  return record.revision;
}

function asRecord(input: FabricPresenceRecord): FabricStoredRecord {
  return { ...input } as Readonly<Record<string, JsonValue>>;
}

/** Durable, generation-fenced last-known presence observations. */
export class FabricPresenceManager {
  readonly #now: () => number;

  constructor(
    readonly directory: FabricDirectory,
    readonly connections: FabricConnectionManager,
    readonly coordinator: FabricStoreCoordinator,
    options: FabricPresenceManagerOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
  }

  async heartbeat(input: FabricPresenceHeartbeat): Promise<FabricPresenceRecord> {
    this.#assertHeartbeat(input);
    this.#assertCurrentAuthority(input);
    const at = this.#now();
    const committed = await this.coordinator.commit("presence", at, (store) => {
      const previous = store.records[input.subjectId];
      if (previous !== undefined && previous.subjectKind !== input.subjectKind) {
        throw new FabricContractError("conflict", "Presence identity is already used by another subject kind", "subjectId");
      }
      if (previous !== undefined) {
        if (previous.connectionId !== input.connectionId || previous.connectionGeneration !== input.connectionGeneration) {
          const priorGeneration = previous.connectionGeneration;
          if (typeof priorGeneration !== "number" || input.connectionGeneration <= priorGeneration) {
            throw new FabricContractError("stale_generation", "Presence connection generation is stale", "connectionGeneration");
          }
        } else if (typeof previous.sequence !== "number" || input.sequence <= previous.sequence) {
          throw new FabricContractError("stale_generation", "Heartbeat sequence must strictly increase", "sequence");
        }
      }
      const priorRevision = previous === undefined ? undefined : recordRevision(previous);
      const priorEvidence = previous?.evidenceRevision;
      if (priorEvidence !== undefined && (typeof priorEvidence !== "number" || !Number.isSafeInteger(priorEvidence) || priorEvidence < 1)) {
        throw new FabricContractError("protocol_violation", "Presence evidence revision is invalid", "evidenceRevision");
      }
      const next: FabricPresenceRecord = {
        ...input,
        evidenceRevision: (priorEvidence ?? 0) + 1,
        revision: (priorRevision ?? 0) + 1,
      };
      return {
        mutations: [{
          kind: "upsert",
          subjectId: input.subjectId,
          expectedRevision: priorRevision,
          value: asRecord(next),
          eventKind: "presence.heartbeat",
          payload: {
            kind: input.subjectKind,
            subjectId: input.subjectId,
            connectionId: input.connectionId,
            connectionGeneration: input.connectionGeneration,
            sequence: input.sequence,
            status: input.status,
            observedAt: input.observedAt,
            expiresAt: input.expiresAt,
            evidenceRevision: next.evidenceRevision,
          },
        }],
        value: next,
      };
    });
    try {
      this.#assertCurrentAuthority(input);
    } catch (error) {
      await this.#fenceLateHeartbeat(committed);
      throw error;
    }
    return { ...committed };
  }

  async get(subjectId: string): Promise<FabricPresenceRecord | undefined> {
    assertFabricIdentifier(subjectId, "subjectId");
    const record = await this.coordinator.get("presence", subjectId);
    if (record === undefined) return undefined;
    const presence = this.#fromRecord(record);
    if (presence.expiresAt <= this.#now() && presence.status !== "offline") return { ...presence, status: "offline" };
    return { ...presence };
  }

  async expire(subjectId: string, expectedRevision: number): Promise<FabricPresenceRecord> {
    assertFabricIdentifier(subjectId, "subjectId");
    assertRevision(expectedRevision, "expectedRevision");
    const at = this.#now();
    return this.coordinator.commit("presence", at, (store) => {
      const currentRecord = store.records[subjectId];
      if (currentRecord === undefined) throw new FabricContractError("not_found", "Presence is not known", "subjectId");
      const current = this.#fromRecord(currentRecord);
      if (current.revision !== expectedRevision) throw new FabricContractError("conflict", "Presence revision is stale", "expectedRevision");
      if (current.expiresAt > at) throw new FabricContractError("invalid_state", "Presence lease has not expired", "expiresAt");
      if (current.status === "offline") return { mutations: [], value: current };
      const next: FabricPresenceRecord = { ...current, status: "offline", evidenceRevision: current.evidenceRevision + 1, revision: current.revision + 1 };
      return {
        mutations: [{
          kind: "upsert",
          subjectId,
          expectedRevision: current.revision,
          value: asRecord(next),
          eventKind: "presence.expired",
          payload: { kind: current.subjectKind, subjectId, connectionId: current.connectionId, connectionGeneration: current.connectionGeneration, sequence: current.sequence, status: "offline", observedAt: current.observedAt, expiresAt: current.expiresAt, evidenceRevision: next.evidenceRevision },
        }],
        value: next,
      };
    });
  }

  #assertHeartbeat(input: FabricPresenceHeartbeat): void {
    this.#assertPresenceShape(input);
    if (input.observedAt > this.#now()) throw new FabricContractError("invalid_argument", "Presence observation cannot be in the future", "observedAt");
    if (input.expiresAt <= this.#now()) throw new FabricContractError("expired", "Presence lease must be current", "expiresAt");
  }

  #assertPresenceShape(input: FabricPresenceHeartbeat): void {
    if (!FABRIC_PRESENCE_SUBJECT_KINDS.includes(input.subjectKind)) throw new FabricContractError("invalid_argument", "Invalid presence subject kind", "subjectKind");
    if (!FABRIC_PRESENCE_STATUSES.includes(input.status)) throw new FabricContractError("invalid_argument", "Invalid presence status", "status");
    assertFabricIdentifier(input.subjectId, "subjectId");
    assertFabricIdentifier(input.connectionId, "connectionId");
    assertGeneration(input.connectionGeneration, "connectionGeneration");
    assertGeneration(input.sequence, "sequence");
    assertEpochMilliseconds(input.observedAt, "observedAt");
    assertEpochMilliseconds(input.expiresAt, "expiresAt");
    if (input.expiresAt <= input.observedAt) throw new FabricContractError("protocol_violation", "Presence expiry must follow its observation", "expiresAt");
  }

  #assertCurrentAuthority(input: FabricPresenceHeartbeat): void {
    const lease = this.connections.requireReady(input.connectionId, input.connectionGeneration);
    if (input.subjectKind === "connector") {
      if (input.subjectId !== lease.connectorId) throw new FabricContractError("permission_denied", "Connector presence does not match the current connection", "subjectId");
      return;
    }
    if (input.subjectKind === "device") {
      this.connections.requireReadyForDevice(input.connectionId, input.connectionGeneration, input.subjectId);
      return;
    }
    const endpoint = this.directory.getEndpoint(input.subjectId);
    if (endpoint === undefined || endpoint.connectorId !== lease.connectorId) {
      throw new FabricContractError("permission_denied", "Endpoint is not admitted by the current Connector", "subjectId");
    }
    this.connections.requireReadyForDevice(input.connectionId, input.connectionGeneration, endpoint.deviceId);
  }

  #fromRecord(record: FabricStoredRecord): FabricPresenceRecord {
    const presence = {
      subjectKind: record.subjectKind,
      subjectId: record.subjectId,
      connectionId: record.connectionId,
      connectionGeneration: record.connectionGeneration,
      sequence: record.sequence,
      status: record.status,
      observedAt: record.observedAt,
      expiresAt: record.expiresAt,
      evidenceRevision: record.evidenceRevision,
      revision: recordRevision(record),
    } as FabricPresenceRecord;
    this.#assertPresenceShape(presence);
    assertRevision(presence.evidenceRevision, "evidenceRevision");
    if (presence.evidenceRevision < 1) throw new FabricContractError("protocol_violation", "Presence evidence revision must be positive", "evidenceRevision");
    return presence;
  }

  async #fenceLateHeartbeat(committed: FabricPresenceRecord): Promise<void> {
    const at = this.#now();
    await this.coordinator.commit("presence", at, (store) => {
      const current = store.records[committed.subjectId];
      if (current?.revision !== committed.revision || current.connectionId !== committed.connectionId || current.connectionGeneration !== committed.connectionGeneration) {
        return { mutations: [], value: undefined };
      }
      const next = { ...committed, status: "offline" as const, expiresAt: Math.max(committed.observedAt + 1, at), evidenceRevision: committed.evidenceRevision + 1, revision: committed.revision + 1 };
      return {
        mutations: [{
          kind: "upsert",
          subjectId: committed.subjectId,
          expectedRevision: committed.revision,
          value: asRecord(next),
          eventKind: "presence.fenced",
          payload: { kind: committed.subjectKind, subjectId: committed.subjectId, connectionId: committed.connectionId, connectionGeneration: committed.connectionGeneration, sequence: committed.sequence, status: "offline", observedAt: committed.observedAt, expiresAt: next.expiresAt, evidenceRevision: next.evidenceRevision },
        }],
        value: undefined,
      };
    });
  }
}
