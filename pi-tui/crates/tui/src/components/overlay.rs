//! `overlay` — plugin overlay surface (`extension_ui_request{method:"custom"}`).
//!
//! DOM shape:
//! ```text
//! #dialog-area
//!   └─ .overlay-card            (spec chrome: width/max-height/anchor)
//!       ├─ .ov-title            (spec.title)
//!       ├─ .ov-row[.selected]   (one per frame row)
//!       │    └─ span.role-*[.bold]
//!       └─ .ov-hints            (spec.hints: key verb · key verb)
//! ```
//!
//! Style is enforced by the wire protocol: spans carry a closed `Role` enum
//! mapped to `role-*` classes in the UA stylesheet, so plugin overlays share
//! the theme's CSS variables with the built-in dialogs. The plugin can never
//! emit a raw color.

use blitz_dom::{DocumentMutator, NodeId};
use pi_rpc::{OverlayAnchor, OverlayMargin, OverlaySpec, Role, SizeValue, Span};

use crate::components::dom::{div, qual, span_text};
use crate::state::DialogState;

/// Render the active plugin overlay into `#dialog-area`.
pub fn render(m: &mut DocumentMutator<'_>, area: NodeId, dialog: &DialogState) {
    let DialogState::Plugin {
        spec, frame, ..
    } = dialog
    else {
        return;
    };

    let card = div(m, area, "overlay-card");
    apply_spec_layout(m, card, spec);

    if let Some(title) = &spec.title {
        if !title.is_empty() {
            let t = div(m, card, "ov-title");
            span_text(m, t, "", title);
        }
    }

    for row in frame {
        let selected = row.iter().any(|s| s.role == Some(Role::Selected));
        let r = div(m, card, if selected { "ov-row selected" } else { "ov-row" });
        for s in row {
            render_span(m, r, s);
        }
    }

    if !spec.hints.is_empty() {
        let bar = div(m, card, "ov-hints");
        for (i, h) in spec.hints.iter().enumerate() {
            if i > 0 {
                span_text(m, bar, "hint-sep", " · ");
            }
            span_text(m, bar, "hint-key", &h.key);
            span_text(m, bar, "hint-verb", &format!(" {}", h.verb));
        }
    }
}

fn render_span(m: &mut DocumentMutator<'_>, row: NodeId, s: &Span) {
    let class = match (s.role, s.bold) {
        (Some(role), true) => format!("{} bold", role_class(role)),
        (Some(role), false) => role_class(role).to_string(),
        (None, true) => "bold".to_string(),
        (None, false) => String::new(),
    };
    span_text(m, row, &class, &s.text);
}

fn role_class(role: Role) -> &'static str {
    match role {
        Role::Text => "role-text",
        Role::Muted => "role-muted",
        Role::Dim => "role-dim",
        Role::Accent => "role-accent",
        Role::Warning => "role-warning",
        Role::Error => "role-error",
        Role::Success => "role-success",
        Role::Border => "role-border",
        Role::Selected => "role-selected",
        Role::HintKey => "role-hint-key",
        Role::HintVerb => "role-hint-verb",
    }
}

/// Map the spec's sizing/positioning fields onto inline styles. The layout
/// is in-flow (no absolute positioning), so `anchor` collapses to horizontal
/// margins: left anchors pin left, right anchors pin right, everything else
/// centers. `offsetX`/`offsetY` and `row`/`col` are not representable yet.
fn apply_spec_layout(m: &mut DocumentMutator<'_>, card: NodeId, spec: &OverlaySpec) {
    if let Some(w) = &spec.width {
        m.set_style_property(card, "width", &size_to_css(w));
    }
    if let Some(h) = &spec.max_height {
        m.set_style_property(card, "max-height", &size_to_css(h));
    }
    if let Some(min) = spec.min_width {
        m.set_style_property(card, "min-width", &format!("{min}px"));
    }
    match spec.margin {
        Some(OverlayMargin::Uniform(v)) => {
            m.set_style_property(card, "margin", &format!("{v}px"));
        }
        Some(OverlayMargin::Sides {
            top,
            right,
            bottom,
            left,
        }) => {
            if let Some(v) = top {
                m.set_style_property(card, "margin-top", &format!("{v}px"));
            }
            if let Some(v) = right {
                m.set_style_property(card, "margin-right", &format!("{v}px"));
            }
            if let Some(v) = bottom {
                m.set_style_property(card, "margin-bottom", &format!("{v}px"));
            }
            if let Some(v) = left {
                m.set_style_property(card, "margin-left", &format!("{v}px"));
            }
        }
        None => {}
    }
    match spec.anchor.unwrap_or(OverlayAnchor::Center) {
        OverlayAnchor::TopLeft | OverlayAnchor::BottomLeft | OverlayAnchor::LeftCenter => {
            m.set_style_property(card, "margin-right", "auto");
        }
        OverlayAnchor::TopRight | OverlayAnchor::BottomRight | OverlayAnchor::RightCenter => {
            m.set_style_property(card, "margin-left", "auto");
        }
        _ => {
            m.set_style_property(card, "margin-left", "auto");
            m.set_style_property(card, "margin-right", "auto");
        }
    }
    // `qual` is referenced for symmetry with sibling components that set
    // non-style attributes; keep the import used even if none apply yet.
    let _ = qual;
}

fn size_to_css(v: &SizeValue) -> String {
    match v {
        SizeValue::Cells(n) => format!("{n}px"),
        SizeValue::Percent(p) => p.clone(),
    }
}
