import type { ConnectorId, DeviceId } from "./common.ts";

export const FABRIC_CONNECTION_MODES = ["direct", "edge-managed", "ssh", "https"] as const;
export type FabricConnectionMode = (typeof FABRIC_CONNECTION_MODES)[number];

export const FABRIC_CONNECTOR_TRANSPORTS = ["outbound-wss", "ssh", "direct-https", "edge-relay"] as const;
export type FabricConnectorTransport = (typeof FABRIC_CONNECTOR_TRANSPORTS)[number];

export interface ConnectorRecord {
  connectorId: ConnectorId;
  label: string;
  transport: FabricConnectorTransport;
  credentialGeneration: number;
  instanceNonce?: string;
  lastSeenAt?: number;
  enabled: boolean;
  revision: number;
}

export interface DeviceRecord {
  deviceId: DeviceId;
  label: string;
  connectorId: ConnectorId;
  connectionMode: FabricConnectionMode;
  platform?: string;
  architecture?: string;
  enabled: boolean;
  revision: number;
}
