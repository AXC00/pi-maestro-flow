import {
  FabricContractError,
  assertEpochMilliseconds,
  assertFabricIdentifier,
  type EndpointRecord,
  type EndpointRouteHandle,
  type JsonValue,
} from "pi-maestro-fabric-core/v1";
import type { GatewayPrincipal } from "../contracts.ts";

export const FABRIC_ENDPOINT_REQUEST_VERSION = "fabric.endpoint-request.v1" as const;
export type FabricEndpointKind = EndpointRecord["kind"];

export interface FabricRouteAuthority {
  validateRoute(routeId: string): EndpointRouteHandle;
}

export interface FabricEndpointDirectory {
  getEndpoint(endpointId: string): EndpointRecord | undefined;
}

export interface FabricEndpointDispatchRequestV1 {
  readonly version: typeof FABRIC_ENDPOINT_REQUEST_VERSION;
  readonly requestId: string;
  readonly routeId: string;
  readonly endpointId: string;
  readonly endpointKind: FabricEndpointKind;
  readonly endpointGeneration: number;
  readonly deadlineAt: number;
  readonly operation: string;
  readonly input: Readonly<Record<string, JsonValue>>;
}

export interface FabricEndpointDispatchContext {
  readonly request: FabricEndpointDispatchRequestV1;
  readonly route: EndpointRouteHandle;
  readonly endpoint: EndpointRecord;
  readonly principal: GatewayPrincipal;
  readonly signal: AbortSignal;
}

export interface FabricEndpointHandler {
  handle(context: FabricEndpointDispatchContext): Promise<JsonValue>;
}

export interface FabricEndpointRegistration {
  readonly endpointId: string;
  readonly kind: FabricEndpointKind;
  readonly handler: FabricEndpointHandler;
  /** Present only for a remote, generation-owned transport registration. */
  readonly ownerId?: string;
  readonly connectionId?: string;
  readonly connectionGeneration?: number;
  readonly endpointGeneration?: number;
}

export interface FabricEndpointDispatcherOptions {
  readonly routes: FabricRouteAuthority;
  readonly endpoints: FabricEndpointDirectory;
  readonly registrations?: readonly FabricEndpointRegistration[];
  readonly maxPendingRequests?: number;
  readonly maxRequestBytes?: number;
  readonly maxResultBytes?: number;
  readonly now?: () => number;
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new FabricContractError("invalid_argument", `${label} must be a positive safe integer`, label);
  return result;
}

function byteLength(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
  catch { return Number.POSITIVE_INFINITY; }
}

function assertGeneration(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new FabricContractError("invalid_argument", `${path} must be a positive safe integer`, path);
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FabricContractError("invalid_argument", `${path} must be a JSON object`, path);
  }
  try { JSON.stringify(value); } catch { throw new FabricContractError("invalid_argument", `${path} must be JSON serializable`, path); }
}

/**
 * Selects exactly the Endpoint named by the current route. It never performs a
 * first-match lookup and revalidates route/Endpoint generations on both sides
 * of the operation.
 */
export class FabricEndpointDispatcher {
  readonly routes: FabricRouteAuthority;
  readonly endpoints: FabricEndpointDirectory;
  readonly #registrations = new Map<string, FabricEndpointRegistration>();
  readonly #maxPendingRequests: number;
  readonly #maxRequestBytes: number;
  readonly #maxResultBytes: number;
  readonly #now: () => number;
  #pendingRequests = 0;

  constructor(options: FabricEndpointDispatcherOptions) {
    this.routes = options.routes;
    this.endpoints = options.endpoints;
    this.#maxPendingRequests = positiveLimit(options.maxPendingRequests, 64, "maxPendingRequests");
    this.#maxRequestBytes = positiveLimit(options.maxRequestBytes, 1024 * 1024, "maxRequestBytes");
    this.#maxResultBytes = positiveLimit(options.maxResultBytes, 1024 * 1024, "maxResultBytes");
    this.#now = options.now ?? Date.now;
    for (const registration of options.registrations ?? []) this.register(registration);
  }

  register(registration: FabricEndpointRegistration): () => boolean {
    assertFabricIdentifier(registration.endpointId, "endpointId");
    if (registration.kind !== "mcp" && registration.kind !== "agent") {
      throw new FabricContractError("invalid_argument", "Unsupported Fabric Endpoint kind", "kind");
    }
    const ownedFields = [registration.ownerId, registration.connectionId, registration.connectionGeneration, registration.endpointGeneration];
    if (ownedFields.some((value) => value !== undefined) && ownedFields.some((value) => value === undefined)) {
      throw new FabricContractError("invalid_argument", "Owned Endpoint registration requires its complete generation tuple", "ownerId");
    }
    if (registration.ownerId !== undefined) {
      assertFabricIdentifier(registration.ownerId, "ownerId");
      assertFabricIdentifier(registration.connectionId, "connectionId");
      assertGeneration(registration.connectionGeneration, "connectionGeneration");
      assertGeneration(registration.endpointGeneration, "endpointGeneration");
    }
    if (this.#registrations.has(registration.endpointId)) {
      throw new FabricContractError("conflict", "Fabric Endpoint already has a dispatcher registration", "endpointId");
    }
    this.#registrations.set(registration.endpointId, registration);
    let disposed = false;
    return () => {
      if (disposed) return false;
      disposed = true;
      return this.unregister(registration.endpointId, registration);
    };
  }

  unregister(endpointId: string, expected?: FabricEndpointRegistration): boolean {
    assertFabricIdentifier(endpointId, "endpointId");
    const current = this.#registrations.get(endpointId);
    if (current === undefined || (expected !== undefined && current !== expected)) return false;
    return this.#registrations.delete(endpointId);
  }

  /** Validate and return the route/Endpoint tuple used by exchange and events. */
  authorize(input: Pick<FabricEndpointDispatchRequestV1, "routeId" | "endpointId" | "endpointKind" | "endpointGeneration" | "deadlineAt">): {
    route: EndpointRouteHandle;
    endpoint: EndpointRecord;
  } {
    assertFabricIdentifier(input.routeId, "routeId");
    assertFabricIdentifier(input.endpointId, "endpointId");
    assertGeneration(input.endpointGeneration, "endpointGeneration");
    assertEpochMilliseconds(input.deadlineAt, "deadlineAt");
    const now = this.#now();
    if (now >= input.deadlineAt) throw new FabricContractError("deadline_exceeded", "Fabric request deadline has passed", "deadlineAt");
    const route = this.routes.validateRoute(input.routeId);
    if (input.deadlineAt > route.expiresAt) throw new FabricContractError("deadline_exceeded", "Fabric request deadline exceeds the route lease", "deadlineAt");
    if (route.endpointId !== input.endpointId || route.endpointGeneration !== input.endpointGeneration) {
      throw new FabricContractError("stale_generation", "Fabric request does not match the route's current Endpoint", "endpointId");
    }
    const endpoint = this.endpoints.getEndpoint(route.endpointId);
    if (endpoint === undefined) throw new FabricContractError("not_found", "Fabric route Endpoint is not registered", "endpointId");
    if (endpoint.endpointId !== input.endpointId || endpoint.generation !== input.endpointGeneration) {
      throw new FabricContractError("stale_generation", "Fabric route Endpoint generation is stale", "endpointGeneration");
    }
    if (endpoint.kind !== input.endpointKind) {
      throw new FabricContractError("conflict", "Fabric request Endpoint kind does not match the current Endpoint", "endpointKind");
    }
    return { route, endpoint };
  }

  async dispatch(request: FabricEndpointDispatchRequestV1, principal: GatewayPrincipal, signal: AbortSignal): Promise<JsonValue> {
    assertFabricIdentifier(request.requestId, "requestId");
    if (request.version !== FABRIC_ENDPOINT_REQUEST_VERSION) throw new FabricContractError("unsupported_version", "Unsupported Fabric Endpoint request version", "version");
    if (typeof request.operation !== "string" || request.operation.length === 0 || Buffer.byteLength(request.operation, "utf8") > 128) {
      throw new FabricContractError("invalid_argument", "Fabric Endpoint operation is invalid", "operation");
    }
    assertRecord(request.input, "input");
    if (byteLength(request) > this.#maxRequestBytes) throw new FabricContractError("resource_exhausted", "Fabric Endpoint request is too large", "maxRequestBytes");
    if (signal.aborted) throw new FabricContractError("cancelled", "Fabric Endpoint request was cancelled");
    if (this.#pendingRequests >= this.#maxPendingRequests) throw new FabricContractError("resource_exhausted", "Fabric Endpoint request queue is full", "maxPendingRequests");
    this.#pendingRequests += 1;
    const controller = new AbortController();
    const remaining = request.deadlineAt - this.#now();
    let timedOut = false;
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new FabricContractError("deadline_exceeded", "Fabric Endpoint request deadline has passed", "deadlineAt"));
    }, Math.max(0, remaining));
    try {
      const { route, endpoint } = this.authorize(request);
      const registration = this.#registrations.get(endpoint.endpointId);
      if (registration === undefined) throw new FabricContractError("not_found", "Fabric Endpoint has no local transport registration", "endpointId");
      if (registration.kind !== endpoint.kind) throw new FabricContractError("conflict", "Fabric Endpoint registration kind is stale", "endpointKind");
      if (registration.ownerId !== undefined && (
        registration.connectionId !== route.connectionId ||
        registration.connectionGeneration !== route.connectionGeneration ||
        registration.endpointGeneration !== endpoint.generation
      )) {
        throw new FabricContractError("stale_generation", "Fabric Endpoint transport registration is stale", "endpointGeneration");
      }

      // Observe both fulfillment and rejection even if cancellation wins. The
      // dispatcher must release admission capacity without waiting for a
      // non-cooperative handler, while late rejections remain handled.
      const handler = Promise.resolve().then(() => registration.handler.handle({
        request, route, endpoint, principal, signal: controller.signal,
      }));
      const observedHandler = handler.then(
        (value) => ({ kind: "value" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const cancelled = new Promise<{ kind: "cancel" }>((resolve) => {
        if (controller.signal.aborted) resolve({ kind: "cancel" });
        else controller.signal.addEventListener("abort", () => resolve({ kind: "cancel" }), { once: true });
      });
      const settled = await Promise.race([observedHandler, cancelled]);
      if (settled.kind === "cancel") {
        throw timedOut
          ? new FabricContractError("deadline_exceeded", "Fabric Endpoint request deadline has passed", "deadlineAt")
          : new FabricContractError("cancelled", "Fabric Endpoint request was cancelled");
      }
      if (settled.kind === "error") throw settled.error;
      if (controller.signal.aborted) {
        throw timedOut
          ? new FabricContractError("deadline_exceeded", "Fabric Endpoint request deadline has passed", "deadlineAt")
          : new FabricContractError("cancelled", "Fabric Endpoint request was cancelled");
      }
      const current = this.authorize(request);
      if (this.#registrations.get(endpoint.endpointId) !== registration ||
        (registration.ownerId !== undefined && (
          registration.connectionId !== current.route.connectionId ||
          registration.connectionGeneration !== current.route.connectionGeneration ||
          registration.endpointGeneration !== current.endpoint.generation
        ))) {
        throw new FabricContractError("stale_generation", "Fabric Endpoint transport owner changed while dispatch awaited", "connectionGeneration");
      }
      if (byteLength(settled.value) > this.#maxResultBytes) throw new FabricContractError("resource_exhausted", "Fabric Endpoint result is too large", "maxResultBytes");
      return structuredClone(settled.value);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      this.#pendingRequests -= 1;
    }
  }

  get pendingRequestCount(): number { return this.#pendingRequests; }
}
