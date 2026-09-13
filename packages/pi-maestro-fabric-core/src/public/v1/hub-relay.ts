import {
  FABRIC_ERROR_CODES,
  FABRIC_PROTOCOL_VERSION,
  FabricContractError,
  assertBoundedString,
  assertEpochMilliseconds,
  assertFabricIdentifier,
  assertGeneration,
  assertRevision,
  utf8ByteLength,
  type FabricErrorCode,
  type JsonValue,
} from "./common.ts";
import type { FabricEnvelopeV1 } from "./protocol.ts";
import { assertValidTeammatePlacement } from "./validation.ts";
import {
  FABRIC_STREAM_VERSION,
  type FabricStreamFrameV1,
} from "./transport.ts";

/** Optional data-plane feature negotiated independently from the legacy Fabric envelope. */
export const FABRIC_HUB_RELAY_VERSION = "fabric.hub-relay.v1" as const;
export const FABRIC_HUB_RELAY_DIRECTIONS = ["hub-to-device", "device-to-hub"] as const;
export const FABRIC_HUB_RELAY_RECEIPT_KINDS = ["invoke_accepted", "cancel_delivered", "closed"] as const;
export const FABRIC_HUB_RELAY_AGENT_OPERATIONS = [
  "agent.start",
  "agent.send",
  "agent.abort",
  "agent.events",
  "agent.recover",
  "agent.reclaim",
] as const;

export type FabricHubRelayDirection = (typeof FABRIC_HUB_RELAY_DIRECTIONS)[number];
export type FabricHubRelayReceiptKind = (typeof FABRIC_HUB_RELAY_RECEIPT_KINDS)[number];
export type FabricHubRelayAgentOperation = (typeof FABRIC_HUB_RELAY_AGENT_OPERATIONS)[number];

/** Optional client_hello extension. Absence preserves inventory-only legacy behavior. */
export interface FabricHubRelayHelloExtensionV1 {
  readonly relayVersions: readonly string[];
}

/** Echoed only when both peers selected executable relay support. */
export interface FabricHubRelayAcceptedExtensionV1 {
  readonly relayVersion: typeof FABRIC_HUB_RELAY_VERSION;
  readonly hubRuntimeEpoch: string;
}

export interface FabricHubRelayAuthorityV1 {
  readonly version: typeof FABRIC_HUB_RELAY_VERSION;
  readonly hubRuntimeEpoch: string;
  readonly connectorId: string;
  readonly deviceId: string;
  readonly connectionId: string;
  readonly connectionGeneration: number;
  readonly routeId: string;
  readonly routeRevision: number;
  readonly workspaceBindingId: string;
  readonly workspaceGeneration: number;
  readonly endpointId: string;
  readonly endpointGeneration: number;
  readonly requestId: string;
  readonly correlationId: string;
  readonly operationId: string;
  readonly streamId: string;
  readonly sequence: number;
  readonly deadlineAt: number;
}

export interface FabricHubRelayInvokeV1 extends FabricHubRelayAuthorityV1 {
  readonly direction: "hub-to-device";
  readonly operation: FabricHubRelayAgentOperation;
  readonly originSubject: string;
  readonly input: Readonly<Record<string, JsonValue>>;
  readonly frame: FabricStreamFrameV1;
}

export interface FabricHubRelayStreamV1 extends FabricHubRelayAuthorityV1 {
  readonly direction: "device-to-hub";
  readonly frame: FabricStreamFrameV1;
}

export interface FabricHubRelayCancelV1 extends FabricHubRelayAuthorityV1 {
  readonly direction: "hub-to-device";
  readonly reason: string;
  readonly frame: FabricStreamFrameV1;
}

/** Transport-only evidence. It never represents Agent completion or reclamation. */
export interface FabricHubRelayReceiptV1 extends FabricHubRelayAuthorityV1 {
  readonly direction: "device-to-hub";
  readonly receiptKind: FabricHubRelayReceiptKind;
  readonly acceptedMessageId: string;
  readonly accepted: boolean;
  readonly code?: FabricErrorCode;
  readonly message?: string;
}

export type FabricHubRelayPayloadV1 =
  | FabricHubRelayInvokeV1
  | FabricHubRelayStreamV1
  | FabricHubRelayCancelV1
  | FabricHubRelayReceiptV1;

const AUTHORITY_KEYS = [
  "version", "direction", "hubRuntimeEpoch", "connectorId", "deviceId", "connectionId",
  "connectionGeneration", "routeId", "routeRevision", "workspaceBindingId", "workspaceGeneration",
  "endpointId", "endpointGeneration", "requestId", "correlationId", "operationId", "streamId",
  "sequence", "deadlineAt",
] as const;
const INVOKE_KEYS = [...AUTHORITY_KEYS, "operation", "originSubject", "input", "frame"] as const;
const STREAM_KEYS = [...AUTHORITY_KEYS, "frame"] as const;
const CANCEL_KEYS = [...AUTHORITY_KEYS, "reason", "frame"] as const;
const RECEIPT_KEYS = [...AUTHORITY_KEYS, "receiptKind", "acceptedMessageId", "accepted", "code", "message"] as const;
const FABRIC_AGENT_ATTEMPT_VERSION = "fabric.agent-attempt.v1" as const;
const AGENT_INPUT_KEYS: Readonly<Record<FabricHubRelayAgentOperation, readonly string[]>> = Object.freeze({
  "agent.start": ["version", "attemptId", "placement", "spec"],
  "agent.send": ["version", "attemptId", "placementId", "message", "mode"],
  "agent.abort": ["version", "attemptId", "placementId"],
  "agent.events": ["version", "attemptId", "placementId", "afterSequence", "limit"],
  "agent.recover": ["version", "attemptId", "placementId"],
  "agent.reclaim": ["version", "attemptId", "placementId"],
});
const PLACEMENT_KEYS = [
  "version", "placementId", "routeId", "workspaceBindingId", "endpointId", "connectionGeneration",
  "workspaceGeneration", "endpointGeneration", "task", "requestedModel", "requestedRole", "requestedTaskType", "deadlineAt",
] as const;
const RUN_SPEC_KEYS = ["agent", "task", "name", "context", "model", "thinking", "outputSchema"] as const;
const TASK_REFERENCE_KEYS = ["authority", "workspaceId", "taskId"] as const;
const LOCAL_AUTHORITY_KEYS = new Set([
  "cwd", "path", "localPath", "localWorkspacePath", "principal", "gatewayPrincipal",
  "callerPrincipal", "owner", "ownerId", "ownerToken", "principalToken", "authorization",
]);

function record(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FabricContractError("invalid_argument", `${path} must be an object`, path);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new FabricContractError("invalid_argument", `${path} must be a plain object`, path);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new FabricContractError("invalid_argument", `${path} contains an unsupported field`, `${path}.${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable) {
      throw new FabricContractError("invalid_argument", `${path}.${key} must be an enumerable data property`, `${path}.${key}`);
    }
  }
}

function safeSequence(value: unknown, minimum: number, path = "sequence"): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new FabricContractError("invalid_argument", `${path} must be a safe integer >= ${minimum}`, path);
  }
}

function strictJson(value: unknown, path: string, depth: number, budget: { nodes: number }): void {
  if (depth > 32 || ++budget.nodes > 10_000) throw new FabricContractError("resource_exhausted", `${path} exceeds JSON complexity limits`, path);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new FabricContractError("invalid_argument", `${path} must be a finite JSON number`, path);
    return;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).some((key) => key !== "length" &&
      (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length))) {
      throw new FabricContractError("invalid_argument", `${path} must be a plain JSON array`, path);
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new FabricContractError("invalid_argument", `${path} cannot contain sparse entries`, `${path}[${index}]`);
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable) {
        throw new FabricContractError("invalid_argument", `${path}[${index}] must be an enumerable data property`, `${path}[${index}]`);
      }
      strictJson(descriptor.value, `${path}[${index}]`, depth + 1, budget);
    }
    return;
  }
  const candidate = record(value, path);
  for (const key of Reflect.ownKeys(candidate)) {
    if (typeof key !== "string" || key === "toJSON") throw new FabricContractError("invalid_argument", `${path} contains a non-JSON property`, path);
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (!descriptor || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable) {
      throw new FabricContractError("invalid_argument", `${path}.${key} must be an enumerable data property`, `${path}.${key}`);
    }
    strictJson(descriptor.value, `${path}.${key}`, depth + 1, budget);
  }
}

function jsonRecord(value: unknown, path: string): asserts value is Readonly<Record<string, JsonValue>> {
  const candidate = record(value, path);
  strictJson(candidate, path, 0, { nodes: 0 });
  const serialized = JSON.stringify(candidate);
  if (utf8ByteLength(serialized) > 65_536) {
    throw new FabricContractError("resource_exhausted", `${path} exceeds 65536 bytes`, path);
  }
}

function optionalSafeInteger(value: unknown, minimum: number, path: string): void {
  if (value !== undefined) safeSequence(value, minimum, path);
}

/**
 * Strict per-operation relay input projection. Only opaque Agent protocol data
 * is admitted; host paths, principals, owner tokens, and caller authority
 * objects have no representable field on this boundary.
 */
export function assertValidFabricHubRelayAgentInput(
  input: unknown,
  operation: FabricHubRelayAgentOperation,
  deadlineAt?: number,
): asserts input is Readonly<Record<string, JsonValue>> {
  const value = record(input, "input");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "string" && LOCAL_AUTHORITY_KEYS.has(key)) {
      throw new FabricContractError("permission_denied", "input cannot carry host-local or caller authority", `input.${key}`);
    }
  }
  exactKeys(value, AGENT_INPUT_KEYS[operation], "input");
  strictJson(value, "input", 0, { nodes: 0 });
  const serialized = JSON.stringify(value);
  if (utf8ByteLength(serialized) > 65_536) {
    throw new FabricContractError("resource_exhausted", "input exceeds 65536 bytes", "input");
  }
  if (value.version !== FABRIC_AGENT_ATTEMPT_VERSION) {
    throw new FabricContractError("unsupported_version", "Unsupported Fabric Agent attempt version", "input.version");
  }
  assertFabricIdentifier(value.attemptId, "input.attemptId");

  if (operation === "agent.start") {
    const placement = record(value.placement, "input.placement");
    exactKeys(placement, PLACEMENT_KEYS, "input.placement");
    if (placement.task !== undefined) exactKeys(record(placement.task, "input.placement.task"), TASK_REFERENCE_KEYS, "input.placement.task");
    assertValidTeammatePlacement(placement);
    if (deadlineAt !== undefined && placement.deadlineAt !== deadlineAt) {
      throw new FabricContractError("conflict", "Agent start placement deadline does not match relay authority", "input.placement.deadlineAt");
    }
    const spec = record(value.spec, "input.spec");
    exactKeys(spec, RUN_SPEC_KEYS, "input.spec");
    assertFabricIdentifier(spec.agent, "input.spec.agent");
    assertBoundedString(spec.task, "input.spec.task", 65_536, true);
    if (spec.name !== undefined) assertFabricIdentifier(spec.name, "input.spec.name");
    if (spec.context !== undefined) oneOf(spec.context, ["fresh", "fork"] as const, "input.spec.context");
    if (spec.model !== undefined) assertBoundedString(spec.model, "input.spec.model", 256);
    if (spec.thinking !== undefined) oneOf(spec.thinking, ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, "input.spec.thinking");
    if (spec.outputSchema !== undefined) record(spec.outputSchema, "input.spec.outputSchema");
    return;
  }

  assertFabricIdentifier(value.placementId, "input.placementId");
  if (operation === "agent.send") {
    assertBoundedString(value.message, "input.message", 65_536, true);
    oneOf(value.mode, ["prompt", "follow_up", "steer"] as const, "input.mode");
  } else if (operation === "agent.events") {
    optionalSafeInteger(value.afterSequence, 0, "input.afterSequence");
    optionalSafeInteger(value.limit, 1, "input.limit");
  }
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], path: string): asserts value is T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new FabricContractError("invalid_argument", `${path} has an unsupported value`, path);
  }
}

function validateAuthority(value: Readonly<Record<string, unknown>>): void {
  if (value.version !== FABRIC_HUB_RELAY_VERSION) {
    throw new FabricContractError("unsupported_version", "Unsupported Fabric Hub relay version", "version");
  }
  for (const key of [
    "hubRuntimeEpoch", "connectorId", "deviceId", "connectionId", "routeId", "workspaceBindingId",
    "endpointId", "requestId", "correlationId", "operationId", "streamId",
  ] as const) assertFabricIdentifier(value[key], key);
  assertGeneration(value.connectionGeneration, "connectionGeneration");
  assertRevision(value.routeRevision, "routeRevision");
  assertGeneration(value.workspaceGeneration, "workspaceGeneration");
  assertGeneration(value.endpointGeneration, "endpointGeneration");
  safeSequence(value.sequence, 0);
  assertEpochMilliseconds(value.deadlineAt, "deadlineAt");
}

function validateFrame(value: Readonly<Record<string, unknown>>, allowedKinds: readonly FabricStreamFrameV1["kind"][]): FabricStreamFrameV1 {
  const candidate = record(value.frame, "frame");
  exactKeys(candidate, ["version", "streamId", "routeId", "operationId", "sequence", "kind", "sentAt", "payload"], "frame");
  if (candidate.version !== FABRIC_STREAM_VERSION) throw new FabricContractError("unsupported_version", "Unsupported Fabric stream version", "frame.version");
  const streamId = candidate.streamId;
  const routeId = candidate.routeId;
  const operationId = candidate.operationId;
  assertFabricIdentifier(streamId, "frame.streamId");
  assertFabricIdentifier(routeId, "frame.routeId");
  assertFabricIdentifier(operationId, "frame.operationId");
  safeSequence(candidate.sequence, 0, "frame.sequence");
  oneOf(candidate.kind, allowedKinds, "frame.kind");
  assertEpochMilliseconds(candidate.sentAt, "frame.sentAt");
  jsonRecord(candidate.payload, "frame.payload");
  if (streamId !== value.streamId || routeId !== value.routeId ||
    operationId !== value.operationId || candidate.sequence !== value.sequence) {
    throw new FabricContractError("conflict", "Relay frame correlation does not match its authority tuple", "frame");
  }
  return {
    version: FABRIC_STREAM_VERSION,
    streamId,
    routeId,
    operationId,
    sequence: candidate.sequence,
    kind: candidate.kind,
    sentAt: candidate.sentAt,
    payload: candidate.payload,
  };
}

export function assertValidFabricHubRelayVersions(value: unknown, path = "relayVersions"): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new FabricContractError("invalid_argument", `${path} must be an array with at most 8 entries`, path);
  }
  const seen = new Set<string>();
  for (const [index, version] of value.entries()) {
    assertBoundedString(version, `${path}[${index}]`, 64);
    if (seen.has(version)) throw new FabricContractError("conflict", `${path} contains a duplicate`, `${path}[${index}]`);
    seen.add(version);
  }
}

export function assertValidFabricHubRelayPayload(input: unknown, kind: FabricEnvelopeV1["kind"]): asserts input is FabricHubRelayPayloadV1 {
  const value = record(input, "relay");
  validateAuthority(value);
  switch (kind) {
    case "invoke":
      exactKeys(value, INVOKE_KEYS, "relay");
      if (value.direction !== "hub-to-device") throw new FabricContractError("protocol_violation", "Relay invoke direction is invalid", "direction");
      oneOf(value.operation, FABRIC_HUB_RELAY_AGENT_OPERATIONS, "operation");
      assertFabricIdentifier(value.originSubject, "originSubject");
      jsonRecord(value.input, "input");
      assertValidFabricHubRelayAgentInput(value.input, value.operation, value.deadlineAt as number);
      safeSequence(value.sequence, 0);
      if (value.sequence !== 0) throw new FabricContractError("protocol_violation", "Relay invoke must use sequence zero", "sequence");
      const open = validateFrame(value, ["open"]);
      if (open.kind !== "open") throw new FabricContractError("protocol_violation", "Relay invoke must carry an open frame", "frame.kind");
      const openPayload = record(open.payload, "frame.payload");
      exactKeys(openPayload, ["operation", "input"], "frame.payload");
      if (openPayload.operation !== value.operation || JSON.stringify(openPayload.input) !== JSON.stringify(value.input)) {
        throw new FabricContractError("conflict", "Relay invoke open frame does not match its operation input", "frame.payload");
      }
      return;
    case "stream":
      exactKeys(value, STREAM_KEYS, "relay");
      if (value.direction !== "device-to-hub") throw new FabricContractError("protocol_violation", "Relay stream direction is invalid", "direction");
      validateFrame(value, ["ack", "data", "end", "error"]);
      return;
    case "cancel":
      exactKeys(value, CANCEL_KEYS, "relay");
      if (value.direction !== "hub-to-device") throw new FabricContractError("protocol_violation", "Relay cancel direction is invalid", "direction");
      safeSequence(value.sequence, 1);
      assertBoundedString(value.reason, "reason", 512);
      validateFrame(value, ["cancel"]);
      return;
    case "receipt":
      exactKeys(value, RECEIPT_KEYS, "relay");
      if (value.direction !== "device-to-hub") throw new FabricContractError("protocol_violation", "Relay receipt direction is invalid", "direction");
      oneOf(value.receiptKind, FABRIC_HUB_RELAY_RECEIPT_KINDS, "receiptKind");
      assertFabricIdentifier(value.acceptedMessageId, "acceptedMessageId");
      if (typeof value.accepted !== "boolean") throw new FabricContractError("invalid_argument", "accepted must be a boolean", "accepted");
      if (value.code !== undefined) oneOf(value.code, FABRIC_ERROR_CODES, "code");
      if (value.message !== undefined) assertBoundedString(value.message, "message", 512, true);
      return;
    default:
      throw new FabricContractError("invalid_argument", "Envelope kind is not a Hub relay payload", "kind");
  }
}

export function assertValidFabricHubRelayEnvelope(input: unknown): asserts input is FabricEnvelopeV1 & { payload: FabricHubRelayPayloadV1 } {
  const envelope = record(input, "envelope");
  exactKeys(envelope, ["version", "messageId", "kind", "sentAt", "connectionId", "connectionGeneration", "correlationId", "operationId", "deadlineAt", "payload"], "envelope");
  if (envelope.version !== FABRIC_PROTOCOL_VERSION) throw new FabricContractError("unsupported_version", "Unsupported Fabric protocol version", "version");
  assertFabricIdentifier(envelope.messageId, "messageId");
  assertEpochMilliseconds(envelope.sentAt, "sentAt");
  if (envelope.kind !== "invoke" && envelope.kind !== "stream" && envelope.kind !== "cancel" && envelope.kind !== "receipt") {
    throw new FabricContractError("invalid_argument", "Envelope does not contain a Hub relay message", "kind");
  }
  assertValidFabricHubRelayPayload(envelope.payload, envelope.kind);
  const payload = envelope.payload;
  if (envelope.connectionId !== payload.connectionId || envelope.connectionGeneration !== payload.connectionGeneration ||
    envelope.correlationId !== payload.correlationId || envelope.operationId !== payload.operationId ||
    envelope.deadlineAt !== payload.deadlineAt) {
    throw new FabricContractError("conflict", "Relay envelope metadata does not match its payload authority", "envelope");
  }
}
