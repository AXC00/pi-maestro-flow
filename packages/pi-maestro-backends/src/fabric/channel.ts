import type {
  AttemptReclamation,
  AttemptRecoveryFacts,
  BackendCapabilities,
} from "pi-maestro-backend-core/v1/backend";
import type {
  ControlMode,
  RunContext,
  SingleResult,
  ThinkingLevel,
} from "pi-maestro-backend-core/v1/spec";
import {
  FABRIC_PLACEMENT_VERSION,
  FabricContractError,
  assertEpochMilliseconds,
  assertFabricIdentifier,
  assertValidEndpointRecord,
  assertValidEndpointRouteHandle,
  assertValidFabricPlacementEvent,
  assertValidTeammatePlacement,
  type AgentRuntimeEndpoint,
  type EndpointRouteHandle,
  type FabricPlacementEventV1,
  type TeammatePlacementV1,
} from "pi-maestro-fabric-core/v1";

export const FABRIC_AGENT_ATTEMPT_VERSION = "fabric.agent-attempt.v1" as const;
export const FABRIC_AGENT_OPERATIONS = [
  "agent.start",
  "agent.send",
  "agent.abort",
  "agent.events",
  "agent.recover",
  "agent.reclaim",
] as const;
export type FabricAgentOperation = (typeof FABRIC_AGENT_OPERATIONS)[number];

/** The teammate fields allowed to cross to the selected source workspace. */
export interface FabricAgentRunSpecV1 {
  readonly agent: string;
  readonly task: string;
  readonly name?: string;
  readonly context?: RunContext;
  readonly model?: string;
  readonly thinking?: ThinkingLevel;
  readonly outputSchema?: Record<string, unknown>;
}

export interface FabricAgentStartRequestV1 {
  readonly version: typeof FABRIC_AGENT_ATTEMPT_VERSION;
  readonly attemptId: string;
  readonly placement: TeammatePlacementV1;
  readonly spec: FabricAgentRunSpecV1;
}

export interface FabricAgentStartAckV1 {
  readonly version: typeof FABRIC_AGENT_ATTEMPT_VERSION;
  readonly attemptId: string;
  readonly placementId: string;
  readonly routeId: string;
  readonly endpointId: string;
  readonly connectionGeneration: number;
  readonly workspaceGeneration?: number;
  readonly endpointGeneration: number;
  readonly acceptedBackend: string;
  readonly acceptedModel?: string;
  readonly acceptedCapabilities: BackendCapabilities;
  readonly receiptRef: string;
}

export interface FabricAgentSendRequestV1 {
  readonly version: typeof FABRIC_AGENT_ATTEMPT_VERSION;
  readonly attemptId: string;
  readonly placementId: string;
  readonly message: string;
  readonly mode: ControlMode;
}

export interface FabricAgentControlReceiptV1 {
  readonly version: typeof FABRIC_AGENT_ATTEMPT_VERSION;
  readonly attemptId: string;
  readonly placementId: string;
  readonly action: "send" | "abort";
  readonly accepted: boolean;
  readonly state: "queued" | "accepted" | "refused" | "already-terminal" | "unknown";
  readonly receiptRef: string;
}

export interface FabricAgentEventPageV1 {
  readonly version: typeof FABRIC_AGENT_ATTEMPT_VERSION;
  readonly attemptId: string;
  readonly placementId: string;
  readonly nextSequence: number;
  readonly terminal: boolean;
  readonly events: readonly FabricPlacementEventV1[];
}

export interface FabricAgentRecoveryReceiptV1 {
  readonly version: typeof FABRIC_AGENT_ATTEMPT_VERSION;
  readonly attemptId: string;
  readonly placementId: string;
  readonly startAcknowledged: boolean;
  readonly terminal: boolean;
  readonly lastSequence: number;
  readonly recovery?: AttemptRecoveryFacts;
  readonly result?: SingleResult;
  readonly receiptRef: string;
}

export interface FabricAgentReclamationReceiptV1 {
  readonly version: typeof FABRIC_AGENT_ATTEMPT_VERSION;
  readonly attemptId: string;
  readonly placementId: string;
  readonly reclamation: AttemptReclamation;
  readonly receiptRef: string;
}

export interface FabricBackendPrepareRequest {
  readonly placement: TeammatePlacementV1;
  readonly attemptId: string;
}

export interface FabricBackendChannelWaitResult {
  readonly status: "completed" | "transport-lost";
  readonly reason?: string;
}

/**
 * One route-pinned channel. A resolver may implement this over HTTPS, WSS, or a
 * test transport, but it cannot change Endpoint identity after preparation.
 */
export interface PreparedFabricBackendChannel {
  readonly route: EndpointRouteHandle;
  readonly endpoint: AgentRuntimeEndpoint;
  subscribe(listener: (event: FabricPlacementEventV1) => void): () => void;
  start(request: FabricAgentStartRequestV1, signal: AbortSignal): Promise<FabricAgentStartAckV1>;
  wait(signal: AbortSignal): Promise<FabricBackendChannelWaitResult>;
  send(request: FabricAgentSendRequestV1, signal: AbortSignal): Promise<FabricAgentControlReceiptV1>;
  abort(attemptId: string, placementId: string, signal: AbortSignal): Promise<FabricAgentControlReceiptV1>;
  recover(attemptId: string, placementId: string, signal: AbortSignal): Promise<FabricAgentRecoveryReceiptV1>;
  reclaim(attemptId: string, placementId: string, signal: AbortSignal): Promise<FabricAgentReclamationReceiptV1>;
  close(): Promise<void>;
}

export interface FabricBackendRouteResolver {
  prepare(request: FabricBackendPrepareRequest, signal: AbortSignal): Promise<PreparedFabricBackendChannel>;
}

/** Dispatch identity presented when acquiring origin-owned route wiring. */
export interface FabricBackendRouteResolverAcquireRequest {
  readonly correlationId: string;
  readonly placement: TeammatePlacementV1;
}

/** One generation-owned resolver lease for exactly one placed dispatch. */
export interface FabricBackendRouteResolverLease {
  readonly resolver: FabricBackendRouteResolver;
  readonly generation: number;
  readonly ownerId: string;
  release(): void | Promise<void>;
}

/** Lazily supplies a resolver lease after the dispatch identity is known. */
export interface FabricBackendRouteResolverAcquirer {
  acquire(
    request: FabricBackendRouteResolverAcquireRequest,
    signal: AbortSignal,
  ): FabricBackendRouteResolverLease | undefined | Promise<FabricBackendRouteResolverLease | undefined>;
}

/** Direct resolvers remain supported for embedders and focused transports. */
export type FabricBackendRouteResolverSource =
  | FabricBackendRouteResolver
  | FabricBackendRouteResolverAcquirer;

function positiveGeneration(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new FabricContractError("protocol_violation", `${path} must be a positive safe integer`, path);
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FabricContractError("protocol_violation", `${path} must be an object`, path);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) {
      throw new FabricContractError("invalid_argument", `${path} contains unsupported field ${JSON.stringify(key)}`, `${path}.${key}`);
    }
  }
}

export function assertPreparedFabricChannel(
  channel: PreparedFabricBackendChannel,
  placement: TeammatePlacementV1,
  now = Date.now(),
): void {
  assertValidTeammatePlacement(placement, now);
  assertValidEndpointRouteHandle(channel.route, now);
  assertValidEndpointRecord(channel.endpoint);
  if (channel.endpoint.kind !== "agent") {
    throw new FabricContractError("conflict", "Fabric teammate placement requires an Agent Endpoint", "endpointId");
  }
  const route = channel.route;
  const endpoint = channel.endpoint;
  if (
    route.state !== "open" || route.routeId !== placement.routeId ||
    route.endpointId !== placement.endpointId || route.endpointGeneration !== placement.endpointGeneration ||
    route.connectionGeneration !== placement.connectionGeneration ||
    route.workspaceBindingId !== placement.workspaceBindingId ||
    route.workspaceGeneration !== placement.workspaceGeneration ||
    endpoint.endpointId !== placement.endpointId || endpoint.generation !== placement.endpointGeneration
  ) {
    throw new FabricContractError("stale_generation", "Prepared Fabric channel does not match the placement route tuple", "placement");
  }
  if (endpoint.status !== "online") {
    throw new FabricContractError("unavailable", "Selected Agent Endpoint is not online", "endpointId");
  }
  if (placement.deadlineAt > route.expiresAt) {
    throw new FabricContractError("deadline_exceeded", "Placement deadline exceeds the selected route lease", "deadlineAt");
  }
}

export function assertFabricAgentStartAck(
  value: unknown,
  request: FabricAgentStartRequestV1,
): asserts value is FabricAgentStartAckV1 {
  const ack = record(value, "startAck") as unknown as FabricAgentStartAckV1;
  if (ack.version !== FABRIC_AGENT_ATTEMPT_VERSION) {
    throw new FabricContractError("unsupported_version", "Unsupported Fabric Agent attempt version", "version");
  }
  for (const [key, expected] of [
    ["attemptId", request.attemptId],
    ["placementId", request.placement.placementId],
    ["routeId", request.placement.routeId],
    ["endpointId", request.placement.endpointId],
  ] as const) {
    assertFabricIdentifier(ack[key], key);
    if (ack[key] !== expected) throw new FabricContractError("conflict", `Fabric start ACK ${key} does not match`, key);
  }
  positiveGeneration(ack.connectionGeneration, "connectionGeneration");
  positiveGeneration(ack.endpointGeneration, "endpointGeneration");
  if (ack.workspaceGeneration !== undefined) positiveGeneration(ack.workspaceGeneration, "workspaceGeneration");
  if (
    ack.connectionGeneration !== request.placement.connectionGeneration ||
    ack.workspaceGeneration !== request.placement.workspaceGeneration ||
    ack.endpointGeneration !== request.placement.endpointGeneration
  ) {
    throw new FabricContractError("stale_generation", "Fabric start ACK generation tuple does not match", "placement");
  }
  assertFabricIdentifier(ack.acceptedBackend, "acceptedBackend");
  if (ack.acceptedModel !== undefined && (typeof ack.acceptedModel !== "string" || ack.acceptedModel.length === 0)) {
    throw new FabricContractError("protocol_violation", "acceptedModel must be non-empty", "acceptedModel");
  }
  assertFabricIdentifier(ack.receiptRef, "receiptRef");
  record(ack.acceptedCapabilities, "acceptedCapabilities");
}

function assertReceiptIdentity(
  value: unknown,
  attemptId: string,
  placementId: string,
  path: string,
): Record<string, unknown> {
  const receipt = record(value, path);
  if (receipt.version !== FABRIC_AGENT_ATTEMPT_VERSION) {
    throw new FabricContractError("unsupported_version", "Unsupported Fabric Agent receipt version", `${path}.version`);
  }
  if (receipt.attemptId !== attemptId || receipt.placementId !== placementId) {
    throw new FabricContractError("conflict", "Fabric Agent receipt belongs to another attempt", path);
  }
  assertFabricIdentifier(receipt.receiptRef, `${path}.receiptRef`);
  return receipt;
}

export function assertFabricAgentControlReceipt(
  value: unknown,
  attemptId: string,
  placementId: string,
  action: "send" | "abort",
): asserts value is FabricAgentControlReceiptV1 {
  const receipt = assertReceiptIdentity(value, attemptId, placementId, "controlReceipt");
  if (receipt.action !== action || typeof receipt.accepted !== "boolean") {
    throw new FabricContractError("protocol_violation", "Fabric Agent control receipt is invalid", "controlReceipt");
  }
  if (!["queued", "accepted", "refused", "already-terminal", "unknown"].includes(String(receipt.state))) {
    throw new FabricContractError("protocol_violation", "Fabric Agent control receipt state is invalid", "controlReceipt.state");
  }
}

export function assertFabricAgentRecoveryReceipt(
  value: unknown,
  attemptId: string,
  placementId: string,
): asserts value is FabricAgentRecoveryReceiptV1 {
  const receipt = assertReceiptIdentity(value, attemptId, placementId, "recoveryReceipt");
  if (typeof receipt.startAcknowledged !== "boolean" || typeof receipt.terminal !== "boolean") {
    throw new FabricContractError("protocol_violation", "Fabric Agent recovery receipt booleans are invalid", "recoveryReceipt");
  }
  if (!Number.isSafeInteger(receipt.lastSequence) || (receipt.lastSequence as number) < 0) {
    throw new FabricContractError("protocol_violation", "Fabric Agent recovery receipt sequence is invalid", "lastSequence");
  }
  if (receipt.recovery !== undefined) record(receipt.recovery, "recoveryReceipt.recovery");
  if (receipt.result !== undefined) record(receipt.result, "recoveryReceipt.result");
}

export function assertFabricAgentReclamationReceipt(
  value: unknown,
  attemptId: string,
  placementId: string,
): asserts value is FabricAgentReclamationReceiptV1 {
  const receipt = assertReceiptIdentity(value, attemptId, placementId, "reclamationReceipt");
  const reclamation = record(receipt.reclamation, "reclamationReceipt.reclamation");
  if (reclamation.status !== "reclaimed" && reclamation.status !== "unreaped") {
    throw new FabricContractError("protocol_violation", "Fabric Agent reclamation status is invalid", "reclamation.status");
  }
  if (reclamation.status === "unreaped" && (typeof reclamation.reason !== "string" || reclamation.reason.length === 0)) {
    throw new FabricContractError("protocol_violation", "Unreaped Fabric Agent receipt requires a reason", "reclamation.reason");
  }
}

export function assertFabricAgentEvent(event: unknown, placementId: string): asserts event is FabricPlacementEventV1 {
  assertValidFabricPlacementEvent(event);
  if (event.placementId !== placementId) {
    throw new FabricContractError("conflict", "Fabric placement event belongs to another attempt", "placementId");
  }
}

export function assertFabricAgentStartRequest(value: unknown, now = Date.now()): asserts value is FabricAgentStartRequestV1 {
  const requestRecord = record(value, "startRequest");
  assertOnlyKeys(requestRecord, ["version", "attemptId", "placement", "spec"], "startRequest");
  const request = requestRecord as unknown as FabricAgentStartRequestV1;
  if (request.version !== FABRIC_AGENT_ATTEMPT_VERSION) {
    throw new FabricContractError("unsupported_version", "Unsupported Fabric Agent attempt version", "version");
  }
  assertFabricIdentifier(request.attemptId, "attemptId");
  assertValidTeammatePlacement(request.placement, now);
  const specRecord = record(request.spec, "spec");
  assertOnlyKeys(specRecord, ["agent", "task", "name", "context", "model", "thinking", "outputSchema"], "spec");
  const spec = specRecord as unknown as FabricAgentRunSpecV1;
  assertFabricIdentifier(spec.agent, "spec.agent");
  if (typeof spec.task !== "string") throw new FabricContractError("invalid_argument", "spec.task must be text", "spec.task");
  if (spec.name !== undefined) assertFabricIdentifier(spec.name, "spec.name");
  if (spec.context !== undefined && spec.context !== "fresh" && spec.context !== "fork") {
    throw new FabricContractError("invalid_argument", "spec.context is invalid", "spec.context");
  }
  if (spec.model !== undefined && (typeof spec.model !== "string" || spec.model.length === 0)) {
    throw new FabricContractError("invalid_argument", "spec.model must be non-empty", "spec.model");
  }
  if (spec.thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(spec.thinking)) {
    throw new FabricContractError("invalid_argument", "spec.thinking is invalid", "spec.thinking");
  }
  if (spec.outputSchema !== undefined) record(spec.outputSchema, "spec.outputSchema");
}

export function fabricStartRequest(
  attemptId: string,
  placement: TeammatePlacementV1,
  spec: FabricAgentRunSpecV1,
  now = Date.now(),
): FabricAgentStartRequestV1 {
  const request = { version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId, placement, spec } as const;
  assertFabricAgentStartRequest(request, now);
  return request;
}

export function fabricPlacementEvent(
  placementId: string,
  sequence: number,
  kind: FabricPlacementEventV1["kind"],
  occurredAt: number,
  payload: FabricPlacementEventV1["payload"],
): FabricPlacementEventV1 {
  const event: FabricPlacementEventV1 = {
    version: FABRIC_PLACEMENT_VERSION,
    placementId,
    sequence,
    kind,
    occurredAt,
    payload,
  };
  assertEpochMilliseconds(occurredAt, "occurredAt");
  assertValidFabricPlacementEvent(event);
  return event;
}
