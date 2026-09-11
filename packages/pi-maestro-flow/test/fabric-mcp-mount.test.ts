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
import { FabricMcpClientTransport, type FabricMcpDispatchPort } from "../src/mcp/fabric-transport.ts";
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

class DelayedFabricDispatcher implements FabricMcpDispatchPort {
  readonly started: Promise<void>;
  #markStarted!: () => void;
  readonly resultGate: Promise<void>;
  #releaseResult!: () => void;

  constructor() {
    this.started = new Promise((resolve) => { this.#markStarted = resolve; });
    this.resultGate = new Promise((resolve) => { this.#releaseResult = resolve; });
  }

  release(): void {
    this.#releaseResult();
  }

  async dispatch(input: Parameters<FabricMcpDispatchPort["dispatch"]>[0]): Promise<JsonValue> {
    if (input.operation === "mcp.initialize") {
      return { capabilities: { tools: {} }, serverVersion: { name: "delayed", version: "1" } };
    }
    if (input.operation === "mcp.list") {
      return { tools: [{ name: "echo", description: "delayed", inputSchema: { type: "object" } }] };
    }
    if (input.operation === "mcp.call") {
      this.#markStarted();
      await this.resultGate;
      return { content: [{ type: "text", text: "secret-stale-result" }] };
    }
    throw new Error(`unexpected operation ${input.operation}`);
  }
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

test("Fabric revoke hides first and fences a delayed call before a replacement mount can publish", async (t) => {
  const endpointRoute = route("endpoint-delayed");
  const delayed = new DelayedFabricDispatcher();
  const routes = new Map([[endpointRoute.routeId, endpointRoute]]);
  const endpoints = new Map([[endpointRoute.endpointId, endpoint(endpointRoute.endpointId)]]);
  const state = createState(
    "session-fence",
    routes,
    endpoints,
    new Map([[endpointRoute.endpointId, delayed]]),
  );
  t.after(async () => { await state.fabricMounts!.closeAll(); });

  const mounted = await executeFabricMount(state, endpointRoute);
  const serverName = String(mounted.details.server);
  const mountId = (mounted.details.mount as { mountId: string }).mountId;
  const toolName = state.toolMetadata.get(serverName)![0]!.name;
  const call = executeCall(state, toolName, { value: "old" }, serverName);
  await delayed.started;

  const unmount = state.fabricMounts!.unmount(mountId);
  assert.equal(state.fabricMounts!.hasServer(serverName), false, "outer visibility is removed synchronously before inner drain");
  assert.equal(state.toolMetadata.has(serverName), false, "search and describe cannot observe stale tools");
  assert.equal(executeSearch(state, "echo").details.count, 0);
  assert.equal(executeDescribe(state, toolName).details.error, "tool_not_found");

  delayed.release();
  const staleResult = await call;
  await unmount;
  assert.doesNotMatch(text(staleResult), /secret-stale-result/);

  const replacementDispatcher: FabricMcpDispatchPort = {
    async dispatch(input): Promise<JsonValue> {
      if (input.operation === "mcp.initialize") {
        return { capabilities: { tools: {} }, serverVersion: { name: "replacement", version: "1" } };
      }
      if (input.operation === "mcp.list") {
        return { tools: [{ name: "replacement", description: "new authority", inputSchema: { type: "object" } }] };
      }
      return { content: [{ type: "text", text: "replacement-result" }] };
    },
  };
  const replacementState = createState(
    "session-replacement",
    routes,
    endpoints,
    new Map([[endpointRoute.endpointId, replacementDispatcher]]),
  );
  t.after(async () => { await replacementState.fabricMounts!.closeAll(); });
  const replacement = await executeFabricMount(replacementState, endpointRoute);
  const replacementServer = String(replacement.details.server);
  assert.deepEqual(
    replacementState.toolMetadata.get(replacementServer)?.map((tool) => tool.originalName),
    ["replacement"],
    "a stale callback cannot overwrite the replacement mount metadata",
  );
});

test("Fabric revoke during paginated discovery drains startup without publishing a connection", async (t) => {
  const endpointRoute = route("endpoint-pages");
  let page = 0;
  let markSecondPage!: () => void;
  let releaseSecondPage!: () => void;
  const secondPage = new Promise<void>((resolve) => { markSecondPage = resolve; });
  const pageGate = new Promise<void>((resolve) => { releaseSecondPage = resolve; });
  const dispatcher: FabricMcpDispatchPort = {
    async dispatch(input): Promise<JsonValue> {
      if (input.operation === "mcp.initialize") {
        return { capabilities: { tools: {} }, serverVersion: { name: "pages", version: "1" } };
      }
      if (input.operation === "mcp.list") {
        page += 1;
        if (page === 1) {
          return { tools: [{ name: "page-one", inputSchema: { type: "object" } }], nextCursor: "next" };
        }
        markSecondPage();
        await pageGate;
        return { tools: [{ name: "stale-page-two", inputSchema: { type: "object" } }] };
      }
      return { content: [] };
    },
  };
  const state = createState(
    "session-pages",
    new Map([[endpointRoute.routeId, endpointRoute]]),
    new Map([[endpointRoute.endpointId, endpoint(endpointRoute.endpointId)]]),
    new Map([[endpointRoute.endpointId, dispatcher]]),
  );
  t.after(async () => { await state.fabricMounts!.closeAll(); });
  const mounted = await state.fabricMounts!.mount(endpointRoute, new AbortController().signal);
  const definition = state.fabricMounts!.getDefinition(mounted.serverName)!;
  const connecting = state.manager.connect(mounted.serverName, definition);
  await secondPage;
  const unmounting = state.fabricMounts!.unmount(mounted.lease.mountId);
  assert.equal(state.fabricMounts!.hasServer(mounted.serverName), false);
  assert.equal(state.manager.getConnection(mounted.serverName), undefined);
  releaseSecondPage();
  await assert.rejects(connecting);
  await unmounting;
  assert.equal(state.manager.getConnection(mounted.serverName), undefined);
  assert.equal(state.toolMetadata.has(mounted.serverName), false);
});

test("Fabric route validation failure immediately evicts metadata and drains the inner client", async (t) => {
  const endpointRoute = route("endpoint-stale-route");
  const source = await realMcpSource("stale-route");
  t.after(async () => { await source.close(); });
  const routes = new Map([[endpointRoute.routeId, endpointRoute]]);
  const state = createState(
    "session-stale-route",
    routes,
    new Map([[endpointRoute.endpointId, endpoint(endpointRoute.endpointId)]]),
    new Map([[endpointRoute.endpointId, source.dispatcher]]),
  );
  t.after(async () => { await state.fabricMounts!.closeAll(); });

  const mounted = await executeFabricMount(state, endpointRoute);
  const serverName = String(mounted.details.server);
  const mountId = (mounted.details.mount as { mountId: string }).mountId;
  endpointRoute.revision += 1;
  const validation = await executeFabricValidate(state, mountId);

  assert.equal(validation.details.error, "mount_invalid");
  assert.equal(state.fabricMounts!.hasServer(serverName), false);
  assert.equal(state.toolMetadata.has(serverName), false);
  assert.equal(executeSearch(state, "echo").details.count, 0);
  await state.fabricMounts!.closeAll();
  assert.equal(state.manager.getConnection(serverName), undefined);
});

test("Fabric mutation transport loss is reported as outcome unknown and is never replayed", async () => {
  let dispatches = 0;
  const endpointRoute = route("endpoint-mutation");
  endpointRoute.operationClass = "mcp-mutation";
  const provider = new FabricMcpMountProvider({
    sessionId: "session-mutation",
    routes: {
      validateRoute: () => structuredClone(endpointRoute),
      validateBinding: () => ({
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
      }),
    },
    endpoints: { getEndpoint: () => endpoint("endpoint-mutation") },
    connections: {
      requireReadyForDevice: () => ({
        connectionId: "connection-edge",
        deviceId: "device-edge",
        connectorId: "connector-edge",
        connectorInstanceNonce: "nonce-edge",
        generation: 4,
        state: "connected",
        capabilityDigest: "c".repeat(64),
        establishedAt: Date.now() - 1_000,
        expiresAt: Date.now() + 60_000,
        revision: 1,
      }),
    },
    createMountId: () => "mount-mutation",
  });
  const lease = await provider.mount(endpointRoute, new AbortController().signal);
  const transport = new FabricMcpClientTransport({
    lease,
    workspaceId: "workspace-project",
    workspaceGeneration: 2,
    mutation: true,
    validate: async () => { await provider.validate(lease.mountId, lease.routeRevision); },
    dispatcher: {
      async dispatch(): Promise<JsonValue> {
        dispatches += 1;
        throw new Error("connection lost after write");
      },
    },
  });
  const messages: unknown[] = [];
  transport.onmessage = (message) => { messages.push(message); };
  await transport.start();
  await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mutate", arguments: {} } });
  assert.equal(dispatches, 1);
  assert.match(JSON.stringify(messages), /outcome is unknown/);
  await transport.close();
  await provider.unmount(lease.mountId);
});

test("Fabric continuation fences structurally cover direct, resource, metadata, and UI publication paths", async () => {
  const root = new URL("../src/mcp/", import.meta.url);
  const [direct, init, manager, uiResource, uiServer] = await Promise.all([
    readFile(new URL("direct-tools.ts", root), "utf8"),
    readFile(new URL("init.ts", root), "utf8"),
    readFile(new URL("server-manager.ts", root), "utf8"),
    readFile(new URL("ui-resource-handler.ts", root), "utf8"),
    readFile(new URL("ui-server.ts", root), "utf8"),
  ]);
  assert.match(direct, /await connection\.client\.readResource[\s\S]*lease\.assertCurrent\(\)/u);
  assert.match(direct, /await abortable\(resultPromise[\s\S]*lease\.assertCurrent\(\)[\s\S]*sendToolResult/u);
  assert.match(init, /routeLease\?\.assertCurrent\(\)[\s\S]*toolMetadata\.set/u);
  assert.match(init, /if \(routeLease !== undefined\) return/u);
  assert.match(manager, /if \(connection\.fabricRoute !== undefined\) await connection\.fabricRoute\.validateCurrent\(\);[\s\S]*connections\.set/u);
  assert.match(uiResource, /routeLease\?\.assertCurrent\(\)/u);
  assert.match(uiServer, /lease\.assertCurrent\(\)[\s\S]*sendJson\(res, 200/u);
});
