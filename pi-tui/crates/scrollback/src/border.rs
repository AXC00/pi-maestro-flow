//! Border painting with box-drawing segment merging.
//!
//! RECON §4: every border cell carries a 4-bit segment mask
//! (`U|D|L|R`); painting a border *merges* the new segments into the
//! cell's existing mask and re-derives the glyph from a lookup table, so
//! intersecting borders produce junctions (`┬`, `┼`, …). A final
//! adjacency pass keeps a segment only when the neighbour in that
//! direction reciprocates — this is what turns a corner's spurious
//! outer stubs into `┌`/`┐`/`└`/`┘` and lets `<hr>` lines weld into
//! box borders.
//!
//! Two glyph sets exist (unicode / ASCII), selected by [`GlyphSet`].

use crate::cell::Symbol;
use crate::style::CellStyle;
use crate::surface::Surface;

/// Segment mask bits.
pub mod seg {
    /// Segment extending upward from the cell centre.
    pub const UP: u8 = 1;
    /// Segment extending downward.
    pub const DOWN: u8 = 2;
    /// Segment extending left.
    pub const LEFT: u8 = 4;
    /// Segment extending right.
    pub const RIGHT: u8 = 8;
}

/// Which glyph table to use.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum GlyphSet {
    /// Unicode box-drawing characters.
    #[default]
    Unicode,
    /// ASCII fallbacks (`-`, `|`, `+`).
    Ascii,
}

/// Map a 4-bit segment mask to its box-drawing glyph.
///
/// Table (RECON §4): `3→│ 5→┘ 6→┐ 7→┤ 9→└ 10→┌ 11→├ 12→─ 13→┴ 14→┬ 15→┼`.
/// Single-segment masks map to the plain line glyph (a lone stub still
/// renders as a line end).
pub fn glyph_for(mask: u8, set: GlyphSet) -> &'static str {
    match set {
        GlyphSet::Unicode => match mask {
            0 => " ",
            // Single stubs and the straight pair share the line glyph.
            1 | 2 | 3 => "│",
            4 | 8 | 12 => "─",
            5 => "┘",
            6 => "┐",
            7 => "┤",
            9 => "└",
            10 => "┌",
            11 => "├",
            13 => "┴",
            14 => "┬",
            _ => "┼",
        },
        GlyphSet::Ascii => match mask {
            0 => " ",
            1 | 2 | 3 => "|",
            4 | 8 | 12 => "-",
            _ => "+",
        },
    }
}

/// Classify a symbol into its segment mask (0 = not a line glyph).
///
/// Covers the unicode box-drawing range we emit plus the ASCII
/// fallbacks, so re-painting over an existing border cell merges
/// correctly.
pub fn segment_mask(symbol: &str) -> u8 {
    use seg::*;
    match symbol {
        // Unicode line glyphs.
        "│" => UP | DOWN,
        "─" => LEFT | RIGHT,
        // Corners connect the two edges they join: ┘=up+left, ┐=down+left,
        // └=up+right, ┌=down+right (matches RECON masks 5/6/9/10).
        "┘" => UP | LEFT,
        "┐" => DOWN | LEFT,
        "└" => UP | RIGHT,
        "┌" => DOWN | RIGHT,
        // Tees: ┤=vertical+left, ├=vertical+right, ┴=up+horizontal,
        // ┬=down+horizontal (RECON masks 7/11/13/14).
        "┤" => UP | DOWN | LEFT,
        "├" => UP | DOWN | RIGHT,
        "┴" => UP | LEFT | RIGHT,
        "┬" => DOWN | LEFT | RIGHT,
        "┼" => UP | DOWN | LEFT | RIGHT,
        // Half-line stubs.
        "╵" => UP,
        "╷" => DOWN,
        "╴" => LEFT,
        "╶" => RIGHT,
        // ASCII fallbacks.
        "|" => UP | DOWN,
        "-" => LEFT | RIGHT,
        "+" => UP | DOWN | LEFT | RIGHT,
        _ => 0,
    }
}

/// Paint one border cell: merge `mask` into the cell's existing segment
/// mask, re-derive the glyph, and apply `style`.
///
/// Non-line content is overwritten (a border wins over text at the same
/// cell, matching the original where borders paint after backgrounds).
pub fn paint_border_cell(
    surface: &mut Surface,
    x: i32,
    y: i32,
    mask: u8,
    style: &CellStyle,
    set: GlyphSet,
) {
    if x < 0 || y < 0 || x >= surface.width as i32 || y >= surface.height as i32 {
        return;
    }
    let (x, y) = (x as u16, y as u16);
    let Some(cell) = surface.cell_mut(x, y) else { return };
    let merged = segment_mask(cell.symbol.as_str()) | mask;
    cell.symbol = Symbol::new(glyph_for(merged, set));
    cell.fg = style.fg;
    cell.bg = style.bg;
    cell.underline = style.underline;
    cell.modifier = if style.modifier == crate::style::INHERIT_MODIFIER {
        crate::cell::Modifier::empty()
    } else {
        style.modifier
    };
    surface.mark_border(x, y);
}

/// Per-side border description for [`paint_borders`].
#[derive(Clone, Copy, Debug, Default)]
pub struct BorderEdges {
    /// Top edge present.
    pub top: bool,
    /// Bottom edge present.
    pub bottom: bool,
    /// Left edge present.
    pub left: bool,
    /// Right edge present.
    pub right: bool,
}

impl BorderEdges {
    /// All four edges.
    pub const ALL: Self = Self {
        top: true,
        bottom: true,
        left: true,
        right: true,
    };

    /// No edges.
    pub const NONE: Self = Self {
        top: false,
        bottom: false,
        left: false,
        right: false,
    };

    /// True when at least one edge is present.
    pub fn any(&self) -> bool {
        self.top || self.bottom || self.left || self.right
    }
}

/// Paint the border of `rect` (a cell rect: `x,y` top-left, `w,h` size)
/// into `surface`, merging segments into whatever is already there.
///
/// Corners get both segments of the adjoining edges; the adjacency
/// fixup in [`fixup_border_adjacency`] then prunes non-reciprocated
/// stubs, which is what produces real corner glyphs.
pub fn paint_borders(
    surface: &mut Surface,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    edges: BorderEdges,
    style: &CellStyle,
    set: GlyphSet,
) {
    use seg::*;
    if w <= 0 || h <= 0 || !edges.any() {
        return;
    }
    let (x0, y0, x1, y1) = (x, y, x + w - 1, y + h - 1);

    if edges.top {
        for cx in x0..=x1 {
            let mut m = LEFT | RIGHT;
            if cx == x0 && edges.left {
                m |= DOWN;
            }
            if cx == x1 && edges.right {
                m |= DOWN;
            }
            paint_border_cell(surface, cx, y0, m, style, set);
        }
    }
    if edges.bottom {
        for cx in x0..=x1 {
            let mut m = LEFT | RIGHT;
            if cx == x0 && edges.left {
                m |= UP;
            }
            if cx == x1 && edges.right {
                m |= UP;
            }
            paint_border_cell(surface, cx, y1, m, style, set);
        }
    }
    if edges.left {
        for cy in y0..=y1 {
            let mut m = UP | DOWN;
            if cy == y0 && edges.top {
                m |= RIGHT;
            }
            if cy == y1 && edges.bottom {
                m |= RIGHT;
            }
            paint_border_cell(surface, x0, cy, m, style, set);
        }
    }
    if edges.right {
        for cy in y0..=y1 {
            let mut m = UP | DOWN;
            if cy == y0 && edges.top {
                m |= LEFT;
            }
            if cy == y1 && edges.bottom {
                m |= LEFT;
            }
            paint_border_cell(surface, x1, cy, m, style, set);
        }
    }
}

/// Adjacency fixup: for every cell in `rect` that carries a line glyph,
/// reconcile each segment with its neighbour — "双向呼应" (mutual
/// acknowledgement):
///
/// * neighbour is **not** a line cell (mask 0) → the segment is a
///   dangling stub, drop it (this is what turns a corner's spurious
///   outer stubs into `┌`/`┐`/`└`/`┘`);
/// * neighbour already has the opposite segment → keep;
/// * neighbour is a line cell lacking the opposite segment → **weld**:
///   add the opposite segment to the neighbour and re-derive its glyph
///   (this is what makes `<hr>` lines meet box sides as `├`/`┤` and
///   verticals meet horizontals as `┬`/`┴`).
///
/// Welding only ever *adds* segments, so a single row-major pass is
/// order-independent for the cases above. Neighbours outside `rect`
/// participate in the test and may be welded (they keep their style).
pub fn fixup_border_adjacency(surface: &mut Surface, x: i32, y: i32, w: i32, h: i32, set: GlyphSet) {
    use seg::*;
    let x0 = x.max(0);
    let y0 = y.max(0);
    let x1 = (x + w).min(surface.width as i32);
    let y1 = (y + h).min(surface.height as i32);

    for cy in y0..y1 {
        for cx in x0..x1 {
            let (cx16, cy16) = (cx as u16, cy as u16);
            // Only border-painted cells participate: text glyphs that
            // happen to look like line chars (`+`, `-`, `|`) are left
            // alone (P4 fix — the original tracks painted borders, not
            // arbitrary text).
            if !surface.is_border(cx16, cy16) {
                continue;
            }
            let Some(cell) = surface.cell(cx16, cy16) else {
                continue;
            };
            let orig_mask = segment_mask(cell.symbol.as_str());
            let mut mask = orig_mask;
            if mask == 0 {
                continue;
            }
            for (dir, dx, dy, opposite) in [
                (UP, 0i32, -1i32, DOWN),
                (DOWN, 0, 1, UP),
                (LEFT, -1, 0, RIGHT),
                (RIGHT, 1, 0, LEFT),
            ] {
                if mask & dir == 0 {
                    continue;
                }
                let nx = cx + dx;
                let ny = cy + dy;
                if nx < 0 || ny < 0 || nx >= surface.width as i32 || ny >= surface.height as i32 {
                    // Off-surface: dangling stub.
                    mask &= !dir;
                    continue;
                }
                let (nx16, ny16) = (nx as u16, ny as u16);
                // Only border-painted neighbours can reciprocate or be
                // welded — a text `+`/`-`/`|` next to a border is not a
                // junction.
                let nmask = if surface.is_border(nx16, ny16) {
                    surface
                        .cell(nx16, ny16)
                        .map(|n| segment_mask(n.symbol.as_str()))
                        .unwrap_or(0)
                } else {
                    0
                };
                if nmask == 0 {
                    // Neighbour is not a line cell: dangling stub.
                    mask &= !dir;
                } else if nmask & opposite == 0 {
                    // Weld: neighbour gains the reciprocal segment.
                    let new_nmask = nmask | opposite;
                    if let Some(n) = surface.cell_mut(nx16, ny16) {
                        n.symbol = Symbol::new(glyph_for(new_nmask, set));
                    }
                }
            }
            // A fully-stripped mask means every segment dangled — but a
            // lone line glyph (e.g. the left border of a 1-row-tall box)
            // is intentional paint, not a junction artifact. Keep it.
            if mask == 0 {
                mask = orig_mask;
            }
            let new_glyph = glyph_for(mask, set);
            if let Some(cell) = surface.cell_mut(cx16, cy16) {
                if cell.symbol.as_str() != new_glyph {
                    cell.symbol = Symbol::new(new_glyph);
                }
            }
        }
    }
}

/// Convenience: paint borders then run the adjacency fixup over the
/// rect expanded by one cell (so edge cells see their neighbours).
pub fn paint_borders_fixed(
    surface: &mut Surface,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    edges: BorderEdges,
    style: &CellStyle,
    set: GlyphSet,
) {
    paint_borders(surface, x, y, w, h, edges, style, set);
    fixup_border_adjacency(surface, x - 1, y - 1, w + 2, h + 2, set);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cell::Color;

    fn style() -> CellStyle {
        CellStyle {
            fg: Color::Ansi(7),
            ..CellStyle::INHERIT
        }
    }

    #[test]
    fn glyph_table_matches_recon() {
        use seg::*;
        let g = |m| glyph_for(m, GlyphSet::Unicode);
        assert_eq!(g(UP | DOWN), "│"); // 3
        assert_eq!(g(UP | LEFT), "┘"); // 5
        assert_eq!(g(DOWN | LEFT), "┐"); // 6
        assert_eq!(g(UP | DOWN | LEFT), "┤"); // 7
        assert_eq!(g(UP | RIGHT), "└"); // 9
        assert_eq!(g(DOWN | RIGHT), "┌"); // 10
        assert_eq!(g(UP | DOWN | RIGHT), "├"); // 11
        assert_eq!(g(LEFT | RIGHT), "─"); // 12
        assert_eq!(g(UP | LEFT | RIGHT), "┴"); // 13
        assert_eq!(g(DOWN | LEFT | RIGHT), "┬"); // 14
        assert_eq!(g(UP | DOWN | LEFT | RIGHT), "┼"); // 15
    }

    #[test]
    fn segment_mask_roundtrip() {
        // glyph_for collapses single stubs and the straight pair onto the
        // plain line glyph, so only multi-direction masks round-trip.
        for m in 1u8..=15 {
            let expected = match m {
                1 | 2 | 3 => 3,   // UP/DOWN/vertical → │
                4 | 8 | 12 => 12, // LEFT/RIGHT/horizontal → ─
                other => other,
            };
            assert_eq!(
                segment_mask(glyph_for(m, GlyphSet::Unicode)),
                expected,
                "mask {m}"
            );
        }
    }

    #[test]
    fn merge_produces_junction() {
        let mut s = Surface::new(5, 3);
        // Horizontal line through (2,1), then vertical line through it.
        paint_border_cell(&mut s, 2, 1, seg::LEFT | seg::RIGHT, &style(), GlyphSet::Unicode);
        paint_border_cell(&mut s, 2, 1, seg::UP | seg::DOWN, &style(), GlyphSet::Unicode);
        assert_eq!(s.cell(2, 1).unwrap().symbol, "┼");
    }

    #[test]
    fn full_box_has_corners_after_fixup() {
        let mut s = Surface::new(6, 4);
        paint_borders(&mut s, 1, 0, 4, 3, BorderEdges::ALL, &style(), GlyphSet::Unicode);
        fixup_border_adjacency(&mut s, 0, 0, 6, 4, GlyphSet::Unicode);
        assert_eq!(s.cell(1, 0).unwrap().symbol, "┌");
        assert_eq!(s.cell(4, 0).unwrap().symbol, "┐");
        assert_eq!(s.cell(1, 2).unwrap().symbol, "└");
        assert_eq!(s.cell(4, 2).unwrap().symbol, "┘");
        assert_eq!(s.cell(2, 0).unwrap().symbol, "─");
        assert_eq!(s.cell(1, 1).unwrap().symbol, "│");
    }

    #[test]
    fn hr_welds_into_box_sides() {
        let mut s = Surface::new(6, 4);
        paint_borders(&mut s, 1, 0, 4, 3, BorderEdges::ALL, &style(), GlyphSet::Unicode);
        // <hr> across the middle row.
        for x in 2..4 {
            paint_border_cell(&mut s, x, 1, seg::LEFT | seg::RIGHT, &style(), GlyphSet::Unicode);
        }
        fixup_border_adjacency(&mut s, 0, 0, 6, 4, GlyphSet::Unicode);
        // Left/right borders gain junctions where the line meets them.
        assert_eq!(s.cell(1, 1).unwrap().symbol, "├");
        assert_eq!(s.cell(4, 1).unwrap().symbol, "┤");
        assert_eq!(s.cell(2, 1).unwrap().symbol, "─");
    }

    #[test]
    fn lone_line_keeps_line_glyph() {
        let mut s = Surface::new(5, 1);
        for x in 0..5 {
            paint_border_cell(&mut s, x, 0, seg::LEFT | seg::RIGHT, &style(), GlyphSet::Unicode);
        }
        fixup_border_adjacency(&mut s, 0, 0, 5, 1, GlyphSet::Unicode);
        for x in 0..5 {
            assert_eq!(s.cell(x, 0).unwrap().symbol, "─", "x={x}");
        }
    }

    #[test]
    fn ascii_glyph_set() {
        assert_eq!(glyph_for(seg::LEFT | seg::RIGHT, GlyphSet::Ascii), "-");
        assert_eq!(glyph_for(seg::UP | seg::DOWN, GlyphSet::Ascii), "|");
        assert_eq!(glyph_for(15, GlyphSet::Ascii), "+");
    }
}
