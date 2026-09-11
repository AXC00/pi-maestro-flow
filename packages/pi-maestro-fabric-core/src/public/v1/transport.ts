import type { ConnectorId, DeviceId, JsonValue, OperationId, RouteId } from "./common.ts";
import type { ConnectionLease } from "./connection.ts";
import type { FabricEnvelopeV1, FabricProtocolLimits } from "./protocol.ts";

export interface FabricCancellationSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
}

export const FABRIC_STREAM_VERSION = "fabric.stream.v1" as const;
export const FABRIC_STREAM_FRAME_KINDS = ["open", "data", "ack", "end", "cancel", "error"] as const;
export type FabricStreamFrameKind = (typeof FABRIC_STREAM_FRAME_KINDS)[number];

export interface FabricStreamFrameV1 {
  version: typeof FABRIC_STREAM_VERSION;
  streamId: string;
  routeId: RouteId;
  operationId: OperationId;
  sequence: number;
  kind: FabricStreamFrameKind;
  sentAt: number;
  payload: Readonly<Record<string, JsonValue>>;
}

/** Route-bound data channel. Transport implementations own framing and IO. */
export interface FabricStreamChannel {
  readonly streamId: string;
  readonly routeId: RouteId;
  readonly operationId: OperationId;
  send(frame: FabricStreamFrameV1, signal: FabricCancellationSignal): Promise<void>;
  receive(signal: FabricCancellationSignal): Promise<FabricStreamFrameV1 | undefined>;
  close(reason: string): Promise<void>;
}

export interface FabricConnectRequest {
  requestId: string;
  deviceId: DeviceId;
  connectorId: ConnectorId;
  expectedCredentialGeneration: number;
  deadlineAt: number;
  limits: FabricProtocolLimits;
}

export interface FabricConnectionDescriptor {
  lease: ConnectionLease;
  protocolVersion: "fabric.v1";
  limits: FabricProtocolLimits;
}

export interface FabricLiveConnection {
  readonly descriptor: FabricConnectionDescriptor;
  exchange(
    envelope: FabricEnvelopeV1,
    signal: FabricCancellationSignal,
  ): Promise<FabricEnvelopeV1>;
  close(reason: string): Promise<void>;
}

export interface FabricTransportProvider {
  readonly kind: string;
  connect(
    request: FabricConnectRequest,
    signal: FabricCancellationSignal,
  ): Promise<FabricLiveConnection>;
}
