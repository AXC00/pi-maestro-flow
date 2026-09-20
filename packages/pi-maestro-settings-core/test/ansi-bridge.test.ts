import assert from "node:assert/strict";
import test from "node:test";
import { ansiToSpans, ansiToFrame } from "../src/ui/ansi-bridge.ts";

test("plain text produces a single unstyled span", () => {
	assert.deepEqual(ansiToSpans("hello"), [{ text: "hello" }]);
});

test("SGR color codes map to roles and reset restores text", () => {
	const spans = ansiToSpans("a\x1b[31merr\x1b[0mb");
	assert.deepEqual(spans, [
		{ text: "a" },
		{ text: "err", role: "error" },
		{ text: "b" },
	]);
});

test("bold flag is tracked separately from role", () => {
	const spans = ansiToSpans("\x1b[1;36maccent\x1b[22m still-accent\x1b[0m");
	assert.deepEqual(spans, [
		{ text: "accent", role: "accent", bold: true },
		{ text: " still-accent", role: "accent" },
	]);
});

test("bright variants share base roles; bg and style codes are dropped", () => {
	const spans = ansiToSpans("\x1b[93mW\x1b[41m!\x1b[49m?\x1b[3mI");
	assert.deepEqual(spans, [
		{ text: "W", role: "warning" },
		{ text: "!" , role: "warning" },
		{ text: "?", role: "warning" },
		{ text: "I", role: "warning" },
	]);
});

test("OSC sequences are stripped entirely", () => {
	const spans = ansiToSpans("x\x1b]8;;https://e\x07link\x1b]8;;\x07y");
	assert.deepEqual(spans, [{ text: "xlinky" }]);
});

test("non-SGR CSI and C0 controls are stripped", () => {
	const spans = ansiToSpans("a\x1b[2Kb\x00c\x1b[Hd");
	assert.deepEqual(spans, [{ text: "abcd" }]);
});

test("inverse video maps to selected role", () => {
	const spans = ansiToSpans("\x1b[7m \x1b[27m");
	assert.deepEqual(spans, [{ text: " ", role: "selected" }]);
});

test("ansiToFrame maps every line", () => {
	assert.deepEqual(ansiToFrame(["a", "\x1b[32mb"]), [
		[{ text: "a" }],
		[{ text: "b", role: "success" }],
	]);
});
