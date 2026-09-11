import assert from "node:assert/strict";
import test from "node:test";
import {
  FabricContractError,
  type EndpointRouteHandle,
  type FabricLiveConnection,
  type WorkspaceBinding,
} from "pi-maestro-fabric-core/v1";
import {
  FabricAdmissionManager,
  FabricConnectionManager,
  FabricDirectory,
  TransportRegistry,
  type FabricAdvertisementSnapshot,
} from "../src/index.ts";

const limits = {
  maxFrameBytes: 1024,
  maxInFlightOperations: 2,
  heartbeatIntervalMs: 10,
  heartbeatTimeoutMs: 20,
  maxAdvertisementItems: 20,
  maxResultBytes: 2048,
};

function advertisement(advertisementRevision = 1, endpointGeneration = 1): FabricAdvertisementSnapshot {
  return {
    connectionId: "connection-1",
    connectionGeneration: 1,
    capabilityDigest: "digest-a",
    advertisementRevision,
    devices: [{
      deviceId: "device-a",
      connectorId: "connector-a",
      label: "Device A",
      connectionMode: "ssh",
      enabled: true,
      revision: 1,
    }],
    workspaces: [{
      workspaceId: "workspace-a",
      deviceId: "device-a",
      localWorkspaceId: "private-local-id",
      label: "Workspace A",
      mode: "permanent",
      generation: 1,
      policyDigest: "policy-a",
      endpointIds: ["endpoint-workspace"],
      revision: 1,
    }],
    endpoints: [{
      endpointId: "endpoint-workspace",
      deviceId: "device-a",
      connectorId: "connector-a",
      scope: { kind: "workspace", workspaceId: "workspace-a" },
      generation: endpointGeneration,
      contractHash: `contract-${endpointGeneration}`,
      status: "online",
      revision: advertisementRevision,
      kind: "agent",
      roles: ["general"],
      taskTypes: ["development"],
      models: ["provider/model"],
      maxConcurrency: 1,
    }, {
      endpointId: "endpoint-device",
      deviceId: "device-a",
      connectorId: "connector-a",
      scope: { kind: "device" },
      generation: 1,
      contractHash: "contract-device",
      status: "online",
      revision: 1,
      kind: "mcp",
      serverName: "status",
      protocolVersion: "2025-06-18",
      transport: "http",
      durableDeduplication: false,
    }],
    capabilities: [],
  };
}

function live(generation: number, closes: string[]): FabricLiveConnection {
  return {
    descriptor: {
      protocolVersion: "fabric.v1",
      limits,
      lease: {
        connectionId: `connection-${generation}`,
        deviceId: "device-a",
        connectorId: "connector-a",
        connectorInstanceNonce: "nonce-a",
        generation,
        state: "connected",
        capabilityDigest: "digest-a",
        establishedAt: 1000,
        expiresAt: 3000,
        revision: 0,
      },
    },
    exchange: async (envelope) => envelope,
    close: async (reason) => { closes.push(reason); },
  };
}

function binding(): WorkspaceBinding {
  return {
    bindingId: "binding-a",
    connectionId: "connection-1",
    deviceId: "device-a",
    workspaceId: "workspace-a",
    connectionGeneration: 1,
    workspaceGeneration: 1,
    policyDigest: "policy-a",
    issuedAt: 1000,
    expiresAt: 2500,
    revision: 0,
  };
}

function route(endpointId = "endpoint-workspace"): EndpointRouteHandle {
  return {
    routeId: `route-${endpointId}`,
    connectionId: "connection-1",
    workspaceBindingId: endpointId === "endpoint-workspace" ? "binding-a" : undefined,
    endpointId,
    connectionGeneration: 1,
    workspaceGeneration: endpointId === "endpoint-workspace" ? 1 : undefined,
    endpointGeneration: 1,
    issuedAt: 1000,
    expiresAt: 2400,
    state: "open",
    revision: 0,
  };
}

async function setup(): Promise<{
  directory: FabricDirectory;
  connections: FabricConnectionManager;
  admissions: FabricAdmissionManager;
  setGeneration(value: number): void;
}> {
  const directory = new FabricDirectory();
  const initial = advertisement();
  directory.seedAuthority({
    connector: {
      connectorId: "connector-a", label: "Connector A", transport: "ssh", credentialGeneration: 1,
      instanceNonce: "nonce-a", enabled: true, revision: 1,
    },
    devices: initial.devices,
  });
  const transports = new TransportRegistry();
  let generation = 1;
  transports.register({ kind: "ssh", connect: async () => live(generation, []) });
  const connections = new FabricConnectionManager(directory, transports, { now: () => 1100 });
  await connections.connect({
    requestId: "connect-a",
    deviceId: "device-a",
    connectorId: "connector-a",
    expectedCredentialGeneration: 1,
    deadlineAt: 2000,
    limits,
  }, new AbortController().signal);
  connections.acceptAdvertisement(initial);
  return {
    directory,
    connections,
    admissions: new FabricAdmissionManager(directory, connections, { now: () => 1100 }),
    setGeneration(value: number): void { generation = value; },
  };
}

function expectCode(action: () => unknown, code: FabricContractError["code"]): void {
  assert.throws(action, (error: unknown) => error instanceof FabricContractError && error.code === code);
}

test("workspace binding and route admission use current connection and generation fences", async () => {
  const { admissions } = await setup();
  const storedBinding = admissions.bind(binding());
  storedBinding.policyDigest = "mutated";
  assert.equal(admissions.getBinding("binding-a")?.policyDigest, "policy-a");

  const storedRoute = admissions.openRoute(route());
  storedRoute.state = "closed";
  assert.equal(admissions.validateRoute("route-endpoint-workspace").state, "open");
  expectCode(() => admissions.openRoute(route()), "conflict");
});

test("workspace scope is mandatory and device scope rejects an attached binding", async () => {
  const { admissions } = await setup();
  const missingBinding = { ...route(), workspaceBindingId: undefined, workspaceGeneration: undefined };
  expectCode(() => admissions.openRoute(missingBinding), "permission_denied");

  admissions.bind(binding());
  const foreignBinding = {
    ...route("endpoint-device"),
    routeId: "route-device-bound",
    workspaceBindingId: "binding-a",
    workspaceGeneration: 1,
  };
  expectCode(() => admissions.openRoute(foreignBinding), "conflict");
  assert.equal(admissions.openRoute(route("endpoint-device")).endpointId, "endpoint-device");
});

test("drain, disconnect, reconnect, and endpoint generation changes invalidate old authority", async () => {
  const { directory, connections, admissions, setGeneration } = await setup();
  admissions.bind(binding());
  admissions.openRoute(route());
  connections.acceptAdvertisement(advertisement(2, 2));
  expectCode(() => admissions.validateRoute("route-endpoint-workspace"), "stale_generation");

  connections.drain("connection-1", 1, 1500);
  expectCode(() => admissions.validateRoute("route-endpoint-workspace"), "invalid_state");
  await connections.disconnect("connection-1", 1);
  expectCode(() => admissions.validateBinding("binding-a"), "stale_generation");

  setGeneration(2);
  await connections.connect({
    requestId: "connect-b",
    deviceId: "device-a",
    connectorId: "connector-a",
    expectedCredentialGeneration: 1,
    deadlineAt: 2000,
    limits,
  }, new AbortController().signal);
  expectCode(() => admissions.validateRoute("route-endpoint-workspace"), "stale_generation");
});

test("binding and route admission re-read current durable directory authority", async () => {
  const bindingCase = await setup();
  bindingCase.directory.seedAuthority({
    connector: {
      connectorId: "connector-a", label: "Connector A", transport: "ssh", credentialGeneration: 2,
      instanceNonce: "nonce-b", enabled: true, revision: 2,
    },
    devices: advertisement().devices,
  });
  expectCode(() => bindingCase.admissions.bind(binding()), "stale_generation");

  const routeCase = await setup();
  routeCase.admissions.bind(binding());
  routeCase.directory.seedAuthority({
    connector: {
      connectorId: "connector-a", label: "Connector A", transport: "ssh", credentialGeneration: 1,
      instanceNonce: "nonce-a", enabled: false, revision: 2,
    },
    devices: advertisement().devices,
  });
  expectCode(() => routeCase.admissions.openRoute(route()), "stale_generation");
});

test("stale workspace generation and policy are rejected before storage", async () => {
  const { admissions } = await setup();
  expectCode(() => admissions.bind({ ...binding(), workspaceGeneration: 2 }), "stale_generation");
  expectCode(() => admissions.bind({ ...binding(), bindingId: "binding-policy", policyDigest: "wrong" }), "stale_generation");
  assert.equal(admissions.getBinding("binding-a"), undefined);
});
