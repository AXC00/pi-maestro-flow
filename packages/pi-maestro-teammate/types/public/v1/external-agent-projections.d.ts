/**
 * Dependency-light, process-local projections for read-only agents owned by an
 * external runtime (for example Flow's ssh-gateway).
 *
 * Providers are session-aware and never create Teammate sessions/endpoints.
 * Consumers collect a sanitized snapshot for their current Pi session and may
 * subscribe to the best-effort dirty signal to repaint it.
 */
export type ExternalAgentProjectionStatus = "pending" | "running" | "retrying" | "sleeping" | "result-ready" | "stalled" | "done" | "failed" | "terminated";
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
export declare const EXTERNAL_AGENT_PROJECTION_MAX_PROVIDERS = 16;
export declare const EXTERNAL_AGENT_PROJECTION_MAX_AGENTS_PER_PROVIDER = 64;
export declare const EXTERNAL_AGENT_PROJECTION_MAX_AGENTS = 128;
export declare const EXTERNAL_AGENT_PROJECTION_MAX_ID_CHARS = 256;
export declare const EXTERNAL_AGENT_PROJECTION_MAX_LABEL_CHARS = 96;
export declare const EXTERNAL_AGENT_PROJECTION_MAX_TOOL_CHARS = 96;
export declare const EXTERNAL_AGENT_PROJECTION_MAX_TOOL_ARGS_CHARS = 256;
/** Bind a consumer repaint callback to projection dirty notifications. */
export declare function registerExternalAgentProjectionDirtyListener(listener: () => void): () => void;
export declare function registerExternalAgentProjectionProvider(provider: ExternalAgentProjectionProviderV1): ExternalAgentProjectionRegistrationV1;
export declare function getExternalAgentProjectionProvider(source: string): ExternalAgentProjectionProviderV1 | undefined;
export declare function listExternalAgentProjectionProviders(): ExternalAgentProjectionProviderV1[];
/**
 * Collect a frozen, bounded, known-field-only snapshot for one Pi session.
 * Throwing providers, cross-session items, duplicates, and malformed entries
 * are dropped without affecting other sources.
 */
export declare function collectExternalAgentProjections(sessionId: string, log?: (message: string) => void): readonly ExternalAgentProjectionV1[];
export declare function markAllExternalAgentProjectionsDirty(): void;
