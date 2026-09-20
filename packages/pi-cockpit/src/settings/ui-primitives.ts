// Canonical binding of the shared settings primitives (moved to
// pi-maestro-settings-core/src/ui/primitives.ts). This module keeps the
// historical import path working for cockpit internals and external callers;
// new code should import from "pi-maestro-settings-core/ui" via a local
// binding module instead of this package's src path.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createUiPrimitives, type UiFrameTheme } from "pi-maestro-settings-core/ui";

/** @deprecated Use `UiFrameTheme` from pi-maestro-settings-core/ui. */
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
