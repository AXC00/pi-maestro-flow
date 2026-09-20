//! ANSI escape sequence emission.
//!
//! RECON §8 (verified against .rdata strings):
//! * colors: truecolor `38;2;R;G;B` / `48;2;…`, 256-color `38;5;N` /
//!   `48;5;…`, underline color `58;…`, reset `0m`, defaults `39;49m`;
//! * modifiers: `1m 2m 3m 4m 5m 7m 8m 9m`, resets `22/23/24/27/29m`;
//! * screen: alt-screen `?1049h/l`, synchronized output `?2026h/l`,
//!   cursor `?25l/h`, home `H`, position `{r};{c}H`;
//! * erase: `J 1J 2J 3J` (screen), `K 0K 1K 2K` (line);
//! * title stack: `22;0t` push / `23;0t` pop.

use std::fmt::Write as _;

use crate::cell::{Color, Modifier};
use crate::style::CellStyle;

/// Terminal capability level byte (RECON §7: `0x102020000 >> (level*8)`).
///
/// | level | byte  | meaning        |
/// |-------|-------|----------------|
/// | 0     | 0x00  | no ANSI color  |
/// | 1,2   | 0x02  | 256-color      |
/// | 3,4   | 0x20  | truecolor      |
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct Level(pub u8);

impl Level {
    /// No color support.
    pub const NONE: Level = Level(0x00);
    /// 256-color (`38;5;n`) support.
    pub const ANSI256: Level = Level(0x02);
    /// Truecolor (`38;2;r;g;b`) support.
    pub const TRUECOLOR: Level = Level(0x20);

    /// Map a detected tier (0–4) to the capability byte. The original's
    /// `GLOBAL_LEVEL = (0x102020000 >> (level*8)) as u8` is a little-endian
    /// byte table; the equivalent table for the 0→0,1→2,2→2,3→0x20,4→0x20
    /// mapping is `0x20_20_02_02_00`.
    pub const fn from_tier(tier: u8) -> Level {
        let t = if tier > 4 { 4 } else { tier };
        Level((0x20_20_02_02_00u64 >> (t as u64 * 8)) as u8)
    }

    /// True when any ANSI color may be emitted.
    pub fn has_color(self) -> bool {
        self.0 != 0
    }

    /// True when truecolor sequences may be emitted.
    pub fn has_truecolor(self) -> bool {
        self.0 & 0x20 != 0
    }
}

impl Default for Level {
    fn default() -> Self {
        Level::TRUECOLOR
    }
}

// ------------------------------------------------------------------
// Cursor / screen control
// ------------------------------------------------------------------

/// `\x1b[{row};{col}H` — 1-based cursor position.
pub fn move_to(out: &mut String, row: u16, col: u16) {
    let _ = write!(out, "\x1b[{};{}H", row + 1, col + 1);
}

/// `\x1b[H` — cursor home.
pub fn cursor_home(out: &mut String) {
    out.push_str("\x1b[H");
}

/// `\x1b[?25l` — hide cursor.
pub fn hide_cursor(out: &mut String) {
    out.push_str("\x1b[?25l");
}

/// `\x1b[?25h` — show cursor.
pub fn show_cursor(out: &mut String) {
    out.push_str("\x1b[?25h");
}

/// `\x1b[?1049h` — enter alternate screen.
pub fn enter_alt_screen(out: &mut String) {
    out.push_str("\x1b[?1049h");
}

/// `\x1b[?1049l` — leave alternate screen.
pub fn leave_alt_screen(out: &mut String) {
    out.push_str("\x1b[?1049l");
}

/// `\x1b[?2026h` — begin synchronized output.
pub fn begin_sync(out: &mut String) {
    out.push_str("\x1b[?2026h");
}

/// `\x1b[?2026l` — end synchronized output.
pub fn end_sync(out: &mut String) {
    out.push_str("\x1b[?2026l");
}

/// Erase in display: `0`=below `1`=above `2`=all `3`=scrollback.
pub fn erase_display(out: &mut String, mode: u8) {
    match mode {
        0 => out.push_str("\x1b[J"),
        _ => {
            let _ = write!(out, "\x1b[{}J", mode);
        }
    }
}

/// Erase in line: `0`=right `1`=left `2`=all.
pub fn erase_line(out: &mut String, mode: u8) {
    match mode {
        0 => out.push_str("\x1b[K"),
        _ => {
            let _ = write!(out, "\x1b[{}K", mode);
        }
    }
}

/// `\x1b[22;0t` — push window title onto the stack.
pub fn push_title(out: &mut String) {
    out.push_str("\x1b[22;0t");
}

/// `\x1b[23;0t` — pop window title from the stack.
pub fn pop_title(out: &mut String) {
    out.push_str("\x1b[23;0t");
}

/// `ESC 7` — save cursor.
pub fn save_cursor(out: &mut String) {
    out.push_str("\x1b7");
}

/// `ESC 8` — restore cursor.
pub fn restore_cursor(out: &mut String) {
    out.push_str("\x1b8");
}

// ------------------------------------------------------------------
// SGR
// ------------------------------------------------------------------

/// `\x1b[0m` — full reset.
pub fn sgr_reset(out: &mut String) {
    out.push_str("\x1b[0m");
}

/// `\x1b[39;49m` — default fg/bg.
pub fn sgr_default_colors(out: &mut String) {
    out.push_str("\x1b[39;49m");
}

fn push_color_params(params: &mut String, base: u8, color: Color, level: Level) {
    match color {
        Color::Reset => {
            // 39 (default fg) or 49 (default bg); for underline (base 58)
            // there is no "default" — emit 59.
            let code = match base {
                38 => 39,
                48 => 49,
                _ => 59,
            };
            let _ = write!(params, "{code}");
        }
        Color::Ansi(n) => {
            if level.has_color() {
                let _ = write!(params, "{base};5;{n}");
            } else {
                let code = match base {
                    38 => 39,
                    48 => 49,
                    _ => 59,
                };
                let _ = write!(params, "{code}");
            }
        }
        Color::Rgb(r, g, b) => {
            if level.has_truecolor() {
                let _ = write!(params, "{base};2;{r};{g};{b}");
            } else if level.has_color() {
                let _ = write!(params, "{base};5;{}", rgb_to_ansi256(r, g, b));
            } else {
                let code = match base {
                    38 => 39,
                    48 => 49,
                    _ => 59,
                };
                let _ = write!(params, "{code}");
            }
        }
    }
}

/// Build the SGR parameter list that sets fg/bg/underline colors and
/// modifiers to exactly `style` — **assuming a `0` reset precedes it**
/// (which is how [`emit_sgr`] and the delta fallback use it). `Reset`
/// colors are therefore omitted entirely: after `0` they are already
/// the terminal default.
pub fn sgr_params(style: &CellStyle, level: Level) -> String {
    let mut params = String::new();
    let mut first = true;
    let push = |p: &str, params: &mut String, first: &mut bool| {
        if !*first {
            params.push(';');
        }
        params.push_str(p);
        *first = false;
    };

    // Colors (Reset = default after the leading 0 → skip). With no color
    // support at all, omit color params entirely so a colored style still
    // collapses to a bare `\x1b[0m`.
    if level.has_color() {
        if !style.fg.is_reset() {
            let mut seg = String::new();
            push_color_params(&mut seg, 38, style.fg, level);
            push(&seg, &mut params, &mut first);
        }
        if !style.bg.is_reset() {
            let mut seg = String::new();
            push_color_params(&mut seg, 48, style.bg, level);
            push(&seg, &mut params, &mut first);
        }
        if !style.underline.is_reset() {
            let mut seg = String::new();
            push_color_params(&mut seg, 58, style.underline, level);
            push(&seg, &mut params, &mut first);
        }
    }

    // Modifiers (SGR 1..9).
    let m = style.modifier;
    for (bit, code) in [
        (Modifier::BOLD, "1"),
        (Modifier::DIM, "2"),
        (Modifier::ITALIC, "3"),
        (Modifier::UNDERLINE, "4"),
        (Modifier::BLINK, "5"),
        (Modifier::INVERSE, "7"),
        (Modifier::HIDDEN, "8"),
        (Modifier::STRIKE, "9"),
    ] {
        if m.contains(bit) {
            push(code, &mut params, &mut first);
        }
    }
    params
}

/// Emit `\x1b[…m` switching the terminal to exactly `style`.
///
/// Always starts with `0` (reset) so stale attributes can't leak, then
/// appends only the non-default params. A fully-default style emits a
/// bare `\x1b[0m`.
pub fn emit_sgr(out: &mut String, style: &CellStyle, level: Level) {
    let params = sgr_params(style, level);
    if params.is_empty() {
        out.push_str("\x1b[0m");
    } else {
        let _ = write!(out, "\x1b[0;{params}m");
    }
}

/// Emit the SGR delta switching terminal state `from` → `to`.
///
/// Modifier bits that turn off emit their specific resets
/// (`22/23/24/27/29m`); colors that changed emit their new values.
/// Emits nothing when `from == to`.
pub fn emit_sgr_delta(out: &mut String, from: &CellStyle, to: &CellStyle, level: Level) {
    if from == to {
        return;
    }
    let mut params = String::new();
    let mut first = true;
    macro_rules! push {
        ($s:expr) => {{
            if !first {
                params.push(';');
            }
            params.push_str($s);
            first = false;
        }};
    }

    if from.fg != to.fg {
        let mut seg = String::new();
        push_color_params(&mut seg, 38, to.fg, level);
        push!(&seg);
    }
    if from.bg != to.bg {
        let mut seg = String::new();
        push_color_params(&mut seg, 48, to.bg, level);
        push!(&seg);
    }
    if from.underline != to.underline {
        let mut seg = String::new();
        push_color_params(&mut seg, 58, to.underline, level);
        push!(&seg);
    }

    let turned_on = to.modifier.difference(from.modifier);
    let turned_off = from.modifier.difference(to.modifier);
    for (bit, code) in [
        (Modifier::BOLD, "1"),
        (Modifier::DIM, "2"),
        (Modifier::ITALIC, "3"),
        (Modifier::UNDERLINE, "4"),
        (Modifier::BLINK, "5"),
        (Modifier::INVERSE, "7"),
        (Modifier::HIDDEN, "8"),
        (Modifier::STRIKE, "9"),
    ] {
        if turned_on.contains(bit) {
            push!(code);
        }
    }
    // Specific resets: bold+dim share 22; italic 23; underline 24;
    // inverse 27; strike 29. Blink/hidden have no dedicated reset —
    // fall back to a full reset plus re-emit (rare path).
    let needs_full_reset = turned_off.intersects(Modifier::BLINK | Modifier::HIDDEN);
    if needs_full_reset {
        // Simplest correct path: full reset then absolute style.
        out.push_str("\x1b[0m");
        let abs = sgr_params(to, level);
        if !abs.is_empty() {
            let _ = write!(out, "\x1b[{abs}m");
        }
        return;
    }
    for (bit, code) in [
        (Modifier::BOLD, "22"),
        (Modifier::DIM, "22"),
        (Modifier::ITALIC, "23"),
        (Modifier::UNDERLINE, "24"),
        (Modifier::INVERSE, "27"),
        (Modifier::STRIKE, "29"),
    ] {
        if turned_off.contains(bit) && !params.ends_with(code) {
            // avoid duplicate 22 when both BOLD and DIM turn off
            if !(bit == Modifier::DIM && turned_off.contains(Modifier::BOLD)) {
                push!(code);
            }
        }
    }
    if params.is_empty() {
        return;
    }
    let _ = write!(out, "\x1b[{params}m");
}

/// Quantize 24-bit RGB to the xterm 256-palette index.
///
/// Uses the 6×6×6 cube (16–231) plus the gray ramp (232–255), picking
/// whichever is closer per channel.
pub fn rgb_to_ansi256(r: u8, g: u8, b: u8) -> u8 {
    fn cube_idx(v: u8) -> u8 {
        // nearest of {0,95,135,175,215,255}
        if v < 48 {
            0
        } else if v < 115 {
            1
        } else {
            ((v as u16 - 35) / 40).min(5) as u8
        }
    }
    let (ri, gi, bi) = (cube_idx(r), cube_idx(g), cube_idx(b));
    let cube = 16 + 36 * ri + 6 * gi + bi;

    // Gray ramp candidate.
    let avg = (r as u16 + g as u16 + b as u16) / 3;
    let gray_idx = if avg < 8 {
        0
    } else if avg > 238 {
        23
    } else {
        ((avg - 8) / 10) as u8
    };
    let gray_val = 8 + 10 * gray_idx as u16;
    let gray = 232 + gray_idx;

    // Compare squared error of cube vs gray.
    let cube_rgb = [
        [0, 95, 135, 175, 215, 255][ri as usize],
        [0, 95, 135, 175, 215, 255][gi as usize],
        [0, 95, 135, 175, 215, 255][bi as usize],
    ];
    let err = |a: [u16; 3]| -> u32 {
        let d = [
            a[0] as i32 - r as i32,
            a[1] as i32 - g as i32,
            a[2] as i32 - b as i32,
        ];
        (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) as u32
    };
    if err([gray_val, gray_val, gray_val]) < err(cube_rgb.map(|v| v as u16)) {
        gray
    } else {
        cube
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn style(fg: Color, bg: Color) -> CellStyle {
        CellStyle {
            fg,
            bg,
            underline: Color::Reset,
            modifier: Modifier::empty(),
        }
    }

    #[test]
    fn truecolor_packing() {
        let mut out = String::new();
        emit_sgr(&mut out, &style(Color::Rgb(94, 196, 255), Color::Reset), Level::TRUECOLOR);
        assert_eq!(out, "\x1b[0;38;2;94;196;255m");
    }

    #[test]
    fn ansi256_packing() {
        let mut out = String::new();
        emit_sgr(&mut out, &style(Color::Ansi(196), Color::Ansi(21)), Level::TRUECOLOR);
        assert_eq!(out, "\x1b[0;38;5;196;48;5;21m");
    }

    #[test]
    fn rgb_quantizes_at_256_level() {
        let mut out = String::new();
        emit_sgr(
            &mut out,
            &style(Color::Rgb(255, 0, 0), Color::Reset),
            Level::ANSI256,
        );
        assert_eq!(out, "\x1b[0;38;5;196m");
    }

    #[test]
    fn no_color_level_emits_defaults() {
        let mut out = String::new();
        emit_sgr(&mut out, &style(Color::Rgb(1, 2, 3), Color::Ansi(5)), Level::NONE);
        assert_eq!(out, "\x1b[0m");
    }

    #[test]
    fn underline_color_58() {
        let mut out = String::new();
        let s = CellStyle {
            underline: Color::Rgb(255, 0, 0),
            modifier: Modifier::UNDERLINE,
            ..style(Color::Reset, Color::Reset)
        };
        emit_sgr(&mut out, &s, Level::TRUECOLOR);
        assert_eq!(out, "\x1b[0;58;2;255;0;0;4m");
    }

    #[test]
    fn modifier_codes() {
        let mut out = String::new();
        let s = CellStyle {
            modifier: Modifier::BOLD | Modifier::ITALIC | Modifier::STRIKE,
            ..style(Color::Reset, Color::Reset)
        };
        emit_sgr(&mut out, &s, Level::TRUECOLOR);
        assert_eq!(out, "\x1b[0;1;3;9m");
    }

    #[test]
    fn delta_emits_only_changes() {
        let from = style(Color::Ansi(7), Color::Reset);
        let to = CellStyle {
            modifier: Modifier::BOLD,
            ..style(Color::Ansi(7), Color::Reset)
        };
        let mut out = String::new();
        emit_sgr_delta(&mut out, &from, &to, Level::TRUECOLOR);
        assert_eq!(out, "\x1b[1m");
    }

    #[test]
    fn delta_modifier_reset() {
        let from = CellStyle {
            modifier: Modifier::BOLD | Modifier::UNDERLINE,
            ..style(Color::Reset, Color::Reset)
        };
        let to = style(Color::Reset, Color::Reset);
        let mut out = String::new();
        emit_sgr_delta(&mut out, &from, &to, Level::TRUECOLOR);
        assert_eq!(out, "\x1b[22;24m");
    }

    #[test]
    fn cursor_and_screen_sequences() {
        let mut out = String::new();
        move_to(&mut out, 0, 0);
        move_to(&mut out, 9, 4);
        hide_cursor(&mut out);
        show_cursor(&mut out);
        enter_alt_screen(&mut out);
        leave_alt_screen(&mut out);
        begin_sync(&mut out);
        end_sync(&mut out);
        erase_display(&mut out, 2);
        erase_line(&mut out, 0);
        assert_eq!(
            out,
            "\x1b[1;1H\x1b[10;5H\x1b[?25l\x1b[?25h\x1b[?1049h\x1b[?1049l\x1b[?2026h\x1b[?2026l\x1b[2J\x1b[K"
        );
    }

    #[test]
    fn level_tier_table() {
        assert_eq!(Level::from_tier(0), Level::NONE);
        assert_eq!(Level::from_tier(1), Level::ANSI256);
        assert_eq!(Level::from_tier(2), Level::ANSI256);
        assert_eq!(Level::from_tier(3), Level::TRUECOLOR);
        assert_eq!(Level::from_tier(4), Level::TRUECOLOR);
    }
}
