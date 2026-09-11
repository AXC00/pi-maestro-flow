import type { IncomingMessage, ServerResponse } from "node:http";
import {
  FabricChannelRouter,
  RouteBoundFabricStreamChannel,
} from "pi-maestro-fabric";
import {
  FabricContractError,
  assertEpochMilliseconds,
  assertFabricIdentifier,
  assertValidFabricStreamFrame,
  type FabricStreamFrameV1,
  type JsonValue,
} from "pi-maestro-fabric-core/v1";
import type { GatewayPrincipal } from "../contracts.ts";
import {
  FABRIC_HTTPS_EVENTS_PATH,
  FABRIC_HTTPS_EVENTS_VERSION,
  FABRIC_HTTPS_EXCHANGE_PATH,
  FABRIC_HTTPS_EXCHANGE_VERSION,
  type FabricHttpsEventV1,
  type FabricHttpsEventsResultV1,
  type FabricHttpsExchangeRequestV1,
  type FabricHttpsExchangeResultV1,
} from "./https-transport.ts";
import {
  FABRIC_ENDPOINT_REQUEST_VERSION,
  FabricEndpointDispatcher,
  type FabricEndpointKind,
} from "./endpoint-dispatcher.ts";

export interface FabricHttpChannelServerLimits {
  readonly maxRequestBytes: number;
  readonly maxResultBytes: number;
  readonly maxFrameBytes: number;
  readonly maxPendingRequests: number;
  readonly maxEventsPerRoute: number;
  readonly maxEventBytes: number;
  readonly maxEventRead: number;
}

export interface FabricHttpChannelServerOptions {
  readonly dispatcher: FabricEndpointDispatcher;
  readonly limits?: Partial<FabricHttpChannelServerLimits>;
  readonly now?: () => number;
}

interface ActiveExchange {
  readonly request: FabricHttpsExchangeRequestV1;
  readonly channel: RouteBoundFabricStreamChannel;
  readonly controller: AbortController;
}

const DEFAULT_LIMITS: FabricHttpChannelServerLimits = {
  maxRequestBytes: 1024 * 1024,
  maxResultBytes: 1024 * 1024,
  maxFrameBytes: 1024 * 1024,
  maxPendingRequests: 64,
  maxEventsPerRoute: 512,
  maxEventBytes: 256 * 1024,
  maxEventRead: 256,
};

function limit(value: number | undefined, fallback: number, path: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new FabricContractError("invalid_argument", `${path} must be a positive safe integer`, path);
  return result;
}

function bytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { return Number.POSITIVE_INFINITY; }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FabricContractError("invalid_argument", `${path} must be an object`, path);
  return value as Record<string, unknown>;
}

function integer(value: unknown, path: string, minimum: number): number {
  const parsed = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < minimum) throw new FabricContractError("invalid_argument", `${path} is invalid`, path);
  return parsed as number;
}

function endpointKind(value: unknown): FabricEndpointKind {
  if (value !== "mcp" && value !== "agent") throw new FabricContractError("invalid_argument", "endpointKind is invalid", "endpointKind");
  return value;
}

function operationKey(routeId: string, operationId: string): string {
  return `${routeId}\u0000${operationId}`;
}

/** HTTP route handler for the dedicated versioned Fabric data plane. */
export class FabricHttpChannelServer {
  readonly dispatcher: FabricEndpointDispatcher;
  readonly limits: Readonly<FabricHttpChannelServerLimits>;
  readonly #now: () => number;
  readonly #events = new Map<string, FabricHttpsEventV1[]>();
  readonly #nextEventSequence = new Map<string, number>();
  readonly #channels: FabricChannelRouter;
  readonly #active = new Map<string, ActiveExchange>();
  #pendingRequests = 0;

  constructor(options: FabricHttpChannelServerOptions) {
    this.dispatcher = options.dispatcher;
    this.#now = options.now ?? Date.now;
    this.#channels = new FabricChannelRouter(options.dispatcher.routes);
    this.limits = Object.freeze({
      maxRequestBytes: limit(options.limits?.maxRequestBytes, DEFAULT_LIMITS.maxRequestBytes, "maxRequestBytes"),
      maxResultBytes: limit(options.limits?.maxResultBytes, DEFAULT_LIMITS.maxResultBytes, "maxResultBytes"),
      maxFrameBytes: limit(options.limits?.maxFrameBytes, DEFAULT_LIMITS.maxFrameBytes, "maxFrameBytes"),
      maxPendingRequests: limit(options.limits?.maxPendingRequests, DEFAULT_LIMITS.maxPendingRequests, "maxPendingRequests"),
      maxEventsPerRoute: limit(options.limits?.maxEventsPerRoute, DEFAULT_LIMITS.maxEventsPerRoute, "maxEventsPerRoute"),
      maxEventBytes: limit(options.limits?.maxEventBytes, DEFAULT_LIMITS.maxEventBytes, "maxEventBytes"),
      maxEventRead: limit(options.limits?.maxEventRead, DEFAULT_LIMITS.maxEventRead, "maxEventRead"),
    });
  }

  handles(pathname: string): boolean {
    return pathname === FABRIC_HTTPS_EXCHANGE_PATH || pathname === FABRIC_HTTPS_EVENTS_PATH;
  }

  async handle(request: IncomingMessage, response: ServerResponse, url: URL, principal: GatewayPrincipal): Promise<void> {
    if (!this.handles(url.pathname)) throw new FabricContractError("not_found", "Unknown Fabric HTTP route");
    if (this.#pendingRequests >= this.limits.maxPendingRequests) {
      this.#json(response, 429, { error: { code: "resource_exhausted", message: "Fabric HTTP request queue is full" } });
      return;
    }
    this.#pendingRequests += 1;
    const controller = new AbortController();
    const onAborted = (): void => controller.abort();
    request.once("aborted", onAborted);
    try {
      if (url.pathname === FABRIC_HTTPS_EXCHANGE_PATH) {
        if (request.method !== "POST") {
          response.writeHead(405, { allow: "POST, OPTIONS" }); response.end(); return;
        }
        await this.#exchange(request, response, principal, controller.signal);
      } else {
        if (request.method !== "GET") {
          response.writeHead(405, { allow: "GET, OPTIONS" }); response.end(); return;
        }
        await this.#readEvents(response, url);
      }
    } catch (error) {
      const normalized = error instanceof FabricContractError ? error : new FabricContractError("unavailable", "Fabric HTTP channel failed");
      if (!response.headersSent) this.#json(response, this.#status(normalized), { error: { code: normalized.code, message: normalized.message } });
      else if (!response.writableEnded) response.end();
    } finally {
      request.off("aborted", onAborted);
      this.#pendingRequests -= 1;
    }
  }

  publish(input: Omit<FabricHttpsEventV1, "sequence" | "occurredAt"> & { occurredAt?: number }): FabricHttpsEventV1 {
    const currentRoute = this.dispatcher.routes.validateRoute(input.routeId);
    this.dispatcher.authorize({ ...input, deadlineAt: currentRoute.expiresAt });
    const queue = this.#events.get(input.routeId) ?? [];
    if (queue.length >= this.limits.maxEventsPerRoute) throw new FabricContractError("resource_exhausted", "Fabric event queue is full", "maxEventsPerRoute");
    const sequence = this.#nextEventSequence.get(input.routeId) ?? 1;
    const event: FabricHttpsEventV1 = {
      sequence,
      routeId: input.routeId,
      endpointId: input.endpointId,
      endpointKind: input.endpointKind,
      endpointGeneration: input.endpointGeneration,
      occurredAt: input.occurredAt ?? this.#now(),
      payload: structuredClone(input.payload),
    };
    if (bytes(event) > this.limits.maxEventBytes) throw new FabricContractError("resource_exhausted", "Fabric event exceeds maxEventBytes", "maxEventBytes");
    queue.push(event);
    this.#events.set(input.routeId, queue);
    this.#nextEventSequence.set(input.routeId, sequence + 1);
    return structuredClone(event);
  }

  async #exchange(request: IncomingMessage, response: ServerResponse, principal: GatewayPrincipal, requestSignal: AbortSignal): Promise<void> {
    const parsed = object(await this.#readJson(request), "exchangeRequest") as unknown as FabricHttpsExchangeRequestV1;
    this.#validateEnvelope(parsed);
    const frame = parsed.frame;

    // Unary endpoint operations intentionally have no data/ack phase. Rejecting
    // these frame kinds at the boundary is part of the protocol shape rather
    // than silently ignoring them.
    if (frame.kind === "data" || frame.kind === "ack") {
      throw new FabricContractError("invalid_state", "Unary Fabric HTTPS operations do not accept data or ack frames", "frame.kind");
    }
    if (frame.kind !== "open" && frame.kind !== "cancel") {
      throw new FabricContractError("protocol_violation", "Fabric HTTPS exchange accepts only open or cancel frames", "frame.kind");
    }

    const result = frame.kind === "open"
      ? await this.#open(parsed, principal, requestSignal)
      : await this.#cancel(parsed);
    if (bytes(result.frame) > this.limits.maxFrameBytes || bytes(result) > this.limits.maxResultBytes) {
      throw new FabricContractError("resource_exhausted", "Fabric HTTPS result exceeds configured bounds");
    }
    this.#json(response, 200, result);
  }

  async #open(parsed: FabricHttpsExchangeRequestV1, principal: GatewayPrincipal, requestSignal: AbortSignal): Promise<FabricHttpsExchangeResultV1> {
    const frame = parsed.frame;
    if (frame.sequence !== 0) throw new FabricContractError("protocol_violation", "Fabric HTTPS open frame must start at sequence zero", "frame.sequence");
    const payload = object(frame.payload, "frame.payload");
    if (typeof payload.operation !== "string") throw new FabricContractError("invalid_argument", "Fabric frame operation is required", "operation");
    const input = object(payload.input, "frame.payload.input") as Record<string, JsonValue>;
    const channel = new RouteBoundFabricStreamChannel(this.dispatcher.routes, {
      streamId: frame.streamId,
      routeId: frame.routeId,
      operationId: frame.operationId,
      deadlineAt: parsed.deadlineAt,
      limits: { maxFrameBytes: this.limits.maxFrameBytes, maxBufferedFrames: 2, maxResultBytes: this.limits.maxResultBytes },
      io: { send: async () => undefined, close: async () => undefined },
      now: this.#now,
    });
    this.#channels.bind(frame.routeId, frame.operationId, channel);
    channel.accept(frame);
    const controller = new AbortController();
    const onRequestAbort = (): void => controller.abort();
    requestSignal.addEventListener("abort", onRequestAbort, { once: true });
    const state: ActiveExchange = { request: parsed, channel, controller };
    const key = operationKey(frame.routeId, frame.operationId);
    this.#active.set(key, state);
    try {
      let terminal: FabricStreamFrameV1;
      try {
        const value = await this.dispatcher.dispatch({
          version: FABRIC_ENDPOINT_REQUEST_VERSION,
          requestId: parsed.requestId,
          routeId: frame.routeId,
          endpointId: parsed.endpointId,
          endpointKind: endpointKind(parsed.endpointKind),
          endpointGeneration: parsed.endpointGeneration,
          deadlineAt: parsed.deadlineAt,
          operation: payload.operation,
          input,
        }, principal, controller.signal);
        terminal = { ...frame, sequence: frame.sequence + 1, kind: "end", sentAt: this.#now(), payload: { result: value } };
      } catch (error) {
        const normalized = error instanceof FabricContractError ? error : new FabricContractError("unavailable", "Fabric Endpoint dispatch failed");
        terminal = { ...frame, sequence: frame.sequence + 1, kind: "error", sentAt: this.#now(), payload: { code: normalized.code, message: normalized.message.slice(0, 1024) } };
      }
      return this.#result(parsed, terminal);
    } finally {
      requestSignal.removeEventListener("abort", onRequestAbort);
      if (this.#active.get(key) === state) this.#active.delete(key);
      this.#channels.unbind(frame.routeId, frame.operationId);
      await channel.close("Fabric HTTPS exchange completed").catch(() => undefined);
    }
  }

  async #cancel(parsed: FabricHttpsExchangeRequestV1): Promise<FabricHttpsExchangeResultV1> {
    const frame = parsed.frame;
    const key = operationKey(frame.routeId, frame.operationId);
    const state = this.#active.get(key);
    const routed = this.#channels.get(frame.routeId, frame.operationId);
    if (state === undefined || routed === undefined || routed !== state.channel) {
      throw new FabricContractError("invalid_state", "Fabric HTTPS cancel has no active route operation", "frame.operationId");
    }
    const open = state.request;
    if (parsed.requestId !== open.requestId || parsed.endpointId !== open.endpointId || parsed.endpointKind !== open.endpointKind || parsed.endpointGeneration !== open.endpointGeneration || parsed.deadlineAt !== open.deadlineAt) {
      throw new FabricContractError("conflict", "Fabric HTTPS cancel correlation does not match the active exchange", "requestId");
    }
    if (frame.streamId !== open.frame.streamId) {
      throw new FabricContractError("conflict", "Fabric HTTPS cancel stream does not match the active exchange", "frame.streamId");
    }
    state.channel.accept(frame); // validates exact route, operation, stream, and monotonic sequence
    state.controller.abort(new FabricContractError("cancelled", "Fabric HTTPS cancel frame received"));
    return this.#result(parsed, {
      ...frame,
      sequence: frame.sequence + 1,
      kind: "end",
      sentAt: this.#now(),
      payload: { cancelled: true },
    });
  }

  #validateEnvelope(parsed: FabricHttpsExchangeRequestV1): void {
    if (parsed.version !== FABRIC_HTTPS_EXCHANGE_VERSION || parsed.kind !== "exchange") throw new FabricContractError("unsupported_version", "Unsupported Fabric HTTPS exchange request", "version");
    assertFabricIdentifier(parsed.requestId, "requestId");
    assertFabricIdentifier(parsed.endpointId, "endpointId");
    endpointKind(parsed.endpointKind);
    integer(parsed.endpointGeneration, "endpointGeneration", 1);
    assertEpochMilliseconds(parsed.deadlineAt, "deadlineAt");
    if (this.#now() >= parsed.deadlineAt) throw new FabricContractError("deadline_exceeded", "Fabric HTTPS request deadline has passed", "deadlineAt");
    assertValidFabricStreamFrame(parsed.frame);
    if (bytes(parsed.frame) > this.limits.maxFrameBytes) throw new FabricContractError("resource_exhausted", "Fabric HTTPS frame exceeds maxFrameBytes", "maxFrameBytes");
  }

  #result(request: FabricHttpsExchangeRequestV1, frame: FabricStreamFrameV1): FabricHttpsExchangeResultV1 {
    return {
      version: FABRIC_HTTPS_EXCHANGE_VERSION,
      kind: "result",
      requestId: request.requestId,
      endpointId: request.endpointId,
      endpointKind: endpointKind(request.endpointKind),
      endpointGeneration: request.endpointGeneration,
      deadlineAt: request.deadlineAt,
      frame,
    };
  }

  async #readEvents(response: ServerResponse, url: URL): Promise<void> {
    const requestId = url.searchParams.get("requestId") ?? "";
    const routeId = url.searchParams.get("routeId") ?? "";
    const endpointId = url.searchParams.get("endpointId") ?? "";
    const kind = endpointKind(url.searchParams.get("endpointKind"));
    const endpointGeneration = integer(url.searchParams.get("endpointGeneration"), "endpointGeneration", 1);
    const deadlineAt = integer(url.searchParams.get("deadlineAt"), "deadlineAt", 0);
    const afterSequence = integer(url.searchParams.get("afterSequence"), "afterSequence", 0);
    const requestedLimit = integer(url.searchParams.get("limit") ?? this.limits.maxEventRead, "limit", 1);
    assertFabricIdentifier(requestId, "requestId");
    assertFabricIdentifier(routeId, "routeId");
    assertFabricIdentifier(endpointId, "endpointId");
    if (requestedLimit > this.limits.maxEventRead) throw new FabricContractError("resource_exhausted", "Fabric event read exceeds maxEventRead", "limit");
    this.dispatcher.authorize({ routeId, endpointId, endpointKind: kind, endpointGeneration, deadlineAt });
    const events = (this.#events.get(routeId) ?? []).filter((event) => event.sequence > afterSequence).slice(0, requestedLimit);
    const nextSequence = events.at(-1)?.sequence ?? afterSequence;
    const result: FabricHttpsEventsResultV1 = {
      version: FABRIC_HTTPS_EVENTS_VERSION,
      kind: "events",
      requestId,
      routeId,
      endpointId,
      endpointKind: kind,
      endpointGeneration,
      deadlineAt,
      nextSequence,
      events: structuredClone(events),
    };
    if (bytes(result) > this.limits.maxResultBytes) throw new FabricContractError("resource_exhausted", "Fabric events result exceeds maxResultBytes", "maxResultBytes");
    this.#json(response, 200, result);
  }

  async #readJson(request: IncomingMessage): Promise<unknown> {
    const declared = Number(request.headers["content-length"]);
    if (Number.isFinite(declared) && declared > this.limits.maxRequestBytes) throw new FabricContractError("resource_exhausted", "Fabric HTTP request exceeds maxRequestBytes");
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > this.limits.maxRequestBytes) throw new FabricContractError("resource_exhausted", "Fabric HTTP request exceeds maxRequestBytes");
      chunks.push(buffer);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new FabricContractError("invalid_argument", "Fabric HTTP request body must be valid JSON"); }
  }

  #json(response: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value);
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
    response.end(body);
  }

  #status(error: FabricContractError): number {
    if (error.code === "permission_denied") return 403;
    if (error.code === "not_found") return 404;
    if (error.code === "resource_exhausted") return 413;
    if (error.code === "deadline_exceeded") return 408;
    return 400;
  }

  get pendingRequestCount(): number { return this.#pendingRequests; }
  get activeExchangeCount(): number { return this.#active.size; }
}
