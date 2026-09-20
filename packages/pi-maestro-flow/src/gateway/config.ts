/** Native Pi agent Gateway configuration reader and writer. */
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute } from "node:path";
import { isMap, parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import {
  GATEWAY_CONFIG_VERSION,
  GATEWAY_DEFAULT_LIMITS,
  GATEWAY_HARD_LIMITS,
} from "./contracts.ts";
import {
  gatewayConfigPath,
  readGatewayFile,
  utf8Bytes,
  writeGatewayFileAtomic,
} from "./state-paths.ts";
import {
  normalizeGatewayTunnelMcpAccess,
  normalizeGatewayTunnelMcpPath,
  type GatewayTunnelMcpAccessConfig,
  GatewayTunnelMcpAccessValidationError,
} from "./tunnel/mcp-access.ts";

export type GatewayAuthMode = "open" | "bearer" | "oauth" | "dual";
export type GatewayCommandPolicy = "allow" | "confirm" | "deny";
export type GatewayLogLevel = "silent" | "error" | "warn" | "info" | "debug";

export interface GatewayServerConfig {
  host: string;
  port: number;
  disableLocalhostProtection: boolean;
  trustProxyHeaders: boolean;
  allowedOrigins: string[];
}
export interface GatewayOAuthConfig {
  password?: string;
  serverUrl?: string;
  tokenTtlMs: number;
}
export interface GatewayAuthConfig {
  mode: GatewayAuthMode;
  token?: string;
  oauth?: GatewayOAuthConfig;
  /** Legacy open-HTTP mutation bridge. Omitted preserves v1 behavior with a runtime warning. */
  allowOpenMutations?: boolean;
}
export interface GatewayCommandSecurityConfig {
  default: GatewayCommandPolicy;
  allow: string[];
  confirm: string[];
  deny: string[];
  autoAllowReadonly: boolean | null;
}
export interface GatewayFileSecurityConfig {
  maxReadBytes: number;
  maxPatchFiles: number;
  allow: string[];
  confirm: string[];
  deny: string[];
}
export interface GatewayTrustedFullAccessConfig {
  enabled: boolean;
  workspaceRoots: string[];
}
export interface GatewaySkillSecurityConfig {
  enabled: boolean;
  workspaceRoots: string[];
  externalSkillRoots: string[];
  externalReferenceRoots: string[];
}
export interface GatewayMaestroCliSecurityConfig {
  enabled: boolean;
  executable?: string;
  minimumVersion?: string;
  allowSearch: boolean;
  allowLoad: boolean;
  allowStage: boolean;
}
export type GatewayBrowserChannel = "managed" | "profile" | "cdp" | "extension";
export interface GatewayBrowserSecurityConfig {
  enabled: boolean;
  allowedChannels: GatewayBrowserChannel[];
  allowedOrigins: string[];
  maxTabsPerPrincipal: number;
}
export interface GatewaySecurityConfig {
  commands: GatewayCommandSecurityConfig;
  files: GatewayFileSecurityConfig;
  trustedFullAccess: GatewayTrustedFullAccessConfig;
  skills: GatewaySkillSecurityConfig;
  maestroCli: GatewayMaestroCliSecurityConfig;
  browser: GatewayBrowserSecurityConfig;
}
export interface GatewayWorkspaceConfig {
  path: string;
  id?: string;
  mode?: "lease" | "permanent";
  ttlMs?: number;
  generation?: number;
}
export interface GatewayTlsConfig {
  enabled: boolean;
  certFile?: string;
  keyFile?: string;
}
export interface GatewayTransportConfig {
  stdio: { enabled: boolean };
  http: { enabled: boolean; host: string; port: number; path: string; tls: GatewayTlsConfig };
  ssh: { enabled: boolean };
}
export interface GatewayLimitsConfig {
  maxRequestBytes: number;
  maxOutputBytes: number;
  maxConcurrentRequests: number;
  maxConcurrentJobs: number;
  maxConcurrentTasks: number;
  maxJobs: number;
  maxTasks: number;
  maxCommandBytes: number;
  maxFileReadBytes: number;
  maxFileWriteBytes: number;
  maxPatchFiles: number;
  maxExecTimeoutMs: number;
  maxLeaseTtlMs: number;
  maxWorkspaceCount: number;
  /** Board-only limits are optional in the structural type so legacy policy projections remain source-compatible. */
  maxBoardTasks?: number;
  maxBoardOperations?: number;
  maxBoardEvents?: number;
  maxHandoffRecords?: number;
  maxSkillFiles?: number;
  maxSkillFileBytes?: number;
  maxSkillResponseBytes?: number;
  maxMaestroOutputBytes?: number;
  maxMaestroTimeoutMs?: number;
}
export interface GatewayLoggingConfig {
  level: GatewayLogLevel;
  file?: string;
  auditFile?: string;
}
export interface GatewayStateConfig {
  rootDir?: string;
  ownerPath?: string;
  workspaceRegistryPath?: string;
  sessionsRoot?: string;
  boardRoot?: string;
  handoffRoot?: string;
  operationReceiptRoot?: string;
  maestroReceiptRoot?: string;
  pairingPath?: string;
  serviceManifestPath?: string;
}
export interface GatewayRetentionConfig {
  jobsMs: number;
  tasksMs: number;
  resultsMs: number;
  workspacesMs: number;
  boardTasksMs: number;
  boardOperationsMs: number;
  boardEventsMs: number;
}
export interface GatewayOpenAiTunnelConfig {
  /** Experimental provider opt-in; false by default. */
  enabled: boolean;
  /** Explicit opt-in for the pinned, verified managed tunnel-client download. */
  autoInstall: boolean;
  binaryPath?: string;
  tunnelIdEnv: string;
  runtimeKeyEnv: string;
  minimumVersion: string;
  credentialTtlMs: number;
}
interface GatewayTunnelProfileBase {
  id: string;
  enabled: boolean;
  binaryPath?: string;
  localPort?: number;
  publicUrl?: string;
  /** Optional, disabled-by-default MCP ingress contract. */
  mcpAccess?: GatewayTunnelMcpAccessConfig;
}
export interface GatewayCloudflareQuickTunnelProfileConfig extends GatewayTunnelProfileBase {
  provider: "cloudflare";
  mode: "quick";
  lifecycle: "ephemeral";
}
export interface GatewayCloudflareNamedTunnelProfileConfig extends GatewayTunnelProfileBase {
  provider: "cloudflare";
  mode: "named";
  lifecycle: "persistent";
  publicUrl: string;
  tunnelId: string;
  credentialsFile?: string;
  tokenFile?: string;
}
export interface GatewayOpenAiSecureTunnelProfileConfig extends GatewayTunnelProfileBase {
  provider: "openai";
  mode: "secure";
  lifecycle: "persistent";
  publicUrl: string;
  tunnelIdEnv: string;
  runtimeKeyEnv: string;
  credentialTtlMs: number;
  /** Profile-level override for the managed tunnel-client download opt-in. */
  autoInstall?: boolean;
}
export interface GatewaySshReverseTunnelProfileConfig extends GatewayTunnelProfileBase {
  provider: "ssh";
  mode: "reverse";
  lifecycle: "persistent";
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
export type GatewayTunnelProfileConfig =
  | GatewayCloudflareQuickTunnelProfileConfig
  | GatewayCloudflareNamedTunnelProfileConfig
  | GatewayOpenAiSecureTunnelProfileConfig
  | GatewaySshReverseTunnelProfileConfig;
export interface GatewayTunnelsConfig {
  /** Legacy OpenAI defaults retained for existing configuration and UI callers. */
  openai: GatewayOpenAiTunnelConfig;
  profiles: GatewayTunnelProfileConfig[];
}

export interface GatewayTunnelProfileInputOptions {
  /** Actual listener port, available only after Gateway binding. */
  boundPort?: number;
  /** Tunnel ingress profiles must always target their bound loopback listener. */
  forceBoundPort?: boolean;
}

export function gatewayTunnelProfileInput(
  profile: GatewayTunnelProfileConfig,
  http: Pick<GatewayTransportConfig["http"], "port" | "path">,
  options: GatewayTunnelProfileInputOptions = {},
): Readonly<Record<string, unknown>> {
  const localPort = options.forceBoundPort && options.boundPort !== undefined ? options.boundPort : undefined;
  const port = (configured: number | undefined): number => localPort ?? configured ?? http.port;
  if (profile.provider === "cloudflare" && profile.mode === "quick") {
    return {
      mode: "quick",
      localPort: port(profile.localPort),
      ...(profile.binaryPath ? { binaryPath: profile.binaryPath } : {}),
    };
  }
  if (profile.provider === "cloudflare") {
    return {
      mode: "named",
      localPort: port(profile.localPort),
      publicUrl: profile.publicUrl,
      tunnelId: profile.tunnelId,
      ...(profile.binaryPath ? { binaryPath: profile.binaryPath } : {}),
      ...(profile.credentialsFile ? { credentialsFile: profile.credentialsFile } : { tokenFile: profile.tokenFile }),
    };
  }
  if (profile.provider === "ssh") {
    return {
      mode: "reverse",
      localPort: port(profile.localPort),
      mcpPath: http.path,
      publicUrl: profile.publicUrl,
      host: profile.host,
      ...(profile.user ? { user: profile.user } : {}),
      port: profile.port,
      remoteBindHost: profile.remoteBindHost,
      remotePort: profile.remotePort,
      localHost: profile.localHost,
      ...(profile.binaryPath ? { binaryPath: profile.binaryPath } : {}),
      ...(profile.identityFile ? { identityFile: profile.identityFile } : {}),
      ...(profile.configFile ? { configFile: profile.configFile } : {}),
      ...(profile.knownHostsFile ? { knownHostsFile: profile.knownHostsFile } : {}),
      connectTimeoutSeconds: profile.connectTimeoutSeconds,
      serverAliveIntervalSeconds: profile.serverAliveIntervalSeconds,
      serverAliveCountMax: profile.serverAliveCountMax,
    };
  }
  return {
    mode: "secure",
    experimental: true,
    localPort: port(profile.localPort),
    mcpPath: http.path,
    publicUrl: profile.publicUrl,
    tunnelIdEnv: profile.tunnelIdEnv,
    runtimeKeyEnv: profile.runtimeKeyEnv,
    credentialTtlMs: profile.credentialTtlMs,
    ...(profile.autoInstall === undefined ? {} : { autoInstall: profile.autoInstall }),
    ...(profile.binaryPath ? { binaryPath: profile.binaryPath } : {}),
  };
}

export interface GatewayConfig {
  version: typeof GATEWAY_CONFIG_VERSION;  server: GatewayServerConfig;
  auth: GatewayAuthConfig;
  security: GatewaySecurityConfig;
  workspaces: GatewayWorkspaceConfig[];
  transport: GatewayTransportConfig;
  limits: GatewayLimitsConfig;
  logging: GatewayLoggingConfig;
  state: GatewayStateConfig;
  retention: GatewayRetentionConfig;
  tunnels: GatewayTunnelsConfig;
  fabric: GatewayFabricConfig;
}

export interface GatewayFabricConfig {
  enabled: boolean;
  /**
   * Audience every Fabric Connector pairing and proof must carry.
   *
   * Optional so that a document which does not mention Fabric stays exactly as
   * it was: a default written back into the canonical form would read as an
   * operator setting on the next load.
   */
  audience?: string;
  /** Complete five-store Gateway Fabric authority document override. */
  enrollmentPath?: string;
  limits?: {
    maxFrameBytes: number;
    heartbeatIntervalMs: number;
    heartbeatTimeoutMs: number;
  };
}

export type GatewayConfigPatchValue<T> =
  T extends readonly unknown[]
    ? T
    : T extends object
      ? { [K in keyof T]?: GatewayConfigPatchValue<T[K]> | null }
      : T;

export type GatewayConfigPatch = {
  [K in keyof GatewayConfig]?: GatewayConfigPatchValue<GatewayConfig[K]> | null;
} & Record<string, unknown>;

export interface GatewayConfigDocument {
  config: GatewayConfig;
  /** Top-level sections not owned by the Gateway (discovery, terminal, etc.). */
  unknownSections: Record<string, unknown>;
  /** Original text, retained so unknown sections/comments survive a write. */
  raw: string;
  path?: string;
}

export class GatewayConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayConfigValidationError";
  }
}

const KNOWN_SECTIONS = new Set(["version", "server", "auth", "security", "workspaces", "transport", "limits", "logging", "state", "retention", "tunnels", "fabric"]);
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const properLockfile = createRequire(import.meta.url)("proper-lockfile") as {
  lock(filePath: string, options: { realpath: boolean; stale: number; update: number; retries: { retries: number; factor: number; minTimeout: number; maxTimeout: number; randomize: boolean } }): Promise<() => Promise<void>>;
};

export class GatewayConfigConflictError extends Error {
  constructor(message = "Gateway config changed concurrently") {
    super(message);
    this.name = "GatewayConfigConflictError";
  }
}

const DEFAULT_SERVER: GatewayServerConfig = {
  host: "127.0.0.1",
  port: 9090,
  disableLocalhostProtection: false,
  trustProxyHeaders: false,
  allowedOrigins: [],
};
const DEFAULT_AUTH: GatewayAuthConfig = { mode: "open" };
const DEFAULT_SECURITY: GatewaySecurityConfig = {
  commands: { default: "allow", allow: [], confirm: [], deny: [], autoAllowReadonly: null },
  files: { maxReadBytes: GATEWAY_DEFAULT_LIMITS.maxFileReadBytes, maxPatchFiles: GATEWAY_DEFAULT_LIMITS.maxPatchFiles, allow: [], confirm: [], deny: [] },
  trustedFullAccess: { enabled: false, workspaceRoots: [] },
  skills: { enabled: false, workspaceRoots: [], externalSkillRoots: [], externalReferenceRoots: [] },
  maestroCli: { enabled: false, allowSearch: false, allowLoad: false, allowStage: false },
  browser: { enabled: true, allowedChannels: ["managed", "profile", "cdp", "extension"], allowedOrigins: [], maxTabsPerPrincipal: 8 },
};
const DEFAULT_TRANSPORT: GatewayTransportConfig = {
  stdio: { enabled: true },
  http: { enabled: true, host: "127.0.0.1", port: 9090, path: "/mcp", tls: { enabled: false } },
  ssh: { enabled: true },
};
const DEFAULT_TUNNELS: GatewayTunnelsConfig = {
  openai: {
    enabled: false,
    autoInstall: false,
    tunnelIdEnv: "CONTROL_PLANE_TUNNEL_ID",
    runtimeKeyEnv: "CONTROL_PLANE_API_KEY",
    minimumVersion: "0.0.14",
    credentialTtlMs: 5 * 60_000,
  },
  profiles: [],
};
const DEFAULT_FABRIC: GatewayFabricConfig = {
  enabled: false,
};
/** Audience used when the document does not name one. */
export const FABRIC_DEFAULT_AUDIENCE = "fabric";
const DEFAULT_FABRIC_LIMITS = { maxFrameBytes: 256 * 1024, heartbeatIntervalMs: 10_000, heartbeatTimeoutMs: 30_000 } as const;
const DEFAULT_RETENTION: GatewayRetentionConfig = {
  jobsMs: 7 * 24 * 60 * 60 * 1000,
  tasksMs: 30 * 24 * 60 * 60 * 1000,
  resultsMs: 30 * 24 * 60 * 60 * 1000,
  workspacesMs: 24 * 60 * 60 * 1000,
  boardTasksMs: 90 * 24 * 60 * 60 * 1000,
  boardOperationsMs: 30 * 24 * 60 * 60 * 1000,
  boardEventsMs: 30 * 24 * 60 * 60 * 1000,
};

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new GatewayConfigValidationError(`${path} must be a mapping`);
  return value as Record<string, unknown>;
}
function optionalObject(value: unknown, path: string): Record<string, unknown> {
  return value === undefined || value === null ? {} : object(value, path);
}
function knownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) throw new GatewayConfigValidationError(`${path}.${key} is not a recognized field`);
}
function stringValue(value: unknown, path: string, max = 4096): string {
  if (typeof value !== "string" || value.trim() === "") throw new GatewayConfigValidationError(`${path} must be a non-empty string`);
  if (utf8Bytes(value) > max) throw new GatewayConfigValidationError(`${path} exceeds ${max} UTF-8 bytes`);
  return value;
}
function optionalString(value: unknown, path: string, max = 4096): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return stringValue(value, path, max);
}
function bool(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new GatewayConfigValidationError(`${path} must be a boolean`);
  return value;
}
function integer(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER, fallback?: number): number {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new GatewayConfigValidationError(`${path} is required`);
  }
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new GatewayConfigValidationError(`${path} must be an integer in [${min}, ${max}]`);
  return value as number;
}
function stringList(value: unknown, path: string, maxItems = 256): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new GatewayConfigValidationError(`${path} must be a list of at most ${maxItems} strings`);
  return value.map((item, index) => stringValue(item, `${path}[${index}]`, 4096));
}
function pick<T>(record: Record<string, unknown>, camel: string, snake: string): unknown {
  return record[camel] ?? record[snake];
}
function boundedLimit(value: unknown, path: string, fallback: number, hard: number): number {
  const result = integer(value, path, 1, hard, fallback);
  return result;
}

export function defaultGatewayConfig(): GatewayConfig {
  return structuredClone({
    version: GATEWAY_CONFIG_VERSION,
    server: DEFAULT_SERVER,
    auth: DEFAULT_AUTH,
    security: DEFAULT_SECURITY,
    workspaces: [],
    transport: DEFAULT_TRANSPORT,
    limits: GATEWAY_DEFAULT_LIMITS,
    logging: { level: "info" as const },
    state: {},
    retention: DEFAULT_RETENTION,
    tunnels: DEFAULT_TUNNELS,
    fabric: DEFAULT_FABRIC,
  });
}

export function normalizeGatewayConfig(value: unknown): GatewayConfig {
  const root = object(value ?? {}, "config");
  if (root.version !== undefined && root.version !== GATEWAY_CONFIG_VERSION) throw new GatewayConfigValidationError(`config.version must be ${GATEWAY_CONFIG_VERSION}`);

  const serverRaw = optionalObject(root.server, "server");
  knownKeys(serverRaw, ["host", "port", "disable_localhost_protection", "trust_proxy_headers", "allowed_origins", "disableLocalhostProtection", "trustProxyHeaders", "allowedOrigins"], "server");
  const server: GatewayServerConfig = {
    host: serverRaw.host === undefined ? DEFAULT_SERVER.host : stringValue(serverRaw.host, "server.host", 255),
    port: integer(serverRaw.port, "server.port", 1, 65535, DEFAULT_SERVER.port),
    disableLocalhostProtection: bool(pick(serverRaw, "disableLocalhostProtection", "disable_localhost_protection"), "server.disableLocalhostProtection", DEFAULT_SERVER.disableLocalhostProtection),
    trustProxyHeaders: bool(pick(serverRaw, "trustProxyHeaders", "trust_proxy_headers"), "server.trustProxyHeaders", DEFAULT_SERVER.trustProxyHeaders),
    allowedOrigins: stringList(pick(serverRaw, "allowedOrigins", "allowed_origins"), "server.allowedOrigins", 64),
  };

  const authRaw = optionalObject(root.auth, "auth");
  knownKeys(authRaw, [
    "mode", "token", "oauth", "allowOpenMutations", "allow_open_mutations",
    "oauth_password", "oauth_server_url", "oauth_token_ttl", "oauth_token_ttl_ms",
    "oauth_token_secret", "oauth_client_id", "oauth_client_secret", "oauth_redirect_uris",
  ], "auth");
  const authMode = authRaw.mode === undefined ? DEFAULT_AUTH.mode : authRaw.mode;
  if (authMode !== "open" && authMode !== "bearer" && authMode !== "oauth" && authMode !== "dual") throw new GatewayConfigValidationError("auth.mode must be open, bearer, oauth, or dual");
  const token = optionalString(authRaw.token, "auth.token", 4096);
  const hasFlatOauth = Object.keys(authRaw).some((key) => key.startsWith("oauth_"));
  const oauthRaw = authRaw.oauth === undefined
    ? (hasFlatOauth ? {
      password: authRaw.oauth_password,
      server_url: authRaw.oauth_server_url,
      token_ttl: authRaw.oauth_token_ttl,
      token_ttl_ms: authRaw.oauth_token_ttl_ms,
      token_secret: authRaw.oauth_token_secret,
      client_id: authRaw.oauth_client_id,
      client_secret: authRaw.oauth_client_secret,
      redirect_uris: authRaw.oauth_redirect_uris,
    } : undefined)
    : optionalObject(authRaw.oauth, "auth.oauth");
  let oauth: GatewayOAuthConfig | undefined;
  if (oauthRaw) {
    knownKeys(oauthRaw, [
      "password", "server_url", "serverUrl", "token_ttl", "tokenTtlMs", "token_ttl_ms",
      "token_secret", "client_id", "client_secret", "redirect_uris",
    ], "auth.oauth");
    const ttlSeconds = oauthRaw.token_ttl;
    const tokenTtlMs = oauthRaw.tokenTtlMs ?? oauthRaw.token_ttl_ms ?? (ttlSeconds === undefined ? 24 * 60 * 60 * 1000 : integer(ttlSeconds, "auth.oauth.token_ttl", 1, 30 * 24 * 60 * 60) * 1000);
    oauth = {
      password: optionalString(oauthRaw.password, "auth.oauth.password", 4096),
      serverUrl: optionalString(oauthRaw.serverUrl ?? oauthRaw.server_url, "auth.oauth.serverUrl", 4096),
      tokenTtlMs: integer(tokenTtlMs, "auth.oauth.tokenTtlMs", 1, 30 * 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000),
    };
  }
  if ((authMode === "bearer" || authMode === "dual") && !token) throw new GatewayConfigValidationError(`auth.token is required when auth.mode=${authMode}`);
  if ((authMode === "oauth" || authMode === "dual") && !oauth) throw new GatewayConfigValidationError(`auth.oauth is required when auth.mode=${authMode}`);
  const allowOpenMutationsRaw = authRaw.allowOpenMutations ?? authRaw.allow_open_mutations;
  if (allowOpenMutationsRaw !== undefined && typeof allowOpenMutationsRaw !== "boolean") throw new GatewayConfigValidationError("auth.allowOpenMutations must be boolean");
  const auth: GatewayAuthConfig = {
    mode: authMode,
    ...(token === undefined ? {} : { token }),
    ...(oauth === undefined ? {} : { oauth }),
    ...(allowOpenMutationsRaw === undefined ? {} : { allowOpenMutations: allowOpenMutationsRaw }),
  };

  const securityRaw = optionalObject(root.security, "security");
  knownKeys(securityRaw, ["commands", "files", "trustedFullAccess", "trusted_full_access", "skills", "maestroCli", "maestro_cli", "browser"], "security");
  const commandsRaw = optionalObject(securityRaw.commands, "security.commands");
  knownKeys(commandsRaw, ["default", "allow", "confirm", "deny", "auto_allow_readonly", "autoAllowReadonly"], "security.commands");
  const commandDefault = commandsRaw.default === undefined ? DEFAULT_SECURITY.commands.default : commandsRaw.default;
  if (commandDefault !== "allow" && commandDefault !== "confirm" && commandDefault !== "deny") throw new GatewayConfigValidationError("security.commands.default must be allow, confirm, or deny");
  const autoReadonlyRaw = pick(commandsRaw, "autoAllowReadonly", "auto_allow_readonly");
  if (autoReadonlyRaw !== undefined && autoReadonlyRaw !== null && typeof autoReadonlyRaw !== "boolean") throw new GatewayConfigValidationError("security.commands.autoAllowReadonly must be boolean or null");
  const commands: GatewayCommandSecurityConfig = {
    default: commandDefault,
    allow: stringList(commandsRaw.allow, "security.commands.allow"),
    confirm: stringList(commandsRaw.confirm, "security.commands.confirm"),
    deny: stringList(commandsRaw.deny, "security.commands.deny"),
    autoAllowReadonly: autoReadonlyRaw === undefined ? DEFAULT_SECURITY.commands.autoAllowReadonly : autoReadonlyRaw as boolean | null,
  };
  const filesRaw = optionalObject(securityRaw.files, "security.files");
  knownKeys(filesRaw, ["max_read_bytes", "maxReadBytes", "max_patch_files", "maxPatchFiles", "max_patch_lines", "allow", "confirm", "deny"], "security.files");
  const files: GatewayFileSecurityConfig = {
    maxReadBytes: boundedLimit(pick(filesRaw, "maxReadBytes", "max_read_bytes"), "security.files.maxReadBytes", DEFAULT_SECURITY.files.maxReadBytes, GATEWAY_HARD_LIMITS.maxFileReadBytes),
    maxPatchFiles: boundedLimit(pick(filesRaw, "maxPatchFiles", "max_patch_files"), "security.files.maxPatchFiles", DEFAULT_SECURITY.files.maxPatchFiles, GATEWAY_HARD_LIMITS.maxPatchFiles),
    allow: stringList(filesRaw.allow, "security.files.allow"),
    confirm: stringList(filesRaw.confirm, "security.files.confirm"),
    deny: stringList(filesRaw.deny, "security.files.deny"),
  };
  const trustedRaw = optionalObject(securityRaw.trustedFullAccess ?? securityRaw.trusted_full_access, "security.trustedFullAccess");
  knownKeys(trustedRaw, ["enabled", "workspaceRoots", "workspace_roots"], "security.trustedFullAccess");
  const trustedFullAccess: GatewayTrustedFullAccessConfig = {
    enabled: bool(trustedRaw.enabled, "security.trustedFullAccess.enabled", false),
    workspaceRoots: stringList(trustedRaw.workspaceRoots ?? trustedRaw.workspace_roots, "security.trustedFullAccess.workspaceRoots", 64),
  };
  if (trustedFullAccess.enabled && authMode === "open") throw new GatewayConfigValidationError("security.trustedFullAccess requires authenticated HTTP (auth.mode cannot be open)");
  const skillsRaw = optionalObject(securityRaw.skills, "security.skills");
  knownKeys(skillsRaw, ["enabled", "workspaceRoots", "workspace_roots", "externalSkillRoots", "external_skill_roots", "externalReferenceRoots", "external_reference_roots"], "security.skills");
  const skills: GatewaySkillSecurityConfig = {
    enabled: bool(skillsRaw.enabled, "security.skills.enabled", DEFAULT_SECURITY.skills.enabled),
    workspaceRoots: stringList(skillsRaw.workspaceRoots ?? skillsRaw.workspace_roots, "security.skills.workspaceRoots", 64),
    externalSkillRoots: stringList(skillsRaw.externalSkillRoots ?? skillsRaw.external_skill_roots, "security.skills.externalSkillRoots", 64),
    externalReferenceRoots: stringList(skillsRaw.externalReferenceRoots ?? skillsRaw.external_reference_roots, "security.skills.externalReferenceRoots", 64),
  };
  const maestroRaw = optionalObject(securityRaw.maestroCli ?? securityRaw.maestro_cli, "security.maestroCli");
  knownKeys(maestroRaw, ["enabled", "executable", "minimumVersion", "minimum_version", "allowSearch", "allow_search", "allowLoad", "allow_load", "allowStage", "allow_stage"], "security.maestroCli");
  const maestroCli: GatewayMaestroCliSecurityConfig = {
    enabled: bool(maestroRaw.enabled, "security.maestroCli.enabled", DEFAULT_SECURITY.maestroCli.enabled),
    ...(optionalString(maestroRaw.executable, "security.maestroCli.executable", 4096) === undefined ? {} : { executable: optionalString(maestroRaw.executable, "security.maestroCli.executable", 4096) }),
    ...(optionalString(maestroRaw.minimumVersion ?? maestroRaw.minimum_version, "security.maestroCli.minimumVersion", 128) === undefined ? {} : { minimumVersion: optionalString(maestroRaw.minimumVersion ?? maestroRaw.minimum_version, "security.maestroCli.minimumVersion", 128) }),
    allowSearch: bool(maestroRaw.allowSearch ?? maestroRaw.allow_search, "security.maestroCli.allowSearch", DEFAULT_SECURITY.maestroCli.allowSearch),
    allowLoad: bool(maestroRaw.allowLoad ?? maestroRaw.allow_load, "security.maestroCli.allowLoad", DEFAULT_SECURITY.maestroCli.allowLoad),
    allowStage: bool(maestroRaw.allowStage ?? maestroRaw.allow_stage, "security.maestroCli.allowStage", DEFAULT_SECURITY.maestroCli.allowStage),
  };
  const browserRaw = optionalObject(securityRaw.browser, "security.browser");
  knownKeys(browserRaw, ["enabled", "allowedChannels", "allowed_channels", "allowedOrigins", "allowed_origins", "maxTabsPerPrincipal", "max_tabs_per_principal"], "security.browser");
  const allowedChannels = stringList(browserRaw.allowedChannels ?? browserRaw.allowed_channels, "security.browser.allowedChannels", 4);
  const normalizedChannels = allowedChannels.length === 0 ? [...DEFAULT_SECURITY.browser.allowedChannels] : allowedChannels;
  for (const channel of normalizedChannels) {
    if (channel !== "managed" && channel !== "profile" && channel !== "cdp" && channel !== "extension") throw new GatewayConfigValidationError("security.browser.allowedChannels contains an unsupported channel");
  }
  if (new Set(normalizedChannels).size !== normalizedChannels.length) throw new GatewayConfigValidationError("security.browser.allowedChannels must not contain duplicates");
  const allowedOrigins = stringList(browserRaw.allowedOrigins ?? browserRaw.allowed_origins, "security.browser.allowedOrigins", 128).map((origin, index) => {
    let parsed: URL;
    try { parsed = new URL(origin); }
    catch { throw new GatewayConfigValidationError(`security.browser.allowedOrigins[${index}] must be an absolute HTTP(S) origin`); }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== origin || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new GatewayConfigValidationError(`security.browser.allowedOrigins[${index}] must be an exact HTTP(S) origin`);
    }
    return parsed.origin;
  });
  if (new Set(allowedOrigins).size !== allowedOrigins.length) throw new GatewayConfigValidationError("security.browser.allowedOrigins must not contain duplicates");
  const browser: GatewayBrowserSecurityConfig = {
    enabled: bool(browserRaw.enabled, "security.browser.enabled", DEFAULT_SECURITY.browser.enabled),
    allowedChannels: normalizedChannels as GatewayBrowserChannel[],
    allowedOrigins,
    maxTabsPerPrincipal: integer(browserRaw.maxTabsPerPrincipal ?? browserRaw.max_tabs_per_principal, "security.browser.maxTabsPerPrincipal", 1, 32, DEFAULT_SECURITY.browser.maxTabsPerPrincipal),
  };
  if ((skills.enabled || maestroCli.enabled) && authMode === "open") throw new GatewayConfigValidationError("Gateway skill and Maestro CLI surfaces require authenticated HTTP (auth.mode cannot be open)");

  const workspacesRaw = root.workspaces;
  if (workspacesRaw !== undefined && !Array.isArray(workspacesRaw) && (typeof workspacesRaw !== "object" || workspacesRaw === null)) throw new GatewayConfigValidationError("workspaces must be a list or mapping");
  const workspaceEntries: unknown[] = Array.isArray(workspacesRaw)
    ? workspacesRaw
    : workspacesRaw && typeof workspacesRaw === "object"
      ? Object.entries(workspacesRaw as Record<string, unknown>).map(([path, entry]) => entry && typeof entry === "object" && !Array.isArray(entry) ? { ...(entry as Record<string, unknown>), path: (entry as Record<string, unknown>).path ?? path } : { path, ttl: entry })
      : [];
  const workspaces: GatewayWorkspaceConfig[] = workspaceEntries.map((entry, index) => {
    const item = object(entry, `workspaces[${index}]`);
    knownKeys(item, ["path", "workspacePath", "canonicalPath", "name", "id", "workspaceId", "mode", "permanent", "ttl", "ttl_ms", "ttlMs", "ttl_seconds", "ttlSeconds", "expires_at", "expiresAt", "owner_token", "ownerToken", "generation"], `workspaces[${index}]`);
    const path = stringValue(item.path ?? item.workspacePath ?? item.canonicalPath, `workspaces[${index}].path`, 4096);
    const directTtl = item.ttlMs ?? item.ttl_ms;
    const secondsTtl = item.ttlSeconds ?? item.ttl_seconds ?? item.ttl;
    const legacyExpiry = item.expiresAt ?? item.expires_at;
    const modeRaw = item.mode ?? (item.permanent === true || item.ttl === null || (directTtl === undefined && secondsTtl === undefined && legacyExpiry === undefined) ? "permanent" : "lease");
    if (modeRaw !== "lease" && modeRaw !== "permanent") throw new GatewayConfigValidationError(`workspaces[${index}].mode must be lease or permanent`);
    const mode = modeRaw as "lease" | "permanent";
    let ttlMs = directTtl !== undefined && directTtl !== null
      ? integer(directTtl, `workspaces[${index}].ttlMs`, 1, GATEWAY_HARD_LIMITS.maxLeaseTtlMs)
      : secondsTtl === undefined || secondsTtl === null
        ? undefined
        : integer(secondsTtl, `workspaces[${index}].ttl`, 1, GATEWAY_HARD_LIMITS.maxLeaseTtlMs / 1000) * 1000;
    if (ttlMs === undefined && legacyExpiry !== undefined && legacyExpiry !== null) {
      const expiresAt = typeof legacyExpiry === "number" ? legacyExpiry : Date.parse(String(legacyExpiry));
      if (!Number.isFinite(expiresAt)) throw new GatewayConfigValidationError(`workspaces[${index}].expiresAt must be an ISO timestamp or epoch milliseconds`);
      ttlMs = Math.min(GATEWAY_HARD_LIMITS.maxLeaseTtlMs, Math.max(1, Math.floor(expiresAt - Date.now())));
    }
    return {
      path,
      ...(item.id === undefined && item.workspaceId === undefined ? {} : { id: stringValue(item.id ?? item.workspaceId, `workspaces[${index}].id`, 256) }),
      mode,
      ...(ttlMs === undefined || mode === "permanent" ? {} : { ttlMs: Math.min(ttlMs, GATEWAY_HARD_LIMITS.maxLeaseTtlMs) }),
      ...(item.generation === undefined ? {} : { generation: integer(item.generation, `workspaces[${index}].generation`, 1) }),
    };
  });

  const transportRaw = optionalObject(root.transport, "transport");
  knownKeys(transportRaw, ["stdio", "http", "ssh", "session_idle_ttl"], "transport");
  const stdioRaw = optionalObject(transportRaw.stdio, "transport.stdio");
  knownKeys(stdioRaw, ["enabled"], "transport.stdio");
  const httpRaw = optionalObject(transportRaw.http, "transport.http");
  knownKeys(httpRaw, ["enabled", "host", "port", "path", "tls"], "transport.http");
  const tlsRaw = optionalObject(httpRaw.tls, "transport.http.tls");
  knownKeys(tlsRaw, ["enabled", "certFile", "cert_file", "keyFile", "key_file"], "transport.http.tls");
  const tlsEnabled = bool(tlsRaw.enabled, "transport.http.tls.enabled", false);
  const tls = {
    enabled: tlsEnabled,
    ...(optionalString(tlsRaw.certFile ?? tlsRaw.cert_file, "transport.http.tls.certFile", 4096) ? { certFile: optionalString(tlsRaw.certFile ?? tlsRaw.cert_file, "transport.http.tls.certFile", 4096) } : {}),
    ...(optionalString(tlsRaw.keyFile ?? tlsRaw.key_file, "transport.http.tls.keyFile", 4096) ? { keyFile: optionalString(tlsRaw.keyFile ?? tlsRaw.key_file, "transport.http.tls.keyFile", 4096) } : {}),
  };
  if (tlsEnabled && (!tls.certFile || !tls.keyFile)) throw new GatewayConfigValidationError("transport.http.tls requires certFile and keyFile when enabled");
  const sshRaw = optionalObject(transportRaw.ssh, "transport.ssh");
  knownKeys(sshRaw, ["enabled"], "transport.ssh");
  const transport: GatewayTransportConfig = {
    stdio: { enabled: bool(stdioRaw.enabled, "transport.stdio.enabled", DEFAULT_TRANSPORT.stdio.enabled) },
    http: {
      enabled: bool(httpRaw.enabled, "transport.http.enabled", DEFAULT_TRANSPORT.http.enabled),
      host: httpRaw.host === undefined ? server.host : stringValue(httpRaw.host, "transport.http.host", 255),
      port: integer(httpRaw.port, "transport.http.port", 1, 65535, server.port),
      path: httpRaw.path === undefined ? DEFAULT_TRANSPORT.http.path : normalizeGatewayTunnelMcpPath(httpRaw.path, "transport.http.path"),
      tls,
    },
    ssh: { enabled: bool(sshRaw.enabled, "transport.ssh.enabled", DEFAULT_TRANSPORT.ssh.enabled) },
  };

  const limitsRaw = optionalObject(root.limits, "limits");
  knownKeys(limitsRaw, [
    ...Object.keys(GATEWAY_DEFAULT_LIMITS).flatMap((key) => [key, key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)]),
    "max_result_bytes",
  ], "limits");
  const limits: GatewayLimitsConfig = {
    maxRequestBytes: boundedLimit(pick(limitsRaw, "maxRequestBytes", "max_request_bytes"), "limits.maxRequestBytes", GATEWAY_DEFAULT_LIMITS.maxRequestBytes, GATEWAY_HARD_LIMITS.maxRequestBytes),
    maxOutputBytes: boundedLimit(limitsRaw.maxOutputBytes ?? limitsRaw.max_output_bytes ?? limitsRaw.max_result_bytes, "limits.maxOutputBytes", GATEWAY_DEFAULT_LIMITS.maxOutputBytes, GATEWAY_HARD_LIMITS.maxOutputBytes),
    maxConcurrentRequests: boundedLimit(pick(limitsRaw, "maxConcurrentRequests", "max_concurrent_requests"), "limits.maxConcurrentRequests", GATEWAY_DEFAULT_LIMITS.maxConcurrentRequests, GATEWAY_HARD_LIMITS.maxConcurrentRequests),
    maxConcurrentJobs: boundedLimit(pick(limitsRaw, "maxConcurrentJobs", "max_concurrent_jobs"), "limits.maxConcurrentJobs", GATEWAY_DEFAULT_LIMITS.maxConcurrentJobs, GATEWAY_HARD_LIMITS.maxConcurrentJobs),
    maxConcurrentTasks: boundedLimit(pick(limitsRaw, "maxConcurrentTasks", "max_concurrent_tasks"), "limits.maxConcurrentTasks", GATEWAY_DEFAULT_LIMITS.maxConcurrentTasks, GATEWAY_HARD_LIMITS.maxConcurrentTasks),
    maxJobs: boundedLimit(pick(limitsRaw, "maxJobs", "max_jobs"), "limits.maxJobs", GATEWAY_DEFAULT_LIMITS.maxJobs, GATEWAY_HARD_LIMITS.maxJobs),
    maxTasks: boundedLimit(pick(limitsRaw, "maxTasks", "max_tasks"), "limits.maxTasks", GATEWAY_DEFAULT_LIMITS.maxTasks, GATEWAY_HARD_LIMITS.maxTasks),
    maxCommandBytes: boundedLimit(pick(limitsRaw, "maxCommandBytes", "max_command_bytes"), "limits.maxCommandBytes", GATEWAY_DEFAULT_LIMITS.maxCommandBytes, GATEWAY_HARD_LIMITS.maxCommandBytes),
    maxFileReadBytes: boundedLimit(pick(limitsRaw, "maxFileReadBytes", "max_file_read_bytes"), "limits.maxFileReadBytes", GATEWAY_DEFAULT_LIMITS.maxFileReadBytes, GATEWAY_HARD_LIMITS.maxFileReadBytes),
    maxFileWriteBytes: boundedLimit(pick(limitsRaw, "maxFileWriteBytes", "max_file_write_bytes"), "limits.maxFileWriteBytes", GATEWAY_DEFAULT_LIMITS.maxFileWriteBytes, GATEWAY_HARD_LIMITS.maxFileWriteBytes),
    maxPatchFiles: boundedLimit(pick(limitsRaw, "maxPatchFiles", "max_patch_files"), "limits.maxPatchFiles", GATEWAY_DEFAULT_LIMITS.maxPatchFiles, GATEWAY_HARD_LIMITS.maxPatchFiles),
    maxExecTimeoutMs: boundedLimit(pick(limitsRaw, "maxExecTimeoutMs", "max_exec_timeout_ms"), "limits.maxExecTimeoutMs", GATEWAY_DEFAULT_LIMITS.maxExecTimeoutMs, GATEWAY_HARD_LIMITS.maxExecTimeoutMs),
    maxLeaseTtlMs: boundedLimit(pick(limitsRaw, "maxLeaseTtlMs", "max_lease_ttl_ms"), "limits.maxLeaseTtlMs", GATEWAY_DEFAULT_LIMITS.maxLeaseTtlMs, GATEWAY_HARD_LIMITS.maxLeaseTtlMs),
    maxWorkspaceCount: boundedLimit(pick(limitsRaw, "maxWorkspaceCount", "max_workspace_count"), "limits.maxWorkspaceCount", GATEWAY_DEFAULT_LIMITS.maxWorkspaceCount, GATEWAY_HARD_LIMITS.maxWorkspaceCount),
    maxBoardTasks: boundedLimit(pick(limitsRaw, "maxBoardTasks", "max_board_tasks"), "limits.maxBoardTasks", GATEWAY_DEFAULT_LIMITS.maxBoardTasks, GATEWAY_HARD_LIMITS.maxBoardTasks),
    maxBoardOperations: boundedLimit(pick(limitsRaw, "maxBoardOperations", "max_board_operations"), "limits.maxBoardOperations", GATEWAY_DEFAULT_LIMITS.maxBoardOperations, GATEWAY_HARD_LIMITS.maxBoardOperations),
    maxBoardEvents: boundedLimit(pick(limitsRaw, "maxBoardEvents", "max_board_events"), "limits.maxBoardEvents", GATEWAY_DEFAULT_LIMITS.maxBoardEvents, GATEWAY_HARD_LIMITS.maxBoardEvents),
    maxHandoffRecords: boundedLimit(pick(limitsRaw, "maxHandoffRecords", "max_handoff_records"), "limits.maxHandoffRecords", GATEWAY_DEFAULT_LIMITS.maxHandoffRecords, GATEWAY_HARD_LIMITS.maxHandoffRecords),
    maxSkillFiles: boundedLimit(pick(limitsRaw, "maxSkillFiles", "max_skill_files"), "limits.maxSkillFiles", GATEWAY_DEFAULT_LIMITS.maxSkillFiles, GATEWAY_HARD_LIMITS.maxSkillFiles),
    maxSkillFileBytes: boundedLimit(pick(limitsRaw, "maxSkillFileBytes", "max_skill_file_bytes"), "limits.maxSkillFileBytes", GATEWAY_DEFAULT_LIMITS.maxSkillFileBytes, GATEWAY_HARD_LIMITS.maxSkillFileBytes),
    maxSkillResponseBytes: boundedLimit(pick(limitsRaw, "maxSkillResponseBytes", "max_skill_response_bytes"), "limits.maxSkillResponseBytes", GATEWAY_DEFAULT_LIMITS.maxSkillResponseBytes, GATEWAY_HARD_LIMITS.maxSkillResponseBytes),
    maxMaestroOutputBytes: boundedLimit(pick(limitsRaw, "maxMaestroOutputBytes", "max_maestro_output_bytes"), "limits.maxMaestroOutputBytes", GATEWAY_DEFAULT_LIMITS.maxMaestroOutputBytes, GATEWAY_HARD_LIMITS.maxMaestroOutputBytes),
    maxMaestroTimeoutMs: boundedLimit(pick(limitsRaw, "maxMaestroTimeoutMs", "max_maestro_timeout_ms"), "limits.maxMaestroTimeoutMs", GATEWAY_DEFAULT_LIMITS.maxMaestroTimeoutMs, GATEWAY_HARD_LIMITS.maxMaestroTimeoutMs),
  };

  const loggingRaw = optionalObject(root.logging, "logging");
  knownKeys(loggingRaw, ["level", "file", "audit_file", "auditFile", "enabled", "dir"], "logging");
  const level = loggingRaw.level === undefined ? "info" : loggingRaw.level;
  if (level !== "silent" && level !== "error" && level !== "warn" && level !== "info" && level !== "debug") throw new GatewayConfigValidationError("logging.level is invalid");
  const logging: GatewayLoggingConfig = {
    level,
    ...(optionalString(loggingRaw.file, "logging.file", 4096) === undefined ? {} : { file: optionalString(loggingRaw.file, "logging.file", 4096) }),
    ...(optionalString(loggingRaw.auditFile ?? loggingRaw.audit_file, "logging.auditFile", 4096) === undefined ? {} : { auditFile: optionalString(loggingRaw.auditFile ?? loggingRaw.audit_file, "logging.auditFile", 4096) }),
  };
  const stateRaw = optionalObject(root.state, "state");
  knownKeys(stateRaw, ["rootDir", "root_dir", "ownerPath", "owner_path", "workspaceRegistryPath", "workspace_registry_path", "sessionsRoot", "sessions_root", "boardRoot", "board_root", "handoffRoot", "handoff_root", "operationReceiptRoot", "operation_receipt_root", "maestroReceiptRoot", "maestro_receipt_root", "pairingPath", "pairing_path", "serviceManifestPath", "service_manifest_path", "retention"], "state");
  const state: GatewayStateConfig = {
    ...(optionalString(stateRaw.rootDir ?? stateRaw.root_dir, "state.rootDir", 4096) === undefined ? {} : { rootDir: optionalString(stateRaw.rootDir ?? stateRaw.root_dir, "state.rootDir", 4096) }),
    ...(optionalString(stateRaw.ownerPath ?? stateRaw.owner_path, "state.ownerPath", 4096) === undefined ? {} : { ownerPath: optionalString(stateRaw.ownerPath ?? stateRaw.owner_path, "state.ownerPath", 4096) }),
    ...(optionalString(stateRaw.workspaceRegistryPath ?? stateRaw.workspace_registry_path, "state.workspaceRegistryPath", 4096) === undefined ? {} : { workspaceRegistryPath: optionalString(stateRaw.workspaceRegistryPath ?? stateRaw.workspace_registry_path, "state.workspaceRegistryPath", 4096) }),
    ...(optionalString(stateRaw.sessionsRoot ?? stateRaw.sessions_root, "state.sessionsRoot", 4096) === undefined ? {} : { sessionsRoot: optionalString(stateRaw.sessionsRoot ?? stateRaw.sessions_root, "state.sessionsRoot", 4096) }),
    ...(optionalString(stateRaw.boardRoot ?? stateRaw.board_root, "state.boardRoot", 4096) === undefined ? {} : { boardRoot: optionalString(stateRaw.boardRoot ?? stateRaw.board_root, "state.boardRoot", 4096) }),
    ...(optionalString(stateRaw.handoffRoot ?? stateRaw.handoff_root, "state.handoffRoot", 4096) === undefined ? {} : { handoffRoot: optionalString(stateRaw.handoffRoot ?? stateRaw.handoff_root, "state.handoffRoot", 4096) }),
    ...(optionalString(stateRaw.operationReceiptRoot ?? stateRaw.operation_receipt_root, "state.operationReceiptRoot", 4096) === undefined ? {} : { operationReceiptRoot: optionalString(stateRaw.operationReceiptRoot ?? stateRaw.operation_receipt_root, "state.operationReceiptRoot", 4096) }),
    ...(optionalString(stateRaw.maestroReceiptRoot ?? stateRaw.maestro_receipt_root, "state.maestroReceiptRoot", 4096) === undefined ? {} : { maestroReceiptRoot: optionalString(stateRaw.maestroReceiptRoot ?? stateRaw.maestro_receipt_root, "state.maestroReceiptRoot", 4096) }),
    ...(optionalString(stateRaw.pairingPath ?? stateRaw.pairing_path, "state.pairingPath", 4096) === undefined ? {} : { pairingPath: optionalString(stateRaw.pairingPath ?? stateRaw.pairing_path, "state.pairingPath", 4096) }),
    ...(optionalString(stateRaw.serviceManifestPath ?? stateRaw.service_manifest_path, "state.serviceManifestPath", 4096) === undefined ? {} : { serviceManifestPath: optionalString(stateRaw.serviceManifestPath ?? stateRaw.service_manifest_path, "state.serviceManifestPath", 4096) }),
  };
  const retentionRaw = optionalObject(root.retention, "retention");
  knownKeys(retentionRaw, ["jobsMs", "jobs_ms", "jobs", "tasksMs", "tasks_ms", "tasks", "resultsMs", "results_ms", "results", "workspacesMs", "workspaces_ms", "workspaces", "boardTasksMs", "board_tasks_ms", "board_tasks", "boardOperationsMs", "board_operations_ms", "board_operations", "boardEventsMs", "board_events_ms", "board_events"], "retention");
  const retention: GatewayRetentionConfig = {
    jobsMs: boundedLimit(retentionRaw.jobsMs ?? retentionRaw.jobs_ms ?? retentionRaw.jobs, "retention.jobsMs", DEFAULT_RETENTION.jobsMs, 365 * 24 * 60 * 60 * 1000),
    tasksMs: boundedLimit(retentionRaw.tasksMs ?? retentionRaw.tasks_ms ?? retentionRaw.tasks, "retention.tasksMs", DEFAULT_RETENTION.tasksMs, 365 * 24 * 60 * 60 * 1000),
    resultsMs: boundedLimit(retentionRaw.resultsMs ?? retentionRaw.results_ms ?? retentionRaw.results, "retention.resultsMs", DEFAULT_RETENTION.resultsMs, 365 * 24 * 60 * 60 * 1000),
    workspacesMs: boundedLimit(retentionRaw.workspacesMs ?? retentionRaw.workspaces_ms ?? retentionRaw.workspaces, "retention.workspacesMs", DEFAULT_RETENTION.workspacesMs, 365 * 24 * 60 * 60 * 1000),
    boardTasksMs: boundedLimit(retentionRaw.boardTasksMs ?? retentionRaw.board_tasks_ms ?? retentionRaw.board_tasks, "retention.boardTasksMs", DEFAULT_RETENTION.boardTasksMs, 365 * 24 * 60 * 60 * 1000),
    boardOperationsMs: boundedLimit(retentionRaw.boardOperationsMs ?? retentionRaw.board_operations_ms ?? retentionRaw.board_operations, "retention.boardOperationsMs", DEFAULT_RETENTION.boardOperationsMs, 365 * 24 * 60 * 60 * 1000),
    boardEventsMs: boundedLimit(retentionRaw.boardEventsMs ?? retentionRaw.board_events_ms ?? retentionRaw.board_events, "retention.boardEventsMs", DEFAULT_RETENTION.boardEventsMs, 365 * 24 * 60 * 60 * 1000),
  };

  const tunnelsRaw = optionalObject(root.tunnels, "tunnels");
  knownKeys(tunnelsRaw, ["openai", "profiles"], "tunnels");
  const fabricRaw = optionalObject(root.fabric, "fabric");
  knownKeys(fabricRaw, ["enabled", "audience", "limits", "enrollmentPath", "enrollment_path"], "fabric");
  const fabricEnabled = bool(fabricRaw.enabled, "fabric.enabled", DEFAULT_FABRIC.enabled);
  const fabricLimitsRaw = optionalObject(fabricRaw.limits, "fabric.limits");
  knownKeys(fabricLimitsRaw, ["maxFrameBytes", "max_frame_bytes", "heartbeatIntervalMs", "heartbeat_interval_ms", "heartbeatTimeoutMs", "heartbeat_timeout_ms"], "fabric.limits");
  const fabricLimits = {
    maxFrameBytes: integer(fabricLimitsRaw.maxFrameBytes ?? fabricLimitsRaw.max_frame_bytes, "fabric.limits.maxFrameBytes", 1_024, 16 * 1024 * 1024, DEFAULT_FABRIC_LIMITS.maxFrameBytes),
    heartbeatIntervalMs: integer(fabricLimitsRaw.heartbeatIntervalMs ?? fabricLimitsRaw.heartbeat_interval_ms, "fabric.limits.heartbeatIntervalMs", 100, 600_000, DEFAULT_FABRIC_LIMITS.heartbeatIntervalMs),
    heartbeatTimeoutMs: integer(fabricLimitsRaw.heartbeatTimeoutMs ?? fabricLimitsRaw.heartbeat_timeout_ms, "fabric.limits.heartbeatTimeoutMs", 200, 3_600_000, DEFAULT_FABRIC_LIMITS.heartbeatTimeoutMs),
  };
  if (fabricLimits.heartbeatTimeoutMs <= fabricLimits.heartbeatIntervalMs) {
    throw new GatewayConfigValidationError("fabric.limits.heartbeatTimeoutMs must exceed heartbeatIntervalMs");
  }
  const fabricAudience = optionalString(fabricRaw.audience, "fabric.audience", 256);
  const fabricEnrollmentPath = optionalString(fabricRaw.enrollmentPath ?? fabricRaw.enrollment_path, "fabric.enrollmentPath", 4_096);
  const fabricLimitsConfigured = Object.keys(fabricLimitsRaw).length > 0;
  const fabric: GatewayFabricConfig = {
    enabled: fabricEnabled,
    ...(fabricAudience === undefined ? {} : { audience: fabricAudience }),
    ...(fabricLimitsConfigured ? { limits: fabricLimits } : {}),
    ...(fabricEnrollmentPath === undefined ? {} : { enrollmentPath: fabricEnrollmentPath }),
  };
  // Fabric is recognized whether or not it is enabled: a document that names
  // Fabric settings while the section is off is a configuration the operator
  // meant to take effect, and silently ignoring it would leave the Gateway
  // running without the multi-device plane it was configured for.
  if (!fabricEnabled) {
    const configured = Object.keys(fabricRaw).filter((key) => key !== "enabled");
    if (configured.length > 0) {
      throw new GatewayConfigValidationError(
        `fabric.${configured[0]} is set while fabric.enabled is false; enable Fabric or remove the setting rather than leaving it ignored`,
      );
    }
  }
  const openaiRaw = optionalObject(tunnelsRaw.openai, "tunnels.openai");
  knownKeys(openaiRaw, ["enabled", "autoInstall", "auto_install", "binaryPath", "binary_path", "tunnelIdEnv", "tunnel_id_env", "runtimeKeyEnv", "runtime_key_env", "minimumVersion", "minimum_version", "credentialTtlMs", "credential_ttl_ms"], "tunnels.openai");
  const environmentName = (value: unknown, path: string, fallback: string): string => {
    const result = value === undefined ? fallback : stringValue(value, path, 128);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(result)) throw new GatewayConfigValidationError(`${path} must be an environment variable name`);
    return result;
  };
  const minimumVersion = openaiRaw.minimumVersion ?? openaiRaw.minimum_version;
  const openai: GatewayOpenAiTunnelConfig = {
    enabled: bool(openaiRaw.enabled, "tunnels.openai.enabled", DEFAULT_TUNNELS.openai.enabled),
    autoInstall: bool(openaiRaw.autoInstall ?? openaiRaw.auto_install, "tunnels.openai.autoInstall", DEFAULT_TUNNELS.openai.autoInstall),
    ...(optionalString(openaiRaw.binaryPath ?? openaiRaw.binary_path, "tunnels.openai.binaryPath", 4096) === undefined ? {} : { binaryPath: optionalString(openaiRaw.binaryPath ?? openaiRaw.binary_path, "tunnels.openai.binaryPath", 4096) }),
    tunnelIdEnv: environmentName(openaiRaw.tunnelIdEnv ?? openaiRaw.tunnel_id_env, "tunnels.openai.tunnelIdEnv", DEFAULT_TUNNELS.openai.tunnelIdEnv),
    runtimeKeyEnv: environmentName(openaiRaw.runtimeKeyEnv ?? openaiRaw.runtime_key_env, "tunnels.openai.runtimeKeyEnv", DEFAULT_TUNNELS.openai.runtimeKeyEnv),
    minimumVersion: minimumVersion === undefined ? DEFAULT_TUNNELS.openai.minimumVersion : stringValue(minimumVersion, "tunnels.openai.minimumVersion", 64),
    credentialTtlMs: integer(openaiRaw.credentialTtlMs ?? openaiRaw.credential_ttl_ms, "tunnels.openai.credentialTtlMs", 1_000, 60 * 60_000, DEFAULT_TUNNELS.openai.credentialTtlMs),
  };
  if (!/^\d+\.\d+\.\d+$/u.test(openai.minimumVersion)) throw new GatewayConfigValidationError("tunnels.openai.minimumVersion must be a semantic version triplet");

  const profilesRaw = tunnelsRaw.profiles;
  if (profilesRaw !== undefined && !Array.isArray(profilesRaw)) throw new GatewayConfigValidationError("tunnels.profiles must be a list");
  if ((profilesRaw?.length ?? 0) > 32) throw new GatewayConfigValidationError("tunnels.profiles must contain at most 32 entries");
  const profileIds = new Set<string>();
  const profiles: GatewayTunnelProfileConfig[] = (profilesRaw ?? []).map((entry, index) => {
    const path = `tunnels.profiles[${index}]`;
    const item = object(entry, path);
    knownKeys(item, [
      "id", "enabled", "provider", "mode", "lifecycle", "binaryPath", "binary_path", "localPort", "local_port",
      "publicUrl", "public_url", "tunnelId", "tunnel_id", "credentialsFile", "credentials_file", "tokenFile", "token_file",
      "mcpAccess", "mcp_access",
      "tunnelIdEnv", "tunnel_id_env", "runtimeKeyEnv", "runtime_key_env", "credentialTtlMs", "credential_ttl_ms",
      "autoInstall", "auto_install",
      "host", "user", "port", "remoteBindHost", "remote_bind_host", "remotePort", "remote_port",
      "localHost", "local_host", "identityFile", "identity_file", "configFile", "config_file",
      "knownHostsFile", "known_hosts_file", "connectTimeoutSeconds", "connect_timeout_seconds",
      "serverAliveIntervalSeconds", "server_alive_interval_seconds", "serverAliveCountMax", "server_alive_count_max",
    ], path);
    const id = stringValue(item.id, `${path}.id`, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) throw new GatewayConfigValidationError(`${path}.id must be a safe identifier`);
    if (profileIds.has(id)) throw new GatewayConfigValidationError(`Duplicate tunnel profile id: ${id}`);
    profileIds.add(id);
    const provider = item.provider;
    const mode = item.mode;
    const enabled = bool(item.enabled, `${path}.enabled`, true);
    const lifecycle = item.lifecycle ?? (mode === "quick" ? "ephemeral" : "persistent");
    const binaryPath = optionalString(item.binaryPath ?? item.binary_path, `${path}.binaryPath`, 4096);
    const localPort = item.localPort ?? item.local_port;
    const common = {
      id,
      enabled,
      ...(binaryPath === undefined ? {} : { binaryPath }),
      ...(localPort === undefined ? {} : { localPort: integer(localPort, `${path}.localPort`, 1, 65_535) }),
    };
    const rawPublicUrl = optionalString(item.publicUrl ?? item.public_url, `${path}.publicUrl`, 2048);
    const publicUrl = rawPublicUrl === undefined ? undefined : (() => {
      let parsed: URL;
      try { parsed = new URL(rawPublicUrl); } catch { throw new GatewayConfigValidationError(`${path}.publicUrl must be an HTTPS origin`); }
      if (parsed.protocol !== "https:" || parsed.origin !== rawPublicUrl || parsed.pathname !== "/" || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new GatewayConfigValidationError(`${path}.publicUrl must be an exact credential-free HTTPS origin`);
      }
      return parsed.origin;
    })();
    const hasNamedFields = item.tunnelId !== undefined || item.tunnel_id !== undefined
      || item.credentialsFile !== undefined || item.credentials_file !== undefined || item.tokenFile !== undefined || item.token_file !== undefined;
    const hasOpenAiFields = item.tunnelIdEnv !== undefined || item.tunnel_id_env !== undefined
      || item.runtimeKeyEnv !== undefined || item.runtime_key_env !== undefined || item.credentialTtlMs !== undefined || item.credential_ttl_ms !== undefined
      || item.autoInstall !== undefined || item.auto_install !== undefined;
    const hasSshFields = item.host !== undefined || item.user !== undefined || item.port !== undefined
      || item.remoteBindHost !== undefined || item.remote_bind_host !== undefined || item.remotePort !== undefined || item.remote_port !== undefined
      || item.localHost !== undefined || item.local_host !== undefined || item.identityFile !== undefined || item.identity_file !== undefined
      || item.configFile !== undefined || item.config_file !== undefined || item.knownHostsFile !== undefined || item.known_hosts_file !== undefined
      || item.connectTimeoutSeconds !== undefined || item.connect_timeout_seconds !== undefined
      || item.serverAliveIntervalSeconds !== undefined || item.server_alive_interval_seconds !== undefined
      || item.serverAliveCountMax !== undefined || item.server_alive_count_max !== undefined;
    const mcpRaw = item.mcpAccess !== undefined ? item.mcpAccess : item.mcp_access;
    const normalizeMcp = (): GatewayTunnelMcpAccessConfig | undefined => {
      if (mcpRaw === undefined) return undefined;
      try {
        const result = normalizeGatewayTunnelMcpAccess(mcpRaw, `${path}.mcpAccess`, { provider: String(provider), mode: String(mode), controlledPath: transport.http.path });
        if (result.publicUrl !== undefined && publicUrl !== undefined && new URL(result.publicUrl).origin !== new URL(publicUrl).origin) {
          throw new GatewayTunnelMcpAccessValidationError(`${path}.publicUrl must match the tunnel profile publicUrl origin`);
        }
        return result;
      } catch (error) {
        if (error instanceof GatewayTunnelMcpAccessValidationError) throw new GatewayConfigValidationError(error.message);
        throw error;
      }
    };
    if (provider === "cloudflare" && mode === "quick") {
      if (lifecycle !== "ephemeral") throw new GatewayConfigValidationError(`${path}.lifecycle must be ephemeral for Cloudflare Quick Tunnel`);
      if (publicUrl !== undefined || hasNamedFields || hasOpenAiFields || hasSshFields) {
        throw new GatewayConfigValidationError(`${path} Quick Tunnel cannot define persistent-provider fields`);
      }
      const mcpAccess = normalizeMcp();
      if (mcpAccess?.publicUrl !== undefined) throw new GatewayConfigValidationError(`${path}.mcpAccess.publicUrl is not allowed for an ephemeral Quick Tunnel`);
      return { ...common, provider, mode, lifecycle, ...(mcpAccess === undefined ? {} : { mcpAccess }) };
    }
    if (provider === "cloudflare" && mode === "named") {
      if (lifecycle !== "persistent") throw new GatewayConfigValidationError(`${path}.lifecycle must be persistent for Cloudflare Named Tunnel`);
      if (hasOpenAiFields) throw new GatewayConfigValidationError(`${path} Cloudflare Named Tunnel cannot define OpenAI fields`);
      if (hasSshFields) throw new GatewayConfigValidationError(`${path} Cloudflare Named Tunnel cannot define SSH fields`);
      if (!publicUrl) throw new GatewayConfigValidationError(`${path}.publicUrl is required`);
      const tunnelId = stringValue(item.tunnelId ?? item.tunnel_id, `${path}.tunnelId`, 128);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(tunnelId)) throw new GatewayConfigValidationError(`${path}.tunnelId must be a safe name or UUID`);
      const credentialsFile = optionalString(item.credentialsFile ?? item.credentials_file, `${path}.credentialsFile`, 4096);
      const tokenFile = optionalString(item.tokenFile ?? item.token_file, `${path}.tokenFile`, 4096);
      if (Boolean(credentialsFile) === Boolean(tokenFile)) throw new GatewayConfigValidationError(`${path} requires exactly one of credentialsFile or tokenFile`);
      const mcpAccess = normalizeMcp();
      return { ...common, provider, mode, lifecycle, publicUrl, tunnelId, ...(credentialsFile ? { credentialsFile } : { tokenFile: tokenFile! }), ...(mcpAccess === undefined ? {} : { mcpAccess }) };
    }
    if (provider === "openai" && mode === "secure") {
      if (lifecycle !== "persistent") throw new GatewayConfigValidationError(`${path}.lifecycle must be persistent for OpenAI Secure Tunnel`);
      if (hasNamedFields) throw new GatewayConfigValidationError(`${path} OpenAI Secure Tunnel cannot define Cloudflare Named fields`);
      if (hasSshFields) throw new GatewayConfigValidationError(`${path} OpenAI Secure Tunnel cannot define SSH fields`);
      if (!publicUrl) throw new GatewayConfigValidationError(`${path}.publicUrl is required`);
      const mcpAccess = normalizeMcp();
      return {
        ...common,
        provider,
        mode,
        lifecycle,
        publicUrl,
        tunnelIdEnv: environmentName(item.tunnelIdEnv ?? item.tunnel_id_env, `${path}.tunnelIdEnv`, openai.tunnelIdEnv),
        runtimeKeyEnv: environmentName(item.runtimeKeyEnv ?? item.runtime_key_env, `${path}.runtimeKeyEnv`, openai.runtimeKeyEnv),
        credentialTtlMs: integer(item.credentialTtlMs ?? item.credential_ttl_ms, `${path}.credentialTtlMs`, 60_000, 60 * 60_000, openai.credentialTtlMs),
        ...(item.autoInstall === undefined && item.auto_install === undefined ? {} : { autoInstall: bool(item.autoInstall ?? item.auto_install, `${path}.autoInstall`, false) }),
        ...(mcpAccess === undefined ? {} : { mcpAccess }),
      };
    }
    if (provider === "ssh" && mode === "reverse") {
      if (lifecycle !== "persistent") throw new GatewayConfigValidationError(`${path}.lifecycle must be persistent for SSH Reverse Tunnel`);
      if (hasNamedFields || hasOpenAiFields) throw new GatewayConfigValidationError(`${path} SSH Reverse Tunnel cannot define fields for another provider`);
      if (!publicUrl) throw new GatewayConfigValidationError(`${path}.publicUrl is required`);
      const host = stringValue(item.host, `${path}.host`, 255);
      if (host.startsWith("-") || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(host)) {
        throw new GatewayConfigValidationError(`${path}.host must be a safe SSH host or config alias`);
      }
      const user = optionalString(item.user, `${path}.user`, 64);
      if (user !== undefined && (user.startsWith("-") || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(user))) {
        throw new GatewayConfigValidationError(`${path}.user must be a safe SSH user name`);
      }
      const port = integer(item.port, `${path}.port`, 1, 65_535, 22);
      const remoteBindHost = optionalString(item.remoteBindHost ?? item.remote_bind_host, `${path}.remoteBindHost`, 64) ?? "127.0.0.1";
      if (remoteBindHost !== "127.0.0.1" && remoteBindHost !== "::1") throw new GatewayConfigValidationError(`${path}.remoteBindHost must be loopback`);
      const remotePort = integer(item.remotePort ?? item.remote_port, `${path}.remotePort`, 1, 65_535);
      const localHost = optionalString(item.localHost ?? item.local_host, `${path}.localHost`, 64) ?? "127.0.0.1";
      if (localHost !== "127.0.0.1" && localHost !== "::1") throw new GatewayConfigValidationError(`${path}.localHost must be loopback`);
      const identityFile = optionalString(item.identityFile ?? item.identity_file, `${path}.identityFile`, 4096);
      const configFile = optionalString(item.configFile ?? item.config_file, `${path}.configFile`, 4096);
      const knownHostsFile = optionalString(item.knownHostsFile ?? item.known_hosts_file, `${path}.knownHostsFile`, 4096);
      for (const [filePath, value] of [[`${path}.identityFile`, identityFile], [`${path}.configFile`, configFile], [`${path}.knownHostsFile`, knownHostsFile]] as const) {
        if (value !== undefined && !isAbsolute(value)) throw new GatewayConfigValidationError(`${filePath} must be an absolute path`);
      }
      const mcpAccess = normalizeMcp();
      return {
        ...common,
        provider,
        mode,
        lifecycle,
        publicUrl,
        host,
        ...(user === undefined ? {} : { user }),
        port,
        remoteBindHost,
        remotePort,
        localHost,
        ...(identityFile === undefined ? {} : { identityFile }),
        ...(configFile === undefined ? {} : { configFile }),
        ...(knownHostsFile === undefined ? {} : { knownHostsFile }),
        connectTimeoutSeconds: integer(item.connectTimeoutSeconds ?? item.connect_timeout_seconds, `${path}.connectTimeoutSeconds`, 1, 120, 10),
        serverAliveIntervalSeconds: integer(item.serverAliveIntervalSeconds ?? item.server_alive_interval_seconds, `${path}.serverAliveIntervalSeconds`, 5, 300, 15),
        serverAliveCountMax: integer(item.serverAliveCountMax ?? item.server_alive_count_max, `${path}.serverAliveCountMax`, 1, 10, 3),
        ...(mcpAccess === undefined ? {} : { mcpAccess }),
      };
    }
    throw new GatewayConfigValidationError(`${path} has an unsupported provider/mode combination`);
  });
  const activePersistent = profiles.filter((profile) => profile.enabled && profile.lifecycle === "persistent");
  if (activePersistent.length > 1) throw new GatewayConfigValidationError("Only one persistent tunnel profile may be enabled");
  if (activePersistent.length === 1) {
    const profile = activePersistent[0]!;
    if (auth.mode !== "oauth" && auth.mode !== "dual") throw new GatewayConfigValidationError("An enabled persistent tunnel profile requires auth.mode oauth or dual");
    if (auth.oauth?.serverUrl !== profile.publicUrl) throw new GatewayConfigValidationError("auth.oauth.serverUrl must match the enabled persistent tunnel profile publicUrl");
  }
  const tunnels: GatewayTunnelsConfig = { openai, profiles };

  return {
    version: GATEWAY_CONFIG_VERSION,
    server,
    auth,
    security: { commands, files, trustedFullAccess, skills, maestroCli, browser },
    workspaces,
    transport,
    limits,
    logging,
    state,
    retention,
    tunnels,
    fabric,
  };
}

function splitTopLevelSections(text: string): Array<{ key: string; raw: string }> {
  const lines = text.split(/(?<=\n)/);
  const sections: Array<{ key: string; raw: string }> = [];
  let current: { key: string; raw: string } | undefined;
  for (const line of lines) {
    const match = /^(?<key>[A-Za-z_][A-Za-z0-9_-]*):(?:\s|$)/.exec(line);
    if (match?.groups?.key) {
      if (current) sections.push(current);
      current = { key: match.groups.key, raw: line };
    } else if (current) current.raw += line;
    else if (line.trim() !== "") sections.push({ key: "__preamble__", raw: line });
  }
  if (current) sections.push(current);
  return sections;
}

function parseRawDocument(text: string): Record<string, unknown> {
  try {
    const parsed = parseYaml(text);
    return object(parsed ?? {}, "config");
  } catch (error) {
    const position = (error as { linePos?: readonly { line?: unknown; col?: unknown }[] } | undefined)?.linePos?.[0];
    const location = typeof position?.line === "number" && typeof position.col === "number"
      ? ` at line ${position.line}, column ${position.col}`
      : "";
    throw new GatewayConfigValidationError(`Invalid config YAML${location}`);
  }
}

export function parseGatewayConfigDocument(text: string, path?: string): GatewayConfigDocument {
  if (utf8Bytes(text) > MAX_CONFIG_BYTES) throw new GatewayConfigValidationError(`config exceeds ${MAX_CONFIG_BYTES} bytes`);
  const raw = parseRawDocument(text);
  const unknownSections: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) if (!KNOWN_SECTIONS.has(key)) unknownSections[key] = value;
  return { config: normalizeGatewayConfig(raw), unknownSections, raw: text, ...(path === undefined ? {} : { path }) };
}
export const parseGatewayYaml = parseGatewayConfigDocument;

export function parseGatewayConfig(value: unknown): GatewayConfig {
  return normalizeGatewayConfig(value);
}

export async function readGatewayConfigDocument(path = gatewayConfigPath()): Promise<GatewayConfigDocument> {
  const raw = await readGatewayFile(path, MAX_CONFIG_BYTES);
  return parseGatewayConfigDocument(raw ?? "", path);
}
export async function loadGatewayConfig(path = gatewayConfigPath()): Promise<GatewayConfig> {
  return (await readGatewayConfigDocument(path)).config;
}
export function loadGatewayConfigSync(path = gatewayConfigPath()): GatewayConfig {
  try { return parseGatewayConfigDocument(readFileSync(path, "utf8"), path).config; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultGatewayConfig();
    throw error;
  }
}
export const readGatewayConfig = loadGatewayConfig;

function toYamlSection(key: string, value: unknown): string {
  return stringifyYaml({ [key]: value }, { lineWidth: 0 }).trimEnd() + "\n";
}

function topLevelRawKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function canonicalYamlSection(key: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (key === "server") {
    const v = value as Record<string, unknown>;
    const { disableLocalhostProtection, disable_localhost_protection, trustProxyHeaders, trust_proxy_headers, allowedOrigins, allowed_origins, ...rest } = v;
    return {
      ...rest,
      ...(disableLocalhostProtection === undefined ? (disable_localhost_protection === undefined ? {} : { disable_localhost_protection }) : { disable_localhost_protection: disableLocalhostProtection }),
      ...(trustProxyHeaders === undefined ? (trust_proxy_headers === undefined ? {} : { trust_proxy_headers }) : { trust_proxy_headers: trustProxyHeaders }),
      ...(allowedOrigins === undefined ? (allowed_origins === undefined ? {} : { allowed_origins }) : { allowed_origins: allowedOrigins }),
    };
  }
  if (key === "auth") {
    const v = value as Record<string, unknown>;
    const { oauth: rawOauth, allowOpenMutations, allow_open_mutations, ...rest } = v;
    let oauth: unknown = rawOauth;
    if (rawOauth && typeof rawOauth === "object" && !Array.isArray(rawOauth)) {
      const o = rawOauth as Record<string, unknown>;
      const { serverUrl, server_url, tokenTtlMs, token_ttl, token_ttl_ms, ...oauthRest } = o;
      oauth = {
        ...oauthRest,
        ...(serverUrl === undefined ? (server_url === undefined ? {} : { server_url }) : { server_url: serverUrl }),
        ...(tokenTtlMs === undefined
          ? (token_ttl === undefined ? (token_ttl_ms === undefined ? {} : { token_ttl: Math.floor((token_ttl_ms as number) / 1000) }) : { token_ttl })
          : { token_ttl: Math.floor((tokenTtlMs as number) / 1000) }),
      };
    }
    return {
      ...rest,
      ...(allowOpenMutations === undefined ? (allow_open_mutations === undefined ? {} : { allow_open_mutations }) : { allow_open_mutations: allowOpenMutations }),
      ...(oauth === undefined ? {} : { oauth }),
    };
  }
  if (key === "security") {
    const v = value as Record<string, unknown>;
    const { commands: rawCommands, files: rawFiles, ...rest } = v;
    const normalizeCommands = rawCommands && typeof rawCommands === "object" && !Array.isArray(rawCommands)
      ? (() => {
        const c = rawCommands as Record<string, unknown>;
        const { autoAllowReadonly, auto_allow_readonly, ...commandsRest } = c;
        return { ...commandsRest, ...(autoAllowReadonly === undefined ? (auto_allow_readonly === undefined ? {} : { auto_allow_readonly }) : { auto_allow_readonly: autoAllowReadonly }) };
      })() : rawCommands;
    const normalizeFiles = rawFiles && typeof rawFiles === "object" && !Array.isArray(rawFiles)
      ? (() => {
        const f = rawFiles as Record<string, unknown>;
        const { maxReadBytes, max_read_bytes, maxPatchFiles, max_patch_files, ...filesRest } = f;
        return {
          ...filesRest,
          ...(maxReadBytes === undefined ? (max_read_bytes === undefined ? {} : { max_read_bytes }) : { max_read_bytes: maxReadBytes }),
          ...(maxPatchFiles === undefined ? (max_patch_files === undefined ? {} : { max_patch_files }) : { max_patch_files: maxPatchFiles }),
        };
      })() : rawFiles;
    return { ...rest, ...(normalizeCommands === undefined ? {} : { commands: normalizeCommands }), ...(normalizeFiles === undefined ? {} : { files: normalizeFiles }) };
  }
  if (key === "tunnels") {
    const v = value as Record<string, unknown>;
    const rawOpenAi = v.openai;
    let openai: unknown = rawOpenAi;
    if (rawOpenAi && typeof rawOpenAi === "object" && !Array.isArray(rawOpenAi)) {
      const o = rawOpenAi as Record<string, unknown>;
      const { binaryPath, tunnelIdEnv, runtimeKeyEnv, minimumVersion, credentialTtlMs, autoInstall, ...rest } = o;
      openai = {
        ...rest,
        ...(autoInstall === undefined ? {} : { auto_install: autoInstall }),
        ...(binaryPath === undefined ? {} : { binary_path: binaryPath }),
        ...(tunnelIdEnv === undefined ? {} : { tunnel_id_env: tunnelIdEnv }),
        ...(runtimeKeyEnv === undefined ? {} : { runtime_key_env: runtimeKeyEnv }),
        ...(minimumVersion === undefined ? {} : { minimum_version: minimumVersion }),
        ...(credentialTtlMs === undefined ? {} : { credential_ttl_ms: credentialTtlMs }),
      };
    }
    const profiles = Array.isArray(v.profiles) ? v.profiles.map((profile) => {
      if (!profile || typeof profile !== "object" || Array.isArray(profile)) return profile;
      const p = profile as Record<string, unknown>;
      const { binaryPath, localPort, publicUrl, tunnelId, credentialsFile, tokenFile, tunnelIdEnv, runtimeKeyEnv, credentialTtlMs, autoInstall, mcpAccess, mcp_access, ...rest } = p;
      const rawMcp = mcpAccess ?? mcp_access;
      const mcp = rawMcp && typeof rawMcp === "object" && !Array.isArray(rawMcp)
        ? (() => {
          const access = rawMcp as Record<string, unknown>;
          const { allowedActions, allowed_actions, publicUrl: accessUrl, public_url, auth: rawAuth, ...accessRest } = access;
          const auth = rawAuth && typeof rawAuth === "object" && !Array.isArray(rawAuth)
            ? (() => {
              const authRecord = rawAuth as Record<string, unknown>;
              const { workspaceId, workspace_id, ...authRest } = authRecord;
              return { ...authRest, ...(workspaceId === undefined ? (workspace_id === undefined ? {} : { workspace_id }) : { workspace_id: workspaceId }) };
            })()
            : rawAuth;
          return {
            ...accessRest,
            ...(allowedActions === undefined ? (allowed_actions === undefined ? {} : { actions: allowed_actions }) : { actions: allowedActions }),
            ...(accessUrl === undefined ? (public_url === undefined ? {} : { public_url }) : { public_url: accessUrl }),
            ...(auth === undefined ? {} : { auth }),
          };
        })()
        : rawMcp;
      return {
        ...rest,
        ...(mcp === undefined ? {} : { mcp_access: mcp }),
        ...(binaryPath === undefined ? {} : { binary_path: binaryPath }),
        ...(localPort === undefined ? {} : { local_port: localPort }),
        ...(publicUrl === undefined ? {} : { public_url: publicUrl }),
        ...(tunnelId === undefined ? {} : { tunnel_id: tunnelId }),
        ...(credentialsFile === undefined ? {} : { credentials_file: credentialsFile }),
        ...(tokenFile === undefined ? {} : { token_file: tokenFile }),
        ...(tunnelIdEnv === undefined ? {} : { tunnel_id_env: tunnelIdEnv }),
        ...(runtimeKeyEnv === undefined ? {} : { runtime_key_env: runtimeKeyEnv }),
        ...(credentialTtlMs === undefined ? {} : { credential_ttl_ms: credentialTtlMs }),
        ...(autoInstall === undefined ? {} : { auto_install: autoInstall }),
      };
    }) : v.profiles;
    return { ...v, ...(openai === undefined ? {} : { openai }), ...(profiles === undefined ? {} : { profiles }) };
  }
  return value;
}

/** Apply a patch with omitted=preserve, arrays=replace, objects=merge, and null=clear. */
export function applyGatewayConfigPatch(base: GatewayConfig, patch: GatewayConfigPatch): GatewayConfig {
  const raw = structuredClone(base) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (key === "version" || value === undefined) continue;
    const next = mergeRawValue(raw[key], value);
    if (next === undefined) delete raw[key]; else raw[key] = next;
  }
  return normalizeGatewayConfig(raw);
}

function mergeKeyAliases(key: string): string[] {
  const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  const camel = key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  return [...new Set([key, snake, camel])];
}

function mergeRawValue(base: unknown, patch: unknown): unknown {
  if (patch === null) return undefined;
  if (Array.isArray(patch) || patch === undefined || typeof patch !== "object" || patch === null) return structuredClone(patch);
  const result: Record<string, unknown> = base && typeof base === "object" && !Array.isArray(base)
    ? structuredClone(base as Record<string, unknown>)
    : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    const aliases = mergeKeyAliases(key);
    const existingKey = aliases.find((alias) => Object.prototype.hasOwnProperty.call(result, alias));
    const existing = existingKey === undefined ? undefined : result[existingKey];
    for (const alias of aliases) delete result[alias];
    const next = mergeRawValue(existing, value);
    if (next !== undefined) result[key] = next;
  }
  return result;
}

function yamlDocumentPatchKey(
  document: ReturnType<typeof parseDocument>,
  parent: readonly string[],
  key: string,
): { key: string; aliases: string[]; canonicalKeys: boolean } {
  const rootKey = parent[0] ?? topLevelRawKey(key);
  const canonicalKeys = KNOWN_SECTIONS.has(rootKey);
  const aliases = canonicalKeys ? mergeKeyAliases(key) : [key];
  const existing = aliases.find((alias) => document.hasIn([...parent, alias]));
  return { key: existing ?? (canonicalKeys ? topLevelRawKey(key) : key), aliases, canonicalKeys };
}

function canonicalYamlPatchValue(value: unknown, canonicalKeys: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalYamlPatchValue(item, canonicalKeys));
  if (!value || typeof value !== "object") return structuredClone(value);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
    canonicalKeys ? topLevelRawKey(key) : key,
    canonicalYamlPatchValue(child, canonicalKeys),
  ]));
}

function applyYamlDocumentPatch(
  document: ReturnType<typeof parseDocument>,
  parent: readonly string[],
  key: string,
  patch: unknown,
): void {
  if (patch === undefined) return;
  const resolved = yamlDocumentPatchKey(document, parent, key);
  for (const alias of resolved.aliases) {
    if (alias !== resolved.key) document.deleteIn([...parent, alias]);
  }
  const path = [...parent, resolved.key];
  if (patch === null) {
    document.deleteIn(path);
    return;
  }
  if (Array.isArray(patch) || typeof patch !== "object") {
    document.setIn(path, canonicalYamlPatchValue(patch, resolved.canonicalKeys));
    return;
  }
  const existing = document.getIn(path);
  if (!isMap(existing)) document.setIn(path, document.createNode({}));
  for (const [childKey, childValue] of Object.entries(patch as Record<string, unknown>)) {
    applyYamlDocumentPatch(document, path, childKey, childValue);
  }
}

function replaceSections(text: string, changed: Record<string, unknown>): string {
  const sections = splitTopLevelSections(text);
  const touched = new Set(Object.keys(changed).map(topLevelRawKey));
  let output = "";
  const emitted = new Set<string>();
  for (const section of sections) {
    if (section.key === "__preamble__") { output += section.raw; continue; }
    if (touched.has(section.key)) {
      if (changed[section.key] !== undefined) output += toYamlSection(section.key, canonicalYamlSection(section.key, changed[section.key]));
      emitted.add(section.key);
    } else output += section.raw;
  }
  for (const [inputKey, value] of Object.entries(changed)) {
    const key = topLevelRawKey(inputKey);
    if (!emitted.has(key) && !sections.some((section) => section.key === key)) {
      if (output && !output.endsWith("\n")) output += "\n";
      output += toYamlSection(key, canonicalYamlSection(inputKey, value));
    }
  }
  return output.endsWith("\n") ? output : `${output}\n`;
}

/**
 * Replace only supplied top-level sections. Unowned sections and comments are
 * copied verbatim from the existing file; omitted fields remain untouched.
 */
async function writeGatewayConfigPatchUnlocked(
  path: string,
  patch: GatewayConfigPatch,
  cwd = process.cwd(),
): Promise<GatewayConfigDocument> {
  const existing = await readGatewayFile(path, MAX_CONFIG_BYTES) ?? "";
  // Validate the effective result before committing, so malformed known fields
  // never reach the native Gateway config.
  const current = parseRawDocument(existing);
  const document = parseDocument(existing);
  let changed = false;
  if (current.version === undefined) {
    current.version = GATEWAY_CONFIG_VERSION;
    document.set("version", GATEWAY_CONFIG_VERSION);
    changed = true;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "version") {
      if (value !== GATEWAY_CONFIG_VERSION) throw new GatewayConfigValidationError(`config.version must be ${GATEWAY_CONFIG_VERSION}`);
      continue;
    }
    const yamlKey = topLevelRawKey(key);
    const next = mergeRawValue(current[yamlKey], value);
    if (next === undefined) delete current[yamlKey];
    else current[yamlKey] = next;
    applyYamlDocumentPatch(document, [], key, value);
    changed = true;
  }
  normalizeGatewayConfig(current);
  const nextText = changed ? document.toString({ lineWidth: 0 }) : existing;
  await writeGatewayFileAtomic(path, nextText, { mode: 0o600, maximumBytes: MAX_CONFIG_BYTES });
  return parseGatewayConfigDocument(nextText, path);
}

export async function writeGatewayConfigPatch(
  path: string,
  patch: GatewayConfigPatch,
  cwd = process.cwd(),
): Promise<GatewayConfigDocument> {
  return withGatewayConfigLock(path, () => writeGatewayConfigPatchUnlocked(path, patch, cwd));
}

const CONFIG_LOCK_OPTIONS = {
  realpath: false,
  stale: 10_000,
  update: 2_000,
  retries: { retries: 8, factor: 1.4, minTimeout: 25, maxTimeout: 250, randomize: true },
};

async function withGatewayConfigLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    try { writeFileSync(path, "", { encoding: "utf8", mode: 0o600, flag: "wx" }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const release = await properLockfile.lock(path, CONFIG_LOCK_OPTIONS);
  try { return await operation(); }
  finally { await release(); }
}

/** Apply a patch only when the exact raw document observed by the caller remains current. */
export async function writeGatewayConfigPatchIfCurrent(
  path: string,
  expectedRaw: string,
  patch: GatewayConfigPatch,
  cwd = process.cwd(),
): Promise<GatewayConfigDocument> {
  return withGatewayConfigLock(path, async () => {
    const current = await readGatewayFile(path, MAX_CONFIG_BYTES) ?? "";
    if (current !== expectedRaw) throw new GatewayConfigConflictError();
    return writeGatewayConfigPatchUnlocked(path, patch, cwd);
  });
}

/** Restore a snapshot only when the committed document is still the expected one. */
export async function restoreGatewayConfigIfCurrent(path: string, expectedRaw: string, replacementRaw: string): Promise<void> {
  return withGatewayConfigLock(path, async () => {
    const current = await readGatewayFile(path, MAX_CONFIG_BYTES) ?? "";
    if (current !== expectedRaw) throw new GatewayConfigConflictError("Gateway config changed; rollback left newer writer intact");
    if (utf8Bytes(replacementRaw) > MAX_CONFIG_BYTES) throw new GatewayConfigValidationError(`config exceeds ${MAX_CONFIG_BYTES} bytes`);
    parseGatewayConfigDocument(replacementRaw, path);
    await writeGatewayFileAtomic(path, replacementRaw, { mode: 0o600, maximumBytes: MAX_CONFIG_BYTES });
  });
}

export async function writeGatewayConfig(path: string, config: GatewayConfig | GatewayConfigPatch): Promise<GatewayConfigDocument> {
  const patch = (config as GatewayConfig).version === GATEWAY_CONFIG_VERSION
    ? config as unknown as GatewayConfigPatch
    : config as GatewayConfigPatch;
  return writeGatewayConfigPatch(path, patch);
}

export async function updateGatewayConfig(patch: GatewayConfigPatch, path = gatewayConfigPath()): Promise<GatewayConfigDocument> {
  return writeGatewayConfigPatch(path, patch);
}
export const saveGatewayConfig = writeGatewayConfig;
