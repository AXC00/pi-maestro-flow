import { createHash, randomUUID } from "node:crypto";
import { link, lstat, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  getSessionHostDirectoryRefresh,
  getSessionHostRegistry,
} from "pi-maestro-teammate/v1/sessions";
import {
  inventorySessionTranscripts,
  type SessionTranscriptInventoryEntry,
} from "../session/session-export.ts";
import {
  guardedDeleteUsageHistory,
  inventoryUsageHistory,
  type UsageHistoryInventoryEntry,
  type UsageLiveSessionProtection,
} from "../providers/usage-history.ts";
import type {
  ManagedDataContext,
  ManagedDataItem,
  ManagedDataSource,
  ManagedDeleteRequest,
} from "./data-manager.ts";

function currentTranscript(entry: SessionTranscriptInventoryEntry, context?: ManagedDataContext): boolean {
  const isCurrentFile = context?.currentSessionFile
    ? resolve(entry.path) === resolve(context.currentSessionFile)
    : false;
  return isCurrentFile || Boolean(context?.currentSessionId && entry.sessionId === context.currentSessionId);
}

function forceTranscriptProtection(entry: SessionTranscriptInventoryEntry, cwd: string, context?: ManagedDataContext): string | undefined {
  if (!context?.currentSessionId && !context?.currentSessionFile) return "current session identity is unavailable";
  if (currentTranscript(entry, context)) return "current session transcript is active";
  if (!entry.headerValid) return "invalid transcript header; host-owned";
  if (resolve(entry.cwd!) !== resolve(cwd)) return "transcript cwd ownership does not match this workspace";
  return undefined;
}

function transcriptProtection(entry: SessionTranscriptInventoryEntry, cwd: string, context?: ManagedDataContext): string {
  return forceTranscriptProtection(entry, cwd, context) ?? "host-owned transcript; inactivity is unproven";
}

function transcriptItem(entry: SessionTranscriptInventoryEntry, cwd: string, context?: ManagedDataContext): ManagedDataItem {
  const forceProtection = forceTranscriptProtection(entry, cwd, context);
  return {
    id: entry.id,
    title: entry.sessionId ?? entry.fileName,
    detail: [
      `File: ${entry.path}`,
      `Session: ${entry.sessionId ?? "unknown"}`,
      `Cwd: ${entry.cwd ?? "unknown"}`,
      `Header: ${entry.headerValid ? "valid" : "invalid"}`,
    ].join("\n"),
    sizeBytes: entry.sizeBytes,
    updatedAt: entry.modified.toISOString(),
    revision: entry.revision,
    cleanupEligible: false,
    forceCleanupEligible: forceProtection === undefined,
    protectionReason: transcriptProtection(entry, cwd, context),
  };
}

function transcriptRevision(path: string, info: Awaited<ReturnType<typeof lstat>>): string {
  return createHash("sha256").update(`${resolve(path)}\0${info.dev}\0${info.ino}\0${info.size}\0${info.mtimeMs}`).digest("hex");
}

async function restoreTranscript(originalPath: string, quarantinePath: string): Promise<boolean> {
  try {
    await link(quarantinePath, originalPath);
    await unlink(quarantinePath);
    return true;
  } catch {
    return false;
  }
}

async function forceDeleteTranscript(request: ManagedDeleteRequest) {
  const sessionDir = request.context.currentSessionDir;
  if (!sessionDir) return { status: "protected" as const, message: "active transcript directory is unavailable" };
  const entry = (await inventorySessionTranscripts(sessionDir)).find((candidate) => candidate.id === request.itemId);
  if (!entry) return { status: "missing" as const };
  if (entry.revision !== request.revision) return { status: "stale" as const, message: "transcript changed after preview" };
  const protectionReason = forceTranscriptProtection(entry, request.cwd, request.context);
  if (protectionReason) return { status: "protected" as const, message: protectionReason };

  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(entry.path);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
    return code === "ENOENT" ? { status: "missing" as const } : { status: "failed" as const, message: error instanceof Error ? error.message : String(error) };
  }
  if (!before.isFile() || before.isSymbolicLink()) return { status: "protected" as const, message: "transcript is not a regular non-symlink file" };
  if (transcriptRevision(entry.path, before) !== request.revision) return { status: "stale" as const, message: "transcript changed before deletion" };

  const quarantinePath = join(dirname(entry.path), `.${randomUUID()}.transcript-delete`);
  try {
    await rename(entry.path, quarantinePath);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
    return code === "ENOENT"
      ? { status: "missing" as const }
      : { status: "failed" as const, message: error instanceof Error ? error.message : String(error) };
  }
  try {
    const liveContext = request.revalidateContext?.() ?? request.context;
    const liveProtection = forceTranscriptProtection(entry, request.cwd, liveContext);
    if (liveProtection) {
      const restored = await restoreTranscript(entry.path, quarantinePath);
      return restored
        ? { status: "protected" as const, message: liveProtection }
        : { status: "partial" as const, message: `${liveProtection}; transcript was quarantined at ${quarantinePath}` };
    }
    const quarantined = await lstat(quarantinePath);
    if (!quarantined.isFile() || quarantined.isSymbolicLink()
      || quarantined.dev !== before.dev || quarantined.ino !== before.ino
      || transcriptRevision(entry.path, quarantined) !== request.revision) {
      const restored = await restoreTranscript(entry.path, quarantinePath);
      return restored
        ? { status: "stale" as const, message: "transcript identity or contents changed during deletion" }
        : { status: "partial" as const, message: `transcript changed and was quarantined at ${quarantinePath}` };
    }
    const finalProtection = forceTranscriptProtection(entry, request.cwd, request.revalidateContext?.() ?? liveContext);
    if (finalProtection) {
      const restored = await restoreTranscript(entry.path, quarantinePath);
      return restored
        ? { status: "protected" as const, message: finalProtection }
        : { status: "partial" as const, message: `${finalProtection}; transcript was quarantined at ${quarantinePath}` };
    }
    const finalState = await lstat(quarantinePath);
    if (!finalState.isFile() || finalState.isSymbolicLink()
      || finalState.dev !== before.dev || finalState.ino !== before.ino
      || transcriptRevision(entry.path, finalState) !== request.revision) {
      const restored = await restoreTranscript(entry.path, quarantinePath);
      return restored
        ? { status: "stale" as const, message: "transcript changed immediately before deletion" }
        : { status: "partial" as const, message: `transcript changed and was quarantined at ${quarantinePath}` };
    }
    await unlink(quarantinePath);
    return { status: "deleted" as const, reclaimedBytes: entry.sizeBytes };
  } catch (error) {
    const restored = await restoreTranscript(entry.path, quarantinePath);
    return {
      status: restored ? "failed" as const : "partial" as const,
      message: restored
        ? (error instanceof Error ? error.message : String(error))
        : `force deletion failed and the transcript remains quarantined at ${quarantinePath}`,
    };
  }
}

/** Host transcript inventory; force deletion is limited to valid non-current workspace entries. */
export function createSessionHistoryDataSource(): ManagedDataSource {
  return {
    id: "session-history",
    label: "Session transcripts",
    async load(cwd, context) {
      const sessionDir = context?.currentSessionDir;
      const entries = sessionDir ? await inventorySessionTranscripts(sessionDir) : [];
      const items = entries.map((entry) => transcriptItem(entry, cwd, context));
      return {
        sourceId: "session-history",
        label: "Session transcripts",
        scope: sessionDir ? "Current session directory (force cleanup available)" : "No active session directory",
        totalBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
        items,
      };
    },
    async delete() {
      return false;
    },
    forceDelete: forceDeleteTranscript,
  };
}

function usageItem(entry: UsageHistoryInventoryEntry): ManagedDataItem {
  const title = entry.sessionIds.length === 1 ? entry.sessionIds[0]! : entry.fileName;
  return {
    id: entry.id,
    title,
    detail: [
      `File: ${entry.path}`,
      `Sessions: ${entry.sessionIds.join(", ") || "unknown"}`,
      `Cwds: ${entry.cwds.join(", ") || "unknown"}`,
    ].join("\n"),
    sizeBytes: entry.sizeBytes,
    updatedAt: entry.modified.toISOString(),
    revision: entry.revision,
    cleanupEligible: entry.cleanupEligible,
    ...(entry.protectionReason ? { protectionReason: entry.protectionReason } : {}),
  };
}

async function authoritativeLiveSessionProtection(): Promise<UsageLiveSessionProtection> {
  const refresh = getSessionHostDirectoryRefresh();
  const registry = getSessionHostRegistry();
  if (!refresh || !registry) return { evidenceAvailable: false };
  try {
    await refresh();
    const refreshed = getSessionHostRegistry();
    if (!refreshed || refreshed !== registry) return { evidenceAvailable: false };
    const liveSessionIds = new Set(
      refreshed.listEndpoints()
        .filter((endpoint) => endpoint.kind === "root"
          && endpoint.status !== "settled"
          && (endpoint.scope === "local" || endpoint.scope === "workspace-peer")
          && Boolean(endpoint.sessionId))
        .map((endpoint) => endpoint.sessionId!),
    );
    return { evidenceAvailable: true, liveSessionIds };
  } catch {
    return { evidenceAvailable: false };
  }
}

async function guardedUsageDelete(request: ManagedDeleteRequest) {
  const liveProtection = await authoritativeLiveSessionProtection();
  return guardedDeleteUsageHistory({
    cwd: request.cwd,
    itemId: request.itemId,
    revision: request.revision,
    ...(request.context.currentSessionId ? { currentSessionId: request.context.currentSessionId } : {}),
    liveProtection,
  });
}

/** Workspace-scoped usage history with revision-checked production deletion. */
export function createUsageHistoryDataSource(): ManagedDataSource {
  const source: ManagedDataSource = {
    id: "usage-history",
    label: "Usage history",
    async load(cwd, context) {
      const liveProtection = await authoritativeLiveSessionProtection();
      const entries = await inventoryUsageHistory(cwd, context?.currentSessionId, liveProtection);
      const items = entries.map(usageItem);
      return {
        sourceId: "usage-history",
        label: "Usage history",
        scope: "Current workspace ownership (global store inventory)",
        totalBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0),
        items,
      };
    },
    async delete(cwd, itemId, context) {
      const effectiveContext: ManagedDataContext = context ?? { cwd, now: new Date() };
      const snapshot = await source.load(cwd, effectiveContext);
      const item = snapshot.items.find((candidate) => candidate.id === itemId);
      if (!item?.revision || item.protectionReason) return false;
      const result = await guardedUsageDelete({ cwd, itemId, revision: item.revision, item, context: effectiveContext });
      return result.status === "deleted";
    },
    guardedDelete: guardedUsageDelete,
  };
  return source;
}
