//! `completion` — `/`/`@` autocomplete list (native pi TUI style).
//!
//! Rendered in-flow in `#completion-area` directly below the input —
//! a full-width list (not a floating dropdown):
//! ```text
//! #completion-area
//!   └─ .completion-item[.selected]
//!        ├─ .completion-marker  "○" / "●" (selected)
//!        ├─ .completion-label   "/model [provider/id]" / "@src/app.rs"
//!        └─ .completion-desc    "select or switch model"
//!   └─ .completion-more "↓ more"
//! ```
//!
//! Rows carry `data-hit-idx` so clicks accept the completion.
//! Keys (app::handle_key): tab/shift+tab cycle, ↑↓ move, enter accepts,
//! esc closes.

use blitz_dom::{DocumentMutator, NodeId};

use crate::components::dom::{div, qual, span_text};
use crate::components::glyphs::GlyphMode;
use crate::components::select;
use crate::state::{AppState, DialogState};

/// Max visible completion rows.
const MAX_VISIBLE: usize = 8;

/// Build `#completion-area` under `parent`.
pub fn build(m: &mut DocumentMutator<'_>, parent: NodeId) -> NodeId {
    let area = div(m, parent, "");
    m.set_attribute(area, qual("id"), "completion-area");
    area
}

/// Hash of everything `sync` renders — the app skips the rebuild
/// (and its `drop_children` restyle damage) while this is unchanged.
pub fn signature(state: &AppState) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut s = std::collections::hash_map::DefaultHasher::new();
    state.tray.open.hash(&mut s);
    match &state.dialog {
        Some(DialogState::Select { sel, .. })
        | Some(DialogState::Local { sel, .. }) => {
            sel.title.hash(&mut s);
            sel.cursor.hash(&mut s);
            sel.scroll.hash(&mut s);
            sel.filter.hash(&mut s);
            sel.footer.hash(&mut s);
            sel.extra_class.hash(&mut s);
            for o in &sel.options {
                o.label.hash(&mut s);
                o.description.hash(&mut s);
                o.badge.hash(&mut s);
            }
        }
        Some(_) => 1u8.hash(&mut s),
        None => {
            if let Some(comp) = &state.completion {
                comp.cursor.hash(&mut s);
                std::mem::discriminant(&comp.kind).hash(&mut s);
                for item in &comp.items {
                    item.display.hash(&mut s);
                    item.desc.hash(&mut s);
                }
            }
        }
    }
    s.finish()
}

/// Sync the completion list (rebuilt each frame while open).
pub fn sync(
    m: &mut DocumentMutator<'_>,
    area: NodeId,
    state: &AppState,
    mode: GlyphMode,
) {
    crate::components::dom::drop_children(m, area);
    if state.tray.open {
        return;
    }
    // Select/Local pickers live below the input (native pi style).
    if let Some(dialog) = &state.dialog {
        if let DialogState::Select { sel, .. } | DialogState::Local { sel, .. } =
            dialog
        {
            select::render(m, area, sel, mode);
        }
        return;
    }
    let Some(comp) = &state.completion else {
        return;
    };

    let total = comp.items.len();
    // Keep the cursor inside the visible window.
    let mut start = comp.cursor.saturating_sub(MAX_VISIBLE - 1);
    if comp.cursor < start {
        start = comp.cursor;
    }
    let end = (start + MAX_VISIBLE).min(total);

    for (i, item) in comp.items.iter().enumerate().take(end).skip(start) {
        let selected = i == comp.cursor;
        let row = div(
            m,
            area,
            if selected {
                "completion-item selected"
            } else {
                "completion-item"
            },
        );
        m.set_attribute(row, qual("data-hit-idx"), &i.to_string());
        let marker = if selected { "●" } else { "○" };
        span_text(m, row, "completion-label", &format!("{marker} {}", item.display));
        if !item.desc.is_empty() {
            span_text(m, row, "completion-desc", &format!("  {}", item.desc));
        }
    }
    if end < total {
        let more = div(m, area, "completion-more");
        span_text(m, more, "", &format!("{} more", mode.arrow_down()));
    }
}
