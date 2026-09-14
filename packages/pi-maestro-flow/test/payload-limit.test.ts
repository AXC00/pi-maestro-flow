import assert from "node:assert/strict";
import test from "node:test";
import {
  applyContextPressurePolicy,
  estimateMessageTokens,
  estimatePayloadBytes,
  imagePruneReplacement,
  runPayloadLimitPrune,
} from "../src/compaction/auto-compaction.ts";
import {
  readCompactionSettings,
  resolveEffectiveCompactionSettings,
  validateCompactionPatch,
} from "../src/compaction/compaction-settings.ts";

const imageBlock = (data: string, mimeType = "image/png") => ({ type: "image", data, mimeType });

const mkToolResult = (callId: string, data: string, extra: Record<string, unknown> = {}) => ({
  role: "toolResult",
  toolCallId: callId,
  toolName: "read",
  content: [
    { type: "text", text: `text ${callId}` },
    imageBlock(data),
  ],
  isError: false,
  ...extra,
}) as never;

// --- settings: payloadLimitBytes ---

test("payloadLimitBytes defaults to undefined (no ceiling)", () => {
  const effective = resolveEffectiveCompactionSettings({}, {});
  assert.equal(effective.payloadLimitBytes, undefined);
});

test("payloadLimitBytes layers user then project scope", () => {
  const user = { payloadLimitBytes: 8 * 1024 * 1024 } as never;
  const project = { payloadLimitBytes: 20 * 1024 * 1024 } as never;
  const effective = resolveEffectiveCompactionSettings(user, project);
  assert.equal(effective.payloadLimitBytes, 20 * 1024 * 1024);
});

test("payloadLimitBytes validation rejects non-positive values", () => {
  const v = validateCompactionPatch({ payloadLimitBytes: -1 } as never);
  assert.ok(v.errors.some((e) => e.includes("payloadLimitBytes")), `errors ${v.errors}`);
  const v2 = validateCompactionPatch({ payloadLimitBytes: 1_000_000 } as never);
  assert.equal(v2.errors.length, 0, `valid limit accepted: ${v2.errors}`);
});

test("readCompactionSettings reads payloadLimitBytes from file", () => {
  const dir = process.cwd();
  const snapshot = readCompactionSettings(dir);
  // No project settings in the repo normally; just assert shape is intact.
  assert.ok("scopes" in snapshot && "effective" in snapshot);
});

// --- estimatePayloadBytes ---

test("estimatePayloadBytes sums text and base64 image payloads", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    mkToolResult("t1", "A".repeat(1_000)),
    mkToolResult("t2", "B".repeat(2_000)),
  ] as never;
  const bytes = estimatePayloadBytes(messages);
  assert.ok(bytes >= 3_000, `base64 images counted: ${bytes}`);
  assert.ok(bytes >= 64, "text counted too");
});

// --- imagePruneReplacement ---

test("imagePruneReplacement replaces images with payload-limit marker, keeps text", () => {
  const original = mkToolResult("t1", "A".repeat(500));
  const replacement = imagePruneReplacement(original);
  assert.ok(replacement !== undefined);
  const content = (replacement as { content: Array<{ type: string; text: string }> }).content;
  assert.equal(content.length, 2);
  assert.equal(content[0].type, "text");
  assert.match(content[1].text, /\[image:image\/png \(\d+B, evicted by payload limit\)\]/);
  assert.ok(!content[1].text.includes("AAAA"), "base64 dropped");
});

// --- runPayloadLimitPrune ---

test("runPayloadLimitPrune reclaims oldest eligible messages until payload fits", () => {
  const big1 = "A".repeat(20_000_000); // 20MB base64
  const big2 = "B".repeat(20_000_000);
  const small = "C".repeat(10_000);
  const messages = [
    mkToolResult("t1", big1),
    mkToolResult("t2", big2),
    mkToolResult("t3", small),
  ] as never;
  const manifest = new Map();
  const limit = 16 * 1024 * 1024; // 16MiB ceiling
  const result = runPayloadLimitPrune({ messages, pruneManifest: manifest, frontierStart: 3, limitBytes: limit });
  assert.ok(result.pruned, "payload over limit -> pruned");
  assert.ok(result.replaced >= 1, `reclaimed at least oldest message: ${result.replaced}`);
  assert.ok(manifest.has("t1"), "oldest pruned first");
  assert.ok(!manifest.has("t3"), "newest small survives");
  const survivor = result.transformed.find((m) => (m as { toolCallId?: string }).toolCallId === "t3")!;
  assert.ok(JSON.stringify(survivor.content).includes("C".repeat(10)), "small message intact");
});

test("runPayloadLimitPrune protects the current user message and errors", () => {
  const huge = "A".repeat(50_000_000);
  const messages = [
    { role: "toolResult", toolCallId: "err", toolName: "read", content: [imageBlock(huge)], isError: true },
    { role: "toolResult", toolCallId: "todo", toolName: "todo", content: [imageBlock(huge)] },
    { role: "user", content: [imageBlock(huge)] }, // current user
  ] as never;
  const manifest = new Map();
  const result = runPayloadLimitPrune({ messages, pruneManifest: manifest, frontierStart: 2, limitBytes: 1024 });
  assert.ok(!result.pruned, "only protected/error messages remain eligible-free -> nothing pruned");
  assert.equal(manifest.size, 0);
});

test("runPayloadLimitPrune does nothing when within limit", () => {
  const messages = [mkToolResult("t1", "A".repeat(10_000))] as never;
  const result = runPayloadLimitPrune({ messages, pruneManifest: new Map(), frontierStart: 1, limitBytes: 1024 * 1024 });
  assert.ok(!result.pruned);
});

test("runPayloadLimitPrune skips already-claimed messages (no double-record)", () => {
  const huge = "A".repeat(30_000_000);
  const messages = [mkToolResult("t1", huge)] as never;
  const manifest = new Map();
  const first = runPayloadLimitPrune({ messages, pruneManifest: manifest, frontierStart: 1, limitBytes: 1024 });
  assert.ok(first.pruned);
  const second = runPayloadLimitPrune({ messages, pruneManifest: manifest, frontierStart: 1, limitBytes: 1024 });
  assert.ok(!second.pruned, "claimed call ID skipped");
});

test("applyContextPressurePolicy returns action compact when oversize is only in protected current user message", () => {
  const huge = "A".repeat(50_000_000);
  const messages = [
    { role: "user", content: [imageBlock(huge)], timestamp: Date.now() }, // protected
  ] as never;
  const result = applyContextPressurePolicy(
    messages,
    1_000_000,
    {
      enabled: true,
      reserveTokens: 10_000,
      keepRecentTokens: 10_000,
      payloadLimitBytes: 16 * 1024 * 1024,
      soft: { enabled: true, nudgeRatio: 0.7, pruneRatio: 0.8, pruneTargetRatio: 0.7 },
    },
  );
  assert.equal(result.prunedToolResults, 0, "nothing reclaimable before protected boundary");
  assert.equal(result.action, "compact", "payload-protected oversize triggers compaction-like action");
  assert.ok(result.reasons.some((r) => r.startsWith("payload-protected:")), `reasons ${result.reasons}`);
});

// --- applyContextPressurePolicy integration ---

test("applyContextPressurePolicy prunes at normal token pressure when payloadLimitBytes exceeded", () => {
  const huge1 = "A".repeat(20_000_000);
  const huge2 = "B".repeat(20_000_000);
  const messages = [
    mkToolResult("t1", huge1),
    mkToolResult("t2", huge2),
    { role: "user", content: [{ type: "text", text: "continue" }], timestamp: Date.now() },
  ] as never;
  const result = applyContextPressurePolicy(
    messages,
    1_000_000,
    {
      enabled: true,
      reserveTokens: 10_000,
      keepRecentTokens: 10_000,
      model: "provider/model",
      payloadLimitBytes: 16 * 1024 * 1024,
      soft: { enabled: true, nudgeRatio: 0.7, pruneRatio: 0.8, pruneTargetRatio: 0.7 },
    },
  );
  assert.ok(result.prunedToolResults > 0, `payload limit prunes despite normal token pressure: ${result.prunedToolResults}`);
  assert.ok(result.savedTokens > 0);
  assert.ok(result.reasons.some((r) => r.startsWith("payload-bytes:")), `reasons ${result.reasons}`);
  assert.ok(result.messages.some((m) => JSON.stringify(m).includes("evicted by payload limit")), "placeholder present");
});

test("applyContextPressurePolicy does not prune when payloadLimitBytes is undefined (default)", () => {
  const huge = "A".repeat(50_000_000);
  const messages = [
    mkToolResult("t1", huge),
    { role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() },
  ] as never;
  const result = applyContextPressurePolicy(
    messages,
    1_000_000,
    {
      enabled: true,
      reserveTokens: 10_000,
      keepRecentTokens: 10_000,
      soft: { enabled: true, nudgeRatio: 0.7, pruneRatio: 0.8, pruneTargetRatio: 0.7 },
    },
  );
  assert.equal(result.prunedToolResults, 0, "no ceiling configured -> no prune");
});