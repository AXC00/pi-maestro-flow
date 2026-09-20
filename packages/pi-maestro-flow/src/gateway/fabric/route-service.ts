import {
  FabricContractError,
  type EndpointRecord,
  type EndpointRouteHandle,
  type FabricControlRequestV1,
  type WorkspaceBinding,
} from "pi-maestro-fabric-core/v1";
import type { GatewayPrincipal, GatewayResult } from "../contracts.ts";
import {
  GatewayFabricControlSupport,
  type GatewayFabricControlInput,
  type GatewayFabricControlRuntime,
} from "./control-support.ts";

export type GatewayFabricRouteAction = "open" | "renew" | "close";
export interface GatewayFabricRouteRequest extends GatewayFabricControlInput {
  action: GatewayFabricRouteAction;
}

export type GatewayFabricRouteClose = (routeId: string, reason: string) => void | Promise<void>;

function expectedRevision(request: FabricControlRequestV1): number {
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision! < 0) {
    throw new FabricContractError("invalid_argument", "expectedRevision is required", "expectedRevision");
  }
  return request.expectedRevision!;
}

export class GatewayFabricRouteService {
  constructor(
    readonly support: GatewayFabricControlSupport,
    readonly closeChannels?: GatewayFabricRouteClose,
  ) {}

  handle(principal: GatewayPrincipal, input: GatewayFabricRouteRequest): Promise<GatewayResult<unknown>> {
    return this.support.execute(principal, "route", input, async (runtime, request) => {
      switch (request.action) {
        case "route.open":
          return { route: await this.open(principal, runtime, request) };
        case "route.renew": {
          const route = await this.route(runtime, request.routeId!);
          const binding = await this.authorize(principal, runtime, route);
          const endpoint = runtime.directory.getEndpoint(route.endpointId)!;
          // Liveness is fenced here; the lease expiry is not a TTL ceiling —
          // heartbeats renew it while dependent leases keep their requested TTL.
          runtime.connections.requireReadyForDevice(route.connectionId, route.connectionGeneration, endpoint.deviceId);
          const expiresAt = this.support.boundedExpiry(request, binding?.expiresAt);
          return { route: await runtime.admissions.renewRoute(route.routeId, expectedRevision(request), expiresAt) };
        }
        case "route.close": {
          const route = await this.route(runtime, request.routeId!);
          await this.authorize(principal, runtime, route);
          const closed = await runtime.admissions.closeRoute(route.routeId, expectedRevision(request));
          await this.closeChannels?.(closed.routeId, "Fabric route closed");
          return { route: closed };
        }
        default:
          throw new FabricContractError("invalid_argument", "Unsupported Fabric Route action", "action");
      }
    });
  }

  private async open(
    principal: GatewayPrincipal,
    runtime: GatewayFabricControlRuntime,
    request: FabricControlRequestV1,
  ): Promise<EndpointRouteHandle> {
    const endpoint = runtime.directory.getEndpoint(request.endpointId!);
    if (endpoint === undefined) throw new FabricContractError("not_found", "Fabric Endpoint is not registered", "endpointId");
    if (endpoint.generation !== request.expectedEndpointGeneration) {
      throw new FabricContractError("stale_generation", "Fabric Endpoint generation is stale", "expectedEndpointGeneration");
    }
    // Liveness is fenced here; the lease expiry is not a TTL ceiling —
    // heartbeats renew it while dependent leases keep their requested TTL.
    const connection = runtime.connections.requireReadyForDevice(
      request.connectionId!,
      request.expectedConnectionGeneration!,
      endpoint.deviceId,
    );
    let binding: WorkspaceBinding | undefined;
    if (endpoint.scope.kind === "workspace") {
      if (request.workspaceBindingId === undefined) {
        throw new FabricContractError("permission_denied", "Workspace-scoped Endpoint requires a Workspace Binding", "workspaceBindingId");
      }
      binding = runtime.admissions.validateBinding(request.workspaceBindingId);
      if (binding.workspaceId !== endpoint.scope.workspaceId || binding.deviceId !== endpoint.deviceId) {
        throw new FabricContractError("conflict", "Workspace Binding does not own the selected Endpoint", "workspaceBindingId");
      }
      if (request.expectedWorkspaceGeneration !== undefined && request.expectedWorkspaceGeneration !== binding.workspaceGeneration) {
        throw new FabricContractError("stale_generation", "Workspace Binding generation is stale", "expectedWorkspaceGeneration");
      }
      await this.support.authorizeWorkspace(principal, binding.workspaceId);
    } else if (request.workspaceBindingId !== undefined || request.expectedWorkspaceGeneration !== undefined) {
      throw new FabricContractError("conflict", "Device-scoped Endpoint cannot use Workspace Binding fields", "workspaceBindingId");
    }
    const now = this.support.now(runtime);
    const route: EndpointRouteHandle = {
      routeId: this.support.createId("route", runtime),
      connectionId: connection.connectionId,
      ...(binding === undefined ? {} : {
        workspaceBindingId: binding.bindingId,
        workspaceGeneration: binding.workspaceGeneration,
      }),
      endpointId: endpoint.endpointId,
      connectionGeneration: connection.generation,
      endpointGeneration: endpoint.generation,
      issuedAt: now,
      expiresAt: this.support.boundedExpiry(request, binding?.expiresAt),
      state: "open",
      revision: 0,
      deviceId: endpoint.deviceId,
      operationClass: request.operationClass!,
      pathCandidates: [...request.pathCandidates!],
      selectedPath: request.pathCandidates![0],
    };
    return runtime.admissions.openRouteDurable(route);
  }

  private async route(runtime: GatewayFabricControlRuntime, routeId: string): Promise<EndpointRouteHandle> {
    const route = await runtime.admissions.getRouteDurable(routeId);
    if (route === undefined) throw new FabricContractError("not_found", "Fabric Route is not known", "routeId");
    return route;
  }

  private async authorize(
    principal: GatewayPrincipal,
    runtime: GatewayFabricControlRuntime,
    route: EndpointRouteHandle,
  ): Promise<WorkspaceBinding | undefined> {
    const endpoint = runtime.directory.getEndpoint(route.endpointId);
    if (endpoint === undefined || endpoint.generation !== route.endpointGeneration) {
      throw new FabricContractError("stale_generation", "Fabric Route Endpoint is stale", "endpointId");
    }
    if (route.deviceId !== undefined && route.deviceId !== endpoint.deviceId) {
      throw new FabricContractError("conflict", "Fabric Route Device identity is inconsistent", "deviceId");
    }
    if (endpoint.scope.kind === "device") {
      if (route.workspaceBindingId !== undefined || route.workspaceGeneration !== undefined) {
        throw new FabricContractError("conflict", "Device-scoped Route cannot carry Workspace Binding fields", "workspaceBindingId");
      }
      return undefined;
    }
    if (route.workspaceBindingId === undefined || route.workspaceGeneration === undefined) {
      throw new FabricContractError("permission_denied", "Workspace-scoped Route has no Workspace Binding", "workspaceBindingId");
    }
    const binding = runtime.admissions.validateBinding(route.workspaceBindingId);
    if (binding.workspaceId !== endpoint.scope.workspaceId || binding.workspaceGeneration !== route.workspaceGeneration) {
      throw new FabricContractError("stale_generation", "Fabric Route Workspace Binding is stale", "workspaceBindingId");
    }
    await this.support.authorizeWorkspace(principal, binding.workspaceId);
    return binding;
  }
}
