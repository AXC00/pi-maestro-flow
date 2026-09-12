import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FabricContractError } from "pi-maestro-fabric-core/v1";
import { GatewayPairingStore } from "../src/gateway/pairing-store.ts";
import { FabricConnectorSecurity } from "../src/gateway/fabric/security.ts";
import {
  FABRIC_PAIRING_AUDIENCE,
  FabricPairingAdapter,
} from "../src/gateway/fabric/pairing-adapter.ts";

const NOW = 1_000_000;

function publicKey(): string {
  const { publicKey: key } = generateKeyPairSync("ed25519");
  return key.export({ format: "der", type: "spki" }).toString("base64");
}

async function adapter(): Promise<{ adapter: FabricPairingAdapter; pairings: GatewayPairingStore; security: FabricConnectorSecurity }> {
  const root = await mkdtemp(join(tmpdir(), "fabric-pairing-adapter-"));
  const pairings = new GatewayPairingStore({ path: join(root, "pairings.json"), now: () => NOW });
  const security = new FabricConnectorSecurity({ audience: "hub.example.test", now: () => NOW });
  return { adapter: new FabricPairingAdapter({ pairings, security, now: () => NOW }), pairings, security };
}

test("a Fabric-audience pairing enrolls a Connector with its Fabric-dedicated scopes", async () => {
  const harness = await adapter();
  const issued = await harness.pairings.issue({
    audience: FABRIC_PAIRING_AUDIENCE,
    scopes: ["fabric.data.*", "gateway.workspace"],
    ttlMs: 60_000,
  });

  const credential = await harness.adapter.enrollFromPairing({
    pairingId: issued.id,
    connectorId: "connector-1",
    keyId: "key-1",
    publicKey: publicKey(),
  });
  assert.equal(credential.connectorId, "connector-1");
  assert.equal(credential.credentialGeneration, 1);
  // Only the Fabric scopes crossed over; the legacy grant did not.
  assert.deepEqual(credential.scopes, ["fabric.data.*"]);
  assert.equal(harness.adapter.connectorOfPairing(issued.id), "connector-1");
});

test("a legacy Gateway pairing is never upgraded into Fabric authority", async () => {
  const harness = await adapter();
  const legacy = await harness.pairings.issue({ scopes: ["gateway.workspace"], ttlMs: 60_000 });
  await assert.rejects(
    () => harness.adapter.enrollFromPairing({
      pairingId: legacy.id,
      connectorId: "connector-1",
      keyId: "key-1",
      publicKey: publicKey(),
    }),
    (error: FabricContractError) => {
      assert.equal(error.code, "permission_denied");
      assert.match(error.message, /never grants Fabric authority/);
      return true;
    },
  );

  // A Fabric-audience pairing that carries no Fabric scope authorizes nothing.
  const scopeLess = await harness.pairings.issue({
    audience: FABRIC_PAIRING_AUDIENCE,
    scopes: ["gateway.workspace"],
    ttlMs: 60_000,
  });
  await assert.rejects(
    () => harness.adapter.enrollFromPairing({
      pairingId: scopeLess.id,
      connectorId: "connector-2",
      keyId: "key-2",
      publicKey: publicKey(),
    }),
    /no Fabric-dedicated scope/,
  );
});

test("revoked, expired, and unknown pairings are refused", async () => {
  const harness = await adapter();
  const revoked = await harness.pairings.issue({
    audience: FABRIC_PAIRING_AUDIENCE, scopes: ["fabric.data.*"], ttlMs: 60_000,
  });
  await harness.pairings.revoke(revoked.id, { revokedBy: "test" });
  await assert.rejects(
    () => harness.adapter.enrollFromPairing({
      pairingId: revoked.id, connectorId: "connector-1", keyId: "k", publicKey: publicKey(),
    }),
    /pairing is revoked/,
  );

  await assert.rejects(
    () => harness.adapter.enrollFromPairing({
      pairingId: "pairing-never-issued", connectorId: "connector-1", keyId: "k", publicKey: publicKey(),
    }),
    /pairing is not known/,
  );

  let now = NOW;
  const root = await mkdtemp(join(tmpdir(), "fabric-pairing-adapter-"));
  const pairings = new GatewayPairingStore({ path: join(root, "pairings.json"), now: () => now });
  const security = new FabricConnectorSecurity({ audience: "hub.example.test", now: () => now });
  const expiring = new FabricPairingAdapter({ pairings, security, now: () => now });
  const shortLived = await pairings.issue({
    audience: FABRIC_PAIRING_AUDIENCE, scopes: ["fabric.data.*"], ttlMs: 1_000,
  });
  now += 5_000;
  await assert.rejects(
    () => expiring.enrollFromPairing({
      pairingId: shortLived.id, connectorId: "connector-1", keyId: "k", publicKey: publicKey(),
    }),
    /pairing has expired/,
  );
});

test("revoking a pairing revokes both halves", async () => {
  const harness = await adapter();
  const issued = await harness.pairings.issue({
    audience: FABRIC_PAIRING_AUDIENCE, scopes: ["fabric.data.*"], ttlMs: 60_000,
  });
  await harness.adapter.enrollFromPairing({
    pairingId: issued.id, connectorId: "connector-1", keyId: "key-1", publicKey: publicKey(),
  });

  const revoked = await harness.adapter.revokeForPairing(issued.id);
  assert.equal(revoked?.revoked, true);
  assert.equal(harness.security.credentialOf("connector-1")?.revoked, true);
  // The credential can no longer authenticate, and the pairing can no longer enroll.
  assert.throws(() => harness.security.issueChallenge("connector-1"), /not accepted by this Hub/);
  await assert.rejects(
    () => harness.adapter.enrollFromPairing({
      pairingId: issued.id, connectorId: "connector-2", keyId: "key-2", publicKey: publicKey(),
    }),
    /pairing is revoked/,
  );
  assert.equal(harness.adapter.connectorOfPairing(issued.id), undefined);
});
