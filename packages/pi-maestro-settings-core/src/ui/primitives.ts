// Settings-shell line primitives, bound to injected width utils.
//
// Moved up from pi-cockpit/src/settings/ui-primitives.ts so every package
// shares one implementation. The functions need pi-tui's ANSI-aware width
// math; to keep this package dependency-free they are produced by
// `createUiPrimitives(utils)` — callers bind `visibleWidth`/`truncateToWidth`
// once and re-export (see pi-cockpit's ui-primitives.ts for the canonical
// binding).

import type { WidthUtils } from "./layout.ts";

/**
 * Minimal theme surface shared by the Maestro settings shell and the legacy
 * settings TUIs that adopt its visual language. Satisfied by both the pi-tui
 * Theme and the per-overlay theme objects used inside pi-maestro-flow.
 */
export interface UiFrameTheme {
	fg(role: string, text: string): string;
	bold(text: string): string;
	bg?(role: string, text: string): string;
}

export interface UiPrimitives {
	/** Truncate a value to the given visible width, appending an ellipsis. */
	fit(value: string, width: number): string;
	/** Truncate to width and right-pad with spaces up to the exact visible width. */
	pad(value: string, width: number): string;
	/** Horizontal divider line. */
	rule(width: number): string;
	/**
	 * Draws a framed overlay box using the shared visual language: dim border
	 * lines with the customMessageBg background. Adopted by every settings TUI
	 * so that shell and overlay surfaces render identically.
	 */
	frame(rows: readonly string[], width: number, theme: UiFrameTheme): string[];
	/**
	 * Header line in the shared `title · segment · segment` shape. Empty
	 * segments are skipped so callers can pass optional state segments.
	 */
	headerLine(theme: UiFrameTheme, title: string, segments: readonly string[], width: number): string;
	/** Dimmed help/footer line, truncated to width. */
	helpLine(theme: UiFrameTheme, text: string, width: number): string;
}

/**
 * Bind the primitives to a width implementation. In pi extensions:
 * `createUiPrimitives({ measure: visibleWidth, clip: (t, w, e) => truncateToWidth(t, w, e) })`.
 */
export function createUiPrimitives(utils: WidthUtils): UiPrimitives {
	const fit = (value: string, width: number): string =>
		utils.clip(value, Math.max(0, width), "…");

	const pad = (value: string, width: number): string => {
		const fitted = fit(value, width);
		return `${fitted}${" ".repeat(Math.max(0, width - utils.measure(fitted)))}`;
	};

	const rule = (width: number): string => "─".repeat(Math.max(0, width));

	const frame = (rows: readonly string[], width: number, theme: UiFrameTheme): string[] => {
		if (width < 2) return rows.map((row) => fit(row, width));
		const inner = width - 2;
		const background = (value: string): string => theme.bg?.("customMessageBg", value) ?? value;
		return [
			background(theme.fg("dim", `┌${"─".repeat(inner)}┐`)),
			...rows.map((row) => background(`${theme.fg("dim", "│")}${pad(row, inner)}${theme.fg("dim", "│")}`)),
			background(theme.fg("dim", `└${"─".repeat(inner)}┘`)),
		];
	};

	const headerLine = (
		theme: UiFrameTheme,
		title: string,
		segments: readonly string[],
		width: number,
	): string => {
		const rest = segments.filter((segment) => segment.length > 0);
		const line = rest.length > 0 ? `${theme.bold(title)} · ${rest.join(" · ")}` : theme.bold(title);
		return fit(line, Math.max(0, width));
	};

	const helpLine = (theme: UiFrameTheme, text: string, width: number): string =>
		theme.fg("dim", fit(text, Math.max(0, width)));

	return { fit, pad, rule, frame, headerLine, helpLine };
}
