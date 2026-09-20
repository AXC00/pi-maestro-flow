// Local binding of the shared settings primitives for pi-maestro-flow.
// Replaces the previous cross-package `pi-cockpit/src/settings/ui-primitives.ts`
// imports — the implementation now lives in pi-maestro-settings-core and is
// bound here to pi-tui's ANSI-aware width functions.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createUiPrimitives, type UiFrameTheme } from "pi-maestro-settings-core/ui";

export type FrameTheme = UiFrameTheme;

const p = createUiPrimitives({
	measure: visibleWidth,
	clip: (text, width, ellipsis) => truncateToWidth(text, width, ellipsis),
});

export const fit = p.fit;
export const pad = p.pad;
export const rule = p.rule;
export const frame = p.frame;
export const headerLine = p.headerLine;
export const helpLine = p.helpLine;
