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
  type OverlayKeys,
  type OverlayTheme,
} from "pi-maestro-settings-core/ui";

export interface MarkdownReviewTurnItem {
  /** 1-based turn 序号。 */
  index: number;
  role: "user" | "assistant";
  /** 列表预览行（首行非空文本）。 */
  preview: string;
  /** 完整 markdown 文本（右侧预览渲染用）。 */
  text: string;
}

export type MarkdownReviewOverlayAction =
  | { kind: "close" }
  | { kind: "export"; turnIndexes: number[] };

export interface MarkdownReviewOverlayParams {
  turns: readonly MarkdownReviewTurnItem[];
}

const PREVIEW_VISIBLE = 14;
const WIDE_THRESHOLD = 76;

/** 与 plan-confirm 的 markdownTheme 同构，避免依赖未导出的内部函数。 */
export function reviewMarkdownTheme(theme: OverlayTheme): MarkdownTheme {
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

/**
 * 清除终端控制序列与危险控制字符（保留 \n \t），防止会话内容篡改终端渲染。
 */
export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC 序列
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI 序列
    .replace(/\x1b[()][0-9A-Za-z]/g, "") // 其他单字符转义
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "") // C0 控制（保留 \t\n）
    .replace(/\r/g, "");
}

/**
 * 多选 turn 列表 + 预览。宽屏（≥76）列表与预览并排；窄屏 Enter 切换全宽预览。
 * 所有 turn 默认全选；Space 勾选/取消，a 全选，n 清空，e 导出，Esc 关闭/返回。
 */
export class MarkdownReviewOverlay implements OverlayController<MarkdownReviewOverlayAction> {
  private selected = 0;
  private selectedIndexes = new Set<number>();
  private previewScroll = 0;
  private previewMode = false;
  private status = "";
  /** handleKey 使用最近一次 render 的宽/窄状态，避免与终端列宽来源不一致。 */
  private lastWide = true;
  private readonly turns: MarkdownReviewTurnItem[];
  private host: { requestRender(): void; close(result?: MarkdownReviewOverlayAction): void } | undefined;

  constructor(private readonly params: MarkdownReviewOverlayParams) {
    this.turns = params.turns.map((turn) => ({
      ...turn,
      preview: sanitizeTerminalText(turn.preview),
      text: sanitizeTerminalText(turn.text),
    }));
    for (const turn of this.turns) this.selectedIndexes.add(turn.index);
  }

  attach(host: { requestRender(): void; close(result?: MarkdownReviewOverlayAction): void }): void {
    this.host = host;
  }

  render(w: number, h: number, theme?: OverlayTheme): Frame {
    const inner = Math.max(1, w);
    const wide = inner >= WIDE_THRESHOLD;
    this.lastWide = wide;

    const entries = this.turns;
    const scrollInfo = !wide && !this.previewMode && entries.length > 0;
    // Body rows: header + rule + content + rule + status? + footer.
    const contentBudget = Math.max(1, h - 4 - (this.status ? 1 : 0));
    const visibleCount = contentBudget;

    const listWidth = wide ? Math.min(36, Math.floor(inner * 0.4)) : inner;
    const previewWidth = wide ? Math.max(1, inner - listWidth - 1) : inner;

    const start = visibleStart(this.selected, entries.length, Math.max(1, visibleCount));
    const listRows: Frame = entries.slice(start, start + visibleCount).map((turn, offset) => {
      const isSelectedRow = start + offset === this.selected;
      const cursor = isSelectedRow ? "›" : " ";
      const checked = this.selectedIndexes.has(turn.index) ? "✓" : " ";
      const role = turn.role === "user" ? "U" : "A";
      const label = `${cursor} [${checked}] #${turn.index} ${role} ${turn.preview}`;
      return [span(fit(label, listWidth), isSelectedRow ? "selected" : "text", isSelectedRow)];
    });

    const rows: Frame = [
      [span(`${entries.length} turns · ${this.selectedIndexes.size} 已选`, "text", true)],
      line("─".repeat(inner), "dim"),
    ];

    if (entries.length === 0) {
      rows.push(line("没有可 Review 的 turn", "warning"));
    } else if (wide) {
      const previewRows = this.renderPreviewPane(entries[this.selected]!, previewWidth, contentBudget, theme);
      const count = Math.max(listRows.length, previewRows.length);
      for (let index = 0; index < count; index++) {
        const left = listRows[index] ?? [span("")];
        const right = previewRows[index];
        rows.push(right
          ? [...left, span(" ".repeat(Math.max(1, listWidth - rowTextWidth(left) + 1))), ...right]
          : left);
      }
    } else if (this.previewMode) {
      rows.push(...this.renderPreviewPane(entries[this.selected]!, previewWidth, contentBudget, theme));
    } else {
      rows.push(...listRows);
      if (scrollInfo && entries.length > visibleCount) {
        rows.push(line(`↑↓ 滚动 · 显示 ${start + 1}-${Math.min(entries.length, start + visibleCount)}/${entries.length}`, "dim"));
      }
    }

    rows.push(line("─".repeat(inner), "dim"));
    if (this.status) {
      rows.push(line(this.status, "warning"));
    }
    const keys = wide
      ? "Space 勾选 · a 全选 · n 清空 · e 导出 · ↑↓ 选择 · Esc 关闭"
      : this.previewMode
        ? "Esc 返回 · ↑↓/PgUp/PgDn 滚动"
        : inner >= 46
          ? "Space 勾选 · a 全选 · n 清空 · Enter 预览 · e 导出 · Esc"
          : "Space 勾选 · a 全选 · n 清空 · e 导出 · Esc";
    rows.push(line(fit(keys, inner), "dim"));
    return rows;
  }

  private renderPreviewPane(turn: MarkdownReviewTurnItem, width: number, contentBudget: number, theme?: OverlayTheme): Frame {
    const inner = Math.max(1, width);
    if (!theme) return [];
    const markdown = new Markdown(turn.text, 0, 0, reviewMarkdownTheme(theme));
    const rendered = markdown.render(inner);
    if (contentBudget < 3) {
      // 预算不足：省略头部/页脚，只显示正文行。
      return rendered.slice(0, contentBudget).map(ansiToSpans);
    }
    const visible = Math.max(1, Math.min(PREVIEW_VISIBLE, contentBudget - 2));
    const maxScroll = Math.max(0, rendered.length - visible);
    this.previewScroll = Math.min(Math.max(0, this.previewScroll), maxScroll);
    const end = Math.min(rendered.length, this.previewScroll + visible);
    const body = rendered.slice(this.previewScroll, end).map(ansiToSpans);
    while (body.length < visible) body.push([span("")]);
    const header = [span(`预览 · Turn ${turn.index} ${turn.role === "user" ? "User" : "Assistant"}`, "text", true)];
    const footer = rendered.length > visible
      ? line(`行 ${this.previewScroll + 1}-${end}/${rendered.length} · PgUp/PgDn 滚动`, "dim")
      : line(`${rendered.length} 行`, "dim");
    return [header, ...body, footer];
  }

  handleKey(data: string, keys: OverlayKeys): boolean {
    const entries = this.turns;
    if (entries.length === 0) {
      if (keys.cancel(data)) this.host?.close({ kind: "close" });
      return true;
    }
    this.status = "";

    if (this.previewMode && !this.lastWide) {
      if (keys.cancel(data)) {
        this.previewMode = false;
        this.previewScroll = 0;
      } else if (keys.up(data)) {
        this.previewScroll = Math.max(0, this.previewScroll - 1);
      } else if (keys.down(data)) {
        this.previewScroll += 1;
      } else if (keys.pageUp(data)) {
        this.previewScroll = Math.max(0, this.previewScroll - PREVIEW_VISIBLE);
      } else if (keys.pageDown(data)) {
        this.previewScroll += PREVIEW_VISIBLE;
      }
      return true;
    }

    if (keys.up(data)) {
      this.selected = wrapIndex(this.selected - 1, entries.length);
      this.previewScroll = 0;
    } else if (keys.down(data)) {
      this.selected = wrapIndex(this.selected + 1, entries.length);
      this.previewScroll = 0;
    } else if (keys.pageUp(data)) {
      this.previewScroll = Math.max(0, this.previewScroll - PREVIEW_VISIBLE);
    } else if (keys.pageDown(data)) {
      this.previewScroll += PREVIEW_VISIBLE;
    } else if (keys.confirm(data) && !this.lastWide) {
      this.previewMode = true;
      this.previewScroll = 0;
    } else if (data === " " || data === " ") {
      this.toggleSelected(entries[this.selected]!.index);
    } else if (data === "a" || data === "A") {
      for (const turn of entries) this.selectedIndexes.add(turn.index);
    } else if (data === "n" || data === "N") {
      this.selectedIndexes.clear();
    } else if (data === "e" || data === "E") {
      this.finishExport();
      return true;
    } else if (keys.cancel(data)) {
      this.host?.close({ kind: "close" });
      return true;
    } else {
      return false;
    }
    return true;
  }

  private toggleSelected(index: number): void {
    if (this.selectedIndexes.has(index)) this.selectedIndexes.delete(index);
    else this.selectedIndexes.add(index);
  }

  private finishExport(): void {
    if (this.selectedIndexes.size === 0) {
      this.status = "未选择任何 turn · 按 a 全选或 Space 勾选后再导出";
      return;
    }
    const turnIndexes = [...this.selectedIndexes].sort((a, b) => a - b);
    this.host?.close({ kind: "export", turnIndexes });
  }
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
