//! `Renderer` — double-buffered frame driver.
//!
//! RECON §7: keeps the previous frame, decides full vs incremental
//! redraw (no prev frame / size change / pending lines → full), runs
//! the cell diff, and emits ANSI. `SharedCell` holds the terminal
//! capability [`Level`] published once at setup.

use std::sync::{Arc, OnceLock};

use crate::ansi::{self, Level};
use crate::surface::Surface;

/// One painted frame: the surface plus its dimensions.
#[derive(Clone)]
pub struct Frame {
    /// The painted cells.
    pub surface: Surface,
}

impl Frame {
    /// Wrap a surface as a frame.
    pub fn new(surface: Surface) -> Self {
        Frame { surface }
    }

    /// Frame width in cells.
    pub fn width(&self) -> u16 {
        self.surface.width
    }

    /// Frame height in cells.
    pub fn height(&self) -> u16 {
        self.surface.height
    }
}

/// A line of raw text committed to terminal scrollback before the next
/// frame is drawn (the original's `pending` line buffer — lines whose
/// tag is not "clean" are flushed verbatim ahead of the diff).
#[derive(Clone, Debug)]
pub struct PendingLine {
    /// The line's cells.
    pub cells: Vec<crate::cell::Cell>,
}

/// Process-shared terminal capability cell.
///
/// The original stores `Arc<OnceCell<Result<u8>>>` behind a global; the
/// level byte is `(0x102020000 >> (tier*8)) as u8`. Here it's a plain
/// `Arc<OnceLock<Level>>` — set once at terminal setup, read per draw.
#[derive(Clone, Default)]
pub struct SharedCell {
    inner: Arc<OnceLock<Level>>,
}

impl SharedCell {
    /// New unset cell.
    pub fn new() -> Self {
        Self::default()
    }

    /// Publish the level (first write wins).
    pub fn set(&self, level: Level) -> Result<(), Level> {
        self.inner.set(level)
    }

    /// Publish a detected tier (0–4) using the original's byte mapping.
    pub fn set_tier(&self, tier: u8) -> Result<(), Level> {
        self.set(Level::from_tier(tier))
    }

    /// The published level (defaults to truecolor when unset).
    pub fn get(&self) -> Level {
        self.inner.get().copied().unwrap_or_default()
    }
}

/// Double-buffered ANSI renderer.
///
/// Usage: paint a [`Surface`] each frame (via
/// [`crate::cell_render::paint_document`]), wrap it in a [`Frame`], and
/// call [`Renderer::draw`] to get the ANSI byte stream.
pub struct Renderer {
    /// The previously drawn frame (double buffer).
    pub prev_frame: Option<Frame>,
    /// Pending scrollback lines flushed verbatim on the next draw.
    pub pending: Vec<PendingLine>,
    /// Terminal capability level.
    pub level: SharedCell,
    /// Force a full redraw on the next draw.
    pub needs_full_redraw: bool,
    /// The surface of the frame replaced by the last `draw` — callers
    /// may reclaim it as a scratch buffer (double-buffer reuse).
    pub spare_surface: Option<Surface>,
}

impl Default for Renderer {
    fn default() -> Self {
        Self::new()
    }
}

impl Renderer {
    /// New renderer with no previous frame.
    pub fn new() -> Self {
        Renderer {
            prev_frame: None,
            pending: Vec::new(),
            level: SharedCell::new(),
            needs_full_redraw: false,
            spare_surface: None,
        }
    }

    /// Queue a line to be committed to scrollback verbatim before the
    /// next frame (forces a full redraw of the frame area).
    pub fn push_pending(&mut self, line: PendingLine) {
        self.pending.push(line);
    }

    /// True when the next draw must be full: no previous frame, a size
    /// change, pending scrollback lines, or an explicit request.
    pub fn needs_full_draw(&self, frame: &Frame) -> bool {
        self.needs_full_redraw
            || !self.pending.is_empty()
            || self
                .prev_frame
                .as_ref()
                .is_none_or(|p| p.width() != frame.width() || p.height() != frame.height())
    }

    /// Draw `frame`, returning the ANSI stream.
    ///
    /// Full redraws flush pending lines, erase the display, and emit
    /// every cell; incremental draws emit only the diff. Either way the
    /// frame becomes the new `prev_frame`.
    pub fn draw(&mut self, frame: Frame) -> String {
        let level = self.level.get();
        let mut out = String::new();

        let full = self.needs_full_draw(&frame);
        if full {
            // Flush pending scrollback lines verbatim.
            for line in self.pending.drain(..) {
                emit_pending_line(&mut out, &line, level);
            }
            ansi::erase_display(&mut out, 2);
            ansi::cursor_home(&mut out);
            crate::diff::emit_full(&mut out, &frame.surface, level);
        } else {
            let prev = self.prev_frame.as_ref().map(|f| &f.surface);
            crate::diff::emit_ansi(&mut out, prev, &frame.surface, level);
        }

        self.needs_full_redraw = false;
        // Reclaim the replaced frame's surface for reuse.
        if let Some(old) = self.prev_frame.replace(frame) {
            self.spare_surface = Some(old.surface);
        }
        out
    }
}

/// Emit one pending scrollback line: cells with their styles, then a
/// newline.
fn emit_pending_line(out: &mut String, line: &PendingLine, level: Level) {
    let mut style: Option<crate::style::CellStyle> = None;
    for cell in &line.cells {
        let cs = crate::style::CellStyle {
            fg: cell.fg,
            bg: cell.bg,
            underline: cell.underline,
            modifier: cell.modifier,
        };
        if style != Some(cs) {
            match style {
                Some(from) => ansi::emit_sgr_delta(out, &from, &cs, level),
                None => ansi::emit_sgr(out, &cs, level),
            }
            style = Some(cs);
        }
        let sym = cell.symbol.as_str();
        out.push_str(if sym.is_empty() { " " } else { sym });
    }
    ansi::sgr_reset(out);
    out.push_str("\r\n");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cell::{Cell, Color};

    #[test]
    fn first_draw_is_full() {
        let mut r = Renderer::new();
        let mut s = Surface::new(4, 1);
        s.draw_str(
            0,
            0,
            "hi",
            4,
            &crate::style::CellStyle::DEFAULT,
            None,
        );
        let out = r.draw(Frame::new(s));
        assert!(out.contains("\x1b[2J"), "full redraw erases: {out:?}");
        assert!(out.contains("hi"), "out: {out:?}");
    }

    #[test]
    fn second_draw_is_incremental() {
        let mut r = Renderer::new();
        let mut s = Surface::new(4, 1);
        s.draw_str(0, 0, "hi", 4, &crate::style::CellStyle::DEFAULT, None);
        r.draw(Frame::new(s.clone()));
        // Change one cell.
        s.set(
            0,
            0,
            Cell {
                symbol: "H".into(),
                fg: Color::Ansi(1),
                ..Cell::EMPTY
            },
        );
        let out = r.draw(Frame::new(s));
        assert!(!out.contains("\x1b[2J"), "incremental: {out:?}");
        assert!(out.contains("H"), "out: {out:?}");
        assert!(!out.contains("hi"), "unchanged cells not re-emitted: {out:?}");
    }

    #[test]
    fn pending_forces_full() {
        let mut r = Renderer::new();
        let s = Surface::new(4, 1);
        r.draw(Frame::new(s.clone()));
        r.push_pending(PendingLine {
            cells: vec![Cell {
                symbol: "x".into(),
                ..Cell::EMPTY
            }],
        });
        let out = r.draw(Frame::new(s));
        // Pending line is flushed verbatim before the erase: symbol, then
        // an SGR reset, then CRLF.
        assert!(out.contains("x\x1b[0m\r\n"), "pending line flushed: {out:?}");
        assert!(out.contains("\x1b[2J"), "pending forces full: {out:?}");
    }

    #[test]
    fn shared_cell_level() {
        let sc = SharedCell::new();
        assert_eq!(sc.get(), Level::TRUECOLOR); // default
        sc.set_tier(1).unwrap();
        assert_eq!(sc.get(), Level::ANSI256);
        assert!(sc.set(Level::NONE).is_err()); // first write wins
    }
}
