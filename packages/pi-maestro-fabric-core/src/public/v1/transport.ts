import type { ConnectorId, DeviceId } from "./common.ts";
import type { ConnectionLease } from "./connection.ts";
import type { FabricEnvelopeV1, FabricProtocolLimits } from "./protocol.ts";

export interface FabricCancellationSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
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
