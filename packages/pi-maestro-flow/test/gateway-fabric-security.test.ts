import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign as signPayload } from "node:crypto";
import {
  FABRIC_CHALLENGE_PROOF_VERSION,
  FabricConnectorSecurity,
  fabricChallengeProofPayload,
  type FabricChallengeProofV1,
  type FabricConnectorSecurityOptions,
} from "../src/gateway/fabric/security.ts";

const AUDIENCE = "hub.example.test";

function keyPair(): { publicKey: string; sign(text: string): string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    sign: (text: string) => signPayload(null, Buffer.from(text, "utf8"), privateKey).toString("base64"),
  };
}

function hub(overrides: Partial<FabricConnectorSecurityOptions> = {}): FabricConnectorSecurity {
  return new FabricConnectorSecurity({ audience: AUDIENCE, now: () => NOW, ...overrides });
}

const NOW = 1_000_000;

function enrolled(hubInstance: FabricConnectorSecurity, connectorId = "connector-1") {
  const pair = keyPair();
  const credential = hubInstance.enroll({
    connectorId,
    keyId: `${connectorId}-key-1`,
    publicKey: pair.publicKey,
    scopes: ["fabric.data.*", "fabric.control.route"],
  });
  return { pair, credential };
}

/** Answer one challenge the way a Connector would. */
function proofFor(
  hubInstance: FabricConnectorSecurity,
  connectorId: string,
  pair: { sign(text: string): string },
  credentialGeneration: number,
  overrides: Partial<FabricChallengeProofV1> = {},
): FabricChallengeProofV1 {
  const challenge = hubInstance.issueChallenge(connectorId);
  const claims = {
    connectorId,
    instanceNonce: "instance-nonce-1",
    challengeNonce: challenge.challengeNonce,
    protocolVersion: "fabric.v1",
    audience: AUDIENCE,
    credentialGeneration,
    ...overrides,
  };
  return {
    version: FABRIC_CHALLENGE_PROOF_VERSION,
    challengeId: challenge.challengeId,
    signature: pair.sign(fabricChallengeProofPayload(claims)),
    ...claims,
  };
}

test("an enrolled Connector proves possession of its key and is accepted", () => {
  const security = hub();
  const { pair, credential } = enrolled(security);
  assert.equal(credential.credentialGeneration, 1);

  const accepted = security.verifyProof(proofFor(security, "connector-1", pair, 1));
  assert.equal(accepted.connectorId, "connector-1");
  assert.deepEqual(accepted.scopes, ["fabric.data.*", "fabric.control.route"]);
  assert.equal(security.pendingChallengeCount, 0, "a used challenge stayed pending");
});

test("a challenge is single use, so a replayed proof fails closed", () => {
  const security = hub();
  const { pair } = enrolled(security);
  const proof = proofFor(security, "connector-1", pair, 1);

  security.verifyProof(proof);
  assert.throws(
    () => security.verifyProof(proof),
    /challenge is unknown or already used/,
  );
});

test("a failed proof burns its challenge instead of leaving a second guess", () => {
  const security = hub();
  const { pair } = enrolled(security);
  const challenge = security.issueChallenge("connector-1");
  const claims = {
    connectorId: "connector-1",
    instanceNonce: "instance-nonce-1",
    challengeNonce: challenge.challengeNonce,
    protocolVersion: "fabric.v1",
    audience: AUDIENCE,
    credentialGeneration: 1,
  };
  const forged: FabricChallengeProofV1 = {
    version: FABRIC_CHALLENGE_PROOF_VERSION,
    challengeId: challenge.challengeId,
    signature: Buffer.alloc(64).toString("base64"),
    ...claims,
  };
  assert.throws(() => security.verifyProof(forged), /signature did not verify/);
  assert.equal(security.pendingChallengeCount, 0);

  // The honest connector now cannot reuse that challenge either.
  assert.throws(
    () => security.verifyProof({ ...forged, signature: pair.sign(fabricChallengeProofPayload(claims)) }),
    /challenge is unknown or already used/,
  );
});

test("expired challenges, wrong audience, and wrong protocol version fail closed", () => {
  let now = NOW;
  const security = new FabricConnectorSecurity({ audience: AUDIENCE, now: () => now, challengeTtlMs: 1_000 });
  const { pair } = enrolled(security);
  const expired = proofFor(security, "connector-1", pair, 1);
  now += 5_000;
  assert.throws(() => security.verifyProof(expired), /challenge has expired/);

  const wrongAudience = proofFor(security, "connector-1", pair, 1, { audience: "other.example.test" });
  assert.throws(() => security.verifyProof(wrongAudience), /audience does not match this Hub/);

  const wrongVersion = proofFor(security, "connector-1", pair, 1, { protocolVersion: "fabric.v2" });
  assert.throws(() => security.verifyProof(wrongVersion), /protocol version is not supported/);
});

test("rotation revokes the predecessor generation in one step", () => {
  const security = hub();
  const { pair } = enrolled(security);
  const replacement = keyPair();

  const rotated = security.rotate("connector-1", {
    connectorId: "connector-1",
    keyId: "connector-1-key-2",
    publicKey: replacement.publicKey,
    scopes: ["fabric.data.exchange"],
  }, 0);
  assert.equal(rotated.credentialGeneration, 2);
  assert.equal(rotated.keyId, "connector-1-key-2");

  // The old key still signs, and the old generation is refused.
  assert.throws(() => security.verifyProof(proofFor(security, "connector-1", pair, 1)), /superseded credential generation/);
  // The new key with the old generation is refused too, and vice versa.
  assert.throws(
    () => security.verifyProof(proofFor(security, "connector-1", replacement, 1)),
    /superseded credential generation/,
  );
  const accepted = security.verifyProof(proofFor(security, "connector-1", replacement, 2));
  assert.equal(accepted.credentialGeneration, 2);
  // The predecessor's key can no longer prove anything even at the new generation.
  assert.throws(
    () => security.verifyProof(proofFor(security, "connector-1", pair, 2)),
    /signature did not verify/,
  );
});

test("revoked and unknown Connectors are refused without confirming which is which", () => {
  const security = hub();
  const { pair } = enrolled(security);
  security.revoke("connector-1", 0);

  assert.throws(() => security.issueChallenge("connector-1"), /not accepted by this Hub/);
  assert.throws(() => security.verifyProof(proofFor(security, "connector-1", pair, 1)), /not accepted by this Hub/);
  assert.throws(() => security.issueChallenge("connector-never-enrolled"), /not accepted by this Hub/);
});

test("a proof whose challenge belongs to another Connector is refused", () => {
  const security = hub();
  const first = enrolled(security, "connector-1");
  const second = keyPair();
  security.enroll({
    connectorId: "connector-2", keyId: "connector-2-key-1", publicKey: second.publicKey, scopes: ["fabric.data.*"],
  });
  const challenge = security.issueChallenge("connector-2");
  const claims = {
    connectorId: "connector-1",
    instanceNonce: "instance-nonce-1",
    challengeNonce: challenge.challengeNonce,
    protocolVersion: "fabric.v1",
    audience: AUDIENCE,
    credentialGeneration: 1,
  };
  assert.throws(
    () => security.verifyProof({
      version: FABRIC_CHALLENGE_PROOF_VERSION,
      challengeId: challenge.challengeId,
      signature: first.pair.sign(fabricChallengeProofPayload(claims)),
      ...claims,
    }),
    /challenge belongs to another Connector/,
  );
});

test("enrollment refuses legacy scopes, non-Ed25519 keys, and malformed signatures", () => {
  const security = hub();
  const { publicKey } = keyPair();

  assert.throws(
    () => security.enroll({ connectorId: "c-1", keyId: "k-1", publicKey, scopes: ["gateway"] }),
    /must be a Fabric-dedicated scope/,
  );
  assert.throws(
    () => security.enroll({ connectorId: "c-1", keyId: "k-1", publicKey, scopes: ["*"] }),
    /must be a Fabric-dedicated scope/,
  );
  assert.throws(
    () => security.enroll({ connectorId: "c-1", keyId: "k-1", publicKey, scopes: [] }),
    /at least one Fabric grant/,
  );
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(
    () => security.enroll({
      connectorId: "c-1",
      keyId: "k-1",
      publicKey: rsa.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      scopes: ["fabric.data.*"],
    }),
    /must be an Ed25519 public key/,
  );
  assert.throws(
    () => security.enroll({ connectorId: "c-1", keyId: "k-1", publicKey: "not-base64!!", scopes: ["fabric.data.*"] }),
    /must be base64 SPKI DER/,
  );

  const { pair } = enrolled(security, "connector-1");
  const challenge = security.issueChallenge("connector-1");
  assert.throws(
    () => security.verifyProof({
      version: FABRIC_CHALLENGE_PROOF_VERSION,
      challengeId: challenge.challengeId,
      connectorId: "connector-1",
      instanceNonce: "n",
      challengeNonce: challenge.challengeNonce,
      audience: AUDIENCE,
      protocolVersion: "fabric.v1",
      credentialGeneration: 1,
      signature: Buffer.alloc(12).toString("base64"),
    }),
    /64-byte Ed25519 signature/,
  );
  void pair;
});

test("the public projection never exposes key material", () => {
  const security = hub();
  enrolled(security);
  const projected = security.publicCredentialOf("connector-1");
  assert.notEqual(projected, undefined);
  assert.equal("publicKey" in (projected as object), false);
  assert.equal(projected?.connectorId, "connector-1");
  assert.equal(security.publicCredentialOf("connector-unknown"), undefined);
});

test("the proof payload is domain separated and field bound", () => {
  const base = {
    connectorId: "connector-1",
    instanceNonce: "n-1",
    challengeNonce: "c-1",
    protocolVersion: "fabric.v1",
    audience: AUDIENCE,
    credentialGeneration: 1,
  };
  const payload = fabricChallengeProofPayload(base);
  assert.match(payload, /^pi-maestro\.fabric\.connector-proof\.v1\n/);
  for (const field of Object.values(base)) assert.ok(payload.includes(String(field)));
  assert.notEqual(payload, fabricChallengeProofPayload({ ...base, credentialGeneration: 2 }));
  assert.notEqual(payload, fabricChallengeProofPayload({ ...base, audience: "other.example.test" }));
});
