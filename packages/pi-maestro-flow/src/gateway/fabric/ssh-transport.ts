import { FabricContractError } from "pi-maestro-fabric-core/v1";
import {
  GatewayControlSshChannelAdapter,
  TeammateRuntimeSshChannelAdapter,
  type GatewayControlSshChannel,
  type GatewayControlSshChannelOpener,
  type TeammateRuntimeSshChannel,
  type TeammateRuntimeSshChannelOpener,
} from "pi-maestro-fabric/fixed-ssh-channel";

export interface GatewayFabricSshTransportOptions<TGatewayHandle, TTeammateHandle> {
  readonly gatewayControlOpener: GatewayControlSshChannelOpener<TGatewayHandle>;
  readonly teammateRuntimeOpener: TeammateRuntimeSshChannelOpener<TTeammateHandle>;
}

/**
 * Flow-facing facade for the two fixed-purpose SSH protocols. It deliberately
 * exposes no command parameter and no generic exec surface.
 */
export class GatewayFabricSshTransport<TGatewayHandle, TTeammateHandle> {
  readonly gatewayControl: GatewayControlSshChannelAdapter<TGatewayHandle>;
  readonly teammateRuntime: TeammateRuntimeSshChannelAdapter<TTeammateHandle>;

  constructor(options: GatewayFabricSshTransportOptions<TGatewayHandle, TTeammateHandle>) {
    this.gatewayControl = new GatewayControlSshChannelAdapter(options.gatewayControlOpener);
    this.teammateRuntime = new TeammateRuntimeSshChannelAdapter(options.teammateRuntimeOpener);
  }

  openGatewayControl(hostRef: string, signal: AbortSignal): Promise<GatewayControlSshChannel<TGatewayHandle>> {
    return this.gatewayControl.open(hostRef, signal);
  }

  openTeammateRuntime(hostRef: string, signal: AbortSignal): Promise<TeammateRuntimeSshChannel<TTeammateHandle>> {
    return this.teammateRuntime.open(hostRef, signal);
  }

  openMcp(_hostRef: string, _signal: AbortSignal): never {
    throw new FabricContractError("permission_denied", "MCP is not available over the control-only fixed SSH adapters");
  }
}
