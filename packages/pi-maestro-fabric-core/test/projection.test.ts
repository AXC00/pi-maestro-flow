import assert from "node:assert/strict";
import test from "node:test";
import {
  projectCapability,
  projectConnection,
  projectConnector,
  projectDevice,
  projectEndpoint,
  projectFabricSnapshot,
  projectWorkspace,
  type AgentRuntimeEndpoint,
  type CapabilityBinding,
  type ConnectionLease,
  type ConnectorRecord,
  type WorkspaceRecord,
} from "../src/public/v1/index.ts";

const connector: ConnectorRecord = {
  connectorId: "connector-a",
  label: "Office edge",
  transport: "outbound-wss",
  credentialGeneration: 2,
  instanceNonce: "private-instance",
  enabled: true,
  revision: 1,
};

const connection: ConnectionLease = {
  connectionId: "connection-a",
  connectorId: connector.connectorId,
  deviceId: "device-a",
  connectorInstanceNonce: "private-instance",
  generation: 3,
  state: "connected",
  capabilityDigest: "sha256:capabilities",
  establishedAt: 100,
  expiresAt: 200,
  revision: 0,
};

const workspace: WorkspaceRecord = {
  workspaceId: "workspace-hub-a",
  deviceId: connection.deviceId,
  localWorkspaceId: "local-path-derived-id",
  label: "Project A",
  mode: "lease",
  generation: 4,
  policyDigest: "sha256:policy",
  endpointIds: [],
  revision: 0,
};

test("public projections whitelist fields instead of spreading storage records", () => {
  const projection = projectConnector({ ...connector, credentialHash: "secret" } as ConnectorRecord & { credentialHash: string });
  assert.equal("instanceNonce" in projection, false);
  assert.equal("credentialHash" in projection, false);
  assert.equal(projection.connectorId, connector.connectorId);
});

test("public projections remove connection nonce and local workspace identity", () => {
  assert.equal("connectorInstanceNonce" in projectConnection(connection), false);
  const projection = projectWorkspace({ ...workspace, canonicalPath: "C:/secret" } as WorkspaceRecord & { canonicalPath: string });
  assert.equal("localWorkspaceId" in projection, false);
  assert.equal("canonicalPath" in projection, false);
});

test("device and endpoint projections copy only public fields and nested values", () => {
  const device = {
    deviceId: "device-a",
    connectorId: "connector-a",
    label: "Device A",
    connectionMode: "direct" as const,
    enabled: true,
    revision: 0,
    environment: { token: "secret" },
  };
  const endpoint: AgentRuntimeEndpoint & { command: string } = {
    kind: "agent",
    endpointId: "endpoint-a",
    deviceId: device.deviceId,
    connectorId: device.connectorId,
    scope: { kind: "device" },
    generation: 1,
    contractHash: "sha256:endpoint",
    status: "online",
    revision: 0,
    roles: ["general"],
    taskTypes: ["development"],
    models: ["openai-codex/gpt-5.4"],
    maxConcurrency: 1,
    command: "secret-command",
  };
  assert.equal("environment" in projectDevice(device), false);
  const endpointProjection = projectEndpoint(endpoint);
  assert.equal("command" in endpointProjection, false);
  assert.notEqual(endpointProjection.scope, endpoint.scope);
  assert.notEqual(endpointProjection.kind === "agent" ? endpointProjection.models : [], endpoint.models);
});

test("capability projection allowlists fields and deeply clones validated JSON", () => {
  const input = {
    capabilityId: "capability-a",
    kind: "tool",
    endpointId: "endpoint-a",
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
    contractHash: "contract-a",
    trustLevel: "owner",
    priority: 1,
    secret: "do-not-project",
  } as CapabilityBinding & { secret: string };
  const projection = projectCapability(input);
  assert.equal("secret" in projection, false);
  assert.notEqual(projection.inputSchema, input.inputSchema);
  (projection.inputSchema as { properties: { value: { type: string } } }).properties.value.type = "number";
  assert.equal((input.inputSchema as { properties: { value: { type: string } } }).properties.value.type, "string");
});

test("snapshot projection preserves source records", () => {
  const snapshot = projectFabricSnapshot({
    connectors: [connector],
    devices: [],
    connections: [connection],
    workspaces: [workspace],
    endpoints: [],
  });
  assert.equal(snapshot.connectors.length, 1);
  assert.equal(snapshot.workspaces.length, 1);
  assert.equal(connector.instanceNonce, "private-instance");
  assert.equal(workspace.localWorkspaceId, "local-path-derived-id");
});
