import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  FABRIC_HUB_RELAY_VERSION,
  FABRIC_PROTOCOL_VERSION,
  FabricContractError,
  assertBoundedString,
  assertFabricIdentifier,
  assertGeneration,
  assertValidFabricEnvelope,
  assertValidFabricHubRelayVersions,
  assertValidFabricProtocolLimits,
  type FabricEnvelopeV1,
  type FabricMessageKind,
  type FabricProtocolLimits,
  type JsonValue,
  type PublicConnectionLease,
} from "pi-maestro-fabric-core/v1";
import type { FabricManagedConnectionOwner } from "pi-maestro-fabric";
import type { FabricHubRelayWssPort } from "./hub-relay.ts";
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

export const FABRIC_CONNECTOR_STATES = ["connecting", "challenged", "connected", "ready", "draining", "closed"] as const;
export type FabricConnectorState = (typeof FABRIC_CONNECTOR_STATES)[number];

const ACCEPTED_KINDS: Readonly<Record<FabricConnectorState, readonly FabricMessageKind[]>> = Object.freeze({
  connecting: ["client_hello"],
  challenged: ["client_proof"],
  connected: ["advertise_snapshot", "advertise_delta", "drain", "close"],
  ready: ["advertise_delta", "heartbeat", "stream", "receipt", "drain", "close"],
  draining: ["close"],
  closed: [],
});

export interface FabricConnectorSession {
  readonly connectorId: string;
  readonly deviceId: string;
  readonly connectionId: string;
  readonly connectionGeneration: number;
  readonly instanceNonce: string;
  readonly state: FabricConnectorState;
  readonly advertisementRevision: number;
  readonly lastHeartbeatAt: number;
  readonly current: boolean;
  readonly relayVersion?: typeof FABRIC_HUB_RELAY_VERSION;
  readonly negotiatedLimits: Readonly<FabricProtocolLimits>;
}

export interface FabricWssAdmissionInput {
  readonly requestId: string;
  readonly connectorId: string;
  readonly expectedCredentialGeneration: number;
  readonly connectorInstanceNonce: string;
  readonly capabilityDigest: string;
  readonly limits: FabricProtocolLimits;
  readonly establishedAt: number;
  readonly expiresAt: number;
}

/** Host authority used by production WSS. Every mutation is awaited before ACK. */
export interface FabricWssAuthority {
  admit(input: FabricWssAdmissionInput, owner: FabricManagedConnectionOwner): Promise<PublicConnectionLease>;
  acceptSnapshot(session: FabricConnectorSession, payload: Readonly<Record<string, JsonValue>>): Promise<void>;
  acceptDelta(session: FabricConnectorSession, payload: Readonly<Record<string, JsonValue>>): Promise<void>;
  heartbeat(session: FabricConnectorSession, input: {
    readonly sequence: number;
    readonly observedAt: number;
    readonly leaseExpiresAt: number;
  }): Promise<void>;
  drain(session: FabricConnectorSession, deadlineAt: number, reason: string): Promise<void>;
  close(session: FabricConnectorSession, reason: string): Promise<void>;
}

export interface FabricWssServerOptions {
  readonly security: FabricConnectorSecurity;
  readonly server: HttpServer | HttpsServer;
  readonly path?: string;
  readonly limits?: Partial<FabricProtocolLimits>;
  readonly now?: () => number;
  readonly drainTimeoutMs?: number;
  readonly authority?: FabricWssAuthority;
  readonly relay?: FabricHubRelayWssPort;
  readonly onReady?: (session: FabricConnectorSession) => void | Promise<void>;
  readonly onSessionClosed?: (session: FabricConnectorSession, reason: string) => void | Promise<void>;
  readonly onAdvertisement?: (
    session: FabricConnectorSession,
    revision: number,
    payload: Readonly<Record<string, JsonValue>>,
  ) => void | Promise<void>;
}

type RetirementState = "active" | "retiring" | "retired";
type CleanupState = "not_required" | "pending" | "running" | "succeeded";
type SocketCleanupState = "pending" | "closing" | "terminating" | "succeeded";

interface QueuedAction {
  settled: boolean;
  timer?: NodeJS.Timeout;
}

interface LiveSession {
  readonly key: string;
  readonly socket: WebSocket;
  readonly sessionToken: string;
  retirementState: RetirementState;
  retirementReason?: string;
  instanceNonce: string;
  state: FabricConnectorState;
  connectionId: string;
  connectionGeneration: number;
  credentialGeneration: number;
  helloConnectorId: string;
  credential?: FabricConnectorCredentialV1;
  challengeId?: string;
  challengeNonce?: string;
  challengeAudience?: string;
  challengeProtocolVersion?: string;
  capabilityDigest: string;
  lease?: PublicConnectionLease;
  negotiatedLimits: FabricProtocolLimits;
  advertisementRevision: number;
  lastHeartbeatAt: number;
  heartbeatSequence: number;
  phaseDeadlineAt: number;
  relayVersion?: typeof FABRIC_HUB_RELAY_VERSION;
  pendingOperationWrites: number;
  pendingControlWrites: number;
  queueDepth: number;
  tail: Promise<void>;
  readonly queuedActions: Set<QueuedAction>;
  authorityView?: FabricConnectorSession;
  authorityCleanupSuppressed: boolean;
  authorityCleanupState: CleanupState;
  authorityCleanupAttempt: number;
  authorityWatchdog?: NodeJS.Timeout;
  authorityRetryTimer?: NodeJS.Timeout;
  callbackCleanupState: CleanupState;
  callbackCleanupAttempt: number;
  callbackWatchdog?: NodeJS.Timeout;
  callbackRetryTimer?: NodeJS.Timeout;
  socketCleanupState: SocketCleanupState;
  socketCleanupTimer?: NodeJS.Timeout;
  socketCleanupPromise?: Promise<void>;
  resolveSocketCleanup?: () => void;
  retirementCleanupPromise?: Promise<void>;
  resolveRetirementCleanup?: () => void;
}

interface SessionContinuation {
  readonly sessionToken: string;
  readonly state: FabricConnectorState;
  readonly connectionId: string;
  readonly connectionGeneration: number;
  readonly advertisementRevision: number;
  readonly heartbeatSequence: number;
  readonly leaseRevision?: number;
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
  return { version: FABRIC_PROTOCOL_VERSION, messageId: randomUUID(), kind, sentAt: now(), ...extra, payload };
}

function frameBytes(data: RawData): number {
  return Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data), "utf8");
}

function textOf(data: RawData): string {
  return Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
}

function protocolLimits(value: JsonValue | undefined, hub: FabricProtocolLimits): FabricProtocolLimits {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FabricContractError("invalid_argument", "client_hello limits must be an object", "limits");
  }
  const input = value as Readonly<Record<string, JsonValue>>;
  const fields = [
    "maxFrameBytes", "maxInFlightOperations", "heartbeatIntervalMs",
    "heartbeatTimeoutMs", "maxAdvertisementItems", "maxResultBytes",
  ] as const;
  for (const field of fields) {
    if (typeof input[field] !== "number") {
      throw new FabricContractError("invalid_argument", `client_hello limits.${field} must be a number`, `limits.${field}`);
    }
  }
  const requested: FabricProtocolLimits = {
    maxFrameBytes: input.maxFrameBytes as number,
    maxInFlightOperations: input.maxInFlightOperations as number,
    heartbeatIntervalMs: input.heartbeatIntervalMs as number,
    heartbeatTimeoutMs: input.heartbeatTimeoutMs as number,
    maxAdvertisementItems: input.maxAdvertisementItems as number,
    maxResultBytes: input.maxResultBytes as number,
  };
  assertValidFabricProtocolLimits(requested);
  const negotiated = {
    maxFrameBytes: Math.min(requested.maxFrameBytes, hub.maxFrameBytes),
    maxInFlightOperations: Math.min(requested.maxInFlightOperations, hub.maxInFlightOperations),
    heartbeatIntervalMs: Math.min(requested.heartbeatIntervalMs, hub.heartbeatIntervalMs),
    heartbeatTimeoutMs: Math.min(requested.heartbeatTimeoutMs, hub.heartbeatTimeoutMs),
    maxAdvertisementItems: Math.min(requested.maxAdvertisementItems, hub.maxAdvertisementItems),
    maxResultBytes: Math.min(requested.maxResultBytes, hub.maxResultBytes),
  };
  assertValidFabricProtocolLimits(negotiated);
  return negotiated;
}

function utf8Bound(value: string, maxBytes: number): string {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

function safeContractMessage(error: FabricContractError): string {
  const sanitized = error.message.replace(/[\r\n\u0000-\u001f\u007f]+/gu, " ");
  return utf8Bound(sanitized, 512);
}

function assertAdmissionLease(
  lease: PublicConnectionLease,
  connectorId: string,
  capabilityDigest: string,
  now: number,
): void {
  assertFabricIdentifier(lease.connectionId, "lease.connectionId");
  assertFabricIdentifier(lease.deviceId, "lease.deviceId");
  assertFabricIdentifier(lease.connectorId, "lease.connectorId");
  assertGeneration(lease.generation, "lease.generation");
  if (lease.connectorId !== connectorId || lease.capabilityDigest !== capabilityDigest || lease.state !== "connected" ||
    !Number.isSafeInteger(lease.establishedAt) || lease.establishedAt > now ||
    !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= now ||
    !Number.isSafeInteger(lease.revision) || lease.revision < 0) {
    throw new FabricContractError("protocol_violation", "Fabric authority returned an invalid connection lease", "lease");
  }
}

export class FabricWssServer {
  readonly #options: FabricWssServerOptions;
  readonly #security: FabricConnectorSecurity;
  readonly #now: () => number;
  readonly #limits: FabricProtocolLimits;
  readonly #path: string;
  readonly #drainTimeoutMs: number;
  readonly #sessions = new Map<string, LiveSession>();
  readonly #liveByConnector = new Map<string, string>();
  readonly #legacyGenerations = new Map<string, number>();
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
      throw new FabricContractError("invalid_argument", "heartbeatTimeoutMs must exceed heartbeatIntervalMs, or a healthy Connector is fenced", "heartbeatTimeoutMs");
    }
    this.#wss = new WebSocketServer({ server: options.server, path: this.#path, maxPayload: this.#limits.maxFrameBytes });
    this.#wss.on("connection", (socket, request) => this.#onConnection(socket, request));
  }

  start(): void {
    if (this.#closed || this.#sweep !== undefined) return;
    this.#scheduleSweep();
  }

  sessions(): FabricConnectorSession[] {
    return [...this.#sessions.values()]
      .filter((session) => session.retirementState === "active")
      .map((session) => this.#view(session));
  }

  sessionOf(connectorId: string): FabricConnectorSession | undefined {
    const id = this.#liveByConnector.get(connectorId);
    const session = id === undefined ? undefined : this.#sessions.get(id);
    return session === undefined || session.retirementState !== "active" ? undefined : this.#view(session);
  }

  /** Abort retained remote Agent attempts after their durable Route has closed. */
  async closeRoute(routeId: string, reason: string): Promise<void> {
    assertFabricIdentifier(routeId, "routeId");
    await this.#options.relay?.closeRoute(routeId, reason);
  }

  /** Retire only sessions that proved or declared the named Connector identity. */
  async retireConnector(connectorId: string, reason = "the Connector registration changed"): Promise<boolean> {
    assertFabricIdentifier(connectorId, "connectorId");
    const owned = [...this.#sessions.values()].filter((session) =>
      session.retirementState !== "retired" &&
      (session.credential?.connectorId === connectorId || session.helloConnectorId === connectorId),
    );
    return this.#withinDeadline(
      Promise.all(owned.map(async (session) => {
        await this.#retire(session, reason);
        await this.#retirementCleanupPromise(session);
      })).then(() => undefined),
      this.#drainTimeoutMs,
    );
  }

  async close(reason = "the Hub is shutting down"): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#sweep !== undefined) clearTimeout(this.#sweep);
    this.#sweep = undefined;
    const deadlineAt = Date.now() + this.#drainTimeoutMs;
    const sessions = [...this.#sessions.values()];
    for (const session of sessions) {
      // Fence executable registrations and active relay owners synchronously,
      // before any peer-controlled drain or close wait begins.
      try { this.#options.relay?.retire(this.#view(session), reason); } catch { /* relay retirement is fail-closed */ }
      try {
        this.#sendDrain(session, reason);
      } catch (error) {
        void this.#retire(session, error instanceof FabricContractError ? safeContractMessage(error) : "Fabric drain could not be delivered");
      }
    }
    await this.#withinDeadline(
      Promise.all(sessions.map((session) => new Promise<void>((resolve) => {
        if (session.socket.readyState === session.socket.CLOSED) return resolve();
        session.socket.once("close", () => resolve());
      }))).then(() => undefined),
      Math.max(0, deadlineAt - Date.now()),
    );
    const retirements = sessions.map((session) => this.#retire(session, reason));
    await this.#withinDeadline(
      Promise.allSettled(retirements).then(() => undefined),
      Math.max(0, deadlineAt - Date.now()),
    );
    await this.#withinDeadline(
      new Promise<void>((resolve) => this.#wss.close(() => resolve())),
      Math.max(0, deadlineAt - Date.now()),
    );
  }

  #onConnection(socket: WebSocket, request: IncomingMessage): void {
    if (this.#closed || request.url === undefined) {
      socket.close(1012, "the Hub is shutting down");
      return;
    }
    const now = this.#now();
    const session: LiveSession = {
      key: randomUUID(), socket, sessionToken: randomUUID(), retirementState: "active",
      instanceNonce: "", state: "connecting", connectionId: "", connectionGeneration: 0,
      credentialGeneration: 0, helloConnectorId: "", capabilityDigest: "", negotiatedLimits: { ...this.#limits }, advertisementRevision: 0,
      lastHeartbeatAt: now, heartbeatSequence: 0, phaseDeadlineAt: now + this.#limits.heartbeatTimeoutMs,
      pendingOperationWrites: 0, pendingControlWrites: 0,
      queueDepth: 0, tail: Promise.resolve(), queuedActions: new Set(), authorityCleanupSuppressed: false,
      authorityCleanupState: "not_required", authorityCleanupAttempt: 0,
      callbackCleanupState: this.#options.onSessionClosed === undefined ? "not_required" : "pending", callbackCleanupAttempt: 0,
      socketCleanupState: "pending",
    };
    this.#sessions.set(session.key, session);
    this.#scheduleSweep();
    socket.on("message", (data, isBinary) => this.#ingest(session, data, isBinary));
    socket.on("close", () => this.#onSocketClosed(session));
    socket.on("error", () => { void this.#retire(session, "the Connector channel errored"); });
  }

  #ingest(session: LiveSession, data: RawData, isBinary: boolean): void {
    if (session.retirementState !== "active" || isBinary || frameBytes(data) > session.negotiatedLimits.maxFrameBytes) {
      this.#enqueue(session, () => this.#onMessage(session, data, isBinary));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(textOf(data));
      assertValidFabricEnvelope(parsed);
    } catch {
      this.#enqueue(session, () => this.#onMessage(session, data, isBinary));
      return;
    }
    if (parsed.kind !== "stream" && parsed.kind !== "receipt") {
      this.#enqueue(session, () => this.#onMessage(session, data, isBinary));
      return;
    }
    if (session.state !== "ready" || session.relayVersion !== FABRIC_HUB_RELAY_VERSION || this.#options.relay === undefined) {
      this.#failSessionOperation(session, new FabricContractError("invalid_state", "Hub relay message arrived before negotiated readiness"));
      return;
    }
    try {
      this.#options.relay.accept(this.#view(session), parsed);
    } catch (error) {
      this.#failSessionOperation(session, error);
    }
  }

  #enqueue(session: LiveSession, action: () => Promise<void>): void {
    if (session.retirementState !== "active") return;
    if (session.queueDepth >= session.negotiatedLimits.maxInFlightOperations) {
      this.#failSessionOperation(session, new FabricContractError("resource_exhausted", "Fabric session action queue is full"));
      return;
    }

    const queued: QueuedAction = { settled: false };
    const settle = (): boolean => {
      if (queued.settled) return false;
      queued.settled = true;
      if (queued.timer !== undefined) clearTimeout(queued.timer);
      session.queuedActions.delete(queued);
      session.queueDepth -= 1;
      return true;
    };
    const timeoutMs = Math.max(1, Math.min(this.#drainTimeoutMs, session.negotiatedLimits.heartbeatTimeoutMs));
    session.queueDepth += 1;
    session.queuedActions.add(queued);
    queued.timer = setTimeout(() => {
      if (!settle() || session.retirementState !== "active") return;
      this.#failSessionOperation(session, new FabricContractError("unavailable", "Fabric session operation timed out in the queue"));
    }, timeoutMs);
    queued.timer.unref?.();

    const run = async (): Promise<void> => {
      if (queued.settled || session.retirementState !== "active") {
        settle();
        return;
      }
      try {
        await action();
        settle();
      } catch (error) {
        if (settle()) this.#failSessionOperation(session, error);
      }
    };
    session.tail = session.tail.then(run, run);
  }

  #failSessionOperation(session: LiveSession, error: unknown): void {
    if (session.retirementState !== "active") return;
    try {
      const code = error instanceof FabricContractError ? error.code : "unavailable";
      const message = error instanceof FabricContractError ? safeContractMessage(error) : "Fabric session operation failed";
      this.#sendError(session, "error", code, message);
    } catch {
      try { session.socket.terminate(); } catch { /* retirement still fences the session */ }
    } finally {
      void this.#retire(session, "Fabric session operation failed");
    }
  }

  async #onMessage(session: LiveSession, data: RawData, isBinary: boolean): Promise<void> {
    if (session.retirementState !== "active") return;
    if (isBinary) return this.#reject(session, "binary", 1003, "protocol_violation", "Fabric frames must be JSON text");
    if (frameBytes(data) > session.negotiatedLimits.maxFrameBytes) {
      return this.#reject(session, "oversized", 1009, "resource_exhausted", "Fabric frame exceeds maxFrameBytes");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(textOf(data)); }
    catch { return this.#reject(session, "malformed", 1008, "protocol_violation", "Fabric frame is not valid JSON"); }
    try { assertValidFabricEnvelope(parsed); }
    catch (error) {
      return this.#reject(session, "malformed", 1008, "protocol_violation", error instanceof Error ? error.message : "Fabric frame is not a valid envelope");
    }
    const envelope = parsed;
    if (!ACCEPTED_KINDS[session.state].includes(envelope.kind)) {
      return this.#reject(session, "unexpected-kind", 1008, "invalid_state", `Fabric frame kind ${JSON.stringify(envelope.kind)} is not accepted while ${session.state}`);
    }
    try {
      await this.#handle(session, envelope);
    } catch (error) {
      const code = error instanceof FabricContractError ? error.code : "unavailable";
      const message = error instanceof FabricContractError ? safeContractMessage(error) : "Fabric authority operation failed";
      try {
        this.#sendError(session, envelope.kind, code, message, false, envelope);
      } finally {
        // Authority/callback failures are fatal for the serialized session, but
        // an already admitted durable lease must still take the independently
        // retryable close path.
        await this.#retire(session, "Fabric authority operation failed");
      }
    }
  }

  async #handle(session: LiveSession, envelope: FabricEnvelopeV1): Promise<void> {
    switch (envelope.kind) {
      case "client_hello": return this.#onHello(session, envelope);
      case "client_proof": return this.#onProof(session, envelope);
      case "advertise_snapshot": return this.#onSnapshot(session, envelope);
      case "advertise_delta": return this.#onDelta(session, envelope);
      case "heartbeat": return this.#onHeartbeat(session, envelope);
      case "stream":
      case "receipt":
        if (session.relayVersion !== FABRIC_HUB_RELAY_VERSION || this.#options.relay === undefined) {
          throw new FabricContractError("invalid_state", "Hub relay support was not negotiated", "kind");
        }
        this.#options.relay.accept(this.#view(session), envelope);
        return;
      case "drain": return this.#onDrain(session, envelope);
      case "close": return this.#retire(session, "the Connector closed the channel");
      default: throw new FabricContractError("invalid_state", "Unsupported Fabric frame", "kind");
    }
  }

  async #onHello(session: LiveSession, envelope: FabricEnvelopeV1): Promise<void> {
    const connectorId = envelope.payload.connectorId;
    const instanceNonce = envelope.payload.instanceNonce;
    const credentialGeneration = envelope.payload.credentialGeneration;
    const supportedVersions = envelope.payload.supportedVersions;
    const capabilityDigest = envelope.payload.capabilityDigest;
    const relayVersions = envelope.payload.relayVersions;
    assertFabricIdentifier(connectorId, "connectorId");
    assertBoundedString(instanceNonce, "instanceNonce", 128);
    assertGeneration(credentialGeneration, "credentialGeneration");
    assertBoundedString(capabilityDigest, "capabilityDigest", 256);
    if (instanceNonce.length === 0 || capabilityDigest.length === 0) {
      throw new FabricContractError("invalid_argument", "client_hello nonce and capability digest must be non-empty", "payload");
    }
    if (!Array.isArray(supportedVersions) || supportedVersions.length === 0 ||
      supportedVersions.some((version) => typeof version !== "string") ||
      !supportedVersions.includes(FABRIC_PROTOCOL_VERSION)) {
      throw new FabricContractError("unsupported_version", "client_hello must support fabric.v1", "supportedVersions");
    }
    if (relayVersions !== undefined) assertValidFabricHubRelayVersions(relayVersions, "relayVersions");
    const negotiatedLimits = protocolLimits(envelope.payload.limits, this.#limits);
    const challenge = this.#security.issueChallenge(connectorId);
    session.state = "challenged";
    session.helloConnectorId = connectorId;
    session.instanceNonce = instanceNonce;
    session.credentialGeneration = credentialGeneration;
    session.challengeId = challenge.challengeId;
    session.challengeNonce = challenge.challengeNonce;
    session.challengeAudience = challenge.audience;
    session.challengeProtocolVersion = challenge.protocolVersion;
    session.credential = undefined;
    session.capabilityDigest = capabilityDigest;
    session.negotiatedLimits = negotiatedLimits;
    session.relayVersion = this.#options.relay !== undefined && Array.isArray(relayVersions) && relayVersions.includes(FABRIC_HUB_RELAY_VERSION)
      ? FABRIC_HUB_RELAY_VERSION
      : undefined;
    session.phaseDeadlineAt = Math.min(challenge.expiresAt, this.#now() + negotiatedLimits.heartbeatTimeoutMs);
    this.#scheduleSweep();
    this.#send(session, envelopeOf("server_challenge", {
      challengeId: challenge.challengeId, challengeNonce: challenge.challengeNonce, audience: challenge.audience,
      protocolVersion: challenge.protocolVersion, expiresAt: challenge.expiresAt,
    }, this.#now, { correlationId: envelope.messageId, ...(envelope.operationId === undefined ? {} : { operationId: envelope.operationId }) }));
  }

  async #onProof(session: LiveSession, envelope: FabricEnvelopeV1): Promise<void> {
    if (session.challengeId === undefined || session.challengeNonce === undefined ||
      session.challengeAudience === undefined || session.challengeProtocolVersion === undefined) {
      throw new FabricContractError("invalid_state", "No Fabric challenge is outstanding", "kind");
    }
    const payload = envelope.payload;
    if (typeof payload.challengeId !== "string" || typeof payload.connectorId !== "string" ||
      typeof payload.instanceNonce !== "string" || typeof payload.challengeNonce !== "string" ||
      typeof payload.audience !== "string" || typeof payload.protocolVersion !== "string" ||
      typeof payload.credentialGeneration !== "number" || typeof payload.signature !== "string") {
      throw new FabricContractError("invalid_argument", "client_proof is missing a required proof field", "payload");
    }
    if (payload.challengeId !== session.challengeId || payload.connectorId !== session.helloConnectorId ||
      payload.instanceNonce !== session.instanceNonce || payload.challengeNonce !== session.challengeNonce ||
      payload.audience !== session.challengeAudience || payload.protocolVersion !== session.challengeProtocolVersion ||
      payload.credentialGeneration !== session.credentialGeneration) {
      throw new FabricContractError("unauthenticated", "client_proof does not match this socket challenge", "payload");
    }
    const proof: FabricChallengeProofV1 = {
      version: FABRIC_CHALLENGE_PROOF_VERSION,
      challengeId: payload.challengeId,
      connectorId: payload.connectorId,
      instanceNonce: payload.instanceNonce,
      challengeNonce: payload.challengeNonce,
      audience: payload.audience,
      protocolVersion: payload.protocolVersion,
      credentialGeneration: payload.credentialGeneration,
      signature: payload.signature,
    };
    const credential = this.#security.verifyProof(proof);
    const admittedAt = this.#now();
    const continuation = this.#continuation(session);
    let lease: PublicConnectionLease;
    if (this.#options.authority !== undefined) {
      // Fence retirement completion while allocation is outstanding: admit may
      // create durable authority before its promise publishes the lease here.
      session.authorityCleanupState = "pending";
      try {
        lease = await this.#options.authority.admit({
          requestId: envelope.messageId,
          connectorId: credential.connectorId,
          expectedCredentialGeneration: credential.credentialGeneration,
          connectorInstanceNonce: session.instanceNonce,
          capabilityDigest: session.capabilityDigest,
          limits: session.negotiatedLimits,
          establishedAt: admittedAt,
          expiresAt: admittedAt + session.negotiatedLimits.heartbeatTimeoutMs,
        }, { close: async (reason) => this.#closeOwned(session, reason) });
      } catch (error) {
        session.authorityCleanupState = "not_required";
        this.#tryCompleteRetirement(session);
        throw error;
      }
      assertAdmissionLease(lease, credential.connectorId, session.capabilityDigest, this.#now());
      // Retain cleanup authority before checking the continuation. If shutdown
      // fenced this socket while admit awaited, the newly durable lease still
      // has an idempotently retryable close path without becoming live locally.
      session.authorityView = {
        connectorId: credential.connectorId,
        deviceId: lease.deviceId,
        connectionId: lease.connectionId,
        connectionGeneration: lease.generation,
        instanceNonce: session.instanceNonce,
        state: "connected",
        advertisementRevision: 0,
        lastHeartbeatAt: admittedAt,
        current: false,
        negotiatedLimits: { ...session.negotiatedLimits },
      };
      this.#assertContinuation(session, continuation);
    } else {
      const previousId = this.#liveByConnector.get(credential.connectorId);
      if (previousId !== undefined && previousId !== session.key) {
        const previous = this.#sessions.get(previousId);
        if (previous !== undefined) {
          this.#sendError(previous, "client_proof", "stale_generation", "A newer connection superseded this generation");
          await this.#retire(previous, "superseded by a newer connection generation", false);
          this.#assertContinuation(session, continuation);
        }
      }
      this.#assertContinuation(session, continuation);
      const generation = (this.#legacyGenerations.get(credential.connectorId) ?? 0) + 1;
      this.#legacyGenerations.set(credential.connectorId, generation);
      lease = {
        connectionId: `connection-${credential.connectorId}-${generation}`,
        deviceId: credential.connectorId,
        connectorId: credential.connectorId,
        generation,
        state: "connected",
        capabilityDigest: session.capabilityDigest,
        establishedAt: admittedAt,
        expiresAt: admittedAt + session.negotiatedLimits.heartbeatTimeoutMs,
        revision: 0,
      };
    }
    session.lease = { ...lease };
    session.connectionId = lease.connectionId;
    session.connectionGeneration = lease.generation;
    session.credential = credential;
    session.state = "connected";
    session.lastHeartbeatAt = this.#now();
    session.phaseDeadlineAt = lease.expiresAt;
    this.#liveByConnector.set(credential.connectorId, session.key);
    session.authorityView = this.#view(session);
    this.#scheduleSweep();
    this.#options.relay?.accepted(this.#view(session), {
      send: (outgoing, priority) => this.#send(session, outgoing, priority),
      get bufferedAmount(): number { return session.socket.bufferedAmount; },
    });
    this.#send(session, envelopeOf("connection_accepted", {
      connectionId: session.connectionId, connectionGeneration: session.connectionGeneration,
      connectorId: credential.connectorId, lease: lease as unknown as JsonValue,
      limits: session.negotiatedLimits as unknown as JsonValue,
      ...(session.relayVersion === undefined ? {} : {
        relayVersion: session.relayVersion,
        hubRuntimeEpoch: this.#options.relay!.hubRuntimeEpoch,
      }),
    }, this.#now, {
      connectionId: session.connectionId,
      connectionGeneration: session.connectionGeneration,
      correlationId: envelope.messageId,
      ...(envelope.operationId === undefined ? {} : { operationId: envelope.operationId }),
    }));
  }

  async #onSnapshot(session: LiveSession, envelope: FabricEnvelopeV1): Promise<void> {
    const revision = envelope.payload.advertisementRevision;
    if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
      throw new FabricContractError("invalid_argument", "advertise_snapshot must carry a positive revision", "advertisementRevision");
    }
    let continuation = this.#continuation(session);
    await this.#options.authority?.acceptSnapshot(this.#view(session), envelope.payload);
    this.#assertContinuation(session, continuation);
    session.advertisementRevision = revision as number;
    session.state = "ready";
    session.lastHeartbeatAt = this.#now();
    session.phaseDeadlineAt = session.lease?.expiresAt ?? session.lastHeartbeatAt + session.negotiatedLimits.heartbeatTimeoutMs;
    continuation = this.#continuation(session);
    await this.#options.onAdvertisement?.(this.#view(session), session.advertisementRevision, envelope.payload);
    this.#assertContinuation(session, continuation);
    if (this.#now() >= session.phaseDeadlineAt) {
      throw new FabricContractError("expired", "Fabric connection expired before readiness was published", "leaseExpiresAt");
    }
    if (session.relayVersion === FABRIC_HUB_RELAY_VERSION) this.#options.relay?.ready(this.#view(session), envelope.payload);
    const leaseExpiresAt = session.lease?.expiresAt ?? session.phaseDeadlineAt;
    this.#scheduleSweep();
    this.#send(session, envelopeOf("ready", {
      connectionId: session.connectionId, connectionGeneration: session.connectionGeneration,
      advertisementRevision: session.advertisementRevision, leaseExpiresAt,
      ...(session.relayVersion === undefined ? {} : { relayVersion: session.relayVersion }),
    }, this.#now, {
      connectionId: session.connectionId,
      connectionGeneration: session.connectionGeneration,
      correlationId: envelope.messageId,
      ...(envelope.operationId === undefined ? {} : { operationId: envelope.operationId }),
    }));
    continuation = this.#continuation(session);
    await this.#options.onReady?.(this.#view(session));
    this.#assertContinuation(session, continuation);
  }

  async #onDelta(session: LiveSession, envelope: FabricEnvelopeV1): Promise<void> {
    const base = envelope.payload.baseRevision;
    if (!Number.isSafeInteger(base) || (base as number) < 0) {
      throw new FabricContractError("invalid_argument", "advertise_delta must carry a base revision", "baseRevision");
    }
    if (base !== session.advertisementRevision) {
      this.#sendError(session, "advertise_delta", "conflict", "Advertisement base revision is stale; resend a snapshot", true, envelope);
      return;
    }
    const revision = envelope.payload.advertisementRevision;
    if (!Number.isSafeInteger(revision) || (revision as number) <= session.advertisementRevision) {
      throw new FabricContractError("invalid_argument", "advertise_delta must advance the revision", "advertisementRevision");
    }
    let continuation = this.#continuation(session);
    await this.#options.authority?.acceptDelta(this.#view(session), envelope.payload);
    this.#assertContinuation(session, continuation);
    session.advertisementRevision = revision as number;
    continuation = this.#continuation(session);
    await this.#options.onAdvertisement?.(this.#view(session), session.advertisementRevision, envelope.payload);
    this.#assertContinuation(session, continuation);
    if (session.relayVersion === FABRIC_HUB_RELAY_VERSION) this.#options.relay?.advertisement(this.#view(session), envelope.payload);
  }

  async #onHeartbeat(session: LiveSession, envelope: FabricEnvelopeV1): Promise<void> {
    if (envelope.connectionId !== session.connectionId || envelope.connectionGeneration !== session.connectionGeneration) {
      throw new FabricContractError("stale_generation", "Fabric heartbeat does not match this connection generation", "connectionGeneration");
    }
    const sequence = envelope.payload.sequence;
    if (!Number.isSafeInteger(sequence) || (sequence as number) <= session.heartbeatSequence) {
      throw new FabricContractError("invalid_argument", "Fabric heartbeat sequence must be strictly increasing within a generation", "sequence");
    }
    const observedAt = this.#now();
    const leaseExpiresAt = observedAt + session.negotiatedLimits.heartbeatTimeoutMs;
    const continuation = this.#continuation(session);
    await this.#options.authority?.heartbeat(this.#view(session), { sequence: sequence as number, observedAt, leaseExpiresAt });
    this.#assertContinuation(session, continuation);
    session.heartbeatSequence = sequence as number;
    session.lastHeartbeatAt = observedAt;
    session.phaseDeadlineAt = leaseExpiresAt;
    if (session.lease !== undefined) {
      session.lease = { ...session.lease, expiresAt: leaseExpiresAt, revision: session.lease.revision + 1 };
    }
    this.#scheduleSweep();
    this.#send(session, envelopeOf("heartbeat_ack", { sequence: session.heartbeatSequence, leaseExpiresAt }, this.#now, {
      connectionId: session.connectionId,
      connectionGeneration: session.connectionGeneration,
      correlationId: envelope.messageId,
      ...(envelope.operationId === undefined ? {} : { operationId: envelope.operationId }),
    }));
  }

  async #onDrain(session: LiveSession, envelope: FabricEnvelopeV1): Promise<void> {
    const reason = typeof envelope.payload.reason === "string"
      ? envelope.payload.reason.replace(/[\r\n\u0000-\u001f\u007f]/gu, " ").slice(0, 256)
      : "the Connector is draining";
    const now = this.#now();
    const deadlineAt = Math.min(now + this.#drainTimeoutMs, session.lease?.expiresAt ?? Number.MAX_SAFE_INTEGER);
    if (deadlineAt <= now) throw new FabricContractError("expired", "Fabric lease expired before drain admission", "deadlineAt");
    // Relay admission is fenced synchronously even though durable drain
    // authority remains awaited before the public WSS state advances.
    try { this.#options.relay?.retire(this.#view(session), reason); } catch { /* fail closed */ }
    const continuation = this.#continuation(session);
    await this.#options.authority?.drain(this.#view(session), deadlineAt, reason);
    this.#assertContinuation(session, continuation);
    session.state = "draining";
    session.phaseDeadlineAt = deadlineAt;
    this.#scheduleSweep();
    this.#sendDrain(session, reason, deadlineAt);
  }

  #sendDrain(session: LiveSession, reason: string, deadlineAt = this.#now() + this.#drainTimeoutMs): void {
    if (session.retirementState !== "active") return;
    const safeReason = reason.replace(/[\r\n\u0000-\u001f\u007f]/gu, " ").slice(0, 256);
    this.#send(session, envelopeOf("drain", { reason: safeReason, deadlineAt }, this.#now, {
      ...(session.connectionId === "" ? {} : { connectionId: session.connectionId }),
      ...(session.connectionGeneration === 0 ? {} : { connectionGeneration: session.connectionGeneration }),
    }));
  }

  #sweepLeases(): void {
    const now = this.#now();
    for (const session of [...this.#sessions.values()]) {
      if (session.retirementState !== "active") continue;
      if (session.phaseDeadlineAt <= now) {
        const reason = session.state === "draining" ? "the drain window closed"
          : session.state === "ready" ? "heartbeat lease expired"
          : "Fabric handshake phase expired";
        this.#enqueue(session, () => this.#retire(session, reason));
      }
    }
  }

  #scheduleSweep(): void {
    if (this.#closed) return;
    if (this.#sweep !== undefined) clearTimeout(this.#sweep);
    const now = this.#now();
    let delay = this.#limits.heartbeatIntervalMs;
    for (const session of this.#sessions.values()) {
      if (session.retirementState === "active") delay = Math.min(delay, Math.max(1, session.phaseDeadlineAt - now));
    }
    this.#sweep = setTimeout(() => {
      this.#sweep = undefined;
      this.#sweepLeases();
      this.#scheduleSweep();
    }, Math.min(2_147_483_647, delay));
    this.#sweep.unref?.();
  }

  async #withinDeadline(promise: Promise<void>, ms: number): Promise<boolean> {
    if (ms <= 0) return false;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #continuation(session: LiveSession): SessionContinuation {
    return {
      sessionToken: session.sessionToken,
      state: session.state,
      connectionId: session.connectionId,
      connectionGeneration: session.connectionGeneration,
      advertisementRevision: session.advertisementRevision,
      heartbeatSequence: session.heartbeatSequence,
      ...(session.lease === undefined ? {} : { leaseRevision: session.lease.revision }),
    };
  }

  #assertContinuation(session: LiveSession, expected: SessionContinuation): void {
    if (session.sessionToken !== expected.sessionToken || session.retirementState !== "active" ||
      this.#sessions.get(session.key) !== session || session.state !== expected.state ||
      session.connectionId !== expected.connectionId || session.connectionGeneration !== expected.connectionGeneration ||
      session.advertisementRevision !== expected.advertisementRevision || session.heartbeatSequence !== expected.heartbeatSequence ||
      session.lease?.revision !== expected.leaseRevision) {
      throw new FabricContractError("stale_generation", "Fabric session changed while an operation awaited", "connectionId");
    }
    if (session.credential !== undefined && this.#liveByConnector.get(session.credential.connectorId) !== session.key) {
      throw new FabricContractError("stale_generation", "Fabric session is no longer the live Connector generation", "connectionGeneration");
    }
    if (session.lease !== undefined && session.lease.expiresAt <= this.#now()) {
      throw new FabricContractError("expired", "Fabric connection lease expired while an operation awaited", "leaseExpiresAt");
    }
  }

  async #closeOwned(session: LiveSession, reason: string): Promise<void> {
    await this.#retire(session, reason);
  }

  #retire(session: LiveSession, reason: string, notifyAuthority = true, closeCode = 1000): Promise<void> {
    if (!notifyAuthority) {
      session.authorityCleanupSuppressed = true;
      session.authorityCleanupState = "not_required";
      if (session.authorityWatchdog !== undefined) clearTimeout(session.authorityWatchdog);
      if (session.authorityRetryTimer !== undefined) clearTimeout(session.authorityRetryTimer);
      session.authorityWatchdog = undefined;
      session.authorityRetryTimer = undefined;
    }
    if (session.retirementState === "active") {
      // Synchronously remove executable registrations before any authority,
      // callback, or socket cleanup is awaited or scheduled.
      try { this.#options.relay?.retire(this.#view(session), reason); } catch { /* relay retirement is fail-closed */ }
      session.retirementState = "retiring";
      session.retirementReason = reason;
      session.state = "closed";
      if (session.credential !== undefined && this.#liveByConnector.get(session.credential.connectorId) === session.key) {
        this.#liveByConnector.delete(session.credential.connectorId);
      }
      for (const queued of session.queuedActions) {
        queued.settled = true;
        if (queued.timer !== undefined) clearTimeout(queued.timer);
      }
      session.queuedActions.clear();
      session.queueDepth = 0;
      const authorityView = session.authorityView ??
        (session.credential !== undefined && session.connectionId !== "" && session.connectionGeneration > 0
          ? this.#view(session)
          : undefined);
      if (!session.authorityCleanupSuppressed && authorityView !== undefined && this.#options.authority !== undefined) {
        session.authorityView = authorityView;
        session.authorityCleanupState = "pending";
      }
      this.#startAuthorityCleanup(session);
      this.#startCallbackCleanup(session);
      this.#startSocketCleanup(session, closeCode);
      this.#scheduleSweep();
    } else if (session.retirementState === "retiring") {
      this.#startAuthorityCleanup(session);
      this.#startCallbackCleanup(session);
      this.#startSocketCleanup(session, closeCode);
    }
    this.#tryCompleteRetirement(session);
    return this.#socketCleanupPromise(session);
  }

  #socketCleanupPromise(session: LiveSession): Promise<void> {
    if (session.socketCleanupState === "succeeded") return Promise.resolve();
    if (session.socketCleanupPromise === undefined) {
      session.socketCleanupPromise = new Promise<void>((resolve) => { session.resolveSocketCleanup = resolve; });
    }
    return session.socketCleanupPromise;
  }

  #retirementCleanupPromise(session: LiveSession): Promise<void> {
    if (session.retirementState === "retired") return Promise.resolve();
    if (session.retirementCleanupPromise === undefined) {
      session.retirementCleanupPromise = new Promise<void>((resolve) => { session.resolveRetirementCleanup = resolve; });
    }
    return session.retirementCleanupPromise;
  }

  #startSocketCleanup(session: LiveSession, closeCode: number): void {
    if (session.socketCleanupState === "succeeded") return;
    void this.#socketCleanupPromise(session);
    if (session.socket.readyState === session.socket.CLOSED) {
      this.#markSocketClosed(session);
      return;
    }
    if (session.socketCleanupState === "pending") {
      if (session.socket.readyState === session.socket.OPEN) {
        session.socketCleanupState = "closing";
        try {
          session.socket.close(closeCode, utf8Bound(session.retirementReason ?? "Fabric session retired", 123));
        } catch {
          this.#terminateSocket(session);
        }
      } else {
        this.#terminateSocket(session);
      }
    }
    this.#scheduleSocketTerminate(session);
  }

  #scheduleSocketTerminate(session: LiveSession): void {
    if (session.socketCleanupState === "succeeded" || session.socketCleanupTimer !== undefined) return;
    session.socketCleanupTimer = setTimeout(() => {
      session.socketCleanupTimer = undefined;
      if (session.socketCleanupState !== "succeeded") this.#terminateSocket(session);
    }, this.#cleanupWatchdogMs());
    session.socketCleanupTimer.unref?.();
  }

  #terminateSocket(session: LiveSession): void {
    if (session.socketCleanupState === "succeeded") return;
    session.socketCleanupState = "terminating";
    try {
      session.socket.terminate();
    } catch {
      session.socketCleanupState = "pending";
    }
    this.#scheduleSocketTerminate(session);
  }

  #onSocketClosed(session: LiveSession): void {
    this.#markSocketClosed(session);
    if (session.retirementState === "active") void this.#retire(session, "the Connector closed the channel");
  }

  #markSocketClosed(session: LiveSession): void {
    if (session.socketCleanupState === "succeeded") return;
    session.socketCleanupState = "succeeded";
    if (session.socketCleanupTimer !== undefined) clearTimeout(session.socketCleanupTimer);
    session.socketCleanupTimer = undefined;
    session.resolveSocketCleanup?.();
    session.resolveSocketCleanup = undefined;
    this.#tryCompleteRetirement(session);
  }

  #startAuthorityCleanup(session: LiveSession): void {
    if (session.retirementState !== "retiring" || session.authorityCleanupState !== "pending" ||
      session.authorityView === undefined || this.#options.authority === undefined) return;
    session.authorityCleanupState = "running";
    const attempt = ++session.authorityCleanupAttempt;
    session.authorityWatchdog = setTimeout(() => {
      session.authorityWatchdog = undefined;
      if (session.authorityCleanupState !== "running" || session.authorityCleanupAttempt !== attempt) return;
      session.authorityCleanupState = "pending";
      this.#scheduleAuthorityRetry(session);
    }, this.#cleanupWatchdogMs());
    session.authorityWatchdog.unref?.();
    void Promise.resolve()
      .then(() => this.#options.authority!.close(session.authorityView!, session.retirementReason ?? "Fabric session retired"))
      .then(() => {
        if (session.authorityCleanupState === "succeeded") return;
        session.authorityCleanupState = "succeeded";
        if (session.authorityWatchdog !== undefined) clearTimeout(session.authorityWatchdog);
        if (session.authorityRetryTimer !== undefined) clearTimeout(session.authorityRetryTimer);
        session.authorityWatchdog = undefined;
        session.authorityRetryTimer = undefined;
        this.#tryCompleteRetirement(session);
      }, () => {
        if (session.authorityCleanupState !== "running" || session.authorityCleanupAttempt !== attempt) return;
        if (session.authorityWatchdog !== undefined) clearTimeout(session.authorityWatchdog);
        session.authorityWatchdog = undefined;
        session.authorityCleanupState = "pending";
        this.#scheduleAuthorityRetry(session);
      });
  }

  #scheduleAuthorityRetry(session: LiveSession): void {
    if (session.authorityCleanupState !== "pending" || session.authorityRetryTimer !== undefined) return;
    session.authorityRetryTimer = setTimeout(() => {
      session.authorityRetryTimer = undefined;
      this.#startAuthorityCleanup(session);
    }, this.#cleanupWatchdogMs());
    session.authorityRetryTimer.unref?.();
  }

  #startCallbackCleanup(session: LiveSession): void {
    if (session.retirementState !== "retiring" || session.callbackCleanupState !== "pending" ||
      this.#options.onSessionClosed === undefined) return;
    session.callbackCleanupState = "running";
    const attempt = ++session.callbackCleanupAttempt;
    session.callbackWatchdog = setTimeout(() => {
      session.callbackWatchdog = undefined;
      if (session.callbackCleanupState !== "running" || session.callbackCleanupAttempt !== attempt) return;
      session.callbackCleanupState = "pending";
      this.#scheduleCallbackRetry(session);
    }, this.#cleanupWatchdogMs());
    session.callbackWatchdog.unref?.();
    void Promise.resolve()
      .then(() => this.#options.onSessionClosed!(this.#view(session), session.retirementReason ?? "Fabric session retired"))
      .then(() => {
        if (session.callbackCleanupState === "succeeded") return;
        session.callbackCleanupState = "succeeded";
        if (session.callbackWatchdog !== undefined) clearTimeout(session.callbackWatchdog);
        if (session.callbackRetryTimer !== undefined) clearTimeout(session.callbackRetryTimer);
        session.callbackWatchdog = undefined;
        session.callbackRetryTimer = undefined;
        this.#tryCompleteRetirement(session);
      }, () => {
        if (session.callbackCleanupState !== "running" || session.callbackCleanupAttempt !== attempt) return;
        if (session.callbackWatchdog !== undefined) clearTimeout(session.callbackWatchdog);
        session.callbackWatchdog = undefined;
        session.callbackCleanupState = "pending";
        this.#scheduleCallbackRetry(session);
      });
  }

  #scheduleCallbackRetry(session: LiveSession): void {
    if (session.callbackCleanupState !== "pending" || session.callbackRetryTimer !== undefined) return;
    session.callbackRetryTimer = setTimeout(() => {
      session.callbackRetryTimer = undefined;
      this.#startCallbackCleanup(session);
    }, this.#cleanupWatchdogMs());
    session.callbackRetryTimer.unref?.();
  }

  #cleanupWatchdogMs(): number {
    return Math.max(1, Math.min(100, this.#drainTimeoutMs));
  }

  #tryCompleteRetirement(session: LiveSession): void {
    if (session.retirementState !== "retiring" || session.socketCleanupState !== "succeeded" ||
      (session.authorityCleanupState !== "succeeded" && session.authorityCleanupState !== "not_required") ||
      (session.callbackCleanupState !== "succeeded" && session.callbackCleanupState !== "not_required")) return;
    session.retirementState = "retired";
    session.resolveRetirementCleanup?.();
    session.resolveRetirementCleanup = undefined;
    if (this.#sessions.get(session.key) === session) this.#sessions.delete(session.key);
  }

  #view(session: LiveSession): FabricConnectorSession {
    return {
      connectorId: session.credential?.connectorId ?? "", deviceId: session.lease?.deviceId ?? "", connectionId: session.connectionId,
      connectionGeneration: session.connectionGeneration, instanceNonce: session.instanceNonce, state: session.state,
      advertisementRevision: session.advertisementRevision, lastHeartbeatAt: session.lastHeartbeatAt,
      current: session.credential !== undefined && this.#liveByConnector.get(session.credential.connectorId) === session.key,
      negotiatedLimits: { ...session.negotiatedLimits },
      ...(session.relayVersion === undefined ? {} : { relayVersion: session.relayVersion }),
    };
  }

  #sendError(
    session: LiveSession,
    kind: FabricMessageKind,
    code: string,
    message: string,
    retryable = false,
    source?: FabricEnvelopeV1,
  ): void {
    this.#send(session, envelopeOf("error", { code, message, kind, retryable }, this.#now, {
      ...(session.connectionId === "" ? {} : { connectionId: session.connectionId }),
      ...(session.connectionGeneration === 0 ? {} : { connectionGeneration: session.connectionGeneration }),
      ...(source === undefined ? {} : { correlationId: source.messageId }),
      ...(source?.operationId === undefined ? {} : { operationId: source.operationId }),
    }));
  }

  async #reject(session: LiveSession, label: string, closeCode: number, code: string, message: string): Promise<void> {
    try {
      this.#sendError(session, "error", code, message);
    } finally {
      await this.#retire(session, label, true, closeCode);
    }
  }

  #send(session: LiveSession, envelope: FabricEnvelopeV1, priority: "operation" | "control" = "control"): void {
    if (session.socket.readyState !== session.socket.OPEN || session.retirementState !== "active") {
      if (priority === "operation") throw new FabricContractError("unavailable", "Fabric Connector socket is not open");
      return;
    }
    const text = JSON.stringify(envelope);
    const textBytes = Buffer.byteLength(text, "utf8");
    if (textBytes > session.negotiatedLimits.maxFrameBytes) {
      throw new FabricContractError("resource_exhausted", "Fabric frame exceeds maxFrameBytes", "maxFrameBytes");
    }
    const operationCapacity = session.negotiatedLimits.maxInFlightOperations;
    const controlCapacity = 3;
    const operationBufferedLimit = session.negotiatedLimits.maxFrameBytes * operationCapacity;
    const controlBufferedLimit = session.negotiatedLimits.maxFrameBytes * (operationCapacity + controlCapacity);
    if ((priority === "operation" && (session.pendingOperationWrites >= operationCapacity || session.socket.bufferedAmount > operationBufferedLimit)) ||
      (priority === "control" && (session.pendingControlWrites >= controlCapacity || session.socket.bufferedAmount > controlBufferedLimit))) {
      throw new FabricContractError("resource_exhausted", "Fabric Connector send backpressure limit is exceeded", "bufferedAmount");
    }
    if (priority === "operation") session.pendingOperationWrites += 1;
    else session.pendingControlWrites += 1;
    const releaseWrite = (): void => {
      if (priority === "operation") session.pendingOperationWrites = Math.max(0, session.pendingOperationWrites - 1);
      else session.pendingControlWrites = Math.max(0, session.pendingControlWrites - 1);
    };
    try {
      session.socket.send(text, (error) => {
        releaseWrite();
        if (error && session.retirementState === "active") {
          this.#failSessionOperation(session, new FabricContractError("unavailable", "Fabric Connector send failed"));
        }
      });
    } catch (error) {
      releaseWrite();
      throw error;
    }
  }
}
