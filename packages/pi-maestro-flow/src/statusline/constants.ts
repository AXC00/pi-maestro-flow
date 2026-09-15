/**
 * Statusline constants — theme-driven helpers, icons, and color slots.
 *
 * Replaces the previous ANSI/RGB hard-coding with the Pi Theme semantic slots
 * (accent/success/warning/error/dim/muted/borderMuted) so the Flow footer
 * renders consistently with the Cockpit theme.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { resolveIconMode, resolveGlyphs, type IconMode } from "pi-maestro-settings-core/ui";

export const ANSI_RESET = "\x1b[0m";
export const ANSI_BOLD = "\x1b[1m";
export const ANSI_DIM = "\x1b[2m";
export const ANSI_REVERSE = "\x1b[7m";

// ---------------------------------------------------------------------------
// Icons / glyphs
// ---------------------------------------------------------------------------

export interface StatuslineGlyphs {
	model: string;
	runs: string;
	dir: string;
	git: string;
	ctx: string;
	milestone: string;
	phase: string;
	tokens: string;
	cacheHit: string;
	gitDirty: string;
	gitConflict: string;
	gitAhead: string;
	gitBehind: string;
	separator: string;
}

/**
 * Resolve the icon vocabulary used by the Flow statusline.
 *
 * Model, workspace (dir), and git icons come from the shared settings-core
 * glyph table so they stay consistent with Cockpit. Statusline-specific
 * glyphs (context bar, runs, milestone, phase) are kept local.
 */
export function resolveStatuslineGlyphs(mode?: IconMode): StatuslineGlyphs {
	const resolvedMode = resolveIconMode(mode ?? (process.env.MAESTRO_NERD_FONT === "1" ? "nerd" : "auto"));
	const glyphs = resolveGlyphs(resolvedMode);
	return {
		// Keep the statusline model icon distinct from the cache-hit bolt so
		// the two glyphs are never visually ambiguous in the footer.
		model: resolvedMode === "nerd" ? "\u{F0E7}" : "✎",
		runs: "⚙",
		dir: glyphs.workspace,
		git: glyphs.git,
		ctx: "◔",
		milestone: "⚑",
		phase: "◆",
		tokens: "Σ",
		cacheHit: "⚡",
		gitDirty: "△",
		gitConflict: "⚠",
		gitAhead: glyphs.tokensIn,
		gitBehind: glyphs.tokensOut,
		separator: glyphs.separator,
	};
}

/** Default glyph set, resolved once at import time. */
export const GLYPHS = resolveStatuslineGlyphs();

// ---------------------------------------------------------------------------
// Theme color slots
// ---------------------------------------------------------------------------

export const STATUSLINE_COLORS = {
	model: "accent",
	runs: "warning",
	dir: "text",
	git: "success",
	ctxOk: "success",
	ctxWarn: "warning",
	ctxAlert: "warning",
	ctxCrit: "error",
	milestone: "warning",
	phase: "accent",
	danger: "error",
	tokens: "muted",
	separator: "borderMuted",
	evol: "mdLink",
} as const satisfies Record<string, ThemeColor>;

export type StatuslineColorKey = keyof typeof STATUSLINE_COLORS;

// ---------------------------------------------------------------------------
// Context level thresholds
// ---------------------------------------------------------------------------

export type CtxLevel = "ok" | "warn" | "alert" | "crit";

export function getCtxLevel(usedPct: number): CtxLevel {
	if (usedPct < 50) return "ok";
	if (usedPct < 65) return "warn";
	if (usedPct < 80) return "alert";
	return "crit";
}

export function getCtxColor(level: CtxLevel): ThemeColor {
	switch (level) {
		case "ok":
			return STATUSLINE_COLORS.ctxOk;
		case "warn":
			return STATUSLINE_COLORS.ctxWarn;
		case "alert":
			return STATUSLINE_COLORS.ctxAlert;
		case "crit":
			return STATUSLINE_COLORS.ctxCrit;
	}
}
