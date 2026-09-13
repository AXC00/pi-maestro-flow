import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FabricStoreCoordinator } from "pi-maestro-fabric";
import {
  GatewayPairingStore,
  type GatewayPairingAuthenticationContext,
  type GatewayPairingPublicRecord,
} from "../src/gateway/pairing-store.ts";
import {
  FABRIC_ENROLL_SCOPE,
  FABRIC_PAIRING_PROVIDER,
  GatewayFabricRegistrationAuthority,
} from "../src/gateway/fabric/registration.ts";
import { FabricConnectorSecurity } from "../src/gateway/fabric/security.ts";
import {
  FABRIC_PAIRING_AUDIENCE,
  FabricPairingAdapter,
  FabricRegistrationLifecycleGate,
} from "../src/gateway/fabric/pairing-adapter.ts";
import { GatewayFabricStore } from "../src/gateway/fabric/store.ts";

const NOW = 1_000_000;

function publicKey(): string {
  return generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
}

async function harness(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "fabric-pairing-adapter-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pairings = new GatewayPairingStore({ path: join(root, "pairings.json"), now: () => NOW });
  const store = new GatewayFabricStore({ path: join(root, "fabric.json") });
  const authority = new GatewayFabricRegistrationAuthority(new FabricStoreCoordinator(store), { audience: "hub.example.test", now: () => NOW });
  const security = new FabricConnectorSecurity({ audience: "hub.example.test", now: () => NOW, credentialAuthority: authority });
  return { adapter: new FabricPairingAdapter({ pairings, authority, security }), pairings, authority, security, store };
}

async function issue(pairings: GatewayPairingStore, connectorId = "connector-1") {
  return pairings.issue({
    audience: FABRIC_PAIRING_AUDIENCE,
    scopes: [FABRIC_ENROLL_SCOPE],
    provider: FABRIC_PAIRING_PROVIDER,
    instance: connectorId,
    ttlMs: 60_000,
  });
}

test("enrollment requires the raw, connector-bound Fabric purpose token", async (t) => {
  const target = await harness(t);
  const issued = await issue(target.pairings);
  const request = { requestId: "request-1", connectorId: "connector-1", keyId: "key-1", publicKey: publicKey() };

  await assert.rejects(() => target.adapter.enrollFromPairing({ ...request, token: issued.id }), /purpose token is invalid/);
  assert.equal((await target.authority.list()).length, 0);

  const receipt = await target.adapter.enrollFromPairing({ ...request, token: issued.token });
  assert.equal(receipt.status, "active");
  assert.deepEqual(target.authority.credentialOf("connector-1")?.scopes, ["fabric.connect"]);
  assert.equal(await target.adapter.connectorOfPairing(issued.id), "connector-1");
  assert.equal(await target.pairings.authenticate(issued.token, { audience: FABRIC_PAIRING_AUDIENCE }), undefined);
});

test("wrong audience, purpose, and connector binding cannot mutate registration", async (t) => {
  const target = await harness(t);
  const legacy = await target.pairings.issue({ scopes: ["gateway.workspace"], ttlMs: 60_000 });
  const wrongPurpose = await target.pairings.issue({
    audience: FABRIC_PAIRING_AUDIENCE, scopes: ["fabric.rotate"], provider: FABRIC_PAIRING_PROVIDER,
    instance: "connector-1", ttlMs: 60_000,
  });
  const otherConnector = await issue(target.pairings, "connector-2");
  const base = { requestId: "request-1", connectorId: "connector-1", keyId: "key-1", publicKey: publicKey() };

  await assert.rejects(() => target.adapter.enrollFromPairing({ ...base, token: legacy.token }), /purpose token is invalid/);
  await assert.rejects(() => target.adapter.enrollFromPairing({ ...base, token: wrongPurpose.token }), /must grant exactly fabric\.enroll/);
  await assert.rejects(() => target.adapter.enrollFromPairing({ ...base, token: otherConnector.token }), /purpose token is invalid/);
  assert.deepEqual(await target.authority.list(), []);
});

test("durable pairing consumption permits at most one concurrent enrollment", async (t) => {
  const target = await harness(t);
  const issued = await issue(target.pairings);
  const key = publicKey();
  const attempts = await Promise.allSettled([
    target.adapter.enrollFromPairing({ token: issued.token, requestId: "request-a", connectorId: "connector-1", keyId: "key-1", publicKey: key }),
    target.adapter.enrollFromPairing({ token: issued.token, requestId: "request-b", connectorId: "connector-1", keyId: "key-1", publicKey: key }),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal((await target.authority.list()).length, 1);
  const registry = await target.store.readStore("registry");
  assert.equal(Object.keys(registry.records).filter((subject) => subject.startsWith("pairing:")).length, 1);
});

test("a pairing revoke requested after authentication fences registration before commit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fabric-pairing-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let authenticated!: () => void;
  const authenticationObserved = new Promise<void>((resolve) => { authenticated = resolve; });
  let resume!: () => void;
  const authenticationGate = new Promise<void>((resolve) => { resume = resolve; });
  class PausingPairingStore extends GatewayPairingStore {
    override async authenticate(token: string, context: GatewayPairingAuthenticationContext = {}): Promise<GatewayPairingPublicRecord | undefined> {
      const result = await super.authenticate(token, context);
      authenticated();
      await authenticationGate;
      return result;
    }
  }
  const pairings = new PausingPairingStore({ path: join(root, "pairings.json"), now: () => NOW });
  const store = new GatewayFabricStore({ path: join(root, "fabric.json") });
  const authority = new GatewayFabricRegistrationAuthority(new FabricStoreCoordinator(store), { audience: "hub.example.test", now: () => NOW });
  const gate = new FabricRegistrationLifecycleGate();
  const adapter = new FabricPairingAdapter({ pairings, authority, gate });
  const issued = await issue(pairings);
  const pendingEnrollment = adapter.enrollFromPairing({ token: issued.token, requestId: "request-race", connectorId: "connector-1", keyId: "key-1", publicKey: publicKey() });
  await authenticationObserved;
  const pendingRevoke = adapter.revokePairing(issued.id);
  resume();

  await assert.rejects(pendingEnrollment, /revocation is pending/);
  assert.deepEqual(await pendingRevoke, { revoked: true });
  assert.deepEqual(await authority.list(), []);
  assert.equal((await store.readStore("registry")).records["registration-operation:request-race"], undefined);
});

test("purpose tokens are revalidated for expiry immediately before enrollment and rotation commits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fabric-pairing-expiry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = NOW;
  class ExpiringPairingStore extends GatewayPairingStore {
    expireAfterNextSuccess = false;
    override async authenticate(token: string, context: GatewayPairingAuthenticationContext = {}): Promise<GatewayPairingPublicRecord | undefined> {
      const result = await super.authenticate(token, context);
      if (result !== undefined && this.expireAfterNextSuccess) {
        this.expireAfterNextSuccess = false;
        now = result.expiresAt;
      }
      return result;
    }
  }
  const pairings = new ExpiringPairingStore({ path: join(root, "pairings.json"), now: () => now });
  const store = new GatewayFabricStore({ path: join(root, "fabric.json") });
  const authority = new GatewayFabricRegistrationAuthority(new FabricStoreCoordinator(store), { audience: "hub.example.test", now: () => now });
  const adapter = new FabricPairingAdapter({ pairings, authority });

  const expiringEnrollment = await issue(pairings);
  pairings.expireAfterNextSuccess = true;
  await assert.rejects(() => adapter.enrollFromPairing({
    token: expiringEnrollment.token, requestId: "expired-enroll", connectorId: "connector-1",
    keyId: "key-1", publicKey: publicKey(),
  }), /purpose token is invalid or unavailable/);
  assert.deepEqual(await authority.list(), []);

  const activeEnrollment = await issue(pairings);
  await adapter.enrollFromPairing({
    token: activeEnrollment.token, requestId: "active-enroll", connectorId: "connector-1",
    keyId: "key-1", publicKey: publicKey(),
  });
  const rotation = await pairings.issue({
    audience: FABRIC_PAIRING_AUDIENCE, scopes: ["fabric.rotate"], provider: FABRIC_PAIRING_PROVIDER,
    instance: "connector-1", generation: 1, ttlMs: 60_000,
  });
  pairings.expireAfterNextSuccess = true;
  await assert.rejects(() => adapter.rotateFromPairing({
    token: rotation.token, requestId: "expired-rotate", connectorId: "connector-1",
    expectedRevision: 1, expectedCredentialGeneration: 1, keyId: "key-2", publicKey: publicKey(),
  }), /purpose token is invalid or unavailable/);
  assert.equal(authority.credentialOf("connector-1")?.credentialGeneration, 1);
});

test("expiry is rechecked inside the serialized registry transaction for enroll and rotate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fabric-pairing-commit-expiry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = NOW;
  let expireAtCommit = false;
  const pairings = new GatewayPairingStore({ path: join(root, "pairings.json"), now: () => now });
  const store = new GatewayFabricStore({ path: join(root, "fabric.json") });
  const durable = {
    transact: (transaction: Parameters<GatewayFabricStore["transact"]>[0]) => store.transact(transaction),
    readStore: async (kind: Parameters<GatewayFabricStore["readStore"]>[0]) => {
      const snapshot = await store.readStore(kind);
      if (expireAtCommit) { expireAtCommit = false; now += 60_000; }
      return snapshot;
    },
  };
  const authority = new GatewayFabricRegistrationAuthority(new FabricStoreCoordinator(durable), { audience: "hub.example.test", now: () => now });
  const adapter = new FabricPairingAdapter({ pairings, authority });
  const enrollToken = await issue(pairings);
  expireAtCommit = true;
  await assert.rejects(() => adapter.enrollFromPairing({
    token: enrollToken.token, requestId: "commit-expired-enroll", connectorId: "connector-1", keyId: "key-1", publicKey: publicKey(),
  }), /expired before registration commit/);
  assert.deepEqual(await authority.list(), []);

  now = NOW;
  const activeToken = await issue(pairings);
  await adapter.enrollFromPairing({ token: activeToken.token, requestId: "active-enroll", connectorId: "connector-1", keyId: "key-1", publicKey: publicKey() });
  const rotateToken = await pairings.issue({ audience: FABRIC_PAIRING_AUDIENCE, scopes: ["fabric.rotate"], provider: FABRIC_PAIRING_PROVIDER, instance: "connector-1", generation: 1, ttlMs: 60_000 });
  expireAtCommit = true;
  await assert.rejects(() => adapter.rotateFromPairing({
    token: rotateToken.token, requestId: "commit-expired-rotate", connectorId: "connector-1", expectedRevision: 1,
    expectedCredentialGeneration: 1, keyId: "key-2", publicKey: publicKey(),
  }), /expired before registration commit/);
  assert.equal(authority.credentialOf("connector-1")?.credentialGeneration, 1);
});

test("a failed serialized revoke clears its transient pairing fence", async (t) => {
  const target = await harness(t);
  const issued = await issue(target.pairings);
  const original = target.authority.connectorOfPairing.bind(target.authority);
  let fail = true;
  target.authority.connectorOfPairing = async (pairingId: string) => {
    if (fail) { fail = false; throw new Error("transient registry read"); }
    return original(pairingId);
  };
  await assert.rejects(() => target.adapter.revokePairing(issued.id), /transient registry read/);
  const receipt = await target.adapter.enrollFromPairing({ token: issued.token, requestId: "after-failed-revoke", connectorId: "connector-1", keyId: "key-1", publicKey: publicKey() });
  assert.equal(receipt.status, "active");
});

test("exact Connector revoke retries pending physical and pairing cleanup", async (t) => {
  const target = await harness(t);
  const issued = await issue(target.pairings);
  await target.adapter.enrollFromPairing({ token: issued.token, requestId: "cleanup-enroll", connectorId: "connector-1", keyId: "key-1", publicKey: publicKey() });
  let physicalReady = false;
  let pairingReady = false;
  const revoke = target.pairings.revoke.bind(target.pairings);
  target.pairings.revoke = async (id, options) => pairingReady ? revoke(id, options) : Promise.reject(new Error("pairing store unavailable"));
  const adapter = new FabricPairingAdapter({ pairings: target.pairings, authority: target.authority, afterCommit: async () => ({ cleanupComplete: physicalReady }) });
  const request = { connectorId: "connector-1", requestId: "cleanup-revoke", expectedRevision: 1 };
  const pending = await adapter.revokeConnector(request);
  assert.deepEqual({ status: pending.status, lifecycle: pending.lifecycleStatus, durable: pending.durableStatus, cleanup: pending.cleanupStatus }, { status: "revoked", lifecycle: "revoked-cleanup-pending", durable: "revoked", cleanup: "pending" });
  physicalReady = true;
  pairingReady = true;
  const complete = await adapter.revokeConnector(request);
  assert.deepEqual({ status: complete.status, lifecycle: complete.lifecycleStatus, durable: complete.durableStatus, cleanup: complete.cleanupStatus }, { status: "revoked", lifecycle: "revoked", durable: "revoked", cleanup: "complete" });
  assert.equal(complete.requestDigest, pending.requestDigest);
});

test("coupled revoke commits durable authority before pairing cleanup", async (t) => {
  const target = await harness(t);
  const issued = await issue(target.pairings);
  await target.adapter.enrollFromPairing({ token: issued.token, requestId: "request-1", connectorId: "connector-1", keyId: "key-1", publicKey: publicKey() });
  target.security.issueChallenge("connector-1");

  const revoked = await target.adapter.revokeForPairing(issued.id, { requestId: "revoke-1", expectedRevision: 1 });
  assert.equal(revoked?.status, "revoked");
  assert.equal(target.authority.credentialOf("connector-1")?.revoked, true);
  assert.equal(target.security.pendingChallengeCount, 0);
  assert.throws(() => target.security.issueChallenge("connector-1"), /not accepted by this Hub/);
});
