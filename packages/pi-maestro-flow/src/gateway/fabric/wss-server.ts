import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  FABRIC_PROTOCOL_VERSION,
  FabricContractError,
  assertValidFabricEnvelope,
  type FabricEnvelopeV1,
  type FabricMessageKind,
  type FabricProtocolLimits,
  type JsonValue,
} from "pi-maestro-fabric-core/v1";
import {
  FABRIC_CHALLENGE_PROOF_VERSION,
  type FabricChallengeProofV1,
  type FabricConnectorCredentialV1,
  FabricConnectorSecurity,
} from "./security.ts";

export const FABRIC_WSS_PATH = "/fabric/v1/connector" as const;

const HUB_LIMITS: FabricProtocolLimits = Object.freeze({
  maxFrameBytes: 256 * 1024,
  maxInFlightOperations: 32,
  heartbeatIntervalMs: 10_000,
  heartbeatTimeoutMs: 30_000,
  maxAdvertisementItems: 1_024,
  maxResultBytes: 1024 * 1024,
});

/** Connection states; a frame is accepted only in the states listed for it. */
export const FABRIC_CONNECTOR_STATES = [
  "connecting",
  "challenged",
  "connected",
  "ready",
  "draining",
  "closed",
] as const;
export type FabricConnectorState = (typeof FABRIC_CONNECTOR_STATES)[number];

/** The exact inbound kinds each state accepts. Anything else is refused. */
const ACCEPTED_KINDS: Readonly<Record<FabricConnectorState, readonly FabricMessageKind[]>> = Object.freeze({
  connecting: ["client_hello"],
  challenged: ["client_proof"],
  connected: ["advertise_snapshot", "advertise_delta", "heartbeat", "drain", "close"],
  ready: ["advertise_delta", "heartbeat", "drain", "close"],
  draining: ["heartbeat", "close"],
  closed: [],
});

export interface FabricConnectorSession {
  readonly connectorId: string;
  readonly connectionId: string;
  readonly connectionGeneration: number;
  readonly instanceNonce: string;
  readonly state: FabricConnectorState;
  /** Advertisement revision the Hub currently holds for this connection. */
  readonly advertisementRevision: number;
  readonly lastHeartbeatAt: number;
  /** True only while this session's generation is the Connector's current one. */
  readonly current: boolean;
}

export interface FabricWssServerOptions {
  readonly security: FabricConnectorSecurity;
  readonly server: HttpsServer;
  readonly path?: string;
  readonly limits?: Partial<FabricProtocolLimits>;
  readonly now?: () => number;
  /** Bounded window a `drain` allows before the Hub fences the generation. */
  readonly drainTimeoutMs?: number;
  readonly onReady?: (session: FabricConnectorSession) => void;
  readonly onSessionClosed?: (session: FabricConnectorSession, reason: string) => void;
  readonly onAdvertisement?: (
    session: FabricConnectorSession,
    revision: number,
    payload: Readonly<Record<string, JsonValue>>,
  ) => void;
}

interface LiveSession {
  readonly socket: WebSocket;
  /** Published by client_hello; empty until then. */
  instanceNonce: string;
  state: FabricConnectorState;
  connectionId: string;
  connectionGeneration: number;
  credential?: FabricConnectorCredentialV1;
  challengeId?: string;
  challengeNonce?: string;
  advertisementRevision: number;
  lastHeartbeatAt: number;
  heartbeatSequence: number;
  drainDeadline?: number;
  readonly openedAt: number;
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
  extra: { connectionId?: string; connectionGeneration?: number; correlationId?: string } = {},
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

/**
 * Hub-side Connector admission over the daemon's own TLS listener.
 *
 * The server owns framing, the handshake state machine, heartbeat lease
 * renewal, drain, and generation fencing. It never reads a secret: proof
 * verification is delegated to {@link FabricConnectorSecurity}, which holds only
 * public keys.
 */
export class FabricWssServer {
  readonly #options: FabricWssServerOptions;
  readonly #security: FabricConnectorSecurity;
  readonly #now: () => number;
  readonly #limits: FabricProtocolLimits;
  readonly #path: string;
  readonly #drainTimeoutMs: number;
  readonly #sessions = new Map<string, LiveSession>();
  readonly #liveByConnector = new Map<string, string>();
  readonly #generations = new Map<string, number>();
  readonly #wss: WebSocketServer;
  #sweep?: NodeJS.Timeout;
  #closed = false;

  constructor(options: FabricWssServerOptions) {
    this.#options = options;
    this.#security = options.security;
    this.#now = options.now ?? Date.now;
    this.#path = options.path ?? FABRIC_WSS_PATH;
    this.#drainTimeoutMs = positive(options.drainTimeoutMs, 5_000, "drainTimeoutMs");
    this.#limits = {
      maxFrameBytes: positive(options.limits?.maxFrameBytes, HUB_LIMITS.maxFrameBytes, "maxFrameBytes"),
      maxInFlightOperations: positive(options.limits?.maxInFlightOperations, HUB_LIMITS.maxInFlightOperations, "maxInFlightOperations"),
      heartbeatIntervalMs: positive(options.limits?.heartbeatIntervalMs, HUB_LIMITS.heartbeatIntervalMs, "heartbeatIntervalMs"),
      heartbeatTimeoutMs: positive(options.limits?.heartbeatTimeoutMs, HUB_LIMITS.heartbeatTimeoutMs, "heartbeatTimeoutMs"),
      maxAdvertisementItems: positive(options.limits?.maxAdvertisementItems, HUB_LIMITS.maxAdvertisementItems, "maxAdvertisementItems"),
      maxResultBytes: positive(options.limits?.maxResultBytes, HUB_LIMITS.maxResultBytes, "maxResultBytes"),
    };
    if (this.#limits.heartbeatTimeoutMs <= this.#limits.heartbeatIntervalMs) {
      throw new FabricContractError(
        "invalid_argument",
        "heartbeatTimeoutMs must exceed heartbeatIntervalMs, or a healthy Connector is fenced",
        "heartbeatTimeoutMs",
      );
    }
    this.#wss = new WebSocketServer({ server: options.server, path: this.#path, maxPayload: this.#limits.maxFrameBytes });
    this.#wss.on("connection", (socket, request) => this.#onConnection(socket, request));
  }

  /** Begin heartbeat sweeping. */
  start(): void {
    if (this.#closed || this.#sweep !== undefined) return;
    this.#sweep = setInterval(() => this.#sweepLeases(), this.#limits.heartbeatIntervalMs);
    this.#sweep.unref?.();
  }

  /** Current session view, for inventory and tests. */
  sessions(): FabricConnectorSession[] {
    return [...this.#sessions.values()].map((session) => this.#view(session));
  }

  sessionOf(connectorId: string): FabricConnectorSession | undefined {
    const id = this.#liveByConnector.get(connectorId);
    const session = id === undefined ? undefined : this.#sessions.get(id);
    return session === undefined ? undefined : this.#view(session);
  }

  /**
   * Bounded shutdown: drain ready sessions, wait for their close, then
   * terminate whatever is left. The Hub never blocks shutdown on a peer.
   */
  async close(reason = "the Hub is shutting down"): Promise<void> {
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
    this.#liveByConnector.clear();
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
  }

  #onConnection(socket: WebSocket, request: IncomingMessage): void {
    if (this.#closed || request.url === undefined) {
      socket.close(1012, "the Hub is shutting down");
      return;
    }
    const session: LiveSession = {
      socket,
      instanceNonce: "",
      state: "connecting",
      connectionId: "",
      connectionGeneration: 0,
      advertisementRevision: 0,
      lastHeartbeatAt: this.#now(),
      heartbeatSequence: 0,
      openedAt: this.#now(),
    };
    this.#sessions.set(randomUUID(), session);
    socket.on("message", (data, isBinary) => this.#onMessage(session, data, isBinary));
    socket.on("close", () => this.#retire(session, "the Connector closed the channel"));
    socket.on("error", () => this.#retire(session, "the Connector channel errored"));
  }

  #onMessage(session: LiveSession, data: RawData, isBinary: boolean): void {
    if (session.state === "closed") return;
    // Binary, oversized, and unparsable frames are refused before any handler
    // sees them: a frame the protocol does not describe is not a message.
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
      this.#sendError(session, envelope.kind, code, error instanceof Error ? error.message : String(error));
    }
  }

  #handle(session: LiveSession, envelope: FabricEnvelopeV1): void {
    switch (envelope.kind) {
      case "client_hello": return this.#onHello(session, envelope);
      case "client_proof": return this.#onProof(session, envelope);
      case "advertise_snapshot": return this.#onSnapshot(session, envelope);
      case "advertise_delta": return this.#onDelta(session, envelope);
      case "heartbeat": return this.#onHeartbeat(session, envelope);
      case "drain": return this.#onDrain(session, envelope);
      case "close": return this.#retire(session, "the Connector closed the channel");
      default:
        throw new FabricContractError("invalid_state", "Unsupported Fabric frame", "kind");
    }
  }

  #onHello(session: LiveSession, envelope: FabricEnvelopeV1): void {
    const connectorId = envelope.payload.connectorId;
    const instanceNonce = envelope.payload.instanceNonce;
    if (typeof connectorId !== "string" || typeof instanceNonce !== "string" || instanceNonce.length === 0) {
      throw new FabricContractError("invalid_argument", "client_hello must name a Connector and instance nonce", "payload");
    }
    // Issuing the challenge is what refuses an unknown, revoked, or expired
    // Connector, so a refused hello never learns why.
    const challenge = this.#security.issueChallenge(connectorId);
    session.state = "challenged";
    session.instanceNonce = instanceNonce;
    session.challengeId = challenge.challengeId;
    session.challengeNonce = challenge.challengeNonce;
    session.credential = undefined;
    this.#send(session, envelopeOf("server_challenge", {
      challengeId: challenge.challengeId,
      challengeNonce: challenge.challengeNonce,
      audience: challenge.audience,
      protocolVersion: challenge.protocolVersion,
      expiresAt: challenge.expiresAt,
    }, this.#now, { correlationId: envelope.messageId }));
  }

  #onProof(session: LiveSession, envelope: FabricEnvelopeV1): void {
    if (session.challengeId === undefined) {
      throw new FabricContractError("invalid_state", "No Fabric challenge is outstanding", "kind");
    }
    const payload = envelope.payload;
    const proof: FabricChallengeProofV1 = {
      version: FABRIC_CHALLENGE_PROOF_VERSION,
      challengeId: typeof payload.challengeId === "string" ? payload.challengeId : session.challengeId,
      connectorId: typeof payload.connectorId === "string" ? payload.connectorId : "",
      instanceNonce: typeof payload.instanceNonce === "string" ? payload.instanceNonce : session.instanceNonce,
      challengeNonce: typeof payload.challengeNonce === "string" ? payload.challengeNonce : "",
      audience: typeof payload.audience === "string" ? payload.audience : "",
      protocolVersion: typeof payload.protocolVersion === "string" ? payload.protocolVersion : "",
      credentialGeneration: typeof payload.credentialGeneration === "number" ? payload.credentialGeneration : 0,
      signature: typeof payload.signature === "string" ? payload.signature : "",
    };
    const credential = this.#security.verifyProof(proof);
    // A newer connection for the same Connector fences the older generation, so
    // a reconnect can never revive the routes its predecessor held.
    const previousId = this.#liveByConnector.get(credential.connectorId);
    if (previousId !== undefined && previousId !== this.#sessionKey(session)) {
      const previous = this.#sessions.get(previousId);
      if (previous !== undefined) {
        this.#sendError(previous, "client_proof", "stale_generation", "A newer connection superseded this generation");
        this.#retire(previous, "superseded by a newer connection generation");
      }
    }
    const generation = (this.#generations.get(credential.connectorId) ?? 0) + 1;
    this.#generations.set(credential.connectorId, generation);
    session.credential = credential;
    session.connectionId = `connection-${credential.connectorId}-${generation}`;
    session.connectionGeneration = generation;
    session.state = "connected";
    session.lastHeartbeatAt = this.#now();
    this.#liveByConnector.set(credential.connectorId, this.#sessionKey(session));
    this.#send(session, envelopeOf("connection_accepted", {
      connectionId: session.connectionId,
      connectionGeneration: generation,
      connectorId: credential.connectorId,
      limits: this.#limits as unknown as JsonValue,
    }, this.#now, { connectionId: session.connectionId, connectionGeneration: generation, correlationId: envelope.messageId }));
  }

  #onSnapshot(session: LiveSession, envelope: FabricEnvelopeV1): void {
    const revision = envelope.payload.advertisementRevision;
    if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
      throw new FabricContractError("invalid_argument", "advertise_snapshot must carry a positive revision", "advertisementRevision");
    }
    session.advertisementRevision = revision as number;
    session.state = "ready";
    session.lastHeartbeatAt = this.#now();
    this.#options.onAdvertisement?.(this.#view(session), session.advertisementRevision, envelope.payload);
    this.#send(session, envelopeOf("ready", {
      connectionId: session.connectionId,
      connectionGeneration: session.connectionGeneration,
      advertisementRevision: session.advertisementRevision,
      heartbeatIntervalMs: this.#limits.heartbeatIntervalMs,
    }, this.#now, { connectionId: session.connectionId, connectionGeneration: session.connectionGeneration }));
    const view = this.#view(session);
    if (view !== undefined) this.#options.onReady?.(view);
  }

  #onDelta(session: LiveSession, envelope: FabricEnvelopeV1): void {
    const base = envelope.payload.baseRevision;
    if (!Number.isSafeInteger(base) || (base as number) < 0) {
      throw new FabricContractError("invalid_argument", "advertise_delta must carry a base revision", "baseRevision");
    }
    if (base !== session.advertisementRevision) {
      // Resync rather than merge: a delta against a revision the Hub does not
      // hold cannot be applied without inventing state it never saw.
      this.#sendError(session, "advertise_delta", "conflict", "Advertisement base revision is stale; resend a snapshot", true);
      return;
    }
    const revision = envelope.payload.advertisementRevision;
    if (!Number.isSafeInteger(revision) || (revision as number) <= session.advertisementRevision) {
      throw new FabricContractError("invalid_argument", "advertise_delta must advance the revision", "advertisementRevision");
    }
    session.advertisementRevision = revision as number;
    this.#options.onAdvertisement?.(this.#view(session), session.advertisementRevision, envelope.payload);
  }

  #onHeartbeat(session: LiveSession, envelope: FabricEnvelopeV1): void {
    if (envelope.connectionId !== session.connectionId
      || envelope.connectionGeneration !== session.connectionGeneration) {
      throw new FabricContractError(
        "stale_generation",
        "Fabric heartbeat does not match this connection generation",
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
    const reason = typeof envelope.payload.reason === "string" ? envelope.payload.reason : "the Connector is draining";
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

  /** Fence every generation whose heartbeat lease lapsed. */
  #sweepLeases(): void {
    const now = this.#now();
    for (const session of [...this.#sessions.values()]) {
      if (session.state === "closed") continue;
      if (session.state === "draining" && (session.drainDeadline ?? 0) <= now) {
        this.#retire(session, "the drain window closed");
        continue;
      }
      // A connection still negotiating has no lease yet; its window is bounded
      // by the challenge, not by heartbeat.
      if (session.state !== "ready" && session.state !== "draining") continue;
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
        if (session.credential !== undefined && this.#liveByConnector.get(session.credential.connectorId) === key) {
          this.#liveByConnector.delete(session.credential.connectorId);
        }
        break;
      }
    }
    const view = this.#view(session);
    if (view !== undefined) this.#options.onSessionClosed?.(view, reason);
    try { session.socket.close(1000, reason.slice(0, 120)); } catch { /* already gone */ }
  }

  #sessionKey(session: LiveSession): string {
    for (const [key, candidate] of this.#sessions) if (candidate === session) return key;
    return randomUUID();
  }

  #view(session: LiveSession): FabricConnectorSession {
    return {
      connectorId: session.credential?.connectorId ?? "",
      connectionId: session.connectionId,
      connectionGeneration: session.connectionGeneration,
      instanceNonce: session.instanceNonce,
      state: session.state,
      advertisementRevision: session.advertisementRevision,
      lastHeartbeatAt: session.lastHeartbeatAt,
      current: session.credential !== undefined
        && this.#liveByConnector.get(session.credential.connectorId) === this.#sessionKey(session),
    };
  }

  #sendError(
    session: LiveSession,
    kind: FabricMessageKind,
    code: string,
    message: string,
    retryable = false,
  ): void {
    this.#send(session, envelopeOf("error", { code, message, kind, retryable }, this.#now, {
      ...(session.connectionId === "" ? {} : { connectionId: session.connectionId }),
      ...(session.connectionGeneration === 0 ? {} : { connectionGeneration: session.connectionGeneration }),
    }));
  }

  #reject(
    session: LiveSession,
    label: string,
    closeCode: number,
    code: string,
    message: string,
  ): void {
    this.#sendError(session, "error", code, message);
    const view = this.#view(session);
    if (view !== undefined) this.#options.onSessionClosed?.(view, `refused a ${label} frame`);
    session.state = "closed";
    try { session.socket.close(closeCode, label.slice(0, 120)); } catch { /* already gone */ }
    for (const [key, candidate] of this.#sessions) if (candidate === session) this.#sessions.delete(key);
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
