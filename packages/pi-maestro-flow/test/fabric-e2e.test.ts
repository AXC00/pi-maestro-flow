import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign as signPayload } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import WebSocket from "ws";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { AttemptOutcome, BackendCapabilities } from "pi-maestro-backend-core/v1/backend";
import type { SingleResult, TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import { FABRIC_AGENT_ATTEMPT_VERSION, createFabricBackend } from "pi-maestro-backends/fabric";
import {
  FABRIC_ARTIFACT_CHUNK_BYTES,
  FabricAdmissionManager,
  FabricArtifactReceiver,
  FabricArtifactSender,
  FabricConnectionManager,
  FabricDirectory,
  FabricEdgeRelayTransport,
  FabricStoreCoordinator,
  TransportRegistry,
  fabricEdgeRelayEnvelope,
  type FabricArtifactDigest,
  type FabricAllocatedConnectRequest,
  type FabricAdvertisementSnapshot,
} from "pi-maestro-fabric";
import { FabricConnectorSecurity, fabricChallengeProofPayload } from "../src/gateway/fabric/security.ts";
import { FABRIC_WSS_PATH, FabricWssServer } from "../src/gateway/fabric/wss-server.ts";
import { FabricConnectorRuntime } from "../src/gateway/fabric/connector-runtime.ts";
import {
  FABRIC_EDGE_CONFIG_VERSION,
  parseFabricEdgeConfig,
  requireAllowedEdgeDevice,
  requireAllowedEdgeEndpoint,
} from "../src/gateway/fabric/edge-config.ts";
import { FabricEdgeRuntime } from "../src/gateway/fabric/edge-runtime.ts";
import { FabricRouteTicketKeyringStore, FabricRouteTicketSecurity } from "../src/gateway/fabric/route-ticket.ts";
import { FABRIC_DIRECT_ROUTE_PATH, FabricDirectRouteServer } from "../src/gateway/fabric/direct-route-server.ts";
import {
  registerFabricTeammateRuntimePort,
  type FabricTeammateAttempt,
  type FabricTeammateAttemptRequest,
  type FabricTeammateRuntimePort,
} from "pi-maestro-teammate/v1/fabric-runtime";
import {
  FABRIC_ARTIFACT_VERSION,
  FABRIC_CONTROL_VERSION,
  FABRIC_PROTOCOL_VERSION,
  FABRIC_STORE_EVENT_VERSION,
  FABRIC_STORE_TRANSACTION_VERSION,
  FabricContractError,
  type EndpointRecord,
  type EndpointRouteHandle,
  type FabricConnectRequest,
  type FabricLiveConnection,
  type FabricProtocolLimits,
  type FabricStoreKind,
  type FabricStoreTransactionV1,
  type FabricStreamChannel,
  type FabricStreamFrameV1,
  type FabricTransportProvider,
  type JsonValue,
  type TeammatePlacementV1,
} from "pi-maestro-fabric-core/v1";
import { FabricAgentRouteResolver } from "../src/gateway/fabric/agent-channel.ts";
import { FabricArtifactService } from "../src/gateway/fabric/artifact-service.ts";
import { FabricArtifactSource } from "../src/gateway/fabric/artifact-source.ts";
import { GatewayEventJournal } from "../src/gateway/event-journal.ts";
import { GatewayFabricEventAdapter } from "../src/gateway/fabric/event-adapter.ts";
import {
  FABRIC_HTTPS_EXCHANGE_PATH,
  FabricHttpsTransport,
  createFabricPinnedCaFetch,
} from "../src/gateway/fabric/https-transport.ts";
import { recoverGatewayFabric } from "../src/gateway/fabric/recovery.ts";
import { GatewayFabricStore } from "../src/gateway/fabric/store.ts";
import { startGatewayHttpServer } from "../src/gateway/http-server.ts";
import { createGatewayPrincipal } from "../src/gateway/principal.ts";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import { workspaceIdForPath } from "../src/gateway/state-paths.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";

/**
 * Cross-component chains of the Multi-Device Fabric.
 *
 * Each chain drives real implementations over real TLS and asserts the outcome
 * of the asynchronous-commit fences (restart, pair rotation, generation change,
 * route close) that keep a late answer from becoming a published result.
 */

const certificatePath = join(import.meta.dirname, "fixtures", "fabric-test-cert.pem");
const keyPath = join(import.meta.dirname, "fixtures", "fabric-test-key.pem");

/** A fence that lands while old work is still in flight. */
type CommitFence = "none" | "restart" | "pair-rotation" | "workspace-generation" | "route-close";
const COMMIT_FENCES: readonly CommitFence[] = ["none", "restart", "pair-rotation", "workspace-generation", "route-close"];

const limits: FabricProtocolLimits = {
  maxFrameBytes: 256 * 1024,
  maxInFlightOperations: 32,
  heartbeatIntervalMs: 10_000,
  heartbeatTimeoutMs: 30_000,
  maxAdvertisementItems: 1_024,
  maxResultBytes: 1024 * 1024,
};

function control(action: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: FABRIC_CONTROL_VERSION, action, requestId: `request-${action}`, deadlineAt: Date.now() + 30_000, ...fields };
}

function resultData(result: Awaited<ReturnType<GatewayRuntime["call"]>>): Record<string, unknown> {
  assert.equal(result.ok, true, result.error?.message);
  return (result.data as { result: Record<string, unknown> }).result;
}

// ---------------------------------------------------------------------------
// Chain 1: Gateway control -> HTTPS route -> real MCP server -> guarded result
// ---------------------------------------------------------------------------

/** A real MCP server behind its own TLS listener; the source of truth for "did the call happen". */
async function startMcpSource(cert: Buffer, key: Buffer): Promise<{
  url: string;
  readonly callCount: number;
  readonly initializeCount: number;
  close(): Promise<void>;
}> {
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();
  let sessionSequence = 0;
  let callCount = 0;
  let initializeCount = 0;
  const listener = createHttpsServer({ cert, key }, (request, response) => {
    void (async () => {
      if (request.url !== "/mcp" || request.method !== "POST") { response.writeHead(404); response.end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const header = request.headers["mcp-session-id"];
      const sessionId = Array.isArray(header) ? header[0] : header;
      let current = sessionId ? sessions.get(sessionId) : undefined;
      if (!current) {
        if (sessionId || !isInitializeRequest(body)) { response.writeHead(400); response.end(); return; }
        initializeCount += 1;
        let created!: { transport: StreamableHTTPServerTransport; server: Server };
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => `fabric-e2e-session-${++sessionSequence}`,
          enableJsonResponse: true,
          onsessioninitialized: (id) => sessions.set(id, created),
        });
        const server = new Server({ name: "fabric-e2e-source", version: "1" }, { capabilities: { tools: {} } });
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [{ name: "echo", description: "Echo a value", inputSchema: { type: "object", properties: { value: { type: "string" } } } }],
        }));
        server.setRequestHandler(CallToolRequestSchema, async (message) => {
          callCount += 1;
          return { content: [{ type: "text", text: `source:${String(message.params.arguments?.value ?? "")}` }] };
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
    get callCount(): number { return callCount; },
    get initializeCount(): number { return initializeCount; },
    async close(): Promise<void> {
      await Promise.allSettled([...sessions.values()].map(async ({ transport, server }) => {
        await transport.close();
        await server.close();
      }));
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}

interface ChainOneHarness {
  runtime: GatewayRuntime;
  store: GatewayFabricStore;
  coordinator: FabricStoreCoordinator;
  connections: FabricConnectionManager;
  admissions: FabricAdmissionManager;
  directory: FabricDirectory;
  source: Awaited<ReturnType<typeof startMcpSource>>;
  server: Awaited<ReturnType<typeof startGatewayHttpServer>>;
  workspaceId: string;
  endpoint: EndpointRecord;
  /** Present when the harness was built with an Agent Endpoint advertised. */
  agentEndpoint?: EndpointRecord;
  connectionId: string;
  connectionGeneration: number;
  advertise(workspaceGeneration: number): void;
  /** Advance the advertisement revision counter, for a hand-built snapshot. */
  nextAdvertisementRevision(): number;
  /** A restart tears down the listening runtime; the durable store is what remains. */
  stopServing(): Promise<void>;
  close(): Promise<void>;
}

interface ChainHarnessOptions {
  agentEndpoint?: boolean;
  /** Extra Devices the Connector authority publishes; an advertisement must match it exactly. */
  extraDevices?: ReadonlyArray<{ deviceId: string; label: string }>;
}

async function chainOneHarness(
  root: string,
  registerCleanup?: (fn: () => Promise<void>) => void,
  options: ChainHarnessOptions = {},
): Promise<ChainOneHarness> {
  const withAgentEndpoint = options.agentEndpoint === true;
  const cert = await readFile(certificatePath);
  const key = await readFile(keyPath);
  const source = await startMcpSource(cert, key);
  const workspaceId = workspaceIdForPath(root);
  const store = new GatewayFabricStore({ path: join(root, "fabric-state.json") });
  let sequence = 0;
  const coordinator = new FabricStoreCoordinator(store, { createId: () => `fabric-store-${++sequence}` });
  const deviceRecords = [
    {
      deviceId: "device-1", label: "Device One", connectorId: "connector-1", connectionMode: "https" as const,
      platform: "linux", architecture: "x64", enabled: true, revision: 1,
    },
    ...(options.extraDevices ?? []).map((device) => ({
      deviceId: device.deviceId, label: device.label, connectorId: "connector-1", connectionMode: "https" as const,
      platform: "linux", architecture: "x64", enabled: true, revision: 1,
    })),
  ];
  const directory = new FabricDirectory();
  directory.seedAuthority({
    connector: {
      connectorId: "connector-1", label: "Connector One", transport: "direct-https",
      credentialGeneration: 1, instanceNonce: "connector-nonce-1", enabled: true, revision: 1,
    },
    devices: deviceRecords,
  });
  const transports = new TransportRegistry();
  transports.register({
    kind: "direct-https",
    async connect(request: FabricConnectRequest): Promise<FabricLiveConnection> {
      const allocated = request as FabricAllocatedConnectRequest;
      return {
        descriptor: {
          protocolVersion: FABRIC_PROTOCOL_VERSION,
          limits,
          lease: {
            connectionId: allocated.allocatedConnectionId,
            deviceId: request.deviceId,
            connectorId: request.connectorId,
            connectorInstanceNonce: "connector-nonce-1",
            generation: allocated.allocatedConnectionGeneration,
            state: "connected",
            capabilityDigest: "capability-digest-1",
            establishedAt: Date.now(),
            expiresAt: Date.now() + 120_000,
            revision: 0,
          },
        },
        exchange: async (envelope) => envelope,
        close: async () => undefined,
      };
    },
  });
  const connections = new FabricConnectionManager(directory, transports, { coordinator });
  const admissions = new FabricAdmissionManager(directory, connections, { coordinator });
  const endpoint: EndpointRecord = {
    endpointId: "endpoint-1", deviceId: "device-1", connectorId: "connector-1",
    scope: { kind: "workspace", workspaceId: "fabric-workspace-1" }, generation: 1,
    contractHash: "a".repeat(64), status: "online", revision: 1, kind: "mcp",
    serverName: "fabric-e2e-source", protocolVersion: "2025-11-25", transport: "streamable-http",
    durableDeduplication: false,
  };
  const agentEndpoint: EndpointRecord | undefined = withAgentEndpoint ? {
    endpointId: "agent-endpoint-1", deviceId: "device-1", connectorId: "connector-1",
    scope: { kind: "workspace", workspaceId: "fabric-workspace-1" }, generation: 1,
    contractHash: "b".repeat(64), status: "online", revision: 1, kind: "agent",
    roles: ["general"], taskTypes: ["development"], models: ["model-a"], maxConcurrency: 1,
  } : undefined;
  const advertisedEndpoints = [
    {
      endpointId: endpoint.endpointId, deviceId: "device-1", connectorId: "connector-1",
      scope: { kind: "workspace", workspaceId: "fabric-workspace-1" }, generation: 1,
      contractHash: "a".repeat(64), status: "online", revision: 1, kind: "mcp",
      serverName: "fabric-e2e-source", protocolVersion: "2025-11-25", transport: "streamable-http",
      durableDeduplication: false,
    },
    ...(agentEndpoint === undefined ? [] : [{
      endpointId: agentEndpoint.endpointId, deviceId: "device-1", connectorId: "connector-1",
      scope: agentEndpoint.scope, generation: 1, contractHash: "b".repeat(64), status: "online" as const,
      revision: 1, kind: "agent" as const, roles: ["general"], taskTypes: ["development"],
      models: ["model-a"], maxConcurrency: 1,
    }]),
  ];
  let advertisementRevision = 1;
  const nextAdvertisementRevision = (): number => (advertisementRevision += 1);
  const advertisement = (connectionId: string, generation: number, workspaceGeneration: number, revision = nextAdvertisementRevision()): FabricAdvertisementSnapshot => ({
    connectionId,
    connectionGeneration: generation,
    capabilityDigest: "capability-digest-1",
    advertisementRevision: revision,
    devices: deviceRecords.slice() as FabricAdvertisementSnapshot["devices"],
    workspaces: [{
      workspaceId: "fabric-workspace-1", deviceId: "device-1", localWorkspaceId: workspaceId, label: "Workspace One",
      mode: "permanent", generation: workspaceGeneration, policyDigest: "policy-digest-1",
      endpointIds: advertisedEndpoints.map((entry) => entry.endpointId), revision: Math.max(workspaceGeneration, revision),
    }],
    endpoints: advertisedEndpoints.slice() as FabricAdvertisementSnapshot["endpoints"],
    capabilities: [
      { capabilityId: "capability-1", kind: "tool", endpointId: endpoint.endpointId, contractHash: "a".repeat(64), trustLevel: "paired", priority: 10 },
      ...(agentEndpoint === undefined ? [] : [{
        capabilityId: "capability-2", kind: "agent-competency" as const, endpointId: agentEndpoint.endpointId,
        contractHash: "b".repeat(64), trustLevel: "paired" as const, priority: 20,
      }]),
    ] as FabricAdvertisementSnapshot["capabilities"],
  });

  const config = createTestGatewayConfig(root, { mode: "bearer", token: "legacy-gateway-token" });
  config.transport.http = { enabled: true, host: "localhost", port: 0, path: "/mcp", tls: { enabled: true, certFile: certificatePath, keyFile: keyPath } };
  let runtimeId = 0;
  const runtime = await GatewayRuntime.create({
    config,
    cwd: root,
    fabricStore: store,
    fabricControlRuntime: {
      directory,
      connections,
      admissions,
      limits,
      createId: (kind) => `${kind}-e2e-${++runtimeId}`,
      resolveLocalWorkspaceId: (fabricWorkspaceId) => fabricWorkspaceId === "fabric-workspace-1" ? workspaceId : undefined,
    },
    fabricHttpChannelEnabled: true,
    ...(withAgentEndpoint ? { fabricAgentEndpointIds: ["agent-endpoint-1"] } : {}),
    fabricMcpSources: [{
      endpointId: endpoint.endpointId,
      url: source.url,
      workspaceId,
      fetch: createFabricPinnedCaFetch({ ca: cert, maxResponseBytes: config.limits.maxOutputBytes }),
    }],
  });
  await runtime.registry.register(root, { id: workspaceId, mode: "permanent" });
  const server = await startGatewayHttpServer(runtime, { host: "localhost", port: 0 });

  const owner = createGatewayPrincipal("stdio", "owner", { authenticated: true, workspaceId });
  const connected = resultData(await runtime.call("device", control("connect", {
    deviceId: "device-1", connectorId: "connector-1", expectedCredentialGeneration: 1,
  }), owner)).connection as { connectionId: string; generation: number };
  connections.acceptAdvertisement(advertisement(connected.connectionId, connected.generation, 1, 1));

  let serving = true;
  const harness: ChainOneHarness = {
    runtime,
    store,
    coordinator,
    connections,
    admissions,
    directory,
    source,
    server,
    workspaceId,
    endpoint,
    ...(agentEndpoint === undefined ? {} : { agentEndpoint }),
    connectionId: connected.connectionId,
    connectionGeneration: connected.generation,
    advertise: (workspaceGeneration) => {
      connections.acceptAdvertisement(advertisement(connected.connectionId, connected.generation, workspaceGeneration));
    },
    nextAdvertisementRevision,
    stopServing: async (): Promise<void> => {
      if (!serving) return;
      serving = false;
      await server.close();
      await runtime.close();
    },
    close: async (): Promise<void> => {
      await harness.stopServing();
      await source.close();
    },
  };
  registerCleanup?.(() => harness.close());
  return harness;
}

/** Admit a workspace binding and a route through real Gateway control requests. */
async function chainOneRoute(
  harness: ChainOneHarness,
  owner: ReturnType<typeof createGatewayPrincipal>,
): Promise<{ bindingId: string; route: EndpointRouteHandle }> {
  const binding = resultData(await harness.runtime.call("workspace", control("bind", {
    deviceId: "device-1",
    connectionId: harness.connectionId,
    workspaceId: "fabric-workspace-1",
    expectedConnectionGeneration: harness.connectionGeneration,
    expectedWorkspaceGeneration: 1,
    requestedTtlMs: 60_000,
  }), owner)).binding as { bindingId: string };
  const route = resultData(await harness.runtime.call("route", control("open", {
    connectionId: harness.connectionId,
    workspaceBindingId: binding.bindingId,
    endpointId: harness.endpoint.endpointId,
    expectedConnectionGeneration: harness.connectionGeneration,
    expectedWorkspaceGeneration: 1,
    expectedEndpointGeneration: 1,
    requestedTtlMs: 45_000,
    operationClass: "mcp-read",
    pathCandidates: ["hub"],
  }), owner)).route as EndpointRouteHandle;
  return { bindingId: binding.bindingId, route };
}

/** Durable evidence that one Fabric operation was in flight when the fence landed. */
async function recordRunningInvocation(store: GatewayFabricStore, operationId: string): Promise<void> {
  const transact = async (kind: FabricStoreKind, subjectId: string, value: Record<string, JsonValue>): Promise<void> => {
    const state = await store.readStore(kind);
    const transaction: FabricStoreTransactionV1 = {
      version: FABRIC_STORE_TRANSACTION_VERSION,
      transactionId: `seed-${subjectId}`,
      storeKind: kind,
      expectedRevision: state.revision,
      nextRevision: state.revision + 1,
      committedAt: 100,
      mutations: [{ kind: "upsert", subjectId, value }],
      events: [{
        version: FABRIC_STORE_EVENT_VERSION,
        eventId: `${subjectId}-event`,
        storeKind: kind,
        sequence: state.highWaterMark + 1,
        eventKind: "record.updated",
        subjectId,
        subjectRevision: Number(value.revision),
        occurredAt: 100,
        payload: {},
      }],
    };
    await store.transact(transaction);
  };
  await transact("invocation", operationId, {
    revision: 1, operationId, routeId: "route-inflight", endpointId: "endpoint-1",
    connectionGeneration: 1, endpointGeneration: 1, state: "running",
    replayClass: "non-replayable", updatedAt: 100,
  });
}

test("chain 1 completes over real Gateway control, a real HTTPS route, and a real MCP server", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fabric-e2e-chain1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = await chainOneHarness(root, (fn) => t.after(fn));
  const owner = createGatewayPrincipal("stdio", "owner", { authenticated: true, workspaceId: harness.workspaceId });
  const { route } = await chainOneRoute(harness, owner);

  const pairing = await harness.runtime.pairingStore.issue({ ttlMs: 60_000, scopes: ["fabric.data"] });
  const transport = new FabricHttpsTransport({ baseUrl: new URL("/", harness.server.url), token: pairing.token, ca: await readFile(certificatePath) });
  const common = {
    routeId: route.routeId, endpointId: harness.endpoint.endpointId, endpointKind: "mcp" as const,
    endpointGeneration: route.endpointGeneration, deadlineAt: Date.now() + 5_000,
  };
  const initialized = await transport.dispatch({
    ...common, operation: "mcp.initialize", input: { workspaceId: harness.workspaceId, workspaceGeneration: 1 },
  }, new AbortController().signal) as Record<string, unknown>;
  assert.deepEqual(initialized.serverVersion, { name: "fabric-e2e-source", version: "1" });

  const called = await transport.dispatch({
    ...common, operation: "mcp.call",
    input: { workspaceId: harness.workspaceId, workspaceGeneration: 1, name: "echo", arguments: { value: "over-the-route" } },
  }, new AbortController().signal) as { content: Array<{ text: string }> };
  assert.equal(called.content[0]?.text, "source:over-the-route");
  assert.equal(harness.source.callCount, 1, "the real MCP server was called exactly once");

  // Guarded result: an unprivileged token never reaches the source.
  const legacy = new FabricHttpsTransport({ baseUrl: new URL("/", harness.server.url), token: "legacy-gateway-token", ca: await readFile(certificatePath) });
  await assert.rejects(
    () => legacy.dispatch({ ...common, operation: "mcp.call", input: { workspaceId: harness.workspaceId, workspaceGeneration: 1, name: "echo", arguments: { value: "denied" } } }, new AbortController().signal),
    (error: FabricContractError) => {
      assert.equal(error instanceof FabricContractError, true, String(error));
      return true;
    },
  );
  const rawFetch = createFabricPinnedCaFetch({ ca: await readFile(certificatePath), maxResponseBytes: 1024 * 1024 });
  const refused = await rawFetch(new URL(FABRIC_HTTPS_EXCHANGE_PATH, harness.server.url), {
    method: "POST",
    headers: { authorization: "Bearer legacy-gateway-token", "content-type": "application/json" },
    body: JSON.stringify({ version: "fabric.https.exchange.v1", kind: "exchange", requestId: "legacy", endpointId: harness.endpoint.endpointId, endpointKind: "mcp", endpointGeneration: 1, deadlineAt: Date.now() + 10_000, frame: {} }),
  });
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /fabric\.data\.exchange/);
  assert.equal(harness.source.callCount, 1, "a guarded result never reached the MCP source");
});

test("chain 1 fences the old asynchronous commit on restart, rotation, generation change, and route close", async () => {
  const observed: string[] = [];
  for (const fence of COMMIT_FENCES.filter((entry) => entry !== "none")) {
    const root = await mkdtemp(join(tmpdir(), `fabric-e2e-chain1-${fence}-`));
    const harness = await chainOneHarness(root);
    try {
      const owner = createGatewayPrincipal("stdio", "owner", { authenticated: true, workspaceId: harness.workspaceId });
      const { route } = await chainOneRoute(harness, owner);
      const pairing = await harness.runtime.pairingStore.issue({ ttlMs: 60_000, scopes: ["fabric.data"] });
      const ca = await readFile(certificatePath);
      const transport = new FabricHttpsTransport({ baseUrl: new URL("/", harness.server.url), token: pairing.token, ca });
      const common = {
        routeId: route.routeId, endpointId: harness.endpoint.endpointId, endpointKind: "mcp" as const,
        endpointGeneration: route.endpointGeneration, deadlineAt: Date.now() + 5_000,
      };
      const read = { workspaceId: harness.workspaceId, workspaceGeneration: 1 };
      await transport.dispatch({ ...common, operation: "mcp.list", input: read }, new AbortController().signal);
      const callsBefore = harness.source.callCount;

      let invocationState: string | undefined;
      switch (fence) {
        case "restart": {
          await recordRunningInvocation(harness.store, "operation-inflight");
          const recovered = await recoverGatewayFabric({
            store: harness.store,
            eventAdapter: new GatewayFabricEventAdapter({ store: harness.store, journal: new GatewayEventJournal() }),
          });
          assert.ok(recovered.fencedRecords >= 1, "a restart must fence the live lease records");
          invocationState = String((await harness.store.get("invocation", "operation-inflight"))?.state);
          // A restart rebuilds the runtime from the durable store: nothing is
          // carried over in memory, so the old route has no live admission.
          await harness.stopServing();
          const rebuilt = new FabricAdmissionManager(harness.directory, harness.connections, { coordinator: harness.coordinator });
          assert.equal(rebuilt.getRoute(route.routeId), undefined, "a restart must not resurrect an in-memory route");
          await assert.rejects(
            async () => rebuilt.validateRoute(route.routeId),
            (error: FabricContractError) => {
              assert.equal(error.code, "not_found");
              return true;
            },
          );
          // Only the durable record survives, and recovery closed it.
          assert.equal((await rebuilt.getRouteDurable(route.routeId))?.state, "closed");
          break;
        }
        case "pair-rotation": {
          assert.equal(await harness.runtime.pairingStore.revoke(pairing.id, { revokedBy: "operator" }), true);
          // A rotated pairing is a new identity; the retired token is not it.
          await harness.runtime.pairingStore.issue({ ttlMs: 60_000, scopes: ["fabric.data"] });
          break;
        }
        case "workspace-generation": {
          harness.advertise(2);
          assert.equal(harness.directory.getWorkspace("fabric-workspace-1")?.generation, 2);
          break;
        }
        case "route-close": {
          const closed = resultData(await harness.runtime.call("route", control("close", {
            routeId: route.routeId, expectedRevision: route.revision,
          }), owner)).route as { state: string };
          assert.equal(closed.state, "closed");
          break;
        }
        default: throw new Error("unexpected fence");
      }

      // The old asynchronous commit: the same route, token, and generation.
      await assert.rejects(
        () => transport.dispatch({
          ...common, requestId: `late-${fence}`, operationId: `late-operation-${fence}`, streamId: `late-stream-${fence}`,
          operation: "mcp.call", input: { ...read, name: "echo", arguments: { value: "late" } },
        }, new AbortController().signal),
        (error: FabricContractError) => {
          assert.equal(error instanceof FabricContractError, true, String(error));
          return true;
        },
        `${fence} left a way for the late commit to land`,
      );
      assert.equal(harness.source.callCount, callsBefore, `${fence} did not prevent the late MCP call`);
      if (invocationState !== undefined) {
        assert.equal(invocationState, "outcome-unknown", "a restart must report the interrupted operation as unknown, never complete");
      }
      observed.push(fence);
    } finally {
      await harness.close();
      await rm(root, { recursive: true, force: true });
    }
  }
  assert.deepEqual(observed, ["restart", "pair-rotation", "workspace-generation", "route-close"]);
});

// ---------------------------------------------------------------------------
// Chain 2: teammate placement -> real source subprocess -> control, one
// completion -> the original publication at the origin
// ---------------------------------------------------------------------------

const CAPABILITIES: BackendCapabilities = {
  outputSchema: "native", forkContext: "unsupported", modelSelection: "native", thinkingLevel: "native",
  todoBinding: "unsupported", toolFilter: "unsupported", steer: "native", followUp: "native", abort: "native",
};

interface ChainTwoSource {
  attempts: string[];
  childOutputs: string[];
  release(): void;
  dispose(): void;
}

/**
 * The source runtime port.
 *
 * The tree ships no production `FabricTeammateRuntimePort`, so the port itself is
 * test-local — but it runs a real child process, and every contract it satisfies
 * (the `FabricTeammateRuntimePort` interface, an ACK before return, no canonical
 * publication of its own) is the real one.
 */
function chainTwoSource(): ChainTwoSource {
  const attempts: string[] = [];
  const childOutputs: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const port: FabricTeammateRuntimePort = {
    async startAttempt(request: FabricTeammateAttemptRequest): Promise<FabricTeammateAttempt> {
      attempts.push(request.spec.task);
      const script = "process.stdout.write('source:' + String(process.argv[1]))";
      const child = spawn(process.execPath, ["-e", script, request.spec.task], { stdio: ["ignore", "pipe", "ignore"] });
      const stdout = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.once("error", reject);
        child.once("close", (code) => {
          if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
          else reject(new Error(`Fabric source process exited with ${String(code)}`));
        });
      });
      childOutputs.push(stdout);
      const settled: SingleResult = {
        agent: request.spec.agent, task: request.spec.task, exitCode: 0,
        messages: [{ role: "assistant", content: stdout }],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 },
        model: request.spec.model ?? "model-a", correlationId: request.correlationId,
        durationMs: 1, terminalStatus: "completed",
      };
      const outcome = (async (): Promise<AttemptOutcome> => {
        // The source's completion is held until the test releases it, which is how
        // a fence can land while the attempt is still in flight.
        await gate;
        request.onTurnComplete?.(settled, "completed");
        return {
          result: settled,
          recovery: {
            settlementAuthority: "authoritative", completedToolCount: 1, inFlightToolCount: 0,
            preActivityInfrastructureExit: false, externalReplayRisk: false,
          },
          reclamation: Promise.resolve({ status: "reclaimed" }),
        };
      })();
      return {
        acceptedBackend: "pi-subprocess",
        acceptedModel: request.spec.model,
        acceptedCapabilities: CAPABILITIES,
        outcome,
        send: () => true,
        abort: () => undefined,
      };
    },
  };
  const registration = registerFabricTeammateRuntimePort(port);
  return { attempts, childOutputs, release, dispose: () => registration.dispose() };
}

interface ChainTwoAttempt {
  run: Awaited<ReturnType<ReturnType<typeof createFabricBackend>["start"]>>;
  completions: string[];
  source: ChainTwoSource;
  route: EndpointRouteHandle;
  pairingId: string;
  settle(): Promise<AttemptOutcome>;
  /**
   * Read the Endpoint's event control operation once.
   *
   * A fence is effective only once the origin's pump can no longer read events,
   * so the loop proves that at the boundary instead of racing the source.
   */
  probeEvents(): Promise<void>;
}

/** Start one real placed attempt over the real Gateway HTTPS route. */
async function chainTwoAttempt(harness: ChainOneHarness, bindingId: string, route: EndpointRouteHandle): Promise<ChainTwoAttempt> {
  const ca = await readFile(certificatePath);
  const pairing = await harness.runtime.pairingStore.issue({ ttlMs: 120_000, scopes: ["fabric.data"] });
  const transport = new FabricHttpsTransport({ baseUrl: new URL("/", harness.server.url), token: pairing.token, ca });
  // The origin reads placement events through the endpoint's own `agent.events`
  // control operation. The Gateway ships that operation, but no origin-side
  // adapter maps it onto the channel transport, so this adapter is test-local:
  // both the operation it calls and the events it forwards are real.
  const controlTransport = {
    dispatch: (input: Parameters<typeof transport.dispatch>[0], signal: AbortSignal) => transport.dispatch(input, signal),
    events: async (input: Parameters<typeof transport.events>[0], signal: AbortSignal): Promise<Awaited<ReturnType<typeof transport.events>>> => {
      let page: { nextSequence: number; events: Awaited<ReturnType<typeof transport.events>>["events"] };
      try {
        page = await transport.dispatch({
          routeId: input.routeId, endpointId: input.endpointId, endpointKind: "agent",
          endpointGeneration: input.endpointGeneration, deadlineAt: input.deadlineAt, requestId: input.requestId,
          operation: "agent.events",
          input: {
            version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId: "attempt-1", placementId: "placement-1",
            afterSequence: input.afterSequence, ...(input.limit === undefined ? {} : { limit: input.limit }),
          },
        }, signal) as unknown as { nextSequence: number; events: Awaited<ReturnType<typeof transport.events>>["events"] };
      } catch (error) {
        // The channel pumps before it starts, so an unregistered attempt is an
        // empty read rather than a transport failure.
        if (error instanceof FabricContractError && error.code === "not_found") {
          page = { nextSequence: input.afterSequence, events: [] };
        } else {
          throw error;
        }
      }
      return {
        version: "fabric.https.events.v1", kind: "events", requestId: input.requestId,
        routeId: input.routeId, endpointId: input.endpointId, endpointKind: "agent",
        endpointGeneration: input.endpointGeneration, deadlineAt: input.deadlineAt,
        nextSequence: page.nextSequence, events: page.events,
      };
    },
  };
  const resolver = new FabricAgentRouteResolver({
    transport: controlTransport,
    authority: {
      routeOf: (routeId) => harness.admissions.validateRoute(routeId),
      endpointOf: (endpointId) => harness.directory.getEndpoint(endpointId),
    },
    pollIntervalMs: 5,
  });
  const backend = createFabricBackend(resolver);
  const placement: TeammatePlacementV1 = {
    version: "fabric.placement.v1", placementId: "placement-1", routeId: route.routeId,
    workspaceBindingId: bindingId, endpointId: harness.agentEndpoint!.endpointId,
    connectionGeneration: route.connectionGeneration, workspaceGeneration: route.workspaceGeneration ?? 1,
    endpointGeneration: route.endpointGeneration, requestedModel: "model-a", requestedRole: "general",
    requestedTaskType: "development", deadlineAt: route.expiresAt,
  };
  const spec: TeammateRunSpec = { agent: "general", task: "inspect the source workspace", model: "model-a", placement };
  const completions: string[] = [];
  const source = chainTwoSource();
  const run = await backend.start(spec, {
    correlationId: "attempt-1", baseCwd: process.cwd(), host: {}, config: {},
    onTurnComplete: (settled) => completions.push(settled.correlationId),
  });
  return {
    run,
    completions,
    source,
    route,
    pairingId: pairing.id,
    settle: async () => {
      source.release();
      return run.outcome;
    },
    probeEvents: async () => {
      await controlTransport.events({
        requestId: `probe-${Date.now()}`, routeId: route.routeId, endpointId: harness.agentEndpoint!.endpointId,
        endpointKind: "agent", endpointGeneration: route.endpointGeneration,
        deadlineAt: Math.min(route.expiresAt, Date.now() + 5_000), afterSequence: 0,
      }, new AbortController().signal);
    },
  };
}

/** Admit the Agent Endpoint's binding and route over real Gateway control. */
async function chainTwoAdmission(
  harness: ChainOneHarness,
  owner: ReturnType<typeof createGatewayPrincipal>,
): Promise<{ bindingId: string; route: EndpointRouteHandle }> {
  const binding = resultData(await harness.runtime.call("workspace", control("bind", {
    deviceId: "device-1", connectionId: harness.connectionId, workspaceId: "fabric-workspace-1",
    expectedConnectionGeneration: harness.connectionGeneration, expectedWorkspaceGeneration: 1, requestedTtlMs: 90_000,
  }), owner)).binding as { bindingId: string };
  const route = resultData(await harness.runtime.call("route", control("open", {
    connectionId: harness.connectionId, workspaceBindingId: binding.bindingId,
    endpointId: harness.agentEndpoint!.endpointId, expectedConnectionGeneration: harness.connectionGeneration,
    expectedWorkspaceGeneration: 1, expectedEndpointGeneration: 1, requestedTtlMs: 45_000,
    operationClass: "agent-placement", pathCandidates: ["hub"],
  }), owner)).route as EndpointRouteHandle;
  return { bindingId: binding.bindingId, route };
}

test("chain 2 places a teammate attempt on a real source subprocess and reaches exactly one origin publication", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fabric-e2e-chain2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const harness = await chainOneHarness(root, (fn) => t.after(fn), { agentEndpoint: true });
  const owner = createGatewayPrincipal("stdio", "owner", { authenticated: true, workspaceId: harness.workspaceId });
  const { bindingId, route } = await chainTwoAdmission(harness, owner);

  const attempt = await chainTwoAttempt(harness, bindingId, route);
  try {
    const outcome = await attempt.settle();
    // Exactly one attempt, and it was a real source subprocess.
    assert.deepEqual(attempt.source.attempts, ["inspect the source workspace"]);
    assert.deepEqual(attempt.source.childOutputs, ["source:inspect the source workspace"]);
    assert.equal(outcome.result.exitCode, 0);
    assert.equal(outcome.result.messages[0]?.content, "source:inspect the source workspace");
    // Exactly one completion, delivered to the origin.
    assert.deepEqual(attempt.completions, ["attempt-1"]);
    assert.deepEqual(await outcome.reclamation, { status: "reclaimed" });
    // Publication identity stays at the origin: the source's result carries the
    // origin's correlation and invents no canonical publication of its own.
    assert.equal(outcome.result.correlationId, "attempt-1");
    assert.equal((outcome.result as unknown as Record<string, unknown>).publicationId, undefined);
  } finally {
    attempt.source.dispose();
  }
});

test("chain 2 fences the old asynchronous completion on restart, rotation, generation change, and route close", async () => {
  const observed: string[] = [];
  for (const fence of COMMIT_FENCES.filter((entry) => entry !== "none")) {
    const root = await mkdtemp(join(tmpdir(), `fabric-e2e-chain2-${fence}-`));
    const harness = await chainOneHarness(root, undefined, { agentEndpoint: true });
    try {
      const owner = createGatewayPrincipal("stdio", "owner", { authenticated: true, workspaceId: harness.workspaceId });
      const { bindingId, route } = await chainTwoAdmission(harness, owner);
      const attempt = await chainTwoAttempt(harness, bindingId, route);
      let invocationState: string | undefined;
      try {
        switch (fence) {
          case "restart": {
            await recordRunningInvocation(harness.store, "operation-inflight");
            await recoverGatewayFabric({
              store: harness.store,
              eventAdapter: new GatewayFabricEventAdapter({ store: harness.store, journal: new GatewayEventJournal() }),
            });
            invocationState = String((await harness.store.get("invocation", "operation-inflight"))?.state);
            await harness.stopServing();
            break;
          }
          case "pair-rotation": {
            assert.equal(await harness.runtime.pairingStore.revoke(attempt.pairingId, { revokedBy: "operator" }), true);
            break;
          }
          case "workspace-generation": {
            harness.advertise(2);
            assert.equal(harness.directory.getWorkspace("fabric-workspace-1")?.generation, 2);
            break;
          }
          case "route-close": {
            const closed = resultData(await harness.runtime.call("route", control("close", {
              routeId: route.routeId, expectedRevision: route.revision,
            }), owner)).route as { state: string };
            assert.equal(closed.state, "closed");
            break;
          }
          default: throw new Error("unexpected fence");
        }

        let channelClosed = false;
        const deadline = Date.now() + 3_000;
        while (!channelClosed && Date.now() < deadline) {
          try {
            await attempt.probeEvents();
            await new Promise((resolve) => setTimeout(resolve, 10));
          } catch {
            channelClosed = true;
          }
        }
        assert.equal(channelClosed, true, `${fence} never closed the origin's event channel`);

        const outcome = await attempt.settle();
        // The source finished, but a fenced route means the origin never publishes it.
        assert.deepEqual(attempt.completions, [], `${fence} let a fenced completion reach publication`);
        assert.notEqual(outcome.result.exitCode, 0, `${fence} published a successful result`);
        assert.equal((await outcome.reclamation).status, "unreaped", `${fence} claimed a release the source never confirmed`);
        if (invocationState !== undefined) {
          assert.equal(invocationState, "outcome-unknown");
        }
        // No second attempt was created to work around the fence.
        assert.deepEqual(attempt.source.attempts, ["inspect the source workspace"]);
        observed.push(fence);
      } finally {
        attempt.source.dispose();
      }
    } finally {
      await harness.close();
      await rm(root, { recursive: true, force: true });
    }
  }
  assert.deepEqual(observed, ["restart", "pair-rotation", "workspace-generation", "route-close"]);
});

// ---------------------------------------------------------------------------
// Chain 3: WSS Connector, two allowlisted Edge devices, a direct failure, and
// a relay that stays on the SAME Endpoint
// ---------------------------------------------------------------------------

const EDGE_AUDIENCE = "edge.e2e.test";
const EDGE_SECRET = "edge-relay-e2e-secret-0001";

/**
 * A live outbound path for the relay.
 *
 * The Hub's WSS listener carries the Connector control channel and refuses
 * route-bound frames (asserted in this test), so the relay rides the Hub's real
 * route channel: `FabricHttpsTransport` to the real Endpoint dispatcher. The
 * provider is an adapter; both ends of it are production code.
 */
function relayOutbound(options: {
  transport: FabricHttpsTransport;
  routeOf: () => EndpointRouteHandle;
  now?: () => number;
}): FabricTransportProvider {
  let sequence = 0;
  return {
    kind: "outbound-wss",
    async connect(request: FabricConnectRequest): Promise<FabricLiveConnection> {
      const route = options.routeOf();
      return {
        descriptor: {
          protocolVersion: FABRIC_PROTOCOL_VERSION,
          limits,
          lease: {
            connectionId: route.connectionId,
            deviceId: request.deviceId,
            connectorId: request.connectorId,
            connectorInstanceNonce: "edge-relay-instance-1",
            generation: route.connectionGeneration,
            state: "connected",
            capabilityDigest: "capability-digest-1",
            establishedAt: (options.now ?? Date.now)(),
            expiresAt: route.expiresAt,
            revision: 0,
          },
        },
        exchange: async (envelope, signal) => {
          const payload = envelope.payload as Record<string, JsonValue>;
          const route = options.routeOf();
          const result = await options.transport.dispatch({
            routeId: route.routeId,
            endpointId: route.endpointId,
            endpointKind: "mcp",
            endpointGeneration: route.endpointGeneration,
            deadlineAt: route.expiresAt,
            operation: String(payload.operation),
            input: (payload.input ?? {}) as Record<string, JsonValue>,
            requestId: `relay-${++sequence}`,
            operationId: `relay-operation-${sequence}`,
            streamId: `relay-stream-${sequence}`,
          }, signal);
          return fabricEdgeRelayEnvelope("control_response", route.routeId, { result: result as JsonValue });
        },
        close: async () => undefined,
      };
    },
  };
}

interface ChainThreeHarness {
  harness: ChainOneHarness;
  certificate: Buffer;
  hub: FabricWssServer;
  hubListener: HttpsServer;
  connector: FabricConnectorRuntime;
  direct: FabricDirectRouteServer;
  directListener: HttpsServer;
  directPort: number;
  edge: FabricEdgeRuntime;
  keyring: FabricRouteTicketKeyringStore;
  transport: FabricHttpsTransport;
  pairingId: string;
  route: EndpointRouteHandle;
  directFailures(): number;
  close(): Promise<void>;
}

async function chainThreeHarness(root: string, t: test.TestContext): Promise<ChainThreeHarness> {
  const harness = await chainOneHarness(root, (fn) => t.after(fn), { extraDevices: [{ deviceId: "device-2", label: "Device Two" }] });
  const certificate = await readFile(certificatePath);
  const key = await readFile(keyPath);
  const owner = createGatewayPrincipal("stdio", "owner", { authenticated: true, workspaceId: harness.workspaceId });
  // The route is admitted with both Edge paths as candidates, so a genuine
  // failure of the direct path has a pre-admitted alternative to move to.
  const binding = resultData(await harness.runtime.call("workspace", control("bind", {
    deviceId: "device-1", connectionId: harness.connectionId, workspaceId: "fabric-workspace-1",
    expectedConnectionGeneration: harness.connectionGeneration, expectedWorkspaceGeneration: 1, requestedTtlMs: 60_000,
  }), owner)).binding as { bindingId: string };
  const route = resultData(await harness.runtime.call("route", control("open", {
    connectionId: harness.connectionId, workspaceBindingId: binding.bindingId, endpointId: "endpoint-1",
    expectedConnectionGeneration: harness.connectionGeneration, expectedWorkspaceGeneration: 1,
    expectedEndpointGeneration: 1, requestedTtlMs: 45_000, operationClass: "mcp-read",
    pathCandidates: ["lan-direct", "edge-relay"],
  }), owner)).route as EndpointRouteHandle;

  // Two Devices, two Endpoints: the direct target and a second allowlisted
  // Device whose Endpoint must never be selected as a fallback.
  const secondDevice = {
    deviceId: "device-2", label: "Device Two", connectorId: "connector-1", connectionMode: "https" as const,
    platform: "linux", architecture: "x64", enabled: true, revision: 1,
  };
  harness.connections.acceptAdvertisement({
    connectionId: harness.connectionId,
    connectionGeneration: harness.connectionGeneration,
    capabilityDigest: "capability-digest-1",
    advertisementRevision: harness.nextAdvertisementRevision(),
    devices: [
      { deviceId: "device-1", label: "Device One", connectorId: "connector-1", connectionMode: "https", platform: "linux", architecture: "x64", enabled: true, revision: 1 },
      { deviceId: "device-2", label: "Device Two", connectorId: "connector-1", connectionMode: "https", platform: "linux", architecture: "x64", enabled: true, revision: 1 },
    ],
    workspaces: [{
      workspaceId: "fabric-workspace-1", deviceId: "device-1", localWorkspaceId: harness.workspaceId, label: "Workspace One",
      mode: "permanent", generation: 1, policyDigest: "policy-digest-1", endpointIds: ["endpoint-1"], revision: 2,
    }],
    endpoints: [
      {
        endpointId: "endpoint-1", deviceId: "device-1", connectorId: "connector-1",
        scope: { kind: "workspace", workspaceId: "fabric-workspace-1" }, generation: 1,
        contractHash: "a".repeat(64), status: "online", revision: 1, kind: "mcp",
        serverName: "fabric-e2e-source", protocolVersion: "2025-11-25", transport: "streamable-http", durableDeduplication: false,
      },
      {
        endpointId: "endpoint-2", deviceId: "device-2", connectorId: "connector-1",
        scope: { kind: "device" }, generation: 1, contractHash: "c".repeat(64), status: "online", revision: 1, kind: "mcp",
        serverName: "other-source", protocolVersion: "2025-11-25", transport: "edge-relay", durableDeduplication: false,
      },
    ],
    capabilities: [{ capabilityId: "capability-1", kind: "tool", endpointId: "endpoint-1", contractHash: "a".repeat(64), trustLevel: "paired", priority: 10 }],
  });
  assert.equal(harness.directory.getDevice(secondDevice.deviceId)?.deviceId, "device-2");

  // The WSS Connector leg: a real Connector proves possession of its enrolled
  // key over real TLS and advertises both allowlisted Devices.
  const hubListener = createHttpsServer({ cert: certificate, key });
  await new Promise<void>((resolve, reject) => { hubListener.once("error", reject); hubListener.listen(0, "localhost", resolve); });
  const hubAddress = hubListener.address();
  assert(hubAddress && typeof hubAddress !== "string");
  const security = new FabricConnectorSecurity({ audience: EDGE_AUDIENCE });
  const hub = new FabricWssServer({ security, server: hubListener, limits: { heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 5_000 }, drainTimeoutMs: 200 });
  hub.start();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  security.enroll({
    connectorId: "connector-1", keyId: "key-1",
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    scopes: ["fabric.data.*"],
  });
  const connector = new FabricConnectorRuntime({
    url: `wss://localhost:${hubAddress.port}${FABRIC_WSS_PATH}`,
    connectorId: "connector-1", keyId: "key-1", audience: EDGE_AUDIENCE, credentialGeneration: 1,
    ca: certificate, limits: { heartbeatIntervalMs: 50, heartbeatTimeoutMs: 5_000 },
    sign: (payload) => signPayload(null, Buffer.from(payload, "utf8"), privateKey).toString("base64"),
    advertisementOf: () => ({
      advertisementRevision: 2, capabilityDigest: "capability-digest-1",
      payload: { devices: [{ deviceId: "device-1" }, { deviceId: "device-2" }] },
    }),
  });
  await connector.start();
  assert.equal(connector.state, "ready");
  assert.equal(hub.sessionOf("connector-1")?.advertisementRevision, 2);

  // The Edge allowlist: both Devices, and the direct target admitted on one path.
  const keyring = new FabricRouteTicketKeyringStore({ activeKeyId: "key-1", secrets: { "key-1": EDGE_SECRET } });
  const tickets = new FabricRouteTicketSecurity({ keyring });
  const edgeConfig = parseFabricEdgeConfig({
    version: FABRIC_EDGE_CONFIG_VERSION, enabled: true, connectorId: "connector-1", audience: EDGE_AUDIENCE,
    pathCandidates: ["lan-direct", "edge-relay"],
    devices: [{ deviceId: "device-1" }, { deviceId: "device-2" }],
    endpoints: [
      { endpointId: "endpoint-1", deviceId: "device-1", operationClasses: ["mcp-read", "mcp-mutation"] },
      { endpointId: "endpoint-2", deviceId: "device-2", operationClasses: ["mcp-read"] },
    ],
    workspaces: [{
      workspaceBindingId: route.workspaceBindingId!, deviceId: "device-1",
      workspaceId: "fabric-workspace-1", localWorkspacePath: root,
    }],
    health: { intervalMs: 1_000, timeoutMs: 5_000 }, ticketTtlMs: 30_000, revision: 2,
  });
  requireAllowedEdgeDevice(edgeConfig, "device-1");
  requireAllowedEdgeDevice(edgeConfig, "device-2");
  requireAllowedEdgeEndpoint(edgeConfig, "device-1", "endpoint-1");
  requireAllowedEdgeEndpoint(edgeConfig, "device-2", "endpoint-2");
  assert.throws(() => requireAllowedEdgeEndpoint(edgeConfig, "device-1", "endpoint-2"), /not on this Edge's allowlist/);

  const edge = new FabricEdgeRuntime({
    config: edgeConfig, tickets, routes: harness.admissions, admissions: harness.admissions,
    confirmWithHub: { confirm: async (ticket, expectation) => tickets.verify(ticket, expectation) },
  });
  edge.recordPresence({ kind: "endpoint", deviceId: "device-1", endpointId: "endpoint-1" }, 1, true);

  // The direct path, served over real TLS WSS, where the first attempt fails.
  const directFailures = { count: 0 };
  const directListener = createHttpsServer({ cert: certificate, key });
  await new Promise<void>((resolve, reject) => { directListener.once("error", reject); directListener.listen(0, "localhost", resolve); });
  const directAddress = directListener.address();
  assert(directAddress && typeof directAddress !== "string");
  // A path listener holds its own verifier: a ticket is presented to exactly one
  // verifier instance per hop, so replay fencing stays per-hop.
  const directTickets = new FabricRouteTicketSecurity({ keyring });
  const direct = new FabricDirectRouteServer({
    server: directListener, tickets: directTickets, routes: harness.admissions, audience: EDGE_AUDIENCE,
    subjects: ["subject-1"], limits: { heartbeatIntervalMs: 50, heartbeatTimeoutMs: 5_000 }, drainTimeoutMs: 200,
    handleStream: () => {
      directFailures.count += 1;
      throw new FabricContractError("unavailable", "the direct path failed to carry the operation");
    },
  });
  direct.start();

  const pairing = await harness.runtime.pairingStore.issue({ ttlMs: 120_000, scopes: ["fabric.data"] });
  const transport = new FabricHttpsTransport({ baseUrl: new URL("/", harness.server.url), token: pairing.token, ca: certificate });
  const close = async (): Promise<void> => {
    await direct.close("test complete");
    directListener.closeAllConnections();
    await new Promise<void>((resolve) => directListener.close(() => resolve()));
    await connector.stop("test complete");
    await hub.close("test complete");
    hubListener.closeAllConnections();
    await new Promise<void>((resolve) => hubListener.close(() => resolve()));
    await harness.close();
  };
  t.after(close);

  return {
    harness, certificate, hub, hubListener, connector, direct, directListener,
    directPort: directAddress.port, edge, keyring, transport, pairingId: pairing.id,
    route: harness.admissions.validateRoute(route.routeId), directFailures: () => directFailures.count,
    close,
  };
}

/** Dial the direct listener and carry one stream frame over real TLS WSS. */
async function directStream(
  chain: ChainThreeHarness,
  ticket: unknown,
  frame: Record<string, unknown>,
): Promise<{ opened: boolean; error?: string; closed: number }> {
  const socket = new WebSocket(`wss://localhost:${chain.directPort}${FABRIC_DIRECT_ROUTE_PATH}`, { ca: chain.certificate });
  const received: Record<string, unknown>[] = [];
  const waiters: Array<{ kind: string; resolve: (envelope: Record<string, unknown>) => void }> = [];
  const waitFor = (kind: string): Promise<Record<string, unknown>> => new Promise((resolve) => {
    const existing = received.find((envelope) => envelope.kind === kind);
    if (existing !== undefined) return resolve(existing);
    waiters.push({ kind, resolve });
  });
  socket.on("message", (data) => {
    const envelope = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data)) as Record<string, unknown>;
    received.push(envelope);
    for (const waiter of [...waiters]) {
      if (waiter.kind === envelope.kind) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(envelope);
      }
    }
  });
  const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
  // Every wait is bounded: a refusal that arrives as an error frame must not
  // turn into a hang in the harness.
  const settled = new Promise<{ kind: "timeout" }>((resolve) => { setTimeout(() => resolve({ kind: "timeout" }), 3_000).unref?.(); });
  const awaitAny = async (kinds: readonly string[]): Promise<{ kind: string; envelope?: Record<string, unknown> }> => {
    const result = await Promise.race([
      ...kinds.map((kind) => waitFor(kind).then((envelope) => ({ kind, envelope }))),
      closed.then(() => ({ kind: "closed" })),
      settled,
    ]);
    return result;
  };
  await new Promise<void>((resolve) => socket.on("open", () => resolve()));
  const envelope = (kind: string, payload: unknown): Record<string, unknown> => ({
    version: FABRIC_PROTOCOL_VERSION, messageId: `m-${kind}-${Math.random().toString(36).slice(2)}`,
    kind, sentAt: Date.now(), payload,
  });
  socket.send(JSON.stringify(envelope("route_open", { ticket })));
  const openedResult = await awaitAny(["route_open", "error"]);
  if (openedResult.kind !== "route_open") {
    const refusal = received.find((entry) => entry.kind === "error");
    socket.close();
    return {
      opened: false,
      error: refusal === undefined ? openedResult.kind : `${String((refusal.payload as Record<string, unknown>).code)}: ${String((refusal.payload as Record<string, unknown>).message)}`,
      closed: await closed,
    };
  }
  const accepted = openedResult.envelope!;
  if ((accepted.payload as Record<string, unknown>).accepted !== true) {
    socket.close();
    return { opened: false, error: "refused", closed: await closed };
  }
  socket.send(JSON.stringify(envelope("stream", frame)));
  const streamResult = await awaitAny(["stream", "error"]);
  const failed = received.find((entry) => entry.kind === "error");
  socket.close();
  const closedCode = await closed;
  if (failed !== undefined) return { opened: true, error: String((failed.payload as Record<string, unknown>).code), closed: closedCode };
  if (streamResult.kind !== "stream") return { opened: true, error: streamResult.kind, closed: closedCode };
  return { opened: true, closed: closedCode };
}

test("chain 3 carries a direct failure to a pre-admitted candidate of the same Endpoint and relays it there", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fabric-e2e-chain3-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const chain = await chainThreeHarness(root, t);
  const route = chain.route;

  const ticket = chain.edge.issueRouteTicket({ routeId: route.routeId, subject: "subject-1" });
  await chain.edge.validateRouteTicketOnline(ticket, {
    subjects: ["subject-1"], audience: EDGE_AUDIENCE, routeId: route.routeId, deviceId: "device-1",
    endpointId: "endpoint-1", connectionGeneration: route.connectionGeneration,
    endpointGeneration: route.endpointGeneration, operationClass: "mcp-read",
    ...(route.workspaceBindingId === undefined ? {} : { workspaceBindingId: route.workspaceBindingId }),
    ...(route.workspaceGeneration === undefined ? {} : { workspaceGeneration: route.workspaceGeneration }),
  });
  const direct = await directStream(chain, ticket, {
    version: "fabric.stream.v1", streamId: "stream-1", routeId: route.routeId, operationId: "operation-1",
    sequence: 0, kind: "open", sentAt: Date.now(),
    payload: { operation: "mcp.call", input: { workspaceId: chain.harness.workspaceId, workspaceGeneration: 1, name: "echo", arguments: { value: "direct" } } },
  });
  assert.equal(direct.opened, true);
  assert.equal(direct.error, "unavailable", "the direct path must fail rather than fall through");
  assert.equal(chain.directFailures(), 1);

  // The failure advances only to another pre-admitted candidate of the same Endpoint.
  const advanced = await chain.edge.advancePath({
    routeId: route.routeId, expectedRevision: route.revision, failedPath: "lan-direct", replayClass: "readonly",
  });
  assert.equal(advanced.selectedPath, "edge-relay");
  assert.equal(advanced.endpointId, "endpoint-1", "the failure reselected an Endpoint");
  assert.equal(advanced.deviceId, "device-1", "the failure reselected a Device");
  assert.equal(advanced.endpointGeneration, route.endpointGeneration);
  assert.equal(advanced.connectionGeneration, route.connectionGeneration);
  // The second allowlisted Device exists and is still never an alternative.
  assert.notEqual(advanced.endpointId, "endpoint-2");
  await assert.rejects(
    () => chain.edge.advancePath({ routeId: route.routeId, expectedRevision: advanced.revision, failedPath: "edge-relay", replayClass: "non-replayable" }),
    /replay|permission_denied|unavailable/,
  );

  // Relayed on the same Endpoint, over the Hub's route channel.
  const relay = new FabricEdgeRelayTransport({
    route: advanced,
    routes: chain.harness.admissions,
    outbound: relayOutbound({ transport: chain.transport, routeOf: () => chain.harness.admissions.validateRoute(route.routeId) }),
  });
  const connection = await relay.connect({
    requestId: "relay-connect", deviceId: "device-1", connectorId: "connector-1",
    expectedCredentialGeneration: 1, deadlineAt: Date.now() + 10_000, limits,
  }, new AbortController().signal);
  const callsBefore = chain.harness.source.callCount;
  const response = await connection.exchange(fabricEdgeRelayEnvelope("invoke", route.routeId, {
    operation: "mcp.call",
    input: { workspaceId: chain.harness.workspaceId, workspaceGeneration: 1, name: "echo", arguments: { value: "relayed" } },
    deviceId: "device-1", endpointId: "endpoint-1", endpointGeneration: route.endpointGeneration,
  }), new AbortController().signal);
  const result = (response.payload as { result: { content: Array<{ text: string }> } }).result;
  assert.equal(result.content[0]?.text, "source:relayed");
  assert.equal(chain.harness.source.callCount, callsBefore + 1, "the relay did not reach the same Endpoint exactly once");
  await connection.close("relay complete");

  // The relay is bound to its own route, Device, Endpoint, and generation.
  const second = await relay.connect({
    requestId: "relay-connect-2", deviceId: "device-1", connectorId: "connector-1",
    expectedCredentialGeneration: 1, deadlineAt: Date.now() + 10_000, limits,
  }, new AbortController().signal);
  for (const hostile of [
    fabricEdgeRelayEnvelope("invoke", "route-other", { operation: "mcp.call", input: {}, deviceId: "device-1", endpointId: "endpoint-1" }),
    fabricEdgeRelayEnvelope("invoke", route.routeId, { operation: "mcp.call", input: {}, deviceId: "device-2", endpointId: "endpoint-1" }),
    fabricEdgeRelayEnvelope("invoke", route.routeId, { operation: "mcp.call", input: {}, deviceId: "device-1", endpointId: "endpoint-2" }),
    fabricEdgeRelayEnvelope("invoke", route.routeId, { operation: "mcp.call", input: {}, deviceId: "device-1", endpointId: "endpoint-1", endpointGeneration: route.endpointGeneration + 1 }),
  ]) {
    await assert.rejects(() => second.exchange(hostile, new AbortController().signal), FabricContractError);
  }
  // A route-bound frame that names no route at all is refused before it leaves.
  await assert.rejects(
    () => second.exchange({
      version: FABRIC_PROTOCOL_VERSION, messageId: "m-route-missing", kind: "invoke", sentAt: Date.now(),
      payload: { operation: "mcp.call", input: {} },
    }, new AbortController().signal),
    /must name the route/,
  );
  await second.close("relay complete");
  assert.equal(chain.harness.source.callCount, callsBefore + 1, "a refused relay frame reached the Endpoint");

  // The Hub's WSS listener is a control channel: a route-bound frame is refused
  // there rather than relayed.
  const raw = new WebSocket(`wss://localhost:${(chain.hubListener.address() as { port: number }).port}${FABRIC_WSS_PATH}`, { ca: chain.certificate });
  const refusals: Record<string, unknown>[] = [];
  await new Promise<void>((resolve) => raw.on("open", () => resolve()));
  raw.on("message", (data) => refusals.push(JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data)) as Record<string, unknown>));
  raw.send(JSON.stringify({
    version: FABRIC_PROTOCOL_VERSION, messageId: "m-route-bound", kind: "invoke", sentAt: Date.now(),
    payload: { routeId: route.routeId, operation: "mcp.call", input: {} },
  }));
  await new Promise<void>((resolve) => { raw.on("close", () => resolve()); setTimeout(resolve, 2_000); });
  const refusal = refusals.find((entry) => entry.kind === "error");
  assert.ok(refusal !== undefined, "the control channel accepted a route-bound frame");
  assert.equal((refusal.payload as Record<string, unknown>).code, "invalid_state");
});

test("chain 3 fences a relayed commit on restart, rotation, generation change, and route close", async (): Promise<void> => {
  const observed: string[] = [];
  for (const fence of COMMIT_FENCES.filter((entry) => entry !== "none")) {
    const root = await mkdtemp(join(tmpdir(), `fabric-e2e-chain3-${fence}-`));
    const chain = await chainThreeHarness(root, { after: () => undefined } as unknown as test.TestContext);
    try {
      const route = chain.route;
      const advanced = await chain.edge.advancePath({
        routeId: route.routeId, expectedRevision: route.revision, failedPath: "lan-direct", replayClass: "readonly",
      });
      const relay = new FabricEdgeRelayTransport({
        route: advanced,
        routes: chain.harness.admissions,
        outbound: relayOutbound({ transport: chain.transport, routeOf: () => chain.harness.admissions.validateRoute(route.routeId) }),
      });
      const callsBefore = chain.harness.source.callCount;

      switch (fence) {
        case "restart": {
          await recordRunningInvocation(chain.harness.store, "operation-inflight");
          await recoverGatewayFabric({
            store: chain.harness.store,
            eventAdapter: new GatewayFabricEventAdapter({ store: chain.harness.store, journal: new GatewayEventJournal() }),
          });
          await chain.harness.stopServing();
          const rebuilt = new FabricAdmissionManager(chain.harness.directory, chain.harness.connections, { coordinator: chain.harness.coordinator });
          assert.equal((await rebuilt.getRouteDurable(route.routeId))?.state, "closed");
          break;
        }
        case "pair-rotation": {
          assert.equal(await chain.harness.runtime.pairingStore.revoke(chain.pairingId, { revokedBy: "operator" }), true);
          break;
        }
        case "workspace-generation": {
          chain.harness.advertise(2);
          break;
        }
        case "route-close": {
          const closed = await chain.harness.admissions.closeRoute(route.routeId, chain.harness.admissions.validateRoute(route.routeId).revision);
          assert.equal(closed.state, "closed");
          break;
        }
        default: throw new Error("unexpected fence");
      }

      await assert.rejects(
        async () => {
          const connection = await relay.connect({
            requestId: `late-relay-${fence}`, deviceId: "device-1", connectorId: "connector-1",
            expectedCredentialGeneration: 1, deadlineAt: Date.now() + 10_000, limits,
          }, new AbortController().signal);
          try {
            return await connection.exchange(fabricEdgeRelayEnvelope("invoke", route.routeId, {
              operation: "mcp.call",
              input: { workspaceId: chain.harness.workspaceId, workspaceGeneration: 1, name: "echo", arguments: { value: "late" } },
              deviceId: "device-1", endpointId: "endpoint-1", endpointGeneration: route.endpointGeneration,
            }), new AbortController().signal);
          } finally {
            await connection.close("late relay");
          }
        },
        (error: unknown) => {
          assert.equal(error instanceof FabricContractError, true, String(error));
          return true;
        },
      );
      assert.equal(chain.harness.source.callCount, callsBefore, `${fence} let a relayed commit reach the Endpoint`);
      observed.push(fence);
    } finally {
      await chain.close();
      await rm(root, { recursive: true, force: true });
    }
  }
  assert.deepEqual(observed, ["restart", "pair-rotation", "workspace-generation", "route-close"]);
});

// ---------------------------------------------------------------------------
// Chain 4: artifact stream over the Edge/WSS path, interrupted, resumed on an
// explicit NEW route with unchanged content, digest verified
// ---------------------------------------------------------------------------

const nodeDigest: FabricArtifactDigest = {
  create: () => {
    const hash = createHash("sha256");
    return { update: (bytes: Uint8Array) => { hash.update(bytes); }, digestHex: () => hash.digest("hex") };
  },
  of: (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex"),
};

function acknowledgeFrame(frame: FabricStreamFrameV1, offset = 0): FabricStreamFrameV1 {
  return {
    version: frame.version, streamId: frame.streamId, routeId: frame.routeId, operationId: frame.operationId,
    sequence: frame.sequence, kind: "ack", sentAt: Date.now(), payload: { offset },
  };
}

/** One artifact chunk on the wire, in the exact shape `FabricArtifactSender` emits. */
function artifactChunkFrame(input: {
  manifest: FabricArtifactManifestV1;
  routeId: string;
  streamId: string;
  operationId: string;
  sequence: number;
  offset: number;
  bytes: Uint8Array;
  totalBytes: number;
}): FabricStreamFrameV1 {
  return {
    version: "fabric.stream.v1",
    streamId: input.streamId,
    routeId: input.routeId,
    operationId: input.operationId,
    sequence: input.sequence,
    kind: "data",
    sentAt: Date.now(),
    payload: {
      version: FABRIC_ARTIFACT_VERSION,
      artifactId: input.manifest.artifactId,
      offset: input.offset,
      byteLength: input.bytes.byteLength,
      digest: nodeDigest.of(input.bytes),
      encodedData: Buffer.from(input.bytes).toString("base64"),
      final: input.offset + input.bytes.byteLength >= input.totalBytes,
    },
  };
}

interface ChainFourSession {
  socket: WebSocket;
  closed: Promise<number>;
  send(frame: unknown): void;
  next(): Promise<{ kind: "frame"; frame: Record<string, unknown> } | { kind: "error"; code: string; message: string } | { kind: "closed" }>;
}

/** One real TLS WSS session to the Edge's direct route listener. */
async function chainFourSession(port: number, ca: Buffer, ticket: unknown): Promise<ChainFourSession> {
  const socket = new WebSocket(`wss://localhost:${port}${FABRIC_DIRECT_ROUTE_PATH}`, { ca });
  const received: Record<string, unknown>[] = [];
  const waiters: Array<() => void> = [];
  const wake = (): void => { for (const waiter of waiters.splice(0)) waiter(); };
  socket.on("message", (data) => {
    received.push(JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data)) as Record<string, unknown>);
    wake();
  });
  const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
  let cursor = 0;
  await new Promise<void>((resolve) => socket.on("open", () => resolve()));
  socket.send(JSON.stringify({
    version: FABRIC_PROTOCOL_VERSION, messageId: "m-route-open", kind: "route_open", sentAt: Date.now(), payload: { ticket },
  }));
  const opened = await new Promise<{ kind: "frame" } | { kind: "error"; code: string; message: string } | { kind: "closed" }>((resolve) => {
    const inspect = (): void => {
      while (cursor < received.length) {
        const envelope = received[cursor++]!;
        if (envelope.kind === "route_open") return resolve({ kind: "frame" });
        if (envelope.kind === "error") {
          const payload = envelope.payload as Record<string, unknown>;
          return resolve({ kind: "error", code: String(payload.code), message: String(payload.message) });
        }
      }
      waiters.push(inspect);
      void closed.then(() => resolve({ kind: "closed" }));
    };
    inspect();
  });
  if (opened.kind !== "frame") {
    socket.close();
    await closed;
    throw new FabricContractError("permission_denied", `direct route refused: ${opened.kind === "error" ? `${opened.code}: ${opened.message}` : "closed"}`);
  }
  return {
    socket,
    closed,
    send: (frame) => socket.send(JSON.stringify({
      version: FABRIC_PROTOCOL_VERSION, messageId: `m-stream-${Math.random().toString(36).slice(2)}`,
      kind: "stream", sentAt: Date.now(), payload: frame,
    })),
    next: async () => {
      for (;;) {
        while (cursor < received.length) {
          const envelope = received[cursor++]!;
          if (envelope.kind === "stream") return { kind: "frame" as const, frame: envelope.payload as Record<string, unknown> };
          if (envelope.kind === "error") {
            const payload = envelope.payload as Record<string, unknown>;
            return { kind: "error" as const, code: String(payload.code), message: String(payload.message) };
          }
        }
        const outcome = await Promise.race([new Promise<void>((resolve) => waiters.push(resolve)), closed.then(() => "closed" as const)]);
        if (outcome === "closed" && cursor >= received.length) return { kind: "closed" as const };
      }
    },
  };
}

interface ChainFourEnvironment {
  root: string;
  harness: ChainOneHarness;
  certificate: Buffer;
  service: FabricArtifactService;
  manifest: FabricArtifactManifestV1;
  content: Buffer;
  bindingId: string;
  port: number;
  edge: FabricEdgeRuntime;
  keyrings: { edge: FabricRouteTicketKeyringStore; path: FabricRouteTicketKeyringStore };
  openRoute(): Promise<EndpointRouteHandle>;
  ticketFor(routeId: string): unknown;
  verifyTicket(routeId: string, ticket: unknown): Promise<void>;
  receiver: FabricArtifactReceiver;
  acceptedOffsets: number[];
  lastChunkDigest: string | undefined;
  interruptAfter(): number;
  setInterruptAfter(value: number): void;
  setRouteAuthority(authority: { validateRoute(routeId: string): EndpointRouteHandle }): void;
  routeAuthority(): { validateRoute(routeId: string): EndpointRouteHandle };
  /** Rotate the Edge's ticket authority: the path listener keeps the old key. */
  rotateEdgeKeyring(): void;
  close(): Promise<void>;
}

async function chainFourEnvironment(root: string): Promise<ChainFourEnvironment> {
  const harness = await chainOneHarness(root);
  const sourceRoot = join(root, "artifacts");
  await mkdir(sourceRoot, { recursive: true });
  const content = Buffer.alloc(32 * 1024 * 5 + 100);
  for (let index = 0; index < content.byteLength; index += 1) content[index] = (index * 7) % 251;
  await writeFile(join(sourceRoot, "payload.bin"), content);
  const service = new FabricArtifactService({
    source: new FabricArtifactSource({ root: sourceRoot }),
    entries: [{ artifactId: "artifact-a", path: "payload.bin" }],
  });
  const manifest = await service.manifest("artifact-a");
  assert.equal(manifest.byteLength, content.byteLength);
  assert.equal(manifest.digest, nodeDigest.of(content));

  const certificate = await readFile(certificatePath);
  const key = await readFile(keyPath);
  const owner = createGatewayPrincipal("stdio", "owner", { authenticated: true, workspaceId: harness.workspaceId });
  const binding = resultData(await harness.runtime.call("workspace", control("bind", {
    deviceId: "device-1", connectionId: harness.connectionId, workspaceId: "fabric-workspace-1",
    expectedConnectionGeneration: harness.connectionGeneration, expectedWorkspaceGeneration: 1, requestedTtlMs: 60_000,
  }), owner)).binding as { bindingId: string };
  const openRoute = async (): Promise<EndpointRouteHandle> => resultData(await harness.runtime.call("route", control("open", {
    connectionId: harness.connectionId, workspaceBindingId: binding.bindingId, endpointId: "endpoint-1",
    expectedConnectionGeneration: harness.connectionGeneration, expectedWorkspaceGeneration: 1,
    expectedEndpointGeneration: 1, requestedTtlMs: 45_000, operationClass: "artifact-read",
    pathCandidates: ["lan-direct"],
  }), owner)).route as EndpointRouteHandle;

  const pathKeyring = new FabricRouteTicketKeyringStore({ activeKeyId: "key-1", secrets: { "key-1": "artifact-e2e-secret-0001" } });
  const edgeKeyring = new FabricRouteTicketKeyringStore({ activeKeyId: "key-1", secrets: { "key-1": "artifact-e2e-secret-0001" } });
  const edgeTickets = new FabricRouteTicketSecurity({ keyring: edgeKeyring });
  const edgeConfig = parseFabricEdgeConfig({
    version: FABRIC_EDGE_CONFIG_VERSION, enabled: true, connectorId: "connector-1", audience: EDGE_AUDIENCE,
    pathCandidates: ["lan-direct"], devices: [{ deviceId: "device-1" }],
    endpoints: [{ endpointId: "endpoint-1", deviceId: "device-1", operationClasses: ["artifact-read"] }],
    workspaces: [{
      workspaceBindingId: binding.bindingId, deviceId: "device-1",
      workspaceId: "fabric-workspace-1", localWorkspacePath: root,
    }],
    health: { intervalMs: 1_000, timeoutMs: 5_000 }, ticketTtlMs: 30_000, revision: 1,
  });
  const edge = new FabricEdgeRuntime({
    config: edgeConfig, tickets: edgeTickets, routes: harness.admissions, admissions: harness.admissions,
    confirmWithHub: { confirm: async (ticket, expectation) => new FabricRouteTicketSecurity({ keyring: edgeKeyring }).verify(ticket, expectation) },
  });
  edge.recordPresence({ kind: "endpoint", deviceId: "device-1", endpointId: "endpoint-1" }, 1, true);

  const receiver = new FabricArtifactReceiver(manifest, nodeDigest);
  const acceptedOffsets: number[] = [];
  const state: {
    lastChunkDigest: string | undefined;
    interruptAfter: number;
    authority: { validateRoute(routeId: string): EndpointRouteHandle };
    issuer?: FabricRouteTicketSecurity;
  } = { lastChunkDigest: undefined, interruptAfter: 2, authority: harness.admissions };
  const listener = createHttpsServer({ cert: certificate, key });
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "localhost", resolve); });
  const address = listener.address();
  assert(address && typeof address !== "string");
  const server = new FabricDirectRouteServer({
    server: listener,
    tickets: new FabricRouteTicketSecurity({ keyring: pathKeyring }),
    routes: { validateRoute: (routeId) => state.authority.validateRoute(routeId) },
    audience: EDGE_AUDIENCE,
    subjects: ["subject-1"],
    // One chunk frame is well under the core stream-frame payload bound while
    // still being several frames long, which is what a resume needs.
    limits: { heartbeatIntervalMs: 50, heartbeatTimeoutMs: 5_000, maxFrameBytes: 256 * 1024 },
    drainTimeoutMs: 200,
    handleStream: (_session, frame: FabricStreamFrameV1) => {
      if (frame.kind === "data") {
        if (acceptedOffsets.length >= state.interruptAfter) {
          // A real interruption: the path fails after the accepted chunks.
          throw new FabricContractError("unavailable", "the artifact path failed mid-transfer");
        }
        const payload = frame.payload as { offset?: unknown; digest?: unknown };
        const offset = receiver.accept(payload, frame.routeId);
        state.lastChunkDigest = String(payload.digest);
        acceptedOffsets.push(Number(payload.offset));
        return acknowledgeFrame(frame, offset);
      }
      if (frame.kind === "end") {
        receiver.finish();
        return acknowledgeFrame(frame, receiver.receivedBytes);
      }
      return acknowledgeFrame(frame);
    },
  });
  server.start();
  const close = async (): Promise<void> => {
    await server.close("test complete");
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await harness.close();
    await rm(root, { recursive: true, force: true });
  };

  return {
    root, harness, certificate, service, manifest, content, bindingId: binding.bindingId, port: address.port,
    edge,
    keyrings: { edge: edgeKeyring, path: pathKeyring },
    openRoute,
    ticketFor: (routeId) => {
      const issued = edge.issueRouteTicket({ routeId, subject: "subject-1" });
      // A rotated authority re-signs the same claims under its own key.
      return state.issuer === undefined ? issued : state.issuer.issue({
        subject: issued.claims.subject, audience: issued.claims.audience, routeId: issued.claims.routeId,
        deviceId: issued.claims.deviceId, endpointId: issued.claims.endpointId,
        ...(issued.claims.workspaceBindingId === undefined ? {} : { workspaceBindingId: issued.claims.workspaceBindingId }),
        connectionGeneration: issued.claims.connectionGeneration,
        ...(issued.claims.workspaceGeneration === undefined ? {} : { workspaceGeneration: issued.claims.workspaceGeneration }),
        endpointGeneration: issued.claims.endpointGeneration,
        operationClasses: issued.claims.operationClasses, ttlMs: 30_000,
      });
    },
    verifyTicket: async (routeId, ticket) => {
      await edge.validateRouteTicketOnline(ticket, {
        subjects: ["subject-1"], audience: EDGE_AUDIENCE, routeId, deviceId: "device-1",
        endpointId: "endpoint-1", connectionGeneration: harness.connectionGeneration, endpointGeneration: 1,
        operationClass: "artifact-read", workspaceBindingId: binding.bindingId, workspaceGeneration: 1,
      });
    },
    receiver,
    acceptedOffsets,
    get lastChunkDigest() { return state.lastChunkDigest; },
    interruptAfter: () => state.interruptAfter,
    setInterruptAfter: (value) => { state.interruptAfter = value; },
    setRouteAuthority: (authority) => { state.authority = authority; },
    routeAuthority: () => state.authority,
    rotateEdgeKeyring: () => {
      state.issuer = new FabricRouteTicketSecurity({
        keyring: new FabricRouteTicketKeyringStore({
          activeKeyId: "key-2", secrets: { "key-1": "artifact-e2e-secret-0001", "key-2": "artifact-e2e-secret-0002" },
        }),
      });
    },
    close,
  };
}

/**
 * Send the chunks the receiver still needs, in the exact wire shape
 * `FabricArtifactSender` emits, and report the offset the Endpoint acknowledged.
 *
 * The real sender stamps every chunk at `FABRIC_ARTIFACT_CHUNK_BYTES`, which the
 * core stream-frame payload bound rejects (asserted in the first chain-4 test),
 * so a framed transfer has to use smaller chunks. Everything else here is real:
 * the bytes come from the real artifact service, the frames are validated by the
 * real receiver, and they travel over the real TLS WSS path.
 */
async function sendRemainingChunks(environment: ChainFourEnvironment, session: ChainFourSession, routeId: string): Promise<number> {
  let position = environment.receiver.receivedBytes;
  let sequence = 1;
  while (position < environment.manifest.byteLength) {
    const byteLength = Math.min(32 * 1024, environment.manifest.byteLength - position);
    const bytes = await environment.service.readChunk("artifact-a", position, byteLength);
    session.send(artifactChunkFrame({
      manifest: environment.manifest, routeId, streamId: `stream-${routeId}`, operationId: `operation-${routeId}`,
      sequence: sequence++, offset: position, bytes, totalBytes: environment.manifest.byteLength,
    }));
    const answer = await session.next();
    if (answer.kind !== "frame") {
      throw new FabricContractError("unavailable", `the artifact path refused the chunk (${answer.kind === "error" ? answer.message : "closed"})`);
    }
    if (answer.frame.kind !== "ack") throw new FabricContractError("protocol_violation", "the artifact path did not acknowledge the chunk");
    position = Number((answer.frame.payload as { offset?: unknown }).offset);
  }
  session.send({
    version: "fabric.stream.v1", streamId: `stream-${routeId}`, routeId, operationId: `operation-${routeId}`,
    sequence: sequence++, kind: "end", sentAt: Date.now(),
    payload: { artifactId: environment.manifest.artifactId, byteLength: position, digest: environment.manifest.digest },
  });
  const final = await session.next();
  if (final.kind !== "frame") {
    throw new FabricContractError("unavailable", `the artifact path refused the end frame (${final.kind === "error" ? final.message : "closed"})`);
  }
  return position;
}

test("chain 4 shows the Edge/WSS path refusing a full-size chunk, and the real sender never reporting complete", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fabric-e2e-chain4-bound-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = await chainFourEnvironment(root);
  t.after(() => environment.close());
  // A source one byte past a chunk boundary makes the real sender emit a full
  // `FABRIC_ARTIFACT_CHUNK_BYTES` chunk first.
  const sourceRoot = join(root, "full-chunks");
  await mkdir(sourceRoot, { recursive: true });
  const content = Buffer.alloc(FABRIC_ARTIFACT_CHUNK_BYTES + 100, 7);
  await writeFile(join(sourceRoot, "big.bin"), content);
  const service = new FabricArtifactService({
    source: new FabricArtifactSource({ root: sourceRoot }),
    entries: [{ artifactId: "artifact-big", path: "big.bin" }],
  });
  const manifest = await service.manifest("artifact-big");
  const receiver = new FabricArtifactReceiver(manifest, nodeDigest);

  const route = await environment.openRoute();
  const ticket = environment.ticketFor(route.routeId);
  await environment.verifyTicket(route.routeId, ticket);
  const session = await chainFourSession(environment.port, environment.certificate, ticket);

  const sender = new FabricArtifactSender({
    manifest,
    digest: nodeDigest,
    read: async (offset, byteLength) => service.readChunk("artifact-big", offset, byteLength),
    channel: {
      routeId: route.routeId,
      streamId: "stream-full",
      operationId: "operation-full",
      send: async (frame) => { session.send(frame); },
      receive: async (): Promise<FabricStreamFrameV1 | undefined> => {
        const next = await session.next();
        if (next.kind === "closed") return undefined;
        if (next.kind === "error") throw new FabricContractError("unavailable", next.message);
        return next.frame as unknown as FabricStreamFrameV1;
      },
    },
  });
  const failure = await sender.start().then(() => undefined, (error: unknown) => error);
  assert.ok(failure instanceof FabricContractError, `expected a Fabric refusal, saw ${String(failure)}`);
  // The path refuses the encoded chunk: it is larger than the core stream-frame
  // payload bound. The transfer is partial, never complete, and the Endpoint
  // accepted nothing it would have to discard.
  assert.equal(sender.state, "partial");
  assert.notEqual(sender.state, "complete");
  assert.equal(receiver.state, "available");
  assert.equal(receiver.receivedBytes, 0);
  assert.equal(receiver.finish(), "partial", "an artifact the Endpoint never received cannot report complete");

  // The receiver's own bound is independent of the wire: a non-final chunk that
  // is not a full chunk is refused, so the two sides cannot agree on a smaller
  // chunk size to work around the path's refusal.
  assert.throws(
    () => receiver.accept({
      version: FABRIC_ARTIFACT_VERSION, artifactId: manifest.artifactId, offset: 0, byteLength: 1_024,
      digest: nodeDigest.of(content.subarray(0, 1_024)),
      encodedData: Buffer.from(content.subarray(0, 1_024)).toString("base64"), final: false,
    }, route.routeId),
    /must be a full chunk/,
  );
});

// ---------------------------------------------------------------------------
// Chain 4 continued: the closest real integration.
//
// No transport in the tree can carry a legal artifact chunk (the first test
// above proves both bounds), so the transfer runs over an explicit loopback
// channel. Everything else is real: the sender, the receiver, the artifact
// service reading a real file, the admitted routes, and the route-ticket
// admission that authorizes each leg.
// ---------------------------------------------------------------------------

interface ChainFourChannelOptions {
  routeId: string;
  authority: () => { validateRoute(routeId: string): EndpointRouteHandle };
  ticket: unknown;
  verifier: FabricRouteTicketSecurity;
  expectation: FabricRouteTicketExpectation;
  receiver: FabricArtifactReceiver;
  failAfterDataFrames?: number;
}

/**
 * A channel whose every frame is admitted against the current route and the
 * route's ticket before it moves, exactly as the real transports do.
 */
function artifactChannel(options: ChainFourChannelOptions): { channel: FabricStreamChannel; dataFrames(): number } {
  options.verifier.verify(options.ticket, options.expectation);
  const toSender: FabricStreamFrameV1[] = [];
  let sequence = 0;
  let dataFrames = 0;
  let open = true;
  const frame = (kind: FabricStreamFrameV1["kind"], payload: Readonly<Record<string, JsonValue>>): FabricStreamFrameV1 => ({
    version: "fabric.stream.v1",
    streamId: `stream-${options.routeId}`,
    routeId: options.routeId,
    operationId: `operation-${options.routeId}`,
    sequence: (sequence += 1),
    kind,
    sentAt: Date.now(),
    payload,
  });
  const channel: FabricStreamChannel = {
    streamId: `stream-${options.routeId}`,
    routeId: options.routeId,
    operationId: `operation-${options.routeId}`,
    async send(incoming: FabricStreamFrameV1): Promise<void> {
      // The route is revalidated on every frame: a closed route, a stale
      // workspace generation, or a recovered authority stops the transfer.
      options.authority().validateRoute(options.routeId);
      if (!open) throw new FabricContractError("unavailable", "the artifact channel closed before the transfer finished");
      if (incoming.kind === "data") {
        if (options.failAfterDataFrames !== undefined && dataFrames >= options.failAfterDataFrames) {
          open = false;
          throw new FabricContractError("unavailable", "the artifact channel dropped mid-transfer");
        }
        dataFrames += 1;
        const payload = incoming.payload as Record<string, JsonValue>;
        const acknowledged = options.receiver.accept({
          version: payload.version, artifactId: payload.artifactId, offset: payload.offset,
          byteLength: payload.byteLength, digest: payload.digest, encodedData: payload.encodedData, final: payload.final,
        }, options.routeId);
        toSender.push(frame("ack", { offset: acknowledged }));
        return;
      }
      if (incoming.kind === "end") options.receiver.finish();
      if (incoming.kind === "cancel") await options.receiver.cancel();
    },
    async receive(): Promise<FabricStreamFrameV1 | undefined> {
      if (!open) return undefined;
      return toSender.shift();
    },
    async close(): Promise<void> { open = true; },
  };
  return { channel, dataFrames: () => dataFrames };
}

interface ChainFourReport {
  senderState: string;
  receiverStateBeforeResume: string;
  resumeRefused?: string;
  receiverStateAfterResume: string;
  completed: boolean;
  digestMatches: boolean;
  bytesMatch: boolean;
  interruptedBytes: number;
  totalBytes: number;
}

async function chainFourRun(fence: CommitFence): Promise<ChainFourReport> {
  const root = await mkdtemp(join(tmpdir(), `fabric-e2e-chain4-${fence}-`));
  const environment = await chainFourEnvironment(root);
  try {
    // Four full chunks and a remainder, so an interrupted transfer still has
    // both a full and a final chunk left to resume with.
    const sourceRoot = join(root, "resume");
    await mkdir(sourceRoot, { recursive: true });
    const content = Buffer.alloc(FABRIC_ARTIFACT_CHUNK_BYTES * 4 + 37);
    for (let index = 0; index < content.byteLength; index += 1) content[index] = (index * 11) % 249;
    await writeFile(join(sourceRoot, "resume.bin"), content);
    const service = new FabricArtifactService({
      source: new FabricArtifactSource({ root: sourceRoot }),
      entries: [{ artifactId: "artifact-resume", path: "resume.bin" }],
    });
    const manifest = await service.manifest("artifact-resume");
    const receiver = new FabricArtifactReceiver(manifest, nodeDigest);
    const expectationOf = (routeId: string): FabricRouteTicketExpectation => ({
      subjects: ["subject-1"], audience: EDGE_AUDIENCE, routeId, deviceId: "device-1",
      endpointId: "endpoint-1", connectionGeneration: environment.harness.connectionGeneration,
      endpointGeneration: 1, operationClass: "artifact-read",
      workspaceBindingId: environment.bindingId, workspaceGeneration: 1,
    });

    // The interrupted transfer, over the real artifact service and sender.
    const firstRoute = await environment.openRoute();
    const firstTicket = environment.ticketFor(firstRoute.routeId);
    await environment.verifyTicket(firstRoute.routeId, firstTicket);
    const firstChannel = artifactChannel({
      routeId: firstRoute.routeId, authority: () => environment.harness.admissions,
      ticket: firstTicket, verifier: new FabricRouteTicketSecurity({ keyring: environment.keyrings.path }),
      expectation: expectationOf(firstRoute.routeId), receiver, failAfterDataFrames: 2,
    });
    const sender = new FabricArtifactSender({
      manifest, digest: nodeDigest, channel: firstChannel.channel,
      read: async (offset, byteLength) => service.readChunk("artifact-resume", offset, byteLength),
    });
    await assert.rejects(() => sender.start(), FabricContractError);
    // An interrupted transfer is partial: it never reports complete.
    assert.equal(sender.state, "partial");
    assert.notEqual(sender.state, "complete");
    assert.notEqual(receiver.state, "complete");
    const interruptedBytes = receiver.receivedBytes;
    assert.equal(interruptedBytes, FABRIC_ARTIFACT_CHUNK_BYTES * 2);
    assert.ok(interruptedBytes < manifest.byteLength);
    const stateAfterInterruption = receiver.state;
    assert.equal(stateAfterInterruption, "transferring");
    assert.equal(receiver.finish(), "partial", "an interrupted transfer cannot complete");

    // An explicit NEW route is required, on unchanged content.
    assert.throws(
      () => receiver.resume({
        artifactId: manifest.artifactId, contentIdentity: manifest.contentIdentity,
        offset: receiver.receivedBytes, chunkDigest: nodeDigest.of(content.subarray(interruptedBytes - FABRIC_ARTIFACT_CHUNK_BYTES, interruptedBytes)),
        routeId: firstRoute.routeId,
      }),
      /requires a new route/,
    );
    assert.throws(
      () => receiver.resume({
        artifactId: manifest.artifactId, contentIdentity: `${manifest.contentIdentity}-changed`,
        offset: receiver.receivedBytes, chunkDigest: "ignored", routeId: "route-elsewhere",
      }),
      /content identity changed/,
    );

    const secondRoute = await environment.openRoute();
    const stateBeforeResume = stateAfterInterruption;
    let resumeRefused: string | undefined;
    let digestMatches = false;
    let bytesMatch = false;

    switch (fence) {
      case "none": break;
      case "restart": {
        await recordRunningInvocation(environment.harness.store, "operation-inflight");
        await recoverGatewayFabric({
          store: environment.harness.store,
          eventAdapter: new GatewayFabricEventAdapter({ store: environment.harness.store, journal: new GatewayEventJournal() }),
        });
        await environment.harness.stopServing();
        const rebuilt = new FabricAdmissionManager(
          environment.harness.directory, environment.harness.connections, { coordinator: environment.harness.coordinator },
        );
        assert.equal((await rebuilt.getRouteDurable(secondRoute.routeId))?.state, "closed");
        environment.setRouteAuthority(rebuilt);
        break;
      }
      case "pair-rotation": {
        // The Edge rotates its ticket key; the path listener holds only the
        // retired one, so the resumed leg has no admission to ride on.
        environment.rotateEdgeKeyring();
        const rotatedTicket = environment.ticketFor(secondRoute.routeId) as { claims: { keyId: string } };
        assert.equal(rotatedTicket.claims.keyId, "key-2");
        break;
      }
      case "workspace-generation": {
        environment.harness.advertise(2);
        break;
      }
      case "route-close": {
        const closed = await environment.harness.admissions.closeRoute(secondRoute.routeId, secondRoute.revision);
        assert.equal(closed.state, "closed");
        break;
      }
      default: throw new Error("unexpected fence");
    }

    if (resumeRefused === undefined) {
      const lastDigest = nodeDigest.of(content.subarray(interruptedBytes - FABRIC_ARTIFACT_CHUNK_BYTES, interruptedBytes));
      receiver.resume({
        artifactId: manifest.artifactId, contentIdentity: manifest.contentIdentity,
        offset: receiver.receivedBytes, chunkDigest: lastDigest, routeId: secondRoute.routeId,
      });
      try {
        const secondTicket = environment.ticketFor(secondRoute.routeId);
        await environment.verifyTicket(secondRoute.routeId, secondTicket);
        const secondChannel = artifactChannel({
          routeId: secondRoute.routeId, authority: environment.routeAuthority,
          ticket: secondTicket, verifier: new FabricRouteTicketSecurity({ keyring: environment.keyrings.path }),
          expectation: expectationOf(secondRoute.routeId), receiver,
        });
        let position = receiver.receivedBytes;
        while (position < manifest.byteLength) {
          const byteLength = Math.min(FABRIC_ARTIFACT_CHUNK_BYTES, manifest.byteLength - position);
          const bytes = await service.readChunk("artifact-resume", position, byteLength);
          await secondChannel.channel.send(artifactChunkFrame({
            manifest, routeId: secondRoute.routeId, streamId: `stream-${secondRoute.routeId}`,
            operationId: `operation-${secondRoute.routeId}`, sequence: position + 1, offset: position,
            bytes, totalBytes: manifest.byteLength,
          }));
          const answer = await secondChannel.channel.receive({ aborted: false });
          if (answer === undefined || answer.kind !== "ack") {
            throw new FabricContractError("unavailable", "the resumed path did not acknowledge the chunk");
          }
          position = Number((answer.payload as { offset?: number }).offset);
        }
        await secondChannel.channel.send({
          version: "fabric.stream.v1", streamId: `stream-${secondRoute.routeId}`, routeId: secondRoute.routeId,
          operationId: `operation-${secondRoute.routeId}`, sequence: manifest.byteLength + 1, kind: "end",
          sentAt: Date.now(),
          payload: { artifactId: manifest.artifactId, byteLength: position, digest: manifest.digest },
        });
      } catch (error) {
        resumeRefused = error instanceof Error ? error.message : String(error);
      }
      const collected = receiver.collected();
      digestMatches = nodeDigest.of(collected) === manifest.digest;
      bytesMatch = Buffer.compare(Buffer.from(collected), content) === 0;
    }

    const completed = receiver.finish() === "complete";
    return {
      senderState: sender.state,
      receiverStateBeforeResume: stateBeforeResume,
      ...(resumeRefused === undefined ? {} : { resumeRefused }),
      receiverStateAfterResume: receiver.state,
      completed,
      digestMatches,
      bytesMatch,
      interruptedBytes,
      totalBytes: manifest.byteLength,
    };
  } finally {
    await environment.close();
  }
}

test("chain 4 interrupts an artifact stream and resumes it on a new route with the same content and digest", async () => {
  const report = await chainFourRun("none");
  assert.equal(report.senderState, "partial", "an interrupted transfer must never report complete");
  assert.equal(report.receiverStateBeforeResume, "transferring");
  assert.equal(report.resumeRefused, undefined);
  assert.equal(report.receiverStateAfterResume, "complete");
  assert.equal(report.completed, true);
  assert.equal(report.digestMatches, true, "the resumed transfer must reproduce the source digest");
  assert.equal(report.bytesMatch, true, "the resumed bytes must be the source bytes");
  assert.ok(report.interruptedBytes > 0 && report.interruptedBytes < report.totalBytes);
});

test("chain 4 fences a resumed artifact commit on restart, rotation, generation change, and route close", async () => {
  const observed: string[] = [];
  for (const fence of COMMIT_FENCES.filter((entry) => entry !== "none")) {
    const report = await chainFourRun(fence);
    // Whatever the fence, the resumed transfer never reports complete and never
    // verifies a digest it did not receive.
    assert.equal(report.completed, false, `${fence} let the resumed transfer report complete`);
    assert.notEqual(report.receiverStateAfterResume, "complete");
    assert.equal(report.digestMatches, false, `${fence} verified a digest that never arrived`);
    assert.equal(report.bytesMatch, false);
    observed.push(fence);
  }
  assert.deepEqual(observed, ["restart", "pair-rotation", "workspace-generation", "route-close"]);
});
