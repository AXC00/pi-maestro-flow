//! `spinner` — 16-frame braille spinner with fusion gradient,
//! `InterruptHint`, and `Thinking` dots (RECON §9 `spinner`).
//!
//! DOM shape:
//! ```text
//! #spinner-line (row, hidden when idle)
//!   ├─ #spinner-glyph "{frame}"   (per-frame fusion-gradient color)
//!   ├─ #spinner-label "Thinking"  (accent)
//!   ├─ #spinner-dots  "." / ".." / "..."   ((tick>>2)%3+1)
//!   └─ #spinner-hint  " · {hint}"          (InterruptHint: bold accent)
//! ```

use blitz_dom::{DocumentMutator, NodeId};

use crate::components::dom::{div, qual, span_text};
use crate::components::glyphs::GlyphMode;

/// Spinner interval: the original ticks at 90ms; the app drives frames
/// from its 33ms tick (`tick / 3`).
pub const SPINNER_INTERVAL_MS: u64 = 90;

/// Fusion gradient endpoints (RECON §9 theme vars).
/// lead → highlight → sidekick, ping-ponged across the 16 frames.
const FUSION_LEAD: (u8, u8, u8) = (0x4e, 0xb6, 0xf7); // #4eb6f7
const FUSION_HIGHLIGHT: (u8, u8, u8) = (0xcf, 0xef, 0xff); // #cfefff
const FUSION_SIDEKICK: (u8, u8, u8) = (0x90, 0xa9, 0xbf); // #90a9bf

fn lerp(a: u8, b: u8, t: f32) -> u8 {
    (a as f32 + (b as f32 - a as f32) * t).round() as u8
}

fn mix(a: (u8, u8, u8), b: (u8, u8, u8), t: f32) -> (u8, u8, u8) {
    (lerp(a.0, b.0, t), lerp(a.1, b.1, t), lerp(a.2, b.2, t))
}

/// The fusion-gradient color for spinner frame `frame` (0..16).
/// Ping-pong: 0..8 lead→highlight, 8..16 highlight→sidekick.
pub fn fusion_color(frame: usize) -> (u8, u8, u8) {
    let f = frame % 16;
    if f < 8 {
        mix(FUSION_LEAD, FUSION_HIGHLIGHT, f as f32 / 7.0)
    } else {
        mix(FUSION_HIGHLIGHT, FUSION_SIDEKICK, (f - 8) as f32 / 8.0)
    }
}

/// Build the `#spinner-line` under `parent`.
/// Returns `(line, glyph_span, label_text, dots_text, hint_text)`.
pub fn build(m: &mut DocumentMutator<'_>, parent: NodeId) -> SpinnerHandles {
    let line = div(m, parent, "");
    m.set_attribute(line, qual("id"), "spinner-line");

    let (glyph_span, _gt) = span_text(m, line, "", "");
    m.set_attribute(glyph_span, qual("id"), "spinner-glyph");
    let (label_span, label_text) = span_text(m, line, "", "");
    m.set_attribute(label_span, qual("id"), "spinner-label");
    let (dots_span, dots_text) = span_text(m, line, "", "");
    m.set_attribute(dots_span, qual("id"), "spinner-dots");
    let (hint_span, hint_text) = span_text(m, line, "", "");
    m.set_attribute(hint_span, qual("id"), "spinner-hint");

    SpinnerHandles {
        line,
        glyph_span,
        label_text,
        dots_text,
        hint_text,
    }
}

/// Node ids the app patches each frame.
#[derive(Clone, Copy)]
pub struct SpinnerHandles {
    pub line: NodeId,
    pub glyph_span: NodeId,
    pub label_text: NodeId,
    pub dots_text: NodeId,
    pub hint_text: NodeId,
}

/// Sync the spinner line for the current tick.
///
/// * `active` — whether the agent is streaming (line hidden when false).
/// * `tick` — app tick counter (33ms); frame = `(tick/3) % 16`.
/// * `hint` — the `InterruptHint` text (e.g. "esc to interrupt").
pub fn sync(
    m: &mut DocumentMutator<'_>,
    h: &SpinnerHandles,
    active: bool,
    tick: u64,
    hint: &str,
    mode: GlyphMode,
) {
    if !active {
        m.set_style_property(h.line, "display", "none");
        return;
    }
    m.set_style_property(h.line, "display", "flex");

    // Frame + fusion gradient color (inline style — per-frame value).
    let frame = (tick / 3) as usize % 16;
    let (r, g, b) = fusion_color(frame);
    m.set_style_property(h.glyph_span, "color", &format!("rgb({r},{g},{b})"));
    // Glyph text lives in the span's first (text) child.
    if let Some(tid) = m.child_ids(h.glyph_span).first().copied() {
        m.set_node_text(tid, mode.spinner_frame(tick / 3));
    }

    m.set_node_text(h.label_text, " Thinking");
    let dots = (tick >> 2) % 3 + 1;
    m.set_node_text(h.dots_text, &".".repeat(dots as usize));
    if hint.is_empty() {
        m.set_node_text(h.hint_text, "");
    } else {
        m.set_node_text(h.hint_text, &format!(" · {hint}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gradient_endpoints() {
        assert_eq!(fusion_color(0), FUSION_LEAD);
        assert_eq!(fusion_color(7), FUSION_HIGHLIGHT);
        assert_eq!(fusion_color(16), FUSION_LEAD); // wraps
    }
}
