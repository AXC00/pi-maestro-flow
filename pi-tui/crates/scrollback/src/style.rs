//! `CellStyle` — the resolved per-node style that flows down the paint
//! traversal and merges with the inherited parent style.
//!
//! RECON §3.3: `resolve_cell_style` produces a 16-byte
//! `{fg, bg, underline, modifier}` record; each field uses an all-ones
//! sentinel (`0xff` / `0xffff`) for "inherit", and the merge with the
//! parent style is a per-field select (the original did it with SIMD
//! `pand`/`pcmpeqd`/`pandn`/`por` — scalar code here).

use crate::cell::{Color, Modifier};

/// Sentinel modifier value meaning "inherit from parent".
///
/// `Modifier::all()` is not a real attribute combination (blink+hidden+
/// strike+… simultaneously is meaningless), so it doubles as the
/// inherit sentinel — matching the original's `0xffff` field.
pub const INHERIT_MODIFIER: Modifier = Modifier::from_bits_retain(0xffff);

/// The style carried by a cell: colors, underline color, modifiers.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct CellStyle {
    /// Foreground color (`Reset` = inherit).
    pub fg: Color,
    /// Background color (`Reset` = inherit).
    pub bg: Color,
    /// Underline color (`Reset` = inherit / follow `fg`).
    pub underline: Color,
    /// Modifier bits ([`INHERIT_MODIFIER`] = inherit).
    pub modifier: Modifier,
}

impl CellStyle {
    /// Fully-inheriting style — the root default.
    pub const INHERIT: CellStyle = CellStyle {
        fg: Color::Reset,
        bg: Color::Reset,
        underline: Color::Reset,
        modifier: INHERIT_MODIFIER,
    };

    /// Concrete default style (terminal defaults, no modifiers).
    pub const DEFAULT: CellStyle = CellStyle {
        fg: Color::Reset,
        bg: Color::Reset,
        underline: Color::Reset,
        modifier: Modifier::empty(),
    };

    /// Merge `self` over `parent`: every field still marked "inherit"
    /// takes the parent's (already resolved) value.
    ///
    /// This is the scalar form of the original's SIMD merge: for each
    /// field, `parent & sentinel_mask | self & !sentinel_mask`.
    pub fn merge_inherited(&self, parent: &CellStyle) -> CellStyle {
        CellStyle {
            fg: if self.fg.is_reset() { parent.fg } else { self.fg },
            bg: if self.bg.is_reset() { parent.bg } else { self.bg },
            underline: if self.underline.is_reset() {
                parent.underline
            } else {
                self.underline
            },
            modifier: if self.modifier == INHERIT_MODIFIER {
                parent.modifier
            } else {
                self.modifier
            },
        }
    }

    /// True when every field is concrete (nothing left to inherit).
    pub fn is_resolved(&self) -> bool {
        !self.fg.is_reset()
            && !self.bg.is_reset()
            && !self.underline.is_reset()
            && self.modifier != INHERIT_MODIFIER
    }
}

impl Default for CellStyle {
    fn default() -> Self {
        CellStyle::INHERIT
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inherit_merge_takes_parent_for_reset_fields() {
        let parent = CellStyle {
            fg: Color::Rgb(1, 2, 3),
            bg: Color::Ansi(4),
            underline: Color::Rgb(9, 9, 9),
            modifier: Modifier::BOLD,
        };
        let child = CellStyle::INHERIT;
        assert_eq!(child.merge_inherited(&parent), parent);
    }

    #[test]
    fn inherit_merge_keeps_concrete_fields() {
        let parent = CellStyle {
            fg: Color::Rgb(1, 2, 3),
            bg: Color::Ansi(4),
            underline: Color::Reset,
            modifier: Modifier::BOLD,
        };
        let child = CellStyle {
            fg: Color::Rgb(9, 8, 7),
            bg: Color::Reset,
            underline: Color::Ansi(2),
            modifier: Modifier::ITALIC,
        };
        let merged = child.merge_inherited(&parent);
        assert_eq!(merged.fg, Color::Rgb(9, 8, 7));
        assert_eq!(merged.bg, Color::Ansi(4)); // inherited
        assert_eq!(merged.underline, Color::Ansi(2));
        assert_eq!(merged.modifier, Modifier::ITALIC); // replaced, not OR'd
    }

    #[test]
    fn modifier_inherit_sentinel() {
        let parent = CellStyle {
            modifier: Modifier::DIM,
            ..CellStyle::INHERIT
        };
        let child = CellStyle {
            modifier: INHERIT_MODIFIER,
            ..CellStyle::INHERIT
        };
        assert_eq!(child.merge_inherited(&parent).modifier, Modifier::DIM);
        // A concrete (even empty) modifier overrides the parent.
        let child2 = CellStyle {
            modifier: Modifier::empty(),
            ..CellStyle::INHERIT
        };
        assert_eq!(child2.merge_inherited(&parent).modifier, Modifier::empty());
    }
}
