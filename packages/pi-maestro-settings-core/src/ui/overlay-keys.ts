// Shared overlay key matchers.
//
// One matcher set for every overlay: the user's `tui.select.*` keybindings
// when a KeybindingsManager is available, otherwise the same defaults the
// panels used to hardcode (arrows + j/k + enter + esc). pi-tui's matchesKey
// is injected so this package stays dependency-free.

/** The `tui.select.*` keybinding ids overlays resolve. */
export type OverlayKeybinding =
	| "tui.select.up"
	| "tui.select.down"
	| "tui.select.pageUp"
	| "tui.select.pageDown"
	| "tui.select.confirm"
	| "tui.select.cancel";

/** Structural subset of pi-tui's KeybindingsManager (which satisfies it). */
export interface OverlayKeybindings {
	matches(data: string, keybinding: OverlayKeybinding): boolean;
}

/** pi-tui `matchesKey(data, keyId)` signature. */
export type MatchesKey = (data: string, keyId: string) => boolean;

export interface OverlayKeys {
	up(data: string): boolean;
	down(data: string): boolean;
	pageUp(data: string): boolean;
	pageDown(data: string): boolean;
	confirm(data: string): boolean;
	cancel(data: string): boolean;
}

export function createOverlayKeys(
	matchesKey: MatchesKey,
	keybindings?: OverlayKeybindings,
): OverlayKeys {
	if (keybindings && typeof keybindings.matches === "function") {
		return {
			up: (d) => keybindings.matches(d, "tui.select.up"),
			down: (d) => keybindings.matches(d, "tui.select.down"),
			pageUp: (d) => keybindings.matches(d, "tui.select.pageUp"),
			pageDown: (d) => keybindings.matches(d, "tui.select.pageDown"),
			confirm: (d) => keybindings.matches(d, "tui.select.confirm"),
			cancel: (d) => keybindings.matches(d, "tui.select.cancel"),
		};
	}
	return {
		up: (d) => matchesKey(d, "up") || d === "k",
		down: (d) => matchesKey(d, "down") || d === "j",
		pageUp: (d) => matchesKey(d, "pageUp"),
		pageDown: (d) => matchesKey(d, "pageDown"),
		confirm: (d) => matchesKey(d, "return") || matchesKey(d, "enter"),
		cancel: (d) => matchesKey(d, "escape"),
	};
}
