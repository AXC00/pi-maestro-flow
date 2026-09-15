import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GatewayDaemon } from "../src/gateway/daemon.ts";
import { GatewayTunnelProcessOwner, gatewayTunnelInvocationDigest } from "../src/gateway/tunnel/process-owner.ts";
import type { GatewayTunnelProvider } from "../src/gateway/tunnel/contracts.ts";
import { GatewayTunnelManager } from "../src/gateway/tunnel/provider.ts";
import { workspaceIdForPath } from "../src/gateway/state-paths.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";

const certificatePath = join(import.meta.dirname, "fixtures", "fabric-test-cert.pem");
const keyPath = join(import.meta.dirname, "fixtures", "fabric-test-key.pem");
const tunnelActions = [
  "gateway.host.status",
  "gateway.file.stat",
  "fabric.control.device.list",
  "fabric.control.workspace.list",
  "fabric.control.endpoint.list",
  "fabric.control.route.close",
];

type ForwardObservation = { method: string; path: string; sessionId?: string; body: string };

interface Forwarder {
  readonly url: string;
  readonly observations: ForwardObservation[];
  setTarget(url: string): void;
  close(): Promise<void>;
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** A separate, protocol-faithful forwarding hop. It never imports or calls GatewayRuntime. */
async function startForwarder(targetUrl: string): Promise<Forwarder> {
  let target = new URL(targetUrl);
  const observations: ForwardObservation[] = [];
  const server: Server = createServer(async (request, response) => {
    const body = await requestBody(request);
    const sessionId = typeof request.headers["mcp-session-id"] === "string" ? request.headers["mcp-session-id"] : undefined;
    observations.push({ method: request.method ?? "", path: request.url ?? "", ...(sessionId === undefined ? {} : { sessionId }), body: body.toString("utf8") });
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (name === "host" || name === "content-length" || name === "connection") continue;
      if (typeof value === "string") headers[name] = value;
    }
    const destination = new URL(request.url ?? "/", target.origin);
    const upstream = await fetch(destination, {
      method: request.method,
      headers,
      ...(body.byteLength === 0 ? {} : { body }),
    });
    response.statusCode = upstream.status;
    upstream.headers.forEach((value, name) => {
      if (name !== "transfer-encoding" && name !== "connection") response.setHeader(name, value);
    });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    observations,
    setTarget(url: string): void { target = new URL(url); },
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function envelope(result: Awaited<ReturnType<Client["callTool"]>>): { ok: boolean; error?: { code?: string }; data?: Record<string, unknown> } {
  const content = result.content[0];
  assert.equal(content?.type, "text");
  return JSON.parse(content.type === "text" ? content.text : "null") as { ok: boolean; error?: { code?: string }; data?: Record<string, unknown> };
}

async function connectMcp(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "independent-tunnel-e2e", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

async function rawInitialize(url: string, token: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "canary", method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw-independent-client", version: "1" } } }),
  });
}

async function nativeHealth(url: string, ca: Buffer): Promise<number> {
  const parsed = new URL(url);
  return new Promise<number>((resolve, reject) => {
    const request = httpsRequest({ hostname: parsed.hostname, port: Number(parsed.port), path: "/healthz", ca }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    request.end();
  });
}

async function closeUpgrade(url: string): Promise<Buffer> {
  const parsed = new URL(url);
  return new Promise<Buffer>((resolve) => {
    const socket = httpRequest({ host: parsed.hostname, port: Number(parsed.port), path: "/fabric/v1/connector", headers: { connection: "Upgrade", upgrade: "websocket" } });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => { socket.destroy(); resolve(Buffer.concat(chunks)); }, 1_000);
    socket.on("response", (response) => {
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    });
    socket.on("error", () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    socket.end();
  });
}

test("independent MCP client reaches daemon TLS/loopback tunnel with scoped Fabric access and bounded lifecycle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-tunnel-mcp-e2e-"));
  const sibling = join(root, "sibling");
  await writeFile(join(root, "canary.txt"), "local canary", "utf8");
  await mkdir(sibling, { recursive: true });
  const localWorkspaceId = workspaceIdForPath(root);
  const siblingWorkspaceId = workspaceIdForPath(sibling);
  const config = createTestGatewayConfig(root, { mode: "bearer", token: "legacy-token-not-used-by-tunnel" });
  config.workspaces.push({ path: sibling, id: siblingWorkspaceId, mode: "permanent" });
  config.transport.http.enabled = true;
  config.transport.http.host = "localhost";
  config.transport.http.port = 0;
  config.transport.http.tls = { enabled: true, certFile: certificatePath, keyFile: keyPath };
  config.fabric = { enabled: true };
  config.logging.auditFile = join(root, "audit", "gateway.jsonl");
  config.tunnels.profiles = [{
    id: "quick",
    provider: "cloudflare",
    mode: "quick",
    lifecycle: "ephemeral",
    enabled: false,
    // Gateway auth is an ingress marker; the remote pairing credential is
    // the sole source of actual action/workspace authority.
    mcpAccess: { enabled: true, actions: [], auth: { kind: "gateway" } },
  }];
  const fakeExecutable = join(root, "quick-tunnel-client");
  await writeFile(fakeExecutable, "fixture executable", "utf8");
  let forwardTarget = "";
  let starts = 0;
  let stops = 0;
  const provider: GatewayTunnelProvider = {
    name: "cloudflare",
    stability: "stable",
    async doctor() { return { ok: true, executablePath: fakeExecutable }; },
    async start() { starts += 1; return { pid: 54321, executablePath: fakeExecutable, args: ["forward"], endpoint: forwardTarget }; },
    async probe() { return { ready: true, endpoint: forwardTarget, detail: "fixture forwarding ready" }; },
    async stop() { stops += 1; },
  };
  const processOwner = new GatewayTunnelProcessOwner({ inspect: async () => ({
    alive: true,
    executableRealpath: fakeExecutable,
    processStartIdentity: "fixture-process",
    invocationDigest: gatewayTunnelInvocationDigest(fakeExecutable, ["forward"]),
  }) });
  const daemonOptions = {
    config,
    cwd: root,
    http: true,
    httpPort: 0,
    tunnelProviders: [provider],
    tunnelStateRoot: join(root, "tunnel-state"),
    shutdownTimeoutMs: 250,
  } as const;
  // Inject only the provider/process seam; the daemon still owns the real
  // listeners, authentication, runtime, and supervisor lifecycle.
  const tunnelManager = new GatewayTunnelManager({
    providers: [provider], stateRoot: join(root, "tunnel-state"), processOwner,
    supervisorOptions: { canonicalizeExecutable: async (path: string) => path },
    profiles: [{ id: "quick", provider: "cloudflare", mode: "quick", lifecycle: "ephemeral", enabled: false, input: { mode: "quick", localPort: 0, path: "/mcp" } }],
  });
  const servingDaemon = new GatewayDaemon({ ...daemonOptions, tunnelManager });
  const forwarder = await startForwarder("http://127.0.0.1:1/mcp");
  t.after(async () => {
    await forwarder.close();
    await servingDaemon.stop();
    await rm(root, { recursive: true, force: true });
  });
  await servingDaemon.start();
  assert(servingDaemon.http?.secure, "authoritative listener must use native TLS");
  assert.equal(await nativeHealth(servingDaemon.http.url, await readFile(certificatePath)), 200, "native TLS listener accepts a pinned-CA request");
  assert(servingDaemon.tunnelHttp, "enabled MCP access profile must publish loopback ingress");
  forwarder.setTarget(servingDaemon.tunnelHttp.url);
  forwardTarget = forwarder.url;
  assert.equal(servingDaemon.tunnelHttp.host, "127.0.0.1");
  assert.equal(servingDaemon.tunnelManager?.profile("quick").lifecycle, "ephemeral");

  const issued = await servingDaemon.runtime!.pairingStore.issue({ scopes: tunnelActions, workspaceId: localWorkspaceId, label: "independent-client" });
  const client = await connectMcp(forwarder.url, issued.token);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "host"));
  assert.ok(tools.tools.some((tool) => tool.name === "device"));
  const host = await client.callTool({ name: "host", arguments: { action: "status" } });
  assert.equal(envelope(host).ok, true);
  assert.equal(host.isError, false);
  const device = await client.callTool({ name: "device", arguments: { version: "fabric.control.v1", action: "list", requestId: "e2e-device-list", deadlineAt: Date.now() + 10_000 } });
  const workspace = await client.callTool({ name: "workspace", arguments: { version: "fabric.control.v1", action: "list", requestId: "e2e-workspace-list", deadlineAt: Date.now() + 10_000 } });
  const endpoint = await client.callTool({ name: "endpoint", arguments: { version: "fabric.control.v1", action: "list", requestId: "e2e-endpoint-list", deadlineAt: Date.now() + 10_000 } });
  const route = await client.callTool({ name: "route", arguments: { version: "fabric.control.v1", action: "close", routeId: "missing-route", expectedRevision: 0, requestId: "e2e-route-close", deadlineAt: Date.now() + 10_000 } });
  assert.equal(envelope(device).ok, true);
  assert.equal(envelope(workspace).ok, true);
  assert.equal(envelope(endpoint).ok, true);
  assert.equal(envelope(route).ok, false, "legal route.close action reaches Fabric control and reports not_found, not capability denial");
  const visibleWorkspaces = (envelope(workspace).data?.workspaces ?? []) as Array<{ id?: string; workspaceId?: string }>;
  assert.equal(visibleWorkspaces.some((entry) => entry.id === siblingWorkspaceId || entry.workspaceId === siblingWorkspaceId), false, "sibling workspace is not projected");
  const siblingFile = await client.callTool({ name: "file", arguments: { action: "stat", workspaceId: siblingWorkspaceId, path: "canary.txt" } });
  assert.equal(envelope(siblingFile).ok, false, "workspace-bound tunnel credential cannot stat a sibling workspace");
  assert.equal(envelope(siblingFile).error?.code, "policy_denied");
  await client.close();

  assert.equal(forwarder.observations[0]?.method, "POST");
  assert.match(forwarder.observations[0]?.body ?? "", /initialize/u);
  assert.ok(forwarder.observations.some((entry) => entry.path === "/mcp" && entry.sessionId !== undefined), "subsequent MCP requests preserve mcp-session-id");
  assert.equal((await fetch(new URL("/fabric/v1/connector", servingDaemon.tunnelHttp.url))).status, 404);
  assert.doesNotMatch((await closeUpgrade(servingDaemon.tunnelHttp.url)).toString("utf8"), /101 Switching Protocols/u);

  const rotated = await servingDaemon.runtime!.pairingStore.issue({ scopes: tunnelActions, workspaceId: localWorkspaceId, replacesId: issued.id });
  assert.equal((await rawInitialize(forwarder.url, issued.token)).status, 401);
  const rotatedClient = await connectMcp(forwarder.url, rotated.token);
  assert.equal(envelope(await rotatedClient.callTool({ name: "host", arguments: { action: "status" } })).ok, true);
  await rotatedClient.close();
  assert.equal(await servingDaemon.runtime!.pairingStore.revoke(rotated.id, { revokedBy: "e2e" }), true);
  assert.equal((await rawInitialize(forwarder.url, rotated.token)).status, 401);

  const restartCredential = await servingDaemon.runtime!.pairingStore.issue({ scopes: tunnelActions, workspaceId: localWorkspaceId, label: "restart-client" });
  await servingDaemon.controlDispatcher!.dispatch("tunnel-start", { profile: "quick" });
  assert.equal(starts, 1, "ephemeral Quick profile starts only after manual enable");
  assert.equal((await servingDaemon.tunnelManager!.supervisor("cloudflare", "quick").status())?.observed.phase, "ready");
  await servingDaemon.controlDispatcher!.dispatch("tunnel-stop", { profile: "quick" });
  assert.equal(stops, 1);
  const oldIngress = servingDaemon.tunnelHttp.url;
  const startedAt = Date.now();
  await servingDaemon.stop();
  assert.ok(Date.now() - startedAt < 1_000, "shutdown is bounded");
  const restarted = new GatewayDaemon({ ...daemonOptions, tunnelManager: new GatewayTunnelManager({ providers: [provider], stateRoot: join(root, "tunnel-state"), processOwner, supervisorOptions: { canonicalizeExecutable: async (path: string) => path }, profiles: [{ id: "quick", provider: "cloudflare", mode: "quick", lifecycle: "ephemeral", enabled: false, input: { mode: "quick", localPort: 0, path: "/mcp" } }] }) });
  await restarted.start();
  t.after(() => restarted.stop());
  assert.notEqual(restarted.tunnelHttp?.url, oldIngress);
  forwarder.setTarget(restarted.tunnelHttp!.url);
  const afterRestart = await connectMcp(forwarder.url, restartCredential.token);
  assert.equal(envelope(await afterRestart.callTool({ name: "host", arguments: { action: "status" } })).ok, true);
  await afterRestart.close();

  const pairingState = await readFile(config.state.pairingPath!, "utf8");
  assert.doesNotMatch(pairingState, new RegExp(issued.token, "u"), "raw credential is not persisted");
  assert.doesNotMatch(JSON.stringify(config.tunnels.profiles), /legacy-token-not-used|independent-client/u);
});
