import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  applyGatewayConfigPatch,
  loadGatewayConfig,
  writeGatewayConfigPatch,
  type GatewayAuthMode,
  type GatewayCommandPolicy,
  type GatewayConfig,
  type GatewayConfigPatch,
  type GatewayLogLevel,
} from "./config.ts";
import { gatewayConfigPath } from "./state-paths.ts";

export type GatewayConfigTuiField =
  | "listenHost"
  | "listenPort"
  | "httpEnabled"
  | "httpPath"
  | "stdioEnabled"
  | "sshEnabled"
  | "commandDefault"
  | "autoAllowReadonly"
  | "disableLocalhostProtection"
  | "trustProxyHeaders"
  | "logLevel";

export interface GatewayConfigTuiDraft {
  listenHost: string;
  listenPort: number;
  httpEnabled: boolean;
  httpPath: string;
  stdioEnabled: boolean;
  sshEnabled: boolean;
  commandDefault: GatewayCommandPolicy;
  autoAllowReadonly: boolean | null;
  disableLocalhostProtection: boolean;
  trustProxyHeaders: boolean;
  logLevel: GatewayLogLevel;
  readonly authMode: GatewayAuthMode;
  readonly tunnelProfileCount: number;
}

interface GatewayConfigTuiFieldDefinition {
  key: GatewayConfigTuiField;
  label: string;
  hint: string;
}

export const GATEWAY_CONFIG_TUI_FIELDS: readonly GatewayConfigTuiFieldDefinition[] = [
  { key: "listenHost", label: "监听地址", hint: "主机名或 IP" },
  { key: "listenPort", label: "监听端口", hint: "1-65535" },
  { key: "httpEnabled", label: "HTTP transport", hint: "on/off" },
  { key: "httpPath", label: "MCP HTTP path", hint: "以 / 开头" },
  { key: "stdioEnabled", label: "stdio transport", hint: "on/off" },
  { key: "sshEnabled", label: "SSH transport", hint: "on/off" },
  { key: "commandDefault", label: "命令默认策略", hint: "allow/confirm/deny" },
  { key: "autoAllowReadonly", label: "只读命令自动允许", hint: "inherit/on/off" },
  { key: "disableLocalhostProtection", label: "关闭 localhost 保护", hint: "on/off" },
  { key: "trustProxyHeaders", label: "信任代理头", hint: "on/off" },
  { key: "logLevel", label: "日志级别", hint: "silent/error/warn/info/debug" },
] as const;

export interface GatewayConfigTuiOptions {
  input?: Readable;
  output?: Writable;
  configPath?: string;
  cwd?: string;
}

export interface GatewayConfigTuiResult {
  status: "saved" | "cancelled";
  path: string;
}

function parseBoolean(value: string, field: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["on", "true", "yes", "1"].includes(normalized)) return true;
  if (["off", "false", "no", "0"].includes(normalized)) return false;
  throw new Error(`${field} 必须是 on 或 off`);
}

function parseChoice<T extends string>(value: string, choices: readonly T[], field: string): T {
  const normalized = value.trim().toLowerCase();
  if (!choices.includes(normalized as T)) throw new Error(`${field} 必须是 ${choices.join("/")}`);
  return normalized as T;
}

export function createGatewayConfigTuiDraft(config: GatewayConfig): GatewayConfigTuiDraft {
  return {
    listenHost: config.transport.http.host,
    listenPort: config.transport.http.port,
    httpEnabled: config.transport.http.enabled,
    httpPath: config.transport.http.path,
    stdioEnabled: config.transport.stdio.enabled,
    sshEnabled: config.transport.ssh.enabled,
    commandDefault: config.security.commands.default,
    autoAllowReadonly: config.security.commands.autoAllowReadonly,
    disableLocalhostProtection: config.server.disableLocalhostProtection,
    trustProxyHeaders: config.server.trustProxyHeaders,
    logLevel: config.logging.level,
    authMode: config.auth.mode,
    tunnelProfileCount: config.tunnels.profiles.length,
  };
}

export function applyGatewayConfigTuiValue(
  draft: GatewayConfigTuiDraft,
  field: GatewayConfigTuiField,
  rawValue: string,
): GatewayConfigTuiDraft {
  const next = { ...draft };
  switch (field) {
    case "listenHost": {
      const value = rawValue.trim();
      if (!value || value.length > 255 || /[\r\n]/u.test(value)) throw new Error("监听地址必须是 1-255 个字符");
      next.listenHost = value;
      break;
    }
    case "listenPort": {
      const value = Number(rawValue.trim());
      if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error("监听端口必须是 1-65535 的整数");
      next.listenPort = value;
      break;
    }
    case "httpPath": {
      const value = rawValue.trim();
      if (!value.startsWith("/") || value.length > 1_024 || /[\s?#]/u.test(value)) {
        throw new Error("MCP HTTP path 必须以 / 开头且不能包含空白、? 或 #");
      }
      next.httpPath = value;
      break;
    }
    case "httpEnabled":
    case "stdioEnabled":
    case "sshEnabled":
    case "disableLocalhostProtection":
    case "trustProxyHeaders":
      next[field] = parseBoolean(rawValue, field);
      break;
    case "commandDefault":
      next.commandDefault = parseChoice(rawValue, ["allow", "confirm", "deny"], field);
      break;
    case "autoAllowReadonly": {
      const value = rawValue.trim().toLowerCase();
      next.autoAllowReadonly = value === "inherit" ? null : parseBoolean(value, field);
      break;
    }
    case "logLevel":
      next.logLevel = parseChoice(rawValue, ["silent", "error", "warn", "info", "debug"], field);
      break;
  }
  return next;
}

export function gatewayConfigPatchFromTuiDraft(
  draft: GatewayConfigTuiDraft,
  baseline?: GatewayConfigTuiDraft,
): GatewayConfigPatch {
  const changed = <K extends keyof GatewayConfigTuiDraft>(key: K): boolean =>
    baseline === undefined || draft[key] !== baseline[key];
  const hostChanged = changed("listenHost");
  const portChanged = changed("listenPort");
  const listenerChanged = hostChanged || portChanged;
  const serverChanged = listenerChanged || changed("disableLocalhostProtection") || changed("trustProxyHeaders");
  const httpChanged = listenerChanged || changed("httpEnabled") || changed("httpPath");
  const transportChanged = httpChanged || changed("stdioEnabled") || changed("sshEnabled");
  const commandsChanged = changed("commandDefault") || changed("autoAllowReadonly");

  return {
    ...(serverChanged ? {
      server: {
        ...(hostChanged ? { host: draft.listenHost } : {}),
        ...(portChanged ? { port: draft.listenPort } : {}),
        ...(changed("disableLocalhostProtection") ? { disableLocalhostProtection: draft.disableLocalhostProtection } : {}),
        ...(changed("trustProxyHeaders") ? { trustProxyHeaders: draft.trustProxyHeaders } : {}),
      },
    } : {}),
    ...(transportChanged ? {
      transport: {
        ...(httpChanged ? {
          http: {
            ...(hostChanged ? { host: draft.listenHost } : {}),
            ...(portChanged ? { port: draft.listenPort } : {}),
            ...(changed("httpEnabled") ? { enabled: draft.httpEnabled } : {}),
            ...(changed("httpPath") ? { path: draft.httpPath } : {}),
          },
        } : {}),
        ...(changed("stdioEnabled") ? { stdio: { enabled: draft.stdioEnabled } } : {}),
        ...(changed("sshEnabled") ? { ssh: { enabled: draft.sshEnabled } } : {}),
      },
    } : {}),
    ...(commandsChanged ? {
      security: {
        commands: {
          ...(changed("commandDefault") ? { default: draft.commandDefault } : {}),
          ...(changed("autoAllowReadonly") ? { autoAllowReadonly: draft.autoAllowReadonly } : {}),
        },
      },
    } : {}),
    ...(changed("logLevel") ? { logging: { level: draft.logLevel } } : {}),
  };
}

export function gatewayConfigTuiWarnings(draft: GatewayConfigTuiDraft): string[] {
  const warnings: string[] = [];
  const loopback = draft.listenHost === "127.0.0.1" || draft.listenHost === "::1" || draft.listenHost === "localhost";
  if (!loopback && draft.authMode === "open") warnings.push("非回环监听仍使用 open auth；公网或共享网络应先配置 bearer/oauth。 ");
  if (draft.commandDefault === "allow") warnings.push("命令默认策略为 allow；共享环境建议 confirm 或 deny。 ");
  if (draft.disableLocalhostProtection) warnings.push("localhost 保护已关闭；仅应在受控代理边界使用。 ");
  if (draft.trustProxyHeaders) warnings.push("代理头信任已启用；请确保只有可信反向代理能访问 Gateway。 ");
  return warnings.map((warning) => warning.trimEnd());
}

function displayValue(draft: GatewayConfigTuiDraft, field: GatewayConfigTuiField): string {
  const value = draft[field];
  if (value === null) return "inherit";
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

export function renderGatewayConfigTui(
  draft: GatewayConfigTuiDraft,
  path: string,
  status = "",
  clear = false,
): string {
  const rows = [
    ...(clear ? ["\x1b[2J\x1b[H"] : []),
    "Pi Maestro Gateway 独立配置 TUI",
    `配置文件: ${path}`,
    `认证模式: ${draft.authMode}（凭据不在此界面显示或修改）`,
    `Tunnel profiles: ${draft.tunnelProfileCount}（生命周期使用 tunnel profile CLI）`,
    "",
    ...GATEWAY_CONFIG_TUI_FIELDS.map((field, index) =>
      `${String(index + 1).padStart(2, " ")}. ${field.label}: ${displayValue(draft, field.key)}  [${field.hint}]`),
  ];
  const warnings = gatewayConfigTuiWarnings(draft);
  if (warnings.length > 0) rows.push("", ...warnings.map((warning) => `! ${warning}`));
  if (status) rows.push("", status);
  rows.push("", "输入编号或字段名进行编辑；s 保存；q 退出（不保存）", "> ");
  return rows.join("\n");
}

function fieldFromSelection(value: string): GatewayConfigTuiFieldDefinition | undefined {
  const trimmed = value.trim();
  const index = Number(trimmed);
  if (Number.isSafeInteger(index) && index >= 1 && index <= GATEWAY_CONFIG_TUI_FIELDS.length) {
    return GATEWAY_CONFIG_TUI_FIELDS[index - 1];
  }
  return GATEWAY_CONFIG_TUI_FIELDS.find((field) => field.key.toLowerCase() === trimmed.toLowerCase());
}

export async function runGatewayConfigCommand(
  args: readonly string[],
  options: Omit<GatewayConfigTuiOptions, "configPath"> = {},
): Promise<GatewayConfigTuiResult> {
  let configPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg !== "--config") throw new Error("Usage: pi-maestro-gateway config [--config PATH]");
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error("--config requires a value");
    configPath = value;
  }
  return runGatewayConfigTui({ ...options, configPath });
}

export async function runGatewayConfigTui(options: GatewayConfigTuiOptions = {}): Promise<GatewayConfigTuiResult> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const path = options.configPath ?? gatewayConfigPath();
  const cwd = options.cwd ?? process.cwd();
  const original = await loadGatewayConfig(path);
  const baseline = createGatewayConfigTuiDraft(original);
  let draft = baseline;
  let status = "";
  const terminal = Boolean((input as Readable & { isTTY?: boolean }).isTTY && (output as Writable & { isTTY?: boolean }).isTTY);
  const lines = createInterface({ input, output, terminal, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  try {
    while (true) {
      output.write(renderGatewayConfigTui(draft, path, status, terminal));
      const command = await iterator.next();
      if (command.done) return { status: "cancelled", path };
      const selection = command.value.trim();
      if (selection.toLowerCase() === "q") {
        output.write("未保存任何更改。\n");
        return { status: "cancelled", path };
      }
      if (selection.toLowerCase() === "s") {
        const patch = gatewayConfigPatchFromTuiDraft(draft, baseline);
        applyGatewayConfigPatch(original, patch);
        await writeGatewayConfigPatch(path, patch, cwd);
        output.write(`已保存 ${path}。重启 Pi Maestro Gateway 后生效。\n`);
        return { status: "saved", path };
      }
      const field = fieldFromSelection(selection);
      if (!field) {
        status = "无效选择；请输入 1-11、字段名、s 或 q。";
        continue;
      }
      output.write(`${field.label} (${field.hint})，当前 ${displayValue(draft, field.key)}\n> `);
      const entered = await iterator.next();
      if (entered.done) return { status: "cancelled", path };
      try {
        const next = applyGatewayConfigTuiValue(draft, field.key, entered.value);
        applyGatewayConfigPatch(original, gatewayConfigPatchFromTuiDraft(next, baseline));
        draft = next;
        status = `${field.label} 已更新；按 s 保存。`;
      } catch (error) {
        status = `无效值: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  } finally {
    lines.close();
  }
}
