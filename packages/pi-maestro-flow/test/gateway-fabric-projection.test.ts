import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import {
  FabricAdmissionManager,
  FabricConnectionManager,
  FabricDirectory,
  TransportRegistry,
  type FabricAdvertisementSnapshot,
} from "pi-maestro-fabric";
import {
  FABRIC_CONTROL_VERSION,
  type FabricConnectRequest,
  type FabricLiveConnection,
  type FabricProtocolLimits,
  type QualifiedTaskSnapshotV1,
} from "pi-maestro-fabric-core/v1";
import { GatewayEventJournal } from "../src/gateway/event-journal.ts";
import {
  GATEWAY_FABRIC_MONITOR_MAX_BYTES,
  GatewayFabricMonitorProjection,
  parseGatewayFabricMonitorSnapshot,
} from "../src/gateway/fabric/monitor-projection.ts";
import {
  GatewayFabricTaskReferenceService,
  qualifiedTaskReferenceKey,
} from "../src/gateway/fabric/task-reference-service.ts";
import { GATEWAY_HANDOFF_WRITE_SCHEMA } from "../src/gateway/handoff-contracts.ts";
import { createGatewayPrincipal } from "../src/gateway/principal.ts";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import { workspaceIdForPath } from "../src/gateway/state-paths.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";

const limits: FabricProtocolLimits = {
  maxFrameBytes: 256 * 1024,
  maxInFlightOperations: 32,
  heartbeatIntervalMs: 10_000,
  heartbeatTimeoutMs: 30_000,
  maxAdvertisementItems: 1_024,
  maxResultBytes: 1024 * 1024,
};

function fabricManagers(now: () => number) {
  const directory = new FabricDirectory();
  const connector = {
    connectorId: "connector-1", label: "Connector\r\nOne\u001b", transport: "direct-https" as const,
    credentialGeneration: 1, instanceNonce: "connector-nonce-1", enabled: true, revision: 1,
  };
  const device = {
    deviceId: "device-1", label: "Device One", connectorId: connector.connectorId,
    connectionMode: "https" as const, enabled: true, revision: 1,
  };
  directory.seedAuthority({ connector, devices: [device] });
  const transports = new TransportRegistry();
  transports.register({
    kind: "direct-https",
    async connect(request: FabricConnectRequest): Promise<FabricLiveConnection> {
      return {
        descriptor: {
          protocolVersion: "fabric.v1",
          limits,
          lease: {
            connectionId: "connection-1",
            deviceId: request.deviceId,
            connectorId: request.connectorId,
            connectorInstanceNonce: connector.instanceNonce,
            generation: 1,
            state: "connected",
            capabilityDigest: "capability-digest-1",
            establishedAt: now(),
            expiresAt: now() + 60_000,
            revision: 0,
          },
        },
        exchange: async (envelope) => envelope,
        close: async () => undefined,
      };
    },
  });
  const connections = new FabricConnectionManager(directory, transports, { now });
  const admissions = new FabricAdmissionManager(directory, connections, { now });
  return { directory, connections, admissions };
}

function advertisement(connectionId: string, generation: number): FabricAdvertisementSnapshot {
  return {
    connectionId,
    connectionGeneration: generation,
    capabilityDigest: "capability-digest-1",
    advertisementRevision: 1,
    devices: [{
      deviceId: "device-1", label: "Device One", connectorId: "connector-1",
      connectionMode: "https", enabled: true, revision: 1,
    }],
    workspaces: [],
    endpoints: [{
      endpointId: "endpoint-1", deviceId: "device-1", connectorId: "connector-1",
      scope: { kind: "device" }, generation: 1, contractHash: "contract-hash-1",
      status: "online", revision: 1, kind: "mcp", serverName: "mcp-files",
      protocolVersion: "2025-11-25", transport: "streamable-http", durableDeduplication: false,
    }],
    capabilities: [],
  };
}

function successData(result: Awaited<ReturnType<GatewayRuntime["call"]>>): Record<string, unknown> {
  assert.equal(result.ok, true, result.error?.message);
  return result.data as Record<string, unknown>;
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not become true");
}

test("Fabric monitor projection separates health kinds, sanitizes display text, and stays bounded", async () => {
  let clock = 10_000;
  const managers = fabricManagers(() => clock);
  const connection = await managers.connections.connect({
    requestId: "connect-1", deviceId: "device-1", connectorId: "connector-1", expectedCredentialGeneration: 1, limits, deadlineAt: clock + 5_000,
  }, new AbortController().signal);
  managers.connections.acceptAdvertisement(advertisement(connection.connectionId, connection.generation));
  const journal = new GatewayEventJournal();
  journal.append({ cursor: 1, workspaceId: "fabric", sessionId: "fabric", handle: "fabric:registry", kind: "state", payload: { safe: true }, at: clock });
  const projection = new GatewayFabricMonitorProjection({ ...managers, journal, now: () => clock, sourceId: "source-1" });

  const snapshot = projection.snapshot();
  assert.equal(snapshot.itemCount, 3);
  assert.equal(snapshot.connectors[0]?.health, "online");
  assert.equal(snapshot.devices[0]?.health, "online");
  assert.equal(snapshot.endpoints[0]?.endpointKind, "mcp");
  assert.equal(snapshot.endpoints[0]?.health, "online");
  assert.equal(snapshot.cursors.find((item) => item.storeKind === "registry")?.cursor, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /[\r\n\u0000\u001b]/u);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= GATEWAY_FABRIC_MONITOR_MAX_BYTES);

  const withPrivateFields = {
    ...snapshot,
    localPath: "C:/secret",
    endpoints: snapshot.endpoints.map((endpoint) => ({ ...endpoint, credential: "secret", label: "safe\nlabel\u001b" })),
  };
  const parsed = parseGatewayFabricMonitorSnapshot(withPrivateFields);
  assert.ok(parsed);
  assert.equal("localPath" in parsed, false);
  assert.equal("credential" in parsed.endpoints[0]!, false);
  assert.equal(parsed.endpoints[0]?.label, "safe label");
  assert.equal(parseGatewayFabricMonitorSnapshot({ ...snapshot, cursors: [snapshot.cursors[0], snapshot.cursors[0]] }), undefined);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(parseGatewayFabricMonitorSnapshot(circular), undefined);

  const bounded = new GatewayFabricMonitorProjection({ ...managers, journal, now: () => clock, sourceId: "source-2", maxItems: 2 }).snapshot();
  assert.equal(bounded.itemCount, 2);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.endpoints.length, 0);
  clock += 1;
  assert.equal(projection.snapshot().revision, snapshot.revision, "capture time alone does not change content revision");
});

test("qualified task snapshots never join equal bare ids across authorities", async () => {
  const snapshots: QualifiedTaskSnapshotV1[] = [
    { reference: { authority: "pi-todo", workspaceId: "workspace-1", taskId: "same" }, subject: "Pi\nTodo", status: "in_progress", revision: 1, capturedAt: 1, truncated: false },
    { reference: { authority: "gateway-todo", workspaceId: "workspace-1", taskId: "same" }, subject: "Gateway Todo", status: "pending", revision: 2, capturedAt: 2, truncated: false },
    { reference: { authority: "board", workspaceId: "workspace-1", taskId: "same" }, subject: "Board", status: "blocked", revision: 3, capturedAt: 3, truncated: false },
  ];
  const service = new GatewayFabricTaskReferenceService({
    maxItems: 2,
    now: () => 20,
    sources: snapshots.map((snapshot) => ({
      authority: snapshot.reference.authority,
      read: async (workspaceId: string, taskId: string) => workspaceId === snapshot.reference.workspaceId && taskId === snapshot.reference.taskId ? snapshot : undefined,
    })),
  });
  assert.equal(new Set(snapshots.map((snapshot) => qualifiedTaskReferenceKey(snapshot.reference))).size, 3);
  const page = await service.snapshotMany(snapshots.map((snapshot) => snapshot.reference));
  assert.equal(page.items.length, 2);
  assert.equal(page.truncated, true);
  assert.deepEqual(page.items.map((item) => item.reference.authority), ["pi-todo", "gateway-todo"]);
  assert.equal(page.items[0]?.subject, "Pi Todo");
  assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= 64 * 1024);
});

test("Gateway Monitor publishes Fabric snapshot/cursors and revoked subscriptions cannot commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-fabric-projection-"));
  const now = Date.now();
  const managers = fabricManagers(() => now);
  const runtime = await GatewayRuntime.create({
    config: createTestGatewayConfig(root, { mode: "bearer", token: "fabric-monitor-token" }),
    cwd: root,
    fabricControlRuntime: {
      ...managers,
      limits,
      createId: (kind) => `${kind}-test`,
      resolveLocalWorkspaceId: () => undefined,
    },
  });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const workspaceId = workspaceIdForPath(root);
  await runtime.registry.register(root, { id: workspaceId, mode: "permanent" });
  const legacy = createGatewayPrincipal("http", "legacy", { authenticated: true, workspaceId, scopes: ["gateway"] });
  successData(await runtime.call("session", {
    action: "create", sessionId: "legacy-monitor", workspacePath: root, ownerId: "legacy",
    expectedSessionRevision: 0, operationId: "legacy-create",
  }, legacy));
  const legacyList = successData(await runtime.call("monitor", { action: "list", sessionId: "legacy-monitor", memberId: "legacy" }, legacy));
  assert.equal(legacyList.fabric, undefined, "legacy Gateway authority must not expose Fabric inventory");

  const fabricReader = createGatewayPrincipal("http", "fabric-reader", { authenticated: true, workspaceId, scopes: ["gateway.session", "gateway.monitor", "fabric.control.monitor.read"] });
  successData(await runtime.call("session", {
    action: "create", sessionId: "scoped-monitor", workspacePath: root, ownerId: "fabric-reader",
    expectedSessionRevision: 0, operationId: "scoped-create",
  }, fabricReader));
  assert.equal((successData(await runtime.call("monitor", { action: "list", sessionId: "scoped-monitor", memberId: "fabric-reader" }, fabricReader)).fabric as { version?: number }).version, 1);

  const owner = createGatewayPrincipal("stdio", "owner", { authenticated: true, workspaceId });
  successData(await runtime.call("session", {
    action: "create", sessionId: "fabric-monitor", workspacePath: root, ownerId: "owner",
    expectedSessionRevision: 0, operationId: "create",
  }, owner));

  runtime.teammate.eventJournal.append({
    cursor: 1, workspaceId: "fabric", sessionId: "fabric", handle: "fabric:registry",
    kind: "state", payload: { storeKind: "registry", state: "safe" }, at: now,
  });
  const listed = successData(await runtime.call("monitor", { action: "list", sessionId: "fabric-monitor", memberId: "owner" }, owner));
  const fabric = listed.fabric as { version: number; cursors: Array<{ handle: string; cursor: number }> };
  assert.equal(fabric.version, 1);
  assert.equal(fabric.cursors.find((item) => item.handle === "fabric:registry")?.cursor, 1);

  const observed = successData(await runtime.call("monitor", {
    action: "observe", sessionId: "fabric-monitor", memberId: "owner", handle: "fabric:registry", cursor: 0, limit: 10,
  }, owner));
  assert.equal((observed.events as unknown[]).length, 1);
  assert.equal(observed.nextCursor, 1);

  const notifications: unknown[] = [];
  const subscribed = successData(await runtime.call("monitor", {
    action: "subscribe", sessionId: "fabric-monitor", memberId: "owner", handle: "fabric:registry", cursor: 1,
  }, owner, undefined, { stream: { connectionId: "connection-1", write: async (notification) => { notifications.push(notification); } } }));
  const subscriptionId = subscribed.subscriptionId as string;
  const state = await runtime.sessionStore.require("fabric-monitor");
  successData(await runtime.call("session", {
    action: "close", sessionId: "fabric-monitor", memberId: "owner",
    expectedSessionRevision: state.session.revision, operationId: "close",
  }, owner));
  runtime.teammate.eventJournal.append({
    cursor: 2, workspaceId: "fabric", sessionId: "fabric", handle: "fabric:registry",
    kind: "state", payload: { storeKind: "registry", state: "new" }, at: now + 1,
  });
  await until(() => runtime.eventStream.state(subscriptionId)?.closed === true);
  assert.equal(notifications.length, 0, "revoked subscription must not commit a later notification");
  assert.equal(runtime.eventStream.state(subscriptionId)?.gap?.reason, "revoked");

  const reference = { authority: "pi-todo", workspaceId: "workspace-1", taskId: "same" } as const;
  assert.equal(Value.Check(GATEWAY_HANDOFF_WRITE_SCHEMA, { taskReferences: [reference] }), true);
  const board = successData(await runtime.call("board", {
    action: "create", workspaceId, taskId: "board-1", title: "Board task", taskReferences: [reference], expectedRevision: 0, operationId: "board-create",
  }, owner)).task as { taskReferences?: unknown[] };
  assert.deepEqual(board.taskReferences, [reference]);
});
