import type {
  ConnectionId,
  FabricErrorCode,
  JsonValue,
  OperationId,
} from "./common.ts";
import { FABRIC_PROTOCOL_VERSION } from "./common.ts";

export const FABRIC_MESSAGE_KINDS = [
  "client_hello",
  "server_challenge",
  "client_proof",
  "connection_accepted",
  "advertise_snapshot",
  "advertise_delta",
  "ready",
  "heartbeat",
  "heartbeat_ack",
  "workspace_bind",
  "route_open",
  "invoke",
  "cancel",
  "receipt",
  "drain",
  "close",
  "error",
] as const;

export type FabricMessageKind = (typeof FABRIC_MESSAGE_KINDS)[number];

export interface FabricEnvelopeV1 {
  version: typeof FABRIC_PROTOCOL_VERSION;
  messageId: string;
  kind: FabricMessageKind;
  sentAt: number;
  connectionId?: ConnectionId;
  connectionGeneration?: number;
  correlationId?: string;
  operationId?: OperationId;
  deadlineAt?: number;
  payload: Readonly<Record<string, JsonValue>>;
}

export interface FabricProtocolError {
  code: FabricErrorCode;
  message: string;
  path?: string;
  retryable: boolean;
}

export interface FabricProtocolLimits {
  maxFrameBytes: number;
  maxInFlightOperations: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  maxAdvertisementItems: number;
  maxResultBytes: number;
}
