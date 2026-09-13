import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FabricStoreCoordinator } from "pi-maestro-fabric";
import { GatewayDaemon, GatewayDaemonOwnershipError } from "../src/gateway/daemon.ts";
import { GatewayOwnerStore } from "../src/gateway/owner-store.ts";
import { requestGatewayIpcControl } from "../src/gateway/ipc.ts";
import { GatewayPairingStore } from "../src/gateway/pairing-store.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";
import { GatewayFabricStore } from "../src/gateway/fabric/store.ts";
import { GatewayFabricRegistrationAuthority, FABRIC_ENROLL_SCOPE, FABRIC_PAIRING_PROVIDER } from "../src/gateway/fabric/registration.ts";
import { FabricPairingAdapter, FABRIC_PAIRING_AUDIENCE } from "../src/gateway/fabric/pairing-adapter.ts";
import { WorkspaceRegistry } from "../src/gateway/workspace-registry.ts";

const certificatePath = join(import.meta.dirname, "fixtures", "fabric-test-cert.pem");
const tlsKeyPath = join(import.meta.dirname, "fixtures", "fabric-test-key.pem");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not reached");
}

test("daemon ownership loss during startup aborts instead of becoming Connector-invalid", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "connector-owner-loss-"));
  const config = createTestGatewayConfig(root);
  class LosingOwnerStore extends GatewayOwnerStore {
    reads = 0;
    override async read() {
      const current = await super.read();
      this.reads += 1;
      if (this.reads >= 2 && current !== undefined) {
        return { ...current, ownerToken: "replacement-owner-token" };
      }
      return current;
    }
  }
  const store = new LosingOwnerStore({ ownerPath: config.state.ownerPath });
  const daemon = new GatewayDaemon({ config, cwd: root, http: false, ownerStore: store });
  await assert.rejects(() => daemon.start(), (error) => error instanceof GatewayDaemonOwnershipError);
  assert.equal(daemon.ipc, undefined);
  await rm(root, { recursive: true, force: true });
});

test("Fabric startup rejects disabled HTTP before publishing owner IPC", async () => {
  const root = await mkdtemp(join(tmpdir(), "connector-http-disabled-"));
  const config = createTestGatewayConfig(root);
  config.fabric = { enabled: true, audience: "fabric" };
  const daemon = new GatewayDaemon({ config, cwd: root, http: false });
  await assert.rejects(() => daemon.start(), /requires the Gateway HTTPS listener/u);
  assert.equal(daemon.ipc, undefined);
  assert.equal(daemon.owner, undefined);
  await rm(root, { recursive: true, force: true });
});

test("daemon revalidates exact ownership immediately before IPC publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "connector-owner-pre-ipc-"));
  const config = createTestGatewayConfig(root);
  class LateLosingOwnerStore extends GatewayOwnerStore {
    reads = 0;
    override async read() {
      const current = await super.read();
      this.reads += 1;
      if (this.reads >= 3 && current !== undefined) {
        return { ...current, ownerToken: "late-replacement-owner-token" };
      }
      return current;
    }
  }
  const store = new LateLosingOwnerStore({ ownerPath: config.state.ownerPath });
  const daemon = new GatewayDaemon({ config, cwd: root, http: false, ownerStore: store });
  await assert.rejects(() => daemon.start(), (error) => error instanceof GatewayDaemonOwnershipError);
  assert.equal(daemon.ipc, undefined);
  await rm(root, { recursive: true, force: true });
});

test("Fabric owner IPC is exposed only after HTTPS grant authority is configured", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "connector-grant-readiness-"));
  const config = createTestGatewayConfig(root);
  config.fabric = { enabled: true, audience: "fabric" };
  const port = await freePort();
  config.transport.http = {
    enabled: true, host: "localhost", port, path: "/mcp",
    tls: { enabled: true, certFile: certificatePath, keyFile: tlsKeyPath },
  };
  const daemon = new GatewayDaemon({ config, cwd: root, http: true, httpHost: "localhost", httpPort: port });
  await daemon.start();
  t.after(async () => { await daemon.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(() => requestGatewayIpcControl({
    address: daemon.owner!.socket!,
    ownerToken: daemon.owner!.ownerToken,
    action: "fabric-origin-grant-acquire",
    data: { providerGeneration: 0 },
  }), /providerGeneration/u);
});

test("Connector IPC control requires the daemon owner token and successful control is audited", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "connector-ipc-audit-"));
  const config = createTestGatewayConfig(root);
  config.logging.auditFile = join(root, "audit.jsonl");
  const daemon = new GatewayDaemon({ config, cwd: root, http: false });
  await daemon.start();
  t.after(async () => { await daemon.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(() => requestGatewayIpcControl({
    address: daemon.owner!.socket!, ownerToken: "owner-token-that-is-wrong", action: "fabric-connector-status",
  }), /owner token is invalid/u);
  const status = await requestGatewayIpcControl({
    address: daemon.owner!.socket!, ownerToken: daemon.owner!.ownerToken, action: "fabric-connector-status",
  }) as { configured: boolean; running: boolean };
  assert.deepEqual(status, { configured: false, state: "stopped", running: false });
  await daemon.runtime!.audit.flush();
  const audit = await readFile(config.logging.auditFile!, "utf8");
  assert.match(audit, /"tool":"control"/u);
  assert.match(audit, /"action":"fabric-connector-status"/u);
  assert.doesNotMatch(audit, /owner-token/u);
});

test("separate Hub and Device daemons reach ready and Device restart requires a fresh operator-started full snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "connector-daemons-"));
  const hubRoot = join(root, "hub");
  const deviceRoot = join(root, "device");
  await mkdir(join(deviceRoot, ".pi"), { recursive: true });
  const port = await freePort();
  const hubConfig = createTestGatewayConfig(hubRoot);
  hubConfig.fabric = { enabled: true, audience: "fabric", limits: { heartbeatIntervalMs: 100, heartbeatTimeoutMs: 2_000 } };
  hubConfig.transport.http = { enabled: true, host: "localhost", port, path: "/mcp", tls: { enabled: true, certFile: certificatePath, keyFile: tlsKeyPath } };

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const connectorPublicKey = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const connectorPrivateKeyPath = join(deviceRoot, ".pi", "connector-key.pem");
  await writeFile(connectorPrivateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }));

  // Seed the same durable Hub registry the daemon will hydrate. This models a
  // completed T1 enrollment without injecting any WSS advertisement fixture.
  const hubStore = new GatewayFabricStore({ path: join(hubRoot, "state", "fabric", "state.json") });
  const pairings = new GatewayPairingStore({ path: hubConfig.state.pairingPath });
  const authority = new GatewayFabricRegistrationAuthority(new FabricStoreCoordinator(hubStore), { audience: "fabric" });
  const adapter = new FabricPairingAdapter({ pairings, authority });
  const issued = await pairings.issue({
    audience: FABRIC_PAIRING_AUDIENCE,
    scopes: [FABRIC_ENROLL_SCOPE],
    provider: FABRIC_PAIRING_PROVIDER,
    instance: "connector-device",
    generation: 1,
    ttlMs: 60_000,
  });
  await adapter.enrollFromPairing({
    token: issued.token,
    requestId: "enroll-device",
    connectorId: "connector-device",
    keyId: "key-device",
    publicKey: connectorPublicKey,
    devices: [{ deviceId: "device-local", label: "Local Device", connectionMode: "https", enabled: true }],
  });

  const hub = new GatewayDaemon({ config: hubConfig, cwd: hubRoot, http: true, httpHost: "localhost", httpPort: port });
  await hub.start();
  t.after(async () => { await hub.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); });

  const deviceConfig = createTestGatewayConfig(deviceRoot);
  const deviceRegistry = new WorkspaceRegistry({ path: deviceConfig.state.workspaceRegistryPath });
  const localWorkspace = await deviceRegistry.register(join(deviceRoot, "project-private-path"), { mode: "permanent", id: "workspace-local" });
  await writeFile(join(deviceRoot, ".pi", "teammate-backends.json"), JSON.stringify({
    version: 2,
    mode: "model-registry",
    default: "source-local",
    defaultModel: "provider/model",
    backends: { "source-local": { module: "pi-subprocess" } },
    models: {
      "provider/model": {
        modelId: "provider/model",
        deployment: "source-local",
        selector: { kind: "adapter-model", value: "provider/model" },
        deploymentDefault: true,
      },
    },
  }));
  await writeFile(join(deviceRoot, ".pi", "fabric-connector.json"), JSON.stringify({
    version: "fabric.connector-config.v1",
    enabled: true,
    hubUrl: `wss://localhost:${port}/fabric/v1/connector`,
    connectorId: "connector-device",
    keyId: "key-device",
    audience: "fabric",
    credentialGeneration: 1,
    privateKeyPath: connectorPrivateKeyPath,
    caPath: certificatePath,
    heartbeatIntervalMs: 100,
    reconnectDelayMs: 50,
    maxReconnectAttempts: 200,
    devices: [{ deviceId: "device-local", connectorId: "connector-device", label: "Local Device", connectionMode: "https", enabled: true, revision: 1 }],
    localDeviceId: "device-local",
    workspaceIds: [localWorkspace.id],
    agentSources: {
      roles: ["general"], taskTypes: ["development"], models: ["provider/model"],
      backends: ["source-local"], maxConcurrency: 2,
    },
    revision: 1,
  }));

  const device = new GatewayDaemon({ config: deviceConfig, cwd: deviceRoot, http: false });
  await device.start();
  t.after(async () => { await device.stop().catch(() => undefined); });
  const initial = device.fabricConnectorService!.status();
  assert.equal(initial.state, "configured", "daemon startup must not dial implicitly");
  assert.equal(hub.fabricWss!.sessionOf("connector-device"), undefined);
  const started = await requestGatewayIpcControl({
    address: device.owner!.socket!, ownerToken: device.owner!.ownerToken, action: "fabric-connector-start", timeoutMs: 30_000,
  }) as { state: string; connectionGeneration: number; advertisementRevision: number };
  assert.equal(started.state, "ready");
  const fabricWorkspaceId = ((device.fabricConnectorService!.status().advertisementRevision !== undefined)
    ? hub.runtime!.fabricControlRuntime!.directory.list().workspaces[0]!.workspaceId
    : "");
  assert.match(fabricWorkspaceId, /^workspace-/u);
  const advertisedEndpoint = hub.runtime!.fabricControlRuntime!.directory.list().endpoints[0];
  assert.equal(advertisedEndpoint?.kind, "agent");
  if (advertisedEndpoint?.kind !== "agent") throw new Error("Agent Endpoint was not advertised");
  assert.deepEqual(advertisedEndpoint.roles, ["general"]);
  assert.deepEqual(advertisedEndpoint.taskTypes, ["development"]);
  assert.deepEqual(advertisedEndpoint.models, ["provider/model"]);
  assert.equal(advertisedEndpoint.maxConcurrency, 2);
  const advertisedCapability = hub.runtime!.fabricControlRuntime!.directory.list().capabilities[0];
  assert.deepEqual(advertisedCapability?.inputSchema, {
    backend: "source-local",
    capabilities: {
      outputSchema: "native", forkContext: "native", modelSelection: "native", thinkingLevel: "native",
      todoBinding: "native", toolFilter: "native", steer: "native", followUp: "native", abort: "native",
    },
  });
  assert.equal(advertisedCapability?.contractHash, advertisedEndpoint.contractHash);
  const firstConnectionGeneration = started.connectionGeneration;

  await device.stop();
  await waitUntil(() => hub.runtime!.fabricControlRuntime!.directory.getWorkspace(fabricWorkspaceId) === undefined);

  const restarted = new GatewayDaemon({ config: deviceConfig, cwd: deviceRoot, http: false });
  await restarted.start();
  t.after(async () => { await restarted.stop().catch(() => undefined); });
  assert.equal(restarted.fabricConnectorService!.status().state, "configured");
  assert.equal(hub.runtime!.fabricControlRuntime!.directory.getWorkspace(fabricWorkspaceId), undefined);
  const restartedStatus = await requestGatewayIpcControl({
    address: restarted.owner!.socket!, ownerToken: restarted.owner!.ownerToken, action: "fabric-connector-start", timeoutMs: 30_000,
  }) as { state: string; connectionGeneration: number; advertisementRevision: number };
  assert.equal(restartedStatus.state, "ready");
  assert.ok(restartedStatus.connectionGeneration > firstConnectionGeneration);
  assert.ok(hub.runtime!.fabricControlRuntime!.directory.getWorkspace(fabricWorkspaceId));

  // A Hub restart hydrates only offline evidence. The still-requested Device
  // runtime reconnects under a fresh nonce and necessarily publishes the same
  // immutable full snapshot before the workspace becomes executable again.
  const beforeHubRestartGeneration = restarted.fabricConnectorService!.status().connectionGeneration!;
  await hub.stop();
  const restartedHub = new GatewayDaemon({ config: hubConfig, cwd: hubRoot, http: true, httpHost: "localhost", httpPort: port });
  await restartedHub.start();
  t.after(async () => { await restartedHub.stop().catch(() => undefined); });
  assert.equal(restartedHub.runtime!.fabricControlRuntime!.directory.getWorkspace(fabricWorkspaceId), undefined);
  await waitUntil(() => restartedHub.runtime!.fabricControlRuntime!.directory.getWorkspace(fabricWorkspaceId) !== undefined, 10_000);
  await waitUntil(() => restarted.fabricConnectorService!.status().state === "ready", 10_000);
  assert.ok(restarted.fabricConnectorService!.status().connectionGeneration! > beforeHubRestartGeneration);
});
