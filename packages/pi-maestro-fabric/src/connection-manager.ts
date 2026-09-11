import {
  FABRIC_PROTOCOL_VERSION,
  FabricContractError,
  assertBoundedString,
  assertEpochMilliseconds,
  assertFabricIdentifier,
  assertGeneration,
  assertUsableEndpointRoute,
  assertValidConnectionLease,
  assertValidFabricProtocolLimits,
  beginConnection,
  beginConnectionDrain,
  bindWorkspace,
  closeConnection,
  createRegisteredConnectionState,
  establishConnection,
  markConnectionReady,
  openEndpointRoute,
  projectConnection,
  type ConnectionFirstState,
  type ConnectorRecord,
  type DeviceRecord,
  type EndpointRecord,
  type EndpointRouteHandle,
  type FabricCancellationSignal,
  type FabricConnectRequest,
  type FabricLiveConnection,
  type FabricProtocolLimits,
  type PublicConnectionLease,
  type WorkspaceBinding,
} from "pi-maestro-fabric-core/v1";
import {
  FabricDirectory,
  type AcceptedAdvertisementMetadata,
  type FabricAdvertisementSnapshot,
} from "./directory.ts";
import {
  FABRIC_DIRECTORY_ADVERTISEMENT_AUTHORITY,
  FABRIC_DIRECTORY_REGISTRY_AUTHORITY,
} from "./directory-authority.ts";
import { TransportRegistry } from "./transport-registry.ts";

interface ManagedConnection {
  state: ConnectionFirstState;
  channel?: FabricLiveConnection;
  closePromise?: Promise<void>;
  closeFailure?: unknown;
  ready: boolean;
  advertisement?: AcceptedAdvertisementMetadata;
  authorityConnector: ConnectorRecord;
  authorityDevice: DeviceRecord;
  negotiatedLimits: FabricProtocolLimits;
  providerLease: FabricLiveConnection["descriptor"]["lease"];
  drainHandle?: unknown;
}

export interface FabricDeadlineScheduler {
  schedule(deadlineAt: number, callback: () => void): unknown;
  cancel(handle: unknown): void;
}

export interface FabricConnectionManagerOptions {
  now?: () => number;
  scheduler?: FabricDeadlineScheduler;
  terminalCapacity?: number;
}

function cancelledMessage(_signal: FabricCancellationSignal): string {
  return "Connection cancelled";
}

function defaultScheduler(now: () => number): FabricDeadlineScheduler {
  return {
    schedule(deadlineAt, callback): ReturnType<typeof setTimeout> {
      return setTimeout(callback, Math.max(0, Math.min(2_147_483_647, deadlineAt - now())));
    },
    cancel(handle): void {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

function limitsEqual(left: FabricProtocolLimits, right: FabricProtocolLimits): boolean {
  return left.maxFrameBytes === right.maxFrameBytes &&
    left.maxInFlightOperations === right.maxInFlightOperations &&
    left.heartbeatIntervalMs === right.heartbeatIntervalMs &&
    left.heartbeatTimeoutMs === right.heartbeatTimeoutMs &&
    left.maxAdvertisementItems === right.maxAdvertisementItems &&
    left.maxResultBytes === right.maxResultBytes;
}

function authorityEqual(left: ConnectorRecord | DeviceRecord, right: ConnectorRecord | DeviceRecord): boolean {
  if ("credentialGeneration" in left && "credentialGeneration" in right) {
    return left.connectorId === right.connectorId && left.label === right.label && left.transport === right.transport &&
      left.credentialGeneration === right.credentialGeneration && left.instanceNonce === right.instanceNonce &&
      left.lastSeenAt === right.lastSeenAt && left.enabled === right.enabled && left.revision === right.revision;
  }
  if ("deviceId" in left && "deviceId" in right) {
    return left.deviceId === right.deviceId && left.connectorId === right.connectorId && left.label === right.label &&
      left.connectionMode === right.connectionMode && left.platform === right.platform &&
      left.architecture === right.architecture && left.enabled === right.enabled && left.revision === right.revision;
  }
  return false;
}

/** Owns live channels while exposing only redacted, cloned connection projections. */
export class FabricConnectionManager {
  readonly #activeById = new Map<string, ManagedConnection>();
  readonly #terminalById = new Map<string, PublicConnectionLease>();
  readonly #currentByDevice = new Map<string, ManagedConnection>();
  readonly #currentByConnector = new Map<string, ManagedConnection>();
  readonly #pendingDevices = new Set<string>();
  readonly #pendingConnectors = new Set<string>();
  readonly #rejectedChannels = new WeakSet<FabricLiveConnection>();
  readonly #generationHighWater = new Map<string, number>();
  readonly #now: () => number;
  readonly #scheduler: FabricDeadlineScheduler;
  readonly #terminalCapacity: number;

  constructor(
    readonly directory: FabricDirectory,
    readonly transports: TransportRegistry,
    options: FabricConnectionManagerOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#scheduler = options.scheduler ?? defaultScheduler(this.#now);
    this.#terminalCapacity = options.terminalCapacity ?? 256;
    if (!Number.isSafeInteger(this.#terminalCapacity) || this.#terminalCapacity < 0) {
      throw new FabricContractError("invalid_argument", "terminalCapacity must be a non-negative safe integer", "terminalCapacity");
    }
  }

  async connect(request: FabricConnectRequest, signal: FabricCancellationSignal): Promise<PublicConnectionLease> {
    assertFabricIdentifier(request.requestId, "requestId");
    assertFabricIdentifier(request.deviceId, "deviceId");
    assertFabricIdentifier(request.connectorId, "connectorId");
    assertGeneration(request.expectedCredentialGeneration, "expectedCredentialGeneration");
    assertEpochMilliseconds(request.deadlineAt, "deadlineAt");
    assertValidFabricProtocolLimits(request.limits);
    if (signal.aborted) throw new FabricContractError("cancelled", cancelledMessage(signal));
    if (request.deadlineAt <= this.#now()) {
      throw new FabricContractError("deadline_exceeded", "Connection deadline has passed", "deadlineAt");
    }

    const device = this.directory.getDevice(request.deviceId);
    const connector = this.directory[FABRIC_DIRECTORY_REGISTRY_AUTHORITY](request.connectorId);
    if (device === undefined) throw new FabricContractError("not_found", "Device is not registered", "deviceId");
    if (connector === undefined) throw new FabricContractError("not_found", "Connector is not registered", "connectorId");
    this.#assertAuthorityForRequest(request, connector, device);
    const provider = this.transports.find(connector.transport);
    if (provider === undefined) {
      throw new FabricContractError("not_found", `Transport '${connector.transport}' is not registered`, "transport");
    }
    if (this.#pendingDevices.has(device.deviceId) || this.#pendingConnectors.has(connector.connectorId)) {
      throw new FabricContractError("conflict", "A connection attempt is already in progress for this device or connector", "deviceId");
    }
    const current = this.#currentByDevice.get(device.deviceId);
    const connectorCurrent = this.#currentByConnector.get(connector.connectorId);
    if (current !== undefined || connectorCurrent !== undefined) {
      throw new FabricContractError("conflict", "Explicit successful disconnect is required before replacement", "deviceId");
    }

    this.#pendingDevices.add(device.deviceId);
    this.#pendingConnectors.add(connector.connectorId);
    let channel: FabricLiveConnection | undefined;
    try {
      const connecting = beginConnection(createRegisteredConnectionState(device), request.requestId);
      try {
        channel = await provider.connect(request, signal);
      } catch {
        throw new FabricContractError("unavailable", "Transport provider failed to open a connection");
      }
      if (signal.aborted) await this.#closeRejectedChannel(channel, new FabricContractError("cancelled", cancelledMessage(signal)));
      const now = this.#now();
      if (request.deadlineAt <= now) {
        await this.#closeRejectedChannel(channel, new FabricContractError("deadline_exceeded", "Connection completed after its deadline", "deadlineAt"));
      }

      const currentDevice = this.directory.getDevice(request.deviceId);
      const currentConnector = this.directory[FABRIC_DIRECTORY_REGISTRY_AUTHORITY](request.connectorId);
      if (
        currentDevice === undefined || currentConnector === undefined ||
        !authorityEqual(currentDevice, device) || !authorityEqual(currentConnector, connector)
      ) {
        await this.#closeRejectedChannel(channel, new FabricContractError("stale_generation", "Directory authority changed during connection", "connectorId"));
      }

      const descriptor = channel.descriptor;
      if (descriptor.protocolVersion !== FABRIC_PROTOCOL_VERSION) {
        await this.#closeRejectedChannel(channel, new FabricContractError("unsupported_version", "Provider selected an unsupported Fabric protocol", "protocolVersion"));
      }
      try {
        assertValidFabricProtocolLimits(descriptor.limits);
        assertValidConnectionLease(descriptor.lease, now);
      } catch (error) {
        await this.#closeRejectedChannel(channel, error);
      }
      if (!limitsEqual(descriptor.limits, request.limits)) {
        await this.#closeRejectedChannel(channel, new FabricContractError("protocol_violation", "Provider limits do not match negotiated limits", "limits"));
      }
      if (descriptor.lease.state !== "connected") {
        await this.#closeRejectedChannel(channel, new FabricContractError("invalid_state", "Provider descriptor must be connected", "lease.state"));
      }
      if (
        descriptor.lease.deviceId !== device.deviceId ||
        descriptor.lease.connectorId !== connector.connectorId ||
        connector.instanceNonce === undefined ||
        descriptor.lease.connectorInstanceNonce !== connector.instanceNonce
      ) {
        await this.#closeRejectedChannel(channel, new FabricContractError("conflict", "Provider descriptor identity or nonce does not match authority", "lease"));
      }
      const highWater = this.#generationHighWater.get(connector.connectorId) ?? 0;
      if (descriptor.lease.generation <= highWater) {
        await this.#closeRejectedChannel(channel, new FabricContractError("stale_generation", "Connection generation must strictly increase", "lease.generation"));
      }
      if (this.#activeById.has(descriptor.lease.connectionId) || this.#terminalById.has(descriptor.lease.connectionId)) {
        await this.#closeRejectedChannel(channel, new FabricContractError("conflict", "Provider reused a connection identity", "lease.connectionId"));
      }

      const lease = { ...descriptor.lease };
      const connected = establishConnection(connecting, lease, now);
      const managed: ManagedConnection = {
        state: connected,
        channel,
        ready: false,
        authorityConnector: { ...connector },
        authorityDevice: projectDeviceClone(device),
        negotiatedLimits: { ...descriptor.limits },
        providerLease: { ...descriptor.lease },
      };
      this.#generationHighWater.set(connector.connectorId, lease.generation);
      this.#activeById.set(lease.connectionId, managed);
      this.#currentByDevice.set(device.deviceId, managed);
      // Fabric v1 invariant: a new generation fences every older generation for the Connector,
      // therefore a Connector has exactly one current physical connection even when it owns many Devices.
      this.#currentByConnector.set(connector.connectorId, managed);
      return projectConnection(lease);
    } catch (error) {
      if (channel !== undefined && !this.#isManagedChannel(channel) && !this.#rejectedChannels.has(channel)) {
        await this.#closeRejectedChannel(channel, error);
      }
      throw error;
    } finally {
      this.#pendingDevices.delete(device.deviceId);
      this.#pendingConnectors.delete(connector.connectorId);
    }
  }

  #assertAuthorityForRequest(request: FabricConnectRequest, connector: ConnectorRecord, device: DeviceRecord): void {
    if (device.connectorId !== connector.connectorId) {
      throw new FabricContractError("conflict", "Device is not owned by the selected connector", "connectorId");
    }
    if (!device.enabled || !connector.enabled) {
      throw new FabricContractError("permission_denied", "Device and connector must both be enabled");
    }
    if (connector.credentialGeneration !== request.expectedCredentialGeneration) {
      throw new FabricContractError("stale_generation", "Connector credential generation is stale", "expectedCredentialGeneration");
    }
    if (connector.instanceNonce === undefined) {
      throw new FabricContractError("unauthenticated", "Connector instance nonce is not registered", "connectorId");
    }
  }

  async #closeRejectedChannel(channel: FabricLiveConnection, cause: unknown): Promise<never> {
    this.#rejectedChannels.add(channel);
    try {
      await channel.close("connection admission rejected");
    } catch {
      throw new FabricContractError("unavailable", "Connection admission failed and the rejected channel could not be closed");
    }
    if (cause instanceof FabricContractError) throw cause;
    throw new FabricContractError("protocol_violation", "Connection admission was rejected");
  }

  #isManagedChannel(channel: FabricLiveConnection): boolean {
    for (const managed of this.#activeById.values()) if (managed.channel === channel) return true;
    return false;
  }

  acceptAdvertisement(snapshot: FabricAdvertisementSnapshot): PublicConnectionLease {
    const now = this.#now();
    assertFabricIdentifier(snapshot.connectionId, "connectionId");
    assertGeneration(snapshot.connectionGeneration, "connectionGeneration");
    if (!this.#activeById.has(snapshot.connectionId)) {
      throw new FabricContractError("stale_generation", "Advertisement connection is not current", "connectionId");
    }
    const managed = this.#requireCurrent(snapshot.connectionId, snapshot.connectionGeneration);
    this.#revalidateAuthority(managed, now);
    if (!["connected", "ready"].includes(managed.state.phase) || managed.state.connection?.state !== "connected") {
      throw new FabricContractError("invalid_state", "Only a connected, non-draining connection may advertise", "state");
    }
    const lease = managed.state.connection;
    const accepted = this.directory[FABRIC_DIRECTORY_ADVERTISEMENT_AUTHORITY]({
      connectionId: lease.connectionId,
      connectionGeneration: lease.generation,
      connectorId: lease.connectorId,
      capabilityDigest: lease.capabilityDigest,
      limits: managed.negotiatedLimits,
    }, snapshot);
    managed.advertisement = accepted;
    managed.state = markConnectionReady(managed.state);
    managed.ready = true;
    return projectConnection(lease);
  }

  get(connectionId: string): PublicConnectionLease | undefined {
    const active = this.#activeById.get(connectionId)?.state.connection;
    if (active !== undefined) return projectConnection(active);
    const terminal = this.#terminalById.get(connectionId);
    return terminal === undefined ? undefined : { ...terminal };
  }

  list(): readonly PublicConnectionLease[] {
    const leases = [
      ...[...this.#activeById.values()].flatMap((managed) => managed.state.connection === undefined ? [] : [projectConnection(managed.state.connection)]),
      ...[...this.#terminalById.values()].map((lease) => ({ ...lease })),
    ];
    return leases.sort((left, right) => left.connectionId < right.connectionId ? -1 : left.connectionId > right.connectionId ? 1 : 0);
  }

  requireReady(connectionId: string, expectedGeneration: number): PublicConnectionLease {
    const now = this.#now();
    const managed = this.#requireCurrent(connectionId, expectedGeneration);
    this.#revalidateAuthority(managed, now);
    const lease = managed.state.connection!;
    const accepted = this.directory.getAcceptedAdvertisement(lease.connectorId);
    if (
      !managed.ready || managed.advertisement === undefined || accepted === undefined ||
      accepted.connectionId !== lease.connectionId || accepted.connectionGeneration !== lease.generation ||
      accepted.advertisementRevision !== managed.advertisement.advertisementRevision ||
      accepted.capabilityDigest !== lease.capabilityDigest
    ) {
      throw new FabricContractError("invalid_state", "Connection has not completed advertisement readiness", "state");
    }
    if (managed.state.phase !== "ready" || lease.state !== "connected") {
      throw new FabricContractError("invalid_state", "Connection is not ready", "state");
    }
    return projectConnection(lease);
  }

  #requireCurrent(connectionId: string, expectedGeneration: number): ManagedConnection {
    assertFabricIdentifier(connectionId, "connectionId");
    assertGeneration(expectedGeneration, "connectionGeneration");
    const managed = this.#activeById.get(connectionId);
    const lease = managed?.state.connection;
    if (managed === undefined || lease === undefined) {
      if (this.#terminalById.has(connectionId)) {
        throw new FabricContractError("stale_generation", "Connection is terminal and no longer current", "connectionId");
      }
      throw new FabricContractError("not_found", "Connection is not active", "connectionId");
    }
    if (lease.generation !== expectedGeneration) {
      throw new FabricContractError("stale_generation", "Connection generation is stale", "connectionGeneration");
    }
    if (
      this.#currentByDevice.get(lease.deviceId) !== managed ||
      this.#currentByConnector.get(lease.connectorId) !== managed ||
      this.#generationHighWater.get(lease.connectorId) !== lease.generation
    ) {
      throw new FabricContractError("stale_generation", "Connection is no longer current", "connectionId");
    }
    return managed;
  }

  #revalidateAuthority(managed: ManagedConnection, now: number): void {
    const lease = managed.state.connection!;
    const providerLease = managed.providerLease;
    const device = this.directory.getDevice(lease.deviceId);
    const connector = this.directory[FABRIC_DIRECTORY_REGISTRY_AUTHORITY](lease.connectorId);
    try {
      if (
        device === undefined || connector === undefined || !device.enabled || !connector.enabled ||
        !authorityEqual(device, managed.authorityDevice) || !authorityEqual(connector, managed.authorityConnector) ||
        device.connectorId !== lease.connectorId || connector.instanceNonce !== lease.connectorInstanceNonce
      ) {
        throw new FabricContractError("stale_generation", "Current directory authority changed", "connectorId");
      }
      const descriptor = managed.channel?.descriptor;
      if (
        descriptor === undefined || descriptor.protocolVersion !== FABRIC_PROTOCOL_VERSION ||
        !limitsEqual(descriptor.limits, managed.negotiatedLimits) ||
        descriptor.lease.connectionId !== providerLease.connectionId || descriptor.lease.generation !== providerLease.generation ||
        descriptor.lease.deviceId !== providerLease.deviceId || descriptor.lease.connectorId !== providerLease.connectorId ||
        descriptor.lease.connectorInstanceNonce !== providerLease.connectorInstanceNonce ||
        descriptor.lease.capabilityDigest !== providerLease.capabilityDigest || descriptor.lease.state !== providerLease.state ||
        descriptor.lease.establishedAt !== providerLease.establishedAt || descriptor.lease.expiresAt !== providerLease.expiresAt ||
        descriptor.lease.revision !== providerLease.revision
      ) {
        throw new FabricContractError("protocol_violation", "Provider descriptor changed after admission", "descriptor");
      }
      assertValidFabricProtocolLimits(descriptor.limits);
      assertValidConnectionLease(descriptor.lease, now);
      assertValidConnectionLease(lease, now);
    } catch (error) {
      this.#fenceAndClose(managed, "authority revalidation failed");
      if (error instanceof FabricContractError) throw error;
      throw new FabricContractError("protocol_violation", "Authority revalidation failed");
    }
  }

  #fenceAndClose(managed: ManagedConnection, reason: string): void {
    if (managed.state.phase !== "closed") {
      const closed = closeConnection(managed.state);
      if (closed.connection !== undefined) {
        managed.state = { ...closed, connection: { ...closed.connection, revision: closed.connection.revision + 1 } };
      }
    }
    managed.ready = false;
    void this.#attemptClose(managed, reason).catch((error: unknown) => {
      managed.closeFailure = error;
    });
  }

  admitWorkspaceBinding(binding: WorkspaceBinding): void {
    const now = this.#now();
    const managed = this.#requireManagedReady(binding.connectionId, binding.connectionGeneration);
    bindWorkspace(managed.state, binding, now);
  }

  admitEndpointRoute(endpoint: EndpointRecord, route: EndpointRouteHandle, binding: WorkspaceBinding | undefined): void {
    const now = this.#now();
    const managed = this.#requireManagedReady(route.connectionId, route.connectionGeneration);
    const base = binding === undefined ? managed.state : bindWorkspace(managed.state, binding, now);
    openEndpointRoute(base, endpoint, route, now);
    assertUsableEndpointRoute(route, {
      connectionId: route.connectionId,
      connectionGeneration: route.connectionGeneration,
      endpointId: endpoint.endpointId,
      endpointGeneration: endpoint.generation,
      workspaceBindingId: binding?.bindingId,
      workspaceGeneration: binding?.workspaceGeneration,
      now,
    });
  }

  #requireManagedReady(connectionId: string, generation: number): ManagedConnection {
    this.requireReady(connectionId, generation);
    return this.#activeById.get(connectionId)!;
  }

  drain(connectionId: string, expectedGeneration: number, deadlineAt: number): PublicConnectionLease {
    assertEpochMilliseconds(deadlineAt, "deadlineAt");
    const now = this.#now();
    if (deadlineAt <= now) throw new FabricContractError("deadline_exceeded", "Drain deadline must be in the future", "deadlineAt");
    const managed = this.#requireManagedReady(connectionId, expectedGeneration);
    const currentLease = managed.state.connection!;
    if (deadlineAt > currentLease.expiresAt) {
      throw new FabricContractError("invalid_argument", "Drain deadline cannot exceed the connection lease", "deadlineAt");
    }
    const draining = beginConnectionDrain(managed.state);
    if (draining.connection === undefined) throw new FabricContractError("invalid_state", "Drain lost its connection state");
    const drainingLease = { ...draining.connection, revision: draining.connection.revision + 1 };
    managed.state = { ...draining, connection: drainingLease };
    managed.ready = false;
    managed.drainHandle = this.#scheduler.schedule(deadlineAt, () => {
      this.#fenceAndClose(managed, "drain deadline reached");
    });
    return projectConnection(drainingLease);
  }

  async disconnect(connectionId: string, expectedGeneration: number, reason = "explicit disconnect"): Promise<PublicConnectionLease> {
    assertFabricIdentifier(connectionId, "connectionId");
    assertGeneration(expectedGeneration, "connectionGeneration");
    assertBoundedString(reason, "reason", 1_024);
    const terminal = this.#terminalById.get(connectionId);
    if (terminal !== undefined) {
      if (terminal.generation !== expectedGeneration) throw new FabricContractError("stale_generation", "Connection generation is stale", "connectionGeneration");
      return { ...terminal };
    }
    const managed = this.#activeById.get(connectionId);
    const lease = managed?.state.connection;
    if (managed === undefined || lease === undefined) throw new FabricContractError("not_found", "Connection is not known", "connectionId");
    if (lease.generation !== expectedGeneration) throw new FabricContractError("stale_generation", "Connection generation is stale", "connectionGeneration");
    if (managed.state.phase !== "closed") {
      const closed = closeConnection(managed.state);
      if (closed.connection === undefined) throw new FabricContractError("invalid_state", "Close lost its connection state");
      managed.state = { ...closed, connection: { ...closed.connection, revision: closed.connection.revision + 1 } };
      managed.ready = false;
    }
    const closedLease = projectConnection(managed.state.connection!);
    await this.#attemptClose(managed, reason);
    return closedLease;
  }

  async #attemptClose(managed: ManagedConnection, reason: string): Promise<void> {
    if (managed.closePromise !== undefined) return managed.closePromise;
    const channel = managed.channel;
    const lease = managed.state.connection;
    if (channel === undefined || lease === undefined) return;
    managed.closeFailure = undefined;
    const attempt = Promise.resolve().then(() => channel.close(reason)).then(() => {
      if (managed.drainHandle !== undefined) this.#scheduler.cancel(managed.drainHandle);
      managed.drainHandle = undefined;
      managed.channel = undefined;
      if (this.#currentByDevice.get(lease.deviceId) === managed) this.#currentByDevice.delete(lease.deviceId);
      if (this.#currentByConnector.get(lease.connectorId) === managed) this.#currentByConnector.delete(lease.connectorId);
      this.#activeById.delete(lease.connectionId);
      const terminal = projectConnection(lease);
      this.#terminalById.delete(lease.connectionId);
      this.#terminalById.set(lease.connectionId, terminal);
      this.#enforceTerminalCapacity();
    }, (error: unknown) => {
      managed.closeFailure = error;
      throw new FabricContractError("unavailable", "Channel close failed; disconnect may be retried", "connectionId");
    }).finally(() => {
      managed.closePromise = undefined;
    });
    managed.closePromise = attempt;
    return attempt;
  }

  #enforceTerminalCapacity(): void {
    while (this.#terminalById.size > this.#terminalCapacity) {
      const oldest = this.#terminalById.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.#terminalById.delete(oldest);
    }
  }

  /** Explicitly compacts retained public terminal metadata; active channels are never affected. */
  compactTerminals(retain = 0): number {
    if (!Number.isSafeInteger(retain) || retain < 0) {
      throw new FabricContractError("invalid_argument", "retain must be a non-negative safe integer", "retain");
    }
    const before = this.#terminalById.size;
    while (this.#terminalById.size > retain) {
      const oldest = this.#terminalById.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#terminalById.delete(oldest);
    }
    return before - this.#terminalById.size;
  }
}

function projectDeviceClone(device: DeviceRecord): DeviceRecord {
  return {
    deviceId: device.deviceId,
    connectorId: device.connectorId,
    label: device.label,
    connectionMode: device.connectionMode,
    platform: device.platform,
    architecture: device.architecture,
    enabled: device.enabled,
    revision: device.revision,
  };
}
