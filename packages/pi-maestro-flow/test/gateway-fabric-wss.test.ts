import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { join } from "node:path";
import { generateKeyPairSync, sign as signPayload, type KeyObject } from "node:crypto";
import WebSocket from "ws";
import { FABRIC_PROTOCOL_VERSION } from "pi-maestro-fabric-core/v1";
import { FabricConnectorSecurity, fabricChallengeProofPayload } from "../src/gateway/fabric/security.ts";
import { FabricConnectorRuntime } from "../src/gateway/fabric/connector-runtime.ts";
import {
  FABRIC_WSS_PATH,
  FabricWssServer,
  type FabricWssAuthority,
  type FabricWssServerOptions,
} from "../src/gateway/fabric/wss-server.ts";

const AUDIENCE = "hub.example.test";
const CONNECTOR = "connector-1";
const certificatePath = join(import.meta.dirname, "fixtures", "fabric-test-cert.pem");
const keyPath = join(import.meta.dirname, "fixtures", "fabric-test-key.pem");

interface Harness {
  hub: FabricWssServer;
  security: FabricConnectorSecurity;
  url: string;
  ca: Buffer;
  listener: HttpsServer;
  close(): Promise<void>;
}

async function harness(
  limits: { heartbeatIntervalMs: number; heartbeatTimeoutMs: number; maxFrameBytes?: number; maxInFlightOperations?: number },
  authority?: FabricWssAuthority,
  onSessionClosed?: () => void | Promise<void>,
  callbacks: Pick<FabricWssServerOptions, "onReady" | "onAdvertisement"> = {},
): Promise<Harness> {
  const ca = await readFile(certificatePath);
  const key = await readFile(keyPath);
  const listener = createHttpsServer({ cert: ca, key });
  await new Promise<void>((resolve) => listener.listen(0, "localhost", resolve));
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("no listener address");
  const security = new FabricConnectorSecurity({ audience: AUDIENCE });
  const hub = new FabricWssServer({ security, server: listener, limits, drainTimeoutMs: 200, authority, onSessionClosed, ...callbacks });
  hub.start();
  return {
    hub,
    security,
    url: `wss://localhost:${address.port}${FABRIC_WSS_PATH}`,
    ca,
    listener,
    async close(): Promise<void> {
      await hub.close();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    },
  };
}

function connectorIdentity(): { publicKey: string; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"), privateKey };
}

/** A raw client so a test can send exactly the frames it means to send. */
function rawClient(url: string, ca: Buffer): {
  socket: WebSocket;
  received: Record<string, unknown>[];
  send(envelope: Record<string, unknown>): void;
  sendRaw(text: string): void;
  waitFor(kind: string): Promise<Record<string, unknown>>;
  closed: Promise<number>;
} {
  const socket = new WebSocket(url, { ca });
  const received: Record<string, unknown>[] = [];
  const waiters: Array<{ kind: string; resolve: (envelope: Record<string, unknown>) => void }> = [];
  socket.on("message", (data) => {
    const envelope = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data)) as Record<string, unknown>;
    received.push(envelope);
    for (const waiter of [...waiters]) {
      if (waiter.kind === envelope.kind) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(envelope);
      }
    }
  });
  const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
  return {
    socket,
    received,
    send: (envelope) => socket.send(JSON.stringify(envelope)),
    sendRaw: (text) => socket.send(text),
    waitFor: (kind) => new Promise((resolve) => {
      const existing = received.find((envelope) => envelope.kind === kind);
      if (existing !== undefined) return resolve(existing);
      waiters.push({ kind, resolve });
    }),
    closed,
  };
}

function envelope(kind: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: FABRIC_PROTOCOL_VERSION, messageId: `m-${kind}-${Math.random().toString(36).slice(2)}`, kind, sentAt: Date.now(), payload, ...extra };
}

function authorityStub(overrides: Partial<FabricWssAuthority> = {}): FabricWssAuthority {
  return {
    admit: async (input) => ({
      connectionId: "manager-connection-1",
      deviceId: "device-1",
      connectorId: input.connectorId,
      generation: 1,
      state: "connected",
      capabilityDigest: input.capabilityDigest,
      establishedAt: input.establishedAt,
      expiresAt: input.expiresAt,
      revision: 0,
    }),
    acceptSnapshot: async () => undefined,
    acceptDelta: async () => undefined,
    heartbeat: async () => undefined,
    drain: async () => undefined,
    close: async () => undefined,
    ...overrides,
  };
}

/** Drive a raw client through hello and proof; returns the accepted generation. */
async function admit(
  client: ReturnType<typeof rawClient>,
  identity: { privateKey: KeyObject },
  instanceNonce: string,
  clientLimits: Record<string, number> = {
    maxFrameBytes: 256 * 1024,
    maxInFlightOperations: 32,
    heartbeatIntervalMs: 1_000,
    heartbeatTimeoutMs: 5_000,
    maxAdvertisementItems: 1_024,
    maxResultBytes: 1024 * 1024,
  },
): Promise<number> {
  client.send(envelope("client_hello", {
    connectorId: CONNECTOR,
    keyId: "k-1",
    instanceNonce,
    credentialGeneration: 1,
    supportedVersions: [FABRIC_PROTOCOL_VERSION],
    capabilityDigest: "d",
    limits: clientLimits,
  }));
  const challenge = await client.waitFor("server_challenge");
  const payload = challenge.payload as Record<string, unknown>;
  const claims = {
    connectorId: CONNECTOR,
    instanceNonce,
    challengeNonce: String(payload.challengeNonce),
    protocolVersion: String(payload.protocolVersion),
    audience: String(payload.audience),
    credentialGeneration: 1,
  };
  client.send(envelope("client_proof", {
    challengeId: String(payload.challengeId),
    ...claims,
    signature: signPayload(null, Buffer.from(fabricChallengeProofPayload(claims), "utf8"), identity.privateKey).toString("base64"),
  }));
  const accepted = await client.waitFor("connection_accepted");
  return (accepted.payload as Record<string, unknown>).connectionGeneration as number;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not reached within the bounded wait");
}

test("a real TLS WSS Connector completes enrollment proof, advertises, and reaches ready", async () => {
  const harnessed = await harness({ heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 5_000 });
  try {
    const identity = connectorIdentity();
    harnessed.security.enroll({ connectorId: CONNECTOR, keyId: "k-1", publicKey: identity.publicKey, scopes: ["fabric.data.*"] });

    const ready: Array<{ connectionId: string; connectionGeneration: number; advertisementRevision: number }> = [];
    const runtime = new FabricConnectorRuntime({
      url: harnessed.url,
      connectorId: CONNECTOR,
      keyId: "k-1",
      audience: AUDIENCE,
      credentialGeneration: 1,
      ca: harnessed.ca,
      limits: { heartbeatIntervalMs: 50, heartbeatTimeoutMs: 5_000 },
      sign: (payload) => signPayload(null, Buffer.from(payload, "utf8"), identity.privateKey).toString("base64"),
      advertisementOf: () => ({ advertisementRevision: 1, capabilityDigest: "digest-1", payload: { devices: [] } }),
      onReady: (info) => ready.push(info),
    });

    await runtime.start();
    assert.equal(runtime.state, "ready");
    assert.equal(runtime.connectionGeneration, 1);
    assert.equal(ready.length, 1);
    assert.equal(ready[0]?.advertisementRevision, 1);

    // Heartbeats keep the lease, so the Hub still holds this session as current.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(harnessed.hub.sessionOf(CONNECTOR)?.current, true);
    assert.equal(harnessed.hub.sessionOf(CONNECTOR)?.state, "ready");

    await runtime.stop("test complete");
    assert.equal(runtime.state, "closed");
    // The Hub retires the session when the socket closes, which is a separate
    // event from the Connector's own stop resolving.
    await waitUntil(() => harnessed.hub.sessionOf(CONNECTOR) === undefined);
  } finally {
    await harnessed.close();
  }
});

test("authority allocation and serialized acceptance gate ready and heartbeat ACKs", async () => {
  let releaseSnapshot!: () => void;
  const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  let releaseHeartbeat!: () => void;
  const heartbeatGate = new Promise<void>((resolve) => { releaseHeartbeat = resolve; });
  const calls: string[] = [];
  const authority: FabricWssAuthority = {
    admit: async (input) => {
      calls.push(`admit:${input.connectorId}:${input.capabilityDigest}`);
      return {
        connectionId: "manager-connection-7", deviceId: "device-7", connectorId: input.connectorId,
        generation: 7, state: "connected", capabilityDigest: input.capabilityDigest,
        establishedAt: input.establishedAt, expiresAt: input.expiresAt, revision: 0,
      };
    },
    acceptSnapshot: async (_session, payload) => {
      calls.push(`snapshot:${String(payload.advertisementRevision)}`);
      await snapshotGate;
    },
    acceptDelta: async () => { calls.push("delta"); },
    heartbeat: async (_session, input) => {
      calls.push(`heartbeat:${input.sequence}`);
      await heartbeatGate;
    },
    drain: async () => { calls.push("drain"); },
    close: async (session) => { calls.push(`close:${session.connectionId}:${session.connectionGeneration}`); },
  };
  const harnessed = await harness({ heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 5_000 }, authority);
  try {
    const identity = connectorIdentity();
    harnessed.security.enroll({ connectorId: CONNECTOR, keyId: "k-1", publicKey: identity.publicKey, scopes: ["fabric.data.*"] });
    const client = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => client.socket.on("open", () => resolve()));
    const generation = await admit(client, identity, "instance-authority");
    assert.equal(generation, 7);
    const accepted = client.received.find((entry) => entry.kind === "connection_accepted")!;
    const acceptedPayload = accepted.payload as Record<string, unknown>;
    assert.equal(acceptedPayload.connectionId, "manager-connection-7");
    assert.deepEqual(acceptedPayload.lease, {
      connectionId: "manager-connection-7", deviceId: "device-7", connectorId: CONNECTOR,
      generation: 7, state: "connected", capabilityDigest: "d",
      establishedAt: (acceptedPayload.lease as Record<string, unknown>).establishedAt,
      expiresAt: (acceptedPayload.lease as Record<string, unknown>).expiresAt,
      revision: 0,
    });

    client.send(envelope("advertise_snapshot", {
      advertisementRevision: 1, capabilityDigest: "d", devices: [], workspaces: [], endpoints: [], capabilities: [],
    }));
    await waitUntil(() => calls.includes("snapshot:1"));
    assert.equal(client.received.some((entry) => entry.kind === "ready"), false);
    releaseSnapshot();
    const readyEnvelope = await client.waitFor("ready");
    assert.equal(
      typeof (readyEnvelope.payload as Record<string, unknown>).leaseExpiresAt,
      "number",
    );

    client.send(envelope("heartbeat", { sequence: 1, observedAt: Date.now() }, {
      connectionId: "manager-connection-7", connectionGeneration: 7,
    }));
    await waitUntil(() => calls.includes("heartbeat:1"));
    assert.equal(client.received.some((entry) => entry.kind === "heartbeat_ack"), false);
    releaseHeartbeat();
    await client.waitFor("heartbeat_ack");
    client.socket.close();
    await client.closed;
    await waitUntil(() => calls.includes("close:manager-connection-7:7"));
    assert.deepEqual(calls.slice(0, 3), ["admit:connector-1:d", "snapshot:1", "heartbeat:1"]);
  } finally {
    await harnessed.close();
  }
});

test("binary, oversized, and out-of-state frames are refused before any handler runs", async () => {
  const harnessed = await harness({ heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 5_000 });
  try {
    const identity = connectorIdentity();
    harnessed.security.enroll({ connectorId: CONNECTOR, keyId: "k-1", publicKey: identity.publicKey, scopes: ["fabric.data.*"] });

    // A kind the current state does not accept.
    const wrongKind = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => wrongKind.socket.on("open", () => resolve()));
    wrongKind.send(envelope("heartbeat", { sequence: 1, observedAt: Date.now() }));
    const refusal = await wrongKind.waitFor("error");
    assert.equal((refusal.payload as Record<string, unknown>).code, "invalid_state");
    assert.equal(await wrongKind.closed, 1008);

    // A binary frame.
    const binary = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => binary.socket.on("open", () => resolve()));
    binary.socket.send(Buffer.from([1, 2, 3]));
    assert.equal((((await binary.waitFor("error")).payload as Record<string, unknown>).code), "protocol_violation");
    assert.equal(await binary.closed, 1003);

    // Malformed JSON and an unknown message kind both fail as protocol errors.
    const malformed = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => malformed.socket.on("open", () => resolve()));
    malformed.sendRaw("{not json");
    assert.equal((((await malformed.waitFor("error")).payload as Record<string, unknown>).code), "protocol_violation");
    assert.equal(await malformed.closed, 1008);

    const unknownKind = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => unknownKind.socket.on("open", () => resolve()));
    unknownKind.send(envelope("teleport", {}));
    assert.equal((((await unknownKind.waitFor("error")).payload as Record<string, unknown>).code), "protocol_violation");
    assert.equal(await unknownKind.closed, 1008);
  } finally {
    await harnessed.close();
  }
});

test("an oversized frame is refused as a resource error", async () => {
  const harnessed = await harness({ heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 5_000 });
  try {
    const oversized = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => oversized.socket.on("open", () => resolve()));
    oversized.sendRaw(JSON.stringify({ padding: "x".repeat(300 * 1024) }));
    // The peer may see the refusal or the transport's own payload rejection;
    // either way the session never becomes ready.
    await oversized.closed;
    assert.equal(harnessed.hub.sessionOf(CONNECTOR), undefined);
  } finally {
    await harnessed.close();
  }
});

test("a lapsed heartbeat lease fences the generation, and a reconnect is a new one", async () => {
  const harnessed = await harness({ heartbeatIntervalMs: 20, heartbeatTimeoutMs: 60 });
  try {
    const identity = connectorIdentity();
    harnessed.security.enroll({ connectorId: CONNECTOR, keyId: "k-1", publicKey: identity.publicKey, scopes: ["fabric.data.*"] });

    const first = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => first.socket.on("open", () => resolve()));
    const firstGeneration = await admit(first, identity, "instance-1");
    first.send(envelope("advertise_snapshot", { advertisementRevision: 1, capabilityDigest: "d" }));
    await first.waitFor("ready");
    assert.equal(firstGeneration, 1);

    // Go silent: the Hub must expire the lease rather than keep the session.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(harnessed.hub.sessionOf(CONNECTOR), undefined, "an expired lease stayed live");

    const second = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => second.socket.on("open", () => resolve()));
    const secondGeneration = await admit(second, identity, "instance-2");
    assert.equal(secondGeneration, 2, "a reconnect reused the fenced generation");

    // The fenced generation cannot renew its lease any more.
    first.send(envelope("heartbeat", { sequence: 1, observedAt: Date.now() }, {
      connectionId: `connection-${CONNECTOR}-1`, connectionGeneration: 1,
    }));
    await first.closed;
    assert.equal(harnessed.hub.sessionOf(CONNECTOR)?.connectionGeneration, 2);
  } finally {
    await harnessed.close();
  }
});

test("a stale heartbeat generation is refused with a stale_generation error", async () => {
  const harnessed = await harness({ heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 5_000 });
  try {
    const identity = connectorIdentity();
    harnessed.security.enroll({ connectorId: CONNECTOR, keyId: "k-1", publicKey: identity.publicKey, scopes: ["fabric.data.*"] });
    const client = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => client.socket.on("open", () => resolve()));
    const generation = await admit(client, identity, "instance-1");
    client.send(envelope("advertise_snapshot", { advertisementRevision: 1, capabilityDigest: "d" }));
    await client.waitFor("ready");

    client.send(envelope("heartbeat", { sequence: 1, observedAt: Date.now() }, {
      connectionId: `connection-${CONNECTOR}-${generation}`, connectionGeneration: generation + 1,
    }));
    const refusal = await client.waitFor("error");
    assert.equal((refusal.payload as Record<string, unknown>).code, "stale_generation");
  } finally {
    await harnessed.close();
  }
});

test("a delta against an unknown revision asks for a snapshot instead of merging", async () => {
  const harnessed = await harness({ heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 5_000 });
  try {
    const identity = connectorIdentity();
    harnessed.security.enroll({ connectorId: CONNECTOR, keyId: "k-1", publicKey: identity.publicKey, scopes: ["fabric.data.*"] });
    const client = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => client.socket.on("open", () => resolve()));
    await admit(client, identity, "instance-1");
    client.send(envelope("advertise_snapshot", { advertisementRevision: 2, capabilityDigest: "d" }));
    await client.waitFor("ready");

    client.send(envelope("advertise_delta", { baseRevision: 1, advertisementRevision: 3, capabilityDigest: "d" }));
    const refusal = await client.waitFor("error");
    assert.equal((refusal.payload as Record<string, unknown>).code, "conflict");
    assert.match(String((refusal.payload as Record<string, unknown>).message), /resend a snapshot/);
    assert.equal(harnessed.hub.sessionOf(CONNECTOR)?.advertisementRevision, 2);

    client.send(envelope("advertise_delta", { baseRevision: 2, advertisementRevision: 3, capabilityDigest: "d" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(harnessed.hub.sessionOf(CONNECTOR)?.advertisementRevision, 3);
  } finally {
    await harnessed.close();
  }
});

test("fatal admission failures locally finalize the socket and redact bounded correlated errors", async () => {
  const authority = authorityStub({ admit: async () => { throw new Error(`C:\\private\\token-${"x".repeat(2_000)}`); } });
  const harnessed = await harness({ heartbeatIntervalMs: 20, heartbeatTimeoutMs: 60 }, authority);
  try {
    const identity = connectorIdentity();
    harnessed.security.enroll({ connectorId: CONNECTOR, keyId: "k-1", publicKey: identity.publicKey, scopes: ["fabric.data.*"] });
    const client = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => client.socket.on("open", () => resolve()));
    client.send(envelope("client_hello", {
      connectorId: CONNECTOR, instanceNonce: "fatal-nonce", credentialGeneration: 1,
      supportedVersions: [FABRIC_PROTOCOL_VERSION], capabilityDigest: "d",
      limits: { maxFrameBytes: 4096, maxInFlightOperations: 4, heartbeatIntervalMs: 20,
        heartbeatTimeoutMs: 60, maxAdvertisementItems: 10, maxResultBytes: 4096 },
    }));
    const challenge = await client.waitFor("server_challenge");
    const challengePayload = challenge.payload as Record<string, unknown>;
    const claims = {
      connectorId: CONNECTOR, instanceNonce: "fatal-nonce",
      challengeNonce: String(challengePayload.challengeNonce), protocolVersion: String(challengePayload.protocolVersion),
      audience: String(challengePayload.audience), credentialGeneration: 1,
    };
    client.send({
      ...envelope("client_proof", {
        challengeId: String(challengePayload.challengeId), ...claims,
        signature: signPayload(null, Buffer.from(fabricChallengeProofPayload(claims), "utf8"), identity.privateKey).toString("base64"),
      }),
      messageId: "proof-correlation-1",
    });
    const failure = await client.waitFor("error");
    const failurePayload = failure.payload as Record<string, unknown>;
    assert.equal(failure.correlationId, "proof-correlation-1");
    assert.equal(failurePayload.code, "unavailable");
    assert.equal(failurePayload.message, "Fabric authority operation failed");
    assert.equal(String(failurePayload.message).includes("private"), false);
    await client.closed;
    assert.equal(harnessed.hub.sessions().length, 0);
  } finally {
    await harnessed.close();
  }
});

test("connecting, challenged, and connected sessions expire and connected heartbeats are forbidden", async () => {
  const harnessed = await harness({ heartbeatIntervalMs: 20, heartbeatTimeoutMs: 60 });
  try {
    const identity = connectorIdentity();
    harnessed.security.enroll({ connectorId: CONNECTOR, keyId: "k-1", publicKey: identity.publicKey, scopes: ["fabric.data.*"] });

    const connecting = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => connecting.socket.on("open", () => resolve()));
    assert.equal(await connecting.closed, 1000);

    const challenged = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => challenged.socket.on("open", () => resolve()));
    challenged.send(envelope("client_hello", {
      connectorId: CONNECTOR, instanceNonce: "challenge-timeout", credentialGeneration: 1,
      supportedVersions: [FABRIC_PROTOCOL_VERSION], capabilityDigest: "d",
      limits: { maxFrameBytes: 4096, maxInFlightOperations: 4, heartbeatIntervalMs: 20,
        heartbeatTimeoutMs: 60, maxAdvertisementItems: 10, maxResultBytes: 4096 },
    }));
    await challenged.waitFor("server_challenge");
    assert.equal(await challenged.closed, 1000);

    const connected = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => connected.socket.on("open", () => resolve()));
    const generation = await admit(connected, identity, "connected-timeout");
    assert.equal(generation, 1);
    assert.equal(await connected.closed, 1000);

    const noRenewal = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => noRenewal.socket.on("open", () => resolve()));
    const nextGeneration = await admit(noRenewal, identity, "connected-no-heartbeat");
    noRenewal.send(envelope("heartbeat", { sequence: 1, observedAt: Date.now() }, {
      connectionId: `connection-${CONNECTOR}-${nextGeneration}`, connectionGeneration: nextGeneration,
    }));
    assert.equal(((await noRenewal.waitFor("error")).payload as Record<string, unknown>).code, "invalid_state");
    assert.equal(await noRenewal.closed, 1008);
  } finally {
    await harnessed.close();
  }
});

test("hello/proof fields are exact, challenges are socket-bound, and negotiated frame limits are enforced", async () => {
  const harnessed = await harness({ heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 5_000 });
  try {
    const identity = connectorIdentity();
    harnessed.security.enroll({ connectorId: CONNECTOR, keyId: "k-1", publicKey: identity.publicKey, scopes: ["fabric.data.*"] });
    const malformed = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => malformed.socket.on("open", () => resolve()));
    malformed.send(envelope("client_hello", {
      connectorId: CONNECTOR, instanceNonce: "bad-hello", credentialGeneration: "1",
      supportedVersions: [], capabilityDigest: "d", limits: { maxFrameBytes: "1024" },
    }));
    assert.equal(((await malformed.waitFor("error")).payload as Record<string, unknown>).code, "invalid_argument");
    await malformed.closed;

    const first = rawClient(harnessed.url, harnessed.ca);
    const second = rawClient(harnessed.url, harnessed.ca);
    await Promise.all([
      new Promise<void>((resolve) => first.socket.on("open", () => resolve())),
      new Promise<void>((resolve) => second.socket.on("open", () => resolve())),
    ]);
    const helloLimits = { maxFrameBytes: 1024, maxInFlightOperations: 4, heartbeatIntervalMs: 20,
      heartbeatTimeoutMs: 60, maxAdvertisementItems: 10, maxResultBytes: 1024 };
    first.send(envelope("client_hello", { connectorId: CONNECTOR, instanceNonce: "socket-1", credentialGeneration: 1,
      supportedVersions: [FABRIC_PROTOCOL_VERSION], capabilityDigest: "d", limits: helloLimits }));
    second.send(envelope("client_hello", { connectorId: CONNECTOR, instanceNonce: "socket-2", credentialGeneration: 1,
      supportedVersions: [FABRIC_PROTOCOL_VERSION], capabilityDigest: "d", limits: helloLimits }));
    const firstChallenge = await first.waitFor("server_challenge");
    await second.waitFor("server_challenge");
    const firstPayload = firstChallenge.payload as Record<string, unknown>;
    const firstClaims = { connectorId: CONNECTOR, instanceNonce: "socket-1",
      challengeNonce: String(firstPayload.challengeNonce), protocolVersion: String(firstPayload.protocolVersion),
      audience: String(firstPayload.audience), credentialGeneration: 1 };
    second.send(envelope("client_proof", {
      challengeId: String(firstPayload.challengeId), ...firstClaims,
      signature: signPayload(null, Buffer.from(fabricChallengeProofPayload(firstClaims), "utf8"), identity.privateKey).toString("base64"),
    }));
    assert.equal(((await second.waitFor("error")).payload as Record<string, unknown>).code, "unauthenticated");
    await second.closed;
    first.socket.close();
    await first.closed;

    const limited = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => limited.socket.on("open", () => resolve()));
    await admit(limited, identity, "limited-frame", helloLimits);
    const accepted = limited.received.find((entry) => entry.kind === "connection_accepted")!;
    const acceptedLimits = (accepted.payload as Record<string, unknown>).limits as Record<string, unknown>;
    assert.equal(acceptedLimits.maxFrameBytes, 1024);
    assert.equal(acceptedLimits.heartbeatIntervalMs, 20);
    limited.sendRaw(JSON.stringify(envelope("advertise_snapshot", {
      advertisementRevision: 1, capabilityDigest: "d", padding: "x".repeat(2_000),
    })));
    await limited.closed;
  } finally {
    await harnessed.close();
  }
});

test("Connector drain is admitted by manager authority before WSS enters draining", async () => {
  const drains: Array<{ deadlineAt: number; reason: string }> = [];
  const harnessed = await harness({ heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 5_000 }, authorityStub({
    drain: async (_session, deadlineAt, reason) => { drains.push({ deadlineAt, reason }); },
  }));
  try {
    const identity = connectorIdentity();
    harnessed.security.enroll({ connectorId: CONNECTOR, keyId: "k-1", publicKey: identity.publicKey, scopes: ["fabric.data.*"] });
    const client = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => client.socket.on("open", () => resolve()));
    await admit(client, identity, "drain-authority");
    client.send(envelope("advertise_snapshot", { advertisementRevision: 1, capabilityDigest: "d" }));
    await client.waitFor("ready");
    client.send(envelope("drain", { reason: "maintenance" }, {
      connectionId: "manager-connection-1", connectionGeneration: 1,
    }));
    await client.waitFor("drain");
    assert.equal(drains.length, 1);
    assert.equal(drains[0]?.reason, "maintenance");
    assert.equal(harnessed.hub.sessionOf(CONNECTOR)?.state, "draining");
  } finally {
    await harnessed.close();
  }
});

test("Connector applies accepted heartbeat limits, fences reconnect attempts, enforces audience, and settles stop", async () => {
  const heartbeatHarness = await harness({ heartbeatIntervalMs: 20, heartbeatTimeoutMs: 60 });
  try {
    const identity = connectorIdentity();
    heartbeatHarness.security.enroll({ connectorId: CONNECTOR, keyId: "k-1", publicKey: identity.publicKey, scopes: ["fabric.data.*"] });
    const runtime = new FabricConnectorRuntime({
      url: heartbeatHarness.url, connectorId: CONNECTOR, keyId: "k-1", audience: AUDIENCE,
      credentialGeneration: 1, ca: heartbeatHarness.ca,
      limits: { heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 5_000 },
      sign: (payload) => signPayload(null, Buffer.from(payload, "utf8"), identity.privateKey).toString("base64"),
      advertisementOf: () => ({ advertisementRevision: 1, capabilityDigest: "d", payload: {} }),
    });
    await runtime.start();
    const firstHeartbeat = heartbeatHarness.hub.sessionOf(CONNECTOR)?.lastHeartbeatAt ?? 0;
    await waitUntil(() => (heartbeatHarness.hub.sessionOf(CONNECTOR)?.lastHeartbeatAt ?? 0) > firstHeartbeat, 500);
    await runtime.stop();
  } finally {
    await heartbeatHarness.close();
  }

  const reconnectHarness = await harness({ heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 5_000 });
  try {
    let upgrades = 0;
    reconnectHarness.listener.on("upgrade", () => { upgrades += 1; });
    const noAdvertisement = new FabricConnectorRuntime({
      url: reconnectHarness.url, connectorId: CONNECTOR, keyId: "k-1", audience: AUDIENCE,
      credentialGeneration: 1, ca: reconnectHarness.ca, reconnectDelayMs: 10, maxReconnectAttempts: 1,
      connectTimeoutMs: 200, sign: () => "unused",
    });
    await assert.rejects(noAdvertisement.start(), /gave up/);
    assert.equal(upgrades, 2);
    await assert.rejects(noAdvertisement.start(), /gave up/);
    assert.equal(upgrades, 4, "a fresh start lifecycle reused the exhausted reconnect budget");

    const identity = connectorIdentity();
    reconnectHarness.security.enroll({ connectorId: CONNECTOR, keyId: "k-1", publicKey: identity.publicKey, scopes: ["fabric.data.*"] });
    let signCalls = 0;
    const wrongAudience = new FabricConnectorRuntime({
      url: reconnectHarness.url, connectorId: CONNECTOR, keyId: "k-1", audience: "other.example.test",
      credentialGeneration: 1, ca: reconnectHarness.ca, reconnectDelayMs: 10, maxReconnectAttempts: 1,
      connectTimeoutMs: 200, advertisementOf: () => ({ advertisementRevision: 1, capabilityDigest: "d", payload: {} }),
      sign: () => { signCalls += 1; return "should-not-sign"; },
    });
    await assert.rejects(wrongAudience.start(), /gave up/);
    assert.equal(signCalls, 0);

    const stopping = new FabricConnectorRuntime({
      url: reconnectHarness.url, connectorId: "connector-stop", keyId: "k", audience: AUDIENCE,
      credentialGeneration: 1, ca: reconnectHarness.ca, connectTimeoutMs: 200, sign: () => "unused",
      advertisementOf: () => ({ advertisementRevision: 1, capabilityDigest: "d", payload: {} }),
    });
    const pendingStart = stopping.start();
    const rejection = assert.rejects(pendingStart, /cancelled|stopping/);
    await stopping.stop("cancelled while connecting");
    await rejection;
  } finally {
    await reconnectHarness.close();
  }
});

test("Connector negotiated-frame send failures are contained and reconnect to a bounded failure", async () => {
  const harnessed = await harness({ heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 5_000, maxFrameBytes: 1_024 });
  try {
    const identity = connectorIdentity();
    harnessed.security.enroll({ connectorId: CONNECTOR, keyId: "k-1", publicKey: identity.publicKey, scopes: ["fabric.data.*"] });
    const errors: string[] = [];
    const runtime = new FabricConnectorRuntime({
      url: harnessed.url, connectorId: CONNECTOR, keyId: "k-1", audience: AUDIENCE,
      credentialGeneration: 1, ca: harnessed.ca, reconnectDelayMs: 10, maxReconnectAttempts: 1,
      limits: { maxFrameBytes: 4_096, heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 5_000 },
      sign: (payload) => signPayload(null, Buffer.from(payload, "utf8"), identity.privateKey).toString("base64"),
      advertisementOf: () => ({ advertisementRevision: 1, capabilityDigest: "d", payload: { padding: "x".repeat(2_000) } }),
      onError: (message) => errors.push(message),
    });
    await assert.rejects(runtime.start(), /gave up/);
    assert.equal(runtime.state, "closed");
    assert.equal(errors.some((message) => message.includes("maxFrameBytes")), true);
  } finally {
    await harnessed.close();
  }
});

test("WSS authority cleanup watchdog retries after a never-settling close and completes once", async () => {
  const never = new Promise<void>(() => undefined);
  let closeAttempts = 0;
  const harnessed = await harness({ heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 5_000 }, authorityStub({
    close: async () => {
      closeAttempts += 1;
      if (closeAttempts === 1) await never;
    },
  }));
  try {
    const identity = connectorIdentity();
    harnessed.security.enroll({ connectorId: CONNECTOR, keyId: "k-1", publicKey: identity.publicKey, scopes: ["fabric.data.*"] });
    const client = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => client.socket.on("open", () => resolve()));
    await admit(client, identity, "retry-close");
    client.send(envelope("advertise_snapshot", { advertisementRevision: 1, capabilityDigest: "d" }));
    await client.waitFor("ready");
    client.socket.close();
    await client.closed;
    await waitUntil(() => closeAttempts === 2);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(closeAttempts, 2);
  } finally {
    await harnessed.close();
  }
});

test("WSS bounds queued actions and independently retires a hung handler", async () => {
  const never = new Promise<void>(() => undefined);
  let deltaCalls = 0;
  const harnessed = await harness(
    { heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 5_000, maxInFlightOperations: 2 },
    authorityStub({ acceptDelta: async () => { deltaCalls += 1; await never; } }),
  );
  try {
    const identity = connectorIdentity();
    harnessed.security.enroll({ connectorId: CONNECTOR, keyId: "k-1", publicKey: identity.publicKey, scopes: ["fabric.data.*"] });
    const client = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => client.socket.on("open", () => resolve()));
    await admit(client, identity, "queue-bound", {
      maxFrameBytes: 4_096, maxInFlightOperations: 2, heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 5_000, maxAdvertisementItems: 10, maxResultBytes: 4_096,
    });
    client.send(envelope("advertise_snapshot", { advertisementRevision: 1, capabilityDigest: "d" }));
    await client.waitFor("ready");
    for (let revision = 2; revision <= 5; revision += 1) {
      client.send(envelope("advertise_delta", { baseRevision: 1, advertisementRevision: revision, capabilityDigest: "d" }));
    }
    await client.closed;
    assert.equal(harnessed.hub.sessionOf(CONNECTOR), undefined);
    assert.equal(deltaCalls, 1);
  } finally {
    await harnessed.close();
  }
});

test("queued WSS work expires from enqueue time and never runs after the local fence", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let deltaCalls = 0;
  const harnessed = await harness(
    { heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 5_000, maxInFlightOperations: 4 },
    authorityStub({ acceptDelta: async () => { deltaCalls += 1; await gate; } }),
  );
  try {
    const identity = connectorIdentity();
    harnessed.security.enroll({ connectorId: CONNECTOR, keyId: "k-1", publicKey: identity.publicKey, scopes: ["fabric.data.*"] });
    const client = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => client.socket.on("open", () => resolve()));
    await admit(client, identity, "enqueue-deadline", {
      maxFrameBytes: 4_096, maxInFlightOperations: 4, heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 5_000, maxAdvertisementItems: 10, maxResultBytes: 4_096,
    });
    client.send(envelope("advertise_snapshot", { advertisementRevision: 1, capabilityDigest: "d" }));
    await client.waitFor("ready");
    const queuedAt = Date.now();
    client.send(envelope("advertise_delta", { baseRevision: 1, advertisementRevision: 2, capabilityDigest: "d" }));
    client.send(envelope("advertise_delta", { baseRevision: 1, advertisementRevision: 3, capabilityDigest: "d" }));
    await client.closed;
    assert.ok(Date.now() - queuedAt < 350, "queue timeout was armed only after dequeue");
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(deltaCalls, 1, "an expired queued action executed stale work");
  } finally {
    release();
    await harnessed.close();
  }
});

test("legacy proof revalidates its session after awaiting predecessor retirement", async () => {
  const harnessed = await harness({ heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 5_000 });
  try {
    const identity = connectorIdentity();
    harnessed.security.enroll({ connectorId: CONNECTOR, keyId: "k-1", publicKey: identity.publicKey, scopes: ["fabric.data.*"] });
    const first = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => first.socket.on("open", () => resolve()));
    assert.equal(await admit(first, identity, "legacy-first"), 1);
    first.send(envelope("advertise_snapshot", { advertisementRevision: 1, capabilityDigest: "d" }));
    await first.waitFor("ready");
    const firstTransport = (first.socket as unknown as { _socket?: { pause(): void; resume(): void } })._socket;
    assert.ok(firstTransport);
    firstTransport.pause();

    const fenced = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => fenced.socket.on("open", () => resolve()));
    fenced.send(envelope("client_hello", {
      connectorId: CONNECTOR, keyId: "k-1", instanceNonce: "legacy-fenced", credentialGeneration: 1,
      supportedVersions: [FABRIC_PROTOCOL_VERSION], capabilityDigest: "d",
      limits: { maxFrameBytes: 4_096, maxInFlightOperations: 4, heartbeatIntervalMs: 1_000,
        heartbeatTimeoutMs: 5_000, maxAdvertisementItems: 10, maxResultBytes: 4_096 },
    }));
    const challenge = await fenced.waitFor("server_challenge");
    const challengePayload = challenge.payload as Record<string, unknown>;
    const claims = {
      connectorId: CONNECTOR, instanceNonce: "legacy-fenced",
      challengeNonce: String(challengePayload.challengeNonce), protocolVersion: String(challengePayload.protocolVersion),
      audience: String(challengePayload.audience), credentialGeneration: 1,
    };
    fenced.send(envelope("client_proof", {
      challengeId: String(challengePayload.challengeId), ...claims,
      signature: signPayload(null, Buffer.from(fabricChallengeProofPayload(claims), "utf8"), identity.privateKey).toString("base64"),
    }));
    setTimeout(() => fenced.socket.terminate(), 20).unref?.();
    await fenced.closed;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fenced.received.some((entry) => entry.kind === "connection_accepted"), false);

    firstTransport.resume();
    await first.closed;
    const next = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => next.socket.on("open", () => resolve()));
    assert.equal(await admit(next, identity, "legacy-next"), 2, "the fenced proof published a stale generation");
    next.socket.close();
    await next.closed;
  } finally {
    await harnessed.close();
  }
});

test("retirement terminates a peer that ignores the WebSocket close handshake", async () => {
  const harnessed = await harness({ heartbeatIntervalMs: 20, heartbeatTimeoutMs: 60 });
  try {
    const identity = connectorIdentity();
    harnessed.security.enroll({ connectorId: CONNECTOR, keyId: "k-1", publicKey: identity.publicKey, scopes: ["fabric.data.*"] });
    const client = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => client.socket.on("open", () => resolve()));
    await admit(client, identity, "ignore-close");
    client.send(envelope("advertise_snapshot", { advertisementRevision: 1, capabilityDigest: "d" }));
    await client.waitFor("ready");
    const transport = (client.socket as unknown as { _socket?: { pause(): void; resume(): void } })._socket;
    assert.ok(transport);
    transport.pause();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const connections = await new Promise<number>((resolve, reject) => {
      harnessed.listener.getConnections((error, count) => error === null ? resolve(count) : reject(error));
    });
    assert.equal(connections, 0, "the retired CLOSING socket was not forcibly terminated");
    transport.resume();
    await client.closed;
  } finally {
    await harnessed.close();
  }
});

test("async WSS continuations cannot publish readiness after socket retirement", async () => {
  let entered!: () => void;
  const enteredSnapshot = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const snapshotGate = new Promise<void>((resolve) => { release = resolve; });
  let advertisements = 0;
  let ready = 0;
  const harnessed = await harness(
    { heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 5_000 },
    authorityStub({ acceptSnapshot: async () => { entered(); await snapshotGate; } }),
    undefined,
    { onAdvertisement: () => { advertisements += 1; }, onReady: () => { ready += 1; } },
  );
  try {
    const identity = connectorIdentity();
    harnessed.security.enroll({ connectorId: CONNECTOR, keyId: "k-1", publicKey: identity.publicKey, scopes: ["fabric.data.*"] });
    const client = rawClient(harnessed.url, harnessed.ca);
    await new Promise<void>((resolve) => client.socket.on("open", () => resolve()));
    await admit(client, identity, "stale-continuation");
    client.send(envelope("advertise_snapshot", { advertisementRevision: 1, capabilityDigest: "d" }));
    await enteredSnapshot;
    client.socket.terminate();
    await client.closed;
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(advertisements, 0);
    assert.equal(ready, 0);
    assert.equal(harnessed.hub.sessionOf(CONNECTOR), undefined);
  } finally {
    await harnessed.close();
  }
});

test("multibyte Hub and Connector close reasons are UTF-8 bounded", async () => {
  const harnessed = await harness({ heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 5_000 });
  const identity = connectorIdentity();
  harnessed.security.enroll({ connectorId: CONNECTOR, keyId: "k-1", publicKey: identity.publicKey, scopes: ["fabric.data.*"] });
  const runtime = new FabricConnectorRuntime({
    url: harnessed.url, connectorId: CONNECTOR, keyId: "k-1", audience: AUDIENCE,
    credentialGeneration: 1, ca: harnessed.ca,
    sign: (payload) => signPayload(null, Buffer.from(payload, "utf8"), identity.privateKey).toString("base64"),
    advertisementOf: () => ({ advertisementRevision: 1, capabilityDigest: "d", payload: {} }),
  });
  await runtime.start();
  await runtime.stop("😀".repeat(100));
  assert.equal(runtime.state, "closed");
  await harnessed.hub.close("😀".repeat(100));
  await new Promise<void>((resolve) => harnessed.listener.close(() => resolve()));
});

test("Hub shutdown is bounded when authority close and callbacks never settle", async () => {
  const never = new Promise<void>(() => undefined);
  const harnessed = await harness(
    { heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 5_000 },
    authorityStub({ close: async () => never }),
    async () => never,
  );
  const identity = connectorIdentity();
  harnessed.security.enroll({ connectorId: CONNECTOR, keyId: "k-1", publicKey: identity.publicKey, scopes: ["fabric.data.*"] });
  const client = rawClient(harnessed.url, harnessed.ca);
  await new Promise<void>((resolve) => client.socket.on("open", () => resolve()));
  await admit(client, identity, "hung-close");
  client.send(envelope("advertise_snapshot", { advertisementRevision: 1, capabilityDigest: "d" }));
  await client.waitFor("ready");
  const started = Date.now();
  await harnessed.hub.close("bounded shutdown");
  assert.ok(Date.now() - started < 1_000);
  await new Promise<void>((resolve) => harnessed.listener.close(() => resolve()));
});

test("Hub shutdown is bounded even when a peer never closes", async () => {
  const harnessed = await harness({ heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 5_000 });
  const identity = connectorIdentity();
  harnessed.security.enroll({ connectorId: CONNECTOR, keyId: "k-1", publicKey: identity.publicKey, scopes: ["fabric.data.*"] });
  const client = rawClient(harnessed.url, harnessed.ca);
  await new Promise<void>((resolve) => client.socket.on("open", () => resolve()));
  await admit(client, identity, "instance-1");
  client.send(envelope("advertise_snapshot", { advertisementRevision: 1, capabilityDigest: "d" }));
  await client.waitFor("ready");

  const started = Date.now();
  await harnessed.hub.close("test shutdown");
  assert.ok(Date.now() - started < 3_000, "Hub shutdown waited on a peer that never closed");
  await new Promise<void>((resolve) => harnessed.listener.close(() => resolve()));
});
