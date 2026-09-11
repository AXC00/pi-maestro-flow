import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolvePiAgentDirectory } from "../src/shared/agent-directory.ts";

const packageRoot = path.resolve(import.meta.dirname, "..");

test("Pi agent directory resolution does not require the Pi SDK", () => {
  const home = path.resolve("fixture-home");
  assert.equal(resolvePiAgentDirectory({}, home), path.join(home, ".pi", "agent"));
  assert.equal(resolvePiAgentDirectory({ PI_CODING_AGENT_DIR: "~" }, home), home);
  assert.equal(resolvePiAgentDirectory({ PI_CODING_AGENT_DIR: "~/custom" }, home), path.join(home, "custom"));
  assert.equal(resolvePiAgentDirectory({ PI_CODING_AGENT_DIR: "~\\custom" }, home), path.join(home, "custom"));
  assert.equal(
    resolvePiAgentDirectory({ PI_CODING_AGENT_DIR: "configured-agent" }, home),
    path.resolve("configured-agent"),
  );
});

test("standalone public execution surfaces load without Pi SDK value imports", () => {
  const root = mkdtempSync(path.join(tmpdir(), "teammate-sdk-boundary-"));
  const loader = path.join(root, "block-pi-sdk.mjs");
  writeFileSync(loader, `
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@earendil-works/")) {
    const error = new Error("blocked Pi SDK value import: " + specifier);
    error.code = "ERR_MODULE_NOT_FOUND";
    throw error;
  }
  return nextResolve(specifier, context);
}
`, "utf8");
  try {
    const specifiers = [
      "pi-maestro-teammate/v1/execution",
      "pi-maestro-teammate/v1/backends",
      "pi-maestro-teammate/v1/acp-cli",
    ];
    const result = spawnSync(process.execPath, [
      "--experimental-transform-types",
      "--experimental-loader",
      pathToFileURL(loader).href,
      "--input-type=module",
      "--eval",
      `await Promise.all(${JSON.stringify(specifiers)}.map((specifier) => import(specifier)));`,
    ], {
      cwd: packageRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
