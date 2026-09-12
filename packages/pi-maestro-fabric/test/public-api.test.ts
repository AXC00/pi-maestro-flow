import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = resolve(packageRoot, "src");
const publicFiles = [
  "index.ts",
  "directory.ts",
  "transport-registry.ts",
  "connection-manager.ts",
  "admission-manager.ts",
  "store-coordinator.ts",
  "presence-manager.ts",
  "invocation-manager.ts",
  "fixed-ssh-channel.ts",
  "stream-channel.ts",
  "channel-router.ts",
  "mcp-mount-provider.ts",
  "outbound-wss-transport.ts",
  "edge-relay-transport.ts",
];
const runtimeFiles = [...publicFiles, "directory-authority.ts"];

function runtimeGraph(entry: string): { modules: Set<string>; externals: Set<string> } {
  const modules = new Set<string>();
  const externals = new Set<string>();
  const visit = (file: string): void => {
    const absolute = resolve(file);
    if (modules.has(absolute)) return;
    modules.add(absolute);
    const source = readFileSync(absolute, "utf8");
    const statement = /(?:^|\n)[ \t]*(?:import|export)[ \t]+(type[ \t]+)?(?:\{[^}]*\}|[^;\n{]*?)[ \t]*from[ \t]*["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = statement.exec(source))) {
      if (match[1]) continue;
      const specifier = match[2];
      if (!specifier.startsWith(".")) {
        externals.add(specifier);
      } else {
        visit(resolve(dirname(absolute), specifier));
      }
    }
  };
  visit(entry);
  return { modules, externals };
}

test("every runtime module is explicitly exported", () => {
  const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
    exports?: Record<string, string>;
  };
  const exports = new Set(Object.values(packageJson.exports ?? {}));
  for (const file of publicFiles) {
    assert.ok(exports.has(`./src/${file}`), `${file} is missing a package export`);
  }
});

test("runtime dependency is exactly fabric-core 0.1.0", () => {
  const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.deepEqual(packageJson.dependencies, { "pi-maestro-fabric-core": "0.1.0" });
});

test("public runtime graph imports only fabric-core and local modules", () => {
  const graph = runtimeGraph(resolve(sourceRoot, "index.ts"));
  assert.deepEqual([...graph.externals], ["pi-maestro-fabric-core/v1"]);
  assert.equal(graph.modules.size, runtimeFiles.length);
});

test("package contains no Flow, teammate package, MCP UI, or dynamic discovery imports", () => {
  for (const file of runtimeFiles) {
    const source = readFileSync(resolve(sourceRoot, file), "utf8");
    const importSpecifiers = [...source.matchAll(/(?:from|import\s*)\s*["']([^"']+)["']/g)].map((match) => match[1]);
    assert.equal(importSpecifiers.some((specifier) => /pi-maestro-(?:flow|teammate)|modelcontextprotocol|mcp-ui/i.test(specifier)), false, file);
    assert.equal(importSpecifiers.some((specifier) => /node:(?:fs|module)|import-meta-resolve/.test(specifier)), false, file);
  }
});
