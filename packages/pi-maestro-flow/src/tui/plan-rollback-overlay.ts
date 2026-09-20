/**
 * TUI overlay for selecting an archived Plan draft to roll back to.
 *
 * Two-column list (revision + archivedAt + checksum) with a Markdown preview
 * of the selected entry. Enter restores, Esc cancels. Bounded to the drafts
 * supplied by plan-store.listDrafts().
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  type KeyId,
  type MarkdownTheme,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  ansiToSpans,
  line,
  openOverlay,
  resolveGlyphs,
  span,
  type Frame,
  type OverlayController,
  type OverlayTheme,
} from "pi-maestro-settings-core/ui";
import type { PlanDraftArchiveEntry } from "../tools/plan-store.ts";

export interface RenderRollbackOverlayOptions {
  drafts: PlanDraftArchiveEntry[];
  readDraft: (path: string) => Promise<string>;
  signal?: AbortSignal;
}

export interface RenderRollbackOverlayResult {
  action: "restore" | "cancel";
  selected?: PlanDraftArchiveEntry;
}

type RollbackContext = Pick<ExtensionContext, "hasUI" | "ui">;

const WIDE_THRESHOLD = 76;

export async function renderRollbackOverlay(
  ctx: RollbackContext,
  options: RenderRollbackOverlayOptions,
): Promise<RenderRollbackOverlayResult> {
  if (!ctx.hasUI || options.signal?.aborted) return { action: "cancel" };
  const drafts = options.drafts;

  let selected = 0;
  let preview = "";
  let loadingPreview = false;
  let settled = false;
  let pendingResult: RenderRollbackOverlayResult | undefined;
  let host: { requestRender(): void; close(result?: RenderRollbackOverlayResult): void } | undefined;

  const finish = (value: RenderRollbackOverlayResult): void => {
    if (settled) return;
    settled = true;
    options.signal?.removeEventListener("abort", onAbort);
    if (host) host.close(value);
    else pendingResult = value;
  };
  const onAbort = (): void => finish({ action: "cancel" });
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  async function refreshPreview(): Promise<void> {
    const entry = drafts[selected];
    if (!entry) { preview = ""; return; }
    loadingPreview = true;
    try {
      preview = await options.readDraft(entry.path);
    } catch {
      preview = "Unable to read this draft archive.";
    } finally {
      loadingPreview = false;
      if (!settled) host?.requestRender();
    }
  }
  if (!settled) void refreshPreview();

  const controller: OverlayController<RenderRollbackOverlayResult> = {
    attach(h) {
      host = h;
      if (pendingResult) h.close(pendingResult);
    },
    dispose() {
      finish({ action: "cancel" });
    },
    render(w, h, theme) {
      const inner = Math.max(1, w);
      const wide = inner >= WIDE_THRESHOLD;
      const listWidth = wide ? Math.min(38, Math.floor(inner * 0.4)) : inner;
      const previewWidth = wide ? Math.max(1, inner - listWidth - 1) : inner;
      const rows: Frame = [];

      if (drafts.length === 0) {
        rows.push(line("No archived drafts available for rollback.", "warning"));
        return rows;
      }

      const markdownTheme = theme ? buildMarkdownTheme(theme) : undefined;
      const renderPreview = (width: number, budget: number): Frame => {
        if (!markdownTheme || budget <= 0) return [];
        const md = new Markdown(preview, 0, 0, markdownTheme);
        return md.render(width).slice(0, budget).map(ansiToSpans);
      };

      // Body rows: list (+scroll info) + separator + preview + loading marker.
      const listBudget = Math.max(1, h - 2);
      const start = visibleStart(selected, drafts.length, listBudget);
      const visibleCount = Math.min(drafts.length - start, listBudget);
      const listRows: Frame = drafts.slice(start, start + visibleCount).map((entry, offset) => {
        const isSelected = start + offset === selected;
        const label = `${isSelected ? "›" : " "} r${entry.revision} · ${entry.archivedAt.slice(0, 15)} · ${entry.checksum.slice(0, 8)}`;
        return [span(label, isSelected ? "selected" : "text", isSelected)];
      });

      if (wide) {
        const rendered = renderPreview(previewWidth, h);
        const count = Math.max(listRows.length, rendered.length);
        for (let index = 0; index < count; index++) {
          const left = listRows[index] ?? [span("")];
          const right = rendered[index];
          if (right) {
            rows.push([...left, span(" ".repeat(Math.max(1, listWidth - rowTextWidth(left) + 1))), ...right]);
          } else {
            rows.push(left);
          }
        }
      } else {
        rows.push(...listRows);
        if (drafts.length > visibleCount) {
          rows.push(line(
            `↑↓ scroll · ${start + 1}-${Math.min(drafts.length, start + visibleCount)}/${drafts.length}`,
            "dim",
          ));
        }
        rows.push(line("─".repeat(inner), "dim"));
        const previewBudget = Math.max(0, h - rows.length - (loadingPreview ? 1 : 0));
        rows.push(...renderPreview(previewWidth, previewBudget));
      }

      if (loadingPreview) rows.push(line("loading preview…", "dim"));
      return rows;
    },
    handleKey(data, keys) {
      if (keys.up(data)) {
        selected = Math.max(0, selected - 1);
        void refreshPreview();
        return true;
      }
      if (keys.down(data)) {
        selected = Math.min(drafts.length - 1, selected + 1);
        void refreshPreview();
        return true;
      }
      if (keys.confirm(data)) {
        finish({ action: "restore", selected: drafts[selected] });
        return true;
      }
      if (keys.cancel(data)) {
        finish({ action: "cancel" });
        return true;
      }
      return false;
    },
  };

  const result = await openOverlay<RenderRollbackOverlayResult>(
    ctx,
    {
      kind: "card",
      title: `Rollback to draft version · ${drafts.length} archived`,
      width: "92%",
      minWidth: 40,
      maxHeight: "90%",
      anchor: "center",
      hints: [
        { key: "↑↓", verb: "select" },
        { key: "Enter", verb: "restore" },
        { key: "Esc", verb: "cancel" },
      ],
    },
    controller,
    {
      utils: {
        measure: visibleWidth,
        clip: (text, width, ellipsis) => truncateToWidth(text, width, ellipsis),
      },
      glyphs: resolveGlyphs("nerd"),
      matchesKey: (data, keyId) => matchesKey(data, keyId as KeyId),
    },
  );

  return result ?? { action: "cancel" };
}

function visibleStart(selected: number, length: number, maxVisible: number): number {
  if (length <= maxVisible) return 0;
  return Math.min(Math.max(0, selected - maxVisible + 1), length - maxVisible);
}

function rowTextWidth(row: readonly { text: string }[]): number {
  let w = 0;
  for (const s of row) w += visibleWidth(s.text);
  return w;
}

function buildMarkdownTheme(theme: OverlayTheme): MarkdownTheme {
  return {
    heading: (text) => theme.fg("accent", theme.bold ? theme.bold(text) : text),
    link: (text) => theme.fg("accent", text),
    linkUrl: (text) => theme.fg("dim", text),
    code: (text) => theme.fg("warning", text),
    codeBlock: (text) => text,
    codeBlockBorder: (text) => theme.fg("dim", text),
    quote: (text) => text,
    quoteBorder: (text) => theme.fg("dim", text),
    hr: (text) => theme.fg("dim", text),
    listBullet: (text) => theme.fg("accent", text),
    bold: (text) => theme.bold ? theme.bold(text) : theme.fg("text", text),
    italic: (text) => text,
    strikethrough: (text) => theme.fg("dim", text),
    underline: (text) => text,
  };
}
