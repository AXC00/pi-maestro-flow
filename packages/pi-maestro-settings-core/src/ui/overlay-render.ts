// The single overlay chrome renderer.
//
// renderChrome() is the ONLY bordered-card implementation plugin overlays use:
// rounded corners from the resolved glyph set, title embedded in the top edge,
// key hints embedded in the bottom edge, and a hard vertical budget that clips
// the body and reports the overflow as "N more" inside the budget (never on
// top of it — spec ui-conventions-006).
//
// frameToAnsi() is the TTY backend (Role → theme slots); frameToJson() is the
// RPC wire shape consumed by the Rust pi-tui overlay host. Both render the
// same Frame, so a plugin's styling is identical on either frontend.

import type { IconGlyphs } from "./icons.ts";
import type { WidthUtils } from "./layout.ts";
import {
	type Frame,
	type OverlayHint,
	type OverlaySpec,
	type Role,
	type Span,
	isSelectedRow,
	rowWidth,
	span,
} from "./overlay-spec.ts";

/** Theme surface needed by the TTY backend. Matches pi-coding-agent Theme. */
export interface OverlayTheme {
	fg(name: string, text: string): string;
	bg?(name: string, text: string): string;
	bold?(text: string): string;
	/** Reverse-video cell used for text-input cursors. */
	inverse?(text: string): string;
}

/** Role → pi-coding-agent ThemeColor slot. */
const ROLE_FG: Record<Role, string> = {
	text: "text",
	muted: "muted",
	dim: "dim",
	accent: "accent",
	warning: "warning",
	error: "error",
	success: "success",
	border: "borderMuted",
	selected: "accent",
	hintKey: "accent",
	hintVerb: "dim",
};

/** Role → wire name (snake_case, mirrors the Rust serde enum). */
const ROLE_WIRE: Record<Role, string> = {
	text: "text",
	muted: "muted",
	dim: "dim",
	accent: "accent",
	warning: "warning",
	error: "error",
	success: "success",
	border: "border",
	selected: "selected",
	hintKey: "hint_key",
	hintVerb: "hint_verb",
};

function paintSpan(s: Span, theme: OverlayTheme): string {
	let out = s.text;
	const role = s.role ?? "text";
	if (role === "selected") {
		// Selected rows get the background fill in renderChrome; the span itself
		// only takes the accent foreground so the marker stays legible on it.
		out = theme.fg(ROLE_FG.selected, out);
	} else if (role !== "text") {
		out = theme.fg(ROLE_FG[role], out);
	}
	if (s.bold && theme.bold) out = theme.bold(out);
	return out;
}

function clipRow(row: readonly Span[], width: number, utils: WidthUtils): Span[] {
	if (width <= 0) return [];
	const out: Span[] = [];
	let used = 0;
	for (const s of row) {
		const remaining = width - used;
		if (remaining <= 0) break;
		const w = utils.measure(s.text);
		if (w <= remaining) {
			out.push(s);
			used += w;
		} else {
			const clipped = utils.clip(s.text, remaining, "…");
			if (clipped !== "") out.push({ ...s, text: clipped });
			break;
		}
	}
	return out;
}

function padRow(row: readonly Span[], width: number, utils: WidthUtils): Span[] {
	const fill = width - rowWidth(row, utils.measure);
	if (fill <= 0) return [...row];
	return [...row, span(" ".repeat(fill))];
}

function hintsRow(hints: readonly OverlayHint[]): Span[] {
	const row: Span[] = [];
	hints.forEach((h, i) => {
		if (i > 0) row.push(span(" · ", "dim"));
		row.push(span(h.key, "hintKey", true), span(` ${h.verb}`, "hintVerb"));
	});
	return row;
}

/**
 * Wrap `inner` in the unified overlay card chrome.
 *
 * `w`/`h` are the real budget in terminal cells. Output is exactly `h` rows
 * when h ≥ 3 (top border + body + bottom border); when the body overflows it
 * is clipped and the last body row becomes `{N} more` — the marker consumes a
 * budgeted row rather than adding one. Below h=3 or w<4 the chrome degrades
 * to clipped plain rows instead of drawing a broken box.
 */
export function renderChrome(
	spec: OverlaySpec,
	inner: Frame,
	w: number,
	h: number,
	glyphs: IconGlyphs,
	utils: WidthUtils,
): Frame {
	return renderChromeMarked(spec, inner, w, h, glyphs, utils).frame;
}

/** renderChrome + per-row fill markers for the TTY backend. */
export function renderChromeMarked(
	spec: OverlaySpec,
	inner: Frame,
	w: number,
	h: number,
	glyphs: IconGlyphs,
	utils: WidthUtils,
): { frame: Frame; fillRows: boolean[] } {
	if (w <= 0 || h <= 0) return { frame: [], fillRows: [] };
	if (w < 4 || h < 3) {
		const frame = inner.slice(0, h).map((row) => clipRow(row, w, utils));
		return { frame, fillRows: frame.map(() => spec.fill === true) };
	}
	const box = glyphs.box;
	const innerW = w - 2;
	const bodyBudget = h - 2;

	// Top border: ╭─ title ────────╮
	const top: Span[] = [span(box.topLeft, "border")];
	let titleW = 0;
	if (spec.title) {
		const t = utils.clip(spec.title, Math.max(0, innerW - 4), "…");
		top.push(span(`${box.horizontal} `, "border"), span(t, "accent", true));
		titleW = 1 + 1 + utils.measure(t);
	}
	top.push(span(box.horizontal.repeat(Math.max(0, innerW - titleW)), "border"), span(box.topRight, "border"));

	// Bottom border: ╰─ key verb · key verb ──╮
	const bottom: Span[] = [span(box.bottomLeft, "border")];
	const hintSpans = spec.hints?.length ? hintsRow(spec.hints) : [];
	let hintW = 0;
	if (hintSpans.length > 0) {
		const fitted = clipRow(hintSpans, Math.max(0, innerW - 2), utils);
		hintW = rowWidth(fitted, utils.measure);
		bottom.push(span(box.horizontal, "border"), ...fitted);
		hintW += 1;
	}
	bottom.push(
		span(box.horizontal.repeat(Math.max(0, innerW - hintW)), "border"),
		span(box.bottomRight, "border"),
	);

	// Body: clip to budget; overflow is reported by a "N more" marker that
	// consumes the last budgeted row (never adds one on top).
	// With spec.fill the card edge is the background fill (borderless sides,
	// matching makeOverlayFrame); without it the border glyphs form the edge.
	const wrapRow = (row: Span[]): Span[] =>
		spec.fill
			? [span(" "), ...row]
			: [span(box.vertical, "border"), ...row, span(box.vertical, "border")];
	const bodyWidth = spec.fill ? innerW + 1 : innerW;
	const overflow = inner.length > bodyBudget;
	const shown = overflow ? inner.slice(0, Math.max(0, bodyBudget - 1)) : inner;
	const body: Frame = shown.map((row) => {
		const clipped = padRow(clipRow(row, bodyWidth, utils), bodyWidth, utils);
		return wrapRow(clipped);
	});
	if (overflow) {
		const hidden = inner.length - shown.length;
		const markerRow = padRow(clipRow([span(`${hidden} more`, "dim")], bodyWidth, utils), bodyWidth, utils);
		body.push(wrapRow(markerRow));
	}
	// Pad short bodies so the card always occupies its full height.
	while (body.length < bodyBudget) {
		body.push(wrapRow([span(" ".repeat(bodyWidth))]));
	}

	const frame: Frame = [top, ...body, bottom];
	const fillRows = frame.map(() => spec.fill === true);
	return { frame, fillRows };
}

/** TTY backend: Frame → ANSI-styled lines via theme slots. */
export function frameToAnsi(
	frame: Frame,
	theme: OverlayTheme,
	utils: WidthUtils,
	options: { fillRows?: boolean[]; fillBg?: string } = {},
): string[] {
	return frame.map((row, i) => {
		const selected = isSelectedRow(row);
		const text = row.map((s) => paintSpan(s, theme)).join("");
		if (selected && theme.bg) return theme.bg("selectedBg", text);
		if (options.fillRows?.[i] && theme.bg) return theme.bg(options.fillBg ?? "customMessageBg", text);
		return text;
	});
}

/** RPC backend: Frame → wire JSON (snake_case roles, mirrors pi-rpc Span). */
export function frameToJson(frame: Frame): unknown {
	return frame.map((row) =>
		row.map((s) => {
			const o: Record<string, unknown> = { text: s.text };
			if (s.role) o.role = ROLE_WIRE[s.role];
			if (s.bold) o.bold = true;
			return o;
		}),
	);
}
