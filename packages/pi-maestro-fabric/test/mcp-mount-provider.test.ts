import assert from "node:assert/strict";
import test from "node:test";
import {
  FabricMcpMountProvider,
  type FabricMcpMountConnectionAuthority,
} from "../src/mcp-mount-provider.ts";
import type {
  EndpointRecord,
  EndpointRouteHandle,
  PublicConnectionLease,
  WorkspaceBinding,
} from "pi-maestro-fabric-core/v1";

function fixture() {
  let now = 1_000;
  let mountSequence = 0;
  const endpoint: EndpointRecord = {
    endpointId: "endpoint-files",
    deviceId: "device-edge",
    connectorId: "connector-edge",
    scope: { kind: "workspace", workspaceId: "workspace-project" },
    generation: 3,
    contractHash: "a".repeat(64),
    status: "online",
    revision: 1,
    kind: "mcp",
    serverName: "files",
    protocolVersion: "2025-11-25",
    transport: "streamable-http",
    durableDeduplication: false,
  };
  const route: EndpointRouteHandle = {
    routeId: "route-files",
    connectionId: "connection-edge",
    workspaceBindingId: "binding-project",
    endpointId: endpoint.endpointId,
    connectionGeneration: 4,
    workspaceGeneration: 2,
    endpointGeneration: endpoint.generation,
    issuedAt: 900,
    expiresAt: 10_000,
    state: "open",
    revision: 5,
    deviceId: endpoint.deviceId,
    operationClass: "mcp-read",
    pathCandidates: ["hub"],
    selectedPath: "hub",
  };
  const binding: WorkspaceBinding = {
    bindingId: "binding-project",
    connectionId: route.connectionId,
    deviceId: endpoint.deviceId,
    workspaceId: "workspace-project",
    connectionGeneration: route.connectionGeneration,
    workspaceGeneration: route.workspaceGeneration!,
    policyDigest: "b".repeat(64),
    issuedAt: 900,
    expiresAt: 10_000,
    revision: 1,
  };
  const connection: PublicConnectionLease = {
    connectionId: route.connectionId,
    deviceId: endpoint.deviceId,
    connectorId: endpoint.connectorId,
    generation: route.connectionGeneration,
    state: "connected",
    capabilityDigest: "c".repeat(64),
    establishedAt: 800,
    expiresAt: 10_000,
    revision: 1,
  };
  const connections: FabricMcpMountConnectionAuthority = {
    requireReadyForDevice(connectionId, generation, deviceId) {
      assert.equal(connectionId, connection.connectionId);
      assert.equal(generation, connection.generation);
      assert.equal(deviceId, connection.deviceId);
      return { ...connection };
    },
  };
  const routes = {
    validateRoute(routeId: string): EndpointRouteHandle {
      assert.equal(routeId, route.routeId);
      return structuredClone(route);
    },
    validateBinding(bindingId: string): WorkspaceBinding {
      assert.equal(bindingId, binding.bindingId);
      return { ...binding };
    },
  };
  const endpoints = {
    getEndpoint(endpointId: string): EndpointRecord | undefined {
      return endpointId === endpoint.endpointId ? structuredClone(endpoint) : undefined;
    },
  };
  const provider = (sessionId: string) => new FabricMcpMountProvider({
    sessionId,
    routes,
    connections,
    endpoints,
    now: () => now,
    createMountId: () => `mount-${++mountSequence}`,
    credentialRef: () => "host-secret-ref",
  });
  return { provider, route, endpoint, binding, setNow: (value: number) => { now = value; } };
}

test("Fabric MCP mounts are explicit, session-scoped, tuple-ref-counted, and projected without credentials", async () => {
  const { provider: createProvider, route } = fixture();
  const firstSession = createProvider("session-one");
  const secondSession = createProvider("session-two");
  assert.deepEqual(firstSession.list(), [], "route existence alone must not create a mount");

  const signal = new AbortController().signal;
  const first = await firstSession.mount(route, signal);
  const repeated = await firstSession.mount(route, signal);
  const otherSession = await secondSession.mount(route, signal);

  assert.equal(repeated.mountId, first.mountId);
  assert.equal(firstSession.getReferenceCount(first.mountId), 2);
  assert.notEqual(otherSession.mountId, first.mountId);
  assert.equal(first.providerNamespace, "fabric");
  assert.equal(first.serverName, "route:binding-project:endpoint-files");
  assert.equal(first.credentialRef, "host-secret-ref");
  assert.equal("credentialRef" in firstSession.get(first.mountId)!, false);

  let cleanupCalls = 0;
  await firstSession.unmount(first.mountId, () => { cleanupCalls += 1; });
  assert.equal(cleanupCalls, 0);
  assert.equal(firstSession.get(first.mountId)?.state, "active");
  assert.equal(firstSession.getReferenceCount(first.mountId), 1);

  await firstSession.unmount(first.mountId, (lease) => {
    cleanupCalls += 1;
    assert.equal(lease.state, "revoking");
    assert.equal(firstSession.get(first.mountId)?.state, "revoking");
  });
  assert.equal(cleanupCalls, 1);
  assert.equal(firstSession.get(first.mountId)?.state, "closed");
  await firstSession.unmount(first.mountId, () => { cleanupCalls += 1; });
  assert.equal(cleanupCalls, 1, "unmount is idempotent after closure");
});

test("Fabric MCP mount validation fails closed after route revision or endpoint status changes", async () => {
  const { provider: createProvider, route, endpoint, setNow } = fixture();
  const provider = createProvider("session-validation");
  const mounted = await provider.mount(route, new AbortController().signal);
  await provider.validate(mounted.mountId, route.revision);

  route.revision += 1;
  await assert.rejects(() => provider.validate(mounted.mountId, mounted.routeRevision), /route identity is stale/);
  route.revision -= 1;
  endpoint.status = "offline";
  await assert.rejects(() => provider.validate(mounted.mountId, mounted.routeRevision), /not online/);
  endpoint.status = "online";
  setNow(route.expiresAt);
  await assert.rejects(() => provider.validate(mounted.mountId, mounted.routeRevision), /expired/);
});

test("Fabric MCP revoke fences immediately without deadlocking cleanup validation", async () => {
  const { provider: createProvider, route } = fixture();
  const provider = createProvider("session-revoke");
  const mounted = await provider.mount(route, new AbortController().signal);
  let releaseCleanup!: () => void;
  const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  let cleanupEntered!: () => void;
  const entered = new Promise<void>((resolve) => { cleanupEntered = resolve; });

  const unmount = provider.unmount(mounted.mountId, async () => {
    await assert.rejects(() => provider.validate(mounted.mountId, mounted.routeRevision), /no longer active/);
    cleanupEntered();
    await cleanupGate;
  });
  await entered;
  assert.equal(provider.get(mounted.mountId)?.state, "revoking");
  await assert.rejects(() => provider.mount(route, new AbortController().signal), /different active mount tuple/);
  releaseCleanup();
  await unmount;

  const replacement = await provider.mount(route, new AbortController().signal);
  assert.notEqual(replacement.mountId, mounted.mountId);
  await assert.rejects(
    () => provider.unmount(replacement.mountId, async () => { throw new Error("inner close failed"); }),
    /inner close failed/,
  );
  assert.equal(provider.get(replacement.mountId)?.state, "closed", "cleanup failure must not restore visibility");
});
