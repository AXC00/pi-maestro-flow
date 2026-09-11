/** Cloudflare Quick and Named Tunnel provider for the native Gateway tunnel supervisor. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type {
  GatewayTunnelDeadlineContext,
  GatewayTunnelDoctorResult,
  GatewayTunnelExit,
  GatewayTunnelProcessIdentity,
  GatewayTunnelProbeResult,
  GatewayTunnelProvider,
  GatewayTunnelProviderRequest,
  GatewayTunnelStartResult,
  GatewayTunnelStopRequest,
} from "../contracts.ts";
import { waitWithinTunnelDeadline } from "../probe.ts";

export const CLOUDFLARE_QUICK_TUNNEL_PROVIDER = "cloudflare" as const;
export const CLOUDFLARE_QUICK_TUNNEL_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_LOCAL_PORT = 9090;
const DEFAULT_PROBE_PATH = "/mcp";
const STOP_GRACE_MS = 2_000;
const STOP_POLL_MS = 50;
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/iu;
const SAFE_TUNNEL_ID = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9])?$/u;

type CloudflareTunnelMode = "quick" | "named";

type CloudflareInput = {
  mode: "quick";
  localPort: number;
  binaryPath?: string;
} | {
  mode: "named";
  localPort: number;
  binaryPath?: string;
  tunnelId: string;
  publicUrl: string;
  credentialFlag: "--credentials-file" | "--token-file";
  credentialPath: string;
};

export interface CloudflareQuickTunnelProcess {
  pid: number;
  commandLine: string;
}

export interface CloudflareQuickTunnelProviderOptions {
  /** Explicit administrator configuration. When omitted, PATH is consulted. */
  binaryPath?: string;
  defaultLocalPort?: number;
  probePath?: string;
  maxOutputBytes?: number;
  fetch?: typeof fetch;
  spawn?: typeof spawn;
  discoverProcesses?: (localPort: number) => CloudflareQuickTunnelProcess[] | undefined | Promise<CloudflareQuickTunnelProcess[] | undefined>;
  processAlive?: (pid: number) => boolean;
  signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  now?: () => number;
  /** Deterministic platform seam for lifecycle tests. */
  platform?: NodeJS.Platform;
}

interface CloudflareRuntime {
  readonly key: string;
  readonly pid: number;
  readonly mode: CloudflareTunnelMode;
  readonly localPort: number;
  readonly binaryPath: string;
  readonly args: string[];
  readonly child: ChildProcess;
  readonly exited: Promise<GatewayTunnelExit>;
  readonly publicUrl?: string;
  output: Buffer;
  exit?: GatewayTunnelExit;
}

export function isValidCloudflareLocalPort(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
}

export function cloudflareQuickTunnelArgs(localPort: number): string[] {
  if (!isValidCloudflareLocalPort(localPort)) throw new Error("Cloudflare Quick Tunnel localPort must be in [1, 65535]");
  return ["tunnel", "--protocol", "http2", "--url", `http://127.0.0.1:${localPort}`];
}

export function cloudflareNamedTunnelArgs(input: {
  localPort: number;
  tunnelId: string;
  credentialFlag: "--credentials-file" | "--token-file";
  credentialPath: string;
}): string[] {
  if (!isValidCloudflareLocalPort(input.localPort)) throw new Error("Cloudflare Named Tunnel localPort must be in [1, 65535]");
  return [
    "tunnel",
    "run",
    "--url",
    `http://127.0.0.1:${input.localPort}`,
    input.credentialFlag,
    input.credentialPath,
    input.tunnelId,
  ];
}

/** Exact matcher used only for duplicate discovery; named tunnels never match. */
export function isCloudflareQuickTunnelCommandLine(commandLine: string, localPort: number): boolean {
  if (!isValidCloudflareLocalPort(localPort)) return false;
  const match = commandLine.trim().match(/^(?:"([^"]+)"|(\S+))\s+(.+)$/u);
  if (!match) return false;
  const executable = (match[1] ?? match[2] ?? "").split(/[\\/]/u).pop()?.toLowerCase();
  if (executable !== "cloudflared" && executable !== "cloudflared.exe") return false;
  const args = match[3]!.trim().split(/\s+/u);
  const url = `http://127.0.0.1:${localPort}`;
  return (args.length === 3 && args[0] === "tunnel" && args[1] === "--url" && args[2] === url)
    || (args.length === 5 && args[0] === "tunnel" && args[1] === "--protocol" && args[2] === "http2" && args[3] === "--url" && args[4] === url);
}

/** Fail-closed process discovery. `undefined` means enumeration was incomplete. */
export function discoverCloudflareQuickTunnels(localPort: number): CloudflareQuickTunnelProcess[] | undefined {
  if (!isValidCloudflareLocalPort(localPort)) return undefined;
  if (process.platform === "win32") return discoverWindows(localPort);
  if (process.platform === "darwin") return discoverPs(localPort);
  return discoverProc(localPort);
}

export function parseCloudflareQuickTunnelUrl(output: string | Uint8Array): string | undefined {
  const value = typeof output === "string" ? output : Buffer.from(output).toString("utf8");
  return value.match(QUICK_TUNNEL_URL)?.[0];
}

export function resolveCloudflaredBinary(explicitPath?: string): string | undefined {
  if (explicitPath !== undefined) {
    const value = explicitPath.trim();
    if (!value || !isAbsolute(value) || !existsSync(value)) return undefined;
    try { return realpathSync.native(value); } catch { return undefined; }
  }
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["cloudflared"], {
    encoding: "utf8",
    timeout: 5_000,
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) return undefined;
  const first = String(result.stdout || "").split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
  if (!first) return undefined;
  try { return realpathSync.native(first); } catch { return first; }
}

export class CloudflareQuickTunnelProvider implements GatewayTunnelProvider {
  readonly name = CLOUDFLARE_QUICK_TUNNEL_PROVIDER;
  private readonly defaultLocalPort: number;
  private readonly probePath: string;
  private readonly maxOutputBytes: number;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: typeof spawn;
  private readonly discover: NonNullable<CloudflareQuickTunnelProviderOptions["discoverProcesses"]>;
  private readonly alive: (pid: number) => boolean;
  private readonly signal: (pid: number, signal: NodeJS.Signals | 0) => void;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly binaryPath?: string;
  private readonly runtimes = new Map<string, CloudflareRuntime>();

  constructor(options: CloudflareQuickTunnelProviderOptions = {}) {
    this.defaultLocalPort = options.defaultLocalPort ?? DEFAULT_LOCAL_PORT;
    if (!isValidCloudflareLocalPort(this.defaultLocalPort)) throw new Error("Cloudflare defaultLocalPort must be in [1, 65535]");
    this.probePath = normalizeProbePath(options.probePath ?? DEFAULT_PROBE_PATH);
    this.maxOutputBytes = options.maxOutputBytes ?? CLOUDFLARE_QUICK_TUNNEL_MAX_OUTPUT_BYTES;
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes < 1024 || this.maxOutputBytes > 1024 * 1024) throw new Error("Cloudflare maxOutputBytes must be in [1024, 1048576]");
    this.fetchImpl = options.fetch ?? fetch;
    this.spawnImpl = options.spawn ?? spawn;
    this.discover = options.discoverProcesses ?? discoverCloudflareQuickTunnels;
    this.alive = options.processAlive ?? processAlive;
    this.signal = options.signalProcess ?? ((pid, value) => process.kill(pid, value));
    this.now = options.now ?? (() => Date.now());
    this.platform = options.platform ?? process.platform;
    this.binaryPath = options.binaryPath;
  }

  async doctor(context: GatewayTunnelDeadlineContext, request: GatewayTunnelProviderRequest): Promise<GatewayTunnelDoctorResult> {
    context.throwIfExpired("doctor");
    const raw = request.input ?? {};
    let configured: string | undefined;
    if (raw.mode === "named") configured = this.input(request).binaryPath ?? this.binaryPath;
    else {
      this.assertQuickInput(request);
      configured = raw.binaryPath === undefined ? this.binaryPath : String(raw.binaryPath);
    }
    const executablePath = resolveCloudflaredBinary(configured);
    return executablePath
      ? { ok: true, executablePath }
      : { ok: false, detail: configured ? "Configured cloudflared binary is unavailable" : "cloudflared was not found on PATH" };
  }

  async start(context: GatewayTunnelDeadlineContext, request: GatewayTunnelProviderRequest): Promise<GatewayTunnelStartResult> {
    context.throwIfExpired("start");
    const input = this.input(request);
    const localPort = input.localPort;
    const binaryPath = resolveCloudflaredBinary(input.binaryPath ?? this.binaryPath);
    if (!binaryPath) throw providerError("tunnel_doctor_failed", "cloudflared was not found in explicit configuration or PATH");
    if (input.mode === "quick") {
      const existing = await this.discover(localPort);
      context.throwIfExpired("start");
      if (existing === undefined) throw providerError("tunnel_discovery_failed", "Cloudflare process discovery was incomplete; refusing a duplicate start");
      if (existing.length > 0) throw providerError("tunnel_duplicate", `Found ${existing.length} existing Cloudflare Quick Tunnel process(es) for 127.0.0.1:${localPort}`);
    }

    const args = input.mode === "quick"
      ? cloudflareQuickTunnelArgs(localPort)
      : cloudflareNamedTunnelArgs({
        localPort,
        tunnelId: input.tunnelId,
        credentialFlag: input.credentialFlag,
        credentialPath: input.credentialPath,
      });
    const isShim = this.platform === "win32" && /\.(?:cmd|bat)$/iu.test(binaryPath);
    const child = this.spawnImpl(binaryPath, args, {
      detached: !isShim,
      stdio: ["ignore", "pipe", "pipe"],
      shell: isShim,
      windowsHide: true,
    });
    if (!child.pid) {
      try { child.kill(); } catch { /* no process was created */ }
      throw providerError("tunnel_spawn_failed", "cloudflared did not publish a process id");
    }
    child.unref();
    const key = runtimeKey(request);
    let settle!: (exit: GatewayTunnelExit) => void;
    let settled = false;
    const exited = new Promise<GatewayTunnelExit>((resolve) => { settle = resolve; });
    const runtime: CloudflareRuntime = {
      key,
      pid: child.pid,
      mode: input.mode,
      localPort,
      binaryPath,
      args,
      child,
      exited,
      ...(input.mode === "named" ? { publicUrl: input.publicUrl } : {}),
      output: Buffer.alloc(0),
    };
    const finish = (exit: GatewayTunnelExit): void => {
      if (settled) return;
      settled = true;
      runtime.exit = exit;
      if (runtime.mode === "quick") appendBounded(runtime, exit.detail ?? "", this.maxOutputBytes);
      settle(exit);
    };
    if (runtime.mode === "quick") {
      child.stdout?.on("data", (chunk: Buffer | string) => appendBounded(runtime, chunk, this.maxOutputBytes));
      child.stderr?.on("data", (chunk: Buffer | string) => appendBounded(runtime, chunk, this.maxOutputBytes));
    } else {
      child.stdout?.resume();
      child.stderr?.resume();
    }
    child.once("error", (error) => finish(runtime.mode === "quick"
      ? { code: null, at: this.now(), detail: `spawn error: ${error.message}` }
      : { code: null, at: this.now(), detail: "cloudflared spawn failed" }));
    child.once("exit", (code, signal) => finish(runtime.mode === "quick"
      ? { code, signal, at: this.now(), detail: outputTail(runtime.output) }
      : { code, signal, at: this.now() }));
    this.runtimes.set(key, runtime);
    return {
      pid: runtime.pid,
      executablePath: binaryPath,
      args,
      ...(runtime.publicUrl ? { endpoint: runtime.publicUrl } : {}),
      exited,
      child,
    };
  }

  async probe(context: GatewayTunnelDeadlineContext, process: GatewayTunnelStartResult, request: GatewayTunnelProviderRequest): Promise<GatewayTunnelProbeResult> {
    context.throwIfExpired("probe");
    const input = this.input(request);
    const runtime = this.runtimes.get(runtimeKey(request));
    const mode = runtime?.mode ?? input.mode;
    if (runtime && runtime.pid !== process.pid) return { ready: false, terminal: true, detail: "Cloudflare runtime pid does not match the requested generation" };
    if (runtime?.exit || !this.alive(process.pid)) {
      const exit = runtime?.exit;
      const suffix = mode === "quick" ? `: ${runtime ? outputTail(runtime.output) : ""}` : "";
      return {
        ready: false,
        terminal: true,
        detail: boundedDetail(`cloudflared exited before readiness (exit=${exit?.code ?? "unknown"}${exit?.signal ? `, signal=${exit.signal}` : ""})${suffix}`),
      };
    }

    const localPort = runtime?.localPort ?? input.localPort;
    const local = await this.probeEndpoint(context, `http://127.0.0.1:${localPort}${this.probePath}`, false);
    if (!local.ready) return { ready: false, terminal: local.terminal, detail: `local: ${local.detail}`, retryAfterMs: local.retryAfterMs };

    const endpoint = mode === "named"
      ? runtime?.publicUrl ?? (input.mode === "named" ? input.publicUrl : undefined)
      : process.endpoint ?? (runtime ? parseCloudflareQuickTunnelUrl(runtime.output) : undefined);
    if (!endpoint) {
      return { ready: false, terminal: runtime === undefined, detail: boundedDetail(`local: ready; provider: ${runtime ? "waiting for Quick Tunnel URL" : "persisted endpoint unavailable"}; log: ${runtime ? outputTail(runtime.output) : ""}`), retryAfterMs: 100 };
    }

    const publicProbe = await this.probeEndpoint(context, `${endpoint}${this.probePath}`, true);
    const providerDetail = mode === "named" ? "configured URL" : "URL acquired";
    if (!publicProbe.ready) {
      return {
        ready: false,
        terminal: publicProbe.terminal,
        endpoint,
        detail: `local: ready; provider: ${providerDetail}; public: ${publicProbe.detail}`,
        retryAfterMs: publicProbe.retryAfterMs,
      };
    }
    return { ready: true, endpoint, detail: `local: ready; provider: ${providerDetail}; public: ${publicProbe.detail}` };
  }

  async stop(context: GatewayTunnelDeadlineContext, identity: GatewayTunnelProcessIdentity, request: GatewayTunnelStopRequest): Promise<void> {
    context.throwIfExpired("stop");
    const key = runtimeKey(request);
    const runtime = this.runtimes.get(key);
    if (runtime && runtime.pid !== identity.pid) throw providerError("tunnel_ownership_denied", "Cloudflare runtime pid does not match the verified identity");
    await this.stopPid(context, identity.pid);
    if (this.runtimes.get(key)?.pid === identity.pid) this.runtimes.delete(key);
  }

  private input(request: GatewayTunnelProviderRequest): CloudflareInput {
    const raw = request.input ?? {};
    const mode = raw.mode === undefined ? "quick" : String(raw.mode);
    if (mode === "quick") {
      this.assertQuickInput(request);
      const localPort = raw.localPort === undefined ? this.defaultLocalPort : Number(raw.localPort);
      if (!isValidCloudflareLocalPort(localPort)) throw providerError("invalid_arguments", "Cloudflare localPort must be in [1, 65535]");
      const binaryPath = raw.binaryPath === undefined ? undefined : String(raw.binaryPath);
      return { mode, localPort, ...(binaryPath === undefined ? {} : { binaryPath }) };
    }
    if (mode !== "named") throw providerError("tunnel_mode_unsupported", "Only Cloudflare Quick or Named Tunnel mode is supported");

    const allowed = new Set(["mode", "tunnelId", "publicUrl", "credentialsFile", "tokenFile", "localPort", "binaryPath"]);
    const literal = Object.keys(raw).find((key) => raw[key] !== undefined && !allowed.has(key) && /token|credential|config/iu.test(key));
    if (literal) throw providerError("invalid_arguments", `Cloudflare Named Tunnel rejects literal secret/config input: ${literal}`);
    const unknown = Object.keys(raw).find((key) => !allowed.has(key));
    if (unknown) throw providerError("invalid_arguments", `Unknown Cloudflare Named Tunnel input: ${unknown}`);

    const tunnelId = requiredString(raw.tunnelId, "tunnelId");
    if (!SAFE_TUNNEL_ID.test(tunnelId)) {
      throw providerError("invalid_arguments", "Cloudflare tunnelId must be a 1-128 character safe identifier using only letters, digits, hyphens, or underscores, without leading/trailing punctuation");
    }
    const publicUrl = normalizePublicOrigin(requiredString(raw.publicUrl, "publicUrl"));
    const hasCredentialsFile = raw.credentialsFile !== undefined;
    const hasTokenFile = raw.tokenFile !== undefined;
    if (hasCredentialsFile === hasTokenFile) {
      throw providerError("invalid_arguments", "Cloudflare Named Tunnel requires exactly one of credentialsFile or tokenFile");
    }
    const credentialFlag = hasCredentialsFile ? "--credentials-file" as const : "--token-file" as const;
    const credentialPath = resolveExistingFile(
      requiredString(hasCredentialsFile ? raw.credentialsFile : raw.tokenFile, hasCredentialsFile ? "credentialsFile" : "tokenFile"),
      hasCredentialsFile ? "credentialsFile" : "tokenFile",
    );
    const localPort = raw.localPort === undefined ? this.defaultLocalPort : Number(raw.localPort);
    if (!isValidCloudflareLocalPort(localPort)) throw providerError("invalid_arguments", "Cloudflare localPort must be in [1, 65535]");
    const binaryPath = raw.binaryPath === undefined ? undefined : String(raw.binaryPath);
    return {
      mode,
      localPort,
      ...(binaryPath === undefined ? {} : { binaryPath }),
      tunnelId,
      publicUrl,
      credentialFlag,
      credentialPath,
    };
  }

  private assertQuickInput(request: GatewayTunnelProviderRequest): void {
    const input = request.input ?? {};
    const allowed = new Set(["mode", "localPort", "binaryPath"]);
    const unknown = Object.keys(input).find((key) => !allowed.has(key));
    if (unknown) throw providerError("invalid_arguments", `Unknown Cloudflare Quick Tunnel input: ${unknown}`);
    if (input.mode !== undefined && input.mode !== "quick") {
      throw providerError("tunnel_mode_unsupported", "Only Cloudflare Quick or Named Tunnel mode is supported");
    }
  }

  private async probeEndpoint(context: GatewayTunnelDeadlineContext, url: string, publicEndpoint: boolean): Promise<{ ready: boolean; terminal?: boolean; detail: string; retryAfterMs?: number }> {
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-maestro-gateway-tunnel", version: "1" } } }),
        signal: context.signal,
        redirect: "manual",
      });
      if (response.status === 200) return { ready: true, detail: "HTTP 200" };
      if (response.status === 401 && (response.headers.get("www-authenticate") ?? "").toLowerCase().includes("resource_metadata")) {
        return { ready: true, detail: "OAuth challenge reachable" };
      }
      if (publicEndpoint && response.status === 530) {
        const body = await readBoundedResponseBody(response, 32 * 1024);
        if (/\b1033\b/u.test(body)) return { ready: false, detail: "Cloudflare Error 1033 (connector registration pending)", retryAfterMs: 250 };
      }
      return { ready: false, detail: `HTTP ${response.status}`, retryAfterMs: 250 };
    } catch (error) {
      if (context.signal.aborted) context.throwIfExpired("probe");
      return { ready: false, detail: error instanceof Error ? error.message : String(error), retryAfterMs: 100 };
    }
  }

  private async stopPid(context: GatewayTunnelDeadlineContext, pid: number): Promise<void> {
    if (!this.alive(pid)) return;
    if (this.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T"], { stdio: "ignore", timeout: Math.max(1, context.remainingMs()), windowsHide: true });
    } else {
      try { this.signal(-pid, "SIGTERM"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        this.signal(pid, "SIGTERM");
      }
    }
    const graceDeadline = Math.min(context.deadlineAt, this.now() + STOP_GRACE_MS);
    while (this.alive(pid) && this.now() < graceDeadline) await waitWithinTunnelDeadline(context, Math.min(STOP_POLL_MS, graceDeadline - this.now()));
    if (!this.alive(pid)) return;
    if (this.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", timeout: Math.max(1, context.remainingMs()), windowsHide: true });
    } else {
      try { this.signal(-pid, "SIGKILL"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") this.signal(pid, "SIGKILL");
      }
    }
    if (this.alive(pid)) throw providerError("tunnel_stop_failed", `cloudflared pid ${pid} survived stop escalation`);
  }
}

function normalizeProbePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.includes("?") || trimmed.includes("#") || trimmed.length > 256) throw new Error("Cloudflare probePath must be an absolute URL path");
  return trimmed.replace(/\/$/u, "") || "/";
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw providerError("invalid_arguments", `Cloudflare ${field} must be a non-empty string without surrounding whitespace`);
  }
  return value;
}

function resolveExistingFile(value: string, field: string): string {
  if (!isAbsolute(value)) throw providerError("invalid_arguments", `Cloudflare ${field} must be an absolute existing file path`);
  try {
    const source = lstatSync(value);
    if (source.isSymbolicLink() || !source.isFile()) throw providerError("invalid_arguments", `Cloudflare ${field} must reference a non-symlink regular file`);
    const realpath = realpathSync.native(value);
    if (!statSync(realpath).isFile()) throw providerError("invalid_arguments", `Cloudflare ${field} must reference a non-symlink regular file`);
    return realpath;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "invalid_arguments") throw error;
    throw providerError("invalid_arguments", `Cloudflare ${field} must be an absolute existing file path`);
  }
}

function normalizePublicOrigin(value: string): string {
  if (!value.startsWith("https://") || value.includes("?") || value.includes("#")) {
    throw providerError("invalid_arguments", "Cloudflare publicUrl must be an HTTPS origin without credentials, query, or hash");
  }
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw providerError("invalid_arguments", "Cloudflare publicUrl must be a valid HTTPS origin"); }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/") {
    throw providerError("invalid_arguments", "Cloudflare publicUrl must be an HTTPS origin without credentials, path, query, or hash");
  }
  return parsed.origin;
}

function runtimeKey(request: Pick<GatewayTunnelProviderRequest, "generation" | "ownerToken">): string {
  return `${request.generation}\0${request.ownerToken}`;
}

function appendBounded(runtime: CloudflareRuntime, chunk: Buffer | string, maximumBytes: number): void {
  if (!chunk || (typeof chunk === "string" && chunk.length === 0)) return;
  const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
  const incoming = raw.byteLength <= maximumBytes ? raw : raw.subarray(raw.byteLength - maximumBytes);
  const retained = runtime.output.byteLength + incoming.byteLength <= maximumBytes
    ? runtime.output
    : runtime.output.subarray(Math.min(runtime.output.byteLength, runtime.output.byteLength + incoming.byteLength - maximumBytes));
  runtime.output = Buffer.concat([retained, incoming]);
}

async function readBoundedResponseBody(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < maximumBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const bounded = Buffer.from(value).subarray(0, maximumBytes - total);
      chunks.push(bounded);
      total += bounded.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function outputTail(output: Buffer, maximumBytes = 1024): string {
  return output.subarray(Math.max(0, output.byteLength - maximumBytes)).toString("utf8").trim();
}

function boundedDetail(value: string): string {
  const buffer = Buffer.from(value, "utf8");
  return buffer.byteLength <= 16 * 1024 ? value : buffer.subarray(buffer.byteLength - 16 * 1024).toString("utf8");
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function discoverProc(localPort: number): CloudflareQuickTunnelProcess[] | undefined {
  let entries: string[];
  try { entries = readdirSync("/proc"); } catch { return undefined; }
  const matches: CloudflareQuickTunnelProcess[] = [];
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const argv = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean);
      const commandLine = argv.map(quoteCommandPart).join(" ");
      if (isCloudflareQuickTunnelCommandLine(commandLine, localPort)) matches.push({ pid: Number(entry), commandLine });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
  }
  return matches;
}

function discoverPs(localPort: number): CloudflareQuickTunnelProcess[] | undefined {
  const result = spawnSync("ps", ["-wwaxo", "pid=,command="], { encoding: "utf8", timeout: 5_000, shell: false });
  if (result.status !== 0 || result.error) return undefined;
  const matches: CloudflareQuickTunnelProcess[] = [];
  for (const line of String(result.stdout || "").split(/\r?\n/u)) {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/u);
    if (match && isCloudflareQuickTunnelCommandLine(match[2]!, localPort)) matches.push({ pid: Number(match[1]), commandLine: match[2]! });
  }
  return matches;
}

function discoverWindows(localPort: number): CloudflareQuickTunnelProcess[] | undefined {
  const script = "$ErrorActionPreference='Stop';@(Get-CimInstance Win32_Process -Filter \"Name='cloudflared.exe'\"|Select-Object ProcessId,CommandLine)|ConvertTo-Json -Compress";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 5_000, shell: false, windowsHide: true });
  if (result.status !== 0 || result.error) return undefined;
  try {
    const parsed = JSON.parse(String(result.stdout || "null")) as unknown;
    const values = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed];
    const matches: CloudflareQuickTunnelProcess[] = [];
    for (const value of values) {
      if (!value || typeof value !== "object") return undefined;
      const record = value as { ProcessId?: unknown; CommandLine?: unknown };
      if (!Number.isSafeInteger(record.ProcessId) || typeof record.CommandLine !== "string") return undefined;
      if (isCloudflareQuickTunnelCommandLine(record.CommandLine, localPort)) matches.push({ pid: Number(record.ProcessId), commandLine: record.CommandLine });
    }
    return matches;
  } catch { return undefined; }
}

function quoteCommandPart(value: string): string {
  return /\s/u.test(value) ? `"${value.replace(/"/gu, '\\"')}"` : value;
}

function providerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
