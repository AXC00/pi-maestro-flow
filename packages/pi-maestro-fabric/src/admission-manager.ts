import {
  FabricContractError,
  assertValidEndpointRouteHandle,
  assertValidWorkspaceBinding,
  type EndpointRouteHandle,
  type WorkspaceBinding,
} from "pi-maestro-fabric-core/v1";
import { FabricConnectionManager } from "./connection-manager.ts";
import { FabricDirectory } from "./directory.ts";

export interface FabricAdmissionManagerOptions {
  now?: () => number;
}

/** Minimal, in-memory workspace binding and endpoint route authority for Phase 2. */
export class FabricAdmissionManager {
  readonly #bindings = new Map<string, WorkspaceBinding>();
  readonly #routes = new Map<string, EndpointRouteHandle>();
  readonly #now: () => number;

  constructor(
    readonly directory: FabricDirectory,
    readonly connections: FabricConnectionManager,
    options: FabricAdmissionManagerOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
  }

  bind(binding: WorkspaceBinding): WorkspaceBinding {
    const now = this.#now();
    assertValidWorkspaceBinding(binding, now);
    if (this.#bindings.has(binding.bindingId)) {
      throw new FabricContractError("conflict", "Workspace binding identity already exists", "bindingId");
    }
    const workspace = this.directory.getWorkspace(binding.workspaceId);
    if (workspace === undefined) {
      throw new FabricContractError("not_found", "Workspace is not registered", "workspaceId");
    }
    if (
      workspace.deviceId !== binding.deviceId ||
      workspace.generation !== binding.workspaceGeneration ||
      workspace.policyDigest !== binding.policyDigest
    ) {
      throw new FabricContractError("stale_generation", "Workspace binding does not match current workspace authority", "workspaceId");
    }
    const connection = this.connections.requireReady(binding.connectionId, binding.connectionGeneration);
    if (connection.deviceId !== workspace.deviceId) {
      throw new FabricContractError("conflict", "Workspace does not belong to the connected device", "deviceId");
    }
    this.connections.admitWorkspaceBinding(binding);
    const stored = { ...binding };
    this.#bindings.set(stored.bindingId, stored);
    return { ...stored };
  }

  openRoute(route: EndpointRouteHandle): EndpointRouteHandle {
    const now = this.#now();
    assertValidEndpointRouteHandle(route, now);
    if (this.#routes.has(route.routeId)) {
      throw new FabricContractError("conflict", "Route identity already exists", "routeId");
    }
    const endpoint = this.directory.getEndpoint(route.endpointId);
    if (endpoint === undefined) throw new FabricContractError("not_found", "Endpoint is not registered", "endpointId");
    const binding = route.workspaceBindingId === undefined ? undefined : this.#bindings.get(route.workspaceBindingId);
    if (endpoint.scope.kind === "workspace" && binding === undefined) {
      throw new FabricContractError("permission_denied", "Workspace-scoped endpoint requires a current binding", "workspaceBindingId");
    }
    if (endpoint.scope.kind === "device" && binding !== undefined) {
      throw new FabricContractError("conflict", "Device-scoped endpoint cannot use a workspace binding", "workspaceBindingId");
    }
    this.connections.admitEndpointRoute(endpoint, route, binding);
    const stored = { ...route };
    this.#routes.set(stored.routeId, stored);
    return { ...stored };
  }

  validateBinding(bindingId: string): WorkspaceBinding {
    const binding = this.#bindings.get(bindingId);
    if (binding === undefined) throw new FabricContractError("not_found", "Workspace binding is not known", "bindingId");
    assertValidWorkspaceBinding(binding, this.#now());
    const workspace = this.directory.getWorkspace(binding.workspaceId);
    if (
      workspace === undefined ||
      workspace.deviceId !== binding.deviceId ||
      workspace.generation !== binding.workspaceGeneration ||
      workspace.policyDigest !== binding.policyDigest
    ) {
      throw new FabricContractError("stale_generation", "Workspace binding is stale", "bindingId");
    }
    this.connections.admitWorkspaceBinding(binding);
    return { ...binding };
  }

  validateRoute(routeId: string): EndpointRouteHandle {
    const route = this.#routes.get(routeId);
    if (route === undefined) throw new FabricContractError("not_found", "Route is not known", "routeId");
    const endpoint = this.directory.getEndpoint(route.endpointId);
    if (endpoint === undefined) throw new FabricContractError("stale_generation", "Route endpoint no longer exists", "endpointId");
    const binding = route.workspaceBindingId === undefined ? undefined : this.validateBinding(route.workspaceBindingId);
    this.connections.admitEndpointRoute(endpoint, route, binding);
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
}
