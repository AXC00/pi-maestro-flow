/** Dedicated, operator-driven Gateway tunnel page. */
import { readFileSync } from "node:fs";
import { Key, type Component, type Focusable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { makeBorderFrame, resolveGlyphs, type OverlayTheme } from "pi-maestro-settings-core/ui";
import { GatewayConfigConflictError, loadGatewayConfigSync, normalizeGatewayConfig, restoreGatewayConfigIfCurrent, writeGatewayConfigPatchIfCurrent, type GatewayConfigPatch, type GatewayTunnelProfileConfig } from "../gateway/config.ts";
import { gatewayConfigPath } from "../gateway/state-paths.ts";
import type { GatewayTunnelDoctorReport } from "../gateway/tunnel/provider.ts";
import { projectGatewayTunnelMcpConnectionDescriptor, type GatewayTunnelMcpConnectionDescriptor } from "../gateway/tunnel/mcp-exposure.ts";
import { normalizeGatewayTunnelMcpAccess } from "../gateway/tunnel/mcp-access.ts";
import type { GatewayControlClient } from "../gateway/control-client.ts";

export interface GatewayTunnelPanelParams {
  requestRender: () => void;
  close: () => void;
  configPath?: string;
  createControlClient?: (configPath: string) => GatewayControlClient;
  initialProfiles?: readonly GatewayTunnelProfileConfig[];
  initialDoctor?: GatewayTunnelDoctorReport;
  /** Host-native prompt used by the structured metadata editor. */
  input?: (title: string, placeholder?: string) => Promise<string | undefined>;
  /** Canonical daemon listener path (for example /api/mcp). */
  httpPath?: string;
  /** Footer hint for the Esc key — "Esc 关闭" when the page is the overlay's initial view. */
  escLabel?: string;
  /** Theme for role colors; when absent the panel renders unstyled. */
  theme?: OverlayTheme;
}

export interface GatewayTunnelReadiness {
  provider: "ready" | "not-ready" | "unknown";
  mcp: "ready" | "not-ready" | "unknown";
  remoteAuthorizationE2E: "ready" | "not-ready" | "unknown";
}

/** Build a patch that replaces only the tunnel profile list. */
export function gatewayTunnelProfilesPatch(profiles: readonly GatewayTunnelProfileConfig[]): GatewayConfigPatch {
  return { tunnels: { profiles: structuredClone(profiles) } as never };
}

/** A complete profile replacement used by structured editors; no YAML/argv secrets. */
export function replaceGatewayTunnelProfile(
  profiles: readonly GatewayTunnelProfileConfig[],
  profileId: string,
  replacement: GatewayTunnelProfileConfig,
): GatewayTunnelProfileConfig[] {
  if (replacement.id !== profileId) throw new Error("Tunnel profile id cannot change during an edit");
  const index = profiles.findIndex((profile) => profile.id === profileId);
  if (index < 0) throw new Error(`Unknown tunnel profile: ${profileId}`);
  const next = profiles.map((profile, candidate) => candidate === index ? structuredClone(replacement) : structuredClone(profile));
  return next;
}

/** Readiness is intentionally layered and conservative: no provider detail or secret is projected. */
export function gatewayTunnelReadiness(
  profile: GatewayTunnelProfileConfig,
  descriptor: GatewayTunnelMcpConnectionDescriptor,
  providerReady?: boolean,
): GatewayTunnelReadiness {
  const provider = providerReady === undefined ? "unknown" : providerReady ? "ready" : "not-ready";
  const mcp = !profile.enabled || !profile.mcpAccess?.enabled
    ? "not-ready"
    : descriptor.mcpUrl || descriptor.ephemeral
      ? descriptor.readiness ? "ready" : "not-ready"
      : "unknown";
  const remoteAuthorizationE2E = provider === "ready" && mcp === "ready" && profile.mcpAccess?.auth !== undefined ? "ready" : mcp === "not-ready" || provider === "not-ready" ? "not-ready" : "unknown";
  return { provider, mcp, remoteAuthorizationE2E };
}

function statusLabel(value: string): string { return value === "ready" ? "ready" : value === "not-ready" ? "not ready" : "unknown"; }

function readConfigSnapshot(path: string): string {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export class GatewayTunnelPanel implements Component, Focusable {
  focused = false;
  private readonly configPath: string;
  private profiles: GatewayTunnelProfileConfig[];
  private selected = 0;
  private status = "";
  private doctor?: GatewayTunnelDoctorReport;
  private busy = false;
  private disposed = false;
  private readonly httpPath: string;
  private readonly escLabel: string;

  constructor(private readonly params: GatewayTunnelPanelParams) {
    this.escLabel = params.escLabel ?? "Esc 返回";
    this.configPath = params.configPath ?? gatewayConfigPath();
    this.profiles = [...(params.initialProfiles ?? (() => {
      try { return loadGatewayConfigSync(this.configPath).tunnels.profiles; } catch { return []; }
    })())].map((profile) => structuredClone(profile));
    this.doctor = params.initialDoctor;
    this.httpPath = params.httpPath ?? (() => {
      try { return loadGatewayConfigSync(this.configPath).transport.http.path; } catch { return "/mcp"; }
    })();
  }

  invalidate(): void {}
  dispose(): void { this.disposed = true; }

  private requestRender(): void { if (!this.disposed) this.params.requestRender(); }
  private setStatus(value: string): void { this.status = sanitizeTerminalText(value); }

  getProfiles(): GatewayTunnelProfileConfig[] { return this.profiles.map((profile) => structuredClone(profile)); }
  getSelectedProfile(): GatewayTunnelProfileConfig | undefined { return this.profiles[this.selected]; }
  setDoctorResult(result: GatewayTunnelDoctorReport | undefined): void { this.doctor = result; }

  /** Add a complete profile draft with the safe defaults required by the operator UI. */
  addProfile(profile: GatewayTunnelProfileConfig): void {
    if (this.profiles.some((candidate) => candidate.id === profile.id)) throw new Error(`Tunnel profile already exists: ${profile.id}`);
    this.profiles.push({
      ...structuredClone(profile),
      enabled: false,
      mcpAccess: profile.mcpAccess ?? { enabled: false, actions: [], auth: { kind: "gateway" } },
    });
    this.setStatus("已添加 profile（默认 disabled，按 s 保存）");
    this.requestRender();
  }

  /** Structured, in-memory edit. Saving is explicit and never starts a tunnel. */
  editProfile(profileId: string, replacement: GatewayTunnelProfileConfig): void {
    const normalized = replacement.lifecycle === "ephemeral" ? { ...structuredClone(replacement), enabled: false } : structuredClone(replacement);
    this.profiles = replaceGatewayTunnelProfile(this.profiles, profileId, normalized);
    this.setStatus("已编辑；按 s 保存（保存不会自动启动隧道）");
    this.requestRender();
  }

  /** Update selected structured fields without accepting YAML, argv, or secret material. */
  updateProfile(profileId: string, changes: Partial<GatewayTunnelProfileConfig>): void {
    const current = this.profiles.find((profile) => profile.id === profileId);
    if (!current) throw new Error(`Unknown tunnel profile: ${profileId}`);
    const replacement = { ...current, ...structuredClone(changes), id: profileId } as GatewayTunnelProfileConfig;
    this.editProfile(profileId, replacement);
  }

  /** Dedicated MCP policy editor seam; policy is persisted with the profile atomically. */
  setMcpAccessPolicy(profileId: string, policy: NonNullable<GatewayTunnelProfileConfig["mcpAccess"]>): void {
    this.updateProfile(profileId, { mcpAccess: structuredClone(policy) });
  }

  /** Alias used by embedders that call the policy `mcp_access`. */
  setMcpAccess(profileId: string, policy: NonNullable<GatewayTunnelProfileConfig["mcpAccess"]>): void {
    this.setMcpAccessPolicy(profileId, policy);
  }

  cancel(): void { this.setStatus("编辑已取消；未写入配置"); this.requestRender(); }

  async save(): Promise<void> {
    if (this.disposed) return;
    // Snapshot the exact raw document before any asynchronous online check; the
    // CAS writer re-reads it under the private config lock immediately before commit.
    const expectedRaw = readConfigSnapshot(this.configPath);
    const current = loadGatewayConfigSync(this.configPath);
    const profiles = this.profiles.map((profile) => profile.lifecycle === "ephemeral" ? { ...structuredClone(profile), enabled: false } : structuredClone(profile));
    this.profiles = profiles;
    const client = this.params.createControlClient?.(this.configPath);
    if (client && JSON.stringify(current.tunnels.profiles) !== JSON.stringify(profiles)) {
      const daemon = await client.status();
      if (this.disposed) return;
      if (daemon.online) {
        this.setStatus("保存已拒绝：Gateway 正在运行，请先停止 daemon 后再保存配置（或使用 e/x 受控切换）");
        this.requestRender();
        return;
      }
    }
    await writeGatewayConfigPatchIfCurrent(this.configPath, expectedRaw, gatewayTunnelProfilesPatch(profiles));
    this.setStatus("已保存配置；未自动启动隧道");
    this.requestRender();
  }

  /** Run the state-only local doctor through authenticated local control IPC. */
  async doctorNow(): Promise<GatewayTunnelDoctorReport> {
    if (this.busy) throw new Error("Tunnel operation is already in progress");
    this.busy = true;
    try {
      const client = this.params.createControlClient?.(this.configPath);
      if (!client) throw new Error("Tunnel doctor control client is unavailable");
      this.doctor = await client.tunnelDoctor();
      this.setStatus(this.doctor.sideEffects ? "doctor returned an unsafe result" : "doctor 完成（只读、无副作用）");
      this.requestRender();
      return this.doctor;
    } finally { this.busy = false; }
  }

  /** Manual lifecycle switch. Persistent transitions are a config/runtime
   * transaction; ephemeral Quick profiles never mutate desired-state config. */
  async switchSelected(enabled: boolean): Promise<void> {
    const target = this.getSelectedProfile();
    if (!target || this.busy) return;
    this.busy = true;
    const client = this.params.createControlClient?.(this.configPath);
    if (!client) { this.busy = false; this.setStatus("Tunnel lifecycle control client is unavailable"); this.requestRender(); return; }
    // Quick is explicitly transient: x must stop an actually running process
    // even when its persisted enabled flag is false, and e must not persist it.
    if (target.lifecycle === "ephemeral") {
      try {
        if (enabled) await client.tunnelProfileStart(target.id);
        else await client.tunnelProfileStop(target.id);
        this.setStatus(enabled ? "Quick Tunnel 已临时启动（未写入 enabled）" : "Quick Tunnel 已停止");
      } catch (error) {
        this.setStatus(`Quick Tunnel 操作失败: ${error instanceof Error ? error.message : String(error)}`);
      } finally { this.busy = false; this.requestRender(); }
      return;
    }
    const failures: string[] = [];
    let originalRaw: string | undefined;
    let committedRaw: string | undefined;
    let original: ReturnType<typeof loadGatewayConfigSync> | undefined;
    let targetPersisted: GatewayTunnelProfileConfig | undefined;
    let old: GatewayTunnelProfileConfig | undefined;
    let wasOnline = false;
    try {
      // Re-read canonical state immediately before the transition; edits in the
      // panel are never treated as authority over persisted profile topology.
      originalRaw = readConfigSnapshot(this.configPath);
      original = loadGatewayConfigSync(this.configPath);
      targetPersisted = original.tunnels.profiles.find((profile) => profile.id === target.id);
      if (!targetPersisted) throw new Error(`Unknown persisted tunnel profile: ${target.id}`);
      if (targetPersisted.lifecycle !== "persistent") throw new Error(`Profile ${target.id} is not persistent`);
      if (targetPersisted.enabled === enabled) {
        this.setStatus(enabled ? "profile 已启用" : "profile 已停用");
        return;
      }
      old = original.tunnels.profiles.find((profile) => profile.lifecycle === "persistent" && profile.enabled && profile.id !== target.id);
      wasOnline = (await client.status()).online;
      const nextProfiles = original.tunnels.profiles.map((profile) => {
        if (profile.id === target.id) return { ...profile, enabled };
        if (enabled && profile.lifecycle === "persistent") return { ...profile, enabled: false };
        return profile;
      });
      const authPatch = enabled ? {
        server: { disable_localhost_protection: true, trust_proxy_headers: true } as never,
        auth: {
          mode: original.auth.mode === "open" ? "oauth" : original.auth.mode === "bearer" ? "dual" : original.auth.mode,
          oauth: { server_url: targetPersisted.publicUrl, tokenTtlMs: original.auth.oauth?.tokenTtlMs ?? 86_400_000 },
        } as never,
      } : {};
      if (old && wasOnline) await client.tunnelProfileStop(old.id);
      if (!enabled && targetPersisted.enabled && wasOnline) await client.tunnelProfileStop(target.id);
      const committed = await writeGatewayConfigPatchIfCurrent(this.configPath, originalRaw, { tunnels: { profiles: nextProfiles } as never, ...authPatch });
      committedRaw = committed.raw;
      this.profiles = nextProfiles.map((profile) => structuredClone(profile));
      if (wasOnline) await client.restart();
      if (enabled) await client.tunnelProfileStart(target.id);
      this.setStatus(enabled ? "已原子切换 persistent profile（旧 profile 已停止）" : "已停用 profile");
    } catch (error) {
      // Restore both the canonical document and the old runtime. Every
      // rollback failure remains visible to the operator.
      if (committedRaw !== undefined && originalRaw !== undefined) {
        try { await restoreGatewayConfigIfCurrent(this.configPath, committedRaw, originalRaw); } catch (rollbackError) { failures.push(`配置回滚失败: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
      }
      if (original) this.profiles = original.tunnels.profiles.map((profile) => structuredClone(profile));
      if (wasOnline && !(error instanceof GatewayConfigConflictError)) {
        try { await client.restart(); } catch (rollbackError) { failures.push(`daemon 回滚重启失败: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
        const restoreProfile = old ?? (original?.tunnels.profiles.find((profile) => profile.id === target.id && profile.enabled));
        if (restoreProfile) {
          try { await client.tunnelProfileStart(restoreProfile.id); } catch (rollbackError) { failures.push(`旧 profile 恢复失败: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`); }
        }
      } else if (wasOnline) {
        failures.push("检测到配置并发修改，未重启或覆盖更新者的运行时");
      }
      const detail = error instanceof Error ? error.message : String(error);
      this.setStatus(`切换失败（已尝试回滚）: ${detail}${failures.length ? ` · ${failures.join("; ")}` : ""}`);
    } finally { this.busy = false; this.requestRender(); }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, 120));
    if (safeWidth < 20) {
      return [truncateToWidth(`Gateway Tunnel · ${this.profiles.length} profiles · ${this.escLabel}`, safeWidth, "…")];
    }
    const inner = safeWidth - 2;
    const rows = [fitLine(`Pi Maestro Gateway · ${this.fg("36", "Tunnel")}（专用人工操作面）`, inner), rule(inner)];
    if (this.profiles.length === 0) {
      rows.push(fitLine("  ○ 尚无 tunnel profile；请先在 /gateway config 建立 profile", inner));
      rows.push(fitLine(this.fg("2", "  默认 enabled: false · Enter 可添加 JSON metadata"), inner));
    }
    for (const [index, profile] of this.profiles.entries()) {
      const descriptor = projectGatewayTunnelMcpConnectionDescriptor(profile, { httpPath: this.httpPath, state: this.stateFor(profile.id) });
      const readiness = gatewayTunnelReadiness(profile, descriptor, this.providerReady(profile.id));
      const marker = index === this.selected ? this.fg("36", "▶") : " ";
      const enabled = profile.enabled ? this.fg("32", "enabled") : this.fg("2", "disabled");
      const endpoint = descriptor.ephemeral ? "MCP URL: ephemeral（运行后不固定）" : `MCP URL: ${descriptor.mcpUrl ?? "未配置"}`;
      rows.push(fitLine(`${marker} ${profile.id} · ${profile.provider}/${profile.mode} · ${profile.lifecycle === "persistent" ? "fixed" : "ephemeral"} · ${enabled}`, inner));
      rows.push(fitLine(`  ${endpoint} · auth: ${descriptor.authKind}`, inner));
      rows.push(fitLine(`  OpenAI experimental: ${profile.provider === "openai" ? "yes" : "no"} · ${this.statusSegment("provider", readiness.provider)} · ${this.statusSegment("MCP", readiness.mcp)} · ${this.statusSegment("remote authorization E2E", readiness.remoteAuthorizationE2E)}`, inner));
      if (index === this.selected && profile.mcpAccess) {
        rows.push(fitLine(`  mcp_access: ${profile.mcpAccess.enabled ? "enabled" : "disabled"} · actions: ${profile.mcpAccess.actions.length}`, inner));
      }
    }
    if (this.status) rows.push(rule(inner), fitLine(this.status, inner));
    rows.push(...fitSegments(inner, ["↑↓ 选择", "Enter 详情/编辑", "s 保存", "d doctor", "e 启用", "x 停用", this.escLabel]));
    return frame(rows, safeWidth, this.params.theme);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.params.close(); return; }
    if (matchesKey(data, Key.enter) || data === "\r") { void this.editOrAddFromPrompt(); return; }
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.selected = Math.min(Math.max(0, this.profiles.length - 1), this.selected + 1);
    else if (data === "d") void this.doctorNow().catch((error) => { this.setStatus(`doctor 失败: ${error instanceof Error ? error.message : String(error)}`); this.requestRender(); });
    else if (data === "e") void this.switchSelected(true);
    else if (data === "x") void this.switchSelected(false);
    else if (data === "s") void this.save().catch((error) => { this.setStatus(`保存失败: ${error instanceof Error ? error.message : String(error)}`); this.requestRender(); });
    this.requestRender();
  }

  private async editOrAddFromPrompt(): Promise<void> {
    if (this.busy) { this.setStatus("Tunnel operation is already in progress"); this.requestRender(); return; }
    if (!this.params.input) { this.setStatus("结构化编辑器不可用：宿主未提供 input callback"); this.requestRender(); return; }
    const existing = this.getSelectedProfile();
    const title = existing ? `编辑 profile ${existing.id}（JSON metadata；Esc 取消）` : "添加 tunnel profile（JSON metadata；Esc 取消）";
    const raw = await this.params.input(title, JSON.stringify(existing ?? { id: "new-profile", provider: "cloudflare", mode: "named", lifecycle: "persistent", enabled: false }, null, 2));
    if (this.disposed) return;
    if (raw === undefined) { this.cancel(); return; }
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("metadata 必须是 JSON mapping");
      const record = value as Record<string, unknown>;
      const forbidden = new Set(["token", "password", "secret", "clientsecret", "privatekey"]);
      const key = Object.keys(record).find((candidate) => forbidden.has(candidate.replace(/_/gu, "").toLowerCase()));
      if (key) throw new Error(`${key} 是 secret material；请使用已配置的安全引用`);
      const aliases: Record<string, string> = {
        public_url: "publicUrl", mcp_access: "mcpAccess", local_port: "localPort", binary_path: "binaryPath",
        tunnel_id: "tunnelId", credentials_file: "credentialsFile", token_file: "tokenFile", identity_file: "identityFile", tunnel_id_env: "tunnelIdEnv",
        runtime_key_env: "runtimeKeyEnv", credential_ttl_ms: "credentialTtlMs", auto_install: "autoInstall", remote_bind_host: "remoteBindHost",
        remote_port: "remotePort", local_host: "localHost", config_file: "configFile", known_hosts_file: "knownHostsFile",
        connect_timeout_seconds: "connectTimeoutSeconds", server_alive_interval_seconds: "serverAliveIntervalSeconds",
        server_alive_count_max: "serverAliveCountMax",
      };
      const allowed = new Set(["id", "enabled", "provider", "mode", "lifecycle", "publicUrl", "mcpAccess", ...Object.keys(aliases), ...Object.values(aliases)]);
      const unknown = Object.keys(record).find((candidate) => !allowed.has(candidate));
      if (unknown) throw new Error(`${unknown} 不是可编辑的 profile metadata`);
      const canonicalInput: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(record)) {
        const canonical = aliases[key] ?? key;
        if (Object.hasOwn(canonicalInput, canonical) && JSON.stringify(canonicalInput[canonical]) !== JSON.stringify(item)) {
          throw new Error(`${key} 与 ${canonical} 是冲突的重复 alias`);
        }
        canonicalInput[canonical] = structuredClone(item);
      }
      const profile = structuredClone((existing ? { ...existing, ...canonicalInput } : canonicalInput)) as unknown as GatewayTunnelProfileConfig;
      if (typeof profile.id !== "string" || typeof profile.provider !== "string" || typeof profile.mode !== "string") throw new Error("id/provider/mode 是必填 metadata");
      if (profile.mcpAccess !== undefined) {
        profile.mcpAccess = normalizeGatewayTunnelMcpAccess(profile.mcpAccess, "mcpAccess", { provider: profile.provider, mode: profile.mode, controlledPath: this.httpPath });
      }
      // Validate and retain exactly the canonical profile that will be stored.
      const canonical = normalizeGatewayConfig({ transport: { http: { path: this.httpPath } }, tunnels: { profiles: [{ ...profile, enabled: profile.lifecycle === "ephemeral" ? false : profile.enabled }] } });
      const validatedProfile = canonical.tunnels.profiles[0];
      if (!validatedProfile) throw new Error("profile metadata produced no canonical profile");
      if (existing) this.editProfile(existing.id, validatedProfile);
      else this.addProfile(validatedProfile);
    } catch (error) {
      this.setStatus(`编辑失败: ${error instanceof Error ? error.message : String(error)}`);
      this.requestRender();
    }
  }

  private stateFor(profileId: string): { phase?: "stopped" | "starting" | "ready" | "degraded" | "quiescing" | "failed"; readiness?: boolean; generation?: number } {
    const item = this.doctor?.profiles.find((profile) => profile.profile === profileId);
    return item ? { phase: item.phase, readiness: item.readiness } : {};
  }
  private providerReady(profileId: string): boolean | undefined {
    return this.doctor?.profiles.find((profile) => profile.profile === profileId)?.readiness;
  }

  private statusSegment(label: string, value: string): string {
    const color = value === "ready" ? "32" : value === "not-ready" ? "31" : "33";
    return this.fg(color, `${label}: ${statusLabel(value)}`);
  }

  /** Legacy numeric code → semantic role → theme slot. */
  private fg(code: string, text: string): string {
    const theme = this.params.theme;
    if (!theme || !code) return text;
    const role = CODE_ROLE[code];
    if (role === "bold") return theme.bold ? theme.bold(text) : theme.fg("text", text);
    return theme.fg(role ?? "text", text);
  }
}

const FRAME_GLYPHS = resolveGlyphs("nerd");
const FRAME_UTILS = {
  measure: visibleWidth,
  clip: (text: string, width: number, ellipsis: string) => truncateToWidth(text, width, ellipsis),
};

function fitLine(value: string, width: number): string {
  return truncateToWidth(sanitizeTerminalText(value), width, "…", true);
}

function rule(width: number): string {
  return "─".repeat(Math.max(0, width));
}

function frame(rows: readonly string[], width: number, theme?: OverlayTheme): string[] {
  return makeBorderFrame(rows, width, FRAME_GLYPHS, FRAME_UTILS, {
    corners: "square",
    clip: false,
    pad: false,
    theme,
    borderColor: "borderMuted",
  });
}

const CODE_ROLE: Record<string, string> = {
  "1": "bold",
  "2": "dim",
  "31": "error",
  "32": "success",
  "33": "warning",
  "34": "muted",
  "35": "accent",
  "36": "accent",
};

function fitSegments(width: number, segments: readonly string[]): string[] {
  const lines: string[] = [];
  let current = "";
  for (const segment of segments) {
    const candidate = current ? `${current} · ${segment}` : segment;
    if (current && visibleWidth(candidate) > width) {
      lines.push(fitLine(current, width));
      current = segment;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(fitLine(current, width));
  return lines;
}

function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[(?![0-9;]*m)[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u009f]/g, "")
    .replace(/[\r\n]+/g, " ");
}

export const createGatewayTunnelPanel = (params: GatewayTunnelPanelParams): GatewayTunnelPanel => new GatewayTunnelPanel(params);
