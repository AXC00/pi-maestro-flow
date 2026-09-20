//! Frame diffing: compare the previous and current [`Surface`]s cell by
//! cell and emit the minimal ANSI stream that turns one into the other.
//!
//! RECON §6: per-row, per-cell comparison; consecutive changed cells
//! form a run; within a run, cells sharing a style are emitted as one
//! span (SGR once, then the symbols). Cursor moves are emitted only
//! when the next changed cell isn't where the cursor already is.

use std::fmt::Write as _;
use std::sync::Arc;

use crate::ansi::{self, Level};
use crate::cell::Cell;
use crate::style::CellStyle;
use crate::surface::Surface;

/// One changed span: `count` cells starting at `(x, y)` on the new
/// frame, all sharing `style`.
#[derive(Clone, Debug, PartialEq)]
pub struct Span {
    /// Row.
    pub y: u16,
    /// Start column.
    pub x: u16,
    /// Number of cells.
    pub count: u16,
    /// Shared style of the span.
    pub style: CellStyle,
}

/// Compute the changed spans between `prev` and `cur`.
///
/// When `prev` is `None` or sizes differ, every cell counts as changed.
/// Cells are grouped into spans of equal style along each row — the
/// run-length encoding the ANSI emitter walks.
pub fn diff_spans(prev: Option<&Surface>, cur: &Surface) -> Vec<Span> {
    let mut spans = Vec::new();
    let full = match prev {
        Some(p) => p.width != cur.width || p.height != cur.height,
        None => true,
    };

    for y in 0..cur.height {
        let mut x = 0u16;
        while x < cur.width {
            let changed = full
                || match prev.and_then(|p| p.cell(x, y)) {
                    Some(pc) => pc != cur.cell(x, y).unwrap(),
                    None => true,
                };
            if !changed {
                x += 1;
                continue;
            }
            // Start of a changed run; group by equal style.
            let style = cell_style(cur.cell(x, y).unwrap());
            let start = x;
            let mut count = 1u16;
            x += 1;
            while x < cur.width {
                let cell = cur.cell(x, y).unwrap();
                let still_changed = full
                    || match prev.and_then(|p| p.cell(x, y)) {
                        Some(pc) => pc != cell,
                        None => true,
                    };
                if !still_changed || cell_style(cell) != style {
                    break;
                }
                count += 1;
                x += 1;
            }
            spans.push(Span {
                y,
                x: start,
                count,
                style,
            });
        }
    }
    spans
}

/// Extract the emit-relevant style of a cell.
fn cell_style(cell: &Cell) -> CellStyle {
    CellStyle {
        fg: cell.fg,
        bg: cell.bg,
        underline: cell.underline,
        modifier: cell.modifier,
    }
}

/// Emit the ANSI stream that turns `prev` into `cur`.
///
/// * `level` gates color emission (see [`Level`]).
/// * Changed cells are written left-to-right, top-to-bottom; a
///   `move_to` is emitted whenever the next changed cell isn't
///   contiguous with the previously written one.
/// * Wide-cluster continuation cells (blank symbol following a
///   width-2 symbol) are skipped — the terminal advances past them.
/// * Hyperlinks are emitted as OSC 8 around the linked cells.
pub fn emit_ansi(out: &mut String, prev: Option<&Surface>, cur: &Surface, level: Level) {
    let spans = diff_spans(prev, cur);
    if spans.is_empty() {
        return;
    }

    // Terminal cursor bookkeeping: after writing a cell the cursor sits
    // one column past it (two for wide glyphs).
    let mut cursor: Option<(u16, u16)> = None; // (x, y) of next write
    let mut current_style: Option<CellStyle> = None;
    let mut open_link: Option<Arc<str>> = None;

    for span in spans {
        for i in 0..span.count {
            let x = span.x + i;
            let y = span.y;
            let cell = cur.cell(x, y).unwrap();

            // Skip continuation cells of wide clusters: the master cell
            // (already emitted) occupies them on the terminal.
            if cell.symbol.is_empty() && x > 0 {
                if let Some(left) = cur.cell(x - 1, y) {
                    if unicode_width::UnicodeWidthStr::width(left.symbol.as_str()) == 2 {
                        cursor = Some((x + 1, y));
                        continue;
                    }
                }
            }

            // Reposition when not contiguous.
            if cursor != Some((x, y)) {
                ansi::move_to(out, y, x);
            }

            // Style change → SGR.
            if current_style != Some(span.style) {
                match current_style {
                    Some(from) => ansi::emit_sgr_delta(out, &from, &span.style, level),
                    None => ansi::emit_sgr(out, &span.style, level),
                }
                current_style = Some(span.style);
            }

            // Hyperlink transitions (OSC 8).
            if cell.link.as_deref() != open_link.as_deref() {
                match &cell.link {
                    Some(uri) => {
                        let _ = write!(out, "\x1b]8;;{}\x1b\\", uri);
                    }
                    None => out.push_str("\x1b]8;;\x1b\\"),
                }
                open_link = cell.link.clone();
            }

            // Symbol.
            let sym = cell.symbol.as_str();
            if sym.is_empty() {
                out.push(' ');
            } else {
                out.push_str(sym);
            }
            let adv = unicode_width::UnicodeWidthStr::width(sym).max(1) as u16;
            cursor = Some((x + adv, y));
        }
    }

    // Close any dangling hyperlink and leave the terminal in a sane
    // style state.
    if open_link.is_some() {
        out.push_str("\x1b]8;;\x1b\\");
    }
    if current_style.is_some_and(|s| {
        s.modifier != crate::cell::Modifier::empty()
            || !s.fg.is_reset()
            || !s.bg.is_reset()
            || !s.underline.is_reset()
    }) {
        ansi::sgr_reset(out);
    }
}

/// Emit the whole surface unconditionally (first frame / resize).
pub fn emit_full(out: &mut String, cur: &Surface, level: Level) {
    emit_ansi(out, None, cur, level);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cell::{Color, Modifier};

    fn styled_cell(sym: &str, fg: Color) -> Cell {
        Cell {
            symbol: sym.into(),
            fg,
            ..Cell::EMPTY
        }
    }

    #[test]
    fn no_changes_no_spans() {
        let a = Surface::new(4, 2);
        let b = a.clone();
        assert!(diff_spans(Some(&a), &b).is_empty());
    }

    #[test]
    fn run_length_groups_same_style() {
        let prev = Surface::new(6, 1);
        let mut cur = prev.clone();
        // Change cells 1..4 to the same style.
        for x in 1..4 {
            cur.set(x, 0, styled_cell("x", Color::Ansi(1)));
        }
        let spans = diff_spans(Some(&prev), &cur);
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].x, 1);
        assert_eq!(spans[0].count, 3);
        // A style change mid-run splits the span; cells after it that
        // revert to the first style form a third span (spans group by
        // equal style because emit_ansi writes span.style once).
        cur.set(2, 0, styled_cell("y", Color::Ansi(2)));
        let spans = diff_spans(Some(&prev), &cur);
        assert_eq!(spans.len(), 3);
        assert_eq!(spans[0].count, 1);
        assert_eq!(spans[1].x, 2);
        assert_eq!(spans[1].count, 1);
        assert_eq!(spans[2].x, 3);
        assert_eq!(spans[2].count, 1);
    }

    #[test]
    fn size_change_is_full_diff() {
        let prev = Surface::new(2, 1);
        let cur = Surface::new(4, 1);
        let spans = diff_spans(Some(&prev), &cur);
        assert_eq!(spans.iter().map(|s| s.count as usize).sum::<usize>(), 4);
    }

    #[test]
    fn emit_ansi_positions_and_styles() {
        let prev = Surface::new(8, 2);
        let mut cur = prev.clone();
        cur.set(
            2,
            1,
            Cell {
                symbol: "h".into(),
                fg: Color::Rgb(255, 0, 0),
                modifier: Modifier::BOLD,
                ..Cell::EMPTY
            },
        );
        cur.set(3, 1, styled_cell("i", Color::Rgb(255, 0, 0)));
        // give cell 3 the same style as cell 2 (bold) so they share a span
        cur.cell_mut(3, 1).unwrap().modifier = Modifier::BOLD;

        let mut out = String::new();
        emit_ansi(&mut out, Some(&prev), &cur, Level::TRUECOLOR);
        // Row 2 (1-based), col 3 → "\x1b[2;3H", then SGR with truecolor+bold.
        assert!(out.contains("\x1b[2;3H"), "out: {out:?}");
        assert!(out.contains("38;2;255;0;0"), "out: {out:?}");
        assert!(out.contains("hi"), "out: {out:?}");
        // Ends with a reset.
        assert!(out.ends_with("\x1b[0m"), "out: {out:?}");
    }

    #[test]
    fn emit_ansi_skips_unchanged() {
        let prev = Surface::new(4, 1);
        let cur = prev.clone();
        let mut out = String::new();
        emit_ansi(&mut out, Some(&prev), &cur, Level::TRUECOLOR);
        assert_eq!(out, "");
    }
}

