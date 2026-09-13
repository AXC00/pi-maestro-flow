import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startGatewayHttpServer } from "../src/gateway/http-server.ts";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";
import {
  FABRIC_ENROLLMENT_PATH,
  FABRIC_REGISTRATION_RECEIPT_PATH,
  FABRIC_ROTATION_PATH,
} from "../src/gateway/fabric/enrollment-http.ts";
import {
  FABRIC_ENROLL_SCOPE,
  FABRIC_PAIRING_PROVIDER,
  FABRIC_ROTATE_SCOPE,
  type GatewayFabricRegistrationReceiptV1,
} from "../src/gateway/fabric/registration.ts";

const certificatePath = join(import.meta.dirname, "fixtures", "fabric-test-cert.pem");
const keyPath = join(import.meta.dirname, "fixtures", "fabric-test-key.pem");

function publicKey(): string {
  return generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
}

async function post(url: URL, ca: Buffer, token: string | undefined, body: unknown): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  value: unknown;
}> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: "POST",
      ca,
      rejectUnauthorized: true,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            value: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        } catch (error) { reject(error); }
      });
    });
    request.once("error", reject);
    request.end(payload);
  });
}

async function harness(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "gateway-fabric-enrollment-http-"));
  const config = createTestGatewayConfig(root, { mode: "bearer", token: "gateway-only-token" });
  config.fabric = { enabled: true, audience: "hub.example.test" };
  config.transport.http.enabled = true;
  config.transport.http.host = "localhost";
  config.transport.http.tls = { enabled: true, certFile: certificatePath, keyFile: keyPath };
  const runtime = await GatewayRuntime.create({ config, cwd: root });
  const server = await startGatewayHttpServer(runtime, { host: "localhost", port: 0 });
  const ca = await readFile(certificatePath);
  t.after(async () => { await server.close(); await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { runtime, server, ca };
}

async function issue(runtime: GatewayRuntime, scope: typeof FABRIC_ENROLL_SCOPE | typeof FABRIC_ROTATE_SCOPE, generation = 1) {
  return runtime.pairingStore.issue({
    audience: "fabric",
    provider: FABRIC_PAIRING_PROVIDER,
    instance: "connector-1",
    scopes: [scope],
    generation,
    ttlMs: 600_000,
  });
}

function enrollmentBody(spki: string): Record<string, unknown> {
  return {
    version: 1,
    requestId: "enroll-http-1",
    connector: { connectorId: "connector-1", label: "Connector One", transport: "outbound-wss" },
    devices: [{ deviceId: "device-1", label: "Device One", connectionMode: "https", enabled: true }],
    keyId: "key-1",
    publicKeySpki: spki,
  };
}

test("native HTTPS enrollment authenticates only the bearer header and recovers a consumed receipt", async (t) => {
  const target = await harness(t);
  const issued = await issue(target.runtime, FABRIC_ENROLL_SCOPE);
  const body = enrollmentBody(publicKey());
  const endpoint = new URL(FABRIC_ENROLLMENT_PATH, target.server.url);

  const missing = await post(endpoint, target.ca, undefined, body);
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.location, undefined);
  const genericGatewayBearer = await post(endpoint, target.ca, "gateway-only-token", body);
  assert.equal(genericGatewayBearer.status, 401, "Gateway bearer authority must not authorize Fabric enrollment");

  const bodyCredential = await post(endpoint, target.ca, issued.token, { ...body, token: issued.token });
  assert.equal(bodyCredential.status, 400);
  assert.match(JSON.stringify(bodyCredential.value), /body\.token is not supported/u);
  assert.equal((await target.runtime.fabricRegistration?.list())?.length, 0);

  const oversized = await post(endpoint, target.ca, issued.token, { ...body, padding: "x".repeat(70 * 1024) });
  assert.equal(oversized.status, 413);
  assert.equal((await target.runtime.fabricRegistration?.list())?.length, 0);

  const enrolled = await post(endpoint, target.ca, issued.token, body);
  assert.equal(enrolled.status, 201);
  assert.equal(enrolled.headers.location, undefined, "credential-bearing requests must never be redirected");
  const receipt = enrolled.value as GatewayFabricRegistrationReceiptV1;
  assert.equal(receipt.status, "active");
  assert.equal(await target.runtime.pairingStore.authenticate(issued.token, { audience: "fabric" }), undefined);

  const recovered = await post(new URL(FABRIC_REGISTRATION_RECEIPT_PATH, target.server.url), target.ca, issued.token, {
    version: 1,
    requestId: receipt.requestId,
    requestDigest: receipt.requestDigest,
  });
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.value, receipt);
  assert.equal(recovered.headers.location, undefined);

  const wrong = await post(new URL(FABRIC_REGISTRATION_RECEIPT_PATH, target.server.url), target.ca, "wrong-token", {
    version: 1,
    requestId: receipt.requestId,
    requestDigest: receipt.requestDigest,
  });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.value, { error: { code: "unauthorized", message: "Registration receipt is unavailable" } });
});

test("HTTPS rotation enforces its purpose generation and advances durable authority once", async (t) => {
  const target = await harness(t);
  const enrollment = await issue(target.runtime, FABRIC_ENROLL_SCOPE);
  const enrolled = await post(new URL(FABRIC_ENROLLMENT_PATH, target.server.url), target.ca, enrollment.token, enrollmentBody(publicKey()));
  assert.equal(enrolled.status, 201);

  const rotation = await issue(target.runtime, FABRIC_ROTATE_SCOPE, 1);
  const rotated = await post(new URL(FABRIC_ROTATION_PATH, target.server.url), target.ca, rotation.token, {
    version: 1,
    requestId: "rotate-http-1",
    connectorId: "connector-1",
    expectedRevision: 1,
    expectedCredentialGeneration: 1,
    keyId: "key-2",
    publicKeySpki: publicKey(),
  });
  assert.equal(rotated.status, 200);
  assert.deepEqual(
    { revision: (rotated.value as GatewayFabricRegistrationReceiptV1).connectorRevision, generation: (rotated.value as GatewayFabricRegistrationReceiptV1).credentialGeneration },
    { revision: 2, generation: 2 },
  );
  assert.equal(target.runtime.fabricAdmissionReady, true);
  assert.deepEqual(
    { revision: target.runtime.fabricControlRuntime?.directory.getConnector("connector-1")?.revision, generation: target.runtime.fabricControlRuntime?.directory.getConnector("connector-1")?.credentialGeneration },
    { revision: 2, generation: 2 },
  );

  const wrongGeneration = await target.runtime.pairingStore.issue({
    audience: "fabric", provider: FABRIC_PAIRING_PROVIDER, instance: "connector-1",
    scopes: [FABRIC_ROTATE_SCOPE], generation: 1, ttlMs: 600_000,
  });
  const rejected = await post(new URL(FABRIC_ROTATION_PATH, target.server.url), target.ca, wrongGeneration.token, {
    version: 1, requestId: "rotate-http-2", connectorId: "connector-1",
    expectedRevision: 2, expectedCredentialGeneration: 2, keyId: "key-3", publicKeySpki: publicKey(),
  });
  assert.equal(rejected.status, 401);
});

test("Fabric enrollment routes cannot start on a plaintext listener", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-fabric-enrollment-plaintext-"));
  const config = createTestGatewayConfig(root, { mode: "bearer", token: "gateway-only-token" });
  config.fabric = { enabled: true };
  config.transport.http.enabled = true;
  config.transport.http.tls = { enabled: false };
  const runtime = await GatewayRuntime.create({ config, cwd: root });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(
    () => startGatewayHttpServer(runtime, { host: "127.0.0.1", port: 0 }),
    /Fabric enrollment routes require native HTTPS/,
  );
});
