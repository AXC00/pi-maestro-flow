/** Safe, allowlisted projection of tunnel MCP connection state for public/status output. */
import type { GatewayTunnelProfileConfig } from "../config.ts";
import type { GatewayTunnelPhase } from "./contracts.ts";
import { normalizeGatewayTunnelMcpPath, normalizeGatewayTunnelMcpUrl } from "./mcp-access.ts";

export interface GatewayTunnelMcpConnectionDescriptor {
  profile: string;
  provider: string;
  mode: string;
  /** Persistent profiles expose a fixed endpoint; ephemeral Quick profiles omit this key. */
  fixed?: true;
  ephemeral?: true;
  publicOrigin?: string;
  mcpUrl?: string;
  authKind: "gateway" | "managed-forward";
  enabled: boolean;
  phase: GatewayTunnelPhase;
  generation: number;
  readiness: boolean;
}

export interface GatewayTunnelMcpExposureState {
  phase?: GatewayTunnelPhase;
  generation?: number;
  readiness?: boolean;
  observed?: { phase?: GatewayTunnelPhase; endpoint?: string };
}

export interface GatewayTunnelMcpExposureOptions {
  httpPath?: string;
  state?: GatewayTunnelMcpExposureState;
}

const PHASES = new Set<GatewayTunnelPhase>(["stopped", "starting", "ready", "degraded", "quiescing", "failed"]);

/**
 * Project only the stable connection descriptor. Never pass provider input,
 * tunnel state, process identity, or runtime observations to this function's
 * output: those values can contain credentials and process-control material.
 */
export function projectGatewayTunnelMcpConnectionDescriptor(
  profile: GatewayTunnelProfileConfig,
  options: GatewayTunnelMcpExposureOptions | GatewayTunnelMcpExposureState = {},
): GatewayTunnelMcpConnectionDescriptor {
  const access = profile.mcpAccess;
  const authKind = access?.auth.kind === "managed-forward" ? "managed-forward" : "gateway";
  const optionsRecord = options as GatewayTunnelMcpExposureOptions;
  // The legacy overload accepts a bare state object. An options object may
  // contain only httpPath, so detect both option keys before selecting the
  // controlled path (never silently revert to /mcp).
  const isOptions = Object.hasOwn(optionsRecord, "state") || Object.hasOwn(optionsRecord, "httpPath");
  const state = isOptions ? optionsRecord.state : options as GatewayTunnelMcpExposureState;
  const httpPath = normalizeGatewayTunnelMcpPath(isOptions ? optionsRecord.httpPath ?? "/mcp" : "/mcp", "transport.http.path");
  const observedPhase = state?.observed?.phase;
  const fallbackPhase = observedPhase !== undefined && PHASES.has(observedPhase) ? observedPhase : "stopped";
  const phase = state?.phase !== undefined && PHASES.has(state.phase) ? state.phase : fallbackPhase;
  const generation = state?.generation !== undefined && Number.isSafeInteger(state.generation) && state.generation >= 0 ? state.generation : 0;
  const readiness = typeof state?.readiness === "boolean" ? state.readiness : phase === "ready";
  const descriptor: GatewayTunnelMcpConnectionDescriptor = {
    profile: profile.id,
    provider: profile.provider,
    mode: profile.mode,
    authKind,
    enabled: profile.enabled && (access?.enabled ?? false),
    phase,
    generation,
    readiness,
  };

  // Quick tunnels intentionally do not claim a fixed endpoint. In particular,
  // never project observed.endpoint: provider output may contain bearer URLs.
  if (profile.lifecycle === "ephemeral") {
    descriptor.ephemeral = true;
    return descriptor;
  }
  descriptor.fixed = true;
  const fixedUrl = access?.publicUrl ?? profile.publicUrl;
  if (fixedUrl !== undefined) {
    const controlledPath = httpPath;
    const mcpUrl = access?.publicUrl
      ? (() => {
        const normalized = normalizeGatewayTunnelMcpUrl(access.publicUrl!, "mcpAccess.publicUrl", controlledPath);
        return new URL(normalized).pathname === "/" ? `${normalized}${controlledPath}` : normalized;
      })()
      : normalizeGatewayTunnelMcpUrl(`${fixedUrl}${controlledPath}`, "profile.publicUrl", controlledPath);
    const parsed = new URL(mcpUrl);
    descriptor.publicOrigin = parsed.origin;
    descriptor.mcpUrl = mcpUrl;
  }
  return descriptor;
}

/** Alias for status/catalog callers. */
export const exposeGatewayTunnelMcpConnection = projectGatewayTunnelMcpConnectionDescriptor;
export const projectGatewayTunnelMcpExposure = projectGatewayTunnelMcpConnectionDescriptor;
