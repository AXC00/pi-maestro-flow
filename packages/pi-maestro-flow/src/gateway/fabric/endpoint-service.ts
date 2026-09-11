import {
  FabricContractError,
  type EndpointRecord,
  type FabricControlRequestV1,
} from "pi-maestro-fabric-core/v1";
import type { GatewayPrincipal, GatewayResult } from "../contracts.ts";
import {
  GatewayFabricControlSupport,
  type GatewayFabricControlInput,
} from "./control-support.ts";

export type GatewayFabricEndpointAction = "list" | "describe" | "select";
export interface GatewayFabricEndpointRequest extends GatewayFabricControlInput {
  action: GatewayFabricEndpointAction;
}

export class GatewayFabricEndpointService {
  constructor(readonly support: GatewayFabricControlSupport) {}

  handle(principal: GatewayPrincipal, input: GatewayFabricEndpointRequest): Promise<GatewayResult<unknown>> {
    return this.support.execute(principal, "endpoint", input, async (runtime, request) => {
      if (request.action === "endpoint.list") {
        const candidates = runtime.directory.list().endpoints
          .filter((endpoint) => request.deviceId === undefined || endpoint.deviceId === request.deviceId)
          .filter((endpoint) => request.workspaceId === undefined || (endpoint.scope.kind === "workspace" && endpoint.scope.workspaceId === request.workspaceId))
          .filter((endpoint) => request.endpointKind === undefined || endpoint.kind === request.endpointKind)
          .filter((endpoint) => request.endpointStatus === undefined || endpoint.status === request.endpointStatus);
        const endpoints: EndpointRecord[] = [];
        for (const endpoint of candidates) {
          if (await this.visible(principal, endpoint)) endpoints.push(endpoint);
        }
        return { endpoints };
      }
      if (request.action === "endpoint.describe" || request.action === "endpoint.select") {
        const endpoint = this.endpoint(runtime, request);
        if (!await this.visible(principal, endpoint)) {
          throw new FabricContractError("not_found", "Fabric Endpoint is not visible", "endpointId");
        }
        if (request.action === "endpoint.select" && endpoint.status !== "online") {
          throw new FabricContractError("unavailable", "Only an online Endpoint can be selected", "endpointId");
        }
        const capabilities = runtime.directory.resolveCapabilities({}).filter((candidate) => candidate.binding.endpointId === endpoint.endpointId);
        return { endpoint, capabilities, ...(request.action === "endpoint.select" ? { selected: true } : {}) };
      }
      throw new FabricContractError("invalid_argument", "Unsupported Fabric Endpoint action", "action");
    });
  }

  private endpoint(runtime: ReturnType<GatewayFabricControlSupport["requireRuntime"]>, request: FabricControlRequestV1): EndpointRecord {
    const endpoint = runtime.directory.getEndpoint(request.endpointId!);
    if (endpoint === undefined) throw new FabricContractError("not_found", "Fabric Endpoint is not registered", "endpointId");
    return endpoint;
  }

  private async visible(principal: GatewayPrincipal, endpoint: EndpointRecord): Promise<boolean> {
    if (endpoint.scope.kind === "device") return true;
    try {
      await this.support.authorizeWorkspace(principal, endpoint.scope.workspaceId);
      return true;
    } catch {
      return false;
    }
  }
}
