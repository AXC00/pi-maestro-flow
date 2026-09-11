import assert from "node:assert/strict";
import { Duplex, PassThrough } from "node:stream";
import test from "node:test";
import type { SshExecuteRequest, SshCommandChannel } from "../src/ssh-manager/executor.ts";
import {
  SshGatewayClientPool,
  type SshGatewayBindingSource,
  type SshGatewayMonitorEvent,
} from "../src/ssh-manager/gateway-client.ts";
import { collectExternalAgentProjections } from "pi-maestro-teammate/v1/external-agent-projections";
import { GatewayCompletionRouter } from "../src/ssh-manager/gateway-completion-router.ts";
import type { SshGatewayLaunchBinding, SshHost } from "../src/ssh-manager/model.ts";

const NOW = 1_700_000_000_000;
const DIGEST = "a".repeat(64);
const PIN = `SHA256:${"A".repeat(43)}`;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

class MonitorGatewayChannel extends Duplex {
  readonly stderr = new PassThrough();
  readonly calls: JsonRpcRequest[] = [];
  private input = "";
  private subscriptionId = "subscription-1";

  _read(): void {}

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.input += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    try {
      while (this.input.includes("\n")) {
        const newline = this.input.indexOf("\n");
        const line = this.input.slice(0, newline).replace(/\r$/u, "");
        this.input = this.input.slice(newline + 1);
        if (line) this.handle(JSON.parse(line) as JsonRpcRequest);
      }
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  notify(cursor: number, kind: string, payload: unknown, eventId = `remote-task-1:${cursor}`): void {
    this.push(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/gateway/event",
      params: {
        subscriptionId: this.subscriptionId,
        handle: "remote-task-1",
        eventId,
        cursor,
        kind,
        payload,
      },
    })}\n`);
  }

  private handle(request: JsonRpcRequest): void {
    this.calls.push(request);
    if (request.id === undefined) return;
    if (request.method === "initialize") {
      this.respond(request.id, {
        protocolVersion: request.params?.protocolVersion,
        capabilities: { tools: {}, experimental: { "monitor-stream-v1": {} } },
        serverInfo: { name: "pi-maestro-gateway", version: "1" },
      });
      return;
    }
    if (request.method === "tools/list") {
      this.respond(request.id, {
        tools: [{ name: "host", description: "host", inputSchema: { type: "object", properties: {} } }],
      });
      return;
    }
    if (request.method !== "tools/call") throw new Error(`unexpected ${request.method}`);
    const params = request.params ?? {};
    const name = String(params.name ?? "");
    const args = params.arguments as Record<string, unknown> | undefined;
    const meta = { principalId: "local-owner" };
    let envelope: unknown;
    if (name === "host" && args?.action === "describe") {
      envelope = { ok: true, data: { cwd: "/remote" }, meta };
    } else if (name === "session" && args?.action === "create") {
      envelope = {
        ok: true,
        data: {
          session: { id: args.sessionId, revision: 1 },
          member: {
            id: args.ownerId,
            principalId: "stdio:local-owner",
            status: "active",
            generation: 1,
            leaseExpiresAt: NOW + 90_000,
            updatedAt: NOW,
          },
        },
        meta,
      };
    } else if (name === "session" && args?.action === "start-pi") {
      envelope = { ok: true, data: { taskId: "remote-task-1", monitorHandle: "remote-task-1" }, meta };
    } else if (name === "monitor" && args?.action === "subscribe") {
      envelope = {
        ok: true,
        data: {
          subscriptionId: this.subscriptionId,
          handle: "remote-task-1",
          cursor: args.cursor,
          watermark: args.cursor,
          oldestCursor: 1,
          replayed: 0,
        },
        meta,
      };
    } else if (name === "monitor" && args?.action === "unsubscribe") {
      envelope = { ok: true, data: { subscriptionId: args.subscriptionId, unsubscribed: true, cursor: 2 }, meta };
    } else if (name === "monitor" && args?.action === "result") {
      envelope = {
        ok: true,
        data: {
          handle: "remote-task-1",
          taskId: "remote-task-1",
          status: "completed",
          results: [{ cursor: 1, status: "completed", output: "done" }],
          nextCursor: 1,
          done: true,
        },
        meta,
      };
    } else {
      throw new Error(`unexpected ${name}.${String(args?.action)}`);
    }
    this.respond(request.id, { content: [{ type: "text", text: JSON.stringify(envelope) }] });
  }

  private respond(id: string | number, result: unknown): void {
    this.push(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }
}

class MemoryBindings implements SshGatewayBindingSource {
  readonly values = new Map<string, SshGatewayLaunchBinding>();
  getGatewayBinding(): undefined { return undefined; }
  getGatewayLaunchBinding(hostId: string, bindingId: string): SshGatewayLaunchBinding | undefined {
    const value = this.values.get(bindingId);
    return value?.hostId === hostId ? structuredClone(value) : undefined;
  }
  getGatewayLaunchBindings(piSessionRef?: string): SshGatewayLaunchBinding[] {
    return [...this.values.values()]
      .filter((value) => piSessionRef === undefined || value.version === 2 && value.piSessionRef === piSessionRef)
      .map((value) => structuredClone(value));
  }
  async saveGatewayLaunchBinding(binding: SshGatewayLaunchBinding): Promise<void> {
    this.values.set(binding.bindingId, structuredClone(binding));
  }
  async removeGatewayLaunchBinding(hostId: string, bindingId: string): Promise<boolean> {
    return Boolean(this.values.get(bindingId)?.hostId === hostId && this.values.delete(bindingId));
  }
}

function host(): SshHost {
  return {
    id: "host-a",
    label: "Host A",
    host: "host.test",
    user: "runner",
    port: 22,
    shell: "bash",
    hostKey: PIN,
    auth: { kind: "agent" },
    tags: [],
    jumpHostId: null,
    monitorEnabled: false,
  };
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not become true");
}

test("start_pi subscribes over SSH stdio, deduplicates events, and keeps event/result cursors separate", async () => {
  const channel = new MonitorGatewayChannel();
  const bindings = new MemoryBindings();
  const events: SshGatewayMonitorEvent[] = [];
  const executor = {
    async openChannel(_host: SshHost, _request: SshExecuteRequest): Promise<SshCommandChannel> {
      return { channel: channel as SshCommandChannel["channel"], effectiveDigest: DIGEST, close: () => channel.destroy() };
    },
  };
  const pool = new SshGatewayClientPool(executor, {
    bindingSource: bindings,
    now: () => NOW,
    monitorSink: { onEvent: (event) => { events.push(event); } },
  });
  try {
    const started = await pool.execute(host(), DIGEST, {
      action: "start_pi",
      objective: "test monitor",
      requestId: "request-1",
    }, undefined, { piSessionRef: "local-session-1", todos: [] });
    const result = started.data as { binding: { bindingId: string; generation: number } };
    const binding = bindings.getGatewayLaunchBinding("host-a", result.binding.bindingId);
    assert.equal(binding?.version, 2);
    assert.equal(binding?.version === 2 && binding.piSessionRef, "local-session-1");

    const subscribeCall = channel.calls.find((request) => request.method === "tools/call"
      && (request.params?.arguments as Record<string, unknown> | undefined)?.action === "subscribe");
    assert.equal((subscribeCall?.params?.arguments as Record<string, unknown>).cursor, 0);
    assert.equal((subscribeCall?.params?.arguments as Record<string, unknown>)._sshLaunch, undefined);

    channel.notify(1, "state", { status: "running" });
    channel.notify(1, "state", { status: "running" });
    channel.notify(2, "state", { status: "completed" });
    await until(() => events.length === 2 && bindings.getGatewayLaunchBinding("host-a", result.binding.bindingId)?.cursor === 2);
    assert.deepEqual(events.map((event) => event.notification.cursor), [1, 2]);

    const latest = bindings.getGatewayLaunchBinding("host-a", result.binding.bindingId);
    assert.equal(latest?.version === 2 && latest.eventCursor, 2);
    assert.equal(latest?.version === 2 && latest.resultCursor, 0);
    await pool.execute(host(), DIGEST, {
      action: "call",
      tool: "monitor",
      args: {
        action: "result",
        sessionId: latest!.gatewaySessionId,
        memberId: latest!.gatewayMemberId,
        handle: latest!.executionHandle,
        cursor: 0,
        _sshLaunch: { bindingId: latest!.bindingId, generation: latest!.generation },
      },
    });
    const afterResult = bindings.getGatewayLaunchBinding("host-a", result.binding.bindingId);
    assert.equal(afterResult?.version === 2 && afterResult.eventCursor, 2);
    assert.equal(afterResult?.version === 2 && afterResult.resultCursor, 1);

    await pool.pauseMonitorSession("local-session-1");
    assert.ok(channel.calls.some((request) => request.method === "tools/call"
      && (request.params?.arguments as Record<string, unknown> | undefined)?.action === "unsubscribe"));
  } finally {
    await pool.close();
  }
});

test("completion router projects remote progress and wakes only on authoritative terminal state", async () => {
  const channel = new MonitorGatewayChannel();
  const bindings = new MemoryBindings();
  const deliveries: Array<{ sessionId: string; status: string; deliveryId: string }> = [];
  const executor = {
    async openChannel(_host: SshHost, _request: SshExecuteRequest): Promise<SshCommandChannel> {
      return { channel: channel as SshCommandChannel["channel"], effectiveDigest: DIGEST, close: () => channel.destroy() };
    },
  };
  const pool = new SshGatewayClientPool(executor, { bindingSource: bindings, now: () => NOW });
  const router = new GatewayCompletionRouter({
    pool,
    store: bindings,
    now: () => NOW,
    resolveTarget: (binding) => binding.hostId === "host-a" ? { host: host(), effectiveDigest: DIGEST } : undefined,
    deliver: (binding, completion) => {
      deliveries.push({ sessionId: binding.piSessionRef, status: completion.status, deliveryId: completion.deliveryId });
    },
  });
  router.setActiveSession("local-session-2");
  try {
    const started = await pool.execute(host(), DIGEST, {
      action: "start_pi",
      objective: "project monitor",
      requestId: "request-2",
    }, undefined, { piSessionRef: "local-session-2", todos: [] });
    const bindingId = (started.data as { binding: { bindingId: string } }).binding.bindingId;

    channel.notify(1, "progress", { toolCount: 3, tokens: 120, recentTools: [{ name: "bash", argsPreview: "npm test" }] });
    await until(() => collectExternalAgentProjections("local-session-2").some((item) => item.activeTool === "bash"));
    const running = collectExternalAgentProjections("local-session-2").find((item) => item.id === bindingId);
    assert.equal(running?.status, "running");
    assert.equal(running?.activeToolArgs, "npm test");
    assert.equal(running?.metrics?.toolCount, 3);

    channel.notify(2, "complete", { status: "completed" });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(deliveries.length, 0, "child/turn complete does not settle the Gateway task");

    channel.notify(3, "state", { status: "completed" });
    channel.notify(3, "state", { status: "completed" });
    await until(() => deliveries.length === 1
      && bindings.getGatewayLaunchBinding("host-a", bindingId)?.cursor === 3);
    assert.deepEqual(deliveries.map(({ sessionId, status }) => ({ sessionId, status })), [
      { sessionId: "local-session-2", status: "completed" },
    ]);
    const terminal = bindings.getGatewayLaunchBinding("host-a", bindingId);
    assert.equal(terminal?.version === 2 && terminal.monitorState?.status, "completed");
    assert.equal(terminal?.version === 2 && terminal.completion?.acceptedAt, NOW);
    assert.equal(terminal?.version === 2 && terminal.resultCursor, 1);
    assert.equal(collectExternalAgentProjections("other-session").length, 0);
    assert.equal(collectExternalAgentProjections("local-session-2").find((item) => item.id === bindingId)?.status, "done");
  } finally {
    await router.dispose();
    await pool.close();
  }
});

test("an idle SSH stdio disconnect reconnects and resumes the durable event cursor without polling", async () => {
  const first = new MonitorGatewayChannel();
  const second = new MonitorGatewayChannel();
  const channels = [first, second];
  const bindings = new MemoryBindings();
  const events: SshGatewayMonitorEvent[] = [];
  let opens = 0;
  const executor = {
    async openChannel(_host: SshHost, _request: SshExecuteRequest): Promise<SshCommandChannel> {
      const channel = channels[opens++];
      if (!channel) throw new Error("unexpected reconnect");
      return { channel: channel as SshCommandChannel["channel"], effectiveDigest: DIGEST, close: () => channel.destroy() };
    },
  };
  const pool = new SshGatewayClientPool(executor, {
    bindingSource: bindings,
    now: () => NOW,
    monitorSink: { onEvent: (event) => { events.push(event); } },
  });
  try {
    await pool.execute(host(), DIGEST, {
      action: "start_pi",
      objective: "reconnect monitor",
      requestId: "request-reconnect",
    }, undefined, { piSessionRef: "local-session-reconnect", todos: [] });
    assert.equal(opens, 1);
    first.destroy();
    await until(() => opens === 2 && second.calls.some((request) => request.method === "tools/call"
      && (request.params?.arguments as Record<string, unknown> | undefined)?.action === "subscribe"));
    const subscribe = second.calls.find((request) => request.method === "tools/call"
      && (request.params?.arguments as Record<string, unknown> | undefined)?.action === "subscribe");
    assert.equal((subscribe?.params?.arguments as Record<string, unknown>).cursor, 0);
    second.notify(1, "state", { status: "running" });
    await until(() => events.length === 1);
    assert.equal(events[0]?.notification.cursor, 1);
  } finally {
    await pool.close();
  }
});
