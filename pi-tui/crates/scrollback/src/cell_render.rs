//! `paint_node` — recursive blitz-dom → cell-surface painter.
//!
//! Rebuild of the original `cell_render.rs` (RECON §3). Walks the DOM
//! in paint order (`paint_children` + hoisted stacking-context lists),
//! resolves each node's `CellStyle` against its inherited parent style,
//! converts taffy `final_layout` to absolute cell rects (subtracting
//! ancestor `scroll_offset`s), and paints backgrounds, borders, `<hr>`
//! rules and parley inline text into the [`Surface`].
//!
//! Coordinate model (verified against blitz-dom `Node::hit_inner` and
//! taffy 0.14 `round_layout`): `final_layout().location` is relative to
//! the parent's *border box* in the parent's unscrolled content space,
//! so `abs(node) = Σ ancestors (location − scroll_offset)`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use blitz_dom::node::Marker;
use blitz_dom::{BaseDocument, Node, NodeData, NodeId, local_name};
use parley::layout::PositionedLayoutItem;
use style::color::{AbsoluteColor, ColorSpace};
use style::properties::ComputedValues;
use style::properties::generated::longhands::visibility::computed_value::T as StyloVisibility;
use style::values::computed::{BorderStyle, Overflow};
use style::values::specified::TextDecorationLine;

use crate::border::{self, BorderEdges, GlyphSet};
use crate::cell::{Color, Modifier};
use crate::style::CellStyle;
use crate::surface::Surface;

/// A cell-space rectangle (i32 so partially off-screen rects work).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rect {
    /// Left column.
    pub x: i32,
    /// Top row.
    pub y: i32,
    /// Width in cells.
    pub w: i32,
    /// Height in cells.
    pub h: i32,
}

impl Rect {
    /// `x,y,w,h` constructor.
    pub const fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Rect { x, y, w, h }
    }

    /// Intersection (may be empty).
    pub fn intersect(&self, other: &Rect) -> Rect {
        let x0 = self.x.max(other.x);
        let y0 = self.y.max(other.y);
        let x1 = (self.x + self.w).min(other.x + other.w);
        let y1 = (self.y + self.h).min(other.y + other.h);
        Rect::new(x0, y0, (x1 - x0).max(0), (y1 - y0).max(0))
    }

    /// True when the rect has positive area.
    pub fn is_non_empty(&self) -> bool {
        self.w > 0 && self.h > 0
    }
}

/// A clickable region recorded during painting (`data-hit-*` attribute
/// or `<a href>` link text).
#[derive(Clone, Debug, PartialEq)]
pub struct HitRegion {
    /// Cell rect the region covers.
    pub rect: Rect,
    /// `data-hit-*` suffix (e.g. `data-hit-accept` → `"accept"`), or
    /// `"link"` for `<a href>` regions.
    pub kind: String,
    /// Optional payload: the attribute value, or the link target.
    pub payload: Option<String>,
    /// The DOM node that declared the region.
    pub node: NodeId,
}

/// A truncatable region (`data-truncatable-*` attribute): marks content
/// that may be elided when it doesn't fit.
#[derive(Clone, Debug, PartialEq)]
pub struct TruncRegion {
    /// Cell rect the region covers.
    pub rect: Rect,
    /// `data-truncatable-*` suffix.
    pub kind: String,
    /// Optional attribute value.
    pub payload: Option<String>,
    /// The DOM node that declared the region.
    pub node: NodeId,
}

/// Painter state for one frame.
pub struct PaintContext<'a> {
    /// The document being painted.
    pub doc: &'a BaseDocument,
    /// The cell surface being painted into.
    pub surface: &'a mut Surface,
    /// Hit regions accumulated this frame.
    pub hit_regions: Vec<HitRegion>,
    /// Truncatable regions accumulated this frame.
    pub trunc_regions: Vec<TruncRegion>,
    /// Border glyph table.
    pub glyph_set: GlyphSet,
    /// CSS px per cell (chisel-ui uses 1px = 1 cell).
    pub scale: f32,
    /// Absolute-position overrides for hoisted (stacking-context)
    /// children, keyed by node id — their DOM parent chain does not
    /// reflect their paint position.
    abs_override: HashMap<NodeId, (f32, f32)>,
    /// Reentrancy guard (RECON `+0x4c0` paint counter).
    active: HashSet<NodeId>,
}

impl<'a> PaintContext<'a> {
    /// New context painting `doc` into `surface`.
    pub fn new(doc: &'a BaseDocument, surface: &'a mut Surface) -> Self {
        PaintContext {
            doc,
            surface,
            hit_regions: Vec::new(),
            trunc_regions: Vec::new(),
            glyph_set: GlyphSet::Unicode,
            scale: 1.0,
            abs_override: HashMap::new(),
            active: HashSet::new(),
        }
    }

    /// The full-surface clip rect.
    pub fn full_clip(&self) -> Rect {
        Rect::new(0, 0, self.surface.width as i32, self.surface.height as i32)
    }
}

/// Paint the whole document: entry point equivalent to the original's
/// `render_cells`. Returns the painted root rect.
pub fn paint_document(ctx: &mut PaintContext) -> Option<Rect> {
    let root = ctx.doc.root_node().id;
    let clip = ctx.full_clip();
    paint_node(ctx, root, clip, &CellStyle::INHERIT)
}

/// Paint one node (and its subtree) into the surface.
///
/// * `clip` — cell rect outside which nothing is drawn.
/// * `inherited` — the parent's already-merged `CellStyle`.
///
/// Returns the node's border-box rect (pre-clip), or `None` when the
/// node paints nothing (text/comment nodes, `display:none`, reentrant
/// cycles).
pub fn paint_node(
    ctx: &mut PaintContext,
    node_id: NodeId,
    clip: Rect,
    inherited: &CellStyle,
) -> Option<Rect> {
    // Reentrancy guard: a node already on the paint stack is skipped.
    if !ctx.active.insert(node_id) {
        return None;
    }
    let result = paint_node_inner(ctx, node_id, clip, inherited);
    ctx.active.remove(&node_id);
    result
}

fn paint_node_inner(
    ctx: &mut PaintContext,
    node_id: NodeId,
    clip: Rect,
    inherited: &CellStyle,
) -> Option<Rect> {
    let node = ctx.doc.get_node(node_id)?;

    match &node.data {
        // Containers: just recurse into children.
        NodeData::Document(_) => {
            paint_children(ctx, node, clip, inherited);
            return None;
        }
        // Text/comment nodes have no box of their own — their glyphs are
        // painted by the inline root's `inline_layout_data`.
        NodeData::Text(_) | NodeData::Comment { .. } => return None,
        NodeData::Element(_) | NodeData::AnonymousBlock(_) => {}
    }

    // `display:none` early-out (taffy style is the layout truth).
    if matches!(node.style().display, taffy::Display::None) {
        return None;
    }

    // `visibility` other than visible hides the subtree (blitz-paint
    // parity — descendants can't re-show themselves in a cell world).
    let styles = node.primary_styles();
    if let Some(styles) = styles.as_ref() {
        if styles.get_inherited_box().visibility != StyloVisibility::Visible {
            return None;
        }
    }

    // Merge this node's resolved style over the inherited one.
    let own = resolve_cell_style(node);
    let merged = own.merge_inherited(inherited);

    // Absolute cell rect: Σ ancestors (location − scroll_offset).
    let (ax, ay) = abs_position(ctx, node);
    let layout = node.final_layout();
    let w = (layout.size.width / ctx.scale).round() as i32;
    let h = (layout.size.height / ctx.scale).round() as i32;
    let rect = Rect::new(ax, ay, w, h);
    let visible = rect.intersect(&clip);

    // Record data-hit-* / data-truncatable-* regions (visible part).
    record_regions(ctx, node, visible);

    // Background fill: explicit bg, or positioned boxes clear their
    // rect (position:absolute|fixed paint over what is below).
    let positioned = styles
        .as_ref()
        .map(|s| s.clone_position())
        .is_some_and(|p| p.is_absolutely_positioned());
    if (!merged.bg.is_reset() || positioned) && visible.is_non_empty() {
        ctx.surface
            .fill(visible.x, visible.y, visible.w, visible.h, " ", &merged);
    }

    // Borders (outer ring of the border box).
    paint_node_borders(ctx, node, &rect, &merged);

    // Content: <hr> rule, list marker, or inline text.
    let tag = node
        .element_data()
        .map(|e| e.name.local.to_string())
        .unwrap_or_default();
    if tag == "hr" {
        paint_hr(ctx, &rect, &merged);
    } else {
        paint_inline_layout(ctx, node, &rect, clip, &merged);
        paint_list_marker(ctx, node, &rect, &merged);
    }

    // Child clip: overflow other than visible tightens to the padding
    // box (border box minus border widths).
    let child_clip = if clips_overflow(styles.as_ref().map(|s| &***s)) {
        let b = &layout.border;
        let padding_box = Rect::new(
            ax + (b.left / ctx.scale).round() as i32,
            ay + (b.top / ctx.scale).round() as i32,
            (w - ((b.left + b.right) / ctx.scale).round() as i32).max(0),
            (h - ((b.top + b.bottom) / ctx.scale).round() as i32).max(0),
        );
        clip.intersect(&padding_box)
    } else {
        clip
    };

    paint_children(ctx, node, child_clip, &merged);

    Some(rect)
}

/// Paint children in CSS paint order: negative-z hoisted, then
/// `paint_children` (z-sorted), then positive-z hoisted.
fn paint_children(ctx: &mut PaintContext, node: &Node, clip: Rect, inherited: &CellStyle) {
    let node_abs = abs_position(ctx, node);

    // Negative z-index hoisted children paint first.
    if let Some(sc) = &node.stacking_context {
        for child in sc.neg_z_hoisted_children() {
            ctx.abs_override.insert(
                child.node_id,
                (node_abs.0 as f32 + child.position.x, node_abs.1 as f32 + child.position.y),
            );
            paint_node(ctx, child.node_id, clip, inherited);
            ctx.abs_override.remove(&child.node_id);
        }
    }

    // Regular children (paint_children is z-sorted; fall back to DOM
    // order when the paint list wasn't built).
    let paint_list = node.paint_children.borrow();
    if let Some(children) = paint_list.as_ref() {
        for &child_id in children.iter() {
            paint_node(ctx, child_id, clip, inherited);
        }
    } else {
        for &child_id in node.children.iter() {
            paint_node(ctx, child_id, clip, inherited);
        }
    }
    drop(paint_list);

    // Positive z-index hoisted children paint last.
    if let Some(sc) = &node.stacking_context {
        for child in sc.pos_z_hoisted_children() {
            ctx.abs_override.insert(
                child.node_id,
                (node_abs.0 as f32 + child.position.x, node_abs.1 as f32 + child.position.y),
            );
            paint_node(ctx, child.node_id, clip, inherited);
            ctx.abs_override.remove(&child.node_id);
        }
    }
}

/// Absolute cell position of `node`: sum `location − scroll_offset`
/// over the ancestor chain (hoisted nodes use their override).
fn abs_position(ctx: &PaintContext, node: &Node) -> (i32, i32) {
    if let Some(&(x, y)) = ctx.abs_override.get(&node.id) {
        return (
            (x / ctx.scale).round() as i32,
            (y / ctx.scale).round() as i32,
        );
    }
    let mut x = node.final_layout().location.x;
    let mut y = node.final_layout().location.y;
    let mut cur = node.parent;
    while let Some(pid) = cur {
        let Some(p) = ctx.doc.get_node(pid) else { break };
        if let Some(&(ox, oy)) = ctx.abs_override.get(&pid) {
            x += ox;
            y += oy;
            break;
        }
        x += p.final_layout().location.x - p.scroll_offset().x as f32;
        y += p.final_layout().location.y - p.scroll_offset().y as f32;
        cur = p.parent;
    }
    (
        (x / ctx.scale).round() as i32,
        (y / ctx.scale).round() as i32,
    )
}

/// Resolve a node's stylo `ComputedValues` into a `CellStyle`.
///
/// Nodes without styles (or without stylo data) return
/// [`CellStyle::INHERIT`]. `transparent` colors resolve to
/// `Color::Reset` (inherit), matching chisel-ui's
/// `color:transparent` → terminal-native-fg convention.
fn resolve_cell_style(node: &Node) -> CellStyle {
    let Some(styles) = node.primary_styles() else {
        return CellStyle::INHERIT;
    };
    cell_style_from_computed(&styles)
}

/// Build a `CellStyle` from stylo computed values.
fn cell_style_from_computed(styles: &ComputedValues) -> CellStyle {
    let current_color = styles.clone_color();
    let fg = absolute_to_cell(&current_color);
    let bg = absolute_to_cell(
        &styles
            .get_background()
            .background_color
            .resolve_to_absolute(&current_color),
    );

    let mut modifier = Modifier::empty();
    if styles.get_font().font_weight.value() >= 600.0 {
        modifier |= Modifier::BOLD;
    }
    if styles.get_font().font_style != style::values::computed::FontStyle::NORMAL {
        modifier |= Modifier::ITALIC;
    }
    let deco = styles.get_text().text_decoration_line;
    if deco.contains(TextDecorationLine::UNDERLINE) {
        modifier |= Modifier::UNDERLINE;
    }
    if deco.contains(TextDecorationLine::LINE_THROUGH) {
        modifier |= Modifier::STRIKE;
    }
    if deco.contains(TextDecorationLine::BLINK) {
        modifier |= Modifier::BLINK;
    }

    let underline = styles
        .get_text()
        .text_decoration_color
        .as_absolute()
        .map(absolute_to_cell)
        .unwrap_or(Color::Reset);

    CellStyle {
        fg,
        bg,
        underline,
        modifier,
    }
}

/// Convert a stylo `AbsoluteColor` to a cell `Color`.
///
/// `alpha == 0` (CSS `transparent`) maps to `Color::Reset` = inherit.
/// Non-sRGB spaces are converted; components are normalized floats.
fn absolute_to_cell(c: &AbsoluteColor) -> Color {
    if c.alpha <= 0.0 {
        return Color::Reset;
    }
    let srgb = c.to_color_space(ColorSpace::Srgb);
    let [r, g, b, _a] = *srgb.raw_components();
    let to_u8 = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    Color::Rgb(to_u8(r), to_u8(g), to_u8(b))
}

/// True when the node's overflow clips its content (anything but
/// `visible` on either axis).
fn clips_overflow(styles: Option<&ComputedValues>) -> bool {
    let Some(styles) = styles else { return false };
    let b = styles.get_box();
    !matches!(b.overflow_x, Overflow::Visible) || !matches!(b.overflow_y, Overflow::Visible)
}

/// Record `data-hit-*` / `data-truncatable-*` attribute regions.
fn record_regions(ctx: &mut PaintContext, node: &Node, visible: Rect) {
    let Some(attrs) = node.data.attrs() else { return };
    for attr in attrs {
        let name: &str = &attr.name.local;
        if let Some(kind) = name.strip_prefix("data-hit-") {
            ctx.hit_regions.push(HitRegion {
                rect: visible,
                kind: kind.to_string(),
                payload: non_empty(&attr.value),
                node: node.id,
            });
        } else if let Some(kind) = name.strip_prefix("data-truncatable-") {
            ctx.trunc_regions.push(TruncRegion {
                rect: visible,
                kind: kind.to_string(),
                payload: non_empty(&attr.value),
                node: node.id,
            });
        }
    }
}

fn non_empty(s: &str) -> Option<String> {
    if s.is_empty() { None } else { Some(s.to_string()) }
}

/// Paint the node's border edges (outer ring of the border box).
fn paint_node_borders(ctx: &mut PaintContext, node: &Node, rect: &Rect, merged: &CellStyle) {
    let Some(styles) = node.primary_styles() else {
        return;
    };
    let border = styles.get_border();
    let layout = node.final_layout();
    let current_color = styles.clone_color();

    let edge = |width_px: f32, style: BorderStyle| -> bool {
        width_px >= 0.5 && !style.none_or_hidden()
    };
    let edges = BorderEdges {
        top: edge(layout.border.top, border.border_top_style),
        bottom: edge(layout.border.bottom, border.border_bottom_style),
        left: edge(layout.border.left, border.border_left_style),
        right: edge(layout.border.right, border.border_right_style),
    };
    if !edges.any() {
        return;
    }

    // Per-side colors resolved against currentColor; fall back to the
    // merged style's fg when the side color is transparent.
    let side_style = |color: &style::values::computed::Color| -> CellStyle {
        let c = absolute_to_cell(&color.resolve_to_absolute(&current_color));
        CellStyle {
            fg: if c.is_reset() { merged.fg } else { c },
            bg: merged.bg,
            underline: merged.underline,
            modifier: merged.modifier,
        }
    };

    let set = ctx.glyph_set;
    let (x, y, w, h) = (rect.x, rect.y, rect.w, rect.h);
    if w <= 0 || h <= 0 {
        return;
    }
    let (x1, y1) = (x + w - 1, y + h - 1);

    // Paint each edge with its own color, then fix up junctions.
    if edges.top {
        let st = side_style(&border.border_top_color);
        for cx in x..=x1 {
            let mut m = border::seg::LEFT | border::seg::RIGHT;
            if cx == x && edges.left {
                m |= border::seg::DOWN;
            }
            if cx == x1 && edges.right {
                m |= border::seg::DOWN;
            }
            border::paint_border_cell(ctx.surface, cx, y, m, &st, set);
        }
    }
    if edges.bottom {
        let st = side_style(&border.border_bottom_color);
        for cx in x..=x1 {
            let mut m = border::seg::LEFT | border::seg::RIGHT;
            if cx == x && edges.left {
                m |= border::seg::UP;
            }
            if cx == x1 && edges.right {
                m |= border::seg::UP;
            }
            border::paint_border_cell(ctx.surface, cx, y1, m, &st, set);
        }
    }
    if edges.left {
        let st = side_style(&border.border_left_color);
        for cy in y..=y1 {
            let mut m = border::seg::UP | border::seg::DOWN;
            if cy == y && edges.top {
                m |= border::seg::RIGHT;
            }
            if cy == y1 && edges.bottom {
                m |= border::seg::RIGHT;
            }
            border::paint_border_cell(ctx.surface, x, cy, m, &st, set);
        }
    }
    if edges.right {
        let st = side_style(&border.border_right_color);
        for cy in y..=y1 {
            let mut m = border::seg::UP | border::seg::DOWN;
            if cy == y && edges.top {
                m |= border::seg::LEFT;
            }
            if cy == y1 && edges.bottom {
                m |= border::seg::LEFT;
            }
            border::paint_border_cell(ctx.surface, x1, cy, m, &st, set);
        }
    }

    // Adjacency fixup over the border ring plus one cell around it.
    border::fixup_border_adjacency(ctx.surface, x - 1, y - 1, w + 2, h + 2, set);
}

/// `<hr>` → a `─` run across the content box, welded into any
/// neighbouring borders by the segment machinery.
fn paint_hr(ctx: &mut PaintContext, rect: &Rect, merged: &CellStyle) {
    if rect.w <= 0 || rect.h <= 0 {
        return;
    }
    let set = ctx.glyph_set;
    let cy = rect.y + rect.h / 2;
    for cx in rect.x..rect.x + rect.w {
        border::paint_border_cell(
            ctx.surface,
            cx,
            cy,
            border::seg::LEFT | border::seg::RIGHT,
            merged,
            set,
        );
    }
    border::fixup_border_adjacency(ctx.surface, rect.x - 1, cy - 1, rect.w + 2, 3, set);
}

/// Paint the inline text layout owned by this node (inline roots only).
fn paint_inline_layout(
    ctx: &mut PaintContext,
    node: &Node,
    rect: &Rect,
    clip: Rect,
    merged: &CellStyle,
) {
    if !node.flags.is_inline_root() {
        return;
    }
    let Some(ed) = node.element_data() else { return };
    let Some(tl) = &ed.inline_layout_data else { return };

    // Text starts at the content box (border box + border + padding)
    // and is bounded on the right by the content-box edge.
    let layout = node.final_layout();
    let content_x = rect.x + ((layout.border.left + layout.padding.left) / ctx.scale).round() as i32;
    let content_y = rect.y + ((layout.border.top + layout.padding.top) / ctx.scale).round() as i32;
    let content_right =
        rect.x + rect.w - ((layout.border.right + layout.padding.right) / ctx.scale).round() as i32;

    for line in tl.layout.lines() {
        let line_y = content_y + (line.metrics().block_min_coord / ctx.scale).round() as i32;
        if line_y < clip.y || line_y >= clip.y + clip.h {
            continue;
        }
        // `line.items()` splits each Run into GlyphRuns at style boundaries;
        // every GlyphRun of one Run reports the *run's* full text/cluster
        // range, so slicing text by it double-paints. Mirror the iterator's
        // `glyph_start` bookkeeping: a per-run glyph cursor locates which
        // clusters (and thus which text range) this GlyphRun covers.
        let mut glyph_cursor = 0usize;
        let mut last_run_index = usize::MAX;
        for item in line.items() {
            let PositionedLayoutItem::GlyphRun(gr) = item else {
                glyph_cursor = 0;
                last_run_index = usize::MAX;
                continue;
            };
            let run = gr.run();
            if run.index() != last_run_index {
                glyph_cursor = 0;
                last_run_index = run.index();
            }
            let n_glyphs = gr.glyphs().count();
            let g_start = glyph_cursor;
            glyph_cursor += n_glyphs;
            let g_end = g_start + n_glyphs;

            // Union the text ranges of clusters intersecting [g_start, g_end).
            let mut g = 0usize;
            let mut range: Option<std::ops::Range<usize>> = None;
            for c in run.visual_clusters() {
                let c_end = g + c.glyphs().count();
                if c_end > g_start && g < g_end {
                    let r = c.text_range();
                    range = Some(match range {
                        None => r,
                        Some(a) => a.start.min(r.start)..a.end.max(r.end),
                    });
                }
                g = c_end;
            }
            let Some(range) = range else { continue };
            let Some(text) = tl.text.get(range.clone()) else {
                continue;
            };
            if text.is_empty() {
                continue;
            }

            // Style of the span that owns this run (TextBrush.id → node).
            let brush_id: NodeId = gr.style().brush.id;
            let span_style = resolve_text_style(ctx.doc, brush_id).merge_inherited(merged);
            let link = find_link(ctx.doc, brush_id);

            // Record <a href> link regions as hit regions.
            if link.is_some() {
                let run_x = content_x + (gr.offset() / ctx.scale).round() as i32;
                let run_w = (gr.advance() / ctx.scale).round() as i32;
                ctx.hit_regions.push(HitRegion {
                    rect: Rect::new(run_x, line_y, run_w.max(1), 1).intersect(&clip),
                    kind: "link".to_string(),
                    payload: link.as_ref().map(|l| l.to_string()),
                    node: brush_id,
                });
            }

            let x = content_x + (gr.offset() / ctx.scale).round() as i32;
            let avail = (clip.x + clip.w - x).min(content_right - x);
            if avail <= 0 {
                continue;
            }
            ctx.surface
                .draw_str(x, line_y, text, avail, &span_style, link.as_ref());
        }
    }
}

/// Resolve the `CellStyle` for a text run's owning node, walking up to
/// the nearest styled ancestor when the node itself carries no styles
/// (text nodes never do).
fn resolve_text_style(doc: &BaseDocument, mut id: NodeId) -> CellStyle {
    loop {
        let Some(node) = doc.get_node(id) else {
            return CellStyle::INHERIT;
        };
        if let Some(styles) = node.primary_styles() {
            return cell_style_from_computed(&styles);
        }
        match node.parent {
            Some(p) => id = p,
            None => return CellStyle::INHERIT,
        }
    }
}

/// Walk ancestors of `id` looking for `<a href>`; returns the link
/// target for OSC 8 / hit regions.
fn find_link(doc: &BaseDocument, mut id: NodeId) -> Option<Arc<str>> {
    loop {
        let node = doc.get_node(id)?;
        if let Some(ed) = node.element_data() {
            if ed.is_link() {
                if let Some(href) = ed.attr(local_name!("href")) {
                    return Some(Arc::from(href));
                }
            }
        }
        id = node.parent?;
    }
}

/// `list-style` marker (`• `) for `display:list-item` nodes.
fn paint_list_marker(ctx: &mut PaintContext, node: &Node, rect: &Rect, merged: &CellStyle) {
    let Some(ed) = node.element_data() else { return };
    let Some(item) = &ed.list_item_data else { return };
    let text = match &item.marker {
        Marker::Char(c) => {
            let mut s = String::with_capacity(4);
            s.push(*c);
            s
        }
        Marker::String(s) => s.clone(),
    };
    if text.is_empty() {
        return;
    }
    // Markers paint just left of the content box (outside position).
    let layout = node.final_layout();
    let content_x =
        rect.x + ((layout.border.left + layout.padding.left) / ctx.scale).round() as i32;
    let w = unicode_width::UnicodeWidthStr::width(text.as_str()) as i32;
    ctx.surface
        .draw_str(content_x - w, rect.y, &text, w, merged, None);
}
