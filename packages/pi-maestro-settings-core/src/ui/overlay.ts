import type { IconGlyphs } from "./icons.ts";
import type { WidthUtils } from "./layout.ts";

/** Minimal theme surface used by overlay frame helpers. */
export interface ThemeLike {
	bg(name: string, text: string): string;
	fg(name: string, text: string): string;
}

export interface OverlayFrameOptions {
	/** Row indices that should use `selectedBg` instead of `customMessageBg`. */
	selectedRows?: ReadonlySet<number>;
	/** Background slot used for the panel fill and border background. */
	contentBg?: string;
	/** Foreground slot used for the border glyphs. */
	borderColor?: string;
}

/** Frame painting subset: `bg` is optional because many borders are fg-only. */
export interface FrameTheme {
	fg(name: string, text: string): string;
	bg?(name: string, text: string): string;
}

export interface BorderFrameOptions {
	/** Corner set; defaults to the rounded `glyphs.box` set. */
	corners?: "rounded" | "square";
	/** Theme used for `borderColor` / `background` painting. Omit for plain text. */
	theme?: FrameTheme;
	/** Foreground slot for the border glyphs; requires `theme`. */
	borderColor?: string;
	/** Background slot for border + content rows; requires `theme`. Omit for transparent. */
	background?: string;
	/** Leading and trailing spaces inside the border (default 0). */
	padding?: number;
	/** Clip each row to the inner width (default true). */
	clip?: boolean;
	/** Pad short rows to the inner width (default true). */
	pad?: boolean;
	/** Row indices rendered with `selectedBg` instead of `background`. */
	selectedRows?: ReadonlySet<number>;
}

const SQUARE_BOX = {
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
	horizontal: "─",
	vertical: "│",
} as const;

export interface FrameLineOptions {
	/** Corner set; defaults to the rounded `glyphs.box` set. */
	corners?: "rounded" | "square";
	/** Theme used for `borderColor` / `background` painting. */
	theme?: FrameTheme;
	/** Foreground slot for the border glyphs; requires `theme`. */
	borderColor?: string;
	/** Background slot for the border glyphs; requires `theme.bg`. */
	background?: string;
	/** Width helpers required by `title` / `label`. */
	utils?: WidthUtils;
	/** Inline title embedded in a top border (`── title ──`). */
	title?: string;
	/** Inline label embedded in a bottom border (`── label ──`). */
	label?: string;
}

function frameBox(corners: "rounded" | "square" | undefined, glyphs: IconGlyphs) {
	return corners === "square" ? SQUARE_BOX : glyphs.box;
}

function framePaint(options: FrameLineOptions): (text: string) => string {
	const theme = options.theme;
	return (text: string): string => {
		let out = text;
		if (options.borderColor && theme) out = theme.fg(options.borderColor, out);
		if (options.background && theme?.bg) out = theme.bg(options.background, out);
		return out;
	};
}

/** One top/middle/bottom border line for composable feature frames. */
export function makeFrameBorderLine(
	position: "top" | "middle" | "bottom",
	width: number,
	glyphs: IconGlyphs,
	options: FrameLineOptions = {},
): string {
	const box = frameBox(options.corners, glyphs);
	const paint = framePaint(options);
	if (width <= 1) return paint(box.horizontal.slice(0, Math.max(0, width)));
	const inner = width - 2;
	const left = position === "top" ? box.topLeft : position === "bottom" ? box.bottomLeft : "├";
	const right = position === "top" ? box.topRight : position === "bottom" ? box.bottomRight : "┤";
	if (inner === 0) return paint(`${left}${right}`);
	const inline = position === "top" ? options.title : position === "bottom" ? options.label : undefined;
	if (inline && options.utils) {
		const utils = options.utils;
		const prefix = position === "top" ? `─ ${inline} ` : (() => {
			const label = ` ${inline} `;
			const leftWidth = Math.max(1, inner - utils.measure(label) - 1);
			return box.horizontal.repeat(leftWidth) + label;
		})();
		let body = prefix;
		const used = utils.measure(body);
		if (used < inner) body += box.horizontal.repeat(inner - used);
		body = utils.clip(body, inner, "");
		return paint(`${left}${body}${right}`);
	}
	return paint(`${left}${box.horizontal.repeat(inner)}${right}`);
}

/** One bordered content row (`inner` = content width between the borders). */
export function makeFrameRow(
	content: string,
	inner: number,
	glyphs: IconGlyphs,
	utils: WidthUtils,
	options: FrameLineOptions & { leadingSpace?: boolean } = {},
): string {
	const box = frameBox(options.corners, glyphs);
	const paint = framePaint(options);
	const clipped = utils.clip(options.leadingSpace ? ` ${content}` : content, Math.max(0, inner), "…");
	const fill = " ".repeat(Math.max(0, inner - utils.measure(clipped)));
	return `${paint(box.vertical)}${clipped}${fill}${paint(box.vertical)}`;
}

/**
 * Single bordered-frame builder for feature overlays that own their own chrome.
 *
 * Supports both the rounded card look (`glyphs.box`) and the square terminal
 * panel look, with optional theme painting, padding, and background fill, so
 * Flow's feature overlays stop carrying private copies of the box glyphs.
 */
export function makeBorderFrame(
	lines: readonly string[],
	width: number,
	glyphs: IconGlyphs,
	utils: WidthUtils,
	options: BorderFrameOptions = {},
): string[] {
	if (width < 2) return lines.map((line) => utils.clip(line, Math.max(0, width), "…"));
	const box = options.corners === "square" ? SQUARE_BOX : glyphs.box;
	const theme = options.theme;
	const paint = (text: string): string => {
		let out = text;
		if (options.borderColor && theme) out = theme.fg(options.borderColor, out);
		if (options.background && theme?.bg) out = theme.bg(options.background, out);
		return out;
	};
	const padding = Math.max(0, options.padding ?? 0);
	const inner = width - 2;
	const contentWidth = Math.max(0, inner - padding * 2);
	const edge = box.horizontal.repeat(inner);
	const rows = lines.map((line, index) => {
		const clipped = options.clip === false ? line : utils.clip(line, contentWidth, "…");
		const fill = options.pad === false ? "" : " ".repeat(Math.max(0, contentWidth - utils.measure(clipped)));
		const padded = `${ " ".repeat(padding)}${clipped}${fill}${ " ".repeat(padding)}`;
		const bg = options.selectedRows?.has(index) ? "selectedBg" : options.background;
		const body = theme?.bg && bg ? theme.bg(bg, padded) : padded;
		return `${paint(box.vertical)}${body}${paint(box.vertical)}`;
	});
	return [paint(`${box.topLeft}${edge}${box.topRight}`), ...rows, paint(`${box.bottomLeft}${edge}${box.bottomRight}`)];
}

/**
 * Draw the rounded-card overlay frame shared by Todo/attach overlays.
 *
 * The frame is `width` terminal columns wide. Each content line is clipped to
 * `width - 1` visible columns (one leading margin column), then padded to the
 * full width with the panel background. Callers that need a narrower content
 * area can pre-truncate their lines before passing them in.
 */
export function makeOverlayFrame(
	lines: string[],
	width: number,
	theme: ThemeLike,
	glyphs: IconGlyphs,
	utils: WidthUtils,
	options: OverlayFrameOptions = {},
): string[] {
	const box = glyphs.box;
	const edge = box.horizontal.repeat(Math.max(0, width - 2));
	const contentBg = options.contentBg ?? "customMessageBg";
	const borderColor = options.borderColor ?? "borderMuted";
	const border = (glyph: string): string =>
		theme.bg(contentBg, theme.fg(borderColor, glyph));

	const contentWidth = Math.max(0, width - 1);
	const out: string[] = [border(`${box.topLeft}${edge}${box.topRight}`)];

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const fitted = utils.clip(line, contentWidth, "…");
		const fill = `${" ".repeat(Math.max(0, contentWidth - utils.measure(fitted)))}`;
		const padded = ` ${fitted}${fill}`;
		const bg = options.selectedRows?.has(index) ? "selectedBg" : contentBg;
		out.push(theme.bg(bg, padded));
	}

	out.push(border(`${box.bottomLeft}${edge}${box.bottomRight}`));
	return out;
}
