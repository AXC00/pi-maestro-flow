import type { ConnectionId, ConnectorId, DeviceId } from "./common.ts";
import type { DeviceRecord } from "./device.ts";
import type { EndpointRecord } from "./endpoint.ts";
import type { EndpointRouteHandle } from "./route.ts";
import type { WorkspaceBinding } from "./workspace.ts";
import { FabricContractError, assertFabricIdentifier, assertUnexpired } from "./common.ts";
import {
  assertValidConnectionLease,
  assertValidDeviceRecord,
  assertValidEndpointRecord,
  assertValidEndpointRouteHandle,
  assertValidWorkspaceBinding,
} from "./validation.ts";

export const FABRIC_CONNECTION_STATES = ["connecting", "connected", "draining", "closed"] as const;
export type FabricConnectionState = (typeof FABRIC_CONNECTION_STATES)[number];

export interface ConnectionLease {
  connectionId: ConnectionId;
  deviceId: DeviceId;
  connectorId: ConnectorId;
  connectorInstanceNonce: string;
  generation: number;
  state: FabricConnectionState;
  capabilityDigest: string;
  establishedAt: number;
  expiresAt: number;
  revision: number;
}

export const CONNECTION_FIRST_PHASES = [
  "registered",
  "connecting",
  "connected",
  "workspace-bound",
  "endpoint-ready",
  "draining",
  "closed",
] as const;
export type ConnectionFirstPhase = (typeof CONNECTION_FIRST_PHASES)[number];

export interface ConnectionFirstState {
  phase: ConnectionFirstPhase;
  deviceId: DeviceId;
  connectorId: ConnectorId;
  connectRequestId?: string;
  previousConnectionGeneration?: number;
  connection?: ConnectionLease;
  workspaceBinding?: WorkspaceBinding;
  endpoint?: EndpointRecord;
  route?: EndpointRouteHandle;
}

function requirePhase(state: ConnectionFirstState, allowed: readonly ConnectionFirstPhase[]): void {
  if (!allowed.includes(state.phase)) {
    throw new FabricContractError(
      "invalid_state",
      `Cannot transition from ${state.phase}; expected ${allowed.join(" or ")}`,
      "phase",
    );
  }
}

export function createRegisteredConnectionState(device: DeviceRecord): ConnectionFirstState {
  assertValidDeviceRecord(device);
  return { phase: "registered", deviceId: device.deviceId, connectorId: device.connectorId };
}

export function beginConnection(
  state: ConnectionFirstState,
  connectRequestId: string,
): ConnectionFirstState {
  requirePhase(state, ["registered", "closed"]);
  assertFabricIdentifier(connectRequestId, "connectRequestId");
  return {
    phase: "connecting",
    deviceId: state.deviceId,
    connectorId: state.connectorId,
    connectRequestId,
    previousConnectionGeneration: state.connection?.generation ?? state.previousConnectionGeneration,
  };
}

export function establishConnection(
  state: ConnectionFirstState,
  connection: ConnectionLease,
  now: number,
): ConnectionFirstState {
  requirePhase(state, ["connecting"]);
  assertValidConnectionLease(connection, now);
  if (connection.state !== "connected") {
    throw new FabricContractError("invalid_state", "An established connection must be connected", "connection.state");
  }
  if (
    state.previousConnectionGeneration !== undefined &&
    connection.generation <= state.previousConnectionGeneration
  ) {
    throw new FabricContractError(
      "stale_generation",
      "A reconnected lease must use a newer connection generation",
      "connection.generation",
    );
  }
  if (connection.deviceId !== state.deviceId || connection.connectorId !== state.connectorId) {
    throw new FabricContractError("conflict", "Connection identity does not match the selected device", "connection");
  }
  return {
    phase: "connected",
    deviceId: state.deviceId,
    connectorId: state.connectorId,
    connection,
  };
}

export function bindWorkspace(
  state: ConnectionFirstState,
  binding: WorkspaceBinding,
  now: number,
): ConnectionFirstState {
  requirePhase(state, ["connected", "workspace-bound"]);
  if (!state.connection) throw new FabricContractError("invalid_state", "Connection is required", "connection");
  assertValidConnectionLease(state.connection, now);
  if (state.connection.state !== "connected") {
    throw new FabricContractError("invalid_state", "Workspace binding requires a connected lease", "connection.state");
  }
  assertValidWorkspaceBinding(binding, now);
  if (
    binding.connectionId !== state.connection.connectionId ||
    binding.connectionGeneration !== state.connection.generation ||
    binding.deviceId !== state.deviceId
  ) {
    throw new FabricContractError("stale_generation", "Workspace binding does not belong to the current connection", "binding");
  }
  return {
    phase: "workspace-bound",
    deviceId: state.deviceId,
    connectorId: state.connectorId,
    connection: state.connection,
    workspaceBinding: binding,
  };
}

export function openEndpointRoute(
  state: ConnectionFirstState,
  endpoint: EndpointRecord,
  route: EndpointRouteHandle,
  now: number,
): ConnectionFirstState {
  requirePhase(state, ["connected", "workspace-bound"]);
  if (!state.connection) throw new FabricContractError("invalid_state", "Connection is required", "connection");
  assertValidConnectionLease(state.connection, now);
  if (state.connection.state !== "connected") {
    throw new FabricContractError("invalid_state", "Route admission requires a connected lease", "connection.state");
  }
  assertValidEndpointRecord(endpoint);
  assertValidEndpointRouteHandle(route, now);
  if (route.state !== "open") {
    throw new FabricContractError("invalid_state", "Endpoint-ready state requires an open route", "route.state");
  }
  if (endpoint.status !== "online") {
    throw new FabricContractError("unavailable", "Endpoint must be online before opening a route", "endpoint.status");
  }
  if (
    endpoint.deviceId !== state.deviceId ||
    endpoint.connectorId !== state.connectorId ||
    route.connectionId !== state.connection.connectionId ||
    route.connectionGeneration !== state.connection.generation ||
    route.endpointId !== endpoint.endpointId ||
    route.endpointGeneration !== endpoint.generation
  ) {
    throw new FabricContractError("stale_generation", "Route does not match the current connection and endpoint", "route");
  }
  if (endpoint.scope.kind === "workspace") {
    const binding = state.workspaceBinding;
    if (!binding) {
      throw new FabricContractError("permission_denied", "Workspace-scoped endpoints require a binding", "workspaceBinding");
    }
    assertUnexpired(binding.expiresAt, now, "workspaceBinding.expiresAt");
    if (
      binding.workspaceId !== endpoint.scope.workspaceId ||
      route.workspaceBindingId !== binding.bindingId ||
      route.workspaceGeneration !== binding.workspaceGeneration
    ) {
      throw new FabricContractError("stale_generation", "Route does not match the current workspace binding", "route");
    }
  } else if (route.workspaceBindingId || route.workspaceGeneration !== undefined) {
    throw new FabricContractError("conflict", "Device-scoped routes cannot carry a workspace binding", "route");
  }
  return {
    phase: "endpoint-ready",
    deviceId: state.deviceId,
    connectorId: state.connectorId,
    connection: state.connection,
    workspaceBinding: endpoint.scope.kind === "workspace" ? state.workspaceBinding : undefined,
    endpoint,
    route,
  };
}

export function beginConnectionDrain(state: ConnectionFirstState): ConnectionFirstState {
  requirePhase(state, ["connected", "workspace-bound", "endpoint-ready"]);
  if (!state.connection) throw new FabricContractError("invalid_state", "Connection is required", "connection");
  return {
    phase: "draining",
    deviceId: state.deviceId,
    connectorId: state.connectorId,
    connection: { ...state.connection, state: "draining" },
  };
}

export function closeConnection(state: ConnectionFirstState): ConnectionFirstState {
  requirePhase(state, ["connecting", "connected", "workspace-bound", "endpoint-ready", "draining"]);
  return {
    phase: "closed",
    deviceId: state.deviceId,
    connectorId: state.connectorId,
    previousConnectionGeneration: state.connection?.generation ?? state.previousConnectionGeneration,
    connection: state.connection ? { ...state.connection, state: "closed" } : undefined,
  };
}
