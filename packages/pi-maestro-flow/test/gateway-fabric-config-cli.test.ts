import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GatewayConfigValidationError,
  defaultGatewayConfig,
  normalizeGatewayConfig,
  parseGatewayConfigDocument,
} from "../src/gateway/config.ts";
import { GatewayDaemon } from "../src/gateway/daemon.ts";
import {
  fabricConnectorConfigPath,
  fabricConnectorPidPath,
  fabricConnectorStart,
  fabricConnectorStatus,
  fabricConnectorStop,
  type FabricConnectorCliIo,
} from "../src/gateway/fabric/connector-cli.ts";
import { main as gatewayCliMain } from "../src/gateway/cli.ts";

function capture(): { io: FabricConnectorCliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t), root: "", json: false } };
}

test("Fabric is a recognized section that is off unless it is turned on", () => {
  assert.deepEqual(defaultGatewayConfig().fabric, { enabled: false });

  const document = parseGatewayConfigDocument(["fabric:", "  enabled: true", "  audience: hub.example.test", ""].join("\n"));
  // Recognized, so it is not parked among the sections the Gateway does not own.
  assert.deepEqual(Object.keys(document.unknownSections), []);
  assert.equal(document.config.fabric.enabled, true);
  assert.equal(document.config.fabric.audience, "hub.example.test");
});

test("a Fabric setting left behind by a disabled section is refused, not ignored", () => {
  // The operator wrote settings that were meant to take effect. Running on
  // without them would leave the Gateway missing the plane it was configured
  // for, so the document is rejected instead.
  assert.throws(
    () => normalizeGatewayConfig({ fabric: { enabled: false, audience: "hub.example.test" } }),
    (error: GatewayConfigValidationError) => {
      assert.match(error.message, /fabric\.audience is set while fabric\.enabled is false/);
      return true;
    },
  );
  // The section may still say plainly that Fabric is off.
  assert.equal(normalizeGatewayConfig({ fabric: { enabled: false } }).fabric.enabled, false);

  assert.throws(() => normalizeGatewayConfig({ fabric: { enabled: true, connectorPath: "/tmp/x" } }), /fabric\.connectorPath is not a recognized field/);
  assert.throws(() => normalizeGatewayConfig({ fabric: { enabled: true, limits: { maxFrameBytes: 10 } } }), /fabric\.limits\.maxFrameBytes/);
  assert.throws(
    () => normalizeGatewayConfig({ fabric: { enabled: true, limits: { heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 30_000 } } }),
    /fabric\.limits\.heartbeatTimeoutMs must exceed heartbeatIntervalMs/,
  );
  // A timeout shorter than the interval would expire a lease between beats.
  const accepted = normalizeGatewayConfig({ fabric: { enabled: true, limits: { heartbeat_interval_ms: 5_000, heartbeat_timeout_ms: 20_000 } } });
  assert.equal(accepted.fabric.limits?.heartbeatIntervalMs, 5_000);
  assert.equal(accepted.fabric.limits?.heartbeatTimeoutMs, 20_000);
});

test("enabling Fabric without the Gateway HTTPS listener is refused by name", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-fabric-daemon-"));
  const configPath = join(root, "config.yaml");
  const unix = (value: string) => value.replace(/\\/g, "/");
  await writeFile(configPath, [
    "transport:",
    "  http:",
    "    enabled: false",
    "fabric:",
    "  enabled: true",
    "state:",
    `  root_dir: "${unix(join(root, "state"))}"`,
    `  owner_path: "${unix(join(root, "owner.json"))}"`,
    `  workspace_registry_path: "${unix(join(root, "workspaces.json"))}"`,
    "logging:",
    "  level: silent",
    "",
  ].join("\n"));
  const daemon = new GatewayDaemon({ configPath, cwd: root, http: false });
  t.after(async () => { await daemon.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  // A Connector channel over plaintext would authenticate a key over a link
  // anyone can rewrite, so the daemon refuses to mount at all.
  await assert.rejects(() => daemon.start(), /Fabric requires the Gateway HTTPS listener/);
  await daemon.stop();
});

async function connectorWorkspace(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gateway-fabric-connector-cli-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, ".pi"), { recursive: true });
  return root;
}

async function writeConnectorConfig(root: string, overrides: Record<string, unknown> = {}): Promise<{ privateKeyPath: string }> {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = join(root, ".pi", "connector-key.pem");
  await writeFile(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }));
  await writeFile(fabricConnectorConfigPath(root), JSON.stringify({
    version: "fabric.connector-config.v1",
    enabled: true,
    hubUrl: "wss://hub.example.test/fabric/v1/connector",
    connectorId: "connector-laptop",
    keyId: "key-1",
    audience: "fabric",
    credentialGeneration: 1,
    privateKeyPath,
    devices: [{ deviceId: "device-laptop", connectorId: "connector-laptop", label: "Laptop", connectionMode: "https", enabled: true, revision: 1 }],
    localDeviceId: "device-laptop",
    workspaceIds: [],
    revision: 1,
    ...overrides,
  }));
  return { privateKeyPath };
}

test("connector status reports configuration without dialling the Hub", async (t) => {
  const root = await connectorWorkspace(t);
  const { io, out, err } = capture();
  assert.equal(await fabricConnectorStatus({ ...io, root }), 0);
  assert.equal(err.length, 0);
  assert.match(out.join(""), /not configured/);

  await writeConnectorConfig(root);
  const configured = capture();
  assert.equal(await fabricConnectorStatus({ ...configured.io, root, json: true }), 0);
  assert.deepEqual(JSON.parse(configured.out.join("")), {
    configured: true, enabled: true, running: false,
    hubUrl: "wss://hub.example.test/fabric/v1/connector",
    connectorId: "connector-laptop", keyId: "key-1", audience: "fabric",
    credentialGeneration: 1, keyPresent: true,
  });

  const disabled = capture();
  await writeConnectorConfig(root, { enabled: false });
  assert.equal(await fabricConnectorStatus({ ...disabled.io, root }), 0);
  assert.match(disabled.out.join(""), /configured but disabled/);
});

test("connector start refuses an unconfigured, disabled, or legacy foreground Connector", async (t) => {
  const root = await connectorWorkspace(t);
  const unconfigured = capture();
  assert.equal(await fabricConnectorStart({ ...unconfigured.io, root }), 1);
  assert.match(unconfigured.err.join(""), /not configured/);

  await writeConnectorConfig(root, { enabled: false });
  const disabled = capture();
  assert.equal(await fabricConnectorStart({ ...disabled.io, root }), 1);
  assert.match(disabled.err.join(""), /is disabled/);

  await writeConnectorConfig(root);
  await writeFile(fabricConnectorPidPath(root), String(process.pid));
  const running = capture();
  assert.equal(await fabricConnectorStart({ ...running.io, root }), 1);
  assert.match(running.err.join(""), /legacy foreground Connector PID marker.*not signalled/s);
});

test("legacy v1 status remains readable but start requires enrollment metadata", async (t) => {
  const root = await connectorWorkspace(t);
  await writeConnectorConfig(root, { devices: undefined, localDeviceId: undefined, workspaceIds: undefined });
  const status = capture();
  assert.equal(await fabricConnectorStatus({ ...status.io, root }), 0);
  assert.match(status.out.join(""), /connector-laptop/);
  const start = capture();
  assert.equal(await fabricConnectorStart({ ...start.io, root }), 1);
  assert.match(start.err.join(""), /predates Device enrollment metadata.*connector enroll\/upgrade/);
});

test("connector start forwards only daemon control outcomes", async (t) => {
  const root = await connectorWorkspace(t);
  await writeConnectorConfig(root);
  const attempted = capture();
  assert.equal(await fabricConnectorStart({
    ...attempted.io,
    root,
    control: {
      fabricConnectorStatus: async () => ({ configured: false, state: "stopped", running: false }),
      fabricConnectorStart: async () => { throw new Error("Connector credentials could not be loaded"); },
      fabricConnectorStop: async () => { throw new Error("not used"); },
    },
  }), 1);
  assert.match(attempted.err.join(""), /credentials could not be loaded/);
  assert.doesNotMatch(attempted.err.join(""), /connector-key\.pem/u);
});

test("connector stop never signals or removes a legacy PID marker", async (t) => {
  const root = await connectorWorkspace(t);
  const none = capture();
  assert.equal(await fabricConnectorStop({ ...none.io, root }), 1);
  assert.match(none.err.join(""), /Gateway IPC control action is invalid|Gateway is offline|Gateway daemon is offline|Pi Maestro Gateway is offline/u);

  await writeFile(fabricConnectorPidPath(root), "2147483646");
  const legacy = capture();
  assert.equal(await fabricConnectorStop({ ...legacy.io, root }), 1);
  assert.match(legacy.err.join(""), /legacy foreground Connector PID marker.*not signalled/s);
  assert.equal(await readFile(fabricConnectorPidPath(root), "utf8"), "2147483646");
  const after = capture();
  assert.equal(await fabricConnectorStatus({ ...after.io, root }), 0);
  assert.match(after.out.join(""), /legacy foreground Connector PID marker/u);
});

test("the connector command is reachable from the Gateway CLI", async (t) => {
  const root = await connectorWorkspace(t);
  const out: string[] = [];
  const err: string[] = [];
  const code = await gatewayCliMain(["connector", "status", "--json"], {
    stdout: { write: (chunk: string) => { out.push(String(chunk)); return true; } } as never,
    stderr: { write: (chunk: string) => { err.push(String(chunk)); return true; } } as never,
  });
  assert.equal(code, 0);
  assert.equal(err.length, 0);
  assert.deepEqual(JSON.parse(out.join("")), { configured: false, running: false });

  const usageOut: string[] = [];
  const usageErr: string[] = [];
  const usage = async (argv: string[]): Promise<number> => gatewayCliMain(argv, {
    stdout: { write: (chunk: string) => { usageOut.push(String(chunk)); return true; } } as never,
    stderr: { write: (chunk: string) => { usageErr.push(String(chunk)); return true; } } as never,
  });
  assert.equal(await usage(["connector", "restart"]), 1);
  assert.match(usageErr.join(""), /Usage: pi-maestro-gateway connector start\|stop\|status/);
  usageErr.length = 0;
  assert.equal(await usage(["connector", "status", "--verbose"]), 1);
  assert.match(usageErr.join(""), /connector status does not accept --verbose/);
  usageErr.length = 0;
  assert.equal(await usage(["connector", "enroll", "raw_secret_must_not_echo"]), 1);
  assert.doesNotMatch(usageErr.join(""), /raw_secret_must_not_echo/);
  assert.match(usageErr.join(""), /tokens are never accepted in argv/);
  void root;
});
