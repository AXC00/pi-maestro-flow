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
  type ConnectionLease,
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
  type FabricAcceptedExecutionView,
  type FabricAdvertisementDelta,
  type FabricAdvertisementSnapshot,
} from "./directory.ts";
import {
  FABRIC_DIRECTORY_ADVERTISEMENT_AUTHORITY,
  FABRIC_DIRECTORY_REGISTRY_AUTHORITY,
} from "./directory-authority.ts";
import { FabricStoreCoordinator } from "./store-coordinator.ts";
import { TransportRegistry } from "./transport-registry.ts";

export interface FabricAllocatedConnectRequest extends FabricConnectRequest {
  readonly allocatedConnectionId: string;
  readonly allocatedConnectionGeneration: number;
}

interface DurableConnectionReservation {
  connectionId: string;
  connectorId: string;
  deviceId: string;
  generation: number;
  revision: number;
}

interface ManagedConnection {
  state: ConnectionFirstState;
  channel?: FabricLiveConnection;
  inboundOwner?: FabricManagedConnectionOwner;
  inbound: boolean;
  /** Monotonic memory fence. Once true, renewal can never publish again. */
  closureStarted: boolean;
  /** The serial queue for renewal and durable lifecycle transitions. */
  lifecycleTail: Promise<void>;
  durableCleanupDone: boolean;
  durableCleanupFailure?: unknown;
  ownerCloseDone: boolean;
  ownerCloseAttempt?: Promise<void>;
  ownerCloseFailure?: unknown;
  ready: boolean;
  advertisement?: AcceptedAdvertisementMetadata;
  authorityConnector: ConnectorRecord;
  authorityDevice: DeviceRecord;
  negotiatedLimits: FabricProtocolLimits;
  providerLease: FabricLiveConnection["descriptor"]["lease"];
  drainHandle?: unknown;
  durableRevision?: number;
}

export interface FabricDeadlineScheduler {
  schedule(deadlineAt: number, callback: () => void): unknown;
  cancel(handle: unknown): void;
}

export interface FabricConnectionManagerOptions {
  now?: () => number;
  scheduler?: FabricDeadlineScheduler;
  terminalCapacity?: number;
  coordinator?: FabricStoreCoordinator;
}

/** Authenticated inbound Connector data supplied by the Hub handshake. */
export interface FabricInboundConnectionRequest {
  readonly requestId: string;
  readonly connectorId: string;
  readonly expectedCredentialGeneration: number;
  readonly connectorInstanceNonce: string;
  readonly capabilityDigest: string;
  readonly limits: FabricProtocolLimits;
  readonly establishedAt: number;
  readonly expiresAt: number;
}

/** Physical inbound channel ownership without inventing an outbound exchange transport. */
export interface FabricManagedConnectionOwner {
  close(reason: string): Promise<void>;
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

function assertValidPriorDurableConnection(value: Readonly<Record<string, unknown>>, connectorId: string): void {
  const fail = (field: string): never => {
    throw new FabricContractError("protocol_violation", "Durable connection record is malformed", field);
  };
  try {
    if (value.kind !== "connection") fail("kind");
    assertFabricIdentifier(value.connectionId, "connectionId");
    assertFabricIdentifier(value.connectorId, "connectorId");
    assertFabricIdentifier(value.deviceId, "deviceId");
    if (value.connectorId !== connectorId) fail("connectorId");
    assertGeneration(value.generation, "generation");
    if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) fail("revision");
    assertEpochMilliseconds(value.expiresAt, "expiresAt");
    if (!["connecting", "connected", "draining", "closed"].includes(String(value.state))) fail("state");

    const details = [
      value.connectorInstanceNonce,
      value.capabilityDigest,
      value.establishedAt,
      value.connectionRevision,
    ];
    const detailCount = details.filter((detail) => detail !== undefined).length;
    if (detailCount !== 0 && detailCount !== details.length) fail("state");
    if ((value.state === "connected" || value.state === "draining") && detailCount !== details.length) fail("state");
    if (detailCount === details.length) {
      // Reuse the canonical lease validator rather than maintaining a weaker
      // durable-record dialect. In particular, historical nonces remain Fabric
      // identifiers and corrupted identity evidence is never overwritten.
      assertValidConnectionLease({
        connectionId: value.connectionId,
        connectorId: value.connectorId,
        deviceId: value.deviceId,
        connectorInstanceNonce: value.connectorInstanceNonce,
        generation: value.generation,
        state: value.state,
        capabilityDigest: value.capabilityDigest,
        establishedAt: value.establishedAt,
        expiresAt: value.expiresAt,
        revision: value.connectionRevision,
      });
    }
  } catch (error) {
    if (error instanceof FabricContractError && error.code === "protocol_violation") throw error;
    fail(error instanceof FabricContractError ? error.path ?? "record" : "record");
  }
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
  readonly #reservationsByChannel = new WeakMap<FabricLiveConnection, DurableConnectionReservation>();
  readonly #generationHighWater = new Map<string, number>();
  readonly #now: () => number;
  readonly #scheduler: FabricDeadlineScheduler;
  readonly #terminalCapacity: number;
  readonly #coordinator?: FabricStoreCoordinator;

  constructor(
    readonly directory: FabricDirectory,
    readonly transports: TransportRegistry,
    options: FabricConnectionManagerOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#scheduler = options.scheduler ?? defaultScheduler(this.#now);
    this.#terminalCapacity = options.terminalCapacity ?? 256;
    this.#coordinator = options.coordinator;
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
    let reservation: DurableConnectionReservation | undefined;
    let durableCommitted = false;
    try {
      reservation = await this.#reserveDurableConnection(request);
      const connecting = beginConnection(createRegisteredConnectionState(device), request.requestId);
      try {
        const providerRequest: FabricConnectRequest = reservation === undefined ? request : {
          ...request,
          allocatedConnectionId: reservation.connectionId,
          allocatedConnectionGeneration: reservation.generation,
        } as FabricAllocatedConnectRequest;
        channel = await provider.connect(providerRequest, signal);
        if (reservation !== undefined) this.#reservationsByChannel.set(channel, reservation);
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
      if (
        reservation !== undefined &&
        (descriptor.lease.connectionId !== reservation.connectionId || descriptor.lease.generation !== reservation.generation)
      ) {
        await this.#closeRejectedChannel(channel, new FabricContractError("protocol_violation", "Provider did not use the durable connection allocation", "lease"));
      }
      if (this.#activeById.has(descriptor.lease.connectionId) || this.#terminalById.has(descriptor.lease.connectionId)) {
        await this.#closeRejectedChannel(channel, new FabricContractError("conflict", "Provider reused a connection identity", "lease.connectionId"));
      }

      const lease = { ...descriptor.lease };
      const connected = establishConnection(connecting, lease, now);
      const durableRevision = reservation === undefined ? undefined : await this.#commitDurableConnection(reservation, lease, now);
      durableCommitted = true;
      const managed: ManagedConnection = {
        state: connected,
        channel,
        ready: false,
        inbound: false,
        closureStarted: false,
        lifecycleTail: Promise.resolve(),
        durableCleanupDone: durableRevision === undefined,
        ownerCloseDone: false,
        authorityConnector: { ...connector },
        authorityDevice: projectDeviceClone(device),
        negotiatedLimits: { ...descriptor.limits },
        providerLease: { ...descriptor.lease },
        durableRevision,
      };
      this.#generationHighWater.set(connector.connectorId, lease.generation);
      this.#activeById.set(lease.connectionId, managed);
      this.#currentByDevice.set(device.deviceId, managed);
      // Fabric v1 invariant: a new generation fences every older generation for the Connector,
      // therefore a Connector has exactly one current physical connection even when it owns many Devices.
      this.#currentByConnector.set(connector.connectorId, managed);
      return projectConnection(lease);
    } catch (error) {
      if (reservation !== undefined && !durableCommitted && (channel === undefined || !this.#rejectedChannels.has(channel))) {
        await this.#closeDurableReservation(reservation, "connection admission rejected");
      }
      if (channel !== undefined && !this.#isManagedChannel(channel) && !this.#rejectedChannels.has(channel)) {
        await this.#closeRejectedChannel(channel, error);
      }
      throw error;
    } finally {
      this.#pendingDevices.delete(device.deviceId);
      this.#pendingConnectors.delete(connector.connectorId);
    }
  }

  /**
   * Admits an already-authenticated inbound channel. Unlike outbound connect(),
   * replacement is intentional: the durable generation is fenced before the
   * superseded physical owner is asked to close.
   */
  async acceptInbound(
    request: FabricInboundConnectionRequest,
    owner: FabricManagedConnectionOwner,
  ): Promise<PublicConnectionLease> {
    assertFabricIdentifier(request.requestId, "requestId");
    assertFabricIdentifier(request.connectorId, "connectorId");
    assertGeneration(request.expectedCredentialGeneration, "expectedCredentialGeneration");
    assertFabricIdentifier(request.connectorInstanceNonce, "connectorInstanceNonce");
    assertBoundedString(request.capabilityDigest, "capabilityDigest", 256);
    assertEpochMilliseconds(request.establishedAt, "establishedAt");
    assertEpochMilliseconds(request.expiresAt, "expiresAt");
    assertValidFabricProtocolLimits(request.limits);
    const now = this.#now();
    if (request.establishedAt > now || request.expiresAt <= now) {
      throw new FabricContractError("expired", "Inbound connection lease must contain the current time", "expiresAt");
    }
    const connector = this.directory[FABRIC_DIRECTORY_REGISTRY_AUTHORITY](request.connectorId);
    if (connector === undefined) throw new FabricContractError("not_found", "Connector is not registered", "connectorId");
    if (!connector.enabled) throw new FabricContractError("permission_denied", "Connector is disabled", "connectorId");
    if (connector.credentialGeneration !== request.expectedCredentialGeneration) {
      throw new FabricContractError("stale_generation", "Connector credential generation is stale", "expectedCredentialGeneration");
    }
    const device = this.directory.list().devices
      .filter((candidate) => candidate.connectorId === connector.connectorId && candidate.enabled)
      .sort((left, right) => left.deviceId.localeCompare(right.deviceId))[0];
    if (device === undefined) {
      throw new FabricContractError("not_found", "Connector has no enabled authority Device", "connectorId");
    }
    if (this.#pendingConnectors.has(connector.connectorId)) {
      throw new FabricContractError("conflict", "A connection attempt is already in progress for this connector", "connectorId");
    }

    this.#pendingConnectors.add(connector.connectorId);
    const previous = this.#currentByConnector.get(connector.connectorId);
    let reservation: DurableConnectionReservation | undefined;
    let committed = false;
    try {
      reservation = await this.#reserveInboundConnection(request, device.deviceId);
      // The reservation is the durable generation fence. Mirror that fence in
      // memory before any later await so the overwritten predecessor can no
      // longer authorize work even when admission subsequently fails.
      if (reservation !== undefined) {
        this.#generationHighWater.set(connector.connectorId, reservation.generation);
        if (previous !== undefined) {
          this.#fenceReplacedInbound(previous, "superseded by a newer connection generation");
        }
      }
      let checkedAt = this.#now();
      this.#assertInboundAuthority(request, connector, device, checkedAt);
      const connectionId = reservation?.connectionId ?? `connection-${crypto.randomUUID()}`;
      const generation = reservation?.generation
        ?? (this.#generationHighWater.get(connector.connectorId) ?? 0) + 1;
      if (!Number.isSafeInteger(generation)) {
        throw new FabricContractError("resource_exhausted", "Connection generation is exhausted", "generation");
      }
      const lease: ConnectionLease = {
        connectionId,
        deviceId: device.deviceId,
        connectorId: connector.connectorId,
        connectorInstanceNonce: request.connectorInstanceNonce,
        generation,
        state: "connected",
        capabilityDigest: request.capabilityDigest,
        establishedAt: request.establishedAt,
        expiresAt: request.expiresAt,
        revision: 0,
      };
      const connecting = beginConnection(createRegisteredConnectionState(device), request.requestId);
      const connected = establishConnection(connecting, lease, checkedAt);
      const durableRevision = reservation === undefined
        ? undefined
        : await this.#commitDurableConnection(reservation, lease, checkedAt);
      checkedAt = this.#now();
      this.#assertInboundAuthority(request, connector, device, checkedAt);
      const managed: ManagedConnection = {
        state: connected,
        inboundOwner: owner,
        inbound: true,
        closureStarted: false,
        lifecycleTail: Promise.resolve(),
        durableCleanupDone: durableRevision === undefined,
        ownerCloseDone: false,
        ready: false,
        authorityConnector: { ...connector },
        authorityDevice: projectDeviceClone(device),
        negotiatedLimits: { ...request.limits },
        providerLease: { ...lease },
        durableRevision,
      };
      this.#generationHighWater.set(connector.connectorId, generation);
      this.#activeById.set(connectionId, managed);
      this.#currentByDevice.set(device.deviceId, managed);
      this.#currentByConnector.set(connector.connectorId, managed);
      if (reservation === undefined && previous !== undefined && previous !== managed) {
        this.#fenceReplacedInbound(previous, "superseded by a newer connection generation");
      }
      committed = true;
      return projectConnection(lease);
    } catch (error) {
      if (committed) throw error;
      const cleanupFailures: unknown[] = [];
      if (reservation !== undefined) {
        try {
          await this.#closeDurableReservation(reservation, "inbound connection admission rejected");
        } catch (rollbackError) {
          cleanupFailures.push(rollbackError);
        }
      }
      try {
        await owner.close("inbound connection admission rejected");
      } catch (ownerError) {
        cleanupFailures.push(ownerError);
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          "Inbound connection admission failed and cleanup remains retryable",
          { cause: error },
        );
      }
      throw error;
    } finally {
      this.#pendingConnectors.delete(connector.connectorId);
    }
  }

  /** Renews only the exact current inbound generation and commits before publishing it. */
  async renewInboundLease(
    connectionId: string,
    expectedGeneration: number,
    expiresAt: number,
  ): Promise<PublicConnectionLease> {
    assertEpochMilliseconds(expiresAt, "expiresAt");
    const managed = this.#requireCurrent(connectionId, expectedGeneration);
    this.#assertRenewableInbound(managed, connectionId, expectedGeneration, expiresAt, this.#now());
    return this.#enqueueLifecycle(managed, async () => {
      const current = this.#assertRenewableInbound(managed, connectionId, expectedGeneration, expiresAt, this.#now());
      const next: ConnectionLease = { ...current, expiresAt, revision: current.revision + 1 };
      assertValidConnectionLease(next, this.#now());
      if (this.#coordinator !== undefined && managed.durableRevision !== undefined) {
        const expectedRevision = managed.durableRevision;
        const durableRevision = expectedRevision + 1;
        await this.#coordinator.commit("lease", this.#now(), (store) => {
          const durable = store.records[current.connectorId];
          if (durable !== undefined) assertValidPriorDurableConnection(durable, current.connectorId);
          if (durable?.revision !== expectedRevision || durable.connectionId !== connectionId || durable.generation !== expectedGeneration) {
            throw new FabricContractError("stale_generation", "Durable connection lease is no longer current", "connectionId");
          }
          return {
            mutations: [{
              kind: "upsert",
              subjectId: current.connectorId,
              expectedRevision,
              value: { ...durable, expiresAt, connectionRevision: next.revision, revision: durableRevision },
              eventKind: "connection.renewed",
              payload: { connectionId, connectorId: current.connectorId, generation: expectedGeneration, expiresAt },
            }],
            value: durableRevision,
          };
        });
        // The commit belongs to this captured owner even if a later generation
        // fences it before the continuation resumes. Cleanup must observe the
        // committed revision, while publication below still requires currency.
        this.#assertManagedIdentity(managed, connectionId, expectedGeneration);
        managed.durableRevision = durableRevision;
      }
      const after = this.#assertRenewableInbound(managed, connectionId, expectedGeneration, expiresAt, this.#now());
      if (after !== current || after.revision !== current.revision || after.expiresAt !== current.expiresAt) {
        throw new FabricContractError("stale_generation", "Connection changed while its lease was renewing", "connectionId");
      }
      managed.state = { ...managed.state, connection: next };
      managed.providerLease = { ...next };
      return projectConnection(next);
    });
  }

  #assertRenewableInbound(
    managed: ManagedConnection,
    connectionId: string,
    expectedGeneration: number,
    expiresAt: number,
    now: number,
  ): ConnectionLease {
    if (this.#requireCurrent(connectionId, expectedGeneration) !== managed) {
      throw new FabricContractError("stale_generation", "Connection owner changed while its lease was renewing", "connectionId");
    }
    if (!managed.inbound) throw new FabricContractError("invalid_state", "Only inbound leases are heartbeat-renewed", "connectionId");
    if (managed.closureStarted) {
      throw new FabricContractError("invalid_state", "Connection closure has started and cannot be renewed", "state");
    }
    const current = managed.state.connection!;
    if ((managed.state.phase !== "connected" && managed.state.phase !== "ready") || current.state !== "connected") {
      throw new FabricContractError("invalid_state", "Only a live connected inbound lease may renew", "state");
    }
    this.#revalidateAuthority(managed, now);
    if (expiresAt <= current.expiresAt) {
      throw new FabricContractError("invalid_argument", "Connection renewal must extend expiry", "expiresAt");
    }
    assertValidConnectionLease({ ...current, expiresAt }, now);
    return current;
  }

  async #reserveInboundConnection(
    request: FabricInboundConnectionRequest,
    deviceId: string,
  ): Promise<DurableConnectionReservation | undefined> {
    if (this.#coordinator === undefined) return undefined;
    const connectionId = `connection-${crypto.randomUUID()}`;
    return this.#coordinator.commit("lease", this.#now(), (store) => {
      const previous = store.records[request.connectorId];
      if (previous !== undefined) assertValidPriorDurableConnection(previous, request.connectorId);
      const previousRevision = previous?.revision as number | undefined;
      const priorGeneration = previous?.generation as number | undefined;
      const generation = Math.max(priorGeneration ?? 0, this.#generationHighWater.get(request.connectorId) ?? 0) + 1;
      if (!Number.isSafeInteger(generation)) throw new FabricContractError("resource_exhausted", "Connection generation is exhausted", "generation");
      const revision = (previousRevision ?? 0) + 1;
      return {
        mutations: [{
          kind: "upsert",
          subjectId: request.connectorId,
          expectedRevision: previousRevision as number | undefined,
          value: {
            revision,
            kind: "connection",
            connectionId,
            connectorId: request.connectorId,
            deviceId,
            generation,
            state: "connecting",
            expiresAt: request.expiresAt,
          },
          eventKind: "connection.connecting",
          payload: { connectionId, connectorId: request.connectorId, deviceId, generation, state: "connecting" },
        }],
        value: { connectionId, connectorId: request.connectorId, deviceId, generation, revision },
      };
    });
  }

  #assertInboundAuthority(
    request: FabricInboundConnectionRequest,
    expectedConnector: ConnectorRecord,
    expectedDevice: DeviceRecord,
    now: number,
  ): void {
    if (request.establishedAt > now || request.expiresAt <= now) {
      throw new FabricContractError("expired", "Inbound connection lease expired during admission", "expiresAt");
    }
    const connector = this.directory[FABRIC_DIRECTORY_REGISTRY_AUTHORITY](request.connectorId);
    const device = this.directory.getDevice(expectedDevice.deviceId);
    if (
      connector === undefined || device === undefined || !connector.enabled || !device.enabled ||
      !authorityEqual(connector, expectedConnector) || !authorityEqual(device, expectedDevice) ||
      device.connectorId !== connector.connectorId || connector.credentialGeneration !== request.expectedCredentialGeneration
    ) {
      throw new FabricContractError("stale_generation", "Directory authority changed during inbound admission", "connectorId");
    }
  }

  #fenceReplacedInbound(managed: ManagedConnection, reason: string): void {
    this.#fenceMemory(managed);
    void this.#enqueueCleanup(managed, reason).catch(() => {
      // Per-step failures are retained on the ManagedConnection for explicit
      // disconnect retry; automatic fencing must never create an unhandled rejection.
    });
  }

  async #reserveDurableConnection(request: FabricConnectRequest): Promise<DurableConnectionReservation | undefined> {
    if (this.#coordinator === undefined) return undefined;
    const at = this.#now();
    const allocatedConnectionId = `connection-${crypto.randomUUID()}`;
    return this.#coordinator.commit("lease", at, (store) => {
      const previous = store.records[request.connectorId];
      if (previous !== undefined) assertValidPriorDurableConnection(previous, request.connectorId);
      const previousRevision = previous?.revision as number | undefined;
      if (previous !== undefined && previous.state !== "closed") {
        throw new FabricContractError("conflict", "A durable connection generation is still active", "connectorId");
      }
      const priorGeneration = previous?.generation as number | undefined;
      const generation = Math.max(priorGeneration ?? 0, this.#generationHighWater.get(request.connectorId) ?? 0) + 1;
      if (!Number.isSafeInteger(generation)) throw new FabricContractError("resource_exhausted", "Connection generation is exhausted", "generation");
      const revision = (previousRevision ?? 0) + 1;
      const reservation: DurableConnectionReservation = {
        connectionId: allocatedConnectionId,
        connectorId: request.connectorId,
        deviceId: request.deviceId,
        generation,
        revision,
      };
      return {
        mutations: [{
          kind: "upsert",
          subjectId: request.connectorId,
          expectedRevision: previousRevision as number | undefined,
          value: {
            revision,
            kind: "connection",
            connectionId: allocatedConnectionId,
            connectorId: request.connectorId,
            deviceId: request.deviceId,
            generation,
            state: "connecting",
            expiresAt: request.deadlineAt,
          },
          eventKind: "connection.connecting",
          payload: { connectionId: allocatedConnectionId, connectorId: request.connectorId, deviceId: request.deviceId, generation, state: "connecting" },
        }],
        value: reservation,
      };
    });
  }

  async #commitDurableConnection(
    reservation: DurableConnectionReservation,
    lease: FabricLiveConnection["descriptor"]["lease"],
    at: number,
  ): Promise<number> {
    if (this.#coordinator === undefined) return reservation.revision;
    const revision = reservation.revision + 1;
    return this.#coordinator.commit("lease", at, (store) => {
      const current = store.records[reservation.connectorId];
      if (
        current?.revision !== reservation.revision || current.connectionId !== reservation.connectionId ||
        current.generation !== reservation.generation || current.state !== "connecting"
      ) {
        throw new FabricContractError("stale_generation", "Durable connection reservation is no longer current", "connectionId");
      }
      return {
        mutations: [{
          kind: "upsert",
          subjectId: reservation.connectorId,
          expectedRevision: reservation.revision,
          value: {
            revision,
            kind: "connection",
            connectionId: lease.connectionId,
            connectorId: lease.connectorId,
            deviceId: lease.deviceId,
            connectorInstanceNonce: lease.connectorInstanceNonce,
            generation: lease.generation,
            state: lease.state,
            capabilityDigest: lease.capabilityDigest,
            establishedAt: lease.establishedAt,
            expiresAt: lease.expiresAt,
            connectionRevision: lease.revision,
          },
          eventKind: "connection.connected",
          payload: { connectionId: lease.connectionId, connectorId: lease.connectorId, deviceId: lease.deviceId, generation: lease.generation, state: lease.state },
        }],
        value: revision,
      };
    });
  }

  async #closeDurableReservation(reservation: DurableConnectionReservation, reason: string): Promise<void> {
    if (this.#coordinator === undefined) return;
    const at = this.#now();
    await this.#coordinator.commit("lease", at, (store) => {
      const current = store.records[reservation.connectorId];
      if (current === undefined) return { mutations: [], value: undefined };
      assertValidPriorDurableConnection(current, reservation.connectorId);
      if (current.connectionId !== reservation.connectionId || current.generation !== reservation.generation) {
        return { mutations: [], value: undefined };
      }
      const currentRevision = current.revision as number;
      return {
        mutations: [{
          kind: "upsert",
          subjectId: reservation.connectorId,
          expectedRevision: currentRevision,
          value: { ...current, state: "closed", revision: currentRevision + 1 },
          eventKind: "connection.closed",
          payload: { connectionId: reservation.connectionId, connectorId: reservation.connectorId, generation: reservation.generation, state: "closed", reason },
        }],
        value: undefined,
      };
    });
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
    const reservation = this.#reservationsByChannel.get(channel);
    if (reservation !== undefined) await this.#closeDurableReservation(reservation, "connection admission rejected");
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

  acceptAdvertisementDelta(delta: FabricAdvertisementDelta): PublicConnectionLease {
    const now = this.#now();
    assertFabricIdentifier(delta.connectionId, "connectionId");
    assertGeneration(delta.connectionGeneration, "connectionGeneration");
    const managed = this.#requireCurrent(delta.connectionId, delta.connectionGeneration);
    this.#revalidateAuthority(managed, now);
    if (!managed.ready || managed.state.phase !== "ready" || managed.state.connection?.state !== "connected") {
      throw new FabricContractError("invalid_state", "Advertisement deltas require a ready connection", "state");
    }
    const lease = managed.state.connection;
    const accepted = this.directory[FABRIC_DIRECTORY_ADVERTISEMENT_AUTHORITY]({
      connectionId: lease.connectionId,
      connectionGeneration: lease.generation,
      connectorId: lease.connectorId,
      capabilityDigest: lease.capabilityDigest,
      limits: managed.negotiatedLimits,
    }, delta);
    managed.advertisement = accepted;
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

  requireReadyForDevice(connectionId: string, expectedGeneration: number, deviceId: string): PublicConnectionLease {
    assertFabricIdentifier(deviceId, "deviceId");
    const lease = this.requireReady(connectionId, expectedGeneration);
    const device = this.directory.getDevice(deviceId);
    if (device === undefined || !device.enabled || device.connectorId !== lease.connectorId) {
      throw new FabricContractError("permission_denied", "Device is not allowlisted for the current Connector", "deviceId");
    }
    const view = this.directory.getAcceptedExecutionView(lease.connectorId, deviceId);
    if (
      view === undefined || view.connectionId !== lease.connectionId ||
      view.connectionGeneration !== lease.generation || view.capabilityDigest !== lease.capabilityDigest ||
      view.devices.length !== 1 || !authorityEqual(view.devices[0]!, device)
    ) {
      throw new FabricContractError("stale_generation", "Device is not present in the accepted advertisement", "deviceId");
    }
    return lease;
  }

  getAcceptedExecutionView(
    connectionId: string,
    expectedGeneration: number,
    deviceId?: string,
  ): FabricAcceptedExecutionView {
    const lease = deviceId === undefined
      ? this.requireReady(connectionId, expectedGeneration)
      : this.requireReadyForDevice(connectionId, expectedGeneration, deviceId);
    const view = this.directory.getAcceptedExecutionView(lease.connectorId, deviceId);
    if (view === undefined || view.connectionId !== lease.connectionId || view.connectionGeneration !== lease.generation) {
      throw new FabricContractError("stale_generation", "Accepted execution view is no longer current", "connectionId");
    }
    return view;
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
        device.connectorId !== lease.connectorId || (!managed.inbound && connector.instanceNonce !== lease.connectorInstanceNonce)
      ) {
        throw new FabricContractError("stale_generation", "Current directory authority changed", "connectorId");
      }
      const descriptor = managed.channel?.descriptor;
      if (!managed.inbound) {
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
      }
      assertValidConnectionLease(lease, now);
    } catch (error) {
      this.#fenceAndClose(managed, "authority revalidation failed");
      if (error instanceof FabricContractError) throw error;
      throw new FabricContractError("protocol_violation", "Authority revalidation failed");
    }
  }

  #fenceAndClose(managed: ManagedConnection, reason: string): void {
    this.#fenceMemory(managed);
    void this.#enqueueCleanup(managed, reason).catch(() => {
      // Automatic cleanup is best-effort. Durable and owner failures remain
      // independently retryable through disconnect().
    });
  }

  admitWorkspaceBinding(binding: WorkspaceBinding): void {
    const now = this.#now();
    const managed = this.#requireManagedReadyForDevice(binding.connectionId, binding.connectionGeneration, binding.deviceId);
    bindWorkspace({ ...managed.state, deviceId: binding.deviceId }, binding, now);
  }

  admitEndpointRoute(endpoint: EndpointRecord, route: EndpointRouteHandle, binding: WorkspaceBinding | undefined): void {
    const now = this.#now();
    const managed = this.#requireManagedReadyForDevice(route.connectionId, route.connectionGeneration, endpoint.deviceId);
    const deviceState = { ...managed.state, deviceId: endpoint.deviceId };
    const base = binding === undefined ? deviceState : bindWorkspace(deviceState, binding, now);
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

  #requireManagedReadyForDevice(connectionId: string, generation: number, deviceId: string): ManagedConnection {
    this.requireReadyForDevice(connectionId, generation, deviceId);
    return this.#activeById.get(connectionId)!;
  }

  drain(connectionId: string, expectedGeneration: number, deadlineAt: number): PublicConnectionLease {
    assertEpochMilliseconds(deadlineAt, "deadlineAt");
    const now = this.#now();
    if (deadlineAt <= now) throw new FabricContractError("deadline_exceeded", "Drain deadline must be in the future", "deadlineAt");
    const managed = this.#requireCurrent(connectionId, expectedGeneration);
    this.#revalidateAuthority(managed, now);
    const currentLease = managed.state.connection!;
    if (managed.closureStarted || (managed.state.phase !== "connected" && managed.state.phase !== "ready") || currentLease.state !== "connected") {
      throw new FabricContractError("invalid_state", "Only an admitted connected generation may drain", "state");
    }
    if (deadlineAt > currentLease.expiresAt) {
      throw new FabricContractError("invalid_argument", "Drain deadline cannot exceed the connection lease", "deadlineAt");
    }
    const draining = beginConnectionDrain(managed.state);
    if (draining.connection === undefined) throw new FabricContractError("invalid_state", "Drain lost its connection state");
    const drainingLease = { ...draining.connection, revision: draining.connection.revision + 1 };
    managed.closureStarted = true;
    managed.state = { ...draining, connection: drainingLease };
    managed.ready = false;
    void this.#enqueueLifecycle(managed, async () => {
      try {
        await this.#persistLeaseState(managed, drainingLease, "explicit drain");
      } catch (error) {
        managed.durableCleanupFailure = error;
        throw error;
      }
    }).catch(() => {
      // A later deadline/disconnect cleanup retries from the durable record.
    });
    const ownerConnectionId = drainingLease.connectionId;
    const ownerGeneration = drainingLease.generation;
    managed.drainHandle = this.#scheduler.schedule(deadlineAt, () => {
      if (!this.#isManagedIdentity(managed, ownerConnectionId, ownerGeneration)) return;
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
    this.#fenceMemory(managed);
    const closedLease = projectConnection(managed.state.connection!);
    await this.#enqueueCleanup(managed, reason);
    return closedLease;
  }

  #enqueueLifecycle<T>(managed: ManagedConnection, action: () => Promise<T>): Promise<T> {
    const run = managed.lifecycleTail.then(action);
    managed.lifecycleTail = run.then(() => undefined, () => undefined);
    return run;
  }

  #isManagedIdentity(managed: ManagedConnection, connectionId: string, generation: number): boolean {
    const lease = managed.state.connection;
    return this.#activeById.get(connectionId) === managed && lease?.connectionId === connectionId && lease.generation === generation;
  }

  #assertManagedIdentity(managed: ManagedConnection, connectionId: string, generation: number): void {
    if (!this.#isManagedIdentity(managed, connectionId, generation)) {
      throw new FabricContractError("stale_generation", "Connection owner changed during lifecycle work", "connectionId");
    }
  }

  #fenceMemory(managed: ManagedConnection): void {
    managed.closureStarted = true;
    if (managed.state.phase !== "closed") {
      const closed = closeConnection(managed.state);
      if (closed.connection === undefined) throw new FabricContractError("invalid_state", "Close lost its connection state");
      managed.state = { ...closed, connection: { ...closed.connection, revision: closed.connection.revision + 1 } };
    }
    managed.ready = false;
  }

  #enqueueCleanup(managed: ManagedConnection, reason: string): Promise<void> {
    const lease = managed.state.connection;
    if (lease === undefined) return Promise.resolve();

    // Physical ownership is fenced independently from durable serialization.
    // A non-settling store operation must never keep the transport alive.
    const ownerAttempt = this.#startOwnerCleanup(managed, lease, reason);
    const durableAttempt = this.#enqueueLifecycle(managed, async () => {
      if (managed.durableCleanupDone) return;
      try {
        await this.#attemptDurableCleanup(managed, lease, reason);
        managed.durableCleanupDone = true;
        managed.durableCleanupFailure = undefined;
      } catch (error) {
        managed.durableCleanupFailure = error;
        throw error;
      }
    });

    return Promise.allSettled([durableAttempt, ownerAttempt]).then((results) => {
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (managed.durableCleanupDone && managed.ownerCloseDone) this.#finalizeManaged(managed, lease);
      if (failures.length > 0) {
        const failure = new FabricContractError("unavailable", "Connection cleanup incomplete; disconnect may be retried", "connectionId");
        Object.defineProperty(failure, "cause", {
          configurable: true,
          value: failures.length === 1 ? failures[0] : new AggregateError(failures, "Connection cleanup steps failed"),
        });
        throw failure;
      }
    });
  }

  #startOwnerCleanup(managed: ManagedConnection, lease: ConnectionLease, reason: string): Promise<void> {
    if (managed.ownerCloseDone) return Promise.resolve();
    if (managed.ownerCloseAttempt !== undefined) return managed.ownerCloseAttempt;

    const attempt = Promise.resolve().then(() => this.#attemptOwnerClose(managed, lease, reason)).then(() => {
      managed.ownerCloseDone = true;
      managed.ownerCloseFailure = undefined;
    }, (error: unknown) => {
      managed.ownerCloseFailure = error;
      throw error;
    }).finally(() => {
      if (managed.ownerCloseAttempt === attempt) managed.ownerCloseAttempt = undefined;
    });
    managed.ownerCloseAttempt = attempt;
    return attempt;
  }

  async #persistLeaseState(managed: ManagedConnection, lease: ConnectionLease, reason: string): Promise<void> {
    if (this.#coordinator === undefined || managed.durableRevision === undefined) return;
    const expectedRevision = managed.durableRevision;
    const nextRevision = expectedRevision + 1;
    await this.#coordinator.commit("lease", this.#now(), (store) => {
      const current = store.records[lease.connectorId];
      if (current !== undefined) assertValidPriorDurableConnection(current, lease.connectorId);
      if (
        current?.revision !== expectedRevision || current.connectionId !== lease.connectionId ||
        current.generation !== lease.generation
      ) {
        throw new FabricContractError("stale_generation", "Durable connection lease is no longer current", "connectionId");
      }
      return {
        mutations: [{
          kind: "upsert",
          subjectId: lease.connectorId,
          expectedRevision,
          value: {
            ...current,
            state: lease.state,
            expiresAt: lease.expiresAt,
            connectionRevision: lease.revision,
            revision: nextRevision,
          },
          eventKind: `connection.${lease.state}`,
          payload: { connectionId: lease.connectionId, connectorId: lease.connectorId, generation: lease.generation, state: lease.state, reason },
        }],
        value: undefined,
      };
    });
    this.#assertManagedIdentity(managed, lease.connectionId, lease.generation);
    managed.durableRevision = nextRevision;
  }

  async #attemptDurableCleanup(managed: ManagedConnection, lease: ConnectionLease, reason: string): Promise<void> {
    if (this.#coordinator === undefined || managed.durableRevision === undefined) return;
    const at = this.#now();
    const committedRevision = await this.#coordinator.commit("lease", at, (store) => {
      const current = store.records[lease.connectorId];
      if (current === undefined) return { mutations: [], value: managed.durableRevision! };
      assertValidPriorDurableConnection(current, lease.connectorId);
      if (current.connectionId !== lease.connectionId || current.generation !== lease.generation) {
        // A newer durable generation is already the authoritative fence.
        return { mutations: [], value: managed.durableRevision! };
      }
      const currentRevision = current.revision as number;
      if (current.state === "closed") return { mutations: [], value: currentRevision };
      const nextRevision = currentRevision + 1;
      return {
        mutations: [{
          kind: "upsert",
          subjectId: lease.connectorId,
          expectedRevision: currentRevision,
          value: {
            ...current,
            state: "closed",
            // Preserve the memory-fenced lease boundary. A renewal that was
            // already inside its durable await must not extend closure.
            expiresAt: lease.expiresAt,
            connectionRevision: lease.revision,
            revision: nextRevision,
          },
          eventKind: "connection.closed",
          payload: { connectionId: lease.connectionId, connectorId: lease.connectorId, generation: lease.generation, state: "closed", reason },
        }],
        value: nextRevision,
      };
    });
    this.#assertManagedIdentity(managed, lease.connectionId, lease.generation);
    managed.durableRevision = committedRevision;
  }

  async #attemptOwnerClose(managed: ManagedConnection, lease: ConnectionLease, reason: string): Promise<void> {
    const owner = managed.channel ?? managed.inboundOwner;
    if (owner === undefined) return;
    await owner.close(reason);
    this.#assertManagedIdentity(managed, lease.connectionId, lease.generation);
    if (managed.channel === owner) managed.channel = undefined;
    if (managed.inboundOwner === owner) managed.inboundOwner = undefined;
  }

  #finalizeManaged(managed: ManagedConnection, lease: ConnectionLease): void {
    if (!this.#isManagedIdentity(managed, lease.connectionId, lease.generation)) return;
    if (managed.drainHandle !== undefined) this.#scheduler.cancel(managed.drainHandle);
    managed.drainHandle = undefined;
    if (this.#currentByDevice.get(lease.deviceId) === managed) this.#currentByDevice.delete(lease.deviceId);
    if (this.#currentByConnector.get(lease.connectorId) === managed) this.#currentByConnector.delete(lease.connectorId);
    if (this.#activeById.get(lease.connectionId) === managed) this.#activeById.delete(lease.connectionId);
    const terminal = projectConnection(lease);
    this.#terminalById.delete(lease.connectionId);
    this.#terminalById.set(lease.connectionId, terminal);
    this.#enforceTerminalCapacity();
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
