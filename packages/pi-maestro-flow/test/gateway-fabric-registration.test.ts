import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as signPayload } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FabricDirectory,
  FabricStoreCoordinator,
  type FabricDurableStore,
  type FabricLogicalStoreSnapshot,
} from "pi-maestro-fabric";
import { GatewayPairingStore } from "../src/gateway/pairing-store.ts";
import { FabricPairingAdapter } from "../src/gateway/fabric/pairing-adapter.ts";
import {
  FABRIC_ENROLL_SCOPE,
  FABRIC_PAIRING_PROVIDER,
  FABRIC_ROTATE_SCOPE,
  GatewayFabricRegistrationAuthority,
  gatewayFabricEnrollmentRequestDigest,
  type GatewayFabricEnrollmentInput,
} from "../src/gateway/fabric/registration.ts";
import {
  FABRIC_CHALLENGE_PROOF_VERSION,
  FabricConnectorSecurity,
  fabricChallengeProofPayload,
  type FabricChallengeProofV1,
} from "../src/gateway/fabric/security.ts";
import { GatewayFabricStore } from "../src/gateway/fabric/store.ts";

const AUDIENCE = "hub.example.test";
const NOW = 1_000_000;

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    spki: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    fingerprint: createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex"),
    sign: (payload: string) => signPayload(null, Buffer.from(payload, "utf8"), privateKey).toString("base64"),
  };
}

async function fixture(t: test.TestContext, now: () => number = () => NOW) {
  const root = await mkdtemp(join(tmpdir(), "gateway-fabric-registration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "fabric.json");
  const store = new GatewayFabricStore({ path });
  const pairings = new GatewayPairingStore({ path: join(root, "pairings.json"), now });
  const authority = new GatewayFabricRegistrationAuthority(new FabricStoreCoordinator(store), { audience: AUDIENCE, now });
  const security = new FabricConnectorSecurity({ audience: AUDIENCE, now, credentialAuthority: authority });
  const adapter = new FabricPairingAdapter({ pairings, authority, security });
  return { root, path, store, pairings, authority, security, adapter, now };
}

async function purposeToken(target: Awaited<ReturnType<typeof fixture>>, scope: typeof FABRIC_ENROLL_SCOPE | typeof FABRIC_ROTATE_SCOPE, generation = 1) {
  return target.pairings.issue({
    audience: "fabric", scopes: [scope], provider: FABRIC_PAIRING_PROVIDER, instance: "connector-1",
    generation, ttlMs: 60_000,
  });
}

function enrollment(token: string, spki: string, requestId = "enroll-1") {
  return {
    token, requestId, connectorId: "connector-1", keyId: "key-1", publicKey: spki,
    label: "Connector One" as const, transport: "outbound-wss" as const,
    devices: [{ deviceId: "device-1", label: "Device One", connectionMode: "https" as const, platform: "linux", architecture: "x64", enabled: true }],
  };
}

function proof(
  security: FabricConnectorSecurity,
  signer: ReturnType<typeof keyPair>,
  generation: number,
): FabricChallengeProofV1 {
  const challenge = security.issueChallenge("connector-1");
  const claims = {
    connectorId: "connector-1", instanceNonce: "instance-1", challengeNonce: challenge.challengeNonce,
    audience: AUDIENCE, protocolVersion: "fabric.v1", credentialGeneration: generation,
  };
  return { version: FABRIC_CHALLENGE_PROOF_VERSION, challengeId: challenge.challengeId, ...claims, signature: signer.sign(fabricChallengeProofPayload(claims)) };
}

test("enrollment atomically persists canonical identity, Device ownership, consumption, and a secret-safe receipt", async (t) => {
  const target = await fixture(t);
  const signer = keyPair();
  const issued = await purposeToken(target, FABRIC_ENROLL_SCOPE);
  const receipt = await target.adapter.enrollFromPairing(enrollment(issued.token, signer.spki));

  assert.deepEqual({ revision: receipt.connectorRevision, generation: receipt.credentialGeneration, status: receipt.status }, { revision: 1, generation: 1, status: "active" });
  const registry = await target.store.readStore("registry");
  assert.deepEqual(Object.keys(registry.records).sort(), [
    `connector:connector-1`, `device:device-1`, `pairing:${issued.id}`, "registration-operation:enroll-1",
  ].sort());
  assert.equal(registry.records["connector:connector-1"]?.publicKeySpki, signer.spki);
  assert.equal(registry.records["connector:connector-1"]?.publicKeyFingerprint, signer.fingerprint);
  assert.equal(registry.records["connector:connector-1"]?.credentialGeneration, 1);
  assert.equal(registry.records["connector:connector-1"]?.revision, 1);
  assert.equal(registry.records["device:device-1"]?.connectorId, "connector-1");
  assert.equal((await readFile(target.path, "utf8")).includes(issued.token), false);
  assert.equal(JSON.stringify(await target.store.pendingOutbox()).includes("publicKey"), false);
  assert.equal(JSON.stringify(await target.store.pendingOutbox()).includes("Fingerprint"), false);
});

test("lost enrollment response recovers only the existing receipt after pairing revocation and restart", async (t) => {
  const target = await fixture(t);
  const signer = keyPair();
  const issued = await purposeToken(target, FABRIC_ENROLL_SCOPE);
  const original = await target.adapter.enrollFromPairing(enrollment(issued.token, signer.spki));
  assert.equal(await target.pairings.authenticate(issued.token, { audience: "fabric" }), undefined);

  const restarted = new GatewayFabricRegistrationAuthority(new FabricStoreCoordinator(new GatewayFabricStore({ path: target.path })), { audience: AUDIENCE, now: () => NOW });
  await restarted.hydrate();
  assert.deepEqual(await restarted.receipt({ requestId: original.requestId, requestDigest: original.requestDigest, rawToken: issued.token }), original);
  assert.equal(await restarted.receipt({ requestId: original.requestId, requestDigest: original.requestDigest, rawToken: "wrong-token" }), undefined);
  assert.equal(await restarted.receipt({ requestId: original.requestId, requestDigest: "0".repeat(64), rawToken: issued.token }), undefined);
  assert.equal((await target.store.readStore("registry")).revision, 1, "receipt recovery mutated durable state");
});

test("rotation increments revision and generation once, survives restart, and fences predecessor proofs", async (t) => {
  const target = await fixture(t);
  const predecessor = keyPair();
  const enrollToken = await purposeToken(target, FABRIC_ENROLL_SCOPE);
  const enrolled = await target.adapter.enrollFromPairing(enrollment(enrollToken.token, predecessor.spki));
  const preRotationChallenge = proof(target.security, predecessor, 1);

  const successor = keyPair();
  const rotateToken = await purposeToken(target, FABRIC_ROTATE_SCOPE, 1);
  const rotated = await target.adapter.rotateFromPairing({
    token: rotateToken.token, requestId: "rotate-1", connectorId: "connector-1",
    expectedRevision: 1, expectedCredentialGeneration: 1, keyId: "key-2", publicKey: successor.spki,
  });
  assert.deepEqual({ revision: rotated.connectorRevision, generation: rotated.credentialGeneration }, { revision: 2, generation: 2 });
  assert.throws(() => target.security.verifyProof(preRotationChallenge), /unknown or already used/);

  const restartedAuthority = new GatewayFabricRegistrationAuthority(new FabricStoreCoordinator(new GatewayFabricStore({ path: target.path })), { audience: AUDIENCE, now: () => NOW });
  await restartedAuthority.hydrate();
  const restartedSecurity = new FabricConnectorSecurity({ audience: AUDIENCE, now: () => NOW, credentialAuthority: restartedAuthority });
  assert.throws(() => restartedSecurity.verifyProof(preRotationChallenge), /unknown or already used/);
  assert.throws(() => restartedSecurity.verifyProof(proof(restartedSecurity, predecessor, 2)), /signature did not verify/);
  assert.equal(restartedSecurity.verifyProof(proof(restartedSecurity, successor, 2)).credentialGeneration, 2);

  const recoveredEnrollment = await restartedAuthority.receipt({ requestId: "enroll-1", requestDigest: enrolled.requestDigest, rawToken: enrollToken.token });
  assert.equal(recoveredEnrollment?.status, "superseded");
});

test("revocation is durable and exact retries never advance revision twice", async (t) => {
  const target = await fixture(t);
  const issued = await purposeToken(target, FABRIC_ENROLL_SCOPE);
  await target.adapter.enrollFromPairing(enrollment(issued.token, keyPair().spki));

  const first = await target.authority.revoke({ requestId: "revoke-1", connectorId: "connector-1", expectedRevision: 1 });
  const registryRevision = (await target.store.readStore("registry")).revision;
  const replay = await target.authority.revoke({ requestId: "revoke-1", connectorId: "connector-1", expectedRevision: 1 });
  assert.deepEqual(replay, first);
  assert.equal((await target.store.readStore("registry")).revision, registryRevision);
  assert.equal(target.authority.credentialOf("connector-1")?.revoked, true);

  await assert.rejects(
    () => target.authority.revoke({ requestId: "revoke-1", connectorId: "connector-1", expectedRevision: 2 }),
    /requestId is already bound to different content/,
  );
  const safeRepeat = await target.authority.revoke({ requestId: "revoke-2", connectorId: "connector-1", expectedRevision: 2 });
  assert.equal(safeRepeat.status, "revoked");
  assert.equal((await target.store.readStore("registry")).revision, registryRevision);
});

test("Connector revocation tombstones every consumed purpose binding", async (t) => {
  const target = await fixture(t);
  const enrolledKey = keyPair();
  const enrollmentToken = await purposeToken(target, FABRIC_ENROLL_SCOPE);
  await target.adapter.enrollFromPairing(enrollment(enrollmentToken.token, enrolledKey.spki));
  const rotationToken = await purposeToken(target, FABRIC_ROTATE_SCOPE, 1);
  await target.adapter.rotateFromPairing({
    token: rotationToken.token, requestId: "rotate-before-revoke", connectorId: "connector-1",
    expectedRevision: 1, expectedCredentialGeneration: 1, keyId: "key-2", publicKey: keyPair().spki,
  });

  await target.authority.revoke({ requestId: "revoke-all-bindings", connectorId: "connector-1", expectedRevision: 2 });
  const registry = await target.store.readStore("registry");
  assert.equal(registry.records[`pairing:${enrollmentToken.id}`]?.state, "revoked");
  assert.equal(registry.records[`pairing:${rotationToken.id}`]?.state, "revoked");
});

test("revocation rejects an arbitrary pairing id without persisting an invalid operation", async (t) => {
  const target = await fixture(t);
  const issued = await purposeToken(target, FABRIC_ENROLL_SCOPE);
  await target.adapter.enrollFromPairing(enrollment(issued.token, keyPair().spki));
  const before = await target.store.readStore("registry");

  await assert.rejects(
    () => target.authority.revoke({ requestId: "revoke-invalid", connectorId: "connector-1", expectedRevision: 1, pairingId: "pair-missing" }),
    /pairing consumption binding was not found/,
  );
  const after = await target.store.readStore("registry");
  assert.equal(after.revision, before.revision);
  assert.equal(after.records["registration-operation:revoke-invalid"], undefined);
  await target.authority.validate();
});

test("restart hydration restores identity and Directory authority but not executable readiness", async (t) => {
  const target = await fixture(t);
  const issued = await purposeToken(target, FABRIC_ENROLL_SCOPE);
  await target.adapter.enrollFromPairing(enrollment(issued.token, keyPair().spki));

  const restarted = new GatewayFabricRegistrationAuthority(new FabricStoreCoordinator(new GatewayFabricStore({ path: target.path })), { audience: AUDIENCE, now: () => NOW });
  const directory = new FabricDirectory();
  const seeds = await restarted.hydrate(directory);
  assert.equal(seeds.length, 1);
  assert.equal(directory.getConnector("connector-1")?.credentialGeneration, 1);
  assert.equal(directory.getDevice("device-1")?.connectorId, "connector-1");
  assert.deepEqual(directory.listAcceptedExecutionViews(), []);
  assert.equal(directory.getEndpoint("endpoint-1"), undefined);
});

test("request digests are canonical across object key and unordered Device ordering", () => {
  const signer = keyPair();
  const left = {
    requestId: "canonical-request",
    pairingId: "pair-canonical",
    connector: { connectorId: "connector-1", label: "Connector One", transport: "outbound-wss" as const },
    devices: [
      { deviceId: "device-b", label: "B", connectionMode: "https" as const, enabled: true },
      { deviceId: "device-a", label: "A", connectionMode: "https" as const, enabled: true },
    ],
    keyId: "key-1",
    publicKeySpki: signer.spki,
  };
  const right = {
    publicKeySpki: signer.spki,
    keyId: "key-1",
    devices: [
      { enabled: true, connectionMode: "https" as const, label: "A", deviceId: "device-a" },
      { label: "B", deviceId: "device-b", enabled: true, connectionMode: "https" as const },
    ],
    connector: { transport: "outbound-wss" as const, label: "Connector One", connectorId: "connector-1" },
    pairingId: "pair-canonical",
    requestId: "canonical-request",
  };
  assert.equal(gatewayFabricEnrollmentRequestDigest(left), gatewayFabricEnrollmentRequestDigest(right));
});

test("registration rejects unknown Connector and Device runtime fields before persistence", async (t) => {
  const target = await fixture(t);
  const base = {
    requestId: "unknown-field-enroll",
    pairingId: "pair-unknown-field",
    rawToken: "raw-token",
    connector: { connectorId: "connector-1", label: "Connector One", transport: "outbound-wss" as const },
    devices: [{ deviceId: "device-1", label: "Device One", connectionMode: "https" as const, enabled: true }],
    keyId: "key-1",
    publicKeySpki: keyPair().spki,
  };
  const connectorInput = {
    ...base,
    connector: { ...base.connector, instanceNonce: "must-not-persist" },
  } as unknown as GatewayFabricEnrollmentInput;
  await assert.rejects(() => target.authority.enroll(connectorInput), /connector\.instanceNonce is not supported/);

  const deviceInput = {
    ...base,
    requestId: "unknown-device-field",
    devices: [{ ...base.devices[0]!, privatePath: "D:/secret" }],
  } as unknown as GatewayFabricEnrollmentInput;
  await assert.rejects(() => target.authority.enroll(deviceInput), /devices\[0\]\.privatePath is not supported/);
  assert.equal((await target.store.readStore("registry")).revision, 0);
});

test("stale hydration cannot overwrite a credential rotation published after its snapshot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-fabric-hydration-fence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new GatewayFabricStore({ path: join(root, "fabric.json") });
  let pauseNextRead = false;
  let captured!: () => void;
  const capturedRead = new Promise<void>((resolve) => { captured = resolve; });
  let resume!: () => void;
  const readGate = new Promise<void>((resolve) => { resume = resolve; });
  const durable: FabricDurableStore = {
    transact: (transaction) => store.transact(transaction),
    readStore: async (kind): Promise<FabricLogicalStoreSnapshot> => {
      const snapshot = await store.readStore(kind);
      if (pauseNextRead) {
        pauseNextRead = false;
        captured();
        await readGate;
      }
      return snapshot;
    },
  };
  const authority = new GatewayFabricRegistrationAuthority(new FabricStoreCoordinator(durable), { audience: AUDIENCE, now: () => NOW });
  const predecessor = keyPair();
  await authority.enroll({
    requestId: "hydrate-enroll", pairingId: "pair-hydrate-enroll", rawToken: "enroll-token",
    connector: { connectorId: "connector-1", label: "Connector One", transport: "outbound-wss" },
    devices: [], keyId: "key-1", publicKeySpki: predecessor.spki,
  });

  pauseNextRead = true;
  const hydration = authority.hydrate();
  await capturedRead;
  const successor = keyPair();
  await authority.rotate({
    requestId: "hydrate-rotate", pairingId: "pair-hydrate-rotate", rawToken: "rotate-token",
    connectorId: "connector-1", expectedRevision: 1, expectedCredentialGeneration: 1,
    keyId: "key-2", publicKeySpki: successor.spki,
  });
  resume();
  await hydration;
  assert.equal(authority.credentialOf("connector-1")?.credentialGeneration, 2);
  assert.equal(authority.credentialOf("connector-1")?.publicKey, successor.spki);
});

test("startup rejects Connector authority without enrollment evidence and operations without pairing ids", async (t) => {
  const orphaned = await fixture(t);
  const orphanToken = await purposeToken(orphaned, FABRIC_ENROLL_SCOPE);
  await orphaned.adapter.enrollFromPairing(enrollment(orphanToken.token, keyPair().spki, "orphan-enroll"));
  await orphaned.authority.coordinator.commit("registry", NOW, () => ({
    mutations: [
      { kind: "delete", subjectId: `pairing:${orphanToken.id}`, expectedRevision: 1, eventKind: "test.pairing-removed", payload: {} },
      { kind: "delete", subjectId: "registration-operation:orphan-enroll", expectedRevision: 1, eventKind: "test.operation-removed", payload: {} },
    ],
    value: undefined,
  }));
  const orphanRestart = new GatewayFabricRegistrationAuthority(new FabricStoreCoordinator(orphaned.store), { audience: AUDIENCE, now: () => NOW });
  await assert.rejects(() => orphanRestart.validate(), /exactly one valid enrollment operation and consumption tombstone/);

  const missingPairing = await fixture(t);
  const issued = await purposeToken(missingPairing, FABRIC_ENROLL_SCOPE);
  await missingPairing.adapter.enrollFromPairing(enrollment(issued.token, keyPair().spki, "missing-pairing-enroll"));
  await missingPairing.authority.coordinator.commit("registry", NOW, (snapshot) => {
    const current = snapshot.records["registration-operation:missing-pairing-enroll"]!;
    const { pairingId: _pairingId, ...withoutPairing } = current;
    return {
      mutations: [{
        kind: "upsert", subjectId: "registration-operation:missing-pairing-enroll", expectedRevision: 1,
        value: { ...withoutPairing, revision: 2 }, eventKind: "test.operation-corrupted", payload: {},
      }],
      value: undefined,
    };
  });
  const missingPairingRestart = new GatewayFabricRegistrationAuthority(new FabricStoreCoordinator(missingPairing.store), { audience: AUDIENCE, now: () => NOW });
  await assert.rejects(() => missingPairingRestart.validate(), /must reference its pairing consumption/);
});

test("startup rejects cross-Connector operation pairing provenance", async (t) => {
  const target = await fixture(t);
  const first = await purposeToken(target, FABRIC_ENROLL_SCOPE);
  await target.adapter.enrollFromPairing(enrollment(first.token, keyPair().spki, "enroll-first"));
  const secondToken = await target.pairings.issue({ audience: "fabric", scopes: [FABRIC_ENROLL_SCOPE], provider: FABRIC_PAIRING_PROVIDER, instance: "connector-2", generation: 1, ttlMs: 60_000 });
  await target.adapter.enrollFromPairing({ token: secondToken.token, requestId: "enroll-second", connectorId: "connector-2", keyId: "key-2", publicKey: keyPair().spki });
  await target.authority.revoke({ requestId: "revoke-first", connectorId: "connector-1", expectedRevision: 1 });
  await target.authority.coordinator.commit("registry", NOW, (snapshot) => {
    const current = snapshot.records["registration-operation:revoke-first"]!;
    return { mutations: [{ kind: "upsert", subjectId: "registration-operation:revoke-first", expectedRevision: 1, value: { ...current, pairingId: secondToken.id, revision: 2 }, eventKind: "test.operation-corrupted", payload: {} }], value: undefined };
  });
  const restarted = new GatewayFabricRegistrationAuthority(new FabricStoreCoordinator(target.store), { audience: AUDIENCE, now: () => NOW });
  await assert.rejects(() => restarted.validate(), /another Connector's pairing/);
});

test("recognized malformed registrations fail closed while unrelated legacy subjects remain inert", async (t) => {
  const target = await fixture(t);
  await target.authority.coordinator.commit("registry", NOW, () => ({
    mutations: [{ kind: "upsert", subjectId: "legacy-record", value: { revision: 1, label: "inert" }, eventKind: "legacy.updated", payload: {} }],
    value: undefined,
  }));
  assert.deepEqual(await target.authority.hydrate(), []);

  await target.authority.coordinator.commit("registry", NOW, (store) => ({
    mutations: [{ kind: "upsert", subjectId: "connector:broken", value: { revision: 1 }, eventKind: "connector.updated", payload: {} }],
    value: store.revision,
  }));
  await assert.rejects(() => target.authority.hydrate(), /recordType.*required/);
  assert.equal(target.authority.credentialOf("broken"), undefined);
});
