import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Value } from "typebox/value";
import {
  FabricAdmissionManager,
  FabricConnectionManager,
  FabricDirectory,
  FabricStoreCoordinator,
  TransportRegistry,
  type FabricAllocatedConnectRequest,
  type FabricAdvertisementSnapshot,
} from "pi-maestro-fabric";
import {
  FABRIC_CONTROL_VERSION,
  type FabricConnectRequest,
  type FabricLiveConnection,
  type FabricProtocolLimits,
} from "pi-maestro-fabric-core/v1";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import { GatewayFabricStore } from "../src/gateway/fabric/store.ts";
import { createGatewayPrincipal } from "../src/gateway/principal.ts";
import { workspaceIdForPath } from "../src/gateway/state-paths.ts";
import {
  FabricDeviceParams,
  FabricEndpointParams,
  FabricRouteParams,
  FabricWorkspaceParams,
  createFabricDeviceTool,
  createFabricEndpointTool,
  createFabricRouteTool,
  createFabricWorkspaceTool,
  type GatewayFabricCaller,
} from "../src/tools/fabric.ts";
import { SshToolParams } from "../src/ssh-manager/llm-tool.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";

const limits: FabricProtocolLimits = {
  maxFrameBytes: 256 * 1024,
  maxInFlightOperations: 32,
  heartbeatIntervalMs: 10_000,
  heartbeatTimeoutMs: 30_000,
  maxAdvertisementItems: 1_024,
  maxResultBytes: 1024 * 1024,
};

function control(action: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: FABRIC_CONTROL_VERSION, action, requestId: `request-${action.replace(".", "-")}`, deadlineAt: Date.now() + 30_000, ...fields };
}

function resultData(result: Awaited<ReturnType<GatewayRuntime["call"]>>): Record<string, unknown> {
  assert.equal(result.ok, true, result.error?.message);
  return (result.data as { result: Record<string, unknown> }).result;
}

async function setupRuntime(root: string) {
  const config = createTestGatewayConfig(root, { mode: "bearer", token: "legacy-gateway-token" });
  config.logging.auditFile = join(root, "fabric-audit.jsonl");
  const store = new GatewayFabricStore({ path: join(root, "fabric-state.json") });
  let durableId = 0;
  const coordinator = new FabricStoreCoordinator(store, { createId: () => `fabric-store-${++durableId}` });
  const directory = new FabricDirectory();
  const connector = {
    connectorId: "connector-1", label: "Connector One", transport: "direct-https" as const,
    credentialGeneration: 1, instanceNonce: "connector-nonce-1", enabled: true, revision: 1,
  };
  const device = {
    deviceId: "device-1", label: "Device One", connectorId: connector.connectorId,
    connectionMode: "https" as const, platform: "linux", architecture: "x64", enabled: true, revision: 1,
  };
  directory.seedAuthority({ connector, devices: [device] });
  const transports = new TransportRegistry();
  let opens = 0;
  const closes: string[] = [];
  transports.register({
    kind: "direct-https",
    async connect(request: FabricConnectRequest): Promise<FabricLiveConnection> {
      opens += 1;
      const allocated = request as FabricAllocatedConnectRequest;
      return {
        descriptor: {
          protocolVersion: "fabric.v1",
          limits,
          lease: {
            connectionId: allocated.allocatedConnectionId,
            deviceId: request.deviceId,
            connectorId: request.connectorId,
            connectorInstanceNonce: connector.instanceNonce,
            generation: allocated.allocatedConnectionGeneration,
            state: "connected",
            capabilityDigest: "capability-digest-1",
            establishedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
            revision: 0,
          },
        },
        exchange: async (envelope) => envelope,
        close: async (reason) => { closes.push(reason); },
      };
    },
  });
  const connections = new FabricConnectionManager(directory, transports, { coordinator });
  const admissions = new FabricAdmissionManager(directory, connections, { coordinator });
  let runtimeId = 0;
  const localWorkspaceId = workspaceIdForPath(root);
  const runtime = await GatewayRuntime.create({
    config,
    cwd: root,
    fabricStore: store,
    fabricControlRuntime: {
      directory,
      connections,
      admissions,
      limits,
      createId: (kind) => `${kind}-test-${++runtimeId}`,
      resolveLocalWorkspaceId: (workspaceId) => workspaceId === "fabric-workspace-1" ? localWorkspaceId : undefined,
    },
  });
  await runtime.registry.register(root, { id: localWorkspaceId, mode: "permanent" });
  return { runtime, directory, connections, connector, device, localWorkspaceId, opens: () => opens, closes };
}

function advertisement(connectionId: string, generation: number, localWorkspaceId: string): FabricAdvertisementSnapshot {
  return {
    connectionId,
    connectionGeneration: generation,
    capabilityDigest: "capability-digest-1",
    advertisementRevision: 1,
    devices: [{
      deviceId: "device-1", label: "Device One", connectorId: "connector-1", connectionMode: "https",
      platform: "linux", architecture: "x64", enabled: true, revision: 1,
    }],
    workspaces: [{
      workspaceId: "fabric-workspace-1", deviceId: "device-1", localWorkspaceId, label: "Workspace One",
      mode: "permanent", generation: 1, policyDigest: "policy-digest-1", endpointIds: ["endpoint-1"], revision: 1,
    }],
    endpoints: [{
      endpointId: "endpoint-1", deviceId: "device-1", connectorId: "connector-1",
      scope: { kind: "workspace", workspaceId: "fabric-workspace-1" }, generation: 1,
      contractHash: "contract-hash-1", status: "online", revision: 1, kind: "mcp",
      serverName: "source-mcp", protocolVersion: "2025-11-25", transport: "streamable-http", durableDeduplication: false,
    }],
    capabilities: [{
      capabilityId: "capability-1", kind: "tool", endpointId: "endpoint-1",
      contractHash: "contract-hash-1", trustLevel: "paired", priority: 10,
    }],
  };
}

test("Gateway Fabric controls are explicit, manager-backed, authorized, audited, and do not connect during discovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-fabric-tools-"));
  const fixture = await setupRuntime(root);
  const { runtime } = fixture;
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const owner = createGatewayPrincipal("stdio", "owner", { authenticated: true, workspaceId: fixture.localWorkspaceId });

  const catalog = runtime.catalog.list();
  assert.deepEqual(catalog.map((tool) => tool.name).slice(-3), ["device", "endpoint", "route"]);
  for (const name of ["device", "endpoint", "route"] as const) {
    const tool = catalog.find((entry) => entry.name === name);
    assert.equal(tool?.capability, `fabric.control.${name}`);
    assert.deepEqual(tool?.requiredCapabilities, [`fabric.control.${name}`]);
  }
  const workspaceTool = catalog.find((entry) => entry.name === "workspace");
  assert.equal(workspaceTool?.capability, "gateway.workspace");
  assert.deepEqual(workspaceTool?.requiredCapabilities, ["gateway.workspace"]);

  const listed = resultData(await runtime.call("device", control("list"), owner));
  assert.deepEqual((listed.devices as Array<{ deviceId: string }>).map((device) => device.deviceId), ["device-1"]);
  const paired = resultData(await runtime.call("device", control("pair", {
    connectorId: "connector-1", deviceId: "device-1", pairingRef: "host-private-bootstrap-reference",
  }), owner));
  assert.doesNotMatch(JSON.stringify(paired), /host-private-bootstrap-reference/);
  assert.equal(fixture.opens(), 0, "list/get/pair discovery must not connect");

  const legacy = createGatewayPrincipal("http", "legacy", { authenticated: true, scopes: ["gateway"] });
  assert.equal((await runtime.call("device", control("list"), legacy)).error?.code, "capability_denied");
  const narrow = createGatewayPrincipal("http", "fabric-reader", { authenticated: true, scopes: ["fabric.control.device.list"] });
  assert.equal((await runtime.call("device", control("list"), narrow)).ok, true);
  assert.equal((await runtime.call("device", { ...control("list"), version: "fabric.control.v2" }, owner)).error?.code, "invalid_arguments");

  const connected = resultData(await runtime.call("device", control("connect", {
    deviceId: "device-1", connectorId: "connector-1", expectedCredentialGeneration: 1,
  }), owner)).connection as { connectionId: string; generation: number };
  assert.equal(fixture.opens(), 1);
  fixture.connections.acceptAdvertisement(advertisement(connected.connectionId, connected.generation, fixture.localWorkspaceId));

  const selected = resultData(await runtime.call("endpoint", control("select", { endpointId: "endpoint-1" }), owner));
  assert.equal((selected.endpoint as { endpointId: string }).endpointId, "endpoint-1");
  assert.equal(fixture.opens(), 1, "Endpoint selection must not connect");
  const fabricWorkspaces = resultData(await runtime.call("workspace", control("list", { deviceId: "device-1" }), owner));
  assert.deepEqual((fabricWorkspaces.workspaces as Array<{ workspaceId: string }>).map((workspace) => workspace.workspaceId), ["fabric-workspace-1"]);

  const binding = resultData(await runtime.call("workspace", control("bind", {
    deviceId: "device-1", connectionId: connected.connectionId, workspaceId: "fabric-workspace-1",
    expectedConnectionGeneration: connected.generation, expectedWorkspaceGeneration: 1, requestedTtlMs: 5_000,
  }), owner)).binding as { bindingId: string; revision: number };
  const route = resultData(await runtime.call("route", control("open", {
    connectionId: connected.connectionId, workspaceBindingId: binding.bindingId, endpointId: "endpoint-1",
    expectedConnectionGeneration: connected.generation, expectedWorkspaceGeneration: 1, expectedEndpointGeneration: 1,
    requestedTtlMs: 2_000, operationClass: "mcp-read", pathCandidates: ["hub"],
  }), owner)).route as { routeId: string; revision: number };
  const renewed = resultData(await runtime.call("route", control("renew", {
    routeId: route.routeId, expectedRevision: route.revision, requestedTtlMs: 4_000,
  }), owner)).route as { revision: number };
  const closed = resultData(await runtime.call("route", control("close", {
    routeId: route.routeId, expectedRevision: renewed.revision,
  }), owner)).route as { state: string };
  assert.equal(closed.state, "closed");
  assert.equal((resultData(await runtime.call("workspace", control("unbind", {
    workspaceBindingId: binding.bindingId, expectedRevision: binding.revision,
  }), owner)).binding as { bindingId: string }).bindingId, binding.bindingId);
  assert.equal((resultData(await runtime.call("device", control("disconnect", {
    deviceId: "device-1", connectionId: connected.connectionId, expectedConnectionGeneration: connected.generation,
  }), owner)).connection as { state: string }).state, "closed");
  assert.equal(fixture.closes.length, 1);

  const pathOnly = await runtime.call("workspace", control("bind", {
    path: root, deviceId: "device-1", connectionId: connected.connectionId,
    expectedConnectionGeneration: 1, expectedWorkspaceGeneration: 1, requestedTtlMs: 1_000,
  }), owner);
  assert.equal(pathOnly.error?.code, "invalid_arguments", "a path cannot opt into Fabric Workspace binding");
  assert.equal((await runtime.call("workspace", { action: "list" }, owner)).ok, true, "legacy unversioned Workspace discovery remains available");

  const audit = await readFile(configuredAudit(runtime), "utf8");
  assert.match(audit, /"tool":"device"/);
  assert.match(audit, /"code":"capability_denied"/);
});

function configuredAudit(runtime: GatewayRuntime): string {
  assert.ok(runtime.config.logging.auditFile);
  return runtime.config.logging.auditFile;
}

test("disabled Fabric and strict Pi/SSH schemas fail closed while Pi tools inject the v1 control envelope", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-fabric-disabled-"));
  const runtime = await GatewayRuntime.create({ config: createTestGatewayConfig(root), cwd: root });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const owner = createGatewayPrincipal("stdio", "owner", { authenticated: true });
  assert.equal((await runtime.call("device", control("list"), owner)).error?.code, "fabric_disabled");

  assert.equal(Value.Check(FabricWorkspaceParams, { action: "bind", path: root, requestedTtlMs: 1000 }), false);
  assert.equal(Value.Check(FabricDeviceParams, { action: "connect", deviceId: "device-1", connectorId: "connector-1", expectedCredentialGeneration: 1 }), true);
  assert.equal(Value.Check(FabricEndpointParams, { action: "select", endpointId: "endpoint-1", unknown: true }), false);
  assert.equal(Value.Check(FabricRouteParams, { action: "open", connectionId: "connection-1", endpointId: "endpoint-1" }), false);
  assert.equal(Value.Check(SshToolParams, { command: "id", deviceId: "device-1" }), false);
  assert.equal(Value.Check(SshToolParams, { action: "call", tool: "device", args: control("list") }), true);

  const calls: Array<{ tool: string; args: Record<string, unknown>; cwd: string }> = [];
  const caller: GatewayFabricCaller = {
    async call(tool, args, options): Promise<CallToolResult> {
      calls.push({ tool, args, cwd: options.cwd });
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }], structuredContent: { ok: true } };
    },
  };
  const tools = [createFabricDeviceTool(caller), createFabricWorkspaceTool(caller), createFabricEndpointTool(caller), createFabricRouteTool(caller)];
  assert.deepEqual(tools.map((tool) => tool.name), ["device", "workspace", "endpoint", "route"]);
  await tools[2]!.execute("select", { action: "select", endpointId: "endpoint-1" }, undefined, undefined, { cwd: root } as never);
  assert.equal(calls[0]?.tool, "endpoint");
  assert.equal(calls[0]?.args.version, FABRIC_CONTROL_VERSION);
  assert.equal(typeof calls[0]?.args.requestId, "string");
  assert.equal(typeof calls[0]?.args.deadlineAt, "number");
  assert.equal(calls[0]?.cwd, root);
});
