import type { FabricTeammateRuntimePort } from "pi-maestro-teammate/v1/fabric-runtime";
import {
  FabricContractError,
  assertFabricIdentifier,
  assertValidEndpointRecord,
  assertValidWorkspaceRecord,
  type AgentRuntimeEndpoint,
  type EndpointRouteHandle,
  type JsonValue,
  type PublicWorkspaceRecord,
} from "pi-maestro-fabric-core/v1";
import type { GatewayPolicy } from "../policy.ts";
import { createGatewayPrincipal } from "../principal.ts";
import type { WorkspaceRegistry } from "../workspace-registry.ts";
import {
  FabricAgentEndpointBridge,
  type FabricAgentEndpointLimits,
} from "./agent-endpoint.ts";
import {
  GatewayFabricControlSupport,
  type GatewayFabricControlRuntime,
} from "./control-support.ts";
import type {
  FabricDeviceRelayExecutionContext,
  FabricDeviceRelayExecutionHandler,
} from "./hub-relay.ts";
import type {
  PreparedFabricConnectorInventory,
  PreparedFabricWorkspaceBinding,
} from "./connector-inventory.ts";

export interface FabricDeviceAgentRuntimeOptions {
  readonly prepared: PreparedFabricConnectorInventory;
  readonly registry: WorkspaceRegistry;
  readonly policy: GatewayPolicy;
  /** Exact daemon-owned port. This runtime never consults the process registry. */
  readonly runtime: FabricTeammateRuntimePort;
  /** Service/connection owner fence supplied by FabricConnectorService. */
  readonly assertCurrent?: (
    authority: FabricDeviceRelayExecutionContext["authority"],
    prepared: PreparedFabricConnectorInventory,
  ) => void | Promise<void>;
  readonly limits?: Partial<FabricAgentEndpointLimits>;
  readonly now?: () => number;
}

interface RouteReservation {
  readonly route: EndpointRouteHandle;
  refs: number;
}

function recordArray<T>(value: JsonValue | undefined, path: string): T[] {
  if (!Array.isArray(value)) throw new FabricContractError("invalid_state", `${path} is unavailable in the prepared advertisement`, path);
  return value as unknown as T[];
}

function sameRouteOwner(left: EndpointRouteHandle, right: EndpointRouteHandle): boolean {
  return left.routeId === right.routeId && left.connectionId === right.connectionId &&
    left.workspaceBindingId === right.workspaceBindingId && left.endpointId === right.endpointId &&
    left.connectionGeneration === right.connectionGeneration && left.workspaceGeneration === right.workspaceGeneration &&
    left.endpointGeneration === right.endpointGeneration && left.revision === right.revision;
}

/**
 * Device-side adapter from authenticated Hub relay authority to the existing
 * source Agent Endpoint bridge. All paths and principals are reconstructed from
 * the daemon's private inventory, registry, and policy.
 */
export class FabricDeviceAgentRuntime implements FabricDeviceRelayExecutionHandler {
  readonly prepared: PreparedFabricConnectorInventory;
  readonly bridge: FabricAgentEndpointBridge;
  readonly #options: FabricDeviceAgentRuntimeOptions;
  readonly #endpoints = new Map<string, AgentRuntimeEndpoint>();
  readonly #workspaces = new Map<string, PublicWorkspaceRecord>();
  readonly #bindings = new Map<string, PreparedFabricWorkspaceBinding>();
  readonly #routes = new Map<string, RouteReservation>();
  #generation = 1;
  #active = true;
  #closeOperation?: Promise<void>;

  constructor(options: FabricDeviceAgentRuntimeOptions) {
    if (!options.runtime || typeof options.runtime.startAttempt !== "function") {
      throw new FabricContractError("unavailable", "Device Agent runtime requires an explicit teammate runtime port", "runtime");
    }
    this.#options = options;
    this.prepared = options.prepared;
    const payload = options.prepared.advertisement.payload;
    const advertisedEndpoints = recordArray<unknown>(payload.endpoints, "advertisement.endpoints");
    const advertisedWorkspaces = recordArray<unknown>(payload.workspaces, "advertisement.workspaces");
    for (const candidate of advertisedWorkspaces) {
      assertValidWorkspaceRecord(candidate);
      this.#workspaces.set(candidate.workspaceId, structuredClone(candidate));
    }
    for (const candidate of advertisedEndpoints) {
      assertValidEndpointRecord(candidate);
      if (candidate.kind !== "agent") continue;
      if (candidate.connectorId !== options.prepared.connectorId || candidate.deviceId !== options.prepared.deviceId ||
        candidate.status !== "online" || candidate.scope.kind !== "workspace") {
        throw new FabricContractError("permission_denied", "Prepared executable Endpoint is foreign, offline, or not workspace-scoped", "endpointId");
      }
      this.#endpoints.set(candidate.endpointId, structuredClone(candidate));
    }
    for (const binding of options.prepared.workspaceBindings ?? []) {
      if (this.#bindings.has(binding.workspaceId)) {
        throw new FabricContractError("conflict", "Prepared inventory contains duplicate workspace mappings", "workspaceBindings");
      }
      this.#bindings.set(binding.workspaceId, structuredClone(binding));
    }
    if (this.#endpoints.size > 0 && options.prepared.source === undefined) {
      throw new FabricContractError("permission_denied", "Agent execution was advertised without proven source restrictions", "sourceRestrictions");
    }
    for (const endpoint of this.#endpoints.values()) {
      if (endpoint.scope.kind !== "workspace") throw new FabricContractError("permission_denied", "Agent Endpoint must be workspace-scoped");
      const workspace = this.#workspaces.get(endpoint.scope.workspaceId);
      const binding = this.#bindings.get(endpoint.scope.workspaceId);
      if (workspace === undefined || binding === undefined || !workspace.endpointIds.includes(endpoint.endpointId) ||
        workspace.deviceId !== options.prepared.deviceId || workspace.generation !== binding.workspaceGeneration ||
        endpoint.generation !== binding.workspaceGeneration) {
        throw new FabricContractError("stale_generation", "Prepared Agent Endpoint is not bound to an exact local workspace generation", "endpointGeneration");
      }
      const source = options.prepared.source!;
      if (endpoint.contractHash !== source.digest || endpoint.maxConcurrency > source.maxConcurrency ||
        endpoint.roles.some((role) => !source.roles.includes(role)) ||
        endpoint.taskTypes.some((taskType) => !source.taskTypes.includes(taskType)) ||
        endpoint.models.some((model) => !source.models.includes(model))) {
        throw new FabricContractError("permission_denied", "Prepared Agent Endpoint exceeds proven source restrictions", "endpointId");
      }
    }

    const controlRuntime = {
      directory: {
        getWorkspace: (workspaceId: string) => {
          const workspace = this.#workspaces.get(workspaceId);
          return workspace === undefined ? undefined : structuredClone(workspace);
        },
        getEndpoint: (endpointId: string) => {
          const endpoint = this.#endpoints.get(endpointId);
          return endpoint === undefined ? undefined : structuredClone(endpoint);
        },
      },
      admissions: {
        validateRoute: (routeId: string) => {
          this.#assertActive();
          const reservation = this.#routes.get(routeId);
          if (reservation === undefined) throw new FabricContractError("stale_generation", "Device relay route is no longer active", "routeId");
          return structuredClone(reservation.route);
        },
      },
      resolveLocalWorkspaceId: (workspaceId: string) => this.#bindings.get(workspaceId)?.localWorkspaceId,
      now: options.now ?? Date.now,
    } as unknown as GatewayFabricControlRuntime;
    const support = new GatewayFabricControlSupport(controlRuntime, options.policy, options.registry);
    this.bridge = new FabricAgentEndpointBridge({
      support,
      runtimeOf: () => this.#active ? options.runtime : undefined,
      ...(options.prepared.source === undefined ? {} : { sourceBackends: options.prepared.source.backends }),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  async handle(context: FabricDeviceRelayExecutionContext): Promise<JsonValue> {
    const generation = this.#generation;
    this.#assertActive(generation);
    await this.#assertOwner(context, generation);
    const endpoint = this.#requireEndpoint(context);
    const workspaceId = endpoint.scope.kind === "workspace" ? endpoint.scope.workspaceId : "";
    const workspace = this.#workspaces.get(workspaceId)!;
    const binding = this.#bindings.get(workspaceId)!;
    const local = await this.#options.registry.get(binding.localWorkspaceId);
    this.#assertActive(generation);
    await this.#assertOwner(context, generation);
    if (local === undefined || local.generation !== binding.localWorkspaceGeneration) {
      throw new FabricContractError("stale_generation", "Source-local workspace generation changed after advertisement", "workspaceGeneration");
    }
    const principal = createGatewayPrincipal("http", context.originSubject, {
      authenticated: true,
      workspaceId: local.id,
      scopes: ["fabric.data"],
      source: "fabric-device-relay",
    });
    const decision = await this.#options.policy.authorizeWorkspace(principal, local.id);
    this.#assertActive(generation);
    await this.#assertOwner(context, generation);
    if (!decision.allowed || decision.workspaceId !== local.id) {
      throw new FabricContractError("permission_denied", "Source-local workspace policy refused relay execution", "workspaceId");
    }

    const route: EndpointRouteHandle = {
      routeId: context.authority.routeId,
      connectionId: context.authority.connectionId,
      workspaceBindingId: context.authority.workspaceBindingId,
      endpointId: endpoint.endpointId,
      connectionGeneration: context.authority.connectionGeneration,
      workspaceGeneration: workspace.generation,
      endpointGeneration: endpoint.generation,
      issuedAt: Math.max(0, (this.#options.now ?? Date.now)() - 1),
      expiresAt: context.authority.deadlineAt,
      state: "open",
      revision: context.authority.routeRevision,
    };
    const reservation = this.#reserveRoute(route);
    try {
      const result = await this.bridge.handle({
        request: {
          version: "fabric.endpoint-request.v1",
          requestId: context.authority.requestId,
          routeId: route.routeId,
          endpointId: endpoint.endpointId,
          endpointKind: "agent",
          endpointGeneration: endpoint.generation,
          deadlineAt: context.authority.deadlineAt,
          operation: context.operation,
          input: structuredClone(context.input),
        },
        route,
        endpoint,
        principal,
        signal: context.signal,
      });
      this.#assertActive(generation);
      await this.#assertOwner(context, generation);
      this.#requireEndpoint(context);
      const currentLocal = await this.#options.registry.get(binding.localWorkspaceId);
      this.#assertActive(generation);
      await this.#assertOwner(context, generation);
      if (currentLocal === undefined || currentLocal.generation !== binding.localWorkspaceGeneration) {
        throw new FabricContractError("stale_generation", "Source-local workspace changed while relay execution awaited", "workspaceGeneration");
      }
      return result;
    } finally {
      this.#releaseRoute(route.routeId, reservation);
    }
  }

  close(): Promise<void> {
    if (this.#closeOperation !== undefined) return this.#closeOperation;
    this.#active = false;
    this.#generation += 1;
    this.#routes.clear();
    const operation = this.bridge.close();
    this.#closeOperation = operation;
    return operation;
  }

  #requireEndpoint(context: FabricDeviceRelayExecutionContext): AgentRuntimeEndpoint {
    const authority = context.authority;
    assertFabricIdentifier(context.originSubject, "originSubject");
    if (authority.connectorId !== this.prepared.connectorId || authority.deviceId !== this.prepared.deviceId) {
      throw new FabricContractError("permission_denied", "Relay authority belongs to another Connector or Device", "connectorId");
    }
    const endpoint = this.#endpoints.get(authority.endpointId);
    if (endpoint === undefined || endpoint.status !== "online" || endpoint.generation !== authority.endpointGeneration ||
      endpoint.connectorId !== authority.connectorId || endpoint.deviceId !== authority.deviceId || endpoint.scope.kind !== "workspace") {
      throw new FabricContractError("stale_generation", "Relay authority does not name the exact advertised online Agent Endpoint", "endpointGeneration");
    }
    const workspace = this.#workspaces.get(endpoint.scope.workspaceId);
    const binding = this.#bindings.get(endpoint.scope.workspaceId);
    if (workspace === undefined || binding === undefined || workspace.generation !== authority.workspaceGeneration ||
      binding.workspaceGeneration !== authority.workspaceGeneration || !workspace.endpointIds.includes(endpoint.endpointId)) {
      throw new FabricContractError("stale_generation", "Relay workspace authority is stale or foreign", "workspaceGeneration");
    }
    return structuredClone(endpoint);
  }

  async #assertOwner(context: FabricDeviceRelayExecutionContext, generation: number): Promise<void> {
    this.#assertActive(generation);
    await this.#options.assertCurrent?.(context.authority, this.prepared);
    this.#assertActive(generation);
  }

  #reserveRoute(route: EndpointRouteHandle): RouteReservation {
    const current = this.#routes.get(route.routeId);
    if (current !== undefined) {
      if (!sameRouteOwner(current.route, route)) {
        throw new FabricContractError("stale_generation", "Relay route identity changed during a concurrent operation", "routeId");
      }
      current.refs += 1;
      return current;
    }
    const reservation: RouteReservation = { route: structuredClone(route), refs: 1 };
    this.#routes.set(route.routeId, reservation);
    return reservation;
  }

  #releaseRoute(routeId: string, reservation: RouteReservation): void {
    if (this.#routes.get(routeId) !== reservation) return;
    reservation.refs -= 1;
    if (reservation.refs === 0) this.#routes.delete(routeId);
  }

  #assertActive(generation = this.#generation): void {
    if (!this.#active || generation !== this.#generation) {
      throw new FabricContractError("stale_generation", "Device Agent runtime owner is retired");
    }
  }

  get active(): boolean { return this.#active; }
  get generation(): number { return this.#generation; }
}

export function createFabricDeviceRelayHandler(options: FabricDeviceAgentRuntimeOptions): FabricDeviceAgentRuntime {
  return new FabricDeviceAgentRuntime(options);
}
