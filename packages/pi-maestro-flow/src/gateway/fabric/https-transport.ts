import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import {
  FABRIC_ERROR_CODES,
  FabricContractError,
  assertEpochMilliseconds,
  assertFabricIdentifier,
  assertValidFabricStreamFrame,
  type FabricStreamFrameV1,
  type JsonValue,
} from "pi-maestro-fabric-core/v1";
import type { FabricEndpointKind } from "./endpoint-dispatcher.ts";

export const FABRIC_HTTPS_EXCHANGE_VERSION = "fabric.https.exchange.v1" as const;
export const FABRIC_HTTPS_EVENTS_VERSION = "fabric.https.events.v1" as const;
export const FABRIC_HTTPS_EXCHANGE_PATH = "/fabric/v1/exchange" as const;
export const FABRIC_HTTPS_EVENTS_PATH = "/fabric/v1/events" as const;

export interface FabricHttpsExchangeRequestV1 {
  readonly version: typeof FABRIC_HTTPS_EXCHANGE_VERSION;
  readonly kind: "exchange";
  readonly requestId: string;
  readonly endpointId: string;
  readonly endpointKind: FabricEndpointKind;
  readonly endpointGeneration: number;
  readonly deadlineAt: number;
  readonly frame: FabricStreamFrameV1;
}

export interface FabricHttpsExchangeResultV1 {
  readonly version: typeof FABRIC_HTTPS_EXCHANGE_VERSION;
  readonly kind: "result";
  readonly requestId: string;
  readonly endpointId: string;
  readonly endpointKind: FabricEndpointKind;
  readonly endpointGeneration: number;
  readonly deadlineAt: number;
  readonly frame: FabricStreamFrameV1;
}

export interface FabricHttpsEventV1 {
  readonly sequence: number;
  readonly routeId: string;
  readonly endpointId: string;
  readonly endpointKind: FabricEndpointKind;
  readonly endpointGeneration: number;
  readonly occurredAt: number;
  readonly payload: Readonly<Record<string, JsonValue>>;
}

export interface FabricHttpsEventsResultV1 {
  readonly version: typeof FABRIC_HTTPS_EVENTS_VERSION;
  readonly kind: "events";
  readonly requestId: string;
  readonly routeId: string;
  readonly endpointId: string;
  readonly endpointKind: FabricEndpointKind;
  readonly endpointGeneration: number;
  readonly deadlineAt: number;
  readonly nextSequence: number;
  readonly events: readonly FabricHttpsEventV1[];
}

export interface FabricHttpsTransportLimits {
  readonly maxRequestBytes: number;
  readonly maxResultBytes: number;
  readonly maxFrameBytes: number;
  readonly maxEvents: number;
  readonly maxPendingRequests: number;
}

export interface FabricHttpsTransportOptions {
  readonly baseUrl: URL | string;
  readonly token: string;
  /** Explicit trust root for the paired Gateway. System roots remain available when omitted. */
  readonly ca?: string | Buffer | (string | Buffer)[];
  readonly limits?: Partial<FabricHttpsTransportLimits>;
  readonly now?: () => number;
}

export interface FabricHttpsDispatchInput {
  readonly routeId: string;
  readonly endpointId: string;
  readonly endpointKind: FabricEndpointKind;
  readonly endpointGeneration: number;
  readonly deadlineAt: number;
  readonly operation: string;
  readonly input: Readonly<Record<string, JsonValue>>;
  readonly requestId?: string;
  readonly operationId?: string;
  readonly streamId?: string;
}

export interface FabricPinnedCaFetchOptions {
  readonly ca?: FabricHttpsTransportOptions["ca"];
  readonly maxResponseBytes: number;
  /** Optional absolute bound for a source whose caller does not supply an aborting signal. */
  readonly deadlineAt?: number;
  readonly now?: () => number;
}

const DEFAULT_LIMITS: FabricHttpsTransportLimits = {
  maxRequestBytes: 1024 * 1024,
  maxResultBytes: 1024 * 1024,
  maxFrameBytes: 1024 * 1024,
  maxEvents: 256,
  maxPendingRequests: 64,
};

function limit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new FabricContractError("invalid_argument", `${name} must be a positive safe integer`, name);
  return result;
}

function bytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { return Number.POSITIVE_INFINITY; }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FabricContractError("protocol_violation", `${path} must be an object`, path);
  return value as Record<string, unknown>;
}

function plainJsonRecord(value: unknown, path: string, maximumBytes: number): Record<string, JsonValue> {
  const result = record(value, path);
  const prototype = Object.getPrototypeOf(result);
  if (prototype !== Object.prototype && prototype !== null) throw new FabricContractError("protocol_violation", `${path} must be a plain JSON object`, path);
  const length = bytes(result);
  if (!Number.isFinite(length)) throw new FabricContractError("protocol_violation", `${path} must contain plain JSON values`, path);
  if (length > maximumBytes) throw new FabricContractError("resource_exhausted", `${path} exceeds its configured bound`, path);
  return result as Record<string, JsonValue>;
}

function endpointKind(value: unknown, path: string): FabricEndpointKind {
  if (value !== "mcp" && value !== "agent") throw new FabricContractError("protocol_violation", `${path} is invalid`, path);
  return value;
}

function positiveGeneration(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new FabricContractError("protocol_violation", `${path} must be a positive safe integer`, path);
  return value as number;
}

function safeSequence(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new FabricContractError("protocol_violation", `${path} must be a safe integer`, path);
  return value as number;
}

function validateExchangeRequest(request: FabricHttpsExchangeRequestV1, now: number, maxFrameBytes: number): void {
  if (request.version !== FABRIC_HTTPS_EXCHANGE_VERSION || request.kind !== "exchange") throw new FabricContractError("unsupported_version", "Unsupported Fabric HTTPS exchange request", "version");
  assertFabricIdentifier(request.requestId, "requestId");
  assertFabricIdentifier(request.endpointId, "endpointId");
  endpointKind(request.endpointKind, "endpointKind");
  positiveGeneration(request.endpointGeneration, "endpointGeneration");
  assertEpochMilliseconds(request.deadlineAt, "deadlineAt");
  if (now >= request.deadlineAt) throw new FabricContractError("deadline_exceeded", "Fabric HTTPS request deadline has passed", "deadlineAt");
  assertValidFabricStreamFrame(request.frame);
  if (request.frame.kind !== "open" && request.frame.kind !== "cancel") {
    throw new FabricContractError("protocol_violation", "Unary Fabric HTTPS exchange accepts only open or cancel frames", "frame.kind");
  }
  if (bytes(request.frame) > maxFrameBytes) throw new FabricContractError("resource_exhausted", "Fabric HTTPS frame exceeds maxFrameBytes", "maxFrameBytes");
}

/** Real TLS transport for correlated open/cancel Fabric exchanges. */
export class FabricHttpsTransport {
  readonly baseUrl: URL;
  readonly limits: Readonly<FabricHttpsTransportLimits>;
  readonly #token: string;
  readonly #ca?: FabricHttpsTransportOptions["ca"];
  readonly #now: () => number;
  #pending = 0;

  constructor(options: FabricHttpsTransportOptions) {
    this.baseUrl = new URL(options.baseUrl);
    if (this.baseUrl.protocol !== "https:") throw new FabricContractError("permission_denied", "Fabric Gateway transport requires HTTPS", "baseUrl");
    if (this.baseUrl.username || this.baseUrl.password || this.baseUrl.hash || this.baseUrl.search) throw new FabricContractError("invalid_argument", "Fabric Gateway URL must not contain credentials, query, or fragment", "baseUrl");
    if (!options.token) throw new FabricContractError("invalid_argument", "Paired Gateway token is required", "token");
    this.#token = options.token;
    this.#ca = options.ca;
    this.#now = options.now ?? Date.now;
    this.limits = Object.freeze({
      maxRequestBytes: limit(options.limits?.maxRequestBytes, DEFAULT_LIMITS.maxRequestBytes, "maxRequestBytes"),
      maxResultBytes: limit(options.limits?.maxResultBytes, DEFAULT_LIMITS.maxResultBytes, "maxResultBytes"),
      maxFrameBytes: limit(options.limits?.maxFrameBytes, DEFAULT_LIMITS.maxFrameBytes, "maxFrameBytes"),
      maxEvents: limit(options.limits?.maxEvents, DEFAULT_LIMITS.maxEvents, "maxEvents"),
      maxPendingRequests: limit(options.limits?.maxPendingRequests, DEFAULT_LIMITS.maxPendingRequests, "maxPendingRequests"),
    });
  }

  async dispatch(input: FabricHttpsDispatchInput, signal: AbortSignal): Promise<JsonValue> {
    if (signal.aborted) throw new FabricContractError("cancelled", "Fabric HTTPS request was cancelled");
    const requestId = input.requestId ?? randomUUID();
    const operationId = input.operationId ?? requestId;
    const streamId = input.streamId ?? randomUUID();
    const frame: FabricStreamFrameV1 = {
      version: "fabric.stream.v1",
      streamId,
      routeId: input.routeId,
      operationId,
      sequence: 0,
      kind: "open",
      sentAt: this.#now(),
      payload: { operation: input.operation, input: input.input },
    };
    const request: FabricHttpsExchangeRequestV1 = {
      version: FABRIC_HTTPS_EXCHANGE_VERSION,
      kind: "exchange",
      requestId,
      endpointId: input.endpointId,
      endpointKind: input.endpointKind,
      endpointGeneration: input.endpointGeneration,
      deadlineAt: input.deadlineAt,
      frame,
    };
    const openController = new AbortController();
    let cancelDelivery: Promise<void> | undefined;
    const onAbort = (): void => {
      const cancel: FabricHttpsExchangeRequestV1 = {
        ...request,
        frame: { ...frame, sequence: 1, kind: "cancel", sentAt: this.#now(), payload: { reason: "caller_cancelled" } },
      };
      cancelDelivery = this.exchange(cancel, new AbortController().signal).then(() => undefined).catch(() => undefined).finally(() => openController.abort());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await this.exchange(request, openController.signal);
      if (signal.aborted) throw new FabricContractError("cancelled", "Fabric HTTPS request was cancelled");
      if (result.frame.kind === "error") {
        const rawCode = result.frame.payload.code;
        if (typeof rawCode !== "string" || !FABRIC_ERROR_CODES.includes(rawCode as never)) {
          throw new FabricContractError("protocol_violation", "Fabric Endpoint returned an invalid error code");
        }
        const message = typeof result.frame.payload.message === "string" ? result.frame.payload.message : "Fabric Endpoint failed";
        throw new FabricContractError(rawCode as (typeof FABRIC_ERROR_CODES)[number], message);
      }
      if (result.frame.kind !== "end" || !("result" in result.frame.payload)) {
        throw new FabricContractError("protocol_violation", "Fabric HTTPS result frame is not terminal", "frame.kind");
      }
      return structuredClone(result.frame.payload.result as JsonValue);
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (cancelDelivery !== undefined) await cancelDelivery;
    }
  }

  async exchange(request: FabricHttpsExchangeRequestV1, signal: AbortSignal): Promise<FabricHttpsExchangeResultV1> {
    validateExchangeRequest(request, this.#now(), this.limits.maxFrameBytes);
    const raw = await this.#post(FABRIC_HTTPS_EXCHANGE_PATH, request, signal, request.deadlineAt);
    const result = record(raw, "exchangeResult") as unknown as FabricHttpsExchangeResultV1;
    if (result.version !== FABRIC_HTTPS_EXCHANGE_VERSION || result.kind !== "result") throw new FabricContractError("protocol_violation", "Fabric HTTPS response has the wrong result kind", "kind");
    if (result.requestId !== request.requestId || result.endpointId !== request.endpointId || result.endpointKind !== request.endpointKind || result.endpointGeneration !== request.endpointGeneration || result.deadlineAt !== request.deadlineAt) {
      throw new FabricContractError("conflict", "Fabric HTTPS result correlation does not match its request", "requestId");
    }
    assertValidFabricStreamFrame(result.frame);
    if (result.frame.streamId !== request.frame.streamId || result.frame.routeId !== request.frame.routeId || result.frame.operationId !== request.frame.operationId || result.frame.sequence <= request.frame.sequence) {
      throw new FabricContractError("conflict", "Fabric HTTPS result frame correlation is invalid", "frame");
    }
    if (result.frame.kind !== "end" && result.frame.kind !== "error") throw new FabricContractError("protocol_violation", "Fabric HTTPS response must contain a terminal result frame", "frame.kind");
    if (bytes(result.frame) > this.limits.maxFrameBytes) throw new FabricContractError("resource_exhausted", "Fabric HTTPS result frame exceeds maxFrameBytes", "maxFrameBytes");
    if (bytes(result) > this.limits.maxResultBytes) throw new FabricContractError("resource_exhausted", "Fabric HTTPS result exceeds maxResultBytes", "maxResultBytes");
    if (this.#now() >= request.deadlineAt) throw new FabricContractError("deadline_exceeded", "Fabric HTTPS result arrived after its deadline", "deadlineAt");
    return structuredClone(result);
  }

  async events(input: Omit<FabricHttpsEventsResultV1, "version" | "kind" | "nextSequence" | "events"> & { afterSequence: number; limit?: number }, signal: AbortSignal): Promise<FabricHttpsEventsResultV1> {
    assertFabricIdentifier(input.requestId, "requestId");
    assertFabricIdentifier(input.routeId, "routeId");
    assertFabricIdentifier(input.endpointId, "endpointId");
    endpointKind(input.endpointKind, "endpointKind");
    positiveGeneration(input.endpointGeneration, "endpointGeneration");
    assertEpochMilliseconds(input.deadlineAt, "deadlineAt");
    if (this.#now() >= input.deadlineAt) throw new FabricContractError("deadline_exceeded", "Fabric HTTPS events deadline has passed", "deadlineAt");
    const requestedLimit = input.limit ?? this.limits.maxEvents;
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0 || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > this.limits.maxEvents) {
      throw new FabricContractError("invalid_argument", "Fabric HTTPS event cursor or limit is invalid");
    }
    const url = new URL(FABRIC_HTTPS_EVENTS_PATH, this.baseUrl);
    for (const [key, value] of Object.entries({ ...input, limit: requestedLimit })) url.searchParams.set(key, String(value));
    const raw = await this.#request(url, "GET", undefined, signal, input.deadlineAt);
    if (bytes(raw) > this.limits.maxResultBytes) throw new FabricContractError("resource_exhausted", "Fabric HTTPS events result exceeds maxResultBytes", "maxResultBytes");
    const result = record(raw, "eventsResult") as unknown as FabricHttpsEventsResultV1;
    if (result.version !== FABRIC_HTTPS_EVENTS_VERSION || result.kind !== "events") throw new FabricContractError("protocol_violation", "Fabric HTTPS response has the wrong events kind", "kind");
    for (const key of ["requestId", "routeId", "endpointId", "endpointKind", "endpointGeneration", "deadlineAt"] as const) {
      if (result[key] !== input[key]) throw new FabricContractError("conflict", "Fabric HTTPS events correlation does not match its request", key);
    }
    if (!Array.isArray(result.events)) throw new FabricContractError("protocol_violation", "Fabric HTTPS events must be an array", "events");
    if (result.events.length > requestedLimit || result.events.length > this.limits.maxEvents) throw new FabricContractError("resource_exhausted", "Fabric HTTPS event result exceeds its bound", "events");
    let sequence = input.afterSequence;
    for (let index = 0; index < result.events.length; index += 1) {
      const event = record(result.events[index], `events[${index}]`);
      const eventSequence = safeSequence(event.sequence, `events[${index}].sequence`, 1);
      if (eventSequence <= sequence) throw new FabricContractError("protocol_violation", "Fabric HTTPS event sequence is not increasing", `events[${index}].sequence`);
      if (event.routeId !== input.routeId || event.endpointId !== input.endpointId || event.endpointKind !== input.endpointKind || event.endpointGeneration !== input.endpointGeneration) {
        throw new FabricContractError("protocol_violation", "Fabric HTTPS event identity is invalid", `events[${index}]`);
      }
      assertEpochMilliseconds(event.occurredAt, `events[${index}].occurredAt`);
      plainJsonRecord(event.payload, `events[${index}].payload`, this.limits.maxFrameBytes);
      if (bytes(event) > this.limits.maxFrameBytes) throw new FabricContractError("resource_exhausted", "Fabric HTTPS event exceeds maxFrameBytes", `events[${index}]`);
      sequence = eventSequence;
    }
    const nextSequence = safeSequence(result.nextSequence, "nextSequence");
    if (nextSequence !== sequence) throw new FabricContractError("protocol_violation", "Fabric HTTPS event cursor is invalid", "nextSequence");
    return structuredClone(result);
  }

  async #post(path: string, body: unknown, signal: AbortSignal, deadlineAt: number): Promise<unknown> {
    if (bytes(body) > this.limits.maxRequestBytes) throw new FabricContractError("resource_exhausted", "Fabric HTTPS request exceeds maxRequestBytes", "maxRequestBytes");
    return this.#request(new URL(path, this.baseUrl), "POST", Buffer.from(JSON.stringify(body), "utf8"), signal, deadlineAt);
  }

  async #request(url: URL, method: "GET" | "POST", body: Buffer | undefined, signal: AbortSignal, deadlineAt: number): Promise<unknown> {
    if (signal.aborted) throw new FabricContractError("cancelled", "Fabric HTTPS request was cancelled");
    if (this.#pending >= this.limits.maxPendingRequests) throw new FabricContractError("resource_exhausted", "Fabric HTTPS request queue is full", "maxPendingRequests");
    const remaining = deadlineAt - this.#now();
    if (remaining <= 0) throw new FabricContractError("deadline_exceeded", "Fabric HTTPS request deadline has passed", "deadlineAt");
    this.#pending += 1;
    try {
      return await new Promise<unknown>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(deadlineTimer);
          signal.removeEventListener("abort", onAbort);
          callback();
        };
        const request = httpsRequest(url, {
          method,
          ca: this.#ca,
          // Certificate and hostname verification are never disabled.
          headers: {
            authorization: `Bearer ${this.#token}`,
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json", "content-length": body.byteLength }),
          },
        }, (response) => {
          response.on("error", (error: unknown) => finish(() => reject(error instanceof FabricContractError ? error : new FabricContractError("unavailable", "Fabric HTTPS response failed"))));
          const declared = Number(response.headers["content-length"]);
          if (Number.isFinite(declared) && declared > this.limits.maxResultBytes) {
            response.destroy(new FabricContractError("resource_exhausted", "Fabric HTTPS response exceeds maxResultBytes", "maxResultBytes"));
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          response.on("data", (chunk: Buffer) => {
            total += chunk.byteLength;
            if (total > this.limits.maxResultBytes) response.destroy(new FabricContractError("resource_exhausted", "Fabric HTTPS response exceeds maxResultBytes", "maxResultBytes"));
            else chunks.push(chunk);
          });
          response.on("end", () => finish(() => {
            const text = Buffer.concat(chunks).toString("utf8");
            if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) return reject(new FabricContractError("unavailable", `Fabric HTTPS request failed with status ${response.statusCode}: ${text.slice(0, 512)}`));
            try { resolve(JSON.parse(text)); }
            catch { reject(new FabricContractError("protocol_violation", "Fabric HTTPS response is not valid JSON")); }
          }));
        });
        const onAbort = (): void => { request.destroy(new FabricContractError("cancelled", "Fabric HTTPS request was cancelled")); };
        const deadlineTimer = setTimeout(() => { request.destroy(new FabricContractError("deadline_exceeded", "Fabric HTTPS request deadline has passed", "deadlineAt")); }, remaining);
        deadlineTimer.unref?.();
        signal.addEventListener("abort", onAbort, { once: true });
        request.on("error", (error: unknown) => finish(() => reject(error instanceof FabricContractError ? error : new FabricContractError("unavailable", "Fabric HTTPS request failed"))));
        if (body !== undefined) request.write(body);
        request.end();
      });
    } finally {
      this.#pending -= 1;
    }
  }
}

/** Fetch adapter for an explicitly supplied CA and bounded MCP source response. */
export function createFabricPinnedCaFetch(options: FabricPinnedCaFetchOptions): NonNullable<StreamableHttpFetch> {
  const maximum = limit(options.maxResponseBytes, 0, "maxResponseBytes");
  const now = options.now ?? Date.now;
  if (options.deadlineAt !== undefined) assertEpochMilliseconds(options.deadlineAt, "deadlineAt");
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
    if (url.protocol !== "https:") throw new FabricContractError("permission_denied", "Pinned Fabric fetch requires HTTPS", "url");
    const sourceHeaders = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => sourceHeaders.set(key, value));
    const rawBody = init?.body ?? (input instanceof Request ? input.body : undefined);
    let body: Buffer | undefined;
    if (typeof rawBody === "string") body = Buffer.from(rawBody);
    else if (rawBody instanceof Uint8Array) body = Buffer.from(rawBody);
    else if (rawBody !== undefined && rawBody !== null) body = Buffer.from(await new Response(rawBody).arrayBuffer());
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) throw new FabricContractError("cancelled", "Fabric MCP source request was cancelled");
    const remaining = options.deadlineAt === undefined ? undefined : options.deadlineAt - now();
    if (remaining !== undefined && remaining <= 0) throw new FabricContractError("deadline_exceeded", "Fabric MCP source deadline has passed", "deadlineAt");

    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        callback();
      };
      const request = httpsRequest(url, {
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        headers: Object.fromEntries(sourceHeaders.entries()),
        ca: options.ca,
        // Certificate and hostname verification are never disabled.
      }, (response) => {
        response.on("error", (error: unknown) => finish(() => reject(error instanceof FabricContractError ? error : new FabricContractError("unavailable", "Fabric MCP source response failed"))));
        const declared = Number(response.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maximum) {
          response.destroy(new FabricContractError("resource_exhausted", "Fabric MCP source response exceeds maxResponseBytes", "maxResponseBytes"));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > maximum) response.destroy(new FabricContractError("resource_exhausted", "Fabric MCP source response exceeds maxResponseBytes", "maxResponseBytes"));
          else chunks.push(chunk);
        });
        response.on("end", () => finish(() => resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 500,
          statusText: response.statusMessage,
          headers: response.headers as HeadersInit,
        }))));
      });
      const onAbort = (): void => { request.destroy(new FabricContractError("cancelled", "Fabric MCP source request was cancelled")); };
      const timer = remaining === undefined ? undefined : setTimeout(() => { request.destroy(new FabricContractError("deadline_exceeded", "Fabric MCP source deadline has passed", "deadlineAt")); }, remaining);
      timer?.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      request.on("error", (error: unknown) => finish(() => reject(error instanceof FabricContractError ? error : new FabricContractError("unavailable", "Fabric MCP source request failed"))));
      if (body !== undefined) request.write(body);
      request.end();
    });
  };
}

type StreamableHttpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
