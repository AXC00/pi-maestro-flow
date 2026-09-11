export const FABRIC_PROTOCOL_VERSION = "fabric.v1" as const;

export const FABRIC_IDENTIFIER_MAX_LENGTH = 128;
export const FABRIC_LABEL_MAX_BYTES = 256;
export const FABRIC_CONTRACT_HASH_MAX_BYTES = 256;
export const FABRIC_ERROR_MESSAGE_MAX_BYTES = 1_024;

export type ConnectorId = string;
export type DeviceId = string;
export type ConnectionId = string;
export type WorkspaceId = string;
export type WorkspaceBindingId = string;
export type EndpointId = string;
export type CapabilityId = string;
export type RouteId = string;
export type OperationId = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];

export const FABRIC_ERROR_CODES = [
  "invalid_argument",
  "unsupported_version",
  "unauthenticated",
  "permission_denied",
  "not_found",
  "conflict",
  "stale_generation",
  "invalid_state",
  "expired",
  "resource_exhausted",
  "deadline_exceeded",
  "cancelled",
  "outcome_unknown",
  "unavailable",
  "protocol_violation",
] as const;

export type FabricErrorCode = (typeof FABRIC_ERROR_CODES)[number];

export interface FabricValidationIssue {
  code: FabricErrorCode;
  message: string;
  path?: string;
}

export class FabricContractError extends Error {
  readonly code: FabricErrorCode;
  readonly path?: string;

  constructor(code: FabricErrorCode, message: string, path?: string) {
    super(message);
    this.name = "FabricContractError";
    this.code = code;
    this.path = path;
  }
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

export function assertFabricIdentifier(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new FabricContractError(
      "invalid_argument",
      `${path} must be 1-${FABRIC_IDENTIFIER_MAX_LENGTH} characters using letters, digits, '.', '_', ':' or '-'`,
      path,
    );
  }
}

export function assertBoundedString(
  value: unknown,
  path: string,
  maxBytes: number,
  allowEmpty = false,
): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || utf8ByteLength(value) > maxBytes) {
    throw new FabricContractError(
      "invalid_argument",
      `${path} must be ${allowEmpty ? "at most" : "between 1 and"} ${maxBytes} UTF-8 bytes`,
      path,
    );
  }
}

export function assertGeneration(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new FabricContractError("invalid_argument", `${path} must be a positive safe integer`, path);
  }
}

export function assertRevision(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new FabricContractError("invalid_argument", `${path} must be a non-negative safe integer`, path);
  }
}

export function assertEpochMilliseconds(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new FabricContractError("invalid_argument", `${path} must be non-negative Unix epoch milliseconds`, path);
  }
}

export function assertUnexpired(expiresAt: number, now: number, path: string): void {
  assertEpochMilliseconds(now, "now");
  assertEpochMilliseconds(expiresAt, path);
  if (expiresAt <= now) {
    throw new FabricContractError("expired", `${path} is expired`, path);
  }
}
