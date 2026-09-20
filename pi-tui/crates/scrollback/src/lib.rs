//! scrollback — blitz-dom `Document` → cell surface → ANSI renderer.
//!
//! Rebuild of the private `scrollback` crate (see
//! `devin-re/SCROLLBACK-RECON.md`). Renderer-agnostic: it turns a
//! laid-out blitz-dom tree into a [`Surface`] of [`Cell`]s, diffs
//! successive frames, and emits ANSI escape streams. The embedding
//! application owns the terminal, the event loop, and DOM construction.
//!
//! Pipeline:
//! ```text
//! BaseDocument (resolved) ──paint_document──▶ Surface ──diff──▶ ANSI String
//! ```

pub mod ansi;
pub mod border;
pub mod cell;
pub mod cell_render;
pub mod diff;
pub mod renderer;
pub mod style;
pub mod surface;

pub use cell::{Cell, Color, Modifier, Symbol, INLINE_CAP};
pub use cell_render::{
    HitRegion, PaintContext, Rect, TruncRegion, paint_document, paint_node,
};
pub use border::{BorderEdges, GlyphSet};
pub use ansi::Level;
pub use diff::{Span, diff_spans, emit_ansi, emit_full};
pub use renderer::{Frame, PendingLine, Renderer, SharedCell};
pub use style::{CellStyle, INHERIT_MODIFIER};
pub use surface::{PUA_MARKER, PuaMarker, Surface};
