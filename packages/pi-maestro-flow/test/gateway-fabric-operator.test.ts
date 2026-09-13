import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createServer } from "node:net";
import test from "node:test";
import { FabricStoreCoordinator } from "pi-maestro-fabric";
import { main, writePrivateToken } from "../src/gateway/cli.ts";
import { GatewayDaemon } from "../src/gateway/daemon.ts";
import type { GatewayControlClient } from "../src/gateway/control-client.ts";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import { GatewayFabricStore } from "../src/gateway/fabric/store.ts";
import { FABRIC_ENROLL_SCOPE, FABRIC_PAIRING_PROVIDER } from "../src/gateway/fabric/registration.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";

const certificatePath = join(import.meta.dirname, "fixtures", "fabric-test-cert.pem");
const keyPath = join(import.meta.dirname, "fixtures", "fabric-test-key.pem");

async function seedStore(path: string, subjectId: string): Promise<void> {
  const coordinator = new FabricStoreCoordinator(new GatewayFabricStore({ path }));
  await coordinator.commit("registry", Date.now(), () => ({
    mutations: [{ kind: "upsert", subjectId, value: { revision: 1, label: subjectId }, eventKind: "test.seeded", payload: {} }],
    value: undefined,
  }));
}

function capture() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = "";
  let errors = "";
  stdout.on("data", (chunk) => { output += chunk.toString(); });
  stderr.on("data", (chunk) => { errors += chunk.toString(); });
  return { stdout, stderr, output: () => output, errors: () => errors };
}

function publicKey(): string {
  return generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test listener did not allocate a TCP port");
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return address.port;
}

test("enrollmentPath selects one complete store and rejects ambiguity, divergence, and unknown formats", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-fabric-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = createTestGatewayConfig(root);
  config.fabric = { enabled: true, enrollmentPath: join(root, "override.json") };
  const defaultPath = join(root, "state", "fabric", "state.json");

  const injected = new GatewayFabricStore({ path: join(root, "injected.json") });
  await assert.rejects(() => GatewayRuntime.create({ config, cwd: root, fabricStore: injected }), /cannot be combined with an injected Fabric store/);

  await seedStore(defaultPath, "legacy-default");
  await assert.rejects(() => GatewayRuntime.create({ config, cwd: root }), /move or copy the complete document offline/);

  await seedStore(config.fabric.enrollmentPath!, "different-override");
  await assert.rejects(() => GatewayRuntime.create({ config, cwd: root }), /divergent non-empty state/);

  await copyFile(defaultPath, config.fabric.enrollmentPath!);
  const runtime = await GatewayRuntime.create({ config, cwd: root });
  assert.equal(runtime.fabricStore.path, config.fabric.enrollmentPath);
  await runtime.close();

  const unknownPath = join(root, "unknown.json");
  const unknown = '{"version":99,"private":"preserve-me"}\n';
  await writeFile(unknownPath, unknown);
  const unknownConfig = createTestGatewayConfig(join(root, "unknown-state"));
  unknownConfig.fabric = { enabled: true, enrollmentPath: unknownPath };
  await assert.rejects(() => GatewayRuntime.create({ config: unknownConfig, cwd: root }), /Unsupported Gateway Fabric store version/);
  assert.equal(await readFile(unknownPath, "utf8"), unknown);
});

test("post-commit projection failure blocks admission until rebuilt from durable authority", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-fabric-projection-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = createTestGatewayConfig(root);
  config.fabric = { enabled: true, audience: "hub.example.test" };
  const runtime = await GatewayRuntime.create({ config, cwd: root });
  t.after(() => runtime.close());
  const issued = await runtime.pairingStore.issue({
    audience: "fabric", provider: FABRIC_PAIRING_PROVIDER, instance: "connector-1",
    scopes: [FABRIC_ENROLL_SCOPE], generation: 1, ttlMs: 600_000,
  });
  const directory = runtime.fabricControlRuntime!.directory;
  const seedAuthority = directory.seedAuthority.bind(directory);
  directory.seedAuthority = () => { throw new Error("injected projection failure"); };

  await assert.rejects(() => runtime.fabricPairingAdapter!.enrollFromPairing({
    token: issued.token, requestId: "projection-enroll-1", connectorId: "connector-1",
    keyId: "key-1", publicKey: publicKey(),
  }), /injected projection failure/);
  assert.equal((await runtime.fabricRegistration!.list()).length, 1, "durable registration did not commit");
  assert.equal(runtime.fabricAdmissionReady, false);
  assert.equal(runtime.fabricRegistration!.credentialOf("connector-1"), undefined, "stale credential cache remained usable");

  directory.seedAuthority = seedAuthority;
  await runtime.reconcileFabricRegistration();
  assert.equal(runtime.fabricAdmissionReady, true);
  assert.equal(runtime.fabricRegistration!.credentialOf("connector-1")?.credentialGeneration, 1);
  assert.deepEqual(directory.listAcceptedExecutionViews(), []);
});

test("a post-commit continuation cannot reopen admission after a later lifecycle fence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-fabric-post-commit-fence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = createTestGatewayConfig(root);
  config.fabric = { enabled: true, audience: "hub.example.test" };
  const runtime = await GatewayRuntime.create({ config, cwd: root });
  t.after(() => runtime.close());
  const issued = await runtime.pairingStore.issue({
    audience: "fabric", provider: FABRIC_PAIRING_PROVIDER, instance: "connector-fenced",
    scopes: [FABRIC_ENROLL_SCOPE], generation: 1, ttlMs: 600_000,
  });
  let entered!: () => void;
  let release!: () => void;
  const cleanupEntered = new Promise<void>((resolve) => { entered = resolve; });
  const cleanupGate = new Promise<void>((resolve) => { release = resolve; });
  runtime.setFabricPostCommitFence(async () => {
    entered();
    await cleanupGate;
    return { cleanupComplete: true };
  });
  const enrolling = runtime.fabricPairingAdapter!.enrollFromPairing({
    token: issued.token,
    requestId: "post-commit-fence-enroll",
    connectorId: "connector-fenced",
    keyId: "key-fenced",
    publicKey: publicKey(),
  });
  await cleanupEntered;
  runtime.fenceFabricAdmission();
  release();
  await enrolling;
  assert.equal(runtime.fabricAdmissionReady, false);
});

test("private token output applies verified Windows ACLs without path or token argv", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-private-token-acl-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tokenPath = join(root, "secret", "purpose.token");
  const requests: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  await writePrivateToken(tokenPath, "never-in-argv", {
    platform: "win32",
    windowsAclRunner: async (request) => { requests.push({ args: request.args, env: request.env }); },
  });
  assert.equal(await readFile(tokenPath, "utf8"), "never-in-argv\n");
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.args.some((arg) => arg.includes(tokenPath) || arg.includes("never-in-argv")), false);
    assert.equal(typeof request.env.PI_MAESTRO_PRIVATE_PATH, "string");
  }

  const rejectedPath = join(root, "rejected", "purpose.token");
  await assert.rejects(() => writePrivateToken(rejectedPath, "private-token", {
    platform: "win32",
    windowsAclRunner: async (request) => {
      if (request.env.PI_MAESTRO_PRIVATE_KIND === "file") throw new Error("ACL verification failed");
    },
  }), /ACL verification failed/);
  await assert.rejects(() => readFile(rejectedPath), /ENOENT/);
});

test("operator purpose tokens use fixed grants, private file delivery, and Connector revoke", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-fabric-operator-"));
  const config = createTestGatewayConfig(root, { mode: "open" });
  config.fabric = { enabled: true, audience: "hub.example.test" };
  const port = await availablePort();
  config.transport.http = {
    enabled: true,
    host: "localhost",
    port,
    path: "/mcp",
    tls: { enabled: true, certFile: certificatePath, keyFile: keyPath },
  };
  const daemon = new GatewayDaemon({ config, cwd: root, httpHost: "localhost", httpPort: port });
  await daemon.start();
  t.after(async () => { await daemon.stop(); await rm(root, { recursive: true, force: true }); });

  const generic = await daemon.runtime!.pairingStore.issue({ ttlMs: 60_000 });
  assert.deepEqual(await daemon.controlDispatcher!.dispatch("pair-revoke", { id: generic.id }), { revoked: true });
  assert.equal((await daemon.runtime!.pairingStore.list({ includeInactive: true })).find((entry) => entry.id === generic.id)?.revokedBy, undefined);

  await assert.rejects(
    () => daemon.controlDispatcher!.dispatch("pair", { purpose: "fabric-enrollment", connectorId: "connector-1", ttlMs: 600_001 }),
    /cannot exceed|ttlMs/u,
  );
  await assert.rejects(
    () => daemon.controlDispatcher!.dispatch("pair", { purpose: "fabric-enrollment", connectorId: "connector-1", audience: "gateway" }),
    /do not accept audience overrides/u,
  );
  const rotationPurpose = await daemon.controlDispatcher!.dispatch("pair", {
    purpose: "fabric-rotation", connectorId: "connector-1", generation: 3,
  }) as { token: string; audience: string; provider: string; instance: string; scopes: string[]; generation: number; expiresAt: number; createdAt: number };
  assert.deepEqual(
    { audience: rotationPurpose.audience, provider: rotationPurpose.provider, instance: rotationPurpose.instance, scopes: rotationPurpose.scopes, generation: rotationPurpose.generation, ttl: rotationPurpose.expiresAt - rotationPurpose.createdAt },
    { audience: "fabric", provider: FABRIC_PAIRING_PROVIDER, instance: "connector-1", scopes: ["fabric.rotate"], generation: 3, ttl: 600_000 },
  );

  const tokenPath = join(root, "private", "enrollment.token");
  const purposeIo = capture();
  const purposeCode = await main([
    "pair", "create", "--purpose", "fabric-enrollment", "--connector-id", "connector-1",
    "--ttl", "600", "--token-out", tokenPath, "--config", join(root, "unused-config.yaml"),
  ], {
    stdout: purposeIo.stdout,
    stderr: purposeIo.stderr,
    createControlClient: () => ({
      issueFabricPurposePairing: (options: { purpose: string; connectorId: string; ttlSeconds: number }) => {
        assert.deepEqual(options, { purpose: "fabric-enrollment", connectorId: "connector-1", ttlSeconds: 600 });
        return Promise.resolve({
          version: 1, id: "pair-purpose", token: "private-purpose-token", createdAt: 1, expiresAt: 601_000,
          scopes: [FABRIC_ENROLL_SCOPE], audience: "fabric", generation: 1,
          provider: FABRIC_PAIRING_PROVIDER, instance: "connector-1",
        });
      },
    }) as unknown as GatewayControlClient,
  });
  assert.equal(purposeCode, 0, purposeIo.errors());
  assert.equal(await readFile(tokenPath, "utf8"), "private-purpose-token\n");
  if (process.platform !== "win32") assert.equal((await stat(tokenPath)).mode & 0o077, 0);
  assert.doesNotMatch(purposeIo.output(), /private-purpose-token/u);
  assert.equal((JSON.parse(purposeIo.output()) as { token?: string; tokenOut?: string }).token, undefined);

  const revokeIo = capture();
  const revokeCode = await main([
    "connector", "revoke", "connector-1", "--expected-revision", "7", "--request-id", "cli-revoke-1", "--json",
  ], {
    stdout: revokeIo.stdout,
    stderr: revokeIo.stderr,
    createControlClient: () => ({
      revokeFabricConnector: (options: { connectorId: string; requestId: string; expectedRevision: number }) => {
        assert.deepEqual(options, { connectorId: "connector-1", requestId: "cli-revoke-1", expectedRevision: 7 });
        return Promise.resolve({ status: "revoked", lifecycleStatus: "revoked", durableStatus: "revoked", cleanupStatus: "complete", connectorId: "connector-1" });
      },
    }) as unknown as GatewayControlClient,
  });
  assert.equal(revokeCode, 0, revokeIo.errors());
  assert.deepEqual(JSON.parse(revokeIo.output()), { status: "revoked", lifecycleStatus: "revoked", durableStatus: "revoked", cleanupStatus: "complete", connectorId: "connector-1" });

  const issued = await daemon.controlDispatcher!.dispatch("pair", {
    purpose: "fabric-enrollment", connectorId: "connector-1", ttlMs: 600_000,
  }) as { id: string; token: string; audience: string; provider: string; instance: string; scopes: string[]; generation: number; expiresAt: number; createdAt: number };
  assert.deepEqual(
    { audience: issued.audience, provider: issued.provider, instance: issued.instance, scopes: issued.scopes, generation: issued.generation, ttl: issued.expiresAt - issued.createdAt },
    { audience: "fabric", provider: FABRIC_PAIRING_PROVIDER, instance: "connector-1", scopes: [FABRIC_ENROLL_SCOPE], generation: 1, ttl: 600_000 },
  );
  await daemon.runtime!.fabricPairingAdapter!.enrollFromPairing({
    token: issued.token,
    requestId: "operator-enroll-1",
    connectorId: "connector-1",
    keyId: "key-1",
    publicKey: publicKey(),
  });
  const revoked = await daemon.controlDispatcher!.dispatch("fabric-connector-revoke", {
    connectorId: "connector-1", requestId: "operator-revoke-1", expectedRevision: 1,
  }) as { status: string; lifecycleStatus: string; durableStatus: string; cleanupStatus: string; connectorRevision: number };
  assert.deepEqual({ status: revoked.status, lifecycle: revoked.lifecycleStatus, durable: revoked.durableStatus, cleanup: revoked.cleanupStatus, revision: revoked.connectorRevision }, { status: "revoked", lifecycle: "revoked", durable: "revoked", cleanup: "complete", revision: 2 });
  assert.equal(daemon.runtime!.fabricRegistration!.credentialOf("connector-1")?.revoked, true);
  assert.deepEqual(
    { enabled: daemon.runtime!.fabricControlRuntime!.directory.getConnector("connector-1")?.enabled, revision: daemon.runtime!.fabricControlRuntime!.directory.getConnector("connector-1")?.revision },
    { enabled: false, revision: 2 },
  );
  assert.equal(await daemon.runtime!.pairingStore.authenticate(rotationPurpose.token, { audience: "fabric" }), undefined);
  assert.equal(daemon.runtime!.fabricAdmissionReady, true);
});
