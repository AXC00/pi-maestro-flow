import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  EXTERNAL_AGENT_PROJECTION_MAX_AGENTS_PER_PROVIDER,
  collectExternalAgentProjections,
  getExternalAgentProjectionProvider,
  listExternalAgentProjectionProviders,
  markAllExternalAgentProjectionsDirty,
  registerExternalAgentProjectionDirtyListener,
  registerExternalAgentProjectionProvider,
} from "../src/public/v1/external-agent-projections.ts";

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

test("collects only bounded sanitized projections for the requested session", () => {
  const long = "x".repeat(400);
  disposers.push(registerExternalAgentProjectionProvider({
    source: "ssh-gateway",
    snapshot: ({ sessionId, maxAgents }) => {
      assert.equal(sessionId, "session-a");
      assert.equal(maxAgents, EXTERNAL_AGENT_PROJECTION_MAX_AGENTS_PER_PROVIDER);
      return [{
        version: 1,
        source: "ssh-gateway",
        sessionId,
        id: " remote-1 ",
        label: ` Builder\n${long}`,
        status: "running",
        activeTool: " bash\n",
        activeToolArgs: long,
        metrics: { toolCount: 2.9, tokens: 1200, inputTokens: -1, ignored: "secret" },
        revision: " r1 ",
        updatedAt: 123.9,
        ignored: "not projected",
      }, {
        version: 1,
        source: "ssh-gateway",
        sessionId: "other-session",
        id: "leak",
        label: "leak",
        status: "running",
        updatedAt: 1,
      }];
    },
  }).dispose);

  const result = collectExternalAgentProjections("session-a");
  assert.equal(result.length, 1);
  assert.deepEqual(result[0]?.metrics, { toolCount: 2, tokens: 1200 });
  assert.equal(result[0]?.id, "remote-1");
  assert.equal(result[0]?.activeTool, "bash");
  assert.equal(result[0]?.updatedAt, 123);
  assert.ok((result[0]?.label.length ?? 0) <= 96);
  assert.ok((result[0]?.activeToolArgs?.length ?? 0) <= 256);
  assert.equal("ignored" in (result[0] as unknown as Record<string, unknown>), false);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result[0]));
});

test("filters source spoofing, malformed rows, duplicates, and throwing providers", () => {
  disposers.push(registerExternalAgentProjectionProvider({
    source: "ssh-gateway",
    snapshot: () => [{
      version: 1,
      source: "spoofed",
      sessionId: "session-a",
      id: "bad",
      label: "bad",
      status: "running",
      updatedAt: 1,
    }, {
      version: 1,
      source: "ssh-gateway",
      sessionId: "session-a",
      id: "ok",
      label: "ok",
      status: "done",
      updatedAt: 2,
    }, {
      version: 1,
      source: "ssh-gateway",
      sessionId: "session-a",
      id: "ok",
      label: "duplicate",
      status: "running",
      updatedAt: 3,
    }],
  }).dispose);
  disposers.push(registerExternalAgentProjectionProvider({
    source: "broken",
    snapshot: () => { throw new Error("boom"); },
  }).dispose);
  const logs: string[] = [];
  assert.deepEqual(collectExternalAgentProjections("session-a", (message) => logs.push(message)).map((item) => item.id), ["ok"]);
  assert.match(logs[0] ?? "", /broken.*boom/);
});

test("registration replacement and dirty notifications are best effort", () => {
  let dirty = 0;
  let upstream = 0;
  disposers.push(registerExternalAgentProjectionDirtyListener(() => { dirty += 1; }));
  const first = registerExternalAgentProjectionProvider({ source: "ssh-gateway", snapshot: () => [] });
  const replacement = {
    source: "ssh-gateway",
    snapshot: () => [],
    markDirty: () => { upstream += 1; },
  };
  const second = registerExternalAgentProjectionProvider(replacement);
  disposers.push(first.dispose, second.dispose);
  assert.equal(getExternalAgentProjectionProvider("ssh-gateway"), replacement);
  assert.equal(listExternalAgentProjectionProviders().length, 1);
  first.dispose();
  assert.ok(getExternalAgentProjectionProvider("ssh-gateway"));
  second.markDirty();
  assert.equal(dirty, 1);
  markAllExternalAgentProjectionsDirty();
  assert.equal(upstream, 1);
  assert.equal(dirty, 2);
  second.dispose();
  assert.equal(dirty, 3);
});
