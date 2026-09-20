//! `tray` — subagent/shell tray panel (RECON §12.2 `TrayContent`).
//!
//! DOM shape (rendered inside `#dialog-area`, above the input):
//! ```text
//! .tray-panel
//!   ├─ .tray-tabs
//!   │    ├─ .tray-tab[.active] "Subagents"
//!   │    ├─ .tray-tab "Cloud agents"
//!   │    └─ .tray-tab "Shells ({n})"
//!   ├─ .tray-empty + .tray-empty-sub        (empty state)
//!   └─ .tray-split (row)
//!        ├─ .tray-list (column)
//!        │    └─ .tray-item[.selected]
//!        │         ├─ .tray-status  "[~]"/"Completed"/"Failed"/"Cancelled"
//!        │         ├─ .tray-name    "{title}"   (agent palette color)
//!        │         └─ .tray-meta    " {n} tools · {n}s"
//!        └─ .tray-preview (column, selected entry)
//!             ├─ .tray-preview-title  "{title}"
//!             ├─ .tray-preview-meta   "{tool} · {model} · {status} · {n}s"
//!             ├─ .tray-preview-label  "Recent tools"
//!             ├─ .tray-preview-tool   "· {name}"  (≤5)
//!             ├─ .tray-preview-label  "Output"
//!             └─ .tray-preview-line   "{line}"    (≤4 tail lines)
//! ```
//!
//! Keys (handled in `app::handle_tray_key`): tab/←→ switch tabs,
//! ↑↓ navigate, enter view, x kill, f foreground, esc close.

use blitz_dom::{DocumentMutator, NodeId};

use crate::components::dom::{div, qual, span_text};
use crate::state::{Message, MsgKind, TrayEntry, TrayKind, TrayState, TrayStatus, TrayTab};

/// Devin agent palette (RECON §12.5) — subagent name colors.
pub const AGENT_PALETTE: [&str; 10] = [
    "#ff8787", "#ffaf87", "#ffd787", "#d7af5f", "#afd787", "#87d7af", "#87d7ff",
    "#afafff", "#d7afff", "#ffafd7",
];

/// Milliseconds per app tick (33ms frame tick).
const TICK_MS: u64 = 33;

/// Preview tail lines shown for the selected entry.
const PREVIEW_LINES: usize = 4;

fn status_label(e: &TrayEntry) -> &'static str {
    match e.status {
        // Devin `subagent/mode`: backgrounded running entries are
        // "parked" (output hidden until finish).
        TrayStatus::Running if !e.foregrounded => "[bg]",
        TrayStatus::Running => "[~]",
        TrayStatus::Done => "Completed",
        TrayStatus::Failed => "Failed",
        TrayStatus::Cancelled => "Cancelled",
    }
}

fn duration_secs(e: &TrayEntry, now: u64) -> u64 {
    let end = e.end_tick.unwrap_or(now);
    end.saturating_sub(e.start_tick) * TICK_MS / 1000
}

/// Render the tray panel under `parent` (rebuilt each sync).
/// `now` is the current `AppState.tick` for live durations; `messages`
/// feeds the preview's output tail.
pub fn render(
    m: &mut DocumentMutator<'_>,
    parent: NodeId,
    tray: &TrayState,
    now: u64,
    messages: &[Message],
) {
    let panel = div(m, parent, "tray-panel");

    // Tabs.
    let tabs = div(m, panel, "tray-tabs");
    let shells = tray
        .entries
        .iter()
        .filter(|e| e.kind == TrayKind::Shell)
        .count();
    for tab in [TrayTab::Subagents, TrayTab::Cloud, TrayTab::Shells] {
        let cls = if tab == tray.tab {
            "tray-tab active"
        } else {
            "tray-tab"
        };
        let t = div(m, tabs, cls);
        span_text(m, t, "", &tab.label(shells));
    }

    let visible = tray.visible();
    if visible.is_empty() {
        let (line, sub) = match tray.tab {
            TrayTab::Subagents => (
                "No subagents yet.",
                "Ask Devin to spawn a subagent for parallel or focused work.",
            ),
            TrayTab::Cloud => (
                "No cloud agents yet.",
                "Run /handoff to launch a Devin agent on its own dev machine.",
            ),
            TrayTab::Shells => ("No shells yet.", "Ctrl+B runs a command in the background."),
        };
        let e = div(m, panel, "tray-empty");
        span_text(m, e, "", line);
        let s = div(m, panel, "tray-empty-sub");
        span_text(m, s, "", sub);
        return;
    }

    // Split: entry list (left) + selected-entry preview (right).
    let split = div(m, panel, "tray-split");
    let list = div(m, split, "tray-list");
    for (row, &ei) in visible.iter().enumerate() {
        let e = &tray.entries[ei];
        let selected = row == tray.cursor;
        let item = div(
            m,
            list,
            if selected {
                "tray-item selected"
            } else {
                "tray-item"
            },
        );
        m.set_attribute(item, qual("data-hit-tray"), &row.to_string());
        let st = div(m, item, "tray-status");
        span_text(m, st, "", status_label(e));
        let name = div(m, item, "tray-name");
        m.set_style_property(name, "color", AGENT_PALETTE[ei % AGENT_PALETTE.len()]);
        span_text(m, name, "", &format!(" {}", e.title));
        let meta = div(m, item, "tray-meta");
        span_text(
            m,
            meta,
            "",
            &format!("  {} tools · {}s", e.tools, duration_secs(e, now)),
        );
    }

    // Preview pane for the selected entry (Devin subagent detail).
    if let Some(&ei) = visible.get(tray.cursor) {
        let e = &tray.entries[ei];
        let pv = div(m, split, "tray-preview");
        let t = div(m, pv, "tray-preview-title");
        span_text(m, t, "", &e.title);
        let meta = div(m, pv, "tray-preview-meta");
        span_text(
            m,
            meta,
            "",
            &format!(
                "{} · {} · {} · {}s",
                e.tool,
                if e.model.is_empty() { "-" } else { &e.model },
                status_label(e),
                duration_secs(e, now),
            ),
        );
        if !e.recent_tools.is_empty() {
            let l = div(m, pv, "tray-preview-label");
            span_text(m, l, "", "Recent tools");
            for (name, target) in &e.recent_tools {
                let r = div(m, pv, "tray-preview-tool");
                let text = if target.is_empty() {
                    format!("· {name}")
                } else {
                    format!("· {name} {target}")
                };
                span_text(m, r, "", &text);
            }
        }
        // Output tail from the entry's tool card.
        if let Some(msg) = messages.get(e.msg_idx) {
            if msg.kind == MsgKind::Tool {
                if let Some(out) = &msg.tool_output {
                    let tail: Vec<&str> = out
                        .lines()
                        .rev()
                        .take(PREVIEW_LINES)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect();
                    if !tail.is_empty() {
                        let l = div(m, pv, "tray-preview-label");
                        span_text(m, l, "", "Output");
                        for line in tail {
                            let r = div(m, pv, "tray-preview-line");
                            span_text(m, r, "", line);
                        }
                    }
                }
            }
        }
        let hint = div(m, pv, "tray-preview-hint");
        span_text(
            m,
            hint,
            "",
            if e.foregrounded {
                "enter view · x kill · f background"
            } else {
                "enter view · x kill · f foreground"
            },
        );
    }
}
