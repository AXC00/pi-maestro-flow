import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  openOverlay,
  resolveGlyphs,
  span,
  type Frame,
  type OverlayController,
  type OverlayKeys,
  type OverlayTheme,
} from "pi-maestro-settings-core/ui";
import type {
  PlanExecutionBackend,
  PlanExecutionChoice,
  PlanExecutionContextMode,
  PlanWorkflowTarget,
} from "./plan-store.ts";

export type PlanConfirmationAction =
  | "execute"
  | "modify"
  | "continue"
  | "refine"
  | "rollback"
  | "exit-plan"
  | "close";

export interface PlanConfirmationDecision {
  action: PlanConfirmationAction;
  execution?: PlanExecutionChoice;
}

export interface PlanWorkflowConfirmationTarget {
  sessionId: string;
  intent: string;
  available: boolean;
  reason?: string;
}

export interface PlanWorkflowConfirmationOptions {
  current?: PlanWorkflowConfirmationTarget;
  allowNew: boolean;
}

export interface PlanConfirmationModelTransition {
  current: string;
  act?: string;
}

export interface PlanConfirmationOptions {
  markdown: string;
  pathLabel?: string;
  canCompactContext?: boolean;
  contextPercent?: number;
  defaultExecution?: PlanExecutionChoice;
  workflow?: PlanWorkflowConfirmationOptions;
  modelTransition?: PlanConfirmationModelTransition;
  /** Candidate decision documents detected for this Plan (workspace-relative paths). */
  decisionDocuments?: string[];
  signal?: AbortSignal;
  /** Archived draft revisions available for rollback. */
  drafts?: { revision: number; archivedAt: string; checksum: string }[];
}

interface ActionItem {
  action: Exclude<PlanConfirmationAction, "close">;
  label: string;
  description: string;
}

type SelectionRow =
  | { kind: "backend" }
  | { kind: "target" }
  | { kind: "context" }
  | { kind: "source" }
  | { kind: "action"; item: ActionItem };

const CTRL_ENTER_SEQUENCES = new Set([
  "\x1b[13;5u",
  "\x1b[13;5~",
  "\x1b[27;5;13~",
]);

export async function openPlanConfirmation(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  options: PlanConfirmationOptions,
): Promise<PlanConfirmationDecision> {
  if (!ctx.hasUI || options.signal?.aborted) return { action: "close" };

  const currentTargetAvailable = options.workflow?.current?.available === true;
  const workflowAvailable = currentTargetAvailable || options.workflow?.allowNew === true;
  let backend: PlanExecutionBackend = options.defaultExecution?.backend === "workflow" && workflowAvailable
    ? "workflow"
    : "standalone";
  let workflowTarget: PlanWorkflowTarget = preferredWorkflowTarget(options, currentTargetAvailable);
  let contextMode: PlanExecutionContextMode = options.defaultExecution?.context === "compact"
    && options.canCompactContext !== false
    ? "compact"
    : "current";
  const decisionDocs = options.decisionDocuments ?? [];
  let selectedSource: string | undefined = options.defaultExecution?.sourceDocument
    && decisionDocs.includes(options.defaultExecution.sourceDocument)
    ? options.defaultExecution.sourceDocument
    : decisionDocs[0];
  const actions: ActionItem[] = [
    { action: "execute", label: "Execute", description: "Approve with the selected execution settings" },
    { action: "modify", label: "View / modify Plan", description: "Open the full-screen Markdown editor" },
    { action: "refine", label: "Review & Refine", description: "Open the role-based review & refine panel (reviewer / decomposer / optimizer / brainstormer)" },
    ...(options.drafts?.length
      ? [{ action: "rollback" as const, label: "Rollback to draft version", description: "Restore a previous Plan draft from the archived history" }]
      : []),
    { action: "continue", label: "Continue discussion", description: "Enter feedback or a question" },
    { action: "exit-plan", label: "Exit Plan mode", description: "Keep the draft without approval" },
  ];
  let markdown: Markdown | undefined;
  let selected = 0;
  let previewOffset = 0;
  let previewMaxOffset = 0;
  let status = "";
  let lastWidth = 80;
  let host: { requestRender(): void; close(result?: PlanConfirmationDecision): void } | undefined;

  const rows = (): SelectionRow[] => [
    { kind: "backend" },
    ...(backend === "workflow" ? [{ kind: "target" } as const] : []),
    { kind: "context" },
    ...(decisionDocs.length > 0 ? [{ kind: "source" } as const] : []),
    ...actions.map((item): SelectionRow => ({ kind: "action", item })),
  ];

  function actionFooter(width: number, segments: string[]): string {
    let value = "";
    for (const segment of segments) {
      const next = value ? `${value} · ${segment}` : segment;
      if (visibleWidth(next) <= width) value = next;
    }
    return value || segments[0] || "";
  }

  function executionChoice(): PlanExecutionChoice {
    const base = backend === "workflow"
      ? { backend, context: contextMode, workflowTarget }
      : { backend, context: contextMode };
    return selectedSource ? { ...base, sourceDocument: selectedSource } : base;
  }

  let settled = false;
  function complete(action: PlanConfirmationAction): void {
    if (settled) return;
    settled = true;
    options.signal?.removeEventListener("abort", onAbort);
    host?.close(action === "execute"
      ? { action, execution: executionChoice() }
      : { action });
  }
  const onAbort = () => complete("close");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) queueMicrotask(onAbort);

  function changeControl(row: SelectionRow, direction: -1 | 1): void {
    status = "";
    if (row.kind === "backend") {
      if (!workflowAvailable && backend === "standalone") {
        status = workflowUnavailableMessage(options);
        return;
      }
      backend = backend === "standalone" ? "workflow" : "standalone";
      return;
    }
    if (row.kind === "target") {
      const available = availableWorkflowTargets(options);
      if (available.length < 2) {
        status = available[0] === "current"
          ? "Only the current Workflow Session is available."
          : "Only creating a new Workflow Session is available.";
        return;
      }
      const index = available.indexOf(workflowTarget);
      workflowTarget = available[(index + direction + available.length) % available.length] ?? available[0]!;
      return;
    }
    if (row.kind === "context") {
      if (options.canCompactContext === false) {
        status = "New Context is unavailable for this confirmation path.";
        return;
      }
      contextMode = contextMode === "current" ? "compact" : "current";
      return;
    }
    if (row.kind === "source") {
      const choices: (string | undefined)[] = [undefined, ...decisionDocs];
      const index = choices.indexOf(selectedSource);
      selectedSource = choices[(index + direction + choices.length) % choices.length];
      return;
    }
  }

  function choose(row = rows()[selected]): void {
    if (!row) return;
    if (row.kind === "action") {
      complete(row.item.action);
      return;
    }
    changeControl(row, 1);
    host?.requestRender();
  }

  const controller: OverlayController<PlanConfirmationDecision> = {
    attach(h) {
      host = h;
    },
    dispose() {
      options.signal?.removeEventListener("abort", onAbort);
      complete("close");
    },
    invalidate() {
      markdown?.invalidate();
    },
    render(w, h, theme) {
      const safeWidth = Math.max(1, w + 2); // w is inner; keep narrow-mode parity with the old outer width
      lastWidth = safeWidth;
      const selectionRows = rows();
      selected = Math.min(selected, selectionRows.length - 1);
      const selectedRow = selectionRows[selected] ?? selectionRows[0]!;
      if (safeWidth < 24) {
        return [
          line(truncateToWidth(`Plan confirm · ${selected + 1}/${selectionRows.length} ${rowLabel(selectedRow, actions, options, backend, workflowTarget, contextMode, selectedSource)}`, safeWidth, "…")),
          line(truncateToWidth(actionFooter(safeWidth, ["Esc exit", "Enter choose", "↑↓ navigate"]), safeWidth, "…"), "dim"),
        ];
      }

      const inner = Math.max(1, w);
      if (!markdown) markdown = new Markdown(options.markdown, 0, 0, markdownTheme(theme ?? plainTheme));
      // Body rows: header + rule + preview + range + rule + selections + footer
      // + optional status. Preview gets the rest, capped at 14.
      const hasStatusLine = Boolean(status);
      const fixed = 1 + 1 + 1 + 1 + selectionRows.length + 1 + (hasStatusLine ? 1 : 0);
      const previewHeight = Math.max(2, Math.min(14, h - fixed));
      const renderedPlan = markdown.render(Math.max(1, inner - 2));
      const maxOffset = Math.max(0, renderedPlan.length - previewHeight);
      previewMaxOffset = maxOffset;
      previewOffset = Math.min(previewOffset, maxOffset);
      const preview = renderedPlan.slice(previewOffset, previewOffset + previewHeight);
      const range = renderedPlan.length > previewHeight
        ? `${previewOffset + 1}-${Math.min(renderedPlan.length, previewOffset + previewHeight)}/${renderedPlan.length}`
        : `${renderedPlan.length}`;
      const footer = actionFooter(inner, [
        "Esc close",
        "Enter choose",
        "←→ change mode",
        "↑↓ navigate",
        "Ctrl+Enter execute",
        "PgUp/PgDn scroll",
      ]);
      const modelTransition = formatModelTransition(options.modelTransition);
      const rendered: Frame = [
        line(`${options.pathLabel ?? "current.md"}${modelTransition ? ` · ${modelTransition}` : ""}`, "dim"),
        line("─".repeat(inner), "dim"),
        ...preview.map((l) => ansiToSpans(` ${l}`)),
      ];
      while (rendered.length < previewHeight + 2) rendered.push([span("")]);
      rendered.push(line(`Plan ${range}`, "dim"));
      rendered.push(line("─".repeat(inner), "dim"));
      for (let index = 0; index < selectionRows.length; index++) {
        const row = selectionRows[index]!;
        const marker = index === selected ? "›" : " ";
        const label = rowLabel(row, actions, options, backend, workflowTarget, contextMode, selectedSource);
        const description = inner >= 76 ? `  — ${rowDescription(row, options)}` : "";
        const text = truncateToWidth(`${marker} ${label}${description}`, inner, "…");
        rendered.push([span(text, index === selected ? "selected" : "text", index === selected)]);
      }
      rendered.push(line(footer, "dim"));
      if (status) rendered.push(line(status, "warning"));
      return rendered;
    },
    handleKey(data, keys) {
      if (lastWidth < 20) {
        if (keys.cancel(data)) complete("close");
        return true;
      }
      const selectionRows = rows();
      if (keys.up(data)) {
        if (previewOffset >= previewMaxOffset) {
          if (selected > 0) selected -= 1;
          else previewOffset = Math.max(0, previewOffset - 1);
        } else previewOffset = Math.max(0, previewOffset - 1);
      } else if (keys.down(data)) {
        if (previewOffset >= previewMaxOffset) selected = Math.min(selectionRows.length - 1, selected + 1);
        else previewOffset = Math.min(previewMaxOffset, previewOffset + 1);
      } else if (matchesKey(data, Key.left)) {
        const row = selectionRows[selected];
        if (row && row.kind !== "action") changeControl(row, -1);
      } else if (matchesKey(data, Key.right)) {
        const row = selectionRows[selected];
        if (row && row.kind !== "action") changeControl(row, 1);
      } else if (keys.pageUp(data)) {
        previewOffset = Math.max(0, previewOffset - 5);
      } else if (keys.pageDown(data)) {
        previewOffset = Math.min(previewMaxOffset, previewOffset + 5);
      } else if (/^[1-9]$/.test(data)) {
        const index = Number(data) - 1;
        if (index < actions.length) {
          complete(actions[index]!.action);
          return true;
        }
      } else if (keys.confirm(data)) {
        choose();
        return true;
      } else if (matchesKey(data, Key.ctrl("enter")) || CTRL_ENTER_SEQUENCES.has(data)) {
        complete("execute");
        return true;
      } else if (keys.cancel(data)) {
        complete("close");
        return true;
      } else {
        return false;
      }
      return true;
    },
  };

  const result = await openOverlay<PlanConfirmationDecision>(
    ctx,
    {
      kind: "card",
      title: "Plan confirmation",
      width: "92%",
      minWidth: 24,
      maxHeight: 28,
      anchor: "center",
      hints: [
        { key: "Enter", verb: "choose" },
        { key: "←→", verb: "change" },
        { key: "Ctrl+Enter", verb: "execute" },
        { key: "Esc", verb: "close" },
      ],
    },
    controller,
    {
      utils: {
        measure: visibleWidth,
        clip: (text, width, ellipsis) => truncateToWidth(text, width, ellipsis),
      },
      glyphs: resolveGlyphs("nerd"),
      matchesKey: (data, keyId) => matchesKey(data, keyId as never),
    },
  );

  return isPlanConfirmationDecision(result) ? result : { action: "close" };
}

const plainTheme: OverlayTheme = { fg: (_n, t) => t };

function isPlanConfirmationDecision(value: unknown): value is PlanConfirmationDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const decision = value as Record<string, unknown>;
  const action = decision.action;
  if (![
    "execute",
    "modify",
    "continue",
    "refine",
    "rollback",
    "exit-plan",
    "close",
  ].includes(typeof action === "string" ? action : "")) return false;
  if (action !== "execute") return true;

  const execution = decision.execution;
  if (!execution || typeof execution !== "object" || Array.isArray(execution)) return false;
  const choice = execution as Record<string, unknown>;
  if (choice.context !== "current" && choice.context !== "compact") return false;
  if (choice.sourceDocument !== undefined && typeof choice.sourceDocument !== "string") return false;
  if (choice.backend === "standalone") return true;
  return choice.backend === "workflow"
    && (choice.workflowTarget === "current" || choice.workflowTarget === "new");
}

function availableWorkflowTargets(options: PlanConfirmationOptions): PlanWorkflowTarget[] {
  return [
    ...(options.workflow?.current?.available ? ["current" as const] : []),
    ...(options.workflow?.allowNew ? ["new" as const] : []),
  ];
}

function preferredWorkflowTarget(
  options: PlanConfirmationOptions,
  currentAvailable: boolean,
): PlanWorkflowTarget {
  const preferred = options.defaultExecution?.workflowTarget;
  if (preferred === "current" && currentAvailable) return preferred;
  if (preferred === "new" && options.workflow?.allowNew) return preferred;
  return currentAvailable ? "current" : "new";
}

function workflowUnavailableMessage(options: PlanConfirmationOptions): string {
  return options.workflow?.current?.reason
    ?? "Workflow execution is unavailable because no writable Workflow Session target exists.";
}

function rowLabel(
  row: SelectionRow,
  actions: ActionItem[],
  options: PlanConfirmationOptions,
  backend: PlanExecutionBackend,
  target: PlanWorkflowTarget,
  context: PlanExecutionContextMode,
  source: string | undefined,
): string {
  if (row.kind === "backend") return `Execution  [${backend === "standalone" ? "Standalone" : "Workflow"}]`;
  if (row.kind === "target") {
    if (target === "new") return "Workflow target  [Create new Session]";
    const id = options.workflow?.current?.sessionId ?? "current";
    return `Workflow target  [Current: ${id}]`;
  }
  if (row.kind === "context") return `Context  [${context === "compact" ? "New Context" : "Current"}]`;
  if (row.kind === "source") return `Decision doc  [${source ?? "none"}]`;
  const number = actions.findIndex((item) => item.action === row.item.action);
  const prefix = number >= 0 ? `${number + 1}. ` : "";
  return `${prefix}${row.item.label}`;
}

function rowDescription(row: SelectionRow, options: PlanConfirmationOptions): string {
  if (row.kind === "backend") return "Choose local Todo/Goal execution or canonical Workflow Session/Run execution";
  if (row.kind === "target") {
    return options.workflow?.current?.intent
      ? `Current intent: ${options.workflow.current.intent}`
      : "Select the canonical Workflow Session target";
  }
  if (row.kind === "context") return "Save the Plan conversation as a checkpoint, then reset the same-session context deterministically";
  if (row.kind === "source") return "Bind the decision document whose locked decisions this Plan implements";
  const actModel = options.modelTransition?.act;
  if (actModel && row.item.action === "execute") {
    return `Approve and restore the main model to ${actModel} before implementation`;
  }
  if (actModel && row.item.action === "exit-plan") {
    return `Keep the draft and restore the main model to ${actModel}`;
  }
  return row.item.description;
}

function formatModelTransition(transition: PlanConfirmationModelTransition | undefined): string {
  if (!transition) return "";
  return transition.act
    ? `Plan model ${transition.current} → Act model ${transition.act} on Execute/Exit`
    : `Main model ${transition.current}`;
}

function markdownTheme(theme: OverlayTheme): MarkdownTheme {
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
