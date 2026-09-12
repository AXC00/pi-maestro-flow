import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Package-level wiring for the Multi-Device Fabric.
 *
 * These assertions read the real manifests and the real source graph rather than
 * restating the intended layering: a declaration that no longer matches the
 * package is exactly the failure a describe-only test cannot catch.
 */

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = resolve(packageRoot, "..", "..");

interface Manifest {
  name?: string;
  main?: string;
  exports?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const PACKAGES = {
  fabricCore: resolve(repositoryRoot, "packages", "pi-maestro-fabric-core"),
  fabric: resolve(repositoryRoot, "packages", "pi-maestro-fabric"),
  backends: resolve(repositoryRoot, "packages", "pi-maestro-backends"),
  flow: resolve(repositoryRoot, "packages", "pi-maestro-flow"),
} as const;

const CORE_REQUEST = "pi-maestro-fabric-core/v1";

function manifest(root: string): Manifest {
  return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as Manifest;
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && /\.(?:ts|mts)$/u.test(entry.name)) {
        files.push(path);
      }
    }
  };
  walk(resolve(root, "src"));
  return files;
}

test("every declared export of every Fabric-relevant package resolves to a real file", () => {
  for (const [label, root] of Object.entries(PACKAGES)) {
    const declared = manifest(root);
    assert.ok(declared.exports !== undefined, `${label} declares no subpath exports`);
    for (const [subpath, target] of Object.entries(declared.exports)) {
      if (target.includes("*")) {
        // A wildcard export resolves only while its literal prefix exists.
        const prefix = target.slice(0, target.indexOf("*"));
        assert.ok(existsSync(resolve(root, prefix)), `${label} export ${subpath} has no resolvable prefix ${prefix}`);
        continue;
      }
      assert.ok(existsSync(resolve(root, target)), `${label} export ${subpath} points at missing ${target}`);
    }
    // pi-maestro-flow is a `bin`/subpath package with no bare entry, so only a
    // declared main is checked.
    if (declared.main !== undefined) {
      assert.ok(existsSync(resolve(root, declared.main)), `${label} main ${declared.main} is missing`);
      assert.equal(declared.main, declared.exports["."], `${label} main and "." export must be the same module`);
    }
  }
});

test("the Fabric packages depend on nothing they are meant to stay independent of", () => {
  const core = manifest(PACKAGES.fabricCore);
  // fabric-core is the frozen contract layer: depending on a runtime package
  // would make every consumer inherit that package's install graph.
  assert.deepEqual(core.dependencies ?? {}, {}, "pi-maestro-fabric-core must have no runtime dependencies");

  const fabric = manifest(PACKAGES.fabric);
  assert.deepEqual(fabric.dependencies ?? {}, { "pi-maestro-fabric-core": "0.1.0" });

  for (const [label, declared] of [["pi-maestro-fabric-core", core], ["pi-maestro-fabric", fabric]] as const) {
    const declaredRuntime = {
      ...declared.dependencies,
      ...declared.peerDependencies,
      ...declared.optionalDependencies,
    };
    for (const forbidden of ["pi-maestro-flow", "pi-maestro-teammate", "pi-maestro-backends", "@modelcontextprotocol/sdk"]) {
      assert.equal(
        Object.hasOwn(declaredRuntime, forbidden),
        false,
        `${label} must not depend on ${forbidden}: the Fabric kernel is host-independent`,
      );
    }
  }
});

/** Every name a module's public entry re-exports, following `export *` transitively. */
function exportedNames(entry: string): Set<string> {
  const names = new Set<string>();
  const visited = new Set<string>();
  const visit = (file: string): void => {
    const absolute = resolve(file);
    if (visited.has(absolute)) return;
    visited.add(absolute);
    const source = readFileSync(absolute, "utf8");
    for (const match of source.matchAll(/export\s+\*\s+from\s+["']([^"']+)["']/g)) {
      visit(resolve(dirname(absolute), match[1]!));
    }
    for (const match of source.matchAll(/export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g)) {
      names.add(match[1]!);
    }
    for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
      for (const binding of match[1]!.split(",")) {
        const name = binding.trim().replace(/^type\s+/u, "").split(/\s+as\s+/).pop()?.trim();
        if (name) names.add(name);
      }
    }
  };
  visit(entry);
  return names;
}

/** Named bindings each consumer imports from the Fabric contract package. */
function coreImports(root: string): Map<string, Set<string>> {
  const bySpecifier = new Map<string, Set<string>>();
  for (const file of sourceFiles(root)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/import\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*["'](pi-maestro-fabric-core[^"']*)["']/g)) {
      const specifier = match[2]!;
      const names = bySpecifier.get(specifier) ?? new Set<string>();
      for (const binding of match[1]!.split(",")) {
        const name = binding.trim().replace(/^type\s+/u, "").split(/\s+as\s+/)[0]?.trim();
        if (name) names.add(name);
      }
      bySpecifier.set(specifier, names);
    }
  }
  return bySpecifier;
}

test("fabric-core's public entry exports every contract its consumers import", () => {
  const publicEntry = exportedNames(resolve(PACKAGES.fabricCore, "src", "index.ts"));
  const publicV1 = exportedNames(resolve(PACKAGES.fabricCore, "src", "public", "v1", "index.ts"));
  assert.deepEqual([...publicV1].sort(), [...publicEntry].sort(), "the package main must be the public v1 entry");

  const consumers = [PACKAGES.fabric, PACKAGES.backends, PACKAGES.flow] as const;
  let checked = 0;
  for (const root of consumers) {
    for (const [specifier, names] of coreImports(root)) {
      const target = specifier === CORE_REQUEST
        ? resolve(PACKAGES.fabricCore, "src", "public", "v1", "index.ts")
        : resolve(PACKAGES.fabricCore, "src", "public", "v1", `${specifier.slice(`${CORE_REQUEST}/`.length)}.ts`);
      assert.ok(existsSync(target), `${root} imports ${specifier}, which is not a fabric-core v1 module`);
      const available = exportedNames(target);
      for (const name of names) {
        checked += 1;
        assert.ok(
          available.has(name),
          `${root} imports ${name} from ${specifier}, but fabric-core does not export it`,
        );
      }
    }
  }
  // A scan that found nothing would pass vacuously.
  assert.ok(checked > 100, `expected the consumers to import the phase 3-6 contracts, found ${checked} bindings`);
});

/** Mirror of packages/pi-maestro-fabric/test/public-api.test.ts, kept honest by re-deriving the graph. */
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
      const specifier = match[2]!;
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

test("pi-maestro-fabric's public runtime graph still admits only pi-maestro-fabric-core/v1", () => {
  const graph = runtimeGraph(resolve(PACKAGES.fabric, "src", "index.ts"));
  assert.deepEqual([...graph.externals], [CORE_REQUEST]);
});
