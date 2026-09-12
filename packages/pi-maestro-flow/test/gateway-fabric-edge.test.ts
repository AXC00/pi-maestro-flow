import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import {
  FABRIC_PROTOCOL_VERSION,
  FABRIC_STREAM_VERSION,
  FabricContractError,
  type EndpointRouteHandle,
  type FabricConnectRequest,
  type FabricLiveConnection,
  type FabricProtocolLimits,
  type FabricStreamFrameV1,
} from "pi-maestro-fabric-core/v1";
import {
  FabricAdmissionManager,
  FabricConnectionManager,
  FabricDirectory,
  TransportRegistry,
} from "pi-maestro-fabric";
import {
  FABRIC_EDGE_CONFIG_VERSION,
  parseFabricEdgeConfig,
  requireAllowedEdgeDevice,
  requireAllowedEdgeEndpoint,
  requireAllowedEdgeWorkspace,
  type FabricEdgeConfigV1,
} from "../src/gateway/fabric/edge-config.ts";
import { FabricEdgeRuntime } from "../src/gateway/fabric/edge-runtime.ts";
import {
  FabricRouteTicketKeyringStore,
  FabricRouteTicketSecurity,
  type FabricRouteTicketExpectation,
} from "../src/gateway/fabric/route-ticket.ts";
import { FABRIC_DIRECT_ROUTE_PATH, FabricDirectRouteServer } from "../src/gateway/fabric/direct-route-server.ts";

const AUDIENCE = "edge.example.test";
const SECRET = "edge-route-ticket-secret-0001";
const CONNECTOR = "connector-a";
const DEVICE = "device-a";
const ENDPOINT = "endpoint-a";
const ROUTE = "route-a";
const SUBJECT = "subject-a";

const certificatePath = join(import.meta.dirname, "fixtures", "fabric-test-cert.pem");
const keyPath = join(import.meta.dirname, "fixtures", "fabric-test-key.pem");

const PROTOCOL_LIMITS: FabricProtocolLimits = Object.freeze({
  maxFrameBytes: 64 * 1024,
  maxInFlightOperations: 8,
  heartbeatIntervalMs: 1_000,
  heartbeatTimeoutMs: 5_000,
  maxAdvertisementItems: 64,
  maxResultBytes: 64 * 1024,
});

function expectCode(error: unknown, code: FabricContractError["code"]): boolean {
  return error instanceof FabricContractError && error.code === code;
}

function deviceRecord(): {
  deviceId: string;
  connectorId: string;
  label: string;
  connectionMode: "ssh";
  enabled: boolean;
  revision: number;
} {
  return { deviceId: DEVICE, connectorId: CONNECTOR, label: "Device A", connectionMode: "ssh", enabled: true, revision: 1 };
}

function edgeDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: FABRIC_EDGE_CONFIG_VERSION,
    enabled: true,
    connectorId: CONNECTOR,
    audience: AUDIENCE,
    pathCandidates: ["lan-direct", "edge-relay"],
    devices: [{ deviceId: DEVICE }],
    endpoints: [{ endpointId: ENDPOINT, deviceId: DEVICE, operationClasses: ["mcp-read", "mcp-mutation"] }],
    workspaces: [{
      workspaceBindingId: "binding-a",
      deviceId: DEVICE,
      workspaceId: "workspace-a",
      localWorkspacePath: join(tmpdir(), "workspace-a"),
    }],
    health: { intervalMs: 1_000, timeoutMs: 5_000 },
    ticketTtlMs: 30_000,
    revision: 1,
    ...overrides,
  };
}

interface EdgeFixture {
  now: { value: number };
  directory: FabricDirectory;
  connections: FabricConnectionManager;
  admissions: FabricAdmissionManager;
  config: FabricEdgeConfigV1;
  tickets: FabricRouteTicketSecurity;
  edge: FabricEdgeRuntime;
  route: EndpointRouteHandle;
  confirmations: { count: number };
}

/**
 * A real route authority: a directory, an admitted connection with an accepted
 * advertisement, and the admission manager that owns route generations.
 */
async function fixture(): Promise<EdgeFixture> {
  const now = { value: Date.now() };
  const directory = new FabricDirectory();
  directory.seedAuthority({
    connector: {
      connectorId: CONNECTOR,
      label: "Connector A",
      transport: "ssh",
      credentialGeneration: 1,
      instanceNonce: "nonce-a",
      enabled: true,
      revision: 1,
    },
    devices: [deviceRecord()],
  });
  const transports = new TransportRegistry();
  transports.register({
    kind: "ssh",
    connect: async (request: FabricConnectRequest): Promise<FabricLiveConnection> => ({
      descriptor: {
        protocolVersion: FABRIC_PROTOCOL_VERSION,
        limits: PROTOCOL_LIMITS,
        lease: {
          connectionId: "connection-a",
          deviceId: request.deviceId,
          connectorId: request.connectorId,
          connectorInstanceNonce: "nonce-a",
          generation: 1,
          state: "connected",
          capabilityDigest: "digest-edge",
          establishedAt: now.value,
          expiresAt: now.value + 3_600_000,
          revision: 0,
        },
      },
      exchange: async (envelope) => envelope,
      close: async () => undefined,
    }),
  });
  const connections = new FabricConnectionManager(directory, transports, { now: () => now.value });
  const connected = await connections.connect({
    requestId: "connect-a",
    deviceId: DEVICE,
    connectorId: CONNECTOR,
    expectedCredentialGeneration: 1,
    deadlineAt: now.value + 60_000,
    limits: PROTOCOL_LIMITS,
  }, new AbortController().signal);
  connections.acceptAdvertisement({
    connectionId: connected.connectionId,
    connectionGeneration: connected.generation,
    capabilityDigest: "digest-edge",
    advertisementRevision: 1,
    devices: [deviceRecord()],
    workspaces: [],
    endpoints: [{
      endpointId: ENDPOINT,
      deviceId: DEVICE,
      connectorId: CONNECTOR,
      scope: { kind: "device" },
      generation: 1,
      contractHash: "contract-a",
      status: "online",
      revision: 1,
      kind: "mcp",
      serverName: "remote-a",
      protocolVersion: "2025-06-18",
      transport: "edge-relay",
      durableDeduplication: true,
    }],
    capabilities: [],
  });
  const admissions = new FabricAdmissionManager(directory, connections, { now: () => now.value });
  const route: EndpointRouteHandle = {
    routeId: ROUTE,
    connectionId: connected.connectionId,
    endpointId: ENDPOINT,
    connectionGeneration: connected.generation,
    endpointGeneration: 1,
    issuedAt: now.value,
    expiresAt: now.value + 3_600_000,
    state: "open",
    revision: 0,
    deviceId: DEVICE,
    operationClass: "mcp-read",
    pathCandidates: ["lan-direct", "edge-relay"],
    selectedPath: "lan-direct",
  };
  admissions.openRoute(route);

  const config = parseFabricEdgeConfig(edgeDocument());
  const keyring = new FabricRouteTicketKeyringStore({ activeKeyId: "key-1", secrets: { "key-1": SECRET } });
  const tickets = new FabricRouteTicketSecurity({ keyring, now: () => now.value });
  // The Hub holds the same key id; it is the online authority the Edge asks.
  const hubTickets = new FabricRouteTicketSecurity({ keyring, now: () => now.value });
  const confirmations = { count: 0 };
  const edge = new FabricEdgeRuntime({
    config,
    tickets,
    routes: admissions,
    admissions,
    now: () => now.value,
    confirmWithHub: {
      confirm: async (ticket, expectation) => {
        confirmations.count += 1;
        return hubTickets.verify(ticket, expectation);
      },
    },
  });
  return { now, directory, connections, admissions, config, tickets, edge, route, confirmations };
}

function expectationFor(overrides: Partial<FabricRouteTicketExpectation> = {}): FabricRouteTicketExpectation {
  return {
    subjects: [SUBJECT],
    audience: AUDIENCE,
    routeId: ROUTE,
    deviceId: DEVICE,
    endpointId: ENDPOINT,
    connectionGeneration: 1,
    endpointGeneration: 1,
    operationClass: "mcp-read",
    ...overrides,
  };
}

async function listen(server: HttpServer | HttpsServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no listener address");
  return address.port;
}

interface DirectClient {
  readonly socket: WebSocket;
  readonly received: Record<string, unknown>[];
  readonly opened: Promise<void>;
  readonly closed: Promise<number>;
  send(envelope: Record<string, unknown>): void;
  waitFor(kind: string): Promise<Record<string, unknown>>;
}

function rawClient(url: string, ca?: Buffer): DirectClient {
  const socket = new WebSocket(url, ca === undefined ? undefined : { ca });
  const received: Record<string, unknown>[] = [];
  const waiters: Array<{ kind: string; resolve: (envelope: Record<string, unknown>) => void }> = [];
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
  return {
    socket,
    received,
    opened: new Promise<void>((resolve) => socket.on("open", () => resolve())),
    closed: new Promise<number>((resolve) => socket.on("close", (code) => resolve(code))),
    send: (envelope) => socket.send(JSON.stringify(envelope)),
    waitFor: (kind) => new Promise((resolve) => {
      const existing = received.find((envelope) => envelope.kind === kind);
      if (existing !== undefined) return resolve(existing);
      waiters.push({ kind, resolve });
    }),
  };
}

function payloadOf(frame: Record<string, unknown>): Record<string, unknown> {
  return frame.payload as Record<string, unknown>;
}

function envelope(kind: string, payload: object, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: FABRIC_PROTOCOL_VERSION,
    messageId: `m-${kind}-${Math.random().toString(36).slice(2)}`,
    kind,
    sentAt: Date.now(),
    payload,
    ...extra,
  };
}

function streamFrame(overrides: Partial<FabricStreamFrameV1> = {}): FabricStreamFrameV1 {
  return {
    version: FABRIC_STREAM_VERSION,
    streamId: "stream-a",
    routeId: ROUTE,
    operationId: "operation-a",
    sequence: 0,
    kind: "open",
    sentAt: Date.now(),
    payload: {},
    ...overrides,
  };
}

test("the Edge allowlist refuses unlisted and foreign targets and has no discovery surface", () => {
  const config = parseFabricEdgeConfig(edgeDocument());
  assert.throws(() => requireAllowedEdgeDevice(config, "device-foreign"), /not on this Edge's allowlist/);
  assert.throws(() => requireAllowedEdgeEndpoint(config, DEVICE, "endpoint-foreign"), /not on this Edge's allowlist/);
  assert.throws(() => requireAllowedEdgeWorkspace(config, DEVICE, "binding-foreign"), /not on this Edge's allowlist/);

  // A target on a Device this Edge does not allow is refused at parse time.
  assert.throws(
    () => parseFabricEdgeConfig(edgeDocument({
      endpoints: [{ endpointId: "endpoint-x", deviceId: "device-foreign", operationClasses: ["mcp-read"] }],
    })),
    /must belong to an allowed Device/,
  );
  assert.throws(
    () => parseFabricEdgeConfig(edgeDocument({
      workspaces: [{
        workspaceBindingId: "binding-x",
        deviceId: "device-foreign",
        workspaceId: "workspace-x",
        localWorkspacePath: join(tmpdir(), "workspace-x"),
      }],
    })),
    /must belong to an allowed Device/,
  );

  // There is no discovery switch to turn on and no wildcard to write.
  assert.throws(() => parseFabricEdgeConfig(edgeDocument({ discovery: true })), /unsupported field/);
  assert.throws(() => parseFabricEdgeConfig(edgeDocument({ devices: "*" })), /must be an explicit list/);
  assert.throws(() => parseFabricEdgeConfig(edgeDocument({ devices: ["device-a"] })), /must be a JSON object/);
  assert.throws(() => parseFabricEdgeConfig(edgeDocument({ version: "fabric.edge-config.v2" })), /Unsupported Fabric Edge config version/);
  assert.throws(() => parseFabricEdgeConfig(edgeDocument({ health: { intervalMs: 5_000, timeoutMs: 5_000 } })), /must exceed/);
  assert.throws(() => parseFabricEdgeConfig(edgeDocument({ ticketTtlMs: 120_000 })), /ticketTtlMs must be between/);
  assert.throws(
    () => parseFabricEdgeConfig(edgeDocument({
      workspaces: [{ workspaceBindingId: "b", deviceId: DEVICE, workspaceId: "w", localWorkspacePath: "relative/path" }],
    })),
    /must be an absolute path/,
  );

  assert.equal(Object.keys(config).some((key) => /discover|scan|mdns|multicast/i.test(key)), false);
  assert.deepEqual(config.health, { intervalMs: 1_000, timeoutMs: 5_000 });

  // An explicitly empty allowlist parses and admits nothing. It is not a default.
  const empty = parseFabricEdgeConfig(edgeDocument({ devices: [], endpoints: [], workspaces: [] }));
  assert.throws(() => requireAllowedEdgeDevice(empty, DEVICE), /not on this Edge's allowlist/);
});

test("Connector presence never implies an Endpoint is online, and presence is generation-bound", async () => {
  const edge = (await fixture()).edge;

  edge.recordPresence({ kind: "connector" }, 1, true);
  assert.equal(edge.presenceOf({ kind: "connector" })?.online, true);
  assert.equal(edge.endpointOnline(DEVICE, ENDPOINT, 1), false, "a live Connector was read as a live Endpoint");
  assert.throws(() => edge.issueRouteTicket({ routeId: ROUTE, subject: SUBJECT }), (error) => expectCode(error, "unavailable"));

  edge.recordPresence({ kind: "endpoint", deviceId: DEVICE, endpointId: ENDPOINT }, 1, true);
  assert.equal(edge.endpointOnline(DEVICE, ENDPOINT, 1), true);
  assert.equal(edge.endpointOnline(DEVICE, ENDPOINT, 2), false, "presence was not generation-bound");

  const ticket = edge.issueRouteTicket({ routeId: ROUTE, subject: SUBJECT });
  assert.deepEqual(ticket.claims.operationClasses, ["mcp-read"]);
  assert.equal(ticket.claims.endpointGeneration, 1);
  assert.equal(ticket.claims.connectionGeneration, 1);
  assert.equal(ticket.claims.audience, AUDIENCE);

  // A newer generation is accepted; an older observation cannot lower it.
  edge.recordPresence({ kind: "endpoint", deviceId: DEVICE, endpointId: ENDPOINT }, 2, true);
  assert.throws(
    () => edge.recordPresence({ kind: "endpoint", deviceId: DEVICE, endpointId: ENDPOINT }, 1, true),
    (error) => expectCode(error, "stale_generation"),
  );
  assert.throws(() => edge.issueRouteTicket({ routeId: ROUTE, subject: SUBJECT }), (error) => expectCode(error, "unavailable"));

  assert.throws(
    () => edge.recordPresence({ kind: "endpoint", deviceId: DEVICE, endpointId: "endpoint-foreign" }, 1, true),
    /not on this Edge's allowlist/,
  );
});

test("a ticket is confirmed with the Hub online, and Hub admission cannot widen the local allowlist", async () => {
  const f = await fixture();
  f.edge.recordPresence({ kind: "endpoint", deviceId: DEVICE, endpointId: ENDPOINT }, 1, true);
  const ticket = f.edge.issueRouteTicket({ routeId: ROUTE, subject: SUBJECT });

  const claims = await f.edge.validateRouteTicketOnline(ticket, expectationFor());
  assert.equal(claims.routeId, ROUTE);
  assert.equal(f.confirmations.count, 1, "the ticket was accepted without an online Hub confirmation");
  assert.equal(JSON.stringify(claims).includes(SECRET), false);
  assert.equal("proof" in claims, false);

  // The same ticket presented twice is a replay, not a second authorization.
  await assert.rejects(f.edge.validateRouteTicketOnline(ticket, expectationFor()), (error) => expectCode(error, "conflict"));

  // A Hub answer that names a target this Edge does not allow is still refused.
  const hostile = new FabricEdgeRuntime({
    config: f.config,
    tickets: f.tickets,
    routes: f.admissions,
    admissions: f.admissions,
    now: () => f.now.value,
    confirmWithHub: { confirm: async () => ({ ...claims, deviceId: "device-foreign" }) },
  });
  await assert.rejects(hostile.validateRouteTicketOnline(ticket, expectationFor()), /not on this Edge's allowlist/);

  // Without a confirmation port there is no online authority, so nothing is admitted.
  const offline = new FabricEdgeRuntime({
    config: f.config,
    tickets: f.tickets,
    routes: f.admissions,
    admissions: f.admissions,
    now: () => f.now.value,
  });
  await assert.rejects(offline.validateRouteTicketOnline(ticket, expectationFor()), (error) => expectCode(error, "unavailable"));
});

test("a failure advances only to another pre-admitted candidate for the same Endpoint", async () => {
  const f = await fixture();
  const before = f.admissions.validateRoute(ROUTE);

  const advanced = await f.edge.advancePath({
    routeId: ROUTE,
    expectedRevision: 0,
    failedPath: "lan-direct",
    replayClass: "readonly",
  });
  assert.equal(advanced.selectedPath, "edge-relay");
  assert.ok(before.pathCandidates?.includes(advanced.selectedPath), "the switch invented a path the route never admitted");
  assert.equal(advanced.endpointId, before.endpointId);
  assert.equal(advanced.deviceId, before.deviceId);
  assert.equal(advanced.connectionId, before.connectionId);
  assert.equal(advanced.connectionGeneration, before.connectionGeneration);
  assert.equal(advanced.endpointGeneration, before.endpointGeneration);
  assert.equal(advanced.revision, 1);

  // Revision-fenced compare-and-swap: a stale revision cannot switch again.
  await assert.rejects(
    f.edge.advancePath({ routeId: ROUTE, expectedRevision: 0, failedPath: "edge-relay", replayClass: "readonly" }),
    (error) => expectCode(error, "conflict"),
  );
  // Only the path that failed may be left behind.
  await assert.rejects(
    f.edge.advancePath({ routeId: ROUTE, expectedRevision: 1, failedPath: "lan-direct", replayClass: "readonly" }),
    (error) => expectCode(error, "conflict"),
  );
  // The pre-negotiated alternative is still reachable from the new path.
  const returned = await f.edge.advancePath({
    routeId: ROUTE,
    expectedRevision: 1,
    failedPath: "edge-relay",
    replayClass: "durable-dedup",
  });
  assert.equal(returned.selectedPath, "lan-direct");
  assert.equal(returned.endpointId, before.endpointId);
});

test("a route with no admitted alternative is left alone rather than redirected", async () => {
  const f = await fixture();
  f.admissions.openRoute({ ...f.route, routeId: "route-solo", pathCandidates: ["lan-direct"], selectedPath: "lan-direct" });
  await assert.rejects(
    f.edge.advancePath({ routeId: "route-solo", expectedRevision: 0, failedPath: "lan-direct", replayClass: "readonly" }),
    (error) => expectCode(error, "unavailable"),
  );
  assert.equal(f.admissions.validateRoute("route-solo").selectedPath, "lan-direct");

  // A candidate this Edge does not admit is not an alternative either.
  f.admissions.openRoute({
    ...f.route,
    routeId: "route-unadmitted",
    pathCandidates: ["lan-direct", "vps-relay"],
    selectedPath: "lan-direct",
  });
  await assert.rejects(
    f.edge.advancePath({ routeId: "route-unadmitted", expectedRevision: 0, failedPath: "lan-direct", replayClass: "readonly" }),
    (error) => expectCode(error, "unavailable"),
  );
  assert.equal(f.admissions.validateRoute("route-unadmitted").selectedPath, "lan-direct");
});

test("a path switch that would move the Endpoint is refused instead of published", async () => {
  const f = await fixture();
  const hostile = new FabricEdgeRuntime({
    config: f.config,
    tickets: f.tickets,
    routes: f.admissions,
    now: () => f.now.value,
    admissions: {
      switchRoutePath: async (routeId, expectedRevision, selectedPath) => ({
        ...f.admissions.validateRoute(routeId),
        endpointId: "endpoint-other",
        selectedPath,
        revision: expectedRevision + 1,
      }),
    },
  });
  await assert.rejects(
    hostile.advancePath({ routeId: ROUTE, expectedRevision: 0, failedPath: "lan-direct", replayClass: "readonly" }),
    (error) => expectCode(error, "protocol_violation"),
  );
  const unchanged = f.admissions.validateRoute(ROUTE);
  assert.equal(unchanged.endpointId, ENDPOINT);
  assert.equal(unchanged.selectedPath, "lan-direct");
});

test("a failed mutation is not replayed on another admitted path", async () => {
  const f = await fixture();
  f.admissions.openRoute({ ...f.route, routeId: "route-mutation", operationClass: "mcp-mutation" });

  await assert.rejects(
    f.edge.advancePath({
      routeId: "route-mutation",
      expectedRevision: 0,
      failedPath: "lan-direct",
      replayClass: "non-replayable",
    }),
    (error) => expectCode(error, "permission_denied"),
  );
  assert.equal(f.admissions.validateRoute("route-mutation").selectedPath, "lan-direct");

  // Readonly work and endpoint-proven deduplication may advance.
  const advanced = await f.edge.advancePath({
    routeId: "route-mutation",
    expectedRevision: 0,
    failedPath: "lan-direct",
    replayClass: "durable-dedup",
  });
  assert.equal(advanced.selectedPath, "edge-relay");
});

test("no secret leaves the Edge through a ticket, an advertisement, or a projection", async () => {
  const f = await fixture();
  f.edge.recordPresence({ kind: "endpoint", deviceId: DEVICE, endpointId: ENDPOINT }, 1, true);
  const ticket = f.edge.issueRouteTicket({ routeId: ROUTE, subject: SUBJECT });
  const advertisement = f.edge.advertisementOf();

  for (const value of [ticket, advertisement, f.config]) {
    assert.equal(JSON.stringify(value).includes(SECRET), false, "a secret reached a public value");
  }
  assert.equal(ticket.claims.keyId, "key-1");
  assert.equal(ticket.proof.includes(SECRET), false);

  // Device-local roots stay on the device.
  const workspaces = advertisement.payload.workspaces as ReadonlyArray<Record<string, unknown>>;
  assert.deepEqual(Object.keys(workspaces[0] ?? {}).sort(), ["deviceId", "workspaceBindingId", "workspaceId"]);
  const devices = advertisement.payload.devices as ReadonlyArray<Record<string, unknown>>;
  assert.deepEqual(devices.map((device) => device.deviceId), [DEVICE]);

  assert.equal(advertisement.advertisementRevision, 1);
  assert.equal(f.edge.advertisementOf().advertisementRevision, 1, "a stable inventory advanced its revision");

  const claims = await f.edge.validateRouteTicketOnline(ticket, expectationFor());
  assert.equal(JSON.stringify(claims).includes(SECRET), false);
  assert.equal("proof" in claims, false);
});

test("a real TLS lan-direct admission requires a current route and a valid ticket", async () => {
  const f = await fixture();
  f.edge.recordPresence({ kind: "endpoint", deviceId: DEVICE, endpointId: ENDPOINT }, 1, true);
  const ca = await readFile(certificatePath);
  const key = await readFile(keyPath);
  const listener = createHttpsServer({ cert: ca, key });
  const port = await listen(listener);
  const server = new FabricDirectRouteServer({
    server: listener,
    tickets: f.tickets,
    routes: f.admissions,
    audience: AUDIENCE,
    subjects: [SUBJECT],
    limits: { heartbeatIntervalMs: 50, heartbeatTimeoutMs: 5_000 },
    drainTimeoutMs: 200,
    handleStream: (_session, frame) => ({ ...frame, kind: "end", payload: { echoed: true } }),
  });
  server.start();
  try {
    const ticket = f.edge.issueRouteTicket({ routeId: ROUTE, subject: SUBJECT });
    // The Hub is asked online first; the direct listener is not the authority.
    await f.edge.validateRouteTicketOnline(ticket, expectationFor());

    const client = rawClient(`wss://localhost:${port}${FABRIC_DIRECT_ROUTE_PATH}`, ca);
    await client.opened;
    client.send(envelope("route_open", { ticket }));
    const accepted = await client.waitFor("route_open");
    assert.equal(payloadOf(accepted).accepted, true);
    assert.equal(payloadOf(accepted).endpointId, ENDPOINT);
    assert.equal(payloadOf(accepted).subject, SUBJECT);
    assert.equal(accepted.connectionGeneration, 1);
    assert.equal(server.sessionOfRoute(ROUTE)?.state, "admitted");

    client.send(envelope("stream", streamFrame(), {
      connectionId: accepted.connectionId,
      connectionGeneration: 1,
      operationId: "operation-a",
    }));
    const published = await client.waitFor("stream");
    assert.equal(payloadOf(published).kind, "end");
    assert.equal((payloadOf(published).payload as Record<string, unknown>).echoed, true);
    assert.equal(server.sessionOfRoute(ROUTE)?.resultsPublished, 1);

    client.socket.close();
    await client.closed;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(server.sessionOfRoute(ROUTE), undefined);
  } finally {
    await server.close("test complete");
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

test("a direct result is never published for a route that moved while the work was in flight", async () => {
  const f = await fixture();
  f.edge.recordPresence({ kind: "endpoint", deviceId: DEVICE, endpointId: ENDPOINT }, 1, true);
  const ca = await readFile(certificatePath);
  const key = await readFile(keyPath);
  const listener = createHttpsServer({ cert: ca, key });
  const port = await listen(listener);
  const server = new FabricDirectRouteServer({
    server: listener,
    tickets: f.tickets,
    routes: f.admissions,
    audience: AUDIENCE,
    subjects: [SUBJECT],
    limits: { heartbeatIntervalMs: 50, heartbeatTimeoutMs: 5_000 },
    drainTimeoutMs: 200,
    handleStream: async (_session, frame) => {
      // The route is revoked while the answer is being produced.
      await f.admissions.closeRoute(ROUTE, 0);
      return { ...frame, kind: "end", payload: {} };
    },
  });
  try {
    const ticket = f.edge.issueRouteTicket({ routeId: ROUTE, subject: SUBJECT });
    const client = rawClient(`wss://localhost:${port}${FABRIC_DIRECT_ROUTE_PATH}`, ca);
    await client.opened;
    client.send(envelope("route_open", { ticket }));
    const accepted = await client.waitFor("route_open");

    client.send(envelope("stream", streamFrame(), {
      connectionId: accepted.connectionId,
      connectionGeneration: 1,
      operationId: "operation-a",
    }));
    const refusal = await client.waitFor("error");
    assert.equal(payloadOf(refusal).code, "invalid_state");
    assert.equal(await client.closed, 1000);
    assert.equal(client.received.some((frame) => frame.kind === "stream"), false, "a stale result was published");
  } finally {
    await server.close("test complete");
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

test("a direct listener refuses a ticket for another subject, another path, or a replayed nonce", async () => {
  const f = await fixture();
  f.edge.recordPresence({ kind: "endpoint", deviceId: DEVICE, endpointId: ENDPOINT }, 1, true);
  f.admissions.openRoute({ ...f.route, routeId: "route-relay", selectedPath: "edge-relay" });
  const ca = await readFile(certificatePath);
  const key = await readFile(keyPath);
  const listener = createHttpsServer({ cert: ca, key });
  const port = await listen(listener);
  const server = new FabricDirectRouteServer({
    server: listener,
    tickets: f.tickets,
    routes: f.admissions,
    audience: AUDIENCE,
    subjects: [SUBJECT],
    limits: { heartbeatIntervalMs: 50, heartbeatTimeoutMs: 5_000 },
    drainTimeoutMs: 200,
  });
  const url = `wss://localhost:${port}${FABRIC_DIRECT_ROUTE_PATH}`;
  try {
    const refused = async (ticket: unknown, code: FabricContractError["code"]): Promise<void> => {
      const client = rawClient(url, ca);
      await client.opened;
      client.send(envelope("route_open", { ticket }));
      const refusal = await client.waitFor("error");
      assert.equal(payloadOf(refusal).code, code);
      assert.equal(await client.closed, 1000);
      assert.equal(server.sessionOfRoute(ROUTE), undefined);
    };

    await refused(f.edge.issueRouteTicket({ routeId: ROUTE, subject: "subject-b" }), "permission_denied");
    await refused(f.edge.issueRouteTicket({ routeId: "route-relay", subject: SUBJECT }), "permission_denied");

    const replayed = f.edge.issueRouteTicket({ routeId: ROUTE, subject: SUBJECT });
    const first = rawClient(url, ca);
    await first.opened;
    first.send(envelope("route_open", { ticket: replayed }));
    assert.equal(payloadOf(await first.waitFor("route_open")).accepted, true);
    first.socket.close();
    await first.closed;
    await refused(replayed, "conflict");
  } finally {
    await server.close("test complete");
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});

test("a plaintext listener is refused before any ticket is read", async () => {
  const f = await fixture();
  const listener = createHttpServer();
  const port = await listen(listener);
  const server = new FabricDirectRouteServer({
    server: listener,
    tickets: f.tickets,
    routes: f.admissions,
    audience: AUDIENCE,
    subjects: [SUBJECT],
    limits: { heartbeatIntervalMs: 50, heartbeatTimeoutMs: 5_000 },
    drainTimeoutMs: 200,
  });
  try {
    const client = rawClient(`ws://localhost:${port}${FABRIC_DIRECT_ROUTE_PATH}`);
    const refusal = await client.waitFor("error");
    assert.equal(payloadOf(refusal).code, "protocol_violation");
    assert.match(String(payloadOf(refusal).message), /requires TLS/);
    assert.equal(await client.closed, 1002);
    assert.equal(server.sessions().length, 0);
  } finally {
    await server.close("test complete");
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});
