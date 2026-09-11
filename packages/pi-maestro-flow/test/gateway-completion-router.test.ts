import assert from "node:assert/strict";
import test from "node:test";
import { collectExternalAgentProjections } from "pi-maestro-teammate/v1/external-agent-projections";
import { GatewayCompletionRouter, type GatewayCompletionBindingStore } from "../src/ssh-manager/gateway-completion-router.ts";
import type { SshGatewayClientPool, SshGatewayMonitorSink } from "../src/ssh-manager/gateway-client.ts";
import type { SshGatewayLaunchBinding, SshGatewayLaunchBindingV2, SshHost } from "../src/ssh-manager/model.ts";

const NOW = 1_700_000_000_000;
const DIGEST = "a".repeat(64);

function host(): SshHost {
  return {
    id: "host-a",
    label: "Remote A",
    host: "remote.test",
    user: "runner",
    port: 22,
    shell: "bash",
    hostKey: `SHA256:${"A".repeat(43)}`,
    auth: { kind: "agent" },
    tags: [],
    jumpHostId: null,
    monitorEnabled: false,
  };
}

function binding(overrides: Partial<SshGatewayLaunchBindingV2> = {}): SshGatewayLaunchBindingV2 {
  return {
    version: 2,
    bindingId: "launch-1",
    hostId: "host-a",
    effectiveHostDigest: DIGEST,
    endpointIdentity: "b".repeat(64),
    gatewayPrincipalId: "stdio:local-owner",
    gatewaySessionId: "gateway-session",
    gatewayMemberId: "gateway-member",
    sessionRevision: 1,
    memberGeneration: 1,
    leaseExpiresAt: NOW + 90_000,
    leaseTtlMs: 90_000,
    operationId: "operation-1",
    executionHandle: "execution-1",
    generation: 1,
    cursor: 0,
    piSessionRef: "local-session",
    eventCursor: 0,
    resultCursor: 0,
    ...overrides,
  };
}

class MemoryStore implements GatewayCompletionBindingStore {
  readonly values = new Map<string, SshGatewayLaunchBinding>();
  constructor(...values: SshGatewayLaunchBinding[]) {
    for (const value of values) this.values.set(value.bindingId, structuredClone(value));
  }
  getGatewayLaunchBinding(hostId: string, bindingId: string): SshGatewayLaunchBinding | undefined {
    const value = this.values.get(bindingId);
    return value?.hostId === hostId ? structuredClone(value) : undefined;
  }
  getGatewayLaunchBindings(piSessionRef?: string): SshGatewayLaunchBinding[] {
    return [...this.values.values()]
      .filter((value) => piSessionRef === undefined || value.version === 2 && value.piSessionRef === piSessionRef)
      .map((value) => structuredClone(value));
  }
  async saveGatewayLaunchBinding(value: SshGatewayLaunchBinding): Promise<void> {
    this.values.set(value.bindingId, structuredClone(value));
  }
}

class FakePool {
  sink?: SshGatewayMonitorSink;
  readonly resumed: string[] = [];
  readonly paused: string[] = [];
  readonly resultCalls: number[] = [];
  constructor(private readonly store: MemoryStore, private readonly resultStatus: string) {}
  setMonitorSink(sink: SshGatewayMonitorSink | undefined): void { this.sink = sink; }
  async resumeMonitorSession(sessionId: string): Promise<void> { this.resumed.push(sessionId); }
  async pauseMonitorSession(sessionId: string): Promise<void> { this.paused.push(sessionId); }
  async execute(_host: SshHost, _digest: string, input: { args?: Record<string, unknown> }) {
    const cursor = input.args?.cursor as number;
    this.resultCalls.push(cursor);
    const current = [...this.store.values.values()].find((value) => value.version === 2 && value.resultCursor === cursor);
    if (current?.version === 2) await this.store.saveGatewayLaunchBinding({ ...current, resultCursor: cursor + 1 });
    return {
      data: {
        content: [{ type: "text", text: JSON.stringify({
          ok: true,
          data: { status: this.resultStatus, results: [], nextCursor: cursor + 1, done: true },
        }) }],
      },
    };
  }
}

test("queued completion is delivered only when its original Pi session resumes", async () => {
  const pending = binding({
    monitorState: { status: "failed", updatedAt: NOW },
    completion: {
      deliveryId: "delivery-1",
      eventId: "execution-1:4",
      status: "failed",
      content: "remote failed",
      queuedAt: NOW,
    },
  });
  const store = new MemoryStore(pending);
  const pool = new FakePool(store, "failed");
  const deliveries: string[] = [];
  const router = new GatewayCompletionRouter({
    pool: pool as unknown as SshGatewayClientPool,
    store,
    now: () => NOW + 1,
    resolveTarget: () => ({ host: host(), effectiveDigest: DIGEST }),
    deliver: (value, completion) => deliveries.push(`${value.piSessionRef}:${completion.deliveryId}`),
  });
  try {
    router.setActiveSession("other-session");
    await router.resumeActiveSession([{ host: host(), effectiveDigest: DIGEST }]);
    assert.deepEqual(deliveries, []);
    assert.equal(collectExternalAgentProjections("other-session").length, 0);

    router.setActiveSession("local-session");
    await router.resumeActiveSession([{ host: host(), effectiveDigest: DIGEST }]);
    await router.resumeActiveSession([{ host: host(), effectiveDigest: DIGEST }]);
    assert.deepEqual(deliveries, ["local-session:delivery-1"]);
    const accepted = store.getGatewayLaunchBinding("host-a", "launch-1");
    assert.equal(accepted?.version === 2 && accepted.completion?.acceptedAt, NOW + 1);
    assert.equal(collectExternalAgentProjections("local-session")[0]?.status, "failed");
  } finally {
    await router.dispose();
  }
});

test("failed and cancelled terminal states reconcile once while other-session events are ignored", async () => {
  const first = binding();
  const second = binding({
    bindingId: "launch-2",
    operationId: "operation-2",
    executionHandle: "execution-2",
    generation: 2,
    piSessionRef: "other-session",
  });
  const store = new MemoryStore(first, second);
  const pool = new FakePool(store, "cancelled");
  const deliveries: string[] = [];
  const router = new GatewayCompletionRouter({
    pool: pool as unknown as SshGatewayClientPool,
    store,
    now: () => NOW,
    resolveTarget: () => ({ host: host(), effectiveDigest: DIGEST }),
    deliver: (_value, completion) => deliveries.push(completion.status),
  });
  router.setActiveSession("local-session");
  try {
    await router.onEvent({
      binding: second,
      notification: { subscriptionId: "sub-2", handle: "execution-2", eventId: "execution-2:1", cursor: 1, kind: "state", payload: { status: "failed" } },
    });
    assert.deepEqual(deliveries, []);

    await router.onEvent({
      binding: first,
      notification: { subscriptionId: "sub-1", handle: "execution-1", eventId: "execution-1:1", cursor: 1, kind: "state", payload: { status: "cancelled" } },
    });
    await router.onEvent({
      binding: first,
      notification: { subscriptionId: "sub-1", handle: "execution-1", eventId: "execution-1:1", cursor: 1, kind: "state", payload: { status: "cancelled" } },
    });
    assert.deepEqual(deliveries, ["cancelled"]);
    assert.deepEqual(pool.resultCalls, [0]);
  } finally {
    await router.dispose();
  }
});

test("a retention gap performs one result reconciliation instead of starting a poll loop", async () => {
  const current = binding({ monitorState: { status: "running", updatedAt: NOW } });
  const store = new MemoryStore(current);
  const pool = new FakePool(store, "failed");
  const deliveries: string[] = [];
  const router = new GatewayCompletionRouter({
    pool: pool as unknown as SshGatewayClientPool,
    store,
    now: () => NOW + 5,
    resolveTarget: () => ({ host: host(), effectiveDigest: DIGEST }),
    deliver: (_value, completion) => deliveries.push(completion.status),
  });
  router.setActiveSession("local-session");
  try {
    await router.onGap({
      binding: current,
      gap: { reason: "retention", fromCursor: 1, toCursor: 8, resumeCursor: 8 },
    });
    assert.deepEqual(pool.resultCalls, [0]);
    assert.deepEqual(deliveries, ["failed"]);
    const reconciled = store.getGatewayLaunchBinding("host-a", "launch-1");
    assert.equal(reconciled?.version === 2 && reconciled.monitorState?.status, "reconnecting");
    assert.equal(reconciled?.version === 2 && reconciled.completion?.status, "failed");
  } finally {
    await router.dispose();
  }
});
