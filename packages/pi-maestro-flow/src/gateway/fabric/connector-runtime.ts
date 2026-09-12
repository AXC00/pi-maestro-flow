import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  FABRIC_PROTOCOL_VERSION,
  FabricContractError,
  assertValidFabricEnvelope,
  type FabricEnvelopeV1,
  type FabricProtocolLimits,
  type JsonValue,
} from "pi-maestro-fabric-core/v1";
import { fabricChallengeProofPayload } from "./security.ts";

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
  #heartbeatSequence = 0;
  #heartbeatTimer?: NodeJS.Timeout;
  #awaitingAck = false;
  #reconnectTimer?: NodeJS.Timeout;
  #reconnectAttempts = 0;
  #pending?: PendingStart;
  #stopRequested = false;

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
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#clearHeartbeat();
    const socket = this.#socket;
    if (socket === undefined || socket.readyState === WebSocket.CLOSED) {
      this.#state = "closed";
      this.#settleStart(new FabricContractError("cancelled", reason));
      return;
    }
    if (this.#state === "ready") {
      this.#state = "draining";
      this.#send({ kind: "drain", payload: { reason } });
    }
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      const timer = setTimeout(() => {
        try { socket.terminate(); } catch { /* already gone */ }
        done();
      }, this.#connectTimeoutMs);
      timer.unref?.();
      socket.once("close", () => {
        clearTimeout(timer);
        done();
      });
      try { socket.close(1000, reason.slice(0, 120)); } catch { done(); }
    });
    this.#state = "closed";
    this.#options.onClosed?.(reason);
  }

  #connect(): void {
    const socket = new WebSocket(this.#options.url, {
      ...(this.#ca === undefined ? {} : { ca: this.#ca }),
      maxPayload: this.#limits.maxFrameBytes,
      handshakeTimeout: this.#connectTimeoutMs,
    });
    this.#socket = socket;
    const timer = setTimeout(() => {
      if (this.#state === "connecting") {
        try { socket.terminate(); } catch { /* already gone */ }
        this.#failOrReconnect("the Hub did not answer within connectTimeoutMs");
      }
    }, this.#connectTimeoutMs);
    timer.unref?.();

    socket.on("open", () => {
      clearTimeout(timer);
      this.#send({
        kind: "client_hello",
        payload: {
          connectorId: this.#options.connectorId,
          keyId: this.#options.keyId,
          instanceNonce: this.#instanceNonce,
          limits: this.#limits as unknown as JsonValue,
        },
      });
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) return this.#failOrReconnect("the Hub sent a binary frame");
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
        assertValidFabricEnvelope(parsed);
      } catch (error) {
        return this.#failOrReconnect(error instanceof Error ? error.message : "the Hub sent a malformed frame");
      }
      this.#onEnvelope(parsed);
    });
    socket.on("error", (error: Error) => {
      this.#options.onError?.(error.message);
    });
    socket.on("close", (code: number) => {
      clearTimeout(timer);
      this.#clearHeartbeat();
      if (this.#stopRequested || this.#state === "closed") return;
      this.#failOrReconnect(`the Hub closed the channel (${code})`);
    });
  }

  #onEnvelope(envelope: FabricEnvelopeV1): void {
    switch (envelope.kind) {
      case "server_challenge": {
        const challengeId = envelope.payload.challengeId;
        const challengeNonce = envelope.payload.challengeNonce;
        const audience = envelope.payload.audience;
        const protocolVersion = envelope.payload.protocolVersion;
        if (typeof challengeId !== "string" || typeof challengeNonce !== "string"
          || typeof audience !== "string" || typeof protocolVersion !== "string") {
          return this.#failOrReconnect("the Hub sent an incomplete challenge");
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
        const connectionId = envelope.payload.connectionId;
        const generation = envelope.payload.connectionGeneration;
        if (typeof connectionId !== "string" || !Number.isSafeInteger(generation) || (generation as number) < 1) {
          return this.#failOrReconnect("the Hub accepted the connection without a generation");
        }
        this.#connectionId = connectionId;
        this.#connectionGeneration = generation as number;
        const advertisement = this.#options.advertisementOf?.();
        if (advertisement === undefined) {
          return this.#failOrReconnect("this Connector has no advertisement to publish");
        }
        this.#advertisementRevision = advertisement.advertisementRevision;
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
        this.#state = "ready";
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
      case "drain": {
        const reason = typeof envelope.payload.reason === "string" ? envelope.payload.reason : "the Hub is draining";
        this.#state = "draining";
        this.#clearHeartbeat();
        this.#options.onDrain?.(reason);
        return;
      }
      case "error": {
        const code = typeof envelope.payload.code === "string" ? envelope.payload.code : "protocol_violation";
        const message = typeof envelope.payload.message === "string" ? envelope.payload.message : "the Hub refused the Connector";
        this.#options.onError?.(`${code}: ${message}`);
        // A generation fence is terminal for this attempt; a retryable refusal
        // is answered by a fresh connection, never by reviving this one.
        this.#failOrReconnect(`${code}: ${message}`);
        return;
      }
      case "close": {
        this.#state = "closed";
        this.#options.onClosed?.("the Hub closed the channel");
        return;
      }
      default:
        this.#failOrReconnect(`the Hub sent an unexpected frame kind ${envelope.kind}`);
    }
  }

  #startHeartbeat(): void {
    this.#clearHeartbeat();
    this.#heartbeatTimer = setInterval(() => {
      if (this.#state !== "ready" || this.#stopRequested) return;
      // A lease that lapsed without an acknowledgement is not renewed by
      // sending another heartbeat: the connection is re-established instead.
      if (this.#awaitingAck) {
        this.#failOrReconnect("the Hub did not acknowledge the previous heartbeat");
        return;
      }
      this.#heartbeatSequence += 1;
      this.#awaitingAck = true;
      this.#send({
        kind: "heartbeat",
        payload: { sequence: this.#heartbeatSequence, observedAt: this.#now() },
      });
    }, this.#limits.heartbeatIntervalMs);
    this.#heartbeatTimer.unref?.();
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    this.#awaitingAck = false;
  }

  #send(input: { kind: FabricEnvelopeV1["kind"]; payload: Readonly<Record<string, JsonValue>> }): void {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return;
    const envelope: FabricEnvelopeV1 = {
      version: FABRIC_PROTOCOL_VERSION,
      messageId: randomUUID(),
      kind: input.kind,
      sentAt: this.#now(),
      ...(this.#connectionId === "" ? {} : { connectionId: this.#connectionId }),
      ...(this.#connectionGeneration === 0 ? {} : { connectionGeneration: this.#connectionGeneration }),
      payload: input.payload,
    };
    const text = JSON.stringify(envelope);
    if (Buffer.byteLength(text, "utf8") > this.#limits.maxFrameBytes) {
      throw new FabricContractError("resource_exhausted", "Fabric frame exceeds maxFrameBytes", "maxFrameBytes");
    }
    socket.send(text);
  }

  #failOrReconnect(reason: string): void {
    this.#options.onError?.(reason);
    this.#clearHeartbeat();
    try { this.#socket?.terminate(); } catch { /* already gone */ }
    if (this.#stopRequested || this.#state === "closed") return;
    if (this.#reconnectAttempts >= this.#maxReconnectAttempts) {
      this.#state = "closed";
      this.#settleStart(new FabricContractError("unavailable", `Fabric Connector gave up: ${reason}`));
      this.#options.onClosed?.(reason);
      return;
    }
    this.#reconnectAttempts += 1;
    // A reconnect is a new Connector process lifetime: a fresh nonce means the
    // Hub admits a new generation instead of restoring the fenced one.
    this.#instanceNonce = randomUUID();
    this.#connectionId = "";
    this.#connectionGeneration = 0;
    this.#heartbeatSequence = 0;
    this.#state = "connecting";
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      if (!this.#stopRequested) this.#connect();
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
