import type { TUI } from "@earendil-works/pi-tui";
import { readStableReference } from "./stable-reference.ts";

const VIEWPORT_STABILITY_MARKER = Symbol.for("pi-cockpit.viewport-stability");

type ApplyLineResets = (lines: string[]) => string[];

interface ViewportTuiInternals {
	applyLineResets?: ApplyLineResets;
	previousLines?: string[];
	previousViewportTop?: number;
	previousHeight?: number;
	previousWidth?: number;
	terminal?: { columns: number; rows: number };
}

interface ViewportStabilityMarker {
	original: ApplyLineResets;
	retain(): () => void;
}

interface ApplyLineResetsSlot {
	original: ApplyLineResets;
	requiresDispatchProbe: boolean;
	current(): ApplyLineResets | undefined;
	replace(value: ApplyLineResets): void;
	restore(): void;
}

export interface ViewportStabilityPatch {
	active: boolean;
	detach(): void;
}

function once(action: () => void): () => void {
	let called = false;
	return () => {
		if (called) return;
		called = true;
		action();
	};
}

function markerOf(fn: ApplyLineResets): ViewportStabilityMarker | undefined {
	return (fn as ApplyLineResets & Record<symbol, ViewportStabilityMarker | undefined>)[VIEWPORT_STABILITY_MARKER];
}

function isKittyImageLine(line: string | undefined): boolean {
	return typeof line === "string" && line.includes("\x1b_G");
}

const ANSI_ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;

function plainLine(line: string | undefined): string {
	return line?.replace(ANSI_ESCAPE, "").trim() ?? "";
}

function uniqueLinePositions(lines: readonly string[]): Map<string, number> {
	const positions = new Map<string, number>();
	const duplicates = new Set<string>();
	for (let index = 0; index < lines.length; index += 1) {
		const key = plainLine(lines[index]);
		if (!key || duplicates.has(key)) continue;
		if (positions.has(key)) {
			positions.delete(key);
			duplicates.add(key);
		} else {
			positions.set(key, index);
		}
	}
	return positions;
}

function mutableLineIdentity(line: string | undefined): string {
	return plainLine(line).toLowerCase().replace(/\d+(?:\.\d+)?/g, "#");
}

function mutableRowsCrossViewportBoundary(
	previousLines: readonly string[],
	nextLines: readonly string[],
	hiddenEnd: number,
): boolean {
	if (hiddenEnd <= 0 || hiddenEnd >= previousLines.length || hiddenEnd >= nextLines.length) return false;
	const previousHidden = mutableLineIdentity(previousLines[hiddenEnd - 1]);
	const previousVisible = mutableLineIdentity(previousLines[hiddenEnd]);
	const nextHidden = mutableLineIdentity(nextLines[hiddenEnd - 1]);
	const nextVisible = mutableLineIdentity(nextLines[hiddenEnd]);
	return previousHidden !== ""
		&& previousVisible !== ""
		&& previousHidden !== previousVisible
		&& previousHidden === nextVisible
		&& previousVisible === nextHidden;
}

function crossesViewportBoundary(
	previousLines: readonly string[],
	nextLines: readonly string[],
	hiddenEnd: number,
): boolean {
	if (mutableRowsCrossViewportBoundary(previousLines, nextLines, hiddenEnd)) return true;
	const previousPositions = uniqueLinePositions(previousLines);
	const nextPositions = uniqueLinePositions(nextLines);
	for (const [key, previousIndex] of previousPositions) {
		const nextIndex = nextPositions.get(key);
		if (nextIndex === undefined) continue;
		if ((previousIndex < hiddenEnd) !== (nextIndex < hiddenEnd)) return true;
	}
	return false;
}

function prototypeMethodSlot(target: object): ApplyLineResetsSlot | undefined {
	const seen = new WeakSet<object>();
	let owner = Object.getPrototypeOf(target) as object | null;
	for (let depth = 0; owner && depth < 32; depth += 1) {
		if (seen.has(owner)) return undefined;
		seen.add(owner);
		const descriptor = Object.getOwnPropertyDescriptor(owner, "applyLineResets");
		if (descriptor) {
			if (typeof descriptor.value !== "function" || descriptor.writable !== true) return undefined;
			const original = descriptor.value as ApplyLineResets;
			return {
				original,
				requiresDispatchProbe: true,
				current: () => Object.getOwnPropertyDescriptor(owner, "applyLineResets")?.value as ApplyLineResets | undefined,
				replace: (value) => Object.defineProperty(owner, "applyLineResets", { ...descriptor, value }),
				restore: () => Object.defineProperty(owner, "applyLineResets", descriptor),
			};
		}
		owner = Object.getPrototypeOf(owner) as object | null;
	}
	return undefined;
}

function instanceMethodSlot(internals: ViewportTuiInternals, stable: ApplyLineResets): ApplyLineResetsSlot {
	const target = internals as object;
	const descriptor = Object.getOwnPropertyDescriptor(target, "applyLineResets");
	return {
		original: stable,
		requiresDispatchProbe: false,
		current: () => internals.applyLineResets,
		replace: (value) => Object.defineProperty(target, "applyLineResets", descriptor
			? { ...descriptor, value }
			: { configurable: true, enumerable: false, writable: true, value }),
		restore: () => {
			if (descriptor) Object.defineProperty(target, "applyLineResets", descriptor);
			else delete internals.applyLineResets;
		},
	};
}

function resolveApplyLineResetsSlot(internals: ViewportTuiInternals): ApplyLineResetsSlot | undefined {
	const stable = readStableReference(() => internals.applyLineResets);
	if (typeof stable === "function") return instanceMethodSlot(internals, stable);
	// pi 0.84 exposes a dynamic TUI Proxy whose method reads intentionally return
	// fresh dispatch closures. Its prototype, however, is the current renderer's
	// real prototype, so patch that stable method slot without wrapping a closure.
	return prototypeMethodSlot(internals);
}

/**
 * Treats the hidden viewport prefix as immutable scrollback while frame size is
 * stable. The next frame keeps the terminal's actual hidden text, so visible
 * changes can use pi-tui's differential path instead of clearing and replaying
 * the screen. Structural, resize and image changes retain the native path.
 */
export function attachViewportStability(tui: TUI): ViewportStabilityPatch {
	try {
		// Native fullscreen has an application-owned fixed viewport. Its inherited
		// applyLineResets method is not part of that renderer's diff path, so patching
		// it would report a false-positive attachment on the shared TUI base class.
		if (tui.mode === "fullscreen") return { active: false, detach() {} };
		const internals = tui as unknown as ViewportTuiInternals;
		const slot = resolveApplyLineResetsSlot(internals);
		if (!slot) return { active: false, detach() {} };
		const { original } = slot;
		const existing = markerOf(original);
		if (existing) return { active: true, detach: existing.retain() };

		let dispatches = 0;
		const wrapped: ApplyLineResets = function (this: ViewportTuiInternals, lines: string[]): string[] {
			dispatches += 1;
			const nextLines = original.call(this, lines);
			const previousLines = this.previousLines;
			const viewportTop = this.previousViewportTop;
			if (
				Array.isArray(previousLines)
					&& previousLines.length === nextLines.length
					&& typeof viewportTop === "number"
					&& Number.isFinite(viewportTop)
					&& viewportTop > 0
					&& this.previousHeight === this.terminal?.rows
					&& this.previousWidth === this.terminal?.columns
			) {
				const hiddenEnd = Math.min(previousLines.length, Math.trunc(viewportTop));
				const hiddenHasKittyImage = previousLines.slice(0, hiddenEnd).some(isKittyImageLine)
					|| nextLines.slice(0, hiddenEnd).some(isKittyImageLine);
				// Equal total height does not prove row identity. If a stable row crossed
				// the viewport boundary, freezing by index would duplicate it across the
				// hidden and visible regions; retain pi-tui's canonical full redraw instead.
				if (!hiddenHasKittyImage && !crossesViewportBoundary(previousLines, nextLines, hiddenEnd)) {
					for (let index = 0; index < hiddenEnd; index += 1) {
						const previous = previousLines[index];
						if (previous !== undefined) nextLines[index] = previous;
					}
				}
			}
			return nextLines;
		};
		let references = 1;
		const release = (): void => {
			references -= 1;
			if (references === 0 && slot.current() === wrapped) slot.restore();
		};
		const retain = (): (() => void) => {
			references += 1;
			return once(release);
		};
		Object.defineProperty(wrapped, VIEWPORT_STABILITY_MARKER, {
			value: { original, retain } satisfies ViewportStabilityMarker,
			configurable: false,
			enumerable: false,
			writable: false,
		});
		slot.replace(wrapped);
		const installed = slot.current() === wrapped;
		const dispatched = !slot.requiresDispatchProbe || (() => {
			const before = dispatches;
			internals.applyLineResets?.([]);
			return dispatches === before + 1;
		})();
		if (!installed || !dispatched) {
			if (slot.current() === wrapped) slot.restore();
			return { active: false, detach() {} };
		}

		return { active: true, detach: once(release) };
	} catch {
		return { active: false, detach() {} };
	}
}
