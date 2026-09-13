import {
  FabricContractError,
  type EndpointRouteHandle,
  type FabricControlRequestV1,
  type WorkspaceBinding,
} from "pi-maestro-fabric-core/v1";
import type { GatewayPrincipal, GatewayResult } from "../contracts.ts";
import {
  GatewayFabricControlSupport,
  type GatewayFabricControlInput,
} from "./control-support.ts";
import type { GatewayFabricRouteClose } from "./route-service.ts";

export type GatewayFabricWorkspaceAction = "list" | "bind" | "renew" | "unbind";
export interface GatewayFabricWorkspaceRequest extends GatewayFabricControlInput {
  action: GatewayFabricWorkspaceAction;
}

function expectedRevision(request: FabricControlRequestV1): number {
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision! < 0) {
    throw new FabricContractError("invalid_argument", "expectedRevision is required", "expectedRevision");
  }
  return request.expectedRevision!;
}

export class GatewayFabricWorkspaceService {
  constructor(
    readonly support: GatewayFabricControlSupport,
    readonly closeChannels?: GatewayFabricRouteClose,
  ) {}

  handle(principal: GatewayPrincipal, input: GatewayFabricWorkspaceRequest): Promise<GatewayResult<unknown>> {
    return this.support.execute(principal, "workspace", input, async (runtime, request) => {
      switch (request.action) {
        case "workspace.list": {
          const candidates = runtime.directory.list().workspaces
            .filter((workspace) => request.deviceId === undefined || workspace.deviceId === request.deviceId);
          const workspaces = [];
          for (const workspace of candidates) {
            if (await this.support.visibleWorkspace(principal, workspace)) workspaces.push(workspace);
          }
          return { workspaces };
        }
        case "workspace.bind": {
          const authorized = await this.support.authorizeWorkspaceBinding(
            principal,
            request.workspaceId!,
            request.localWorkspaceId,
            request.expectedLocalWorkspaceGeneration,
          );
          if (authorized.fabric.deviceId !== request.deviceId) {
            throw new FabricContractError("conflict", "Fabric workspace does not belong to the selected Device", "deviceId");
          }
          if (authorized.fabric.generation !== request.expectedWorkspaceGeneration) {
            throw new FabricContractError("stale_generation", "Fabric workspace generation is stale", "expectedWorkspaceGeneration");
          }
          const connection = runtime.connections.requireReadyForDevice(
            request.connectionId!,
            request.expectedConnectionGeneration!,
            request.deviceId!,
          );
          const binding: WorkspaceBinding = {
            bindingId: this.support.createId("binding", runtime),
            connectionId: connection.connectionId,
            deviceId: request.deviceId!,
            workspaceId: authorized.fabric.workspaceId,
            connectionGeneration: connection.generation,
            workspaceGeneration: authorized.fabric.generation,
            policyDigest: authorized.fabric.policyDigest,
            issuedAt: this.support.now(runtime),
            expiresAt: this.support.boundedExpiry(request, connection.expiresAt),
            revision: 0,
          };
          const authorization = runtime.resolveLocalWorkspaceAuthorization === undefined ? undefined : {
            localWorkspaceId: authorized.localWorkspaceId,
            localWorkspaceGeneration: authorized.localWorkspaceGeneration,
          };
          return { binding: await runtime.admissions.bindDurable(binding, authorization) };
        }
        case "workspace.renew": {
          const binding = await runtime.admissions.getBindingDurable(request.workspaceBindingId!);
          if (binding === undefined) throw new FabricContractError("not_found", "Workspace Binding is not known", "workspaceBindingId");
          await this.support.authorizeWorkspaceBindingLifecycle(principal, binding.bindingId, binding.workspaceId);
          const connection = runtime.connections.requireReadyForDevice(binding.connectionId, binding.connectionGeneration, binding.deviceId);
          const expiresAt = this.support.boundedExpiry(request, connection.expiresAt);
          return { binding: await runtime.admissions.renewBinding(binding.bindingId, expectedRevision(request), expiresAt) };
        }
        case "workspace.unbind": {
          const binding = await runtime.admissions.getBindingDurable(request.workspaceBindingId!);
          if (binding === undefined) throw new FabricContractError("not_found", "Workspace Binding is not known", "workspaceBindingId");
          await this.support.authorizeWorkspaceBindingLifecycle(principal, binding.bindingId, binding.workspaceId);
          const admissions = runtime.admissions as typeof runtime.admissions & {
            unbindWithRoutes?: (
              bindingId: string,
              expectedRevision: number,
            ) => Promise<{ binding: WorkspaceBinding; closedRoutes: readonly EndpointRouteHandle[] }>;
          };
          if (typeof admissions.unbindWithRoutes !== "function") {
            return { binding: await admissions.unbind(binding.bindingId, expectedRevision(request)) };
          }
          const result = await admissions.unbindWithRoutes(binding.bindingId, expectedRevision(request));
          await this.cleanupClosedRoutes(result.closedRoutes);
          return { binding: result.binding };
        }
        default:
          throw new FabricContractError("invalid_argument", "Unsupported Fabric Workspace action", "action");
      }
    });
  }

  private async cleanupClosedRoutes(routes: readonly EndpointRouteHandle[]): Promise<void> {
    if (this.closeChannels === undefined || routes.length === 0) return;
    const results = await Promise.allSettled(routes.map((route) =>
      Promise.resolve().then(() => this.closeChannels!(route.routeId, "Fabric workspace unbound"))
    ));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Fabric workspace route cleanup failed");
  }
}
