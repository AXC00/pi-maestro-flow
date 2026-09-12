import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  FABRIC_PROTOCOL_VERSION,
  FabricContractError,
  assertFabricIdentifier,
  assertValidFabricEnvelope,
  assertValidFabricRouteTicket,
  assertValidFabricStreamFrame,
  type DeviceId,
  type EndpointId,
  type EndpointRouteHandle,
  type FabricEnvelopeV1,
  type FabricMessageKind,
  type FabricProtocolLimits,
  type FabricStreamFrameV1,
  type JsonValue,
  type RouteId,
  type WorkspaceBindingId,
} from "pi-maestro-fabric-core/v1";
import type { FabricRouteValidator } from "pi-maestro-fabric";
import type { FabricRouteTicketExpectation, FabricRouteTicketSecurity } from "./route-ticket.ts";

export const FABRIC_DIRECT_ROUTE_PATH = "/fabric/v1/direct" as const;

const DIRECT_LIMITS: FabricProtocolLimits = Object.freeze({
  maxFrameBytes: 256 * 1024,
  maxInFlightOperations: 32,
  heartbeatIntervalMs: 10_000,
  heartbeatTimeoutMs: 30_000,
  maxAdvertisementItems: 1_024,
  maxResultBytes: 1024 * 1024,
});

export const FABRIC_DIRECT_ROUTE_STATES = ["connecting", "admitted", "draining", "closed"] as const;
export type FabricDirectRouteState = (typeof FABRIC_DIRECT_ROUTE_STATES)[number];

/** The exact inbound kinds each state accepts. Anything else is refused. */
const ACCEPTED_KINDS: Readonly<Record<FabricDirectRouteState, readonly FabricMessageKind[]>> = Object.freeze({
  connecting: ["route_open"],
  admitted: ["stream", "heartbeat", "drain", "close"],
  draining: ["heartbeat", "close"],
  closed: [],
});

export interface FabricDirectRouteSession {
  readonly connectionId: string;
  readonly connectionGeneration: number;
  readonly routeId: RouteId;
  readonly subject: string;
  readonly ticketId: string;
  readonly deviceId: DeviceId;
  readonly endpointId: EndpointId;
  readonly workspaceBindingId?: WorkspaceBindingId;
  readonly state: FabricDirectRouteState;
  readonly routeRevision: number;
  readonly framesReceived: number;
  readonly resultsPublished: number;
}

export interface FabricDirectRouteServerOptions {
  readonly server: HttpServer | HttpsServer;
  /** Verifies tickets issued to this Edge. The proof never leaves this module. */
  readonly tickets: FabricRouteTicketSecurity;
  /** Current route authority. A stale route or generation is refused. */
  readonly routes: FabricRouteValidator;
  /** Audience this listener serves; taken from configuration, never from a ticket. */
  readonly audience: string;
  /** Subjects this listener serves. Required: an empty list is a configuration error. */
  readonly subjects: readonly string[];
  readonly path?: string;
  readonly limits?: Partial<FabricProtocolLimits>;
  readonly now?: () => number;
  readonly drainTimeoutMs?: number;
  /**
   * Handles one admitted stream frame. A returned frame is published only after
   * the route generations are revalidated again.
   */
  readonly handleStream?: (
    session: FabricDirectRouteSession,
    frame: FabricStreamFrameV1,
  ) => Promise<FabricStreamFrameV1 | undefined> | FabricStreamFrameV1 | undefined;
  readonly onAdmitted?: (session: FabricDirectRouteSession) => void;
  readonly onSessionClosed?: (session: FabricDirectRouteSession, reason: string) => void;
}

interface LiveSession {
  readonly socket: WebSocket;
  state: FabricDirectRouteState;
  connectionId: string;
  connectionGeneration: number;
  routeId: string;
  subject: string;
  ticketId: string;
  deviceId: string;
  endpointId: string;
  workspaceBindingId?: string;
  workspaceGeneration?: number;
  routeRevision: number;
  endpointGeneration: number;
  connectionGenerationOfRoute: number;
  lastHeartbeatAt: number;
  heartbeatSequence: number;
  framesReceived: number;
  resultsPublished: number;
  drainDeadline?: number;
}

function positive(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new FabricContractError("invalid_argument", `${label} must be a positive safe integer`, label);
  }
  return result;
}

function envelopeOf(
  kind: FabricMessageKind,
  payload: Readonly<Record<string, JsonValue>>,
  now: () => number,
  extra: { connectionId?: string; connectionGeneration?: number; correlationId?: string; operationId?: string } = {},
): FabricEnvelopeV1 {
  return {
    version: FABRIC_PROTOCOL_VERSION,
    messageId: randomUUID(),
    kind,
    sentAt: now(),
    ...extra,
    payload,
  };
}

function frameBytes(data: RawData, isBinary: boolean): number {
  if (isBinary) return Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data));
  return Buffer.byteLength(Buffer.isBuffer(data) ? data.toString("utf8") : String(data), "utf8");
}

function textOf(data: RawData): string {
  return Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
}

/** JSON-safe view of a value that is about to be framed. */
function jsonPayload(value: unknown): Readonly<Record<string, JsonValue>> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new FabricContractError("protocol_violation", "Fabric frame payload is not JSON serializable");
  }
  return JSON.parse(serialized) as Readonly<Record<string, JsonValue>>;
}

/**
 * Whether this socket is TLS.
 *
 * A `lan-direct` route is only ever authorized over TLS, so a plaintext
 * listener is refused here rather than relying on the host to remember.
 */
function isTls(request: IncomingMessage): boolean {
  return (request.socket as { encrypted?: boolean }).encrypted === true;
}

/**
 * `lan-direct` admission over the host's own TLS listener.
 *
 * The server owns framing, the ticket handshake, the heartbeat lease, and route
 * generation revalidation. It never performs capability selection or endpoint
 * fallback: the ticket names exactly one route, and the only route it will
 * serve is the current one.
 */
export class FabricDirectRouteServer {
  readonly #options: FabricDirectRouteServerOptions;
  readonly #now: () => number;
  readonly #limits: FabricProtocolLimits;
  readonly #path: string;
  readonly #subjects: readonly string[];
  readonly #drainTimeoutMs: number;
  readonly #sessions = new Map<string, LiveSession>();
  readonly #liveByRoute = new Map<string, string>();
  readonly #generations = new Map<string, number>();
  readonly #wss: WebSocketServer;
  #sweep?: NodeJS.Timeout;
  #closed = false;

  constructor(options: FabricDirectRouteServerOptions) {
    if (!Array.isArray(options.subjects) || options.subjects.length === 0) {
      throw new FabricContractError("invalid_argument", "subjects must name at least one served subject", "subjects");
    }
    for (const [index, subject] of options.subjects.entries()) assertFabricIdentifier(subject, `subjects[${index}]`);
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#path = options.path ?? FABRIC_DIRECT_ROUTE_PATH;
    this.#subjects = [...options.subjects];
    this.#drainTimeoutMs = positive(options.drainTimeoutMs, 5_000, "drainTimeoutMs");
    this.#limits = {
      maxFrameBytes: positive(options.limits?.maxFrameBytes, DIRECT_LIMITS.maxFrameBytes, "maxFrameBytes"),
      maxInFlightOperations: positive(options.limits?.maxInFlightOperations, DIRECT_LIMITS.maxInFlightOperations, "maxInFlightOperations"),
      heartbeatIntervalMs: positive(options.limits?.heartbeatIntervalMs, DIRECT_LIMITS.heartbeatIntervalMs, "heartbeatIntervalMs"),
      heartbeatTimeoutMs: positive(options.limits?.heartbeatTimeoutMs, DIRECT_LIMITS.heartbeatTimeoutMs, "heartbeatTimeoutMs"),
      maxAdvertisementItems: positive(options.limits?.maxAdvertisementItems, DIRECT_LIMITS.maxAdvertisementItems, "maxAdvertisementItems"),
      maxResultBytes: positive(options.limits?.maxResultBytes, DIRECT_LIMITS.maxResultBytes, "maxResultBytes"),
    };
    if (this.#limits.heartbeatTimeoutMs <= this.#limits.heartbeatIntervalMs) {
      throw new FabricContractError(
        "invalid_argument",
        "heartbeatTimeoutMs must exceed heartbeatIntervalMs, or a healthy direct route is fenced",
        "heartbeatTimeoutMs",
      );
    }
    this.#wss = new WebSocketServer({ server: options.server, path: this.#path, maxPayload: this.#limits.maxFrameBytes });
    this.#wss.on("connection", (socket, request) => this.#onConnection(socket, request));
  }

  start(): void {
    if (this.#closed || this.#sweep !== undefined) return;
    this.#sweep = setInterval(() => this.#sweepLeases(), this.#limits.heartbeatIntervalMs);
    this.#sweep.unref?.();
  }

  sessions(): FabricDirectRouteSession[] {
    return [...this.#sessions.values()].map((session) => this.#view(session));
  }

  sessionOfRoute(routeId: string): FabricDirectRouteSession | undefined {
    const key = this.#liveByRoute.get(routeId);
    const session = key === undefined ? undefined : this.#sessions.get(key);
    return session === undefined ? undefined : this.#view(session);
  }

  async close(reason = "the Edge is shutting down"): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sweep !== undefined) clearInterval(this.#sweep);
    this.#sweep = undefined;
    const sessions = [...this.#sessions.values()];
    for (const session of sessions) this.#sendDrain(session, reason);
    await Promise.race([
      Promise.all(sessions.map((session) => new Promise<void>((resolve) => {
        if (session.socket.readyState === session.socket.CLOSED) return resolve();
        session.socket.once("close", () => resolve());
      }))).then(() => undefined),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.#drainTimeoutMs);
        timer.unref?.();
      }),
    ]);
    for (const session of this.#sessions.values()) {
      try { session.socket.terminate(); } catch { /* already gone */ }
    }
    this.#sessions.clear();
    this.#liveByRoute.clear();
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
  }

  #onConnection(socket: WebSocket, request: IncomingMessage): void {
    if (this.#closed) {
      socket.close(1012, "the Edge is shutting down");
      return;
    }
    if (!isTls(request)) {
      // A direct route always uses TLS; a plaintext socket is not a slow case,
      // it is an unauthenticated one.
      this.#refuseSocket(socket, 1002, "protocol_violation", "A lan-direct route requires TLS");
      return;
    }
    const session: LiveSession = {
      socket,
      state: "connecting",
      connectionId: "",
      connectionGeneration: 0,
      routeId: "",
      subject: "",
      ticketId: "",
      deviceId: "",
      endpointId: "",
      routeRevision: 0,
      endpointGeneration: 0,
      connectionGenerationOfRoute: 0,
      lastHeartbeatAt: this.#now(),
      heartbeatSequence: 0,
      framesReceived: 0,
      resultsPublished: 0,
    };
    this.#sessions.set(randomUUID(), session);
    socket.on("message", (data, isBinary) => this.#onMessage(session, data, isBinary));
    socket.on("close", () => this.#retire(session, "the caller closed the direct route"));
    socket.on("error", () => this.#retire(session, "the direct route errored"));
  }

  #onMessage(session: LiveSession, data: RawData, isBinary: boolean): void {
    if (session.state === "closed") return;
    if (isBinary) return this.#reject(session, "binary", 1003, "protocol_violation", "Fabric frames must be JSON text");
    if (frameBytes(data, false) > this.#limits.maxFrameBytes) {
      return this.#reject(session, "oversized", 1009, "resource_exhausted", "Fabric frame exceeds maxFrameBytes");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(textOf(data));
    } catch {
      return this.#reject(session, "malformed", 1008, "protocol_violation", "Fabric frame is not valid JSON");
    }
    try {
      assertValidFabricEnvelope(parsed);
    } catch (error) {
      return this.#reject(
        session,
        "malformed",
        1008,
        "protocol_violation",
        error instanceof Error ? error.message : "Fabric frame is not a valid envelope",
      );
    }
    const envelope = parsed;
    if (!ACCEPTED_KINDS[session.state].includes(envelope.kind)) {
      return this.#reject(
        session,
        "unexpected-kind",
        1008,
        "invalid_state",
        `Fabric frame kind ${JSON.stringify(envelope.kind)} is not accepted while ${session.state}`,
      );
    }
    try {
      this.#handle(session, envelope);
    } catch (error) {
      const code = error instanceof FabricContractError ? error.code : "protocol_violation";
      const message = error instanceof Error ? error.message : String(error);
      this.#sendError(session, envelope.kind, code, message);
      // A refused admission or a stale generation is terminal for this handle.
      if (session.state !== "admitted" || code === "stale_generation" || code === "expired") {
        this.#retire(session, `${code}: ${message}`);
      }
    }
  }

  #handle(session: LiveSession, envelope: FabricEnvelopeV1): void {
    switch (envelope.kind) {
      case "route_open": return this.#onRouteOpen(session, envelope);
      case "stream": return this.#onStream(session, envelope);
      case "heartbeat": return this.#onHeartbeat(session, envelope);
      case "drain": return this.#onDrain(session, envelope);
      case "close": return this.#retire(session, "the caller closed the direct route");
      default:
        throw new FabricContractError("invalid_state", "Unsupported Fabric frame", "kind");
    }
  }

  /**
   * Admit one ticket.
   *
   * The route is resolved first so the ticket is checked against the route that
   * actually exists, not against what the ticket claims about itself.
   */
  #onRouteOpen(session: LiveSession, envelope: FabricEnvelopeV1): void {
    const now = this.#now();
    const rawTicket: unknown = envelope.payload.ticket;
    if (rawTicket === undefined) {
      throw new FabricContractError("invalid_argument", "route_open must carry a route ticket", "ticket");
    }
    assertValidFabricRouteTicket(rawTicket, now);
    const claims = rawTicket.claims;
    const route = this.#options.routes.validateRoute(claims.routeId);
    if (route.selectedPath !== "lan-direct") {
      throw new FabricContractError("permission_denied", "This listener only serves lan-direct routes", "selectedPath");
    }
    const deviceId = route.deviceId;
    const operationClass = route.operationClass;
    if (deviceId === undefined || operationClass === undefined) {
      throw new FabricContractError("permission_denied", "A lan-direct route must name a Device and an operation class", "routeId");
    }
    const expectation: FabricRouteTicketExpectation = {
      subjects: this.#subjects,
      audience: this.#options.audience,
      routeId: route.routeId,
      deviceId,
      endpointId: route.endpointId,
      ...(route.workspaceBindingId === undefined ? {} : { workspaceBindingId: route.workspaceBindingId }),
      connectionGeneration: route.connectionGeneration,
      ...(route.workspaceGeneration === undefined ? {} : { workspaceGeneration: route.workspaceGeneration }),
      endpointGeneration: route.endpointGeneration,
      operationClass,
    };
    const verified = this.#options.tickets.verify(rawTicket, expectation);

    // A newer direct session for the same route fences the older generation.
    const previousKey = this.#liveByRoute.get(route.routeId);
    if (previousKey !== undefined && previousKey !== this.#sessionKey(session)) {
      const previous = this.#sessions.get(previousKey);
      if (previous !== undefined) {
        this.#sendError(previous, "route_open", "stale_generation", "A newer direct route superseded this generation");
        this.#retire(previous, "superseded by a newer direct route generation");
      }
    }
    const generation = (this.#generations.get(route.routeId) ?? 0) + 1;
    this.#generations.set(route.routeId, generation);
    session.state = "admitted";
    session.connectionId = `direct-${route.routeId}-${generation}`;
    session.connectionGeneration = generation;
    session.routeId = route.routeId;
    session.subject = verified.subject;
    session.ticketId = verified.ticketId;
    session.deviceId = verified.deviceId;
    session.endpointId = verified.endpointId;
    session.workspaceBindingId = verified.workspaceBindingId;
    session.workspaceGeneration = verified.workspaceGeneration;
    session.routeRevision = route.revision;
    session.endpointGeneration = verified.endpointGeneration;
    session.connectionGenerationOfRoute = verified.connectionGeneration;
    session.lastHeartbeatAt = this.#now();
    this.#liveByRoute.set(route.routeId, this.#sessionKey(session));
    this.#send(session, envelopeOf("route_open", {
      accepted: true,
      routeId: route.routeId,
      routeRevision: route.revision,
      subject: verified.subject,
      deviceId: verified.deviceId,
      endpointId: verified.endpointId,
      connectionGeneration: verified.connectionGeneration,
      endpointGeneration: verified.endpointGeneration,
      expiresAt: verified.expiresAt,
    }, this.#now, {
      connectionId: session.connectionId,
      connectionGeneration: generation,
      correlationId: envelope.messageId,
    }));
    this.#options.onAdmitted?.(this.#view(session));
  }

  /**
   * Accept one work frame.
   *
   * The route is revalidated before the frame is handed on, so work is never
   * received on a generation that has already moved.
   */
  #onStream(session: LiveSession, envelope: FabricEnvelopeV1): void {
    this.#requireCurrentRoute(session);
    const rawFrame: unknown = envelope.payload;
    assertValidFabricStreamFrame(rawFrame);
    const frame = rawFrame;
    if (frame.routeId !== session.routeId) {
      throw new FabricContractError("conflict", "Stream frame names another route", "routeId");
    }
    session.framesReceived += 1;
    const handler = this.#options.handleStream;
    if (handler === undefined) return;
    void Promise.resolve()
      .then(() => handler(this.#view(session), frame))
      .then((result) => {
        if (result === undefined || session.state === "closed") return;
        // Revalidated again: the answer is only published if the route it
        // belongs to is still the current one.
        this.#requireCurrentRoute(session);
        assertValidFabricStreamFrame(result);
        if (result.routeId !== session.routeId) {
          throw new FabricContractError("protocol_violation", "A published stream frame names another route", "routeId");
        }
        session.resultsPublished += 1;
        this.#send(session, envelopeOf("stream", jsonPayload(result), this.#now, {
          connectionId: session.connectionId,
          connectionGeneration: session.connectionGeneration,
          ...(envelope.operationId === undefined ? {} : { operationId: envelope.operationId }),
          correlationId: envelope.messageId,
        }));
      })
      .catch((error: unknown) => {
        const code = error instanceof FabricContractError ? error.code : "protocol_violation";
        const message = error instanceof Error ? error.message : String(error);
        try {
          this.#sendError(session, "stream", code, message);
        } catch { /* the peer is already gone */ }
        if (session.state !== "closed") this.#retire(session, `${code}: ${message}`);
      });
  }

  #onHeartbeat(session: LiveSession, envelope: FabricEnvelopeV1): void {
    if (envelope.connectionId !== session.connectionId
      || envelope.connectionGeneration !== session.connectionGeneration) {
      throw new FabricContractError(
        "stale_generation",
        "Fabric heartbeat does not match this direct route generation",
        "connectionGeneration",
      );
    }
    const sequence = envelope.payload.sequence;
    if (!Number.isSafeInteger(sequence) || (sequence as number) <= session.heartbeatSequence) {
      throw new FabricContractError(
        "invalid_argument",
        "Fabric heartbeat sequence must be strictly increasing within a generation",
        "sequence",
      );
    }
    session.heartbeatSequence = sequence as number;
    session.lastHeartbeatAt = this.#now();
    this.#send(session, envelopeOf("heartbeat_ack", {
      sequence: session.heartbeatSequence,
      leaseExpiresAt: session.lastHeartbeatAt + this.#limits.heartbeatTimeoutMs,
    }, this.#now, { connectionId: session.connectionId, connectionGeneration: session.connectionGeneration }));
  }

  #onDrain(session: LiveSession, envelope: FabricEnvelopeV1): void {
    const reason = typeof envelope.payload.reason === "string" ? envelope.payload.reason : "the caller is draining";
    session.state = "draining";
    session.drainDeadline = this.#now() + this.#drainTimeoutMs;
    this.#sendDrain(session, reason);
  }

  #sendDrain(session: LiveSession, reason: string): void {
    if (session.state === "closed") return;
    this.#send(session, envelopeOf("drain", {
      reason,
      deadlineAt: this.#now() + this.#drainTimeoutMs,
    }, this.#now, { connectionId: session.connectionId, connectionGeneration: session.connectionGeneration }));
  }

  /**
   * The current route, or a terminal refusal.
   *
   * Route identity and every generation must still match this session: a path
   * switch may move `selectedPath`, but never the target.
   */
  #requireCurrentRoute(session: LiveSession): EndpointRouteHandle {
    const route = this.#options.routes.validateRoute(session.routeId);
    if (route.state !== "open") {
      throw new FabricContractError("invalid_state", "Route is no longer open", "state");
    }
    if (route.selectedPath !== "lan-direct") {
      throw new FabricContractError("stale_generation", "Route no longer selects lan-direct", "selectedPath");
    }
    if (route.deviceId !== session.deviceId
      || route.endpointId !== session.endpointId
      || route.connectionGeneration !== session.connectionGenerationOfRoute
      || route.workspaceBindingId !== session.workspaceBindingId
      || route.workspaceGeneration !== session.workspaceGeneration
      || route.endpointGeneration !== session.endpointGeneration) {
      throw new FabricContractError("stale_generation", "Route identity or generation changed", "routeId");
    }
    return route;
  }

  #sweepLeases(): void {
    const now = this.#now();
    for (const session of [...this.#sessions.values()]) {
      if (session.state === "closed") continue;
      if (session.state === "draining" && (session.drainDeadline ?? 0) <= now) {
        this.#retire(session, "the drain window closed");
        continue;
      }
      if (session.state !== "admitted" && session.state !== "draining") continue;
      if (now - session.lastHeartbeatAt > this.#limits.heartbeatTimeoutMs) {
        this.#retire(session, "heartbeat lease expired");
      }
    }
  }

  #retire(session: LiveSession, reason: string): void {
    if (session.state === "closed") return;
    session.state = "closed";
    for (const [key, candidate] of this.#sessions) {
      if (candidate === session) {
        this.#sessions.delete(key);
        if (session.routeId !== "" && this.#liveByRoute.get(session.routeId) === key) {
          this.#liveByRoute.delete(session.routeId);
        }
        break;
      }
    }
    this.#options.onSessionClosed?.(this.#view(session), reason);
    try { session.socket.close(1000, reason.slice(0, 120)); } catch { /* already gone */ }
  }

  #sessionKey(session: LiveSession): string {
    for (const [key, candidate] of this.#sessions) if (candidate === session) return key;
    return randomUUID();
  }

  #view(session: LiveSession): FabricDirectRouteSession {
    return {
      connectionId: session.connectionId,
      connectionGeneration: session.connectionGeneration,
      routeId: session.routeId,
      subject: session.subject,
      ticketId: session.ticketId,
      deviceId: session.deviceId,
      endpointId: session.endpointId,
      ...(session.workspaceBindingId === undefined ? {} : { workspaceBindingId: session.workspaceBindingId }),
      state: session.state,
      routeRevision: session.routeRevision,
      framesReceived: session.framesReceived,
      resultsPublished: session.resultsPublished,
    };
  }

  #sendError(session: LiveSession, kind: FabricMessageKind, code: string, message: string, retryable = false): void {
    this.#send(session, envelopeOf("error", { code, message, kind, retryable }, this.#now, {
      ...(session.connectionId === "" ? {} : { connectionId: session.connectionId }),
      ...(session.connectionGeneration === 0 ? {} : { connectionGeneration: session.connectionGeneration }),
    }));
  }

  #reject(session: LiveSession, label: string, closeCode: number, code: string, message: string): void {
    this.#sendError(session, "error", code, message);
    this.#options.onSessionClosed?.(this.#view(session), `refused a ${label} frame`);
    session.state = "closed";
    for (const [key, candidate] of this.#sessions) if (candidate === session) this.#sessions.delete(key);
    try { session.socket.close(closeCode, label.slice(0, 120)); } catch { /* already gone */ }
  }

  #refuseSocket(socket: WebSocket, closeCode: number, code: string, message: string): void {
    const text = JSON.stringify(envelopeOf("error", { code, message, kind: "error", retryable: false }, this.#now));
    try { socket.send(text); } catch { /* the socket may already be gone */ }
    try { socket.close(closeCode, code.slice(0, 120)); } catch { /* already gone */ }
  }

  #send(session: LiveSession, envelope: FabricEnvelopeV1): void {
    if (session.socket.readyState !== session.socket.OPEN) return;
    const text = JSON.stringify(envelope);
    if (Buffer.byteLength(text, "utf8") > this.#limits.maxFrameBytes) {
      throw new FabricContractError("resource_exhausted", "Fabric frame exceeds maxFrameBytes", "maxFrameBytes");
    }
    session.socket.send(text);
  }
}
