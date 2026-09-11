import {
  FabricContractError,
  assertBoundedString,
  assertFabricIdentifier,
} from "pi-maestro-fabric-core/v1";

export const GATEWAY_CONTROL_SSH_COMMAND = "pi-maestro-gateway connect --stdio" as const;
export const TEAMMATE_RUNTIME_SSH_COMMAND = "pi-teammate-remote connect --stdio" as const;

export interface HostInjectedFixedSshDescriptor {
  hostRef: string;
  purpose: string;
  command: string;
  hostDigest: string;
  fence: string;
}

export interface HostInjectedFixedSshChannel<THandle> {
  readonly descriptor: HostInjectedFixedSshDescriptor;
  readonly handle: THandle;
  close(reason: string): Promise<void>;
}

export interface GatewayControlSshOpenRequest {
  hostRef: string;
  purpose: "gateway-control";
  command: typeof GATEWAY_CONTROL_SSH_COMMAND;
}

export interface TeammateRuntimeSshOpenRequest {
  hostRef: string;
  purpose: "teammate-runtime";
  command: typeof TEAMMATE_RUNTIME_SSH_COMMAND;
}

export interface GatewayControlSshChannelOpener<THandle> {
  open(request: GatewayControlSshOpenRequest, signal: AbortSignal): Promise<HostInjectedFixedSshChannel<THandle>>;
}

export interface TeammateRuntimeSshChannelOpener<THandle> {
  open(request: TeammateRuntimeSshOpenRequest, signal: AbortSignal): Promise<HostInjectedFixedSshChannel<THandle>>;
}

interface FixedSshChannelBase<THandle, TPurpose extends string, TCommand extends string> {
  readonly descriptor: Readonly<HostInjectedFixedSshDescriptor & { purpose: TPurpose; command: TCommand }>;
  /** The exact host-owned stream/channel handle returned by the injected opener. */
  readonly handle: THandle;
  close(reason?: string): Promise<void>;
}

export type GatewayControlSshChannel<THandle> = FixedSshChannelBase<
  THandle,
  "gateway-control",
  typeof GATEWAY_CONTROL_SSH_COMMAND
>;

export type TeammateRuntimeSshChannel<THandle> = FixedSshChannelBase<
  THandle,
  "teammate-runtime",
  typeof TEAMMATE_RUNTIME_SSH_COMMAND
>;

async function rejectAndClose<THandle>(channel: HostInjectedFixedSshChannel<THandle>, cause: unknown): Promise<never> {
  try {
    await channel.close("fixed SSH channel admission rejected");
  } catch {
    throw new FabricContractError("unavailable", "Fixed SSH admission failed and the rejected channel could not be closed");
  }
  if (cause instanceof FabricContractError) throw cause;
  throw new FabricContractError("protocol_violation", "Fixed SSH channel admission failed");
}

async function validateChannel<THandle, TPurpose extends string, TCommand extends string>(
  channel: HostInjectedFixedSshChannel<THandle>,
  expected: { hostRef: string; purpose: TPurpose; command: TCommand },
  signal: AbortSignal,
): Promise<FixedSshChannelBase<THandle, TPurpose, TCommand>> {
  if (signal.aborted) await rejectAndClose(channel, new FabricContractError("cancelled", "Fixed SSH channel open was aborted"));
  try {
    assertFabricIdentifier(channel.descriptor.hostRef, "descriptor.hostRef");
    assertBoundedString(channel.descriptor.hostDigest, "descriptor.hostDigest", 256);
    assertBoundedString(channel.descriptor.fence, "descriptor.fence", 256);
    if (
      channel.descriptor.hostRef !== expected.hostRef ||
      channel.descriptor.purpose !== expected.purpose ||
      channel.descriptor.command !== expected.command
    ) {
      throw new FabricContractError("conflict", "Host channel descriptor does not match the fixed SSH request", "descriptor");
    }
  } catch (error) {
    await rejectAndClose(channel, error);
  }

  const descriptor = Object.freeze({ ...channel.descriptor, purpose: expected.purpose, command: expected.command });
  let closePromise: Promise<void> | undefined;
  return {
    descriptor,
    handle: channel.handle,
    close(reason = "fixed SSH channel closed"): Promise<void> {
      assertBoundedString(reason, "reason", 1_024);
      closePromise ??= Promise.resolve().then(() => channel.close(reason));
      return closePromise;
    },
  };
}

export class GatewayControlSshChannelAdapter<THandle> {
  constructor(readonly opener: GatewayControlSshChannelOpener<THandle>) {}

  async open(hostRef: string, signal: AbortSignal): Promise<GatewayControlSshChannel<THandle>> {
    assertFabricIdentifier(hostRef, "hostRef");
    if (signal.aborted) throw new FabricContractError("cancelled", "Fixed SSH channel open was aborted");
    const request: GatewayControlSshOpenRequest = { hostRef, purpose: "gateway-control", command: GATEWAY_CONTROL_SSH_COMMAND };
    let channel: HostInjectedFixedSshChannel<THandle>;
    try {
      channel = await this.opener.open(request, signal);
    } catch {
      throw new FabricContractError("unavailable", "Fixed SSH channel opener failed");
    }
    return validateChannel(channel, request, signal);
  }
}

export class TeammateRuntimeSshChannelAdapter<THandle> {
  constructor(readonly opener: TeammateRuntimeSshChannelOpener<THandle>) {}

  async open(hostRef: string, signal: AbortSignal): Promise<TeammateRuntimeSshChannel<THandle>> {
    assertFabricIdentifier(hostRef, "hostRef");
    if (signal.aborted) throw new FabricContractError("cancelled", "Fixed SSH channel open was aborted");
    const request: TeammateRuntimeSshOpenRequest = { hostRef, purpose: "teammate-runtime", command: TEAMMATE_RUNTIME_SSH_COMMAND };
    let channel: HostInjectedFixedSshChannel<THandle>;
    try {
      channel = await this.opener.open(request, signal);
    } catch {
      throw new FabricContractError("unavailable", "Fixed SSH channel opener failed");
    }
    return validateChannel(channel, request, signal);
  }
}
