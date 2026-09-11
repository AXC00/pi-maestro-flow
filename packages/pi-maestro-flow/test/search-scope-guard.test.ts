import assert from "node:assert/strict";
import type { Dir } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
  registerSearchScopeGuard,
  searchScopeBlockReason,
} from "../src/tools/search-scope-guard.ts";

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-search-guard-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("search scope guard rejects filesystem roots, home, and paths outside the workspace", async () => {
  await withWorkspace(async (root) => {
    const filesystemRoot = parse(root).root;
    assert.match(
      await searchScopeBlockReason("grep", { path: filesystemRoot }, root) ?? "",
      /filesystem root/,
    );
    assert.match(
      await searchScopeBlockReason("grep", {}, root, { homeDirectory: root }) ?? "",
      /home directory/,
    );
    assert.match(
      await searchScopeBlockReason("grep", { path: join(root, "..") }, root) ?? "",
      /outside the current workspace/,
    );
  });
});

test("search scope guard rejects symlink and junction escapes", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-search-link-"));
  const workspace = join(base, "workspace");
  const outside = join(base, "outside");
  try {
    await mkdir(workspace);
    await mkdir(outside);
    await symlink(outside, join(workspace, "external"), process.platform === "win32" ? "junction" : "dir");

    assert.match(
      await searchScopeBlockReason("ffgrep", { path: "external" }, workspace) ?? "",
      /outside the current workspace/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("search scope guard preserves scoped searches and small root searches", async () => {
  await withWorkspace(async (root) => {
    const source = join(root, "src");
    await mkdir(source);
    await mkdir(join(root, "..foo"));
    await writeFile(join(source, "index.ts"), "export {};\n");

    assert.equal(
      await searchScopeBlockReason("grep", { path: "src" }, root, { maxEntries: 1 }),
      undefined,
    );
    assert.equal(
      await searchScopeBlockReason("grep", { path: "..foo" }, root, { maxEntries: 1 }),
      undefined,
    );
    assert.equal(
      await searchScopeBlockReason("grep", {}, root, { maxEntries: 10 }),
      undefined,
    );
  });
});

test("search scope guard blocks large root searches when no applicable ignore file exists", async () => {
  await withWorkspace(async (root) => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.ts"), "a\n");
    await writeFile(join(root, "src", "b.ts"), "b\n");
    await writeFile(join(root, ".gitignore"), "# comments alone do not exclude anything\n");

    const grepReason = await searchScopeBlockReason("grep", {}, root, { maxEntries: 3 });
    assert.match(grepReason ?? "", /root search blocked/);
    assert.match(grepReason ?? "", /no applicable ignore file/);

    const fffReason = await searchScopeBlockReason("ffgrep", {}, root, { maxEntries: 3 });
    assert.match(fffReason ?? "", /add \.gitignore/);

    let clock = 0;
    const slowReason = await searchScopeBlockReason("grep", {}, root, {
      maxEntries: 100,
      maxDurationMs: 100,
      now: () => clock++ === 0 ? 0 : 100,
    });
    assert.match(slowReason ?? "", /inspection budget was exceeded/);
  });
});

test("search scope guard bounds stalled directory I/O and closes late handles", async () => {
  await withWorkspace(async (root) => {
    let resolveOpen!: (handle: Dir) => void;
    let closeCount = 0;
    const stalledOpen = new Promise<Dir>((resolve) => { resolveOpen = resolve; });
    const startedAt = Date.now();
    const reason = await searchScopeBlockReason("grep", {}, root, {
      maxDurationMs: 10,
      openDirectory: () => stalledOpen,
    });
    assert.match(reason ?? "", /inspection budget was exceeded/);
    assert.ok(Date.now() - startedAt < 500, "preflight must return without waiting for stalled I/O");

    resolveOpen({
      close: async () => { closeCount += 1; },
    } as unknown as Dir);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closeCount, 1, "a directory handle that opens after timeout must be closed");
  });
});

test("search scope guard recognizes tool-specific ignore files", async () => {
  await withWorkspace(async (root) => {
    await writeFile(join(root, ".ignore"), "generated/\n");
    assert.equal(
      await searchScopeBlockReason("grep", {}, root, { maxEntries: 1 }),
      undefined,
    );
    assert.match(
      await searchScopeBlockReason("ffgrep", {}, root, { maxEntries: 1 }) ?? "",
      /add \.gitignore/,
    );

    await writeFile(join(root, ".gitignore"), "generated/\n");
    assert.equal(
      await searchScopeBlockReason("ffgrep", {}, root, { maxEntries: 1 }),
      undefined,
    );
  });
});

test("registered guard blocks risky root calls before tool execution", async () => {
  await withWorkspace(async (root) => {
    await writeFile(join(root, "a"), "a\n");
    await writeFile(join(root, "b"), "b\n");
    let handler: ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<unknown>) | undefined;
    registerSearchScopeGuard({
      on(event, candidate) {
        if (event === "tool_call") handler = candidate as typeof handler;
      },
    } as unknown as ExtensionAPI, { maxEntries: 2 });

    assert.ok(handler);
    const blocked = await handler(
      { type: "tool_call", toolName: "grep", toolCallId: "root", input: { pattern: "x" } },
      { cwd: root } as ExtensionContext,
    ) as { block?: boolean; reason?: string } | undefined;
    assert.equal(blocked?.block, true);
    assert.match(blocked?.reason ?? "", /Specify a narrower path/);

    const allowed = await handler(
      { type: "tool_call", toolName: "grep", toolCallId: "scoped", input: { pattern: "x", path: "a" } },
      { cwd: root } as ExtensionContext,
    );
    assert.equal(allowed, undefined);
  });
});
