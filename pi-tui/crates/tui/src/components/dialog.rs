//! `dialog` — `extension_ui_request` dialogs (RECON §9 + P4 spec).
//!
//! DOM shape:
//! ```text
//! #dialog-area (position:relative — select dropdown anchors here)
//!   ├─ .toast            (notify messages, auto-dismiss)
//!   ├─ .select-wrap …    (select::render — absolute dropdown)
//!   ├─ .dialog-confirm   (title + message + [y]es/[n]o bar)
//!   ├─ .dialog-input     (title + single-line InputBox)
//!   └─ .dialog-editor    (title + multi-line editor, ctrl+enter submits)
//! #widget-area           (setWidget lines, above the hint bar)
//! ```
//!
//! Interactive requests (`select`/`confirm`/`input`/`editor`) become
//! `state.dialog`; `notify` becomes a toast; `setWidget` fills the widget
//! area; `setStatus`/`setTitle`/`set_editor_text` are handled in state.

use blitz_dom::{DocumentMutator, NodeId};

use crate::components::dom::{div, qual, span_text};
use crate::components::glyphs::GlyphMode;
use crate::components::input_box::CURSOR_MARKER;
use crate::components::{select, tray};
use crate::state::{AppState, DialogState};

/// Toast lifetime in app ticks (33ms each) — ~5s.
pub const TOAST_TICKS: u64 = 150;

/// Build `#dialog-area` + `#widget-area` under `parent`.
/// Returns `(dialog_area, widget_area)`.
pub fn build(m: &mut DocumentMutator<'_>, parent: NodeId) -> (NodeId, NodeId) {
    let area = div(m, parent, "");
    m.set_attribute(area, qual("id"), "dialog-area");
    let widgets = div(m, parent, "");
    m.set_attribute(widgets, qual("id"), "widget-area");
    (area, widgets)
}

/// Sync the dialog + widget areas from state. Rebuilds children each
/// call (dialogs are small; rebuild-on-dirty keeps it simple).
pub fn sync(
    m: &mut DocumentMutator<'_>,
    area: NodeId,
    widget_area: NodeId,
    state: &AppState,
    mode: GlyphMode,
) {
    crate::components::dom::drop_children(m, area);
    for toast in &state.toasts {
        let t = div(m, area, "toast");
        span_text(m, t, "", &toast.text);
    }
    // Select/Local pickers render BELOW the input (native pi style)
    // via `completion::sync` into #completion-area — skip them here.
    if let Some(dialog) = &state.dialog {
        match dialog {
            DialogState::Select { .. } | DialogState::Local { .. } => {}
            DialogState::Plugin { .. } => crate::components::overlay::render(m, area, dialog),
            _ => render_dialog(m, area, dialog, mode),
        }
    }
    // Queued (follow-up) messages: dimmed lines above the input.
    for q in &state.queued {
        let row = div(m, area, "queued-line");
        span_text(m, row, "", &format!("queued: {}", q.lines().next().unwrap_or("")));
    }
    if state.tray.open {
        tray::render(m, area, &state.tray, state.tick, &state.messages);
    }

    crate::components::dom::drop_children(m, widget_area);
    for (_key, lines) in &state.widgets {
        for line in lines {
            let w = div(m, widget_area, "widget-line");
            span_text(m, w, "", line);
        }
    }
}

fn render_dialog(
    m: &mut DocumentMutator<'_>,
    area: NodeId,
    dialog: &DialogState,
    mode: GlyphMode,
) {
    match dialog {
        DialogState::Select { sel, .. } | DialogState::Local { sel, .. } => {
            select::render(m, area, sel, mode);
        }
        DialogState::Confirm { title, message, .. } => {
            let d = div(m, area, "dialog-confirm");
            if !title.is_empty() {
                let t = div(m, d, "dialog-title");
                span_text(m, t, "", title);
            }
            if !message.is_empty() {
                let msg = div(m, d, "dialog-message");
                span_text(m, msg, "", message);
            }
            let bar = div(m, d, "dialog-bar");
            let yes = div(m, bar, "dialog-btn");
            m.set_attribute(yes, qual("data-hit-confirm"), "yes");
            span_text(m, yes, "hint-key", "y");
            span_text(m, yes, "hint-verb", " yes");
            let no = div(m, bar, "dialog-btn");
            m.set_attribute(no, qual("data-hit-confirm"), "no");
            span_text(m, no, "hint-key", "n");
            span_text(m, no, "hint-verb", " no");
            let cancel = div(m, bar, "dialog-btn");
            m.set_attribute(cancel, qual("data-hit-confirm"), "cancel");
            span_text(m, cancel, "hint-key", "esc");
            span_text(m, cancel, "hint-verb", " cancel");
        }
        DialogState::Input {
            title,
            input,
            placeholder,
            ..
        } => {
            let d = div(m, area, "dialog-input");
            if !title.is_empty() {
                let t = div(m, d, "dialog-title");
                span_text(m, t, "", title);
            }
            let row = div(m, d, "dialog-input-box");
            span_text(m, row, "dialog-prompt", &format!("{} ", mode.chevron()));
            let shown = if input.text.is_empty() {
                match placeholder {
                    Some(p) => format!("{p}{CURSOR_MARKER}"),
                    None => CURSOR_MARKER.to_string(),
                }
            } else {
                let mut s = String::with_capacity(input.text.len() + 1);
                s.push_str(&input.text[..input.cursor]);
                s.push(CURSOR_MARKER);
                s.push_str(&input.text[input.cursor..]);
                s
            };
            let cls = if input.text.is_empty() && placeholder.is_some() {
                "dialog-input-text placeholder"
            } else {
                "dialog-input-text"
            };
            span_text(m, row, cls, &shown);
        }
        DialogState::Editor { title, input, .. } => {
            let d = div(m, area, "dialog-editor");
            if !title.is_empty() {
                let t = div(m, d, "dialog-title");
                span_text(m, t, "", title);
            }
            let box_el = div(m, d, "dialog-editor-box");
            let mut s = String::with_capacity(input.text.len() + 1);
            s.push_str(&input.text[..input.cursor]);
            s.push(CURSOR_MARKER);
            s.push_str(&input.text[input.cursor..]);
            span_text(m, box_el, "dialog-editor-text", &s);
            let hint = div(m, d, "dialog-hint");
            span_text(m, hint, "hint-key", "ctrl+enter");
            span_text(m, hint, "hint-verb", " submit");
            span_text(m, hint, "hint-sep", " · ");
            span_text(m, hint, "hint-key", "esc");
            span_text(m, hint, "hint-verb", " cancel");
        }
        // Plugin overlays render via overlay::render from sync() — this arm
        // is unreachable but keeps the match exhaustive.
        DialogState::Plugin { .. } => {}
    }
}


