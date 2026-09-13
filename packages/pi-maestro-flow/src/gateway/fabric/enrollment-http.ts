/** Native-HTTPS-only Fabric registration endpoints. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { FabricContractError, type DeviceRecord } from "pi-maestro-fabric-core/v1";
import { FabricPairingAdapter } from "./pairing-adapter.ts";
import { GatewayFabricRegistrationAuthority } from "./registration.ts";

export const FABRIC_ENROLLMENT_PATH = "/fabric/v1/enroll" as const;
export const FABRIC_ROTATION_PATH = "/fabric/v1/rotate" as const;
export const FABRIC_REGISTRATION_RECEIPT_PATH = "/fabric/v1/registration-receipt" as const;
const REGISTRATION_PATHS = new Set<string>([
  FABRIC_ENROLLMENT_PATH,
  FABRIC_ROTATION_PATH,
  FABRIC_REGISTRATION_RECEIPT_PATH,
]);
const DEFAULT_MAXIMUM_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface FabricEnrollmentHttpOptions {
  readonly adapter: FabricPairingAdapter;
  readonly authority: GatewayFabricRegistrationAuthority;
  readonly maximumBytes?: number;
  readonly timeoutMs?: number;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) throw new Error(`${name} must be a positive safe integer`);
  return selected;
}

function recordOf(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FabricContractError("invalid_argument", `${path} must be an object`, path);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(record: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[], path: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new FabricContractError("invalid_argument", `${path}.${key} is not supported`, `${path}.${key}`);
  }
  for (const key of required) {
    if (!(key in record)) throw new FabricContractError("invalid_argument", `${path}.${key} is required`, `${path}.${key}`);
  }
}

function stringField(record: Readonly<Record<string, unknown>>, key: string, path: string, maximum = 256): string {
  const value = record[key];
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > maximum) {
    throw new FabricContractError("invalid_argument", `${path}.${key} must be a non-empty bounded string`, `${path}.${key}`);
  }
  return value;
}

function integerField(record: Readonly<Record<string, unknown>>, key: string, path: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new FabricContractError("invalid_argument", `${path}.${key} must be a positive safe integer`, `${path}.${key}`);
  }
  return value as number;
}

function bearerToken(request: IncomingMessage): string {
  const value = request.headers.authorization;
  if (typeof value !== "string" || value.includes(",")) {
    throw new FabricContractError("unauthenticated", "Fabric registration requires one bearer token", "authorization");
  }
  const match = /^Bearer ([A-Za-z0-9_-]{1,1024})$/iu.exec(value);
  if (match === null) throw new FabricContractError("unauthenticated", "Fabric registration bearer token is invalid", "authorization");
  return match[1]!;
}

function enrollmentBody(value: unknown): {
  requestId: string;
  connectorId: string;
  keyId: string;
  publicKey: string;
  label?: string;
  transport?: "outbound-wss" | "ssh" | "direct-https" | "edge-relay";
  devices: readonly Omit<DeviceRecord, "connectorId" | "revision">[];
} {
  const body = recordOf(value, "body");
  exactKeys(body, ["version", "requestId", "connector", "devices", "keyId", "publicKeySpki"], [], "body");
  if (body.version !== 1) throw new FabricContractError("unsupported_version", "body.version must be 1", "body.version");
  const connector = recordOf(body.connector, "body.connector");
  exactKeys(connector, ["connectorId"], ["label", "transport"], "body.connector");
  const transportValue = connector.transport;
  if (transportValue !== undefined && transportValue !== "outbound-wss" && transportValue !== "ssh" && transportValue !== "direct-https" && transportValue !== "edge-relay") {
    throw new FabricContractError("invalid_argument", "body.connector.transport is not supported", "body.connector.transport");
  }
  if (!Array.isArray(body.devices) || body.devices.length > 256) {
    throw new FabricContractError("invalid_argument", "body.devices must be a bounded array", "body.devices");
  }
  const devices = body.devices.map((value, index): Omit<DeviceRecord, "connectorId" | "revision"> => {
    const path = `body.devices[${index}]`;
    const device = recordOf(value, path);
    exactKeys(device, ["deviceId", "label", "connectionMode", "enabled"], ["platform", "architecture"], path);
    const connectionMode = device.connectionMode;
    if (connectionMode !== "direct" && connectionMode !== "edge-managed" && connectionMode !== "ssh" && connectionMode !== "https") {
      throw new FabricContractError("invalid_argument", `${path}.connectionMode is not supported`, `${path}.connectionMode`);
    }
    if (typeof device.enabled !== "boolean") throw new FabricContractError("invalid_argument", `${path}.enabled must be boolean`, `${path}.enabled`);
    return {
      deviceId: stringField(device, "deviceId", path),
      label: stringField(device, "label", path),
      connectionMode,
      ...(device.platform === undefined ? {} : { platform: stringField(device, "platform", path) }),
      ...(device.architecture === undefined ? {} : { architecture: stringField(device, "architecture", path) }),
      enabled: device.enabled,
    };
  });
  return {
    requestId: stringField(body, "requestId", "body"),
    connectorId: stringField(connector, "connectorId", "body.connector"),
    keyId: stringField(body, "keyId", "body"),
    publicKey: stringField(body, "publicKeySpki", "body", 512),
    ...(connector.label === undefined ? {} : { label: stringField(connector, "label", "body.connector") }),
    ...(transportValue === undefined ? {} : { transport: transportValue }),
    devices,
  };
}

function rotationBody(value: unknown): {
  requestId: string;
  connectorId: string;
  expectedRevision: number;
  expectedCredentialGeneration: number;
  keyId: string;
  publicKey: string;
} {
  const body = recordOf(value, "body");
  exactKeys(body, ["version", "requestId", "connectorId", "expectedRevision", "expectedCredentialGeneration", "keyId", "publicKeySpki"], [], "body");
  if (body.version !== 1) throw new FabricContractError("unsupported_version", "body.version must be 1", "body.version");
  return {
    requestId: stringField(body, "requestId", "body"),
    connectorId: stringField(body, "connectorId", "body"),
    expectedRevision: integerField(body, "expectedRevision", "body"),
    expectedCredentialGeneration: integerField(body, "expectedCredentialGeneration", "body"),
    keyId: stringField(body, "keyId", "body"),
    publicKey: stringField(body, "publicKeySpki", "body", 512),
  };
}

function receiptBody(value: unknown): { requestId: string; requestDigest: string } {
  const body = recordOf(value, "body");
  exactKeys(body, ["version", "requestId", "requestDigest"], [], "body");
  if (body.version !== 1) throw new FabricContractError("unsupported_version", "body.version must be 1", "body.version");
  const requestDigest = stringField(body, "requestDigest", "body", 64);
  if (!/^[a-f0-9]{64}$/u.test(requestDigest)) throw new FabricContractError("invalid_argument", "body.requestDigest must be a SHA-256 digest", "body.requestDigest");
  return { requestId: stringField(body, "requestId", "body"), requestDigest };
}

async function readJsonBody(request: IncomingMessage, maximumBytes: number, timeoutMs: number): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    throw new FabricContractError("invalid_argument", "Fabric registration requires application/json", "content-type");
  }
  const declared = request.headers["content-length"];
  if (typeof declared === "string") {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new FabricContractError("invalid_argument", "Content-Length is invalid", "content-length");
    if (bytes > maximumBytes) throw new FabricContractError("resource_exhausted", `Request exceeds ${maximumBytes} bytes`, "content-length");
  }
  request.setTimeout(timeoutMs, () => request.destroy(new Error("Fabric registration request timed out")));
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maximumBytes) throw new FabricContractError("resource_exhausted", `Request exceeds ${maximumBytes} bytes`, "body");
      chunks.push(buffer);
    }
  } finally {
    request.setTimeout(0);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw); }
  catch { throw new FabricContractError("invalid_argument", "Request body must be valid JSON", "body"); }
}

function statusOf(error: FabricContractError): number {
  if (error.code === "unauthenticated") return 401;
  if (error.code === "permission_denied") return 403;
  if (error.code === "not_found") return 404;
  if (error.code === "conflict" || error.code === "stale_generation" || error.code === "invalid_state") return 409;
  if (error.code === "resource_exhausted") return 413;
  if (error.code === "unavailable") return 503;
  return 400;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

/** Strict route owner for enrollment, rotation, and possession-based receipt recovery. */
export class FabricEnrollmentHttpServer {
  readonly #adapter: FabricPairingAdapter;
  readonly #authority: GatewayFabricRegistrationAuthority;
  readonly #maximumBytes: number;
  readonly #timeoutMs: number;

  constructor(options: FabricEnrollmentHttpOptions) {
    this.#adapter = options.adapter;
    this.#authority = options.authority;
    this.#maximumBytes = positive(options.maximumBytes, DEFAULT_MAXIMUM_BYTES, "maximumBytes");
    this.#timeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  }

  handles(pathname: string): boolean { return REGISTRATION_PATHS.has(pathname); }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (!("encrypted" in request.socket) || request.socket.encrypted !== true) {
      sendJson(response, 400, { error: { code: "tls_required", message: "Fabric registration requires native TLS" } });
      return;
    }
    if (url.search !== "" || url.hash !== "") {
      sendJson(response, 400, { error: { code: "invalid_request", message: "Fabric registration routes do not accept query or fragment data" } });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      sendJson(response, 405, { error: { code: "method_not_allowed", message: "Fabric registration routes require POST" } });
      return;
    }
    try {
      const token = bearerToken(request);
      const body = await readJsonBody(request, this.#maximumBytes, this.#timeoutMs);
      if (url.pathname === FABRIC_ENROLLMENT_PATH) {
        sendJson(response, 201, await this.#adapter.enrollFromPairing({ token, ...enrollmentBody(body) }));
        return;
      }
      if (url.pathname === FABRIC_ROTATION_PATH) {
        sendJson(response, 200, await this.#adapter.rotateFromPairing({ token, ...rotationBody(body) }));
        return;
      }
      const receiptRequest = receiptBody(body);
      const recovered = await this.#authority.receipt({ rawToken: token, ...receiptRequest });
      if (recovered === undefined) {
        sendJson(response, 401, { error: { code: "unauthorized", message: "Registration receipt is unavailable" } });
        return;
      }
      sendJson(response, 200, recovered);
    } catch (error) {
      if (error instanceof FabricContractError) {
        sendJson(response, statusOf(error), { error: { code: error.code, message: error.message } });
        return;
      }
      sendJson(response, 503, { error: { code: "unavailable", message: "Fabric registration is unavailable" } });
    }
  }
}
