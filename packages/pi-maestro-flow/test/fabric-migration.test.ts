import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signPayload } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FabricAdmissionManager,
  FabricConnectionManager,
  FabricDirectory,
  FabricMcpMountProvider,
  FabricStoreCoordinator,
  TransportRegistry,
  type FabricAllocatedConnectRequest,
  type FabricAdvertisementSnapshot,
} from "pi-maestro-fabric";
import {
  FABRIC_CONTROL_VERSION,
  FABRIC_STORE_EVENT_VERSION,
  FABRIC_STORE_TRANSACTION_VERSION,
  FabricContractError,
  type FabricChallengeProofV1,
  type FabricConnectRequest,
  type FabricLiveConnection,
  type FabricProtocolLimits,
  type FabricStoreKind,
  type FabricStoreTransactionV1,
  type PublicFabricMountLeaseV1,
} from "pi-maestro-fabric-core/v1";
import { GatewayFabricControlSupport } from "../src/gateway/fabric/control-support.ts";
import { FabricConnectorSecurity, fabricChallengeProofPayload } from "../src/gateway/fabric/security.ts";
import { FABRIC_PAIRING_AUDIENCE, FabricPairingAdapter } from "../src/gateway/fabric/pairing-adapter.ts";
import { FABRIC_ENROLL_SCOPE, FABRIC_PAIRING_PROVIDER, GatewayFabricRegistrationAuthority } from "../src/gateway/fabric/registration.ts";
import { GatewayEventJournal } from "../src/gateway/event-journal.ts";
import { GatewayFabricEventAdapter } from "../src/gateway/fabric/event-adapter.ts";
import { recoverGatewayFabric } from "../src/gateway/fabric/recovery.ts";
import { GatewayFabricStore } from "../src/gateway/fabric/store.ts";
import { GatewayPairingStore } from "../src/gateway/pairing-store.ts";
import { GatewayPolicy } from "../src/gateway/policy.ts";
import { createGatewayPrincipal } from "../src/gateway/principal.ts";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import { WorkspaceRegistry } from "../src/gateway/workspace-registry.ts";
import { GatewayConfigValidationError, normalizeGatewayConfig } from "../src/gateway/config.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";

/**
 * Migration and rollback rules for the Fabric plane.
 *
 * Each rule exists because of a failure mode that is silent rather than loud:
 * a Fabric setting that is quietly ignored, a legacy token that is quietly
 * promoted, or a state file that is quietly replaced with an empty one. The
 * tests therefore assert the refusal, not just the happy path.
 */

const AUDIENCE = "hub.example.test";

function control(action: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: FABRIC_CONTROL_VERSION, action, requestId: `request-${action}`, deadlineAt: Date.now() + 30_000, ...fields };
}

test("Fabric defaults to off, and a Fabric setting named while off is refused instead of ignored", () => {
  // A document that never mentions Fabric must not gain a setting that would
  // read as operator intent on the next load.
  assert.deepEqual(normalizeGatewayConfig({}).fabric, { enabled: false });

  const enabled = normalizeGatewayConfig({
    fabric: { enabled: true, audience: AUDIENCE, limits: { maxFrameBytes: 4096 } },
  });
  assert.equal(enabled.fabric.enabled, true);
  assert.equal(enabled.fabric.audience, AUDIENCE);
  assert.equal(enabled.fabric.limits?.maxFrameBytes, 4096);

  for (const fabric of [
    { enabled: false, audience: AUDIENCE },
    { enabled: false, enrollmentPath: "/tmp/enrollment.json" },
    { enabled: false, limits: { maxFrameBytes: 4096 } },
  ]) {
    assert.throws(
      () => normalizeGatewayConfig({ fabric }),
      (error: unknown) => {
        assert.ok(error instanceof GatewayConfigValidationError);
        assert.match(error.message, /is set while fabric\.enabled is false/);
        return true;
      },
    );
  }

  // Unknown Fabric fields and incoherent limits fail closed rather than being dropped.
  assert.throws(() => normalizeGatewayConfig({ fabric: { enabled: true, listener: "wss://x" } }), /fabric\.listener is not a recognized field/);
  assert.throws(
    () => normalizeGatewayConfig({ fabric: { enabled: true, limits: { heartbeatIntervalMs: 30_000, heartbeatTimeoutMs: 1_000 } } }),
    /heartbeatTimeoutMs must exceed heartbeatIntervalMs/,
  );
});

test("an unknown Gateway config version is refused, never silently re-defaulted", () => {
  assert.throws(() => normalizeGatewayConfig({ version: 3 }), /config\.version must be/);
  assert.throws(() => normalizeGatewayConfig({ version: "fabric" }), /config\.version must be/);
  assert.throws(() => normalizeGatewayConfig({ version: 3, fabric: { enabled: true } }), /config\.version must be/);
});

test("a legacy Gateway token never becomes Fabric authority, and Fabric keeps its own audience and scopes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fabric-migration-pairing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pairings = new GatewayPairingStore({ path: join(root, "pairings.json") });
  const store = new GatewayFabricStore({ path: join(root, "fabric.json") });
  const authority = new GatewayFabricRegistrationAuthority(new FabricStoreCoordinator(store), { audience: AUDIENCE });
  const security = new FabricConnectorSecurity({ audience: AUDIENCE, credentialAuthority: authority });
  const adapter = new FabricPairingAdapter({ pairings, authority, security });

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const request = (token: string, requestId: string) => ({ token, requestId, connectorId: "connector-1", keyId: "key-1", publicKey: spki });

  const legacy = await pairings.issue({ scopes: ["gateway.workspace"], ttlMs: 60_000 });
  await assert.rejects(() => adapter.enrollFromPairing(request(legacy.token, "legacy-request")), /purpose token is invalid/);
  assert.equal((await authority.list()).length, 0);

  const wrongPurpose = await pairings.issue({
    audience: FABRIC_PAIRING_AUDIENCE, scopes: ["fabric.rotate"], provider: FABRIC_PAIRING_PROVIDER,
    instance: "connector-1", ttlMs: 60_000,
  });
  await assert.rejects(() => adapter.enrollFromPairing(request(wrongPurpose.token, "wrong-purpose-request")), /must grant exactly fabric\.enroll/);

  const fabricPairing = await pairings.issue({
    audience: FABRIC_PAIRING_AUDIENCE, scopes: [FABRIC_ENROLL_SCOPE], provider: FABRIC_PAIRING_PROVIDER,
    instance: "connector-1", ttlMs: 60_000,
  });
  const receipt = await adapter.enrollFromPairing(request(fabricPairing.token, "enroll-request"));
  assert.equal(receipt.credentialGeneration, 1);
  const credential = authority.credentialOf("connector-1");
  assert.equal(credential?.audience, AUDIENCE);
  assert.notEqual(credential?.audience, FABRIC_PAIRING_AUDIENCE);
  assert.deepEqual(credential?.scopes, ["fabric.connect"]);

  const challenge = security.issueChallenge("connector-1");
  assert.equal(challenge.audience, AUDIENCE);
  const proof = (target: { challengeId: string; challengeNonce: string; protocolVersion: string }, audience: string): FabricChallengeProofV1 => {
    const claims = { connectorId: "connector-1", instanceNonce: "instance-nonce-1", challengeNonce: target.challengeNonce, protocolVersion: target.protocolVersion, audience, credentialGeneration: receipt.credentialGeneration };
    return { version: "fabric.challenge-proof.v1", challengeId: target.challengeId, ...claims, signature: signPayload(null, Buffer.from(fabricChallengeProofPayload(claims), "utf8"), privateKey).toString("base64") };
  };
  assert.throws(() => security.verifyProof(proof(challenge, "gateway")), /audience does not match this Hub/);
  const fresh = security.issueChallenge("connector-1");
  assert.equal(security.verifyProof(proof(fresh, AUDIENCE)).connectorId, "connector-1");
});

test("a Fabric request while Fabric is disabled fails closed and is never executed as legacy work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fabric-migration-disabled-"));
  const runtime = await GatewayRuntime.create({ config: createTestGatewayConfig(root), cwd: root });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });

  const owner = createGatewayPrincipal("stdio", "owner", { authenticated: true });
  const refused = await runtime.call("device", control("list"), owner);
  assert.equal(refused.ok, false);
  assert.equal(refused.error?.code, "fabric_disabled");

  // The same tool still answers its legacy, unversioned request, so the Fabric
  // refusal is a refusal and not a tool that stopped working.
  const legacy = await runtime.call("workspace", { action: "list" }, owner);
  assert.equal(legacy.ok, true);

  // Refusal happens before any Fabric work is attempted.
  const performed: string[] = [];
  const support = new GatewayFabricControlSupport(undefined, new GatewayPolicy(), runtime.registry);
  const result = await support.execute(
    owner,
    "route",
    control("open", { connectionId: "connection-1", endpointId: "endpoint-1" }),
    () => { performed.push("route.open"); return {}; },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "fabric_disabled");
  assert.deepEqual(performed, []);
});

test("an unknown Fabric store version is refused and the persisted document is never reset to empty", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fabric-migration-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "fabric-state.json");
  const persisted = `${JSON.stringify({ version: 99, revision: 0, stores: {}, outbox: [], transactions: [] }, null, 2)}\n`;
  await writeFile(path, persisted, "utf8");

  const store = new GatewayFabricStore({ path });
  await assert.rejects(() => store.load(), /Unsupported Gateway Fabric store version/);
  // A refusal that rewrote the file would destroy state a future version could
  // still read, so the bytes must survive the refusal untouched.
  assert.equal(await readFile(path, "utf8"), persisted);

  const shapeDrift = `${JSON.stringify({
    version: 1,
    revision: 0,
    stores: { registry: { shapeVersion: 2, storeKind: "registry", revision: 0, records: {}, events: [], cursors: [], highWaterMark: 0 } },
    outbox: [],
    transactions: [],
  }, null, 2)}\n`;
  await writeFile(path, shapeDrift, "utf8");
  await assert.rejects(() => store.load(), /Unsupported Fabric persisted store shape|canonical shapeVersion 1/);
  assert.equal(await readFile(path, "utf8"), shapeDrift);

  // A fresh path is the only way to an empty store.
  const empty = new GatewayFabricStore({ path: join(root, "missing.json") });
  assert.equal((await empty.load()).revision, 0);
});

const limits: FabricProtocolLimits = {
  maxFrameBytes: 256 * 1024,
  maxInFlightOperations: 32,
  heartbeatIntervalMs: 10_000,
  heartbeatTimeoutMs: 30_000,
  maxAdvertisementItems: 1_024,
  maxResultBytes: 1024 * 1024,
};

function advertisement(connectionId: string, generation: number): FabricAdvertisementSnapshot {
  return {
    connectionId,
    connectionGeneration: generation,
    capabilityDigest: "capability-digest-1",
    advertisementRevision: 1,
    devices: [{
      deviceId: "device-1", label: "Device One", connectorId: "connector-1", connectionMode: "https",
      platform: "linux", architecture: "x64", enabled: true, revision: 1,
    }],
    workspaces: [{
      workspaceId: "fabric-workspace-1", deviceId: "device-1", localWorkspaceId: "local-workspace-1", label: "Workspace One",
      mode: "permanent", generation: 1, policyDigest: "policy-digest-1", endpointIds: ["endpoint-1"], revision: 1,
    }],
    endpoints: [{
      endpointId: "endpoint-1", deviceId: "device-1", connectorId: "connector-1",
      scope: { kind: "workspace", workspaceId: "fabric-workspace-1" }, generation: 1,
      contractHash: "contract-hash-1", status: "online", revision: 1, kind: "mcp",
      serverName: "source-mcp", protocolVersion: "2025-11-25", transport: "streamable-http", durableDeduplication: false,
    }],
    capabilities: [{
      capabilityId: "capability-1", kind: "tool", endpointId: "endpoint-1",
      contractHash: "contract-hash-1", trustLevel: "paired", priority: 10,
    }],
  };
}

test("rollback stops admission, fences and drains, unmounts, closes the Connector, and only then disables Fabric", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fabric-migration-rollback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let sequence = 0;
  const store = new GatewayFabricStore({ path: join(root, "fabric-state.json") });
  const coordinator = new FabricStoreCoordinator(store, { createId: () => `fabric-store-${++sequence}` });
  const directory = new FabricDirectory();
  directory.seedAuthority({
    connector: {
      connectorId: "connector-1", label: "Connector One", transport: "direct-https",
      credentialGeneration: 1, instanceNonce: "connector-nonce-1", enabled: true, revision: 1,
    },
    devices: [{
      deviceId: "device-1", label: "Device One", connectorId: "connector-1", connectionMode: "https",
      platform: "linux", architecture: "x64", enabled: true, revision: 1,
    }],
  });
  const closes: string[] = [];
  const transports = new TransportRegistry();
  transports.register({
    kind: "direct-https",
    async connect(request: FabricConnectRequest): Promise<FabricLiveConnection> {
      const allocated = request as FabricAllocatedConnectRequest;
      return {
        descriptor: {
          protocolVersion: "fabric.v1",
          limits,
          lease: {
            connectionId: allocated.allocatedConnectionId,
            deviceId: request.deviceId,
            connectorId: request.connectorId,
            connectorInstanceNonce: "connector-nonce-1",
            generation: allocated.allocatedConnectionGeneration,
            state: "connected",
            capabilityDigest: "capability-digest-1",
            establishedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
            revision: 0,
          },
        },
        exchange: async (envelope) => envelope,
        close: async (reason) => { closes.push(reason); },
      };
    },
  });
  const connections = new FabricConnectionManager(directory, transports, { coordinator });
  const admissions = new FabricAdmissionManager(directory, connections, { coordinator });
  const mounts = new FabricMcpMountProvider({
    sessionId: "session-1",
    routes: admissions,
    connections,
    endpoints: directory,
    createMountId: () => `mount-${++sequence}`,
  });

  const signal = new AbortController().signal;
  const lease = await connections.connect({
    requestId: "request-connect",
    deviceId: "device-1",
    connectorId: "connector-1",
    expectedCredentialGeneration: 1,
    deadlineAt: Date.now() + 30_000,
    limits,
  }, signal);
  connections.acceptAdvertisement(advertisement(lease.connectionId, lease.generation));

  const now = Date.now();
  const binding = await admissions.bindDurable({
    bindingId: "binding-1",
    connectionId: lease.connectionId,
    deviceId: "device-1",
    workspaceId: "fabric-workspace-1",
    connectionGeneration: lease.generation,
    workspaceGeneration: 1,
    policyDigest: "policy-digest-1",
    issuedAt: now,
    expiresAt: lease.expiresAt,
    revision: 0,
  });
  const route = await admissions.openRouteDurable({
    routeId: "route-1",
    connectionId: lease.connectionId,
    workspaceBindingId: binding.bindingId,
    workspaceGeneration: 1,
    endpointId: "endpoint-1",
    connectionGeneration: lease.generation,
    endpointGeneration: 1,
    issuedAt: now,
    expiresAt: lease.expiresAt,
    state: "open",
    revision: 0,
    deviceId: "device-1",
    operationClass: "mcp-read",
    pathCandidates: ["hub"],
    selectedPath: "hub",
  });
  const mount = await mounts.mount(route, signal);
  assert.equal(mount.providerNamespace, "fabric");

  const timeline: string[] = [];

  // 1. Admission stop: no new Fabric work may be admitted from here on, and the
  // Connector is still connected so the drain that follows has something to hold.
  await admissions.unbind(binding.bindingId, binding.revision);
  const stopped = await admissions.closeRoute(route.routeId, route.revision);
  assert.equal(stopped.state, "closed");
  assert.throws(() => admissions.validateRoute(route.routeId), /Route must be open/);
  assert.equal(connections.get(lease.connectionId)?.state, "connected");
  timeline.push("admission-stop");

  // 2. Fence and drain: the connection leaves readiness before it is closed, and
  // admission cannot be reopened on a draining Connector.
  const draining = connections.drain(lease.connectionId, lease.generation, Date.now() + 2_000);
  assert.equal(draining.state, "draining");
  // The admit gate both managers share refuses a draining Connector, so no route
  // can be reopened behind the drain.
  assert.throws(
    () => connections.requireReadyForDevice(lease.connectionId, lease.generation, "device-1"),
    (error: FabricContractError) => {
      assert.ok(["invalid_state", "stale_generation"].includes(error.code), error.code);
      return true;
    },
  );
  await assert.rejects(
    () => admissions.bindDurable({ ...binding, bindingId: "binding-2", revision: 0 }),
    (error: FabricContractError) => {
      assert.ok(["invalid_state", "stale_generation"].includes(error.code), error.code);
      return true;
    },
  );
  timeline.push("fence-drain");

  // 3. Unmount: the mount is retired while the Connector is still open, so the
  // cleanup is a deliberate hand-off rather than a reaction to a dropped socket.
  const cleaned: PublicFabricMountLeaseV1[] = [];
  await mounts.unmount(mount.mountId, (lease) => { cleaned.push(lease); });
  assert.equal(mounts.get(mount.mountId)?.state, "closed");
  assert.deepEqual(cleaned.map((entry) => entry.mountId), [mount.mountId]);
  assert.deepEqual(closes, [], "the Connector must still be open when the mount is retired");
  timeline.push("unmount");

  // 4. Connector close: last observable Fabric step before the plane is disabled.
  const closed = await connections.disconnect(lease.connectionId, lease.generation, "rollback");
  assert.equal(closed.state, "closed");
  assert.deepEqual(closes, ["rollback"]);
  timeline.push("connector-close");

  // 5. Disable: only now is Fabric control unavailable, and it is unavailable as
  // Fabric — never as a legacy fallback that would run the request anyway.
  const performed: string[] = [];
  const support = new GatewayFabricControlSupport(
    undefined,
    new GatewayPolicy(),
    new WorkspaceRegistry({ path: join(root, "workspaces.json") }),
  );
  const refused = await support.execute(
    createGatewayPrincipal("stdio", "owner", { authenticated: true }),
    "route",
    control("open", { connectionId: lease.connectionId, endpointId: "endpoint-1" }),
    () => { performed.push("route.open"); return {}; },
  );
  assert.equal(refused.ok, false);
  assert.equal(refused.error?.code, "fabric_disabled");
  assert.deepEqual(performed, []);
  timeline.push("disable");

  assert.deepEqual(timeline, ["admission-stop", "fence-drain", "unmount", "connector-close", "disable"]);
  // The retired mount is gone rather than converted into a live legacy server.
  assert.deepEqual(mounts.list().filter((entry) => entry.state !== "closed"), []);
});

test("an interrupted Fabric invocation is fenced to outcome-unknown and never re-run or handed to legacy execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fabric-migration-fence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new GatewayFabricStore({ path: join(root, "state.json") });

  const transaction = (input: {
    id: string;
    kind: FabricStoreKind;
    subjectId: string;
    value: Record<string, string | number | boolean>;
  }): FabricStoreTransactionV1 => ({
    version: FABRIC_STORE_TRANSACTION_VERSION,
    transactionId: input.id,
    storeKind: input.kind,
    expectedRevision: 0,
    nextRevision: 1,
    committedAt: 100,
    mutations: [{ kind: "upsert", subjectId: input.subjectId, value: input.value }],
    events: [{
      version: FABRIC_STORE_EVENT_VERSION,
      eventId: `${input.id}-event`,
      storeKind: input.kind,
      sequence: 1,
      eventKind: "record.updated",
      subjectId: input.subjectId,
      subjectRevision: Number(input.value.revision),
      occurredAt: 100,
      payload: {},
    }],
  });

  await store.transact(transaction({
    id: "connection-start",
    kind: "lease",
    subjectId: "connection-1",
    value: {
      revision: 1, connectionId: "connection-1", connectorId: "connector-1", connectorInstanceNonce: "instance-1",
      generation: 1, state: "connected", capabilityDigest: "capability-digest-1", establishedAt: 10, expiresAt: 1_000,
    },
  }));
  await store.transact(transaction({
    id: "invocation-start",
    kind: "invocation",
    subjectId: "operation-1",
    value: {
      revision: 1, operationId: "operation-1", routeId: "route-1", endpointId: "endpoint-1",
      connectionGeneration: 1, endpointGeneration: 1, state: "running", replayClass: "non-replayable", updatedAt: 700,
    },
  }));

  const journal = new GatewayEventJournal();
  const recovered = await recoverGatewayFabric({
    store,
    eventAdapter: new GatewayFabricEventAdapter({ store, journal }),
    now: () => 500,
  });
  assert.equal(recovered.outcomeUnknownReceipts, 1);

  const invocation = await store.get("invocation", "operation-1");
  // The commit outcome is unknowable, so it is reported as such: re-running it
  // would duplicate a mutation, and dropping it would lose the receipt.
  assert.equal(invocation?.state, "outcome-unknown");
  assert.equal(invocation?.replayClass, "non-replayable");
  assert.equal((await store.get("lease", "connection-1"))?.state, "closed");

  const appended = (await store.pageEvents("invocation", 0, 10)).events.map((event) => event);
  assert.deepEqual(appended.map((event) => event.eventKind), ["record.updated", "invocation.outcome-unknown"]);
  const recoveryEvents = appended.filter((event) => event.eventKind === "invocation.outcome-unknown");
  assert.equal(recoveryEvents.length, 1);
  assert.equal((recoveryEvents[0]!.payload as { recovery?: unknown }).recovery, true, "recovery appends only fence events");
  // No step re-enters the operation as a legacy run.
  assert.equal(appended.some((event) => event.eventKind.startsWith("legacy")), false);
});
