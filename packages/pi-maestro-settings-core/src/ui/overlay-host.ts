// openOverlay — the single entry point for plugin overlays.
//
// TTY backend (today): the Frame-producing controller is wrapped in a pi-tui
// Component and mounted through ctx.ui.custom({overlay:true}). The same
// controller later runs unchanged over RPC: its Frame is serialized by
// frameToJson() and input arrives as extension_ui_event messages.
//
// Non-TUI degrade: when ctx.mode !== "tui" (or custom() resolves undefined —
// the current rpc-mode behaviour), the overlay falls back to spec.degrade()
// when provided, else a read-only setWidget rendering. Interactive overlays
// that cannot degrade should declare spec.degrade explicitly.
//
// Height budget (spec ui-conventions-006): the controller receives the real
// row budget resolved from spec.maxHeight × terminal rows; when the terminal
// height is unknown it falls back to FALLBACK_ROWS, never a guess.

import type { IconGlyphs } from "./icons.ts";
import type { WidthUtils } from "./layout.ts";
import type { MatchesKey, OverlayKeybindings } from "./overlay-keys.ts";
import { createOverlayKeys } from "./overlay-keys.ts";
import {
	type Frame,
	type OverlaySpec,
	type SizeValue,
	span,
} from "./overlay-spec.ts";
import { type OverlayTheme, renderChrome, renderChromeMarked, frameToAnsi } from "./overlay-render.ts";

/** Last-resort row budget when the terminal height is unavailable. */
export const FALLBACK_ROWS = 24;

/** Fixed size presets — the only allowed overlay sizes. */
export type OverlayPresetName = "dialog" | "panel" | "wide";

const PRESETS: Record<OverlayPresetName, { width: SizeValue; maxHeight: SizeValue }> = {
	dialog: { width: "60%", maxHeight: "70%" },
	panel: { width: "80%", maxHeight: "85%" },
	wide: { width: "92%", maxHeight: "90%" },
};

export function overlayPreset(name: OverlayPresetName): { width: SizeValue; maxHeight: SizeValue } {
	return { ...PRESETS[name] };
}

/** Resolve a SizeValue against a terminal dimension. */
export function resolveSize(value: SizeValue | undefined, total: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number") return value;
	const pct = Number.parseFloat(value);
	if (!Number.isFinite(pct)) return undefined;
	return Math.max(1, Math.floor((total * pct) / 100));
}

/** Row budget for the overlay body+chrome, per ui-conventions-006. */
export function overlayHeightBudget(spec: OverlaySpec, termRows?: number): number {
	const rows = termRows ?? process.stdout?.rows ?? FALLBACK_ROWS;
	const requested = resolveSize(spec.maxHeight, rows);
	return Math.max(3, requested ?? Math.min(rows, FALLBACK_ROWS));
}

/** Structural subset of the pi-tui Component the host wraps. */
export interface HostComponent {
	render(width: number): string[];
	handleInput?(data: string): void;
	invalidate?(): void;
	focused?: boolean;
	dispose?(): void;
}

/** Structural subset of ctx.ui used by the host. */
export interface OverlayUI {
	custom<T>(
		factory: (
			tui: { requestRender(): void },
			theme: OverlayTheme,
			keybindings: OverlayKeybindings,
			done: (result: T) => void,
		) => HostComponent | Promise<HostComponent>,
		options?: {
			overlay?: boolean;
			overlayOptions?: Record<string, unknown> | (() => Record<string, unknown>);
			onHandle?: (handle: unknown) => void;
		},
	): Promise<T>;
	setWidget?(key: string, lines: string[], options?: { placement?: string }): void;
	notify?(message: string, type?: string): void;
}

export interface OverlayHostDeps {
	utils: WidthUtils;
	glyphs: IconGlyphs;
	matchesKey: MatchesKey;
	/** Terminal row count override (tests); defaults to process.stdout.rows. */
	termRows?: number;
}

/** What the overlay body produces and how it answers input. */
export interface OverlayController<T = unknown> {
	/**
	 * Produce the body frame for the given inner budget (chrome excluded).
	 * `theme` is only present on the TTY backend — controllers that still embed
	 * legacy ANSI-producing widgets (e.g. Markdown) may use it and bridge via
	 * ansiToSpans; pure-Span controllers must not depend on it.
	 */
	render(w: number, h: number, theme?: OverlayTheme): Frame;
	/**
	 * Consume one key event. Return true when handled, "close" to resolve with
	 * `closeResult`, false/undefined to let the host apply defaults (Esc).
	 */
	handleKey?(key: string, keys: ReturnType<typeof createOverlayKeys>): boolean | "close";
	/** Value returned through done() when the overlay closes. */
	closeResult?: T;
	/** Called once with host services after the component is created. */
	attach?(host: { requestRender(): void; close(result?: T): void }): void;
	/** Component teardown; implementations may settle a cancel result here. */
	dispose?(): void;
	/** Forwarded from the host component (cursor-blink reset for embedded widgets). */
	invalidate?(): void;
}

export interface OpenOverlayOptions<T = unknown> {
	/** Explicit size preset; spec.width/maxHeight win when both are set. */
	preset?: OverlayPresetName;
	/** Non-TUI degrade: return the overlay result without UI. */
	degrade?(ctx: { ui: OverlayUI }): T | Promise<T>;
	/** Forwarded to ctx.ui.custom options.onHandle. */
	onHandle?: (handle: unknown) => void;
}

function specToOverlayOptions(spec: OverlaySpec, preset?: OverlayPresetName): Record<string, unknown> {
	const base: { width?: SizeValue; maxHeight?: SizeValue } = preset ? PRESETS[preset] : {};
	const opts: Record<string, unknown> = {
		width: spec.width ?? base.width,
		maxHeight: spec.maxHeight ?? base.maxHeight,
		anchor: spec.anchor ?? "center",
	};
	if (spec.minWidth !== undefined) opts.minWidth = spec.minWidth;
	if (spec.margin !== undefined) opts.margin = spec.margin;
	if (spec.offsetX !== undefined) opts.offsetX = spec.offsetX;
	if (spec.offsetY !== undefined) opts.offsetY = spec.offsetY;
	return opts;
}

/**
 * Mount an overlay described by `spec` whose body is produced by `controller`.
 * Resolves with the controller's close result (undefined on Esc dismissal).
 */
export async function openOverlay<T = unknown>(
	ctx: { ui: OverlayUI; mode?: string },
	spec: OverlaySpec,
	controller: OverlayController<T>,
	deps: OverlayHostDeps,
	options: OpenOverlayOptions<T> = {},
): Promise<T | undefined> {
	if (ctx.mode !== undefined && ctx.mode !== "tui") {
		return degrade(ctx, spec, controller, deps, options);
	}
	const h = overlayHeightBudget(spec, deps.termRows);

	const result = await ctx.ui.custom<T | undefined>(
		(tui, theme, keybindings, done) => {
			const keys = createOverlayKeys(deps.matchesKey, keybindings);
			const component: HostComponent = {
				focused: true,
				render(width: number) {
					const inner = controller.render(Math.max(0, width - 2), Math.max(0, h - 2), theme);
					const { frame, fillRows } = renderChromeMarked(spec, inner, width, h, deps.glyphs, deps.utils);
					return frameToAnsi(frame, theme, deps.utils, { fillRows });
				},
				handleInput(data: string) {
					const handled = controller.handleKey?.(data, keys);
					if (handled === "close") {
						done(controller.closeResult as T);
						return;
					}
					if (handled) {
						tui.requestRender();
						return;
					}
					if (spec.dismissable !== false && keys.cancel(data)) {
						done(undefined);
						return;
					}
					tui.requestRender();
				},
				dispose() {
					controller.dispose?.();
				},
				invalidate() {
					controller.invalidate?.();
				},
			};
			controller.attach?.({
				requestRender: () => tui.requestRender(),
				close: (r?: T) => done(r as T),
			});
			return component;
		},
		{
			overlay: true,
			overlayOptions: specToOverlayOptions(spec, options.preset),
			onHandle: options.onHandle,
		},
	);
	// rpc-mode custom() resolves undefined without ever running the factory;
	// there is no positive signal to distinguish that from an Esc dismissal,
	// so mode-gating above is the real degrade path.
	return result;
}

async function degrade<T>(
	ctx: { ui: OverlayUI },
	spec: OverlaySpec,
	controller: OverlayController<T>,
	deps: OverlayHostDeps,
	options: OpenOverlayOptions<T>,
): Promise<T | undefined> {
	if (options.degrade) return options.degrade(ctx);
	// Read-only degrade: render the body once as plain text into a widget.
	if (ctx.ui.setWidget) {
		const w = resolveSize(spec.width, process.stdout?.columns ?? 80) ?? 60;
		const h = overlayHeightBudget(spec, deps.termRows);
		const { frame } = renderChromeMarked(spec, controller.render(w - 2, h - 2), w, h, deps.glyphs, deps.utils);
		const plain = frame.map((row) => row.map((s) => s.text).join(""));
		ctx.ui.setWidget(`overlay:${spec.title ?? "custom"}`, plain);
		return undefined;
	}
	ctx.ui.notify?.(`${spec.title ?? "Overlay"} unavailable in this mode`, "warning");
	return undefined;
}

/**
 * Bridge for unmigrated components: mounts an existing
 * `render(width): string[]` component with preset sizing. Chrome is NOT added
 * (legacy components already draw their own frame); migrate to openOverlay +
 * Frame to get the unified card.
 */
export async function openOverlayLegacy<T = unknown>(
	ctx: { ui: OverlayUI; mode?: string },
	factory: (
		tui: { requestRender(): void },
		theme: OverlayTheme,
		keybindings: OverlayKeybindings,
		done: (result: T) => void,
	) => HostComponent | Promise<HostComponent>,
	options: {
		preset?: OverlayPresetName;
		overlayOptions?: Record<string, unknown> | (() => Record<string, unknown>);
		onHandle?: (handle: unknown) => void;
	} = {},
): Promise<T | undefined> {
	if (ctx.mode !== undefined && ctx.mode !== "tui") return undefined;
	const overlayOptions =
		options.overlayOptions ??
		(options.preset ? { ...PRESETS[options.preset], anchor: "center" } : undefined);
	return ctx.ui.custom<T>(factory, {
		overlay: true,
		overlayOptions: overlayOptions as Record<string, unknown>,
		onHandle: options.onHandle,
	});
}
