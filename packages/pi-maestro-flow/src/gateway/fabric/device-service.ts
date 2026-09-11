import {
  FabricContractError,
  type FabricControlRequestV1,
} from "pi-maestro-fabric-core/v1";
import type { GatewayPrincipal, GatewayResult } from "../contracts.ts";
import {
  GatewayFabricControlSupport,
  type GatewayFabricControlInput,
} from "./control-support.ts";

export type GatewayFabricDeviceAction = "list" | "get" | "pair" | "connect" | "disconnect" | "status" | "workspaces";
export interface GatewayFabricDeviceRequest extends GatewayFabricControlInput {
  action: GatewayFabricDeviceAction;
}

export class GatewayFabricDeviceService {
  constructor(readonly support: GatewayFabricControlSupport) {}

  handle(principal: GatewayPrincipal, input: GatewayFabricDeviceRequest, signal?: AbortSignal): Promise<GatewayResult<unknown>> {
    return this.support.execute(principal, "device", input, async (runtime, request) => {
      switch (request.action) {
        case "device.list":
          return { devices: runtime.directory.list().devices };
        case "device.get":
          return { device: this.device(runtime, request) };
        case "device.pair": {
          const device = this.device(runtime, request);
          const connector = runtime.directory.getConnector(request.connectorId!);
          if (connector === undefined || device.connectorId !== connector.connectorId) {
            throw new FabricContractError("conflict", "Device is not owned by the selected Connector", "connectorId");
          }
          return {
            device,
            connector,
            pairing: {
              state: "out-of-band-required",
              nextAction: "Complete Connector enrollment through the host-owned pairing channel",
            },
          };
        }
        case "device.connect": {
          const lease = await runtime.connections.connect({
            requestId: request.requestId,
            deviceId: request.deviceId!,
            connectorId: request.connectorId!,
            expectedCredentialGeneration: request.expectedCredentialGeneration!,
            deadlineAt: request.deadlineAt,
            limits: this.support.limits(runtime),
          }, signal ?? new AbortController().signal);
          return { connection: lease };
        }
        case "device.disconnect": {
          const current = runtime.connections.get(request.connectionId!);
          if (current === undefined) throw new FabricContractError("not_found", "Connection is not known", "connectionId");
          if (current.deviceId !== request.deviceId) throw new FabricContractError("conflict", "Connection does not belong to the selected Device", "deviceId");
          return { connection: await runtime.connections.disconnect(request.connectionId!, request.expectedConnectionGeneration!) };
        }
        case "device.status": {
          const device = this.device(runtime, request);
          const connections = runtime.connections.list().filter((connection) => connection.deviceId === device.deviceId);
          const presence = runtime.presence === undefined ? undefined : await runtime.presence.get(device.deviceId);
          return { device, connections, ...(presence === undefined ? {} : { presence }) };
        }
        case "device.workspaces": {
          const device = this.device(runtime, request);
          const workspaces = runtime.directory.list().workspaces.filter((workspace) => workspace.deviceId === device.deviceId);
          return { deviceId: device.deviceId, workspaces };
        }
        default:
          throw new FabricContractError("invalid_argument", "Unsupported Fabric Device action", "action");
      }
    });
  }

  private device(runtime: ReturnType<GatewayFabricControlSupport["requireRuntime"]>, request: FabricControlRequestV1) {
    const device = runtime.directory.getDevice(request.deviceId!);
    if (device === undefined) throw new FabricContractError("not_found", "Fabric Device is not registered", "deviceId");
    return device;
  }
}
