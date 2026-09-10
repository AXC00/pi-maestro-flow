import assert from "node:assert/strict";
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

const root = await mkdtemp(join(tmpdir(), "pi-data-manager-session-"));
process.env.PI_CODING_AGENT_DIR = root;

const usage = await import("../src/providers/usage-history.ts");
const sessions = await import("pi-maestro-teammate/v1/sessions");
const { createSessionHistoryDataSource, createUsageHistoryDataSource } = await import("../src/tools/data-manager-session-sources.ts");

function publishLiveSessions(sessionIds: string[]): void {
  const owners = sessionIds.map((sessionId, index) => ({
    workspaceId: "workspace",
    ownerId: String(index + 1).padStart(32, "0"),
    ownerNonce: `nonce-${index}`,
    scope: index === 0 ? "local" as const : "workspace-peer" as const,
    status: "running" as const,
    sessionId,
    agents: [],
  }));
  sessions.publishSessionHostRegistry(new sessions.SessionHostRegistry({
    endpoints: sessions.projectSessionEndpoints(owners),
  }));
  sessions.publishSessionHostDirectoryRefresh(async () => undefined);
}

function record(sessionId: string, cwd: string, ts: number) {
  return {
    ts, model: "model", provider: "provider", sessionId, cwd,
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    cost: { total: 0.01, input: 0, output: 0.01, cacheRead: 0, cacheWrite: 0 },
  };
}

function message(ts: number) {
  return {
    role: "assistant", content: [], provider: "provider", model: "model", timestamp: ts,
    usage: {
      input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
      cost: { total: 0.01, input: 0, output: 0.01, cacheRead: 0, cacheWrite: 0 },
    },
  } as never;
}

function legacyPath(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 200) || "unknown";
  return join(usage.usageHistoryDir(), `${safe}.jsonl`);
}

async function jsonl(path: string, records: unknown[]): Promise<void> {
  await mkdir(usage.usageHistoryDir(), { recursive: true });
  await writeFile(path, `${records.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
}

test("session-history force deletion removes only valid non-current workspace transcripts", async () => {
  const dir = join(root, "transcript-inventory");
  await mkdir(dir, { recursive: true });
  const current = join(dir, "current.jsonl");
  const old = join(dir, "old.jsonl");
  await writeFile(current, `${JSON.stringify({ type: "session", id: "current", cwd: "/ws" })}\n`);
  await writeFile(old, `${JSON.stringify({ type: "session", id: "old", cwd: "/ws" })}\n`);
  await symlink(old, join(dir, "linked.jsonl"), "file");

  const source = createSessionHistoryDataSource();
  const context = {
    cwd: "/ws", now: new Date(), currentSessionId: "current", currentSessionFile: current, currentSessionDir: dir,
  };
  const snapshot = await source.load("/ws", context);
  assert.equal(snapshot.items.length, 2);
  assert.ok(snapshot.items.every((item) => item.cleanupEligible === false && item.protectionReason));
  const currentItem = snapshot.items.find((item) => item.title === "current")!;
  const oldItem = snapshot.items.find((item) => item.title === "old")!;
  assert.match(currentItem.protectionReason!, /active/);
  assert.equal(currentItem.forceCleanupEligible, false);
  assert.match(oldItem.protectionReason!, /host-owned/);
  assert.equal(oldItem.forceCleanupEligible, true);
  assert.equal(await source.delete("/ws", currentItem.id), false);

  const protectedResult = await source.forceDelete!({
    cwd: "/ws", itemId: currentItem.id, revision: currentItem.revision!, item: currentItem, context,
  });
  assert.equal(protectedResult.status, "protected");
  assert.equal(existsSync(current), true);

  const deleted = await source.forceDelete!({
    cwd: "/ws", itemId: oldItem.id, revision: oldItem.revision!, item: oldItem, context,
  });
  assert.equal(deleted.status, "deleted");
  assert.equal(existsSync(old), false);
});

test("session-history force deletion rejects a transcript changed after preview", async () => {
  const dir = join(root, "transcript-stale");
  await mkdir(dir, { recursive: true });
  const old = join(dir, "old.jsonl");
  await writeFile(old, `${JSON.stringify({ type: "session", id: "old-stale", cwd: "/ws" })}\n`);
  const source = createSessionHistoryDataSource();
  const context = { cwd: "/ws", now: new Date(), currentSessionId: "current", currentSessionDir: dir };
  const item = (await source.load("/ws", context)).items[0]!;
  await appendFile(old, `${JSON.stringify({ type: "message", text: "changed" })}\n`);
  const result = await source.forceDelete!({ cwd: "/ws", itemId: item.id, revision: item.revision!, item, context });
  assert.equal(result.status, "stale");
  assert.equal(existsSync(old), true);
});

test("session-history force deletion fails closed without current-session identity", async () => {
  const dir = join(root, "transcript-no-current-identity");
  await mkdir(dir, { recursive: true });
  const old = join(dir, "old.jsonl");
  await writeFile(old, `${JSON.stringify({ type: "session", id: "identity-unknown", cwd: "/ws" })}\n`);
  const source = createSessionHistoryDataSource();
  const context = { cwd: "/ws", now: new Date(), currentSessionDir: dir };
  const item = (await source.load("/ws", context)).items[0]!;
  assert.equal(item.forceCleanupEligible, false);
  assert.match(item.protectionReason ?? "", /identity is unavailable/);
  const result = await source.forceDelete!({ cwd: "/ws", itemId: item.id, revision: item.revision!, item, context });
  assert.equal(result.status, "protected");
  assert.equal(existsSync(old), true);
});

test("session-history force deletion restores a transcript that becomes current at the destructive edge", async () => {
  const dir = join(root, "transcript-becomes-current");
  await mkdir(dir, { recursive: true });
  const old = join(dir, "old.jsonl");
  await writeFile(old, `${JSON.stringify({ type: "session", id: "becomes-current", cwd: "/ws" })}\n`);
  const source = createSessionHistoryDataSource();
  const context = { cwd: "/ws", now: new Date(), currentSessionId: "other", currentSessionDir: dir };
  const item = (await source.load("/ws", context)).items[0]!;
  const result = await source.forceDelete!({
    cwd: "/ws",
    itemId: item.id,
    revision: item.revision!,
    item,
    context,
    revalidateContext: () => ({ ...context, currentSessionId: "becomes-current", currentSessionFile: old }),
  });
  assert.equal(result.status, "protected");
  assert.equal(existsSync(old), true);
});

test("session-history force deletion detects same-inode writes after quarantine", async () => {
  const dir = join(root, "transcript-quarantine-write");
  await mkdir(dir, { recursive: true });
  const old = join(dir, "old.jsonl");
  await writeFile(old, `${JSON.stringify({ type: "session", id: "quarantine-write", cwd: "/ws" })}\n`);
  const source = createSessionHistoryDataSource();
  const context = { cwd: "/ws", now: new Date(), currentSessionId: "other", currentSessionDir: dir };
  const item = (await source.load("/ws", context)).items[0]!;
  let revalidations = 0;
  const result = await source.forceDelete!({
    cwd: "/ws",
    itemId: item.id,
    revision: item.revision!,
    item,
    context,
    revalidateContext: () => {
      revalidations += 1;
      if (revalidations === 2) {
        const quarantine = readdirSync(dir).find((name) => name.endsWith(".transcript-delete"));
        assert.ok(quarantine);
        appendFileSync(join(dir, quarantine), `${JSON.stringify({ type: "message", text: "late write" })}\n`);
      }
      return context;
    },
  });
  assert.equal(result.status, "stale");
  assert.equal(existsSync(old), true);
  assert.match(await readFile(old, "utf8"), /late write/);
});

test("usage history uses full-digest keys and migrates legacy records losslessly", async () => {
  const sid = "legacy-session";
  const identical = record(sid, "/ws", 20);
  const equalTimestampDistinct = { ...record(sid, "/ws", 20), model: "legacy-distinct" };
  await jsonl(legacyPath(sid), [record(sid, "/ws", 10), identical, equalTimestampDistinct]);
  await jsonl(usage.usageSessionFile(sid), [identical, record(sid, "/ws", 30)]);

  await usage.inventoryUsageHistory("/ws");
  assert.equal(existsSync(legacyPath(sid)), false, "legacy is removed only after canonical write succeeds");
  const migrated = await usage.readHistory({ kind: "session", sessionId: sid });
  assert.deepEqual(migrated.map((item) => [item.ts, item.model]), [
    [10, "model"],
    [20, "model"],
    [20, "legacy-distinct"],
    [30, "model"],
  ]);

  const prefix = "x".repeat(210);
  const sidA = `${prefix}A`;
  const sidB = `${prefix}B`;
  await usage.recordUsage(message(100), sidA, "/ws");
  await usage.recordUsage(message(101), sidB, "/ws");
  assert.notEqual(usage.usageSessionFile(sidA), usage.usageSessionFile(sidB));
  assert.match(basename(usage.usageSessionFile(sidA)), /--[a-f0-9]{64}\.jsonl$/);
  assert.equal((await usage.readHistory({ kind: "session", sessionId: sidA })).length, 1);
  assert.equal((await usage.readHistory({ kind: "session", sessionId: sidB })).length, 1);
});

test("migration retains malformed canonical and its valid legacy source byte-for-byte", async () => {
  const sid = "malformed-canonical";
  const canonical = usage.usageSessionFile(sid);
  const legacy = legacyPath(sid);
  const canonicalRaw = `${JSON.stringify(record(sid, "/ws", 40))}\nraw-unparsed-data\n`;
  await mkdir(usage.usageHistoryDir(), { recursive: true });
  await writeFile(canonical, canonicalRaw, "utf8");
  await jsonl(legacy, [record(sid, "/ws", 50)]);

  await usage.inventoryUsageHistory("/ws");
  assert.equal(await readFile(canonical, "utf8"), canonicalRaw);
  assert.equal(existsSync(legacy), true);
  assert.equal((await readFile(legacy, "utf8")).includes('"ts":50'), true);
});

test("migration rejects invalid UTF-8 without rewriting either source", async () => {
  const sid = "invalid-utf8-canonical";
  const canonical = usage.usageSessionFile(sid);
  const legacy = legacyPath(sid);
  const encoded = JSON.stringify({ ...record(sid, "/ws", 60), model: "INVALID_MARKER" });
  const [before, after] = encoded.split("INVALID_MARKER");
  const canonicalRaw = Buffer.concat([Buffer.from(before!, "utf8"), Buffer.from([0xff]), Buffer.from(`${after!}\n`, "utf8")]);
  await mkdir(usage.usageHistoryDir(), { recursive: true });
  await writeFile(canonical, canonicalRaw);
  await jsonl(legacy, [record(sid, "/ws", 70)]);

  await usage.inventoryUsageHistory("/ws");
  assert.deepEqual(await readFile(canonical), canonicalRaw);
  assert.equal(existsSync(legacy), true);
  assert.equal((await readFile(legacy, "utf8")).includes('"ts":70'), true);
});

test("usage-history source protects authoritative live workspace peers and unsafe contents", async () => {
  publishLiveSessions(["live", "peer-live"]);
  await usage.recordUsage(message(200), "live", "/ws");
  await usage.recordUsage(message(199), "peer-live", "/ws");
  await jsonl(usage.usageSessionFile("mixed"), [record("mixed", "/ws", 201), record("mixed", "/other", 202)]);
  await writeFile(join(usage.usageHistoryDir(), "damaged.jsonl"), "not-json\n", "utf8");
  const foreignTarget = join(root, "foreign-usage.jsonl");
  await jsonl(foreignTarget, [record("linked", "/ws", 203)]);
  await symlink(foreignTarget, join(usage.usageHistoryDir(), "linked.jsonl"), "file");
  await usage.recordUsage(message(204), "stale", "/ws");

  const source = createUsageHistoryDataSource();
  const context = { cwd: "/ws", now: new Date(), currentSessionId: "live" };
  const snapshot = await source.load("/ws", context);
  const live = snapshot.items.find((item) => item.title === "live")!;
  const mixed = snapshot.items.find((item) => item.title === "mixed")!;
  const damaged = snapshot.items.find((item) => item.title === "damaged.jsonl")!;
  const peerLive = snapshot.items.find((item) => item.title === "peer-live")!;
  const linked = snapshot.items.find((item) => item.title === "linked.jsonl")!;
  assert.match(live.protectionReason!, /current session/);
  assert.match(peerLive.protectionReason!, /workspace peer session is active/);
  assert.match(mixed.protectionReason!, /mixed cwd/);
  assert.match(damaged.protectionReason!, /damaged/);
  assert.match(linked.protectionReason!, /symlink/);

  const stale = snapshot.items.find((item) => item.title === "stale")!;
  await appendFile(usage.usageSessionFile("stale"), `${JSON.stringify(record("stale", "/ws", 205))}\n`);
  const result = await source.guardedDelete!({ cwd: "/ws", itemId: stale.id, revision: stale.revision!, item: stale, context });
  assert.equal(result.status, "stale");
  assert.equal(existsSync(usage.usageSessionFile("stale")), true);
});

test("qualified usage cleanup deletes the real file and coordinates the index", async () => {
  publishLiveSessions(["another-live-session"]);
  await usage.recordUsage(message(300), "delete-me", "/ws");
  const source = createUsageHistoryDataSource();
  const context = { cwd: "/ws", now: new Date(), currentSessionId: "another-live-session" };
  const snapshot = await source.load("/ws", context);
  const item = snapshot.items.find((candidate) => candidate.title === "delete-me")!;
  assert.equal(item.cleanupEligible, true);
  assert.equal(item.protectionReason, undefined);

  const result = await source.guardedDelete!({ cwd: "/ws", itemId: item.id, revision: item.revision!, item, context });
  assert.equal(result.status, "deleted");
  assert.equal(existsSync(usage.usageSessionFile("delete-me")), false);
  assert.equal((await usage.readSessionIndex()).sessions.some((entry) => entry.sessionId === "delete-me"), false);

  // Exercise the same production cleanup path twice; the second call is safely missing.
  const again = await source.guardedDelete!({ cwd: "/ws", itemId: item.id, revision: item.revision!, item, context });
  assert.equal(again.status, "missing");
});

test("post-unlink index failure still reports deleted with a reconciliation warning", async () => {
  publishLiveSessions(["other-live"]);
  await usage.recordUsage(message(310), "delete-index-warning", "/ws");
  const source = createUsageHistoryDataSource();
  const context = { cwd: "/ws", now: new Date(), currentSessionId: "other-live" };
  const snapshot = await source.load("/ws", context);
  const item = snapshot.items.find((candidate) => candidate.title === "delete-index-warning")!;
  const index = join(usage.usageHistoryDir(), "index.json");
  await rm(index, { force: true });
  await mkdir(index);

  const result = await source.guardedDelete!({ cwd: "/ws", itemId: item.id, revision: item.revision!, item, context });
  assert.equal(result.status, "deleted");
  assert.match(result.message ?? "", /non-authoritative index reconciliation failed/);
  assert.equal(existsSync(usage.usageSessionFile("delete-index-warning")), false);
  await rm(index, { recursive: true, force: true });
});

test("usage cleanup is conservatively protected when authoritative live-session evidence is unavailable", async () => {
  sessions.publishSessionHostRegistry(undefined);
  sessions.publishSessionHostDirectoryRefresh(undefined);
  await usage.recordUsage(message(320), "unknown-liveness", "/ws");
  const source = createUsageHistoryDataSource();
  const snapshot = await source.load("/ws", { cwd: "/ws", now: new Date(), currentSessionId: "other" });
  const item = snapshot.items.find((candidate) => candidate.title === "unknown-liveness")!;
  assert.equal(item.cleanupEligible, false);
  assert.match(item.protectionReason ?? "", /live-session status is unavailable/);
});

test.after(async () => {
  sessions.publishSessionHostRegistry(undefined);
  sessions.publishSessionHostDirectoryRefresh(undefined);
  await rm(root, { recursive: true, force: true });
});
