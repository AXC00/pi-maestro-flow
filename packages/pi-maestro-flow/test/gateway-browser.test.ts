import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultGatewayConfig, normalizeGatewayConfig } from "../src/gateway/config.ts";
import { createGatewayPrincipal } from "../src/gateway/principal.ts";
import { GatewayPolicy } from "../src/gateway/policy.ts";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import { GatewayBrowserService } from "../src/gateway/services/browser-service.ts";
import type {
  BrowserManagerLike,
  BrowserManagerStatus,
  BrowserOpenOptions,
  BrowserRunOutput,
  BrowserTabInfo,
} from "../src/tools/browser/manager.ts";

class FakeBrowserManager implements BrowserManagerLike {
  readonly tabs = new Map<string, BrowserTabInfo>();
  readonly opened: BrowserOpenOptions[] = [];
  readonly closed: string[] = [];
  readonly closeFailures = new Set<string>();
  openGate: Promise<void> | undefined;
  runGate: Promise<void> | undefined;
  lastMaxOutputBytes: number | undefined;

  async open(options: BrowserOpenOptions): Promise<BrowserTabInfo> {
    this.opened.push(options);
    await this.openGate;
    const existing = this.tabs.get(options.name);
    if (existing) return { ...existing, reused: true };
    const channel = options.channel ?? "managed";
    const info: BrowserTabInfo = {
      name: options.name,
      kind: channel === "managed" ? options.visible ? "headed" : "headless" : channel === "extension" ? "extension" : "connected",
      connection: {
        channel,
        ownership: channel === "managed" ? "owned" : "borrowed",
        capabilities: { page: true, cdp: true, cookies: true },
      },
      url: options.url ?? "about:blank",
      title: "Fake browser",
      reused: false,
      viewport: options.viewport ? { width: options.viewport.width, height: options.viewport.height, deviceScaleFactor: options.viewport.scale } : undefined,
    };
    this.tabs.set(options.name, info);
    return info;
  }

  async run(name: string, code: string, _cwd: string, _signal: AbortSignal | undefined, _timeoutMs: number, maxOutputBytes?: number): Promise<BrowserRunOutput> {
    this.lastMaxOutputBytes = maxOutputBytes;
    await this.runGate;
    const tab = this.tabs.get(name);
    if (!tab) throw new Error("missing fake tab");
    const url = code.includes("navigate") ? "https://example.com/next" : tab.url;
    this.tabs.set(name, { ...tab, url });
    return {
      displays: [{ type: "text", text: "ran" }],
      returnValue: { ok: true },
      screenshots: [],
      url,
      ...(url === tab.url ? {} : { navigated: true }),
    };
  }

  async status(): Promise<BrowserManagerStatus> {
    return {
      bridge: { serverStarted: false, state: "stopped", listeningPort: null, authenticatedConnected: false, tabCount: 0, pendingPairings: [], drainingCommands: 0 },
      namedTabs: [...this.tabs.values()].map((tab) => ({ name: tab.name, channel: tab.connection.channel, ownership: tab.connection.ownership, capabilities: tab.connection.capabilities })),
    };
  }

  async pair(requestId: string, code: string) {
    return { requestId, port: 19222, installationId: `pair-${code}` };
  }

  async close(name: string): Promise<boolean> {
    this.closed.push(name);
    if (this.closeFailures.has(name)) throw new Error("fake close failed");
    return this.tabs.delete(name);
  }

  async closeAll(): Promise<number> {
    const count = this.tabs.size;
    this.tabs.clear();
    return count;
  }
}

function principal(id: string, workspace: string) {
  return createGatewayPrincipal("stdio", id, { authenticated: true, workspacePath: workspace });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("Gateway browser config defaults to full channels and validates explicit bounds", () => {
  assert.deepEqual(defaultGatewayConfig().security.browser, {
    enabled: true,
    allowedChannels: ["managed", "profile", "cdp", "extension"],
    allowedOrigins: [],
    maxTabsPerPrincipal: 8,
  });
  const browser = normalizeGatewayConfig({ security: { browser: {
    enabled: true,
    allowed_channels: ["managed", "profile"],
    allowed_origins: ["https://example.com"],
    max_tabs_per_principal: 3,
  } } }).security.browser;
  assert.deepEqual(browser, {
    enabled: true,
    allowedChannels: ["managed", "profile"],
    allowedOrigins: ["https://example.com"],
    maxTabsPerPrincipal: 3,
  });
  assert.throws(() => normalizeGatewayConfig({ security: { browser: { allowed_channels: ["unknown"] } } }), /unsupported channel/);
  assert.throws(() => normalizeGatewayConfig({ security: { browser: { allowed_origins: ["https://example.com/path"] } } }), /exact HTTP\(S\) origin/);
  assert.throws(() => normalizeGatewayConfig({ security: { browser: { max_tabs_per_principal: 33 } } }), /maxTabsPerPrincipal/);
});

test("Gateway browser service isolates tabs by principal and workspace and enforces policy", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-browser-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new FakeBrowserManager();
  const policy = new GatewayPolicy({ workspaceRoot: root });
  const service = new GatewayBrowserService({
    policy,
    manager,
    security: { enabled: true, allowedChannels: ["managed"], allowedOrigins: [], maxTabsPerPrincipal: 1 },
  });
  const first = principal("first", root);
  const second = principal("second", root);

  assert.deepEqual(((await service.handle(second, { action: "status" })).data as { tabs: unknown[] }).tabs, []);
  const opened = await service.handle(first, { action: "open", name: "main", url: "https://example.com/start" });
  assert.equal(opened.ok, true);
  assert.notEqual(manager.opened[0]?.name, "main", "public names must not be used as cross-principal manager keys");
  assert.equal(manager.opened[0]?.isolationKey, manager.opened[0]?.name, "managed profile keys must include the isolated manager name");
  assert.equal((await service.handle(first, { action: "open", name: "extra", url: "https://example.com" })).error?.code, "browser_tab_limit");
  assert.equal((await service.handle(second, { action: "run", name: "main", code: "return 1" })).error?.code, "not_found");

  assert.equal((await service.handle(second, { action: "open", name: "main", url: "https://example.com" })).ok, true);
  assert.notEqual(manager.opened[0]?.isolationKey, manager.opened[1]?.isolationKey, "two principals must use different physical managed profiles");
  const ran = await service.handle(first, { action: "run", name: "main", code: "navigate" });
  assert.equal(ran.ok, true);
  assert.equal((ran.data as { url: string }).url, "https://example.com/next");
  assert.equal(manager.lastMaxOutputBytes, policy.limits.maxOutputBytes);
  assert.equal(((await service.handle(first, { action: "status" })).data as { tabs: Array<{ name: string; url: string }> }).tabs[0]?.name, "main");

  assert.equal((await service.handle(second, { action: "open", name: "scheme", url: "file:///secret" })).error?.code, "browser_url_denied");
  const anonymous = createGatewayPrincipal("http", "anonymous", { authenticated: false, scopes: ["gateway"], workspacePath: root });
  assert.equal((await service.handle(anonymous, { action: "status" })).error?.code, "authentication_required");

  const restrictedManager = new FakeBrowserManager();
  const restricted = new GatewayBrowserService({
    policy,
    manager: restrictedManager,
    security: { enabled: true, allowedChannels: ["managed"], allowedOrigins: ["https://example.com"], maxTabsPerPrincipal: 1 },
  });
  assert.equal((await restricted.handle(first, { action: "open", url: "https://example.com" })).ok, true);
  assert.equal((await restricted.handle(first, { action: "run", code: "return location.href" })).error?.code, "browser_run_origin_policy_conflict");
  assert.equal((await restricted.handle(second, { action: "open", url: "https://denied.example" })).error?.code, "browser_url_denied");

  assert.equal(((await service.handle(first, { action: "close", all: true })).data as { closed: number }).closed, 1);
  assert.equal(((await service.handle(second, { action: "close", all: true })).data as { closed: number }).closed, 1);
  await restricted.shutdown();
  await service.shutdown();
});

test("Gateway browser scope includes canonical path when configured workspace IDs collide", async (t) => {
  const firstRoot = await mkdtemp(join(tmpdir(), "gateway-browser-scope-a-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "gateway-browser-scope-b-"));
  t.after(async () => { await rm(firstRoot, { recursive: true, force: true }); await rm(secondRoot, { recursive: true, force: true }); });
  const manager = new FakeBrowserManager();
  const service = new GatewayBrowserService({
    policy: new GatewayPolicy({ workspaces: [{ path: firstRoot, id: "duplicate" }, { path: secondRoot, id: "duplicate" }] }),
    manager,
    security: { enabled: true, allowedChannels: ["managed"], allowedOrigins: [], maxTabsPerPrincipal: 2 },
  });
  const owner = createGatewayPrincipal("stdio", "multi-workspace", { authenticated: true });

  assert.equal((await service.handle(owner, { action: "open", workspace: firstRoot, name: "main" })).ok, true);
  assert.equal((await service.handle(owner, { action: "open", workspace: secondRoot, name: "main" })).ok, true);
  assert.notEqual(manager.opened[0]?.name, manager.opened[1]?.name);
  assert.equal(((await service.handle(owner, { action: "status", workspace: firstRoot })).data as { tabs: unknown[] }).tabs.length, 1);
  assert.equal(((await service.handle(owner, { action: "status", workspace: secondRoot })).data as { tabs: unknown[] }).tabs.length, 1);
  await service.shutdown();
});

test("Gateway browser exposes guide, pairing, bridge status, and every configured channel", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-browser-full-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new FakeBrowserManager();
  let bridgeShutdowns = 0;
  const service = new GatewayBrowserService({
    policy: new GatewayPolicy({ workspaceRoot: root }),
    manager,
    security: { enabled: true, allowedChannels: ["managed", "profile", "cdp", "extension"], allowedOrigins: [], maxTabsPerPrincipal: 8 },
    shutdownBridge: async () => { bridgeShutdowns += 1; },
  });
  const owner = principal("full-owner", root);

  const guide = await service.handle(owner, { action: "guide" });
  assert.match((guide.data as { content: string }).content, /Gateway Browser SOP Registry/);
  const core = await service.handle(owner, { action: "guide", topic: "core" });
  assert.match((core.data as { content: string }).content, /CHANNEL \/ VISIBILITY \/ OWNERSHIP/);
  const status = await service.handle(owner, { action: "status" });
  assert.deepEqual((status.data as { bridge: { serverStarted: boolean } }).bridge.serverStarted, false);
  const paired = await service.handle(owner, { action: "pair", pairingRequestId: "pending-1", code: "123456" });
  assert.equal((paired.data as { approval: { requestId: string } }).approval.requestId, "pending-1");

  assert.equal((await service.handle(owner, {
    action: "open", name: "managed", url: "https://example.com", app: { path: "chrome", args: ["--flag"] },
  })).ok, true);
  assert.equal((await service.handle(owner, {
    action: "open", name: "profile", app: { channel: "profile", attach_user_profile: true, user_profile_dir: "C:/profile" }, visible: true,
  })).ok, true);
  assert.equal((await service.handle(owner, {
    action: "open", name: "cdp", app: { channel: "cdp", cdp_url: "http://127.0.0.1:9222", target: "docs" },
  })).ok, true);
  assert.equal((await service.handle(owner, {
    action: "open", name: "extension", url: "https://example.com", app: { channel: "extension" },
  })).ok, true);
  assert.deepEqual(manager.opened.map((options) => options.channel), ["managed", "profile", "cdp", "extension"]);
  assert.equal(manager.opened[0]?.isolationKey, manager.opened[0]?.name);
  assert.deepEqual(manager.opened.slice(1).map((options) => options.isolationKey), [undefined, undefined, undefined]);
  assert.equal(manager.opened[0]?.executablePath, "chrome");
  assert.deepEqual(manager.opened[0]?.args, ["--flag"]);
  assert.equal(manager.opened[1]?.userProfileDir, "C:/profile");
  assert.equal(manager.opened[2]?.cdpUrl, "http://127.0.0.1:9222");
  assert.equal(manager.opened[2]?.target, "docs");

  assert.equal(((await service.handle(owner, { action: "close", all: true })).data as { closed: number }).closed, 4);
  await service.shutdown();
  assert.equal(bridgeShutdowns, 1);
});

test("Gateway browser reserves concurrent slots, fences late opens, and retains failed closes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-browser-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = principal("owner", root);

  const limitedManager = new FakeBrowserManager();
  const gate = deferred();
  limitedManager.openGate = gate.promise;
  const limited = new GatewayBrowserService({
    policy: new GatewayPolicy({ workspaceRoot: root }),
    manager: limitedManager,
    security: { enabled: true, allowedChannels: ["managed"], allowedOrigins: [], maxTabsPerPrincipal: 1 },
  });
  assert.equal((await limited.handle(owner, { action: "open", name: "invalid", timeoutMs: 0 })).error?.code, "invalid_input");
  const firstOpen = limited.handle(owner, { action: "open", name: "first" });
  assert.equal((await limited.handle(owner, { action: "open", name: "second" })).error?.code, "browser_tab_limit");
  gate.resolve();
  assert.equal((await firstOpen).ok, true);
  const runGate = deferred();
  limitedManager.runGate = runGate.promise;
  const running = limited.handle(owner, { action: "run", name: "first", code: "return true" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await limited.handle(owner, { action: "open", name: "first" })).error?.code, "browser_tab_busy");
  assert.equal((await limited.handle(owner, { action: "close", all: true })).error?.code, "browser_tab_busy");
  runGate.resolve();
  assert.equal((await running).ok, true);
  const internalName = limitedManager.opened[0]!.name;
  limitedManager.closeFailures.add(internalName);
  assert.equal((await limited.handle(owner, { action: "close", all: true })).error?.code, "browser_action_failed");
  assert.equal(((await limited.handle(owner, { action: "status" })).data as { tabs: unknown[] }).tabs.length, 1, "failed close must retain ownership for retry");
  limitedManager.closeFailures.clear();
  assert.equal((await limited.handle(owner, { action: "close", all: true })).ok, true);
  await limited.shutdown();

  const lateManager = new FakeBrowserManager();
  const lateGate = deferred();
  lateManager.openGate = lateGate.promise;
  const late = new GatewayBrowserService({
    policy: new GatewayPolicy({ workspaceRoot: root }),
    manager: lateManager,
    security: { enabled: true, allowedChannels: ["managed"], allowedOrigins: [], maxTabsPerPrincipal: 1 },
  });
  const lateOpen = late.handle(owner, { action: "open", name: "late" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lateManager.opened.length, 1);
  const shuttingDown = late.shutdown();
  lateGate.resolve();
  assert.equal((await lateOpen).status, "cancelled");
  await shuttingDown;
  assert.equal(lateManager.tabs.size, 0, "late open must be closed instead of published after shutdown");

  const scopeGate = deferred();
  const delayedPolicy = new GatewayPolicy({ workspaceRoot: root });
  const authorizeWorkspace = delayedPolicy.authorizeWorkspace.bind(delayedPolicy);
  delayedPolicy.authorizeWorkspace = async (requestPrincipal, workspace) => {
    await scopeGate.promise;
    return authorizeWorkspace(requestPrincipal, workspace);
  };
  const delayed = new GatewayBrowserService({
    policy: delayedPolicy,
    manager: new FakeBrowserManager(),
    security: { enabled: true, allowedChannels: ["managed"], allowedOrigins: [], maxTabsPerPrincipal: 1 },
  });
  const pendingStatus = delayed.handle(owner, { action: "status" });
  const delayedShutdown = delayed.shutdown();
  scopeGate.resolve();
  assert.equal((await pendingStatus).error?.code, "gateway_closed");
  await delayedShutdown;
});

test("Gateway publishes browser for generic MCP and enforces action capabilities and shutdown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-browser-runtime-"));
  const manager = new FakeBrowserManager();
  const config = defaultGatewayConfig();
  config.auth = { mode: "bearer", token: "secret" };
  config.security.browser = { enabled: true, allowedChannels: ["managed", "profile", "cdp", "extension"], allowedOrigins: [], maxTabsPerPrincipal: 2 };
  const runtime = await GatewayRuntime.create({ config, cwd: root, browserManager: manager });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });

  assert.equal(runtime.catalog.list().at(-1)?.name, "browser");
  const browser = runtime.catalog.get("browser");
  const actions = (browser?.inputSchema.oneOf as Array<{ properties: { action: { const: string } } }>).map((schema) => schema.properties.action.const);
  assert.deepEqual(actions, ["guide", "status", "pair", "open", "run", "close"]);
  assert.match(browser?.description ?? "", /BEFORE browser work/);
  assert.match(browser?.description ?? "", /managed.*profile.*cdp.*extension/s);
  assert.match(browser?.description ?? "", /shell-equivalent/);
  assert.match(browser?.description ?? "", /pairingRequestId/);
  assert.match(browser?.description ?? "", /tab\.observe/);

  const statusOnly = createGatewayPrincipal("http", "status-only", { authenticated: true, scopes: ["gateway.browser.status"], workspacePath: root });
  assert.equal((await runtime.call("browser", { action: "status" }, statusOnly)).ok, true);
  assert.equal((await runtime.call("browser", { action: "open", url: "https://example.com" }, statusOnly)).error?.code, "capability_denied");
  assert.equal((await runtime.call("browser", { action: "status", unexpected: true }, statusOnly)).error?.code, "invalid_arguments");
  assert.equal((await runtime.call("browser", { action: "open", app: { channel: "cdp", cdpUrl: "http://127.0.0.1:9222" } }, statusOnly)).error?.code, "capability_denied");

  const owner = createGatewayPrincipal("http", "owner", { authenticated: true, scopes: ["gateway.browser"], workspacePath: root });
  assert.equal((await runtime.call("browser", { action: "guide", topic: "core" }, owner)).ok, true);
  assert.equal((await runtime.call("browser", { action: "pair", pairingRequestId: "pending-2", code: "654321" }, owner)).ok, true);
  assert.equal((await runtime.call("browser", { action: "open", name: "main", url: "https://example.com" }, owner)).ok, true);
  assert.equal((await runtime.call("browser", { action: "open", name: "remote", app: { channel: "cdp", cdp_url: "http://127.0.0.1:9222" } }, owner)).ok, true);
  assert.equal(manager.tabs.size, 2);
  await runtime.close();
  assert.equal(manager.tabs.size, 0, "Gateway shutdown must close only service-owned tabs");
});
