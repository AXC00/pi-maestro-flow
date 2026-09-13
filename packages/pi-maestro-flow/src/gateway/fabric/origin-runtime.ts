import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  FabricContractError,
  assertFabricIdentifier,
  assertValidEndpointRecord,
  assertValidEndpointRouteHandle,
  assertValidTeammatePlacement,
  type AgentRuntimeEndpoint,
  type EndpointRecord,
  type EndpointRouteHandle,
  type TeammatePlacementV1,
} from "pi-maestro-fabric-core/v1";
import type {
  FabricBackendPrepareRequest,
  FabricBackendRouteResolver,
  FabricBackendRouteResolverAcquireRequest,
  PreparedFabricBackendChannel,
} from "pi-maestro-backends/fabric";

/** Mirrors the generation-tracked public teammate API without importing package internals. */
export interface FabricRouteResolverProviderAcquireRequest extends FabricBackendRouteResolverAcquireRequest {
  readonly generation: number;
  readonly ownerId: string;
}
export interface FabricRouteResolverProviderLease {
  readonly resolver: FabricBackendRouteResolver;
  release(): void | Promise<void>;
}
export interface GenerationTrackedFabricRouteResolverProvider {
  acquire(
    request: FabricRouteResolverProviderAcquireRequest,
    signal: AbortSignal,
  ): FabricRouteResolverProviderLease | undefined | Promise<FabricRouteResolverProviderLease | undefined>;
}
import type { GatewayPrincipal } from "../contracts.ts";
import { createGatewayPrincipal } from "../principal.ts";
import { FabricAgentRouteResolver, type FabricAgentChannelAuthority, type FabricAgentChannelTransport } from "./agent-channel.ts";
import {
  FabricHttpsTransport,
  type FabricHttpsDispatchInput,
} from "./https-transport.ts";

export const FABRIC_ORIGIN_GRANT_TTL_MS = 30_000;
export const FABRIC_ORIGIN_GRANT_LIMIT = 64;
const GRANT_PRINCIPAL_PREFIX = "fabric-origin-grant:";

export interface FabricOriginGrantIdentity {
  readonly grantId: string;
  readonly hubRuntimeEpoch: string;
  readonly daemonGeneration: string;
  readonly providerGeneration: number;
  readonly providerOwnerId: string;
  readonly correlationId: string;
  readonly placementId: string;
}

export interface FabricOriginGrantAcquireRequest {
  readonly providerGeneration: number;
  readonly providerOwnerId: string;
  readonly correlationId: string;
  readonly placement: TeammatePlacementV1;
}

export interface FabricOriginGrantRenewRequest extends FabricOriginGrantIdentity {}
export interface FabricOriginGrantReleaseRequest extends FabricOriginGrantIdentity {}

export interface FabricOriginGrantSnapshot extends FabricOriginGrantIdentity {
  readonly httpsBaseUrl: string;
  readonly ca?: string;
  readonly expiresAt: number;
  readonly deadlineAt: number;
  readonly route: EndpointRouteHandle;
  readonly endpoint: AgentRuntimeEndpoint;
}

export interface FabricOriginGrantAcquired extends FabricOriginGrantSnapshot {
  /** Secret returned only over owner-authenticated IPC. Never project or log it. */
  readonly token: string;
}

export interface FabricOriginGrantAuthorityView {
  routeOf(routeId: string): EndpointRouteHandle;
  endpointOf(endpointId: string): EndpointRecord | undefined;
}

export interface FabricOriginDataPlaneGrantAuthorityOptions {
  readonly hubRuntimeEpoch: string;
  readonly daemonGeneration: string;
  readonly authority: FabricOriginGrantAuthorityView;
  readonly maxActiveGrants?: number;
  readonly maxTtlMs?: number;
  readonly now?: () => number;
}

interface GrantRecord extends FabricOriginGrantIdentity {
  readonly tokenDigest: string;
  readonly placement: TeammatePlacementV1;
  readonly connectorId: string;
  readonly controller: AbortController;
  expiresAt: number;
  route: EndpointRouteHandle;
  endpoint: AgentRuntimeEndpoint;
}

function positive(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new FabricContractError("invalid_argument", `${path} must be a positive safe integer`, path);
  }
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function sameIdentity(left: FabricOriginGrantIdentity, right: FabricOriginGrantIdentity): boolean {
  return left.grantId === right.grantId && left.hubRuntimeEpoch === right.hubRuntimeEpoch
    && left.daemonGeneration === right.daemonGeneration
    && left.providerGeneration === right.providerGeneration
    && left.providerOwnerId === right.providerOwnerId
    && left.correlationId === right.correlationId && left.placementId === right.placementId;
}

function assertStableAuthority(
  priorRoute: EndpointRouteHandle,
  currentRoute: EndpointRouteHandle,
  priorEndpoint: EndpointRecord,
  currentEndpoint: EndpointRecord,
): void {
  if (priorRoute.routeId !== currentRoute.routeId || priorRoute.connectionId !== currentRoute.connectionId
    || priorRoute.workspaceBindingId !== currentRoute.workspaceBindingId
    || priorRoute.endpointId !== currentRoute.endpointId
    || priorRoute.connectionGeneration !== currentRoute.connectionGeneration
    || priorRoute.workspaceGeneration !== currentRoute.workspaceGeneration
    || priorRoute.endpointGeneration !== currentRoute.endpointGeneration
    || priorEndpoint.endpointId !== currentEndpoint.endpointId
    || priorEndpoint.connectorId !== currentEndpoint.connectorId
    || priorEndpoint.deviceId !== currentEndpoint.deviceId
    || priorEndpoint.generation !== currentEndpoint.generation) {
    throw new FabricContractError("stale_generation", "Fabric origin route authority changed", "connectionGeneration");
  }
}

function assertPlacementTuple(
  placement: TeammatePlacementV1,
  route: EndpointRouteHandle,
  endpoint: EndpointRecord,
  now: number,
): asserts endpoint is AgentRuntimeEndpoint {
  assertValidTeammatePlacement(placement, now);
  assertValidEndpointRouteHandle(route, now);
  assertValidEndpointRecord(endpoint);
  if (route.state !== "open" || route.routeId !== placement.routeId
    || route.endpointId !== placement.endpointId
    || route.connectionGeneration !== placement.connectionGeneration
    || route.workspaceBindingId !== placement.workspaceBindingId
    || route.workspaceGeneration !== placement.workspaceGeneration
    || route.endpointGeneration !== placement.endpointGeneration) {
    throw new FabricContractError("stale_generation", "Fabric origin grant does not match the current route tuple", "placement");
  }
  if (endpoint.endpointId !== placement.endpointId || endpoint.generation !== placement.endpointGeneration) {
    throw new FabricContractError("stale_generation", "Fabric origin grant Endpoint generation is stale", "endpointGeneration");
  }
  if (endpoint.kind !== "agent") {
    throw new FabricContractError("conflict", "Fabric origin grant requires an Agent Endpoint", "endpointId");
  }
  if (endpoint.status !== "online") {
    throw new FabricContractError("unavailable", "Fabric origin grant requires an online Agent Endpoint", "endpointId");
  }
  if (placement.deadlineAt > route.expiresAt) {
    throw new FabricContractError("deadline_exceeded", "Fabric placement deadline exceeds the route lease", "deadlineAt");
  }
}

/**
 * Daemon-owned, memory-only bearer grant authority for the local HTTPS hop.
 * Durable Gateway state contains neither these records nor their bearer token.
 */
export class FabricOriginDataPlaneGrantAuthority {
  readonly hubRuntimeEpoch: string;
  readonly daemonGeneration: string;
  readonly #authority: FabricOriginGrantAuthorityView;
  readonly #maxActiveGrants: number;
  readonly #maxTtlMs: number;
  readonly #now: () => number;
  readonly #grants = new Map<string, GrantRecord>();
  readonly #grantByTokenDigest = new Map<string, string>();
  #httpsBaseUrl?: string;
  #ca?: string;
  #accepting = true;

  constructor(options: FabricOriginDataPlaneGrantAuthorityOptions) {
    assertFabricIdentifier(options.hubRuntimeEpoch, "hubRuntimeEpoch");
    assertFabricIdentifier(options.daemonGeneration, "daemonGeneration");
    this.hubRuntimeEpoch = options.hubRuntimeEpoch;
    this.daemonGeneration = options.daemonGeneration;
    this.#authority = options.authority;
    this.#maxActiveGrants = options.maxActiveGrants ?? FABRIC_ORIGIN_GRANT_LIMIT;
    this.#maxTtlMs = options.maxTtlMs ?? FABRIC_ORIGIN_GRANT_TTL_MS;
    positive(this.#maxActiveGrants, "maxActiveGrants");
    positive(this.#maxTtlMs, "maxTtlMs");
    this.#now = options.now ?? Date.now;
  }

  configureHttps(input: { readonly baseUrl: string; readonly ca?: string }): void {
    const url = new URL(input.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new FabricContractError("invalid_argument", "Fabric origin grants require a credential-free HTTPS base URL", "baseUrl");
    }
    url.pathname = "/";
    this.#httpsBaseUrl = url.href;
    this.#ca = input.ca;
  }

  acquire(input: FabricOriginGrantAcquireRequest): FabricOriginGrantAcquired {
    if (!this.#accepting || this.#httpsBaseUrl === undefined) {
      throw new FabricContractError("unavailable", "Fabric origin data-plane grants are unavailable");
    }
    positive(input.providerGeneration, "providerGeneration");
    assertFabricIdentifier(input.providerOwnerId, "providerOwnerId");
    assertFabricIdentifier(input.correlationId, "correlationId");
    this.#purgeExpired();
    if (this.#grants.size >= this.#maxActiveGrants) {
      throw new FabricContractError("resource_exhausted", "Fabric origin data-plane grant limit is reached", "maxActiveGrants");
    }
    const { route, endpoint } = this.#currentTuple(input.placement);
    const grantId = `grant-${randomUUID()}`;
    const token = randomBytes(32).toString("base64url");
    const record: GrantRecord = {
      grantId,
      hubRuntimeEpoch: this.hubRuntimeEpoch,
      daemonGeneration: this.daemonGeneration,
      providerGeneration: input.providerGeneration,
      providerOwnerId: input.providerOwnerId,
      correlationId: input.correlationId,
      placementId: input.placement.placementId,
      tokenDigest: tokenDigest(token),
      placement: structuredClone(input.placement),
      connectorId: endpoint.connectorId,
      controller: new AbortController(),
      expiresAt: this.#nextExpiry(input.placement.deadlineAt),
      route,
      endpoint,
    };
    this.#grants.set(grantId, record);
    this.#grantByTokenDigest.set(record.tokenDigest, grantId);
    return { ...this.#snapshot(record), token };
  }

  renew(input: FabricOriginGrantRenewRequest): FabricOriginGrantSnapshot {
    const record = this.#require(input);
    const { route, endpoint } = this.#currentTuple(record.placement);
    assertStableAuthority(record.route, route, record.endpoint, endpoint);
    record.route = route;
    record.endpoint = endpoint;
    record.expiresAt = this.#nextExpiry(record.placement.deadlineAt);
    return this.#snapshot(record);
  }

  release(input: FabricOriginGrantReleaseRequest): { released: boolean } {
    const record = this.#grants.get(input.grantId);
    if (record === undefined || !sameIdentity(record, input)) return { released: false };
    this.#delete(record);
    return { released: true };
  }

  /** Return a narrow principal only while the exact in-memory grant is live. */
  authenticate(token: string): GatewayPrincipal | undefined {
    if (!this.#accepting || token.length === 0) return undefined;
    const grantId = this.#grantByTokenDigest.get(tokenDigest(token));
    const record = grantId === undefined ? undefined : this.#grants.get(grantId);
    if (record === undefined) return undefined;
    if (this.#now() >= record.expiresAt) {
      this.#delete(record);
      return undefined;
    }
    return createGatewayPrincipal("http", `${GRANT_PRINCIPAL_PREFIX}${record.grantId}`, {
      authenticated: true,
      source: "local-owner-ipc-grant",
      scopes: ["fabric.data"],
    });
  }

  /** Revalidate the bound route tuple on every exchange/events request. */
  authorize(principal: GatewayPrincipal, input: {
    readonly routeId: string;
    readonly endpointId: string;
    readonly endpointGeneration: number;
    readonly deadlineAt: number;
  }): FabricOriginGrantAuthorization | undefined {
    if (!principal.id.startsWith(GRANT_PRINCIPAL_PREFIX)) return undefined;
    const record = this.#grants.get(principal.id.slice(GRANT_PRINCIPAL_PREFIX.length));
    if (record === undefined || !this.#accepting || this.#now() >= record.expiresAt) {
      if (record !== undefined) this.#delete(record);
      throw new FabricContractError("permission_denied", "Fabric origin data-plane grant is unavailable");
    }
    if (input.routeId !== record.placement.routeId || input.endpointId !== record.placement.endpointId
      || input.endpointGeneration !== record.placement.endpointGeneration
      || input.deadlineAt > record.placement.deadlineAt
      || input.deadlineAt > record.expiresAt) {
      throw new FabricContractError("permission_denied", "Fabric origin data-plane request exceeds its grant");
    }
    const current = this.#currentTuple(record.placement);
    assertStableAuthority(record.route, current.route, record.endpoint, current.endpoint);
    return { expiresAt: record.expiresAt, signal: record.controller.signal };
  }

  fenceRoute(routeId: string): void {
    for (const record of [...this.#grants.values()]) if (record.placement.routeId === routeId) this.#delete(record);
  }

  fenceConnector(connectorId: string): void {
    for (const record of [...this.#grants.values()]) if (record.connectorId === connectorId) this.#delete(record);
  }

  /** Hub epoch loss fences authentication immediately and drops all secret state. */
  fence(): void {
    this.#accepting = false;
    for (const record of [...this.#grants.values()]) this.#delete(record);
  }

  get activeGrantCount(): number { this.#purgeExpired(); return this.#grants.size; }

  #currentTuple(placement: TeammatePlacementV1): { route: EndpointRouteHandle; endpoint: AgentRuntimeEndpoint } {
    const route = this.#authority.routeOf(placement.routeId);
    const endpoint = this.#authority.endpointOf(placement.endpointId);
    if (endpoint === undefined) throw new FabricContractError("not_found", "Fabric origin grant Endpoint is not registered", "endpointId");
    assertPlacementTuple(placement, route, endpoint, this.#now());
    return { route: structuredClone(route), endpoint: structuredClone(endpoint) };
  }

  #require(identity: FabricOriginGrantIdentity): GrantRecord {
    const record = this.#grants.get(identity.grantId);
    if (record === undefined || !sameIdentity(record, identity) || !this.#accepting) {
      throw new FabricContractError("permission_denied", "Fabric origin data-plane grant is unavailable");
    }
    if (this.#now() >= record.expiresAt) {
      this.#delete(record);
      throw new FabricContractError("deadline_exceeded", "Fabric origin data-plane grant expired");
    }
    return record;
  }

  #nextExpiry(deadlineAt: number): number {
    const expiry = Math.min(deadlineAt, this.#now() + this.#maxTtlMs);
    if (expiry <= this.#now()) throw new FabricContractError("deadline_exceeded", "Fabric placement deadline has passed", "deadlineAt");
    return expiry;
  }

  #snapshot(record: GrantRecord): FabricOriginGrantSnapshot {
    return {
      grantId: record.grantId,
      hubRuntimeEpoch: record.hubRuntimeEpoch,
      daemonGeneration: record.daemonGeneration,
      providerGeneration: record.providerGeneration,
      providerOwnerId: record.providerOwnerId,
      correlationId: record.correlationId,
      placementId: record.placementId,
      httpsBaseUrl: this.#httpsBaseUrl!,
      ...(this.#ca === undefined ? {} : { ca: this.#ca }),
      expiresAt: record.expiresAt,
      deadlineAt: record.placement.deadlineAt,
      route: structuredClone(record.route),
      endpoint: structuredClone(record.endpoint),
    };
  }

  #delete(record: GrantRecord): void {
    if (this.#grants.get(record.grantId) === record) this.#grants.delete(record.grantId);
    if (this.#grantByTokenDigest.get(record.tokenDigest) === record.grantId) this.#grantByTokenDigest.delete(record.tokenDigest);
    record.controller.abort(new FabricContractError("cancelled", "Fabric origin data-plane grant was fenced"));
  }

  #purgeExpired(): void {
    const now = this.#now();
    for (const record of [...this.#grants.values()]) if (now >= record.expiresAt) this.#delete(record);
  }
}

export interface FabricOriginGrantAuthorization {
  readonly expiresAt: number;
  readonly signal: AbortSignal;
}

export interface FabricOriginGrantControlClient {
  acquireFabricOriginGrant(input: FabricOriginGrantAcquireRequest): Promise<FabricOriginGrantAcquired>;
  renewFabricOriginGrant(input: FabricOriginGrantRenewRequest): Promise<FabricOriginGrantSnapshot>;
  releaseFabricOriginGrant(input: FabricOriginGrantReleaseRequest): Promise<unknown>;
}

export interface FabricOriginRouteResolverProviderOptions {
  readonly control: FabricOriginGrantControlClient;
  readonly now?: () => number;
  readonly transportFactory?: (options: ConstructorParameters<typeof FabricHttpsTransport>[0]) => FabricAgentChannelTransport;
}

interface LiveGrant {
  snapshot: FabricOriginGrantSnapshot;
  readonly identity: FabricOriginGrantIdentity;
  readonly controller: AbortController;
  active: boolean;
  renewalFailed: boolean;
}

function assertSnapshot(
  snapshot: FabricOriginGrantSnapshot,
  identity: FabricOriginGrantIdentity,
  placement: TeammatePlacementV1,
  now: number,
): void {
  if (!sameIdentity(snapshot, identity)) throw new FabricContractError("stale_generation", "Fabric origin grant identity changed while awaiting IPC");
  if (snapshot.deadlineAt !== placement.deadlineAt || now >= snapshot.expiresAt) {
    throw new FabricContractError("deadline_exceeded", "Fabric origin grant is expired or has the wrong deadline", "deadlineAt");
  }
  assertPlacementTuple(placement, snapshot.route, snapshot.endpoint, now);
}

class GrantBoundTransport implements FabricAgentChannelTransport {
  constructor(
    private readonly grant: LiveGrant,
    private readonly transport: FabricAgentChannelTransport,
    private readonly now: () => number,
  ) {}

  async dispatch(input: FabricHttpsDispatchInput, signal: AbortSignal): Promise<import("pi-maestro-fabric-core/v1").JsonValue> {
    this.#assertLive();
    const linked = this.#link(signal);
    try {
      const value = await this.transport.dispatch({
        ...input,
        deadlineAt: Math.min(input.deadlineAt, this.grant.snapshot.expiresAt),
      }, linked.signal);
      this.#assertLive();
      return value;
    } finally {
      linked.cleanup();
    }
  }


  #link(signal: AbortSignal): { signal: AbortSignal; cleanup(): void } {
    const controller = new AbortController();
    const abortCaller = (): void => controller.abort(signal.reason);
    const abortGrant = (): void => controller.abort(this.grant.controller.signal.reason);
    signal.addEventListener("abort", abortCaller, { once: true });
    this.grant.controller.signal.addEventListener("abort", abortGrant, { once: true });
    if (signal.aborted) abortCaller();
    if (this.grant.controller.signal.aborted) abortGrant();
    const timer = setTimeout(() => controller.abort(new FabricContractError(
      "deadline_exceeded",
      "Fabric origin data-plane grant expired during request",
    )), Math.max(0, this.grant.snapshot.expiresAt - this.now()));
    timer.unref?.();
    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abortCaller);
        this.grant.controller.signal.removeEventListener("abort", abortGrant);
      },
    };
  }

  #assertLive(): void {
    if (!this.grant.active || this.grant.renewalFailed || this.grant.controller.signal.aborted || this.now() >= this.grant.snapshot.expiresAt) {
      throw new FabricContractError("unavailable", "Fabric origin data-plane grant is no longer live");
    }
  }
}

class FabricOriginRouteResolver implements FabricBackendRouteResolver {
  constructor(
    private readonly control: FabricOriginGrantControlClient,
    private readonly grant: LiveGrant,
    private readonly placement: TeammatePlacementV1,
    private readonly transport: FabricAgentChannelTransport,
    private readonly now: () => number,
  ) {}

  async prepare(request: FabricBackendPrepareRequest, signal: AbortSignal): Promise<PreparedFabricBackendChannel> {
    if (signal.aborted) throw new FabricContractError("cancelled", "Fabric origin route preparation was cancelled");
    if (request.placement.placementId !== this.placement.placementId || request.attemptId !== this.grant.identity.correlationId) {
      throw new FabricContractError("permission_denied", "Fabric origin resolver lease belongs to another dispatch");
    }
    assertSnapshot(this.grant.snapshot, this.grant.identity, request.placement, this.now());
    const renewed = await this.control.renewFabricOriginGrant(this.grant.identity);
    if (signal.aborted) throw new FabricContractError("cancelled", "Fabric origin route preparation was cancelled");
    assertSnapshot(renewed, this.grant.identity, request.placement, this.now());
    assertStableAuthority(this.grant.snapshot.route, renewed.route, this.grant.snapshot.endpoint, renewed.endpoint);
    this.grant.snapshot = renewed;
    const authority: FabricAgentChannelAuthority = {
      routeOf: (routeId) => {
        if (routeId !== request.placement.routeId) throw new FabricContractError("permission_denied", "Fabric origin resolver cannot change routes");
        assertSnapshot(this.grant.snapshot, this.grant.identity, request.placement, this.now());
        return structuredClone(this.grant.snapshot.route);
      },
      endpointOf: (endpointId) => endpointId === request.placement.endpointId
        ? structuredClone(this.grant.snapshot.endpoint)
        : undefined,
    };
    return new FabricAgentRouteResolver({ transport: this.transport, authority, now: this.now }).prepare(request, signal);
  }
}

/** Generation-tracked extension provider. IPC acquisition occurs only for a placed dispatch. */
export class FabricOriginRouteResolverProvider implements GenerationTrackedFabricRouteResolverProvider {
  readonly #control: FabricOriginGrantControlClient;
  readonly #now: () => number;
  readonly #transportFactory: NonNullable<FabricOriginRouteResolverProviderOptions["transportFactory"]>;

  constructor(options: FabricOriginRouteResolverProviderOptions) {
    this.#control = options.control;
    this.#now = options.now ?? Date.now;
    this.#transportFactory = options.transportFactory ?? ((transportOptions) => new FabricHttpsTransport(transportOptions));
  }

  async acquire(
    request: FabricRouteResolverProviderAcquireRequest,
    signal: AbortSignal,
  ): Promise<FabricRouteResolverProviderLease | undefined> {
    if (signal.aborted) throw new FabricContractError("cancelled", "Fabric origin grant acquisition was cancelled");
    if (request.placement === undefined) return undefined;
    const acquired = await this.#control.acquireFabricOriginGrant({
      providerGeneration: request.generation,
      providerOwnerId: request.ownerId,
      correlationId: request.correlationId,
      placement: request.placement,
    });
    const identity: FabricOriginGrantIdentity = {
      grantId: acquired.grantId,
      hubRuntimeEpoch: acquired.hubRuntimeEpoch,
      daemonGeneration: acquired.daemonGeneration,
      providerGeneration: acquired.providerGeneration,
      providerOwnerId: acquired.providerOwnerId,
      correlationId: acquired.correlationId,
      placementId: acquired.placementId,
    };
    if (identity.providerGeneration !== request.generation || identity.providerOwnerId !== request.ownerId
      || identity.correlationId !== request.correlationId || identity.placementId !== request.placement.placementId) {
      await this.#control.releaseFabricOriginGrant(identity).catch(() => undefined);
      throw new FabricContractError("stale_generation", "Fabric origin grant identity does not match its requesting dispatch");
    }
    const { token, ...snapshot } = acquired;
    const state: LiveGrant = {
      snapshot,
      identity,
      controller: new AbortController(),
      active: true,
      renewalFailed: false,
    };
    const control = this.#control;
    try {
      if (signal.aborted) {
        throw new FabricContractError("cancelled", "Fabric origin grant acquisition was cancelled");
      }
      assertSnapshot(snapshot, identity, request.placement, this.#now());
      const rawTransport = this.#transportFactory({ baseUrl: snapshot.httpsBaseUrl, token, ...(snapshot.ca === undefined ? {} : { ca: snapshot.ca }) });
      const transport = new GrantBoundTransport(state, rawTransport, this.#now);
      const resolver = new FabricOriginRouteResolver(this.#control, state, request.placement, transport, this.#now);
      let released = false;
      let timer: NodeJS.Timeout | undefined;
      const renew = async (): Promise<void> => {
        if (!state.active) return;
        try {
          const renewed = await this.#control.renewFabricOriginGrant(identity);
          assertSnapshot(renewed, identity, request.placement, this.#now());
          assertStableAuthority(state.snapshot.route, renewed.route, state.snapshot.endpoint, renewed.endpoint);
          state.snapshot = renewed;
          schedule();
        } catch {
          state.renewalFailed = true;
          state.controller.abort(new FabricContractError("cancelled", "Fabric origin grant renewal failed"));
        }
      };
      const schedule = (): void => {
        if (!state.active || state.renewalFailed) return;
        const delay = Math.max(1, Math.min(
          Math.floor((state.snapshot.expiresAt - this.#now()) / 2),
          state.snapshot.deadlineAt - this.#now(),
        ));
        timer = setTimeout(() => { void renew(); }, delay);
        timer.unref?.();
      };
      schedule();
      return {
        resolver,
        async release(): Promise<void> {
          if (released) return;
          released = true;
          state.active = false;
          state.controller.abort(new FabricContractError("cancelled", "Fabric origin grant was released"));
          if (timer !== undefined) clearTimeout(timer);
          await control.releaseFabricOriginGrant(identity).catch(() => undefined);
        },
      };
    } catch (error) {
      state.active = false;
      state.controller.abort(new FabricContractError("cancelled", "Fabric origin grant acquisition failed"));
      await this.#control.releaseFabricOriginGrant(identity).catch(() => undefined);
      throw error;
    }
  }
}
