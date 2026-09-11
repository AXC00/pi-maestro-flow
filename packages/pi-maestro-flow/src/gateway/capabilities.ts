/** Action-level Gateway capability matching shared by every authenticated transport. */
import type { GatewayPrincipal, GatewayToolName } from "./contracts.ts";

const CAPABILITY_PART = /^[A-Za-z0-9_-]+$/;

export function gatewayActionCapability(tool: GatewayToolName | string, action: string): string {
  if (!CAPABILITY_PART.test(tool) || !CAPABILITY_PART.test(action)) throw new Error("Gateway capability contains an invalid component");
  return `gateway.${tool}.${action}`;
}

/**
 * Compatibility grants are deliberately explicit. `gateway` and `gateway.*`
 * remain primary-owner umbrellas, while a narrow grant can cover exactly one
 * action (`gateway.file.read`) or one tool (`gateway.file`/`gateway.file.*`).
 */
export function gatewayScopeGrants(scopes: readonly string[], requested: string): boolean {
  if (!requested.startsWith("gateway.")) return false;
  const parts = requested.split(".");
  const tool = parts[1];
  return scopes.some((scope) => scope === "*"
    || scope === "gateway"
    || scope === "gateway.*"
    || scope === requested
    || scope === `gateway.${tool}`
    || scope === `gateway.${tool}.*`
    // Pre-v1 tool-level grants are accepted only as exact umbrellas; prefixes
    // never grant sibling actions.
    || scope === tool
    || scope === `${tool}.*`);
}

export function principalHasGatewayAction(
  principal: GatewayPrincipal,
  tool: GatewayToolName | string,
  action: string,
): boolean {
  if (principal.transport === "stdio") return true;
  if (principal.authenticated === true && principal.scopes.length === 0) return true;
  return gatewayScopeGrants(principal.scopes, gatewayActionCapability(tool, action));
}

export function isPrimaryGatewayScope(scope: string): boolean {
  return scope === "*" || scope === "gateway" || scope === "gateway.*";
}

export const FABRIC_DATA_SCOPE = "fabric.data" as const;
export type FabricDataAction = "exchange" | "events";

/**
 * Fabric data-plane grants are intentionally disjoint from legacy Gateway tool
 * grants. Open auth, `gateway`, `gateway.*`, and an empty authenticated scope
 * never imply paired-Gateway route access.
 */
export function principalHasFabricDataPlane(principal: GatewayPrincipal, action: FabricDataAction): boolean {
  if (principal.authenticated !== true) return false;
  const requested = `${FABRIC_DATA_SCOPE}.${action}`;
  return principal.scopes.some((scope) => scope === FABRIC_DATA_SCOPE || scope === `${FABRIC_DATA_SCOPE}.*` || scope === requested);
}
