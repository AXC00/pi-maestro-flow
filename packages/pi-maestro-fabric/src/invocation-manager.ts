import {
  FabricContractError,
  assertInvocationReceiptTransition,
  assertRevision,
  assertValidInvocationReceipt,
  type FabricInvocationState,
  type InvocationReceipt,
  type JsonValue,
} from "pi-maestro-fabric-core/v1";
import { FabricAdmissionManager } from "./admission-manager.ts";
import { FabricStoreCoordinator, type FabricStoredRecord } from "./store-coordinator.ts";

export interface FabricInvocationTransition {
  state: FabricInvocationState;
  expectedRevision: number;
  updatedAt?: number;
  endpointReceiptRef?: string;
  resultRef?: string;
}

export interface FabricInvocationManagerOptions {
  now?: () => number;
}

const TERMINAL_STATES = new Set<FabricInvocationState>(["succeeded", "failed", "cancelled"]);

function storedRecord(value: object): FabricStoredRecord {
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry as JsonValue;
  }
  return result;
}

/** Durable operation uniqueness and monotonic receipt transitions. */
export class FabricInvocationManager {
  readonly #now: () => number;

  constructor(
    readonly admissions: FabricAdmissionManager,
    readonly coordinator: FabricStoreCoordinator,
    options: FabricInvocationManagerOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
  }

  async admit(input: InvocationReceipt): Promise<InvocationReceipt> {
    assertValidInvocationReceipt(input);
    if (input.state !== "accepted" || input.revision !== 0) {
      throw new FabricContractError("invalid_state", "New invocation must start accepted at revision zero", "state");
    }
    this.#assertRouteAuthority(input);
    this.#assertReplayAuthority(input);
    const next = { ...input, revision: 1 };
    const committed = await this.coordinator.commit("invocation", this.#now(), (store) => {
      const previousRecord = store.records[input.operationId];
      if (previousRecord !== undefined) {
        const previous = this.#fromRecord(previousRecord);
        if (!this.#sameAuthority(previous, input)) {
          throw new FabricContractError("conflict", "Operation identity is already bound to another route", "operationId");
        }
        return { mutations: [], value: previous };
      }
      return {
        mutations: [{
          kind: "upsert",
          subjectId: input.operationId,
          value: storedRecord(next),
          eventKind: "invocation.accepted",
          payload: {
            operationId: next.operationId,
            routeId: next.routeId,
            endpointId: next.endpointId,
            connectionGeneration: next.connectionGeneration,
            endpointGeneration: next.endpointGeneration,
            state: next.state,
            replayClass: next.replayClass,
            updatedAt: next.updatedAt,
          },
        }],
        value: next,
      };
    });
    this.#assertRouteAuthority(committed);
    return { ...committed };
  }

  async transition(operationId: string, input: FabricInvocationTransition): Promise<InvocationReceipt> {
    assertRevision(input.expectedRevision, "expectedRevision");
    const currentRecord = await this.coordinator.get("invocation", operationId);
    if (currentRecord === undefined) throw new FabricContractError("not_found", "Invocation receipt is not known", "operationId");
    const current = this.#fromRecord(currentRecord);
    if (current.revision !== input.expectedRevision) throw new FabricContractError("conflict", "Invocation receipt revision is stale", "expectedRevision");
    if (TERMINAL_STATES.has(current.state)) {
      if (
        input.state === current.state &&
        (input.endpointReceiptRef === undefined || input.endpointReceiptRef === current.endpointReceiptRef) &&
        (input.resultRef === undefined || input.resultRef === current.resultRef)
      ) return { ...current };
      throw new FabricContractError("invalid_state", "Terminal invocation receipt is immutable", "state");
    }
    this.#assertRouteAuthority(current);
    const next: InvocationReceipt = {
      ...current,
      state: input.state,
      endpointReceiptRef: input.endpointReceiptRef ?? current.endpointReceiptRef,
      resultRef: input.resultRef,
      revision: current.revision + 1,
      updatedAt: input.updatedAt ?? this.#now(),
    };
    if (current.state === "outcome-unknown" && TERMINAL_STATES.has(next.state) && next.endpointReceiptRef === undefined) {
      throw new FabricContractError("permission_denied", "Resolving outcome-unknown requires Endpoint receipt evidence", "endpointReceiptRef");
    }
    assertInvocationReceiptTransition(current, next);
    const committed = await this.coordinator.commit("invocation", next.updatedAt, (store) => {
      const latest = store.records[operationId];
      if (latest?.revision !== current.revision) {
        throw new FabricContractError("conflict", "Invocation receipt revision is stale", "expectedRevision");
      }
      return {
        mutations: [{
          kind: "upsert",
          subjectId: operationId,
          expectedRevision: current.revision,
          value: storedRecord(next),
          eventKind: `invocation.${next.state}`,
          payload: storedRecord({
            operationId: next.operationId,
            routeId: next.routeId,
            endpointId: next.endpointId,
            connectionGeneration: next.connectionGeneration,
            endpointGeneration: next.endpointGeneration,
            previousState: current.state,
            nextState: next.state,
            replayClass: next.replayClass,
            endpointReceiptRef: next.endpointReceiptRef,
            resultRef: next.resultRef,
            updatedAt: next.updatedAt,
          }),
        }],
        value: next,
      };
    });
    // The store await is an asynchronous publication boundary. A route closed while it
    // was pending must fail the caller even though the durable receipt remains auditable.
    this.#assertRouteAuthority(committed);
    return { ...committed };
  }

  async get(operationId: string): Promise<InvocationReceipt | undefined> {
    const record = await this.coordinator.get("invocation", operationId);
    return record === undefined ? undefined : this.#fromRecord(record);
  }

  #assertRouteAuthority(receipt: InvocationReceipt): void {
    const route = this.admissions.validateRoute(receipt.routeId);
    if (
      route.endpointId !== receipt.endpointId || route.connectionGeneration !== receipt.connectionGeneration ||
      route.endpointGeneration !== receipt.endpointGeneration
    ) {
      throw new FabricContractError("stale_generation", "Invocation receipt does not match its current route", "routeId");
    }
  }

  #assertReplayAuthority(receipt: InvocationReceipt): void {
    if (receipt.replayClass !== "durable-dedup") return;
    const endpoint = this.admissions.directory.getEndpoint(receipt.endpointId);
    if (endpoint?.kind !== "mcp" || !endpoint.durableDeduplication) {
      throw new FabricContractError("permission_denied", "Endpoint does not prove durable deduplication", "replayClass");
    }
  }

  #fromRecord(record: FabricStoredRecord): InvocationReceipt {
    const receipt = {
      operationId: record.operationId,
      routeId: record.routeId,
      endpointId: record.endpointId,
      connectionGeneration: record.connectionGeneration,
      endpointGeneration: record.endpointGeneration,
      state: record.state,
      replayClass: record.replayClass,
      endpointReceiptRef: record.endpointReceiptRef,
      resultRef: record.resultRef,
      revision: record.revision,
      updatedAt: record.updatedAt,
    } as InvocationReceipt;
    assertValidInvocationReceipt(receipt);
    if (receipt.revision < 1) throw new FabricContractError("protocol_violation", "Stored invocation revision must be positive", "revision");
    return receipt;
  }

  #sameAuthority(left: InvocationReceipt, right: InvocationReceipt): boolean {
    return left.operationId === right.operationId && left.routeId === right.routeId && left.endpointId === right.endpointId &&
      left.connectionGeneration === right.connectionGeneration && left.endpointGeneration === right.endpointGeneration &&
      left.replayClass === right.replayClass;
  }
}
