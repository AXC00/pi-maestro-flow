import type {
  AttemptReclamation,
  AttemptRecoveryFacts,
  BackendCapabilities,
} from "pi-maestro-backend-core/v1/backend";
import type { ControlMode, SingleResult, TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import {
  FABRIC_AGENT_ATTEMPT_VERSION,
  FABRIC_AGENT_OPERATIONS,
  assertFabricAgentStartRequest,
  fabricPlacementEvent,
  type FabricAgentControlReceiptV1,
  type FabricAgentEventPageV1,
  type FabricAgentRecoveryReceiptV1,
  type FabricAgentReclamationReceiptV1,
  type FabricAgentRunSpecV1,
  type FabricAgentStartAckV1,
  type FabricAgentStartRequestV1,
} from "pi-maestro-backends/fabric";
import {
  getFabricTeammateRuntimePort,
  type FabricTeammateAttempt,
  type FabricTeammateRuntimePort,
} from "pi-maestro-teammate/v1/fabric-runtime";
import {
  FabricContractError,
  assertFabricIdentifier,
  type AgentRuntimeEndpoint,
  type FabricPlacementEventV1,
  type JsonValue,
} from "pi-maestro-fabric-core/v1";
import { principalKey } from "../principal.ts";
import type { GatewayWorkspace } from "../contracts.ts";
import type { FabricEndpointDispatchContext, FabricEndpointHandler } from "./endpoint-dispatcher.ts";
import type { GatewayFabricControlSupport } from "./control-support.ts";

export interface FabricAgentEndpointLimits {
  readonly maxAttempts: number;
  readonly maxEventsPerAttempt: number;
  readonly maxEventRead: number;
  readonly maxMessageBytes: number;
}

export interface FabricAgentEndpointOptions {
  readonly support: GatewayFabricControlSupport;
  readonly runtimeOf?: () => FabricTeammateRuntimePort | undefined;
  /** When present, ACK admission is fenced to this proven source capability set. */
  readonly sourceBackends?: readonly {
    readonly name: string;
    readonly capabilities: BackendCapabilities;
  }[];
  readonly limits?: Partial<FabricAgentEndpointLimits>;
  readonly now?: () => number;
}

interface PendingEvent {
  readonly kind: FabricPlacementEventV1["kind"];
  readonly payload: Readonly<Record<string, JsonValue>>;
}

interface SourceAttemptState {
  readonly request: FabricAgentStartRequestV1;
  readonly fingerprint: string;
  readonly principalId: string;
  readonly localWorkspaceId: string;
  readonly localWorkspacePath: string;
  readonly localWorkspaceGeneration: number;
  readonly controller: AbortController;
  readonly events: FabricPlacementEventV1[];
  readonly pendingEvents: PendingEvent[];
  nextSequence: number;
  startPromise: Promise<FabricAgentStartAckV1>;
  handle?: FabricTeammateAttempt;
  ack?: FabricAgentStartAckV1;
  recovery?: AttemptRecoveryFacts;
  result?: SingleResult;
  reclamation?: AttemptReclamation;
  settlement?: Promise<void>;
  deadlineTimer?: NodeJS.Timeout;
  terminal: boolean;
  overflowed: boolean;
  turnCompleteEmitted: boolean;
  released: boolean;
}

const DEFAULT_LIMITS: FabricAgentEndpointLimits = Object.freeze({
  maxAttempts: 128,
  maxEventsPerAttempt: 512,
  maxEventRead: 128,
  maxMessageBytes: 64 * 1024,
});

function positiveLimit(value: number | undefined, fallback: number, path: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new FabricContractError("invalid_argument", `${path} must be a positive safe integer`, path);
  }
  return result;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function json<T>(value: unknown, path: string): T & JsonValue {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("undefined");
    return JSON.parse(serialized) as T & JsonValue;
  } catch {
    throw new FabricContractError("protocol_violation", `${path} must contain plain JSON`, path);
  }
}

function object(value: unknown, path: string): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FabricContractError("invalid_argument", `${path} must be an object`, path);
  }
  return value as Record<string, JsonValue>;
}

function safeInteger(value: unknown, path: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new FabricContractError("invalid_argument", `${path} must be a safe integer >= ${minimum}`, path);
  }
  return value as number;
}

function controlMode(value: unknown): ControlMode {
  if (value !== "prompt" && value !== "follow_up" && value !== "steer") {
    throw new FabricContractError("invalid_argument", "mode is invalid", "mode");
  }
  return value;
}

function identity(input: Record<string, JsonValue>): { attemptId: string; placementId: string } {
  if (input.version !== FABRIC_AGENT_ATTEMPT_VERSION) {
    throw new FabricContractError("unsupported_version", "Unsupported Fabric Agent attempt version", "version");
  }
  assertFabricIdentifier(input.attemptId, "attemptId");
  assertFabricIdentifier(input.placementId, "placementId");
  return { attemptId: input.attemptId, placementId: input.placementId };
}

function capabilitiesJson(capabilities: BackendCapabilities): BackendCapabilities & Readonly<Record<string, JsonValue>> {
  return json(capabilities, "acceptedCapabilities") as BackendCapabilities & Readonly<Record<string, JsonValue>>;
}

function sameCapabilities(left: BackendCapabilities, right: BackendCapabilities): boolean {
  return left.outputSchema === right.outputSchema && left.forkContext === right.forkContext &&
    left.modelSelection === right.modelSelection && left.thinkingLevel === right.thinkingLevel &&
    left.todoBinding === right.todoBinding && left.toolFilter === right.toolFilter &&
    left.steer === right.steer && left.followUp === right.followUp && left.abort === right.abort;
}

/** Source-side Agent Endpoint. It runs one attempt and never publishes canonical completion. */
export class FabricAgentEndpointBridge implements FabricEndpointHandler {
  readonly support: GatewayFabricControlSupport;
  readonly limits: Readonly<FabricAgentEndpointLimits>;
  readonly #runtimeOf: () => FabricTeammateRuntimePort | undefined;
  readonly #sourceBackends?: ReadonlyMap<string, BackendCapabilities>;
  readonly #now: () => number;
  readonly #attempts = new Map<string, SourceAttemptState>();

  constructor(options: FabricAgentEndpointOptions) {
    this.support = options.support;
    this.#runtimeOf = options.runtimeOf ?? getFabricTeammateRuntimePort;
    if (options.sourceBackends !== undefined) {
      const entries = options.sourceBackends.map((backend) => [backend.name, structuredClone(backend.capabilities)] as const);
      if (new Set(entries.map(([name]) => name)).size !== entries.length) {
        throw new FabricContractError("invalid_argument", "sourceBackends must not contain duplicate names", "sourceBackends");
      }
      this.#sourceBackends = new Map(entries);
    }
    this.#now = options.now ?? Date.now;
    this.limits = Object.freeze({
      maxAttempts: positiveLimit(options.limits?.maxAttempts, DEFAULT_LIMITS.maxAttempts, "maxAttempts"),
      maxEventsPerAttempt: positiveLimit(options.limits?.maxEventsPerAttempt, DEFAULT_LIMITS.maxEventsPerAttempt, "maxEventsPerAttempt"),
      maxEventRead: positiveLimit(options.limits?.maxEventRead, DEFAULT_LIMITS.maxEventRead, "maxEventRead"),
      maxMessageBytes: positiveLimit(options.limits?.maxMessageBytes, DEFAULT_LIMITS.maxMessageBytes, "maxMessageBytes"),
    });
    if (this.limits.maxEventsPerAttempt < 6) {
      throw new FabricContractError("invalid_argument", "maxEventsPerAttempt must reserve lifecycle capacity", "maxEventsPerAttempt");
    }
  }

  async handle(context: FabricEndpointDispatchContext): Promise<JsonValue> {
    if (context.endpoint.kind !== "agent") {
      throw new FabricContractError("conflict", "Agent bridge requires an Agent Endpoint", "endpointKind");
    }
    if (!FABRIC_AGENT_OPERATIONS.includes(context.request.operation as never)) {
      throw new FabricContractError("invalid_argument", "Unsupported Fabric Agent operation", "operation");
    }
    switch (context.request.operation) {
      case "agent.start": return this.#start(context);
      case "agent.send": return this.#send(context);
      case "agent.abort": return this.#abort(context);
      case "agent.events": return this.#events(context);
      case "agent.recover": return this.#recover(context);
      case "agent.reclaim": return this.#reclaim(context);
      default: throw new FabricContractError("invalid_argument", "Unsupported Fabric Agent operation", "operation");
    }
  }

  async #start(context: FabricEndpointDispatchContext): Promise<JsonValue> {
    if (context.endpoint.kind !== "agent") {
      throw new FabricContractError("conflict", "Agent bridge requires an Agent Endpoint", "endpointKind");
    }
    const endpoint = context.endpoint;
    const input = context.request.input as unknown;
    assertFabricAgentStartRequest(input, this.#now());
    this.#assertPlacement(context, input);
    this.#assertEndpointSelection(endpoint, input);
    const local = await this.#authorizeWorkspace(context, input);
    this.#assertCurrent(context, input.placement.placementId);
    const fingerprint = JSON.stringify(input);
    const existing = this.#attempts.get(input.placement.placementId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint || existing.principalId !== principalKey(context.principal)) {
        throw new FabricContractError("conflict", "placementId is already bound to another source attempt", "placementId");
      }
      return json(await existing.startPromise, "startAck");
    }
    this.#reapReleased();
    if (this.#attempts.size >= this.limits.maxAttempts) {
      throw new FabricContractError("resource_exhausted", "Fabric Agent attempt capacity is full", "maxAttempts");
    }
    const endpointOccupancy = [...this.#attempts.values()].filter((state) =>
      state.request.placement.endpointId === endpoint.endpointId && state.reclamation?.status !== "reclaimed"
    ).length;
    if (endpointOccupancy >= endpoint.maxConcurrency) {
      throw new FabricContractError("resource_exhausted", "Agent Endpoint concurrency is full", "maxConcurrency");
    }

    const state: SourceAttemptState = {
      request: structuredClone(input),
      fingerprint,
      principalId: principalKey(context.principal),
      localWorkspaceId: local.id,
      localWorkspacePath: local.path,
      localWorkspaceGeneration: local.generation,
      controller: new AbortController(),
      events: [],
      pendingEvents: [],
      nextSequence: 1,
      startPromise: Promise.resolve(undefined as never),
      terminal: false,
      overflowed: false,
      turnCompleteEmitted: false,
      released: false,
    };
    this.#attempts.set(input.placement.placementId, state);
    const timer = setTimeout(() => {
      state.controller.abort(new FabricContractError("deadline_exceeded", "Fabric placement deadline has passed", "deadlineAt"));
      state.handle?.abort();
    }, Math.max(0, input.placement.deadlineAt - this.#now()));
    timer.unref?.();
    state.deadlineTimer = timer;
    const cancelStart = (): void => {
      state.controller.abort(context.signal.reason ?? new FabricContractError("cancelled", "Fabric Agent start request was cancelled"));
      state.handle?.abort();
    };
    context.signal.addEventListener("abort", cancelStart, { once: true });
    if (context.signal.aborted) cancelStart();
    state.startPromise = this.#startAttempt(state, endpoint);
    try {
      return json(await state.startPromise, "startAck");
    } finally {
      context.signal.removeEventListener("abort", cancelStart);
    }
  }

  async #startAttempt(state: SourceAttemptState, endpoint: AgentRuntimeEndpoint): Promise<FabricAgentStartAckV1> {
    const runtime = this.#runtimeOf();
    if (runtime === undefined) {
      this.#failStart(state, "No Fabric teammate runtime port is registered");
      throw new FabricContractError("unavailable", "No Fabric teammate runtime port is registered");
    }
    const request = state.request;
    const source = request.spec;
    const spec: TeammateRunSpec = {
      agent: source.agent,
      task: source.task,
      ...(source.name === undefined ? {} : { name: source.name }),
      ...(source.context === undefined ? {} : { context: source.context }),
      ...(source.model === undefined ? {} : { model: source.model }),
      ...(source.thinking === undefined ? {} : { thinking: source.thinking }),
      ...(source.outputSchema === undefined ? {} : { outputSchema: source.outputSchema }),
      cwd: state.localWorkspacePath,
    };
    try {
      const handle = await runtime.startAttempt({
        placement: request.placement,
        spec,
        correlationId: request.attemptId,
        baseCwd: state.localWorkspacePath,
        signal: state.controller.signal,
        onChildEvent: (event) => {
          try {
            this.#queueOrEmit(state, "output", { event: json(event, "childEvent") });
          } catch (error) {
            this.#overflow(state, error instanceof Error ? error.message : String(error));
          }
        },
        onTurnComplete: (result, terminalStatus) => {
          try {
            const payload = {
              result: json(result, "turnResult"),
              ...(terminalStatus === undefined ? {} : { terminalStatus }),
            };
            this.#queueOrEmit(state, "turn-complete", payload);
            state.turnCompleteEmitted = true;
          } catch (error) {
            this.#overflow(state, error instanceof Error ? error.message : String(error));
          }
        },
      });
      if (state.controller.signal.aborted) {
        handle.abort();
        throw new FabricContractError("cancelled", "Fabric source attempt was cancelled before ACK");
      }
      this.#assertAcceptedSelection(endpoint, request.spec, request.placement.requestedModel, handle);
      state.handle = handle;
      const ack: FabricAgentStartAckV1 = {
        version: FABRIC_AGENT_ATTEMPT_VERSION,
        attemptId: request.attemptId,
        placementId: request.placement.placementId,
        routeId: request.placement.routeId,
        endpointId: request.placement.endpointId,
        connectionGeneration: request.placement.connectionGeneration,
        ...(request.placement.workspaceGeneration === undefined ? {} : { workspaceGeneration: request.placement.workspaceGeneration }),
        endpointGeneration: request.placement.endpointGeneration,
        acceptedBackend: handle.acceptedBackend,
        ...(handle.acceptedModel === undefined ? {} : { acceptedModel: handle.acceptedModel }),
        acceptedCapabilities: capabilitiesJson(handle.acceptedCapabilities),
        receiptRef: this.#receipt(state, "start"),
      };
      state.ack = ack;
      this.#emit(state, "start-ack", {
        attemptId: ack.attemptId,
        acceptedBackend: ack.acceptedBackend,
        ...(ack.acceptedModel === undefined ? {} : { acceptedModel: ack.acceptedModel }),
        receiptRef: ack.receiptRef,
      });
      for (const pending of state.pendingEvents.splice(0)) this.#emit(state, pending.kind, pending.payload);
      state.settlement = this.#settle(state);
      return ack;
    } catch (error) {
      this.#failStart(state, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async #settle(state: SourceAttemptState): Promise<void> {
    try {
      const outcome = await state.handle!.outcome;
      if (state.overflowed) {
        throw new FabricContractError("resource_exhausted", "Fabric Agent event buffer overflowed", "events");
      }
      state.result = structuredClone(outcome.result);
      if (!state.turnCompleteEmitted) {
        state.turnCompleteEmitted = true;
        this.#emit(state, "turn-complete", {
          result: json(outcome.result, "turnResult"),
          ...(outcome.result.terminalStatus === undefined ? {} : { terminalStatus: outcome.result.terminalStatus }),
        });
      }
      state.recovery = structuredClone(outcome.recovery);
      this.#emit(state, "recovery-facts", json(outcome.recovery, "recovery"));
      state.reclamation = await outcome.reclamation;
      this.#emit(state, "reclamation", json(state.reclamation, "reclamation"));
      state.terminal = true;
      // A source lifecycle fact: it names the terminal state and a receipt so
      // the origin can close its attempt. It carries no publication identity and
      // is never the canonical agent:// publication, which stays at the origin.
      this.#emit(state, "completion", {
        terminalStatus: outcome.result.terminalStatus ?? (outcome.result.exitCode === 0 ? "completed" : "failed"),
        receiptRef: this.#receipt(state, "completion"),
      });
    } catch (error) {
      state.recovery = {
        settlementAuthority: "unknown",
        completedToolCount: 0,
        inFlightToolCount: 0,
        preActivityInfrastructureExit: false,
        externalReplayRisk: true,
      };
      state.reclamation = { status: "unreaped", reason: `source attempt failed before release was confirmed: ${String(error)}` };
      this.#emit(state, "error", { message: String(error).slice(0, 1024) });
      this.#emit(state, "recovery-facts", json(state.recovery, "recovery"));
      this.#emit(state, "reclamation", json(state.reclamation, "reclamation"));
      state.terminal = true;
      this.#emit(state, "completion", { terminalStatus: "failed", receiptRef: this.#receipt(state, "completion") });
    }
    if (state.deadlineTimer !== undefined) clearTimeout(state.deadlineTimer);
  }

  #failStart(state: SourceAttemptState, reason: string): void {
    if (state.terminal) return;
    state.recovery = {
      settlementAuthority: "unknown",
      completedToolCount: 0,
      inFlightToolCount: 0,
      preActivityInfrastructureExit: false,
      externalReplayRisk: true,
    };
    state.reclamation = { status: "unreaped", reason: `start acknowledgement was not established: ${reason}` };
    this.#emit(state, "error", { message: reason.slice(0, 1024) });
    this.#emit(state, "recovery-facts", json(state.recovery, "recovery"));
    this.#emit(state, "reclamation", json(state.reclamation, "reclamation"));
    state.terminal = true;
    this.#emit(state, "completion", { terminalStatus: "failed", receiptRef: this.#receipt(state, "completion") });
    if (state.deadlineTimer !== undefined) clearTimeout(state.deadlineTimer);
  }

  async #send(context: FabricEndpointDispatchContext): Promise<JsonValue> {
    const input = object(context.request.input, "input");
    const ids = identity(input);
    const state = await this.#state(context, ids);
    if (typeof input.message !== "string" || byteLength(input.message) > this.limits.maxMessageBytes) {
      throw new FabricContractError("invalid_argument", "Fabric teammate message is invalid or too large", "message");
    }
    const mode = controlMode(input.mode);
    const accepted = state.handle !== undefined && !state.terminal && state.handle.send(input.message, mode);
    const receipt: FabricAgentControlReceiptV1 = {
      version: FABRIC_AGENT_ATTEMPT_VERSION,
      ...ids,
      action: "send",
      accepted,
      state: accepted ? "queued" : "refused",
      receiptRef: this.#receipt(state, "send"),
    };
    return json(receipt, "sendReceipt");
  }

  async #abort(context: FabricEndpointDispatchContext): Promise<JsonValue> {
    const input = object(context.request.input, "input");
    const ids = identity(input);
    const state = await this.#state(context, ids);
    if (state.terminal) {
      return json<FabricAgentControlReceiptV1>({
        version: FABRIC_AGENT_ATTEMPT_VERSION, ...ids, action: "abort", accepted: false,
        state: "already-terminal", receiptRef: this.#receipt(state, "abort"),
      }, "abortReceipt");
    }
    state.controller.abort(new FabricContractError("cancelled", "Fabric source attempt abort requested"));
    state.handle?.abort();
    return json<FabricAgentControlReceiptV1>({
      version: FABRIC_AGENT_ATTEMPT_VERSION, ...ids, action: "abort", accepted: true,
      state: "accepted", receiptRef: this.#receipt(state, "abort"),
    }, "abortReceipt");
  }

  async #events(context: FabricEndpointDispatchContext): Promise<JsonValue> {
    const input = object(context.request.input, "input");
    const ids = identity(input);
    const state = await this.#state(context, ids);
    const afterSequence = safeInteger(input.afterSequence ?? 0, "afterSequence", 0);
    const limit = safeInteger(input.limit ?? this.limits.maxEventRead, "limit", 1);
    if (limit > this.limits.maxEventRead) throw new FabricContractError("resource_exhausted", "Fabric Agent event read exceeds maxEventRead", "limit");
    const events = state.events.filter((event) => event.sequence > afterSequence).slice(0, limit);
    const page: FabricAgentEventPageV1 = {
      version: FABRIC_AGENT_ATTEMPT_VERSION,
      ...ids,
      nextSequence: events.at(-1)?.sequence ?? afterSequence,
      terminal: state.terminal,
      events: structuredClone(events),
    };
    return json(page, "eventPage");
  }

  async #recover(context: FabricEndpointDispatchContext): Promise<JsonValue> {
    const input = object(context.request.input, "input");
    const ids = identity(input);
    const state = await this.#state(context, ids);
    const receipt: FabricAgentRecoveryReceiptV1 = {
      version: FABRIC_AGENT_ATTEMPT_VERSION,
      ...ids,
      startAcknowledged: state.ack !== undefined,
      terminal: state.terminal,
      lastSequence: state.nextSequence - 1,
      ...(state.recovery === undefined ? {} : { recovery: structuredClone(state.recovery) }),
      ...(state.result === undefined ? {} : { result: structuredClone(state.result) }),
      receiptRef: this.#receipt(state, "recovery"),
    };
    return json(receipt, "recoveryReceipt");
  }

  async #reclaim(context: FabricEndpointDispatchContext): Promise<JsonValue> {
    const input = object(context.request.input, "input");
    const ids = identity(input);
    const state = await this.#state(context, ids);
    if (state.settlement !== undefined && !state.terminal) {
      await this.#bounded(state.settlement, context.signal, context.request.deadlineAt);
    }
    const reclamation = state.reclamation ?? {
      status: "unreaped" as const,
      reason: "source attempt has not confirmed release",
    };
    if (reclamation.status === "reclaimed") state.released = true;
    const receipt: FabricAgentReclamationReceiptV1 = {
      version: FABRIC_AGENT_ATTEMPT_VERSION,
      ...ids,
      reclamation,
      receiptRef: this.#receipt(state, "reclamation"),
    };
    return json(receipt, "reclamationReceipt");
  }

  async #state(
    context: FabricEndpointDispatchContext,
    ids: { attemptId: string; placementId: string },
  ): Promise<SourceAttemptState> {
    const state = this.#attempts.get(ids.placementId);
    if (state === undefined || state.request.attemptId !== ids.attemptId) {
      throw new FabricContractError("not_found", "Fabric source attempt is not known", "placementId");
    }
    if (state.principalId !== principalKey(context.principal)) {
      throw new FabricContractError("permission_denied", "Fabric source attempt belongs to another principal", "placementId");
    }
    this.#assertPlacement(context, state.request);
    const local = await this.#authorizeWorkspace(context, state.request);
    if (local.id !== state.localWorkspaceId || local.path !== state.localWorkspacePath || local.generation !== state.localWorkspaceGeneration) {
      throw new FabricContractError("stale_generation", "Source-local workspace changed during the attempt", "workspaceId");
    }
    this.#assertCurrent(context, ids.placementId);
    return state;
  }

  async #authorizeWorkspace(context: FabricEndpointDispatchContext, request: FabricAgentStartRequestV1): Promise<GatewayWorkspace> {
    if (context.endpoint.scope.kind !== "workspace" || request.placement.workspaceBindingId === undefined || request.placement.workspaceGeneration === undefined) {
      throw new FabricContractError("permission_denied", "Fabric teammate placement requires a workspace-scoped Agent Endpoint", "workspaceBindingId");
    }
    const authorized = await this.support.authorizeWorkspace(context.principal, context.endpoint.scope.workspaceId);
    if (authorized.fabric.generation !== request.placement.workspaceGeneration) {
      throw new FabricContractError("stale_generation", "Fabric placement workspace generation is stale", "workspaceGeneration");
    }
    const local = await this.support.registry.get(authorized.localWorkspaceId);
    if (local === undefined) throw new FabricContractError("permission_denied", "Mapped source workspace is not registered", "workspaceId");
    return local;
  }

  #assertPlacement(context: FabricEndpointDispatchContext, request: FabricAgentStartRequestV1): void {
    const placement = request.placement;
    if (
      placement.routeId !== context.route.routeId || placement.endpointId !== context.endpoint.endpointId ||
      placement.connectionGeneration !== context.route.connectionGeneration ||
      placement.workspaceBindingId !== context.route.workspaceBindingId ||
      placement.workspaceGeneration !== context.route.workspaceGeneration ||
      placement.endpointGeneration !== context.route.endpointGeneration ||
      placement.deadlineAt !== context.request.deadlineAt
    ) {
      throw new FabricContractError("stale_generation", "Fabric source request does not match its admitted placement", "placement");
    }
  }

  #assertEndpointSelection(endpoint: AgentRuntimeEndpoint, request: FabricAgentStartRequestV1): void {
    const placement = request.placement;
    const spec = request.spec;
    if (placement.requestedRole !== undefined && placement.requestedRole !== spec.agent) {
      throw new FabricContractError("conflict", "Placement role does not match source run spec", "requestedRole");
    }
    if (!endpoint.roles.includes(spec.agent)) {
      throw new FabricContractError("permission_denied", "Agent Endpoint does not advertise the requested role", "agent");
    }
    if (placement.requestedTaskType !== undefined && !endpoint.taskTypes.includes(placement.requestedTaskType)) {
      throw new FabricContractError("permission_denied", "Agent Endpoint does not advertise the requested task type", "requestedTaskType");
    }
    if (placement.requestedModel !== undefined && placement.requestedModel !== spec.model) {
      throw new FabricContractError("conflict", "Placement model does not match source run spec", "requestedModel");
    }
    if (spec.model !== undefined && !endpoint.models.includes(spec.model)) {
      throw new FabricContractError("permission_denied", "Agent Endpoint does not advertise the requested model", "model");
    }
  }

  #assertAcceptedSelection(
    endpoint: AgentRuntimeEndpoint,
    spec: FabricAgentRunSpecV1,
    requestedModel: string | undefined,
    handle: FabricTeammateAttempt,
  ): void {
    assertFabricIdentifier(handle.acceptedBackend, "acceptedBackend");
    if (this.#sourceBackends !== undefined) {
      const advertised = this.#sourceBackends.get(handle.acceptedBackend);
      if (advertised === undefined) {
        handle.abort();
        throw new FabricContractError("permission_denied", "Source runtime selected a backend not admitted by this Agent Endpoint", "acceptedBackend");
      }
      if (!sameCapabilities(advertised, handle.acceptedCapabilities)) {
        handle.abort();
        throw new FabricContractError("stale_generation", "Source backend capabilities changed after advertisement", "acceptedCapabilities");
      }
    }
    if (handle.acceptedModel !== undefined && !endpoint.models.includes(handle.acceptedModel)) {
      handle.abort();
      throw new FabricContractError("conflict", "Source runtime selected a model not advertised by the Agent Endpoint", "acceptedModel");
    }
    if ((spec.model ?? requestedModel) !== undefined && handle.acceptedModel !== (spec.model ?? requestedModel)) {
      handle.abort();
      throw new FabricContractError("conflict", "Source runtime selected a different model", "acceptedModel");
    }
  }

  #assertCurrent(context: FabricEndpointDispatchContext, placementId: string): void {
    if (context.signal.aborted) throw new FabricContractError("cancelled", "Fabric Agent operation was cancelled");
    const route = this.support.requireRuntime().admissions.validateRoute(context.route.routeId);
    const endpoint = this.support.requireRuntime().directory.getEndpoint(context.endpoint.endpointId);
    if (
      route.connectionGeneration !== context.route.connectionGeneration ||
      route.workspaceGeneration !== context.route.workspaceGeneration ||
      route.endpointGeneration !== context.route.endpointGeneration ||
      endpoint?.kind !== "agent" || endpoint.generation !== context.endpoint.generation ||
      (this.#attempts.has(placementId) && this.#attempts.get(placementId)?.request.placement.routeId !== route.routeId)
    ) {
      throw new FabricContractError("stale_generation", "Fabric Agent route changed during the operation", "routeId");
    }
  }

  #queueOrEmit(
    state: SourceAttemptState,
    kind: FabricPlacementEventV1["kind"],
    payload: Readonly<Record<string, JsonValue>>,
  ): void {
    if (state.terminal) return;
    try {
      if (state.ack === undefined) {
        const reserve = 5;
        if (kind === "output" && state.pendingEvents.length >= this.limits.maxEventsPerAttempt - reserve) {
          throw new FabricContractError("resource_exhausted", "Fabric Agent pending event buffer is full", "maxEventsPerAttempt");
        }
        if (state.pendingEvents.length >= this.limits.maxEventsPerAttempt) {
          throw new FabricContractError("resource_exhausted", "Fabric Agent pending lifecycle buffer is full", "maxEventsPerAttempt");
        }
        // Validate payload bounds before retaining anything emitted ahead of ACK.
        fabricPlacementEvent(
          state.request.placement.placementId,
          state.nextSequence + state.pendingEvents.length,
          kind,
          this.#now(),
          payload,
        );
        state.pendingEvents.push({ kind, payload });
      } else this.#emit(state, kind, payload);
    } catch (error) {
      this.#overflow(state, error instanceof Error ? error.message : String(error));
    }
  }

  #emit(
    state: SourceAttemptState,
    kind: FabricPlacementEventV1["kind"],
    payload: Readonly<Record<string, JsonValue>>,
  ): void {
    const reserve = 5;
    if (kind === "output" && state.events.length >= this.limits.maxEventsPerAttempt - reserve) {
      throw new FabricContractError("resource_exhausted", "Fabric Agent event buffer is full", "maxEventsPerAttempt");
    }
    if (state.events.length >= this.limits.maxEventsPerAttempt) {
      throw new FabricContractError("resource_exhausted", "Fabric Agent lifecycle event buffer is full", "maxEventsPerAttempt");
    }
    const event = fabricPlacementEvent(
      state.request.placement.placementId,
      state.nextSequence,
      kind,
      this.#now(),
      payload,
    );
    state.nextSequence += 1;
    state.events.push(event);
  }

  #overflow(state: SourceAttemptState, reason: string): void {
    if (state.overflowed) return;
    state.overflowed = true;
    state.controller.abort(new FabricContractError("resource_exhausted", reason, "events"));
    state.handle?.abort();
    try { this.#emit(state, "error", { message: reason.slice(0, 1024) }); } catch { /* capacity already exhausted */ }
  }

  #receipt(state: SourceAttemptState, kind: string): string {
    return `${state.request.placement.placementId}:${kind}:${Math.max(0, state.nextSequence - 1)}`;
  }

  #reapReleased(): void {
    for (const [placementId, state] of this.#attempts) {
      if (!state.released) continue;
      this.#attempts.delete(placementId);
      if (this.#attempts.size < this.limits.maxAttempts) return;
    }
  }

  async #bounded<T>(promise: Promise<T>, signal: AbortSignal, deadlineAt: number): Promise<T> {
    const remaining = deadlineAt - this.#now();
    if (remaining <= 0) throw new FabricContractError("deadline_exceeded", "Fabric Agent deadline has passed", "deadlineAt");
    if (signal.aborted) throw new FabricContractError("cancelled", "Fabric Agent request was cancelled");
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = (): void => finish(() => reject(new FabricContractError("cancelled", "Fabric Agent request was cancelled")));
      const timer = setTimeout(() => finish(() => reject(new FabricContractError("deadline_exceeded", "Fabric Agent deadline has passed", "deadlineAt"))), remaining);
      timer.unref?.();
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
    });
  }

  /** Abort every attempt pinned to a route after durable route close. */
  closeRoute(routeId: string): void {
    for (const state of this.#attempts.values()) {
      if (state.request.placement.routeId !== routeId || state.terminal) continue;
      state.controller.abort(new FabricContractError("cancelled", "Fabric route closed", "routeId"));
      state.handle?.abort();
    }
  }

  async close(): Promise<void> {
    const settlements: Promise<void>[] = [];
    for (const state of this.#attempts.values()) {
      state.controller.abort(new FabricContractError("cancelled", "Fabric Agent endpoint closed"));
      state.handle?.abort();
      if (state.settlement !== undefined) settlements.push(state.settlement);
      if (state.deadlineTimer !== undefined) clearTimeout(state.deadlineTimer);
    }
    const drained = Promise.allSettled(settlements).then(() => undefined);
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      timer.unref?.();
    });
    await Promise.race([drained, timeout]);
    this.#attempts.clear();
  }

  get attemptCount(): number { return this.#attempts.size; }
}
