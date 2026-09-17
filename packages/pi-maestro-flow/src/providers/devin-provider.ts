/**
 * Devin account login and Cascade transport for pi.
 *
 * Registers the `devin` provider through Pi's extension OAuth contract, so the
 * sign-in flow, credential storage, and sign-out stay owned by Pi's own
 * `/login` and `/logout` commands, and binds the provider to the plugin's
 * Cascade transport (protobuf Connect — an API Pi's built-ins do not implement).
 * The static seed keeps a signed-out install usable; once a credential exists,
 * pi's model refresh replaces it with the account's own discovered roster.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";

import { getTuiLocale } from "../tui/locale.ts";
import {
  devinApiKeyFromCredential,
  loginDevin,
  refreshDevinToken,
} from "./devin-auth.ts";
import { discoverDevinModels } from "./devin/discovery.ts";
import { DEVIN_MODEL_ALLOWLIST, DEVIN_MODELS, DEVIN_SEED_ROUTES } from "./devin/models.ts";
import { registerDevinRoutes } from "./devin/routing.ts";
import { DEVIN_API, DEVIN_API_BASE_URL, streamDevin } from "./devin/transport.ts";

export const DEVIN_PROVIDER_ID = "devin";
export const DEVIN_PROVIDER_NAME = "Devin";
export const DEVIN_COMMAND_NAME = "devin";
/** Codeium Cascade host the Devin CLI talks to once signed in. */
export { DEVIN_API_BASE_URL } from "./devin/transport.ts";

const CATALOGS = {
  en: {
    "command.description": "Sign in to a Devin account (status | login | logout)",
    "status.signedIn": "Devin account: signed in (credential source: {source}).{expiry}",
    "status.expiry": " Session token expires {time}.",
    "status.expiryUnknown": " Session token expiry is not recorded.",
    "status.signedOut": "Devin account: not signed in. Run /login devin to sign in.",
    "login.guidance": "Run /login devin to open the Devin sign-in flow in your browser.",
    "logout.guidance": "Run /logout devin to remove the stored Devin credential.",
    "usage": "Usage: /devin [status|login|logout]",
  },
  "zh-CN": {
    "command.description": "Devin 账号登录（status | login | logout）",
    "status.signedIn": "Devin 账号：已登录（凭据来源：{source}）。{expiry}",
    "status.expiry": "会话令牌到期时间 {time}。",
    "status.expiryUnknown": "未记录会话令牌到期时间。",
    "status.signedOut": "Devin 账号：未登录。运行 /login devin 登录。",
    "login.guidance": "运行 /login devin，在浏览器中完成 Devin 登录。",
    "logout.guidance": "运行 /logout devin 删除已保存的 Devin 凭据。",
    "usage": "用法：/devin [status|login|logout]",
  },
} as const;

type CatalogKey = keyof (typeof CATALOGS)["en"];

function t(key: CatalogKey, locale: SupportedSettingsLocale, vars?: Readonly<Record<string, string>>): string {
  const catalog = CATALOGS[locale] ?? CATALOGS.en;
  const template: string = catalog[key] ?? CATALOGS.en[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match);
}

export interface DevinCredentialView {
  type: "oauth" | "api_key";
  /** Absolute expiry in epoch milliseconds, when the credential records one. */
  expires?: number;
}

/**
 * Read-only projection of the stored Devin credential. Pi owns auth.json, so
 * this never writes; an absent or unreadable entry simply reports nothing.
 */
export function readDevinCredential(
  authPath = join(getAgentDir(), "auth.json"),
): DevinCredentialView | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(authPath, "utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const entry = (parsed as Record<string, unknown>)[DEVIN_PROVIDER_ID];
    if (!entry || typeof entry !== "object") return undefined;
    const record = entry as { type?: unknown; expires?: unknown };
    if (record.type !== "oauth" && record.type !== "api_key") return undefined;
    const expires = typeof record.expires === "number" && Number.isFinite(record.expires)
      ? record.expires
      : undefined;
    return { type: record.type, ...(expires === undefined ? {} : { expires }) };
  } catch {
    return undefined;
  }
}

export function formatDevinStatus(
  status: { configured: boolean; source?: string },
  credential: DevinCredentialView | undefined,
  locale: SupportedSettingsLocale = getTuiLocale(),
): string {
  if (!status.configured) return t("status.signedOut", locale);
  const expiry = credential?.expires === undefined
    ? t("status.expiryUnknown", locale)
    : t("status.expiry", locale, { time: formatUtcMinute(credential.expires) });
  return t("status.signedIn", locale, { source: status.source ?? "stored", expiry });
}

/** Locale-independent expiry rendering, so status text is reproducible. */
function formatUtcMinute(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * pi's model refresh hook: the Cascade roster is credential-scoped, so the
 * account's own lanes and effort ladders replace the seed whenever discovery
 * succeeds. The roster is trimmed to DEVIN_MODEL_ALLOWLIST before publishing —
 * the raw catalog is hundreds of lanes and would flood the model picker. Every
 * failure path returns the previous roster — the persisted catalog when
 * offline, else the static seed — because publishing an empty list would
 * silently strip Devin out of the model picker.
 */
export async function refreshDevinModels(
  context: RefreshModelsContext,
  options: { baseUrl?: string } = {},
): Promise<ProviderModelConfig[]> {
  const stored = context.stored?.models as ProviderModelConfig[] | undefined;
  if (!context.allowNetwork) return stored ?? [...DEVIN_MODELS];
  const credential = context.credential;
  const apiKey = credential?.type === "oauth" ? credential.access : undefined;
  if (!apiKey) return stored ?? [...DEVIN_MODELS];

  const discovered = await discoverDevinModels({
    apiKey,
    signal: context.signal,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  });
  if (!discovered) return stored ?? [...DEVIN_MODELS];
  const models = discovered.models.filter((model) => DEVIN_MODEL_ALLOWLIST.has(model.id));
  if (models.length === 0) return stored ?? [...DEVIN_MODELS];
  const routes = new Map([...discovered.routes].filter(([id]) => DEVIN_MODEL_ALLOWLIST.has(id)));
  registerDevinRoutes(routes);
  // Persist so the discovered roster survives an offline start; ``checkedAt``
  // records when the server last confirmed it.
  await context.publish({
    persist: {
      models: models.map((model) => ({
        ...model,
        api: model.api ?? DEVIN_API,
        provider: DEVIN_PROVIDER_ID,
        baseUrl: model.baseUrl ?? DEVIN_API_BASE_URL,
      })),
      checkedAt: Date.now(),
    },
  });
  return [...models];
}

export function registerDevinProvider(pi: ExtensionAPI): void {
  // The offline roster needs its wire uids too: discovery replaces this table
  // whenever it succeeds.
  registerDevinRoutes(DEVIN_SEED_ROUTES);
  if (typeof pi.registerProvider === "function") {
    pi.registerProvider(DEVIN_PROVIDER_ID, {
      name: DEVIN_PROVIDER_NAME,
      baseUrl: DEVIN_API_BASE_URL,
      api: DEVIN_API,
      streamSimple: streamDevin,
      models: [...DEVIN_MODELS],
      refreshModels: refreshDevinModels,
      oauth: {
        name: DEVIN_PROVIDER_NAME,
        isSubscription: true,
        login: loginDevin,
        refreshToken: refreshDevinToken,
        getApiKey: devinApiKeyFromCredential,
      },
    });
  }
  if (typeof pi.registerCommand !== "function") return;
  pi.registerCommand(DEVIN_COMMAND_NAME, {
    description: t("command.description", getTuiLocale()),
    async handler(args, ctx) {
      handleDevinCommand(args, ctx);
    },
  });
}

function handleDevinCommand(args: string, ctx: ExtensionCommandContext): void {
  const action = args.trim().toLowerCase();
  const locale = getTuiLocale();
  if (action === "" || action === "status") {
    const status = ctx.modelRegistry.getProviderAuthStatus(DEVIN_PROVIDER_ID);
    ctx.ui.notify(formatDevinStatus(status, readDevinCredential(), locale), "info");
    return;
  }
  if (action === "login") {
    ctx.ui.notify(t("login.guidance", locale), "info");
    return;
  }
  if (action === "logout") {
    ctx.ui.notify(t("logout.guidance", locale), "info");
    return;
  }
  ctx.ui.notify(t("usage", locale), "warning");
}
