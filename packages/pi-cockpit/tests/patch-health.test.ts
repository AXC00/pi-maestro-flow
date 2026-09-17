import { test } from "node:test";
import assert from "node:assert/strict";
import { patchStatus, patchStatuses, patchSummary, reportPatch, resetPatchHealth } from "../src/patch-health.ts";
import { applyRow, buildRows } from "../src/settings-view.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { cockpitTuiLocale } from "../src/tui-i18n.ts";

cockpitTuiLocale.setLocale("en");

test("patch registry records active and degraded states", () => {
	resetPatchHealth();
	reportPatch("viewport-stability", true);
	reportPatch("split-pane", false, "attach-failed");
	assert.equal(patchStatus("viewport-stability")?.active, true);
	assert.equal(patchStatus("split-pane")?.active, false);
	assert.equal(patchStatus("split-pane")?.reason, "attach-failed");
	assert.equal(patchStatus("fullscreen"), undefined);
});

test("patchSummary counts active and names degraded patches", () => {
	resetPatchHealth();
	assert.equal(patchSummary(), "");
	reportPatch("viewport-stability", true);
	reportPatch("compaction-style", true);
	reportPatch("split-pane", false, "attach-failed");
	assert.equal(patchSummary(), "2/3 · split-pane: attach-failed");
	resetPatchHealth();
	reportPatch("editor-bottom", true);
	assert.equal(patchSummary(), "1/1");
});

test("settings panel shows a read-only host patches row when a summary exists", () => {
	const rows = buildRows(DEFAULT_CONFIG, { thinkingHidden: false, patchSummary: "2/3 · split-pane: attach-failed" });
	const row = rows.find((candidate) => candidate.key === "hostPatches");
	assert.equal(row?.kind, "info");
	assert.equal(row?.accel, "");
	assert.equal(row?.value, "2/3 · split-pane: attach-failed");
	// Info rows are not config: applying them is a no-op.
	assert.equal(applyRow(DEFAULT_CONFIG, "hostPatches"), DEFAULT_CONFIG);
	// No summary → no row (panel stays unchanged before the first patch attempt).
	assert.equal(buildRows(DEFAULT_CONFIG).some((candidate) => candidate.key === "hostPatches"), false);
});
