/** Experimental OpenAI Secure MCP Tunnel provider (external CLI orchestration only). */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { gatewayGlobalStateRoot } from "../../state-paths.ts";
import {
  ensureManagedOpenAiTunnelClient,
  managedOpenAiTunnelClientPath,
  openAiTunnelClientAssetFor,
  sha256File,
  type OpenAiManagedInstallOptions,
  type OpenAiTunnelClientAsset,
} from "./openai-client-managed.ts";
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
import {
  OPENAI_TUNNEL_CLIENT_CONTRACT,
  OPENAI_TUNNEL_CLIENT_EXECUTABLE,
  OPENAI_TUNNEL_CLIENT_MINIMUM_VERSION,
  OPENAI_TUNNEL_PROVIDER,
  OPENAI_TUNNEL_RUNTIME_KEY_ENV,
  assertOpenAiTunnelId,
  isSupportedOpenAiTunnelClientVersion,
  parseOpenAiTunnelClientVersion,
  renderOpenAiTunnelClientConfig,
  type OpenAiTunnelClientContract,
} from "./openai-client-contract.ts";

const DEFAULT_LOCAL_PORT = 9090;
const DEFAULT_MCP_PATH = "/mcp";
const DEFAULT_CREDENTIAL_TTL_MS = 5 * 60_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const STOP_GRACE_MS = 2_000;

export interface OpenAiTunnelGatewayCredential {
  id: string;
  token: string;
  expiresAt: number;
}

export interface OpenAiTunnelProviderOptions {
  /** Explicit opt-in. The provider is experimental and disabled by default. */
  enabled?: boolean;
  /** Explicit opt-in for the pinned, verified managed download. Off by default. */
  autoInstall?: boolean;
  /** Root for the managed client install; defaults to the Gateway global state tools directory. */
  managedRoot?: string;
  /** Test seam for the managed install path. */
  installManagedClient?: (options: OpenAiManagedInstallOptions) => Promise<string>;
  /** Test seam for managed-binary integrity verification; defaults to the pinned SHA-256 check. */
  verifyManagedBinary?: (executablePath: string, asset: OpenAiTunnelClientAsset) => Promise<boolean>;
  binaryPath?: string;
  minimumVersion?: string;
  tunnelIdEnv?: string;
  runtimeKeyEnv?: string;
  defaultLocalPort?: number;
  mcpPath?: string;
  credentialTtlMs?: number;
  environment?: NodeJS.ProcessEnv;
  contract?: OpenAiTunnelClientContract;
  issueGatewayCredential?: (request: GatewayTunnelProviderRequest, ttlMs: number) => Promise<OpenAiTunnelGatewayCredential>;
  revokeGatewayCredential?: (id: string) => void | Promise<void>;
  fetch?: typeof fetch;
  spawn?: typeof spawn;
  runCommand?: (command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; context: GatewayTunnelDeadlineContext }) => Promise<OpenAiTunnelCommandResult>;
  processAlive?: (pid: number) => boolean;
  signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  now?: () => number;
  platform?: NodeJS.Platform;
  temporaryRoot?: string;
}

export interface OpenAiTunnelCommandResult {
  code: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface OpenAiInput {
  enabled: boolean;
  autoInstall: boolean;
  binaryPath?: string;
  localPort: number;
  mcpPath: string;
  publicUrl?: string;
  tunnelIdEnv: string;
  runtimeKeyEnv: string;
  credentialTtlMs: number;
}

interface ValidatedDoctor {
  executablePath: string;
  version: string;
  input: OpenAiInput;
}

interface OpenAiClientDiscovery {
  executablePath: string;
  source: "explicit" | "path" | "managed" | "downloaded";
  /** Pre-verified for managed/downloaded candidates; explicit/PATH candidates are checked by doctor. */
  version?: string;
}

interface OpenAiRuntime {
  key: string;
  pid: number;
  child: ChildProcess;
  executablePath: string;
  args: readonly string[];
  input: OpenAiInput;
  tunnelId: string;
  gatewayCredential: OpenAiTunnelGatewayCredential;
  directory: string;
  configPath: string;
  authorizationPath: string;
  healthUrlPath: string;
  logPath: string;
  exited: Promise<GatewayTunnelExit>;
  exit?: GatewayTunnelExit;
  rotationTimer?: ReturnType<typeof setTimeout>;
  cleaned: boolean;
}

export function resolveOpenAiTunnelClient(explicitPath?: string): string | undefined {
  if (explicitPath !== undefined) {
    const candidate = explicitPath.trim();
    if (!candidate || !isAbsolute(candidate) || !existsSync(candidate)) return undefined;
    try { return realpathSync.native(candidate); } catch { return undefined; }
  }
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [OPENAI_TUNNEL_CLIENT_EXECUTABLE], {
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

/** Redaction is applied to every child diagnostic before it can reach state or an error. */
export function redactOpenAiTunnelText(value: string, secrets: readonly string[] = []): string {
  let result = value;
  for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]");
  result = result
    .replace(/(?:sk|rk|sess)-[A-Za-z0-9._-]{8,}/gu, "[REDACTED]")
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)[^\s"']+/giu, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret)\s*[:=]\s*)[^\s,"']+/giu, "$1[REDACTED]");
  const bytes = Buffer.from(result, "utf8");
  return bytes.byteLength <= 16 * 1024 ? result : bytes.subarray(bytes.byteLength - 16 * 1024).toString("utf8");
}

export class OpenAiTunnelProvider implements GatewayTunnelProvider {
  readonly name = OPENAI_TUNNEL_PROVIDER;
  readonly stability = "experimental" as const;
  private readonly options: OpenAiTunnelProviderOptions;
  private readonly contract: OpenAiTunnelClientContract;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: typeof spawn;
  private readonly runCommandImpl: NonNullable<OpenAiTunnelProviderOptions["runCommand"]>;
  private readonly alive: (pid: number) => boolean;
  private readonly signal: (pid: number, signal: NodeJS.Signals | 0) => void;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly runtimes = new Map<string, OpenAiRuntime>();
  private readonly doctors = new Map<string, ValidatedDoctor>();

  constructor(options: OpenAiTunnelProviderOptions = {}) {
    this.options = options;
    this.contract = options.contract ?? OPENAI_TUNNEL_CLIENT_CONTRACT;
    this.env = options.environment ?? process.env;
    this.fetchImpl = options.fetch ?? fetch;
    this.spawnImpl = options.spawn ?? spawn;
    this.runCommandImpl = options.runCommand ?? runOpenAiTunnelCommand;
    this.alive = options.processAlive ?? processAlive;
    this.signal = options.signalProcess ?? ((pid, value) => process.kill(pid, value));
    this.now = options.now ?? (() => Date.now());
    this.platform = options.platform ?? process.platform;
  }

  async doctor(context: GatewayTunnelDeadlineContext, request: GatewayTunnelProviderRequest): Promise<GatewayTunnelDoctorResult> {
    try {
      const input = this.input(request);
      context.throwIfExpired("doctor");
      if (!input.enabled) return { ok: false, detail: "experimental_blocked: OpenAI Tunnel is experimental and must be explicitly enabled" };
      const discovered = await this.discoverClient(context, input);
      if (!discovered) {
        return { ok: false, detail: "client_not_installed: tunnel-client was not found via binaryPath, PATH, or the managed install; set binaryPath or enable auto_install for a pinned verified download" };
      }
      const { executablePath } = discovered;
      const tunnelId = this.secretReference(input.tunnelIdEnv, "tunnel id");
      const runtimeKey = this.secretReference(input.runtimeKeyEnv, "runtime API key");
      if (!tunnelId || !runtimeKey) return { ok: false, detail: "credentials_missing: configured tunnel id/runtime API key environment references are unavailable" };
      assertOpenAiTunnelId(tunnelId);
      const environment = this.childEnvironment(input, runtimeKey);
      const minimum = this.options.minimumVersion ?? OPENAI_TUNNEL_CLIENT_MINIMUM_VERSION;
      let version = discovered.version;
      if (version === undefined) {
        const versionResult = await runWithinTunnelDeadline(context, "client version", () => this.runCommandImpl(executablePath, this.contract.versionArgs, { env: environment, context }));
        const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`;
        version = versionResult.code === 0 ? parseOpenAiTunnelClientVersion(versionOutput) : undefined;
        if (!version) return { ok: false, detail: `client_identity_invalid: ${redactOpenAiTunnelText(versionOutput, [runtimeKey]).trim() || "unrecognized tunnel-client --version output"}` };
      }
      if (!isSupportedOpenAiTunnelClientVersion(version, minimum)) return { ok: false, detail: `client_version_incompatible: tunnel-client ${version} is outside supported ${minimum}..0.0.x`, executablePath, version };
      this.doctors.set(runtimeKeyFor(request), { executablePath, version, input });
      return { ok: true, executablePath, version, detail: `experimental: validated public tunnel-client CLI contract ${version} (source: ${discovered.source})` };
    } catch (error) {
      return { ok: false, detail: redactOpenAiTunnelText(error instanceof Error ? error.message : String(error)) };
    }
  }

  async start(context: GatewayTunnelDeadlineContext, request: GatewayTunnelProviderRequest): Promise<GatewayTunnelStartResult> {
    context.throwIfExpired("start");
    let validated = this.doctors.get(runtimeKeyFor(request));
    if (!validated) {
      const checked = await this.doctor(context, request);
      if (!checked.ok) throw providerError("tunnel_doctor_failed", checked.detail ?? "OpenAI Tunnel doctor failed");
      validated = this.doctors.get(runtimeKeyFor(request));
    }
    if (!validated) throw providerError("tunnel_doctor_failed", "OpenAI Tunnel validated doctor state is unavailable");
    this.doctors.delete(runtimeKeyFor(request));
    const tunnelId = this.secretReference(validated.input.tunnelIdEnv, "tunnel id");
    const runtimeKey = this.secretReference(validated.input.runtimeKeyEnv, "runtime API key");
    if (!tunnelId || !runtimeKey) throw providerError("credentials_missing", "OpenAI Tunnel credential references disappeared after doctor");
    assertOpenAiTunnelId(tunnelId);
    if (!this.options.issueGatewayCredential || !this.options.revokeGatewayCredential) {
      throw providerError("credentials_missing", "OpenAI Tunnel requires a short-lived Gateway credential issuer and revoker");
    }

    const credentialTtlMs = validated.input.credentialTtlMs;
    const credential = await this.options.issueGatewayCredential(request, credentialTtlMs);
    if (!credential || typeof credential.id !== "string" || !credential.id || typeof credential.token !== "string" || credential.token.length < 16
      || /[\r\n\0]/u.test(credential.token) || !Number.isSafeInteger(credential.expiresAt) || credential.expiresAt <= this.now()) {
      if (credential?.id) await Promise.resolve(this.options.revokeGatewayCredential(credential.id)).catch(() => undefined);
      throw providerError("credentials_invalid", "OpenAI Tunnel Gateway credential issuer returned an invalid or expired credential");
    }
    let directory: string | undefined;
    let child: ChildProcess | undefined;
    try {
      const root = this.options.temporaryRoot ?? tmpdir();
      directory = await mkdtemp(join(root, "pi-maestro-openai-tunnel-"));
      await chmod(directory, 0o700);
      const configPath = join(directory, "tunnel-client.yaml");
      const authorizationPath = join(directory, "authorization");
      const healthUrlPath = join(directory, "health-url");
      const logPath = join(directory, "tunnel-client.ndjson");
      const mcpUrl = `http://127.0.0.1:${validated.input.localPort}${validated.input.mcpPath}`;
      const config = renderOpenAiTunnelClientConfig({ tunnelId, mcpUrl, authorizationFile: authorizationPath, healthUrlFile: healthUrlPath, logFile: logPath });
      await Promise.all([
        writePrivate(configPath, config),
        writePrivate(authorizationPath, `Bearer ${credential.token}\n`),
        writePrivate(healthUrlPath, ""),
        writePrivate(logPath, ""),
      ]);
      const environment = this.childEnvironment(validated.input, runtimeKey);
      const doctorResult = await runWithinTunnelDeadline(context, "client doctor", () => this.runCommandImpl(validated.executablePath, this.contract.doctorArgs(configPath), { env: environment, context }));
      if (doctorResult.code !== 0) {
        const detail = redactOpenAiTunnelText(`${doctorResult.stderr}\n${doctorResult.stdout}`, [runtimeKey, credential.token]);
        throw providerError("tunnel_doctor_failed", `tunnel-client doctor failed (exit=${doctorResult.code}): ${detail.trim()}`);
      }

      const args = this.contract.runArgs(configPath);
      child = this.spawnImpl(validated.executablePath, args, {
        detached: this.platform !== "win32",
        stdio: ["ignore", "ignore", "ignore"],
        shell: false,
        windowsHide: true,
        env: environment,
      });
      if (!child.pid) throw providerError("tunnel_spawn_failed", "tunnel-client did not publish a process id");
      child.unref();
      const key = runtimeKeyFor(request);
      let settle!: (exit: GatewayTunnelExit) => void;
      let settled = false;
      const exited = new Promise<GatewayTunnelExit>((resolve) => { settle = resolve; });
      const runtime: OpenAiRuntime = {
        key, pid: child.pid, child, executablePath: validated.executablePath, args, input: validated.input,
        tunnelId, gatewayCredential: credential, directory, configPath, authorizationPath,
        healthUrlPath, logPath, exited, cleaned: false,
      };
      const finish = (exit: GatewayTunnelExit): void => {
        if (settled) return;
        settled = true;
        runtime.exit = exit;
        settle(exit);
        void this.cleanup(runtime);
      };
      child.once("error", (error) => finish({ code: null, at: this.now(), detail: redactOpenAiTunnelText(`spawn error: ${error.message}`, [runtimeKey, credential.token]) }));
      child.once("exit", (code, signal) => finish({ code, signal, at: this.now() }));
      this.runtimes.set(key, runtime);
      this.scheduleCredentialRotation(runtime);
      return {
        pid: runtime.pid,
        executablePath: runtime.executablePath,
        args,
        ...(runtime.input.publicUrl ? { endpoint: runtime.input.publicUrl } : {}),
        opaqueId: runtime.tunnelId,
        exited,
        child,
      };
    } catch (error) {
      if (child?.pid) try { child.kill(); } catch { /* best effort before ownership is published */ }
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      await Promise.resolve(this.options.revokeGatewayCredential(credential.id)).catch(() => undefined);
      throw providerError((error as { code?: string }).code ?? "tunnel_start_failed", redactOpenAiTunnelText(error instanceof Error ? error.message : String(error), [runtimeKey, credential.token]));
    }
  }

  async probe(context: GatewayTunnelDeadlineContext, process: GatewayTunnelStartResult, request: GatewayTunnelProviderRequest): Promise<GatewayTunnelProbeResult> {
    context.throwIfExpired("probe");
    const runtime = this.runtimes.get(runtimeKeyFor(request));
    const endpoint = runtime?.input.publicUrl ?? process.endpoint;
    if (!runtime || runtime.pid !== process.pid) return { ready: false, terminal: true, ...(endpoint ? { endpoint } : {}), opaqueId: process.opaqueId, detail: "OpenAI tunnel runtime is not owned by this provider generation" };
    if (runtime.exit || !this.alive(runtime.pid)) return { ready: false, terminal: true, ...(endpoint ? { endpoint } : {}), opaqueId: runtime.tunnelId, detail: `tunnel-client exited before readiness (exit=${runtime.exit?.code ?? "unknown"})` };

    const local = await this.probeLocal(context, runtime);
    if (!local.ready) return { ...local, ...(endpoint ? { endpoint } : {}), opaqueId: runtime.tunnelId };
    let healthUrl: string | undefined;
    try { healthUrl = validateHealthUrl((await readFile(runtime.healthUrlPath, "utf8")).trim()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ready: false, terminal: true, ...(endpoint ? { endpoint } : {}), opaqueId: runtime.tunnelId, detail: redactOpenAiTunnelText(error instanceof Error ? error.message : String(error)), retryAfterMs: 100 };
    }
    if (!healthUrl) return { ready: false, ...(endpoint ? { endpoint } : {}), opaqueId: runtime.tunnelId, detail: "local: ready; control-plane: waiting for tunnel-client health URL", retryAfterMs: 100 };
    try {
      const response = await this.fetchImpl(`${healthUrl}/readyz`, { method: "GET", signal: context.signal, redirect: "manual" });
      if (response.status >= 200 && response.status < 300) return { ready: true, ...(endpoint ? { endpoint } : {}), opaqueId: runtime.tunnelId, detail: "local: ready; control-plane: tunnel-client /readyz ready" };
      return { ready: false, ...(endpoint ? { endpoint } : {}), opaqueId: runtime.tunnelId, detail: `local: ready; control-plane: /readyz HTTP ${response.status}`, retryAfterMs: 250 };
    } catch (error) {
      if (context.signal.aborted) context.throwIfExpired("probe");
      return { ready: false, ...(endpoint ? { endpoint } : {}), opaqueId: runtime.tunnelId, detail: `local: ready; control-plane: ${redactOpenAiTunnelText(error instanceof Error ? error.message : String(error))}`, retryAfterMs: 100 };
    }
  }

  /** OpenAI runtime credentials and private files are process-local, so restart instead of adopting. */
  async adopt(): Promise<undefined> { return undefined; }

  async stop(context: GatewayTunnelDeadlineContext, identity: GatewayTunnelProcessIdentity, request: GatewayTunnelStopRequest): Promise<void> {
    context.throwIfExpired("stop");
    const runtime = this.runtimes.get(runtimeKeyFor(request));
    if (runtime && runtime.pid !== identity.pid) throw providerError("tunnel_ownership_denied", "OpenAI tunnel runtime pid does not match the verified identity");
    await this.stopPid(context, identity.pid);
    if (runtime) await this.cleanup(runtime);
  }

  private input(request: GatewayTunnelProviderRequest): OpenAiInput {
    const raw = request.input ?? {};
    const forbidden = ["runtimeKey", "runtimeApiKey", "apiKey", "token", "authorization", "gatewayToken", "configFile"].find((key) => raw[key] !== undefined);
    if (forbidden) throw providerError("invalid_arguments", `OpenAI Tunnel rejects literal secret/config input: ${forbidden}`);
    const allowed = new Set(["mode", "enabled", "experimental", "autoInstall", "binaryPath", "localPort", "mcpPath", "publicUrl", "tunnelIdEnv", "runtimeKeyEnv", "credentialTtlMs"]);
    const unknown = Object.keys(raw).find((key) => !allowed.has(key));
    if (unknown) throw providerError("invalid_arguments", `Unknown OpenAI Tunnel input: ${unknown}`);
    if (raw.mode !== undefined && raw.mode !== "secure") throw providerError("tunnel_mode_unsupported", "Only OpenAI Secure Tunnel mode is supported");
    const enabled = raw.enabled === undefined && raw.experimental === undefined ? this.options.enabled === true : raw.enabled === true || raw.experimental === true;
    const autoInstall = raw.autoInstall === undefined ? this.options.autoInstall === true : raw.autoInstall === true;
    const binaryPath = raw.binaryPath === undefined ? undefined : String(raw.binaryPath);
    const localPort = raw.localPort === undefined ? this.options.defaultLocalPort ?? DEFAULT_LOCAL_PORT : Number(raw.localPort);
    if (!Number.isSafeInteger(localPort) || localPort < 1 || localPort > 65_535) throw providerError("invalid_arguments", "OpenAI Tunnel localPort must be in [1, 65535]");
    const mcpPath = normalizeMcpPath(raw.mcpPath === undefined ? this.options.mcpPath ?? DEFAULT_MCP_PATH : String(raw.mcpPath));
    const publicUrl = raw.publicUrl === undefined ? undefined : normalizePublicUrl(String(raw.publicUrl));
    const tunnelIdEnv = envName(raw.tunnelIdEnv === undefined ? this.options.tunnelIdEnv ?? "CONTROL_PLANE_TUNNEL_ID" : String(raw.tunnelIdEnv), "tunnelIdEnv");
    const runtimeKeyEnv = envName(raw.runtimeKeyEnv === undefined ? this.options.runtimeKeyEnv ?? "CONTROL_PLANE_API_KEY" : String(raw.runtimeKeyEnv), "runtimeKeyEnv");
    const credentialTtlMs = raw.credentialTtlMs === undefined ? this.options.credentialTtlMs ?? DEFAULT_CREDENTIAL_TTL_MS : Number(raw.credentialTtlMs);
    if (!Number.isSafeInteger(credentialTtlMs) || credentialTtlMs < 1_000 || credentialTtlMs > 60 * 60_000) throw providerError("invalid_arguments", "OpenAI Tunnel credential TTL must be in [1000, 3600000] ms");
    return { enabled, autoInstall, ...(binaryPath === undefined ? {} : { binaryPath }), localPort, mcpPath, ...(publicUrl ? { publicUrl } : {}), tunnelIdEnv, runtimeKeyEnv, credentialTtlMs };
  }

  private secretReference(name: string, label: string): string | undefined {
    const value = this.env[name]?.trim();
    if (!value) return undefined;
    if (Buffer.byteLength(value, "utf8") > 16 * 1024) throw providerError("invalid_arguments", `OpenAI Tunnel ${label} environment value is too large`);
    return value;
  }

  private childEnvironment(input: OpenAiInput, runtimeKey: string): NodeJS.ProcessEnv {
    const environment = { ...this.env };
    for (const name of ["OPENAI_ADMIN_KEY", "OPENAI_API_KEY", "CONTROL_PLANE_API_KEY", input.runtimeKeyEnv]) delete environment[name];
    environment[OPENAI_TUNNEL_RUNTIME_KEY_ENV] = runtimeKey;
    return environment;
  }

  /** Identity/version probes never receive the runtime key or broader OpenAI authority. */
  private versionCheckEnvironment(input: OpenAiInput): NodeJS.ProcessEnv {
    const environment = { ...this.env };
    for (const name of ["OPENAI_ADMIN_KEY", "OPENAI_API_KEY", "CONTROL_PLANE_API_KEY", input.runtimeKeyEnv]) delete environment[name];
    return environment;
  }

  /**
   * Discovery order: explicit binaryPath, then PATH, then the managed install,
   * then (only with autoInstall) a pinned verified download. PATH candidates
   * that fail version validation are skipped rather than fatal.
   */
  private async discoverClient(context: GatewayTunnelDeadlineContext, input: OpenAiInput): Promise<OpenAiClientDiscovery | undefined> {
    const explicit = resolveOpenAiTunnelClient(input.binaryPath ?? this.options.binaryPath);
    if (explicit) return { executablePath: explicit, source: "explicit" };

    const executableName = this.platform === "win32" ? `${OPENAI_TUNNEL_CLIENT_EXECUTABLE}.exe` : OPENAI_TUNNEL_CLIENT_EXECUTABLE;
    for (const directory of (this.env.PATH ?? "").split(delimiter)) {
      if (!directory) continue;
      const candidate = join(directory, executableName);
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
      const resolved = (() => { try { return realpathSync.native(candidate); } catch { return candidate; } })();
      const version = await this.clientVersion(context, resolved, input);
      if (version !== undefined) return { executablePath: resolved, source: "path", version };
    }

    const managedRoot = this.options.managedRoot ?? join(gatewayGlobalStateRoot(), "tools", "openai-tunnel-client");
    const install = this.options.installManagedClient ?? ensureManagedOpenAiTunnelClient;
    const asset = openAiTunnelClientAssetFor(this.platform);
    if (asset) {
      const managedPath = managedOpenAiTunnelClientPath(managedRoot, asset);
      // The managed install is trusted only while it still matches the pinned
      // binary hash; a tampered or foreign file falls through to reinstall.
      const verify = this.options.verifyManagedBinary ?? (async (path, candidate) => await sha256File(path).catch(() => undefined) === candidate.binarySha256);
      if (existsSync(managedPath) && await verify(managedPath, asset)) {
        const version = await this.clientVersion(context, managedPath, input);
        if (version !== undefined) return { executablePath: managedPath, source: "managed", version };
      }
    }
    if (!input.autoInstall) return undefined;
    const installed = await install({
      managedRoot,
      platform: this.platform,
      context,
      fetch: this.fetchImpl,
      verifyVersion: async (path) => (await this.clientVersion(context, path, input)) !== undefined,
    });
    const version = await this.clientVersion(context, installed, input);
    return version === undefined ? undefined : { executablePath: installed, source: "downloaded", version };
  }

  /** Run `--version` and return the version only when it satisfies the configured minimum. */
  private async clientVersion(context: GatewayTunnelDeadlineContext, executablePath: string, input: OpenAiInput): Promise<string | undefined> {
    try {
      const result = await runWithinTunnelDeadline(context, "client version", () => this.runCommandImpl(executablePath, this.contract.versionArgs, { env: this.versionCheckEnvironment(input), context }));
      if (result.code !== 0) return undefined;
      const version = parseOpenAiTunnelClientVersion(`${result.stdout}\n${result.stderr}`);
      if (!version) return undefined;
      const minimum = this.options.minimumVersion ?? OPENAI_TUNNEL_CLIENT_MINIMUM_VERSION;
      return isSupportedOpenAiTunnelClientVersion(version, minimum) ? version : undefined;
    } catch (error) {
      if (context.signal.aborted || context.remainingMs() <= 0) throw error;
      return undefined;
    }
  }

  private async probeLocal(context: GatewayTunnelDeadlineContext, runtime: OpenAiRuntime): Promise<GatewayTunnelProbeResult> {
    try {
      const response = await this.fetchImpl(`http://127.0.0.1:${runtime.input.localPort}${runtime.input.mcpPath}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runtime.gatewayCredential.token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pi-maestro-openai-tunnel", version: "1" } } }),
        signal: context.signal,
        redirect: "manual",
      });
      if (response.status >= 200 && response.status < 300) return { ready: true, detail: "local MCP ready" };
      if (response.status === 401 || response.status === 403) return { ready: false, terminal: true, detail: `local credential rejected (HTTP ${response.status})` };
      return { ready: false, detail: `local MCP HTTP ${response.status}`, retryAfterMs: 100 };
    } catch (error) {
      if (context.signal.aborted) context.throwIfExpired("probe");
      return { ready: false, detail: `local MCP: ${redactOpenAiTunnelText(error instanceof Error ? error.message : String(error), [runtime.gatewayCredential.token])}`, retryAfterMs: 100 };
    }
  }

  private async stopPid(context: GatewayTunnelDeadlineContext, pid: number): Promise<void> {
    if (!this.alive(pid)) return;
    if (this.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T"], { stdio: "ignore", timeout: Math.max(1, context.remainingMs()), windowsHide: true });
    else try { this.signal(-pid, "SIGTERM"); } catch { this.signal(pid, "SIGTERM"); }
    const graceAt = Math.min(context.deadlineAt, this.now() + STOP_GRACE_MS);
    while (this.alive(pid) && this.now() < graceAt) await waitWithinTunnelDeadline(context, Math.min(50, graceAt - this.now()));
    if (!this.alive(pid)) return;
    if (this.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", timeout: Math.max(1, context.remainingMs()), windowsHide: true });
    else try { this.signal(-pid, "SIGKILL"); } catch { this.signal(pid, "SIGKILL"); }
    if (this.alive(pid)) throw providerError("tunnel_stop_failed", `tunnel-client pid ${pid} survived stop escalation`);
  }

  private scheduleCredentialRotation(runtime: OpenAiRuntime): void {
    const now = this.now();
    const effectiveExpiry = Math.min(runtime.gatewayCredential.expiresAt, now + runtime.input.credentialTtlMs);
    const remainingMs = Math.max(1, effectiveExpiry - now);
    const leadMs = Math.min(30_000, Math.max(100, Math.floor(remainingMs / 5)));
    runtime.rotationTimer = setTimeout(() => {
      if (runtime.cleaned || this.runtimes.get(runtime.key) !== runtime) return;
      try { runtime.child.kill("SIGTERM"); } catch { /* supervisor recovery handles an eventual exit */ }
    }, Math.max(1, remainingMs - leadMs));
    runtime.rotationTimer.unref?.();
  }

  private async cleanup(runtime: OpenAiRuntime): Promise<void> {
    if (runtime.cleaned) return;
    runtime.cleaned = true;
    if (runtime.rotationTimer) clearTimeout(runtime.rotationTimer);
    if (this.runtimes.get(runtime.key) === runtime) this.runtimes.delete(runtime.key);
    await rm(runtime.directory, { recursive: true, force: true }).catch(() => undefined);
    await Promise.resolve(this.options.revokeGatewayCredential?.(runtime.gatewayCredential.id)).catch(() => undefined);
  }
}

export async function runOpenAiTunnelCommand(command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; context: GatewayTunnelDeadlineContext }): Promise<OpenAiTunnelCommandResult> {
  options.context.throwIfExpired("client command");
  return new Promise<OpenAiTunnelCommandResult>((resolve, reject) => {
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true, env: options.env });
    const append = (current: Buffer, chunk: Buffer | string): Buffer => {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      const next = Buffer.concat([current, incoming]);
      return next.byteLength <= MAX_CAPTURE_BYTES ? next : next.subarray(next.byteLength - MAX_CAPTURE_BYTES);
    };
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const finish = (error?: Error, code: number | null = null, signal: NodeJS.Signals | null = null): void => {
      if (settled) return;
      settled = true;
      options.context.signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve({ code, signal, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
    };
    const onAbort = (): void => {
      try { child.kill("SIGKILL"); } catch { /* process may already have exited */ }
      finish(options.context.signal.reason instanceof Error ? options.context.signal.reason : new Error("Tunnel client command aborted"));
    };
    options.context.signal.addEventListener("abort", onAbort, { once: true });
    if (options.context.signal.aborted) onAbort();
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => finish(undefined, code, signal));
  });
}

function validateHealthUrl(value: string): string | undefined {
  if (!value) return undefined;
  if (value.length > 2048) throw providerError("tunnel_health_invalid", "tunnel-client health URL is too long");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw providerError("tunnel_health_invalid", "tunnel-client health URL is invalid"); }
  if (parsed.protocol !== "http:" || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost" && parsed.hostname !== "[::1]" && parsed.hostname !== "::1") || !parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw providerError("tunnel_health_invalid", "tunnel-client health URL must be a credential-free loopback HTTP origin with an explicit port");
  }
  return parsed.href.replace(/\/$/u, "");
}

async function writePrivate(path: string, value: string): Promise<void> {
  await writeFile(path, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
}

function normalizeMcpPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.includes("?") || trimmed.includes("#") || trimmed.length > 256) throw providerError("invalid_arguments", "OpenAI Tunnel mcpPath must be an absolute URL path");
  return trimmed;
}

function normalizePublicUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw providerError("invalid_arguments", "OpenAI Tunnel publicUrl must be an HTTPS origin"); }
  if (parsed.protocol !== "https:" || parsed.origin !== value || parsed.pathname !== "/" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw providerError("invalid_arguments", "OpenAI Tunnel publicUrl must be an exact credential-free HTTPS origin");
  }
  return parsed.origin;
}

function envName(value: string, field: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value)) throw providerError("invalid_arguments", `OpenAI Tunnel ${field} must be an environment variable name`);
  return value;
}

function runtimeKeyFor(request: Pick<GatewayTunnelProviderRequest, "generation" | "ownerToken">): string {
  return `${request.generation}\0${request.ownerToken}`;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function providerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
