import {
  FabricContractError,
  assertEpochMilliseconds,
  assertRevision,
  assertValidEndpointRouteHandle,
  assertValidWorkspaceBinding,
  type EndpointRouteHandle,
  type FabricRoutePath,
  type JsonValue,
  type WorkspaceBinding,
} from "pi-maestro-fabric-core/v1";
import { FabricConnectionManager } from "./connection-manager.ts";
import { FabricDirectory } from "./directory.ts";
import { FabricStoreCoordinator, type FabricStoredRecord } from "./store-coordinator.ts";

export interface FabricAdmissionManagerOptions {
  now?: () => number;
  coordinator?: FabricStoreCoordinator;
}

function storedRecord(value: Record<string, unknown>): FabricStoredRecord {
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) result[key] = entry as JsonValue;
  }
  return result;
}

function recordRevision(record: FabricStoredRecord, path: string): number {
  assertRevision(record.revision, path);
  if (record.revision < 1) throw new FabricContractError("protocol_violation", `${path} must be positive`, path);
  return record.revision;
}

/** Workspace binding and Endpoint route admission, with optional durable CAS authority. */
export class FabricAdmissionManager {
  readonly #bindings = new Map<string, WorkspaceBinding>();
  readonly #routes = new Map<string, EndpointRouteHandle>();
  readonly #now: () => number;
  readonly #coordinator?: FabricStoreCoordinator;

  constructor(
    readonly directory: FabricDirectory,
    readonly connections: FabricConnectionManager,
    options: FabricAdmissionManagerOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#coordinator = options.coordinator;
  }

  bind(binding: WorkspaceBinding): WorkspaceBinding {
    if (this.#coordinator !== undefined) {
      throw new FabricContractError("invalid_state", "Durable admission requires bindDurable", "binding");
    }
    this.#assertBinding(binding);
    if (this.#bindings.has(binding.bindingId)) {
      throw new FabricContractError("conflict", "Workspace binding identity already exists", "bindingId");
    }
    const stored = { ...binding };
    this.#bindings.set(stored.bindingId, stored);
    return { ...stored };
  }

  async bindDurable(binding: WorkspaceBinding): Promise<WorkspaceBinding> {
    if (this.#coordinator === undefined) return this.bind(binding);
    if (binding.revision !== 0) throw new FabricContractError("conflict", "New workspace binding revision must be zero", "revision");
    const connectorId = this.#assertBinding(binding);
    const now = this.#now();
    const stored = { ...binding, revision: 1 };
    await this.#coordinator.commit("lease", now, (store) => {
      this.#assertDurableConnection(store.records, connectorId, binding.connectionId, binding.connectionGeneration, now);
      if (store.records[binding.bindingId] !== undefined || this.#bindings.has(binding.bindingId)) {
        throw new FabricContractError("conflict", "Workspace binding identity already exists", "bindingId");
      }
      return {
        mutations: [{
          kind: "upsert",
          subjectId: binding.bindingId,
          value: storedRecord({ ...stored, kind: "binding" }),
          eventKind: "binding.issued",
          payload: {
            bindingId: stored.bindingId,
            connectionId: stored.connectionId,
            deviceId: stored.deviceId,
            workspaceId: stored.workspaceId,
            connectionGeneration: stored.connectionGeneration,
            workspaceGeneration: stored.workspaceGeneration,
            expiresAt: stored.expiresAt,
          },
        }],
        value: stored,
      };
    });
    try {
      this.#assertBinding(stored);
    } catch (error) {
      await this.#revokeDurableBinding(stored, now);
      throw error;
    }
    this.#bindings.set(stored.bindingId, stored);
    return { ...stored };
  }

  async renewBinding(bindingId: string, expectedRevision: number, expiresAt: number): Promise<WorkspaceBinding> {
    assertRevision(expectedRevision, "expectedRevision");
    assertEpochMilliseconds(expiresAt, "expiresAt");
    const current = await this.#loadBinding(bindingId);
    if (current.revision !== expectedRevision) throw new FabricContractError("conflict", "Workspace binding revision is stale", "expectedRevision");
    const connectorId = this.#assertBinding(current);
    if (expiresAt <= current.expiresAt) throw new FabricContractError("invalid_argument", "Binding renewal must extend expiry", "expiresAt");
    const next = { ...current, expiresAt, revision: current.revision + 1 };
    assertValidWorkspaceBinding(next, this.#now());
    await this.#commitBinding(next, current.revision, "binding.renewed", connectorId);
    try {
      this.#assertBinding(next);
    } catch (error) {
      await this.#revokeDurableBinding(next, this.#now());
      throw error;
    }
    this.#bindings.set(bindingId, next);
    return { ...next };
  }

  async unbind(bindingId: string, expectedRevision: number): Promise<WorkspaceBinding> {
    assertRevision(expectedRevision, "expectedRevision");
    const current = await this.#loadBinding(bindingId);
    if (current.revision !== expectedRevision) throw new FabricContractError("conflict", "Workspace binding revision is stale", "expectedRevision");
    const next = { ...current, revision: current.revision + 1 };
    await this.#revokeDurableBinding(next, this.#now(), current.revision);
    this.#bindings.delete(bindingId);
    return { ...next };
  }

  openRoute(route: EndpointRouteHandle): EndpointRouteHandle {
    if (this.#coordinator !== undefined) {
      throw new FabricContractError("invalid_state", "Durable admission requires openRouteDurable", "route");
    }
    this.#assertRoute(route);
    if (this.#routes.has(route.routeId)) {
      throw new FabricContractError("conflict", "Route identity already exists", "routeId");
    }
    const stored = { ...route, pathCandidates: route.pathCandidates === undefined ? undefined : [...route.pathCandidates] };
    this.#routes.set(stored.routeId, stored);
    return { ...stored };
  }

  async openRouteDurable(route: EndpointRouteHandle): Promise<EndpointRouteHandle> {
    if (this.#coordinator === undefined) return this.openRoute(route);
    if (route.revision !== 0) throw new FabricContractError("conflict", "New route revision must be zero", "revision");
    const connectorId = this.#assertRoute(route);
    const now = this.#now();
    const stored = { ...route, revision: 1, pathCandidates: route.pathCandidates === undefined ? undefined : [...route.pathCandidates] };
    await this.#coordinator.commit("lease", now, (store) => {
      this.#assertDurableConnection(store.records, connectorId, route.connectionId, route.connectionGeneration, now);
      this.#assertDurableRouteBinding(store.records, route, now);
      if (store.records[route.routeId] !== undefined || this.#routes.has(route.routeId)) {
        throw new FabricContractError("conflict", "Route identity already exists", "routeId");
      }
      return {
        mutations: [{
          kind: "upsert",
          subjectId: route.routeId,
          value: storedRecord({ ...stored, kind: "route" }),
          eventKind: "route.opened",
          payload: storedRecord({
            routeId: stored.routeId,
            connectionId: stored.connectionId,
            deviceId: stored.deviceId,
            workspaceBindingId: stored.workspaceBindingId,
            endpointId: stored.endpointId,
            connectionGeneration: stored.connectionGeneration,
            workspaceGeneration: stored.workspaceGeneration,
            endpointGeneration: stored.endpointGeneration,
            routeRevision: stored.revision,
            expiresAt: stored.expiresAt,
            state: stored.state,
            pathCandidates: stored.pathCandidates,
            selectedPath: stored.selectedPath,
          }),
        }],
        value: stored,
      };
    });
    try {
      this.#assertRoute(stored);
    } catch (error) {
      await this.#closeDurableRoute(stored, now);
      throw error;
    }
    this.#routes.set(stored.routeId, stored);
    return { ...stored };
  }

  async renewRoute(routeId: string, expectedRevision: number, expiresAt: number): Promise<EndpointRouteHandle> {
    assertRevision(expectedRevision, "expectedRevision");
    assertEpochMilliseconds(expiresAt, "expiresAt");
    const current = await this.#loadRoute(routeId);
    if (current.revision !== expectedRevision) throw new FabricContractError("conflict", "Route revision is stale", "expectedRevision");
    const connectorId = this.#assertRoute(current);
    if (expiresAt <= current.expiresAt) throw new FabricContractError("invalid_argument", "Route renewal must extend expiry", "expiresAt");
    const next = { ...current, expiresAt, revision: current.revision + 1 };
    assertValidEndpointRouteHandle(next, this.#now());
    await this.#commitRoute(next, current.revision, "route.renewed", connectorId);
    this.#assertRoute(next);
    this.#routes.set(routeId, next);
    return { ...next };
  }

  async switchRoutePath(routeId: string, expectedRevision: number, selectedPath: FabricRoutePath): Promise<EndpointRouteHandle> {
    assertRevision(expectedRevision, "expectedRevision");
    const current = await this.#loadRoute(routeId);
    if (current.revision !== expectedRevision) throw new FabricContractError("conflict", "Route revision is stale", "expectedRevision");
    const connectorId = this.#assertRoute(current);
    if (current.pathCandidates === undefined || !current.pathCandidates.includes(selectedPath)) {
      throw new FabricContractError("permission_denied", "Route path was not admitted", "selectedPath");
    }
    const next = { ...current, selectedPath, revision: current.revision + 1 };
    assertValidEndpointRouteHandle(next, this.#now());
    await this.#commitRoute(next, current.revision, "route.path-switched", connectorId);
    this.#assertRoute(next);
    this.#routes.set(routeId, next);
    return { ...next };
  }

  async closeRoute(routeId: string, expectedRevision: number): Promise<EndpointRouteHandle> {
    assertRevision(expectedRevision, "expectedRevision");
    const current = await this.#loadRoute(routeId);
    if (current.revision !== expectedRevision) throw new FabricContractError("conflict", "Route revision is stale", "expectedRevision");
    if (current.state === "closed") return { ...current };
    const next = { ...current, state: "closed" as const, revision: current.revision + 1 };
    assertValidEndpointRouteHandle(next);
    await this.#closeDurableRoute(next, this.#now(), current.revision);
    this.#routes.set(routeId, next);
    return { ...next };
  }

  validateBinding(bindingId: string): WorkspaceBinding {
    const binding = this.#bindings.get(bindingId);
    if (binding === undefined) throw new FabricContractError("not_found", "Workspace binding is not known", "bindingId");
    this.#assertBinding(binding);
    return { ...binding };
  }

  validateRoute(routeId: string): EndpointRouteHandle {
    const route = this.#routes.get(routeId);
    if (route === undefined) throw new FabricContractError("not_found", "Route is not known", "routeId");
    this.#assertRoute(route);
    return { ...route };
  }

  getBinding(bindingId: string): WorkspaceBinding | undefined {
    const binding = this.#bindings.get(bindingId);
    return binding === undefined ? undefined : { ...binding };
  }

  getRoute(routeId: string): EndpointRouteHandle | undefined {
    const route = this.#routes.get(routeId);
    return route === undefined ? undefined : { ...route };
  }

  async getBindingDurable(bindingId: string): Promise<WorkspaceBinding | undefined> {
    try { return await this.#loadBinding(bindingId); }
    catch (error) {
      if (error instanceof FabricContractError && error.code === "not_found") return undefined;
      throw error;
    }
  }

  async getRouteDurable(routeId: string): Promise<EndpointRouteHandle | undefined> {
    try { return await this.#loadRoute(routeId); }
    catch (error) {
      if (error instanceof FabricContractError && error.code === "not_found") return undefined;
      throw error;
    }
  }

  #assertBinding(binding: WorkspaceBinding): string {
    assertValidWorkspaceBinding(binding, this.#now());
    const workspace = this.directory.getWorkspace(binding.workspaceId);
    if (workspace === undefined) throw new FabricContractError("not_found", "Workspace is not registered", "workspaceId");
    if (
      workspace.deviceId !== binding.deviceId || workspace.generation !== binding.workspaceGeneration ||
      workspace.policyDigest !== binding.policyDigest
    ) {
      throw new FabricContractError("stale_generation", "Workspace binding does not match current workspace authority", "workspaceId");
    }
    this.connections.admitWorkspaceBinding(binding);
    return this.connections.requireReadyForDevice(binding.connectionId, binding.connectionGeneration, binding.deviceId).connectorId;
  }

  #assertRoute(route: EndpointRouteHandle): string {
    assertValidEndpointRouteHandle(route, this.#now());
    if (route.state !== "open") throw new FabricContractError("invalid_state", "Route must be open", "state");
    const endpoint = this.directory.getEndpoint(route.endpointId);
    if (endpoint === undefined) throw new FabricContractError("stale_generation", "Route endpoint no longer exists", "endpointId");
    const binding = route.workspaceBindingId === undefined ? undefined : this.validateBinding(route.workspaceBindingId);
    if (endpoint.scope.kind === "workspace" && binding === undefined) {
      throw new FabricContractError("permission_denied", "Workspace-scoped endpoint requires a current binding", "workspaceBindingId");
    }
    if (endpoint.scope.kind === "device" && binding !== undefined) {
      throw new FabricContractError("conflict", "Device-scoped endpoint cannot use a workspace binding", "workspaceBindingId");
    }
    this.connections.admitEndpointRoute(endpoint, route, binding);
    return endpoint.connectorId;
  }

  async #loadBinding(bindingId: string): Promise<WorkspaceBinding> {
    const memory = this.#bindings.get(bindingId);
    if (memory !== undefined) return { ...memory };
    const record = await this.#coordinator?.get("lease", bindingId);
    if (record === undefined || record.kind !== "binding" || record.revokedAt !== undefined) {
      throw new FabricContractError("not_found", "Workspace binding is not known", "bindingId");
    }
    const binding = this.#bindingFromRecord(record);
    this.#bindings.set(bindingId, binding);
    return { ...binding };
  }

  async #loadRoute(routeId: string): Promise<EndpointRouteHandle> {
    const memory = this.#routes.get(routeId);
    if (memory !== undefined) return { ...memory };
    const record = await this.#coordinator?.get("lease", routeId);
    if (record === undefined || record.kind !== "route") throw new FabricContractError("not_found", "Route is not known", "routeId");
    const route = this.#routeFromRecord(record);
    this.#routes.set(routeId, route);
    return { ...route };
  }

  #bindingFromRecord(record: FabricStoredRecord): WorkspaceBinding {
    const binding = {
      bindingId: record.bindingId,
      connectionId: record.connectionId,
      deviceId: record.deviceId,
      workspaceId: record.workspaceId,
      connectionGeneration: record.connectionGeneration,
      workspaceGeneration: record.workspaceGeneration,
      policyDigest: record.policyDigest,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      revision: recordRevision(record, "binding.revision"),
    } as WorkspaceBinding;
    assertValidWorkspaceBinding(binding);
    return binding;
  }

  #routeFromRecord(record: FabricStoredRecord): EndpointRouteHandle {
    const route = {
      routeId: record.routeId,
      connectionId: record.connectionId,
      workspaceBindingId: record.workspaceBindingId,
      endpointId: record.endpointId,
      connectionGeneration: record.connectionGeneration,
      workspaceGeneration: record.workspaceGeneration,
      endpointGeneration: record.endpointGeneration,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      state: record.state,
      revision: recordRevision(record, "route.revision"),
      deviceId: record.deviceId,
      operationClass: record.operationClass,
      pathCandidates: record.pathCandidates,
      selectedPath: record.selectedPath,
    } as EndpointRouteHandle;
    assertValidEndpointRouteHandle(route);
    return route;
  }

  #assertDurableConnection(
    records: Readonly<Record<string, FabricStoredRecord>>,
    connectorId: string,
    connectionId: string,
    connectionGeneration: number,
    now: number,
  ): void {
    const connection = records[connectorId];
    if (
      connection?.kind !== "connection" || connection.connectionId !== connectionId ||
      connection.generation !== connectionGeneration || connection.state !== "connected" ||
      typeof connection.expiresAt !== "number" || connection.expiresAt <= now
    ) {
      throw new FabricContractError("stale_generation", "Durable connection authority is not current", "connectionId");
    }
  }

  #assertDurableRouteBinding(
    records: Readonly<Record<string, FabricStoredRecord>>,
    route: EndpointRouteHandle,
    now: number,
  ): void {
    if (route.workspaceBindingId === undefined) return;
    const binding = records[route.workspaceBindingId];
    if (
      binding?.kind !== "binding" || binding.revokedAt !== undefined ||
      binding.connectionId !== route.connectionId || binding.connectionGeneration !== route.connectionGeneration ||
      binding.workspaceGeneration !== route.workspaceGeneration ||
      typeof binding.expiresAt !== "number" || binding.expiresAt <= now
    ) {
      throw new FabricContractError("stale_generation", "Durable workspace binding is not current", "workspaceBindingId");
    }
  }

  async #commitBinding(binding: WorkspaceBinding, expectedRevision: number, eventKind: string, connectorId: string): Promise<void> {
    if (this.#coordinator === undefined) return;
    await this.#coordinator.commit("lease", this.#now(), (store) => {
      this.#assertDurableConnection(store.records, connectorId, binding.connectionId, binding.connectionGeneration, this.#now());
      const current = store.records[binding.bindingId];
      if (current?.kind !== "binding" || current.revision !== expectedRevision || current.revokedAt !== undefined) {
        throw new FabricContractError("conflict", "Workspace binding revision is stale", "expectedRevision");
      }
      return {
        mutations: [{
          kind: "upsert",
          subjectId: binding.bindingId,
          expectedRevision,
          value: storedRecord({ ...binding, kind: "binding" }),
          eventKind,
          payload: { bindingId: binding.bindingId, connectionId: binding.connectionId, deviceId: binding.deviceId, workspaceId: binding.workspaceId, connectionGeneration: binding.connectionGeneration, workspaceGeneration: binding.workspaceGeneration, expiresAt: binding.expiresAt },
        }],
        value: undefined,
      };
    });
  }

  async #revokeDurableBinding(binding: WorkspaceBinding, revokedAt: number, expectedRevision = binding.revision): Promise<void> {
    if (this.#coordinator === undefined) return;
    await this.#coordinator.commit("lease", revokedAt, (store) => {
      const current = store.records[binding.bindingId];
      if (current?.kind !== "binding" || current.revision !== expectedRevision) {
        throw new FabricContractError("conflict", "Workspace binding revision is stale", "expectedRevision");
      }
      return {
        mutations: [{
          kind: "upsert",
          subjectId: binding.bindingId,
          expectedRevision,
          value: storedRecord({ ...binding, kind: "binding", revokedAt, revision: expectedRevision + 1 }),
          eventKind: "binding.revoked",
          payload: { bindingId: binding.bindingId, connectionId: binding.connectionId, deviceId: binding.deviceId, workspaceId: binding.workspaceId, revokedAt },
        }],
        value: undefined,
      };
    });
  }

  async #commitRoute(route: EndpointRouteHandle, expectedRevision: number, eventKind: string, connectorId: string): Promise<void> {
    if (this.#coordinator === undefined) return;
    await this.#coordinator.commit("lease", this.#now(), (store) => {
      this.#assertDurableConnection(store.records, connectorId, route.connectionId, route.connectionGeneration, this.#now());
      this.#assertDurableRouteBinding(store.records, route, this.#now());
      const current = store.records[route.routeId];
      if (current?.kind !== "route" || current.revision !== expectedRevision || current.state !== "open") {
        throw new FabricContractError("conflict", "Route revision is stale", "expectedRevision");
      }
      return {
        mutations: [{
          kind: "upsert",
          subjectId: route.routeId,
          expectedRevision,
          value: storedRecord({ ...route, kind: "route" }),
          eventKind,
          payload: storedRecord({ routeId: route.routeId, connectionId: route.connectionId, endpointId: route.endpointId, connectionGeneration: route.connectionGeneration, workspaceGeneration: route.workspaceGeneration, endpointGeneration: route.endpointGeneration, routeRevision: route.revision, expiresAt: route.expiresAt, state: route.state, pathCandidates: route.pathCandidates, selectedPath: route.selectedPath }),
        }],
        value: undefined,
      };
    });
  }

  async #closeDurableRoute(route: EndpointRouteHandle, at: number, expectedRevision = route.revision): Promise<void> {
    if (this.#coordinator === undefined) return;
    await this.#coordinator.commit("lease", at, (store) => {
      const current = store.records[route.routeId];
      if (current?.kind !== "route" || current.revision !== expectedRevision) {
        throw new FabricContractError("conflict", "Route revision is stale", "expectedRevision");
      }
      return {
        mutations: [{
          kind: "upsert",
          subjectId: route.routeId,
          expectedRevision,
          value: storedRecord({ ...route, kind: "route", state: "closed", revision: expectedRevision + 1 }),
          eventKind: "route.closed",
          payload: { routeId: route.routeId, connectionId: route.connectionId, endpointId: route.endpointId, connectionGeneration: route.connectionGeneration, endpointGeneration: route.endpointGeneration, routeRevision: expectedRevision + 1, state: "closed" },
        }],
        value: undefined,
      };
    });
  }
}
