import assert from "node:assert/strict";
import { createServer as createHttpsServer } from "node:https";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import { main as gatewayCliMain } from "../src/gateway/cli.ts";
import {
  FabricConnectorRegistrationPendingError,
  deriveFabricConnectorRegistrationEndpoints,
  fabricConnectorEnroll,
  fabricConnectorRotate,
  nativeFabricConnectorRegistrationPost,
  type FabricConnectorRegistrationHttpRequest,
} from "../src/gateway/fabric/connector-registration-cli.ts";
import { fabricConnectorConfigPath, loadFabricConnectorConfig } from "../src/gateway/fabric/connector-config.ts";
import { gatewayFabricEnrollmentBodyDigest, gatewayFabricRotationBodyDigest } from "../src/gateway/fabric/registration.ts";

const certificatePath = join(import.meta.dirname, "fixtures", "fabric-test-cert.pem");
const keyPath = join(import.meta.dirname, "fixtures", "fabric-test-key.pem");
const TOKEN = "purpose_token_private";

async function root(t: test.TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "fabric-device-cli-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function enrollOptions(path: string) {
  return {
    root: path, token: TOKEN, hub: "https://hub.example.test", connectorId: "connector-1",
    platform: "win32" as const, windowsAclRunner: async () => undefined,
    devices: [{ deviceId: "device-1", label: "Device One", connectionMode: "https" as const, enabled: true }],
    localDeviceId: "device-1", requestId: () => "request-enroll",
  };
}

function receiptFor(request: FabricConnectorRegistrationHttpRequest, operation: "enroll" | "rotate", revision: number, generation: number) {
  const body = request.body;
  const requestId = String(body.requestId);
  const requestDigest = operation === "enroll"
    ? gatewayFabricEnrollmentBodyDigest({
      requestId,
      connector: body.connector as { connectorId: string; label: string; transport: "outbound-wss" },
      devices: body.devices as [{ deviceId: string; label: string; connectionMode: "https"; enabled: boolean }],
      keyId: String(body.keyId), publicKeySpki: String(body.publicKeySpki),
    })
    : gatewayFabricRotationBodyDigest({
      requestId, connectorId: String(body.connectorId), expectedRevision: Number(body.expectedRevision),
      expectedCredentialGeneration: Number(body.expectedCredentialGeneration), keyId: String(body.keyId), publicKeySpki: String(body.publicKeySpki),
    });
  return {
    version: "fabric.registration-receipt.v1", requestId, operation, connectorId: "connector-1", requestDigest,
    connectorRevision: revision, credentialGeneration: generation, status: "active", committedAt: 1,
  };
}

test("Hub origin derivation is credential-free HTTPS and canonical", () => {
  assert.deepEqual(deriveFabricConnectorRegistrationEndpoints("https://hub.example.test"), {
    origin: "https://hub.example.test", enrollUrl: "https://hub.example.test/fabric/v1/enroll",
    rotateUrl: "https://hub.example.test/fabric/v1/rotate", receiptUrl: "https://hub.example.test/fabric/v1/registration-receipt",
    wssUrl: "wss://hub.example.test/fabric/v1/connector", audience: "fabric",
  });
  for (const value of ["http://hub.example.test", "https://user:secret@hub.example.test", "https://hub.example.test/path", "https://hub.example.test/?token=x", "https://hub.example.test/#x"]) {
    assert.throws(() => deriveFabricConnectorRegistrationEndpoints(value), /credential-free HTTPS origin/);
  }
});

test("native registration transport rejects redirects without following Authorization", async (t) => {
  let requests = 0;
  const server = createHttpsServer({ cert: await readFile(certificatePath), key: await readFile(keyPath) }, (_request, response) => {
    requests += 1;
    response.writeHead(302, { location: "https://elsewhere.invalid/fabric/v1/enroll" });
    response.end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "localhost", resolve); });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server has no port");
  const ca = await readFile(certificatePath);
  await assert.rejects(() => nativeFabricConnectorRegistrationPost({
    url: `https://localhost:${address.port}/fabric/v1/enroll`, token: TOKEN, body: {}, ca,
  }), /redirects are refused/);
  assert.equal(requests, 1);
});

test("connector enroll CLI reads the token from stdin and never emits it", async (t) => {
  const path = await root(t);
  const stdin = new PassThrough();
  stdin.end(`${TOKEN}\n`);
  let stdout = "";
  let stderr = "";
  const code = await gatewayCliMain([
    "connector", "enroll", "--hub", "https://hub.example.test", "--connector-id", "connector-1",
    "--device-id", "device-1", "--token-stdin", "--json",
  ], {
    stdin,
    stdout: { write: (chunk: string) => { stdout += String(chunk); return true; } } as never,
    stderr: { write: (chunk: string) => { stderr += String(chunk); return true; } } as never,
    connectorRoot: path, connectorPlatform: "win32", connectorWindowsAclRunner: async () => undefined,
    fabricRegistrationHttp: (request) => Promise.resolve(receiptFor(request, "enroll", 1, 1)),
  });
  assert.equal(code, 0, stderr);
  assert.equal(stdout.includes(TOKEN), false);
  assert.equal(stderr.includes(TOKEN), false);
  assert.equal((await loadFabricConnectorConfig(fabricConnectorConfigPath(path)))?.localDeviceId, "device-1");
});

test("enroll generates local keys and atomically installs a private identity config", async (t) => {
  const path = await root(t);
  const calls: FabricConnectorRegistrationHttpRequest[] = [];
  const config = await fabricConnectorEnroll({ ...enrollOptions(path), http: async (request) => {
    calls.push(request);
    return receiptFor(request, "enroll", 1, 1);
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.token, TOKEN);
  assert.equal(config.localDeviceId, "device-1");
  assert.deepEqual(config.workspaceIds, []);
  assert.equal((await readFile(config.privateKeyPath, "utf8")).includes("PRIVATE KEY"), true);
  assert.equal((await readFile(fabricConnectorConfigPath(path), "utf8")).includes(TOKEN), false);
  await assert.rejects(() => readFile(join(path, ".pi", "fabric-connector.pending.json")), /ENOENT/);
  if (process.platform !== "win32") {
    assert.equal((await stat(config.privateKeyPath)).mode & 0o077, 0);
    assert.equal((await stat(fabricConnectorConfigPath(path))).mode & 0o077, 0);
  }
});

test("lost response retains a token-free journal and retries receipt only", async (t) => {
  const path = await root(t);
  const firstCalls: string[] = [];
  await assert.rejects(() => fabricConnectorEnroll({ ...enrollOptions(path), http: async (request) => {
    firstCalls.push(request.url);
    throw new Error("connection reset after commit");
  } }), FabricConnectorRegistrationPendingError);
  assert.deepEqual(firstCalls, ["https://hub.example.test/fabric/v1/enroll"]);
  const pendingPath = join(path, ".pi", "fabric-connector.pending.json");
  const pending = await readFile(pendingPath, "utf8");
  assert.equal(pending.includes(TOKEN), false);
  const journal = JSON.parse(pending) as { requestId: string; requestDigest: string; body: Record<string, unknown> };
  const retryCalls: string[] = [];
  const config = await fabricConnectorEnroll({ ...enrollOptions(path), http: async (request) => {
    retryCalls.push(request.url);
    assert.deepEqual(request.body, { version: 1, requestId: journal.requestId, requestDigest: journal.requestDigest });
    return { ...receiptFor({ ...request, body: journal.body }, "enroll", 1, 1), requestDigest: journal.requestDigest };
  } });
  assert.deepEqual(retryCalls, ["https://hub.example.test/fabric/v1/registration-receipt"]);
  assert.equal(config.credentialGeneration, 1);
});

test("rotation keeps old config active on uncertainty and switches only after receipt recovery", async (t) => {
  const path = await root(t);
  await fabricConnectorEnroll({ ...enrollOptions(path), http: (request) => Promise.resolve(receiptFor(request, "enroll", 1, 1)) });
  const before = await readFile(fabricConnectorConfigPath(path), "utf8");
  await assert.rejects(() => fabricConnectorRotate({
    root: path, token: TOKEN, expectedRevision: 1, expectedCredentialGeneration: 1, requestId: () => "request-rotate",
    platform: "win32", windowsAclRunner: async () => undefined,
    http: () => Promise.reject(new Error("lost response")),
  }), FabricConnectorRegistrationPendingError);
  assert.equal(await readFile(fabricConnectorConfigPath(path), "utf8"), before);
  const pendingRaw = await readFile(join(path, ".pi", "fabric-connector.pending.json"), "utf8");
  assert.equal(pendingRaw.includes(TOKEN), false);
  const pending = JSON.parse(pendingRaw) as { requestId: string; requestDigest: string; body: Record<string, unknown> };
  const urls: string[] = [];
  const rotated = await fabricConnectorRotate({
    root: path, token: TOKEN, expectedRevision: 1, expectedCredentialGeneration: 1,
    platform: "win32", windowsAclRunner: async () => undefined,
    http: async (request) => {
      urls.push(request.url);
      return { ...receiptFor({ ...request, body: pending.body }, "rotate", 2, 2), requestDigest: pending.requestDigest };
    },
  });
  assert.deepEqual(urls, ["https://hub.example.test/fabric/v1/registration-receipt"]);
  assert.equal(rotated.credentialGeneration, 2);
  assert.notEqual(await readFile(fabricConnectorConfigPath(path), "utf8"), before);
});

test("a crash before config rename preserves pending recovery without publishing config", async (t) => {
  const path = await root(t);
  let receipt: ReturnType<typeof receiptFor> | undefined;
  await assert.rejects(() => fabricConnectorEnroll({
    ...enrollOptions(path),
    http: async (request) => { receipt = receiptFor(request, "enroll", 1, 1); return receipt; },
    fault: async (point) => { if (point === "before-config-rename") throw new Error("simulated pre-rename crash"); },
  }), /simulated pre-rename crash/);
  await assert.rejects(() => readFile(fabricConnectorConfigPath(path)), /ENOENT/);
  assert.notEqual(receipt, undefined);
  const pending = JSON.parse(await readFile(join(path, ".pi", "fabric-connector.pending.json"), "utf8")) as { requestDigest: string };
  const recovered = await fabricConnectorEnroll({
    ...enrollOptions(path),
    http: async (request) => ({ ...receipt!, requestId: String(request.body.requestId), requestDigest: pending.requestDigest }),
  });
  assert.equal(recovered.revision, 1);
});

test("a crash after config rename is recovered idempotently from the pending journal", async (t) => {
  const path = await root(t);
  let receipt: ReturnType<typeof receiptFor> | undefined;
  await assert.rejects(() => fabricConnectorEnroll({
    ...enrollOptions(path),
    http: async (request) => { receipt = receiptFor(request, "enroll", 1, 1); return receipt; },
    fault: async (point) => { if (point === "after-config-rename") throw new Error("simulated crash"); },
  }), /simulated crash/);
  assert.equal((await loadFabricConnectorConfig(fabricConnectorConfigPath(path)))?.credentialGeneration, 1);
  assert.notEqual(receipt, undefined);
  const recovered = await fabricConnectorEnroll({
    ...enrollOptions(path),
    http: async (request) => ({ ...receipt!, requestId: String(request.body.requestId), requestDigest: String(request.body.requestDigest) }),
  });
  assert.equal(recovered.revision, 1);
  await assert.rejects(() => readFile(join(path, ".pi", "fabric-connector.pending.json")), /ENOENT/);
});

test("Windows ACL runner receives private paths only through env and failures fail closed", async (t) => {
  const path = await root(t);
  const requests: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const config = await fabricConnectorEnroll({
    ...enrollOptions(path), platform: "win32",
    windowsAclRunner: async (request) => { requests.push({ args: request.args, env: request.env }); },
    http: (request) => Promise.resolve(receiptFor(request, "enroll", 1, 1)),
  });
  assert.equal(requests.length > 3, true);
  for (const request of requests) {
    assert.equal(request.args.some((arg) => arg.includes(path) || arg.includes(TOKEN)), false);
    assert.equal(typeof request.env.PI_MAESTRO_PRIVATE_PATH, "string");
  }
  assert.equal(config.connectorId, "connector-1");

  const failed = await root(t);
  await assert.rejects(() => fabricConnectorEnroll({
    ...enrollOptions(failed), platform: "win32", windowsAclRunner: async () => { throw new Error("ACL verification failed"); },
    http: (request) => Promise.resolve(receiptFor(request, "enroll", 1, 1)),
  }), /ACL verification failed/);
  await assert.rejects(() => readFile(fabricConnectorConfigPath(failed)), /ENOENT/);
});

test("connector enroll rejects oversized and non-strict inventory files before network access", async (t) => {
  const path = await root(t);
  const inventoryPath = join(path, "inventory.json");
  const invoke = async (): Promise<{ code: number; stderr: string }> => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let errorText = "";
    stderr.on("data", (chunk: Buffer) => { errorText += chunk.toString("utf8"); });
    stdin.end(`${TOKEN}\n`);
    const code = await gatewayCliMain([
      "connector", "enroll", "--hub", "https://hub.example.test", "--connector-id", "connector-1",
      "--inventory-file", inventoryPath, "--local-device-id", "device-1", "--token-stdin", "--json",
    ], {
      stdin, stdout, stderr, connectorRoot: path, connectorPlatform: "win32",
      connectorWindowsAclRunner: async () => undefined,
      fabricRegistrationHttp: () => { throw new Error("network must not be reached"); },
    });
    return { code, stderr: errorText };
  };

  await writeFile(inventoryPath, `[{"deviceId":"device-1","label":"${"x".repeat(65_536)}","connectionMode":"https","enabled":true}]`);
  const oversized = await invoke();
  assert.equal(oversized.code, 1);
  assert.match(oversized.stderr, /exceeds 64 KiB/);

  await writeFile(inventoryPath, JSON.stringify([{
    deviceId: "device-1", label: "Device", connectionMode: "https", enabled: true, unexpected: true,
  }]));
  const nonStrict = await invoke();
  assert.equal(nonStrict.code, 1);
  assert.match(nonStrict.stderr, /unsupported field/);
});

test("pending recovery rejects oversized or internally inconsistent journals", async (t) => {
  const inconsistentRoot = await root(t);
  await assert.rejects(() => fabricConnectorEnroll({
    ...enrollOptions(inconsistentRoot),
    http: () => Promise.reject(new Error("lost response")),
  }), FabricConnectorRegistrationPendingError);
  const inconsistentPath = join(inconsistentRoot, ".pi", "fabric-connector.pending.json");
  const inconsistent = JSON.parse(await readFile(inconsistentPath, "utf8")) as {
    devices: Array<{ label: string }>;
  };
  inconsistent.devices[0]!.label = "Tampered Device";
  await writeFile(inconsistentPath, `${JSON.stringify(inconsistent)}\n`);
  await assert.rejects(() => fabricConnectorEnroll({
    ...enrollOptions(inconsistentRoot),
    http: () => { throw new Error("network must not be reached"); },
  }), /Malformed Fabric Connector pending journal/);

  const oversizedRoot = await root(t);
  await assert.rejects(() => fabricConnectorEnroll({
    ...enrollOptions(oversizedRoot),
    http: () => Promise.reject(new Error("lost response")),
  }), FabricConnectorRegistrationPendingError);
  const oversizedPath = join(oversizedRoot, ".pi", "fabric-connector.pending.json");
  await writeFile(oversizedPath, "x".repeat(65_537));
  await assert.rejects(() => fabricConnectorEnroll({
    ...enrollOptions(oversizedRoot),
    http: () => { throw new Error("network must not be reached"); },
  }), /exceeds 64 KiB/);
});
