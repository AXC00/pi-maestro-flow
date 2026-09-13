import assert from "node:assert/strict";
import test from "node:test";
import {
  FABRIC_HUB_RELAY_VERSION,
  FABRIC_PROTOCOL_VERSION,
  FabricContractError,
  assertValidFabricEnvelope,
  assertValidFabricHubRelayEnvelope,
  assertValidFabricHubRelayPayload,
  assertValidFabricHubRelayVersions,
  type FabricEnvelopeV1,
  type FabricHubRelayInvokeV1,
} from "../src/public/v1/index.ts";

const now = Date.now();
const invoke: FabricHubRelayInvokeV1 = {
  version: FABRIC_HUB_RELAY_VERSION,
  direction: "hub-to-device",
  hubRuntimeEpoch: "epoch-1",
  connectorId: "connector-1",
  deviceId: "device-1",
  connectionId: "connection-1",
  connectionGeneration: 2,
  routeId: "route-1",
  routeRevision: 3,
  workspaceBindingId: "binding-1",
  workspaceGeneration: 4,
  endpointId: "endpoint-1",
  endpointGeneration: 5,
  requestId: "request-1",
  correlationId: "correlation-1",
  operationId: "operation-1",
  streamId: "stream-1",
  sequence: 0,
  deadlineAt: now + 30_000,
  operation: "agent.recover",
  originSubject: "origin-1",
  input: { version: "fabric.agent-attempt.v1", attemptId: "attempt-1", placementId: "placement-1" },
  frame: {
    version: "fabric.stream.v1",
    streamId: "stream-1",
    routeId: "route-1",
    operationId: "operation-1",
    sequence: 0,
    kind: "open",
    sentAt: now,
    payload: {
      operation: "agent.recover",
      input: { version: "fabric.agent-attempt.v1", attemptId: "attempt-1", placementId: "placement-1" },
    },
  },
};

function relayEnvelope(kind: FabricEnvelopeV1["kind"], payload: object): FabricEnvelopeV1 {
  const wirePayload: FabricEnvelopeV1["payload"] = JSON.parse(JSON.stringify(payload));
  return {
    version: FABRIC_PROTOCOL_VERSION,
    messageId: `message-${kind}`,
    kind,
    sentAt: now,
    connectionId: String(wirePayload.connectionId),
    connectionGeneration: Number(wirePayload.connectionGeneration),
    correlationId: String(wirePayload.correlationId),
    operationId: String(wirePayload.operationId),
    deadlineAt: Number(wirePayload.deadlineAt),
    payload: wirePayload,
  };
}

function code(error: unknown, expected: string): boolean {
  return error instanceof FabricContractError && error.code === expected;
}

test("legacy envelopes and hellos remain valid without relay negotiation", () => {
  const hello: FabricEnvelopeV1 = {
    version: FABRIC_PROTOCOL_VERSION,
    messageId: "legacy-hello",
    kind: "client_hello",
    sentAt: now,
    payload: { supportedVersions: [FABRIC_PROTOCOL_VERSION] },
  };
  assert.doesNotThrow(() => assertValidFabricEnvelope(hello));
  assert.doesNotThrow(() => assertValidFabricHubRelayVersions([]));
  assert.doesNotThrow(() => assertValidFabricHubRelayVersions([FABRIC_HUB_RELAY_VERSION]));
});

test("strict invoke accepts only existing agent operations and exact authority", () => {
  const envelope = relayEnvelope("invoke", invoke);
  assert.doesNotThrow(() => assertValidFabricHubRelayPayload(invoke, "invoke"));
  assert.doesNotThrow(() => assertValidFabricHubRelayEnvelope(envelope));
  const startInput = {
    version: "fabric.agent-attempt.v1",
    attemptId: "attempt-start-1",
    placement: {
      version: "fabric.placement.v1",
      placementId: "placement-start-1",
      routeId: invoke.routeId,
      workspaceBindingId: invoke.workspaceBindingId,
      endpointId: invoke.endpointId,
      connectionGeneration: invoke.connectionGeneration,
      workspaceGeneration: invoke.workspaceGeneration,
      endpointGeneration: invoke.endpointGeneration,
      deadlineAt: invoke.deadlineAt,
    },
    spec: { agent: "general", task: "run remotely", context: "fresh" },
  };
  assert.doesNotThrow(() => assertValidFabricHubRelayPayload({
    ...invoke,
    operation: "agent.start",
    input: startInput,
    frame: { ...invoke.frame, payload: { operation: "agent.start", input: startInput } },
  }, "invoke"));

  assert.throws(() => assertValidFabricHubRelayPayload({ ...invoke, operation: "mcp.call" }, "invoke"), (error) => code(error, "invalid_argument"));
  assert.throws(() => assertValidFabricHubRelayPayload({ ...invoke, direction: "device-to-hub" }, "invoke"), (error) => code(error, "protocol_violation"));
  assert.throws(() => assertValidFabricHubRelayPayload({ ...invoke, sequence: 1 }, "invoke"), (error) => code(error, "protocol_violation"));
  assert.throws(() => assertValidFabricHubRelayPayload({ ...invoke, principal: { id: "forged" } }, "invoke"), (error) => code(error, "invalid_argument"));
  assert.throws(() => assertValidFabricHubRelayPayload({ ...invoke, input: { cwd: "/secret" } }, "invoke"), (error) => code(error, "permission_denied"));
  assert.throws(() => assertValidFabricHubRelayPayload({ ...invoke, input: { ...invoke.input, ownerToken: "secret" } }, "invoke"), (error) => code(error, "permission_denied"));
  assert.throws(() => assertValidFabricHubRelayPayload({ ...invoke, input: { ...invoke.input, arbitraryAuthority: {} } }, "invoke"), (error) => code(error, "invalid_argument"));
  const getterInput: Record<string, unknown> = {};
  Object.defineProperty(getterInput, "attemptId", { enumerable: true, get: () => "attempt-1" });
  assert.throws(() => assertValidFabricHubRelayPayload({ ...invoke, input: getterInput }, "invoke"), (error) => code(error, "invalid_argument"));
  assert.throws(() => assertValidFabricHubRelayEnvelope({ ...envelope, operationId: "foreign-operation" }), (error) => code(error, "conflict"));
});

test("stream, cancel, and receipt require their one legal direction and correlation", () => {
  const responseFrame = { ...invoke.frame, sequence: 0, kind: "end" as const, payload: { result: { accepted: true } } };
  const stream = { ...invoke, direction: "device-to-hub" as const, sequence: 0, frame: responseFrame };
  delete (stream as Partial<typeof stream>).operation;
  delete (stream as Partial<typeof stream>).originSubject;
  delete (stream as Partial<typeof stream>).input;
  assert.doesNotThrow(() => assertValidFabricHubRelayPayload(stream, "stream"));
  assert.throws(() => assertValidFabricHubRelayPayload({ ...stream, direction: "hub-to-device" }, "stream"), (error) => code(error, "protocol_violation"));
  assert.throws(() => assertValidFabricHubRelayPayload({ ...stream, streamId: "other" }, "stream"), (error) => code(error, "conflict"));

  const cancel = { ...invoke, sequence: 1, reason: "caller_cancelled", frame: { ...invoke.frame, sequence: 1, kind: "cancel" as const, payload: { reason: "caller_cancelled" } } };
  delete (cancel as Partial<typeof cancel>).operation;
  delete (cancel as Partial<typeof cancel>).originSubject;
  delete (cancel as Partial<typeof cancel>).input;
  assert.doesNotThrow(() => assertValidFabricHubRelayPayload(cancel, "cancel"));

  const receipt = {
    ...invoke,
    direction: "device-to-hub" as const,
    receiptKind: "cancel_delivered" as const,
    acceptedMessageId: "message-cancel",
    accepted: true,
  };
  delete (receipt as Partial<typeof receipt>).operation;
  delete (receipt as Partial<typeof receipt>).originSubject;
  delete (receipt as Partial<typeof receipt>).input;
  delete (receipt as Partial<typeof receipt>).frame;
  assert.doesNotThrow(() => assertValidFabricHubRelayPayload(receipt, "receipt"));
  assert.throws(() => assertValidFabricHubRelayPayload({ ...receipt, receiptKind: "agent_completed" }, "receipt"), (error) => code(error, "invalid_argument"));
});
