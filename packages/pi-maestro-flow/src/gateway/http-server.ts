/** Streamable HTTP MCP host. No static or Web UI routes are exposed. */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { GatewayHttpAuth, isLoopbackHost, validateGatewayHttpSecurity } from "./auth.ts";
import { principalHasFabricDataPlane } from "./capabilities.ts";
import { FABRIC_HTTPS_EVENTS_PATH, FABRIC_HTTPS_EXCHANGE_PATH } from "./fabric/https-transport.ts";
import { principalKey } from "./principal.ts";
import type { GatewayPrincipal } from "./contracts.ts";
import type { GatewayRuntime } from "./runtime.ts";
import { normalizeGatewayTunnelMcpPath } from "./tunnel/mcp-access.ts";

interface HttpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  principal: GatewayPrincipal;
  /** Persisted pairing principal, when this session was pairing-authenticated. */
  pairingId?: string;
}

export type GatewayHttpServerMode = "gateway" | "tunnel-ingress";

export interface GatewayHttpServerOptions {
  host?: string;
  port?: number;
  path?: string;
  /** Tunnel ingress is a loopback-only MCP/OAuth surface; it never serves Fabric routes. */
  mode?: GatewayHttpServerMode;
  /** Share OAuth state and authentication with the authoritative Gateway listener. */
  auth?: GatewayHttpAuth;
}

export interface GatewayHttpServerHandle {
  readonly server: NodeHttpServer;
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly url: string;
  readonly secure: boolean;
  readonly mode: GatewayHttpServerMode;
  setReady(ready: boolean): void;
  close(): Promise<void>;
}

export async function startGatewayHttpServer(runtime: GatewayRuntime, options: GatewayHttpServerOptions = {}): Promise<GatewayHttpServerHandle> {
  const mode = options.mode ?? "gateway";
  const host = mode === "tunnel-ingress" ? (options.host ?? "127.0.0.1") : (options.host ?? runtime.config.transport.http.host);
  const port = mode === "tunnel-ingress" ? (options.port ?? 0) : (options.port ?? runtime.config.transport.http.port);
  const path = normalizeMcpPath(options.path ?? runtime.config.transport.http.path);
  if (mode === "tunnel-ingress" && !isLoopbackHost(host)) throw new Error("Gateway tunnel ingress must bind a loopback host");
  if (mode === "tunnel-ingress" && runtime.config.auth.mode === "open") {
    throw new Error("Gateway tunnel ingress requires authenticated Gateway HTTP");
  }
  validateGatewayHttpSecurity(runtime.config, host);
  const auth = options.auth ?? new GatewayHttpAuth(runtime.config.auth, runtime.pairingStore, runtime.fabricOriginDataPlaneGrants);
  const sessions = new Map<string, HttpSession>();
  const revokedPairingIds = new Set<string>();
  const revocationTasks = new Set<Promise<void>>();
  let revocationSubscriptionActive = true;
  let unsubscribeRevocations: (() => void) | undefined;
  let closed = false;
  let ready = true;

  const scheduleSessionClose = (id: string, session: HttpSession): void => {
    const task = closeSession(id, session);
    revocationTasks.add(task);
    void task.finally(() => revocationTasks.delete(task)).catch(() => undefined);
  };
  async function closeSession(id: string, session: HttpSession): Promise<void> {
    if (sessions.get(id) === session) sessions.delete(id);
    await session.transport.close().catch(() => undefined);
    await session.server.close().catch(() => undefined);
  }
  // Tunnel ingress is deliberately plaintext on loopback. Native TLS remains
  // mandatory for the authoritative Gateway/Fabric listener.
  const tls = mode === "tunnel-ingress" ? undefined : runtime.config.transport.http.tls;
  if (mode === "gateway" && runtime.fabricHttpChannelServer !== undefined && tls?.enabled !== true) {
    throw new Error("Gateway Fabric HTTP routes require native HTTPS");
  }
  if (mode === "gateway" && runtime.fabricEnrollmentHttpServer !== undefined && tls?.enabled !== true) {
    throw new Error("Gateway Fabric enrollment routes require native HTTPS");
  }
  const listener = (request: IncomingMessage, response: ServerResponse): void => {
    void handleRequest(request, response).catch((error) => {
      if (!response.headersSent) {
        const status = error instanceof HttpBodyError ? error.status : 500;
        jsonRpcError(response, status, status === 500 ? -32603 : -32700, error instanceof Error ? error.message : "Internal server error");
      } else if (!response.writableEnded) response.end();
    });
  };
  const server: NodeHttpServer = tls?.enabled
    ? createHttpsServer({ cert: await readFile(tls.certFile!), key: await readFile(tls.keyFile!) }, listener)
    : createServer(listener);
  if (mode === "tunnel-ingress") {
    // HTTP upgrade requests are never a tunnel ingress capability (in
    // particular, Connector WSS is confined to the native Fabric listener).
    server.on("upgrade", (_request, socket) => socket.destroy());
  }
  unsubscribeRevocations = runtime.pairingStore.subscribeRevocations((event) => {
    if (!revocationSubscriptionActive || closed) return;
    // Keep a bounded fence for sessions racing with authentication/initialization.
    revokedPairingIds.add(event.pairingId);
    if (revokedPairingIds.size > 512) revokedPairingIds.delete(revokedPairingIds.values().next().value as string);
    for (const [id, session] of sessions) {
      if (session.pairingId === event.pairingId) scheduleSessionClose(id, session);
    }
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const baseUrl = publicBaseUrl(runtime, request, host, boundPort(server, port), tls?.enabled === true);
    const url = new URL(request.url ?? "/", baseUrl);
    if (url.pathname === "/healthz" || url.pathname === "/readyz") {
      const healthy = url.pathname === "/healthz" || (ready && runtime.isReady);
      const body = JSON.stringify({ status: healthy ? "ok" : "shutting_down" });
      response.writeHead(healthy ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
      response.end(body);
      return;
    }
    const enrollmentServer = mode === "gateway" ? runtime.fabricEnrollmentHttpServer : undefined;
    if (enrollmentServer?.handles(url.pathname)) {
      if (!ready || !runtime.isReady || !runtime.fabricAdmissionReady) {
        response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: { code: "unavailable", message: "Fabric registration is unavailable while the Gateway is shutting down" } }));
        return;
      }
      await enrollmentServer.handle(request, response, url);
      return;
    }
    const fabricServer = mode === "gateway" ? runtime.fabricHttpChannelServer : undefined;
    if (fabricServer?.handles(url.pathname)) {
      if (request.method === "OPTIONS") {
        applyCors(runtime, request, response);
        response.writeHead(204, {
          "access-control-allow-methods": url.pathname === FABRIC_HTTPS_EXCHANGE_PATH ? "POST, OPTIONS" : "GET, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
        });
        response.end();
        return;
      }
      if (!originAllowed(runtime, request)) {
        fabricAuthError(response, 403, "Origin is not allowed");
        return;
      }
      const authenticated = await auth.authenticate(request, `${baseUrl}/.well-known/oauth-protected-resource${path}`);
      if (!authenticated.principal) {
        response.writeHead(authenticated.status ?? 401, {
          "content-type": "application/json",
          ...(authenticated.wwwAuthenticate ? { "www-authenticate": authenticated.wwwAuthenticate } : {}),
        });
        response.end(JSON.stringify({ error: { code: "unauthorized", message: authenticated.message ?? "Unauthorized" } }));
        return;
      }
      const action = url.pathname === FABRIC_HTTPS_EVENTS_PATH ? "events" : "exchange";
      if (!principalHasFabricDataPlane(authenticated.principal, action)) {
        fabricAuthError(response, 403, `Fabric principal lacks required capability: fabric.data.${action}`);
        return;
      }
      applyCors(runtime, request, response);
      await fabricServer.handle(request, response, url, authenticated.principal);
      return;
    }
    if (await auth.handleOAuthRoute(request, response, url, baseUrl, path)) return;
    if (url.pathname !== path) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    if (request.method === "OPTIONS") {
      applyCors(runtime, request, response);
      response.writeHead(204, {
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id",
        "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
      });
      response.end();
      return;
    }
    if (!originAllowed(runtime, request)) {
      jsonRpcError(response, 403, -32001, "Origin is not allowed");
      return;
    }
    const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource${path}`;
    const authenticated = await auth.authenticate(request, resourceMetadataUrl);
    if (!authenticated.principal) {
      response.writeHead(authenticated.status ?? 401, {
        "content-type": "application/json",
        ...(authenticated.wwwAuthenticate ? { "www-authenticate": authenticated.wwwAuthenticate } : {}),
      });
      response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: authenticated.message ?? "Unauthorized" }, id: null }));
      return;
    }
    applyCors(runtime, request, response);
    const sessionId = headerValue(request.headers["mcp-session-id"]);
    const current = sessionId ? sessions.get(sessionId) : undefined;
    if (current && principalKey(current.principal) !== principalKey(authenticated.principal)) {
      jsonRpcError(response, 403, -32001, "MCP session belongs to a different principal");
      return;
    }
    if (request.method === "POST") {
      const body = await readJsonBody(request, runtime.config.limits.maxRequestBytes);
      if (current) {
        await current.transport.handleRequest(request, response, body);
        return;
      }
      if (sessionId || !isInitializeRequest(body)) {
        jsonRpcError(response, 400, -32000, "Bad Request: No valid session ID provided");
        return;
      }
      if (!runtime.canAcceptNewSessions) {
        jsonRpcError(response, 503, -32002, "Gateway is quiescing; new sessions are refused");
        return;
      }
      let created!: HttpSession;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          if (created.pairingId !== undefined && revokedPairingIds.has(created.pairingId)) {
            scheduleSessionClose(id, created);
            return;
          }
          sessions.set(id, created);
        },
      });
      const mcpServer = runtime.createMcpServer(authenticated.principal);
      created = {
        transport,
        server: mcpServer,
        principal: authenticated.principal,
        ...(authenticated.pairingId === undefined ? {} : { pairingId: authenticated.pairingId }),
      };
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) sessions.delete(id);
        void mcpServer.close().catch(() => undefined);
      };
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response, body);
      return;
    }
    if (request.method === "GET" || request.method === "DELETE") {
      if (!current) {
        jsonRpcError(response, 400, -32000, "Invalid or missing MCP session ID");
        return;
      }
      if (request.method === "GET" && runtime.isQuiescing) {
        jsonRpcError(response, 503, -32002, "Gateway is quiescing; new subscriptions are refused");
        return;
      }
      await current.transport.handleRequest(request, response);
      return;
    }
    response.writeHead(405, { allow: "GET, POST, DELETE, OPTIONS" });
    response.end();
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      revocationSubscriptionActive = false;
      unsubscribeRevocations?.();
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const actualPort = boundPort(server, port);
  return {
    server,
    host,
    port: actualPort,
    path,
    url: `${displayOrigin(host, actualPort, tls?.enabled === true)}${path}`,
    secure: tls?.enabled === true,
    mode,
    setReady(value: boolean): void { ready = value; },
    async close(): Promise<void> {
      ready = false;
      if (closed) return;
      closed = true;
      revocationSubscriptionActive = false;
      unsubscribeRevocations?.();
      unsubscribeRevocations = undefined;
      await Promise.allSettled([...revocationTasks]);
      await Promise.allSettled([...sessions.entries()].map(([id, session]) => closeSession(id, session)));
      sessions.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function normalizeMcpPath(value: string): string {
  return normalizeGatewayTunnelMcpPath(value, "http.path");
}

function boundPort(server: NodeHttpServer, fallback: number): number {
  const address = server.address();
  return address && typeof address !== "string" ? address.port : fallback;
}

function displayOrigin(host: string, port: number, secure = false): string {
  return `${secure ? "https" : "http"}://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;
}

function publicBaseUrl(runtime: GatewayRuntime, request: IncomingMessage, host: string, port: number, secure: boolean): string {
  const configured = runtime.config.auth.oauth?.serverUrl?.replace(/\/$/, "");
  if (configured) return configured;
  const authority = request.headers.host ?? `${host}:${port}`;
  const protocol = secure || (runtime.config.server.trustProxyHeaders && request.headers["x-forwarded-proto"] === "https") ? "https" : "http";
  return `${protocol}://${authority}`;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function originAllowed(runtime: GatewayRuntime, request: IncomingMessage): boolean {
  const origin = headerValue(request.headers.origin);
  if (!origin) return true;
  const allowed = runtime.config.server.allowedOrigins;
  if (allowed.includes(origin)) return true;
  try {
    const parsed = new URL(origin);
    return allowed.length === 0 && (parsed.hostname === "localhost" || parsed.hostname.startsWith("127.") || parsed.hostname === "[::1]" || parsed.hostname === "::1");
  } catch {
    return false;
  }
}

function applyCors(runtime: GatewayRuntime, request: IncomingMessage, response: ServerResponse): void {
  const origin = headerValue(request.headers.origin);
  if (origin && originAllowed(runtime, request)) response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "Origin");
}

async function readJsonBody(request: IncomingMessage, maximum: number): Promise<unknown> {
  const declared = Number(headerValue(request.headers["content-length"]));
  if (Number.isFinite(declared) && declared > maximum) throw new HttpBodyError(413, `Request exceeds ${maximum} bytes`);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximum) throw new HttpBodyError(413, `Request exceeds ${maximum} bytes`);
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw); }
  catch { throw new HttpBodyError(400, "Request body must be valid JSON"); }
}

class HttpBodyError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function fabricAuthError(response: ServerResponse, status: number, message: string): void {
  const body = JSON.stringify({ error: { code: status === 401 ? "unauthorized" : "capability_denied", message } });
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

function jsonRpcError(response: ServerResponse, status: number, code: number, message: string): void {
  const body = JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}
