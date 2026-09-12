import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  FabricContractError,
  assertBoundedString,
  assertFabricIdentifier,
  assertGeneration,
  assertRevision,
  utf8ByteLength,
} from "pi-maestro-fabric-core/v1";

export const FABRIC_CONNECTOR_CONFIG_VERSION = "fabric.connector-config.v1" as const;
export const FABRIC_CONNECTOR_CONFIG_FILE = "fabric-connector.json";
const MAX_CONFIG_BYTES = 64 * 1024;

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
