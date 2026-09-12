import {
  FABRIC_PROTOCOL_VERSION,
  FabricContractError,
  assertEpochMilliseconds,
  assertFabricIdentifier,
  assertGeneration,
  assertValidFabricEnvelope,
  type FabricConnectRequest,
  type FabricEnvelopeV1,
  type FabricLiveConnection,
  type FabricProtocolLimits,
  type FabricTransportProvider,
  type JsonValue,
} from "pi-maestro-fabric-core/v1";
import type { FabricCancellationSignal } from "pi-maestro-fabric-core/v1/transport";

const OUTBOUND_LIMITS: FabricProtocolLimits = Object.freeze({
  maxFrameBytes: 256 * 1024,
  maxInFlightOperations: 32,
  heartbeatIntervalMs: 10_000,
  heartbeatTimeoutMs: 30_000,
  maxAdvertisementItems: 1_024,
  maxResultBytes: 1024 * 1024,
});

/** One live outbound-WSS session, as the injected dialer reports it. */
export interface FabricOutboundWssSession {
  readonly connectionId: string;
  readonly connectionGeneration: number;
  exchange(envelope: FabricEnvelopeV1, signal: FabricCancellationSignal): Promise<FabricEnvelopeV1>;
  close(reason: string): Promise<void>;
}

export interface FabricOutboundWssDialerRequest {
  readonly hubUrl: string;
  readonly connectorId: string;
  readonly keyId: string;
  readonly audience: string;
  readonly credentialGeneration: number;
  readonly deviceId: string;
  readonly deadlineAt: number;
}

/**
 * Opens one outbound-WSS session.
 *
 * Injected rather than imported: the dialer owns TLS trust, the enrolled key,
 * and the connector's own reconnect policy, none of which this kernel holds.
 */
export interface FabricOutboundWssDialer {
  dial(request: FabricOutboundWssDialerRequest, signal: FabricCancellationSignal): Promise<FabricOutboundWssSession>;
}

export interface FabricOutboundWssTransportOptions {
  readonly dialer: FabricOutboundWssDialer;
  readonly hubUrl: string;
  readonly connectorId: string;
  readonly keyId: string;
  readonly audience: string;
  readonly credentialGeneration: number;
  readonly limits?: Partial<FabricProtocolLimits>;
  readonly now?: () => number;
}

function positive(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new FabricContractError("invalid_argument", `${label} must be a positive safe integer`, label);
  }
  return result;
}

function assertJsonPayload(envelope: FabricEnvelopeV1, limits: FabricProtocolLimits): void {
  let text: string;
  try {
    text = JSON.stringify(envelope);
  } catch {
    throw new FabricContractError("protocol_violation", "Fabric envelope is not JSON serializable");
  }
  if (Buffer.byteLength(text, "utf8") > limits.maxFrameBytes) {
    throw new FabricContractError("resource_exhausted", "Fabric frame exceeds maxFrameBytes", "maxFrameBytes");
  }
}

/**
 * The runtime's outbound-WSS transport: a Connector dials out, and every
 * exchange on the resulting connection is fenced by that connection's own
 * generation.
 */
export class FabricOutboundWssTransport implements FabricTransportProvider {
  readonly kind = "outbound-wss";
  readonly #options: FabricOutboundWssTransportOptions;
  readonly #limits: FabricProtocolLimits;
  readonly #now: () => number;

  constructor(options: FabricOutboundWssTransportOptions) {
    if (!options.hubUrl.startsWith("wss://")) {
      throw new FabricContractError("invalid_argument", "Fabric Hub URL must use wss://", "hubUrl");
    }
    assertFabricIdentifier(options.connectorId, "connectorId");
    assertGeneration(options.credentialGeneration, "credentialGeneration");
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#limits = {
      maxFrameBytes: positive(options.limits?.maxFrameBytes, OUTBOUND_LIMITS.maxFrameBytes, "maxFrameBytes"),
      maxInFlightOperations: positive(options.limits?.maxInFlightOperations, OUTBOUND_LIMITS.maxInFlightOperations, "maxInFlightOperations"),
      heartbeatIntervalMs: positive(options.limits?.heartbeatIntervalMs, OUTBOUND_LIMITS.heartbeatIntervalMs, "heartbeatIntervalMs"),
      heartbeatTimeoutMs: positive(options.limits?.heartbeatTimeoutMs, OUTBOUND_LIMITS.heartbeatTimeoutMs, "heartbeatTimeoutMs"),
      maxAdvertisementItems: positive(options.limits?.maxAdvertisementItems, OUTBOUND_LIMITS.maxAdvertisementItems, "maxAdvertisementItems"),
      maxResultBytes: positive(options.limits?.maxResultBytes, OUTBOUND_LIMITS.maxResultBytes, "maxResultBytes"),
    };
  }

  async connect(request: FabricConnectRequest, signal: FabricCancellationSignal): Promise<FabricLiveConnection> {
    assertFabricIdentifier(request.requestId, "requestId");
    assertFabricIdentifier(request.deviceId, "deviceId");
    assertFabricIdentifier(request.connectorId, "connectorId");
    assertEpochMilliseconds(request.deadlineAt, "deadlineAt");
    assertGeneration(request.expectedCredentialGeneration, "expectedCredentialGeneration");
    if (request.connectorId !== this.#options.connectorId) {
      throw new FabricContractError(
        "conflict",
        "Fabric connect request names another Connector than this transport is enrolled as",
        "connectorId",
      );
    }
    // A generation mismatch is terminal for this attempt: presenting a
    // superseded credential would only be refused by the Hub after a round trip.
    if (request.expectedCredentialGeneration !== this.#options.credentialGeneration) {
      throw new FabricContractError(
        "stale_generation",
        "Fabric connect request expects a superseded credential generation",
        "expectedCredentialGeneration",
      );
    }
    if (signal.aborted) throw new FabricContractError("cancelled", "Fabric outbound connection was cancelled");
    if (this.#now() >= request.deadlineAt) {
      throw new FabricContractError("deadline_exceeded", "Fabric outbound connection deadline has passed", "deadlineAt");
    }

    const session = await this.#options.dialer.dial({
      hubUrl: this.#options.hubUrl,
      connectorId: this.#options.connectorId,
      keyId: this.#options.keyId,
      audience: this.#options.audience,
      credentialGeneration: this.#options.credentialGeneration,
      deviceId: request.deviceId,
      deadlineAt: request.deadlineAt,
    }, signal);
    assertFabricIdentifier(session.connectionId, "connectionId");
    assertGeneration(session.connectionGeneration, "connectionGeneration");
    return new FabricOutboundWssConnection(session, request, this.#limits, this.#now);
  }
}

/** One established connection, fenced by its own generation until closed. */
class FabricOutboundWssConnection implements FabricLiveConnection {
  readonly descriptor: FabricLiveConnection["descriptor"];
  readonly #session: FabricOutboundWssSession;
  readonly #limits: FabricProtocolLimits;
  readonly #now: () => number;
  #closed = false;

  constructor(
    session: FabricOutboundWssSession,
    request: FabricConnectRequest,
    limits: FabricProtocolLimits,
    now: () => number,
  ) {
    this.#session = session;
    this.#limits = limits;
    this.#now = now;
    this.descriptor = {
      lease: {
        connectionId: session.connectionId,
        deviceId: request.deviceId,
        connectorId: request.connectorId,
        connectorInstanceNonce: session.connectionId,
        generation: session.connectionGeneration,
        state: "connected" as const,
        capabilityDigest: "",
        establishedAt: now(),
        expiresAt: request.deadlineAt,
        revision: 0,
      },
      protocolVersion: FABRIC_PROTOCOL_VERSION,
      limits,
    };
  }

  async exchange(envelope: FabricEnvelopeV1, signal: FabricCancellationSignal): Promise<FabricEnvelopeV1> {
    if (this.#closed) throw new FabricContractError("invalid_state", "Fabric connection is closed");
    assertValidFabricEnvelope(envelope);
    // The envelope must address this connection's own generation; a frame for
    // another generation is refused here rather than trusted to the peer.
    if (envelope.connectionId !== undefined && envelope.connectionId !== this.#session.connectionId) {
      throw new FabricContractError("stale_generation", "Fabric envelope addresses another connection", "connectionId");
    }
    if (envelope.connectionGeneration !== undefined && envelope.connectionGeneration !== this.#session.connectionGeneration) {
      throw new FabricContractError("stale_generation", "Fabric envelope addresses another connection generation", "connectionGeneration");
    }
    if (envelope.deadlineAt !== undefined && envelope.deadlineAt <= this.#now()) {
      throw new FabricContractError("deadline_exceeded", "Fabric envelope deadline has passed", "deadlineAt");
    }
    assertJsonPayload(envelope, this.#limits);
    if (signal.aborted) throw new FabricContractError("cancelled", "Fabric exchange was cancelled");
    const response = await this.#session.exchange(envelope, signal);
    assertValidFabricEnvelope(response);
    if (response.correlationId !== undefined && envelope.correlationId !== undefined
      && response.correlationId !== envelope.correlationId) {
      throw new FabricContractError("protocol_violation", "Fabric response does not answer this request", "correlationId");
    }
    assertJsonPayload(response, this.#limits);
    if (this.#closed) throw new FabricContractError("invalid_state", "Fabric connection was closed during the exchange");
    return response;
  }

  async close(reason: string): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#session.close(reason);
  }

  get closed(): boolean {
    return this.#closed;
  }
}

/** Envelope helper for callers that build their own frames. */
export function fabricOutboundEnvelope(
  kind: FabricEnvelopeV1["kind"],
  payload: Readonly<Record<string, JsonValue>>,
  now: () => number = Date.now,
): FabricEnvelopeV1 {
  return {
    version: FABRIC_PROTOCOL_VERSION,
    messageId: `outbound-${now().toString(36)}`,
    kind,
    sentAt: now(),
    payload,
  };
}
