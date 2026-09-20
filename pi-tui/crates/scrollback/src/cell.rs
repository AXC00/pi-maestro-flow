//! Cell primitives: `Symbol`, `Color`, `Modifier`, `Cell`.
//!
//! Mirrors the reconstructed `scrollback` cell layout (RECON §2):
//! a cell carries a grapheme `symbol`, foreground/background `Color`s,
//! an underline color, and a `Modifier` bitmask. `Color::Reset` means
//! "inherit" — it is resolved against the parent style during painting
//! and against the terminal default during ANSI emission.

use std::fmt;
use std::sync::Arc;

/// Minimal bitflags implementation so `scrollback` stays dependency-light.
macro_rules! bitflags_like {
    ($(#[$meta:meta])* $vis:vis struct $name:ident : $ty:ty { $(const $const:ident = $val:expr;)* }) => {
        $(#[$meta])*
        $vis struct $name(pub $ty);

        impl $name {
            $(pub const $const: Self = Self($val);)*
            /// No bits set.
            pub const fn empty() -> Self { Self(0) }
            /// All defined bits set.
            pub const fn all() -> Self { Self(0 $(| $val)*) }
            /// Raw bits.
            pub const fn bits(self) -> $ty { self.0 }
            /// Build from raw bits (unknown bits are kept).
            pub const fn from_bits_retain(bits: $ty) -> Self { Self(bits) }
            /// True when no bits are set.
            pub const fn is_empty(self) -> bool { self.0 == 0 }
            /// True when every bit of `other` is set in `self`.
            pub const fn contains(self, other: Self) -> bool { (self.0 & other.0) == other.0 }
            /// True when any bit of `other` is set in `self`.
            pub const fn intersects(self, other: Self) -> bool { (self.0 & other.0) != 0 }
            /// Insert `other` into `self`.
            pub fn insert(&mut self, other: Self) { self.0 |= other.0 }
            /// Remove `other` from `self`.
            pub fn remove(&mut self, other: Self) { self.0 &= !other.0 }
            /// `self` with `other` inserted.
            pub const fn union(self, other: Self) -> Self { Self(self.0 | other.0) }
            /// `self` minus `other`.
            pub const fn difference(self, other: Self) -> Self { Self(self.0 & !other.0) }
        }

        impl std::ops::BitOr for $name {
            type Output = Self;
            fn bitor(self, rhs: Self) -> Self { Self(self.0 | rhs.0) }
        }
        impl std::ops::BitOrAssign for $name {
            fn bitor_assign(&mut self, rhs: Self) { self.0 |= rhs.0 }
        }
        impl std::ops::BitAnd for $name {
            type Output = Self;
            fn bitand(self, rhs: Self) -> Self { Self(self.0 & rhs.0) }
        }
        impl std::ops::Not for $name {
            type Output = Self;
            fn not(self) -> Self { Self(!self.0) }
        }
    };
}

/// Maximum byte length of a `Symbol::Inline` payload.
///
/// RECON §2: symbol tag `0..=0x17` encodes an inline length of up to 23
/// bytes; `0x18` is a boxed string and `>= 0x19` a shared (Arc) string.
pub const INLINE_CAP: usize = 23;

/// A cell symbol: one grapheme cluster worth of display text.
///
/// `Inline` stores up to [`INLINE_CAP`] bytes inline (the common case —
/// ASCII and box-drawing chars fit). Longer clusters are boxed, or shared
/// via `Arc` when the same cluster is stamped across many cells (e.g. a
/// cloned row).
#[derive(Clone)]
pub enum Symbol {
    /// Inline storage: `len` valid bytes in `buf`.
    Inline { len: u8, buf: [u8; INLINE_CAP] },
    /// Heap-allocated cluster.
    Box(Box<str>),
    /// Shared cluster (row clones share the allocation).
    Arc(Arc<str>),
}

impl Default for Symbol {
    fn default() -> Self {
        Symbol::Inline { len: 0, buf: [0u8; INLINE_CAP] }
    }
}

impl Symbol {
    /// Build a symbol from a string slice, choosing the cheapest storage.
    pub fn new(s: &str) -> Self {
        if s.len() <= INLINE_CAP {
            let mut buf = [0u8; INLINE_CAP];
            buf[..s.len()].copy_from_slice(s.as_bytes());
            Symbol::Inline {
                len: s.len() as u8,
                buf,
            }
        } else {
            Symbol::Box(s.into())
        }
    }

    /// Build a shared symbol (used by row cloning).
    pub fn shared(s: &str) -> Self {
        if s.len() <= INLINE_CAP {
            Symbol::new(s)
        } else {
            Symbol::Arc(Arc::from(s))
        }
    }

    /// The symbol text.
    pub fn as_str(&self) -> &str {
        match self {
            Symbol::Inline { len, buf } => {
                // `buf[..len]` only ever holds bytes copied from a `&str`.
                std::str::from_utf8(&buf[..*len as usize]).unwrap_or("")
            }
            Symbol::Box(b) => b,
            Symbol::Arc(a) => a,
        }
    }

    /// True when the cell carries no visible glyph.
    pub fn is_empty(&self) -> bool {
        self.as_str().is_empty()
    }
}

impl fmt::Debug for Symbol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("Symbol").field(&self.as_str()).finish()
    }
}

impl PartialEq for Symbol {
    fn eq(&self, other: &Self) -> bool {
        self.as_str() == other.as_str()
    }
}
impl Eq for Symbol {}
impl PartialEq<str> for Symbol {
    fn eq(&self, other: &str) -> bool {
        self.as_str() == other
    }
}
impl PartialEq<&str> for Symbol {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}

impl From<&str> for Symbol {
    fn from(s: &str) -> Self {
        Symbol::new(s)
    }
}
impl From<char> for Symbol {
    fn from(c: char) -> Self {
        let mut buf = [0u8; 4];
        Symbol::new(c.encode_utf8(&mut buf))
    }
}

/// A cell color.
///
/// `Reset` is the "inherit" sentinel (`0xff` in the original layout): it
/// resolves to the parent style during painting and to the terminal
/// default (`39`/`49`) during emission.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Color {
    /// Inherit / terminal default.
    #[default]
    Reset,
    /// 24-bit truecolor.
    Rgb(u8, u8, u8),
    /// ANSI 256-palette index.
    Ansi(u8),
}

impl Color {
    /// True when this color asks for the inherited/default value.
    pub fn is_reset(self) -> bool {
        matches!(self, Color::Reset)
    }
}

impl fmt::Debug for Color {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Color::Reset => write!(f, "Reset"),
            Color::Rgb(r, g, b) => write!(f, "Rgb({r},{g},{b})"),
            Color::Ansi(n) => write!(f, "Ansi({n})"),
        }
    }
}

bitflags_like! {
    /// Cell modifier bitmask (SGR 1..9 attributes).
    ///
    /// Bit positions follow the SGR parameter numbers so `1<<0` is bold
    /// (SGR 1), `1<<3` is underline (SGR 4), etc.
    #[derive(Clone, Copy, PartialEq, Eq, Hash, Default)]
    pub struct Modifier: u16 {
        const BOLD       = 1 << 0; // SGR 1
        const DIM        = 1 << 1; // SGR 2
        const ITALIC     = 1 << 2; // SGR 3
        const UNDERLINE  = 1 << 3; // SGR 4
        const BLINK      = 1 << 4; // SGR 5
        const INVERSE    = 1 << 6; // SGR 7
        const HIDDEN     = 1 << 7; // SGR 8
        const STRIKE     = 1 << 8; // SGR 9
    }
}

impl fmt::Debug for Modifier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut first = true;
        for (bit, name) in [
            (Modifier::BOLD, "BOLD"),
            (Modifier::DIM, "DIM"),
            (Modifier::ITALIC, "ITALIC"),
            (Modifier::UNDERLINE, "UNDERLINE"),
            (Modifier::BLINK, "BLINK"),
            (Modifier::INVERSE, "INVERSE"),
            (Modifier::HIDDEN, "HIDDEN"),
            (Modifier::STRIKE, "STRIKE"),
        ] {
            if self.contains(bit) {
                if !first {
                    write!(f, "|")?;
                }
                write!(f, "{name}")?;
                first = false;
            }
        }
        if first {
            write!(f, "(empty)")?;
        }
        Ok(())
    }
}

/// One terminal cell.
#[derive(Clone, Default)]
pub struct Cell {
    /// The grapheme cluster drawn in this cell ("" = blank).
    pub symbol: Symbol,
    /// Foreground color.
    pub fg: Color,
    /// Background color.
    pub bg: Color,
    /// Underline color (`Reset` = same as `fg` / default).
    pub underline: Color,
    /// Style modifiers.
    pub modifier: Modifier,
    /// Hyperlink target (`<a href>`), if any.
    pub link: Option<Arc<str>>,
}

impl Cell {
    /// A blank cell with all-inheriting style.
    pub const EMPTY: Cell = Cell {
        symbol: Symbol::Inline {
            len: 0,
            buf: [0; INLINE_CAP],
        },
        fg: Color::Reset,
        bg: Color::Reset,
        underline: Color::Reset,
        modifier: Modifier::empty(),
        link: None,
    };

    /// True when the cell has no glyph and no link.
    pub fn is_blank(&self) -> bool {
        self.symbol.is_empty() && self.link.is_none()
    }
}

impl fmt::Debug for Cell {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Cell")
            .field("symbol", &self.symbol.as_str())
            .field("fg", &self.fg)
            .field("bg", &self.bg)
            .field("underline", &self.underline)
            .field("modifier", &self.modifier)
            .field("link", &self.link)
            .finish()
    }
}

impl PartialEq for Cell {
    fn eq(&self, other: &Self) -> bool {
        self.symbol == other.symbol
            && self.fg == other.fg
            && self.bg == other.bg
            && self.underline == other.underline
            && self.modifier == other.modifier
            // Compare link targets by value, not by Arc identity, so two
            // frames built independently still diff cleanly.
            && self.link.as_deref() == other.link.as_deref()
    }
}
impl Eq for Cell {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symbol_inline_roundtrip() {
        let s = Symbol::new("héllo");
        assert_eq!(s.as_str(), "héllo");
        assert!(matches!(s, Symbol::Inline { .. }));
    }

    #[test]
    fn symbol_boxed_for_long_clusters() {
        let long = "a".repeat(INLINE_CAP + 1);
        let s = Symbol::new(&long);
        assert!(matches!(s, Symbol::Box(_)));
        assert_eq!(s.as_str(), long);
    }

    #[test]
    fn symbol_equality_across_storage() {
        let long = "x".repeat(30);
        assert_eq!(Symbol::new(&long), Symbol::shared(&long));
    }

    #[test]
    fn cell_default_is_empty() {
        let c = Cell::default();
        assert!(c.is_blank());
        assert_eq!(c, Cell::EMPTY);
    }

    #[test]
    fn modifier_bits() {
        let m = Modifier::BOLD | Modifier::UNDERLINE;
        assert!(m.contains(Modifier::BOLD));
        assert!(m.contains(Modifier::UNDERLINE));
        assert!(!m.contains(Modifier::ITALIC));
        assert_eq!(m.bits(), 0b1001);
    }
}
