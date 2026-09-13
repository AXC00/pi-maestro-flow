import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { FabricContractError, type JsonValue, type AgentRuntimeEndpoint, type EndpointRouteHandle, type TeammatePlacementV1 } from "pi-maestro-fabric-core/v1";
import {
  FabricOriginDataPlaneGrantAuthority,
  FabricOriginRouteResolverProvider,
  type FabricOriginGrantIdentity,
  type FabricOriginGrantSnapshot,
} from "../src/gateway/fabric/origin-runtime.ts";
import { FABRIC_AGENT_ATTEMPT_VERSION } from "pi-maestro-backends/fabric";
import type { FabricAgentChannelTransport } from "../src/gateway/fabric/agent-channel.ts";
import type { FabricHttpsDispatchInput, FabricHttpsEventsResultV1, FabricHttpsTransportOptions } from "../src/gateway/fabric/https-transport.ts";
import { GatewayHttpAuth } from "../src/gateway/auth.ts";
import { principalHasFabricDataPlane } from "../src/gateway/capabilities.ts";
import { gatewayIpcAddress, requestGatewayIpcControl, startGatewayIpcServer } from "../src/gateway/ipc.ts";

let now = 1_800_000_000_000;
const placement: TeammatePlacementV1 = {
  version: "fabric.placement.v1",
  placementId: "placement-origin-1",
  routeId: "route-origin-1",
  workspaceBindingId: "binding-origin-1",
  endpointId: "endpoint-origin-1",
  connectionGeneration: 7,
  workspaceGeneration: 5,
  endpointGeneration: 3,
  deadlineAt: now + 120_000,
};
let route: EndpointRouteHandle;
let endpoint: AgentRuntimeEndpoint;

function resetTuple(): void {
  route = {
    routeId: placement.routeId,
    connectionId: "connection-origin-1",
    workspaceBindingId: placement.workspaceBindingId,
    endpointId: placement.endpointId,
    connectionGeneration: placement.connectionGeneration,
    workspaceGeneration: placement.workspaceGeneration,
    endpointGeneration: placement.endpointGeneration,
    issuedAt: now - 1_000,
    expiresAt: placement.deadlineAt,
    state: "open",
    revision: 4,
  };
  endpoint = {
    endpointId: placement.endpointId,
    deviceId: "device-origin-1",
    connectorId: "connector-origin-1",
    scope: { kind: "workspace", workspaceId: "workspace-origin-1" },
    generation: placement.endpointGeneration,
    contractHash: "a".repeat(64),
    status: "online",
    revision: 2,
    kind: "agent",
    roles: ["general"],
    taskTypes: ["development"],
    models: ["model-a"],
    maxConcurrency: 1,
  };
}

function authority(maxActiveGrants = 4): FabricOriginDataPlaneGrantAuthority {
  const grants = new FabricOriginDataPlaneGrantAuthority({
    hubRuntimeEpoch: "hub-origin-epoch-1",
    daemonGeneration: "daemon-origin-generation-1",
    authority: {
      routeOf(routeId) {
        if (routeId !== route.routeId) throw new Error("route is not admitted");
        return structuredClone(route);
      },
      endpointOf(endpointId) {
        return endpointId === endpoint.endpointId ? structuredClone(endpoint) : undefined;
      },
    },
    maxActiveGrants,
    maxTtlMs: 10_000,
    now: () => now,
  });
  grants.configureHttps({ baseUrl: "https://127.0.0.1:9443/mcp", ca: "TEST CA" });
  return grants;
}

function identity(snapshot: FabricOriginGrantSnapshot): FabricOriginGrantIdentity {
  return {
    grantId: snapshot.grantId,
    hubRuntimeEpoch: snapshot.hubRuntimeEpoch,
    daemonGeneration: snapshot.daemonGeneration,
    providerGeneration: snapshot.providerGeneration,
    providerOwnerId: snapshot.providerOwnerId,
    correlationId: snapshot.correlationId,
    placementId: snapshot.placementId,
  };
}

test.beforeEach(() => {
  now = 1_800_000_000_000;
  resetTuple();
});

test("owner grant authority issues bounded memory-only route grants and fences exact authority", () => {
  const grants = authority(1);
  const acquired = grants.acquire({
    providerGeneration: 11,
    providerOwnerId: "flow-owner-11",
    correlationId: "attempt-origin-1",
    placement,
  });
  assert.equal(acquired.hubRuntimeEpoch, "hub-origin-epoch-1");
  assert.equal(acquired.daemonGeneration, "daemon-origin-generation-1");
  assert.equal(acquired.providerGeneration, 11);
  assert.equal(acquired.providerOwnerId, "flow-owner-11");
  assert.equal(acquired.httpsBaseUrl, "https://127.0.0.1:9443/");
  assert.equal(acquired.ca, "TEST CA");
  assert.equal(acquired.expiresAt, now + 10_000);
  assert.ok(acquired.token.length >= 32);
  assert.equal(grants.activeGrantCount, 1);
  assert.throws(() => grants.acquire({
    providerGeneration: 12, providerOwnerId: "flow-owner-12", correlationId: "attempt-origin-2", placement,
  }), /grant limit/);

  const principal = grants.authenticate(acquired.token);
  assert.ok(principal);
  grants.authorize(principal, {
    routeId: placement.routeId,
    endpointId: placement.endpointId,
    endpointGeneration: placement.endpointGeneration,
    deadlineAt: acquired.expiresAt,
  });
  assert.throws(() => grants.authorize(principal, {
    routeId: "another-route",
    endpointId: placement.endpointId,
    endpointGeneration: placement.endpointGeneration,
    deadlineAt: placement.deadlineAt,
  }), /exceeds its grant/);

  route = { ...route, state: "closed", revision: route.revision + 1 };
  assert.throws(() => grants.renew(identity(acquired)), /open|state|route tuple/);
  route = { ...route, state: "open" };
  grants.fenceConnector(endpoint.connectorId);
  assert.equal(grants.authenticate(acquired.token), undefined);
  assert.equal(grants.release(identity(acquired)).released, false);
  assert.doesNotMatch(JSON.stringify(grants), /TEST CA|Bearer|token/i);
});

test("owner-authenticated IPC is the only grant acquisition boundary", async (t) => {
  const grants = authority();
  const ownerToken = "origin-owner-token-123456789";
  const address = gatewayIpcAddress(undefined, join(tmpdir(), `origin-grant-${process.pid}-${Date.now()}.json`));
  const ipc = await startGatewayIpcServer({ canAcceptNewSessions: true } as never, {
    address,
    ownerToken,
    onControl(action, data) {
      if (action === "fabric-origin-grant-acquire") return grants.acquire(data as never);
      if (action === "fabric-origin-grant-renew") return grants.renew(data as never);
      if (action === "fabric-origin-grant-release") return grants.release(data as never);
      throw new Error("unexpected action");
    },
  });
  t.after(() => ipc.close());
  const input = {
    providerGeneration: 15,
    providerOwnerId: "flow-owner-15",
    correlationId: "attempt-origin-15",
    placement,
  };
  await assert.rejects(() => requestGatewayIpcControl({
    address, ownerToken: "wrong-origin-owner-token", action: "fabric-origin-grant-acquire", data: input,
  }), /owner token is invalid/);
  const acquired = await requestGatewayIpcControl({
    address, ownerToken, action: "fabric-origin-grant-acquire", data: input,
  }) as ReturnType<FabricOriginDataPlaneGrantAuthority["acquire"]>;
  assert.equal(acquired.providerGeneration, 15);
  assert.ok(acquired.token);
  const released = await requestGatewayIpcControl({
    address, ownerToken, action: "fabric-origin-grant-release", data: identity(acquired),
  });
  assert.deepEqual(released, { released: true });
});

test("HTTP authentication recognizes the memory-only grant before generic auth", async () => {
  const grants = authority();
  const acquired = grants.acquire({
    providerGeneration: 16,
    providerOwnerId: "flow-owner-16",
    correlationId: "attempt-origin-16",
    placement,
  });
  const auth = new GatewayHttpAuth({ mode: "open" }, undefined, grants);
  const result = await auth.authenticate({
    headers: { authorization: `Bearer ${acquired.token}` },
    socket: { remoteAddress: "127.0.0.1" },
  } as never, "https://127.0.0.1/.well-known/oauth-protected-resource");
  assert.ok(result.principal);
  assert.equal(principalHasFabricDataPlane(result.principal, "exchange"), true);
  assert.equal(result.principal.id.includes(acquired.token), false);
});

test("grant expiry and Hub epoch fencing fail closed without changing grant identity", () => {
  const grants = authority();
  const acquired = grants.acquire({
    providerGeneration: 21,
    providerOwnerId: "flow-owner-21",
    correlationId: "attempt-origin-21",
    placement,
  });
  now += 5_000;
  const renewed = grants.renew(identity(acquired));
  assert.equal(renewed.grantId, acquired.grantId);
  assert.equal(renewed.expiresAt, now + 10_000);
  assert.equal("token" in renewed, false, "renew/status projections must never return the bearer token");

  now = renewed.expiresAt;
  assert.equal(grants.authenticate(acquired.token), undefined);
  assert.throws(() => grants.renew(identity(acquired)), /unavailable|expired/);

  now = 1_800_000_000_000;
  const replacement = authority().acquire({
    providerGeneration: 22,
    providerOwnerId: "flow-owner-22",
    correlationId: "attempt-origin-22",
    placement,
  });
  const fenced = authority();
  const live = fenced.acquire({
    providerGeneration: 23,
    providerOwnerId: "flow-owner-23",
    correlationId: "attempt-origin-23",
    placement,
  });
  fenced.fence();
  assert.equal(fenced.authenticate(live.token), undefined);
  assert.throws(() => fenced.acquire({
    providerGeneration: 24,
    providerOwnerId: "flow-owner-24",
    correlationId: "attempt-origin-24",
    placement,
  }), /unavailable/);
  assert.notEqual(replacement.grantId, live.grantId);
});

class NoopTransport implements FabricAgentChannelTransport {
  async dispatch(_input: FabricHttpsDispatchInput): Promise<JsonValue> { throw new Error("not used"); }
  async events(): Promise<FabricHttpsEventsResultV1> { throw new Error("not used"); }
}

test("generation-tracked provider constructs HTTPS transport, revalidates prepare, and releases IPC once", async () => {
  const grants = authority();
  const order: string[] = [];
  let releases = 0;
  let transportOptions: FabricHttpsTransportOptions | undefined;
  const control = {
    async acquireFabricOriginGrant(input: Parameters<FabricOriginDataPlaneGrantAuthority["acquire"]>[0]) {
      order.push("acquire");
      return grants.acquire(input);
    },
    async renewFabricOriginGrant(input: FabricOriginGrantIdentity) {
      order.push("renew");
      return grants.renew(input);
    },
    async releaseFabricOriginGrant(input: FabricOriginGrantIdentity) {
      order.push("release");
      releases += 1;
      return grants.release(input);
    },
  };
  const provider = new FabricOriginRouteResolverProvider({
    control,
    now: () => now,
    transportFactory(options) {
      transportOptions = options;
      return new NoopTransport();
    },
  });
  const lease = await provider.acquire({
    generation: 31,
    ownerId: "flow-owner-31",
    correlationId: "attempt-origin-31",
    placement,
  }, new AbortController().signal);
  assert.ok(lease);
  assert.equal(transportOptions?.baseUrl, "https://127.0.0.1:9443/");
  assert.equal(transportOptions?.ca, "TEST CA");
  assert.ok(transportOptions?.token);

  const channel = await lease.resolver.prepare({ placement, attemptId: "attempt-origin-31" }, new AbortController().signal);
  assert.equal(channel.route.routeId, placement.routeId);
  assert.equal(channel.endpoint.endpointId, placement.endpointId);
  await channel.close();
  order.push("channel-cleaned");
  await lease.release();
  await lease.release();
  assert.equal(releases, 1);
  assert.deepEqual(order.slice(0, 4), ["acquire", "renew", "channel-cleaned", "release"]);
  assert.equal(grants.activeGrantCount, 0);
});

test("provider rejects and releases an acquired grant whose IPC identity mismatches the request", async () => {
  const grants = authority();
  let releases = 0;
  const provider = new FabricOriginRouteResolverProvider({
    control: {
      async acquireFabricOriginGrant(input) {
        return grants.acquire({ ...input, correlationId: "another-attempt" });
      },
      async renewFabricOriginGrant(input) { return grants.renew(input); },
      async releaseFabricOriginGrant(input) {
        releases += 1;
        return grants.release(input);
      },
    },
    now: () => now,
    transportFactory: () => new NoopTransport(),
  });
  await assert.rejects(() => provider.acquire({
    generation: 35,
    ownerId: "flow-owner-35",
    correlationId: "attempt-origin-35",
    placement,
  }, new AbortController().signal), /does not match its requesting dispatch/u);
  assert.equal(releases, 1);
  assert.equal(grants.activeGrantCount, 0);
});

test("grant-bound dispatch clamps its deadline and release aborts the active relay request", async () => {
  const grants = authority();
  let acquiredExpiry = 0;
  let observedInput: FabricHttpsDispatchInput | undefined;
  let observedEventsInput: Parameters<FabricAgentChannelTransport["events"]>[0] | undefined;
  let observedAborts = 0;
  let entered!: () => void;
  let entries = 0;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const pendingRequest = <T>(signal: AbortSignal): Promise<T> => new Promise<T>((_resolve, reject) => {
    entries += 1;
    if (entries === 2) entered();
    const abort = (): void => {
      observedAborts += 1;
      reject(new FabricContractError("cancelled", "relay request cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  class PendingTransport implements FabricAgentChannelTransport {
    async dispatch(input: FabricHttpsDispatchInput, signal: AbortSignal): Promise<JsonValue> {
      observedInput = input;
      return pendingRequest<JsonValue>(signal);
    }
    async events(input: Parameters<FabricAgentChannelTransport["events"]>[0], signal: AbortSignal): Promise<FabricHttpsEventsResultV1> {
      observedEventsInput = input;
      return pendingRequest<FabricHttpsEventsResultV1>(signal);
    }
  }
  const provider = new FabricOriginRouteResolverProvider({
    control: {
      async acquireFabricOriginGrant(input) {
        const acquired = grants.acquire(input);
        acquiredExpiry = acquired.expiresAt;
        return acquired;
      },
      async renewFabricOriginGrant(input) { return grants.renew(input); },
      async releaseFabricOriginGrant(input) { return grants.release(input); },
    },
    now: () => now,
    transportFactory: () => new PendingTransport(),
  });
  const lease = await provider.acquire({
    generation: 36,
    ownerId: "flow-owner-36",
    correlationId: "attempt-origin-36",
    placement,
  }, new AbortController().signal);
  assert.ok(lease);
  const channel = await lease.resolver.prepare({ placement, attemptId: "attempt-origin-36" }, new AbortController().signal);
  const pending = channel.start({
    version: FABRIC_AGENT_ATTEMPT_VERSION,
    attemptId: "attempt-origin-36",
    placement,
    spec: { agent: "general", task: "test grant cancellation" },
  }, new AbortController().signal);
  await started;
  assert.equal(observedInput?.deadlineAt, acquiredExpiry);
  assert.equal(observedEventsInput?.deadlineAt, acquiredExpiry);
  await lease.release();
  await assert.rejects(() => pending, /cancelled/u);
  await channel.close();
  assert.equal(observedAborts, 2);
});

test("provider prepare rejects a post-await Endpoint generation change", async () => {
  const grants = authority();
  const provider = new FabricOriginRouteResolverProvider({
    control: {
      async acquireFabricOriginGrant(input) { return grants.acquire(input); },
      async renewFabricOriginGrant(input) {
        const renewed = grants.renew(input);
        return {
          ...renewed,
          endpoint: { ...renewed.endpoint, generation: renewed.endpoint.generation + 1 },
        };
      },
      async releaseFabricOriginGrant(input) { return grants.release(input); },
    },
    now: () => now,
    transportFactory: () => new NoopTransport(),
  });
  const lease = await provider.acquire({
    generation: 41,
    ownerId: "flow-owner-41",
    correlationId: "attempt-origin-41",
    placement,
  }, new AbortController().signal);
  assert.ok(lease);
  await assert.rejects(
    () => lease.resolver.prepare({ placement, attemptId: "attempt-origin-41" }, new AbortController().signal),
    /Endpoint generation is stale/,
  );
  await lease.release();
});
