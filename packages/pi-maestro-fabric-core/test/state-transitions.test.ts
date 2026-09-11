import assert from "node:assert/strict";
import test from "node:test";
import {
  FabricContractError,
  beginConnection,
  beginConnectionDrain,
  bindWorkspace,
  closeConnection,
  createRegisteredConnectionState,
  establishConnection,
  openEndpointRoute,
  type AgentRuntimeEndpoint,
  type ConnectionLease,
  type DeviceRecord,
  type EndpointRouteHandle,
  type WorkspaceBinding,
} from "../src/public/v1/index.ts";

const now = 1_000;

const device: DeviceRecord = {
  deviceId: "device-a",
  connectorId: "connector-a",
  label: "Workstation A",
  connectionMode: "direct",
  enabled: true,
  revision: 0,
};

const connection: ConnectionLease = {
  connectionId: "connection-a",
  deviceId: device.deviceId,
  connectorId: device.connectorId,
  connectorInstanceNonce: "instance-a",
  generation: 3,
  state: "connected",
  capabilityDigest: "sha256:capabilities",
  establishedAt: 900,
  expiresAt: 2_000,
  revision: 0,
};

const binding: WorkspaceBinding = {
  bindingId: "binding-a",
  connectionId: connection.connectionId,
  deviceId: device.deviceId,
  workspaceId: "workspace-a",
  connectionGeneration: connection.generation,
  workspaceGeneration: 5,
  policyDigest: "sha256:policy",
  issuedAt: 950,
  expiresAt: 1_900,
  revision: 0,
};

const endpoint: AgentRuntimeEndpoint = {
  kind: "agent",
  endpointId: "endpoint-a",
  deviceId: device.deviceId,
  connectorId: device.connectorId,
  scope: { kind: "workspace", workspaceId: binding.workspaceId },
  generation: 7,
  contractHash: "sha256:endpoint",
  status: "online",
  revision: 0,
  roles: ["general"],
  taskTypes: ["development"],
  models: ["model-a"],
  maxConcurrency: 2,
};

const route: EndpointRouteHandle = {
  routeId: "route-a",
  connectionId: connection.connectionId,
  workspaceBindingId: binding.bindingId,
  endpointId: endpoint.endpointId,
  connectionGeneration: connection.generation,
  workspaceGeneration: binding.workspaceGeneration,
  endpointGeneration: endpoint.generation,
  issuedAt: 980,
  expiresAt: 1_800,
  state: "open",
  revision: 0,
};

function connectedState() {
  const registered = createRegisteredConnectionState(device);
  const connecting = beginConnection(registered, "request-a");
  return establishConnection(connecting, connection, now);
}

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof FabricContractError && error.code === code);
}

test("connection-first flow reaches endpoint-ready only after binding", () => {
  const connected = connectedState();
  const workspaceBound = bindWorkspace(connected, binding, now);
  const ready = openEndpointRoute(workspaceBound, endpoint, route, now);

  assert.equal(ready.phase, "endpoint-ready");
  assert.equal(ready.route?.routeId, route.routeId);
  assert.equal(ready.workspaceBinding?.bindingId, binding.bindingId);
});

test("workspace-scoped endpoint rejects an unbound connection", () => {
  expectCode(() => openEndpointRoute(connectedState(), endpoint, route, now), "permission_denied");
});

test("route generation must match the current connection", () => {
  const workspaceBound = bindWorkspace(connectedState(), binding, now);
  expectCode(
    () => openEndpointRoute(workspaceBound, endpoint, { ...route, connectionGeneration: 2 }, now),
    "stale_generation",
  );
});

test("device-scoped routes reject workspace binding fields", () => {
  const deviceEndpoint: AgentRuntimeEndpoint = {
    ...endpoint,
    endpointId: "endpoint-device",
    scope: { kind: "device" },
  };
  const deviceRoute: EndpointRouteHandle = {
    ...route,
    routeId: "route-device",
    endpointId: deviceEndpoint.endpointId,
    endpointGeneration: deviceEndpoint.generation,
  };
  expectCode(() => openEndpointRoute(connectedState(), deviceEndpoint, deviceRoute, now), "conflict");
});

test("drain and close discard binding and route authority", () => {
  const ready = openEndpointRoute(bindWorkspace(connectedState(), binding, now), endpoint, route, now);
  const draining = beginConnectionDrain(ready);
  const closed = closeConnection(draining);

  assert.equal(draining.phase, "draining");
  assert.equal(draining.workspaceBinding, undefined);
  assert.equal(draining.route, undefined);
  assert.equal(closed.phase, "closed");
  assert.equal(closed.connection?.state, "closed");
});

test("closed connections require a new explicit begin step and generation", () => {
  const closed = closeConnection(connectedState());
  expectCode(() => establishConnection(closed, { ...connection, generation: 4 }, now), "invalid_state");

  const reconnecting = beginConnection(closed, "request-b");
  expectCode(() => establishConnection(reconnecting, connection, now), "stale_generation");
  assert.equal(establishConnection(reconnecting, { ...connection, generation: 4 }, now).phase, "connected");
});

test("a binding that expires after admission cannot open a route", () => {
  const connected = connectedState();
  const shortBinding = { ...binding, expiresAt: 1_100 };
  const workspaceBound = bindWorkspace(connected, shortBinding, now);
  expectCode(() => openEndpointRoute(workspaceBound, endpoint, route, 1_200), "expired");
});

test("cancelled reconnect attempts preserve the generation high-water mark", () => {
  const closed = closeConnection(connectedState());
  const cancelledReconnect = closeConnection(beginConnection(closed, "request-b"));
  const nextAttempt = beginConnection(cancelledReconnect, "request-c");
  expectCode(() => establishConnection(nextAttempt, connection, now), "stale_generation");
  assert.equal(establishConnection(nextAttempt, { ...connection, generation: 4 }, now).connection?.generation, 4);
});

test("binding rejects an expired or non-connected lease", () => {
  const connected = connectedState();
  expectCode(
    () => bindWorkspace({ ...connected, connection: { ...connection, expiresAt: 1_050 } }, binding, 1_100),
    "expired",
  );
  expectCode(
    () => bindWorkspace({ ...connected, connection: { ...connection, state: "closed" } }, binding, now),
    "invalid_state",
  );
});

test("endpoint-ready rejects a closed route even when its fields match", () => {
  const workspaceBound = bindWorkspace(connectedState(), binding, now);
  expectCode(
    () => openEndpointRoute(workspaceBound, endpoint, { ...route, state: "closed" }, now),
    "invalid_state",
  );
});
