/**
 * Process-level Devin routing table.
 *
 * Cascade expresses reasoning strength as *different wire model uids*, not as a
 * request field, so a pi model id can only be resolved to a uid by knowing the
 * account's own ladder. Discovery (see discovery.ts) fills this table; the
 * transport reads it. It lives in its own module so discovery and the transport
 * can share it without importing each other.
 */

/** Base host for Codeium/Windsurf's Cascade API (Connect protocol over HTTP/1.1). */
export const DEVIN_API_BASE_URL = "https://server.codeium.com";

/** pi thinking levels, the axis a lane's effort ladder is keyed by. */
export type DevinThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface DevinRoute {
  /** Wire uid used when no effort route applies: the lane's server default. */
  uid: string;
  /** pi thinking level -> member wire uid. Levels absent here are unsupported. */
  byEffort: Partial<Record<DevinThinkingLevel, string>>;
  /** The lane is a server-side dispatcher: its uid must go through AssignModel. */
  router: boolean;
}

const routes = new Map<string, DevinRoute>();

/**
 * Replace the table with a freshly discovered roster. Discovery is the only
 * writer, so a successful fetch fully supersedes the previous ladder.
 */
export function registerDevinRoutes(entries: ReadonlyMap<string, DevinRoute>): void {
  routes.clear();
  for (const [modelId, route] of entries) routes.set(modelId, route);
}

export function lookupDevinRoute(modelId: string): DevinRoute | undefined {
  return routes.get(modelId);
}

/** Wire uid for one pi model at one thinking level; unknown ids resolve to themselves. */
export function resolveDevinWireUid(modelId: string, level: string | undefined): string {
  const route = routes.get(modelId);
  if (!route) return modelId;
  if (level && level in route.byEffort) {
    return route.byEffort[level as DevinThinkingLevel] ?? route.uid;
  }
  return route.uid;
}

export function isDevinRouterModel(modelId: string): boolean {
  return routes.get(modelId)?.router === true;
}

/** Test helper: the table is process-global state. */
export function clearDevinRoutes(): void {
  routes.clear();
}
