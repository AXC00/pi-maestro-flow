import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  applyGatewayConfigPatch,
  defaultGatewayConfig,
  loadGatewayConfig,
} from "../src/gateway/config.ts";
import {
  applyGatewayConfigTuiValue,
  createGatewayConfigTuiDraft,
  gatewayConfigPatchFromTuiDraft,
  gatewayConfigTuiWarnings,
  renderGatewayConfigTui,
  runGatewayConfigTui,
} from "../src/gateway/config-tui.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const binary = join(packageRoot, "bin", "pi-maestro-gateway.mjs");

function capture(stream: PassThrough): () => string {
  let value = "";
  stream.on("data", (chunk) => { value += chunk.toString(); });
  return () => value;
}

function runtimeExternals(entry: string): Set<string> {
  const visited = new Set<string>();
  const externals = new Set<string>();
  const visit = (file: string): void => {
    const absolute = resolve(file);
    if (visited.has(absolute)) return;
    visited.add(absolute);
    const source = readFileSync(absolute, "utf8");
    const statement = /(?:^|\n)[ \t]*(?:import|export)[ \t]+(?:type[ \t]+)?(?:\{[^}]*\}|[^;\n{]*?)[ \t]*from[ \t]*["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = statement.exec(source))) {
      const specifier = match[1]!;
      if (!specifier.startsWith(".")) {
        externals.add(specifier);
      } else {
        visit(resolve(dirname(absolute), specifier));
      }
    }
  };
  visit(entry);
  return externals;
}

test("TUI draft emits a dirty validated patch and keeps legacy/server HTTP listeners aligned", () => {
  const original = defaultGatewayConfig();
  const baseline = createGatewayConfigTuiDraft(original);
  let draft = baseline;
  draft = applyGatewayConfigTuiValue(draft, "listenHost", "0.0.0.0");
  draft = applyGatewayConfigTuiValue(draft, "listenPort", "9191");
  draft = applyGatewayConfigTuiValue(draft, "commandDefault", "deny");
  const patch = gatewayConfigPatchFromTuiDraft(draft, baseline);
  const config = applyGatewayConfigPatch(original, patch);

  assert.equal(config.server.host, "0.0.0.0");
  assert.equal(config.server.port, 9191);
  assert.equal(config.transport.http.host, "0.0.0.0");
  assert.equal(config.transport.http.port, 9191);
  assert.equal(config.security.commands.default, "deny");
  assert.equal(patch.logging, undefined);
  assert.match(gatewayConfigTuiWarnings(draft).join("\n"), /open auth/u);
});

test("standalone TUI saves through the canonical atomic Gateway writer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-config-tui-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.yaml");
  await writeFile(configPath, "# retained\nunknown_section:\n  keep: true\n");
  const output = new PassThrough();
  const getOutput = capture(output);
  const input = Readable.from([
    "listenPort\n",
    "9191\n",
    "commandDefault\n",
    "deny\n",
    "s\n",
  ]);

  const result = await runGatewayConfigTui({ input, output, configPath, cwd: root });
  assert.equal(result.status, "saved");
  const config = await loadGatewayConfig(configPath);
  assert.equal(config.server.port, 9191);
  assert.equal(config.transport.http.port, 9191);
  assert.equal(config.security.commands.default, "deny");
  assert.match(await readFile(configPath, "utf8"), /unknown_section:\n  keep: true/u);
  assert.match(getOutput(), /已保存/u);
});

test("inherit clears an existing snake-case readonly policy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-config-tui-inherit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.yaml");
  await writeFile(configPath, "security:\n  commands:\n    auto_allow_readonly: true\n");
  await runGatewayConfigTui({
    input: Readable.from(["autoAllowReadonly\n", "inherit\n", "s\n"]),
    output: new PassThrough(),
    configPath,
    cwd: root,
  });
  assert.equal((await loadGatewayConfig(configPath)).security.commands.autoAllowReadonly, null);
  assert.doesNotMatch(await readFile(configPath, "utf8"), /auto_allow_readonly:\s*true/u);
});

test("dirty leaf save preserves a concurrent host update and touched-section comments", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-config-tui-dirty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.yaml");
  const initial = "server:\n  host: 127.0.0.1\n  port: 9090\n  trust_proxy_headers: false # keep inline\n# keep before unknown\nunknown_section:\n  keep: true\n";
  const external = "server:\n  host: 0.0.0.0 # external update\n  port: 9090\n  trust_proxy_headers: false # keep inline\n# keep before unknown\nunknown_section:\n  keep: true\n";
  await writeFile(configPath, initial);
  async function* edits() {
    yield "listenPort\n";
    yield "9191\n";
    await writeFile(configPath, external);
    yield "s\n";
  }
  await runGatewayConfigTui({
    input: Readable.from(edits()),
    output: new PassThrough(),
    configPath,
    cwd: root,
  });
  const saved = await readFile(configPath, "utf8");
  const config = await loadGatewayConfig(configPath);
  assert.equal(config.server.host, "0.0.0.0");
  assert.equal(config.server.port, 9191);
  assert.equal(config.transport.http.host, "0.0.0.0");
  assert.equal(config.transport.http.port, 9191);
  assert.match(saved, /host: 0\.0\.0\.0 # external update/u);
  assert.match(saved, /trust_proxy_headers: false # keep inline/u);
  assert.match(saved, /# keep before unknown\nunknown_section:/u);
});

test("standalone TUI cancellation writes nothing and never renders credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-config-tui-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.yaml");
  const original = "auth:\n  mode: bearer\n  token: TOP_SECRET_TOKEN\n";
  await writeFile(configPath, original);
  const output = new PassThrough();
  const getOutput = capture(output);

  const result = await runGatewayConfigTui({
    input: Readable.from(["q\n"]),
    output,
    configPath,
    cwd: root,
  });
  assert.equal(result.status, "cancelled");
  assert.equal(await readFile(configPath, "utf8"), original);
  assert.doesNotMatch(getOutput(), /TOP_SECRET_TOKEN/u);
  assert.match(getOutput(), /认证模式: bearer/u);
});

test("packaged config command runs while Pi package resolution is blocked", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-config-bin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.yaml");
  const blockerPath = join(root, "block-pi-resolution.mjs");
  await writeFile(blockerPath, [
    "export async function resolve(specifier, context, nextResolve) {",
    "  if (specifier.startsWith('@earendil-works/pi-')) throw new Error('PI_IMPORT_BLOCKED:' + specifier);",
    "  return nextResolve(specifier, context);",
    "}",
    "",
  ].join("\n"));
  const blockerUrl = pathToFileURL(blockerPath).href;
  const env = { ...process.env, HOME: root, USERPROFILE: root, NO_COLOR: "1" };
  const control = spawnSync(process.execPath, ["--experimental-loader", blockerUrl, "--input-type=module", "-e", "await import('@earendil-works/pi-tui')"], {
    cwd: packageRoot,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(control.status, 1);
  assert.match(control.stderr, /PI_IMPORT_BLOCKED:@earendil-works\/pi-tui/u);

  const result = spawnSync(process.execPath, ["--experimental-loader", blockerUrl, binary, "config", "--config", configPath], {
    cwd: packageRoot,
    env,
    input: "q\n",
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /PI_IMPORT_BLOCKED/u);
  assert.match(result.stdout, /Gateway 独立配置 TUI/u);
  assert.equal(await readFile(configPath, "utf8").catch(() => undefined), undefined);
});

test("malformed YAML diagnostics never echo credential source text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-config-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.yaml");
  await writeFile(configPath, "auth: { mode: bearer, token: SYNTHETIC_SECRET\n");
  const result = spawnSync(process.execPath, [binary, "config", "--config", configPath], {
    cwd: packageRoot,
    env: { ...process.env, HOME: root, USERPROFILE: root, NO_COLOR: "1" },
    input: "q\n",
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid config YAML/u);
  assert.doesNotMatch(result.stderr, /SYNTHETIC_SECRET/u);
});

test("standalone config graph has no Pi runtime dependency", () => {
  const externals = runtimeExternals(join(packageRoot, "src", "gateway", "config-tui.ts"));
  assert.equal([...externals].some((name) => name.startsWith("@earendil-works/pi-")), false);
  assert.ok(externals.has("node:readline"));
});

test("Pi extension registers /gateway-config as a dedicated config page", () => {
  const source = readFileSync(join(packageRoot, "src", "extension", "index.ts"), "utf8");
  assert.match(source, /registerCommand\("gateway-config"/u);
  assert.match(source, /openGatewayOverlay\(ctx, "config"\)/u);
});

test("renderer returns terminal text without secret-shaped config fields", () => {
  const text = renderGatewayConfigTui(createGatewayConfigTuiDraft(defaultGatewayConfig()), "config.yaml");
  assert.match(text, /输入编号或字段名/u);
  assert.doesNotMatch(text, /auth\.token|oauth\.password/u);
});
