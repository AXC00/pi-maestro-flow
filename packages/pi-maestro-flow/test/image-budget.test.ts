import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  applyContextPressurePolicy,
  estimateMessageTokens,
  imageBytesOfMessage,
  imagePruneReplacement,
  measureImageBytes,
  runImageBudgetPrune,
} from "../src/compaction/auto-compaction.ts";
import {
  DEFAULT_IMAGE_BUDGET,
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
    { type: "text", text: `text for ${callId}` },
    imageBlock(data),
  ],
  isError: false,
  ...extra,
}) as never;

// --- P1: measureImageBytes ---

test("measureImageBytes sums UTF-8 image bytes, count, and largest image", () => {
  const messages = [
    mkToolResult("t1", "A".repeat(1_000)),
    mkToolResult("t2", "B".repeat(3_000)),
  ] as never;
  const measured = measureImageBytes(messages);
  assert.equal(measured.imageCount, 2);
  assert.equal(measured.imageBytes, 4_000);
  assert.equal(measured.largestImageBytes, 3_000);
});

test("measureImageBytes ignores non-string and missing data, and text-only messages", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "toolResult", toolCallId: "x", content: [{ type: "image", mimeType: "image/png" }] },
    { role: "toolResult", toolCallId: "y", content: [{ type: "image", data: 42 }] },
  ] as never;
  const measured = measureImageBytes(messages);
  assert.equal(measured.imageCount, 0);
  assert.equal(measured.imageBytes, 0);
  assert.equal(measured.largestImageBytes, 0);
});

// --- P2: imagePruneReplacement ---

test("imagePruneReplacement replaces image blocks with metadata marker, keeps text", () => {
  const original = mkToolResult("t1", "A".repeat(500));
  const replacement = imagePruneReplacement(original);
  assert.ok(replacement !== undefined);
  const content = (replacement as { content: Array<{ type: string; text: string }> }).content;
  assert.equal(content.length, 2);
  assert.equal(content[0].type, "text");
  assert.match(content[1].text, /\[image:image\/png \(\d+B, pruned by image byte budget\)\]/);
  assert.ok(!content[1].text.includes("AAAA"), "base64 must not reach placeholder");
});

test("imagePruneReplacement is deterministic and returns undefined for text-only", () => {
  const original = mkToolResult("t1", "A".repeat(500));
  const r1 = imagePruneReplacement(original);
  const r2 = imagePruneReplacement(original);
  assert.equal(JSON.stringify(r1), JSON.stringify(r2), "deterministic replacement");
  const textOnly = { role: "toolResult", toolCallId: "t2", content: [{ type: "text", text: "x" }] } as never;
  assert.equal(imagePruneReplacement(textOnly), undefined);
});

// --- P3: runImageBudgetPrune ---

test("runImageBudgetPrune prunes oldest images when aggregate budget is exceeded", () => {
  const big1 = "A".repeat(6_000_000); // ~6MB
  const big2 = "B".repeat(5_000_000); // ~5MB
  const small = "C".repeat(10_000);
  const messages = [
    mkToolResult("t1", big1),
    mkToolResult("t2", big2),
    mkToolResult("t3", small),
  ] as never;
  const manifest = new Map();
  const budget = { enabled: true, maxBytesPerImage: 4 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 };
  const result = runImageBudgetPrune({
    messages,
    pruneManifest: manifest,
    frontierStart: messages.length,
    budget,
  });
  assert.ok(result.pruned, "budget exceeded -> pruned");
  assert.ok(result.replaced >= 2, "prunes oldest images until total under budget");
  assert.ok(result.savedBytes >= 11_000_000, `savedBytes ${result.savedBytes} reclaims the big payloads`);
  assert.ok(result.savedTokens > 0, `savedTokens ${result.savedTokens}`);
  assert.ok(manifest.has("t1") && manifest.has("t2"), "manifest records image-level prunes");
  assert.equal((manifest.get("t1")!).level, "image");
  // t3 (small) survives
  const survivor = result.transformed.find((m) => (m as { toolCallId?: string }).toolCallId === "t3")!;
  assert.ok(imageBytesOfMessage(survivor) === 10_000, "small image survives");
});

test("runImageBudgetPrune prunes a single oversized image even with small total", () => {
  const huge = "A".repeat(30_000_000); // ~30MB base64 > 16MiB per-image
  const messages = [mkToolResult("t1", huge)] as never;
  const manifest = new Map();
  const result = runImageBudgetPrune({
    messages,
    pruneManifest: manifest,
    frontierStart: 1,
    budget: { enabled: true, maxBytesPerImage: 4 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 },
  });
  assert.ok(result.pruned, "single oversized image triggers prune");
  assert.ok(manifest.has("t1"));
  const replaced = result.transformed[0] as { content?: Array<{ type: string; text: string }> };
  assert.ok(Array.isArray(replaced.content), "content replaced with blocks");
  assert.ok(replaced.content.some((b) => b.type === "text" && /pruned by image byte budget/.test(b.text)), "placeholder text present");
});

test("runImageBudgetPrune leaves protected messages untouched", () => {
  const huge = "A".repeat(20_000_000);
  const messages = [
    { role: "toolResult", toolCallId: "err", toolName: "read", content: [imageBlock(huge)], isError: true },
    { role: "toolResult", toolCallId: "todo", toolName: "todo", content: [imageBlock(huge)] },
    { role: "toolResult", toolCallId: "t2", toolName: "read", content: [imageBlock(huge)] },
    { role: "user", content: [imageBlock(huge)] }, // current user message
  ] as never;
  const manifest = new Map();
  const result = runImageBudgetPrune({
    messages,
    pruneManifest: manifest,
    frontierStart: 3, // protect the user message (index 3) and beyond
    budget: { enabled: true, maxBytesPerImage: 4 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 },
  });
  // err (error) and todo (control) are ineligible; t2 is a valid candidate.
  assert.ok(result.pruned, "eligible image-bearing tool result should be pruned");
  assert.ok(manifest.has("t2"), "t2 pruned");
  assert.ok(!manifest.has("err"), "error result untouched");
  assert.ok(!manifest.has("todo"), "control tool untouched");
  const userMessage = result.transformed[3] as { content?: Array<{ type?: string }> };
  assert.equal(userMessage.content![0]!.type, "image", "current user image untouched");
});

test("runImageBudgetPrune respects manifest claim (no double-record) and does not re-prune", () => {
  const huge = "A".repeat(20_000_000);
  const messages = [mkToolResult("t1", huge)] as never;
  const manifest = new Map();
  const first = runImageBudgetPrune({ messages, pruneManifest: manifest, frontierStart: 1, budget: DEFAULT_IMAGE_BUDGET });
  assert.ok(first.pruned);
  const second = runImageBudgetPrune({ messages, pruneManifest: manifest, frontierStart: 1, budget: DEFAULT_IMAGE_BUDGET });
  assert.ok(!second.pruned, "already-pruned call ID is claimed; no double prune");
});

// --- P4: applyContextPressurePolicy integration ---

test("applyContextPressurePolicy prunes images at normal token pressure when image budget exceeded", () => {
  const huge1 = "A".repeat(20_000_000);
  const huge2 = "B".repeat(20_000_000);
  const messages = [
    mkToolResult("t1", huge1),
    mkToolResult("t2", huge2),
    { role: "user", content: [{ type: "text", text: "continue please" }], timestamp: Date.now() },
  ] as never;
  const contextWindow = 1_000_000;
  const result = applyContextPressurePolicy(
    messages,
    contextWindow,
    {
      enabled: true,
      reserveTokens: 10_000,
      keepRecentTokens: 10_000,
      model: "provider/model",
      soft: {
        enabled: true,
        nudgeRatio: 0.7,
        pruneRatio: 0.8,
        pruneTargetRatio: 0.7,
        imageBudget: { enabled: true, maxBytesPerImage: 4 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 },
      },
    },
  );
  // Token fullness is tiny; without the image budget nothing would prune, but
  // the byte budget forces oldest image pruning.
  assert.ok(result.prunedToolResults > 0, `should prune images despite normal token pressure, got ${result.prunedToolResults}`);
  assert.ok(result.savedTokens > 0, `savedTokens ${result.savedTokens}`);
  assert.ok(result.band === "normal" || result.band === "auto-prune", `band ${result.band}`);
  // Placeholders visible
  assert.ok(result.messages.some((m) => JSON.stringify(m).includes("pruned by image byte budget")), "placeholder present");
});

test("applyContextPressurePolicy does not prune images when budget not exceeded", () => {
  const messages = [
    mkToolResult("t1", "A".repeat(10_000)),
    { role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() },
  ] as never;
  const result = applyContextPressurePolicy(
    messages,
    1_000_000,
    {
      enabled: true,
      reserveTokens: 10_000,
      keepRecentTokens: 10_000,
      soft: {
        enabled: true,
        nudgeRatio: 0.7,
        pruneRatio: 0.8,
        pruneTargetRatio: 0.7,
        imageBudget: { enabled: true, maxBytesPerImage: 4 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 },
      },
    },
  );
  assert.equal(result.prunedToolResults, 0, "no budget pressure -> no prune");
});

test("applyContextPressurePolicy skips image prune when imageBudget disabled", () => {
  const huge = "A".repeat(50_000_000);
  const messages = [mkToolResult("t1", huge)] as never;
  const result = applyContextPressurePolicy(
    messages,
    1_000_000,
    {
      enabled: true,
      reserveTokens: 10_000,
      keepRecentTokens: 10_000,
      soft: {
        enabled: true,
        nudgeRatio: 0.7,
        pruneRatio: 0.8,
        pruneTargetRatio: 0.7,
        imageBudget: { enabled: false, maxBytesPerImage: 4 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 },
      },
    },
  );
  assert.equal(result.prunedToolResults, 0, "imageBudget disabled -> no prune");
});

// --- P5: settings read/merge/validate ---

test("imageBudget default enabled with stable default bytes", () => {
  const effective = resolveEffectiveCompactionSettings({}, {});
  assert.equal(effective.soft.imageBudget!.enabled, true);
  assert.equal(effective.soft.imageBudget!.maxBytesPerImage, DEFAULT_IMAGE_BUDGET.maxBytesPerImage);
  assert.equal(effective.soft.imageBudget!.maxTotalBytes, DEFAULT_IMAGE_BUDGET.maxTotalBytes);
});

test("imageBudget patch merge layers user then project", () => {
  const user = { soft: { imageBudget: { enabled: true, maxBytesPerImage: 2 * 1024 * 1024 } } };
  const project = { soft: { imageBudget: { maxTotalBytes: 20 * 1024 * 1024 } } };
  const effective = resolveEffectiveCompactionSettings(user as never, project as never);
  assert.equal(effective.soft.imageBudget!.enabled, true);
  assert.equal(effective.soft.imageBudget!.maxBytesPerImage, 2 * 1024 * 1024);
  assert.equal(effective.soft.imageBudget!.maxTotalBytes, 20 * 1024 * 1024);
});

test("imageBudget validation rejects invalid bytes and inverted per-image/total", () => {
  const patch1 = { soft: { imageBudget: { maxBytesPerImage: -1 } } };
  const v1 = validateCompactionPatch(patch1 as never);
  assert.ok(v1.errors.some((e) => e.includes("imageBudget.maxBytesPerImage")), `errors ${v1.errors}`);
  const patch2 = { soft: { imageBudget: { maxBytesPerImage: 10 * 1024 * 1024, maxTotalBytes: 5 * 1024 * 1024 } } };
  const v2 = validateCompactionPatch(patch2 as never);
  assert.ok(v2.errors.some((e) => e.includes("maxBytesPerImage must be less than maxTotalBytes")), `errors ${v2.errors}`);
});