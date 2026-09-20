// ANSI → Span bridge (transitional).
//
// Lets a legacy `render(width): string[]` body feed the Frame model without a
// rewrite: SGR color/style codes are folded onto the closed Role vocabulary,
// every other escape sequence is stripped. Raw ANSI never crosses the wire —
// the RPC backend only sees roles, and the TTY backend re-emits them through
// the theme, which also normalizes plugin styling onto theme slots.
//
// Deliberate limits (transitional bridge, not a terminal emulator):
// - Extended colors (38;5;N / 38;2;R;G;B / bg variants) cannot map to a Role
//   and are dropped — migrate hot paths to Span roles directly.
// - Italic/underline/blink have no Role and are dropped.
// - Inverse video (SGR 7) maps to "selected"; a row containing it gets the
//   selected-row background in renderChrome — avoid for in-row cursor cells.

import { type Role, type Span } from "./overlay-spec.ts";

/** SGR parameter → Role. Bright variants (90-97) share the base-color role. */
const SGR_ROLE: Record<number, Role> = {
	2: "dim",
	7: "selected",
	30: "muted",
	31: "error",
	32: "success",
	33: "warning",
	34: "muted",
	35: "accent",
	36: "accent",
	37: "text",
	90: "dim",
	91: "error",
	92: "success",
	93: "warning",
	94: "muted",
	95: "accent",
	96: "accent",
	97: "text",
};

/** Parse one rendered line into styled spans. */
export function ansiToSpans(line: string): Span[] {
	const spans: Span[] = [];
	let role: Role = "text";
	let bold = false;
	let buf = "";
	const flush = (): void => {
		if (!buf) return;
		const s: Span = { text: buf };
		if (role !== "text") s.role = role;
		if (bold) s.bold = true;
		spans.push(s);
		buf = "";
	};

	let i = 0;
	while (i < line.length) {
		const ch = line[i];
		if (ch === "\x1b") {
			if (line[i + 1] === "]") {
				// OSC: ESC ] … (BEL | ESC \) — strip entirely.
				let j = i + 2;
				while (j < line.length && line[j] !== "\x07" && !(line[j] === "\x1b" && line[j + 1] === "\\")) j++;
				i = line[j] === "\x07" ? j + 1 : j + 2;
				continue;
			}
			if (line[i + 1] === "[") {
				// CSI: ESC [ params final-byte.
				let j = i + 2;
				while (j < line.length && !/[@-~]/.test(line[j])) j++;
				const final = line[j];
				const params = line.slice(i + 2, j);
				i = j + 1;
				if (final !== "m") continue; // non-SGR CSI: strip
				flush();
				for (const p of params.split(";")) {
					const n = p === "" ? 0 : Number.parseInt(p, 10);
					if (!Number.isFinite(n)) continue;
					if (n === 0) { role = "text"; bold = false; }
					else if (n === 1) bold = true;
					else if (n === 22) bold = false;
					else if (n === 39) role = "text";
					else if (n === 27 && role === "selected") role = "text";
					else if (SGR_ROLE[n] !== undefined) role = SGR_ROLE[n];
					// 38/48 extended colors, 40-47/49/100-107 bg, 3/4/5/9 styles: drop.
				}
				continue;
			}
			i++; // lone ESC / other escape introducer: skip the byte.
			continue;
		}
		if (ch < " " && ch !== "\t") { i++; continue; } // C0 controls: strip.
		buf += ch;
		i++;
	}
	flush();
	return spans;
}

/** Convert a whole legacy render output into a Frame. */
export function ansiToFrame(lines: readonly string[]): Span[][] {
	return lines.map(ansiToSpans);
}
