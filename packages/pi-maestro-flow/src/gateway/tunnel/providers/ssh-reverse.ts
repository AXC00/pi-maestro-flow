/** Managed OpenSSH reverse-tunnel provider for the native Gateway tunnel supervisor. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
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
import { runWithinTunnelDeadline, waitWithinTunnelDeadline } from "../probe.ts";

export const SSH_REVERSE_TUNNEL_PROVIDER = "ssh" as const;
const DEFAULT_LOCAL_PORT = 9090;
const DEFAULT_MCP_PATH = "/mcp";
const STOP_GRACE_MS = 2_000;
const STOP_POLL_MS = 50;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const SAFE_USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const FORWARDING_DIRECTIVE = /^(?:localforward|remoteforward|dynamicforward)\s+/imu;

export type SshReverseReferenceField = "identityFile" | "configFile" | "knownHostsFile";

export interface SshReverseCommandResult {
  code: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface SshReverseTunnelProviderOptions {
  binaryPath?: string;
  defaultLocalPort?: number;
  mcpPath?: string;
  fetch?: typeof fetch;
  spawn?: typeof spawn;
  resolveBinary?: (explicitPath?: string) => string | undefined;
  resolveFile?: (path: string, field: SshReverseReferenceField) => string | undefined;
  runCommand?: (command: string, args: readonly string[], context: GatewayTunnelDeadlineContext) => Promise<SshReverseCommandResult>;
  processAlive?: (pid: number) => boolean;
  signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  now?: () => number;
}

interface SshReverseInput {
  mode: "reverse";
  binaryPath?: string;
  localPort: number;
  mcpPath: string;
  publicUrl: string;
  host: string;
  user?: string;
  port: number;
  remoteBindHost: "127.0.0.1" | "::1";
  remotePort: number;
  localHost: "127.0.0.1" | "::1";
  identityFile?: string;
  configFile?: string;
  knownHostsFile?: string;
  connectTimeoutSeconds: number;
  serverAliveIntervalSeconds: number;
  serverAliveCountMax: number;
}

interface ResolvedSshReverseInput extends SshReverseInput {
  executablePath: string;
}

interface SshReverseRuntime {
  key: string;
  pid: number;
  executablePath: string;
  args: readonly string[];
  input: ResolvedSshReverseInput;
  child?: ChildProcess;
  exited?: Promise<GatewayTunnelExit>;
  exit?: GatewayTunnelExit;
}

export function resolveSshExecutable(explicitPath?: string): string | undefined {
  if (explicitPath !== undefined) return resolveExecutableFile(explicitPath);
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["ssh"], {
    encoding: "utf8",
    timeout: 5_000,
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) return undefined;
  const first = String(result.stdout || "").split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
  return first ? resolveExecutableFile(first) : undefined;
}

export function resolveSshReferenceFile(path: string): string | undefined {
  if (!isAbsolute(path)) return undefined;
  try {
    const source = lstatSync(path);
    if (source.isSymbolicLink() || !source.isFile()) return undefined;
    const canonical = realpathSync.native(path);
    return statSync(canonical).isFile() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

export function sshReverseTunnelArgs(input: Omit<ResolvedSshReverseInput, "mode" | "binaryPath" | "executablePath" | "mcpPath" | "publicUrl">): string[] {
  return [
    ...(input.configFile ? ["-F", input.configFile] : []),
    ...(input.identityFile ? ["-i", input.identityFile] : []),
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "PermitLocalCommand=no",
    "-o", "RequestTTY=no",
    "-o", "ForkAfterAuthentication=no",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ControlPersist=no",
    // `yes` clears command-line -R entries in OpenSSH. Doctor rejects configured
    // forwards, then this explicit `no` preserves the single managed -R below.
    "-o", "ClearAllForwardings=no",
    "-o", `ConnectTimeout=${input.connectTimeoutSeconds}`,
    "-o", `ServerAliveInterval=${input.serverAliveIntervalSeconds}`,
    "-o", `ServerAliveCountMax=${input.serverAliveCountMax}`,
    ...(input.knownHostsFile ? ["-o", `UserKnownHostsFile=${input.knownHostsFile}`] : []),
    "-p", String(input.port),
    "-N",
    "-R", `${formatForwardHost(input.remoteBindHost)}:${input.remotePort}:${formatForwardHost(input.localHost)}:${input.localPort}`,
    input.user ? `${input.user}@${input.host}` : input.host,
  ];
}

export class SshReverseTunnelProvider implements GatewayTunnelProvider {
  readonly name = SSH_REVERSE_TUNNEL_PROVIDER;
  readonly stability = "stable" as const;
  private readonly binaryPath?: string;
  private readonly defaultLocalPort: number;
  private readonly defaultMcpPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: typeof spawn;
  private readonly resolveBinary: NonNullable<SshReverseTunnelProviderOptions["resolveBinary"]>;
  private readonly resolveFile: NonNullable<SshReverseTunnelProviderOptions["resolveFile"]>;
  private readonly runCommand: NonNullable<SshReverseTunnelProviderOptions["runCommand"]>;
  private readonly alive: (pid: number) => boolean;
  private readonly signal: (pid: number, signal: NodeJS.Signals | 0) => void;
  private readonly now: () => number;
  private readonly runtimes = new Map<string, SshReverseRuntime>();

  constructor(options: SshReverseTunnelProviderOptions = {}) {
    this.binaryPath = options.binaryPath;
    this.defaultLocalPort = options.defaultLocalPort ?? DEFAULT_LOCAL_PORT;
    assertPort(this.defaultLocalPort, "defaultLocalPort");
    this.defaultMcpPath = normalizeMcpPath(options.mcpPath ?? DEFAULT_MCP_PATH);
    this.fetchImpl = options.fetch ?? fetch;
    this.spawnImpl = options.spawn ?? spawn;
    this.resolveBinary = options.resolveBinary ?? resolveSshExecutable;
    this.resolveFile = options.resolveFile ?? ((path) => resolveSshReferenceFile(path));
    this.runCommand = options.runCommand ?? runSshCommand;
    this.alive = options.processAlive ?? processAlive;
    this.signal = options.signalProcess ?? ((pid, value) => process.kill(pid, value));
    this.now = options.now ?? (() => Date.now());
  }

  async doctor(context: GatewayTunnelDeadlineContext, request: GatewayTunnelProviderRequest): Promise<GatewayTunnelDoctorResult> {
    try {
      context.throwIfExpired("doctor");
      const input = this.resolveInput(request);
      const versionResult = await runWithinTunnelDeadline(context, "ssh version", () => this.runCommand(input.executablePath, ["-V"], context));
      const versionOutput = `${versionResult.stderr}\n${versionResult.stdout}`.trim();
      const version = parseOpenSshVersion(versionOutput);
      if (versionResult.code !== 0 || versionResult.stdoutTruncated || versionResult.stderrTruncated || !version) {
        return { ok: false, executablePath: input.executablePath, detail: "Configured ssh executable did not report a bounded supported OpenSSH identity" };
      }
      const expanded = await runWithinTunnelDeadline(context, "ssh config", () => this.runCommand(input.executablePath, sshConfigurationArgs(input), context));
      if (expanded.code !== 0) {
        return { ok: false, executablePath: input.executablePath, version, detail: "OpenSSH could not evaluate the configured destination" };
      }
      if (expanded.stdoutTruncated || expanded.stderrTruncated) {
        return { ok: false, executablePath: input.executablePath, version, detail: "OpenSSH effective configuration exceeded the bounded doctor output" };
      }
      if (FORWARDING_DIRECTIVE.test(expanded.stdout)) {
        return { ok: false, executablePath: input.executablePath, version, detail: "SSH configuration contains forwarding directives; the managed profile requires exactly one reverse forwarding" };
      }
      return { ok: true, executablePath: input.executablePath, version };
    } catch (error) {
      return { ok: false, detail: boundedDetail(error instanceof Error ? error.message : String(error)) };
    }
  }

  async start(context: GatewayTunnelDeadlineContext, request: GatewayTunnelProviderRequest): Promise<GatewayTunnelStartResult> {
    context.throwIfExpired("start");
    const checked = await this.doctor(context, request);
    if (!checked.ok) throw providerError("tunnel_doctor_failed", checked.detail ?? "OpenSSH doctor failed");
    const input = this.resolveInput(request);
    const args = sshReverseTunnelArgs(input);
    const child = this.spawnImpl(input.executablePath, args, {
      detached: false,
      stdio: ["ignore", "ignore", "ignore"],
      shell: false,
      windowsHide: true,
    });
    let handleSpawnError = (_error: Error): void => undefined;
    child.once("error", (error) => handleSpawnError(error));
    if (!child.pid) {
      try { child.kill(); } catch { /* no process was created */ }
      throw providerError("tunnel_spawn_failed", "ssh did not publish a process id");
    }
    child.unref();
    const key = runtimeKey(request);
    let settle!: (exit: GatewayTunnelExit) => void;
    let settled = false;
    const exited = new Promise<GatewayTunnelExit>((resolve) => { settle = resolve; });
    const runtime: SshReverseRuntime = {
      key,
      pid: child.pid,
      executablePath: input.executablePath,
      args,
      input,
      child,
      exited,
    };
    const finish = (exit: GatewayTunnelExit): void => {
      if (settled) return;
      settled = true;
      runtime.exit = exit;
      settle(exit);
    };
    handleSpawnError = (error) => finish({ code: null, at: this.now(), detail: boundedDetail(`ssh spawn failed: ${error.message}`) });
    child.once("exit", (code, signal) => finish({ code, signal, at: this.now() }));
    this.runtimes.set(key, runtime);
    return {
      pid: runtime.pid,
      executablePath: runtime.executablePath,
      args,
      endpoint: input.publicUrl,
      exited,
      child,
    };
  }

  async probe(context: GatewayTunnelDeadlineContext, process: GatewayTunnelStartResult, request: GatewayTunnelProviderRequest): Promise<GatewayTunnelProbeResult> {
    context.throwIfExpired("probe");
    const runtime = this.runtimes.get(runtimeKey(request));
    if (!runtime || runtime.pid !== process.pid) {
      return { ready: false, terminal: true, ...(process.endpoint ? { endpoint: process.endpoint } : {}), detail: "OpenSSH runtime is not owned by this provider generation" };
    }
    if (runtime.exit || !this.alive(runtime.pid)) {
      return { ready: false, terminal: true, endpoint: runtime.input.publicUrl, detail: `ssh exited before readiness (exit=${runtime.exit?.code ?? "unknown"})` };
    }
    const localUrl = `http://${formatUrlHost(runtime.input.localHost)}:${runtime.input.localPort}${runtime.input.mcpPath}`;
    const publicMcpUrl = `${runtime.input.publicUrl}${runtime.input.mcpPath}`;
    const expectedMetadataUrl = expectedResourceMetadataUrl(publicMcpUrl);
    const local = await this.probeEndpoint(context, localUrl, expectedMetadataUrl);
    if (!local.ready) return { ready: false, terminal: local.terminal, endpoint: runtime.input.publicUrl, detail: `local: ${local.detail}`, retryAfterMs: local.retryAfterMs };
    const publicProbe = await this.probeEndpoint(context, publicMcpUrl, expectedMetadataUrl);
    if (!publicProbe.ready) {
      return { ready: false, terminal: publicProbe.terminal, endpoint: runtime.input.publicUrl, detail: `local: ${local.detail}; public: ${publicProbe.detail}`, retryAfterMs: publicProbe.retryAfterMs };
    }
    return { ready: true, endpoint: runtime.input.publicUrl, detail: `local: ${local.detail}; public: ${publicProbe.detail}` };
  }

  /** A recovered PID has no Node exit handle, so verified recovery always restarts it. */
  async adopt(context: GatewayTunnelDeadlineContext, _identity: GatewayTunnelProcessIdentity, _request: GatewayTunnelProviderRequest): Promise<undefined> {
    context.throwIfExpired("adopt");
    return undefined;
  }

  async stop(context: GatewayTunnelDeadlineContext, identity: GatewayTunnelProcessIdentity, request: GatewayTunnelStopRequest): Promise<void> {
    context.throwIfExpired("stop");
    const key = runtimeKey(request);
    const runtime = this.runtimes.get(key);
    if (runtime && runtime.pid !== identity.pid) throw providerError("tunnel_ownership_denied", "OpenSSH runtime pid does not match the verified identity");
    await this.stopPid(context, identity.pid);
    if (this.runtimes.get(key)?.pid === identity.pid) this.runtimes.delete(key);
  }

  private resolveInput(request: GatewayTunnelProviderRequest): ResolvedSshReverseInput {
    const input = this.input(request);
    const executablePath = this.resolveBinary(input.binaryPath ?? this.binaryPath);
    if (!executablePath) throw providerError("tunnel_doctor_failed", input.binaryPath ?? this.binaryPath ? "Configured ssh executable is unavailable or not executable" : "ssh was not found on PATH");
    const resolveReference = (path: string | undefined, field: SshReverseReferenceField): string | undefined => {
      if (path === undefined) return undefined;
      const resolved = this.resolveFile(path, field);
      if (!resolved) throw providerError("invalid_arguments", `SSH ${field} must reference an absolute, non-symlink regular file`);
      return resolved;
    };
    const identityFile = resolveReference(input.identityFile, "identityFile");
    const configFile = resolveReference(input.configFile, "configFile");
    const knownHostsFile = resolveReference(input.knownHostsFile, "knownHostsFile");
    return {
      ...input,
      executablePath,
      ...(identityFile ? { identityFile } : {}),
      ...(configFile ? { configFile } : {}),
      ...(knownHostsFile ? { knownHostsFile } : {}),
    };
  }

  private input(request: GatewayTunnelProviderRequest): SshReverseInput {
    const raw = request.input ?? {};
    const forbidden = ["password", "passphrase", "privateKey", "privateKeyContents", "identityContents", "configContents", "argv", "args", "command", "remoteCommand", "environment", "env"].find((key) => raw[key] !== undefined);
    if (forbidden) throw providerError("invalid_arguments", `SSH Reverse Tunnel rejects secret, command, or arbitrary argv input: ${forbidden}`);
    const allowed = new Set([
      "mode", "binaryPath", "localPort", "mcpPath", "publicUrl", "host", "user", "port", "remoteBindHost", "remotePort",
      "localHost", "identityFile", "configFile", "knownHostsFile", "connectTimeoutSeconds", "serverAliveIntervalSeconds", "serverAliveCountMax",
    ]);
    const unknown = Object.keys(raw).find((key) => !allowed.has(key));
    if (unknown) throw providerError("invalid_arguments", `Unknown SSH Reverse Tunnel input: ${unknown}`);
    if (raw.mode !== "reverse") throw providerError("tunnel_mode_unsupported", "Only SSH Reverse Tunnel mode is supported");
    const localPort = integer(raw.localPort, "localPort", 1, 65_535, this.defaultLocalPort);
    const mcpPath = normalizeMcpPath(raw.mcpPath === undefined ? this.defaultMcpPath : requiredString(raw.mcpPath, "mcpPath", 256));
    const publicUrl = normalizePublicOrigin(requiredString(raw.publicUrl, "publicUrl", 2048));
    const host = requiredString(raw.host, "host", 255);
    if (!SAFE_HOST.test(host) || host.startsWith("-")) throw providerError("invalid_arguments", "SSH host must be a safe, bounded, non-option hostname or address");
    const user = optionalString(raw.user, "user", 64);
    if (user !== undefined && (!SAFE_USER.test(user) || user.startsWith("-"))) throw providerError("invalid_arguments", "SSH user must be a safe, bounded, non-option name");
    const port = integer(raw.port, "port", 1, 65_535, 22);
    const remoteBindHost = loopback(raw.remoteBindHost, "remoteBindHost");
    const remotePort = integer(raw.remotePort, "remotePort", 1, 65_535);
    const localHost = loopback(raw.localHost, "localHost");
    const binaryPath = optionalString(raw.binaryPath, "binaryPath", 4096);
    const identityFile = optionalString(raw.identityFile, "identityFile", 4096);
    const configFile = optionalString(raw.configFile, "configFile", 4096);
    const knownHostsFile = optionalString(raw.knownHostsFile, "knownHostsFile", 4096);
    const connectTimeoutSeconds = integer(raw.connectTimeoutSeconds, "connectTimeoutSeconds", 1, 120, 10);
    const serverAliveIntervalSeconds = integer(raw.serverAliveIntervalSeconds, "serverAliveIntervalSeconds", 5, 300, 15);
    const serverAliveCountMax = integer(raw.serverAliveCountMax, "serverAliveCountMax", 1, 10, 3);
    return {
      mode: "reverse",
      ...(binaryPath ? { binaryPath } : {}),
      localPort,
      mcpPath,
      publicUrl,
      host,
      ...(user ? { user } : {}),
      port,
      remoteBindHost,
      remotePort,
      localHost,
      ...(identityFile ? { identityFile } : {}),
      ...(configFile ? { configFile } : {}),
      ...(knownHostsFile ? { knownHostsFile } : {}),
      connectTimeoutSeconds,
      serverAliveIntervalSeconds,
      serverAliveCountMax,
    };
  }

  private async probeEndpoint(context: GatewayTunnelDeadlineContext, url: string, expectedMetadataUrl: string): Promise<{ ready: boolean; terminal?: boolean; detail: string; retryAfterMs?: number }> {
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-maestro-ssh-reverse-tunnel", version: "1" } } }),
        signal: context.signal,
        redirect: "manual",
      });
      if (response.status === 200 && (response.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
        const body = await readBoundedResponseBody(response, 64 * 1024);
        if (isMcpInitializeResponse(body)) return { ready: true, detail: "MCP initialize ready" };
        return { ready: false, detail: "HTTP 200 without a valid MCP initialize response", retryAfterMs: 250 };
      }
      if (response.status === 401) {
        const metadata = oauthResourceMetadata(response.headers.get("www-authenticate") ?? "");
        await response.body?.cancel().catch(() => undefined);
        if (metadata === expectedMetadataUrl) return { ready: true, detail: "OAuth challenge reachable" };
        return { ready: false, detail: "OAuth challenge resource metadata does not match the probed endpoint", retryAfterMs: 250 };
      }
      await response.body?.cancel().catch(() => undefined);
      return { ready: false, detail: `HTTP ${response.status}`, retryAfterMs: 250 };
    } catch (error) {
      if (context.signal.aborted) context.throwIfExpired("probe");
      return { ready: false, detail: boundedDetail(error instanceof Error ? error.message : String(error)), retryAfterMs: 100 };
    }
  }

  private async stopPid(context: GatewayTunnelDeadlineContext, pid: number): Promise<void> {
    if (!this.alive(pid)) return;
    signalPid(this.signal, pid, "SIGTERM");
    const graceAt = Math.min(context.deadlineAt, this.now() + STOP_GRACE_MS);
    while (this.alive(pid) && this.now() < graceAt) await waitWithinTunnelDeadline(context, Math.min(STOP_POLL_MS, graceAt - this.now()));
    if (!this.alive(pid)) return;
    signalPid(this.signal, pid, "SIGKILL");
    if (this.alive(pid)) throw providerError("tunnel_stop_failed", `ssh pid ${pid} survived stop escalation`);
  }
}

function resolveExecutableFile(path: string): string | undefined {
  const value = path.trim();
  if (!value || !isAbsolute(value)) return undefined;
  try {
    const canonical = realpathSync.native(value);
    if (!statSync(canonical).isFile()) return undefined;
    if (process.platform !== "win32") accessSync(canonical, constants.X_OK);
    return canonical;
  } catch {
    return undefined;
  }
}

function sshConfigurationArgs(input: ResolvedSshReverseInput): string[] {
  const args = sshReverseTunnelArgs(input);
  const reverseIndex = args.indexOf("-R");
  if (reverseIndex < 0) throw new Error("Managed SSH reverse forwarding is unavailable");
  return ["-G", ...args.slice(0, reverseIndex), ...args.slice(reverseIndex + 2)];
}

async function runSshCommand(command: string, args: readonly string[], context: GatewayTunnelDeadlineContext): Promise<SshReverseCommandResult> {
  return new Promise<SshReverseCommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      signal: context.signal,
    });
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    const finish = (result: SshReverseCommandResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const next = appendBounded(stdout, chunk);
      stdout = next.output;
      stdoutTruncated ||= next.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const next = appendBounded(stderr, chunk);
      stderr = next.output;
      stderrTruncated ||= next.truncated;
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code, signal) => finish({
      code,
      signal,
      stdout: stdout.toString("utf8"),
      stderr: stderr.toString("utf8"),
      ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
      ...(stderrTruncated ? { stderrTruncated: true } : {}),
    }));
  });
}

function appendBounded(current: Buffer, chunk: Buffer | string): { output: Buffer; truncated: boolean } {
  const raw = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
  const truncated = current.byteLength + raw.byteLength > MAX_COMMAND_OUTPUT_BYTES;
  const incoming = raw.byteLength <= MAX_COMMAND_OUTPUT_BYTES ? raw : raw.subarray(raw.byteLength - MAX_COMMAND_OUTPUT_BYTES);
  const retained = current.byteLength + incoming.byteLength <= MAX_COMMAND_OUTPUT_BYTES
    ? current
    : current.subarray(Math.min(current.byteLength, current.byteLength + incoming.byteLength - MAX_COMMAND_OUTPUT_BYTES));
  return { output: Buffer.concat([retained, incoming]), truncated };
}

async function readBoundedResponseBody(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || total + value.byteLength > maximumBytes) throw new Error("MCP initialize response exceeded the bounded probe body");
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function isMcpInitializeResponse(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as { jsonrpc?: unknown; id?: unknown; result?: { protocolVersion?: unknown } };
    return parsed?.jsonrpc === "2.0" && parsed.id === 1 && typeof parsed.result?.protocolVersion === "string";
  } catch {
    return false;
  }
}

function oauthResourceMetadata(value: string): string | undefined {
  return value.match(/(?:^|[,\s])resource_metadata\s*=\s*"([^"]+)"/iu)?.[1];
}

function expectedResourceMetadataUrl(endpoint: string): string {
  const parsed = new URL(endpoint);
  return `${parsed.origin}/.well-known/oauth-protected-resource${parsed.pathname}`;
}

function parseOpenSshVersion(value: string): string | undefined {
  return value.match(/OpenSSH(?:_for_[A-Za-z0-9]+)?[_-]([^,\s]+)/u)?.[1];
}

function formatForwardHost(host: "127.0.0.1" | "::1"): string {
  return host === "::1" ? "[::1]" : host;
}

function formatUrlHost(host: "127.0.0.1" | "::1"): string {
  return host === "::1" ? "[::1]" : host;
}

function normalizeMcpPath(value: string): string {
  const path = value.trim();
  if (!path.startsWith("/") || path.includes("?") || path.includes("#") || path.length > 256) {
    throw providerError("invalid_arguments", "SSH Reverse Tunnel mcpPath must be an absolute URL path without query or hash");
  }
  return path === "/" ? "/" : path.replace(/\/$/u, "");
}

function normalizePublicOrigin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw providerError("invalid_arguments", "SSH Reverse Tunnel publicUrl must be a valid HTTPS origin"); }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw providerError("invalid_arguments", "SSH Reverse Tunnel publicUrl must be an HTTPS origin without credentials, path, query, or hash");
  }
  return parsed.origin;
}

function requiredString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value || value !== value.trim() || Buffer.byteLength(value, "utf8") > maximum || /[\0\r\n]/u.test(value)) {
    throw providerError("invalid_arguments", `SSH Reverse Tunnel ${field} must be a bounded non-empty string without surrounding whitespace or control characters`);
  }
  return value;
}

function optionalString(value: unknown, field: string, maximum: number): string | undefined {
  return value === undefined ? undefined : requiredString(value, field, maximum);
}

function integer(value: unknown, field: string, minimum: number, maximum: number, fallback?: number): number {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || Number(resolved) < minimum || Number(resolved) > maximum) {
    throw providerError("invalid_arguments", `SSH Reverse Tunnel ${field} must be an integer in [${minimum}, ${maximum}]`);
  }
  return Number(resolved);
}

function assertPort(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error(`SSH Reverse Tunnel ${field} must be in [1, 65535]`);
}

function loopback(value: unknown, field: string): "127.0.0.1" | "::1" {
  if (value === "127.0.0.1" || value === "::1") return value;
  throw providerError("invalid_arguments", `SSH Reverse Tunnel ${field} must be loopback`);
}

function runtimeKey(request: Pick<GatewayTunnelProviderRequest, "generation" | "ownerToken">): string {
  return `${request.generation}\0${request.ownerToken}`;
}

function signalPid(signal: (pid: number, signal: NodeJS.Signals | 0) => void, pid: number, value: NodeJS.Signals): void {
  try { signal(pid, value); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function boundedDetail(value: string): string {
  const buffer = Buffer.from(value, "utf8");
  return buffer.byteLength <= 16 * 1024 ? value : buffer.subarray(buffer.byteLength - 16 * 1024).toString("utf8");
}

function providerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
