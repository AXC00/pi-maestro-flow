// C 验证：真实故障会话数据的 payload-limit 行为（只读分支源码，不动运行环境）
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyContextPressurePolicy,
  estimatePayloadBytes,
} from "../src/compaction/auto-compaction.ts";

// 原故障会话 compaction 后的图片分布（17 张 / 11.58MB，含两张 3.2MB 大图）
const REAL_IMAGE_SIZES = [
  3_257_000, 3_252_000, 1_724_000,   // 3 张大截图
  320_000, 310_000, 305_000, 298_000, 290_000, 285_000, 280_000,  // 中等
  260_000, 255_000, 250_000, 245_000, 240_000, 235_000, 230_000,  // 中等偏小
];

// 原始故障会话完整数据：29 张图 / 12.69MB base64 / 请求体 16.07MB
const REAL_IMAGE_SIZES_FULL = [
  3_257_000, 3_252_000, 3_252_000, 1_724_000,   // 4 张大截图
  320_000, 310_000, 305_000, 298_000, 290_000, 285_000, 280_000,  // 中等
  260_000, 255_000, 250_000, 245_000, 240_000, 235_000, 230_000,  // 中等偏小
  200_000, 195_000, 190_000, 185_000, 180_000, 175_000, 170_000, 165_000, 160_000, 155_000,  // 小图
];
const mkToolResult = (callId: string, data: string) => ({
  role: "toolResult",
  toolCallId: callId,
  toolName: "read",
  content: [
    { type: "text", text: `Read image file [image/png]` },
    { type: "image", data, mimeType: "image/png" },
  ],
  isError: false,
});

function fullSession(): any[] {
  const tools = REAL_IMAGE_SIZES_FULL.map((sz, i) => mkToolResult(`t${i}`, "A".repeat(sz)));
  // 会话文本内容（assistant 分析 + toolCall 等）约占 3.4MB，将请求体推到 16.07MB
  const textBlock = { role: "assistant", content: [{ type: "text", text: "X".repeat(3_400_000) }], timestamp: Date.now() };
  const user = { role: "user", content: [{ type: "text", text: "继续分析" }], timestamp: Date.now() };
  return [...tools, textBlock, user];
}

const settings = (payloadLimitBytes: number | undefined): any => ({
  enabled: true,
  reserveTokens: 10_000,
  keepRecentTokens: 10_000,
  model: "provider/model",
  payloadLimitBytes,
  soft: { enabled: true, nudgeRatio: 0.7, pruneRatio: 0.8, pruneTargetRatio: 0.7, cache: { enabled: true } },
});

test("C1 默认无上限：不回收，请求体现在多 MB 就发多少", () => {
  const messages = fullSession();
  const bytes = estimatePayloadBytes(messages);
  console.log(`  [C1] 未设 limit，请求体估算 = ${(bytes / 1048576).toFixed(2)} MB`);
  const result = applyContextPressurePolicy(messages, 1_000_000, settings(undefined));
  assert.equal(result.prunedToolResults, 0, "默认无上限不回收");
  assert.ok(bytes >= 16 * 1048576, `确实超 16MiB（原撞墙场景）：${(bytes / 1048576).toFixed(2)}MB`);
});

test("C2 设 10MiB 上限：最旧优先回收直到请求体低于上限", () => {
  const messages = fullSession();
  const before = estimatePayloadBytes(messages);
  const result = applyContextPressurePolicy(messages, 1_000_000, settings(10 * 1024 * 1024));
  const after = estimatePayloadBytes(result.messages);
  console.log(`  [C2] limit=10MiB: 请求体 ${(before / 1048576).toFixed(2)}MB → ${(after / 1048576).toFixed(2)}MB`);
  console.log(`  [C2] 回收了 ${result.prunedToolResults} 条，占位: ${result.messages.filter(m => JSON.stringify(m).includes("evicted by payload limit")).length} 条`);
  assert.ok(result.prunedToolResults > 0, "超限回收");
  assert.ok(after <= 10 * 1024 * 1024, `回收后低于上限：${(after / 1048576).toFixed(2)}MB`);
});

test("C3 超限字节全在保护 user 消息：触发 action=compact", () => {
  // 任意回收路径都不存在：没有任何历史 toolResult 图片，只有 user 消息带一张 3.3MB 图
  const messages = [
    { role: "user", content: [
      { type: "text", text: "看看这张截图" },
      { type: "image", data: "A".repeat(3_300_000), mimeType: "image/png" },
    ], timestamp: Date.now() },
  ];
  const result = applyContextPressurePolicy(messages as any, 1_000_000, settings(1024 * 1024)); // 1MiB 上限，user 3.3MB 图远超
  console.log(`  [C3] action=${result.action}, reasons=${result.reasons.join(",")}`);
  assert.equal(result.action, "compact", "保护区内超限 → 触发压缩");
});

test("C4 设 16MiB 上限（原故障极限）：请求体提前控制，不会撞 16.07MB 墙", () => {
  const messages = fullSession();
  const before = estimatePayloadBytes(messages);
  const result = applyContextPressurePolicy(messages, 1_000_000, settings(16 * 1024 * 1024));
  const after = estimatePayloadBytes(result.messages);
  console.log(`  [C4] limit=16MiB: 请求体 ${(before / 1048576).toFixed(2)}MB → ${(after / 1048576).toFixed(2)}MB (上限内)`);
  assert.ok(before > 16 * 1024 * 1024, `确实超 16MiB：${(before / 1048576).toFixed(2)}MB`);
  assert.ok(after < 16 * 1024 * 1024, `不会撞 16MiB 墙：${(after / 1048576).toFixed(2)}MB`);
});