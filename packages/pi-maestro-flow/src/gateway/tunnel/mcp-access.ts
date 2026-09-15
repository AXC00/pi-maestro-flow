/** Validated MCP ingress access policy for Gateway tunnel profiles. */

export type GatewayTunnelMcpAuthKind = "gateway" | "managed-forward";

export interface GatewayTunnelMcpGatewayAuth {
  kind: "gateway";
}

export interface GatewayTunnelMcpManagedForwardAuth {
  kind: "managed-forward";
  provider: "openai";
  workspaceId?: string;
}

export type GatewayTunnelMcpAuth = GatewayTunnelMcpGatewayAuth | GatewayTunnelMcpManagedForwardAuth;

/** Audience used by credentials injected into an external tunnel child. */
export const GATEWAY_TUNNEL_AUDIENCE = "gateway.tunnel" as const;
/** Compatibility capability retained for profiles without an explicit MCP policy. */
export const GATEWAY_TUNNEL_DEFAULT_SCOPE = "gateway.host.status" as const;

export interface GatewayTunnelMcpAccessConfig {
  enabled: boolean;
  actions: string[];
  auth: GatewayTunnelMcpAuth;
  /** Optional fixed MCP endpoint. Credentials, query, and fragment are forbidden. */
  publicUrl?: string;
}

export const GATEWAY_TUNNEL_MCP_MAX_ACTIONS = 64 as const;
export const GATEWAY_TUNNEL_MCP_MAX_ACTION_BYTES = 128 as const;

const ACTION_PART = "[A-Za-z0-9][A-Za-z0-9._:-]{0,63}";
const GATEWAY_ACTION = new RegExp(`^gateway\\.${ACTION_PART}\\.${ACTION_PART}$`, "u");
const FABRIC_CONTROL_ACTION = new RegExp(`^fabric\\.control\\.${ACTION_PART}\\.${ACTION_PART}$`, "u");
const WORKSPACE_ID = /^[a-f0-9]{64}$/u;

/** Canonical MCP listener path shared by config, HTTP, and tunnel projections. */
export function normalizeGatewayTunnelMcpPath(value: unknown, path = "transport.http.path"): string {
  const raw = stringValue(value, path, 1024).trim();
  const normalized = raw.startsWith("/") ? raw : `/${raw}`;
  if (normalized !== "/" && (normalized.includes("?") || normalized.includes("#") || !/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?$/u.test(normalized))) {
    throw new GatewayTunnelMcpAccessValidationError(`${path} must be an absolute MCP URL path without query or fragment`);
  }
  return normalized === "/" ? "/" : normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

export class GatewayTunnelMcpAccessValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayTunnelMcpAccessValidationError";
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayTunnelMcpAccessValidationError(`${path} must be a mapping`);
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new GatewayTunnelMcpAccessValidationError(`${path}.${key} is not a recognized field`);
}

function stringValue(value: unknown, path: string, max = 4096): string {
  if (typeof value !== "string" || value.trim() === "") throw new GatewayTunnelMcpAccessValidationError(`${path} must be a non-empty string`);
  if (Buffer.byteLength(value, "utf8") > max) throw new GatewayTunnelMcpAccessValidationError(`${path} exceeds ${max} UTF-8 bytes`);
  return value;
}

function bool(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new GatewayTunnelMcpAccessValidationError(`${path} must be a boolean`);
  return value;
}

function alias(value: Record<string, unknown>, camel: string, snake: string, path: string): unknown {
  const hasCamel = Object.prototype.hasOwnProperty.call(value, camel);
  const hasSnake = Object.prototype.hasOwnProperty.call(value, snake);
  if (hasCamel && hasSnake && JSON.stringify(value[camel]) !== JSON.stringify(value[snake])) {
    throw new GatewayTunnelMcpAccessValidationError(`${path} has conflicting aliases ${camel} and ${snake}`);
  }
  return hasCamel ? value[camel] : value[snake];
}

/** Normalize an HTTPS fixed endpoint, retaining only the controlled MCP path. */
export function normalizeGatewayTunnelMcpUrl(value: unknown, path = "mcpAccess.publicUrl", controlledPath = "/mcp"): string {
  const raw = stringValue(value, path, 2048);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new GatewayTunnelMcpAccessValidationError(`${path} must be an HTTPS URL`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new GatewayTunnelMcpAccessValidationError(`${path} must be credential-free HTTPS without query or fragment`);
  }
  const canonicalPath = normalizeGatewayTunnelMcpPath(controlledPath, `${path}.controlledPath`);
  const parsedPath = normalizeGatewayTunnelMcpPath(parsed.pathname, path);
  if (parsedPath !== "/" && parsedPath !== canonicalPath) {
    throw new GatewayTunnelMcpAccessValidationError(`${path} must use the HTTPS origin or controlled MCP path ${canonicalPath}`);
  }
  return parsedPath === "/" ? parsed.origin : `${parsed.origin}${parsedPath}`;
}

export interface GatewayTunnelMcpAccessContext {
  provider?: string;
  mode?: string;
  controlledPath?: string;
}

/** Validate the tunnel MCP access contract, accepting both camel and snake case keys. */
export function normalizeGatewayTunnelMcpAccess(
  value: unknown,
  path = "mcpAccess",
  context: GatewayTunnelMcpAccessContext = {},
): GatewayTunnelMcpAccessConfig {
  const item = record(value, path);
  knownKeys(item, ["enabled", "actions", "scopes", "auth", "publicUrl", "public_url"], path);
  const enabled = bool(item.enabled, `${path}.enabled`, false);
  const hasActions = Object.prototype.hasOwnProperty.call(item, "actions");
  const hasScopes = Object.prototype.hasOwnProperty.call(item, "scopes");
  if (hasActions && hasScopes && JSON.stringify(item.actions) !== JSON.stringify(item.scopes)) {
    throw new GatewayTunnelMcpAccessValidationError(`${path} has conflicting aliases actions and scopes`);
  }
  const actionsRaw = hasActions ? item.actions : item.scopes;
  const actionsPath = hasActions ? `${path}.actions` : `${path}.scopes`;
  if (actionsRaw !== undefined && (!Array.isArray(actionsRaw) || actionsRaw.length > GATEWAY_TUNNEL_MCP_MAX_ACTIONS)) {
    throw new GatewayTunnelMcpAccessValidationError(`${actionsPath} must contain 1–64 actions`);
  }
  const actions = (actionsRaw ?? []).map((entry: unknown, index: number) => {
    const action = stringValue(entry, `${actionsPath}[${index}]`, GATEWAY_TUNNEL_MCP_MAX_ACTION_BYTES);
    const segments = action.split(".");
    const forbiddenScope = segments.some((segment) => ["enrollment", "exchange", "events", "wss", "websocket"].includes(segment.toLocaleLowerCase()));
    if (action.includes("*") || action.includes("?") || forbiddenScope || (!GATEWAY_ACTION.test(action) && !FABRIC_CONTROL_ACTION.test(action))) {
      throw new GatewayTunnelMcpAccessValidationError(`${actionsPath}[${index}] must be an exact Gateway or Fabric control action`);
    }
    return action;
  });
  if (new Set(actions).size !== actions.length) throw new GatewayTunnelMcpAccessValidationError(`${actionsPath} must not contain duplicates`);

  const authRaw = item.auth === undefined ? { kind: "gateway" } : record(item.auth, `${path}.auth`);
  knownKeys(authRaw, ["kind", "provider", "workspaceId", "workspace_id", "workspace"], `${path}.auth`);
  const kind = authRaw.kind;
  if (kind === "gateway") {
    if (authRaw.provider !== undefined || authRaw.workspaceId !== undefined || authRaw.workspace_id !== undefined || authRaw.workspace !== undefined) {
      throw new GatewayTunnelMcpAccessValidationError(`${path}.auth gateway cannot define provider, workspace, or scopes`);
    }
    // Gateway auth delegates authorization to the remote Agent's actual
    // pairing credential. Profile actions/scopes would be an unenforced
    // allowlist, so ordinary providers may only use this as an ingress marker.
    if (actions.length > 0) throw new GatewayTunnelMcpAccessValidationError(`${path}.auth gateway cannot define actions/scopes; use the pairing credential`);
    if (enabled && context.provider === "openai" && context.mode === "secure") {
      throw new GatewayTunnelMcpAccessValidationError(`${path}.auth gateway is not supported for enabled OpenAI Secure MCP access; use managed-forward`);
    }
  } else if (kind === "managed-forward") {
    if (authRaw.provider !== "openai" || context.provider !== "openai" || context.mode !== "secure") {
      throw new GatewayTunnelMcpAccessValidationError(`${path}.auth managed-forward is only supported by OpenAI Secure Tunnel`);
    }
    if (enabled && (actionsRaw === undefined || actions.length === 0)) {
      throw new GatewayTunnelMcpAccessValidationError(`${actionsPath} must contain 1–64 actions when managed-forward is enabled`);
    }
  } else {
    throw new GatewayTunnelMcpAccessValidationError(`${path}.auth.kind must be gateway or managed-forward`);
  }

  const publicUrlRaw = alias(item, "publicUrl", "public_url", path);
  const publicUrl = publicUrlRaw === undefined
    ? undefined
    : normalizeGatewayTunnelMcpUrl(publicUrlRaw, `${path}.publicUrl`, context.controlledPath ?? "/mcp");
  if (kind === "gateway") return { enabled, actions, auth: { kind: "gateway" }, ...(publicUrl === undefined ? {} : { publicUrl }) };
  const workspaceValues = [
    authRaw.workspaceId,
    authRaw.workspace_id,
    authRaw.workspace,
  ].filter((candidate) => candidate !== undefined);
  if (new Set(workspaceValues.map((candidate) => JSON.stringify(candidate))).size > 1) {
    throw new GatewayTunnelMcpAccessValidationError(`${path}.auth has conflicting workspace aliases`);
  }
  const workspaceRaw = workspaceValues[0];
  let workspaceId: string | undefined;
  if (workspaceRaw !== undefined) {
    workspaceId = stringValue(workspaceRaw, `${path}.auth.workspaceId`, 64);
    if (!WORKSPACE_ID.test(workspaceId)) throw new GatewayTunnelMcpAccessValidationError(`${path}.auth.workspaceId must be a 64-character lowercase hexadecimal ID`);
  }
  return {
    enabled,
    actions,
    auth: { kind: "managed-forward", provider: "openai", ...(workspaceId === undefined ? {} : { workspaceId }) },
    ...(publicUrl === undefined ? {} : { publicUrl }),
  };
}

export interface GatewayTunnelMcpCredentialPolicy {
  readonly scopes: readonly string[];
  readonly workspaceId?: string;
}

/**
 * Project the credential policy from the canonical profile only. Disabled or
 * absent MCP access deliberately falls back to the legacy host status read;
 * caller-supplied provider input is never part of this projection.
 */
export function gatewayTunnelMcpCredentialPolicy(
  access: GatewayTunnelMcpAccessConfig | undefined,
): GatewayTunnelMcpCredentialPolicy {
  if (access?.enabled !== true) return { scopes: [GATEWAY_TUNNEL_DEFAULT_SCOPE] };
  if (access.auth.kind === "gateway") {
    throw new GatewayTunnelMcpAccessValidationError("MCP access policy cannot issue scoped credentials for gateway auth");
  }
  if (!Array.isArray(access.actions) || access.actions.length === 0) throw new GatewayTunnelMcpAccessValidationError("MCP access policy requires explicit actions when enabled");
  const scopes = [...access.actions];
  if (scopes.length > GATEWAY_TUNNEL_MCP_MAX_ACTIONS || new Set(scopes).size !== scopes.length
    || scopes.some((scope) => !isGatewayTunnelMcpAction(scope))) {
    throw new GatewayTunnelMcpAccessValidationError("MCP access policy contains invalid or duplicate actions");
  }
  const workspaceId = access.auth.kind === "managed-forward" ? access.auth.workspaceId : undefined;
  if (workspaceId !== undefined && !WORKSPACE_ID.test(workspaceId)) {
    throw new GatewayTunnelMcpAccessValidationError("MCP access policy workspaceId is invalid");
  }
  return workspaceId === undefined ? { scopes } : { scopes, workspaceId };
}

export function isGatewayTunnelMcpAction(value: string): boolean {
  return GATEWAY_ACTION.test(value) || FABRIC_CONTROL_ACTION.test(value);
}

/** Compatibility spelling used by callers that refer to the policy as a contract. */
export const parseGatewayTunnelMcpAccess = normalizeGatewayTunnelMcpAccess;
