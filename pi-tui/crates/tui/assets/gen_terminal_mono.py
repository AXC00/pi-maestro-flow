#!/usr/bin/env python3
"""Generate TerminalMono.ttf — a metrics-only monospace font for the pi-tui
headless blitz-dom layout pipeline.

Design (mirrors the original Devin "TerminalMono", SCROLLBACK-RECON §9):
  * unitsPerEm = 1000
  * every "narrow" glyph has advance = 1000  → at `font-size: 1px` each
    character advances exactly 1 CSS px = 1 terminal cell
  * East-Asian Wide/Fullwidth codepoints map to a glyph with advance = 2000
    → 2 cells, matching `unicode-width`
  * zero-width codepoints (Mn/Me/Cf/Cc + ZWJ + variation selectors) map to a
    glyph with advance = 0
  * .notdef has advance = 1000 (unknown chars occupy 1 cell)

Glyphs carry no outlines — parley/swash only need metrics for layout; the
terminal renders the actual glyphs from cell text.

Usage: python gen_terminal_mono.py  (writes TerminalMono.ttf next to itself)
"""

import os
import sys
import unicodedata

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import newTable
from fontTools.ttLib.tables import _c_m_a_p

UPM = 1000
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "TerminalMono.ttf")

GLYPHS = [".notdef", "zero", "narrow", "wide"]
METRICS = {  # advance, lsb
    ".notdef": (UPM, 0),
    "zero": (0, 0),
    "narrow": (UPM, 0),
    "wide": (2 * UPM, 0),
}


def classify(cp: int) -> str | None:
    """Map a codepoint to its width glyph, or None for the narrow default.

    Narrow codepoints are left unmapped: they fall back to `.notdef`,
    which has the same 1000-unit advance — keeping the cmap small enough
    for a format-4 BMP subtable.
    """
    cat = unicodedata.category(chr(cp))
    # Zero-width: combining marks, format controls, control chars.
    if cat in ("Mn", "Me", "Cf", "Cc", "Cs"):
        return "zero"
    # Private use: keep narrow (1 cell) — used for PUA markers.
    if cat == "Co":
        return "narrow"
    # Unassigned/noncharacters: unmapped → .notdef → 1 cell.
    if cat == "Cn":
        return None
    if unicodedata.east_asian_width(chr(cp)) in ("W", "F"):
        return "wide"
    return None


def build_cmap() -> dict[int, str]:
    cmap: dict[int, str] = {}
    for cp in range(0x110000):
        # Skip surrogate range (invalid scalar values).
        if 0xD800 <= cp <= 0xDFFF:
            continue
        glyph = classify(cp)
        if glyph is not None:
            cmap[cp] = glyph
    return cmap


def main() -> None:
    fb = FontBuilder(UPM, isTTF=True)
    fb.setupGlyphOrder(GLYPHS)

    # Empty glyphs (metrics-only font).
    glyph_map = {}
    for name in GLYPHS:
        pen = TTGlyphPen(None)
        glyph_map[name] = pen.glyph()
    fb.setupGlyf(glyph_map)

    cmap = build_cmap()
    # Build only a format-12 (UCS-4) subtable: format 4 cannot express
    # sparse many-codepoints→one-glyph ranges (idRangeOffset overflow).
    cmap_table = newTable("cmap")
    cmap_table.tableVersion = 0
    sub = _c_m_a_p.CmapSubtable.newSubtable(12)
    sub.platformID = 3
    sub.platEncID = 10
    sub.language = 0
    sub.cmap = cmap
    cmap_table.tables = [sub]
    fb.font["cmap"] = cmap_table
    fb.setupHorizontalMetrics({g: METRICS[g] for g in GLYPHS})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupOS2(
        sTypoAscender=800,
        sTypoDescender=-200,
        sTypoLineGap=0,
        usWinAscent=800,
        usWinDescent=200,
    )
    fb.setupNameTable(
        {
            "familyName": "TerminalMono",
            "styleName": "Regular",
            "uniqueFontIdentifier": "TerminalMono-Regular-pi-tui",
            "fullName": "TerminalMono Regular",
            "psName": "TerminalMono-Regular",
            "version": "Version 1.0",
        }
    )
    fb.setupPost()
    fb.setupDummyDSIG()
    fb.save(OUT)
    size = os.path.getsize(OUT)
    print(f"wrote {OUT} ({size} bytes, {len(cmap)} cmap entries)")


if __name__ == "__main__":
    sys.exit(main())
