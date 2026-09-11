import assert from "node:assert/strict";
import test from "node:test";
import {
  FabricContractError,
  FABRIC_PROTOCOL_VERSION,
  assertFabricIdentifier,
  assertInvocationReceiptTransition,
  assertUsableEndpointRoute,
  assertValidCapabilityBinding,
  assertValidDeviceRecord,
  assertValidEndpointRecord,
  assertValidFabricEnvelope,
  assertValidFabricProtocolLimits,
  assertValidMcpInvocationRequest,
  utf8ByteLength,
  type CapabilityBinding,
  type EndpointRouteHandle,
  type FabricEnvelopeV1,
  type InvocationReceipt,
  type McpInvocationRequest,
  type McpServiceEndpoint,
} from "../src/public/v1/index.ts";

const now = 10_000;
const route: EndpointRouteHandle = {
  routeId: "route-a",
  connectionId: "connection-a",
  endpointId: "endpoint-a",
  connectionGeneration: 2,
  endpointGeneration: 4,
  issuedAt: 9_000,
  expiresAt: 20_000,
  state: "open",
  revision: 0,
};

const mcpEndpoint: McpServiceEndpoint = {
  kind: "mcp",
  endpointId: route.endpointId,
  deviceId: "device-a",
  connectorId: "connector-a",
  scope: { kind: "device" },
  generation: route.endpointGeneration,
  contractHash: "sha256:mcp",
  status: "online",
  revision: 0,
  serverName: "files",
  protocolVersion: "2025-11-25",
  transport: "streamable-http",
  durableDeduplication: false,
};

const routeContext = {
  connectionId: route.connectionId,
  connectionGeneration: route.connectionGeneration,
  endpointId: route.endpointId,
  endpointGeneration: route.endpointGeneration,
  now,
};

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof FabricContractError && error.code === code);
}

test("identifiers use a bounded transport-safe alphabet without coercion", () => {
  assert.doesNotThrow(() => assertFabricIdentifier("device:office-1", "deviceId"));
  expectCode(() => assertFabricIdentifier(" device", "deviceId"), "invalid_argument");
  expectCode(() => assertFabricIdentifier("a".repeat(129), "deviceId"), "invalid_argument");
  expectCode(() => assertFabricIdentifier(undefined, "deviceId"), "invalid_argument");
  expectCode(() => assertFabricIdentifier(123, "deviceId"), "invalid_argument");
});

test("UTF-8 byte bounds count non-ASCII code points", () => {
  assert.equal(utf8ByteLength("abc"), 3);
  assert.equal(utf8ByteLength("设备"), 6);
  assert.equal(utf8ByteLength("🧭"), 4);
});

test("route validation rejects stale endpoint generation", () => {
  expectCode(
    () => assertUsableEndpointRoute(route, {
      connectionId: route.connectionId,
      connectionGeneration: route.connectionGeneration,
      endpointId: route.endpointId,
      endpointGeneration: 5,
      now,
    }),
    "stale_generation",
  );
});

test("durable-dedup replay requires endpoint proof", () => {
  const request: McpInvocationRequest = {
    kind: "mcp-call",
    operationId: "operation-a",
    route,
    toolName: "files.write",
    arguments: { path: "relative.txt" },
    deadlineAt: 15_000,
    replayClass: "durable-dedup",
  };
  expectCode(() => assertValidMcpInvocationRequest(request, mcpEndpoint, routeContext), "permission_denied");
  assert.doesNotThrow(() => assertValidMcpInvocationRequest(
    request,
    { ...mcpEndpoint, durableDeduplication: true },
    routeContext,
  ));
});

test("invocation deadline is checked independently from route expiry", () => {
  const request: McpInvocationRequest = {
    kind: "mcp-call",
    operationId: "operation-b",
    route,
    toolName: "files.read",
    arguments: {},
    deadlineAt: now,
    replayClass: "readonly",
  };
  expectCode(() => assertValidMcpInvocationRequest(request, mcpEndpoint, routeContext), "deadline_exceeded");
});

test("MCP invocation requires an open route", () => {
  const request: McpInvocationRequest = {
    kind: "mcp-call",
    operationId: "operation-c",
    route: { ...route, state: "draining" },
    toolName: "files.read",
    arguments: {},
    deadlineAt: 15_000,
    replayClass: "readonly",
  };
  expectCode(() => assertValidMcpInvocationRequest(request, mcpEndpoint, routeContext), "invalid_state");
});

test("capability validation covers kind, endpoint and priority", () => {
  const capability: CapabilityBinding = {
    capabilityId: "capability-a",
    kind: "tool",
    endpointId: "endpoint-a",
    contractHash: "sha256:tool",
    trustLevel: "paired",
    priority: 0,
  };
  assert.doesNotThrow(() => assertValidCapabilityBinding(capability));
  expectCode(() => assertValidCapabilityBinding({ ...capability, priority: -1 }), "invalid_argument");
});

test("runtime record guards reject null, missing fields and wrong scalar types", () => {
  expectCode(() => assertValidDeviceRecord(null), "invalid_argument");
  expectCode(() => assertValidDeviceRecord({ connectorId: "connector-a", enabled: true, revision: 0 }), "invalid_argument");
  expectCode(() => assertValidDeviceRecord({
    deviceId: "device-a",
    connectorId: "connector-a",
    label: "Device A",
    connectionMode: "direct",
    enabled: "yes",
    revision: 0,
  }), "invalid_argument");
  expectCode(() => assertValidFabricProtocolLimits({}), "invalid_argument");
});

test("agent model advertisements accept existing registration IDs", () => {
  assert.doesNotThrow(() => assertValidEndpointRecord({
    kind: "agent",
    endpointId: "endpoint-agent",
    deviceId: "device-a",
    connectorId: "connector-a",
    scope: { kind: "device" },
    generation: 1,
    contractHash: "sha256:agent",
    status: "online",
    revision: 0,
    roles: ["general"],
    taskTypes: ["development"],
    models: ["openai-codex/gpt-5.4", "cli/gemini"],
    maxConcurrency: 1,
  }));
});

test("workspace-scoped execution requires binding fields on its route", () => {
  const workspaceEndpoint = {
    ...mcpEndpoint,
    scope: { kind: "workspace" as const, workspaceId: "workspace-a" },
  };
  const request: McpInvocationRequest = {
    kind: "mcp-call",
    operationId: "operation-workspace",
    route,
    toolName: "files.read",
    arguments: {},
    deadlineAt: 15_000,
    replayClass: "readonly",
  };
  expectCode(() => assertValidMcpInvocationRequest(request, workspaceEndpoint, routeContext), "permission_denied");
});

test("protocol generation cannot appear without connection identity", () => {
  const envelope: FabricEnvelopeV1 = {
    version: FABRIC_PROTOCOL_VERSION,
    messageId: "message-a",
    kind: "heartbeat",
    sentAt: now,
    connectionGeneration: 2,
    payload: {},
  };
  expectCode(() => assertValidFabricEnvelope(envelope), "invalid_argument");
  expectCode(() => assertValidFabricEnvelope({ ...envelope, connectionGeneration: undefined, payload: [] }), "invalid_argument");
});

test("JSON guards reject objects with non-JSON serialization semantics", () => {
  const envelope = {
    version: FABRIC_PROTOCOL_VERSION,
    messageId: "message-json",
    kind: "heartbeat",
    sentAt: now,
  };
  const expectPayloadRejected = (value: unknown): void => {
    expectCode(() => assertValidFabricEnvelope({ ...envelope, payload: { value } }), "invalid_argument");
  };

  expectCode(() => assertValidFabricEnvelope({ ...envelope, payload: new Date(0) }), "invalid_argument");
  expectCode(() => assertValidFabricEnvelope({ ...envelope, payload: Object(1n) }), "invalid_argument");

  const customToJson: unknown[] & { toJSON?: () => bigint } = [];
  customToJson.toJSON = () => 1n;
  expectPayloadRejected(customToJson);

  const accessorArray = ["safe"];
  Object.defineProperty(accessorArray, "0", { enumerable: true, get: () => "computed" });
  expectPayloadRejected(accessorArray);

  const inheritedArray = new Array<unknown>(1);
  Object.setPrototypeOf(inheritedArray, { 0: "inherited" });
  expectPayloadRejected(inheritedArray);
  expectPayloadRejected(new Array<unknown>(1));

  const request = {
    kind: "mcp-call",
    operationId: "operation-json",
    route,
    toolName: "files.read",
    arguments: new Date(0),
    deadlineAt: 15_000,
    replayClass: "readonly",
  };
  expectCode(() => assertValidMcpInvocationRequest(request, mcpEndpoint, routeContext), "invalid_argument");

  assert.doesNotThrow(() => assertValidFabricEnvelope({ ...envelope, payload: { value: [1, "two", null] } }));
  const nullPrototypePayload = Object.assign(Object.create(null) as Record<string, unknown>, { value: [true] });
  assert.doesNotThrow(() => assertValidFabricEnvelope({ ...envelope, payload: nullPrototypePayload }));
});

test("receipt transitions preserve authority identity and terminal monotonicity", () => {
  const accepted: InvocationReceipt = {
    operationId: "operation-a",
    routeId: route.routeId,
    endpointId: route.endpointId,
    connectionGeneration: route.connectionGeneration,
    endpointGeneration: route.endpointGeneration,
    state: "accepted",
    replayClass: "non-replayable",
    revision: 0,
    updatedAt: now,
  };
  const running = { ...accepted, state: "running" as const, revision: 1, updatedAt: now + 1 };
  const succeeded = { ...running, state: "succeeded" as const, revision: 2, updatedAt: now + 2 };
  assert.doesNotThrow(() => assertInvocationReceiptTransition(accepted, running));
  assert.doesNotThrow(() => assertInvocationReceiptTransition(running, succeeded));
  expectCode(
    () => assertInvocationReceiptTransition(succeeded, { ...succeeded, state: "failed", revision: 3 }),
    "invalid_state",
  );
});
