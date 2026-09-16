import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
  DEVIN_AUTHORIZE_URL,
  DEVIN_CALLBACK_PORT_ENV,
  DEVIN_EXPIRY_SKEW_MS,
  DEVIN_TOKEN_FALLBACK_TTL_MS,
  DEVIN_TOKEN_URL,
  devinApiKeyFromCredential,
  devinTokenExpiry,
  generateDevinPkce,
  loginDevin,
  parseDevinAuthorizationInput,
  refreshDevinToken,
} from "../src/providers/devin-auth.ts";
import {
  DEVIN_PROVIDER_ID,
  formatDevinStatus,
  readDevinCredential,
  registerDevinProvider,
} from "../src/providers/devin-provider.ts";
import { streamDevin } from "../src/providers/devin/transport.ts";

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

/** Intercepts only the Devin token endpoint; the loopback callback still uses real fetch. */
function stubDevinTokenFetch(token: string): { requests: CapturedRequest[]; restore(): void } {
  const previous = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== DEVIN_TOKEN_URL) return previous(input, init);
    requests.push({ url, init });
    return new Response(JSON.stringify({ token }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { requests, restore: () => { globalThis.fetch = previous; } };
}

function fakeJwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds }), "utf8").toString("base64url");
  return `header.${payload}.signature`;
}

function callbackCallbacks(onAuth: (url: string) => void, onManualCodeInput?: () => Promise<string>) {
  return {
    onAuth: (info: { url: string }) => onAuth(info.url),
    onDeviceCode: () => {},
    onPrompt: async () => "",
    onSelect: async () => undefined,
    ...(onManualCodeInput ? { onManualCodeInput } : {}),
  };
}

async function withCallbackPortEnv<T>(value: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env[DEVIN_CALLBACK_PORT_ENV];
  process.env[DEVIN_CALLBACK_PORT_ENV] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[DEVIN_CALLBACK_PORT_ENV];
    else process.env[DEVIN_CALLBACK_PORT_ENV] = previous;
  }
}

test("generateDevinPkce derives an S256 challenge from a 32-byte verifier", () => {
  const { verifier, challenge } = generateDevinPkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, createHash("sha256").update(verifier, "utf8").digest("base64url"));
  assert.notEqual(challenge, verifier);
});

test("parseDevinAuthorizationInput accepts redirect URL, fragment, query, and bare code", () => {
  assert.deepEqual(
    parseDevinAuthorizationInput("http://127.0.0.1:59653/callback?code=abc&state=xyz"),
    { code: "abc", state: "xyz" },
  );
  assert.deepEqual(parseDevinAuthorizationInput("abc#xyz"), { code: "abc", state: "xyz" });
  assert.deepEqual(parseDevinAuthorizationInput("code=abc&state=xyz"), { code: "abc", state: "xyz" });
  assert.deepEqual(parseDevinAuthorizationInput("abc"), { code: "abc" });
  assert.deepEqual(parseDevinAuthorizationInput("   "), {});
  assert.deepEqual(
    parseDevinAuthorizationInput("http://127.0.0.1:59653/callback?error=access_denied&error_description=Denied"),
    { error: "Denied" },
  );
});

test("devinTokenExpiry projects the JWT exp minus skew, else one year out", () => {
  const expSeconds = Math.floor(Date.now() / 1000) + 3_600;
  assert.equal(devinTokenExpiry(fakeJwt(expSeconds)), expSeconds * 1000 - DEVIN_EXPIRY_SKEW_MS);

  const now = 1_700_000_000_000;
  assert.equal(devinTokenExpiry("opaque-session-token", now), now + DEVIN_TOKEN_FALLBACK_TTL_MS);
  assert.equal(devinTokenExpiry("header.not-base64-json.sig", now), now + DEVIN_TOKEN_FALLBACK_TTL_MS);
});

test("loginDevin exchanges a pasted code for a session token", async () => {
  const expSeconds = Math.floor(Date.now() / 1000) + 7_200;
  const token = fakeJwt(expSeconds);
  const stub = stubDevinTokenFetch(token);
  let authUrl = "";
  try {
    const credentials = await loginDevin(callbackCallbacks(
      (url) => { authUrl = url; },
      async () => `callback-code#${new URL(authUrl).searchParams.get("state") ?? ""}`,
    ));

    const authorize = new URL(authUrl);
    assert.equal(`${authorize.origin}${authorize.pathname}`, DEVIN_AUTHORIZE_URL);
    assert.equal(authorize.searchParams.get("response_type"), "code");
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorize.searchParams.get("prompt"), "select_account");
    assert.match(authorize.searchParams.get("state") ?? "", /^[0-9a-f-]{36}$/);
    assert.match(authorize.searchParams.get("redirect_uri") ?? "", /^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    assert.equal(stub.requests.length, 1);
    const [exchange] = stub.requests;
    assert.equal(exchange?.url, DEVIN_TOKEN_URL);
    assert.equal(exchange?.init?.method, "POST");
    assert.deepEqual(exchange?.init?.headers, {
      Accept: "application/json",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(exchange?.init?.body)) as { code: string; code_verifier: string };
    assert.equal(body.code, "callback-code");
    assert.equal(
      authorize.searchParams.get("code_challenge"),
      createHash("sha256").update(body.code_verifier, "utf8").digest("base64url"),
    );

    assert.deepEqual(credentials, {
      access: token,
      refresh: token,
      expires: expSeconds * 1000 - DEVIN_EXPIRY_SKEW_MS,
    });
  } finally {
    stub.restore();
  }
});

test("loginDevin completes through its loopback callback and rejects a foreign state", async () => {
  await withCallbackPortEnv("0", async () => {
    const token = fakeJwt(Math.floor(Date.now() / 1000) + 7_200);
    const stub = stubDevinTokenFetch(token);
    let resolveAuth: (url: string) => void = () => {};
    const authReady = new Promise<string>((resolve) => { resolveAuth = resolve; });
    const login = loginDevin(callbackCallbacks((url) => resolveAuth(url))).catch((error: unknown) => error);
    try {
      const authorize = new URL(await authReady);
      const redirectUri = authorize.searchParams.get("redirect_uri") ?? "";
      const state = authorize.searchParams.get("state") ?? "";

      const foreign = await fetch(`${redirectUri}?code=stolen&state=not-this-state`);
      assert.equal(foreign.status, 400);
      assert.match(await foreign.text(), /state did not match/);

      const callback = await fetch(`${redirectUri}?code=devin-code&state=${state}`);
      assert.equal(callback.status, 200);
      assert.match(await callback.text(), /sign-in complete/);

      const credentials = await login;
      assert.deepEqual(credentials, {
        access: token,
        refresh: token,
        expires: devinTokenExpiry(token),
      });
      const body = JSON.parse(String(stub.requests[0]?.init?.body)) as { code: string };
      assert.equal(body.code, "devin-code");
    } finally {
      stub.restore();
    }
  });
});

test("loginDevin surfaces a callback error without exchanging a token", async () => {
  await withCallbackPortEnv("0", async () => {
    const stub = stubDevinTokenFetch("unused");
    let resolveAuth: (url: string) => void = () => {};
    const authReady = new Promise<string>((resolve) => { resolveAuth = resolve; });
    const login = loginDevin(callbackCallbacks((url) => resolveAuth(url))).catch((error: unknown) => error);
    try {
      const authorize = new URL(await authReady);
      const redirectUri = authorize.searchParams.get("redirect_uri") ?? "";
      const state = authorize.searchParams.get("state") ?? "";

      // A forged error callback without this attempt's state must not end it.
      const forged = await fetch(`${redirectUri}?error=access_denied`);
      assert.equal(forged.status, 400);

      const response = await fetch(`${redirectUri}?error=access_denied&error_description=Denied%20by%20user&state=${state}`);
      assert.equal(response.status, 400);

      const failure = await login;
      assert.ok(failure instanceof Error);
      assert.match(failure.message, /Devin sign-in failed: Denied by user/);
      assert.equal(stub.requests.length, 0);
    } finally {
      stub.restore();
    }
  });
});

test("loginDevin reports a failure pasted as a redirect URL", async () => {
  const stub = stubDevinTokenFetch("unused");
  try {
    const failure = await loginDevin(callbackCallbacks(
      () => {},
      async () => "http://127.0.0.1:59653/callback?error=access_denied&error_description=Denied%20by%20user",
    )).catch((error: unknown) => error);
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /Devin sign-in failed: Denied by user/);
    assert.equal(stub.requests.length, 0);
  } finally {
    stub.restore();
  }
});

test("refreshDevinToken rejects because Devin issues no refresh token", async () => {
  await assert.rejects(refreshDevinToken(), /cannot be refreshed; run \/login devin/);
});

test("devinApiKeyFromCredential uses the stored access token", () => {
  assert.equal(devinApiKeyFromCredential({ access: "session-token", refresh: "session-token", expires: 1 }), "session-token");
});

test("formatDevinStatus renders credential expiry deterministically", () => {
  const signedIn = formatDevinStatus(
    { configured: true, source: "stored" },
    { type: "oauth", expires: Date.UTC(2027, 0, 2, 3, 4) },
    "en",
  );
  assert.match(signedIn, /credential source: stored/);
  assert.match(signedIn, /2027-01-02 03:04 UTC/);
  assert.match(formatDevinStatus({ configured: true }, { type: "oauth" }, "en"), /expiry is not recorded/);
  assert.match(formatDevinStatus({ configured: false }, undefined, "en"), /not signed in/);
  assert.match(formatDevinStatus({ configured: false }, undefined, "zh-CN"), /未登录/);
});

test("readDevinCredential projects only a stored Devin entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-auth-"));
  const authPath = join(dir, "auth.json");
  try {
    writeFileSync(authPath, JSON.stringify({
      devin: { type: "oauth", access: "secret", refresh: "secret", expires: 1_234 },
      other: { type: "api_key", key: "x" },
    }));
    assert.deepEqual(readDevinCredential(authPath), { type: "oauth", expires: 1_234 });

    writeFileSync(authPath, JSON.stringify({ other: { type: "api_key", key: "x" } }));
    assert.equal(readDevinCredential(authPath), undefined);

    writeFileSync(authPath, "{ not json");
    assert.equal(readDevinCredential(authPath), undefined);

    assert.equal(readDevinCredential(join(dir, "missing.json")), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function captureRegistrations(): {
  pi: ExtensionAPI;
  providers: Array<{ name: string; config: Record<string, unknown> }>;
  commands: Array<{ name: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void }>;
} {
  const providers: Array<{ name: string; config: Record<string, unknown> }> = [];
  const commands: Array<{ name: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void }> = [];
  const pi = {
    registerProvider: (name: string, config: Record<string, unknown>) => { providers.push({ name, config }); },
    registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void }) => {
      commands.push({ name, handler: options.handler });
    },
  } as unknown as ExtensionAPI;
  return { pi, providers, commands };
}

test("registerDevinProvider registers the Devin OAuth provider and its transport", () => {
  const { pi, providers, commands } = captureRegistrations();
  registerDevinProvider(pi);

  assert.equal(providers.length, 1);
  const provider = providers[0];
  assert.equal(provider?.name, DEVIN_PROVIDER_ID);
  assert.equal(provider?.config.name, "Devin");
  assert.equal(provider?.config.baseUrl, "https://server.codeium.com");
  assert.equal(provider?.config.apiKey, undefined);

  // The transport ships with the provider: without api + streamSimple the
  // registered models would be selectable and then fail on the first request.
  assert.equal(provider?.config.api, "devin-agent");
  assert.equal(provider?.config.streamSimple, streamDevin);
  const models = provider?.config.models as Array<Record<string, unknown>>;
  assert.deepEqual(models.map((model) => model.id), ["swe-2"]);
  for (const model of models) {
    assert.equal(model.api, "devin-agent");
    assert.equal(model.reasoning, true);
    assert.deepEqual(model.input, ["text", "image"]);
    assert.equal(model.contextWindow, 262_000);
    assert.equal(model.maxTokens, 128_000);
  }

  const oauth = provider?.config.oauth as {
    name: string;
    isSubscription?: boolean;
    login: unknown;
    refreshToken: unknown;
    getApiKey: (credential: { access: string }) => string;
  };
  assert.equal(oauth.name, "Devin");
  assert.equal(oauth.isSubscription, true);
  assert.equal(oauth.login, loginDevin);
  assert.equal(oauth.refreshToken, refreshDevinToken);
  assert.equal(oauth.getApiKey({ access: "session-token" }), "session-token");

  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.name, "devin");
});

test("/devin reports status, sign-in guidance, and usage", async () => {
  const { pi, commands } = captureRegistrations();
  registerDevinProvider(pi);
  const handler = commands[0]?.handler;
  assert.ok(handler);

  const notifications: Array<{ message: string; level: string | undefined }> = [];
  const ctx = {
    modelRegistry: { getProviderAuthStatus: () => ({ configured: false }) },
    ui: { notify: (message: string, level?: string) => { notifications.push({ message, level }); } },
  } as unknown as ExtensionCommandContext;

  await handler("", ctx);
  assert.match(notifications.at(-1)?.message ?? "", /not signed in|未登录/);

  await handler("login", ctx);
  assert.match(notifications.at(-1)?.message ?? "", /\/login devin/);

  await handler("logout", ctx);
  assert.match(notifications.at(-1)?.message ?? "", /\/logout devin/);

  await handler("bogus", ctx);
  assert.equal(notifications.at(-1)?.level, "warning");
});

// pi-coding-agent's exports map blocks deep subpath specifiers, and npm may
// hoist the package to the workspace root or this package's node_modules, so
// the dist directory is resolved from the public ESM entry.
const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { AuthStorage } = await import(pathToFileURL(join(piDist, "core/auth-storage.js")).href);
const { ModelRegistry } = await import(pathToFileURL(join(piDist, "core/model-registry.js")).href);
const { ModelRuntime } = await import(pathToFileURL(join(piDist, "core/model-runtime.js")).href);

test("pi composes the Devin registration into an OAuth login method", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-provider-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const modelsPath = join(dir, "models.json");
  writeFileSync(modelsPath, JSON.stringify({ providers: {} }));

  const registry = new ModelRegistry(await ModelRuntime.create({
    credentials: AuthStorage.inMemory({}),
    modelsPath,
  }));
  registerDevinProvider({
    registerProvider(name: string, config: unknown) {
      registry.registerProvider(name, config as never);
    },
  } as unknown as ExtensionAPI);

  const provider = registry.getProvider(DEVIN_PROVIDER_ID);
  assert.ok(provider, "the devin provider must be composed into the registry");
  assert.equal(provider.name, "Devin");
  assert.equal(provider.baseUrl, "https://server.codeium.com");

  // The seeded roster must survive pi's composer with its api, limits and
  // capabilities intact, or the models would reach the wire shape-less.
  const models = provider.getModels();
  assert.deepEqual(models.map((model) => model.id), ["swe-2"]);
  for (const model of models) {
    assert.equal(model.api, "devin-agent");
    assert.equal(model.provider, DEVIN_PROVIDER_ID);
    assert.equal(model.baseUrl, "https://server.codeium.com");
    assert.equal(model.reasoning, true);
    assert.equal(model.contextWindow, 262_000);
    assert.equal(model.maxTokens, 128_000);
  }
  assert.equal(registry.find(DEVIN_PROVIDER_ID, "swe-2")?.name, "SWE-2");

  // /login lists providers by auth method; Devin must offer the subscription
  // method only, with no fabricated API-key entry.
  const oauth = provider.auth.oauth as {
    name: string;
    isSubscription?: boolean;
    toAuth: (credential: Record<string, unknown>) => Promise<{ apiKey?: string }>;
  };
  assert.ok(oauth, "the devin provider must expose an OAuth auth method");
  assert.equal(oauth.name, "Devin");
  assert.equal(oauth.isSubscription, true);
  assert.equal(provider.auth.apiKey, undefined);
  assert.equal(
    (await oauth.toAuth({ type: "oauth", access: "session-token", refresh: "session-token", expires: 1 })).apiKey,
    "session-token",
  );
  assert.equal(registry.getProviderAuthStatus(DEVIN_PROVIDER_ID).configured, false);
});

// The wiring is textual because the extension entry point owns the session
// lifecycle; this guards against the registration being dropped, mirroring
// test/settings-provider-wiring.test.ts.
test("the extension entry point constructs the Devin registration", () => {
  const source = readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf-8");
  assert.match(source, /registerDevinProvider\(pi\)/);
});
