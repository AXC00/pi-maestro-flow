import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Dir } from "node:fs";
import { opendir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_MAX_DURATION_MS = 100;
const ROOT_IGNORE_FILES = [".gitignore", ".ignore", ".rgignore"] as const;

export interface SearchScopeGuardOptions {
  maxEntries?: number;
  maxDurationMs?: number;
  homeDirectory?: string;
  now?: () => number;
  openDirectory?: (path: string) => Promise<Dir>;
}

type WorkspaceInspection = "small" | "large" | "slow" | "unreadable";

function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function isWithin(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

export function resolveSearchScopePath(inputPath: unknown, cwd: string): string {
  const value = typeof inputPath === "string" && inputPath.trim() ? inputPath.trim() : ".";
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(cwd, value);
}

async function hasApplicableIgnoreFile(root: string, toolName: string): Promise<boolean> {
  const candidates = toolName === "grep" ? ROOT_IGNORE_FILES : ROOT_IGNORE_FILES.slice(0, 1);
  for (const name of candidates) {
    try {
      const content = await readFile(join(root, name), "utf8");
      const hasExclusion = content.split(/\r?\n/).some((line) => {
        const pattern = line.trim();
        return pattern.length > 0 && !pattern.startsWith("#") && !pattern.startsWith("!");
      });
      if (hasExclusion) return true;
    } catch {
      // Missing or unreadable ignore files do not make a root scan safe.
    }
  }
  return false;
}

type DeadlineResult<T> =
  | { status: "ok"; value: T }
  | { status: "timeout" }
  | { status: "error" };

async function settleBeforeDeadline<T>(
  operation: Promise<T>,
  remainingMs: number,
  onLateValue?: (value: T) => void,
): Promise<DeadlineResult<T>> {
  if (remainingMs <= 0) {
    void operation.then((value) => onLateValue?.(value), () => undefined);
    return { status: "timeout" };
  }
  return new Promise((resolveResult) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolveResult({ status: "timeout" });
    }, remainingMs);
    operation.then(
      (value) => {
        if (settled) {
          onLateValue?.(value);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolveResult({ status: "ok", value });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult({ status: "error" });
      },
    );
  });
}

function closeDirectory(handle: Dir): void {
  void handle.close().catch(() => undefined);
}

async function inspectWorkspace(
  root: string,
  options: SearchScopeGuardOptions,
): Promise<WorkspaceInspection> {
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const maxDurationMs = Math.max(1, options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS);
  const now = options.now ?? Date.now;
  const openDirectory = options.openDirectory ?? opendir;
  const deadline = now() + maxDurationMs;
  const pending = [root];
  let cursor = 0;
  let entries = 0;

  while (cursor < pending.length) {
    const directory = pending[cursor++]!;
    const opening = openDirectory(directory);
    const opened = await settleBeforeDeadline(opening, deadline - now(), closeDirectory);
    if (opened.status === "timeout") return "slow";
    if (opened.status === "error") return "unreadable";
    const handle = opened.value;
    try {
      while (true) {
        const reading = handle.read();
        const read = await settleBeforeDeadline(reading, deadline - now(), () => closeDirectory(handle));
        if (read.status === "timeout") return "slow";
        if (read.status === "error") return "unreadable";
        const entry = read.value;
        if (!entry) break;
        entries += 1;
        if (entries >= maxEntries) return "large";
        if (entry.isDirectory()) pending.push(join(directory, entry.name));
      }
    } finally {
      closeDirectory(handle);
    }
  }

  return "small";
}

export async function searchScopeBlockReason(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  cwd: string,
  options: SearchScopeGuardOptions = {},
): Promise<string | undefined> {
  if (toolName !== "grep" && toolName !== "ffgrep" && toolName !== "fffind") return undefined;

  const workspaceRoot = resolve(cwd);
  const searchPath = resolveSearchScopePath(input.path, workspaceRoot);
  let canonicalWorkspaceRoot: string;
  let canonicalSearchPath: string;
  try {
    [canonicalWorkspaceRoot, canonicalSearchPath] = await Promise.all([
      realpath(workspaceRoot),
      realpath(searchPath),
    ]);
  } catch {
    return `${toolName} cannot safely resolve its search path; choose an existing path under ${workspaceRoot}.`;
  }
  if (samePath(canonicalSearchPath, parse(canonicalSearchPath).root)) {
    return `${toolName} cannot scan a filesystem root; choose a project subdirectory.`;
  }
  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  const canonicalHomeDirectory = await realpath(homeDirectory).catch(() => homeDirectory);
  if (samePath(canonicalSearchPath, canonicalHomeDirectory)) {
    return `${toolName} cannot scan the home directory; choose a specific project directory.`;
  }
  if (!isWithin(canonicalWorkspaceRoot, canonicalSearchPath)) {
    return `${toolName} cannot scan outside the current workspace; choose a path under ${workspaceRoot}.`;
  }
  if (!samePath(canonicalSearchPath, canonicalWorkspaceRoot)) return undefined;
  if (await hasApplicableIgnoreFile(canonicalWorkspaceRoot, toolName)) return undefined;

  const inspection = await inspectWorkspace(canonicalWorkspaceRoot, options);
  if (inspection === "small") return undefined;
  const detail = inspection === "large"
    ? `at least ${Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES)} entries`
    : inspection === "slow"
      ? `the ${Math.max(1, options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS)}ms inspection budget was exceeded`
      : "the directory tree could not be inspected safely";
  return `${toolName} root search blocked: this workspace has no applicable ignore file and ${detail}. Specify a narrower path or add ${toolName === "grep" ? ".gitignore/.ignore/.rgignore" : ".gitignore"}.`;
}

export function registerSearchScopeGuard(
  pi: ExtensionAPI,
  options: SearchScopeGuardOptions = {},
): void {
  pi.on("tool_call", async (event, ctx) => {
    const reason = await searchScopeBlockReason(event.toolName, event.input, ctx.cwd, options);
    return reason ? { block: true, reason } : undefined;
  });
}
