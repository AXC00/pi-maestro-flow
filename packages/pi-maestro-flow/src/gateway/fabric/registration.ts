/** Durable Connector/Device registration and credential authority for Gateway Fabric. */
import { createHash, createPublicKey, timingSafeEqual } from "node:crypto";
import {
  FabricContractError,
  assertBoundedString,
  assertEpochMilliseconds,
  assertFabricIdentifier,
  assertGeneration,
  assertRevision,
  assertValidConnectorRecord,
  assertValidDeviceRecord,
  type ConnectorRecord,
  type DeviceRecord,
  type JsonValue,
} from "pi-maestro-fabric-core/v1";
import {
  FabricDirectory,
  FabricStoreCoordinator,
  type FabricAuthoritySeed,
  type FabricLogicalStoreSnapshot,
  type FabricStoredRecord,
} from "pi-maestro-fabric";
import {
  FABRIC_CONNECTOR_CREDENTIAL_VERSION,
  type FabricConnectorCredentialAuthority,
  type FabricConnectorCredentialV1,
} from "./security.ts";

export const FABRIC_REGISTRATION_RECORD_VERSION = 1 as const;
export const FABRIC_REGISTRATION_RECEIPT_VERSION = "fabric.registration-receipt.v1" as const;
export const FABRIC_CONNECTOR_RECORD_TYPE = "fabric.connector-registration" as const;
export const FABRIC_DEVICE_RECORD_TYPE = "fabric.device-registration" as const;
export const FABRIC_PAIRING_CONSUMPTION_RECORD_TYPE = "fabric.pairing-consumption" as const;
export const FABRIC_REGISTRATION_OPERATION_RECORD_TYPE = "fabric.registration-operation" as const;
export const FABRIC_CONNECT_SCOPE = "fabric.connect" as const;
export const FABRIC_ENROLL_SCOPE = "fabric.enroll" as const;
export const FABRIC_ROTATE_SCOPE = "fabric.rotate" as const;
export const FABRIC_PAIRING_PROVIDER = "fabric-registration" as const;

const CONNECTOR_PREFIX = "connector:";
const DEVICE_PREFIX = "device:";
const PAIRING_PREFIX = "pairing:";
const OPERATION_PREFIX = "registration-operation:";
const ED25519_SPKI_MAX_BYTES = 512;
const RECEIPT_RECOVERY_MS = 24 * 60 * 60 * 1_000;
const CONNECTOR_TRANSPORTS = ["outbound-wss", "ssh", "direct-https", "edge-relay"] as const;
const CONNECTION_MODES = ["direct", "edge-managed", "ssh", "https"] as const;
const REGISTRATION_OPERATIONS = ["enroll", "rotate", "revoke"] as const;
const PAIRING_OPERATIONS = ["enroll", "rotate"] as const;
const PAIRING_STATES = ["consumed", "revoked"] as const;
const RECEIPT_STATUSES = ["active", "superseded", "revoked"] as const;

type RegistrationOperation = "enroll" | "rotate" | "revoke";
type PairingOperation = "enroll" | "rotate";
type PairingState = "consumed" | "revoked";
type ReceiptStatus = "active" | "superseded" | "revoked";

export interface GatewayFabricConnectorRegistrationV1 extends ConnectorRecord {
  readonly recordType: typeof FABRIC_CONNECTOR_RECORD_TYPE;
  readonly version: typeof FABRIC_REGISTRATION_RECORD_VERSION;
  readonly keyId: string;
  readonly publicKeySpki: string;
  readonly publicKeyFingerprint: string;
  readonly audience: string;
  readonly scopes: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt?: number;
  readonly revokedAt?: number;
}

export interface GatewayFabricDeviceRegistrationV1 extends DeviceRecord {
  readonly recordType: typeof FABRIC_DEVICE_RECORD_TYPE;
  readonly version: typeof FABRIC_REGISTRATION_RECORD_VERSION;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface GatewayFabricPairingConsumptionV1 {
  readonly recordType: typeof FABRIC_PAIRING_CONSUMPTION_RECORD_TYPE;
  readonly version: typeof FABRIC_REGISTRATION_RECORD_VERSION;
  readonly pairingId: string;
  readonly connectorId: string;
  readonly operation: PairingOperation;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly receiptVerifier: string;
  readonly receiptAvailableUntil: number;
  readonly consumedAt: number;
  readonly state: PairingState;
  readonly revokedAt?: number;
  readonly revision: number;
}

export interface GatewayFabricRegistrationReceiptV1 {
  readonly version: typeof FABRIC_REGISTRATION_RECEIPT_VERSION;
  readonly requestId: string;
  readonly operation: RegistrationOperation;
  readonly connectorId: string;
  readonly requestDigest: string;
  readonly connectorRevision: number;
  readonly credentialGeneration: number;
  readonly status: ReceiptStatus;
  readonly committedAt: number;
}

export interface GatewayFabricRegistrationOperationV1 {
  readonly recordType: typeof FABRIC_REGISTRATION_OPERATION_RECORD_TYPE;
  readonly version: typeof FABRIC_REGISTRATION_RECORD_VERSION;
  readonly requestId: string;
  readonly operation: RegistrationOperation;
  readonly connectorId: string;
  readonly requestDigest: string;
  readonly pairingId?: string;
  readonly receipt: GatewayFabricRegistrationReceiptV1;
  readonly createdAt: number;
  readonly revision: number;
}

export interface GatewayFabricEnrollmentInput {
  readonly requestId: string;
  readonly pairingId: string;
  readonly rawToken: string;
  /** Authenticated purpose-token expiry, rechecked inside the registry transaction. */
  readonly authorizationExpiresAt?: number;
  readonly connector: Omit<ConnectorRecord, "credentialGeneration" | "enabled" | "revision" | "instanceNonce" | "lastSeenAt">;
  readonly devices: readonly Omit<DeviceRecord, "connectorId" | "revision">[];
  readonly keyId: string;
  readonly publicKeySpki: string;
  readonly expiresAt?: number;
}

export interface GatewayFabricRotationInput {
  readonly requestId: string;
  readonly pairingId: string;
  readonly rawToken: string;
  /** Authenticated purpose-token expiry, rechecked inside the registry transaction. */
  readonly authorizationExpiresAt?: number;
  readonly connectorId: string;
  readonly expectedRevision: number;
  readonly expectedCredentialGeneration: number;
  readonly keyId: string;
  readonly publicKeySpki: string;
}

export interface GatewayFabricRevocationInput {
  readonly requestId: string;
  readonly connectorId: string;
  readonly expectedRevision: number;
  readonly pairingId?: string;
}

export interface GatewayFabricReceiptRequest {
  readonly requestId: string;
  readonly rawToken: string;
  readonly requestDigest: string;
}

export interface GatewayFabricRegistrationAuthorityOptions {
  readonly audience: string;
  readonly now?: () => number;
  readonly receiptRecoveryMs?: number;
}

function recordOf(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FabricContractError("protocol_violation", `${path} must be an object`, path);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(record: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[], path: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new FabricContractError("protocol_violation", `${path}.${key} is not supported`, `${path}.${key}`);
  }
  for (const key of required) {
    if (!(key in record)) throw new FabricContractError("protocol_violation", `${path}.${key} is required`, `${path}.${key}`);
  }
}

function requiredString(record: Readonly<Record<string, unknown>>, key: string, path: string, maximum = 256): string {
  const value = record[key];
  try { assertBoundedString(value, `${path}.${key}`, maximum); }
  catch (error) { throw storedError(error, `${path}.${key}`); }
  return value;
}

function requiredIdentifier(record: Readonly<Record<string, unknown>>, key: string, path: string): string {
  const value = record[key];
  try { assertFabricIdentifier(value, `${path}.${key}`); }
  catch (error) { throw storedError(error, `${path}.${key}`); }
  return value;
}

function requiredTimestamp(record: Readonly<Record<string, unknown>>, key: string, path: string): number {
  const value = record[key];
  try { assertEpochMilliseconds(value, `${path}.${key}`); }
  catch (error) { throw storedError(error, `${path}.${key}`); }
  return value;
}

function optionalTimestamp(record: Readonly<Record<string, unknown>>, key: string, path: string): number | undefined {
  if (record[key] === undefined) return undefined;
  return requiredTimestamp(record, key, path);
}

function requiredRevision(record: Readonly<Record<string, unknown>>, key: string, path: string): number {
  const value = record[key];
  try { assertRevision(value, `${path}.${key}`); }
  catch (error) { throw storedError(error, `${path}.${key}`); }
  if (value < 1) throw new FabricContractError("protocol_violation", `${path}.${key} must be positive`, `${path}.${key}`);
  return value;
}

function requiredGeneration(record: Readonly<Record<string, unknown>>, key: string, path: string): number {
  const value = record[key];
  try { assertGeneration(value, `${path}.${key}`); }
  catch (error) { throw storedError(error, `${path}.${key}`); }
  return value;
}

function requiredBoolean(record: Readonly<Record<string, unknown>>, key: string, path: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new FabricContractError("protocol_violation", `${path}.${key} must be boolean`, `${path}.${key}`);
  return value;
}

function requiredOneOf<const T extends readonly string[]>(
  record: Readonly<Record<string, unknown>>,
  key: string,
  path: string,
  values: T,
): T[number] {
  const value = requiredString(record, key, path);
  const selected = values.find((candidate) => candidate === value);
  if (selected === undefined) throw new FabricContractError("protocol_violation", `${path}.${key} is not supported`, `${path}.${key}`);
  return selected;
}

function storedError(error: unknown, path: string): FabricContractError {
  return new FabricContractError("protocol_violation", error instanceof Error ? error.message : `Malformed stored Fabric registration at ${path}`, path);
}

function stringList(record: Readonly<Record<string, unknown>>, key: string, path: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new FabricContractError("protocol_violation", `${path}.${key} must be a non-empty bounded array`, `${path}.${key}`);
  }
  const result: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") throw new FabricContractError("protocol_violation", `${path}.${key}[${index}] must be a string`, `${path}.${key}[${index}]`);
    assertBoundedString(entry, `${path}.${key}[${index}]`, 128);
    result.push(entry);
  }
  if (new Set(result).size !== result.length) throw new FabricContractError("protocol_violation", `${path}.${key} contains duplicates`, `${path}.${key}`);
  return result;
}

function assertInputIdentifier(value: unknown, path: string): asserts value is string {
  assertFabricIdentifier(value, path);
  const subject = path === "connectorId" ? `${CONNECTOR_PREFIX}${value}` :
    path === "deviceId" ? `${DEVICE_PREFIX}${value}` :
    path === "pairingId" ? `${PAIRING_PREFIX}${value}` : `${OPERATION_PREFIX}${value}`;
  assertFabricIdentifier(subject, `${path} registry subject`);
}

function canonicalSpki(input: string, path = "publicKeySpki"): { publicKeySpki: string; fingerprint: string } {
  assertBoundedString(input, path, ED25519_SPKI_MAX_BYTES);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(input)) throw new FabricContractError("invalid_argument", `${path} must be base64 SPKI DER`, path);
  let key: ReturnType<typeof createPublicKey>;
  try { key = createPublicKey({ key: Buffer.from(input, "base64"), format: "der", type: "spki" }); }
  catch { throw new FabricContractError("invalid_argument", `${path} is not a parsable public key`, path); }
  if (key.asymmetricKeyType !== "ed25519") throw new FabricContractError("invalid_argument", `${path} must be an Ed25519 public key`, path);
  const der = key.export({ format: "der", type: "spki" });
  const buffer = Buffer.isBuffer(der) ? der : Buffer.from(der);
  return { publicKeySpki: buffer.toString("base64"), fingerprint: createHash("sha256").update(buffer).digest("hex") };
}

function tokenVerifier(token: string): string {
  if (typeof token !== "string" || token.length < 1 || Buffer.byteLength(token, "utf8") > 1_024) {
    throw new FabricContractError("unauthenticated", "Fabric registration token is invalid", "authorization");
  }
  return createHash("sha256").update("pi-maestro.fabric.registration-receipt.v1\0", "utf8").update(token, "utf8").digest("hex");
}

function equalVerifier(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}

function assertExactRuntimeKeys(value: object, allowed: readonly string[], path: string): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) throw new FabricContractError("invalid_argument", `${path}.${key} is not supported`, `${path}.${key}`);
  }
}

function canonicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => canonicalCompare(left, right))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalJson(value)), "utf8").digest("hex");
}

function asStored(value: object): FabricStoredRecord {
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) if (entry !== undefined) result[key] = entry as JsonValue;
  return result;
}

function connectorSubject(connectorId: string): string { return `${CONNECTOR_PREFIX}${connectorId}`; }
function deviceSubject(deviceId: string): string { return `${DEVICE_PREFIX}${deviceId}`; }
function pairingSubject(pairingId: string): string { return `${PAIRING_PREFIX}${pairingId}`; }
function operationSubject(requestId: string): string { return `${OPERATION_PREFIX}${requestId}`; }

export interface GatewayFabricEnrollmentDigestBody {
  readonly requestId: string;
  readonly connector: GatewayFabricEnrollmentInput["connector"];
  readonly devices: GatewayFabricEnrollmentInput["devices"];
  readonly keyId: string;
  readonly publicKeySpki: string;
  readonly expiresAt?: number;
}

/** Stable client/server digest used for enrollment idempotency and receipt recovery. */
export function gatewayFabricEnrollmentBodyDigest(input: GatewayFabricEnrollmentDigestBody): string {
  assertExactRuntimeKeys(input, ["requestId", "connector", "devices", "keyId", "publicKeySpki", "expiresAt"], "input");
  assertExactRuntimeKeys(input.connector, ["connectorId", "label", "transport"], "connector");
  const key = canonicalSpki(input.publicKeySpki);
  const connector: ConnectorRecord = {
    connectorId: input.connector.connectorId,
    label: input.connector.label,
    transport: input.connector.transport,
    credentialGeneration: 1,
    enabled: true,
    revision: 1,
  };
  assertValidConnectorRecord(connector);
  const devices = input.devices.map((device, index): DeviceRecord => {
    assertExactRuntimeKeys(device, ["deviceId", "label", "connectionMode", "platform", "architecture", "enabled"], `devices[${index}]`);
    const candidate: DeviceRecord = {
      deviceId: device.deviceId,
      connectorId: input.connector.connectorId,
      label: device.label,
      connectionMode: device.connectionMode,
      ...(device.platform === undefined ? {} : { platform: device.platform }),
      ...(device.architecture === undefined ? {} : { architecture: device.architecture }),
      enabled: device.enabled,
      revision: 1,
    };
    assertValidDeviceRecord(candidate);
    return candidate;
  }).sort((a, b) => canonicalCompare(a.deviceId, b.deviceId));
  return digest({ operation: "enroll", connector, devices, keyId: input.keyId, publicKeySpki: key.publicKeySpki, expiresAt: input.expiresAt });
}

export function gatewayFabricEnrollmentRequestDigest(input: Omit<GatewayFabricEnrollmentInput, "rawToken">): string {
  const { pairingId: _pairingId, authorizationExpiresAt: _authorizationExpiresAt, ...body } = input;
  return gatewayFabricEnrollmentBodyDigest(body);
}

export interface GatewayFabricRotationDigestBody {
  readonly requestId: string;
  readonly connectorId: string;
  readonly expectedRevision: number;
  readonly expectedCredentialGeneration: number;
  readonly keyId: string;
  readonly publicKeySpki: string;
}

/** Stable client/server digest used for rotation idempotency and receipt recovery. */
export function gatewayFabricRotationBodyDigest(input: GatewayFabricRotationDigestBody): string {
  assertExactRuntimeKeys(input, ["requestId", "connectorId", "expectedRevision", "expectedCredentialGeneration", "keyId", "publicKeySpki"], "input");
  const key = canonicalSpki(input.publicKeySpki);
  return digest({ operation: "rotate", connectorId: input.connectorId, expectedRevision: input.expectedRevision, expectedCredentialGeneration: input.expectedCredentialGeneration, keyId: input.keyId, publicKeySpki: key.publicKeySpki });
}

export function gatewayFabricRotationRequestDigest(input: Omit<GatewayFabricRotationInput, "rawToken">): string {
  const { pairingId: _pairingId, authorizationExpiresAt: _authorizationExpiresAt, ...body } = input;
  return gatewayFabricRotationBodyDigest(body);
}

function publicConnector(record: GatewayFabricConnectorRegistrationV1): ConnectorRecord {
  return {
    connectorId: record.connectorId,
    label: record.label,
    transport: record.transport,
    credentialGeneration: record.credentialGeneration,
    enabled: record.enabled,
    revision: record.revision,
  };
}

function credentialFromConnector(connector: GatewayFabricConnectorRegistrationV1): FabricConnectorCredentialV1 {
  return {
    version: FABRIC_CONNECTOR_CREDENTIAL_VERSION,
    connectorId: connector.connectorId,
    keyId: connector.keyId,
    publicKey: connector.publicKeySpki,
    audience: connector.audience,
    scopes: [...connector.scopes],
    credentialGeneration: connector.credentialGeneration,
    createdAt: connector.createdAt,
    ...(connector.expiresAt === undefined ? {} : { expiresAt: connector.expiresAt }),
    revoked: connector.revokedAt !== undefined || !connector.enabled,
    revision: connector.revision,
  };
}

function publicDevice(record: GatewayFabricDeviceRegistrationV1): DeviceRecord {
  return {
    deviceId: record.deviceId,
    connectorId: record.connectorId,
    label: record.label,
    connectionMode: record.connectionMode,
    ...(record.platform === undefined ? {} : { platform: record.platform }),
    ...(record.architecture === undefined ? {} : { architecture: record.architecture }),
    enabled: record.enabled,
    revision: record.revision,
  };
}

function parseConnector(value: unknown, subjectId: string): GatewayFabricConnectorRegistrationV1 {
  const path = `registry.${subjectId}`;
  const record = recordOf(value, path);
  exactKeys(record, ["recordType", "version", "connectorId", "label", "transport", "credentialGeneration", "enabled", "revision", "keyId", "publicKeySpki", "publicKeyFingerprint", "audience", "scopes", "createdAt", "updatedAt"], ["expiresAt", "revokedAt"], path);
  if (record.recordType !== FABRIC_CONNECTOR_RECORD_TYPE || record.version !== FABRIC_REGISTRATION_RECORD_VERSION) {
    throw new FabricContractError("protocol_violation", `Unsupported Fabric connector registration at ${subjectId}`, path);
  }
  const connectorId = requiredIdentifier(record, "connectorId", path);
  if (subjectId !== connectorSubject(connectorId)) throw new FabricContractError("protocol_violation", "Connector registry subject disagrees with connectorId", path);
  const candidate: GatewayFabricConnectorRegistrationV1 = {
    recordType: FABRIC_CONNECTOR_RECORD_TYPE,
    version: FABRIC_REGISTRATION_RECORD_VERSION,
    connectorId,
    label: requiredString(record, "label", path),
    transport: requiredOneOf(record, "transport", path, CONNECTOR_TRANSPORTS),
    credentialGeneration: requiredGeneration(record, "credentialGeneration", path),
    enabled: requiredBoolean(record, "enabled", path),
    revision: requiredRevision(record, "revision", path),
    keyId: requiredIdentifier(record, "keyId", path),
    publicKeySpki: requiredString(record, "publicKeySpki", path, ED25519_SPKI_MAX_BYTES),
    publicKeyFingerprint: requiredString(record, "publicKeyFingerprint", path, 64),
    audience: requiredString(record, "audience", path),
    scopes: stringList(record, "scopes", path),
    createdAt: requiredTimestamp(record, "createdAt", path),
    updatedAt: requiredTimestamp(record, "updatedAt", path),
    expiresAt: optionalTimestamp(record, "expiresAt", path),
    revokedAt: optionalTimestamp(record, "revokedAt", path),
  };
  try { assertValidConnectorRecord(publicConnector(candidate)); }
  catch (error) { throw storedError(error, path); }
  const canonical = canonicalSpki(candidate.publicKeySpki, `${path}.publicKeySpki`);
  if (canonical.publicKeySpki !== candidate.publicKeySpki || canonical.fingerprint !== candidate.publicKeyFingerprint) {
    throw new FabricContractError("protocol_violation", "Stored Fabric public key is not canonical or its fingerprint disagrees", `${path}.publicKeyFingerprint`);
  }
  if (candidate.audience.length === 0 || candidate.scopes.length !== 1 || candidate.scopes[0] !== FABRIC_CONNECT_SCOPE) {
    throw new FabricContractError("protocol_violation", "Stored Connector grant must be exactly fabric.connect", `${path}.scopes`);
  }
  if (candidate.enabled === (candidate.revokedAt !== undefined)) throw new FabricContractError("protocol_violation", "Stored Connector enabled/revoked state disagrees", path);
  return candidate;
}

function parseDevice(value: unknown, subjectId: string): GatewayFabricDeviceRegistrationV1 {
  const path = `registry.${subjectId}`;
  const record = recordOf(value, path);
  exactKeys(record, ["recordType", "version", "deviceId", "connectorId", "label", "connectionMode", "enabled", "createdAt", "updatedAt", "revision"], ["platform", "architecture"], path);
  if (record.recordType !== FABRIC_DEVICE_RECORD_TYPE || record.version !== FABRIC_REGISTRATION_RECORD_VERSION) {
    throw new FabricContractError("protocol_violation", `Unsupported Fabric device registration at ${subjectId}`, path);
  }
  const candidate: GatewayFabricDeviceRegistrationV1 = {
    recordType: FABRIC_DEVICE_RECORD_TYPE,
    version: FABRIC_REGISTRATION_RECORD_VERSION,
    deviceId: requiredIdentifier(record, "deviceId", path),
    connectorId: requiredIdentifier(record, "connectorId", path),
    label: requiredString(record, "label", path),
    connectionMode: requiredOneOf(record, "connectionMode", path, CONNECTION_MODES),
    ...(record.platform === undefined ? {} : { platform: requiredString(record, "platform", path) }),
    ...(record.architecture === undefined ? {} : { architecture: requiredString(record, "architecture", path) }),
    enabled: requiredBoolean(record, "enabled", path),
    createdAt: requiredTimestamp(record, "createdAt", path),
    updatedAt: requiredTimestamp(record, "updatedAt", path),
    revision: requiredRevision(record, "revision", path),
  };
  if (subjectId !== deviceSubject(candidate.deviceId)) throw new FabricContractError("protocol_violation", "Device registry subject disagrees with deviceId", path);
  try { assertValidDeviceRecord(publicDevice(candidate)); }
  catch (error) { throw storedError(error, path); }
  return candidate;
}

function parseReceipt(value: unknown, path: string): GatewayFabricRegistrationReceiptV1 {
  const record = recordOf(value, path);
  exactKeys(record, ["version", "requestId", "operation", "connectorId", "requestDigest", "connectorRevision", "credentialGeneration", "status", "committedAt"], [], path);
  if (record.version !== FABRIC_REGISTRATION_RECEIPT_VERSION) throw new FabricContractError("protocol_violation", "Unsupported Fabric registration receipt", `${path}.version`);
  const operation = requiredOneOf(record, "operation", path, REGISTRATION_OPERATIONS);
  const status = requiredOneOf(record, "status", path, RECEIPT_STATUSES);
  const receipt: GatewayFabricRegistrationReceiptV1 = {
    version: FABRIC_REGISTRATION_RECEIPT_VERSION,
    requestId: requiredIdentifier(record, "requestId", path),
    operation,
    connectorId: requiredIdentifier(record, "connectorId", path),
    requestDigest: requiredString(record, "requestDigest", path, 64),
    connectorRevision: requiredRevision(record, "connectorRevision", path),
    credentialGeneration: requiredGeneration(record, "credentialGeneration", path),
    status,
    committedAt: requiredTimestamp(record, "committedAt", path),
  };
  if (!/^[a-f0-9]{64}$/u.test(receipt.requestDigest)) throw new FabricContractError("protocol_violation", "Stored registration receipt digest is invalid", `${path}.requestDigest`);
  return receipt;
}

function parsePairing(value: unknown, subjectId: string): GatewayFabricPairingConsumptionV1 {
  const path = `registry.${subjectId}`;
  const record = recordOf(value, path);
  exactKeys(record, ["recordType", "version", "pairingId", "connectorId", "operation", "requestId", "requestDigest", "receiptVerifier", "receiptAvailableUntil", "consumedAt", "state", "revision"], ["revokedAt"], path);
  if (record.recordType !== FABRIC_PAIRING_CONSUMPTION_RECORD_TYPE || record.version !== FABRIC_REGISTRATION_RECORD_VERSION) throw new FabricContractError("protocol_violation", `Unsupported Fabric pairing consumption at ${subjectId}`, path);
  const operation = requiredOneOf(record, "operation", path, PAIRING_OPERATIONS);
  const state = requiredOneOf(record, "state", path, PAIRING_STATES);
  const pairing: GatewayFabricPairingConsumptionV1 = {
    recordType: FABRIC_PAIRING_CONSUMPTION_RECORD_TYPE,
    version: FABRIC_REGISTRATION_RECORD_VERSION,
    pairingId: requiredIdentifier(record, "pairingId", path),
    connectorId: requiredIdentifier(record, "connectorId", path),
    operation,
    requestId: requiredIdentifier(record, "requestId", path),
    requestDigest: requiredString(record, "requestDigest", path, 64),
    receiptVerifier: requiredString(record, "receiptVerifier", path, 64),
    receiptAvailableUntil: requiredTimestamp(record, "receiptAvailableUntil", path),
    consumedAt: requiredTimestamp(record, "consumedAt", path),
    state,
    ...(record.revokedAt === undefined ? {} : { revokedAt: requiredTimestamp(record, "revokedAt", path) }),
    revision: requiredRevision(record, "revision", path),
  };
  if (subjectId !== pairingSubject(pairing.pairingId) || !/^[a-f0-9]{64}$/u.test(pairing.requestDigest) || !/^[a-f0-9]{64}$/u.test(pairing.receiptVerifier)) throw new FabricContractError("protocol_violation", "Stored pairing consumption identity or digest is invalid", path);
  if (pairing.state === "revoked" && pairing.revokedAt === undefined) throw new FabricContractError("protocol_violation", "Revoked pairing consumption is missing revokedAt", path);
  return pairing;
}

function parseOperation(value: unknown, subjectId: string): GatewayFabricRegistrationOperationV1 {
  const path = `registry.${subjectId}`;
  const record = recordOf(value, path);
  exactKeys(record, ["recordType", "version", "requestId", "operation", "connectorId", "requestDigest", "receipt", "createdAt", "revision"], ["pairingId"], path);
  if (record.recordType !== FABRIC_REGISTRATION_OPERATION_RECORD_TYPE || record.version !== FABRIC_REGISTRATION_RECORD_VERSION) throw new FabricContractError("protocol_violation", `Unsupported Fabric registration operation at ${subjectId}`, path);
  const receipt = parseReceipt(record.receipt, `${path}.receipt`);
  const operation: GatewayFabricRegistrationOperationV1 = {
    recordType: FABRIC_REGISTRATION_OPERATION_RECORD_TYPE,
    version: FABRIC_REGISTRATION_RECORD_VERSION,
    requestId: requiredIdentifier(record, "requestId", path),
    operation: receipt.operation,
    connectorId: requiredIdentifier(record, "connectorId", path),
    requestDigest: requiredString(record, "requestDigest", path, 64),
    ...(record.pairingId === undefined ? {} : { pairingId: requiredIdentifier(record, "pairingId", path) }),
    receipt,
    createdAt: requiredTimestamp(record, "createdAt", path),
    revision: requiredRevision(record, "revision", path),
  };
  if (subjectId !== operationSubject(operation.requestId) || record.operation !== receipt.operation || operation.requestId !== receipt.requestId || operation.connectorId !== receipt.connectorId || operation.requestDigest !== receipt.requestDigest || !/^[a-f0-9]{64}$/u.test(operation.requestDigest)) throw new FabricContractError("protocol_violation", "Stored registration operation identity is inconsistent", path);
  if ((operation.operation === "enroll" || operation.operation === "rotate") && operation.pairingId === undefined) {
    throw new FabricContractError("protocol_violation", "Stored enroll/rotate operation must reference its pairing consumption", `${path}.pairingId`);
  }
  return operation;
}

interface ParsedRegistry {
  connectors: Map<string, GatewayFabricConnectorRegistrationV1>;
  devices: Map<string, GatewayFabricDeviceRegistrationV1>;
  pairings: Map<string, GatewayFabricPairingConsumptionV1>;
  operations: Map<string, GatewayFabricRegistrationOperationV1>;
}

function parseRegistry(snapshot: FabricLogicalStoreSnapshot, audience: string): ParsedRegistry {
  const parsed: ParsedRegistry = { connectors: new Map(), devices: new Map(), pairings: new Map(), operations: new Map() };
  for (const [subjectId, record] of Object.entries(snapshot.records)) {
    if (subjectId.startsWith(CONNECTOR_PREFIX)) {
      const connector = parseConnector(record, subjectId);
      if (connector.audience !== audience) throw new FabricContractError("protocol_violation", "Stored Connector audience disagrees with this authority", `registry.${subjectId}.audience`);
      parsed.connectors.set(connector.connectorId, connector);
    } else if (subjectId.startsWith(DEVICE_PREFIX)) {
      const device = parseDevice(record, subjectId);
      parsed.devices.set(device.deviceId, device);
    } else if (subjectId.startsWith(PAIRING_PREFIX)) {
      const pairing = parsePairing(record, subjectId);
      parsed.pairings.set(pairing.pairingId, pairing);
    } else if (subjectId.startsWith(OPERATION_PREFIX)) {
      const operation = parseOperation(record, subjectId);
      parsed.operations.set(operation.requestId, operation);
    }
  }
  for (const device of parsed.devices.values()) if (!parsed.connectors.has(device.connectorId)) throw new FabricContractError("protocol_violation", `Device ${device.deviceId} has no registered Connector`, `registry.${deviceSubject(device.deviceId)}.connectorId`);
  for (const pairing of parsed.pairings.values()) {
    if (!parsed.connectors.has(pairing.connectorId)) throw new FabricContractError("protocol_violation", `Pairing ${pairing.pairingId} has no registered Connector`, `registry.${pairingSubject(pairing.pairingId)}.connectorId`);
    const operation = parsed.operations.get(pairing.requestId);
    if (operation === undefined || operation.pairingId !== pairing.pairingId || operation.operation !== pairing.operation || operation.connectorId !== pairing.connectorId || operation.requestDigest !== pairing.requestDigest) {
      throw new FabricContractError("protocol_violation", `Pairing ${pairing.pairingId} disagrees with its registration operation`, `registry.${pairingSubject(pairing.pairingId)}`);
    }
  }
  for (const operation of parsed.operations.values()) {
    const path = `registry.${operationSubject(operation.requestId)}`;
    const connector = parsed.connectors.get(operation.connectorId);
    if (connector === undefined) throw new FabricContractError("protocol_violation", `Operation ${operation.requestId} has no registered Connector`, `${path}.connectorId`);
    const pairing = operation.pairingId === undefined ? undefined : parsed.pairings.get(operation.pairingId);
    if (operation.pairingId !== undefined && pairing === undefined) throw new FabricContractError("protocol_violation", `Operation ${operation.requestId} has no pairing consumption tombstone`, `${path}.pairingId`);
    if (pairing !== undefined && pairing.connectorId !== operation.connectorId) {
      throw new FabricContractError("protocol_violation", `Operation ${operation.requestId} references another Connector's pairing`, `${path}.pairingId`);
    }
    if (operation.operation === "enroll" || operation.operation === "rotate") {
      if (pairing === undefined || pairing.operation !== operation.operation || pairing.requestId !== operation.requestId || pairing.requestDigest !== operation.requestDigest) {
        throw new FabricContractError("protocol_violation", `Operation ${operation.requestId} disagrees with its pairing provenance`, `${path}.pairingId`);
      }
      if (operation.receipt.status !== "active") throw new FabricContractError("protocol_violation", `Stored ${operation.operation} receipt must be active`, `${path}.receipt.status`);
    } else {
      if (operation.receipt.status !== "revoked") throw new FabricContractError("protocol_violation", "Stored revoke receipt must be revoked", `${path}.receipt.status`);
      if (pairing !== undefined && pairing.state !== "revoked") throw new FabricContractError("protocol_violation", "A revoke operation pairing reference must be revoked", `${path}.pairingId`);
      if (connector.enabled || connector.revokedAt === undefined) throw new FabricContractError("protocol_violation", "A revoke operation cannot reference an active Connector", path);
    }
    if (operation.createdAt !== operation.receipt.committedAt) throw new FabricContractError("protocol_violation", "Stored operation and receipt timestamps disagree", path);
  }
  for (const connector of parsed.connectors.values()) {
    const enrollments = [...parsed.operations.values()].filter((operation) => operation.connectorId === connector.connectorId && operation.operation === "enroll");
    const enrollment = enrollments[0];
    const enrollmentPairing = enrollment?.pairingId === undefined ? undefined : parsed.pairings.get(enrollment.pairingId);
    if (enrollments.length !== 1 || enrollment === undefined || enrollmentPairing === undefined ||
      enrollmentPairing.operation !== "enroll" || enrollment.receipt.connectorRevision !== 1 ||
      enrollment.receipt.credentialGeneration !== 1 || enrollment.receipt.status !== "active") {
      throw new FabricContractError("protocol_violation", `Connector ${connector.connectorId} must have exactly one valid enrollment operation and consumption tombstone`, `registry.${connectorSubject(connector.connectorId)}`);
    }
  }
  return parsed;
}

function currentReceipt(operation: GatewayFabricRegistrationOperationV1, connector: GatewayFabricConnectorRegistrationV1): GatewayFabricRegistrationReceiptV1 {
  const status: ReceiptStatus = connector.revokedAt !== undefined ? "revoked" : connector.credentialGeneration === operation.receipt.credentialGeneration ? "active" : "superseded";
  return { ...operation.receipt, status };
}

/** One durable authority for registration records, token consumption, and safe receipts. */
export class GatewayFabricRegistrationAuthority implements FabricConnectorCredentialAuthority {
  readonly coordinator: FabricStoreCoordinator;
  readonly #audience: string;
  readonly #now: () => number;
  readonly #receiptRecoveryMs: number;
  #credentials = new Map<string, FabricConnectorCredentialV1>();
  #publicationEpoch = 0;

  constructor(coordinator: FabricStoreCoordinator, options: GatewayFabricRegistrationAuthorityOptions) {
    assertBoundedString(options.audience, "audience", 256);
    this.coordinator = coordinator;
    this.#audience = options.audience;
    this.#now = options.now ?? Date.now;
    this.#receiptRecoveryMs = options.receiptRecoveryMs ?? RECEIPT_RECOVERY_MS;
    if (!Number.isSafeInteger(this.#receiptRecoveryMs) || this.#receiptRecoveryMs < 1) throw new FabricContractError("invalid_argument", "receiptRecoveryMs must be a positive safe integer", "receiptRecoveryMs");
  }

  get audience(): string { return this.#audience; }

  credentialOf(connectorId: string): FabricConnectorCredentialV1 | undefined {
    const credential = this.#credentials.get(connectorId);
    return credential === undefined ? undefined : structuredClone(credential);
  }

  async enroll(input: GatewayFabricEnrollmentInput): Promise<GatewayFabricRegistrationReceiptV1> {
    assertExactRuntimeKeys(input, ["requestId", "pairingId", "rawToken", "authorizationExpiresAt", "connector", "devices", "keyId", "publicKeySpki", "expiresAt"], "input");
    assertExactRuntimeKeys(input.connector, ["connectorId", "label", "transport"], "connector");
    this.#validateOperationIds(input.requestId, input.pairingId, input.connector.connectorId);
    assertFabricIdentifier(input.keyId, "keyId");
    const key = canonicalSpki(input.publicKeySpki);
    const connectorCandidate: ConnectorRecord = {
      connectorId: input.connector.connectorId,
      label: input.connector.label,
      transport: input.connector.transport,
      credentialGeneration: 1,
      enabled: true,
      revision: 1,
    };
    assertValidConnectorRecord(connectorCandidate);
    if (input.devices.length > 256) throw new FabricContractError("resource_exhausted", "Connector registration has too many Devices", "devices");
    const devices = input.devices.map((device, index): GatewayFabricDeviceRegistrationV1 => {
      assertExactRuntimeKeys(device, ["deviceId", "label", "connectionMode", "platform", "architecture", "enabled"], `devices[${index}]`);
      assertInputIdentifier(device.deviceId, "deviceId");
      const candidate: DeviceRecord = {
        deviceId: device.deviceId,
        connectorId: input.connector.connectorId,
        label: device.label,
        connectionMode: device.connectionMode,
        ...(device.platform === undefined ? {} : { platform: device.platform }),
        ...(device.architecture === undefined ? {} : { architecture: device.architecture }),
        enabled: device.enabled,
        revision: 1,
      };
      assertValidDeviceRecord(candidate);
      return { recordType: FABRIC_DEVICE_RECORD_TYPE, version: FABRIC_REGISTRATION_RECORD_VERSION, ...candidate, createdAt: 0, updatedAt: 0 };
    });
    if (new Set(devices.map((device) => device.deviceId)).size !== devices.length) throw new FabricContractError("conflict", "Connector registration contains duplicate Device IDs", "devices");
    if (input.expiresAt !== undefined) assertEpochMilliseconds(input.expiresAt, "expiresAt");
    if (input.authorizationExpiresAt !== undefined) assertEpochMilliseconds(input.authorizationExpiresAt, "authorizationExpiresAt");
    const { rawToken: _rawToken, authorizationExpiresAt: _authorizationExpiresAt, ...digestInput } = input;
    const requestDigest = gatewayFabricEnrollmentRequestDigest(digestInput);
    const now = this.#timestamp();
    let credentialAfterCommit: FabricConnectorCredentialV1 | undefined;
    const receipt = await this.coordinator.commit("registry", now, (store) => {
      const transactionNow = this.#timestamp();
      if (input.authorizationExpiresAt !== undefined && input.authorizationExpiresAt <= transactionNow) {
        throw new FabricContractError("unauthenticated", "Fabric purpose token expired before registration commit", "authorization");
      }
      const parsed = parseRegistry(store, this.#audience);
      const replay = this.#operationReplay(parsed, input.requestId, requestDigest);
      if (replay !== undefined) {
        const replayConnector = parsed.connectors.get(replay.connectorId);
        if (replayConnector === undefined) throw new FabricContractError("protocol_violation", "Registration replay references a missing Connector", "connectorId");
        credentialAfterCommit = credentialFromConnector(replayConnector);
        return { mutations: [], value: replay };
      }
      if (parsed.connectors.has(input.connector.connectorId)) throw new FabricContractError("conflict", "Connector is already enrolled; rotate it instead", "connectorId");
      if (parsed.pairings.has(input.pairingId)) throw new FabricContractError("permission_denied", "Fabric registration token was already consumed", "authorization");
      for (const device of devices) if (parsed.devices.has(device.deviceId)) throw new FabricContractError("conflict", "Device identity is already registered", "devices.deviceId");
      const connector: GatewayFabricConnectorRegistrationV1 = {
        recordType: FABRIC_CONNECTOR_RECORD_TYPE, version: FABRIC_REGISTRATION_RECORD_VERSION,
        ...connectorCandidate, keyId: input.keyId, publicKeySpki: key.publicKeySpki,
        publicKeyFingerprint: key.fingerprint, audience: this.#audience, scopes: [FABRIC_CONNECT_SCOPE],
        createdAt: now, updatedAt: now, ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      };
      credentialAfterCommit = credentialFromConnector(connector);
      const durableDevices = devices.map((device) => ({ ...device, createdAt: now, updatedAt: now }));
      const value: GatewayFabricRegistrationReceiptV1 = { version: FABRIC_REGISTRATION_RECEIPT_VERSION, requestId: input.requestId, operation: "enroll", connectorId: connector.connectorId, requestDigest, connectorRevision: 1, credentialGeneration: 1, status: "active", committedAt: now };
      const pairing: GatewayFabricPairingConsumptionV1 = { recordType: FABRIC_PAIRING_CONSUMPTION_RECORD_TYPE, version: FABRIC_REGISTRATION_RECORD_VERSION, pairingId: input.pairingId, connectorId: connector.connectorId, operation: "enroll", requestId: input.requestId, requestDigest, receiptVerifier: tokenVerifier(input.rawToken), receiptAvailableUntil: now + this.#receiptRecoveryMs, consumedAt: now, state: "consumed", revision: 1 };
      const operation: GatewayFabricRegistrationOperationV1 = { recordType: FABRIC_REGISTRATION_OPERATION_RECORD_TYPE, version: FABRIC_REGISTRATION_RECORD_VERSION, requestId: input.requestId, operation: "enroll", connectorId: connector.connectorId, requestDigest, pairingId: input.pairingId, receipt: value, createdAt: now, revision: 1 };
      return {
        mutations: [
          { kind: "upsert", subjectId: connectorSubject(connector.connectorId), value: asStored(connector), eventKind: "connector.enrolled", payload: asStored({ connectorId: connector.connectorId, credentialGeneration: 1, state: "active", audience: connector.audience, keyId: connector.keyId, createdAt: now }) },
          ...durableDevices.map((device) => ({ kind: "upsert" as const, subjectId: deviceSubject(device.deviceId), value: asStored(device), eventKind: "device.registered", payload: asStored({ connectorId: device.connectorId, deviceId: device.deviceId, enabled: device.enabled, createdAt: now }) })),
          { kind: "upsert", subjectId: pairingSubject(pairing.pairingId), value: asStored(pairing), eventKind: "pairing.consumed", payload: asStored({ connectorId: pairing.connectorId, state: pairing.state, createdAt: now }) },
          { kind: "upsert", subjectId: operationSubject(operation.requestId), value: asStored(operation), eventKind: "registration.completed", payload: asStored({ connectorId: operation.connectorId, credentialGeneration: 1, state: "active", createdAt: now }) },
        ],
        value,
      };
    });
    if (credentialAfterCommit === undefined) throw new FabricContractError("protocol_violation", "Committed enrollment did not return credential authority", "connectorId");
    this.#publicationEpoch += 1;
    this.#credentials.set(input.connector.connectorId, credentialAfterCommit);
    return receipt;
  }

  async rotate(input: GatewayFabricRotationInput): Promise<GatewayFabricRegistrationReceiptV1> {
    assertExactRuntimeKeys(input, ["requestId", "pairingId", "rawToken", "authorizationExpiresAt", "connectorId", "expectedRevision", "expectedCredentialGeneration", "keyId", "publicKeySpki"], "input");
    this.#validateOperationIds(input.requestId, input.pairingId, input.connectorId);
    assertRevision(input.expectedRevision, "expectedRevision");
    assertGeneration(input.expectedCredentialGeneration, "expectedCredentialGeneration");
    assertFabricIdentifier(input.keyId, "keyId");
    const key = canonicalSpki(input.publicKeySpki);
    if (input.authorizationExpiresAt !== undefined) assertEpochMilliseconds(input.authorizationExpiresAt, "authorizationExpiresAt");
    const { rawToken: _rawToken, authorizationExpiresAt: _authorizationExpiresAt, ...digestInput } = input;
    const requestDigest = gatewayFabricRotationRequestDigest(digestInput);
    const now = this.#timestamp();
    let credentialAfterCommit: FabricConnectorCredentialV1 | undefined;
    const receipt = await this.coordinator.commit("registry", now, (store) => {
      const transactionNow = this.#timestamp();
      if (input.authorizationExpiresAt !== undefined && input.authorizationExpiresAt <= transactionNow) {
        throw new FabricContractError("unauthenticated", "Fabric purpose token expired before registration commit", "authorization");
      }
      const parsed = parseRegistry(store, this.#audience);
      const replay = this.#operationReplay(parsed, input.requestId, requestDigest);
      if (replay !== undefined) {
        const replayConnector = parsed.connectors.get(replay.connectorId);
        if (replayConnector === undefined) throw new FabricContractError("protocol_violation", "Registration replay references a missing Connector", "connectorId");
        credentialAfterCommit = credentialFromConnector(replayConnector);
        return { mutations: [], value: replay };
      }
      if (parsed.pairings.has(input.pairingId)) throw new FabricContractError("permission_denied", "Fabric registration token was already consumed", "authorization");
      const current = parsed.connectors.get(input.connectorId);
      if (current === undefined) throw new FabricContractError("not_found", "Connector is not registered", "connectorId");
      if (!current.enabled || current.revokedAt !== undefined) throw new FabricContractError("invalid_state", "Revoked Connector cannot be rotated", "connectorId");
      if (current.revision !== input.expectedRevision) throw new FabricContractError("conflict", "Connector revision is stale", "expectedRevision");
      if (current.credentialGeneration !== input.expectedCredentialGeneration) throw new FabricContractError("stale_generation", "Connector credential generation is stale", "expectedCredentialGeneration");
      const next: GatewayFabricConnectorRegistrationV1 = { ...current, keyId: input.keyId, publicKeySpki: key.publicKeySpki, publicKeyFingerprint: key.fingerprint, credentialGeneration: current.credentialGeneration + 1, revision: current.revision + 1, updatedAt: now };
      credentialAfterCommit = credentialFromConnector(next);
      const value: GatewayFabricRegistrationReceiptV1 = { version: FABRIC_REGISTRATION_RECEIPT_VERSION, requestId: input.requestId, operation: "rotate", connectorId: next.connectorId, requestDigest, connectorRevision: next.revision, credentialGeneration: next.credentialGeneration, status: "active", committedAt: now };
      const pairing: GatewayFabricPairingConsumptionV1 = { recordType: FABRIC_PAIRING_CONSUMPTION_RECORD_TYPE, version: FABRIC_REGISTRATION_RECORD_VERSION, pairingId: input.pairingId, connectorId: next.connectorId, operation: "rotate", requestId: input.requestId, requestDigest, receiptVerifier: tokenVerifier(input.rawToken), receiptAvailableUntil: now + this.#receiptRecoveryMs, consumedAt: now, state: "consumed", revision: 1 };
      const operation: GatewayFabricRegistrationOperationV1 = { recordType: FABRIC_REGISTRATION_OPERATION_RECORD_TYPE, version: FABRIC_REGISTRATION_RECORD_VERSION, requestId: input.requestId, operation: "rotate", connectorId: next.connectorId, requestDigest, pairingId: input.pairingId, receipt: value, createdAt: now, revision: 1 };
      return { mutations: [
        { kind: "upsert", subjectId: connectorSubject(next.connectorId), expectedRevision: current.revision, value: asStored(next), eventKind: "connector.rotated", payload: asStored({ connectorId: next.connectorId, credentialGeneration: next.credentialGeneration, state: "active", keyId: next.keyId, updatedAt: now }) },
        { kind: "upsert", subjectId: pairingSubject(pairing.pairingId), value: asStored(pairing), eventKind: "pairing.consumed", payload: asStored({ connectorId: pairing.connectorId, state: pairing.state, updatedAt: now }) },
        { kind: "upsert", subjectId: operationSubject(operation.requestId), value: asStored(operation), eventKind: "registration.completed", payload: asStored({ connectorId: operation.connectorId, credentialGeneration: next.credentialGeneration, state: "active", updatedAt: now }) },
      ], value };
    });
    if (credentialAfterCommit === undefined) throw new FabricContractError("protocol_violation", "Committed rotation did not return credential authority", "connectorId");
    this.#publicationEpoch += 1;
    this.#credentials.set(input.connectorId, credentialAfterCommit);
    return receipt;
  }

  async revoke(input: GatewayFabricRevocationInput): Promise<GatewayFabricRegistrationReceiptV1> {
    assertExactRuntimeKeys(input, ["requestId", "connectorId", "expectedRevision", "pairingId"], "input");
    assertInputIdentifier(input.requestId, "requestId");
    assertInputIdentifier(input.connectorId, "connectorId");
    if (input.pairingId !== undefined) assertInputIdentifier(input.pairingId, "pairingId");
    assertRevision(input.expectedRevision, "expectedRevision");
    const requestDigest = digest({ operation: "revoke", connectorId: input.connectorId, expectedRevision: input.expectedRevision, pairingId: input.pairingId });
    const now = this.#timestamp();
    let credentialAfterCommit: FabricConnectorCredentialV1 | undefined;
    const receipt = await this.coordinator.commit("registry", now, (store) => {
      const parsed = parseRegistry(store, this.#audience);
      const replay = this.#operationReplay(parsed, input.requestId, requestDigest);
      if (replay !== undefined) {
        const replayConnector = parsed.connectors.get(replay.connectorId);
        if (replayConnector === undefined) throw new FabricContractError("protocol_violation", "Registration replay references a missing Connector", "connectorId");
        credentialAfterCommit = credentialFromConnector(replayConnector);
        return { mutations: [], value: replay };
      }
      const current = parsed.connectors.get(input.connectorId);
      if (current === undefined) throw new FabricContractError("not_found", "Connector is not registered", "connectorId");
      const boundPairing = input.pairingId === undefined ? undefined : parsed.pairings.get(input.pairingId);
      if (input.pairingId !== undefined && boundPairing === undefined) {
        throw new FabricContractError("not_found", "Fabric pairing consumption binding was not found", "pairingId");
      }
      if (boundPairing !== undefined && boundPairing.connectorId !== input.connectorId) {
        throw new FabricContractError("conflict", "Fabric pairing consumption belongs to another Connector", "pairingId");
      }
      if (!current.enabled || current.revokedAt !== undefined) {
        credentialAfterCommit = credentialFromConnector(current);
        return { mutations: [], value: { version: FABRIC_REGISTRATION_RECEIPT_VERSION, requestId: input.requestId, operation: "revoke", connectorId: current.connectorId, requestDigest, connectorRevision: current.revision, credentialGeneration: current.credentialGeneration, status: "revoked", committedAt: current.revokedAt ?? current.updatedAt } satisfies GatewayFabricRegistrationReceiptV1 };
      }
      if (current.revision !== input.expectedRevision) throw new FabricContractError("conflict", "Connector revision is stale", "expectedRevision");
      const next: GatewayFabricConnectorRegistrationV1 = { ...current, enabled: false, revokedAt: now, updatedAt: now, revision: current.revision + 1 };
      credentialAfterCommit = credentialFromConnector(next);
      const value: GatewayFabricRegistrationReceiptV1 = { version: FABRIC_REGISTRATION_RECEIPT_VERSION, requestId: input.requestId, operation: "revoke", connectorId: next.connectorId, requestDigest, connectorRevision: next.revision, credentialGeneration: next.credentialGeneration, status: "revoked", committedAt: now };
      const operation: GatewayFabricRegistrationOperationV1 = { recordType: FABRIC_REGISTRATION_OPERATION_RECORD_TYPE, version: FABRIC_REGISTRATION_RECORD_VERSION, requestId: input.requestId, operation: "revoke", connectorId: next.connectorId, requestDigest, ...(input.pairingId === undefined ? {} : { pairingId: input.pairingId }), receipt: value, createdAt: now, revision: 1 };
      const revokedPairings = [...parsed.pairings.values()]
        .filter((pairing) => pairing.connectorId === next.connectorId && pairing.state !== "revoked")
        .map((pairing) => ({ ...pairing, state: "revoked" as const, revokedAt: now, revision: pairing.revision + 1 }));
      return { mutations: [
        { kind: "upsert", subjectId: connectorSubject(next.connectorId), expectedRevision: current.revision, value: asStored(next), eventKind: "connector.revoked", payload: asStored({ connectorId: next.connectorId, credentialGeneration: next.credentialGeneration, state: "revoked", revokedAt: now }) },
        ...revokedPairings.map((pairing) => ({ kind: "upsert" as const, subjectId: pairingSubject(pairing.pairingId), expectedRevision: pairing.revision - 1, value: asStored(pairing), eventKind: "pairing.revoked", payload: asStored({ connectorId: next.connectorId, state: "revoked", revokedAt: now }) })),
        { kind: "upsert", subjectId: operationSubject(operation.requestId), value: asStored(operation), eventKind: "registration.completed", payload: asStored({ connectorId: operation.connectorId, credentialGeneration: next.credentialGeneration, state: "revoked", updatedAt: now }) },
      ], value };
    });
    if (credentialAfterCommit === undefined) throw new FabricContractError("protocol_violation", "Committed revocation did not return credential authority", "connectorId");
    this.#publicationEpoch += 1;
    this.#credentials.set(input.connectorId, credentialAfterCommit);
    return receipt;
  }

  async receipt(input: GatewayFabricReceiptRequest): Promise<GatewayFabricRegistrationReceiptV1 | undefined> {
    assertExactRuntimeKeys(input, ["requestId", "rawToken", "requestDigest"], "input");
    assertInputIdentifier(input.requestId, "requestId");
    const parsed = parseRegistry(await this.coordinator.readStore("registry"), this.#audience);
    const operation = parsed.operations.get(input.requestId);
    if (operation === undefined || operation.pairingId === undefined) return undefined;
    const pairing = parsed.pairings.get(operation.pairingId);
    if (pairing === undefined || pairing.requestId !== operation.requestId || pairing.requestDigest !== operation.requestDigest || pairing.receiptAvailableUntil <= this.#timestamp()) return undefined;
    if (input.requestDigest !== operation.requestDigest) return undefined;
    let presentedVerifier: string;
    try { presentedVerifier = tokenVerifier(input.rawToken); }
    catch { return undefined; }
    if (!equalVerifier(pairing.receiptVerifier, presentedVerifier)) return undefined;
    const connector = parsed.connectors.get(operation.connectorId);
    return connector === undefined ? undefined : currentReceipt(operation, connector);
  }

  async read(connectorId: string): Promise<FabricAuthoritySeed | undefined> {
    assertInputIdentifier(connectorId, "connectorId");
    const parsed = parseRegistry(await this.coordinator.readStore("registry"), this.#audience);
    const connector = parsed.connectors.get(connectorId);
    if (connector === undefined) return undefined;
    return { connector: publicConnector(connector), devices: [...parsed.devices.values()].filter((device) => device.connectorId === connectorId).map(publicDevice).sort((a, b) => a.deviceId.localeCompare(b.deviceId)) };
  }

  async list(): Promise<readonly FabricAuthoritySeed[]> {
    const parsed = parseRegistry(await this.coordinator.readStore("registry"), this.#audience);
    return [...parsed.connectors.values()].sort((a, b) => a.connectorId.localeCompare(b.connectorId)).map((connector) => ({ connector: publicConnector(connector), devices: [...parsed.devices.values()].filter((device) => device.connectorId === connector.connectorId).map(publicDevice).sort((a, b) => a.deviceId.localeCompare(b.deviceId)) }));
  }

  async connectorOfPairing(pairingId: string): Promise<string | undefined> {
    assertInputIdentifier(pairingId, "pairingId");
    const parsed = parseRegistry(await this.coordinator.readStore("registry"), this.#audience);
    return parsed.pairings.get(pairingId)?.connectorId;
  }

  async pairingIdsOfConnector(connectorId: string): Promise<readonly string[]> {
    assertInputIdentifier(connectorId, "connectorId");
    const parsed = parseRegistry(await this.coordinator.readStore("registry"), this.#audience);
    return [...parsed.pairings.values()]
      .filter((pairing) => pairing.connectorId === connectorId)
      .map((pairing) => pairing.pairingId)
      .sort((left, right) => left.localeCompare(right));
  }

  /** Strict startup preflight. It validates without publishing cached authority. */
  async validate(): Promise<void> {
    parseRegistry(await this.coordinator.readStore("registry"), this.#audience);
  }

  async hydrate(directory?: FabricDirectory): Promise<readonly FabricAuthoritySeed[]> {
    for (;;) {
      // Clear first: a malformed restart/reload must never leave predecessor keys usable.
      const publicationEpoch = ++this.#publicationEpoch;
      this.#credentials = new Map();
      const parsed = parseRegistry(await this.coordinator.readStore("registry"), this.#audience);
      if (publicationEpoch !== this.#publicationEpoch) continue;
      const seeds = [...parsed.connectors.values()].sort((a, b) => a.connectorId.localeCompare(b.connectorId)).map((connector): FabricAuthoritySeed => ({ connector: publicConnector(connector), devices: [...parsed.devices.values()].filter((device) => device.connectorId === connector.connectorId).map(publicDevice).sort((a, b) => a.deviceId.localeCompare(b.deviceId)) }));
      const credentials = new Map<string, FabricConnectorCredentialV1>();
      for (const connector of parsed.connectors.values()) credentials.set(connector.connectorId, credentialFromConnector(connector));
      if (publicationEpoch !== this.#publicationEpoch) continue;
      if (directory !== undefined) for (const seed of seeds) directory.seedAuthority(seed);
      if (publicationEpoch !== this.#publicationEpoch) continue;
      this.#credentials = credentials;
      return structuredClone(seeds);
    }
  }

  #operationReplay(parsed: ParsedRegistry, requestId: string, requestDigest: string): GatewayFabricRegistrationReceiptV1 | undefined {
    const operation = parsed.operations.get(requestId);
    if (operation === undefined) return undefined;
    if (operation.requestDigest !== requestDigest) throw new FabricContractError("conflict", "Registration requestId is already bound to different content", "requestId");
    const connector = parsed.connectors.get(operation.connectorId);
    if (connector === undefined) throw new FabricContractError("protocol_violation", "Registration operation references a missing Connector", "connectorId");
    return currentReceipt(operation, connector);
  }

  #validateOperationIds(requestId: string, pairingId: string, connectorId: string): void {
    assertInputIdentifier(requestId, "requestId");
    assertInputIdentifier(pairingId, "pairingId");
    assertInputIdentifier(connectorId, "connectorId");
  }

  #timestamp(): number {
    const now = this.#now();
    assertEpochMilliseconds(now, "now");
    return now;
  }
}
