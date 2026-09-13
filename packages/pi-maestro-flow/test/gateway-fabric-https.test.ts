import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { EndpointRecord, EndpointRouteHandle, FabricStreamFrameV1, JsonValue } from "pi-maestro-fabric-core/v1";
import { FabricContractError } from "pi-maestro-fabric-core/v1";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import { startGatewayHttpServer } from "../src/gateway/http-server.ts";
import {
  FABRIC_HTTPS_EXCHANGE_PATH,
  FABRIC_HTTPS_EXCHANGE_VERSION,
  FABRIC_HTTPS_EVENTS_VERSION,
  FabricHttpsTransport,
  createFabricPinnedCaFetch,
  type FabricHttpsExchangeRequestV1,
} from "../src/gateway/fabric/https-transport.ts";
import { FABRIC_ENDPOINT_REQUEST_VERSION, FabricEndpointDispatcher } from "../src/gateway/fabric/endpoint-dispatcher.ts";
import { createGatewayPrincipal } from "../src/gateway/principal.ts";
import { workspaceIdForPath } from "../src/gateway/state-paths.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";
import { FabricOriginDataPlaneGrantAuthority } from "../src/gateway/fabric/origin-runtime.ts";

const certificatePath = join(import.meta.dirname, "fixtures", "fabric-test-cert.pem");
const keyPath = join(import.meta.dirname, "fixtures", "fabric-test-key.pem");

async function startMcpSource(cert: Buffer, key: Buffer): Promise<{
  url: string;
  readonly initializeCount: number;
  readonly callCount: number;
  stallNextInitialize(): Promise<() => void>;
  close(): Promise<void>;
}> {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();
  let sessionSequence = 0;
  let initializeCount = 0;
  let callCount = 0;
  let initializeGate: Promise<void> | undefined;
  let releaseInitialize: (() => void) | undefined;
  let enteredInitialize: (() => void) | undefined;
  const listener = createHttpsServer({ cert, key }, (request, response) => {
    void (async () => {
      if (request.url !== "/mcp" || request.method !== "POST") { response.writeHead(404); response.end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const sessionId = Array.isArray(request.headers["mcp-session-id"]) ? request.headers["mcp-session-id"][0] : request.headers["mcp-session-id"];
      let current = sessionId ? sessions.get(sessionId) : undefined;
      if (!current) {
        if (sessionId || !isInitializeRequest(body)) { response.writeHead(400); response.end(); return; }
        initializeCount += 1;
        if (initializeGate !== undefined) {
          const gate = initializeGate;
          initializeGate = undefined;
          enteredInitialize?.();
          await gate;
        }
        let created!: { transport: StreamableHTTPServerTransport; server: Server };
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => `fabric-mcp-session-${++sessionSequence}`,
          enableJsonResponse: true,
          onsessioninitialized: (id) => sessions.set(id, created),
        });
        const server = new Server({ name: "fabric-test-source", version: "1" }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", description: "Echo a value", inputSchema: { type: "object", properties: { value: { type: "string" } } } }] }));
        server.setRequestHandler(CallToolRequestSchema, async (message) => {
          callCount += 1;
          return { content: [{ type: "text", text: String(message.params.arguments?.value ?? "") }] };
        });
        created = current = { transport, server };
        transport.onclose = () => sessions.delete(transport.sessionId ?? "");
        await server.connect(transport);
      }
      await current.transport.handleRequest(request, response, body);
    })().catch((error) => { response.writeHead(500); response.end(String(error)); });
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "localhost", resolve);
  });
  const address = listener.address();
  assert(address && typeof address !== "string");
  return {
    url: `https://localhost:${address.port}/mcp`,
    get initializeCount(): number { return initializeCount; },
    get callCount(): number { return callCount; },
    stallNextInitialize(): Promise<() => void> {
      initializeGate = new Promise<void>((resolve) => { releaseInitialize = resolve; });
      return new Promise((resolve) => { enteredInitialize = () => resolve(() => releaseInitialize?.()); });
    },
    async close(): Promise<void> {
      await Promise.allSettled([...sessions.values()].map(async ({ transport, server }) => { await transport.close(); await server.close(); }));
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}

function exchangeRequest(route: EndpointRouteHandle, deadlineAt: number, overrides: Partial<FabricHttpsExchangeRequestV1> = {}): FabricHttpsExchangeRequestV1 {
  const frame: FabricStreamFrameV1 = {
    version: "fabric.stream.v1",
    streamId: "stream-1",
    routeId: route.routeId,
    operationId: "operation-1",
    sequence: 0,
    kind: "open",
    sentAt: Date.now(),
    payload: { operation: "mcp.list", input: { workspaceId: "workspace-placeholder", workspaceGeneration: 1 } },
  };
  return {
    version: FABRIC_HTTPS_EXCHANGE_VERSION,
    kind: "exchange",
    requestId: "request-1",
    endpointId: route.endpointId,
    endpointKind: "mcp",
    endpointGeneration: route.endpointGeneration,
    deadlineAt,
    frame,
    ...overrides,
  };
}

test("paired Gateway HTTPS routes bridge real MCP initialize, list, call, events, auth, and local reauthorization", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-fabric-https-"));
  const cert = await readFile(certificatePath);
  const key = await readFile(keyPath);
  const source = await startMcpSource(cert, key);
  const workspaceId = workspaceIdForPath(root);
  const endpoint: EndpointRecord = {
    endpointId: "mcp-source-1", deviceId: "device-1", connectorId: "connector-1", scope: { kind: "workspace", workspaceId },
    generation: 1, contractHash: "a".repeat(64), status: "online", revision: 1, kind: "mcp", serverName: "test-source",
    protocolVersion: "2025-11-25", transport: "streamable-http", durableDeduplication: false,
  };
  const route: EndpointRouteHandle = {
    routeId: "route-1", connectionId: "connection-1", workspaceBindingId: "binding-1", endpointId: endpoint.endpointId,
    connectionGeneration: 1, workspaceGeneration: 1, endpointGeneration: 1, issuedAt: Date.now() - 1000,
    expiresAt: Date.now() + 60_000, state: "open", revision: 1,
  };
  const routes = { validateRoute(routeId: string): EndpointRouteHandle { if (routeId !== route.routeId) throw new FabricContractError("not_found", "Route is not known"); return { ...route }; } };
  const endpoints = { getEndpoint(endpointId: string): EndpointRecord | undefined { return endpointId === endpoint.endpointId ? structuredClone(endpoint) : undefined; } };
  const config = createTestGatewayConfig(root, { mode: "bearer", token: "legacy-gateway-token" });
  config.transport.http = { enabled: true, host: "localhost", port: 0, path: "/mcp", tls: { enabled: true, certFile: certificatePath, keyFile: keyPath } };
  const runtime = await GatewayRuntime.create({
    config,
    cwd: root,
    fabricRouteAuthority: routes,
    fabricEndpointDirectory: endpoints,
    fabricHttpChannelEnabled: true,
    fabricMcpSources: [{ endpointId: endpoint.endpointId, url: source.url, workspaceId, fetch: createFabricPinnedCaFetch({ ca: cert, maxResponseBytes: config.limits.maxOutputBytes }) }],
  });
  await runtime.registry.register(root, { id: workspaceId, mode: "permanent" });
  const pairing = await runtime.pairingStore.issue({ ttlMs: 60_000, scopes: ["fabric.data"] });
  const server = await startGatewayHttpServer(runtime, { host: "localhost", port: 0 });
  t.after(async () => { await server.close(); await runtime.close(); await source.close(); await rm(root, { recursive: true, force: true }); });

  const transport = new FabricHttpsTransport({ baseUrl: new URL("/", server.url), token: pairing.token, ca: cert });
  const common = { routeId: route.routeId, endpointId: endpoint.endpointId, endpointKind: "mcp" as const, endpointGeneration: 1, deadlineAt: Date.now() + 30_000 };
  const initialized = await transport.dispatch({ ...common, operation: "mcp.initialize", input: { workspaceId, workspaceGeneration: 1 } }, new AbortController().signal) as Record<string, unknown>;
  assert.deepEqual(initialized.serverVersion, { name: "fabric-test-source", version: "1" });
  const listed = await transport.dispatch({ ...common, operation: "mcp.list", input: { workspaceId, workspaceGeneration: 1 } }, new AbortController().signal) as { tools: Array<{ name: string }> };
  assert.deepEqual(listed.tools.map((tool) => tool.name), ["echo"]);
  const called = await transport.dispatch({ ...common, operation: "mcp.call", input: { workspaceId, workspaceGeneration: 1, name: "echo", arguments: { value: "through-two-tls-hops" } } }, new AbortController().signal) as { content: Array<{ text: string }> };
  assert.equal(called.content[0]?.text, "through-two-tls-hops");
  assert.equal(source.initializeCount, 1);

  const published = runtime.fabricHttpChannelServer!.publish({ routeId: route.routeId, endpointId: endpoint.endpointId, endpointKind: "mcp", endpointGeneration: 1, payload: { state: "ready" } });
  const eventPage = await transport.events({ requestId: "event-read-1", ...common, afterSequence: 0 }, new AbortController().signal);
  assert.deepEqual(eventPage.events, [published]);

  const legacyFetch = createFabricPinnedCaFetch({ ca: cert, maxResponseBytes: config.limits.maxOutputBytes });
  const denied = await legacyFetch(new URL(FABRIC_HTTPS_EXCHANGE_PATH, server.url), {
    method: "POST",
    headers: { authorization: "Bearer legacy-gateway-token", "content-type": "application/json" },
    body: JSON.stringify(exchangeRequest(route, Date.now() + 10_000)),
  });
  assert.equal(denied.status, 403);
  assert.match(await denied.text(), /fabric\.data\.exchange/);

  const serverRejectedFrame = exchangeRequest(route, Date.now() + 10_000, {
    requestId: "wrong-frame-request",
    frame: {
      ...exchangeRequest(route, Date.now() + 10_000).frame,
      streamId: "wrong-frame-stream",
      kind: "data",
      payload: { operation: "mcp.list", input: { workspaceId, workspaceGeneration: 1 } },
    },
  });
  const wrongFrameResponse = await legacyFetch(new URL(FABRIC_HTTPS_EXCHANGE_PATH, server.url), {
    method: "POST",
    headers: { authorization: `Bearer ${pairing.token}`, "content-type": "application/json" },
    body: JSON.stringify(serverRejectedFrame),
  });
  assert.equal(wrongFrameResponse.status, 400);
  assert.match(await wrongFrameResponse.text(), /do not accept data or ack frames/);

  await assert.rejects(() => transport.dispatch({ ...common, routeId: "wrong-route", operation: "mcp.list", input: { workspaceId, workspaceGeneration: 1 } }, new AbortController().signal), /Route is not known/);
  await assert.rejects(() => transport.dispatch({ ...common, endpointKind: "agent", operation: "mcp.list", input: { workspaceId, workspaceGeneration: 1 } }, new AbortController().signal), /kind does not match/);
  await assert.rejects(() => transport.dispatch({ ...common, endpointGeneration: 2, operation: "mcp.list", input: { workspaceId, workspaceGeneration: 1 } }, new AbortController().signal), /current Endpoint/);

  endpoint.generation = route.endpointGeneration = 2;
  const generationTwo = { ...common, endpointGeneration: 2, deadlineAt: Date.now() + 30_000 };
  await Promise.all([
    transport.dispatch({
      ...generationTwo,
      requestId: "generation-two-a",
      operationId: "generation-two-operation-a",
      streamId: "generation-two-stream-a",
      operation: "mcp.initialize",
      input: { workspaceId, workspaceGeneration: 1 },
    }, new AbortController().signal),
    transport.dispatch({
      ...generationTwo,
      requestId: "generation-two-b",
      operationId: "generation-two-operation-b",
      streamId: "generation-two-stream-b",
      operation: "mcp.initialize",
      input: { workspaceId, workspaceGeneration: 1 },
    }, new AbortController().signal),
  ]);
  assert.equal(source.initializeCount, 2, "concurrent generation rollover must install exactly one fresh MCP source session");

  const callsBeforeRevocation = source.callCount;
  const authorizeWorkspace = runtime.policy.authorizeWorkspace.bind(runtime.policy);
  let revokeDuringAuthorization = true;
  runtime.policy.authorizeWorkspace = async (principal, id) => {
    const decision = await authorizeWorkspace(principal, id);
    if (revokeDuringAuthorization) {
      revokeDuringAuthorization = false;
      await runtime.registry.unregister(workspaceId);
    }
    return decision;
  };
  await assert.rejects(() => transport.dispatch({
    ...generationTwo,
    operation: "mcp.call",
    input: { workspaceId, workspaceGeneration: 1, name: "echo", arguments: { value: "must-not-run" } },
  }, new AbortController().signal), /revoked during authorization/);
  assert.equal(source.callCount, callsBeforeRevocation, "revocation must fence mutation before MCP source I/O");
});

test("HTTPS transport and server reject expired or wrong frames and wrong correlated results", async (t) => {
  const cert = await readFile(certificatePath);
  const key = await readFile(keyPath);
  const route: EndpointRouteHandle = {
    routeId: "route-validation", connectionId: "connection-1", endpointId: "endpoint-1", connectionGeneration: 1,
    endpointGeneration: 1, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000, state: "open", revision: 1,
  };
  const transport = new FabricHttpsTransport({ baseUrl: "https://localhost:1", token: "token", ca: cert });
  await assert.rejects(() => transport.exchange(exchangeRequest(route, Date.now() - 1), new AbortController().signal), /deadline has passed/);
  const wrongFrame = exchangeRequest(route, Date.now() + 10_000, { frame: { ...exchangeRequest(route, Date.now() + 10_000).frame, kind: "data" } });
  await assert.rejects(() => transport.exchange(wrongFrame, new AbortController().signal), /accepts only open or cancel frames/);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(() => transport.exchange(exchangeRequest(route, Date.now() + 10_000), cancelled.signal), /cancelled/);

  const malicious = createHttpsServer({ cert, key }, async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    const requestValue = exchangeRequest(route, Date.now() + 10_000);
    const body = JSON.stringify({ ...requestValue, kind: "not-a-result" });
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => { malicious.once("error", reject); malicious.listen(0, "localhost", resolve); });
  t.after(async () => { malicious.closeAllConnections(); await new Promise<void>((resolve) => malicious.close(() => resolve())); });
  const address = malicious.address();
  assert(address && typeof address !== "string");
  const client = new FabricHttpsTransport({ baseUrl: `https://localhost:${address.port}`, token: "token", ca: cert });
  await assert.rejects(() => client.exchange(exchangeRequest(route, Date.now() + 10_000), new AbortController().signal), /wrong result kind/);
});

test("real TLS exchange carries exact cancel frames and rejects duplicate or unsupported frames", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-fabric-cancel-"));
  const cert = await readFile(certificatePath);
  const endpoint: EndpointRecord = {
    endpointId: "agent-cancel", deviceId: "device-1", connectorId: "connector-1", scope: { kind: "device" },
    generation: 1, contractHash: "b".repeat(64), status: "online", revision: 1, kind: "agent", agentName: "cancel-test",
    protocolVersion: "1", durableDeduplication: false,
  };
  const route: EndpointRouteHandle = {
    routeId: "route-cancel", connectionId: "connection-1", endpointId: endpoint.endpointId,
    connectionGeneration: 1, endpointGeneration: 1, issuedAt: Date.now() - 1000,
    expiresAt: Date.now() + 60_000, state: "open", revision: 1,
  };
  const routes = { validateRoute(id: string): EndpointRouteHandle { if (id !== route.routeId) throw new FabricContractError("not_found", "wrong route"); return { ...route }; } };
  const endpoints = { getEndpoint(id: string): EndpointRecord | undefined { return id === endpoint.endpointId ? { ...endpoint } : undefined; } };
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let handlerAborted = false;
  const config = createTestGatewayConfig(root, { mode: "bearer", token: "legacy" });
  config.transport.http = { enabled: true, host: "localhost", port: 0, path: "/mcp", tls: { enabled: true, certFile: certificatePath, keyFile: keyPath } };
  const runtime = await GatewayRuntime.create({
    config,
    cwd: root,
    fabricRouteAuthority: routes,
    fabricEndpointDirectory: endpoints,
    fabricHttpChannelEnabled: true,
    fabricEndpointRegistrations: [{ endpointId: endpoint.endpointId, kind: "agent", handler: {
      async handle({ signal }): Promise<JsonValue> {
        entered();
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
          handlerAborted = true;
          reject(new FabricContractError("cancelled", "handler observed cancel"));
        }, { once: true }));
      },
    } }],
  });
  const pairing = await runtime.pairingStore.issue({ ttlMs: 60_000, scopes: ["fabric.data"] });
  const server = await startGatewayHttpServer(runtime, { host: "localhost", port: 0 });
  t.after(async () => { await server.close(); await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const transport = new FabricHttpsTransport({ baseUrl: new URL("/", server.url), token: pairing.token, ca: cert });
  const deadlineAt = Date.now() + 10_000;
  const controller = new AbortController();
  const pending = transport.dispatch({
    routeId: route.routeId, endpointId: endpoint.endpointId, endpointKind: "agent", endpointGeneration: 1,
    deadlineAt, operation: "agent.wait", input: {}, requestId: "request-cancel", operationId: "operation-cancel", streamId: "stream-cancel",
  }, controller.signal);
  await started;

  const open = exchangeRequest(route, deadlineAt, {
    requestId: "request-cancel", endpointId: endpoint.endpointId, endpointKind: "agent",
    frame: {
      version: "fabric.stream.v1", streamId: "stream-cancel", routeId: route.routeId, operationId: "operation-cancel",
      sequence: 0, kind: "open", sentAt: Date.now(), payload: { operation: "agent.wait", input: {} },
    },
  });
  await assert.rejects(() => transport.exchange(open, new AbortController().signal), /already have a bound channel/);
  await assert.rejects(() => transport.exchange({ ...open, frame: { ...open.frame, sequence: 1, kind: "cancel", streamId: "wrong-stream", payload: {} } }, new AbortController().signal), /stream does not match/);
  await assert.rejects(() => transport.exchange({ ...open, frame: { ...open.frame, sequence: 1, kind: "cancel", operationId: "wrong-operation", payload: {} } }, new AbortController().signal), /no active route operation/);
  await assert.rejects(() => transport.exchange({ ...open, frame: { ...open.frame, sequence: 1, kind: "cancel", routeId: "wrong-route", payload: {} } }, new AbortController().signal), /no active route operation/);

  const rawFetch = createFabricPinnedCaFetch({ ca: cert, maxResponseBytes: config.limits.maxOutputBytes });
  for (const kind of ["data", "ack"] as const) {
    const response = await rawFetch(new URL(FABRIC_HTTPS_EXCHANGE_PATH, server.url), {
      method: "POST",
      headers: { authorization: `Bearer ${pairing.token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...open, frame: { ...open.frame, sequence: 1, kind, payload: {} } }),
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /do not accept data or ack frames/);
  }

  controller.abort();
  await assert.rejects(pending, (error) => error instanceof FabricContractError && error.code === "cancelled");
  assert.equal(handlerAborted, true);
  assert.equal(runtime.fabricHttpChannelServer?.activeExchangeCount, 0);
  assert.equal(runtime.fabricEndpointDispatcher?.pendingRequestCount, 0);
});

test("origin grant deadline is enforced server-side and release aborts an admitted dispatch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-fabric-grant-abort-"));
  const cert = await readFile(certificatePath);
  const endpoint: EndpointRecord = {
    endpointId: "agent-grant-abort", deviceId: "device-grant", connectorId: "connector-grant", scope: { kind: "device" },
    generation: 1, contractHash: "d".repeat(64), status: "online", revision: 1, kind: "agent", agentName: "grant-test",
    roles: ["general"], taskTypes: ["development"], models: ["provider/model"], maxConcurrency: 1,
  };
  const route: EndpointRouteHandle = {
    routeId: "route-grant-abort", connectionId: "connection-grant", endpointId: endpoint.endpointId,
    connectionGeneration: 1, endpointGeneration: 1, issuedAt: Date.now() - 1_000,
    expiresAt: Date.now() + 60_000, state: "open", revision: 1,
  };
  const routes = { validateRoute(id: string): EndpointRouteHandle { if (id !== route.routeId) throw new Error("wrong route"); return { ...route }; } };
  const endpoints = { getEndpoint(id: string): EndpointRecord | undefined { return id === endpoint.endpointId ? { ...endpoint } : undefined; } };
  const grants = new FabricOriginDataPlaneGrantAuthority({
    hubRuntimeEpoch: "hub-grant-abort",
    daemonGeneration: "daemon-grant-abort",
    authority: { routeOf: routes.validateRoute, endpointOf: endpoints.getEndpoint },
    maxTtlMs: 5_000,
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let handlerAborted = false;
  const config = createTestGatewayConfig(root, { mode: "bearer", token: "legacy" });
  config.transport.http = { enabled: true, host: "localhost", port: 0, path: "/mcp", tls: { enabled: true, certFile: certificatePath, keyFile: keyPath } };
  const runtime = await GatewayRuntime.create({
    config,
    cwd: root,
    fabricOriginDataPlaneGrants: grants,
    fabricRouteAuthority: routes,
    fabricEndpointDirectory: endpoints,
    fabricHttpChannelEnabled: true,
    fabricEndpointRegistrations: [{ endpointId: endpoint.endpointId, kind: "agent", handler: {
      async handle({ signal }): Promise<JsonValue> {
        entered();
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
          handlerAborted = true;
          reject(new FabricContractError("cancelled", "grant release reached relay"));
        }, { once: true }));
      },
    } }],
  });
  const server = await startGatewayHttpServer(runtime, { host: "localhost", port: 0 });
  const origin = new URL(server.url); origin.pathname = "/";
  grants.configureHttps({ baseUrl: origin.href, ca: cert.toString("utf8") });
  t.after(async () => { await server.close(); await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const placement = {
    version: "fabric.placement.v1" as const,
    placementId: "placement-grant-abort",
    routeId: route.routeId,
    endpointId: endpoint.endpointId,
    connectionGeneration: 1,
    endpointGeneration: 1,
    deadlineAt: route.expiresAt,
  };
  const acquired = grants.acquire({
    providerGeneration: 1, providerOwnerId: "provider-owner", correlationId: "grant-abort-attempt", placement,
  });
  const transport = new FabricHttpsTransport({ baseUrl: origin, token: acquired.token, ca: cert });
  await assert.rejects(() => transport.dispatch({
    routeId: route.routeId, endpointId: endpoint.endpointId, endpointKind: "agent", endpointGeneration: 1,
    deadlineAt: placement.deadlineAt, operation: "agent.wait", input: {}, requestId: "grant-too-long",
  }, new AbortController().signal), /exceeds its grant/u);

  const pending = transport.dispatch({
    routeId: route.routeId, endpointId: endpoint.endpointId, endpointKind: "agent", endpointGeneration: 1,
    deadlineAt: acquired.expiresAt, operation: "agent.wait", input: {}, requestId: "grant-live",
  }, new AbortController().signal);
  await started;
  grants.release({
    grantId: acquired.grantId,
    hubRuntimeEpoch: acquired.hubRuntimeEpoch,
    daemonGeneration: acquired.daemonGeneration,
    providerGeneration: acquired.providerGeneration,
    providerOwnerId: acquired.providerOwnerId,
    correlationId: acquired.correlationId,
    placementId: acquired.placementId,
  });
  await assert.rejects(() => pending, /cancelled|grant/u);
  assert.equal(handlerAborted, true);
});

test("dispatcher enforces an absolute deadline and releases capacity for a never-settling handler", async () => {
  const endpoint: EndpointRecord = {
    endpointId: "agent-deadline", deviceId: "device-1", connectorId: "connector-1", scope: { kind: "device" },
    generation: 1, contractHash: "c".repeat(64), status: "online", revision: 1, kind: "agent", agentName: "deadline-test",
    protocolVersion: "1", durableDeduplication: false,
  };
  const route: EndpointRouteHandle = {
    routeId: "route-deadline", connectionId: "connection-1", endpointId: endpoint.endpointId,
    connectionGeneration: 1, endpointGeneration: 1, issuedAt: Date.now() - 1000,
    expiresAt: Date.now() + 60_000, state: "open", revision: 1,
  };
  let handlerSignal: AbortSignal | undefined;
  let rejectLate!: (error: Error) => void;
  const dispatcher = new FabricEndpointDispatcher({
    routes: { validateRoute: () => ({ ...route }) },
    endpoints: { getEndpoint: () => ({ ...endpoint }) },
    maxPendingRequests: 1,
    registrations: [{ endpointId: endpoint.endpointId, kind: "agent", handler: { handle: async ({ signal }) => {
      handlerSignal = signal;
      return new Promise<JsonValue>((_resolve, reject) => { rejectLate = reject; });
    } } }],
  });
  const deadlineAt = Date.now() + 50;
  await assert.rejects(() => dispatcher.dispatch({
    version: FABRIC_ENDPOINT_REQUEST_VERSION, requestId: "deadline-request", routeId: route.routeId,
    endpointId: endpoint.endpointId, endpointKind: "agent", endpointGeneration: 1, deadlineAt,
    operation: "agent.wait", input: {},
  }, createGatewayPrincipal("http", "paired", { authenticated: true, scopes: ["fabric.data"] }), new AbortController().signal),
  (error) => error instanceof FabricContractError && error.code === "deadline_exceeded");
  assert.equal(handlerSignal?.aborted, true);
  assert.equal(dispatcher.pendingRequestCount, 0);
  rejectLate(new Error("late handler rejection"));
  await new Promise((resolve) => setTimeout(resolve, 10));
});

test("HTTPS client absolute deadline destroys a trickling response", async (t) => {
  const cert = await readFile(certificatePath);
  const key = await readFile(keyPath);
  const route: EndpointRouteHandle = {
    routeId: "route-trickle", connectionId: "connection-1", endpointId: "endpoint-1", connectionGeneration: 1,
    endpointGeneration: 1, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000, state: "open", revision: 1,
  };
  const listener = createHttpsServer({ cert, key }, async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    response.writeHead(200, { "content-type": "application/json" });
    const interval = setInterval(() => response.write(" "), 10);
    response.once("close", () => clearInterval(interval));
  });
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "localhost", resolve); });
  t.after(async () => { listener.closeAllConnections(); await new Promise<void>((resolve) => listener.close(() => resolve())); });
  const address = listener.address();
  assert(address && typeof address !== "string");
  const client = new FabricHttpsTransport({ baseUrl: `https://localhost:${address.port}`, token: "token", ca: cert });
  const startedAt = Date.now();
  await assert.rejects(() => client.exchange(exchangeRequest(route, startedAt + 80), new AbortController().signal),
    (error) => error instanceof FabricContractError && error.code === "deadline_exceeded");
  assert.ok(Date.now() - startedAt < 500, "trickling bytes must not extend the absolute deadline");
});

test("events read boundary converts null and missing fields to FabricContractError", async (t) => {
  const cert = await readFile(certificatePath);
  const key = await readFile(keyPath);
  let responseIndex = 0;
  const deadlineAt = Date.now() + 10_000;
  const base = {
    version: FABRIC_HTTPS_EVENTS_VERSION, kind: "events", requestId: "events-request", routeId: "route-events",
    endpointId: "endpoint-events", endpointKind: "mcp", endpointGeneration: 1, deadlineAt, nextSequence: 0,
  };
  const listener = createHttpsServer({ cert, key }, (_request, response) => {
    const events = responseIndex++ === 0 ? [null] : [{ sequence: 1, routeId: "route-events", endpointId: "endpoint-events", endpointKind: "mcp", endpointGeneration: 1 }];
    const body = JSON.stringify({ ...base, nextSequence: events[0] === null ? 0 : 1, events });
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "localhost", resolve); });
  t.after(async () => { listener.closeAllConnections(); await new Promise<void>((resolve) => listener.close(() => resolve())); });
  const address = listener.address();
  assert(address && typeof address !== "string");
  const transport = new FabricHttpsTransport({ baseUrl: `https://localhost:${address.port}`, token: "token", ca: cert });
  const input = { requestId: "events-request", routeId: "route-events", endpointId: "endpoint-events", endpointKind: "mcp" as const, endpointGeneration: 1, deadlineAt, afterSequence: 0 };
  for (let index = 0; index < 2; index += 1) {
    await assert.rejects(() => transport.events(input, new AbortController().signal), (error) => error instanceof FabricContractError);
  }
});

test("pinned MCP fetch bounds declared, streamed, and trickling source responses", async (t) => {
  const cert = await readFile(certificatePath);
  const key = await readFile(keyPath);
  const listener = createHttpsServer({ cert, key }, (request, response) => {
    if (request.url === "/declared") {
      response.writeHead(200, { "content-length": "1000" });
      response.end("x");
    } else if (request.url === "/streamed") {
      response.writeHead(200);
      response.write("12345678");
      response.end("abcdefgh");
    } else {
      response.writeHead(200);
      const interval = setInterval(() => response.write("x"), 10);
      response.once("close", () => clearInterval(interval));
    }
  });
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "localhost", resolve); });
  t.after(async () => { listener.closeAllConnections(); await new Promise<void>((resolve) => listener.close(() => resolve())); });
  const address = listener.address();
  assert(address && typeof address !== "string");
  const origin = `https://localhost:${address.port}`;
  const bounded = createFabricPinnedCaFetch({ ca: cert, maxResponseBytes: 10 });
  await assert.rejects(() => bounded(`${origin}/declared`), (error) => error instanceof FabricContractError && error.code === "resource_exhausted");
  await assert.rejects(() => bounded(`${origin}/streamed`), (error) => error instanceof FabricContractError && error.code === "resource_exhausted");
  const deadlineFetch = createFabricPinnedCaFetch({ ca: cert, maxResponseBytes: 1024, deadlineAt: Date.now() + 60 });
  await assert.rejects(() => deadlineFetch(`${origin}/trickle`), (error) => error instanceof FabricContractError && error.code === "deadline_exceeded");
  const abortController = new AbortController();
  const aborting = bounded(`${origin}/trickle`, { signal: abortController.signal });
  setTimeout(() => abortController.abort(), 50);
  await assert.rejects(() => aborting, (error) => error instanceof FabricContractError && error.code === "cancelled");
});

test("a cancelled MCP connection waiter evicts the shared hung client state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-fabric-waiter-"));
  const cert = await readFile(certificatePath);
  const key = await readFile(keyPath);
  const source = await startMcpSource(cert, key);
  const workspaceId = workspaceIdForPath(root);
  const endpoint: EndpointRecord = {
    endpointId: "mcp-waiter", deviceId: "device-1", connectorId: "connector-1", scope: { kind: "workspace", workspaceId },
    generation: 1, contractHash: "d".repeat(64), status: "online", revision: 1, kind: "mcp", serverName: "waiter-source",
    protocolVersion: "2025-11-25", transport: "streamable-http", durableDeduplication: false,
  };
  const route: EndpointRouteHandle = {
    routeId: "route-waiter", connectionId: "connection-1", workspaceBindingId: "binding-1", endpointId: endpoint.endpointId,
    connectionGeneration: 1, workspaceGeneration: 1, endpointGeneration: 1, issuedAt: Date.now() - 1000,
    expiresAt: Date.now() + 60_000, state: "open", revision: 1,
  };
  const config = createTestGatewayConfig(root, { mode: "bearer", token: "legacy" });
  const runtime = await GatewayRuntime.create({
    config,
    cwd: root,
    fabricRouteAuthority: { validateRoute: () => ({ ...route }) },
    fabricEndpointDirectory: { getEndpoint: () => ({ ...endpoint }) },
    fabricMcpSources: [{
      endpointId: endpoint.endpointId,
      workspaceId,
      url: source.url,
      fetch: createFabricPinnedCaFetch({ ca: cert, maxResponseBytes: config.limits.maxOutputBytes }),
    }],
  });
  await runtime.registry.register(root, { id: workspaceId, mode: "permanent" });
  t.after(async () => { await runtime.close(); await source.close(); await rm(root, { recursive: true, force: true }); });
  const dispatcher = runtime.fabricEndpointDispatcher!;
  const principal = createGatewayPrincipal("http", "paired", { authenticated: true, scopes: ["fabric.data"] });
  const makeRequest = (requestId: string) => ({
    version: FABRIC_ENDPOINT_REQUEST_VERSION,
    requestId,
    routeId: route.routeId,
    endpointId: endpoint.endpointId,
    endpointKind: "mcp" as const,
    endpointGeneration: 1,
    deadlineAt: Date.now() + 10_000,
    operation: "mcp.initialize",
    input: { workspaceId, workspaceGeneration: 1 },
  });

  const entered = source.stallNextInitialize();
  const creator = dispatcher.dispatch(makeRequest("creator"), principal, new AbortController().signal);
  const release = await entered;
  const waiterController = new AbortController();
  const waiter = dispatcher.dispatch(makeRequest("waiter"), principal, waiterController.signal);
  await new Promise((resolve) => setTimeout(resolve, 25));
  waiterController.abort();
  await assert.rejects(waiter, (error) => error instanceof FabricContractError && error.code === "cancelled");
  release();
  await creator.catch(() => undefined);
  const initialized = await dispatcher.dispatch(makeRequest("replacement"), principal, new AbortController().signal) as Record<string, unknown>;
  assert.ok(initialized.serverVersion);
  assert.ok(source.initializeCount >= 2, "replacement caller must not reuse the cancelled waiter's cached connect");
});
