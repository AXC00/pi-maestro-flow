import {
  FABRIC_MOUNT_VERSION,
  FabricContractError,
  assertFabricIdentifier,
  assertValidEndpointRouteHandle,
  assertValidFabricMountLease,
  projectFabricMount,
  type EndpointRecord,
  type EndpointRouteHandle,
  type FabricMountLeaseV1,
  type PublicConnectionLease,
  type PublicFabricMountLeaseV1,
  type WorkspaceBinding,
} from "pi-maestro-fabric-core/v1";

export interface FabricMcpMountRouteAuthority {
  validateRoute(routeId: string): EndpointRouteHandle;
  validateBinding?(bindingId: string): WorkspaceBinding;
}

export interface FabricMcpMountConnectionAuthority {
  requireReadyForDevice(connectionId: string, expectedGeneration: number, deviceId: string): PublicConnectionLease;
}

export interface FabricMcpMountEndpointDirectory {
  getEndpoint(endpointId: string): EndpointRecord | undefined;
}

export interface FabricMcpMountProviderOptions {
  sessionId: string;
  routes: FabricMcpMountRouteAuthority;
  connections: FabricMcpMountConnectionAuthority;
  endpoints: FabricMcpMountEndpointDirectory;
  now?: () => number;
  createMountId?: () => string;
  credentialRef?: (route: EndpointRouteHandle, endpoint: Extract<EndpointRecord, { kind: "mcp" }>) => string | undefined;
  terminalCapacity?: number;
}

interface ManagedMount {
  lease: FabricMountLeaseV1;
  tupleKey: string;
  references: number;
  unmounting?: Promise<void>;
}

export type FabricMcpMountCleanup = (lease: PublicFabricMountLeaseV1) => void | Promise<void>;

function routeTupleKey(sessionId: string, route: EndpointRouteHandle): string {
  return [
    sessionId,
    route.routeId,
    route.revision,
    route.connectionId,
    route.connectionGeneration,
    route.workspaceBindingId ?? "",
    route.workspaceGeneration ?? "",
    route.endpointId,
    route.endpointGeneration,
  ].join("\u0000");
}

function sameRoute(left: EndpointRouteHandle, right: EndpointRouteHandle): boolean {
  return left.routeId === right.routeId
    && left.revision === right.revision
    && left.connectionId === right.connectionId
    && left.connectionGeneration === right.connectionGeneration
    && left.workspaceBindingId === right.workspaceBindingId
    && left.workspaceGeneration === right.workspaceGeneration
    && left.endpointId === right.endpointId
    && left.endpointGeneration === right.endpointGeneration
    && left.expiresAt === right.expiresAt
    && left.state === right.state
    && left.deviceId === right.deviceId
    && left.operationClass === right.operationClass
    && left.selectedPath === right.selectedPath;
}

/**
 * Session-scoped authority for route-bound MCP mount descriptors. The host owns
 * transport credentials and the MCP adapter owns the inner client lifecycle.
 */
export class FabricMcpMountProvider {
  readonly #sessionId: string;
  readonly #routes: FabricMcpMountRouteAuthority;
  readonly #connections: FabricMcpMountConnectionAuthority;
  readonly #endpoints: FabricMcpMountEndpointDirectory;
  readonly #now: () => number;
  readonly #createMountId: () => string;
  readonly #credentialRef?: FabricMcpMountProviderOptions["credentialRef"];
  readonly #terminalCapacity: number;
  readonly #byId = new Map<string, ManagedMount>();
  readonly #byTuple = new Map<string, ManagedMount>();
  readonly #byRoute = new Map<string, ManagedMount>();

  constructor(options: FabricMcpMountProviderOptions) {
    assertFabricIdentifier(options.sessionId, "sessionId");
    const terminalCapacity = options.terminalCapacity ?? 256;
    if (!Number.isSafeInteger(terminalCapacity) || terminalCapacity < 0) {
      throw new FabricContractError("invalid_argument", "terminalCapacity must be a non-negative safe integer", "terminalCapacity");
    }
    this.#sessionId = options.sessionId;
    this.#routes = options.routes;
    this.#connections = options.connections;
    this.#endpoints = options.endpoints;
    this.#now = options.now ?? Date.now;
    this.#createMountId = options.createMountId ?? (() => `mount-${crypto.randomUUID()}`);
    this.#credentialRef = options.credentialRef;
    this.#terminalCapacity = terminalCapacity;
  }

  async mount(route: EndpointRouteHandle, signal: AbortSignal): Promise<FabricMountLeaseV1> {
    if (signal.aborted) throw new FabricContractError("cancelled", "Fabric MCP mount was cancelled");
    const { current, endpoint } = this.#validateRoute(route);
    const tupleKey = routeTupleKey(this.#sessionId, current);
    const existing = this.#byTuple.get(tupleKey);
    if (existing !== undefined) {
      this.#validateMount(existing.lease.mountId, current.revision);
      existing.references += 1;
      return structuredClone(existing.lease);
    }
    const routeOwner = this.#byRoute.get(current.routeId);
    if (routeOwner !== undefined && routeOwner.lease.state !== "closed") {
      throw new FabricContractError("conflict", "Fabric MCP route already has a different active mount tuple", "routeId");
    }

    const mountId = this.#createMountId();
    assertFabricIdentifier(mountId, "mountId");
    if (this.#byId.has(mountId)) throw new FabricContractError("conflict", "Fabric MCP mount identity already exists", "mountId");
    const projectionOwner = current.workspaceBindingId ?? current.connectionId;
    const now = this.#now();
    const credentialRef = this.#credentialRef?.(current, endpoint);
    const lease: FabricMountLeaseV1 = {
      version: FABRIC_MOUNT_VERSION,
      mountId,
      sessionId: this.#sessionId,
      routeId: current.routeId,
      routeRevision: current.revision,
      connectionId: current.connectionId,
      ...(current.workspaceBindingId === undefined ? {} : {
        workspaceBindingId: current.workspaceBindingId,
        workspaceGeneration: current.workspaceGeneration,
      }),
      endpointId: current.endpointId,
      connectionGeneration: current.connectionGeneration,
      endpointGeneration: current.endpointGeneration,
      providerNamespace: "fabric",
      serverName: `route:${projectionOwner}:${current.endpointId}`,
      transport: endpoint.transport,
      issuedAt: now,
      expiresAt: current.expiresAt,
      state: "active",
      revision: 1,
      ...(credentialRef === undefined ? {} : { credentialRef }),
    };
    assertValidFabricMountLease(lease, now);
    if (signal.aborted) throw new FabricContractError("cancelled", "Fabric MCP mount was cancelled");
    this.#validateRoute(current);
    const managed: ManagedMount = { lease, tupleKey, references: 1 };
    this.#byId.set(mountId, managed);
    this.#byTuple.set(tupleKey, managed);
    this.#byRoute.set(current.routeId, managed);
    return structuredClone(lease);
  }

  async validate(mountId: string, expectedRouteRevision: number): Promise<FabricMountLeaseV1> {
    return this.#validateMount(mountId, expectedRouteRevision);
  }

  async unmount(mountId: string, cleanup?: FabricMcpMountCleanup): Promise<void> {
    assertFabricIdentifier(mountId, "mountId");
    const managed = this.#byId.get(mountId);
    if (managed === undefined || managed.lease.state === "closed") return;
    if (managed.unmounting !== undefined) return managed.unmounting;
    if (managed.references > 1) {
      managed.references -= 1;
      return;
    }
    managed.references = 0;
    this.#byTuple.delete(managed.tupleKey);
    managed.lease = { ...managed.lease, state: "revoking", revision: managed.lease.revision + 1 };
    const operation = Promise.resolve().then(async () => {
      let failure: unknown;
      try {
        await cleanup?.(projectFabricMount(managed.lease));
      } catch (error) {
        failure = error;
      } finally {
        managed.lease = { ...managed.lease, state: "closed", revision: managed.lease.revision + 1 };
        if (this.#byRoute.get(managed.lease.routeId) === managed) this.#byRoute.delete(managed.lease.routeId);
        this.#compactTerminals();
      }
      if (failure !== undefined) throw failure;
    });
    managed.unmounting = operation.finally(() => { managed.unmounting = undefined; });
    return managed.unmounting;
  }

  get(mountId: string): PublicFabricMountLeaseV1 | undefined {
    const managed = this.#byId.get(mountId);
    return managed === undefined ? undefined : projectFabricMount(managed.lease);
  }

  list(): readonly PublicFabricMountLeaseV1[] {
    return [...this.#byId.values()]
      .map((managed) => projectFabricMount(managed.lease))
      .sort((left, right) => left.mountId.localeCompare(right.mountId));
  }

  getReferenceCount(mountId: string): number {
    return this.#byId.get(mountId)?.references ?? 0;
  }

  async closeAll(cleanup?: FabricMcpMountCleanup): Promise<void> {
    const active = [...this.#byId.values()].filter((managed) => managed.lease.state !== "closed");
    const results = await Promise.allSettled(active.map(async (managed) => {
      managed.references = 1;
      await this.unmount(managed.lease.mountId, cleanup);
    }));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure !== undefined) throw failure.reason;
  }

  #validateMount(mountId: string, expectedRouteRevision: number): FabricMountLeaseV1 {
    assertFabricIdentifier(mountId, "mountId");
    if (!Number.isSafeInteger(expectedRouteRevision) || expectedRouteRevision < 0) {
      throw new FabricContractError("invalid_argument", "expectedRouteRevision must be a non-negative safe integer", "expectedRouteRevision");
    }
    const managed = this.#byId.get(mountId);
    if (managed === undefined) throw new FabricContractError("not_found", "Fabric MCP mount is not known", "mountId");
    const lease = managed.lease;
    if (lease.state !== "active" || managed.references < 1) {
      throw new FabricContractError("stale_generation", "Fabric MCP mount is no longer active", "mountId");
    }
    if (lease.sessionId !== this.#sessionId || lease.routeRevision !== expectedRouteRevision) {
      throw new FabricContractError("stale_generation", "Fabric MCP mount route revision is stale", "routeRevision");
    }
    assertValidFabricMountLease(lease, this.#now());
    const current = this.#routes.validateRoute(lease.routeId);
    const expected: EndpointRouteHandle = {
      routeId: lease.routeId,
      revision: lease.routeRevision,
      connectionId: lease.connectionId,
      connectionGeneration: lease.connectionGeneration,
      ...(lease.workspaceBindingId === undefined ? {} : {
        workspaceBindingId: lease.workspaceBindingId,
        workspaceGeneration: lease.workspaceGeneration,
      }),
      endpointId: lease.endpointId,
      endpointGeneration: lease.endpointGeneration,
      issuedAt: current.issuedAt,
      expiresAt: lease.expiresAt,
      state: "open",
      deviceId: current.deviceId,
      operationClass: current.operationClass,
      pathCandidates: current.pathCandidates,
      selectedPath: current.selectedPath,
    };
    if (!sameRoute(current, expected)) throw new FabricContractError("stale_generation", "Fabric MCP mount route identity is stale", "routeId");
    this.#validateRoute(current);
    return structuredClone(lease);
  }

  #validateRoute(route: EndpointRouteHandle): {
    current: EndpointRouteHandle;
    endpoint: Extract<EndpointRecord, { kind: "mcp" }>;
  } {
    const now = this.#now();
    assertValidEndpointRouteHandle(route, now);
    if (route.state !== "open") throw new FabricContractError("invalid_state", "Fabric MCP mount requires an open route", "state");
    if (route.operationClass !== "mcp-read" && route.operationClass !== "mcp-mutation") {
      throw new FabricContractError("permission_denied", "Fabric route is not admitted for MCP operations", "operationClass");
    }
    const current = this.#routes.validateRoute(route.routeId);
    if (!sameRoute(current, route)) throw new FabricContractError("stale_generation", "Fabric MCP route is no longer current", "routeId");
    const endpoint = this.#endpoints.getEndpoint(current.endpointId);
    if (endpoint === undefined) throw new FabricContractError("not_found", "Fabric MCP Endpoint is not registered", "endpointId");
    if (endpoint.kind !== "mcp") throw new FabricContractError("conflict", "Fabric route does not select an MCP Endpoint", "endpointId");
    if (endpoint.generation !== current.endpointGeneration) throw new FabricContractError("stale_generation", "Fabric MCP Endpoint generation is stale", "endpointGeneration");
    if (endpoint.status !== "online") throw new FabricContractError("unavailable", "Fabric MCP Endpoint is not online", "endpointId");
    if (current.deviceId !== undefined && current.deviceId !== endpoint.deviceId) {
      throw new FabricContractError("conflict", "Fabric MCP route Device identity is inconsistent", "deviceId");
    }
    this.#connections.requireReadyForDevice(current.connectionId, current.connectionGeneration, endpoint.deviceId);
    if (current.workspaceBindingId !== undefined) {
      const binding = this.#routes.validateBinding?.(current.workspaceBindingId);
      if (binding === undefined) throw new FabricContractError("permission_denied", "Fabric MCP route binding cannot be validated", "workspaceBindingId");
      if (
        endpoint.scope.kind !== "workspace"
        || binding.workspaceId !== endpoint.scope.workspaceId
        || binding.deviceId !== endpoint.deviceId
        || binding.connectionId !== current.connectionId
        || binding.connectionGeneration !== current.connectionGeneration
        || binding.workspaceGeneration !== current.workspaceGeneration
      ) {
        throw new FabricContractError("stale_generation", "Fabric MCP Workspace Binding is stale", "workspaceBindingId");
      }
    } else if (endpoint.scope.kind === "workspace") {
      throw new FabricContractError("permission_denied", "Workspace-scoped MCP Endpoint requires a Workspace Binding", "workspaceBindingId");
    }
    return { current, endpoint };
  }

  #compactTerminals(): void {
    const terminals = [...this.#byId.entries()].filter(([, managed]) => managed.lease.state === "closed");
    for (let index = 0; index < terminals.length - this.#terminalCapacity; index += 1) {
      this.#byId.delete(terminals[index]![0]);
    }
  }
}
