import assert from "node:assert/strict";
import test from "node:test";
import {
  FabricContractError,
  type EndpointRouteHandle,
  type FabricConnectRequest,
  type FabricLiveConnection,
  type WorkspaceBinding,
} from "pi-maestro-fabric-core/v1";
import {
  FabricAdmissionManager,
  FabricConnectionManager,
  FabricDirectory,
  FabricStoreCoordinator,
  TransportRegistry,
  type FabricAdvertisementSnapshot,
  type FabricAllocatedConnectRequest,
} from "../src/index.ts";
import { MemoryFabricStore } from "./memory-store.ts";

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

async function setupDurableAuthorization() {
  const now = { value: 1100 };
  const store = new MemoryFabricStore();
  let id = 0;
  const coordinator = new FabricStoreCoordinator(store, { createId: () => `authorization-${++id}` });
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
  transports.register({
    kind: "ssh",
    connect: async (request: FabricConnectRequest): Promise<FabricLiveConnection> => {
      const allocated = request as FabricAllocatedConnectRequest;
      return {
        descriptor: {
          protocolVersion: "fabric.v1",
          limits,
          lease: {
            connectionId: allocated.allocatedConnectionId,
            deviceId: request.deviceId,
            connectorId: request.connectorId,
            connectorInstanceNonce: "nonce-a",
            generation: allocated.allocatedConnectionGeneration,
            state: "connected",
            capabilityDigest: "digest-a",
            establishedAt: 1000,
            expiresAt: 5000,
            revision: 0,
          },
        },
        exchange: async (envelope) => envelope,
        close: async () => undefined,
      };
    },
  });
  const connections = new FabricConnectionManager(directory, transports, { coordinator, now: () => now.value });
  const connection = await connections.connect({
    requestId: "connect-durable", deviceId: "device-a", connectorId: "connector-a",
    expectedCredentialGeneration: 1, deadlineAt: 3000, limits,
  }, new AbortController().signal);
  const advertised = { ...initial, connectionId: connection.connectionId, connectionGeneration: connection.generation };
  connections.acceptAdvertisement(advertised);
  const admissions = new FabricAdmissionManager(directory, connections, { coordinator, now: () => now.value });
  const bindingInput = {
    ...binding(), connectionId: connection.connectionId, connectionGeneration: connection.generation,
  };
  return { now, store, coordinator, directory, connections, admissions, connection, advertised, bindingInput };
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

test("durable binding authorization is atomic, private, restart-resolvable, and authority-fenced", async () => {
  const fixture = await setupDurableAuthorization();
  const transactions: unknown[] = [];
  fixture.store.beforeTransact = (transaction) => { transactions.push(structuredClone(transaction)); };
  const issued = await fixture.admissions.bindDurable(fixture.bindingInput, {
    localWorkspaceId: "local-workspace-a",
    localWorkspaceGeneration: 7,
  });
  assert.equal("localWorkspaceId" in issued, false, "public binding must not expose host-local authority");

  const record = await fixture.store.record("lease", issued.bindingId);
  assert.equal(record?.localWorkspaceId, "local-workspace-a");
  assert.equal(record?.localWorkspaceGeneration, 7);

  const restarted = new FabricAdmissionManager(fixture.directory, fixture.connections, {
    coordinator: fixture.coordinator,
    now: () => fixture.now.value,
  });
  assert.deepEqual(await restarted.resolveLocalWorkspaceAuthorization("workspace-a"), {
    localWorkspaceId: "local-workspace-a",
    localWorkspaceGeneration: 7,
  });
  assert.deepEqual(await restarted.resolveLocalWorkspaceBindingAuthorization(issued.bindingId), {
    localWorkspaceId: "local-workspace-a",
    localWorkspaceGeneration: 7,
  });
  const renewed = await restarted.renewBinding(issued.bindingId, issued.revision, 2600);
  assert.equal((await fixture.store.record("lease", issued.bindingId))?.localWorkspaceId, "local-workspace-a");
  await restarted.unbind(issued.bindingId, renewed.revision);
  assert.equal(await restarted.resolveLocalWorkspaceAuthorization("workspace-a"), undefined);
  assert.equal(await restarted.resolveLocalWorkspaceBindingAuthorization(issued.bindingId), undefined);
  const serializedEvents = JSON.stringify(transactions.flatMap((value) => (value as { events: unknown[] }).events));
  assert.doesNotMatch(serializedEvents, /local-workspace-a|localWorkspaceId|localWorkspaceGeneration/);

  const expired = await setupDurableAuthorization();
  await expired.admissions.bindDurable(expired.bindingInput, { localWorkspaceId: "local-workspace-a", localWorkspaceGeneration: 7 });
  expired.now.value = expired.bindingInput.expiresAt;
  assert.equal(await expired.admissions.resolveLocalWorkspaceAuthorization("workspace-a"), undefined);
  await assert.rejects(
    () => expired.admissions.resolveLocalWorkspaceBindingAuthorization(expired.bindingInput.bindingId),
    (error: unknown) => error instanceof FabricContractError,
  );

  const rotated = await setupDurableAuthorization();
  await rotated.admissions.bindDurable(rotated.bindingInput, { localWorkspaceId: "local-workspace-a", localWorkspaceGeneration: 7 });
  rotated.connections.acceptAdvertisement({
    ...rotated.advertised,
    advertisementRevision: 2,
    workspaces: rotated.advertised.workspaces.map((workspace) => ({ ...workspace, generation: 2, revision: 2 })),
  });
  assert.equal(await rotated.admissions.resolveLocalWorkspaceAuthorization("workspace-a"), undefined);
  await assert.rejects(
    () => rotated.admissions.resolveLocalWorkspaceBindingAuthorization(rotated.bindingInput.bindingId),
    (error: unknown) => error instanceof FabricContractError,
  );

  const replaced = await setupDurableAuthorization();
  await replaced.admissions.bindDurable(replaced.bindingInput, { localWorkspaceId: "local-workspace-a", localWorkspaceGeneration: 7 });
  await replaced.connections.disconnect(replaced.connection.connectionId, replaced.connection.generation);
  const next = await replaced.connections.connect({
    requestId: "connect-replacement", deviceId: "device-a", connectorId: "connector-a",
    expectedCredentialGeneration: 1, deadlineAt: 3000, limits,
  }, new AbortController().signal);
  replaced.connections.acceptAdvertisement({ ...replaced.advertised, connectionId: next.connectionId, connectionGeneration: next.generation });
  assert.equal(await replaced.admissions.resolveLocalWorkspaceAuthorization("workspace-a"), undefined);
  await assert.rejects(
    () => replaced.admissions.resolveLocalWorkspaceBindingAuthorization(replaced.bindingInput.bindingId),
    (error: unknown) => error instanceof FabricContractError,
  );
});

test("durable unbind atomically revokes a binding and closes every matching open Route without leaking private authority", async () => {
  const fixture = await setupDurableAuthorization();
  const issued = await fixture.admissions.bindDurable(fixture.bindingInput, {
    localWorkspaceId: "local-workspace-a",
    localWorkspaceGeneration: 7,
  });
  const first = await fixture.admissions.openRouteDurable({
    ...route(),
    connectionId: fixture.connection.connectionId,
    connectionGeneration: fixture.connection.generation,
    routeId: "route-cascade-a",
  });
  const second = await fixture.admissions.openRouteDurable({
    ...route(),
    connectionId: fixture.connection.connectionId,
    connectionGeneration: fixture.connection.generation,
    routeId: "route-cascade-b",
  });
  const alreadyClosed = await fixture.admissions.openRouteDurable({
    ...route(),
    connectionId: fixture.connection.connectionId,
    connectionGeneration: fixture.connection.generation,
    routeId: "route-already-closed",
  });
  await fixture.admissions.closeRoute(alreadyClosed.routeId, alreadyClosed.revision);

  const before = await fixture.coordinator.readStore("lease");
  const transactions: Array<{
    readonly events: readonly { readonly eventKind: string; readonly payload?: unknown }[];
  }> = [];
  fixture.store.beforeTransact = (transaction) => {
    transactions.push(structuredClone(transaction));
  };
  const result = await fixture.admissions.unbindWithRoutes(issued.bindingId, issued.revision);
  const after = await fixture.coordinator.readStore("lease");

  assert.equal(after.revision, before.revision + 1, "cascade must use one lease-store transaction");
  assert.equal(transactions.length, 1);
  assert.deepEqual(transactions[0]!.events.map((event) => event.eventKind), [
    "binding.revoked", "route.closed", "route.closed",
  ]);
  assert.equal(result.binding.revision, issued.revision + 1);
  assert.deepEqual(result.closedRoutes.map((entry) => [entry.routeId, entry.state, entry.revision]), [
    [first.routeId, "closed", first.revision + 1],
    [second.routeId, "closed", second.revision + 1],
  ]);
  assert.equal((await fixture.store.record("lease", issued.bindingId))?.revision, issued.revision + 1);
  assert.equal((await fixture.store.record("lease", first.routeId))?.revision, first.revision + 1);
  assert.equal((await fixture.store.record("lease", second.routeId))?.revision, second.revision + 1);
  assert.equal((await fixture.store.record("lease", alreadyClosed.routeId))?.revision, alreadyClosed.revision + 1);
  assert.equal(JSON.stringify(result).includes("localWorkspace"), false, "private authorization escaped in cleanup result");
  assert.doesNotMatch(JSON.stringify(transactions[0]!.events), /local-workspace-a|localWorkspaceId|localWorkspaceGeneration/);
  assert.throws(() => fixture.admissions.validateBinding(issued.bindingId), /not known/);
  assert.throws(() => fixture.admissions.validateRoute(first.routeId), /must be open/);
  assert.throws(() => fixture.admissions.validateRoute(second.routeId), /must be open/);
});

test("durable unbind CAS failure leaves binding and Route memory projections unchanged", async () => {
  const fixture = await setupDurableAuthorization();
  const issued = await fixture.admissions.bindDurable(fixture.bindingInput, {
    localWorkspaceId: "local-workspace-a",
    localWorkspaceGeneration: 7,
  });
  const first = await fixture.admissions.openRouteDurable({
    ...route(),
    connectionId: fixture.connection.connectionId,
    connectionGeneration: fixture.connection.generation,
    routeId: "route-cas-a",
  });
  const second = await fixture.admissions.openRouteDurable({
    ...route(),
    connectionId: fixture.connection.connectionId,
    connectionGeneration: fixture.connection.generation,
    routeId: "route-cas-b",
  });
  const restarted = new FabricAdmissionManager(fixture.directory, fixture.connections, {
    coordinator: fixture.coordinator,
    now: () => fixture.now.value,
  });
  fixture.store.beforeTransact = () => {
    throw Object.assign(new Error("stale CAS revision"), { name: "FabricStoreConflictError" });
  };

  await assert.rejects(
    () => restarted.unbindWithRoutes(issued.bindingId, issued.revision),
    (error: unknown) => error instanceof FabricContractError && error.code === "conflict",
  );
  assert.equal(restarted.getBinding(issued.bindingId), undefined, "failed CAS populated binding memory");
  assert.equal(restarted.getRoute(first.routeId), undefined, "failed CAS populated first Route memory");
  assert.equal(restarted.getRoute(second.routeId), undefined, "failed CAS populated second Route memory");
  assert.equal((await fixture.store.record("lease", issued.bindingId))?.revokedAt, undefined);
  assert.equal((await fixture.store.record("lease", first.routeId))?.state, "open");
  assert.equal((await fixture.store.record("lease", second.routeId))?.state, "open");
  assert.deepEqual(await restarted.resolveLocalWorkspaceBindingAuthorization(issued.bindingId), {
    localWorkspaceId: "local-workspace-a",
    localWorkspaceGeneration: 7,
  });
});

test("memory and durable workspace authorization select the same deterministic newest valid binding", async () => {
  const memory = await setup();
  const durable = await setupDurableAuthorization();
  const candidates = [
    { bindingId: "binding-old", issuedAt: 900, localWorkspaceId: "local-old" },
    { bindingId: "binding-new-z", issuedAt: 1050, localWorkspaceId: "local-new-z" },
    { bindingId: "binding-new-a", issuedAt: 1050, localWorkspaceId: "local-new-a" },
  ];

  for (const candidate of candidates) {
    const authorization = { localWorkspaceId: candidate.localWorkspaceId, localWorkspaceGeneration: 1 };
    await memory.admissions.bindDurable({ ...binding(), bindingId: candidate.bindingId, issuedAt: candidate.issuedAt }, authorization);
    await durable.admissions.bindDurable({
      ...durable.bindingInput,
      bindingId: candidate.bindingId,
      issuedAt: candidate.issuedAt,
    }, authorization);
  }

  const expected = { localWorkspaceId: "local-new-a", localWorkspaceGeneration: 1 };
  assert.deepEqual(await memory.admissions.resolveLocalWorkspaceAuthorization("workspace-a"), expected);
  assert.deepEqual(await durable.admissions.resolveLocalWorkspaceAuthorization("workspace-a"), expected);
  assert.deepEqual(await memory.admissions.resolveLocalWorkspaceBindingAuthorization("binding-new-z"), {
    localWorkspaceId: "local-new-z",
    localWorkspaceGeneration: 1,
  });
  assert.deepEqual(await durable.admissions.resolveLocalWorkspaceBindingAuthorization("binding-new-z"), {
    localWorkspaceId: "local-new-z",
    localWorkspaceGeneration: 1,
  });
});
