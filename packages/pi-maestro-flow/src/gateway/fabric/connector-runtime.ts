import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  FABRIC_HUB_RELAY_VERSION,
  FABRIC_PROTOCOL_VERSION,
  FabricContractError,
  assertValidFabricEnvelope,
  assertValidFabricProtocolLimits,
  type FabricEnvelopeV1,
  type FabricProtocolLimits,
  type JsonValue,
} from "pi-maestro-fabric-core/v1";
import { fabricChallengeProofPayload } from "./security.ts";
import {
  FabricDeviceRelayOwner,
  type FabricDeviceRelayExecutionHandler,
  type FabricHubRelayLimits,
} from "./hub-relay.ts";

const CONNECTOR_LIMITS: FabricProtocolLimits = Object.freeze({
  maxFrameBytes: 256 * 1024,
  maxInFlightOperations: 32,
  heartbeatIntervalMs: 10_000,
  heartbeatTimeoutMs: 30_000,
  maxAdvertisementItems: 1_024,
  maxResultBytes: 1024 * 1024,
});

export const FABRIC_CONNECTOR_RUNTIME_STATES = ["idle", "connecting", "ready", "draining", "closed"] as const;
export type FabricConnectorRuntimeState = (typeof FABRIC_CONNECTOR_RUNTIME_STATES)[number];

export interface FabricConnectorAdvertisement {
  readonly advertisementRevision: number;
  readonly capabilityDigest: string;
  readonly payload: Readonly<Record<string, JsonValue>>;
}

export interface FabricConnectorRuntimeOptions {
  /** `wss://host:port/path` of the Hub's Connector endpoint. */
  readonly url: string;
  readonly connectorId: string;
  readonly keyId: string;
  readonly audience: string;
  /** This Connector's enrolled credential generation; a proof names it. */
  readonly credentialGeneration: number;
  /**
   * Signs the canonical proof payload. The private key stays with the caller:
   * this runtime never holds or reads key material.
   */
  readonly sign: (payload: string) => string;
  readonly ca?: Buffer | string;
  readonly limits?: Partial<FabricProtocolLimits>;
  readonly now?: () => number;
  readonly instanceNonce?: string;
  readonly connectTimeoutMs?: number;
  readonly reconnectDelayMs?: number;
  readonly maxReconnectAttempts?: number;
  readonly advertisementOf?: () => FabricConnectorAdvertisement;
  /** Optional T4 Device Agent bridge. Its presence advertises relay support. */
  readonly relayHandler?: FabricDeviceRelayExecutionHandler;
  readonly relayLimits?: Partial<FabricHubRelayLimits>;
  readonly onConnected?: (info: { connectionId: string; connectionGeneration: number }) => void;
  readonly onReady?: (info: { connectionId: string; connectionGeneration: number; advertisementRevision: number }) => void;
  readonly onDrain?: (reason: string) => void;
  readonly onError?: (message: string) => void;
  readonly onClosed?: (reason: string) => void;
}

interface PendingStart {
  resolve: () => void;
  reject: (error: Error) => void;
}

function positive(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new FabricContractError("invalid_argument", `${label} must be a positive safe integer`, label);
  }
  return result;
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

/**
 * Connector side of the outbound WSS control channel.
 *
 * The Connector dials the Hub, proves possession of its enrolled key, publishes
 * one advertisement snapshot, then keeps the connection's lease alive with
 * strictly increasing heartbeats. A missing acknowledgement, a fence, or a lost
 * socket reconnects under a fresh instance nonce, which is what makes a
 * reconnect a new generation rather than a revival of the old one.
 */
export class FabricConnectorRuntime {
  readonly #options: FabricConnectorRuntimeOptions;
  readonly #now: () => number;
  readonly #limits: FabricProtocolLimits;
  #negotiatedLimits: FabricProtocolLimits;
  readonly #connectTimeoutMs: number;
  readonly #reconnectDelayMs: number;
  readonly #maxReconnectAttempts: number;
  readonly #ca?: Buffer | string;
  #socket?: WebSocket;
  #state: FabricConnectorRuntimeState = "idle";
  #instanceNonce: string;
  #connectionId = "";
  #connectionGeneration = 0;
  #advertisementRevision = 0;
  #pendingAdvertisement?: FabricConnectorAdvertisement;
  #heartbeatSequence = 0;
  #heartbeatTimer?: NodeJS.Timeout;
  #awaitingAck = false;
  #reconnectTimer?: NodeJS.Timeout;
  #reconnectAttempts = 0;
  #pending?: PendingStart;
  #relayOwner?: FabricDeviceRelayOwner;
  #pendingOperationWrites = 0;
  #pendingControlWrites = 0;
  #stopRequested = false;
  #attemptToken = 0;
  #failedAttemptToken = 0;

  constructor(options: FabricConnectorRuntimeOptions) {
    if (!options.url.startsWith("wss://")) {
      throw new FabricContractError("invalid_argument", "Fabric Connector URL must use wss://", "url");
    }
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#connectTimeoutMs = positive(options.connectTimeoutMs, 10_000, "connectTimeoutMs");
    this.#reconnectDelayMs = positive(options.reconnectDelayMs, 1_000, "reconnectDelayMs");
    this.#maxReconnectAttempts = positive(options.maxReconnectAttempts, 5, "maxReconnectAttempts");
    this.#ca = options.ca;
    this.#instanceNonce = options.instanceNonce ?? randomUUID();
    this.#limits = {
      maxFrameBytes: positive(options.limits?.maxFrameBytes, CONNECTOR_LIMITS.maxFrameBytes, "maxFrameBytes"),
      maxInFlightOperations: positive(options.limits?.maxInFlightOperations, CONNECTOR_LIMITS.maxInFlightOperations, "maxInFlightOperations"),
      heartbeatIntervalMs: positive(options.limits?.heartbeatIntervalMs, CONNECTOR_LIMITS.heartbeatIntervalMs, "heartbeatIntervalMs"),
      heartbeatTimeoutMs: positive(options.limits?.heartbeatTimeoutMs, CONNECTOR_LIMITS.heartbeatTimeoutMs, "heartbeatTimeoutMs"),
      maxAdvertisementItems: positive(options.limits?.maxAdvertisementItems, CONNECTOR_LIMITS.maxAdvertisementItems, "maxAdvertisementItems"),
      maxResultBytes: positive(options.limits?.maxResultBytes, CONNECTOR_LIMITS.maxResultBytes, "maxResultBytes"),
    };
    assertValidFabricProtocolLimits(this.#limits);
    this.#negotiatedLimits = { ...this.#limits };
  }

  get state(): FabricConnectorRuntimeState {
    return this.#state;
  }

  get connectionGeneration(): number {
    return this.#connectionGeneration;
  }

  get instanceNonce(): string {
    return this.#instanceNonce;
  }

  /** Dial, prove, advertise, and resolve once the Hub reports `ready`. */
  async start(): Promise<void> {
    if (this.#state !== "idle" && this.#state !== "closed") {
      throw new FabricContractError("invalid_state", "Fabric Connector runtime is already started");
    }
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#clearHeartbeat();
    this.#socket = undefined;
    this.#reconnectAttempts = 0;
    this.#failedAttemptToken = 0;
    this.#connectionId = "";
    this.#connectionGeneration = 0;
    this.#advertisementRevision = 0;
    this.#pendingAdvertisement = undefined;
    this.#heartbeatSequence = 0;
    this.#relayOwner?.retire("Connector runtime restarted");
    this.#relayOwner = undefined;
    this.#pendingOperationWrites = 0;
    this.#pendingControlWrites = 0;
    this.#negotiatedLimits = { ...this.#limits };
    this.#instanceNonce = this.#options.instanceNonce ?? randomUUID();
    this.#stopRequested = false;
    this.#state = "connecting";
    return new Promise<void>((resolve, reject) => {
      this.#pending = { resolve, reject };
      this.#connect();
    });
  }

  /** Bounded stop: drain if ready, then close and clear every timer. */
  async stop(reason = "the Connector is stopping"): Promise<void> {
    this.#stopRequested = true;
    this.#attemptToken += 1;
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#clearHeartbeat();
    this.#relayOwner?.retire(reason);
    this.#relayOwner = undefined;
    const socket = this.#socket;
    if (socket === undefined || socket.readyState === WebSocket.CLOSED) {
      this.#socket = undefined;
      this.#state = "closed";
      this.#settleStart(new FabricContractError("cancelled", reason));
      return;
    }
    try {
      if (this.#state === "ready") {
        this.#state = "draining";
        this.#send({ kind: "drain", payload: { reason } });
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const done = (): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          resolve();
        };
        timer = setTimeout(() => {
          try { socket.terminate(); } catch { /* the transport is already unusable */ }
          done();
        }, this.#connectTimeoutMs);
        timer.unref?.();
        socket.once("close", done);
        try {
          if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
          else socket.close(1000, utf8Bound(reason, 123));
        } catch {
          try { socket.terminate(); } catch { /* the transport is already unusable */ }
          done();
        }
      });
    } finally {
      if (this.#socket === socket) this.#socket = undefined;
      this.#state = "closed";
      this.#settleStart(new FabricContractError("cancelled", reason));
      this.#notifyClosed(reason);
    }
  }

  #connect(): void {
    const attemptToken = ++this.#attemptToken;
    this.#negotiatedLimits = { ...this.#limits };
    const socket = new WebSocket(this.#options.url, {
      ...(this.#ca === undefined ? {} : { ca: this.#ca }),
      maxPayload: this.#limits.maxFrameBytes,
      handshakeTimeout: this.#connectTimeoutMs,
    });
    this.#socket = socket;
    const timer = setTimeout(() => {
      if (this.#isCurrentAttempt(socket, attemptToken) && this.#state === "connecting") {
        this.#failOrReconnect("the Hub did not answer within connectTimeoutMs", attemptToken);
      }
    }, this.#connectTimeoutMs);
    timer.unref?.();

    socket.on("open", () => {
      if (!this.#isCurrentAttempt(socket, attemptToken)) return;
      clearTimeout(timer);
      try {
        const advertisement = this.#options.advertisementOf?.();
        if (advertisement === undefined) {
          return this.#failOrReconnect("this Connector has no advertisement to publish", attemptToken);
        }
        this.#pendingAdvertisement = advertisement;
        this.#send({
          kind: "client_hello",
          payload: {
            connectorId: this.#options.connectorId,
            keyId: this.#options.keyId,
            instanceNonce: this.#instanceNonce,
            credentialGeneration: this.#options.credentialGeneration,
            supportedVersions: [FABRIC_PROTOCOL_VERSION],
            ...(this.#options.relayHandler === undefined ? {} : { relayVersions: [FABRIC_HUB_RELAY_VERSION] }),
            capabilityDigest: advertisement.capabilityDigest,
            limits: this.#limits as unknown as JsonValue,
          },
        }, attemptToken);
      } catch (error) {
        this.#failOrReconnect(error instanceof Error ? error.message : "the Connector failed to open its Fabric session", attemptToken);
      }
    });
    socket.on("message", (data, isBinary) => {
      if (!this.#isCurrentAttempt(socket, attemptToken)) return;
      if (isBinary) return this.#failOrReconnect("the Hub sent a binary frame", attemptToken);
      const bytes = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data), "utf8");
      if (bytes > this.#negotiatedLimits.maxFrameBytes) {
        return this.#failOrReconnect("the Hub exceeded the negotiated maxFrameBytes", attemptToken);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
        assertValidFabricEnvelope(parsed);
      } catch (error) {
        return this.#failOrReconnect(error instanceof Error ? error.message : "the Hub sent a malformed frame", attemptToken);
      }
      try {
        this.#onEnvelope(parsed, attemptToken);
      } catch (error) {
        this.#failOrReconnect(error instanceof Error ? error.message : "the Connector failed to handle a Hub frame", attemptToken);
      }
    });
    socket.on("error", (error: Error) => {
      if (this.#isCurrentAttempt(socket, attemptToken)) this.#notifyError(error.message);
    });
    socket.on("close", (code: number) => {
      clearTimeout(timer);
      if (!this.#isCurrentAttempt(socket, attemptToken)) return;
      this.#socket = undefined;
      this.#clearHeartbeat();
      if (this.#stopRequested || this.#state === "closed") return;
      this.#failOrReconnect(`the Hub closed the channel (${code})`, attemptToken);
    });
  }

  #isCurrentAttempt(socket: WebSocket, attemptToken: number): boolean {
    return attemptToken === this.#attemptToken && socket === this.#socket;
  }

  #onEnvelope(envelope: FabricEnvelopeV1, attemptToken: number): void {
    switch (envelope.kind) {
      case "server_challenge": {
        const challengeId = envelope.payload.challengeId;
        const challengeNonce = envelope.payload.challengeNonce;
        const audience = envelope.payload.audience;
        const protocolVersion = envelope.payload.protocolVersion;
        if (typeof challengeId !== "string" || typeof challengeNonce !== "string"
          || typeof audience !== "string" || typeof protocolVersion !== "string") {
          return this.#failOrReconnect("the Hub sent an incomplete challenge", attemptToken);
        }
        if (audience !== this.#options.audience) {
          return this.#failOrReconnect("the Hub challenge audience does not match this Connector", attemptToken);
        }
        if (protocolVersion !== FABRIC_PROTOCOL_VERSION) {
          return this.#failOrReconnect("the Hub selected an unsupported Fabric protocol", attemptToken);
        }
        // The generation is the one this Connector was enrolled under; a
        // Connector that does not know it cannot prove one.
        const credentialGeneration = this.#options.credentialGeneration;
        const payload = fabricChallengeProofPayload({
          connectorId: this.#options.connectorId,
          instanceNonce: this.#instanceNonce,
          challengeNonce,
          protocolVersion,
          audience,
          credentialGeneration,
        });
        this.#send({
          kind: "client_proof",
          payload: {
            challengeId,
            connectorId: this.#options.connectorId,
            instanceNonce: this.#instanceNonce,
            challengeNonce,
            audience,
            protocolVersion,
            credentialGeneration,
            signature: this.#options.sign(payload),
          },
        });
        return;
      }
      case "connection_accepted": {
        const lease = envelope.payload.lease;
        const limits = envelope.payload.limits;
        if (typeof lease !== "object" || lease === null || Array.isArray(lease) ||
          typeof limits !== "object" || limits === null || Array.isArray(limits)) {
          return this.#failOrReconnect("the Hub accepted the connection without its locked lease and limits", attemptToken);
        }
        const acceptedLease = lease as Readonly<Record<string, JsonValue>>;
        const connectionId = acceptedLease.connectionId;
        const generation = acceptedLease.generation;
        const deviceId = acceptedLease.deviceId;
        const acceptedLimits = limits as unknown as FabricProtocolLimits;
        try {
          assertValidFabricProtocolLimits(acceptedLimits);
        } catch {
          return this.#failOrReconnect("the Hub returned invalid negotiated limits", attemptToken);
        }
        const limitFields = Object.keys(this.#limits) as Array<keyof FabricProtocolLimits>;
        if (limitFields.some((field) => acceptedLimits[field] > this.#limits[field])) {
          return this.#failOrReconnect("the Hub widened the Connector's negotiated limits", attemptToken);
        }
        if (typeof connectionId !== "string" || !Number.isSafeInteger(generation) || (generation as number) < 1 ||
          envelope.connectionId !== connectionId || envelope.connectionGeneration !== generation ||
          typeof deviceId !== "string" || acceptedLease.connectorId !== this.#options.connectorId ||
          acceptedLease.state !== "connected" || typeof acceptedLease.capabilityDigest !== "string" ||
          typeof acceptedLease.establishedAt !== "number" || typeof acceptedLease.expiresAt !== "number" ||
          typeof acceptedLease.revision !== "number") {
          return this.#failOrReconnect("the Hub returned an invalid connection lease", attemptToken);
        }
        const relayVersion = envelope.payload.relayVersion;
        const hubRuntimeEpoch = envelope.payload.hubRuntimeEpoch;
        if (relayVersion !== undefined && (relayVersion !== FABRIC_HUB_RELAY_VERSION || this.#options.relayHandler === undefined || typeof hubRuntimeEpoch !== "string")) {
          return this.#failOrReconnect("the Hub selected relay support that this Connector did not offer", attemptToken);
        }
        if (relayVersion === undefined && hubRuntimeEpoch !== undefined) {
          return this.#failOrReconnect("the Hub returned relay authority without negotiating a relay version", attemptToken);
        }
        this.#negotiatedLimits = { ...acceptedLimits };
        this.#connectionId = connectionId;
        this.#connectionGeneration = generation as number;
        const currentSocket = (): WebSocket | undefined => {
          const socket = this.#socket;
          return socket !== undefined && this.#isCurrentAttempt(socket, attemptToken) ? socket : undefined;
        };
        if (relayVersion === FABRIC_HUB_RELAY_VERSION && this.#options.relayHandler !== undefined) {
          this.#relayOwner = new FabricDeviceRelayOwner({
            identity: {
              connectorId: this.#options.connectorId,
              deviceId,
              connectionId,
              connectionGeneration: generation as number,
              instanceNonce: this.#instanceNonce,
              state: "connected",
              current: true,
              relayVersion,
            },
            hubRuntimeEpoch: hubRuntimeEpoch as string,
            handler: this.#options.relayHandler,
            ...(this.#options.relayLimits === undefined ? {} : { limits: this.#options.relayLimits }),
            negotiatedLimits: acceptedLimits,
            transport: {
              send: (outgoing, priority) => this.#sendEnvelope(outgoing, priority, attemptToken),
              get bufferedAmount(): number { return currentSocket()?.bufferedAmount ?? 0; },
            },
          });
        }
        const advertisement = this.#pendingAdvertisement;
        this.#pendingAdvertisement = undefined;
        if (advertisement === undefined) {
          return this.#failOrReconnect("this Connector has no authenticated advertisement to publish", attemptToken);
        }
        this.#advertisementRevision = advertisement.advertisementRevision;
        this.#options.onConnected?.({ connectionId: this.#connectionId, connectionGeneration: this.#connectionGeneration });
        this.#send({
          kind: "advertise_snapshot",
          payload: {
            ...advertisement.payload,
            advertisementRevision: advertisement.advertisementRevision,
            capabilityDigest: advertisement.capabilityDigest,
          },
        });
        return;
      }
      case "ready": {
        const revision = envelope.payload.advertisementRevision;
        const leaseExpiresAt = envelope.payload.leaseExpiresAt;
        const relayVersion = envelope.payload.relayVersion;
        if (typeof leaseExpiresAt !== "number" || !Number.isSafeInteger(leaseExpiresAt) || leaseExpiresAt <= this.#now()) {
          return this.#failOrReconnect("the Hub reported ready without a live lease expiry", attemptToken);
        }
        if ((this.#relayOwner === undefined) !== (relayVersion === undefined) ||
          (relayVersion !== undefined && relayVersion !== FABRIC_HUB_RELAY_VERSION)) {
          return this.#failOrReconnect("the Hub ready relay echo does not match connection acceptance", attemptToken);
        }
        this.#state = "ready";
        this.#relayOwner?.activate();
        this.#reconnectAttempts = 0;
        this.#startHeartbeat();
        this.#settleStart();
        this.#options.onReady?.({
          connectionId: this.#connectionId,
          connectionGeneration: this.#connectionGeneration,
          advertisementRevision: typeof revision === "number" ? revision : this.#advertisementRevision,
        });
        return;
      }
      case "heartbeat_ack": {
        this.#awaitingAck = false;
        return;
      }
      case "invoke":
      case "cancel": {
        if (this.#state !== "ready" || this.#relayOwner === undefined) {
          return this.#failOrReconnect("the Hub sent an Agent relay frame before negotiated readiness", attemptToken);
        }
        this.#relayOwner.accept(envelope);
        return;
      }
      case "stream":
      case "receipt":
        return this.#failOrReconnect("the Hub sent a wrong-direction Agent relay frame", attemptToken);
      case "drain": {
        const reason = typeof envelope.payload.reason === "string" ? envelope.payload.reason : "the Hub is draining";
        this.#state = "draining";
        this.#clearHeartbeat();
        this.#relayOwner?.retire(reason);
        this.#relayOwner = undefined;
        this.#options.onDrain?.(reason);
        return;
      }
      case "error": {
        const code = typeof envelope.payload.code === "string" ? envelope.payload.code : "protocol_violation";
        const message = typeof envelope.payload.message === "string" ? envelope.payload.message : "the Hub refused the Connector";
        this.#notifyError(`${code}: ${message}`);
        // A generation fence is terminal for this attempt; a retryable refusal
        // is answered by a fresh connection, never by reviving this one.
        this.#failOrReconnect(`${code}: ${message}`, attemptToken);
        return;
      }
      case "close": {
        this.#relayOwner?.retire("the Hub closed the channel");
        this.#relayOwner = undefined;
        this.#state = "closed";
        this.#notifyClosed("the Hub closed the channel");
        return;
      }
      default:
        this.#failOrReconnect(`the Hub sent an unexpected frame kind ${envelope.kind}`, attemptToken);
    }
  }

  #startHeartbeat(): void {
    this.#clearHeartbeat();
    const attemptToken = this.#attemptToken;
    this.#heartbeatTimer = setInterval(() => {
      if (this.#state !== "ready" || this.#stopRequested || attemptToken !== this.#attemptToken) return;
      // A lease that lapsed without an acknowledgement is not renewed by
      // sending another heartbeat: the connection is re-established instead.
      if (this.#awaitingAck) {
        this.#failOrReconnect("the Hub did not acknowledge the previous heartbeat", attemptToken);
        return;
      }
      this.#heartbeatSequence += 1;
      this.#awaitingAck = true;
      this.#send({
        kind: "heartbeat",
        payload: { sequence: this.#heartbeatSequence, observedAt: this.#now() },
      });
    }, this.#negotiatedLimits.heartbeatIntervalMs);
    this.#heartbeatTimer.unref?.();
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    this.#awaitingAck = false;
  }

  #send(
    input: { kind: FabricEnvelopeV1["kind"]; payload: Readonly<Record<string, JsonValue>> },
    attemptToken = this.#attemptToken,
  ): void {
    const outgoing: FabricEnvelopeV1 = {
      version: FABRIC_PROTOCOL_VERSION,
      messageId: randomUUID(),
      kind: input.kind,
      sentAt: this.#now(),
      ...(this.#connectionId === "" ? {} : { connectionId: this.#connectionId }),
      ...(this.#connectionGeneration === 0 ? {} : { connectionGeneration: this.#connectionGeneration }),
      payload: input.payload,
    };
    try {
      this.#sendEnvelope(outgoing, "control", attemptToken);
    } catch (error) {
      this.#failOrReconnect(error instanceof Error ? error.message : "the Connector failed to send a Fabric frame", attemptToken);
    }
  }

  #sendEnvelope(outgoing: FabricEnvelopeV1, priority: "operation" | "control", attemptToken: number): void {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN || !this.#isCurrentAttempt(socket, attemptToken)) {
      if (priority === "operation") throw new FabricContractError("unavailable", "Fabric Connector socket is not open");
      return;
    }
    const text = JSON.stringify(outgoing);
    if (Buffer.byteLength(text, "utf8") > this.#negotiatedLimits.maxFrameBytes) {
      throw new FabricContractError("resource_exhausted", "Fabric frame exceeds maxFrameBytes", "maxFrameBytes");
    }
    const operationCapacity = this.#negotiatedLimits.maxInFlightOperations;
    const controlCapacity = 3;
    const operationBufferedLimit = this.#negotiatedLimits.maxFrameBytes * operationCapacity;
    const controlBufferedLimit = this.#negotiatedLimits.maxFrameBytes * (operationCapacity + controlCapacity);
    if ((priority === "operation" && (this.#pendingOperationWrites >= operationCapacity || socket.bufferedAmount > operationBufferedLimit)) ||
      (priority === "control" && (this.#pendingControlWrites >= controlCapacity || socket.bufferedAmount > controlBufferedLimit))) {
      throw new FabricContractError("resource_exhausted", "Fabric Connector send backpressure limit is exceeded", "bufferedAmount");
    }
    if (priority === "operation") this.#pendingOperationWrites += 1;
    else this.#pendingControlWrites += 1;
    const releaseWrite = (): void => {
      if (priority === "operation") this.#pendingOperationWrites = Math.max(0, this.#pendingOperationWrites - 1);
      else this.#pendingControlWrites = Math.max(0, this.#pendingControlWrites - 1);
    };
    try {
      socket.send(text, (error) => {
        if (!this.#isCurrentAttempt(socket, attemptToken)) return;
        releaseWrite();
        if (error) this.#failOrReconnect(error.message || "the Connector failed to send a Fabric frame", attemptToken);
      });
    } catch (error) {
      releaseWrite();
      throw error;
    }
  }

  #notifyError(message: string): void {
    try { this.#options.onError?.(message); } catch { /* observers cannot escape transport callbacks */ }
  }

  #notifyClosed(reason: string): void {
    try { this.#options.onClosed?.(reason); } catch { /* observers cannot escape transport callbacks */ }
  }

  #failOrReconnect(reason: string, attemptToken = this.#attemptToken): void {
    if (attemptToken !== this.#attemptToken || this.#failedAttemptToken === attemptToken) return;
    this.#failedAttemptToken = attemptToken;
    this.#notifyError(reason);
    this.#clearHeartbeat();
    this.#relayOwner?.retire(reason);
    this.#relayOwner = undefined;
    const socket = this.#socket;
    if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) {
      try { socket.terminate(); } catch { /* reconnect still fences this attempt */ }
    }
    if (this.#stopRequested || this.#state === "closed") return;
    if (this.#reconnectAttempts >= this.#maxReconnectAttempts) {
      this.#socket = undefined;
      this.#state = "closed";
      this.#settleStart(new FabricContractError("unavailable", `Fabric Connector gave up: ${reason}`));
      this.#notifyClosed(reason);
      return;
    }
    this.#reconnectAttempts += 1;
    // A reconnect is a new Connector process lifetime: a fresh nonce means the
    // Hub admits a new generation instead of restoring the fenced one.
    this.#instanceNonce = randomUUID();
    this.#connectionId = "";
    this.#connectionGeneration = 0;
    this.#pendingAdvertisement = undefined;
    this.#heartbeatSequence = 0;
    this.#pendingOperationWrites = 0;
    this.#pendingControlWrites = 0;
    this.#negotiatedLimits = { ...this.#limits };
    this.#state = "connecting";
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      if (!this.#stopRequested && attemptToken === this.#attemptToken) this.#connect();
    }, this.#reconnectDelayMs);
    this.#reconnectTimer.unref?.();
  }

  #settleStart(error?: Error): void {
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending === undefined) return;
    if (error === undefined) pending.resolve();
    else pending.reject(error);
  }
}
