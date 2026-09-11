/** Bounded, read-only Fabric health projection for Monitor and TUI consumers. */
import { randomUUID } from "node:crypto";
import { FABRIC_STORE_KINDS, sanitizeFabricProjectionText, type FabricStoreKind } from "pi-maestro-fabric-core/v1";
import type { FabricConnectionManager, FabricDirectory } from "pi-maestro-fabric";
import type { GatewayEventJournal } from "../event-journal.ts";

export const GATEWAY_FABRIC_MONITOR_VERSION = 1 as const;
export const GATEWAY_FABRIC_MONITOR_EVENT = "fabric:monitor-snapshot" as const;
export const GATEWAY_FABRIC_MONITOR_MAX_ITEMS = 100;
export const GATEWAY_FABRIC_MONITOR_MAX_BYTES = 64 * 1024;

export type GatewayFabricHealth = "online" | "degraded" | "offline" | "disabled" | "unknown";

export interface GatewayFabricMonitorCursorV1 {
  readonly handle: string;
  readonly storeKind: FabricStoreKind;
  readonly cursor: number;
}

export interface GatewayFabricConnectorHealthV1 {
  readonly kind: "connector";
  readonly connectorId: string;
  readonly label: string;
  readonly transport: string;
  readonly health: GatewayFabricHealth;
  readonly enabled: boolean;
  readonly revision: number;
  readonly connectionId?: string;
  readonly connectionGeneration?: number;
}

export interface GatewayFabricDeviceHealthV1 {
  readonly kind: "device";
  readonly deviceId: string;
  readonly connectorId: string;
  readonly label: string;
  readonly health: GatewayFabricHealth;
  readonly enabled: boolean;
  readonly revision: number;
}

export interface GatewayFabricEndpointHealthV1 {
  readonly kind: "endpoint";
  readonly endpointId: string;
  readonly deviceId: string;
  readonly connectorId: string;
  readonly endpointKind: "agent" | "mcp";
  readonly label: string;
  readonly health: GatewayFabricHealth;
  readonly status: "unknown" | "online" | "offline" | "disabled";
  readonly generation: number;
  readonly revision: number;
}

export interface GatewayFabricMonitorSnapshotV1 {
  readonly version: typeof GATEWAY_FABRIC_MONITOR_VERSION;
  readonly sourceId: string;
  readonly revision: number;
  readonly capturedAt: number;
  readonly truncated: boolean;
  readonly itemCount: number;
  readonly cursors: readonly GatewayFabricMonitorCursorV1[];
  readonly connectors: readonly GatewayFabricConnectorHealthV1[];
  readonly devices: readonly GatewayFabricDeviceHealthV1[];
  readonly endpoints: readonly GatewayFabricEndpointHealthV1[];
}

export interface GatewayFabricMonitorProjectionOptions {
  directory: FabricDirectory;
  connections: FabricConnectionManager;
  journal: GatewayEventJournal;
  now?: () => number;
  sourceId?: string;
  maxItems?: number;
  maxBytes?: number;
}

type ProjectedItem = GatewayFabricConnectorHealthV1 | GatewayFabricDeviceHealthV1 | GatewayFabricEndpointHealthV1;

function byteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? Number.POSITIVE_INFINITY : Buffer.byteLength(serialized, "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function connectorHealth(enabled: boolean, state: string | undefined, expiresAt: number | undefined, now: number): GatewayFabricHealth {
  if (!enabled) return "disabled";
  if (state === "draining") return "degraded";
  if (state === "connected" && expiresAt !== undefined && expiresAt > now) return "online";
  return "offline";
}

function endpointHealth(status: GatewayFabricEndpointHealthV1["status"], device: GatewayFabricHealth): GatewayFabricHealth {
  if (status === "disabled") return "disabled";
  if (device === "disabled") return "disabled";
  if (status === "offline" || device === "offline") return "offline";
  if (status === "online") return device === "online" ? "online" : "degraded";
  return "unknown";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) ? value : undefined;
}

function safeInteger(value: unknown, minimum = 0): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= minimum ? value as number : undefined;
}

function safeHealth(value: unknown): GatewayFabricHealth | undefined {
  return value === "online" || value === "degraded" || value === "offline" || value === "disabled" || value === "unknown" ? value : undefined;
}

/** Strict read-boundary parser used before remote snapshots enter TUI state. */
export function parseGatewayFabricMonitorSnapshot(value: unknown): GatewayFabricMonitorSnapshotV1 | undefined {
  if (byteLength(value) > GATEWAY_FABRIC_MONITOR_MAX_BYTES) return undefined;
  const input = record(value);
  if (!input || input.version !== GATEWAY_FABRIC_MONITOR_VERSION) return undefined;
  const sourceId = safeId(input.sourceId);
  const revision = safeInteger(input.revision, 1);
  const capturedAt = safeInteger(input.capturedAt);
  if (!sourceId || revision === undefined || capturedAt === undefined || typeof input.truncated !== "boolean") return undefined;
  if (!Array.isArray(input.connectors) || !Array.isArray(input.devices) || !Array.isArray(input.endpoints) || !Array.isArray(input.cursors)) return undefined;
  if (input.connectors.length + input.devices.length + input.endpoints.length > GATEWAY_FABRIC_MONITOR_MAX_ITEMS) return undefined;

  const cursors = input.cursors.flatMap((value): GatewayFabricMonitorCursorV1[] => {
    const item = record(value);
    const storeKind = item?.storeKind;
    const cursor = safeInteger(item?.cursor);
    if (!item || !FABRIC_STORE_KINDS.includes(storeKind as FabricStoreKind) || cursor === undefined || item.handle !== `fabric:${storeKind}`) return [];
    return [{ handle: item.handle as string, storeKind: storeKind as FabricStoreKind, cursor }];
  });
  if (cursors.length !== input.cursors.length || cursors.length > FABRIC_STORE_KINDS.length) return undefined;
  if (new Set(cursors.map((cursor) => cursor.storeKind)).size !== cursors.length) return undefined;

  const connectors = input.connectors.flatMap((value): GatewayFabricConnectorHealthV1[] => {
    const item = record(value);
    const connectorId = safeId(item?.connectorId);
    const health = safeHealth(item?.health);
    const revision = safeInteger(item?.revision);
    const connectionId = item?.connectionId === undefined ? undefined : safeId(item.connectionId);
    const connectionGeneration = item?.connectionGeneration === undefined ? undefined : safeInteger(item.connectionGeneration, 1);
    if (!item || item.kind !== "connector" || !connectorId || !health || typeof item.label !== "string" || typeof item.transport !== "string" || typeof item.enabled !== "boolean" || revision === undefined) return [];
    if ((item.connectionId !== undefined && !connectionId) || (item.connectionGeneration !== undefined && connectionGeneration === undefined)) return [];
    return [{ kind: "connector", connectorId, label: sanitizeFabricProjectionText(item.label), transport: sanitizeFabricProjectionText(item.transport), health, enabled: item.enabled, revision, ...(connectionId === undefined ? {} : { connectionId }), ...(connectionGeneration === undefined ? {} : { connectionGeneration }) }];
  });
  if (connectors.length !== input.connectors.length) return undefined;

  const devices = input.devices.flatMap((value): GatewayFabricDeviceHealthV1[] => {
    const item = record(value);
    const deviceId = safeId(item?.deviceId);
    const connectorId = safeId(item?.connectorId);
    const health = safeHealth(item?.health);
    const revision = safeInteger(item?.revision);
    if (!item || item.kind !== "device" || !deviceId || !connectorId || !health || typeof item.label !== "string" || typeof item.enabled !== "boolean" || revision === undefined) return [];
    return [{ kind: "device", deviceId, connectorId, label: sanitizeFabricProjectionText(item.label), health, enabled: item.enabled, revision }];
  });
  if (devices.length !== input.devices.length) return undefined;

  const endpoints = input.endpoints.flatMap((value): GatewayFabricEndpointHealthV1[] => {
    const item = record(value);
    const endpointId = safeId(item?.endpointId);
    const deviceId = safeId(item?.deviceId);
    const connectorId = safeId(item?.connectorId);
    const health = safeHealth(item?.health);
    const generation = safeInteger(item?.generation, 1);
    const revision = safeInteger(item?.revision);
    const status = item?.status;
    if (!item || item.kind !== "endpoint" || !endpointId || !deviceId || !connectorId || !health || (item.endpointKind !== "agent" && item.endpointKind !== "mcp") || typeof item.label !== "string" || (status !== "unknown" && status !== "online" && status !== "offline" && status !== "disabled") || generation === undefined || revision === undefined) return [];
    return [{ kind: "endpoint", endpointId, deviceId, connectorId, endpointKind: item.endpointKind, label: sanitizeFabricProjectionText(item.label), health, status, generation, revision }];
  });
  if (endpoints.length !== input.endpoints.length) return undefined;
  const itemCount = connectors.length + devices.length + endpoints.length;
  if (input.itemCount !== itemCount) return undefined;
  return { version: GATEWAY_FABRIC_MONITOR_VERSION, sourceId, revision, capturedAt, truncated: input.truncated, itemCount, cursors, connectors, devices, endpoints };
}

export class GatewayFabricMonitorProjection {
  readonly sourceId: string;
  private readonly now: () => number;
  private readonly maxItems: number;
  private readonly maxBytes: number;
  private revision = 0;
  private signature = "";

  constructor(private readonly options: GatewayFabricMonitorProjectionOptions) {
    this.sourceId = options.sourceId ?? randomUUID();
    this.now = options.now ?? Date.now;
    this.maxItems = options.maxItems ?? GATEWAY_FABRIC_MONITOR_MAX_ITEMS;
    this.maxBytes = options.maxBytes ?? GATEWAY_FABRIC_MONITOR_MAX_BYTES;
    if (!Number.isSafeInteger(this.maxItems) || this.maxItems < 1 || this.maxItems > GATEWAY_FABRIC_MONITOR_MAX_ITEMS) {
      throw new Error(`Fabric monitor maxItems must be in [1, ${GATEWAY_FABRIC_MONITOR_MAX_ITEMS}]`);
    }
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > GATEWAY_FABRIC_MONITOR_MAX_BYTES) {
      throw new Error(`Fabric monitor maxBytes must be in [1, ${GATEWAY_FABRIC_MONITOR_MAX_BYTES}]`);
    }
  }

  snapshot(): GatewayFabricMonitorSnapshotV1 {
    const capturedAt = this.now();
    const directory = this.options.directory.list();
    const connections = this.options.connections.list();
    const currentByConnector = new Map<string, (typeof connections)[number]>();
    for (const connection of connections) {
      const current = currentByConnector.get(connection.connectorId);
      if (!current || connection.generation > current.generation) currentByConnector.set(connection.connectorId, connection);
    }

    const connectorHealthById = new Map<string, GatewayFabricHealth>();
    const candidates: ProjectedItem[] = [];
    for (const connector of directory.connectors) {
      const connection = currentByConnector.get(connector.connectorId);
      const health = connectorHealth(connector.enabled, connection?.state, connection?.expiresAt, capturedAt);
      connectorHealthById.set(connector.connectorId, health);
      candidates.push({
        kind: "connector",
        connectorId: connector.connectorId,
        label: sanitizeFabricProjectionText(connector.label),
        transport: connector.transport,
        health,
        enabled: connector.enabled,
        revision: connector.revision,
        ...(connection === undefined ? {} : { connectionId: connection.connectionId, connectionGeneration: connection.generation }),
      });
    }

    const deviceHealthById = new Map<string, GatewayFabricHealth>();
    for (const device of directory.devices) {
      const health = !device.enabled ? "disabled" : connectorHealthById.get(device.connectorId) ?? "offline";
      deviceHealthById.set(device.deviceId, health);
      candidates.push({
        kind: "device",
        deviceId: device.deviceId,
        connectorId: device.connectorId,
        label: sanitizeFabricProjectionText(device.label),
        health,
        enabled: device.enabled,
        revision: device.revision,
      });
    }

    for (const endpoint of directory.endpoints) {
      candidates.push({
        kind: "endpoint",
        endpointId: endpoint.endpointId,
        deviceId: endpoint.deviceId,
        connectorId: endpoint.connectorId,
        endpointKind: endpoint.kind,
        label: sanitizeFabricProjectionText(endpoint.kind === "mcp" ? endpoint.serverName : endpoint.endpointId),
        health: endpointHealth(endpoint.status, deviceHealthById.get(endpoint.deviceId) ?? "offline"),
        status: endpoint.status,
        generation: endpoint.generation,
        revision: endpoint.revision,
      });
    }

    const cursors = FABRIC_STORE_KINDS.map((storeKind) => ({
      handle: `fabric:${storeKind}`,
      storeKind,
      cursor: this.options.journal.watermark(`fabric:${storeKind}`),
    }));
    const connectors: GatewayFabricConnectorHealthV1[] = [];
    const devices: GatewayFabricDeviceHealthV1[] = [];
    const endpoints: GatewayFabricEndpointHealthV1[] = [];
    let truncated = false;
    for (const candidate of candidates) {
      if (connectors.length + devices.length + endpoints.length >= this.maxItems) {
        truncated = true;
        break;
      }
      if (candidate.kind === "connector") connectors.push(candidate);
      else if (candidate.kind === "device") devices.push(candidate);
      else endpoints.push(candidate);
      const probe = { version: GATEWAY_FABRIC_MONITOR_VERSION, sourceId: this.sourceId, revision: Number.MAX_SAFE_INTEGER, capturedAt, truncated: false, itemCount: connectors.length + devices.length + endpoints.length, cursors, connectors, devices, endpoints };
      if (byteLength(probe) > this.maxBytes) {
        if (candidate.kind === "connector") connectors.pop();
        else if (candidate.kind === "device") devices.pop();
        else endpoints.pop();
        truncated = true;
        break;
      }
    }

    const content = { cursors, connectors, devices, endpoints, truncated };
    const signature = JSON.stringify(content);
    if (signature !== this.signature) {
      this.signature = signature;
      this.revision += 1;
    }
    const snapshot: GatewayFabricMonitorSnapshotV1 = {
      version: GATEWAY_FABRIC_MONITOR_VERSION,
      sourceId: this.sourceId,
      revision: this.revision,
      capturedAt,
      truncated,
      itemCount: connectors.length + devices.length + endpoints.length,
      cursors,
      connectors,
      devices,
      endpoints,
    };
    if (byteLength(snapshot) > this.maxBytes) throw new Error("Fabric monitor snapshot exceeds its byte budget");
    return structuredClone(snapshot);
  }
}
