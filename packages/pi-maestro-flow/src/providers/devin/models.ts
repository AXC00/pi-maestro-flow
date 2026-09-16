/**
 * Bundled Devin model roster.
 *
 * The Cascade catalog is credential-scoped (gated per account/team), so it is
 * never fetched at boot: baking one account's roster into the plugin would
 * misstate every other account's entitlements. This seed mirrors the SWE-2 lane
 * verified live through `GetCliModelConfigs`, so it resolves synchronously
 * before any credential-scoped discovery could run.
 *
 * Discovery publishes the account's whole roster unfiltered; which of those
 * models the user keeps is decided in pi's own configuration, not here.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

import type { DevinRoute } from "./routing.ts";

export const DEVIN_MODELS: readonly ProviderModelConfig[] = [
  {
    id: "swe-2",
    name: "SWE-2",
    api: "devin-agent",
    reasoning: true,
    input: ["text", "image"],
    // Included in the Devin Coding Plan: upstream reports no cost dimensions.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_000,
    maxTokens: 128_000,
  },
];

/**
 * Wire uids for the seed. Cascade expresses reasoning strength as separate wire
 * uids, so the offline roster still needs the ladder that discovery would
 * otherwise supply; a successful discovery replaces this table wholesale.
 */
export const DEVIN_SEED_ROUTES: ReadonlyMap<string, DevinRoute> = new Map([
  ["swe-2", { uid: "swe-2-high", byEffort: { medium: "swe-2-medium", high: "swe-2-high", max: "swe-2-max" }, router: false }],
]);
