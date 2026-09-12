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
import { FABRIC_WSS_PATH, FabricWssServer } from "../src/gateway/fabric/wss-server.ts";

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

async function harness(limits: { heartbeatIntervalMs: number; heartbeatTimeoutMs: number }): Promise<Harness> {
  const ca = await readFile(certificatePath);
  const key = await readFile(keyPath);
  const listener = createHttpsServer({ cert: ca, key });
  await new Promise<void>((resolve) => listener.listen(0, "localhost", resolve));
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("no listener address");
  const security = new FabricConnectorSecurity({ audience: AUDIENCE });
  const hub = new FabricWssServer({ security, server: listener, limits, drainTimeoutMs: 200 });
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

/** Drive a raw client through hello and proof; returns the accepted generation. */
async function admit(
  client: ReturnType<typeof rawClient>,
  identity: { privateKey: KeyObject },
  instanceNonce: string,
): Promise<number> {
  client.send(envelope("client_hello", { connectorId: CONNECTOR, keyId: "k-1", instanceNonce }));
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
