import assert from "node:assert/strict";
import test from "node:test";
import { resolveGlyphs } from "../src/ui/icons.ts";
import type { WidthUtils } from "../src/ui/layout.ts";
import { frameToAnsi, frameToJson, renderChrome } from "../src/ui/overlay-render.ts";
import { line, span, type Frame } from "../src/ui/overlay-spec.ts";

const utils: WidthUtils = {
	measure: (t) => t.length,
	clip: (t, w, e) => (t.length <= w ? t : t.slice(0, Math.max(0, w - e.length)) + e),
};

const glyphs = resolveGlyphs("ascii");

const theme = {
	fg: (name: string, text: string) => `<${name}>${text}</>`,
	bg: (name: string, text: string) => `[${name}]${text}[/]`,
	bold: (text: string) => `*${text}*`,
};

test("renderChrome fills the height budget exactly", () => {
	const inner: Frame = [line("a"), line("b")];
	const out = renderChrome({ kind: "card", title: "T" }, inner, 20, 6, glyphs, utils);
	assert.equal(out.length, 6);
});

test("renderChrome reports overflow inside the budget", () => {
	const inner: Frame = Array.from({ length: 10 }, (_, i) => line(`row${i}`));
	const out = renderChrome({ kind: "card" }, inner, 20, 5, glyphs, utils);
	assert.equal(out.length, 5);
	const lastBody = out[3].map((s) => s.text).join("");
	assert.match(lastBody, /8 more/); // 10 rows, 3 budgeted: 2 shown + marker, 8 hidden
});

test("renderChrome embeds title and hints in the borders", () => {
	const out = renderChrome(
		{ kind: "card", title: "Hi", hints: [{ key: "esc", verb: "cancel" }] },
		[line("x")],
		24,
		4,
		glyphs,
		utils,
	);
	const top = out[0].map((s) => s.text).join("");
	const bottom = out[3].map((s) => s.text).join("");
	assert.ok(top.includes("Hi"));
	assert.ok(bottom.includes("esc"));
	assert.ok(bottom.includes("cancel"));
});

test("frameToAnsi maps roles to theme slots without raw escapes", () => {
	const frame: Frame = [[span("k", "hintKey", true), span(" verb", "hintVerb")]];
	const [line1] = frameToAnsi(frame, theme, utils);
	assert.equal(line1, "*<accent>k</>*<dim> verb</>");
	assert.ok(!line1.includes("\x1b["));
});

test("frameToAnsi fills selected rows with selectedBg", () => {
	const frame: Frame = [[span("sel", "selected")]];
	const [line1] = frameToAnsi(frame, theme, utils);
	assert.equal(line1, "[selectedBg]<accent>sel</>[/]");
});

test("frameToJson serializes roles snake_case", () => {
	const json = frameToJson([[span("k", "hintKey", true), span("v")]]);
	assert.deepEqual(json, [[{ text: "k", role: "hint_key", bold: true }, { text: "v" }]]);
});
