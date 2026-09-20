// Overlay wire model — the single vocabulary every plugin overlay speaks.
//
// An overlay is data, not a component: `OverlaySpec` describes the chrome
// (title, anchor, size, hints) and a `Frame` of styled `Span`s describes the
// body. Two backends consume the same model:
//   - TTY:   frameToAnsi() maps Role → theme.fg/bg slots (overlay-render.ts)
//   - RPC:   frameToJson() serializes for `extension_ui_request{method:"custom"}`
//            consumed by the Rust pi-tui `DialogState::Plugin` host
//
// Style is enforced by the protocol: Role is a closed enum, so a plugin can
// say "this is accent" but never "this is #ff8800". Both frontends map the
// same role to their own theme surface (ANSI slots / CSS classes).

/** Semantic style roles. Serialized snake_case on the wire (hintKey→hint_key). */
export type Role =
	| "text"
	| "muted"
	| "dim"
	| "accent"
	| "warning"
	| "error"
	| "success"
	| "border"
	| "selected"
	| "hintKey"
	| "hintVerb";

export interface Span {
	text: string;
	role?: Role;
	bold?: boolean;
}

/** One overlay frame: rows of styled spans. */
export type Frame = Span[][];

/** pi-tui OverlayAnchor mirror (kept as literals so this package stays dependency-free). */
export type OverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/** Absolute columns/rows or a percentage string ("72%"). Mirrors pi-tui SizeValue. */
export type SizeValue = number | `${number}%`;

export interface OverlayHint {
	key: string;
	verb: string;
}

/**
 * Declarative overlay chrome. `anchor`/`width`/`minWidth`/`maxHeight`/
 * `margin`/`offsetX`/`offsetY` map 1:1 onto pi-tui `OverlayOptions`, so the
 * TTY backend passes them through unchanged and the RPC backend serializes
 * the same fields.
 */
export interface OverlaySpec {
	kind: "card";
	title?: string;
	anchor?: OverlayAnchor;
	width?: SizeValue;
	minWidth?: number;
	maxHeight?: SizeValue;
	margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
	offsetX?: number;
	offsetY?: number;
	/** When false the client must not close on Esc; the plugin decides. Default true. */
	dismissable?: boolean;
	hints?: OverlayHint[];
	/**
	 * Fill the whole card with the panel background (TTY: `customMessageBg`,
	 * RPC: `.overlay-card` surface). Default false = border-only chrome.
	 */
	fill?: boolean;
}

// --- Span/Frame constructors -------------------------------------------------

export function span(text: string, role?: Role, bold?: boolean): Span {
	const s: Span = { text };
	if (role !== undefined) s.role = role;
	if (bold !== undefined) s.bold = bold;
	return s;
}

/** Convenience: a whole row sharing one role. */
export function line(text: string, role?: Role, bold?: boolean): Span[] {
	return [span(text, role, bold)];
}

/** Visible width of one frame row (sum of span widths via the injected measurer). */
export function rowWidth(row: readonly Span[], measure: (text: string) => number): number {
	let w = 0;
	for (const s of row) w += measure(s.text);
	return w;
}

/** True when any span marks the row selected — the row gets the selected background. */
export function isSelectedRow(row: readonly Span[]): boolean {
	return row.some((s) => s.role === "selected");
}
