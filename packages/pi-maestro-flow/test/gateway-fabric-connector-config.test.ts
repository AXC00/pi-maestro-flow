import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FABRIC_CONNECTOR_CONFIG_VERSION,
  fabricConnectorConfigPath,
  loadFabricConnectorConfig,
  parseFabricConnectorConfig,
} from "../src/gateway/fabric/connector-config.ts";

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: FABRIC_CONNECTOR_CONFIG_VERSION,
    enabled: true,
    hubUrl: "wss://hub.example.test/fabric/v1/connector",
    connectorId: "connector-1",
    keyId: "key-1",
    audience: "hub.example.test",
    credentialGeneration: 1,
    privateKeyPath: join(tmpdir(), "fabric-connector-key.pem"),
    revision: 0,
    ...overrides,
  };
}

test("a complete Connector document parses with its optional fields", () => {
  const parsed = parseFabricConnectorConfig(document({
    caPath: join(tmpdir(), "ca.pem"), heartbeatIntervalMs: 500,
    devices: [{ deviceId: "device-1", connectorId: "connector-1", label: "Device", connectionMode: "https", enabled: true, revision: 1 }],
    localDeviceId: "device-1", workspaceIds: [],
    agentSources: {
      roles: ["general"], taskTypes: ["development"], models: ["provider/model"],
      backends: ["pi-subprocess"], maxConcurrency: 2,
    },
  }));
  assert.equal(parsed.connectorId, "connector-1");
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.credentialGeneration, 1);
  assert.equal(parsed.caPath, join(tmpdir(), "ca.pem"));
  assert.equal(parsed.heartbeatIntervalMs, 500);
  assert.equal(parsed.reconnectDelayMs, undefined);
  assert.equal(parsed.localDeviceId, "device-1");
  assert.deepEqual(parsed.workspaceIds, []);
  assert.deepEqual(parsed.agentSources, {
    roles: ["general"], taskTypes: ["development"], models: ["provider/model"],
    backends: ["pi-subprocess"], maxConcurrency: 2,
  });
});

test("agentSources is strict, bounded, and complete when present", () => {
  const valid = {
    roles: ["general"], taskTypes: ["development"], models: ["provider/model"],
    backends: ["pi-subprocess"], maxConcurrency: 1,
  };
  assert.throws(() => parseFabricConnectorConfig(document({ agentSources: { ...valid, typo: [] } })), /agentSources\.typo is not supported/u);
  assert.throws(() => parseFabricConnectorConfig(document({ agentSources: { ...valid, roles: undefined } })), /agentSources\.roles must be an array/u);
  assert.throws(() => parseFabricConnectorConfig(document({ agentSources: { ...valid, models: ["bad model"] } })), /whitespace or control/u);
  assert.throws(() => parseFabricConnectorConfig(document({ agentSources: { ...valid, maxConcurrency: 1025 } })), /must be in \[1, 1024\]/u);
  assert.throws(() => parseFabricConnectorConfig(document({ agentSources: { ...valid, backends: ["pi-subprocess", "pi-subprocess"] } })), /must not contain duplicates/u);
});

test("legacy v1 remains parseable but partial identity metadata is rejected", () => {
  const legacy = parseFabricConnectorConfig(document());
  assert.equal(legacy.devices, undefined);
  assert.equal(legacy.agentSources, undefined);
  assert.throws(() => parseFabricConnectorConfig(document({ localDeviceId: "device-1" })), /must be provided together/);
  assert.throws(() => parseFabricConnectorConfig(document({ devices: [], localDeviceId: "device-1", workspaceIds: [] })), /must name a registered Device/);
});

test("an undeclared field is an error rather than a silently dropped setting", () => {
  assert.throws(() => parseFabricConnectorConfig(document({ hubURL: "wss://elsewhere" })), /unsupported field/);
});

test("the document refuses insecure, credentialed, or non-absolute settings", () => {
  assert.throws(() => parseFabricConnectorConfig(document({ hubUrl: "ws://hub.example.test/x" })), /must use wss/);
  assert.throws(
    () => parseFabricConnectorConfig(document({ hubUrl: "wss://user:secret@hub.example.test/x" })),
    /must not embed credentials/,
  );
  assert.throws(() => parseFabricConnectorConfig(document({ privateKeyPath: "keys/connector.pem" })), /must be an absolute path/);
  assert.throws(() => parseFabricConnectorConfig(document({ heartbeatIntervalMs: 0 })), /positive safe integer/);
  assert.throws(() => parseFabricConnectorConfig(document({ credentialGeneration: 0 })), /positive safe integer/);
  assert.throws(() => parseFabricConnectorConfig(document({ version: "fabric.connector-config.v2" })), /Unsupported Fabric Connector config version/);
  assert.throws(() => parseFabricConnectorConfig(document({ enabled: "yes" })), /enabled must be a boolean/);
});

test("a missing configuration file is an unconfigured Connector, not an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "fabric-connector-config-"));
  assert.equal(await loadFabricConnectorConfig(fabricConnectorConfigPath(root)), undefined);
});

test("loading parses a written document and bounds its size", async () => {
  const root = await mkdtemp(join(tmpdir(), "fabric-connector-config-"));
  await mkdir(join(root, ".pi"), { recursive: true });
  const path = fabricConnectorConfigPath(root);
  await writeFile(path, JSON.stringify(document()), "utf8");
  const loaded = await loadFabricConnectorConfig(path);
  assert.equal(loaded?.hubUrl, "wss://hub.example.test/fabric/v1/connector");

  const oversizedRoot = await mkdtemp(join(tmpdir(), "fabric-connector-config-"));
  await mkdir(join(oversizedRoot, ".pi"), { recursive: true });
  const oversized = fabricConnectorConfigPath(oversizedRoot);
  await writeFile(oversized, JSON.stringify(document({ caPath: join(tmpdir(), "x".repeat(70 * 1024)) })), "utf8");
  await assert.rejects(() => loadFabricConnectorConfig(oversized), /exceeds the maximum size/);

  const malformedRoot = await mkdtemp(join(tmpdir(), "fabric-connector-config-"));
  await mkdir(join(malformedRoot, ".pi"), { recursive: true });
  const malformed = fabricConnectorConfigPath(malformedRoot);
  await writeFile(malformed, "{not json", "utf8");
  await assert.rejects(() => loadFabricConnectorConfig(malformed), /not valid JSON/);
});
