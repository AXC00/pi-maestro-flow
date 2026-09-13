import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { BackendCapabilities } from "pi-maestro-backend-core/v1/backend";
import { GatewayPolicy } from "../src/gateway/policy.ts";
import { WorkspaceRegistry } from "../src/gateway/workspace-registry.ts";
import type { FabricConnectorConfigV1 } from "../src/gateway/fabric/connector-config.ts";
import {
  FabricConnectorInventory,
  fabricConnectorInventoryManifestPath,
} from "../src/gateway/fabric/connector-inventory.ts";

async function fixture(t: TestContext, allow = true) {
  const root = await mkdtemp(join(tmpdir(), "connector-inventory-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const workspacePath = join(root, "private-project-name");
  const registry = new WorkspaceRegistry({ path: join(root, "registry.json") });
  const workspace = await registry.register(workspacePath, { mode: "permanent", id: "local-workspace-1" });
  const policy = new GatewayPolicy({ workspaceRoot: root, registry, workspaces: [] });
  const config: FabricConnectorConfigV1 = {
    version: "fabric.connector-config.v1",
    enabled: true,
    hubUrl: "wss://hub.example.test/fabric/v1/connector",
    connectorId: "connector-1",
    keyId: "key-1",
    audience: "fabric",
    credentialGeneration: 1,
    privateKeyPath: join(root, "secret-key.pem"),
    devices: [{ deviceId: "device-1", connectorId: "connector-1", label: "Device", connectionMode: "https", enabled: true, revision: 1 }],
    localDeviceId: "device-1",
    workspaceIds: allow ? [workspace.id] : [],
    revision: 1,
  };
  return { root, workspacePath, registry, policy, workspace, config, inventory: new FabricConnectorInventory({ root, registry, policy }) };
}

function payloadOf(value: Awaited<ReturnType<FabricConnectorInventory["prepare"]>>) {
  return value.advertisement.payload as unknown as {
    devices: unknown[];
    workspaces: Array<{ workspaceId: string; localWorkspaceId: string; endpointIds: string[]; generation: number }>;
    endpoints: unknown[];
    capabilities: unknown[];
  };
}

test("inventory uses stable opaque ids, exact Device authority, and a private path-free manifest", async (t) => {
  const value = await fixture(t);
  const first = await value.inventory.prepare(value.config);
  const second = await value.inventory.prepare(value.config);
  const payload = payloadOf(first);
  assert.deepEqual(payload.devices, value.config.devices);
  assert.equal(payload.workspaces.length, 1);
  assert.match(payload.workspaces[0]!.workspaceId, /^workspace-[a-f0-9]{48}$/u);
  assert.match(payload.workspaces[0]!.localWorkspaceId, /^local-[a-f0-9]{48}$/u);
  assert.deepEqual(payload.workspaces[0]!.endpointIds, []);
  assert.deepEqual(payload.endpoints, []);
  assert.deepEqual(payload.capabilities, []);
  assert.equal(second.snapshotDigest, first.snapshotDigest);
  assert.equal(second.manifestRevision, first.manifestRevision);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.advertisement.payload), true);

  const raw = await readFile(fabricConnectorInventoryManifestPath(value.root), "utf8");
  assert.doesNotMatch(raw, /private-project-name|secret-key|ownerToken|principal|canonicalPath|workspacePath/u);
  assert.doesNotMatch(JSON.stringify(first), /private-project-name|secret-key|ownerToken|principal|canonicalPath|workspacePath/u);
});

test("empty allowlist exports no workspace and a policy removal advances the full snapshot", async (t) => {
  const empty = await fixture(t, false);
  assert.deepEqual(payloadOf(await empty.inventory.prepare(empty.config)).workspaces, []);

  const value = await fixture(t);
  const first = await value.inventory.prepare(value.config);
  assert.equal(await value.registry.unregister(value.workspace.id), true);
  const removed = await value.inventory.prepare(value.config);
  assert.deepEqual(payloadOf(removed).workspaces, []);
  assert.notEqual(removed.snapshotDigest, first.snapshotDigest);
  assert.ok(removed.manifestRevision > first.manifestRevision);

  await value.registry.register(value.workspacePath, { mode: "permanent", id: value.workspace.id });
  const restored = await value.inventory.prepare(value.config);
  assert.ok(payloadOf(restored).workspaces[0]!.generation > payloadOf(first).workspaces[0]!.generation);
});

test("timed-out preparation is cancelled and a later generation uses fresh configuration", async (t) => {
  const value = await fixture(t);
  const originalList = value.registry.list.bind(value.registry);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  value.registry.list = async () => {
    await blocked;
    return originalList();
  };
  const inventory = new FabricConnectorInventory({
    root: value.root,
    registry: value.registry,
    policy: value.policy,
    prepareTimeoutMs: 500,
    platform: "win32",
    windowsAclRunner: async () => undefined,
  });
  await assert.rejects(() => inventory.prepare(value.config), /preparation timed out/u);
  value.registry.list = originalList;
  const fresh = inventory.prepare({ ...value.config, workspaceIds: [] });
  release();
  assert.deepEqual(payloadOf(await fresh).workspaces, []);
  await new Promise((resolve) => setImmediate(resolve));
  const manifest = JSON.parse(await readFile(fabricConnectorInventoryManifestPath(value.root), "utf8")) as { workspaces: unknown[] };
  assert.equal(manifest.workspaces.length, 0);
});

test("oversized and non-regular manifests fail closed instead of resetting high-water", async (t) => {
  const value = await fixture(t);
  await value.inventory.prepare(value.config);
  const manifestPath = fabricConnectorInventoryManifestPath(value.root);
  const oversized = "x".repeat(300 * 1024);
  await writeFile(manifestPath, oversized, "utf8");
  await assert.rejects(() => value.inventory.prepare(value.config), /serialized-size limit/u);
  assert.equal((await readFile(manifestPath, "utf8")).length, oversized.length);

  await rm(manifestPath);
  await mkdir(manifestPath);
  const fresh = new FabricConnectorInventory({ root: value.root, registry: value.registry, policy: value.policy });
  await assert.rejects(() => fresh.prepare(value.config), /regular private file/u);
});

test("workspace high-water rejects a 257th entry before writing restart-invalid state", async (t) => {
  const value = await fixture(t);
  await value.inventory.prepare(value.config);
  const manifestPath = fabricConnectorInventoryManifestPath(value.root);
  const digestOf = (index: number): string => index.toString(16).padStart(64, "0");
  const manifest = {
    version: "fabric.connector-inventory-manifest.v1",
    connectorId: "connector-1",
    deviceId: "device-1",
    identityDigest: "a".repeat(64),
    policyDigest: "b".repeat(64),
    snapshotDigest: "c".repeat(64),
    generation: 1,
    revision: 1,
    workspaces: Array.from({ length: 256 }, (_unused, index) => ({
      localIdentityDigest: digestOf(index + 1),
      workspaceId: `workspace-history-${index}`,
      identityDigest: "d".repeat(64),
      policyDigest: "e".repeat(64),
      generation: 1,
      revision: 1,
      active: false,
    })),
  };
  const raw = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestPath, raw, "utf8");
  const fresh = new FabricConnectorInventory({ root: value.root, registry: value.registry, policy: value.policy });
  await assert.rejects(() => fresh.prepare(value.config), /high-water exceeds 256 entries/u);
  assert.equal(await readFile(manifestPath, "utf8"), raw);
});

test("explicit Agent restrictions deterministically intersect proven source availability", async (t) => {
  const value = await fixture(t);
  const capabilities: BackendCapabilities = {
    outputSchema: "native", forkContext: "native", modelSelection: "native", thinkingLevel: "native",
    todoBinding: "native", toolFilter: "native", steer: "native", followUp: "native", abort: "native",
  };
  const inventory = new FabricConnectorInventory({
    root: value.root,
    registry: value.registry,
    policy: value.policy,
    sourceAvailability: {
      roles: ["explorer", "general"],
      taskTypes: ["explore", "development"],
      models: ["provider/other", "provider/model"],
      backends: [
        { name: "other-backend", capabilities },
        { name: "pi-subprocess", capabilities },
      ],
    },
    sourceRestrictions: {
      roles: ["general"], taskTypes: ["development"], models: ["provider/model"],
      backends: ["pi-subprocess"], maxConcurrency: 2,
    },
  });
  const first = await inventory.prepare(value.config);
  const second = await inventory.prepare(value.config);
  const payload = payloadOf(first);
  assert.deepEqual(payload.workspaces[0]?.endpointIds.length, 1);
  assert.deepEqual(payload.endpoints, [{
    endpointId: payload.workspaces[0]?.endpointIds[0],
    deviceId: "device-1",
    connectorId: "connector-1",
    scope: { kind: "workspace", workspaceId: payload.workspaces[0]?.workspaceId },
    generation: 1,
    contractHash: first.source?.digest,
    status: "online",
    revision: 1,
    kind: "agent",
    roles: ["general"],
    taskTypes: ["development"],
    models: ["provider/model"],
    maxConcurrency: 2,
  }]);
  assert.equal(payload.capabilities.length, 1);
  assert.deepEqual((payload.capabilities[0] as { inputSchema: unknown }).inputSchema, {
    backend: "pi-subprocess", capabilities,
  });
  assert.equal(second.snapshotDigest, first.snapshotDigest);
});

test("disabled or foreign local Device and a corrupted manifest fail closed", async (t) => {
  const value = await fixture(t);
  await assert.rejects(() => value.inventory.prepare({
    ...value.config,
    devices: [{ ...value.config.devices![0]!, enabled: false }],
  }), /local Device is not enabled/u);

  await value.inventory.prepare(value.config);
  await writeFile(fabricConnectorInventoryManifestPath(value.root), "{corrupt", "utf8");
  const next = new FabricConnectorInventory({ root: value.root, registry: value.registry, policy: value.policy });
  await assert.rejects(() => next.prepare(value.config), /manifest is not valid JSON/u);
});
