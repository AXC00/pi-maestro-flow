/**
 * Dependency-light, process-local projections for read-only agents owned by an
 * external runtime (for example Flow's ssh-gateway).
 *
 * Providers are session-aware and never create Teammate sessions/endpoints.
 * Consumers collect a sanitized snapshot for their current Pi session and may
 * subscribe to the best-effort dirty signal to repaint it.
 */

export type ExternalAgentProjectionStatus =
  | "pending"
  | "running"
  | "retrying"
  | "sleeping"
  | "result-ready"
  | "stalled"
  | "done"
  | "failed"
  | "terminated";

export interface ExternalAgentMetricsV1 {
  toolCount?: number;
  tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Bounded, sanitized, read-only display data for one externally owned agent. */
export interface ExternalAgentProjectionV1 {
  version: 1;
  /** Provider identity, such as `ssh-gateway`. */
  source: string;
  /** Pi session this projection belongs to. Cross-session items are dropped. */
  sessionId: string;
  /** Stable only within the source and session. */
  id: string;
  label: string;
  status: ExternalAgentProjectionStatus;
  activeTool?: string;
  activeToolArgs?: string;
  metrics?: ExternalAgentMetricsV1;
  /** Provider revision; consumers may derive one when it is omitted. */
  revision?: string;
  updatedAt: number;
}

export interface ExternalAgentProjectionContextV1 {
  sessionId: string;
  /** Maximum number of items the collector can accept from this provider. */
  maxAgents: number;
}

export interface ExternalAgentProjectionProviderV1 {
  /** Stable source identity. A later registration with the same source replaces it. */
  source: string;
  snapshot(context: ExternalAgentProjectionContextV1): readonly unknown[];
  /** Optional upstream refresh hook used by markAllExternalAgentProjectionsDirty. */
  markDirty?(): void;
}

export interface ExternalAgentProjectionRegistrationV1 {
  readonly source: string;
  /** Notify consumers after this provider's data changes. */
  markDirty(): void;
  dispose(): void;
}

export const EXTERNAL_AGENT_PROJECTION_MAX_PROVIDERS = 16;
export const EXTERNAL_AGENT_PROJECTION_MAX_AGENTS_PER_PROVIDER = 64;
export const EXTERNAL_AGENT_PROJECTION_MAX_AGENTS = 128;
export const EXTERNAL_AGENT_PROJECTION_MAX_ID_CHARS = 256;
export const EXTERNAL_AGENT_PROJECTION_MAX_LABEL_CHARS = 96;
export const EXTERNAL_AGENT_PROJECTION_MAX_TOOL_CHARS = 96;
export const EXTERNAL_AGENT_PROJECTION_MAX_TOOL_ARGS_CHARS = 256;

const REGISTRY_KEY = Symbol.for("pi-maestro.external-agent-projection-providers.v1");
const DIRTY_LISTENERS_KEY = Symbol.for("pi-maestro.external-agent-projection-dirty-listeners.v1");
const globals = globalThis as typeof globalThis & Record<symbol, unknown>;

function registry(): Map<string, ExternalAgentProjectionProviderV1> {
  const existing = globals[REGISTRY_KEY];
  if (existing instanceof Map) return existing as Map<string, ExternalAgentProjectionProviderV1>;
  const created = new Map<string, ExternalAgentProjectionProviderV1>();
  globals[REGISTRY_KEY] = created;
  return created;
}

function dirtyListeners(): Set<() => void> {
  const existing = globals[DIRTY_LISTENERS_KEY];
  if (existing instanceof Set) return existing as Set<() => void>;
  const created = new Set<() => void>();
  globals[DIRTY_LISTENERS_KEY] = created;
  return created;
}

function notifyDirty(): void {
  for (const listener of dirtyListeners()) {
    try {
      listener();
    } catch {
      // Repainting is best-effort and must not break a provider.
    }
  }
}

function boundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!clean) return undefined;
  return Array.from(clean).slice(0, maxChars).join("");
}

/** Identity fields reject overflow/control bytes instead of truncating into collisions. */
function boundedIdentity(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return undefined;
  const clean = value.trim();
  if (!clean || Array.from(clean).length > EXTERNAL_AGENT_PROJECTION_MAX_ID_CHARS) return undefined;
  return clean;
}

function boundedCounter(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

const STATUSES = new Set<ExternalAgentProjectionStatus>([
  "pending",
  "running",
  "retrying",
  "sleeping",
  "result-ready",
  "stalled",
  "done",
  "failed",
  "terminated",
]);

function sanitizeProjection(
  value: unknown,
  source: string,
  sessionId: string,
): ExternalAgentProjectionV1 | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const itemSource = boundedIdentity(item.source);
  const itemSessionId = boundedIdentity(item.sessionId);
  const id = boundedIdentity(item.id);
  const label = boundedText(item.label, EXTERNAL_AGENT_PROJECTION_MAX_LABEL_CHARS);
  const updatedAt = boundedCounter(item.updatedAt);
  if (item.version !== 1
    || itemSource !== source
    || itemSessionId !== sessionId
    || !id
    || !label
    || typeof item.status !== "string"
    || !STATUSES.has(item.status as ExternalAgentProjectionStatus)
    || updatedAt === undefined) return undefined;

  const activeTool = boundedText(item.activeTool, EXTERNAL_AGENT_PROJECTION_MAX_TOOL_CHARS);
  const activeToolArgs = boundedText(item.activeToolArgs, EXTERNAL_AGENT_PROJECTION_MAX_TOOL_ARGS_CHARS);
  const revision = boundedText(item.revision, EXTERNAL_AGENT_PROJECTION_MAX_ID_CHARS);
  const rawMetrics = item.metrics && typeof item.metrics === "object"
    ? item.metrics as Record<string, unknown>
    : undefined;
  const metrics = rawMetrics ? {
    toolCount: boundedCounter(rawMetrics.toolCount),
    tokens: boundedCounter(rawMetrics.tokens),
    inputTokens: boundedCounter(rawMetrics.inputTokens),
    outputTokens: boundedCounter(rawMetrics.outputTokens),
  } : undefined;
  const compactMetrics = metrics && Object.values(metrics).some((entry) => entry !== undefined)
    ? Object.fromEntries(Object.entries(metrics).filter(([, entry]) => entry !== undefined)) as ExternalAgentMetricsV1
    : undefined;

  return Object.freeze({
    version: 1,
    source: itemSource,
    sessionId: itemSessionId,
    id,
    label,
    status: item.status as ExternalAgentProjectionStatus,
    ...(activeTool ? { activeTool } : {}),
    ...(activeToolArgs ? { activeToolArgs } : {}),
    ...(compactMetrics ? { metrics: Object.freeze(compactMetrics) } : {}),
    ...(revision ? { revision } : {}),
    updatedAt,
  });
}

/** Bind a consumer repaint callback to projection dirty notifications. */
export function registerExternalAgentProjectionDirtyListener(listener: () => void): () => void {
  dirtyListeners().add(listener);
  return () => dirtyListeners().delete(listener);
}

export function registerExternalAgentProjectionProvider(
  provider: ExternalAgentProjectionProviderV1,
): ExternalAgentProjectionRegistrationV1 {
  const source = boundedIdentity(provider?.source);
  if (!source || typeof provider?.snapshot !== "function") {
    return { source: "", markDirty: () => undefined, dispose: () => undefined };
  }
  const providers = registry();
  if (!providers.has(source) && providers.size >= EXTERNAL_AGENT_PROJECTION_MAX_PROVIDERS) {
    return { source: "", markDirty: () => undefined, dispose: () => undefined };
  }
  providers.set(source, provider);
  return {
    source,
    markDirty: notifyDirty,
    dispose: () => {
      if (registry().get(source) !== provider) return;
      registry().delete(source);
      notifyDirty();
    },
  };
}

export function getExternalAgentProjectionProvider(source: string): ExternalAgentProjectionProviderV1 | undefined {
  return registry().get(source);
}

export function listExternalAgentProjectionProviders(): ExternalAgentProjectionProviderV1[] {
  return [...registry().values()].slice(0, EXTERNAL_AGENT_PROJECTION_MAX_PROVIDERS);
}

/**
 * Collect a frozen, bounded, known-field-only snapshot for one Pi session.
 * Throwing providers, cross-session items, duplicates, and malformed entries
 * are dropped without affecting other sources.
 */
export function collectExternalAgentProjections(
  sessionId: string,
  log?: (message: string) => void,
): readonly ExternalAgentProjectionV1[] {
  const cleanSessionId = boundedIdentity(sessionId);
  if (!cleanSessionId) return Object.freeze([]);
  const projections: ExternalAgentProjectionV1[] = [];
  const identities = new Set<string>();
  for (const provider of listExternalAgentProjectionProviders()) {
    if (projections.length >= EXTERNAL_AGENT_PROJECTION_MAX_AGENTS) break;
    const source = boundedIdentity(provider.source);
    if (!source) continue;
    try {
      const emitted = provider.snapshot({
        sessionId: cleanSessionId,
        maxAgents: Math.min(
          EXTERNAL_AGENT_PROJECTION_MAX_AGENTS_PER_PROVIDER,
          EXTERNAL_AGENT_PROJECTION_MAX_AGENTS - projections.length,
        ),
      });
      if (!Array.isArray(emitted)) continue;
      for (const value of emitted.slice(0, EXTERNAL_AGENT_PROJECTION_MAX_AGENTS_PER_PROVIDER)) {
        if (projections.length >= EXTERNAL_AGENT_PROJECTION_MAX_AGENTS) break;
        const projection = sanitizeProjection(value, source, cleanSessionId);
        if (!projection) continue;
        const identity = `${projection.source}\u0000${projection.id}`;
        if (identities.has(identity)) continue;
        identities.add(identity);
        projections.push(projection);
      }
    } catch (error) {
      log?.(`external agent projection provider "${source}" snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return Object.freeze(projections);
}

export function markAllExternalAgentProjectionsDirty(): void {
  for (const provider of listExternalAgentProjectionProviders()) {
    try {
      provider.markDirty?.();
    } catch {
      // Upstream refresh is best-effort.
    }
  }
  notifyDirty();
}
