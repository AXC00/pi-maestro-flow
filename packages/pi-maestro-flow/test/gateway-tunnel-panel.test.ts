import assert from "node:assert/strict";
import test from "node:test";
import { GatewayTunnelPanel, gatewayTunnelProfilesPatch, gatewayTunnelReadiness } from "../src/tui/gateway-tunnel-panel.ts";
import type { GatewayControlClient } from "../src/gateway/control-client.ts";
import { GatewayTunnelManager, type GatewayTunnelDoctorReport } from "../src/gateway/tunnel/provider.ts";
import type { GatewayTunnelProvider } from "../src/gateway/tunnel/contracts.ts";
import type { GatewayTunnelProfileConfig } from "../src/gateway/config.ts";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeGatewayConfigPatch, loadGatewayConfigSync, restoreGatewayConfigIfCurrent, writeGatewayConfigPatchIfCurrent, GatewayConfigConflictError } from "../src/gateway/config.ts";
import { main } from "../src/gateway/cli.ts";

const profile: GatewayTunnelProfileConfig = {
  id: "cloudflare-main",
  provider: "cloudflare",
  mode: "named",
  lifecycle: "persistent",
  enabled: false,
  publicUrl: "https://example.test",
  tunnelId: "opaque-config-id",
  tokenFile: "C:/private/token",
  mcpAccess: { enabled: false, actions: [], auth: { kind: "gateway" } },
};

const doctor: GatewayTunnelDoctorReport = {
  ok: true,
  bounded: true,
  sideEffects: false,
  profiles: [{ profile: profile.id, provider: "cloudflare", mode: "named", lifecycle: "persistent", enabled: false, phase: "stopped", readiness: false, stateOnly: true }],
};

test("tunnel panel renders layered safe descriptor without tunnel IDs or secrets", () => {
  const panel = new GatewayTunnelPanel({ requestRender() {}, close() {}, initialProfiles: [profile], initialDoctor: doctor });
  const rendered = panel.render(200).join("\n");
  assert.match(rendered, /fixed/u);
  assert.match(rendered, /MCP URL: https:\/\/example\.test\/mcp/u);
  assert.match(rendered, /provider: not ready/u);
  assert.match(rendered, /remote authorization E2E/u);
  assert.doesNotMatch(rendered, /opaque-config-id|C:\/private\/token/u);
  assert.equal(typeof panel.render, "function");
});

test("profile patch replaces complete profiles and preserves disabled-by-default policy", () => {
  const patch = gatewayTunnelProfilesPatch([profile]);
  assert.deepEqual((patch.tunnels as { profiles: GatewayTunnelProfileConfig[] }).profiles, [profile]);
  assert.equal(profile.enabled, false);
  const descriptor = { profile: profile.id, provider: "cloudflare", mode: "named", fixed: true as const, authKind: "gateway" as const, enabled: false, phase: "stopped" as const, generation: 0, readiness: false, mcpUrl: "https://example.test/mcp", publicOrigin: "https://example.test" };
  assert.deepEqual(gatewayTunnelReadiness(profile, descriptor), { provider: "unknown", mcp: "not-ready", remoteAuthorizationE2E: "not-ready" });
});

test("persistent switch synchronizes OAuth URL and restarts online daemon", async () => {
  const configPath = join(mkdtempSync(join(tmpdir(), "gateway-panel-")), "config.yaml");
  const profiles: GatewayTunnelProfileConfig[] = [
    { id: "old", provider: "cloudflare", mode: "named", lifecycle: "persistent", enabled: true, publicUrl: "https://old.test", tunnelId: "old", tokenFile: "/tmp/old" },
    { id: "new", provider: "cloudflare", mode: "named", lifecycle: "persistent", enabled: false, publicUrl: "https://new.test", tunnelId: "new", tokenFile: "/tmp/new" },
  ];
  await writeGatewayConfigPatch(configPath, { auth: { mode: "oauth", oauth: { server_url: "https://old.test" } }, tunnels: { profiles: profiles.map((profile) => ({ ...profile, enabled: false })) } });
  await writeGatewayConfigPatch(configPath, { tunnels: { profiles } });
  const calls: string[] = [];
  const client = { status: async () => ({ online: true }), tunnelProfileStop: async (id: string) => { calls.push(`stop:${id}`); }, tunnelProfileStart: async (id: string) => { calls.push(`start:${id}`); }, restart: async () => { calls.push("restart"); } } as unknown as GatewayControlClient;
  const panel = new GatewayTunnelPanel({ configPath, initialProfiles: profiles, requestRender() {}, close() {}, createControlClient: () => client });
  panel.handleInput("j");
  await panel.switchSelected(true);
  assert.deepEqual(calls, ["stop:old", "restart", "start:new"]);
  assert.equal(loadGatewayConfigSync(configPath).auth.oauth?.serverUrl, "https://new.test");
  assert.deepEqual(loadGatewayConfigSync(configPath).tunnels.profiles.map((profile) => [profile.id, profile.enabled]), [["old", false], ["new", true]]);
});

test("online save rejects policy changes before writing stale daemon state", async () => {
  const configPath = join(mkdtempSync(join(tmpdir(), "gateway-panel-")), "config.yaml");
  const original: GatewayTunnelProfileConfig = { id: "profile", provider: "cloudflare", mode: "named", lifecycle: "persistent", enabled: false, publicUrl: "https://example.test", tunnelId: "p", tokenFile: "/tmp/p" };
  await writeGatewayConfigPatch(configPath, { tunnels: { profiles: [original] } });
  const client = { status: async () => ({ online: true }) } as unknown as GatewayControlClient;
  const panel = new GatewayTunnelPanel({ configPath, initialProfiles: [original], requestRender() {}, close() {}, createControlClient: () => client });
  panel.setMcpAccessPolicy(original.id, { enabled: true, actions: [], auth: { kind: "gateway" } });
  const before = readFileSync(configPath, "utf8");
  await panel.save();
  assert.equal(readFileSync(configPath, "utf8"), before);
});

test("Enter reaches structured add editor and cancellation does not write", async () => {
  let prompts = 0;
  const panel = new GatewayTunnelPanel({
    requestRender() {}, close() {}, initialProfiles: [],
    input: async () => { prompts++; return prompts === 1 ? JSON.stringify({ id: "quick", provider: "cloudflare", mode: "quick", lifecycle: "ephemeral" }) : undefined; },
  });
  panel.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(panel.getProfiles()[0]?.id, "quick");
  panel.handleInput("\r");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(panel.getProfiles().length, 1);
});

test("Quick e/x are transient and x stops despite disabled desired state", async () => {
  const calls: string[] = [];
  const client = { tunnelProfileStart: async (id: string) => { calls.push(`start:${id}`); }, tunnelProfileStop: async (id: string) => { calls.push(`stop:${id}`); } } as unknown as GatewayControlClient;
  const quick: GatewayTunnelProfileConfig = { id: "quick", provider: "cloudflare", mode: "quick", lifecycle: "ephemeral", enabled: false };
  const panel = new GatewayTunnelPanel({ requestRender() {}, close() {}, initialProfiles: [quick], createControlClient: () => client });
  await panel.switchSelected(true);
  await panel.switchSelected(false);
  assert.deepEqual(calls, ["start:quick", "stop:quick"]);
  assert.equal(panel.getProfiles()[0]?.enabled, false);
});

test("structured editor canonicalizes snake aliases and rejects conflicts", async () => {
  const configPath = join(mkdtempSync(join(tmpdir(), "gateway-panel-")), "config.yaml");
  await writeGatewayConfigPatch(configPath, { tunnels: { profiles: [profile] } });
  const inputs = [JSON.stringify({ public_url: "https://canonical.test" }), JSON.stringify({ publicUrl: "https://a.test", public_url: "https://b.test" })];
  const panel = new GatewayTunnelPanel({ configPath, initialProfiles: [profile], requestRender() {}, close() {}, input: async () => inputs.shift() });
  panel.handleInput("\r"); await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(panel.getProfiles()[0]?.publicUrl, "https://canonical.test");
  await panel.save();
  assert.equal(loadGatewayConfigSync(configPath).tunnels.profiles[0]?.publicUrl, "https://canonical.test");
  panel.handleInput("\r"); await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(panel.render(200).join("\n"), /编辑失败/u);
});

test("config CAS rejects stale writers and protects newer rollback", async () => {
  const configPath = join(mkdtempSync(join(tmpdir(), "gateway-panel-")), "config.yaml");
  const first = await writeGatewayConfigPatch(configPath, { tunnels: { profiles: [profile] } });
  await writeGatewayConfigPatch(configPath, { auth: { mode: "open" } });
  await assert.rejects(() => writeGatewayConfigPatchIfCurrent(configPath, first.raw, { auth: { mode: "open" } }), GatewayConfigConflictError);
  const current = readFileSync(configPath, "utf8");
  await writeGatewayConfigPatch(configPath, { auth: { mode: "oauth", oauth: { server_url: "https://new.test" } } });
  await assert.rejects(() => restoreGatewayConfigIfCurrent(configPath, current, first.raw), GatewayConfigConflictError);
  assert.match(readFileSync(configPath, "utf8"), /new\.test/u);
});

test("panel status sanitizes terminal controls and late callbacks after dispose", async () => {
  let renders = 0;
  let resolveInput: ((value: string | undefined) => void) | undefined;
  const panel = new GatewayTunnelPanel({ requestRender() { renders++; }, close() {}, initialProfiles: [profile], input: async () => new Promise((resolve) => { resolveInput = resolve; }) });
  panel.handleInput("\r"); panel.dispose(); resolveInput?.("\x1b]8;;evil\x07\nline"); await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(renders, 0);
  const rendered = panel.render(20).join("\n");
  assert.ok(!rendered.includes("\x1b]8"));
  assert.ok(!rendered.includes("\nline"));
});

test("doctor control seam is read-only and reports sideEffects false", async () => {
  let renders = 0;
  const client = { tunnelDoctor: async () => doctor } as unknown as GatewayControlClient;
  const panel = new GatewayTunnelPanel({ requestRender() { renders++; }, close() {}, initialProfiles: [profile], createControlClient: () => client });
  const result = await panel.doctorNow();
  assert.equal(result.sideEffects, false);
  assert.ok(renders > 0);
});

test("manager doctor is bounded state-only and never invokes provider doctor", async () => {
  let providerDoctorCalls = 0;
  const provider: GatewayTunnelProvider = {
    name: "fake",
    async doctor() { providerDoctorCalls += 1; return { ok: true }; },
    async start() { return { pid: 1, executablePath: "fake" , args: [] }; },
    async probe() { return { ready: false, terminal: true }; },
    async stop() {},
  };
  const manager = new GatewayTunnelManager({ providers: [provider], profiles: [{ id: "fake-profile", provider: "fake", lifecycle: "persistent", enabled: true, input: {} }] });
  const result = await manager.doctor();
  assert.equal(providerDoctorCalls, 0);
  assert.equal(result.bounded, true);
  assert.equal(result.sideEffects, false);
});

test("CLI tunnel doctor uses the local control seam and emits bounded JSON", async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = "";
  let errors = "";
  stdout.on("data", (chunk) => { output += chunk.toString(); });
  stderr.on("data", (chunk) => { errors += chunk.toString(); });
  const client = { tunnelDoctor: async () => doctor } as unknown as GatewayControlClient;
  const code = await main(["tunnel", "doctor", "--json"], { stdout, stderr, createControlClient: () => client });
  assert.equal(code, 0, errors);
  assert.equal(JSON.parse(output).sideEffects, false);
});

test("save creates a missing config file for an empty tunnel page", async () => {
  const configPath = join(mkdtempSync(join(tmpdir(), "gateway-panel-")), "config.yaml");
  const panel = new GatewayTunnelPanel({ configPath, requestRender() {}, close() {}, initialProfiles: [] });
  panel.addProfile({ id: "quick", provider: "cloudflare", mode: "quick", lifecycle: "ephemeral", enabled: true });
  await panel.save();
  const saved = loadGatewayConfigSync(configPath);
  assert.deepEqual(saved.tunnels.profiles.map((profile) => [profile.id, profile.enabled]), [["quick", false]]);
});
