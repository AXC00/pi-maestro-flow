import {
  FabricContractError,
  type FabricControlRequestV1,
  type WorkspaceBinding,
} from "pi-maestro-fabric-core/v1";
import type { GatewayPrincipal, GatewayResult } from "../contracts.ts";
import {
  GatewayFabricControlSupport,
  type GatewayFabricControlInput,
} from "./control-support.ts";

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
  constructor(readonly support: GatewayFabricControlSupport) {}

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
          const authorized = await this.support.authorizeWorkspace(principal, request.workspaceId!);
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
          return { binding: await runtime.admissions.bindDurable(binding) };
        }
        case "workspace.renew": {
          const binding = await runtime.admissions.getBindingDurable(request.workspaceBindingId!);
          if (binding === undefined) throw new FabricContractError("not_found", "Workspace Binding is not known", "workspaceBindingId");
          await this.support.authorizeWorkspace(principal, binding.workspaceId);
          const connection = runtime.connections.requireReadyForDevice(binding.connectionId, binding.connectionGeneration, binding.deviceId);
          const expiresAt = this.support.boundedExpiry(request, connection.expiresAt);
          return { binding: await runtime.admissions.renewBinding(binding.bindingId, expectedRevision(request), expiresAt) };
        }
        case "workspace.unbind": {
          const binding = await runtime.admissions.getBindingDurable(request.workspaceBindingId!);
          if (binding === undefined) throw new FabricContractError("not_found", "Workspace Binding is not known", "workspaceBindingId");
          await this.support.authorizeWorkspace(principal, binding.workspaceId);
          return { binding: await runtime.admissions.unbind(binding.bindingId, expectedRevision(request)) };
        }
        default:
          throw new FabricContractError("invalid_argument", "Unsupported Fabric Workspace action", "action");
      }
    });
  }
}
