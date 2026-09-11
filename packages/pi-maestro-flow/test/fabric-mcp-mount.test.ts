import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FabricMcpMountProvider } from "pi-maestro-fabric";
import type { EndpointRecord, EndpointRouteHandle, JsonValue, WorkspaceBinding } from "pi-maestro-fabric-core/v1";
import { FabricMcpMountRegistry } from "../src/mcp/fabric-mount-registry.ts";
import type { FabricMcpDispatchPort } from "../src/mcp/fabric-transport.ts";
import {
  executeCall,
  executeDescribe,
  executeFabricMount,
  executeFabricUnmount,
  executeFabricValidate,
  executeSearch,
} from "../src/mcp/proxy-modes.ts";
import { McpServerManager } from "../src/mcp/server-manager.ts";
import type { McpExtensionState } from "../src/mcp/state.ts";

async function realMcpSource(label: string): Promise<{ dispatcher: FabricMcpDispatchPort; close(): Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: `source-${label}`, version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "echo", description: `Echo from ${label}`, inputSchema: { type: "object", properties: { value: { type: "string" } } } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: `${label}:${String(request.params.arguments?.value ?? "")}` }],
  }));
  await server.connect(serverTransport);
  const client = new Client({ name: `fabric-source-client-${label}`, version: "1" });
  await client.connect(clientTransport);
  return {
    dispatcher: {
      async dispatch(input, signal): Promise<JsonValue> {
        assert.equal(input.endpointKind, "mcp");
        assert.equal(input.input.workspaceId, "workspace-project");
        assert.equal(input.input.workspaceGeneration, 2);
        const options = { signal, timeout: Math.max(1, input.deadlineAt - Date.now()) };
        if (input.operation === "mcp.initialize") {
          return {
            serverVersion: client.getServerVersion() as unknown as JsonValue,
            capabilities: client.getServerCapabilities() as unknown as JsonValue,
          };
        }
        if (input.operation === "mcp.list") {
          return await client.listTools(undefined, options) as unknown as JsonValue;
        }
        if (input.operation === "mcp.call") {
          return await client.callTool({
            name: String(input.input.name),
            arguments: input.input.arguments as Record<string, unknown> | undefined,
          }, undefined, options) as unknown as JsonValue;
        }
        throw new Error(`unexpected operation ${input.operation}`);
      },
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function route(endpointId: string): EndpointRouteHandle {
  return {
    routeId: `route-${endpointId}`,
    connectionId: "connection-edge",
    workspaceBindingId: "binding-project",
    endpointId,
    connectionGeneration: 4,
    workspaceGeneration: 2,
    endpointGeneration: 3,
    issuedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 60_000,
    state: "open",
    revision: 5,
    deviceId: "device-edge",
    operationClass: "mcp-read",
    pathCandidates: ["hub"],
    selectedPath: "hub",
  };
}

function endpoint(endpointId: string): EndpointRecord {
  return {
    endpointId,
    deviceId: "device-edge",
    connectorId: "connector-edge",
    scope: { kind: "workspace", workspaceId: "workspace-project" },
    generation: 3,
    contractHash: "a".repeat(64),
    status: "online",
    revision: 1,
    kind: "mcp",
    serverName: "same-advertised-name",
    protocolVersion: "2025-11-25",
    transport: "streamable-http",
    durableDeduplication: false,
  };
}

function createState(
  sessionId: string,
  routes: Map<string, EndpointRouteHandle>,
  endpoints: Map<string, EndpointRecord>,
  dispatchers: Map<string, FabricMcpDispatchPort>,
): McpExtensionState {
  let mountSequence = 0;
  const binding: WorkspaceBinding = {
    bindingId: "binding-project",
    connectionId: "connection-edge",
    deviceId: "device-edge",
    workspaceId: "workspace-project",
    connectionGeneration: 4,
    workspaceGeneration: 2,
    policyDigest: "b".repeat(64),
    issuedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 60_000,
    revision: 1,
  };
  const provider = new FabricMcpMountProvider({
    sessionId,
    routes: {
      validateRoute(routeId) {
        const value = routes.get(routeId);
        if (!value) throw new Error("route not found");
        return structuredClone(value);
      },
      validateBinding(bindingId) {
        if (bindingId !== binding.bindingId) throw new Error("binding not found");
        return { ...binding };
      },
    },
    endpoints: { getEndpoint: (endpointId) => structuredClone(endpoints.get(endpointId)) },
    connections: {
      requireReadyForDevice(connectionId, generation, deviceId) {
        assert.equal(connectionId, "connection-edge");
        assert.equal(generation, 4);
        assert.equal(deviceId, "device-edge");
        return {
          connectionId,
          deviceId,
          connectorId: "connector-edge",
          connectorInstanceNonce: "nonce-edge",
          generation,
          state: "connected",
          capabilityDigest: "c".repeat(64),
          establishedAt: Date.now() - 2_000,
          expiresAt: Date.now() + 60_000,
          revision: 1,
        };
      },
    },
    createMountId: () => `${sessionId}-mount-${++mountSequence}`,
  });
  const manager = new McpServerManager();
  const state = {
    manager,
    toolMetadata: new Map(),
    config: { mcpServers: {}, settings: { toolPrefix: "none" } },
    failureTracker: new Map(),
  } as unknown as McpExtensionState;
  state.fabricMounts = new FabricMcpMountRegistry({
    provider,
    manager,
    resolveTransport: (lease) => ({
      dispatcher: dispatchers.get(lease.endpointId)!,
      workspaceId: "workspace-project",
      workspaceGeneration: 2,
    }),
    onHidden: (serverName) => state.toolMetadata.delete(serverName),
  });
  return state;
}

function text(result: CallToolResult | { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

test("Fabric MCP mounts reach fixed real servers, isolate same-name tools and sessions, and never write MCP files", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "fabric-mcp-mount-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  });
  const configPath = join(agentDir, "mcp.json");
  const cachePath = join(agentDir, "mcp-cache.json");
  await writeFile(configPath, "config-sentinel\n");
  await writeFile(cachePath, "cache-sentinel\n");

  const sourceA = await realMcpSource("A");
  const sourceB = await realMcpSource("B");
  t.after(async () => { await Promise.all([sourceA.close(), sourceB.close()]); });
  const routeA = route("endpoint-a");
  const routeB = route("endpoint-b");
  const routes = new Map([[routeA.routeId, routeA], [routeB.routeId, routeB]]);
  const endpoints = new Map([[routeA.endpointId, endpoint(routeA.endpointId)], [routeB.endpointId, endpoint(routeB.endpointId)]]);
  const dispatchers = new Map([[routeA.endpointId, sourceA.dispatcher], [routeB.endpointId, sourceB.dispatcher]]);
  const firstState = createState("session-one", routes, endpoints, dispatchers);
  const secondState = createState("session-two", routes, endpoints, dispatchers);
  t.after(async () => { await Promise.all([firstState.fabricMounts!.closeAll(), secondState.fabricMounts!.closeAll()]); });

  const mountedA = await executeFabricMount(firstState, routeA);
  const repeatedA = await executeFabricMount(firstState, routeA);
  const mountedB = await executeFabricMount(firstState, routeB);
  const secondSessionMount = await executeFabricMount(secondState, routeA);
  assert.equal(mountedA.details.mode, "mount");
  assert.equal(repeatedA.details.references, 2);
  assert.equal(mountedB.details.mode, "mount");
  assert.notEqual(
    (mountedA.details.mount as { mountId: string }).mountId,
    (secondSessionMount.details.mount as { mountId: string }).mountId,
    "different Pi sessions must not share mount identity",
  );

  const search = executeSearch(firstState, "echo");
  assert.equal(search.details.count, 2);
  const serverA = String(mountedA.details.server);
  const serverB = String(mountedB.details.server);
  const toolA = firstState.toolMetadata.get(serverA)![0]!.name;
  const toolB = firstState.toolMetadata.get(serverB)![0]!.name;
  assert.notEqual(toolA, toolB, "same original tool names are namespaced by exact mount");
  assert.equal(executeDescribe(firstState, toolA).details.server, serverA);

  const calledA = await executeCall(firstState, toolA, { value: "one" }, serverA);
  const calledB = await executeCall(firstState, toolB, { value: "two" }, serverB);
  assert.match(text(calledA), /A:one/);
  assert.match(text(calledB), /B:two/);
  const mountIdA = (mountedA.details.mount as { mountId: string }).mountId;
  assert.equal((await executeFabricValidate(firstState, mountIdA)).details.server, serverA);

  await executeFabricUnmount(firstState, mountIdA);
  assert.equal(firstState.toolMetadata.has(serverA), true, "one reference keeps the exact mount visible");
  assert.ok(firstState.manager.getConnection(serverA));
  await executeFabricUnmount(firstState, mountIdA);
  assert.equal(firstState.toolMetadata.has(serverA), false);
  assert.equal(firstState.manager.getConnection(serverA), undefined);
  await executeFabricUnmount(firstState, mountIdA);
  assert.equal(firstState.toolMetadata.has(serverB), true);

  assert.equal(await readFile(configPath, "utf8"), "config-sentinel\n");
  assert.equal(await readFile(cachePath, "utf8"), "cache-sentinel\n");
});
