/**
 * Devin model discovery (`GetCliModelConfigs`).
 *
 * The Cascade catalog is credential-scoped: it lists the account's allowed
 * lanes together with each lane's per-effort wire uids, router entries and
 * per-lane pricing, so it can never be shipped as a static list. pi fetches it
 * through the provider `refreshModels` hook; the resulting ladders are handed to
 * the routing table (routing.ts) that the transport resolves against.
 *
 * Mapping ported from oh-my-pi's Devin discovery (MIT; see LICENSE.oh-my-pi),
 * with one deliberate difference: rather than emitting one spec per wire uid and
 * collapsing them into omp effort families, a lane becomes a single pi model
 * whose `thinkingLevelMap` marks the levels the ladder actually serves.
 */

import { gunzipSync } from "node:zlib";

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

import {
  DisplayOption,
  GetCliModelConfigsRequestSchema,
  GetCliModelConfigsResponseSchema,
  MetadataSchema,
  ModelDimensionKind,
  type ClientModelConfig,
  type Metadata,
} from "./devin-proto.ts";
import { create, fromBinary, toBinary, type MessageCodec, type ProtoMessage } from "./protobuf.ts";
import {
  DEVIN_API_BASE_URL,
  type DevinRoute,
  type DevinThinkingLevel,
} from "./routing.ts";

const GET_CLI_MODEL_CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
const DISCOVERY_TIMEOUT_MS = 5_000;

/** pi thinking levels in presentation order; the ladder is keyed by these. */
const THINKING_LEVELS: readonly DevinThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Display slots the native client advertises. `UNSPECIFIED` (0) is implicit.
 * Asking for the internal slots is what makes the server return its full
 * catalog, exactly as the native client does; the internal ones are filtered
 * out below. The vendored descriptor predates display options 6-8, and wire
 * values are plain int32, so the extra slots are cast rather than regenerated.
 */
const DISPLAY_OPTION_INTERNAL_DEFAULT = 6 as DisplayOption;
const DISPLAY_OPTION_UNCLASSIFIED = 7 as DisplayOption;
const DISPLAY_OPTION_NORMAL = 8 as DisplayOption;
const SUPPORTED_MODEL_DISPLAYS: readonly DisplayOption[] = [
  DisplayOption.MODEL_ROUTER,
  DisplayOption.QUICK_REVIEW,
  DISPLAY_OPTION_INTERNAL_DEFAULT,
  DISPLAY_OPTION_UNCLASSIFIED,
  DISPLAY_OPTION_NORMAL,
];
const INTERNAL_MODEL_DISPLAYS: ReadonlySet<DisplayOption> = new Set([
  DisplayOption.QUICK_REVIEW,
  DISPLAY_OPTION_INTERNAL_DEFAULT,
]);

/**
 * Wire uids whose configs advertise `supports_images` but whose backend drops
 * `ChatMessagePrompt.images`: SWE-1.6 answers as if no image was attached, while
 * the proxied frontier lanes read the field correctly. Declaring them text-only
 * lets pi use its image-fallback path instead of silently losing attachments.
 */
const IMAGE_BLIND_UIDS = new Set(["swe-1-6", "swe-1-6-fast"]);

const REASONING_LABEL_PATTERN = /think|thinking|minimal|high|medium|low|xhigh|max|reasoning/i;
const NO_REASONING_LABEL_PATTERN = /\bno thinking\b/i;

/** `modelFamilyMetadata` entry keys and orders that carry a selectable axis. */
const FAMILY_EFFORT_KEYS: Readonly<Partial<Record<string, true>>> = { effort: true, "reasoning effort": true };
const FAMILY_FAST_KEY = "fast mode";
const FAMILY_FAST_ORDER = 1;
const FAMILY_THINKING_KEY = "thinking";
const FAMILY_THINKING_ORDER = 1;
const FAMILY_CONTEXT_1M_KEY = "1m context";
const FAMILY_CONTEXT_1M_ORDER = 1;

/** Effort-entry names, punctuation stripped, mapped onto pi levels. */
const FAMILY_EFFORT_BY_NAME: Readonly<Partial<Record<string, DevinThinkingLevel>>> = {
  none: "off",
  nothinking: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

const COST_LABEL_INPUT = "input";
const COST_LABEL_CACHE_READ = "cached input";
const COST_LABEL_OUTPUT = "output";
const COST_DENOMINATOR_PATTERN = /(\d+(?:\.\d+)?)\s*([kmb])?/i;
const COST_DENOMINATOR_SCALE: Readonly<Partial<Record<string, number>>> = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
};

export interface DevinDiscoveredModels {
  models: ProviderModelConfig[];
  routes: Map<string, DevinRoute>;
}

export interface DiscoverDevinModelsOptions {
  /** Codeium session token carried inside protobuf `Metadata.apiKey`. */
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

/**
 * Fetch and normalize the account's Cascade roster.
 *
 * Returns `null` on any request/decode failure or when the response carries no
 * usable model, so callers keep their existing roster instead of publishing an
 * empty one: the backend gates the catalog on the pinned client identity and
 * answers an unusable response without an explicit error.
 */
export async function discoverDevinModels(
  options: DiscoverDevinModelsOptions = {},
): Promise<DevinDiscoveredModels | null> {
  const timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  const baseUrl = (options.baseUrl ?? DEVIN_API_BASE_URL).replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const fetchImpl = options.fetch ?? fetch;

  try {
    const request = create(GetCliModelConfigsRequestSchema, {
      metadata: create(MetadataSchema, devinDiscoveryMetadata(options.apiKey)),
    });
    const response = await fetchImpl(`${baseUrl}${GET_CLI_MODEL_CONFIGS_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/proto",
        "connect-protocol-version": "1",
        accept: "*/*",
      },
      body: toBinary(GetCliModelConfigsRequestSchema, request),
      signal,
    });
    if (!response.ok) return null;
    const payload = new Uint8Array(await response.arrayBuffer());
    const decoded = decodeUnaryMessage(GetCliModelConfigsResponseSchema, payload);
    if (!decoded) return null;
    const discovered = normalizeDevinModels(decoded.clientModelConfigs, baseUrl);
    return discovered.models.length > 0 ? discovered : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `Metadata` for the dev-channel `GetCliModelConfigs` call: the native client
 * announces itself as `chisel` on its dev channel, and that identity — not the
 * released `devin-cli` chat identity — unlocks the full native config set.
 */
function devinDiscoveryMetadata(apiKey: string | undefined): Metadata {
  return create(MetadataSchema, {
    apiKey: apiKey ? (apiKey.startsWith("devin-session-token$") ? apiKey : `devin-session-token$${apiKey}`) : "",
    ideName: "chisel",
    ideVersion: "0.0.0-dev",
    extensionName: "chisel",
    extensionVersion: "0.0.0-dev",
    // Without the advertised display slots the server trims the catalog to the
    // plain lanes and withholds the router entries.
    supportedModelDisplays: [...SUPPORTED_MODEL_DISPLAYS],
    locale: "en",
    os: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux",
  });
}

/** Decode a unary Connect response, tolerating a gzipped body. */
function decodeUnaryMessage<T extends ProtoMessage>(schema: MessageCodec<T>, payload: Uint8Array): T | null {
  try {
    return fromBinary(schema, payload);
  } catch {
    try {
      return fromBinary(schema, gunzipSync(payload));
    } catch {
      return null;
    }
  }
}

/** One server-declared family lane, before it becomes a pi model. */
interface DevinLane {
  id: string;
  name: string;
  members: string[];
  defaultMember?: string;
  byEffort: Partial<Record<DevinThinkingLevel, string>>;
  /** First member config, used for lane-level pricing and presentation. */
  lead: ClientModelConfig;
}

export function normalizeDevinModels(
  configs: readonly ClientModelConfig[],
  baseUrl = DEVIN_API_BASE_URL,
): DevinDiscoveredModels {
  const routes = new Map<string, DevinRoute>();
  // Every config starts as its own model; a lane that declares an effort ladder
  // later replaces its members with one collapsed model.
  const standalone = new Map<string, ProviderModelConfig>();
  const lanes = new Map<string, DevinLane>();
  const configsByUid = new Map<string, ClientModelConfig>();
  const seen = new Set<string>();

  for (const config of configs) {
    if (config.disabled) continue;
    const display = config.modelInfo?.displayOption ?? DisplayOption.UNSPECIFIED;
    if (INTERNAL_MODEL_DISPLAYS.has(display)) continue;
    const uid = config.modelUid.trim();
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    configsByUid.set(uid, config);
    if (display === DisplayOption.MODEL_ROUTER || config.modelInfo?.isModelRouter === true) {
      // A router is a server-side dispatcher, not an effort tier: it stays a
      // standalone model even when upstream files it under a family.
      standalone.set(uid, standaloneModel(config, uid, baseUrl));
      routes.set(uid, { uid, byEffort: {}, router: true });
      continue;
    }
    standalone.set(uid, standaloneModel(config, uid, baseUrl));
    routes.set(uid, { uid, byEffort: {}, router: false });
    collectLane(lanes, config, uid);
  }

  for (const lane of lanes.values()) {
    const members = lane.defaultMember
      ? [lane.defaultMember, ...lane.members.filter((uid) => uid !== lane.defaultMember)]
      : lane.members;
    const memberConfigs = members.map((uid) => configsByUid.get(uid)).filter((c): c is ClientModelConfig => !!c);
    const levels = THINKING_LEVELS.filter((level) => lane.byEffort[level] !== undefined);
    // A lane with no effort route has nothing to route: its members stay
    // standalone rather than collapsing into a model whose levels are all
    // unsupported.
    if (levels.length === 0) continue;
    const uid = members[0] ?? lane.id;
    for (const member of members) {
      standalone.delete(member);
      routes.delete(member);
    }
    standalone.set(lane.id, {
      id: lane.id,
      name: lane.name,
      api: "devin-agent",
      baseUrl,
      reasoning: true,
      thinkingLevelMap: thinkingLevelMap(lane.byEffort),
      input: memberConfigs.every((config) => laneSupportsImages(config)) ? ["text", "image"] : ["text"],
      cost: devinModelCost(lane.lead),
      contextWindow: Math.max(...memberConfigs.map((config) => config.maxTokens), DEFAULT_CONTEXT_WINDOW),
      maxTokens: Math.max(
        ...memberConfigs.map((config) => config.modelInfo?.maxOutputTokens ?? 0),
        DEFAULT_MAX_TOKENS,
      ),
    });
    routes.set(lane.id, { uid, byEffort: { ...lane.byEffort }, router: false });
  }

  const models = [...standalone.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { models, routes };
}

/** `undefined` marks a level the ladder does not serve; supported levels keep their name. */
function thinkingLevelMap(
  byEffort: Partial<Record<DevinThinkingLevel, string>>,
): ProviderModelConfig["thinkingLevelMap"] {
  const map: Record<string, string | null> = {};
  for (const level of THINKING_LEVELS) {
    map[level] = byEffort[level] !== undefined ? level : null;
  }
  return map;
}

/** File `config` under its server-declared family lane. */
function collectLane(lanes: Map<string, DevinLane>, config: ClientModelConfig, uid: string): void {
  const metadata = config.modelFamilyMetadata;
  if (!metadata) return;
  const label = metadata.modelFamilyLabel.trim();
  if (!label) return;

  let effort: DevinThinkingLevel | undefined;
  let thinking: boolean | undefined;
  let fast = false;
  let oneMillionContext = false;
  for (const entry of metadata.entries) {
    const value = entry.value;
    if (!value) continue;
    // Keys collapse punctuation to spaces ("Reasoning Effort" -> "reasoning
    // effort"); effort names drop it entirely ("X High" and "XHigh" -> "xhigh").
    const key = entry.key.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (key === FAMILY_FAST_KEY) {
      fast = value.order === FAMILY_FAST_ORDER;
      continue;
    }
    if (key === FAMILY_THINKING_KEY) {
      thinking = value.order === FAMILY_THINKING_ORDER;
      continue;
    }
    if (key === FAMILY_CONTEXT_1M_KEY) {
      oneMillionContext = value.order === FAMILY_CONTEXT_1M_ORDER;
      continue;
    }
    if (FAMILY_EFFORT_KEYS[key]) {
      effort = FAMILY_EFFORT_BY_NAME[value.name.toLowerCase().replace(/[^a-z0-9]+/g, "")];
    }
  }
  // Claude's paired non-thinking and thinking configs share one effort label;
  // its explicit thinking axis decides whether the route is off.
  if (thinking === false) effort = "off";

  const baseId = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!baseId) return;
  const laneId = `${baseId}${oneMillionContext ? "-1m" : ""}${fast ? "-fast" : ""}`;
  let lane = lanes.get(laneId);
  if (!lane) {
    lane = {
      id: laneId,
      name: `${label}${oneMillionContext ? " 1M" : ""}${fast ? " Fast" : ""}`,
      members: [],
      byEffort: {},
      lead: config,
    };
    lanes.set(laneId, lane);
  }
  lane.members.push(uid);
  if (!lane.defaultMember && (config.isDefaultModelInFamily || metadata.isDefaultModelInFamily)) {
    lane.defaultMember = uid;
  }
  if (effort !== undefined && lane.byEffort[effort] === undefined) lane.byEffort[effort] = uid;
}

/** A config that is not part of an effort ladder, surfaced under its own wire uid. */
function standaloneModel(config: ClientModelConfig, uid: string, baseUrl: string): ProviderModelConfig {
  const maxOutput = config.modelInfo?.maxOutputTokens ?? 0;
  return {
    id: uid,
    name: config.label.trim() || uid,
    api: "devin-agent",
    baseUrl,
    reasoning: supportsDevinThinking(config),
    input: laneSupportsImages(config) ? ["text", "image"] : ["text"],
    cost: devinModelCost(config),
    contextWindow: config.maxTokens > 0 ? config.maxTokens : DEFAULT_CONTEXT_WINDOW,
    maxTokens: maxOutput > 0 ? maxOutput : DEFAULT_MAX_TOKENS,
  };
}

/** Server features are authoritative; the label heuristic covers configs without them. */
function supportsDevinThinking(config: ClientModelConfig): boolean {
  const features = config.modelInfo?.modelFeatures;
  if (features) return features.supportsThinking;
  if (NO_REASONING_LABEL_PATTERN.test(config.label)) return false;
  return REASONING_LABEL_PATTERN.test(config.label);
}

function laneSupportsImages(config: ClientModelConfig): boolean {
  const features = config.modelInfo?.modelFeatures;
  const declared = features ? features.supportsImages : config.supportsImages;
  return declared && !IMAGE_BLIND_UIDS.has(config.modelUid.trim());
}

function costDenominatorTokens(denominator: string): number {
  const match = COST_DENOMINATOR_PATTERN.exec(denominator);
  if (!match) return 1_000_000;
  const suffix = match[2];
  const scale = suffix ? (COST_DENOMINATOR_SCALE[suffix.toLowerCase()] ?? 1) : 1;
  const tokens = Number(match[1]) * scale;
  return tokens > 0 ? tokens : 1_000_000;
}

/**
 * Per-million-token rates from the config's cost dimensions. `COST_FUZZY` marks
 * an estimated rate rather than a different unit, so both kinds are read. There
 * is no cache-write dimension — Devin bills cache writes at the input rate — so
 * that rate stays 0.
 */
function devinModelCost(config: ClientModelConfig): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const dimension of config.modelDimensions) {
    if (dimension.kind !== ModelDimensionKind.COST && dimension.kind !== ModelDimensionKind.COST_FUZZY) continue;
    // Values arrive as protobuf floats: round float32 noise (0.1 arrives as
    // 0.10000000149011612) at sub-cent precision.
    const perMillion =
      Math.round(((dimension.value * 1_000_000) / costDenominatorTokens(dimension.denominator)) * 1e6) / 1e6;
    switch (dimension.label.trim().toLowerCase()) {
      case COST_LABEL_INPUT:
        cost.input = perMillion;
        break;
      case COST_LABEL_CACHE_READ:
        cost.cacheRead = perMillion;
        break;
      case COST_LABEL_OUTPUT:
        cost.output = perMillion;
        break;
      default:
        break;
    }
  }
  return cost;
}
