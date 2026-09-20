import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectDecisionDocuments } from "../src/tools/plan-sources.ts";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "plan-sources-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("detectDecisionDocuments returns explicit decision-doc references from the Plan", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", "session-run-minimal-state-architecture-20260812.md"), "# arch");
    await writeFile(join(dir, "docs", "usage.md"), "# usage");
    const markdown = [
      "# Plan",
      "依据 `docs/session-run-minimal-state-architecture-20260812.md` 的方案 B。",
      "另见 docs/usage.md（不匹配决策模式，应被过滤）。",
      "以及 docs/missing-decision.md（不存在，应被过滤）。",
    ].join("\n");

    const result = await detectDecisionDocuments(markdown, dir);
    assert.deepEqual(result, ["docs/session-run-minimal-state-architecture-20260812.md"]);
  });
});

test("detectDecisionDocuments falls back to docs/ scan when no explicit reference matches", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", "a-decision.md"), "a");
    await writeFile(join(dir, "docs", "b-architecture.md"), "b");
    await writeFile(join(dir, "docs", "c-guide.md"), "c");
    const result = await detectDecisionDocuments("# Plan without references", dir);
    assert.equal(result.length, 2);
    assert.ok(result.every((p) => p.startsWith("docs/")));
    assert.ok(result.some((p) => p.includes("decision")));
    assert.ok(result.some((p) => p.includes("architecture")));
    assert.ok(!result.some((p) => p.includes("guide")));
  });
});

test("detectDecisionDocuments returns empty when docs/ is absent", async () => {
  await withTempDir(async (dir) => {
    const result = await detectDecisionDocuments("# Plan", dir);
    assert.deepEqual(result, []);
  });
});

test("detectDecisionDocuments de-duplicates repeated references", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", "x-decision.md"), "x");
    const markdown = "docs/x-decision.md and again docs/x-decision.md";
    const result = await detectDecisionDocuments(markdown, dir);
    assert.deepEqual(result, ["docs/x-decision.md"]);
  });
});
