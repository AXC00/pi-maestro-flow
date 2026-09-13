import { randomUUID } from "node:crypto";
import {
  FabricChannelRouter,
  RouteBoundFabricStreamChannel,
} from "pi-maestro-fabric";
import {
  FABRIC_ERROR_CODES,
  FABRIC_HUB_RELAY_AGENT_OPERATIONS,
  FABRIC_HUB_RELAY_VERSION,
  FABRIC_PROTOCOL_VERSION,
  FabricContractError,
  assertFabricIdentifier,
  assertValidEndpointRecord,
  assertValidFabricHubRelayAgentInput,
  assertValidFabricHubRelayEnvelope,
  type EndpointRecord,
  type EndpointRouteHandle,
  type FabricEnvelopeV1,
  type FabricHubRelayAuthorityV1,
  type FabricHubRelayCancelV1,
  type FabricHubRelayInvokeV1,
  type FabricHubRelayReceiptV1,
  type FabricHubRelayStreamV1,
  type FabricProtocolLimits,
  type FabricStreamFrameV1,
  type JsonValue,
} from "pi-maestro-fabric-core/v1";
import {
  FABRIC_AGENT_ATTEMPT_VERSION,
  assertFabricAgentControlReceipt,
  assertFabricAgentReclamationReceipt,
  assertFabricAgentStartAck,
  type FabricAgentStartRequestV1,
} from "pi-maestro-backends/fabric";
import type { GatewayPrincipal } from "../contracts.ts";
import {
  FabricEndpointDispatcher,
  type FabricEndpointDispatchContext,
  type FabricEndpointHandler,
  type FabricEndpointRegistration,
} from "./endpoint-dispatcher.ts";

export interface FabricRelaySessionIdentity {
  readonly connectorId: string;
  readonly deviceId: string;
  readonly connectionId: string;
  readonly connectionGeneration: number;
  readonly instanceNonce: string;
  readonly state: string;
  readonly current: boolean;
  readonly relayVersion?: typeof FABRIC_HUB_RELAY_VERSION;
  readonly negotiatedLimits?: Readonly<FabricProtocolLimits>;
}

export interface FabricRelaySocketTransport {
  send(envelope: FabricEnvelopeV1, priority: "operation" | "control"): void;
  readonly bufferedAmount: number;
}

export interface FabricHubRelayWssPort {
  readonly version: typeof FABRIC_HUB_RELAY_VERSION;
  readonly hubRuntimeEpoch: string;
  accepted(session: FabricRelaySessionIdentity, transport: FabricRelaySocketTransport): void;
  ready(session: FabricRelaySessionIdentity, advertisement: Readonly<Record<string, JsonValue>>): void;
  advertisement(session: FabricRelaySessionIdentity, advertisement: Readonly<Record<string, JsonValue>>): void;
  accept(session: FabricRelaySessionIdentity, envelope: FabricEnvelopeV1): void;
  closeRoute(routeId: string, reason: string): Promise<void>;
  retire(session: FabricRelaySessionIdentity, reason: string): void;
}

export interface FabricDeviceRelayExecutionContext {
  readonly operation: (typeof FABRIC_HUB_RELAY_AGENT_OPERATIONS)[number];
  readonly input: Readonly<Record<string, JsonValue>>;
  readonly authority: Readonly<FabricHubRelayAuthorityV1>;
  readonly originSubject: string;
  readonly signal: AbortSignal;
}

/** T4 supplies this callback from the daemon-owned Device Agent bridge. */
export interface FabricDeviceRelayExecutionHandler {
  handle(context: FabricDeviceRelayExecutionContext): Promise<JsonValue>;
  /** Optional generation-owned cleanup used by the outbound Connector service. */
  close?(reason?: string): void | Promise<void>;
}

export interface FabricHubRelayLimits {
  readonly maxActiveOperations: number;
  readonly maxBufferedFrames: number;
  readonly maxFrameBytes: number;
  readonly maxResultBytes: number;
  readonly maxSocketBufferedBytes: number;
}

const DEFAULT_LIMITS: FabricHubRelayLimits = Object.freeze({
  maxActiveOperations: 32,
  maxBufferedFrames: 8,
  maxFrameBytes: 256 * 1024,
  maxResultBytes: 1024 * 1024,
  maxSocketBufferedBytes: 2 * 1024 * 1024,
});

function positive(value: number | undefined, fallback: number, path: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new FabricContractError("invalid_argument", `${path} must be a positive safe integer`, path);
  return result;
}

function limitsOf(
  input: Partial<FabricHubRelayLimits> | undefined,
  negotiated?: Pick<FabricProtocolLimits, "maxInFlightOperations" | "maxFrameBytes" | "maxResultBytes">,
): Readonly<FabricHubRelayLimits> {
  const local = {
    maxActiveOperations: positive(input?.maxActiveOperations, DEFAULT_LIMITS.maxActiveOperations, "maxActiveOperations"),
    maxBufferedFrames: positive(input?.maxBufferedFrames, DEFAULT_LIMITS.maxBufferedFrames, "maxBufferedFrames"),
    maxFrameBytes: positive(input?.maxFrameBytes, DEFAULT_LIMITS.maxFrameBytes, "maxFrameBytes"),
    maxResultBytes: positive(input?.maxResultBytes, DEFAULT_LIMITS.maxResultBytes, "maxResultBytes"),
    maxSocketBufferedBytes: positive(input?.maxSocketBufferedBytes, DEFAULT_LIMITS.maxSocketBufferedBytes, "maxSocketBufferedBytes"),
  };
  if (negotiated === undefined) return Object.freeze(local);
  return Object.freeze({
    maxActiveOperations: Math.min(local.maxActiveOperations, negotiated.maxInFlightOperations),
    maxBufferedFrames: Math.min(local.maxBufferedFrames, negotiated.maxInFlightOperations),
    maxFrameBytes: Math.min(local.maxFrameBytes, negotiated.maxFrameBytes),
    maxResultBytes: Math.min(local.maxResultBytes, negotiated.maxResultBytes),
    maxSocketBufferedBytes: Math.min(
      local.maxSocketBufferedBytes,
      negotiated.maxFrameBytes * negotiated.maxInFlightOperations,
    ),
  });
}

function errorOf(error: unknown, fallback: string): FabricContractError {
  return error instanceof FabricContractError ? error : new FabricContractError("unavailable", fallback);
}

function errorPayload(error: FabricContractError): Readonly<Record<string, JsonValue>> {
  return { code: error.code, message: error.message.slice(0, 512) };
}

function agentOperation(value: string): (typeof FABRIC_HUB_RELAY_AGENT_OPERATIONS)[number] {
  for (const operation of FABRIC_HUB_RELAY_AGENT_OPERATIONS) if (operation === value) return operation;
  throw new FabricContractError("invalid_argument", "Hub relay accepts only Agent operations", "operation");
}

function relayErrorCode(value: JsonValue | undefined): FabricContractError["code"] {
  for (const code of FABRIC_ERROR_CODES) if (code === value) return code;
  return "protocol_violation";
}

function relayPayloadRecord(value: object): Readonly<Record<string, JsonValue>> {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new FabricContractError("protocol_violation", "Relay payload is not a JSON object");
  }
  return parsed as Readonly<Record<string, JsonValue>>;
}

function authorityMatches(left: FabricHubRelayAuthorityV1, right: FabricHubRelayAuthorityV1): boolean {
  return left.version === right.version && left.hubRuntimeEpoch === right.hubRuntimeEpoch &&
    left.connectorId === right.connectorId && left.deviceId === right.deviceId &&
    left.connectionId === right.connectionId && left.connectionGeneration === right.connectionGeneration &&
    left.routeId === right.routeId && left.routeRevision === right.routeRevision &&
    left.workspaceBindingId === right.workspaceBindingId && left.workspaceGeneration === right.workspaceGeneration &&
    left.endpointId === right.endpointId && left.endpointGeneration === right.endpointGeneration &&
    left.requestId === right.requestId && left.correlationId === right.correlationId &&
    left.operationId === right.operationId && left.streamId === right.streamId &&
    left.deadlineAt === right.deadlineAt;
}

function tombstone(
  tombstones: Map<string, RelayTombstone>,
  authority: FabricHubRelayAuthorityV1,
  receipts?: { readonly openMessageId?: string; readonly cancelMessageId?: string },
  now = Date.now(),
): void {
  for (const [operationId, entry] of tombstones) {
    if (entry.expiresAt <= now) tombstones.delete(operationId);
  }
  tombstones.delete(authority.operationId);
  tombstones.set(authority.operationId, {
    authority: { ...authority },
    expiresAt: now + TERMINAL_TOMBSTONE_TTL_MS,
    ...(receipts?.openMessageId === undefined ? {} : { openMessageId: receipts.openMessageId }),
    ...(receipts?.cancelMessageId === undefined ? {} : { cancelMessageId: receipts.cancelMessageId }),
  });
  while (tombstones.size > MAX_TERMINAL_TOMBSTONES) {
    const oldest = tombstones.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    tombstones.delete(oldest);
  }
}

function matchingTombstone(
  tombstones: Map<string, RelayTombstone>,
  authority: FabricHubRelayAuthorityV1,
  now = Date.now(),
): boolean {
  const entry = tombstones.get(authority.operationId);
  if (entry === undefined) return false;
  if (entry.expiresAt <= now) {
    tombstones.delete(authority.operationId);
    return false;
  }
  return authorityMatches(entry.authority, authority);
}

function envelope(payload: FabricHubRelayInvokeV1 | FabricHubRelayCancelV1 | FabricHubRelayStreamV1 | FabricHubRelayReceiptV1, kind: "invoke" | "cancel" | "stream" | "receipt", messageId = randomUUID()): FabricEnvelopeV1 {
  return {
    version: FABRIC_PROTOCOL_VERSION,
    messageId,
    kind,
    sentAt: Date.now(),
    connectionId: payload.connectionId,
    connectionGeneration: payload.connectionGeneration,
    correlationId: payload.correlationId,
    operationId: payload.operationId,
    deadlineAt: payload.deadlineAt,
    payload: relayPayloadRecord(payload),
  };
}

function authorityWithSequence(authority: FabricHubRelayAuthorityV1, sequence: number): FabricHubRelayAuthorityV1 {
  return {
    version: authority.version,
    hubRuntimeEpoch: authority.hubRuntimeEpoch,
    connectorId: authority.connectorId,
    deviceId: authority.deviceId,
    connectionId: authority.connectionId,
    connectionGeneration: authority.connectionGeneration,
    routeId: authority.routeId,
    routeRevision: authority.routeRevision,
    workspaceBindingId: authority.workspaceBindingId,
    workspaceGeneration: authority.workspaceGeneration,
    endpointId: authority.endpointId,
    endpointGeneration: authority.endpointGeneration,
    requestId: authority.requestId,
    correlationId: authority.correlationId,
    operationId: authority.operationId,
    streamId: authority.streamId,
    sequence,
    deadlineAt: authority.deadlineAt,
  };
}

function endpointList(value: JsonValue | undefined, path: string): EndpointRecord[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 1_024) {
    throw new FabricContractError("invalid_argument", `${path} must be a bounded array`, path);
  }
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    assertValidEndpointRecord(candidate);
    if (seen.has(candidate.endpointId)) throw new FabricContractError("conflict", `${path} contains a duplicate Endpoint`, `${path}[${index}]`);
    seen.add(candidate.endpointId);
    return structuredClone(candidate);
  });
}

function advertisementEndpointChanges(payload: Readonly<Record<string, JsonValue>>): {
  readonly snapshot?: EndpointRecord[];
  readonly upserts: EndpointRecord[];
  readonly removals: string[];
} {
  const snapshot = endpointList(payload.endpoints, "endpoints");
  let upserts: EndpointRecord[] = [];
  if (payload.upserts !== undefined) {
    if (typeof payload.upserts !== "object" || payload.upserts === null || Array.isArray(payload.upserts)) {
      throw new FabricContractError("invalid_argument", "upserts must be an object", "upserts");
    }
    const upsertRecord = payload.upserts as Readonly<Record<string, JsonValue>>;
    upserts = endpointList(upsertRecord.endpoints, "upserts.endpoints") ?? [];
  }
  let removals: string[] = [];
  if (payload.removals !== undefined) {
    if (typeof payload.removals !== "object" || payload.removals === null || Array.isArray(payload.removals)) {
      throw new FabricContractError("invalid_argument", "removals must be an object", "removals");
    }
    const removalRecord = payload.removals as Readonly<Record<string, JsonValue>>;
    const values = removalRecord.endpointIds;
    if (values !== undefined) {
      if (!Array.isArray(values) || values.length > 1_024) throw new FabricContractError("invalid_argument", "removals.endpointIds must be a bounded array", "removals.endpointIds");
      removals = values.map((value, index) => {
        assertFabricIdentifier(value, `removals.endpointIds[${index}]`);
        return value;
      });
    }
  }
  return { ...(snapshot === undefined ? {} : { snapshot }), upserts, removals };
}

interface HubOperation {
  readonly authority: FabricHubRelayAuthorityV1;
  readonly channel: RouteBoundFabricStreamChannel;
  readonly controller: AbortController;
  deadlineTimer?: NodeJS.Timeout;
  openMessageId?: string;
  openDelivered: boolean;
  cancelMessageId?: string;
  cancelReason?: string;
  cancelSent: boolean;
  failure?: FabricContractError;
}

interface RelayTombstone {
  readonly authority: FabricHubRelayAuthorityV1;
  readonly expiresAt: number;
  readonly openMessageId?: string;
  readonly cancelMessageId?: string;
}

interface HubAgentAttempt {
  readonly attemptId: string;
  readonly placementId: string;
  readonly deadlineAt: number;
  readonly route: EndpointRouteHandle;
  readonly endpoint: EndpointRecord;
  readonly principal: GatewayPrincipal;
  cleanup?: Promise<void>;
}

const MAX_TERMINAL_TOMBSTONES = 256;
const TERMINAL_TOMBSTONE_TTL_MS = 30_000;

interface HubEndpointOwner {
  readonly endpointId: string;
  readonly endpointGeneration: number;
  readonly registration: FabricEndpointRegistration;
  readonly dispose: () => boolean;
}

interface HubSessionOwner {
  readonly ownerId: string;
  readonly identity: FabricRelaySessionIdentity;
  readonly transport: FabricRelaySocketTransport;
  readonly channels: FabricChannelRouter;
  readonly endpoints: Map<string, HubEndpointOwner>;
  readonly operations: Map<string, HubOperation>;
  readonly attempts: Map<string, HubAgentAttempt>;
  readonly tombstones: Map<string, RelayTombstone>;
  readonly limits: Readonly<FabricHubRelayLimits>;
  active: boolean;
  ready: boolean;
}

export interface FabricHubRelayOptions {
  readonly dispatcher: FabricEndpointDispatcher;
  readonly hubRuntimeEpoch: string;
  /** Derives an opaque subject from the authenticated local HTTPS principal. */
  readonly originSubjectOf: (principal: GatewayPrincipal) => string;
  readonly limits?: Partial<FabricHubRelayLimits>;
}

/** Hub-side owner for remote Agent Endpoint registrations and WSS operations. */
export class FabricHubRelay implements FabricHubRelayWssPort {
  readonly version = FABRIC_HUB_RELAY_VERSION;
  readonly hubRuntimeEpoch: string;
  readonly limits: Readonly<FabricHubRelayLimits>;
  readonly #dispatcher: FabricEndpointDispatcher;
  readonly #originSubjectOf: (principal: GatewayPrincipal) => string;
  readonly #sessions = new Map<string, HubSessionOwner>();

  constructor(options: FabricHubRelayOptions) {
    assertFabricIdentifier(options.hubRuntimeEpoch, "hubRuntimeEpoch");
    this.hubRuntimeEpoch = options.hubRuntimeEpoch;
    this.#dispatcher = options.dispatcher;
    this.#originSubjectOf = options.originSubjectOf;
    this.limits = limitsOf(options.limits);
  }

  accepted(session: FabricRelaySessionIdentity, transport: FabricRelaySocketTransport): void {
    if (session.relayVersion !== this.version || !session.current || session.connectionId === "") return;
    for (const existing of [...this.#sessions.values()]) {
      if (existing.identity.connectorId === session.connectorId || existing.identity.connectionId === session.connectionId) {
        this.#retireOwner(existing, "connection owner replaced");
      }
    }
    let owner!: HubSessionOwner;
    const admissions = {
      validateRoute: (routeId: string) => {
        if (!owner.active || this.#sessions.get(session.connectionId) !== owner) throw new FabricContractError("stale_generation", "Hub relay session is retired", "connectionGeneration");
        const route = this.#dispatcher.routes.validateRoute(routeId);
        if (route.connectionId !== session.connectionId || route.connectionGeneration !== session.connectionGeneration) {
          throw new FabricContractError("stale_generation", "Route does not belong to this relay connection", "connectionGeneration");
        }
        return route;
      },
    };
    owner = {
      ownerId: randomUUID(), identity: { ...session }, transport,
      channels: new FabricChannelRouter(admissions), endpoints: new Map(), operations: new Map(), attempts: new Map(), tombstones: new Map(),
      limits: limitsOf(this.limits, session.negotiatedLimits), active: true, ready: false,
    };
    this.#sessions.set(session.connectionId, owner);
  }

  ready(session: FabricRelaySessionIdentity, advertisement: Readonly<Record<string, JsonValue>>): void {
    const owner = this.#requireOwner(session, false);
    owner.ready = true;
    this.#installAdvertisement(owner, advertisement);
  }

  advertisement(session: FabricRelaySessionIdentity, advertisement: Readonly<Record<string, JsonValue>>): void {
    const owner = this.#requireOwner(session, true);
    this.#installAdvertisement(owner, advertisement);
  }

  accept(session: FabricRelaySessionIdentity, input: FabricEnvelopeV1): void {
    assertValidFabricHubRelayEnvelope(input);
    if (input.kind !== "stream" && input.kind !== "receipt") {
      throw new FabricContractError("protocol_violation", "Device sent a wrong-direction Hub relay message", "kind");
    }
    const owner = this.#requireOwner(session, true);
    const payload = input.payload;
    if (payload.direction !== "device-to-hub" || payload.hubRuntimeEpoch !== this.hubRuntimeEpoch ||
      payload.connectorId !== owner.identity.connectorId || payload.deviceId !== owner.identity.deviceId ||
      payload.connectionId !== owner.identity.connectionId || payload.connectionGeneration !== owner.identity.connectionGeneration) {
      throw new FabricContractError("stale_generation", "Relay message does not belong to this accepted session", "connectionGeneration");
    }
    if (matchingTombstone(owner.tombstones, payload)) {
      if (input.kind === "receipt") {
        const receiptPayload = payload as FabricHubRelayReceiptV1;
        const terminal = owner.tombstones.get(payload.operationId)!;
        const expectedMessageId = receiptPayload.receiptKind === "cancel_delivered"
          ? terminal.cancelMessageId
          : terminal.openMessageId;
        if (expectedMessageId === undefined || receiptPayload.acceptedMessageId !== expectedMessageId) {
          throw new FabricContractError("conflict", "Terminal relay receipt acknowledges a foreign message", "acceptedMessageId");
        }
      }
      return;
    }
    // Resolve the generation-owned operation before asking the route authority
    // anything. A route may legitimately expire while a terminal is in flight.
    const operation = owner.operations.get(payload.operationId);
    if (operation === undefined || !authorityMatches(operation.authority, payload)) {
      throw new FabricContractError("conflict", "Relay response correlation is foreign to this session", "operationId");
    }
    if (input.kind === "stream") {
      const streamPayload = payload as FabricHubRelayStreamV1;
      try {
        operation.channel.accept(streamPayload.frame);
        if (streamPayload.frame.kind === "end" || streamPayload.frame.kind === "error") {
          tombstone(owner.tombstones, operation.authority, operation);
        }
      } catch (error) {
        const normalized = errorOf(error, "Relay response failed validation");
        // Correlation and session identity were already proven above. Only a
        // malformed stream protocol is session-fatal from this point onward;
        // route expiry, authority loss, buffering, and local availability are
        // terminals for this operation alone.
        if (normalized.code === "protocol_violation" || normalized.code === "unauthenticated") throw normalized;
        operation.failure = normalized;
        tombstone(owner.tombstones, operation.authority, operation);
        operation.controller.abort(normalized);
        void operation.channel.close(`Relay operation failed: ${normalized.code}`).catch(() => undefined);
      }
      return;
    }
    const receiptPayload = payload as FabricHubRelayReceiptV1;
    const expectedMessageId = receiptPayload.receiptKind === "cancel_delivered"
      ? operation.cancelMessageId
      : operation.openMessageId;
    if (expectedMessageId === undefined || receiptPayload.acceptedMessageId !== expectedMessageId) {
      throw new FabricContractError("conflict", "Relay receipt acknowledges a foreign message", "acceptedMessageId");
    }
    if (!receiptPayload.accepted) {
      operation.failure = new FabricContractError(receiptPayload.code ?? "unavailable", receiptPayload.message ?? "Device refused the relay frame");
      tombstone(owner.tombstones, operation.authority, operation);
      operation.controller.abort(operation.failure);
      void operation.channel.close("Device refused the relay frame").catch(() => undefined);
    }
  }

  async closeRoute(routeId: string, reason: string): Promise<void> {
    assertFabricIdentifier(routeId, "routeId");
    const attempts = [...this.#sessions.values()].flatMap((owner) =>
      [...owner.attempts.values()]
        .filter((attempt) => attempt.route.routeId === routeId)
        .map((attempt) => ({ owner, attempt })),
    );
    const results = await Promise.allSettled(attempts.map(({ owner, attempt }) =>
      this.#abortRouteAttempt(owner, attempt, reason),
    ));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Fabric route cleanup failed to abort remote Agent attempts");
  }

  retire(session: FabricRelaySessionIdentity, reason: string): void {
    const owner = this.#sessions.get(session.connectionId);
    if (owner === undefined || !session.current || session.relayVersion !== this.version ||
      owner.identity.connectorId !== session.connectorId || owner.identity.deviceId !== session.deviceId ||
      owner.identity.connectionGeneration !== session.connectionGeneration ||
      owner.identity.instanceNonce !== session.instanceNonce) return;
    this.#retireOwner(owner, reason);
  }

  #installAdvertisement(owner: HubSessionOwner, payload: Readonly<Record<string, JsonValue>>): void {
    const changes = advertisementEndpointChanges(payload);
    const desired = changes.snapshot === undefined
      ? new Map(changes.upserts.filter((endpoint) => endpoint.kind === "agent").map((endpoint) => [endpoint.endpointId, endpoint]))
      : new Map(changes.snapshot.filter((endpoint) => endpoint.kind === "agent").map((endpoint) => [endpoint.endpointId, endpoint]));
    const removed = new Set(changes.removals);
    const upserted = new Set(changes.upserts.map((endpoint) => endpoint.endpointId));
    for (const [endpointId, current] of owner.endpoints) {
      const next = desired.get(endpointId);
      const remove = removed.has(endpointId) || (changes.snapshot !== undefined && next === undefined) ||
        (changes.snapshot === undefined && upserted.has(endpointId) && next === undefined) ||
        (next !== undefined && next.generation !== current.endpointGeneration);
      if (remove) {
        current.dispose();
        owner.endpoints.delete(endpointId);
        this.#retireEndpointOperations(owner, endpointId, "Remote Agent Endpoint advertisement changed");
      }
    }
    for (const endpoint of desired.values()) {
      if (endpoint.connectorId !== owner.identity.connectorId || endpoint.deviceId !== owner.identity.deviceId || endpoint.status !== "online") {
        throw new FabricContractError("permission_denied", "Advertised executable Endpoint is foreign to this relay session", "endpointId");
      }
      if (owner.endpoints.has(endpoint.endpointId)) continue;
      const handler: FabricEndpointHandler = { handle: (context) => this.#invoke(owner, context) };
      const registration: FabricEndpointRegistration = {
        endpointId: endpoint.endpointId,
        kind: "agent",
        handler,
        ownerId: owner.ownerId,
        connectionId: owner.identity.connectionId,
        connectionGeneration: owner.identity.connectionGeneration,
        endpointGeneration: endpoint.generation,
      };
      const dispose = this.#dispatcher.register(registration);
      owner.endpoints.set(endpoint.endpointId, { endpointId: endpoint.endpointId, endpointGeneration: endpoint.generation, registration, dispose });
    }
  }

  async #invoke(
    owner: HubSessionOwner,
    context: FabricEndpointDispatchContext,
    cleanupRoute?: EndpointRouteHandle,
  ): Promise<JsonValue> {
    if (!owner.active || !owner.ready || this.#sessions.get(owner.identity.connectionId) !== owner) {
      throw new FabricContractError("unavailable", "Remote Agent Endpoint connection is not ready");
    }
    const operationName = agentOperation(context.request.operation);
    if (context.route.workspaceBindingId === undefined || context.route.workspaceGeneration === undefined) {
      throw new FabricContractError("permission_denied", "Remote Agent relay requires workspace binding authority", "workspaceBindingId");
    }
    if (owner.operations.size >= owner.limits.maxActiveOperations) {
      throw new FabricContractError("resource_exhausted", "Hub relay active operation capacity is full", "maxActiveOperations");
    }
    if (owner.transport.bufferedAmount > owner.limits.maxSocketBufferedBytes) {
      throw new FabricContractError("resource_exhausted", "Hub relay socket backpressure limit is exceeded", "bufferedAmount");
    }
    // Validate and clone the operation-specific wire projection before a
    // channel is bound or the transport is touched. Invalid local authority
    // data fails this dispatch only and never reaches the Connector.
    assertValidFabricHubRelayAgentInput(context.request.input, operationName, context.request.deadlineAt);
    const relayInput = structuredClone(context.request.input);
    const operationId = context.request.requestId;
    const originSubject = this.#originSubjectOf(context.principal);
    assertFabricIdentifier(originSubject, "originSubject");
    const base: FabricHubRelayAuthorityV1 = {
      version: this.version,
      hubRuntimeEpoch: this.hubRuntimeEpoch,
      connectorId: owner.identity.connectorId,
      deviceId: owner.identity.deviceId,
      connectionId: owner.identity.connectionId,
      connectionGeneration: owner.identity.connectionGeneration,
      routeId: context.route.routeId,
      routeRevision: context.route.revision,
      workspaceBindingId: context.route.workspaceBindingId,
      workspaceGeneration: context.route.workspaceGeneration,
      endpointId: context.endpoint.endpointId,
      endpointGeneration: context.endpoint.generation,
      requestId: context.request.requestId,
      correlationId: context.request.requestId,
      operationId,
      streamId: randomUUID(),
      sequence: 0,
      deadlineAt: context.request.deadlineAt,
    };
    const controller = new AbortController();
    let operation!: HubOperation;
    const exactRoute = {
      validateRoute: (routeId: string) => {
        let current: EndpointRouteHandle;
        if (cleanupRoute === undefined) {
          current = owner.channels.admissions.validateRoute(routeId);
        } else {
          if (routeId !== cleanupRoute.routeId || cleanupRoute.state !== "open" || !owner.active ||
            this.#sessions.get(owner.identity.connectionId) !== owner) {
            throw new FabricContractError("stale_generation", "Relay cleanup route owner is no longer current", "routeId");
          }
          const endpointOwner = owner.endpoints.get(cleanupRoute.endpointId);
          if (endpointOwner === undefined || endpointOwner.endpointGeneration !== cleanupRoute.endpointGeneration ||
            endpointOwner.registration.connectionId !== cleanupRoute.connectionId ||
            endpointOwner.registration.connectionGeneration !== cleanupRoute.connectionGeneration) {
            throw new FabricContractError("stale_generation", "Relay cleanup Endpoint owner is no longer current", "endpointGeneration");
          }
          current = cleanupRoute;
        }
        if (current.revision !== base.routeRevision || current.connectionId !== base.connectionId ||
          current.connectionGeneration !== base.connectionGeneration || current.workspaceBindingId !== base.workspaceBindingId ||
          current.workspaceGeneration !== base.workspaceGeneration || current.endpointId !== base.endpointId ||
          current.endpointGeneration !== base.endpointGeneration) {
          throw new FabricContractError("stale_generation", "Relay route authority changed during the operation", "routeRevision");
        }
        return current;
      },
    };
    const channel = new RouteBoundFabricStreamChannel(exactRoute, {
      streamId: base.streamId,
      routeId: base.routeId,
      operationId: base.operationId,
      deadlineAt: base.deadlineAt,
      limits: {
        maxFrameBytes: owner.limits.maxFrameBytes,
        maxBufferedFrames: owner.limits.maxBufferedFrames,
        maxResultBytes: owner.limits.maxResultBytes,
      },
      io: {
        send: async (frame) => {
          if (!owner.active || this.#sessions.get(owner.identity.connectionId) !== owner) throw new FabricContractError("unavailable", "Hub relay connection was lost");
          if (owner.transport.bufferedAmount > owner.limits.maxSocketBufferedBytes) throw new FabricContractError("resource_exhausted", "Hub relay socket backpressure limit is exceeded", "bufferedAmount");
          if (frame.kind === "open") {
            const payload: FabricHubRelayInvokeV1 = {
              ...base, direction: "hub-to-device", sequence: frame.sequence,
              operation: operationName, originSubject, input: relayInput, frame,
            };
            const outgoing = envelope(payload, "invoke");
            assertValidFabricHubRelayEnvelope(outgoing);
            operation.openMessageId = outgoing.messageId;
            owner.transport.send(outgoing, "operation");
            operation.openDelivered = true;
            if (operation.cancelReason !== undefined) this.#sendHubCancel(owner, operation, operation.cancelReason);
          } else if (frame.kind === "cancel") {
            throw new FabricContractError("invalid_state", "Relay cancellation uses the reserved control path", "frame.kind");
          } else {
            throw new FabricContractError("protocol_violation", "Hub relay outbound channel accepts only open or cancel", "frame.kind");
          }
        },
        close: async () => undefined,
      },
    });
    operation = { authority: base, channel, controller, openDelivered: false, cancelSent: false };
    this.#channelsBind(owner, operation, cleanupRoute !== undefined);
    const failAtDeadline = (): void => {
      if (owner.operations.get(operationId) !== operation) return;
      const failure = new FabricContractError("deadline_exceeded", "Hub relay operation deadline has passed", "deadlineAt");
      operation.failure ??= failure;
      this.#sendHubCancel(owner, operation, "deadline_exceeded");
      tombstone(owner.tombstones, operation.authority, operation);
      operation.controller.abort(operation.failure);
    };
    operation.deadlineTimer = setTimeout(failAtDeadline, Math.max(0, base.deadlineAt - Date.now()));
    operation.deadlineTimer.unref?.();
    const onAbort = (): void => {
      if (owner.operations.get(operationId) !== operation) return;
      const failure = context.signal.reason instanceof FabricContractError
        ? context.signal.reason
        : new FabricContractError("cancelled", "Fabric relay caller cancelled the operation");
      operation.failure ??= failure;
      this.#sendHubCancel(owner, operation, failure.code === "deadline_exceeded" ? "deadline_exceeded" : "caller_cancelled");
      tombstone(owner.tombstones, operation.authority, operation);
      controller.abort(operation.failure);
    };
    context.signal.addEventListener("abort", onAbort, { once: true });
    if (context.signal.aborted) onAbort();
    try {
      const open: FabricStreamFrameV1 = {
        version: "fabric.stream.v1", streamId: base.streamId, routeId: base.routeId, operationId: base.operationId,
        sequence: 0, kind: "open", sentAt: Date.now(), payload: { operation: operationName, input: relayInput },
      };
      try {
        await channel.send(open, controller.signal);
      } catch (error) {
        if (operation.failure !== undefined) throw operation.failure;
        throw error;
      }
      while (true) {
        let frame: FabricStreamFrameV1 | undefined;
        try {
          frame = await channel.receive(controller.signal);
        } catch (error) {
          if (operation.failure !== undefined) throw operation.failure;
          throw error;
        }
        if (frame === undefined) {
          if (operation.failure !== undefined) throw operation.failure;
          throw new FabricContractError("unavailable", "Hub relay disconnected before a terminal Agent result; outcome is uncertain");
        }
        if (frame.kind === "ack" || frame.kind === "data") continue;
        if (frame.kind === "error") {
          const code = relayErrorCode(frame.payload.code);
          throw new FabricContractError(code, typeof frame.payload.message === "string" ? frame.payload.message : "Remote Agent operation failed");
        }
        if (frame.kind !== "end" || !("result" in frame.payload)) {
          throw new FabricContractError("protocol_violation", "Remote Agent relay returned an invalid terminal frame", "frame.kind");
        }
        const result = structuredClone(frame.payload.result);
        this.#updateAgentAttempt(owner, context, operationName, relayInput, result);
        return result;
      }
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      if (operation.deadlineTimer !== undefined) clearTimeout(operation.deadlineTimer);
      tombstone(owner.tombstones, operation.authority, operation);
      if (owner.operations.get(operationId) === operation) owner.operations.delete(operationId);
      owner.channels.unbind(base.routeId, operationId);
      await channel.close("Hub relay operation completed").catch(() => undefined);
    }
  }

  async #abortRouteAttempt(owner: HubSessionOwner, attempt: HubAgentAttempt, reason: string): Promise<void> {
    if (owner.attempts.get(attempt.placementId) !== attempt) return;
    // Retain the exact attempt authority until #updateAgentAttempt validates a
    // terminal abort result. Concurrent closers share this synchronous claim;
    // any failed delivery clears only the claim so a later close can retry.
    if (attempt.cleanup !== undefined) return attempt.cleanup;
    const cleanup = this.#runRouteAttemptAbort(owner, attempt, reason);
    attempt.cleanup = cleanup;
    try {
      await cleanup;
    } finally {
      if (owner.attempts.get(attempt.placementId) === attempt && attempt.cleanup === cleanup) {
        delete attempt.cleanup;
      }
    }
  }

  async #runRouteAttemptAbort(owner: HubSessionOwner, attempt: HubAgentAttempt, reason: string): Promise<void> {
    const remaining = attempt.deadlineAt - Date.now();
    if (remaining <= 0) {
      throw new FabricContractError("deadline_exceeded", "Remote Agent attempt deadline passed before route cleanup", "deadlineAt");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new FabricContractError(
      "unavailable",
      `${reason}; remote Agent route cleanup timed out`,
      "routeId",
    )), Math.min(5_000, remaining));
    timer.unref?.();
    try {
      await this.#invoke(owner, {
        request: {
          version: "fabric.endpoint-request.v1",
          requestId: randomUUID(),
          routeId: attempt.route.routeId,
          endpointId: attempt.endpoint.endpointId,
          endpointKind: "agent",
          endpointGeneration: attempt.endpoint.generation,
          deadlineAt: attempt.deadlineAt,
          operation: "agent.abort",
          input: {
            version: FABRIC_AGENT_ATTEMPT_VERSION,
            attemptId: attempt.attemptId,
            placementId: attempt.placementId,
          },
        },
        route: attempt.route,
        endpoint: attempt.endpoint,
        principal: attempt.principal,
        signal: controller.signal,
      }, attempt.route);
    } finally {
      clearTimeout(timer);
    }
  }

  #updateAgentAttempt(
    owner: HubSessionOwner,
    context: FabricEndpointDispatchContext,
    operation: (typeof FABRIC_HUB_RELAY_AGENT_OPERATIONS)[number],
    input: Readonly<Record<string, JsonValue>>,
    result: JsonValue,
  ): void {
    if (operation === "agent.start") {
      const request = input as unknown as FabricAgentStartRequestV1;
      assertFabricAgentStartAck(result, request);
      const retained: HubAgentAttempt = {
        attemptId: request.attemptId,
        placementId: request.placement.placementId,
        deadlineAt: request.placement.deadlineAt,
        route: structuredClone(context.route),
        endpoint: structuredClone(context.endpoint),
        principal: structuredClone(context.principal),
      };
      const existing = owner.attempts.get(retained.placementId);
      if (existing !== undefined && (existing.attemptId !== retained.attemptId ||
        existing.route.routeId !== retained.route.routeId || existing.route.revision !== retained.route.revision ||
        existing.route.connectionId !== retained.route.connectionId ||
        existing.route.connectionGeneration !== retained.route.connectionGeneration ||
        existing.endpoint.endpointId !== retained.endpoint.endpointId ||
        existing.endpoint.generation !== retained.endpoint.generation)) {
        throw new FabricContractError("conflict", "Agent start ACK conflicts with retained attempt authority", "placementId");
      }
      owner.attempts.set(retained.placementId, retained);
      return;
    }
    if (typeof input.attemptId !== "string" || typeof input.placementId !== "string") return;
    if (operation === "agent.abort") {
      assertFabricAgentControlReceipt(result, input.attemptId, input.placementId, "abort");
      const retained = owner.attempts.get(input.placementId);
      if (retained?.attemptId === input.attemptId) owner.attempts.delete(input.placementId);
      return;
    }
    if (operation === "agent.reclaim") {
      assertFabricAgentReclamationReceipt(result, input.attemptId, input.placementId);
      if (result.reclamation.status === "reclaimed") {
        const retained = owner.attempts.get(input.placementId);
        if (retained?.attemptId === input.attemptId) owner.attempts.delete(input.placementId);
      }
    }
  }

  #sendHubCancel(owner: HubSessionOwner, operation: HubOperation, reason: string): void {
    if (operation.cancelSent || !owner.active || owner.operations.get(operation.authority.operationId) !== operation) return;
    operation.cancelReason ??= reason;
    if (!operation.openDelivered) return;
    operation.cancelSent = true;
    const cancelFrame: FabricStreamFrameV1 = {
      version: "fabric.stream.v1",
      streamId: operation.authority.streamId,
      routeId: operation.authority.routeId,
      operationId: operation.authority.operationId,
      sequence: 1,
      kind: "cancel",
      sentAt: Date.now(),
      payload: { reason: operation.cancelReason.slice(0, 512) },
    };
    const payload: FabricHubRelayCancelV1 = {
      ...authorityWithSequence(operation.authority, cancelFrame.sequence),
      direction: "hub-to-device",
      reason: operation.cancelReason.slice(0, 512),
      frame: cancelFrame,
    };
    const outgoing = envelope(payload, "cancel");
    try {
      assertValidFabricHubRelayEnvelope(outgoing);
      operation.cancelMessageId = outgoing.messageId;
      owner.transport.send(outgoing, "control");
    } catch (error) {
      operation.failure ??= errorOf(error, "Hub relay cancellation could not be delivered");
    }
  }

  #channelsBind(owner: HubSessionOwner, operation: HubOperation, cleanup: boolean): void {
    // A cleanup invoke is correlated through operations but deliberately never
    // re-enters the admission-backed router after the durable Route is closed.
    if (!cleanup) owner.channels.bind(operation.authority.routeId, operation.authority.operationId, operation.channel);
    owner.operations.set(operation.authority.operationId, operation);
  }

  #requireOwner(session: FabricRelaySessionIdentity, requireReady: boolean): HubSessionOwner {
    const owner = this.#sessions.get(session.connectionId);
    if (owner === undefined || !owner.active || owner.identity.connectorId !== session.connectorId ||
      owner.identity.deviceId !== session.deviceId || owner.identity.connectionGeneration !== session.connectionGeneration ||
      owner.identity.instanceNonce !== session.instanceNonce || session.relayVersion !== this.version ||
      !session.current || (requireReady && !owner.ready)) {
      throw new FabricContractError("stale_generation", "Hub relay session owner is not current", "connectionGeneration");
    }
    return owner;
  }

  #retireEndpointOperations(owner: HubSessionOwner, endpointId: string, reason: string): void {
    for (const [placementId, attempt] of owner.attempts) {
      if (attempt.endpoint.endpointId === endpointId) owner.attempts.delete(placementId);
    }
    for (const operation of [...owner.operations.values()]) {
      if (operation.authority.endpointId !== endpointId) continue;
      operation.failure = new FabricContractError("stale_generation", reason, "endpointGeneration");
      this.#sendHubCancel(owner, operation, "endpoint_generation_changed");
      if (operation.deadlineTimer !== undefined) clearTimeout(operation.deadlineTimer);
      tombstone(owner.tombstones, operation.authority, operation);
      operation.controller.abort(operation.failure);
      if (owner.operations.get(operation.authority.operationId) === operation) owner.operations.delete(operation.authority.operationId);
      owner.channels.unbind(operation.authority.routeId, operation.authority.operationId);
      void operation.channel.close(reason).catch(() => undefined);
    }
  }

  #retireOwner(owner: HubSessionOwner, reason: string): void {
    if (!owner.active) return;
    owner.active = false;
    owner.ready = false;
    if (this.#sessions.get(owner.identity.connectionId) === owner) this.#sessions.delete(owner.identity.connectionId);
    for (const endpoint of owner.endpoints.values()) endpoint.dispose();
    owner.endpoints.clear();
    const operations = [...owner.operations.values()];
    owner.operations.clear();
    owner.attempts.clear();
    for (const operation of operations) {
      operation.failure = new FabricContractError("unavailable", `${reason}; Agent outcome is uncertain`);
      if (operation.deadlineTimer !== undefined) clearTimeout(operation.deadlineTimer);
      tombstone(owner.tombstones, operation.authority, operation);
      operation.controller.abort(operation.failure);
      owner.channels.unbind(operation.authority.routeId, operation.authority.operationId);
      void operation.channel.close(reason).catch(() => undefined);
    }
  }

  get activeSessionCount(): number { return this.#sessions.size; }
}

interface DeviceOperation {
  readonly authority: FabricHubRelayAuthorityV1;
  readonly operation: FabricHubRelayInvokeV1["operation"];
  readonly channel: RouteBoundFabricStreamChannel;
  readonly controller: AbortController;
  readonly invokeMessageId: string;
  deadlineTimer?: NodeJS.Timeout;
}

export interface FabricDeviceRelayOwnerOptions {
  readonly identity: FabricRelaySessionIdentity;
  readonly hubRuntimeEpoch: string;
  readonly transport: FabricRelaySocketTransport;
  readonly handler: FabricDeviceRelayExecutionHandler;
  readonly limits?: Partial<FabricHubRelayLimits>;
  readonly negotiatedLimits?: Pick<FabricProtocolLimits, "maxInFlightOperations" | "maxFrameBytes" | "maxResultBytes">;
}

/** One Device-side execution owner for exactly one accepted Connector attempt. */
export class FabricDeviceRelayOwner {
  readonly identity: FabricRelaySessionIdentity;
  readonly hubRuntimeEpoch: string;
  readonly limits: Readonly<FabricHubRelayLimits>;
  readonly #transport: FabricRelaySocketTransport;
  readonly #handler: FabricDeviceRelayExecutionHandler;
  readonly #channels: FabricChannelRouter;
  readonly #operations = new Map<string, DeviceOperation>();
  readonly #openingRoutes = new Map<string, FabricHubRelayAuthorityV1>();
  readonly #tombstones = new Map<string, RelayTombstone>();
  #active = true;
  #ready = false;

  constructor(options: FabricDeviceRelayOwnerOptions) {
    if (options.identity.relayVersion !== FABRIC_HUB_RELAY_VERSION) throw new FabricContractError("unsupported_version", "Device relay owner requires negotiated relay support");
    assertFabricIdentifier(options.hubRuntimeEpoch, "hubRuntimeEpoch");
    this.identity = { ...options.identity };
    this.hubRuntimeEpoch = options.hubRuntimeEpoch;
    this.#transport = options.transport;
    this.#handler = options.handler;
    this.limits = limitsOf(options.limits, options.negotiatedLimits);
    this.#channels = new FabricChannelRouter({
      validateRoute: (routeId) => {
        if (!this.#active) throw new FabricContractError("stale_generation", "Device relay owner is retired");
        const operation = [...this.#operations.values()].find((candidate) => candidate.authority.routeId === routeId);
        const authority = operation?.authority ?? this.#openingRoutes.get(routeId);
        if (authority === undefined) throw new FabricContractError("not_found", "Device relay route is not active", "routeId");
        return {
          routeId,
          connectionId: this.identity.connectionId,
          workspaceBindingId: authority.workspaceBindingId,
          endpointId: authority.endpointId,
          connectionGeneration: this.identity.connectionGeneration,
          workspaceGeneration: authority.workspaceGeneration,
          endpointGeneration: authority.endpointGeneration,
          issuedAt: Date.now(),
          expiresAt: authority.deadlineAt,
          state: "open",
          revision: authority.routeRevision,
        };
      },
    });
  }

  activate(): void {
    if (!this.#active) throw new FabricContractError("invalid_state", "Device relay owner is retired");
    this.#ready = true;
  }

  accept(input: FabricEnvelopeV1): void {
    assertValidFabricHubRelayEnvelope(input);
    if (!this.#active || !this.#ready) throw new FabricContractError("invalid_state", "Device relay owner is not ready");
    if (input.kind !== "invoke" && input.kind !== "cancel") throw new FabricContractError("protocol_violation", "Hub sent a wrong-direction relay message", "kind");
    const payload = input.payload;
    this.#assertSession(payload);
    if (input.kind === "invoke") this.#open(input.messageId, payload as FabricHubRelayInvokeV1);
    else this.#cancel(input.messageId, payload as FabricHubRelayCancelV1);
  }

  retire(reason: string): void {
    if (!this.#active) return;
    this.#active = false;
    this.#ready = false;
    const operations = [...this.#operations.values()];
    for (const operation of operations) {
      operation.controller.abort(new FabricContractError("unavailable", `${reason}; Agent outcome is uncertain`));
      this.#finishDeviceOperation(operation, reason);
    }
  }

  #open(messageId: string, payload: FabricHubRelayInvokeV1): void {
    const terminal = this.#tombstones.get(payload.operationId);
    if (terminal !== undefined) {
      if (!matchingTombstone(this.#tombstones, payload)) {
        throw new FabricContractError("conflict", "Relay operation identity conflicts with a terminal operation", "operationId");
      }
      this.#sendReceipt(payload, messageId, "invoke_accepted", false, "conflict", "Relay operation is already terminal");
      return;
    }
    const existing = this.#operations.get(payload.operationId);
    if (existing !== undefined) {
      if (!authorityMatches(existing.authority, payload)) {
        throw new FabricContractError("conflict", "Relay operation identity conflicts with an active operation", "operationId");
      }
      // A retransmitted invoke is operation-local and cannot start a second
      // handler. Re-acknowledge the exact active operation idempotently.
      this.#sendReceipt(payload, messageId, "invoke_accepted", true);
      return;
    }
    if (this.#operations.size >= this.limits.maxActiveOperations) {
      this.#sendReceipt(payload, messageId, "invoke_accepted", false, "resource_exhausted", "Device relay active operation capacity is full");
      return;
    }
    if (this.#transport.bufferedAmount > this.limits.maxSocketBufferedBytes) {
      this.#sendReceipt(payload, messageId, "invoke_accepted", false, "resource_exhausted", "Device relay socket backpressure limit is exceeded");
      return;
    }
    const controller = new AbortController();
    let operation!: DeviceOperation;
    this.#openingRoutes.set(payload.routeId, payload);
    try {
      const channel = new RouteBoundFabricStreamChannel(this.#channels.admissions, {
        streamId: payload.streamId,
        routeId: payload.routeId,
        operationId: payload.operationId,
        deadlineAt: payload.deadlineAt,
        limits: {
          maxFrameBytes: this.limits.maxFrameBytes,
          maxBufferedFrames: this.limits.maxBufferedFrames,
          maxResultBytes: this.limits.maxResultBytes,
        },
        io: {
          send: async (frame) => {
            if (!this.#active || this.#operations.get(payload.operationId) !== operation) throw new FabricContractError("stale_generation", "Device relay operation owner is retired");
            if (this.#transport.bufferedAmount > this.limits.maxSocketBufferedBytes) throw new FabricContractError("resource_exhausted", "Device relay socket backpressure limit is exceeded", "bufferedAmount");
            const response: FabricHubRelayStreamV1 = {
              ...authorityWithSequence(payload, frame.sequence),
              direction: "device-to-hub",
              frame,
            };
            const outgoing = envelope(response, "stream");
            assertValidFabricHubRelayEnvelope(outgoing);
            this.#transport.send(outgoing, "operation");
          },
          close: async () => undefined,
        },
      });
      operation = { authority: payload, operation: payload.operation, channel, controller, invokeMessageId: messageId };
      this.#operations.set(payload.operationId, operation);
      this.#channels.bind(payload.routeId, payload.operationId, channel);
      channel.accept(payload.frame);
    } catch (error) {
      if (operation !== undefined) {
        this.#operations.delete(payload.operationId);
        this.#channels.unbind(payload.routeId, payload.operationId);
        void operation.channel.close("Device relay invoke was refused").catch(() => undefined);
      }
      tombstone(this.#tombstones, payload);
      const normalized = errorOf(error, "Device relay invoke failed validation");
      this.#sendReceipt(payload, messageId, "invoke_accepted", false, normalized.code, normalized.message);
      return;
    } finally {
      this.#openingRoutes.delete(payload.routeId);
    }
    operation.deadlineTimer = setTimeout(() => {
      if (this.#operations.get(payload.operationId) !== operation) return;
      const failure = new FabricContractError("deadline_exceeded", "Device relay handler deadline has passed", "deadlineAt");
      operation.controller.abort(failure);
      // The Hub owns the caller-facing deadline terminal and sends cancellation
      // on its reserved control path. Retire locally without racing that cancel
      // with an unsolicited terminal receipt at the exact boundary.
      this.#finishDeviceOperation(operation, "Device relay handler deadline passed");
    }, Math.max(0, payload.deadlineAt - Date.now()));
    operation.deadlineTimer.unref?.();
    this.#sendReceipt(payload, messageId, "invoke_accepted", true);
    void this.#execute(operation, payload).catch(() => undefined);
  }

  async #execute(operation: DeviceOperation, payload: FabricHubRelayInvokeV1): Promise<void> {
    try {
      if (operation.controller.signal.aborted || !this.#active || this.#operations.get(payload.operationId) !== operation) return;
      const result = await this.#handler.handle({
        operation: payload.operation,
        input: structuredClone(payload.input),
        authority: payload,
        originSubject: payload.originSubject,
        signal: operation.controller.signal,
      });
      if (operation.controller.signal.aborted || !this.#active || this.#operations.get(payload.operationId) !== operation) return;
      const frame: FabricStreamFrameV1 = {
        version: "fabric.stream.v1", streamId: payload.streamId, routeId: payload.routeId,
        operationId: payload.operationId, sequence: 0, kind: "end", sentAt: Date.now(), payload: { result },
      };
      await operation.channel.send(frame, operation.controller.signal);
    } catch (error) {
      if (operation.controller.signal.aborted || !this.#active || this.#operations.get(payload.operationId) !== operation) return;
      const normalized = errorOf(error, "Device Agent relay handler failed");
      const frame: FabricStreamFrameV1 = {
        version: "fabric.stream.v1", streamId: payload.streamId, routeId: payload.routeId,
        operationId: payload.operationId, sequence: 0, kind: "error", sentAt: Date.now(), payload: errorPayload(normalized),
      };
      await operation.channel.send(frame, operation.controller.signal).catch((sendError: unknown) => {
        const failure = errorOf(sendError, "Device relay failed to deliver its terminal error");
        this.#sendReceipt(payload, operation.invokeMessageId, "closed", false, failure.code, failure.message);
      });
    } finally {
      this.#finishDeviceOperation(operation, "Device relay operation completed");
    }
  }

  #cancel(messageId: string, payload: FabricHubRelayCancelV1): void {
    const operation = this.#operations.get(payload.operationId);
    if (operation === undefined) {
      if (!matchingTombstone(this.#tombstones, payload)) {
        throw new FabricContractError("conflict", "Relay cancel correlation is foreign to this session", "operationId");
      }
      // Late and duplicate cancellation is an idempotent already-terminal
      // delivery, not a reason to reconnect the authenticated session.
      this.#sendReceipt(payload, messageId, "cancel_delivered", true);
      return;
    }
    if (!authorityMatches(operation.authority, payload)) {
      throw new FabricContractError("conflict", "Relay cancel correlation conflicts with the active operation", "operationId");
    }
    operation.controller.abort(new FabricContractError(
      payload.reason === "deadline_exceeded" ? "deadline_exceeded" : "cancelled",
      payload.reason,
    ));
    try {
      this.#sendReceipt(payload, messageId, "cancel_delivered", true);
    } finally {
      this.#finishDeviceOperation(operation, "Relay cancellation delivered");
    }
  }

  #finishDeviceOperation(operation: DeviceOperation, reason: string): void {
    if (operation.deadlineTimer !== undefined) clearTimeout(operation.deadlineTimer);
    tombstone(this.#tombstones, operation.authority);
    if (this.#operations.get(operation.authority.operationId) === operation) {
      this.#operations.delete(operation.authority.operationId);
    }
    this.#channels.unbind(operation.authority.routeId, operation.authority.operationId);
    void operation.channel.close(reason).catch(() => undefined);
  }

  #sendReceipt(authority: FabricHubRelayAuthorityV1, acceptedMessageId: string, receiptKind: FabricHubRelayReceiptV1["receiptKind"], accepted: boolean, code?: FabricContractError["code"], message?: string): void {
    const payload: FabricHubRelayReceiptV1 = {
      ...authorityWithSequence(authority, authority.sequence),
      direction: "device-to-hub",
      receiptKind,
      acceptedMessageId,
      accepted,
      ...(code === undefined ? {} : { code }),
      ...(message === undefined ? {} : { message: message.slice(0, 512) }),
    };
    const outgoing = envelope(payload, "receipt");
    assertValidFabricHubRelayEnvelope(outgoing);
    try {
      this.#transport.send(outgoing, "control");
    } catch (error) {
      if (!(error instanceof FabricContractError) || error.code !== "resource_exhausted") throw error;
      // A saturated receipt reserve is an operation-local delivery failure.
      // The peer's deadline/cancel owner still supplies the terminal fence.
    }
  }

  #assertSession(payload: FabricHubRelayAuthorityV1): void {
    if (payload.version !== FABRIC_HUB_RELAY_VERSION || payload.hubRuntimeEpoch !== this.hubRuntimeEpoch ||
      payload.connectorId !== this.identity.connectorId || payload.deviceId !== this.identity.deviceId ||
      payload.connectionId !== this.identity.connectionId || payload.connectionGeneration !== this.identity.connectionGeneration) {
      throw new FabricContractError("stale_generation", "Relay authority does not match this Device connection owner", "connectionGeneration");
    }
  }

  get activeOperationCount(): number { return this.#operations.size; }
}
