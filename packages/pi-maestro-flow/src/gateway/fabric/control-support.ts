import { randomUUID } from "node:crypto";
import {
  FABRIC_CONTROL_VERSION,
  FabricContractError,
  assertFabricIdentifier,
  assertValidFabricControlRequest,
  assertValidFabricControlResponse,
  type FabricControlRequestV1,
  type FabricControlResponseV1,
  type FabricProtocolLimits,
  type JsonValue,
  type PublicWorkspaceRecord,
} from "pi-maestro-fabric-core/v1";
import type {
  FabricAdmissionManager,
  FabricConnectionManager,
  FabricDirectory,
  FabricPresenceManager,
} from "pi-maestro-fabric";
import type { GatewayPrincipal, GatewayResult } from "../contracts.ts";
import type { GatewayPolicy } from "../policy.ts";
import { principalKey } from "../principal.ts";
import { gatewayError, gatewayOk } from "../result.ts";
import type { WorkspaceRegistry } from "../workspace-registry.ts";

export const GATEWAY_FABRIC_CONTROL_LIMITS: FabricProtocolLimits = Object.freeze({
  maxFrameBytes: 256 * 1024,
  maxInFlightOperations: 32,
  heartbeatIntervalMs: 10_000,
  heartbeatTimeoutMs: 30_000,
  maxAdvertisementItems: 1_024,
  maxResultBytes: 1024 * 1024,
});

export interface GatewayFabricControlRuntime {
  readonly directory: FabricDirectory;
  readonly connections: FabricConnectionManager;
  readonly admissions: FabricAdmissionManager;
  readonly presence?: FabricPresenceManager;
  readonly limits?: FabricProtocolLimits;
  readonly now?: () => number;
  readonly createId?: (kind: "binding" | "route") => string;
  /** Host-private mapping. Fabric public workspace records deliberately omit this identity. */
  readonly resolveLocalWorkspaceId?: (fabricWorkspaceId: string) => string | undefined | Promise<string | undefined>;
}

export interface GatewayFabricControlInput extends Record<string, unknown> {
  action: string;
  version?: unknown;
  requestId?: unknown;
  deadlineAt?: unknown;
}

export interface GatewayFabricAuthorizedWorkspace {
  readonly fabric: PublicWorkspaceRecord;
  readonly localWorkspaceId: string;
}

class GatewayFabricDisabledError extends Error {
  readonly code = "fabric_disabled";
  constructor() {
    super("Fabric control is disabled for this Gateway runtime");
    this.name = "GatewayFabricDisabledError";
  }
}

function errorCode(error: unknown): string {
  if (error instanceof FabricContractError) return error.code;
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return String((error as { code: string }).code);
  }
  return "fabric_control_failed";
}

function jsonRecord(value: Record<string, unknown>): Readonly<Record<string, JsonValue>> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new FabricContractError("protocol_violation", "Fabric control result is not JSON serializable");
  return JSON.parse(serialized) as Readonly<Record<string, JsonValue>>;
}

export class GatewayFabricControlSupport {
  constructor(
    readonly runtime: GatewayFabricControlRuntime | undefined,
    readonly policy: GatewayPolicy,
    readonly registry: WorkspaceRegistry,
  ) {}

  async execute(
    principal: GatewayPrincipal,
    namespace: "device" | "workspace" | "endpoint" | "route",
    input: GatewayFabricControlInput,
    perform: (runtime: GatewayFabricControlRuntime, request: FabricControlRequestV1) => Promise<Record<string, unknown>> | Record<string, unknown>,
  ): Promise<GatewayResult<FabricControlResponseV1>> {
    const requestId = typeof input.requestId === "string" && input.requestId.length > 0 ? input.requestId : randomUUID();
    const principalId = principalKey(principal);
    try {
      const runtime = this.requireRuntime();
      const request = {
        ...input,
        version: input.version,
        requestId,
        action: `${namespace}.${input.action}`,
      } as unknown as FabricControlRequestV1;
      assertValidFabricControlRequest(request, this.now(runtime));
      const performed = await perform(runtime, request);
      const acceptedAt = this.now(runtime);
      if (acceptedAt >= request.deadlineAt) {
        throw new FabricContractError("deadline_exceeded", "Fabric control operation completed after its deadline", "deadlineAt");
      }
      const response: FabricControlResponseV1 = {
        version: FABRIC_CONTROL_VERSION,
        requestId,
        action: request.action,
        acceptedAt,
        result: jsonRecord(performed),
      };
      assertValidFabricControlResponse(response);
      return gatewayOk(response, { requestId, principalId });
    } catch (error) {
      return gatewayError({
        code: errorCode(error),
        message: error instanceof Error ? error.message : String(error),
      }, { requestId, principalId }) as GatewayResult<FabricControlResponseV1>;
    }
  }

  requireRuntime(): GatewayFabricControlRuntime {
    if (this.runtime === undefined) throw new GatewayFabricDisabledError();
    return this.runtime;
  }

  now(runtime = this.requireRuntime()): number {
    return (runtime.now ?? Date.now)();
  }

  limits(runtime = this.requireRuntime()): FabricProtocolLimits {
    return runtime.limits ?? GATEWAY_FABRIC_CONTROL_LIMITS;
  }

  createId(kind: "binding" | "route", runtime = this.requireRuntime()): string {
    const id = runtime.createId?.(kind) ?? `${kind}-${randomUUID()}`;
    assertFabricIdentifier(id, `${kind}Id`);
    return id;
  }

  boundedExpiry(request: FabricControlRequestV1, ...ceilings: Array<number | undefined>): number {
    const runtime = this.requireRuntime();
    const now = this.now(runtime);
    const ttl = request.requestedTtlMs;
    if (ttl === undefined) throw new FabricContractError("invalid_argument", "requestedTtlMs is required", "requestedTtlMs");
    const expiry = Math.min(now + ttl, request.deadlineAt, ...ceilings.filter((value): value is number => value !== undefined));
    if (expiry <= now) throw new FabricContractError("deadline_exceeded", "Fabric control lease has no remaining lifetime", "deadlineAt");
    return expiry;
  }

  async authorizeWorkspace(principal: GatewayPrincipal, fabricWorkspaceId: string): Promise<GatewayFabricAuthorizedWorkspace> {
    const runtime = this.requireRuntime();
    assertFabricIdentifier(fabricWorkspaceId, "workspaceId");
    const fabric = runtime.directory.getWorkspace(fabricWorkspaceId);
    if (fabric === undefined) throw new FabricContractError("not_found", "Fabric workspace is not registered", "workspaceId");
    const localWorkspaceId = await runtime.resolveLocalWorkspaceId?.(fabricWorkspaceId);
    if (localWorkspaceId === undefined) {
      throw new FabricContractError("permission_denied", "Fabric workspace has no authorized local mapping", "workspaceId");
    }
    const local = await this.registry.get(localWorkspaceId);
    if (local === undefined) throw new FabricContractError("permission_denied", "Mapped local workspace is not registered", "workspaceId");
    const decision = await this.policy.authorizeWorkspace(principal, local.id);
    if (!decision.allowed) throw new FabricContractError("permission_denied", `Local workspace authorization failed: ${decision.reason}`, "workspaceId");
    return { fabric, localWorkspaceId: local.id };
  }

  async visibleWorkspace(principal: GatewayPrincipal, workspace: PublicWorkspaceRecord): Promise<boolean> {
    try {
      await this.authorizeWorkspace(principal, workspace.workspaceId);
      return true;
    } catch (error) {
      if (error instanceof FabricContractError && ["not_found", "permission_denied", "stale_generation"].includes(error.code)) return false;
      throw error;
    }
  }
}
