import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  FABRIC_OPERATION_CLASSES,
  FABRIC_ROUTE_PATHS,
  FabricContractError,
  assertBoundedString,
  assertFabricIdentifier,
  assertRevision,
  utf8ByteLength,
  type ConnectorId,
  type DeviceId,
  type EndpointId,
  type FabricOperationClass,
  type FabricRoutePath,
  type WorkspaceBindingId,
  type WorkspaceId,
} from "pi-maestro-fabric-core/v1";
import { FABRIC_ROUTE_TICKET_MAX_TTL_MS, FABRIC_ROUTE_TICKET_MIN_TTL_MS } from "./route-ticket.ts";

export const FABRIC_EDGE_CONFIG_VERSION = "fabric.edge-config.v1" as const;
export const FABRIC_EDGE_CONFIG_FILE = "fabric-edge.json";
const MAX_CONFIG_BYTES = 64 * 1024;

/** Defaults for health only. They admit nothing: an unlisted target stays refused. */
const DEFAULT_HEALTH_INTERVAL_MS = 15_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 45_000;
const DEFAULT_TICKET_TTL_MS = 30_000;

export interface FabricEdgeDeviceAllowanceV1 {
  readonly deviceId: DeviceId;
}

export interface FabricEdgeEndpointAllowanceV1 {
  readonly endpointId: EndpointId;
  readonly deviceId: DeviceId;
  readonly operationClasses: readonly FabricOperationClass[];
}

export interface FabricEdgeWorkspaceAllowanceV1 {
  readonly workspaceBindingId: WorkspaceBindingId;
  readonly deviceId: DeviceId;
  readonly workspaceId: WorkspaceId;
  /** Device-local root. Absolute, and never published outside this device. */
  readonly localWorkspacePath: string;
}

/**
 * Health settings, deliberately separate from the route/allowlist decision path.
 *
 * A probe interval is an observation cadence; it is not authority. Sharing a
 * value with admission would let a liveness timer widen what this Edge admits.
 */
export interface FabricEdgeHealthSettingsV1 {
  readonly intervalMs: number;
  readonly timeoutMs: number;
}

/**
 * The Edge's own strict allowlist.
 *
 * There is no discovery switch and no wildcard: v1 admits exactly the Devices,
 * Endpoints, and Workspaces named here, and an unlisted target is a denial.
 */
export interface FabricEdgeConfigV1 {
  version: typeof FABRIC_EDGE_CONFIG_VERSION;
  enabled: boolean;
  connectorId: ConnectorId;
  audience: string;
  /** Network paths this Edge may admit. Required: an absent list admits none. */
  pathCandidates: readonly FabricRoutePath[];
  devices: readonly FabricEdgeDeviceAllowanceV1[];
  endpoints: readonly FabricEdgeEndpointAllowanceV1[];
  workspaces: readonly FabricEdgeWorkspaceAllowanceV1[];
  health: FabricEdgeHealthSettingsV1;
  ticketTtlMs: number;
  revision: number;
}

const ALLOWED_KEYS = new Set([
  "version",
  "enabled",
  "connectorId",
  "audience",
  "pathCandidates",
  "devices",
  "endpoints",
  "workspaces",
  "health",
  "ticketTtlMs",
  "revision",
]);

const ALLOWED_HEALTH_KEYS = new Set(["intervalMs", "timeoutMs"]);
const ALLOWED_DEVICE_KEYS = new Set(["deviceId"]);
const ALLOWED_ENDPOINT_KEYS = new Set(["endpointId", "deviceId", "operationClasses"]);
const ALLOWED_WORKSPACE_KEYS = new Set(["workspaceBindingId", "deviceId", "workspaceId", "localWorkspacePath"]);

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FabricContractError("invalid_argument", `${path} must be a JSON object`, path);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(source: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) {
      throw new FabricContractError("invalid_argument", `${path} has unsupported field ${JSON.stringify(key)}`, key);
    }
  }
}

function positive(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new FabricContractError("invalid_argument", `${path} must be a positive safe integer`, path);
  }
  return value as number;
}

function absolutePath(value: unknown, path: string): string {
  assertBoundedString(value, path, 4_096);
  if (!isAbsolute(value)) {
    throw new FabricContractError("invalid_argument", `${path} must be an absolute path`, path);
  }
  return value;
}

function operationClasses(value: unknown, path: string): readonly FabricOperationClass[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new FabricContractError("invalid_argument", `${path} must name at least one operation class`, path);
  }
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || !(FABRIC_OPERATION_CLASSES as readonly string[]).includes(entry)) {
      throw new FabricContractError("invalid_argument", `${path}[${index}] has an unsupported value`, `${path}[${index}]`);
    }
    if (seen.has(entry)) {
      throw new FabricContractError("conflict", `${path} contains a duplicate`, `${path}[${index}]`);
    }
    seen.add(entry);
  }
  return value as readonly FabricOperationClass[];
}

function pathList(value: unknown): readonly FabricRoutePath[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new FabricContractError("invalid_argument", "pathCandidates must name at least one route path", "pathCandidates");
  }
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || !(FABRIC_ROUTE_PATHS as readonly string[]).includes(entry)) {
      throw new FabricContractError("invalid_argument", `pathCandidates[${index}] has an unsupported value`, `pathCandidates[${index}]`);
    }
    if (seen.has(entry)) {
      throw new FabricContractError("conflict", "pathCandidates contains a duplicate", `pathCandidates[${index}]`);
    }
    seen.add(entry);
  }
  return value as readonly FabricRoutePath[];
}

function healthSettings(value: unknown): FabricEdgeHealthSettingsV1 {
  if (value === undefined) {
    return { intervalMs: DEFAULT_HEALTH_INTERVAL_MS, timeoutMs: DEFAULT_HEALTH_TIMEOUT_MS };
  }
  const source = record(value, "health");
  rejectUnknownKeys(source, ALLOWED_HEALTH_KEYS, "health");
  const intervalMs = positive(source.intervalMs, "health.intervalMs");
  const timeoutMs = positive(source.timeoutMs, "health.timeoutMs");
  if (timeoutMs <= intervalMs) {
    throw new FabricContractError(
      "invalid_argument",
      "health.timeoutMs must exceed health.intervalMs, or a live Endpoint is probed into failure",
      "health.timeoutMs",
    );
  }
  return { intervalMs, timeoutMs };
}

/**
 * Strict parse of one Edge allowlist document.
 *
 * An undeclared key is an error rather than an ignored value: this document
 * decides what this device will execute, and a silently dropped setting would
 * be indistinguishable from one that was honoured.
 */
export function parseFabricEdgeConfig(input: unknown): FabricEdgeConfigV1 {
  const source = record(input, "Fabric Edge config");
  rejectUnknownKeys(source, ALLOWED_KEYS, "Fabric Edge config");
  if (source.version !== FABRIC_EDGE_CONFIG_VERSION) {
    throw new FabricContractError("unsupported_version", "Unsupported Fabric Edge config version", "version");
  }
  if (typeof source.enabled !== "boolean") {
    throw new FabricContractError("invalid_argument", "enabled must be a boolean", "enabled");
  }
  assertFabricIdentifier(source.connectorId, "connectorId");
  assertBoundedString(source.audience, "audience", 256);
  assertRevision(source.revision, "revision");

  const ticketTtlMs = source.ticketTtlMs === undefined ? DEFAULT_TICKET_TTL_MS : positive(source.ticketTtlMs, "ticketTtlMs");
  if (ticketTtlMs < FABRIC_ROUTE_TICKET_MIN_TTL_MS || ticketTtlMs > FABRIC_ROUTE_TICKET_MAX_TTL_MS) {
    throw new FabricContractError(
      "invalid_argument",
      `ticketTtlMs must be between ${FABRIC_ROUTE_TICKET_MIN_TTL_MS} and ${FABRIC_ROUTE_TICKET_MAX_TTL_MS}`,
      "ticketTtlMs",
    );
  }

  if (!Array.isArray(source.devices)) {
    throw new FabricContractError("invalid_argument", "devices must be an explicit list, even when empty", "devices");
  }
  const devices: FabricEdgeDeviceAllowanceV1[] = [];
  const deviceIds = new Set<string>();
  for (const [index, entry] of source.devices.entries()) {
    const device = record(entry, `devices[${index}]`);
    rejectUnknownKeys(device, ALLOWED_DEVICE_KEYS, `devices[${index}]`);
    assertFabricIdentifier(device.deviceId, `devices[${index}].deviceId`);
    if (deviceIds.has(device.deviceId)) {
      throw new FabricContractError("conflict", "devices contains a duplicate", `devices[${index}].deviceId`);
    }
    deviceIds.add(device.deviceId);
    devices.push({ deviceId: device.deviceId });
  }

  if (!Array.isArray(source.endpoints)) {
    throw new FabricContractError("invalid_argument", "endpoints must be an explicit list, even when empty", "endpoints");
  }
  const endpoints: FabricEdgeEndpointAllowanceV1[] = [];
  const endpointIds = new Set<string>();
  for (const [index, entry] of source.endpoints.entries()) {
    const endpoint = record(entry, `endpoints[${index}]`);
    rejectUnknownKeys(endpoint, ALLOWED_ENDPOINT_KEYS, `endpoints[${index}]`);
    assertFabricIdentifier(endpoint.endpointId, `endpoints[${index}].endpointId`);
    assertFabricIdentifier(endpoint.deviceId, `endpoints[${index}].deviceId`);
    // An Endpoint on a Device this Edge does not allow would be reachable
    // through the Endpoint list alone, so the two lists must agree.
    if (!deviceIds.has(endpoint.deviceId)) {
      throw new FabricContractError(
        "permission_denied",
        "An allowed Endpoint must belong to an allowed Device",
        `endpoints[${index}].deviceId`,
      );
    }
    if (endpointIds.has(endpoint.endpointId)) {
      throw new FabricContractError("conflict", "endpoints contains a duplicate", `endpoints[${index}].endpointId`);
    }
    endpointIds.add(endpoint.endpointId);
    endpoints.push({
      endpointId: endpoint.endpointId,
      deviceId: endpoint.deviceId,
      operationClasses: operationClasses(endpoint.operationClasses, `endpoints[${index}].operationClasses`),
    });
  }

  if (!Array.isArray(source.workspaces)) {
    throw new FabricContractError("invalid_argument", "workspaces must be an explicit list, even when empty", "workspaces");
  }
  const workspaces: FabricEdgeWorkspaceAllowanceV1[] = [];
  const bindingIds = new Set<string>();
  for (const [index, entry] of source.workspaces.entries()) {
    const workspace = record(entry, `workspaces[${index}]`);
    rejectUnknownKeys(workspace, ALLOWED_WORKSPACE_KEYS, `workspaces[${index}]`);
    assertFabricIdentifier(workspace.workspaceBindingId, `workspaces[${index}].workspaceBindingId`);
    assertFabricIdentifier(workspace.deviceId, `workspaces[${index}].deviceId`);
    assertFabricIdentifier(workspace.workspaceId, `workspaces[${index}].workspaceId`);
    if (!deviceIds.has(workspace.deviceId)) {
      throw new FabricContractError(
        "permission_denied",
        "An allowed Workspace must belong to an allowed Device",
        `workspaces[${index}].deviceId`,
      );
    }
    if (bindingIds.has(workspace.workspaceBindingId)) {
      throw new FabricContractError("conflict", "workspaces contains a duplicate", `workspaces[${index}].workspaceBindingId`);
    }
    bindingIds.add(workspace.workspaceBindingId);
    workspaces.push({
      workspaceBindingId: workspace.workspaceBindingId,
      deviceId: workspace.deviceId,
      workspaceId: workspace.workspaceId,
      localWorkspacePath: absolutePath(workspace.localWorkspacePath, `workspaces[${index}].localWorkspacePath`),
    });
  }

  return {
    version: FABRIC_EDGE_CONFIG_VERSION,
    enabled: source.enabled,
    connectorId: source.connectorId,
    audience: source.audience,
    pathCandidates: pathList(source.pathCandidates),
    devices,
    endpoints,
    workspaces,
    health: healthSettings(source.health),
    ticketTtlMs,
    revision: source.revision,
  };
}

/** The Edge allowlist path under a workspace root. */
export function fabricEdgeConfigPath(root: string): string {
  return join(root, ".pi", FABRIC_EDGE_CONFIG_FILE);
}

/**
 * Read and parse a bounded allowlist document.
 *
 * A missing file is `undefined`, not an empty allowlist: an unconfigured Edge
 * is a supported state, while a silently empty allowlist would look configured.
 */
export async function loadFabricEdgeConfig(path: string): Promise<FabricEdgeConfigV1 | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (utf8ByteLength(raw) > MAX_CONFIG_BYTES) {
    throw new FabricContractError("resource_exhausted", "Fabric Edge config exceeds the maximum size");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FabricContractError("invalid_argument", "Fabric Edge config is not valid JSON");
  }
  return parseFabricEdgeConfig(parsed);
}

/** Lookups. Absence is a denial; there is no wildcard and no default. */
export function allowedEdgeDevice(config: FabricEdgeConfigV1, deviceId: DeviceId): FabricEdgeDeviceAllowanceV1 | undefined {
  return config.devices.find((device) => device.deviceId === deviceId);
}

export function allowedEdgeEndpoint(
  config: FabricEdgeConfigV1,
  deviceId: DeviceId,
  endpointId: EndpointId,
): FabricEdgeEndpointAllowanceV1 | undefined {
  return config.endpoints.find((endpoint) => endpoint.endpointId === endpointId && endpoint.deviceId === deviceId);
}

export function allowedEdgeWorkspace(
  config: FabricEdgeConfigV1,
  deviceId: DeviceId,
  workspaceBindingId: WorkspaceBindingId,
): FabricEdgeWorkspaceAllowanceV1 | undefined {
  return config.workspaces.find(
    (workspace) => workspace.workspaceBindingId === workspaceBindingId && workspace.deviceId === deviceId,
  );
}

export function requireAllowedEdgeDevice(config: FabricEdgeConfigV1, deviceId: DeviceId): FabricEdgeDeviceAllowanceV1 {
  assertFabricIdentifier(deviceId, "deviceId");
  const device = allowedEdgeDevice(config, deviceId);
  if (device === undefined) {
    throw new FabricContractError("permission_denied", "Device is not on this Edge's allowlist", "deviceId");
  }
  return device;
}

export function requireAllowedEdgeEndpoint(
  config: FabricEdgeConfigV1,
  deviceId: DeviceId,
  endpointId: EndpointId,
): FabricEdgeEndpointAllowanceV1 {
  assertFabricIdentifier(deviceId, "deviceId");
  assertFabricIdentifier(endpointId, "endpointId");
  const endpoint = allowedEdgeEndpoint(config, deviceId, endpointId);
  if (endpoint === undefined) {
    throw new FabricContractError("permission_denied", "Endpoint is not on this Edge's allowlist", "endpointId");
  }
  return endpoint;
}

export function requireAllowedEdgeWorkspace(
  config: FabricEdgeConfigV1,
  deviceId: DeviceId,
  workspaceBindingId: WorkspaceBindingId,
): FabricEdgeWorkspaceAllowanceV1 {
  assertFabricIdentifier(deviceId, "deviceId");
  assertFabricIdentifier(workspaceBindingId, "workspaceBindingId");
  const workspace = allowedEdgeWorkspace(config, deviceId, workspaceBindingId);
  if (workspace === undefined) {
    throw new FabricContractError("permission_denied", "Workspace is not on this Edge's allowlist", "workspaceBindingId");
  }
  return workspace;
}
