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
import type { FabricArtifactChunkV1, FabricArtifactDescriptorV1 } from "./artifact.ts";
import { FABRIC_ARTIFACT_STATES, FABRIC_ARTIFACT_STORAGE, FABRIC_ARTIFACT_VERSION } from "./artifact.ts";
import type { FabricControlRequestV1, FabricControlResponseV1 } from "./control.ts";
import { FABRIC_CONTROL_ACTIONS, FABRIC_CONTROL_VERSION, FABRIC_OPERATION_CLASSES } from "./control.ts";
import type { AgentPlacementRequest, InvocationReceipt, McpInvocationRequest } from "./invocation.ts";
import { FABRIC_INVOCATION_STATES, FABRIC_REPLAY_CLASSES } from "./invocation.ts";
import type { FabricMountLeaseV1 } from "./mount.ts";
import { FABRIC_MOUNT_STATES, FABRIC_MOUNT_VERSION } from "./mount.ts";
import type { FabricPlacementEventV1, QualifiedTaskReferenceV1, QualifiedTaskSnapshotV1, TeammatePlacementV1 } from "./placement.ts";
import { FABRIC_PLACEMENT_EVENT_KINDS, FABRIC_PLACEMENT_VERSION, FABRIC_TASK_AUTHORITIES, FABRIC_TASK_SNAPSHOT_STATUSES } from "./placement.ts";
import { sanitizeFabricProjectionText } from "./projection.ts";
import type { FabricEnvelopeV1, FabricProtocolLimits } from "./protocol.ts";
import { FABRIC_MESSAGE_KINDS } from "./protocol.ts";
import type { EndpointRouteHandle, RouteValidationContext } from "./route.ts";
import { FABRIC_ROUTE_PATHS, FABRIC_ROUTE_STATES } from "./route.ts";
import type { FabricRouteTicketClaimsV1, FabricRouteTicketV1 } from "./security.ts";
import { FABRIC_ROUTE_TICKET_VERSION } from "./security.ts";
import type { FabricPersistedStoreStateV1, FabricStoreCursorV1, FabricStoreEventV1, FabricStoreTransactionV1 } from "./store.ts";
import { FABRIC_STORE_CURSOR_VERSION, FABRIC_STORE_EVENT_VERSION, FABRIC_STORE_KINDS, FABRIC_STORE_MUTATIONS, FABRIC_STORE_SHAPE_VERSION, FABRIC_STORE_TRANSACTION_VERSION } from "./store.ts";
import type { FabricStreamFrameV1 } from "./transport.ts";
import { FABRIC_STREAM_FRAME_KINDS, FABRIC_STREAM_VERSION } from "./transport.ts";
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
  if (record.deviceId !== undefined) assertFabricIdentifier(record.deviceId, "deviceId");
  if (record.operationClass !== undefined) assertOneOf(record.operationClass, FABRIC_OPERATION_CLASSES, "operationClass");
  if (record.pathCandidates !== undefined) {
    assertUniqueEnumList(record.pathCandidates, FABRIC_ROUTE_PATHS, "pathCandidates");
    if (record.pathCandidates.length === 0) {
      throw new FabricContractError("invalid_argument", "pathCandidates cannot be empty", "pathCandidates");
    }
  }
  if (record.selectedPath !== undefined) {
    assertOneOf(record.selectedPath, FABRIC_ROUTE_PATHS, "selectedPath");
    if (record.pathCandidates === undefined || !record.pathCandidates.includes(record.selectedPath)) {
      throw new FabricContractError("invalid_argument", "selectedPath must be one of pathCandidates", "selectedPath");
    }
  }
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
  if (request.task !== undefined) assertValidQualifiedTaskReference(request.task);
  if (request.placement !== undefined) {
    assertValidTeammatePlacement(request.placement, context.now);
    if (
      request.placement.routeId !== request.route.routeId ||
      request.placement.endpointId !== request.route.endpointId ||
      request.placement.connectionGeneration !== request.route.connectionGeneration ||
      request.placement.workspaceGeneration !== request.route.workspaceGeneration ||
      request.placement.endpointGeneration !== request.route.endpointGeneration ||
      request.placement.deadlineAt !== request.deadlineAt
    ) {
      throw new FabricContractError("conflict", "Placement metadata must match its admitted route", "placement");
    }
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

function assertSafeIntegerAtLeast(value: unknown, minimum: number, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new FabricContractError("invalid_argument", `${path} must be a safe integer greater than or equal to ${minimum}`, path);
  }
}

function assertUniqueEnumList<T extends string>(input: unknown, values: readonly T[], path: string): asserts input is readonly T[] {
  if (!Array.isArray(input) || input.length > 64) {
    throw new FabricContractError("invalid_argument", `${path} must be an array with at most 64 entries`, path);
  }
  const seen = new Set<T>();
  for (const [index, value] of input.entries()) {
    assertOneOf(value, values, `${path}[${index}]`);
    if (seen.has(value)) throw new FabricContractError("conflict", `${path} contains a duplicate`, `${path}[${index}]`);
    seen.add(value);
  }
}

function assertRequestedTtl(value: unknown, path: string): asserts value is number {
  assertSafeIntegerAtLeast(value, 1, path);
  if (value > 86_400_000) {
    throw new FabricContractError("resource_exhausted", `${path} cannot exceed 86400000`, path);
  }
}

export function assertValidFabricControlRequest(input: unknown, now?: number): asserts input is FabricControlRequestV1 {
  const request = requireRecord<FabricControlRequestV1>(input, "controlRequest");
  if (request.version !== FABRIC_CONTROL_VERSION) {
    throw new FabricContractError("unsupported_version", "Unsupported Fabric control version", "version");
  }
  assertFabricIdentifier(request.requestId, "requestId");
  assertOneOf(request.action, FABRIC_CONTROL_ACTIONS, "action");
  assertEpochMilliseconds(request.deadlineAt, "deadlineAt");
  if (now !== undefined && request.deadlineAt <= now) {
    throw new FabricContractError("deadline_exceeded", "Control request deadline has passed", "deadlineAt");
  }
  if (request.deviceId !== undefined) assertFabricIdentifier(request.deviceId, "deviceId");
  if (request.connectorId !== undefined) assertFabricIdentifier(request.connectorId, "connectorId");
  if (request.connectionId !== undefined) assertFabricIdentifier(request.connectionId, "connectionId");
  if (request.workspaceId !== undefined) assertFabricIdentifier(request.workspaceId, "workspaceId");
  if (request.localWorkspaceId !== undefined) assertFabricIdentifier(request.localWorkspaceId, "localWorkspaceId");
  if (request.workspaceBindingId !== undefined) assertFabricIdentifier(request.workspaceBindingId, "workspaceBindingId");
  if (request.endpointId !== undefined) assertFabricIdentifier(request.endpointId, "endpointId");
  if (request.routeId !== undefined) assertFabricIdentifier(request.routeId, "routeId");
  if (request.pairingRef !== undefined) assertBoundedString(request.pairingRef, "pairingRef", 2_048);
  if (request.expectedRevision !== undefined) assertRevision(request.expectedRevision, "expectedRevision");
  if (request.expectedCredentialGeneration !== undefined) assertGeneration(request.expectedCredentialGeneration, "expectedCredentialGeneration");
  if (request.expectedConnectionGeneration !== undefined) assertGeneration(request.expectedConnectionGeneration, "expectedConnectionGeneration");
  if (request.expectedWorkspaceGeneration !== undefined) assertGeneration(request.expectedWorkspaceGeneration, "expectedWorkspaceGeneration");
  if (request.expectedLocalWorkspaceGeneration !== undefined) assertGeneration(request.expectedLocalWorkspaceGeneration, "expectedLocalWorkspaceGeneration");
  if (request.expectedEndpointGeneration !== undefined) assertGeneration(request.expectedEndpointGeneration, "expectedEndpointGeneration");
  if (request.requestedTtlMs !== undefined) assertRequestedTtl(request.requestedTtlMs, "requestedTtlMs");
  if (request.endpointKind !== undefined) assertOneOf(request.endpointKind, ["agent", "mcp"], "endpointKind");
  if (request.endpointStatus !== undefined) assertOneOf(request.endpointStatus, FABRIC_ENDPOINT_STATUSES, "endpointStatus");
  if (request.operationClass !== undefined) assertOneOf(request.operationClass, FABRIC_OPERATION_CLASSES, "operationClass");
  if (request.pathCandidates !== undefined) assertUniqueEnumList(request.pathCandidates, FABRIC_ROUTE_PATHS, "pathCandidates");

  const requireId = (value: unknown, path: string): void => assertFabricIdentifier(value, path);
  switch (request.action) {
    case "device.get":
    case "device.status":
    case "device.workspaces":
      requireId(request.deviceId, "deviceId");
      break;
    case "device.pair":
      requireId(request.connectorId, "connectorId");
      requireId(request.deviceId, "deviceId");
      assertBoundedString(request.pairingRef, "pairingRef", 2_048);
      break;
    case "device.connect":
      requireId(request.deviceId, "deviceId");
      requireId(request.connectorId, "connectorId");
      assertGeneration(request.expectedCredentialGeneration, "expectedCredentialGeneration");
      break;
    case "device.disconnect":
      requireId(request.deviceId, "deviceId");
      requireId(request.connectionId, "connectionId");
      assertGeneration(request.expectedConnectionGeneration, "expectedConnectionGeneration");
      break;
    case "workspace.bind":
      requireId(request.deviceId, "deviceId");
      requireId(request.connectionId, "connectionId");
      requireId(request.workspaceId, "workspaceId");
      assertGeneration(request.expectedConnectionGeneration, "expectedConnectionGeneration");
      assertGeneration(request.expectedWorkspaceGeneration, "expectedWorkspaceGeneration");
      assertRequestedTtl(request.requestedTtlMs, "requestedTtlMs");
      break;
    case "workspace.renew":
      requireId(request.workspaceBindingId, "workspaceBindingId");
      assertRevision(request.expectedRevision, "expectedRevision");
      assertRequestedTtl(request.requestedTtlMs, "requestedTtlMs");
      break;
    case "workspace.unbind":
      requireId(request.workspaceBindingId, "workspaceBindingId");
      break;
    case "endpoint.describe":
    case "endpoint.select":
      requireId(request.endpointId, "endpointId");
      break;
    case "route.open":
      requireId(request.connectionId, "connectionId");
      requireId(request.endpointId, "endpointId");
      assertGeneration(request.expectedConnectionGeneration, "expectedConnectionGeneration");
      assertGeneration(request.expectedEndpointGeneration, "expectedEndpointGeneration");
      assertOneOf(request.operationClass, FABRIC_OPERATION_CLASSES, "operationClass");
      assertRequestedTtl(request.requestedTtlMs, "requestedTtlMs");
      if (request.pathCandidates === undefined || request.pathCandidates.length === 0) {
        throw new FabricContractError("invalid_argument", "route.open requires pathCandidates", "pathCandidates");
      }
      break;
    case "route.renew":
      requireId(request.routeId, "routeId");
      assertRevision(request.expectedRevision, "expectedRevision");
      assertRequestedTtl(request.requestedTtlMs, "requestedTtlMs");
      break;
    case "route.close":
      requireId(request.routeId, "routeId");
      break;
    case "device.list":
    case "workspace.list":
    case "endpoint.list":
      break;
  }
}

export function assertValidFabricControlResponse(input: unknown): asserts input is FabricControlResponseV1 {
  const response = requireRecord<FabricControlResponseV1>(input, "controlResponse");
  if (response.version !== FABRIC_CONTROL_VERSION) {
    throw new FabricContractError("unsupported_version", "Unsupported Fabric control version", "version");
  }
  assertFabricIdentifier(response.requestId, "requestId");
  assertOneOf(response.action, FABRIC_CONTROL_ACTIONS, "action");
  assertEpochMilliseconds(response.acceptedAt, "acceptedAt");
  assertJsonObject(response.result, "result");
}

export function assertValidFabricStoreEvent(input: unknown): asserts input is FabricStoreEventV1 {
  const event = requireRecord<FabricStoreEventV1>(input, "storeEvent");
  if (event.version !== FABRIC_STORE_EVENT_VERSION) {
    throw new FabricContractError("unsupported_version", "Unsupported Fabric store event version", "version");
  }
  assertFabricIdentifier(event.eventId, "eventId");
  assertOneOf(event.storeKind, FABRIC_STORE_KINDS, "storeKind");
  assertSafeIntegerAtLeast(event.sequence, 1, "sequence");
  assertFabricIdentifier(event.eventKind, "eventKind");
  assertFabricIdentifier(event.subjectId, "subjectId");
  assertRevision(event.subjectRevision, "subjectRevision");
  assertEpochMilliseconds(event.occurredAt, "occurredAt");
  assertJsonObject(event.payload, "payload");
}

export function assertValidFabricStoreTransaction(input: unknown): asserts input is FabricStoreTransactionV1 {
  const transaction = requireRecord<FabricStoreTransactionV1>(input, "storeTransaction");
  if (transaction.version !== FABRIC_STORE_TRANSACTION_VERSION) {
    throw new FabricContractError("unsupported_version", "Unsupported Fabric store transaction version", "version");
  }
  assertFabricIdentifier(transaction.transactionId, "transactionId");
  assertOneOf(transaction.storeKind, FABRIC_STORE_KINDS, "storeKind");
  assertRevision(transaction.expectedRevision, "expectedRevision");
  assertRevision(transaction.nextRevision, "nextRevision");
  if (transaction.nextRevision !== transaction.expectedRevision + 1) {
    throw new FabricContractError("conflict", "nextRevision must increment expectedRevision by one", "nextRevision");
  }
  assertEpochMilliseconds(transaction.committedAt, "committedAt");
  if (!Array.isArray(transaction.mutations) || transaction.mutations.length === 0 || transaction.mutations.length > 10_000) {
    throw new FabricContractError("invalid_argument", "mutations must contain 1-10000 entries", "mutations");
  }
  for (const [index, inputMutation] of transaction.mutations.entries()) {
    const mutation = requireRecord<FabricStoreTransactionV1["mutations"][number]>(inputMutation, `mutations[${index}]`);
    assertOneOf(mutation.kind, FABRIC_STORE_MUTATIONS, `mutations[${index}].kind`);
    assertFabricIdentifier(mutation.subjectId, `mutations[${index}].subjectId`);
    if (mutation.expectedRevision !== undefined) assertRevision(mutation.expectedRevision, `mutations[${index}].expectedRevision`);
    if (mutation.kind === "upsert") assertJsonObject(mutation.value, `mutations[${index}].value`);
    else if (mutation.value !== undefined) throw new FabricContractError("invalid_argument", "delete mutation cannot include value", `mutations[${index}].value`);
  }
  if (!Array.isArray(transaction.events) || transaction.events.length > 10_000) {
    throw new FabricContractError("invalid_argument", "events must be an array with at most 10000 entries", "events");
  }
  for (const [index, event] of transaction.events.entries()) {
    assertValidFabricStoreEvent(event);
    if (event.storeKind !== transaction.storeKind) {
      throw new FabricContractError("conflict", "Transaction events must use the transaction storeKind", `events[${index}].storeKind`);
    }
  }
}

export function assertValidFabricStoreCursor(input: unknown): asserts input is FabricStoreCursorV1 {
  const cursor = requireRecord<FabricStoreCursorV1>(input, "storeCursor");
  if (cursor.version !== FABRIC_STORE_CURSOR_VERSION) {
    throw new FabricContractError("unsupported_version", "Unsupported Fabric store cursor version", "version");
  }
  assertFabricIdentifier(cursor.consumerId, "consumerId");
  assertOneOf(cursor.storeKind, FABRIC_STORE_KINDS, "storeKind");
  assertSafeIntegerAtLeast(cursor.nextSequence, 1, "nextSequence");
  assertRevision(cursor.snapshotRevision, "snapshotRevision");
  assertEpochMilliseconds(cursor.updatedAt, "updatedAt");
}

export function migrateFabricPersistedStoreState(input: unknown): FabricPersistedStoreStateV1 {
  const state = requireRecord<Record<string, unknown>>(input, "storeState");
  if (state.shapeVersion !== undefined && state.shapeVersion !== FABRIC_STORE_SHAPE_VERSION) {
    throw new FabricContractError("unsupported_version", "Unsupported Fabric persisted store shape", "shapeVersion");
  }
  assertOneOf(state.storeKind, FABRIC_STORE_KINDS, "storeKind");
  assertRevision(state.revision, "revision");
  if (!Array.isArray(state.events)) throw new FabricContractError("invalid_argument", "events must be an array", "events");
  const events = state.events.map((event, index) => {
    assertValidFabricStoreEvent(event);
    if (event.storeKind !== state.storeKind) {
      throw new FabricContractError("conflict", "Persisted event storeKind mismatch", `events[${index}].storeKind`);
    }
    return event;
  });
  const cursorInputs: readonly unknown[] = state.shapeVersion === FABRIC_STORE_SHAPE_VERSION
    ? (() => {
        if (!Array.isArray(state.cursors)) throw new FabricContractError("invalid_argument", "cursors must be an array", "cursors");
        return state.cursors;
      })()
    : state.cursor === undefined ? [] : [state.cursor];
  const cursors = cursorInputs.map((cursor, index) => {
    assertValidFabricStoreCursor(cursor);
    if (cursor.storeKind !== state.storeKind) {
      throw new FabricContractError("conflict", "Persisted cursor storeKind mismatch", `cursors[${index}].storeKind`);
    }
    return cursor;
  });
  return { shapeVersion: FABRIC_STORE_SHAPE_VERSION, storeKind: state.storeKind, revision: state.revision, events: [...events], cursors: [...cursors] };
}

export function assertValidFabricMountLease(input: unknown, now?: number): asserts input is FabricMountLeaseV1 {
  const mount = requireRecord<FabricMountLeaseV1>(input, "mount");
  if (mount.version !== FABRIC_MOUNT_VERSION) throw new FabricContractError("unsupported_version", "Unsupported Fabric mount version", "version");
  for (const key of ["mountId", "sessionId", "routeId", "connectionId", "endpointId"] as const) assertFabricIdentifier(mount[key], key);
  assertRevision(mount.routeRevision, "routeRevision");
  if (mount.workspaceBindingId !== undefined) assertFabricIdentifier(mount.workspaceBindingId, "workspaceBindingId");
  assertGeneration(mount.connectionGeneration, "connectionGeneration");
  if (mount.workspaceGeneration !== undefined) assertGeneration(mount.workspaceGeneration, "workspaceGeneration");
  if ((mount.workspaceBindingId === undefined) !== (mount.workspaceGeneration === undefined)) {
    throw new FabricContractError("invalid_argument", "workspace binding and generation must appear together", "workspaceBindingId");
  }
  assertGeneration(mount.endpointGeneration, "endpointGeneration");
  assertFabricIdentifier(mount.providerNamespace, "providerNamespace");
  assertFabricIdentifier(mount.serverName, "serverName");
  assertOneOf(mount.transport, FABRIC_MCP_TRANSPORTS, "transport");
  assertEpochMilliseconds(mount.issuedAt, "issuedAt");
  assertEpochMilliseconds(mount.expiresAt, "expiresAt");
  if (mount.expiresAt <= mount.issuedAt) throw new FabricContractError("invalid_argument", "expiresAt must be after issuedAt", "expiresAt");
  assertOneOf(mount.state, FABRIC_MOUNT_STATES, "state");
  if (now !== undefined && mount.state !== "closed") assertUnexpired(mount.expiresAt, now, "expiresAt");
  assertRevision(mount.revision, "revision");
  if (mount.credentialRef !== undefined) assertBoundedString(mount.credentialRef, "credentialRef", 2_048);
}

export function assertValidQualifiedTaskReference(input: unknown): asserts input is QualifiedTaskReferenceV1 {
  const reference = requireRecord<QualifiedTaskReferenceV1>(input, "taskReference");
  assertOneOf(reference.authority, FABRIC_TASK_AUTHORITIES, "authority");
  assertFabricIdentifier(reference.workspaceId, "workspaceId");
  assertFabricIdentifier(reference.taskId, "taskId");
}

export function assertValidQualifiedTaskSnapshot(input: unknown): asserts input is QualifiedTaskSnapshotV1 {
  const snapshot = requireRecord<QualifiedTaskSnapshotV1>(input, "taskSnapshot");
  assertValidQualifiedTaskReference(snapshot.reference);
  assertBoundedString(snapshot.subject, "subject", 1_024);
  assertOneOf(snapshot.status, FABRIC_TASK_SNAPSHOT_STATUSES, "status");
  if (snapshot.summary !== undefined) assertBoundedString(snapshot.summary, "summary", 4_096, true);
  assertRevision(snapshot.revision, "revision");
  assertEpochMilliseconds(snapshot.capturedAt, "capturedAt");
  assertBoolean(snapshot.truncated, "truncated");
}

/** Read-boundary validator/projection for teammate Todo snapshots (spec:architecture-constraints-071). */
export function validateWorkspaceTodoSnapshot(input: unknown): QualifiedTaskSnapshotV1 {
  assertValidQualifiedTaskSnapshot(input);
  return {
    reference: { ...input.reference },
    subject: sanitizeFabricProjectionText(input.subject),
    status: input.status,
    summary: input.summary === undefined ? undefined : sanitizeFabricProjectionText(input.summary),
    revision: input.revision,
    capturedAt: input.capturedAt,
    truncated: input.truncated,
  };
}

export function assertValidTeammatePlacement(input: unknown, now?: number): asserts input is TeammatePlacementV1 {
  const placement = requireRecord<TeammatePlacementV1>(input, "placement");
  if (placement.version !== FABRIC_PLACEMENT_VERSION) throw new FabricContractError("unsupported_version", "Unsupported Fabric placement version", "version");
  for (const key of ["placementId", "routeId", "endpointId"] as const) assertFabricIdentifier(placement[key], key);
  if (placement.workspaceBindingId !== undefined) assertFabricIdentifier(placement.workspaceBindingId, "workspaceBindingId");
  assertGeneration(placement.connectionGeneration, "connectionGeneration");
  if (placement.workspaceGeneration !== undefined) assertGeneration(placement.workspaceGeneration, "workspaceGeneration");
  if ((placement.workspaceBindingId === undefined) !== (placement.workspaceGeneration === undefined)) {
    throw new FabricContractError("invalid_argument", "workspace binding and generation must appear together", "workspaceBindingId");
  }
  assertGeneration(placement.endpointGeneration, "endpointGeneration");
  if (placement.task !== undefined) assertValidQualifiedTaskReference(placement.task);
  if (placement.requestedModel !== undefined) assertBoundedString(placement.requestedModel, "requestedModel", 256);
  if (placement.requestedRole !== undefined) assertFabricIdentifier(placement.requestedRole, "requestedRole");
  if (placement.requestedTaskType !== undefined) assertFabricIdentifier(placement.requestedTaskType, "requestedTaskType");
  assertEpochMilliseconds(placement.deadlineAt, "deadlineAt");
  if (now !== undefined && placement.deadlineAt <= now) throw new FabricContractError("deadline_exceeded", "Placement deadline has passed", "deadlineAt");
}

export function assertValidFabricPlacementEvent(input: unknown): asserts input is FabricPlacementEventV1 {
  const event = requireRecord<FabricPlacementEventV1>(input, "placementEvent");
  if (event.version !== FABRIC_PLACEMENT_VERSION) throw new FabricContractError("unsupported_version", "Unsupported Fabric placement version", "version");
  assertFabricIdentifier(event.placementId, "placementId");
  assertSafeIntegerAtLeast(event.sequence, 1, "sequence");
  assertOneOf(event.kind, FABRIC_PLACEMENT_EVENT_KINDS, "kind");
  assertEpochMilliseconds(event.occurredAt, "occurredAt");
  assertJsonObject(event.payload, "payload");
}

export function assertValidFabricStreamFrame(input: unknown): asserts input is FabricStreamFrameV1 {
  const frame = requireRecord<FabricStreamFrameV1>(input, "streamFrame");
  if (frame.version !== FABRIC_STREAM_VERSION) throw new FabricContractError("unsupported_version", "Unsupported Fabric stream version", "version");
  for (const key of ["streamId", "routeId", "operationId"] as const) assertFabricIdentifier(frame[key], key);
  assertSafeIntegerAtLeast(frame.sequence, 0, "sequence");
  assertOneOf(frame.kind, FABRIC_STREAM_FRAME_KINDS, "kind");
  assertEpochMilliseconds(frame.sentAt, "sentAt");
  assertJsonObject(frame.payload, "payload");
}

export function assertValidFabricArtifactDescriptor(input: unknown, now?: number): asserts input is FabricArtifactDescriptorV1 {
  const artifact = requireRecord<FabricArtifactDescriptorV1>(input, "artifact");
  if (artifact.version !== FABRIC_ARTIFACT_VERSION) throw new FabricContractError("unsupported_version", "Unsupported Fabric artifact version", "version");
  for (const key of ["artifactId", "operationId", "routeId", "deviceId", "endpointId"] as const) assertFabricIdentifier(artifact[key], key);
  assertGeneration(artifact.connectionGeneration, "connectionGeneration");
  assertGeneration(artifact.endpointGeneration, "endpointGeneration");
  assertBoundedString(artifact.mediaType, "mediaType", 256);
  assertSafeIntegerAtLeast(artifact.byteLength, 0, "byteLength");
  assertBoundedString(artifact.digest, "digest", FABRIC_CONTRACT_HASH_MAX_BYTES);
  assertOneOf(artifact.storage, FABRIC_ARTIFACT_STORAGE, "storage");
  assertOneOf(artifact.state, FABRIC_ARTIFACT_STATES, "state");
  assertEpochMilliseconds(artifact.createdAt, "createdAt");
  assertEpochMilliseconds(artifact.expiresAt, "expiresAt");
  if (artifact.expiresAt <= artifact.createdAt) throw new FabricContractError("invalid_argument", "expiresAt must be after createdAt", "expiresAt");
  if (now !== undefined && !["expired", "revoked"].includes(artifact.state)) assertUnexpired(artifact.expiresAt, now, "expiresAt");
  if (artifact.metadata !== undefined) assertJsonObject(artifact.metadata, "metadata");
  if (artifact.sourceRef !== undefined) assertBoundedString(artifact.sourceRef, "sourceRef", 2_048);
}

export function assertValidFabricArtifactChunk(input: unknown): asserts input is FabricArtifactChunkV1 {
  const chunk = requireRecord<FabricArtifactChunkV1>(input, "artifactChunk");
  if (chunk.version !== FABRIC_ARTIFACT_VERSION) throw new FabricContractError("unsupported_version", "Unsupported Fabric artifact version", "version");
  assertFabricIdentifier(chunk.artifactId, "artifactId");
  assertSafeIntegerAtLeast(chunk.offset, 0, "offset");
  assertSafeIntegerAtLeast(chunk.byteLength, 0, "byteLength");
  if (chunk.byteLength > 1_048_576) throw new FabricContractError("resource_exhausted", "Artifact chunk exceeds 1048576 bytes", "byteLength");
  assertBoundedString(chunk.digest, "digest", FABRIC_CONTRACT_HASH_MAX_BYTES);
  assertBoundedString(chunk.encodedData, "encodedData", 1_398_104, true);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.encodedData)) {
    throw new FabricContractError("invalid_argument", "encodedData must be canonical base64", "encodedData");
  }
  assertBoolean(chunk.final, "final");
}

export function assertValidFabricRouteTicketClaims(input: unknown, now?: number): asserts input is FabricRouteTicketClaimsV1 {
  const claims = requireRecord<FabricRouteTicketClaimsV1>(input, "routeTicketClaims");
  if (claims.version !== FABRIC_ROUTE_TICKET_VERSION) throw new FabricContractError("unsupported_version", "Unsupported Fabric route ticket version", "version");
  for (const key of ["ticketId", "keyId", "subject", "audience", "routeId", "deviceId", "endpointId", "nonce"] as const) assertFabricIdentifier(claims[key], key);
  if (claims.workspaceBindingId !== undefined) assertFabricIdentifier(claims.workspaceBindingId, "workspaceBindingId");
  assertGeneration(claims.connectionGeneration, "connectionGeneration");
  if (claims.workspaceGeneration !== undefined) assertGeneration(claims.workspaceGeneration, "workspaceGeneration");
  if ((claims.workspaceBindingId === undefined) !== (claims.workspaceGeneration === undefined)) {
    throw new FabricContractError("invalid_argument", "workspace binding and generation must appear together", "workspaceBindingId");
  }
  assertGeneration(claims.endpointGeneration, "endpointGeneration");
  assertUniqueEnumList(claims.operationClasses, FABRIC_OPERATION_CLASSES, "operationClasses");
  if (claims.operationClasses.length === 0) throw new FabricContractError("invalid_argument", "operationClasses cannot be empty", "operationClasses");
  assertEpochMilliseconds(claims.issuedAt, "issuedAt");
  assertEpochMilliseconds(claims.expiresAt, "expiresAt");
  if (claims.expiresAt <= claims.issuedAt) throw new FabricContractError("invalid_argument", "expiresAt must be after issuedAt", "expiresAt");
  if (now !== undefined) assertUnexpired(claims.expiresAt, now, "expiresAt");
}

export function assertValidFabricRouteTicket(input: unknown, now?: number): asserts input is FabricRouteTicketV1 {
  const ticket = requireRecord<FabricRouteTicketV1>(input, "routeTicket");
  assertValidFabricRouteTicketClaims(ticket.claims, now);
  assertBoundedString(ticket.proof, "proof", 8_192);
  if (/[\u0000-\u001f\u007f]/u.test(ticket.proof)) throw new FabricContractError("invalid_argument", "proof contains control characters", "proof");
}
