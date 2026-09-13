import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  FabricContractError,
  assertBoundedString,
  assertFabricIdentifier,
  assertGeneration,
  assertRevision,
  assertValidDeviceRecord,
  utf8ByteLength,
  type DeviceRecord,
} from "pi-maestro-fabric-core/v1";

export const FABRIC_CONNECTOR_CONFIG_VERSION = "fabric.connector-config.v1" as const;
export const FABRIC_CONNECTOR_CONFIG_FILE = "fabric-connector.json";
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_AGENT_SOURCE_ENTRIES = 256;
const MAX_AGENT_SOURCE_CONCURRENCY = 1_024;

/** Explicit allowlists for exporting this device's executable Agent source. */
export interface FabricConnectorAgentSourcesV1 {
  readonly roles: readonly string[];
  readonly taskTypes: readonly string[];
  readonly models: readonly string[];
  readonly backends: readonly string[];
  readonly maxConcurrency: number;
}

/**
 * Durable Connector settings.
 *
 * The file names the private-key path but never carries key material: the key
 * stays on the device, and a configuration document can therefore be committed
 * and displayed in full.
 */
export interface FabricConnectorConfigV1 {
  version: typeof FABRIC_CONNECTOR_CONFIG_VERSION;
  enabled: boolean;
  hubUrl: string;
  connectorId: string;
  keyId: string;
  audience: string;
  credentialGeneration: number;
  /** Absolute path to the Ed25519 private key on this device. */
  privateKeyPath: string;
  /** Absolute path to the Hub CA used to pin the TLS peer, when not a public CA. */
  caPath?: string;
  heartbeatIntervalMs?: number;
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
  /** Registered Device authority. Optional only for status compatibility with legacy v1. */
  devices?: readonly DeviceRecord[];
  /** This host's registered Device. Optional only for legacy status reads. */
  localDeviceId?: string;
  /** Explicit local workspace export allowlist; empty means export none. */
  workspaceIds?: readonly string[];
  /** Explicit Agent export policy. Omission exports no Agent Endpoint. */
  agentSources?: FabricConnectorAgentSourcesV1;
  revision: number;
}

const ALLOWED_KEYS = new Set([
  "version",
  "enabled",
  "hubUrl",
  "connectorId",
  "keyId",
  "audience",
  "credentialGeneration",
  "privateKeyPath",
  "caPath",
  "heartbeatIntervalMs",
  "reconnectDelayMs",
  "maxReconnectAttempts",
  "devices",
  "localDeviceId",
  "workspaceIds",
  "agentSources",
  "revision",
]);

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FabricContractError("invalid_argument", "Fabric Connector config must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function optionalPositive(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
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

function identifierList(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 256) throw new FabricContractError("invalid_argument", `${path} must be a bounded array`, path);
  const result = value.map((entry, index) => {
    assertFabricIdentifier(entry, `${path}[${index}]`);
    return entry;
  });
  if (new Set(result).size !== result.length) throw new FabricContractError("invalid_argument", `${path} must not contain duplicates`, path);
  return result;
}

function requiredIdentifierList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_AGENT_SOURCE_ENTRIES) {
    throw new FabricContractError("invalid_argument", `${path} must be an array with at most ${MAX_AGENT_SOURCE_ENTRIES} entries`, path);
  }
  const result = value.map((entry, index) => {
    assertFabricIdentifier(entry, `${path}[${index}]`);
    return entry;
  });
  if (new Set(result).size !== result.length) throw new FabricContractError("invalid_argument", `${path} must not contain duplicates`, path);
  return result;
}

function requiredModelList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_AGENT_SOURCE_ENTRIES) {
    throw new FabricContractError("invalid_argument", `${path} must be an array with at most ${MAX_AGENT_SOURCE_ENTRIES} entries`, path);
  }
  const result = value.map((entry, index) => {
    assertBoundedString(entry, `${path}[${index}]`, 256);
    if (/\s|[\u0000-\u001f\u007f]/u.test(entry)) {
      throw new FabricContractError("invalid_argument", `${path}[${index}] contains whitespace or control characters`, `${path}[${index}]`);
    }
    return entry;
  });
  if (new Set(result).size !== result.length) throw new FabricContractError("invalid_argument", `${path} must not contain duplicates`, path);
  return result;
}

function agentSourcesOf(value: unknown): FabricConnectorAgentSourcesV1 | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FabricContractError("invalid_argument", "agentSources must be an object", "agentSources");
  }
  const source = value as Readonly<Record<string, unknown>>;
  const allowed = new Set(["roles", "taskTypes", "models", "backends", "maxConcurrency"]);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw new FabricContractError("invalid_argument", `agentSources.${key} is not supported`, `agentSources.${key}`);
  }
  const maxConcurrency = optionalPositive(source.maxConcurrency, "agentSources.maxConcurrency");
  if (maxConcurrency === undefined || maxConcurrency > MAX_AGENT_SOURCE_CONCURRENCY) {
    throw new FabricContractError(
      "invalid_argument",
      `agentSources.maxConcurrency must be in [1, ${MAX_AGENT_SOURCE_CONCURRENCY}]`,
      "agentSources.maxConcurrency",
    );
  }
  return {
    roles: requiredIdentifierList(source.roles, "agentSources.roles"),
    taskTypes: requiredIdentifierList(source.taskTypes, "agentSources.taskTypes"),
    models: requiredModelList(source.models, "agentSources.models"),
    backends: requiredIdentifierList(source.backends, "agentSources.backends"),
    maxConcurrency,
  };
}

function devicesOf(value: unknown, connectorId: string): DeviceRecord[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 256) throw new FabricContractError("invalid_argument", "devices must be a bounded array", "devices");
  const devices = value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new FabricContractError("invalid_argument", `devices[${index}] must be an object`, `devices[${index}]`);
    const source = entry as Readonly<Record<string, unknown>>;
    const allowed = new Set(["deviceId", "connectorId", "label", "connectionMode", "platform", "architecture", "enabled", "revision"]);
    for (const key of Object.keys(source)) if (!allowed.has(key)) throw new FabricContractError("invalid_argument", `devices[${index}].${key} is not supported`, `devices[${index}].${key}`);
    const candidate: unknown = structuredClone(entry);
    assertValidDeviceRecord(candidate);
    if (candidate.connectorId !== connectorId) throw new FabricContractError("invalid_argument", `devices[${index}] belongs to another Connector`, `devices[${index}].connectorId`);
    return candidate;
  });
  if (new Set(devices.map((device) => device.deviceId)).size !== devices.length) throw new FabricContractError("invalid_argument", "devices must not contain duplicate identities", "devices");
  return devices;
}

function assertHubUrl(value: unknown): string {
  assertBoundedString(value, "hubUrl", 2_048);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FabricContractError("invalid_argument", "hubUrl must be a valid URL", "hubUrl");
  }
  if (url.protocol !== "wss:") {
    throw new FabricContractError("invalid_argument", "hubUrl must use wss://", "hubUrl");
  }
  if (url.username !== "" || url.password !== "") {
    throw new FabricContractError(
      "invalid_argument",
      "hubUrl must not embed credentials; the Connector authenticates by key proof",
      "hubUrl",
    );
  }
  if (url.hash !== "") {
    throw new FabricContractError("invalid_argument", "hubUrl must not carry a fragment", "hubUrl");
  }
  return url.toString();
}

/**
 * Strict parse of one Connector configuration document.
 *
 * An undeclared key is an error rather than a silently ignored value: a
 * misspelled setting that the runtime drops is indistinguishable from one it
 * honoured, and this document decides where a device dials out.
 */
export function parseFabricConnectorConfig(input: unknown): FabricConnectorConfigV1 {
  const source = record(input);
  for (const key of Object.keys(source)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new FabricContractError("invalid_argument", `Fabric Connector config has unsupported field ${JSON.stringify(key)}`, key);
    }
  }
  if (source.version !== FABRIC_CONNECTOR_CONFIG_VERSION) {
    throw new FabricContractError("unsupported_version", "Unsupported Fabric Connector config version", "version");
  }
  if (typeof source.enabled !== "boolean") {
    throw new FabricContractError("invalid_argument", "enabled must be a boolean", "enabled");
  }
  assertFabricIdentifier(source.connectorId, "connectorId");
  assertFabricIdentifier(source.keyId, "keyId");
  assertBoundedString(source.audience, "audience", 256);
  assertGeneration(source.credentialGeneration, "credentialGeneration");
  assertRevision(source.revision, "revision");
  const heartbeatIntervalMs = optionalPositive(source.heartbeatIntervalMs, "heartbeatIntervalMs");
  const reconnectDelayMs = optionalPositive(source.reconnectDelayMs, "reconnectDelayMs");
  const maxReconnectAttempts = optionalPositive(source.maxReconnectAttempts, "maxReconnectAttempts");
  const devices = devicesOf(source.devices, source.connectorId);
  const workspaceIds = identifierList(source.workspaceIds, "workspaceIds");
  const agentSources = agentSourcesOf(source.agentSources);
  let localDeviceId: string | undefined;
  if (source.localDeviceId !== undefined) {
    assertFabricIdentifier(source.localDeviceId, "localDeviceId");
    localDeviceId = source.localDeviceId;
  }
  const metadataPresent = devices !== undefined || localDeviceId !== undefined || workspaceIds !== undefined;
  if (metadataPresent && (devices === undefined || localDeviceId === undefined || workspaceIds === undefined)) {
    throw new FabricContractError("invalid_argument", "devices, localDeviceId, and workspaceIds must be provided together", "devices");
  }
  if (devices !== undefined && localDeviceId !== undefined && !devices.some((device) => device.deviceId === localDeviceId)) {
    throw new FabricContractError("invalid_argument", "localDeviceId must name a registered Device", "localDeviceId");
  }
  return {
    version: FABRIC_CONNECTOR_CONFIG_VERSION,
    enabled: source.enabled,
    hubUrl: assertHubUrl(source.hubUrl),
    connectorId: source.connectorId,
    keyId: source.keyId,
    audience: source.audience,
    credentialGeneration: source.credentialGeneration,
    privateKeyPath: absolutePath(source.privateKeyPath, "privateKeyPath"),
    ...(source.caPath === undefined ? {} : { caPath: absolutePath(source.caPath, "caPath") }),
    ...(heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs }),
    ...(reconnectDelayMs === undefined ? {} : { reconnectDelayMs }),
    ...(maxReconnectAttempts === undefined ? {} : { maxReconnectAttempts }),
    ...(devices === undefined ? {} : { devices }),
    ...(localDeviceId === undefined ? {} : { localDeviceId }),
    ...(workspaceIds === undefined ? {} : { workspaceIds }),
    ...(agentSources === undefined ? {} : { agentSources }),
    revision: source.revision,
  };
}

/** The Connector configuration path under a workspace root. */
export function fabricConnectorConfigPath(root: string): string {
  return join(root, ".pi", FABRIC_CONNECTOR_CONFIG_FILE);
}

/**
 * Read and parse a bounded configuration document.
 *
 * A missing file is reported as `undefined` rather than as an error: an
 * unconfigured Connector is a supported state, and inventing a default Hub
 * would dial somewhere the operator never named.
 */
export async function loadFabricConnectorConfig(path: string): Promise<FabricConnectorConfigV1 | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (utf8ByteLength(raw) > MAX_CONFIG_BYTES) {
    throw new FabricContractError("resource_exhausted", "Fabric Connector config exceeds the maximum size");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FabricContractError("invalid_argument", "Fabric Connector config is not valid JSON");
  }
  return parseFabricConnectorConfig(parsed);
}
