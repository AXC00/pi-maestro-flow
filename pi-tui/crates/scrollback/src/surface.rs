//! `Surface` — a `width × height` grid of [`Cell`]s, the render target
//! that `paint_node` writes into and `diff` compares against the
//! previous frame.
//!
//! RECON §5: `draw_str` iterates grapheme clusters and writes one cell
//! per display column (wide clusters occupy `width` cells, continuation
//! cells are blanked); PUA marker `U+EE80` hits are recorded on the
//! surface; rows can be cloned (sharing `Arc` symbols).

use std::sync::Arc;

use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

use crate::cell::{Cell, Modifier, Symbol};
use crate::style::CellStyle;

/// Private-use marker codepoint recorded by [`Surface::draw_str`].
///
/// chisel-ui embeds `U+EE80`-prefixed markers in text to tag cells for
/// later hit-testing; the surface remembers where they landed.
pub const PUA_MARKER: char = '\u{EE80}';

/// A recorded PUA-marker hit: which marker text was seen and where.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PuaMarker {
    /// The grapheme cluster containing the marker (marker char included).
    pub text: String,
    /// Cell column where the marker was written.
    pub x: u16,
    /// Cell row.
    pub y: u16,
}

/// A rectangular cell grid.
#[derive(Clone)]
pub struct Surface {
    /// Row-major cells, `width * height` long.
    pub cells: Vec<Cell>,
    /// Width in cells.
    pub width: u16,
    /// Height in cells.
    pub height: u16,
    /// PUA-marker hits recorded while drawing.
    pub markers: Vec<PuaMarker>,
    /// Cells painted by `border::paint_border_cell` this frame. The
    /// adjacency fixup only rewrites these — text glyphs that happen to
    /// look like line chars (`+`, `-`, `|`) are never touched.
    pub(crate) border_mask: Vec<bool>,
}

impl Surface {
    /// A blank `width × height` surface.
    pub fn new(width: u16, height: u16) -> Self {
        Surface {
            cells: vec![Cell::EMPTY; width as usize * height as usize],
            width,
            height,
            markers: Vec::new(),
            border_mask: vec![false; width as usize * height as usize],
        }
    }

    /// Reset for reuse as a paint buffer: cells back to EMPTY,
    /// markers and border mask cleared. Keeps the allocations.
    pub fn reset(&mut self) {
        self.cells.fill(Cell::EMPTY);
        self.markers.clear();
        self.border_mask.fill(false);
    }

    /// Mark `(x, y)` as a border-painted cell (called by
    /// `border::paint_border_cell`).
    #[inline]
    pub(crate) fn mark_border(&mut self, x: u16, y: u16) {
        if let Some(i) = self.index(x, y) {
            self.border_mask[i] = true;
        }
    }

    /// True when `(x, y)` was border-painted this frame.
    #[inline]
    pub(crate) fn is_border(&self, x: u16, y: u16) -> bool {
        self.index(x, y).is_some_and(|i| self.border_mask[i])
    }

    /// Total cell count.
    pub fn len(&self) -> usize {
        self.cells.len()
    }

    /// True when the surface has no cells.
    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }

    /// Cell index for `(x, y)`, or `None` when out of bounds.
    #[inline]
    pub fn index(&self, x: u16, y: u16) -> Option<usize> {
        if x < self.width && y < self.height {
            Some(y as usize * self.width as usize + x as usize)
        } else {
            None
        }
    }

    /// Immutable cell access.
    #[inline]
    pub fn cell(&self, x: u16, y: u16) -> Option<&Cell> {
        self.index(x, y).map(|i| &self.cells[i])
    }

    /// Mutable cell access.
    #[inline]
    pub fn cell_mut(&mut self, x: u16, y: u16) -> Option<&mut Cell> {
        self.index(x, y).map(|i| &mut self.cells[i])
    }

    /// One row of cells (`None` when `y` is out of bounds).
    pub fn row(&self, y: u16) -> Option<&[Cell]> {
        if y >= self.height {
            return None;
        }
        let start = y as usize * self.width as usize;
        Some(&self.cells[start..start + self.width as usize])
    }

    /// Mutable row access.
    pub fn row_mut(&mut self, y: u16) -> Option<&mut [Cell]> {
        if y >= self.height {
            return None;
        }
        let start = y as usize * self.width as usize;
        Some(&mut self.cells[start..start + self.width as usize])
    }

    /// Write a single cell (no-op when out of bounds).
    pub fn set(&mut self, x: u16, y: u16, cell: Cell) {
        if let Some(i) = self.index(x, y) {
            self.cells[i] = cell;
            self.border_mask[i] = false;
        }
    }

    /// Fill the rect `[x, x+w) × [y, y+h)` with `symbol` under `style`.
    /// Out-of-bounds parts are clipped.
    pub fn fill(&mut self, x: i32, y: i32, w: i32, h: i32, symbol: &str, style: &CellStyle) {
        let x0 = x.max(0);
        let y0 = y.max(0);
        let x1 = (x + w).min(self.width as i32);
        let y1 = (y + h).min(self.height as i32);
        for cy in y0..y1 {
            for cx in x0..x1 {
                if let Some(i) = self.index(cx as u16, cy as u16) {
                    let cell = &mut self.cells[i];
                    cell.symbol = Symbol::new(symbol);
                    apply_style(cell, style);
                    self.border_mask[i] = false;
                }
            }
        }
    }

    /// Draw a string starting at `(x, y)`, one grapheme cluster per cell
    /// column, advancing by display width.
    ///
    /// * `width` limits how many columns the text may occupy; a cluster
    ///   that would overflow is replaced by a single `…` (ellipsis) when
    ///   there is room for it, otherwise dropped.
    /// * `style` is applied to every written cell; `link` is attached to
    ///   every written cell (`<a href>` support).
    /// * Grapheme clusters containing [`PUA_MARKER`] are recorded in
    ///   [`Surface::markers`].
    /// * Wide clusters (display width 2) write the cluster into the first
    ///   cell and blank the continuation cell(s).
    ///
    /// Returns the number of columns actually written.
    pub fn draw_str(
        &mut self,
        x: i32,
        y: i32,
        s: &str,
        width: i32,
        style: &CellStyle,
        link: Option<&Arc<str>>,
    ) -> i32 {
        if y < 0 || y >= self.height as i32 || width <= 0 {
            return 0;
        }
        let y = y as u16;
        let mut cx = x;
        let end = x + width;
        let mut written = 0i32;

        for grapheme in s.graphemes(true) {
            let gw = UnicodeWidthStr::width(grapheme) as i32;
            if gw == 0 {
                // Zero-width cluster (combining marks, ZWJ sequences that
                // didn't merge, control chars): skip without advancing.
                continue;
            }
            // Ellide a cluster that would overflow the allotted width.
            // The ellipsis overwrites the LAST allotted column (end-1),
            // matching the original's `draw_str(right_edge-1, y, "…")`.
            if cx + gw > end {
                let ex = end - 1;
                if ex >= 0 && ex < self.width as i32 {
                    if let Some(cell) = self.cell_mut(ex as u16, y) {
                        cell.symbol = Symbol::new("…");
                        apply_style(cell, style);
                        set_link(cell, link);
                    }
                }
                // The allotted field is fully consumed.
                written = end - x;
                break;
            }
            // Record PUA markers.
            if grapheme.contains(PUA_MARKER) {
                self.markers.push(PuaMarker {
                    text: grapheme.to_string(),
                    x: cx.max(0) as u16,
                    y,
                });
            }
            // Master cell.
            if cx >= 0 && cx < self.width as i32 {
                if let Some(i) = self.index(cx as u16, y) {
                    let cell = &mut self.cells[i];
                    cell.symbol = Symbol::new(grapheme);
                    apply_style(cell, style);
                    set_link(cell, link);
                    self.border_mask[i] = false;
                }
            }
            // Continuation cells of wide clusters are blanked.
            for k in 1..gw {
                let kx = cx + k;
                if kx >= 0 && kx < self.width as i32 {
                    if let Some(i) = self.index(kx as u16, y) {
                        let cell = &mut self.cells[i];
                        cell.symbol = Symbol::new("");
                        apply_style(cell, style);
                        set_link(cell, link);
                        self.border_mask[i] = false;
                    }
                }
            }
            cx += gw;
            written += gw;
        }
        written
    }

    /// Deep-clone row `dst` from row `src`.
    ///
    /// `Arc` symbols are shared (cheap); everything else is copied.
    /// Mirrors the original's 64-byte cell row clone.
    pub fn clone_row(&mut self, src: u16, dst: u16) {
        if src >= self.height || dst >= self.height || src == dst {
            return;
        }
        let w = self.width as usize;
        let (lo, hi) = if src < dst { (src, dst) } else { (dst, src) };
        let (a, b) = self.cells.split_at_mut(hi as usize * w);
        let src_row = &a[lo as usize * w..lo as usize * w + w];
        let dst_row = &mut b[..w];
        for (d, s) in dst_row.iter_mut().zip(src_row.iter()) {
            d.symbol = match &s.symbol {
                // Long clusters become shared on clone.
                Symbol::Box(b) => Symbol::Arc(Arc::from(b.as_ref())),
                Symbol::Arc(a) => Symbol::Arc(a.clone()),
                Symbol::Inline { len, buf } => Symbol::Inline {
                    len: *len,
                    buf: *buf,
                },
            };
            d.fg = s.fg;
            d.bg = s.bg;
            d.underline = s.underline;
            d.modifier = s.modifier;
            d.link = s.link.clone();
        }
        // Border mask travels with the cells.
        let (ma, mb) = self.border_mask.split_at_mut(hi as usize * w);
        mb[..w].copy_from_slice(&ma[lo as usize * w..lo as usize * w + w]);
    }

    /// Render the surface to plain text (symbols only) — for tests and
    /// debugging.
    pub fn to_text(&self) -> String {
        let mut out = String::new();
        for y in 0..self.height {
            for x in 0..self.width {
                let s = self.cell(x, y).map(|c| c.symbol.as_str()).unwrap_or("");
                if s.is_empty() {
                    out.push(' ');
                } else {
                    out.push_str(s);
                }
            }
            out.push('\n');
        }
        out
    }
}

/// Apply a `CellStyle` to a cell.
#[inline]
pub(crate) fn apply_style(cell: &mut Cell, style: &CellStyle) {
    cell.fg = style.fg;
    cell.bg = style.bg;
    cell.underline = style.underline;
    cell.modifier = if style.modifier == crate::style::INHERIT_MODIFIER {
        Modifier::empty()
    } else {
        style.modifier
    };
}

#[inline]
fn set_link(cell: &mut Cell, link: Option<&Arc<str>>) {
    cell.link = link.cloned();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cell::Color;

    fn style() -> CellStyle {
        CellStyle {
            fg: Color::Ansi(7),
            bg: Color::Reset,
            underline: Color::Reset,
            modifier: Modifier::empty(),
        }
    }

    #[test]
    fn draw_str_writes_graphemes() {
        let mut s = Surface::new(10, 2);
        s.draw_str(1, 0, "abc", 8, &style(), None);
        assert_eq!(s.cell(1, 0).unwrap().symbol, "a");
        assert_eq!(s.cell(2, 0).unwrap().symbol, "b");
        assert_eq!(s.cell(3, 0).unwrap().symbol, "c");
        assert_eq!(s.cell(1, 0).unwrap().fg, Color::Ansi(7));
    }

    #[test]
    fn draw_str_wide_chars_blank_continuation() {
        let mut s = Surface::new(10, 1);
        s.draw_str(0, 0, "你好x", 10, &style(), None);
        assert_eq!(s.cell(0, 0).unwrap().symbol, "你");
        assert_eq!(s.cell(1, 0).unwrap().symbol, "");
        assert_eq!(s.cell(2, 0).unwrap().symbol, "好");
        assert_eq!(s.cell(3, 0).unwrap().symbol, "");
        assert_eq!(s.cell(4, 0).unwrap().symbol, "x");
    }

    #[test]
    fn draw_str_ellipsis_on_overflow() {
        let mut s = Surface::new(10, 1);
        let n = s.draw_str(0, 0, "abcdef", 3, &style(), None);
        assert_eq!(s.cell(0, 0).unwrap().symbol, "a");
        assert_eq!(s.cell(1, 0).unwrap().symbol, "b");
        assert_eq!(s.cell(2, 0).unwrap().symbol, "…");
        assert_eq!(n, 3);
    }

    #[test]
    fn draw_str_records_pua_markers() {
        let mut s = Surface::new(10, 1);
        s.draw_str(2, 0, "a\u{EE80}b", 8, &style(), None);
        assert_eq!(s.markers.len(), 1);
        assert_eq!(s.markers[0].x, 3);
        assert!(s.markers[0].text.contains('\u{EE80}'));
    }

    #[test]
    fn draw_str_link() {
        let mut s = Surface::new(10, 1);
        let link: Arc<str> = Arc::from("https://example.com");
        s.draw_str(0, 0, "go", 8, &style(), Some(&link));
        assert_eq!(s.cell(0, 0).unwrap().link.as_deref(), Some("https://example.com"));
        assert_eq!(s.cell(1, 0).unwrap().link.as_deref(), Some("https://example.com"));
    }

    #[test]
    fn clone_row_shares_content() {
        let mut s = Surface::new(5, 3);
        s.draw_str(0, 0, "hello", 5, &style(), None);
        s.clone_row(0, 2);
        assert_eq!(s.row(0).unwrap(), s.row(2).unwrap());
    }
}
