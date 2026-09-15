import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayPairingStore } from "../src/gateway/pairing-store.ts";
import { GatewayDaemon } from "../src/gateway/daemon.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";
import { principalHasGatewayAction } from "../src/gateway/capabilities.ts";
import { createGatewayPrincipal } from "../src/gateway/principal.ts";

test("pairings bind scopes, workspace, audience, provider, instance, generation, expiry, and replacement revocation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-pairing-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = 1_000;
  const path = join(root, "pairings.json");
  const store = new GatewayPairingStore({ path, now: () => now });
  const issued = await store.issue({
    ttlMs: 100,
    scopes: ["gateway.file.read"],
    audience: "gateway.tunnel",
    workspaceId: "workspace-a",
    provider: "cloudflare",
    instance: "tunnel-1",
    generation: 3,
  });
  assert.equal((await store.authenticate(issued.token, { audience: "gateway.tunnel", workspaceId: "workspace-a", provider: "cloudflare", instance: "tunnel-1", generation: 3 }))?.id, issued.id);
  assert.equal(await store.authenticate(issued.token, { audience: "gateway" }), undefined);
  assert.equal(await store.authenticate(issued.token, { audience: "gateway.tunnel", workspaceId: "workspace-b" }), undefined);
  assert.equal(await store.authenticate(issued.token, { audience: "gateway.tunnel", generation: 4 }), undefined);

  const replacement = await store.issue({ ttlMs: 100, audience: "gateway.tunnel", scopes: ["gateway.file.read"], replacesId: issued.id });
  assert.equal(await store.authenticate(issued.token, { audience: "gateway.tunnel" }), undefined);
  const inactive = await store.list({ includeInactive: true });
  assert.equal(inactive.find((entry) => entry.id === issued.id)?.replacedById, replacement.id);
  assert.equal(inactive.find((entry) => entry.id === issued.id)?.revokedAt, now);

  now += 101;
  assert.equal(await store.authenticate(replacement.token, { audience: "gateway.tunnel" }), undefined, "expiry is fail closed");
  assert.doesNotMatch(await readFile(path, "utf8"), new RegExp(issued.token));
});

test("generic pairing cannot mint the tunnel audience outside a canonical profile issuer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-pairing-boundary-"));
  const daemon = new GatewayDaemon({ config: createTestGatewayConfig(root, { mode: "bearer", token: "local-token" }), cwd: root, http: false, tunnelProviders: [] });
  t.after(async () => { await daemon.stop().catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  await daemon.start();
  for (const audience of ["gateway.tunnel", " gateway.tunnel ", "\ngateway.tunnel\n", "\t gateway.tunnel \t"]) {
    await assert.rejects(
      () => daemon.controlDispatcher!.dispatch("pair", { audience, scopes: ["gateway.host.status"], provider: "openai", instance: "openai-prod" }),
      /configured tunnel profile/u,
      `generic pairing must reject canonical tunnel audience (${JSON.stringify(audience)})`,
    );
  }
  const canonical = await daemon.controlDispatcher!.dispatch("pair", { audience: " custom.example ", scopes: ["gateway.host.status"] }) as { audience: string };
  assert.equal(canonical.audience, "custom.example");
});

test("startup orphan recovery revokes all active OpenAI generations but not later credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-pairing-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new GatewayPairingStore({ path: join(root, "pairings.json") });
  const events: string[] = [];
  const unsubscribe = store.subscribeRevocations((event) => { events.push(`${event.id}:${event.reason}`); });
  t.after(unsubscribe);
  const first = await store.issue({ audience: "gateway.tunnel", provider: "openai", instance: "profile-a", generation: 1, scopes: ["gateway.host.status"], ttlMs: 60_000 });
  const second = await store.issue({ audience: "gateway.tunnel", provider: "openai", instance: "profile-a", generation: 2, scopes: ["gateway.host.status"], ttlMs: 60_000 });
  const other = await store.issue({ audience: "gateway.tunnel", provider: "openai", instance: "profile-b", generation: 1, scopes: ["gateway.host.status"], ttlMs: 60_000 });
  const revoked = await store.revokeOpenAiTunnelPairings("profile-a", "daemon-startup-recovery:profile-a");
  assert.deepEqual(revoked.map((entry) => entry.id), [first.id, second.id]);
  assert.equal(await store.authenticate(first.token, { audience: "gateway.tunnel" }), undefined);
  assert.equal(await store.authenticate(second.token, { audience: "gateway.tunnel" }), undefined);
  assert.equal((await store.authenticate(other.token, { audience: "gateway.tunnel" }))?.id, other.id);
  const successor = await store.issue({ audience: "gateway.tunnel", provider: "openai", instance: "profile-a", generation: 3, scopes: ["gateway.host.status"], ttlMs: 60_000 });
  assert.equal((await store.authenticate(successor.token, { audience: "gateway.tunnel" }))?.id, successor.id);
  assert.equal(events.length, 2);
});

test("action capabilities keep primary umbrellas compatible without widening narrow pairings", () => {
  const primary = createGatewayPrincipal("http", "primary", { authenticated: true, scopes: ["gateway.*"] });
  const narrow = createGatewayPrincipal("http", "narrow", { authenticated: true, scopes: ["gateway.file.read"] });
  assert.equal(principalHasGatewayAction(primary, "exec", "run"), true);
  assert.equal(principalHasGatewayAction(narrow, "file", "read"), true);
  assert.equal(principalHasGatewayAction(narrow, "file", "write"), false);
  assert.equal(principalHasGatewayAction(narrow, "host", "status"), false);
});
