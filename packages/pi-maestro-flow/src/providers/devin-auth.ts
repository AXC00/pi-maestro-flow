/**
 * Devin CLI account login: authorization code + PKCE.
 *
 * The flow is the one the Devin CLI itself drives (encoded as oh-my-pi's
 * `auth "devin"` rule): the browser is sent to app.devin.ai/auth/cli/continue,
 * the loopback callback at 127.0.0.1:59653/callback — or a pasted redirect URL
 * / authorization code — supplies the code, and api.devin.ai/auth/cli/token
 * exchanges it (JSON body carrying the PKCE verifier) for a Devin session
 * token. Devin issues no refresh token, so the stored credential expires with
 * the JWT that token carries.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

export const DEVIN_AUTHORIZE_URL = "https://app.devin.ai/auth/cli/continue";
export const DEVIN_TOKEN_URL = "https://api.devin.ai/auth/cli/token";
export const DEVIN_CALLBACK_HOST = "127.0.0.1";
export const DEVIN_CALLBACK_PORT = 59_653;
export const DEVIN_CALLBACK_PATH = "/callback";
/** Callback overrides, mirroring pi's own `PI_OAUTH_CALLBACK_HOST`. */
export const DEVIN_CALLBACK_HOST_ENV = "PI_DEVIN_OAUTH_CALLBACK_HOST";
export const DEVIN_CALLBACK_PORT_ENV = "PI_DEVIN_OAUTH_CALLBACK_PORT";
/** Skew subtracted from the token's JWT `exp`, as the CLI projects it. */
export const DEVIN_EXPIRY_SKEW_MS = 300_000;
/** Lifetime applied when the session token is not a decodable JWT (one year). */
export const DEVIN_TOKEN_FALLBACK_TTL_MS = 31_536_000_000;
export const DEVIN_LOGIN_INSTRUCTIONS =
  "Sign in to Devin in your browser. If the browser runs on another machine, paste the final redirect URL or code here.";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ERROR_DETAIL_CHARS = 512;
const HOST_PATTERN = /^[A-Za-z0-9.:[\]_-]+$/;

export interface DevinPkce {
  verifier: string;
  challenge: string;
}

/** PKCE verifier/challenge pair (S256), matching the CLI's 32-byte verifier. */
export function generateDevinPkce(): DevinPkce {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
  return { verifier, challenge };
}

export interface DevinAuthorizationInput {
  code?: string;
  state?: string;
  /** Failure Devin reported, when the pasted redirect carried no code. */
  error?: string;
}

/**
 * Accept the forms a Devin sign-in can hand back: the final redirect URL, a
 * `code#state` pair, a query fragment, or the bare authorization code.
 */
export function parseDevinAuthorizationInput(input: string): DevinAuthorizationInput {
  const value = input.trim();
  if (!value) return {};
  if (value.includes("://")) {
    try {
      const url = new URL(value);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const failure = url.searchParams.get("error_description") ?? url.searchParams.get("error");
      return {
        ...(code ? { code } : {}),
        ...(state ? { state } : {}),
        ...(!code && failure ? { error: failure } : {}),
      };
    } catch {
      // Not a usable URL; fall through to the code forms below.
    }
  }
  const fragment = value.indexOf("#");
  if (fragment >= 0) {
    const code = value.slice(0, fragment).trim();
    const state = value.slice(fragment + 1).trim();
    return { ...(code ? { code } : {}), ...(state ? { state } : {}) };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    const code = params.get("code");
    const state = params.get("state");
    return { ...(code ? { code } : {}), ...(state ? { state } : {}) };
  }
  return { code: value };
}

/** Credential expiry for a Devin session token: JWT `exp` minus skew, else one year out. */
export function devinTokenExpiry(token: string, now = Date.now()): number {
  const expSeconds = decodeJwtExpirySeconds(token);
  return expSeconds === undefined
    ? now + DEVIN_TOKEN_FALLBACK_TTL_MS
    : expSeconds * 1000 - DEVIN_EXPIRY_SKEW_MS;
}

function decodeJwtExpirySeconds(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const exp = (parsed as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : undefined;
  } catch {
    return undefined;
  }
}

export type DevinCallbackOutcome =
  | { kind: "code"; code: string; state: string }
  | { kind: "error"; message: string }
  | { kind: "cancelled" }
  | { kind: "timeout" };

export interface DevinCallbackServer {
  /** Loopback redirect URI advertised to Devin for this login attempt. */
  redirectUri: string;
  /**
   * First outcome of this attempt. Never rejects, so abandoning the wait
   * (manual paste or abort) cannot leak an unhandled rejection.
   */
  wait(): Promise<DevinCallbackOutcome>;
  cancelWait(): void;
  close(): Promise<void>;
}

export interface StartDevinCallbackServerOptions {
  host?: string;
  port?: number;
  /** Bind an OS-assigned port when the preferred one is taken. */
  allowPortFallback?: boolean;
}

/**
 * Loopback callback listener for one login attempt. Only a callback carrying
 * this attempt's `state` can end it: a forged request is answered with an
 * error page and ignored, and the attempt keeps waiting for its own callback.
 */
export async function startDevinCallbackServer(
  expectedState: string,
  options: StartDevinCallbackServerOptions = {},
): Promise<DevinCallbackServer> {
  const host = options.host ?? envHost() ?? DEVIN_CALLBACK_HOST;
  const preferredPort = options.port ?? envPort() ?? DEVIN_CALLBACK_PORT;
  const allowPortFallback = options.allowPortFallback !== false;

  let settle: ((outcome: DevinCallbackOutcome) => void) | undefined;
  let settled = false;
  const outcome = new Promise<DevinCallbackOutcome>((resolve) => {
    settle = resolve;
  });
  const finish = (value: DevinCallbackOutcome): void => {
    if (settled) return;
    settled = true;
    settle?.(value);
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (url.pathname !== DEVIN_CALLBACK_PATH) {
      respond(response, 404, callbackPage("Not found", "This route is not the Devin CLI callback."));
      return;
    }
    const state = url.searchParams.get("state");
    const failure = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    // Only this attempt's own callback may end it: any web page can reach the
    // loopback port, so a forged request must not cancel a live sign-in.
    const owned = state !== null && state === expectedState;
    if (failure) {
      const description = url.searchParams.get("error_description") ?? failure;
      respond(response, 400, callbackPage("Devin sign-in failed", description));
      if (owned) finish({ kind: "error", message: description });
      return;
    }
    if (!owned) {
      respond(response, 400, callbackPage("Devin sign-in failed", "The callback state did not match this sign-in attempt."));
      return;
    }
    if (!code) {
      respond(response, 400, callbackPage("Devin sign-in failed", "The callback carried no authorization code."));
      finish({ kind: "error", message: "The Devin callback carried no authorization code." });
      return;
    }
    respond(response, 200, callbackPage("Devin sign-in complete", "You can close this window and return to Pi."));
    finish({ kind: "code", code, state });
  });

  const port = await listen(server, host, preferredPort, allowPortFallback);
  server.unref();
  const timer = setTimeout(() => finish({ kind: "timeout" }), CALLBACK_TIMEOUT_MS);
  timer.unref();

  return {
    redirectUri: `http://${host}:${port}${DEVIN_CALLBACK_PATH}`,
    wait: () => outcome,
    cancelWait: () => finish({ kind: "cancelled" }),
    async close() {
      clearTimeout(timer);
      finish({ kind: "cancelled" });
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Exchange an authorization code for a Devin session token. */
export async function exchangeDevinAuthorizationCode(
  code: string,
  codeVerifier: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(DEVIN_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: codeVerifier }),
    signal,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Devin token exchange failed (HTTP ${response.status})${errorDetail(body)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Devin token exchange returned invalid JSON.");
  }
  const token = parsed && typeof parsed === "object" ? (parsed as { token?: unknown }).token : undefined;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Devin token exchange returned no session token.");
  }
  return token;
}

/** OAuth login entry point registered with Pi's provider contract. */
export async function loginDevin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const { verifier, challenge } = generateDevinPkce();
  const state = randomUUID();
  const server = await startDevinCallbackServer(state);

  let manualInput: string | undefined;
  let manualError: Error | undefined;
  const onAbort = (): void => server.cancelWait();
  callbacks.signal?.addEventListener("abort", onAbort, { once: true });
  if (callbacks.signal?.aborted) onAbort();

  try {
    const params = new URLSearchParams({
      response_type: "code",
      redirect_uri: server.redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      prompt: "select_account",
    });
    // Publish the sign-in URL before offering the paste prompt, so the code
    // prompt never appears without the link that produces the code.
    callbacks.onAuth({
      url: `${DEVIN_AUTHORIZE_URL}?${params.toString()}`,
      instructions: DEVIN_LOGIN_INSTRUCTIONS,
    });
    const manual = callbacks.onManualCodeInput?.().then(
      (input) => {
        manualInput = input;
        server.cancelWait();
      },
      (error: unknown) => {
        manualError = error instanceof Error ? error : new Error(String(error));
        server.cancelWait();
      },
    );

    const callback = await server.wait();
    if (callback.kind === "error") throw new Error(`Devin sign-in failed: ${callback.message}`);
    if (callback.kind === "timeout") {
      throw new Error("Devin sign-in timed out waiting for the browser callback; run /login devin again.");
    }

    let code = callback.kind === "code" ? callback.code : undefined;
    let returnedState = callback.kind === "code" ? callback.state : undefined;
    const applyManualInput = (): void => {
      if (!manualInput) return;
      const parsed = parseDevinAuthorizationInput(manualInput);
      if (parsed.error) throw new Error(`Devin sign-in failed: ${parsed.error}`);
      code = parsed.code;
      returnedState = parsed.state;
    };
    if (!code) applyManualInput();
    if (!code && manual) {
      await manual;
      if (manualError) throw manualError;
      applyManualInput();
    }
    if (!code) throw new Error("Devin sign-in did not return an authorization code.");
    if (returnedState && returnedState !== state) {
      throw new Error("Devin sign-in state mismatch; the authorization code was rejected.");
    }

    callbacks.onProgress?.("Exchanging the authorization code for a Devin session token…");
    const token = await exchangeDevinAuthorizationCode(code, verifier, callbacks.signal);
    return { access: token, refresh: token, expires: devinTokenExpiry(token) };
  } finally {
    callbacks.signal?.removeEventListener("abort", onAbort);
    await server.close();
  }
}

/** Request credential for the Devin provider. */
export function devinApiKeyFromCredential(credential: OAuthCredentials): string {
  return credential.access;
}

/**
 * Devin CLI credentials carry no refresh token, so an expired session must be
 * re-established interactively. Rejecting keeps Pi from retrying a dead token.
 */
export async function refreshDevinToken(): Promise<OAuthCredentials> {
  throw new Error("Devin session tokens cannot be refreshed; run /login devin to sign in again.");
}

async function listen(
  server: Server,
  host: string,
  preferredPort: number,
  allowPortFallback: boolean,
): Promise<number> {
  try {
    return await listenOn(server, host, preferredPort);
  } catch (error) {
    if (!allowPortFallback || !isAddressInUse(error)) throw error;
    return listenOn(server, host, 0);
  }
}

function listenOn(server: Server, host: string, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Devin callback server did not report a bound port"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function isAddressInUse(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "EADDRINUSE";
}

function envHost(): string | undefined {
  const value = process.env[DEVIN_CALLBACK_HOST_ENV]?.trim();
  return value && HOST_PATTERN.test(value) ? value : undefined;
}

function envPort(): number | undefined {
  const value = Number(process.env[DEVIN_CALLBACK_PORT_ENV]);
  return Number.isInteger(value) && value >= 0 && value <= 65_535 ? value : undefined;
}

function respond(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

function callbackPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #12121c; color: #eaeaea; }
    .box { text-align: center; padding: 2rem; }
    h1 { font-size: 1.25rem; margin: 0 0 0.75rem; }
    p { color: #a0a0b0; margin: 0; }
  </style>
</head>
<body>
  <div class="box">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function errorDetail(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return `: ${collapsed.length > MAX_ERROR_DETAIL_CHARS ? `${collapsed.slice(0, MAX_ERROR_DETAIL_CHARS)}…` : collapsed}`;
}
