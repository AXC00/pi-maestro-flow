import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { beginOAuthContinuation, initializeOAuth, shutdownOAuth } from "../src/mcp/mcp-auth-flow.ts";
import { getAuthForUrl } from "../src/mcp/mcp-auth.ts";
import {
  ensureCallbackServer,
  isCallbackServerRunning,
  stopCallbackServer,
  waitForCallback,
} from "../src/mcp/mcp-callback-server.ts";
import {
  getOAuthCallbackPath,
  getOAuthCallbackPort,
  McpOAuthProvider,
} from "../src/mcp/mcp-oauth-provider.ts";

test("OAuth callback bind stopped in reverse order cannot publish a late server", async () => {
  await stopCallbackServer();
  const starting = ensureCallbackServer({ oauthState: "old-bind-state", reserveState: true });
  const stopping = stopCallbackServer();
  const [startOutcome, stopOutcome] = await Promise.allSettled([starting, stopping]);
  assert.equal(stopOutcome.status, "fulfilled");
  assert.equal(startOutcome.status, "rejected");
  assert.equal(isCallbackServerRunning(), false);

  await ensureCallbackServer({ oauthState: "new-bind-state", reserveState: true });
  assert.equal(isCallbackServerRunning(), true);
  await stopCallbackServer();
  assert.equal(isCallbackServerRunning(), false);
});

test("OAuth callback from an old binding cannot resolve a new binding", async (t) => {
  await stopCallbackServer();
  t.after(async () => { await stopCallbackServer(); });

  await ensureCallbackServer({ oauthState: "old-callback-state", reserveState: true });
  const oldPort = getOAuthCallbackPort();
  const oldPath = getOAuthCallbackPath();
  const oldWait = waitForCallback("old-callback-state");
  oldWait.catch(() => undefined);
  await stopCallbackServer();
  await assert.rejects(oldWait, /stopped/u);

  await ensureCallbackServer({ oauthState: "new-callback-state", reserveState: true });
  const newWait = waitForCallback("new-callback-state");
  const port = getOAuthCallbackPort();
  const path = getOAuthCallbackPath();
  const oldResponse = await fetch(`http://localhost:${port}${path}?state=old-callback-state&code=old-code`);
  assert.equal(oldResponse.status, 400);
  const newResponse = await fetch(`http://localhost:${port}${path}?state=new-callback-state&code=new-code`);
  assert.equal(newResponse.status, 200);
  assert.equal(await newWait, "new-code");
  assert.ok(oldPort > 0);
  assert.equal(oldPath, path);
});

test("revoked OAuth provider cannot write credentials while a new generation can", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "mcp-oauth-fence-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  });

  await initializeOAuth();
  t.after(async () => { await shutdownOAuth(); });
  const oldGuard = beginOAuthContinuation("fenced-server");
  const oldProvider = new McpOAuthProvider("fenced-server", "https://example.test/mcp", {}, {
    onRedirect: async () => { oldGuard.assertCurrent(); },
    guard: oldGuard,
  });
  const unrelatedGuard = beginOAuthContinuation("unrelated-server");
  const newGuard = beginOAuthContinuation("fenced-server");
  unrelatedGuard.assertCurrent();
  const newProvider = new McpOAuthProvider("fenced-server", "https://example.test/mcp", {}, {
    onRedirect: async () => { newGuard.assertCurrent(); },
    guard: newGuard,
  });

  await assert.rejects(
    oldProvider.saveTokens({ access_token: "stale-secret", token_type: "Bearer" }),
    /no longer authoritative/u,
  );
  assert.equal(await getAuthForUrl("fenced-server", "https://example.test/mcp"), undefined);

  await newProvider.saveTokens({ access_token: "current-secret", token_type: "Bearer" });
  const stored = await getAuthForUrl("fenced-server", "https://example.test/mcp");
  assert.equal(stored?.tokens?.accessToken, "current-secret");

  const ordinaryProvider = new McpOAuthProvider("ordinary-server", "https://ordinary.test/mcp", {}, {
    onRedirect: async () => {},
  });
  await ordinaryProvider.saveTokens({ access_token: "ordinary-secret", token_type: "Bearer" });
  assert.equal(
    (await getAuthForUrl("ordinary-server", "https://ordinary.test/mcp"))?.tokens?.accessToken,
    "ordinary-secret",
    "configured MCP OAuth remains unchanged when no continuation guard is supplied",
  );
});
