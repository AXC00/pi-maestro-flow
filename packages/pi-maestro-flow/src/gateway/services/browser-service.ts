/** Principal- and workspace-isolated browser control for the Gateway. */
import { createHash, randomUUID } from "node:crypto";
import type { GatewayBrowserSecurityConfig } from "../config.ts";
import type { GatewayPrincipal, GatewayResult } from "../contracts.ts";
import { isAuthenticatedPrincipal, principalKey } from "../principal.ts";
import { GatewayPolicy, GatewayPolicyError } from "../policy.ts";
import { gatewayError, gatewayOk } from "../result.ts";
import { utf8Bytes } from "../state-paths.ts";
import {
  canonicalizeBrowserOpenOptions,
  type BrowserChannel,
  type BrowserManagerLike,
  type BrowserTabInfo,
} from "../../tools/browser/manager.ts";
import { SopRegistry } from "../../tools/sop/sop-registry.ts";
import { BROWSER_HELPER_QUICKREF, BROWSER_SOPS_BASELINE } from "../../tools/sop/embedded/browser.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BROWSER_TIMEOUT_MS = 300_000;
const DEFAULT_SECURITY: GatewayBrowserSecurityConfig = {
  enabled: true,
  allowedChannels: ["managed", "profile", "cdp", "extension"],
  allowedOrigins: [],
  maxTabsPerPrincipal: 8,
};

interface BrowserWorkspaceRequest {
  workspaceId?: string;
  workspace?: string;
  workspacePath?: string;
  requestId?: string;
}

export interface GatewayBrowserOpenRequest extends BrowserWorkspaceRequest {
  action: "open";
  name?: string;
  url?: string;
  app?: {
    path?: string;
    channel?: BrowserChannel;
    cdpUrl?: string;
    cdp_url?: string;
    args?: string[];
    target?: string;
    attachUserProfile?: boolean;
    attach_user_profile?: boolean;
    userProfileDir?: string;
    user_profile_dir?: string;
  };
  visible?: boolean;
  viewport?: { width: number; height: number; scale?: number };
  waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2";
  dialogs?: "accept" | "dismiss";
  timeoutMs?: number;
}

export interface GatewayBrowserRunRequest extends BrowserWorkspaceRequest {
  action: "run";
  name?: string;
  code: string;
  timeoutMs?: number;
}

export interface GatewayBrowserCloseRequest extends BrowserWorkspaceRequest {
  action: "close";
  name?: string;
  all?: boolean;
}

export interface GatewayBrowserStatusRequest extends BrowserWorkspaceRequest {
  action: "status";
}

export interface GatewayBrowserGuideRequest extends BrowserWorkspaceRequest {
  action: "guide";
  topic?: string;
}

export interface GatewayBrowserPairRequest extends BrowserWorkspaceRequest {
  action: "pair";
  pairingRequestId: string;
  code: string;
}

export type GatewayBrowserRequest = GatewayBrowserOpenRequest | GatewayBrowserRunRequest | GatewayBrowserCloseRequest | GatewayBrowserStatusRequest | GatewayBrowserGuideRequest | GatewayBrowserPairRequest;

interface BrowserScope {
  id: string;
  path: string;
  principal: string;
}

interface OwnedBrowserTab {
  internalName: string;
  name: string;
  scope: BrowserScope;
  info: BrowserTabInfo;
}

class GatewayBrowserServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GatewayBrowserServiceError";
  }
}

export interface GatewayBrowserServiceOptions {
  policy: GatewayPolicy;
  manager: BrowserManagerLike;
  security?: Partial<GatewayBrowserSecurityConfig>;
  shutdownBridge?: () => Promise<void>;
}

export class GatewayBrowserService {
  private readonly security: GatewayBrowserSecurityConfig;
  private readonly tabs = new Map<string, OwnedBrowserTab>();
  private readonly reservations = new Map<string, BrowserScope>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly guides = new Map<string, SopRegistry>();
  private readonly busyTabs = new Set<string>();
  private readonly lifecycle = new AbortController();
  private generation = 0;
  private closed = false;

  constructor(private readonly options: GatewayBrowserServiceOptions) {
    this.security = {
      ...DEFAULT_SECURITY,
      ...(options.security ?? {}),
      allowedChannels: [...(options.security?.allowedChannels ?? DEFAULT_SECURITY.allowedChannels)],
      allowedOrigins: [...(options.security?.allowedOrigins ?? DEFAULT_SECURITY.allowedOrigins)],
    };
  }

  async handle(principal: GatewayPrincipal, request: GatewayBrowserRequest, signal?: AbortSignal): Promise<GatewayResult<unknown>> {
    const startedAt = Date.now();
    const requestId = request.requestId?.trim() || randomUUID();
    const principalId = principalKey(principal);
    try {
      this.assertAvailable(principal);
      const generation = this.generation;
      const scope = await this.resolveScope(principal, request);
      if (this.closed || generation !== this.generation) throw new GatewayBrowserServiceError("gateway_closed", "Gateway browser service is closed");
      if (request.action === "guide") return gatewayOk(await this.guide(scope, request), { requestId, principalId, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt });
      if (request.action === "status") return gatewayOk(await this.status(scope, signal), { requestId, principalId, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt });
      if (request.action === "pair") return gatewayOk(await this.pair(scope, request, signal), { requestId, principalId, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt });
      if (request.action === "open") return gatewayOk(await this.open(scope, request, signal), { requestId, principalId, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt });
      if (request.action === "run") return gatewayOk(await this.run(scope, request, signal), { requestId, principalId, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt });
      return gatewayOk(await this.close(scope, request), { requestId, principalId, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt });
    } catch (error) {
      const aborted = signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
      const code = error instanceof GatewayBrowserServiceError || error instanceof GatewayPolicyError
        ? error.code
        : aborted ? "cancelled" : "browser_action_failed";
      return gatewayError({ code, message: error instanceof Error ? error.message : String(error) }, {
        requestId,
        principalId,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        ...(aborted ? { status: "cancelled" as const } : {}),
      });
    }
  }

  async shutdown(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.generation += 1;
      this.lifecycle.abort();
    }
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
    const entries = [...this.tabs.values()];
    const outcomes = await Promise.allSettled(entries.map((entry) => this.options.manager.close(entry.internalName)));
    const failures: unknown[] = [];
    outcomes.forEach((outcome, index) => {
      if (outcome.status === "fulfilled") this.tabs.delete(entries[index]!.internalName);
      else failures.push(outcome.reason);
    });
    try { await this.options.shutdownBridge?.(); }
    catch (error) { failures.push(error); }
    if (failures.length > 0) throw new AggregateError(failures, `Failed to close ${failures.length} Gateway browser resource(s)`);
  }

  private assertAvailable(principal: GatewayPrincipal): void {
    if (this.closed) throw new GatewayBrowserServiceError("gateway_closed", "Gateway browser service is closed");
    if (!this.security.enabled) throw new GatewayBrowserServiceError("browser_disabled", "Gateway browser access is disabled by security.browser.enabled");
    if (principal.transport === "http" && !isAuthenticatedPrincipal(principal)) {
      throw new GatewayBrowserServiceError("authentication_required", "Gateway browser access requires authenticated HTTP");
    }
  }

  private async resolveScope(principal: GatewayPrincipal, request: BrowserWorkspaceRequest): Promise<BrowserScope> {
    const selector = request.workspaceId ?? request.workspace ?? request.workspacePath ?? principal.workspaceId ?? principal.workspacePath;
    if (!selector) throw new GatewayBrowserServiceError("invalid_input", "browser actions require an authorized workspace");
    const decision = await this.options.policy.authorizeWorkspace(principal, selector);
    if (!decision.allowed || !decision.workspaceId || !decision.workspacePath) throw new GatewayPolicyError(decision.reason);
    return { id: decision.workspaceId, path: decision.workspacePath, principal: principalKey(principal) };
  }

  private async guide(scope: BrowserScope, request: GatewayBrowserGuideRequest): Promise<Record<string, unknown>> {
    const guideKey = `${scope.id}\0${scope.path}`;
    let registry = this.guides.get(guideKey);
    if (!registry) {
      registry = new SopRegistry({ cwd: scope.path, embedded: { browser: BROWSER_SOPS_BASELINE } });
      this.guides.set(guideKey, registry);
    }
    await this.track(registry.ensureLoaded());
    if (this.closed) throw cancelledError();
    const topic = request.topic?.trim();
    if (!topic) {
      const content = registry.renderIndex(
        "browser",
        (count) => `Gateway Browser SOP Registry — ${count} documents. Load the matching topic before browser operations with { action: \"guide\", topic: \"<id>\" }.`,
        BROWSER_HELPER_QUICKREF,
      );
      return { workspaceId: scope.id, content };
    }
    const document = registry.get("browser", topic);
    if (!document) throw new GatewayBrowserServiceError("not_found", `Unknown browser SOP topic ${JSON.stringify(topic)}`);
    return { workspaceId: scope.id, topic, title: document.title, content: document.body };
  }

  private async status(scope: BrowserScope, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const combined = combineSignals(signal, this.lifecycle.signal);
    const operation = this.options.manager.status(combined.signal);
    this.pending.add(operation);
    try {
      const live = await operation;
      if (this.closed) throw cancelledError();
      const tabs = [...this.tabs.values()]
        .filter((entry) => this.sameScope(entry.scope, scope))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((entry) => this.publicTab(entry));
      return { workspaceId: scope.id, bridge: live.bridge, tabs };
    } finally {
      this.pending.delete(operation);
      combined.dispose();
    }
  }

  private async pair(scope: BrowserScope, request: GatewayBrowserPairRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!/^\d{6}$/.test(request.code)) throw new GatewayBrowserServiceError("invalid_input", "browser pair requires an exact six-digit code");
    const pairingRequestId = request.pairingRequestId.trim();
    if (!pairingRequestId) throw new GatewayBrowserServiceError("invalid_input", "browser pair requires pairingRequestId from browser status");
    const combined = combineSignals(signal, this.lifecycle.signal);
    const operation = this.options.manager.pair(pairingRequestId, request.code, combined.signal);
    this.pending.add(operation);
    try {
      const approval = await operation;
      return { workspaceId: scope.id, approval };
    } finally {
      this.pending.delete(operation);
      combined.dispose();
    }
  }

  private async open(scope: BrowserScope, request: GatewayBrowserOpenRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const name = this.name(request.name);
    const internalName = this.internalName(scope, name);
    const attachUserProfile = request.app?.attachUserProfile ?? request.app?.attach_user_profile;
    const userProfileDir = request.app?.userProfileDir ?? request.app?.user_profile_dir;
    const cdpUrl = request.app?.cdpUrl ?? request.app?.cdp_url;
    const channel = request.app?.channel ?? (attachUserProfile ? "profile" : cdpUrl ? "cdp" : "managed");
    if (!this.security.allowedChannels.includes(channel)) {
      throw new GatewayBrowserServiceError("browser_channel_denied", `Gateway browser channel ${JSON.stringify(channel)} is not allowed`);
    }
    this.assertAllowedUrl(request.url);
    const timeoutMs = this.timeout(request.timeoutMs);
    if (this.reservations.has(internalName) || this.busyTabs.has(internalName)) throw new GatewayBrowserServiceError("browser_tab_busy", "Gateway browser tab is busy");
    if (!this.tabs.has(internalName) && this.countPrincipalTabs(scope.principal) >= this.security.maxTabsPerPrincipal) {
      throw new GatewayBrowserServiceError("browser_tab_limit", `Gateway browser tab limit ${this.security.maxTabsPerPrincipal} reached`);
    }
    const generation = this.generation;
    const combined = combineSignals(signal, this.lifecycle.signal);
    this.reservations.set(internalName, scope);
    this.busyTabs.add(internalName);
    const operation = this.options.manager.open(canonicalizeBrowserOpenOptions({
      name: internalName,
      isolationKey: channel === "managed" ? internalName : undefined,
      cwd: scope.path,
      url: request.url,
      executablePath: request.app?.path,
      channel: request.app?.channel,
      cdpUrl,
      args: request.app?.args,
      target: request.app?.target,
      attachUserProfile,
      userProfileDir,
      visible: request.visible,
      viewport: request.viewport,
      waitUntil: request.waitUntil,
      dialogs: request.dialogs,
      signal: combined.signal,
      timeoutMs,
    }));
    this.pending.add(operation);
    try {
      const info = await operation;
      if (this.closed || generation !== this.generation) {
        await this.options.manager.close(internalName).catch(() => false);
        throw cancelledError();
      }
      try {
        this.assertAllowedUrl(info.url);
      } catch (error) {
        await this.options.manager.close(internalName).catch(() => false);
        throw error;
      }
      const owned = { internalName, name, scope, info };
      this.tabs.set(internalName, owned);
      return { workspaceId: scope.id, tab: this.publicTab(owned) };
    } finally {
      this.pending.delete(operation);
      this.reservations.delete(internalName);
      this.busyTabs.delete(internalName);
      combined.dispose();
    }
  }

  private async run(scope: BrowserScope, request: GatewayBrowserRunRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const name = this.name(request.name);
    const internalName = this.internalName(scope, name);
    const owned = this.tabs.get(internalName);
    if (!owned || !this.sameScope(owned.scope, scope)) throw new GatewayBrowserServiceError("not_found", "Gateway browser tab was not found");
    if (this.busyTabs.has(internalName)) throw new GatewayBrowserServiceError("browser_tab_busy", "Gateway browser tab is busy");
    if (this.security.allowedOrigins.length > 0) {
      throw new GatewayBrowserServiceError("browser_run_origin_policy_conflict", "browser run is unavailable when security.browser.allowedOrigins is configured because trusted host code cannot be origin-sandboxed");
    }
    if (!request.code.trim()) throw new GatewayBrowserServiceError("invalid_input", "browser run requires non-empty code");
    if (utf8Bytes(request.code) > this.options.policy.limits.maxCommandBytes) {
      throw new GatewayBrowserServiceError("bounds_exceeded", `browser code exceeds ${this.options.policy.limits.maxCommandBytes} UTF-8 bytes`);
    }
    const combined = combineSignals(signal, this.lifecycle.signal);
    this.busyTabs.add(internalName);
    const operation = this.options.manager.run(
      internalName,
      request.code,
      scope.path,
      combined.signal,
      this.timeout(request.timeoutMs),
      this.options.policy.limits.maxOutputBytes,
    );
    this.pending.add(operation);
    try {
      const output = await operation;
      if (this.closed) throw cancelledError();
      owned.info = { ...owned.info, url: output.url };
      return {
        workspaceId: scope.id,
        name,
        url: output.url,
        displays: output.displays,
        ...(output.returnValue === undefined ? {} : { returnValue: jsonValue(output.returnValue) }),
        screenshots: output.screenshots,
        ...(output.navigated === undefined ? {} : { navigated: output.navigated }),
        ...(output.newTabs === undefined ? {} : { newTabs: output.newTabs }),
      };
    } finally {
      this.pending.delete(operation);
      this.busyTabs.delete(internalName);
      combined.dispose();
    }
  }

  private async close(scope: BrowserScope, request: GatewayBrowserCloseRequest): Promise<Record<string, unknown>> {
    if (request.all) {
      const owned = [...this.tabs.values()].filter((entry) => this.sameScope(entry.scope, scope));
      const reserved = [...this.reservations.entries()].filter(([, reservation]) => this.sameScope(reservation, scope));
      const names = [...new Set([...owned.map((entry) => entry.internalName), ...reserved.map(([name]) => name)])];
      if (names.some((name) => this.busyTabs.has(name))) throw new GatewayBrowserServiceError("browser_tab_busy", "A Gateway browser tab is busy");
      names.forEach((name) => this.busyTabs.add(name));
      const outcomes = await Promise.allSettled(names.map((name) => this.track(this.options.manager.close(name))));
      let closed = 0;
      const failures: unknown[] = [];
      outcomes.forEach((outcome, index) => {
        const internalName = names[index]!;
        this.busyTabs.delete(internalName);
        if (outcome.status === "fulfilled") {
          if (outcome.value) closed += 1;
          this.tabs.delete(internalName);
        } else failures.push(outcome.reason);
      });
      if (failures.length > 0) throw new AggregateError(failures, `Failed to close ${failures.length} Gateway browser tab(s)`);
      return { workspaceId: scope.id, closed };
    }
    const name = this.name(request.name);
    const internalName = this.internalName(scope, name);
    const owned = this.tabs.get(internalName);
    const reserved = this.reservations.get(internalName);
    if ((!owned || !this.sameScope(owned.scope, scope)) && (!reserved || !this.sameScope(reserved, scope))) {
      return { workspaceId: scope.id, name, closed: false };
    }
    if (this.busyTabs.has(internalName)) throw new GatewayBrowserServiceError("browser_tab_busy", "Gateway browser tab is busy");
    this.busyTabs.add(internalName);
    try {
      const closed = await this.track(this.options.manager.close(internalName));
      this.tabs.delete(internalName);
      return { workspaceId: scope.id, name, closed };
    } finally {
      this.busyTabs.delete(internalName);
    }
  }

  private publicTab(entry: OwnedBrowserTab): Record<string, unknown> {
    return {
      name: entry.name,
      kind: entry.info.kind,
      connection: structuredClone(entry.info.connection),
      url: entry.info.url,
      title: entry.info.title,
      reused: entry.info.reused,
      ...(entry.info.viewport === undefined ? {} : { viewport: structuredClone(entry.info.viewport) }),
    };
  }

  private assertAllowedUrl(value: string | undefined): void {
    if (value === undefined || value === "about:blank") return;
    let url: URL;
    try { url = new URL(value); }
    catch { throw new GatewayBrowserServiceError("browser_url_denied", "Gateway browser URL must be absolute"); }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new GatewayBrowserServiceError("browser_url_denied", "Gateway browser permits only HTTP(S) URLs and about:blank");
    }
    if (this.security.allowedOrigins.length > 0 && !this.security.allowedOrigins.includes(url.origin)) {
      throw new GatewayBrowserServiceError("browser_url_denied", `Gateway browser origin ${JSON.stringify(url.origin)} is not allowed`);
    }
  }

  private timeout(value: number | undefined): number {
    const maximum = Math.min(MAX_BROWSER_TIMEOUT_MS, this.options.policy.limits.maxExecTimeoutMs);
    const timeoutMs = value ?? Math.min(DEFAULT_TIMEOUT_MS, maximum);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximum) {
      throw new GatewayBrowserServiceError("invalid_input", `browser timeoutMs must be an integer in [1, ${maximum}]`);
    }
    return timeoutMs;
  }

  private name(value: string | undefined): string {
    const name = value?.trim() || "main";
    if (name.length > 128) throw new GatewayBrowserServiceError("invalid_input", "browser tab name exceeds 128 characters");
    return name;
  }

  private internalName(scope: BrowserScope, name: string): string {
    const digest = createHash("sha256").update(`${scope.principal}\0${scope.id}\0${scope.path}\0${name}`, "utf8").digest("hex");
    return `gateway-${digest}`;
  }

  private countPrincipalTabs(principal: string): number {
    const names = new Set([
      ...[...this.tabs.values()].filter((entry) => entry.scope.principal === principal).map((entry) => entry.internalName),
      ...[...this.reservations.entries()].filter(([, scope]) => scope.principal === principal).map(([name]) => name),
    ]);
    return names.size;
  }

  private sameScope(left: BrowserScope, right: BrowserScope): boolean {
    return left.principal === right.principal && left.id === right.id && left.path === right.path;
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    let tracked: Promise<T>;
    tracked = operation.finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    return tracked;
  }
}

function combineSignals(...signals: Array<AbortSignal | undefined>): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const abort = () => controller.abort();
  for (const signal of active) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => active.forEach((signal) => signal.removeEventListener("abort", abort)),
  };
}

function cancelledError(): Error {
  const error = new Error("Gateway browser operation was cancelled");
  error.name = "AbortError";
  return error;
}

function jsonValue(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : JSON.parse(serialized);
  } catch {
    return String(value);
  }
}
