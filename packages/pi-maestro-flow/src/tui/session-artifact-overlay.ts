import {
  Key,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  ansiToSpans,
  line,
  span,
  type Frame,
  type OverlayController,
  type OverlayTheme,
} from "pi-maestro-settings-core/ui";
import { sanitizeTerminalText } from "./markdown-review-overlay.ts";

export type SessionArtifactSource = "plan" | "review" | "knowledge";

export interface SessionArtifactItem {
  id: string;
  source: SessionArtifactSource;
  title: string;
  detail: string;
  markdown: string;
  createdAt?: string;
  /** Absolute source file path, when the artifact is backed by one. */
  path?: string;
}

export type SessionArtifactOverlayAction =
  | { kind: "close"; selectedId?: string }
  | { kind: "copy"; selectedId: string }
  | { kind: "copyPath"; selectedId: string }
  | { kind: "export"; selectedId: string };

export interface SessionArtifactOverlayParams {
  sessionLabel: string;
  artifacts: readonly SessionArtifactItem[];
  initialSelectedId?: string;
}

const WIDE_THRESHOLD = 76;

export class SessionArtifactOverlay implements OverlayController<SessionArtifactOverlayAction> {
  private selected: number;
  private previewScroll = 0;
  private previewMaxScroll = 0;
  private previewMode = false;
  private lastWide = true;
  private readonly artifacts: SessionArtifactItem[];
  private host: { requestRender(): void; close(result?: SessionArtifactOverlayAction): void } | undefined;

  constructor(private readonly params: SessionArtifactOverlayParams) {
    this.artifacts = params.artifacts.map((artifact) => ({
      ...artifact,
      title: sanitizeTerminalText(artifact.title),
      detail: sanitizeTerminalText(artifact.detail),
      markdown: sanitizeTerminalText(artifact.markdown),
      ...(artifact.path ? { path: sanitizeTerminalText(artifact.path) } : {}),
    }));
    const selected = params.initialSelectedId
      ? this.artifacts.findIndex((artifact) => artifact.id === params.initialSelectedId)
      : -1;
    this.selected = selected >= 0 ? selected : 0;
  }

  attach(host: { requestRender(): void; close(result?: SessionArtifactOverlayAction): void }): void {
    this.host = host;
  }

  render(w: number, h: number, theme?: OverlayTheme): Frame {
    const inner = Math.max(1, w);
    const wide = inner >= WIDE_THRESHOLD;
    this.lastWide = wide;
    const contentBudget = Math.max(1, h - 2); // separator + footer
    const listWidth = wide ? Math.min(42, Math.floor(inner * 0.42)) : inner;
    const previewWidth = wide ? Math.max(1, inner - listWidth - 1) : inner;

    const rows: Frame = [];
    if (this.artifacts.length === 0) {
      rows.push(line("No session Artifacts are available.", "warning"));
      rows.push(line("Esc close", "dim"));
      return rows;
    }

    if (!wide && this.previewMode) {
      rows.push(...this.renderPreview(this.artifacts[this.selected]!, previewWidth, contentBudget, theme));
    } else {
      const visibleCount = Math.max(1, contentBudget);
      const start = visibleStart(this.selected, this.artifacts.length, visibleCount);
      const listRows: Frame = this.artifacts.slice(start, start + visibleCount).map((artifact, offset) => {
        const active = start + offset === this.selected;
        const marker = active ? "›" : " ";
        const source = artifact.source === "knowledge" ? "K" : artifact.source === "review" ? "R" : "P";
        const label = `${marker} [${source}] ${artifact.title}`;
        return [span(fit(label, listWidth), active ? "selected" : "text", active)];
      });
      if (wide) {
        const previewRows = this.renderPreview(this.artifacts[this.selected]!, previewWidth, contentBudget, theme);
        const count = Math.max(listRows.length, previewRows.length);
        for (let index = 0; index < count; index++) {
          const left = listRows[index] ?? [span("")];
          const right = previewRows[index];
          rows.push(right
            ? [...left, span(" ".repeat(Math.max(1, listWidth - rowTextWidth(left) + 1))), ...right]
            : left);
        }
      } else {
        rows.push(...listRows);
        if (this.artifacts.length > visibleCount) {
          rows.push(line(`显示 ${start + 1}-${Math.min(this.artifacts.length, start + visibleCount)}/${this.artifacts.length}`, "dim"));
        }
      }
    }

    rows.push(line("─".repeat(inner), "dim"));
    const footer = !wide && this.previewMode
      ? "←→ 切换 · ↑↓/PgUp/PgDn 滚动 · c 复制 · p 复制路径 · e 导出 · Esc 返回"
      : wide
        ? "←→ 切换 · ↑↓/PgUp/PgDn 滚动 · c 复制 · p 复制路径 · e 导出 · Esc 关闭"
        : "↑↓/←→ 选择 · Enter 预览 · c 复制 · p 复制路径 · e 导出 · Esc 关闭";
    rows.push(line(fit(footer, inner), "dim"));
    return rows;
  }

  private renderPreview(artifact: SessionArtifactItem, width: number, budget: number, theme?: OverlayTheme): Frame {
    const safeWidth = Math.max(1, width);
    if (budget < 3 || !theme) return [];
    const markdown = new Markdown(artifact.markdown, 0, 0, artifactMarkdownTheme(theme));
    const rendered = markdown.render(safeWidth);
    const visible = Math.max(1, budget - 3);
    const maxScroll = Math.max(0, rendered.length - visible);
    this.previewMaxScroll = maxScroll;
    this.previewScroll = Math.min(Math.max(0, this.previewScroll), maxScroll);
    const end = Math.min(rendered.length, this.previewScroll + visible);
    const body = rendered.slice(this.previewScroll, end).map(ansiToSpans);
    while (body.length < visible) body.push([span("")]);
    const range = rendered.length > visible
      ? `${this.previewScroll + 1}-${end}/${rendered.length}`
      : `${rendered.length} 行`;
    return [
      [span(artifact.title, "text", true)],
      line(artifact.detail, "dim"),
      ...body,
      line(range, "dim"),
    ];
  }

  handleKey(data: string, keys: { up(d: string): boolean; down(d: string): boolean; pageUp(d: string): boolean; pageDown(d: string): boolean; confirm(d: string): boolean; cancel(d: string): boolean }): boolean {
    if (this.artifacts.length === 0) {
      if (keys.cancel(data)) this.host?.close({ kind: "close" });
      return true;
    }
    const selected = () => this.artifacts[this.selected]!;
    const switchArtifact = (delta: number) => {
      this.selected = wrapIndex(this.selected + delta, this.artifacts.length);
      this.previewScroll = 0;
    };
    const scrollPreview = (delta: number) => {
      this.previewScroll = delta < 0
        ? Math.max(0, this.previewScroll + delta)
        : Math.min(this.previewMaxScroll, this.previewScroll + delta);
    };
    if (!this.lastWide && this.previewMode) {
      if (keys.cancel(data)) {
        this.previewMode = false;
        this.previewScroll = 0;
      } else if (matchesKey(data, Key.left)) {
        switchArtifact(-1);
      } else if (matchesKey(data, Key.right)) {
        switchArtifact(1);
      } else if (keys.up(data)) {
        scrollPreview(-1);
      } else if (keys.down(data)) {
        scrollPreview(1);
      } else if (keys.pageUp(data)) {
        scrollPreview(-8);
      } else if (keys.pageDown(data)) {
        scrollPreview(8);
      } else if (matchesKey(data, Key.home)) {
        this.previewScroll = 0;
      } else if (matchesKey(data, Key.end)) {
        this.previewScroll = this.previewMaxScroll;
      } else if (data === "c" || data === "C") {
        this.host?.close({ kind: "copy", selectedId: selected().id });
        return true;
      } else if (data === "p" || data === "P") {
        this.host?.close({ kind: "copyPath", selectedId: selected().id });
        return true;
      } else if (data === "e" || data === "E") {
        this.host?.close({ kind: "export", selectedId: selected().id });
        return true;
      }
      return true;
    }

    if (matchesKey(data, Key.left)) {
      switchArtifact(-1);
    } else if (matchesKey(data, Key.right)) {
      switchArtifact(1);
    } else if (keys.up(data)) {
      if (this.lastWide) scrollPreview(-1);
      else switchArtifact(-1);
    } else if (keys.down(data)) {
      if (this.lastWide) scrollPreview(1);
      else switchArtifact(1);
    } else if (keys.pageUp(data)) {
      scrollPreview(-8);
    } else if (keys.pageDown(data)) {
      scrollPreview(8);
    } else if (matchesKey(data, Key.home)) {
      this.previewScroll = 0;
    } else if (matchesKey(data, Key.end)) {
      this.previewScroll = this.previewMaxScroll;
    } else if (keys.confirm(data) && !this.lastWide) {
      this.previewMode = true;
      this.previewScroll = 0;
    } else if (data === "c" || data === "C") {
      this.host?.close({ kind: "copy", selectedId: selected().id });
      return true;
    } else if (data === "p" || data === "P") {
      this.host?.close({ kind: "copyPath", selectedId: selected().id });
      return true;
    } else if (data === "e" || data === "E") {
      this.host?.close({ kind: "export", selectedId: selected().id });
      return true;
    } else if (keys.cancel(data)) {
      this.host?.close({ kind: "close", selectedId: selected().id });
      return true;
    } else {
      return false;
    }
    return true;
  }
}

function artifactMarkdownTheme(theme: OverlayTheme): MarkdownTheme {
  const bold = (text: string) => theme.bold ? theme.bold(text) : text;
  return {
    heading: (text) => theme.fg("accent", bold(text)),
    link: (text) => theme.fg("accent", text),
    linkUrl: (text) => theme.fg("dim", text),
    code: (text) => theme.fg("warning", text),
    codeBlock: (text) => text,
    codeBlockBorder: (text) => theme.fg("dim", text),
    quote: (text) => text,
    quoteBorder: (text) => theme.fg("dim", text),
    hr: (text) => theme.fg("dim", text),
    listBullet: (text) => theme.fg("accent", text),
    bold,
    italic: (text) => text,
    strikethrough: (text) => theme.fg("dim", text),
    underline: (text) => text,
  };
}

function visibleStart(selected: number, length: number, maxVisible: number): number {
  if (length <= maxVisible) return 0;
  return Math.min(Math.max(0, selected - maxVisible + 1), length - maxVisible);
}

function wrapIndex(index: number, length: number): number {
  return length === 0 ? 0 : (index % length + length) % length;
}

function fit(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), "…");
}

function rowTextWidth(row: readonly { text: string }[]): number {
  let w = 0;
  for (const s of row) w += visibleWidth(s.text);
  return w;
}
