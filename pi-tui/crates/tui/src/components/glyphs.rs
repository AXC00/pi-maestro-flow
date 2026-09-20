//! `glyphs` — unicode/ASCII dual glyph inventory (RECON §9 "Glyph 库存").
//!
//! The original keeps a global glyph-mode byte selecting between a unicode
//! and an ASCII glyph table. We mirror that with [`GlyphMode`]: `Unicode`
//! (default) or `Ascii` (`PI_TUI_ASCII=1` / `NO_COLOR`-style fallbacks for
//! terminals without braille/box glyphs).

/// Which glyph table is active.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum GlyphMode {
    /// Full unicode glyphs (braille, box-drawing, arrows).
    #[default]
    Unicode,
    /// ASCII fallbacks for limited terminals.
    Ascii,
}

impl GlyphMode {
    /// Detect from the environment: `PI_TUI_ASCII=1` forces ASCII;
    /// `PI_TUI_GLYPHS=ascii|unicode` is the explicit override.
    pub fn detect() -> Self {
        match std::env::var("PI_TUI_GLYPHS").ok().as_deref() {
            Some("ascii") => return Self::Ascii,
            Some("unicode") => return Self::Unicode,
            _ => {}
        }
        match std::env::var("PI_TUI_ASCII").ok().as_deref() {
            Some("1") | Some("true") | Some("yes") => Self::Ascii,
            _ => Self::Unicode,
        }
    }

    /// Pick the glyph for this mode: `g(self, "·", "-")`.
    pub fn g(self, uni: &'static str, ascii: &'static str) -> &'static str {
        match self {
            Self::Unicode => uni,
            Self::Ascii => ascii,
        }
    }

    // --- named glyphs (RECON §9 inventory) ---

    /// `·` / `-` — separator dot.
    pub fn dot(self) -> &'static str {
        self.g("·", "-")
    }
    /// `›` / `>` — cursor / prompt chevron.
    pub fn chevron(self) -> &'static str {
        self.g("›", ">")
    }
    /// `▾` / `v` — dropdown caret.
    pub fn caret_down(self) -> &'static str {
        self.g("▾", "v")
    }
    /// `↑` / `^` — scroll up marker.
    pub fn arrow_up(self) -> &'static str {
        self.g("↑", "^")
    }
    /// `↓` / `v` — scroll down marker.
    pub fn arrow_down(self) -> &'static str {
        self.g("↓", "v")
    }
    /// `←` / `<`.
    pub fn arrow_left(self) -> &'static str {
        self.g("←", "<")
    }
    /// `→` / `>`.
    pub fn arrow_right(self) -> &'static str {
        self.g("→", ">")
    }
    /// `✓` / `[OK]` — tool success.
    pub fn ok(self) -> &'static str {
        self.g("✓", "[OK]")
    }
    /// `✗` / `[X]` — tool failure.
    pub fn err(self) -> &'static str {
        self.g("✗", "[X]")
    }
    /// `◔` / `[~]` — partial / cancelled.
    pub fn partial(self) -> &'static str {
        self.g("◔", "[~]")
    }
    /// `●` / `o` — running (filled).
    pub fn running(self) -> &'static str {
        self.g("●", "o")
    }
    /// `○` / `o` — pending (hollow).
    pub fn pending(self) -> &'static str {
        self.g("○", "o")
    }
    /// `◆` / `*` — filled diamond (tool default).
    pub fn diamond(self) -> &'static str {
        self.g("◆", "*")
    }
    /// `◇` / `+` — hollow diamond.
    pub fn diamond_open(self) -> &'static str {
        self.g("◇", "+")
    }
    /// `⋮` / `...` — vertical ellipsis (overflow menu).
    pub fn vellipsis(self) -> &'static str {
        self.g("⋮", "...")
    }
    /// `…` / `...` — ellipsis.
    pub fn ellipsis(self) -> &'static str {
        self.g("…", "...")
    }
    /// `▄` / `#` — lower half block (diff emphasis / progress).
    pub fn block_low(self) -> &'static str {
        self.g("▄", "#")
    }
    /// `✱` / `*` — heavy asterisk.
    pub fn asterisk(self) -> &'static str {
        self.g("✱", "*")
    }

    /// The 16-frame braille spinner (RECON §9 verbatim order).
    /// ASCII mode falls back to a 4-frame `-\|/` cycle.
    pub fn spinner_frame(self, tick: u64) -> &'static str {
        const BRAILLE: [&str; 16] = [
            "⠜", "⢣", "⡎", "⢱", "⢎", "⡱", "⢇", "⡸", "⢣", "⡜", "⡣", "⢜", "⡱", "⢎", "⡕", "⢪",
        ];
        const ASCII: [&str; 4] = ["-", "\\", "|", "/"];
        match self {
            Self::Unicode => BRAILLE[(tick as usize) % 16],
            Self::Ascii => ASCII[(tick as usize) % 4],
        }
    }
}

/// Map a stored tool-status char (`state::Message::tool_status`) to the
/// mode-appropriate display glyph.
pub fn status_glyph(mode: GlyphMode, status: Option<char>) -> &'static str {
    match status {
        Some('✓') => mode.ok(),
        Some('✗') => mode.err(),
        Some('◔') => mode.partial(),
        Some('●') => mode.running(),
        Some('○') => mode.pending(),
        Some('◇') => mode.diamond_open(),
        _ => mode.diamond(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dual_sets() {
        assert_eq!(GlyphMode::Unicode.ok(), "✓");
        assert_eq!(GlyphMode::Ascii.ok(), "[OK]");
        assert_eq!(GlyphMode::Ascii.chevron(), ">");
        assert_eq!(GlyphMode::Unicode.spinner_frame(0), "⠜");
        assert_eq!(GlyphMode::Unicode.spinner_frame(15), "⢪");
        assert_eq!(GlyphMode::Unicode.spinner_frame(16), "⠜");
    }
}
