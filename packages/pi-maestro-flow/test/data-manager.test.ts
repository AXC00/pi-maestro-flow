import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  createDefaultDataManagerRegistry,
  DataManagerRegistry,
  executeDataManagerCommand,
  parseCleanupAge,
  registerDataManagerCommand,
  type ManagedDataItem,
  type ManagedDataSource,
} from "../src/tools/data-manager.ts";

function source(deletions: string[]): ManagedDataSource {
  return {
    id: "example",
    label: "Example data",
    async load() {
      return {
        sourceId: "example",
        label: "Example data",
        scope: "Current workspace",
        totalBytes: 12,
        capacity: { used: 1, limit: 5 },
        items: [{
          id: "item-1",
          title: "First item",
          detail: "Resource: example://item-1",
          sizeBytes: 12,
          updatedAt: "2026-08-12T10:00:00.000Z",
        }],
      };
    },
    async delete(_cwd, itemId) {
      deletions.push(itemId);
      return true;
    },
  };
}

function harness(confirm = true) {
  const notifications: Array<{ message: string; type: string }> = [];
  const confirmations: Array<{ title: string; message: string }> = [];
  const ctx = {
    cwd: "D:/workspace",
    ui: {
      notify(message: string, type: string) { notifications.push({ message, type }); },
      async confirm(title: string, message: string) {
        confirmations.push({ title, message });
        return confirm;
      },
      async select() { return undefined; },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications, confirmations };
}

function registry(deletions: string[]): DataManagerRegistry {
  const value = new DataManagerRegistry();
  value.register(source(deletions));
  return value;
}

test("data manager lists registered source occupancy", async () => {
  const h = harness();
  await executeDataManagerCommand("list", h.ctx, registry([]));
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0]!.message, /Example data · 1\/5 items · 12 B · Current workspace/);
});

test("data manager shows source items", async () => {
  const h = harness();
  await executeDataManagerCommand("show example", h.ctx, registry([]));
  assert.match(h.notifications[0]!.message, /First item · 12 B · 2026-08-12 10:00:00 · item-1/);
});

test("data manager deletes only after explicit confirmation", async () => {
  const cancelled: string[] = [];
  const cancelHarness = harness(false);
  await executeDataManagerCommand("delete example item-1", cancelHarness.ctx, registry(cancelled));
  assert.deepEqual(cancelled, []);
  assert.equal(cancelHarness.confirmations.length, 1);

  const approved: string[] = [];
  const approveHarness = harness(true);
  await executeDataManagerCommand("delete example item-1", approveHarness.ctx, registry(approved));
  assert.deepEqual(approved, ["item-1"]);
  assert.match(approveHarness.notifications.at(-1)?.message ?? "", /Deleted item-1/);
});

test("data manager registers the user command", () => {
  const commands = new Map<string, unknown>();
  registerDataManagerCommand({
    registerCommand(name: string, command: unknown) { commands.set(name, command); },
  } as unknown as ExtensionAPI, registry([]));
  assert.ok(commands.has("data-manager"));
});

test("data manager rejects duplicate source ids", () => {
  const value = registry([]);
  assert.throws(() => value.register(source([])), /already registered/);
});

test("default registry contains only the five approved workspace sources", () => {
  assert.deepEqual(
    createDefaultDataManagerRegistry().list().map((entry) => entry.id),
    ["session-history", "usage-history", "teammate-output", "artifact-export", "tool-spill"],
  );
});

test("cleanup age accepts bounded hour, day, and week durations", () => {
  assert.equal(parseCleanupAge("24h"), 24 * 60 * 60 * 1_000);
  assert.equal(parseCleanupAge("7d"), 7 * 24 * 60 * 60 * 1_000);
  assert.equal(parseCleanupAge("2w"), 14 * 24 * 60 * 60 * 1_000);
  assert.equal(parseCleanupAge("0d"), undefined);
  assert.equal(parseCleanupAge("1m"), undefined);
  assert.equal(parseCleanupAge("999999999999999999999w"), undefined);
});

function guardedRegistry(
  loadItems: () => ManagedDataItem[],
  guardedDelete: ManagedDataSource["guardedDelete"],
  forceDelete?: ManagedDataSource["forceDelete"],
): DataManagerRegistry {
  const value = new DataManagerRegistry();
  value.register({
    id: "managed",
    label: "Managed data",
    async load() {
      const items = loadItems();
      return {
        sourceId: "managed",
        label: "Managed data",
        scope: "Current workspace",
        totalBytes: items.reduce((total, item) => total + item.sizeBytes, 0),
        items,
      };
    },
    async delete() { return false; },
    guardedDelete,
    ...(forceDelete ? { forceDelete } : {}),
  });
  return value;
}

const oldItem = (overrides: Partial<ManagedDataItem> = {}): ManagedDataItem => ({
  id: "old-item",
  title: "Old item",
  detail: "Managed test item",
  sizeBytes: 128,
  updatedAt: "2026-08-01T00:00:00.000Z",
  revision: "revision-1",
  cleanupEligible: true,
  ...overrides,
});

const fixedNow = { now: () => new Date("2026-08-31T00:00:00.000Z") };

test("data manager reports aggregate and per-source statistics", async () => {
  const h = harness();
  await executeDataManagerCommand("stats", h.ctx, guardedRegistry(
    () => [oldItem(), oldItem({ id: "protected", protectionReason: "active" })],
    async () => ({ status: "deleted" }),
  ), fixedNow);
  assert.match(h.notifications[0]!.message, /All sources · 2 items · 256 B · cleanup-eligible 1 · protected 1/);
  assert.match(h.notifications[0]!.message, /Managed data · 2 items/);
});

test("protected items cannot enter explicit deletion confirmation", async () => {
  const h = harness(true);
  let deleted = false;
  await executeDataManagerCommand("delete managed old-item", h.ctx, guardedRegistry(
    () => [oldItem({ protectionReason: "current session" })],
    async () => {
      deleted = true;
      return { status: "deleted" };
    },
  ), fixedNow);
  assert.equal(deleted, false);
  assert.equal(h.confirmations.length, 0);
  assert.match(h.notifications[0]!.message, /Protected item old-item: current session/);
});

test("force delete requires explicit source opt-in and two confirmations", async () => {
  const h = harness(true);
  const deletions: string[] = [];
  await executeDataManagerCommand("force-delete managed old-item", h.ctx, guardedRegistry(
    () => [oldItem({ cleanupEligible: false, forceCleanupEligible: true, protectionReason: "soft protection" })],
    async () => ({ status: "protected" }),
    async (request) => {
      deletions.push(request.itemId);
      return { status: "deleted", reclaimedBytes: request.item.sizeBytes };
    },
  ), fixedNow);
  assert.equal(h.confirmations.length, 2);
  assert.match(h.confirmations[0]!.message, /Protection being overridden: soft protection/);
  assert.match(h.confirmations[1]!.title, /irreversible/);
  assert.deepEqual(deletions, ["old-item"]);
  assert.match(h.notifications.at(-1)?.message ?? "", /Force-deleted old-item/);
});

test("hard-protected items cannot enter force deletion confirmation", async () => {
  const h = harness(true);
  let deleted = false;
  await executeDataManagerCommand("force-delete managed old-item", h.ctx, guardedRegistry(
    () => [oldItem({ cleanupEligible: false, forceCleanupEligible: false, protectionReason: "current session" })],
    async () => ({ status: "protected" }),
    async () => {
      deleted = true;
      return { status: "deleted" };
    },
  ), fixedNow);
  assert.equal(h.confirmations.length, 0);
  assert.equal(deleted, false);
  assert.match(h.notifications[0]!.message, /not eligible for force deletion/);
});

test("force delete refreshes session identity after confirmation", async () => {
  let currentSessionId = "before-confirmation";
  let confirmations = 0;
  let observedContext: string | undefined;
  let observedRevalidation: string | undefined;
  const ctx = {
    cwd: "D:/workspace",
    sessionManager: {
      getSessionId: () => currentSessionId,
      getSessionFile: () => `D:/sessions/${currentSessionId}.jsonl`,
      getSessionDir: () => "D:/sessions",
    },
    ui: {
      notify() {},
      async confirm() {
        confirmations += 1;
        if (confirmations === 1) currentSessionId = "after-confirmation";
        return true;
      },
      async select() { return undefined; },
    },
  } as unknown as ExtensionCommandContext;
  await executeDataManagerCommand("force-delete managed old-item", ctx, guardedRegistry(
    () => [oldItem({ cleanupEligible: false, forceCleanupEligible: true, protectionReason: "soft protection" })],
    async () => ({ status: "protected" }),
    async (request) => {
      observedContext = request.context.currentSessionId;
      observedRevalidation = request.revalidateContext?.().currentSessionId;
      return { status: "protected" };
    },
  ), fixedNow);
  assert.equal(confirmations, 2);
  assert.equal(observedContext, "after-confirmation");
  assert.equal(observedRevalidation, "after-confirmation");
});

test("time cleanup previews, confirms, and uses guarded deletion", async () => {
  const h = harness(true);
  const deletions: string[] = [];
  await executeDataManagerCommand("cleanup 7d managed", h.ctx, guardedRegistry(
    () => [oldItem()],
    async (request) => {
      deletions.push(request.itemId);
      return { status: "deleted", reclaimedBytes: request.item.sizeBytes };
    },
  ), fixedNow);
  assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0]!.message, /1 items · 128 B/);
  assert.deepEqual(deletions, ["old-item"]);
  assert.match(h.notifications.at(-1)?.message ?? "", /deleted 1 .* reclaimed 128 B/);
});

test("force cleanup includes opted-in protected items and keeps ordinary cleanup unchanged", async () => {
  const protectedItem = oldItem({ cleanupEligible: false, forceCleanupEligible: true, protectionReason: "inactivity is unproven" });
  const ordinary = harness(true);
  let forceCalls = 0;
  const value = guardedRegistry(
    () => [protectedItem],
    async () => ({ status: "protected" }),
    async () => {
      forceCalls += 1;
      return { status: "deleted", reclaimedBytes: protectedItem.sizeBytes };
    },
  );
  await executeDataManagerCommand("cleanup 7d managed", ordinary.ctx, value, fixedNow);
  assert.equal(ordinary.confirmations.length, 0);
  assert.equal(forceCalls, 0);
  assert.match(ordinary.notifications[0]!.message, /Protected\/skipped old items: 1/);

  const forced = harness(true);
  await executeDataManagerCommand("force-cleanup 7d managed", forced.ctx, value, fixedNow);
  assert.equal(forced.confirmations.length, 2);
  assert.match(forced.confirmations[0]!.message, /Force-authorized protected items: 1/);
  assert.equal(forceCalls, 1);
  assert.match(forced.notifications.at(-1)?.message ?? "", /Force cleanup complete · deleted 1/);
});

test("time cleanup cancellation and legacy sources have no side effects", async () => {
  const cancelled = harness(false);
  let guardedCalls = 0;
  await executeDataManagerCommand("cleanup 7d managed", cancelled.ctx, guardedRegistry(
    () => [oldItem()],
    async () => {
      guardedCalls += 1;
      return { status: "deleted" };
    },
  ), fixedNow);
  assert.equal(cancelled.confirmations.length, 1);
  assert.equal(guardedCalls, 0);

  const legacyDeletes: string[] = [];
  const legacyHarness = harness(true);
  await executeDataManagerCommand("cleanup 7d all", legacyHarness.ctx, registry(legacyDeletes), fixedNow);
  assert.equal(legacyHarness.confirmations.length, 0);
  assert.deepEqual(legacyDeletes, []);
  assert.match(legacyHarness.notifications[0]!.message, /Protected\/skipped old items: 1/);
});

test("cleanup rejects a revision changed after preview", async () => {
  const h = harness(true);
  let loads = 0;
  let guardedCalls = 0;
  await executeDataManagerCommand("cleanup 7d managed", h.ctx, guardedRegistry(
    () => [oldItem({ revision: ++loads === 1 ? "revision-1" : "revision-2" })],
    async () => {
      guardedCalls += 1;
      return { status: "deleted" };
    },
  ), fixedNow);
  assert.equal(guardedCalls, 0);
  assert.match(h.notifications.at(-1)?.message ?? "", /protected\/stale 1/);
});

test("cleanup retains truthful partial statuses and per-item messages after destructive progress", async () => {
  const h = harness(true);
  await executeDataManagerCommand("cleanup 7d managed", h.ctx, guardedRegistry(
    () => [oldItem({ id: "ok" }), oldItem({ id: "partial", revision: "revision-2" })],
    async (request) => request.itemId === "ok"
      ? { status: "deleted", reclaimedBytes: request.item.sizeBytes, message: "index refresh warning" }
      : { status: "partial", message: "target removed; sidecar reconciliation failed" },
  ), fixedNow);
  const message = h.notifications.at(-1)?.message ?? "";
  assert.match(message, /deleted 1 .* partial 1 .* reclaimed 128 B/);
  assert.match(message, /Managed data · ok: deleted · index refresh warning/);
  assert.match(message, /Managed data · partial: partial · target removed; sidecar reconciliation failed/);
  assert.equal(h.notifications.at(-1)?.type, "warning");
});

test("explicit delete reports successful removal with a reconciliation warning", async () => {
  const h = harness(true);
  await executeDataManagerCommand("delete managed old-item", h.ctx, guardedRegistry(
    () => [oldItem()],
    async () => ({ status: "deleted", message: "non-authoritative index reconciliation failed" }),
  ), fixedNow);
  assert.match(h.notifications.at(-1)?.message ?? "", /Deleted old-item.*Warning: non-authoritative index reconciliation failed/);
  assert.equal(h.notifications.at(-1)?.type, "warning");
});

test("statistics isolate a failing source", async () => {
  const value = guardedRegistry(() => [oldItem()], async () => ({ status: "deleted" }));
  value.register({
    id: "broken",
    label: "Broken data",
    async load() { throw new Error("unavailable"); },
    async delete() { return false; },
  });
  const h = harness();
  await executeDataManagerCommand("stats", h.ctx, value, fixedNow);
  assert.match(h.notifications[0]!.message, /Managed data · 1 items/);
  assert.match(h.notifications[0]!.message, /Broken data \(broken\): unavailable/);
  assert.equal(h.notifications[0]!.type, "warning");
});
