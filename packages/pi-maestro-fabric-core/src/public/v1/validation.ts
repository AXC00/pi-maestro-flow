import {
  FABRIC_CONTRACT_HASH_MAX_BYTES,
  FABRIC_LABEL_MAX_BYTES,
  FABRIC_PROTOCOL_VERSION,
  FabricContractError,
  assertBoundedString,
  assertEpochMilliseconds,
  assertFabricIdentifier,
  assertGeneration,
  assertRevision,
  assertUnexpired,
  utf8ByteLength,
} from "./common.ts";
import type { CapabilityBinding } from "./capability.ts";
import { FABRIC_CAPABILITY_KINDS } from "./capability.ts";
import type { ConnectionLease } from "./connection.ts";
import { FABRIC_CONNECTION_STATES } from "./connection.ts";
import type { ConnectorRecord, DeviceRecord } from "./device.ts";
import { FABRIC_CONNECTION_MODES, FABRIC_CONNECTOR_TRANSPORTS } from "./device.ts";
import type { AgentRuntimeEndpoint, EndpointRecord, McpServiceEndpoint } from "./endpoint.ts";
import { FABRIC_ENDPOINT_STATUSES, FABRIC_MCP_TRANSPORTS } from "./endpoint.ts";
import type { AgentPlacementRequest, InvocationReceipt, McpInvocationRequest } from "./invocation.ts";
import { FABRIC_INVOCATION_STATES, FABRIC_REPLAY_CLASSES } from "./invocation.ts";
import type { FabricEnvelopeV1, FabricProtocolLimits } from "./protocol.ts";
import { FABRIC_MESSAGE_KINDS } from "./protocol.ts";
import type { EndpointRouteHandle, RouteValidationContext } from "./route.ts";
import { FABRIC_ROUTE_STATES } from "./route.ts";
import type { WorkspaceBinding, WorkspaceRecord } from "./workspace.ts";
import { FABRIC_WORKSPACE_MODES } from "./workspace.ts";

function requireRecord<T extends object>(value: unknown, path: string): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FabricContractError("invalid_argument", `${path} must be an object`, path);
  }
  return value as T;
}

function assertOneOf<T extends string>(value: unknown, values: readonly T[], path: string): asserts value is T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new FabricContractError("invalid_argument", `${path} has an unsupported value`, path);
  }
}

function assertBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new FabricContractError("invalid_argument", `${path} must be a boolean`, path);
  }
}

function assertIdentifierList(input: unknown, path: string): asserts input is readonly string[] {
  if (!Array.isArray(input)) {
    throw new FabricContractError("invalid_argument", `${path} must be an array`, path);
  }
  const seen = new Set<string>();
  for (const [index, value] of input.entries()) {
    assertFabricIdentifier(value, `${path}[${index}]`);
    if (seen.has(value)) throw new FabricContractError("conflict", `${path} contains a duplicate`, `${path}[${index}]`);
    seen.add(value);
  }
}

function assertModelRegistrationList(input: unknown, path: string): asserts input is readonly string[] {
  if (!Array.isArray(input)) {
    throw new FabricContractError("invalid_argument", `${path} must be an array`, path);
  }
  const seen = new Set<string>();
  for (const [index, value] of input.entries()) {
    assertBoundedString(value, `${path}[${index}]`, 256);
    if (/\s|[\u0000-\u001f\u007f]/u.test(value)) {
      throw new FabricContractError("invalid_argument", `${path}[${index}] contains whitespace or control characters`, `${path}[${index}]`);
    }
    if (seen.has(value)) throw new FabricContractError("conflict", `${path} contains a duplicate`, `${path}[${index}]`);
    seen.add(value);
  }
}

const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const MAX_JSON_BYTES = 65_536;

interface JsonBudget {
  nodes: number;
  bytes: number;
}

function consumeJsonBudget(budget: JsonBudget, bytes: number, path: string): void {
  budget.nodes += 1;
  budget.bytes += bytes;
  if (budget.nodes > MAX_JSON_NODES || budget.bytes > MAX_JSON_BYTES) {
    throw new FabricContractError("resource_exhausted", `${path} exceeds maximum JSON size`, path);
  }
}

function assertJsonValue(value: unknown, path: string, depth = 0, budget: JsonBudget = { nodes: 0, bytes: 0 }): void {
  if (depth > MAX_JSON_DEPTH) throw new FabricContractError("resource_exhausted", `${path} exceeds maximum JSON depth`, path);
  if (value === null) {
    consumeJsonBudget(budget, 4, path);
    return;
  }
  if (typeof value === "string") {
    consumeJsonBudget(budget, utf8ByteLength(value) + 2, path);
    return;
  }
  if (typeof value === "boolean") {
    consumeJsonBudget(budget, value ? 4 : 5, path);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new FabricContractError("invalid_argument", `${path} must be a finite JSON number`, path);
    consumeJsonBudget(budget, String(value).length, path);
    return;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || "toJSON" in value) {
      throw new FabricContractError("invalid_argument", `${path} must be a plain JSON array`, path);
    }
    if (value.length > 10_000) {
      throw new FabricContractError("resource_exhausted", `${path} exceeds maximum array length`, path);
    }
    consumeJsonBudget(budget, 2, path);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new FabricContractError("invalid_argument", `${path} cannot contain sparse or inherited entries`, `${path}[${index}]`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable) {
        throw new FabricContractError("invalid_argument", `${path}[${index}] must be an enumerable data property`, `${path}[${index}]`);
      }
      assertJsonValue(descriptor.value, `${path}[${index}]`, depth + 1, budget);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
        throw new FabricContractError("invalid_argument", `${path} contains a non-JSON array property`, path);
      }
    }
    return;
  }
  const record = requireRecord<Record<string, unknown>>(value, path);
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new FabricContractError("invalid_argument", `${path} must be a plain JSON object`, path);
  }
  const keys = Reflect.ownKeys(record);
  consumeJsonBudget(budget, 2, path);
  if (keys.length > 10_000) {
    throw new FabricContractError("resource_exhausted", `${path} exceeds maximum object size`, path);
  }
  for (const key of keys) {
    if (typeof key !== "string" || key === "toJSON") {
      throw new FabricContractError("invalid_argument", `${path} contains a non-JSON property`, path);
    }
    consumeJsonBudget(budget, utf8ByteLength(key) + 3, path);
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable) {
      throw new FabricContractError("invalid_argument", `${path}.${key} must be an enumerable data property`, `${path}.${key}`);
    }
    assertJsonValue(descriptor.value, `${path}.${key}`, depth + 1, budget);
  }
}

function assertJsonObject(value: unknown, path: string): asserts value is Readonly<Record<string, never>> {
  const record = requireRecord<Record<string, unknown>>(value, path);
  assertJsonValue(record, path);
}

export function assertValidConnectorRecord(input: unknown): asserts input is ConnectorRecord {
  const record = requireRecord<ConnectorRecord>(input, "connector");
  assertFabricIdentifier(record.connectorId, "connectorId");
  assertBoundedString(record.label, "label", FABRIC_LABEL_MAX_BYTES);
  assertOneOf(record.transport, FABRIC_CONNECTOR_TRANSPORTS, "transport");
  assertGeneration(record.credentialGeneration, "credentialGeneration");
  if (record.instanceNonce !== undefined) assertFabricIdentifier(record.instanceNonce, "instanceNonce");
  if (record.lastSeenAt !== undefined) assertEpochMilliseconds(record.lastSeenAt, "lastSeenAt");
  assertBoolean(record.enabled, "enabled");
  assertRevision(record.revision, "revision");
}

export function assertValidDeviceRecord(input: unknown): asserts input is DeviceRecord {
  const record = requireRecord<DeviceRecord>(input, "device");
  assertFabricIdentifier(record.deviceId, "deviceId");
  assertFabricIdentifier(record.connectorId, "connectorId");
  assertBoundedString(record.label, "label", FABRIC_LABEL_MAX_BYTES);
  assertOneOf(record.connectionMode, FABRIC_CONNECTION_MODES, "connectionMode");
  if (record.platform !== undefined) assertBoundedString(record.platform, "platform", FABRIC_LABEL_MAX_BYTES);
  if (record.architecture !== undefined) assertBoundedString(record.architecture, "architecture", FABRIC_LABEL_MAX_BYTES);
  assertBoolean(record.enabled, "enabled");
  assertRevision(record.revision, "revision");
}

export function assertValidConnectionLease(input: unknown, now?: number): asserts input is ConnectionLease {
  const record = requireRecord<ConnectionLease>(input, "connection");
  assertFabricIdentifier(record.connectionId, "connectionId");
  assertFabricIdentifier(record.deviceId, "deviceId");
  assertFabricIdentifier(record.connectorId, "connectorId");
  assertFabricIdentifier(record.connectorInstanceNonce, "connectorInstanceNonce");
  assertGeneration(record.generation, "generation");
  assertOneOf(record.state, FABRIC_CONNECTION_STATES, "state");
  assertBoundedString(record.capabilityDigest, "capabilityDigest", FABRIC_CONTRACT_HASH_MAX_BYTES);
  assertEpochMilliseconds(record.establishedAt, "establishedAt");
  assertEpochMilliseconds(record.expiresAt, "expiresAt");
  if (record.expiresAt <= record.establishedAt) {
    throw new FabricContractError("invalid_argument", "expiresAt must be after establishedAt", "expiresAt");
  }
  if (now !== undefined && record.state !== "closed") assertUnexpired(record.expiresAt, now, "expiresAt");
  assertRevision(record.revision, "revision");
}

export function assertValidWorkspaceRecord(input: unknown): asserts input is WorkspaceRecord {
  const record = requireRecord<WorkspaceRecord>(input, "workspace");
  assertFabricIdentifier(record.workspaceId, "workspaceId");
  assertFabricIdentifier(record.deviceId, "deviceId");
  assertFabricIdentifier(record.localWorkspaceId, "localWorkspaceId");
  assertBoundedString(record.label, "label", FABRIC_LABEL_MAX_BYTES);
  assertOneOf(record.mode, FABRIC_WORKSPACE_MODES, "mode");
  assertGeneration(record.generation, "generation");
  assertBoundedString(record.policyDigest, "policyDigest", FABRIC_CONTRACT_HASH_MAX_BYTES);
  assertIdentifierList(record.endpointIds, "endpointIds");
  assertRevision(record.revision, "revision");
}

export function assertValidWorkspaceBinding(input: unknown, now?: number): asserts input is WorkspaceBinding {
  const record = requireRecord<WorkspaceBinding>(input, "workspaceBinding");
  assertFabricIdentifier(record.bindingId, "bindingId");
  assertFabricIdentifier(record.connectionId, "connectionId");
  assertFabricIdentifier(record.deviceId, "deviceId");
  assertFabricIdentifier(record.workspaceId, "workspaceId");
  assertGeneration(record.connectionGeneration, "connectionGeneration");
  assertGeneration(record.workspaceGeneration, "workspaceGeneration");
  assertBoundedString(record.policyDigest, "policyDigest", FABRIC_CONTRACT_HASH_MAX_BYTES);
  assertEpochMilliseconds(record.issuedAt, "issuedAt");
  assertEpochMilliseconds(record.expiresAt, "expiresAt");
  if (record.expiresAt <= record.issuedAt) {
    throw new FabricContractError("invalid_argument", "expiresAt must be after issuedAt", "expiresAt");
  }
  if (now !== undefined) assertUnexpired(record.expiresAt, now, "expiresAt");
  assertRevision(record.revision, "revision");
}

export function assertValidEndpointRecord(input: unknown): asserts input is EndpointRecord {
  const record = requireRecord<EndpointRecord>(input, "endpoint");
  assertFabricIdentifier(record.endpointId, "endpointId");
  assertFabricIdentifier(record.deviceId, "deviceId");
  assertFabricIdentifier(record.connectorId, "connectorId");
  requireRecord(record.scope, "scope");
  assertOneOf(record.scope.kind, ["device", "workspace"], "scope.kind");
  if (record.scope.kind === "workspace") assertFabricIdentifier(record.scope.workspaceId, "scope.workspaceId");
  assertGeneration(record.generation, "generation");
  assertBoundedString(record.contractHash, "contractHash", FABRIC_CONTRACT_HASH_MAX_BYTES);
  assertOneOf(record.status, FABRIC_ENDPOINT_STATUSES, "status");
  assertRevision(record.revision, "revision");
  assertOneOf(record.kind, ["agent", "mcp"], "kind");
  if (record.kind === "agent") {
    assertIdentifierList(record.roles, "roles");
    assertIdentifierList(record.taskTypes, "taskTypes");
    assertModelRegistrationList(record.models, "models");
    if (!Number.isSafeInteger(record.maxConcurrency) || record.maxConcurrency < 1) {
      throw new FabricContractError("invalid_argument", "maxConcurrency must be a positive safe integer", "maxConcurrency");
    }
  } else {
    assertFabricIdentifier(record.serverName, "serverName");
    assertBoundedString(record.protocolVersion, "protocolVersion", 64);
    assertOneOf(record.transport, FABRIC_MCP_TRANSPORTS, "transport");
    if (typeof record.durableDeduplication !== "boolean") {
      throw new FabricContractError("invalid_argument", "durableDeduplication must be a boolean", "durableDeduplication");
    }
  }
}

export function assertValidCapabilityBinding(input: unknown): asserts input is CapabilityBinding {
  const record = requireRecord<CapabilityBinding>(input, "capability");
  assertFabricIdentifier(record.capabilityId, "capabilityId");
  assertOneOf(record.kind, FABRIC_CAPABILITY_KINDS, "kind");
  assertFabricIdentifier(record.endpointId, "endpointId");
  assertBoundedString(record.contractHash, "contractHash", FABRIC_CONTRACT_HASH_MAX_BYTES);
  assertBoundedString(record.trustLevel, "trustLevel", 128);
  if (record.locality !== undefined) assertBoundedString(record.locality, "locality", FABRIC_LABEL_MAX_BYTES);
  if (record.inputSchema !== undefined) assertJsonObject(record.inputSchema, "inputSchema");
  if (!Number.isSafeInteger(record.priority) || record.priority < 0) {
    throw new FabricContractError("invalid_argument", "priority must be a non-negative safe integer", "priority");
  }
}

export function assertValidEndpointRouteHandle(input: unknown, now?: number): asserts input is EndpointRouteHandle {
  const record = requireRecord<EndpointRouteHandle>(input, "route");
  assertFabricIdentifier(record.routeId, "routeId");
  assertFabricIdentifier(record.connectionId, "connectionId");
  if (record.workspaceBindingId !== undefined) assertFabricIdentifier(record.workspaceBindingId, "workspaceBindingId");
  assertFabricIdentifier(record.endpointId, "endpointId");
  assertGeneration(record.connectionGeneration, "connectionGeneration");
  if (record.workspaceGeneration !== undefined) assertGeneration(record.workspaceGeneration, "workspaceGeneration");
  assertGeneration(record.endpointGeneration, "endpointGeneration");
  assertEpochMilliseconds(record.issuedAt, "issuedAt");
  assertEpochMilliseconds(record.expiresAt, "expiresAt");
  if (record.expiresAt <= record.issuedAt) {
    throw new FabricContractError("invalid_argument", "expiresAt must be after issuedAt", "expiresAt");
  }
  assertOneOf(record.state, FABRIC_ROUTE_STATES, "state");
  if (now !== undefined && record.state !== "closed") assertUnexpired(record.expiresAt, now, "expiresAt");
  assertRevision(record.revision, "revision");
}

export function assertUsableEndpointRoute(input: unknown, contextInput: unknown): asserts input is EndpointRouteHandle {
  const context = requireRecord<RouteValidationContext>(contextInput, "routeContext");
  assertEpochMilliseconds(context.now, "routeContext.now");
  assertFabricIdentifier(context.connectionId, "routeContext.connectionId");
  assertGeneration(context.connectionGeneration, "routeContext.connectionGeneration");
  assertFabricIdentifier(context.endpointId, "routeContext.endpointId");
  assertGeneration(context.endpointGeneration, "routeContext.endpointGeneration");
  if (context.workspaceBindingId !== undefined) assertFabricIdentifier(context.workspaceBindingId, "routeContext.workspaceBindingId");
  if (context.workspaceGeneration !== undefined) assertGeneration(context.workspaceGeneration, "routeContext.workspaceGeneration");
  assertValidEndpointRouteHandle(input, context.now);
  const record = input;
  if (record.state !== "open") throw new FabricContractError("invalid_state", "Route must be open", "state");
  if (
    record.connectionId !== context.connectionId ||
    record.connectionGeneration !== context.connectionGeneration ||
    record.endpointId !== context.endpointId ||
    record.endpointGeneration !== context.endpointGeneration ||
    record.workspaceBindingId !== context.workspaceBindingId ||
    record.workspaceGeneration !== context.workspaceGeneration
  ) {
    throw new FabricContractError("stale_generation", "Route does not match the current authority context", "route");
  }
}

function assertRouteTargetsEndpoint(
  route: EndpointRouteHandle,
  endpointInput: unknown,
  expectedKind: EndpointRecord["kind"],
): asserts endpointInput is EndpointRecord {
  assertValidEndpointRecord(endpointInput);
  const endpoint = endpointInput;
  if (endpoint.kind !== expectedKind) {
    throw new FabricContractError("invalid_argument", `Expected a ${expectedKind} endpoint`, "endpoint.kind");
  }
  if (endpoint.status !== "online") {
    throw new FabricContractError("unavailable", "Endpoint must be online", "endpoint.status");
  }
  if (route.endpointId !== endpoint.endpointId || route.endpointGeneration !== endpoint.generation) {
    throw new FabricContractError("stale_generation", "Route does not target the current endpoint generation", "route");
  }
  if (endpoint.scope.kind === "workspace") {
    if (route.workspaceBindingId === undefined || route.workspaceGeneration === undefined) {
      throw new FabricContractError("permission_denied", "Workspace endpoint requires a bound route", "route.workspaceBindingId");
    }
  } else if (route.workspaceBindingId !== undefined || route.workspaceGeneration !== undefined) {
    throw new FabricContractError("conflict", "Device endpoint route cannot carry workspace authority", "route.workspaceBindingId");
  }
}

export function assertValidAgentPlacementRequest(
  input: unknown,
  endpoint: unknown,
  contextInput: unknown,
): asserts input is AgentPlacementRequest {
  const request = requireRecord<AgentPlacementRequest>(input, "agentPlacement");
  const context = requireRecord<RouteValidationContext>(contextInput, "routeContext");
  if (request.kind !== "agent-placement") throw new FabricContractError("invalid_argument", "Invalid placement kind", "kind");
  assertFabricIdentifier(request.attemptId, "attemptId");
  assertUsableEndpointRoute(request.route, context);
  assertRouteTargetsEndpoint(request.route, endpoint, "agent");
  assertEpochMilliseconds(request.deadlineAt, "deadlineAt");
  if (request.deadlineAt <= context.now) {
    throw new FabricContractError("deadline_exceeded", "Placement deadline has passed", "deadlineAt");
  }
}

export function assertValidMcpInvocationRequest(
  input: unknown,
  endpoint: unknown,
  contextInput: unknown,
): asserts input is McpInvocationRequest {
  const request = requireRecord<McpInvocationRequest>(input, "mcpInvocation");
  const context = requireRecord<RouteValidationContext>(contextInput, "routeContext");
  if (request.kind !== "mcp-call") throw new FabricContractError("invalid_argument", "Invalid MCP invocation kind", "kind");
  assertFabricIdentifier(request.operationId, "operationId");
  assertUsableEndpointRoute(request.route, context);
  assertRouteTargetsEndpoint(request.route, endpoint, "mcp");
  const mcpEndpoint = endpoint as McpServiceEndpoint;
  assertFabricIdentifier(request.toolName, "toolName");
  assertJsonObject(request.arguments, "arguments");
  assertEpochMilliseconds(request.deadlineAt, "deadlineAt");
  if (request.deadlineAt <= context.now) throw new FabricContractError("deadline_exceeded", "Invocation deadline has passed", "deadlineAt");
  assertOneOf(request.replayClass, FABRIC_REPLAY_CLASSES, "replayClass");
  if (request.replayClass === "durable-dedup" && !mcpEndpoint.durableDeduplication) {
    throw new FabricContractError("permission_denied", "Endpoint does not prove durable deduplication", "replayClass");
  }
}

export function assertValidFabricProtocolLimits(input: unknown): asserts input is FabricProtocolLimits {
  const limits = requireRecord<FabricProtocolLimits>(input, "limits");
  for (const key of [
    "maxFrameBytes",
    "maxInFlightOperations",
    "heartbeatIntervalMs",
    "heartbeatTimeoutMs",
    "maxAdvertisementItems",
    "maxResultBytes",
  ] as const) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new FabricContractError("invalid_argument", `${key} must be a positive safe integer`, key);
    }
  }
  if (limits.heartbeatTimeoutMs <= limits.heartbeatIntervalMs) {
    throw new FabricContractError(
      "invalid_argument",
      "heartbeatTimeoutMs must be greater than heartbeatIntervalMs",
      "heartbeatTimeoutMs",
    );
  }
}

export function assertValidFabricEnvelope(input: unknown): asserts input is FabricEnvelopeV1 {
  const envelope = requireRecord<FabricEnvelopeV1>(input, "envelope");
  if (envelope.version !== FABRIC_PROTOCOL_VERSION) {
    throw new FabricContractError("unsupported_version", "Unsupported Fabric protocol version", "version");
  }
  assertFabricIdentifier(envelope.messageId, "messageId");
  assertOneOf(envelope.kind, FABRIC_MESSAGE_KINDS, "kind");
  assertEpochMilliseconds(envelope.sentAt, "sentAt");
  if (envelope.connectionId !== undefined) assertFabricIdentifier(envelope.connectionId, "connectionId");
  if (envelope.connectionGeneration !== undefined) {
    assertGeneration(envelope.connectionGeneration, "connectionGeneration");
    if (envelope.connectionId === undefined) {
      throw new FabricContractError("invalid_argument", "connectionGeneration requires connectionId", "connectionGeneration");
    }
  }
  if (envelope.correlationId !== undefined) assertFabricIdentifier(envelope.correlationId, "correlationId");
  if (envelope.operationId !== undefined) assertFabricIdentifier(envelope.operationId, "operationId");
  if (envelope.deadlineAt !== undefined) assertEpochMilliseconds(envelope.deadlineAt, "deadlineAt");
  assertJsonObject(envelope.payload, "payload");
}

export function assertValidInvocationReceipt(input: unknown): asserts input is InvocationReceipt {
  const receipt = requireRecord<InvocationReceipt>(input, "receipt");
  assertFabricIdentifier(receipt.operationId, "operationId");
  assertFabricIdentifier(receipt.routeId, "routeId");
  assertFabricIdentifier(receipt.endpointId, "endpointId");
  assertGeneration(receipt.connectionGeneration, "connectionGeneration");
  assertGeneration(receipt.endpointGeneration, "endpointGeneration");
  assertOneOf(receipt.state, FABRIC_INVOCATION_STATES, "state");
  assertOneOf(receipt.replayClass, FABRIC_REPLAY_CLASSES, "replayClass");
  if (receipt.endpointReceiptRef !== undefined) assertFabricIdentifier(receipt.endpointReceiptRef, "endpointReceiptRef");
  if (receipt.resultRef !== undefined) {
    assertBoundedString(receipt.resultRef, "resultRef", 2_048);
    if (!["succeeded", "failed"].includes(receipt.state)) {
      throw new FabricContractError("invalid_state", "resultRef requires a succeeded or failed receipt", "resultRef");
    }
  }
  assertRevision(receipt.revision, "revision");
  assertEpochMilliseconds(receipt.updatedAt, "updatedAt");
}

const ALLOWED_RECEIPT_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  accepted: ["accepted", "running", "succeeded", "failed", "cancelled", "outcome-unknown"],
  running: ["running", "succeeded", "failed", "cancelled", "outcome-unknown"],
  succeeded: ["succeeded"],
  failed: ["failed"],
  cancelled: ["cancelled"],
  "outcome-unknown": ["outcome-unknown", "succeeded", "failed", "cancelled"],
};

export function assertInvocationReceiptTransition(previousInput: unknown, nextInput: unknown): void {
  assertValidInvocationReceipt(previousInput);
  assertValidInvocationReceipt(nextInput);
  const previous = previousInput;
  const next = nextInput;
  if (
    next.operationId !== previous.operationId ||
    next.routeId !== previous.routeId ||
    next.endpointId !== previous.endpointId ||
    next.connectionGeneration !== previous.connectionGeneration ||
    next.endpointGeneration !== previous.endpointGeneration ||
    next.replayClass !== previous.replayClass
  ) {
    throw new FabricContractError("conflict", "Receipt authority identity cannot change", "receipt");
  }
  if (next.revision !== previous.revision + 1) {
    throw new FabricContractError("conflict", "Receipt revision must increment by one", "revision");
  }
  if (!ALLOWED_RECEIPT_TRANSITIONS[previous.state]?.includes(next.state)) {
    throw new FabricContractError("invalid_state", `Cannot transition receipt from ${previous.state} to ${next.state}`, "state");
  }
  if (next.updatedAt < previous.updatedAt) {
    throw new FabricContractError("invalid_argument", "Receipt updatedAt cannot move backwards", "updatedAt");
  }
}
