import { generateKeyPairSync, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { DeviceRecord } from "pi-maestro-fabric-core/v1";
import { enforceGatewayPrivatePath, type GatewayWindowsAclRunner } from "../private-path.ts";
import {
  FABRIC_CONNECTOR_CONFIG_VERSION,
  fabricConnectorConfigPath,
  loadFabricConnectorConfig,
  parseFabricConnectorConfig,
  type FabricConnectorConfigV1,
} from "./connector-config.ts";
import {
  FABRIC_ENROLLMENT_PATH,
  FABRIC_REGISTRATION_RECEIPT_PATH,
  FABRIC_ROTATION_PATH,
} from "./enrollment-http.ts";
import {
  gatewayFabricEnrollmentBodyDigest,
  gatewayFabricRotationBodyDigest,
  type GatewayFabricEnrollmentDigestBody,
  type GatewayFabricRegistrationReceiptV1,
  type GatewayFabricRotationDigestBody,
} from "./registration.ts";

const PENDING_FILE = "fabric-connector.pending.json";
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_PENDING_BYTES = 64 * 1024;

export interface FabricConnectorRegistrationEndpoints {
  readonly origin: string;
  readonly enrollUrl: string;
  readonly rotateUrl: string;
  readonly receiptUrl: string;
  readonly wssUrl: string;
  readonly audience: string;
}

export interface FabricConnectorRegistrationHttpRequest {
  readonly url: string;
  readonly token: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly ca?: Buffer;
}

export type FabricConnectorRegistrationHttp = (request: FabricConnectorRegistrationHttpRequest) => Promise<unknown>;

export interface FabricConnectorRegistrationOptions {
  readonly root: string;
  readonly token: string;
  readonly caPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly windowsAclRunner?: GatewayWindowsAclRunner;
  readonly http?: FabricConnectorRegistrationHttp;
  readonly requestId?: () => string;
  readonly fault?: (point: "after-key" | "after-journal" | "after-receipt" | "before-config-rename" | "after-config-rename") => Promise<void>;
}

export interface FabricConnectorEnrollOptions extends FabricConnectorRegistrationOptions {
  readonly hub: string;
  readonly connectorId: string;
  readonly devices: readonly Omit<DeviceRecord, "connectorId" | "revision">[];
  readonly localDeviceId: string;
  readonly workspaceIds?: readonly string[];
}

export interface FabricConnectorRotateOptions extends FabricConnectorRegistrationOptions {
  readonly expectedRevision: number;
  readonly expectedCredentialGeneration: number;
}

type PendingOperation = {
  version: 1;
  operation: "enroll" | "rotate";
  requestId: string;
  requestDigest: string;
  operationUrl: string;
  receiptUrl: string;
  wssUrl: string;
  audience: string;
  keyPath: string;
  configPath: string;
  caPath?: string;
  body: Record<string, unknown>;
  devices: DeviceRecord[];
  localDeviceId: string;
  workspaceIds: string[];
};

export class FabricConnectorRegistrationPendingError extends Error {
  readonly pendingPath: string;
  constructor(pendingPath: string) {
    super(`Fabric Connector registration response is uncertain; retry the exact command with the same token to recover the existing receipt from ${pendingPath}`);
    this.name = "FabricConnectorRegistrationPendingError";
    this.pendingPath = pendingPath;
  }
}

export function deriveFabricConnectorRegistrationEndpoints(input: string): FabricConnectorRegistrationEndpoints {
  let url: URL;
  try { url = new URL(input); }
  catch { throw new Error("--hub must be a valid credential-free HTTPS origin"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || (url.pathname !== "" && url.pathname !== "/")) {
    throw new Error("--hub must be a credential-free HTTPS origin without path, query, or fragment");
  }
  const origin = url.origin;
  const wss = new URL(origin);
  wss.protocol = "wss:";
  wss.pathname = "/fabric/v1/connector";
  return {
    origin,
    enrollUrl: `${origin}${FABRIC_ENROLLMENT_PATH}`,
    rotateUrl: `${origin}${FABRIC_ROTATION_PATH}`,
    receiptUrl: `${origin}${FABRIC_REGISTRATION_RECEIPT_PATH}`,
    wssUrl: wss.toString(),
    audience: "fabric",
  };
}

export async function fabricConnectorEnroll(options: FabricConnectorEnrollOptions): Promise<FabricConnectorConfigV1> {
  const paths = deriveFabricConnectorRegistrationEndpoints(options.hub);
  const pendingPath = join(resolve(options.root), ".pi", PENDING_FILE);
  const existing = await readPending(pendingPath);
  if (existing !== undefined) {
    if (existing.operation !== "enroll" || existing.wssUrl !== paths.wssUrl) throw new Error(`A different Fabric Connector registration is pending at ${pendingPath}`);
    return recoverPending(existing, pendingPath, options);
  }
  const requestId = (options.requestId ?? randomUUID)();
  const keyId = `key-${requestId}`;
  const deviceRecords = options.devices.map((device): DeviceRecord => ({ ...device, connectorId: options.connectorId, revision: 1 }));
  const validationDocument = parseFabricConnectorConfig({
    version: FABRIC_CONNECTOR_CONFIG_VERSION, enabled: true, hubUrl: paths.wssUrl,
    connectorId: options.connectorId, keyId, audience: paths.audience, credentialGeneration: 1,
    privateKeyPath: resolve(options.root, ".pi", `fabric-connector-${requestId}.pem`),
    ...(options.caPath === undefined ? {} : { caPath: resolve(options.caPath) }),
    devices: deviceRecords, localDeviceId: options.localDeviceId, workspaceIds: [...(options.workspaceIds ?? [])], revision: 1,
  });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyPath = validationDocument.privateKeyPath;
  const privateBytes = Buffer.from(privateKey.export({ format: "pem", type: "pkcs8" }), "utf8");
  try { await writePrivateExclusive(keyPath, privateBytes, options); }
  finally { privateBytes.fill(0); }
  await options.fault?.("after-key");
  const body = {
    version: 1,
    requestId,
    connector: { connectorId: options.connectorId, label: options.connectorId, transport: "outbound-wss" as const },
    devices: options.devices.map((device) => ({ ...device })),
    keyId,
    publicKeySpki: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
  const requestDigest = gatewayFabricEnrollmentBodyDigest({
    requestId, connector: body.connector, devices: options.devices, keyId, publicKeySpki: body.publicKeySpki,
  });
  const pending: PendingOperation = {
    version: 1, operation: "enroll", requestId, requestDigest,
    operationUrl: paths.enrollUrl, receiptUrl: paths.receiptUrl, wssUrl: paths.wssUrl, audience: paths.audience,
    keyPath, configPath: fabricConnectorConfigPath(resolve(options.root)),
    ...(validationDocument.caPath === undefined ? {} : { caPath: validationDocument.caPath }),
    body, devices: deviceRecords, localDeviceId: options.localDeviceId, workspaceIds: [...(options.workspaceIds ?? [])],
  };
  await writePrivateAtomic(pendingPath, Buffer.from(`${JSON.stringify(pending)}\n`, "utf8"), options);
  await options.fault?.("after-journal");
  return submitPending(pending, pendingPath, options);
}

export async function fabricConnectorRotate(options: FabricConnectorRotateOptions): Promise<FabricConnectorConfigV1> {
  const root = resolve(options.root);
  const pendingPath = join(root, ".pi", PENDING_FILE);
  const existing = await readPending(pendingPath);
  if (existing !== undefined) {
    if (existing.operation !== "rotate") throw new Error(`A different Fabric Connector registration is pending at ${pendingPath}`);
    return recoverPending(existing, pendingPath, options);
  }
  const current = await loadFabricConnectorConfig(fabricConnectorConfigPath(root));
  if (current === undefined) throw new Error("Fabric Connector is not enrolled");
  requireIdentityMetadata(current);
  if (current.revision !== options.expectedRevision || current.credentialGeneration !== options.expectedCredentialGeneration) {
    throw new Error("Rotation fences do not match the active Connector config");
  }
  const endpoints = deriveEndpointsFromWss(current.hubUrl);
  const requestId = (options.requestId ?? randomUUID)();
  const keyId = `key-${requestId}`;
  const keyPath = join(root, ".pi", `fabric-connector-${requestId}.pem`);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateBytes = Buffer.from(privateKey.export({ format: "pem", type: "pkcs8" }), "utf8");
  try { await writePrivateExclusive(keyPath, privateBytes, options); }
  finally { privateBytes.fill(0); }
  await options.fault?.("after-key");
  const body = {
    version: 1, requestId, connectorId: current.connectorId,
    expectedRevision: options.expectedRevision,
    expectedCredentialGeneration: options.expectedCredentialGeneration,
    keyId, publicKeySpki: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
  const rotationCaPath = options.caPath === undefined ? current.caPath : resolve(options.caPath);
  const pending: PendingOperation = {
    version: 1, operation: "rotate", requestId,
    requestDigest: gatewayFabricRotationBodyDigest({
      requestId, connectorId: current.connectorId, expectedRevision: options.expectedRevision,
      expectedCredentialGeneration: options.expectedCredentialGeneration, keyId, publicKeySpki: body.publicKeySpki,
    }),
    operationUrl: endpoints.rotateUrl, receiptUrl: endpoints.receiptUrl, wssUrl: current.hubUrl, audience: current.audience,
    keyPath, configPath: fabricConnectorConfigPath(root), ...(rotationCaPath === undefined ? {} : { caPath: rotationCaPath }),
    body, devices: [...current.devices], localDeviceId: current.localDeviceId, workspaceIds: [...current.workspaceIds],
  };
  await writePrivateAtomic(pendingPath, Buffer.from(`${JSON.stringify(pending)}\n`, "utf8"), options);
  await options.fault?.("after-journal");
  return submitPending(pending, pendingPath, options);
}

export function requireIdentityMetadata(config: FabricConnectorConfigV1): asserts config is FabricConnectorConfigV1 & Required<Pick<FabricConnectorConfigV1, "devices" | "localDeviceId" | "workspaceIds">> {
  if (config.devices === undefined || config.localDeviceId === undefined || config.workspaceIds === undefined) {
    throw new Error("Fabric Connector config predates Device enrollment metadata; run connector enroll/upgrade before start");
  }
}

async function recoverPending(pending: PendingOperation, pendingPath: string, options: FabricConnectorRegistrationOptions): Promise<FabricConnectorConfigV1> {
  const receipt = await post(options, pending.receiptUrl, {
    version: 1, requestId: pending.requestId, requestDigest: pending.requestDigest,
  }, pending.caPath).catch(() => undefined);
  if (receipt === undefined) throw new FabricConnectorRegistrationPendingError(pendingPath);
  return installReceipt(pending, pendingPath, receipt, options);
}

async function submitPending(pending: PendingOperation, pendingPath: string, options: FabricConnectorRegistrationOptions): Promise<FabricConnectorConfigV1> {
  let receipt: unknown;
  try { receipt = await post(options, pending.operationUrl, pending.body, pending.caPath); }
  catch { throw new FabricConnectorRegistrationPendingError(pendingPath); }
  await options.fault?.("after-receipt");
  return installReceipt(pending, pendingPath, receipt, options);
}

async function installReceipt(pending: PendingOperation, pendingPath: string, value: unknown, options: FabricConnectorRegistrationOptions): Promise<FabricConnectorConfigV1> {
  const receipt = parseActiveReceipt(value, pending);
  const config = parseFabricConnectorConfig({
    version: FABRIC_CONNECTOR_CONFIG_VERSION, enabled: true, hubUrl: pending.wssUrl,
    connectorId: receipt.connectorId, keyId: String(pending.body.keyId), audience: pending.audience,
    credentialGeneration: receipt.credentialGeneration, privateKeyPath: pending.keyPath,
    ...(pending.caPath === undefined ? {} : { caPath: pending.caPath }),
    devices: pending.devices, localDeviceId: pending.localDeviceId, workspaceIds: pending.workspaceIds,
    revision: receipt.connectorRevision,
  });
  await writePrivateAtomic(pending.configPath, Buffer.from(`${JSON.stringify(config, null, 2)}\n`, "utf8"), options, "before-config-rename", "after-config-rename");
  await rm(pendingPath, { force: true });
  await syncDirectory(dirname(pendingPath), options.platform ?? process.platform);
  return config;
}

function parseActiveReceipt(value: unknown, pending: PendingOperation): GatewayFabricRegistrationReceiptV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Hub returned an invalid registration receipt");
  const receipt = value as Readonly<Record<string, unknown>>;
  if (receipt.version !== "fabric.registration-receipt.v1" || receipt.requestId !== pending.requestId || receipt.requestDigest !== pending.requestDigest ||
    receipt.operation !== pending.operation || receipt.status !== "active" || typeof receipt.connectorId !== "string" ||
    typeof receipt.connectorRevision !== "number" || !Number.isSafeInteger(receipt.connectorRevision) ||
    typeof receipt.credentialGeneration !== "number" || !Number.isSafeInteger(receipt.credentialGeneration) ||
    typeof receipt.committedAt !== "number" || !Number.isSafeInteger(receipt.committedAt)) {
    throw new Error("Hub returned a mismatched or inactive registration receipt");
  }
  return {
    version: "fabric.registration-receipt.v1", requestId: pending.requestId, operation: pending.operation,
    connectorId: receipt.connectorId, requestDigest: pending.requestDigest,
    connectorRevision: receipt.connectorRevision, credentialGeneration: receipt.credentialGeneration,
    status: "active", committedAt: receipt.committedAt,
  };
}

function deriveEndpointsFromWss(input: string): FabricConnectorRegistrationEndpoints {
  const url = new URL(input);
  if (url.protocol !== "wss:" || url.pathname !== "/fabric/v1/connector" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw new Error("Active Connector config does not contain the canonical WSS Hub URL");
  }
  url.protocol = "https:";
  url.pathname = "/";
  return deriveFabricConnectorRegistrationEndpoints(url.toString());
}

async function post(options: FabricConnectorRegistrationOptions, url: string, body: Readonly<Record<string, unknown>>, storedCaPath?: string): Promise<unknown> {
  const caPath = options.caPath ?? storedCaPath;
  const ca = caPath === undefined ? undefined : await readFile(caPath);
  return (options.http ?? nativeFabricConnectorRegistrationPost)({ url, token: options.token, body, ...(ca === undefined ? {} : { ca }) });
}

export async function nativeFabricConnectorRegistrationPost(input: FabricConnectorRegistrationHttpRequest): Promise<unknown> {
  const url = new URL(input.url);
  if (url.protocol !== "https:") throw new Error("Fabric registration requires HTTPS");
  const payload = Buffer.from(JSON.stringify(input.body), "utf8");
  return new Promise<unknown>((resolvePromise, reject) => {
    const request = httpsRequest(url, {
      method: "POST", ca: input.ca, rejectUnauthorized: true,
      headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json", "content-length": payload.byteLength },
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) request.destroy(new Error("Hub registration response is too large"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) { reject(new Error("Fabric registration redirects are refused")); return; }
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { reject(new Error("Hub returned an invalid registration response")); return; }
        if (status < 200 || status >= 300) { reject(new Error(`Hub rejected Fabric registration with HTTP ${status}`)); return; }
        resolvePromise(parsed);
      });
    });
    request.setTimeout(10_000, () => request.destroy(new Error("Fabric registration request timed out")));
    request.once("error", reject);
    request.end(payload);
  });
}

function pendingBodyDigest(operation: PendingOperation["operation"], body: Readonly<Record<string, unknown>>): string {
  const allowed = operation === "enroll"
    ? new Set(["version", "requestId", "connector", "devices", "keyId", "publicKeySpki", "expiresAt"])
    : new Set(["version", "requestId", "connectorId", "expectedRevision", "expectedCredentialGeneration", "keyId", "publicKeySpki"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new Error(`Fabric Connector pending ${operation} body has unsupported field ${JSON.stringify(key)}`);
  }
  if (body.version !== 1) throw new Error(`Fabric Connector pending ${operation} body has an unsupported version`);
  const { version: _version, ...digestBody } = body;
  return operation === "enroll"
    ? gatewayFabricEnrollmentBodyDigest(digestBody as unknown as GatewayFabricEnrollmentDigestBody)
    : gatewayFabricRotationBodyDigest(digestBody as unknown as GatewayFabricRotationDigestBody);
}

async function readPending(path: string): Promise<PendingOperation | undefined> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_PENDING_BYTES) {
    throw new Error(`Fabric Connector pending journal exceeds 64 KiB at ${path}`);
  }
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Malformed Fabric Connector pending journal at ${path}`);
  const source = value as Readonly<Record<string, unknown>>;
  const allowed = new Set(["version", "operation", "requestId", "requestDigest", "operationUrl", "receiptUrl", "wssUrl", "audience", "keyPath", "configPath", "caPath", "body", "devices", "localDeviceId", "workspaceIds"]);
  for (const key of Object.keys(source)) if (!allowed.has(key)) throw new Error(`Malformed Fabric Connector pending journal at ${path}`);
  if (source.version !== 1 || (source.operation !== "enroll" && source.operation !== "rotate") || typeof source.requestId !== "string" ||
    typeof source.requestDigest !== "string" || !/^[a-f0-9]{64}$/u.test(source.requestDigest) || typeof source.operationUrl !== "string" ||
    typeof source.receiptUrl !== "string" || typeof source.wssUrl !== "string" || source.audience !== "fabric" ||
    typeof source.keyPath !== "string" || !isAbsolute(source.keyPath) || typeof source.configPath !== "string" || !isAbsolute(source.configPath) ||
    typeof source.body !== "object" || source.body === null || Array.isArray(source.body) || !Array.isArray(source.devices) ||
    typeof source.localDeviceId !== "string" || !Array.isArray(source.workspaceIds) || (source.caPath !== undefined && (typeof source.caPath !== "string" || !isAbsolute(source.caPath)))) throw new Error(`Malformed Fabric Connector pending journal at ${path}`);
  const body = source.body as Readonly<Record<string, unknown>>;
  let computedDigest: string;
  try { computedDigest = pendingBodyDigest(source.operation, body); }
  catch { throw new Error(`Malformed Fabric Connector pending journal at ${path}`); }
  if (computedDigest !== source.requestDigest || body.requestId !== source.requestId) {
    throw new Error(`Malformed Fabric Connector pending journal at ${path}`);
  }
  const connectorSource = source.operation === "enroll" && typeof body.connector === "object" && body.connector !== null && !Array.isArray(body.connector)
    ? body.connector as Readonly<Record<string, unknown>> : undefined;
  const connectorId = source.operation === "enroll" ? connectorSource?.connectorId : body.connectorId;
  if (typeof connectorId !== "string" || typeof body.keyId !== "string") throw new Error(`Malformed Fabric Connector pending journal at ${path}`);
  const validated = parseFabricConnectorConfig({
    version: FABRIC_CONNECTOR_CONFIG_VERSION, enabled: true, hubUrl: source.wssUrl, connectorId, keyId: body.keyId,
    audience: "fabric", credentialGeneration: 1, privateKeyPath: source.keyPath,
    ...(source.caPath === undefined ? {} : { caPath: source.caPath }), devices: source.devices,
    localDeviceId: source.localDeviceId, workspaceIds: source.workspaceIds, revision: 1,
  });
  requireIdentityMetadata(validated);
  if (source.operation === "enroll") {
    if (!Array.isArray(body.devices)) throw new Error(`Malformed Fabric Connector pending journal at ${path}`);
    const registeredDevices = body.devices.map((device) => ({
      ...(device as Readonly<Record<string, unknown>>),
      connectorId,
      revision: 1,
    }));
    const registered = parseFabricConnectorConfig({
      ...validated,
      devices: registeredDevices,
    });
    requireIdentityMetadata(registered);
    if (JSON.stringify(registered.devices) !== JSON.stringify(validated.devices)) {
      throw new Error(`Malformed Fabric Connector pending journal at ${path}`);
    }
  }
  const endpoints = deriveEndpointsFromWss(source.wssUrl);
  if (source.receiptUrl !== endpoints.receiptUrl || source.operationUrl !== (source.operation === "enroll" ? endpoints.enrollUrl : endpoints.rotateUrl) ||
    dirname(source.configPath) !== dirname(path) || dirname(source.keyPath) !== dirname(path)) throw new Error(`Malformed Fabric Connector pending journal at ${path}`);
  return {
    version: 1, operation: source.operation, requestId: source.requestId, requestDigest: source.requestDigest,
    operationUrl: source.operationUrl, receiptUrl: source.receiptUrl, wssUrl: source.wssUrl, audience: "fabric",
    keyPath: source.keyPath, configPath: source.configPath, ...(source.caPath === undefined ? {} : { caPath: source.caPath }),
    body: { ...body }, devices: [...validated.devices], localDeviceId: validated.localDeviceId, workspaceIds: [...validated.workspaceIds],
  };
}

async function writePrivateExclusive(path: string, bytes: string | Buffer, options: FabricConnectorRegistrationOptions): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await enforceGatewayPrivatePath(directory, "directory", options);
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  try { await enforceGatewayPrivatePath(path, "file", options); }
  catch (error) { await rm(path, { force: true }); throw error; }
  await syncDirectory(directory, options.platform ?? process.platform);
}

async function writePrivateAtomic(
  path: string,
  bytes: Buffer,
  options: FabricConnectorRegistrationOptions,
  beforeRename?: "before-config-rename",
  afterRename?: "after-config-rename",
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await enforceGatewayPrivatePath(directory, "directory", options);
  const temporary = join(directory, `.${randomUUID()}.next`);
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await enforceGatewayPrivatePath(temporary, "file", options);
    if (beforeRename !== undefined) await options.fault?.(beforeRename);
    await rename(temporary, path);
    await enforceGatewayPrivatePath(path, "file", options);
    await syncDirectory(directory, options.platform ?? process.platform);
    if (afterRename !== undefined) await options.fault?.(afterRename);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function syncDirectory(path: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); }
  finally { await handle.close(); }
}
