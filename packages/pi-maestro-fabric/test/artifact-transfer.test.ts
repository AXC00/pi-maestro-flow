import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import {
  FabricContractError,
  type FabricArtifactChunkV1,
  type FabricCancellationSignal,
  type FabricStreamChannel,
  type FabricStreamFrameV1,
} from "pi-maestro-fabric-core/v1";
import {
  FABRIC_ARTIFACT_CHUNK_BYTES,
  FabricArtifactReceiver,
  FabricArtifactSender,
  type FabricArtifactManifestV1,
} from "../src/artifact-transfer.ts";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The host supplies SHA-256; the runtime only owns the transfer rules. */
const nodeDigest = {
  create: () => {
    const hash = createHash("sha256");
    return { update: (bytes: Uint8Array) => { hash.update(bytes); }, digestHex: () => hash.digest("hex") };
  },
  of: (bytes: Uint8Array) => sha256(bytes),
};

function manifestOf(content: Uint8Array, contentIdentity = "content-1"): FabricArtifactManifestV1 {
  return { artifactId: "artifact-1", contentIdentity, byteLength: content.byteLength, digest: sha256(content) };
}

function chunkOf(content: Uint8Array, offset: number, byteLength: number): FabricArtifactChunkV1 {
  const bytes = content.subarray(offset, offset + byteLength);
  return {
    version: "fabric.artifact.v1",
    artifactId: "artifact-1",
    offset,
    byteLength: bytes.byteLength,
    digest: sha256(bytes),
    encodedData: Buffer.from(bytes).toString("base64"),
    final: offset + bytes.byteLength >= content.byteLength,
  };
}

/**
 * In-memory pair: the sender's channel feeds a real receiver, which answers
 * with real acknowledgements. `failAfterFrames` drops the link mid-transfer.
 */
function loopback(receiver: FabricArtifactReceiver, options: { routeId?: string; failAfterFrames?: number } = {}) {
  const routeId = options.routeId ?? "route-1";
  const toSender: FabricStreamFrameV1[] = [];
  let sequence = 0;
  let dataFrames = 0;
  let drainedAcks = 0;
  let maxUnacked = 0;
  let connectionOpen = true;

  const frame = (kind: FabricStreamFrameV1["kind"], payload: Readonly<Record<string, unknown>>): FabricStreamFrameV1 => ({
    version: "fabric.stream.v1",
    streamId: "stream-1",
    routeId,
    operationId: "op-1",
    sequence: (sequence += 1),
    kind,
    sentAt: 1,
    payload: payload as FabricStreamFrameV1["payload"],
  });

  const channel: FabricStreamChannel = {
    streamId: "stream-1",
    routeId,
    operationId: "op-1",
    async send(incoming: FabricStreamFrameV1): Promise<void> {
      if (!connectionOpen) throw new FabricContractError("unavailable", "the loopback link is closed");
      if (options.failAfterFrames !== undefined && dataFrames >= options.failAfterFrames && incoming.kind === "data") {
        // The receiver may already hold earlier bytes: this is a loss, not a
        // completion.
        connectionOpen = false;
        throw new FabricContractError("unavailable", "the loopback link dropped mid-transfer");
      }
      if (incoming.kind === "data") {
        dataFrames += 1;
        maxUnacked = Math.max(maxUnacked, dataFrames - drainedAcks);
        try {
          const acknowledged = receiver.accept({
            version: incoming.payload.version,
            artifactId: incoming.payload.artifactId,
            offset: incoming.payload.offset,
            byteLength: incoming.payload.byteLength,
            digest: incoming.payload.digest,
            encodedData: incoming.payload.encodedData,
            final: incoming.payload.final,
          }, routeId);
          toSender.push(frame("ack", { artifactId: "artifact-1", offset: acknowledged }));
        } catch (error) {
          toSender.push(frame("error", { artifactId: "artifact-1", reason: error instanceof Error ? error.message : String(error) }));
        }
        return;
      }
      if (incoming.kind === "end") receiver.finish();
      if (incoming.kind === "cancel") await receiver.cancel();
    },
    async receive(_signal: FabricCancellationSignal): Promise<FabricStreamFrameV1 | undefined> {
      if (!connectionOpen) return undefined;
      const next = toSender.shift();
      if (next?.kind === "ack") drainedAcks += 1;
      return next;
    },
    async close(): Promise<void> { connectionOpen = true; },
  };
  return { channel, maxUnacked: () => maxUnacked, routeId, dropLink: () => { connectionOpen = false; } };
}

test("a transfer reassembles the artifact and both sides verify the whole digest", async () => {
  const content = randomBytes(FABRIC_ARTIFACT_CHUNK_BYTES * 2 + 37);
  const manifest = manifestOf(content);
  const receiver = new FabricArtifactReceiver(manifest, nodeDigest);
  const link = loopback(receiver);
  const sender = new FabricArtifactSender({
    manifest,
    digest: nodeDigest,
    channel: link.channel,
    read: async (offset, byteLength) => content.subarray(offset, offset + byteLength),
  });

  await sender.start();
  assert.equal(sender.state, "complete");
  assert.equal(sender.acknowledgedBytes, content.byteLength);
  assert.equal(receiver.finish(), "complete");
  assert.equal(receiver.receivedBytes, content.byteLength);
  assert.deepEqual(receiver.collected(), content);
});

test("the sender holds its chunk budget instead of streaming unbounded", async () => {
  const content = randomBytes(FABRIC_ARTIFACT_CHUNK_BYTES * 6);
  const manifest = manifestOf(content);
  const receiver = new FabricArtifactReceiver(manifest, nodeDigest);
  const link = loopback(receiver);
  const sender = new FabricArtifactSender({
    manifest,
    digest: nodeDigest,
    channel: link.channel,
    read: async (offset, byteLength) => content.subarray(offset, offset + byteLength),
    maxInFlightChunks: 2,
  });

  await sender.start();
  assert.equal(sender.state, "complete");
  assert.ok(link.maxUnacked() <= 2, `expected at most 2 unacknowledged chunks, saw ${link.maxUnacked()}`);
});

test("out-of-order, overrunning, and short non-final chunks are refused", () => {
  const content = randomBytes(FABRIC_ARTIFACT_CHUNK_BYTES * 2);
  const receiver = new FabricArtifactReceiver(manifestOf(content), nodeDigest);

  // A gap: the first chunk claims to start later than the bytes held.
  assert.throws(() => receiver.accept(chunkOf(content, FABRIC_ARTIFACT_CHUNK_BYTES, FABRIC_ARTIFACT_CHUNK_BYTES), "route-1"), /does not continue at 0/);
  // A replay of an already-accepted offset.
  receiver.accept(chunkOf(content, 0, FABRIC_ARTIFACT_CHUNK_BYTES), "route-1");
  assert.throws(() => receiver.accept(chunkOf(content, 0, FABRIC_ARTIFACT_CHUNK_BYTES), "route-1"), new RegExp(`does not continue at ${FABRIC_ARTIFACT_CHUNK_BYTES}`));
  // A chunk that would overrun the artifact.
  const overrun = { ...chunkOf(content, FABRIC_ARTIFACT_CHUNK_BYTES, FABRIC_ARTIFACT_CHUNK_BYTES), byteLength: FABRIC_ARTIFACT_CHUNK_BYTES + 1 };
  assert.throws(() => receiver.accept(overrun, "route-1"), FabricContractError);
  // A short chunk that is not the final one.
  assert.throws(
    () => receiver.accept({ ...chunkOf(content, FABRIC_ARTIFACT_CHUNK_BYTES, 10), final: false }, "route-1"),
    /must be a full chunk/,
  );
});

test("a chunk whose bytes do not match its digest is refused", () => {
  const content = randomBytes(FABRIC_ARTIFACT_CHUNK_BYTES * 2);
  const receiver = new FabricArtifactReceiver(manifestOf(content), nodeDigest);
  const tampered = chunkOf(content, 0, FABRIC_ARTIFACT_CHUNK_BYTES);
  const flipped = Buffer.from(tampered.encodedData, "base64");
  flipped[0] ^= 0xff;
  assert.throws(
    () => receiver.accept({ ...tampered, encodedData: flipped.toString("base64") }, "route-1"),
    /chunk digest does not match its bytes/,
  );
});

test("a wrong final digest leaves an explicit partial state, never complete", () => {
  const content = randomBytes(FABRIC_ARTIFACT_CHUNK_BYTES + 10);
  const receiver = new FabricArtifactReceiver(manifestOf(content), nodeDigest);
  receiver.accept(chunkOf(content, 0, FABRIC_ARTIFACT_CHUNK_BYTES), "route-1");
  // Same route: this test is about the digest verdict, not route continuity.
  receiver.accept(chunkOf(content, FABRIC_ARTIFACT_CHUNK_BYTES, 10), "route-1");
  // The manifest promised different content than the chunks carried, so the
  // receiver must report partial even though every chunk checked out.
  const wrongManifest = new FabricArtifactReceiver({ ...manifestOf(content), digest: sha256(randomBytes(4)) }, nodeDigest);
  wrongManifest.accept(chunkOf(content, 0, FABRIC_ARTIFACT_CHUNK_BYTES), "route-1");
  wrongManifest.accept(chunkOf(content, FABRIC_ARTIFACT_CHUNK_BYTES, 10), "route-1");
  assert.equal(wrongManifest.finish(), "partial");
  assert.equal(wrongManifest.state, "partial");
  const partial = new FabricArtifactReceiver(manifestOf(randomBytes(8)), nodeDigest);
  assert.equal(partial.finish(), "partial");
  assert.equal(partial.state, "partial");
  assert.equal(receiver.finish(), "complete");
});

test("a source whose content changed mid-transfer fails instead of publishing a stitched body", async () => {
  const content = randomBytes(FABRIC_ARTIFACT_CHUNK_BYTES * 2);
  const manifest = manifestOf(content);
  const receiver = new FabricArtifactReceiver(manifest, nodeDigest);
  const link = loopback(receiver);
  // The source answers the second read with different bytes.
  let reads = 0;
  const sender = new FabricArtifactSender({
    manifest,
    digest: nodeDigest,
    channel: link.channel,
    read: async (offset, byteLength) => {
      reads += 1;
      return reads === 2 ? randomBytes(byteLength) : content.subarray(offset, offset + byteLength);
    },
    maxInFlightChunks: 1,
  });

  await assert.rejects(() => sender.start(), /the source content changed during transfer/);
  assert.equal(sender.state, "partial");
  assert.equal(receiver.finish(), "partial");
});

test("a link that drops after bytes were accepted never reports completion", async () => {
  const content = randomBytes(FABRIC_ARTIFACT_CHUNK_BYTES * 3);
  const manifest = manifestOf(content);
  const receiver = new FabricArtifactReceiver(manifest, nodeDigest);
  const link = loopback(receiver, { failAfterFrames: 2 });
  const sender = new FabricArtifactSender({
    manifest,
    digest: nodeDigest,
    channel: link.channel,
    read: async (offset, byteLength) => content.subarray(offset, offset + byteLength),
    maxInFlightChunks: 1,
  });

  await assert.rejects(() => sender.start());
  assert.equal(sender.state, "partial");
  assert.notEqual(sender.state, "complete");
  assert.equal(receiver.state, "transferring");
  assert.equal(receiver.finish(), "partial");
  assert.ok(receiver.receivedBytes > 0 && receiver.receivedBytes < content.byteLength);
});

test("cancel releases in-flight state and is idempotent", async () => {
  const content = randomBytes(FABRIC_ARTIFACT_CHUNK_BYTES);
  const receiver = new FabricArtifactReceiver(manifestOf(content), nodeDigest);
  receiver.accept(chunkOf(content, 0, FABRIC_ARTIFACT_CHUNK_BYTES), "route-1");
  await receiver.cancel();
  assert.equal(receiver.state, "cancelled");
  assert.equal(receiver.receivedBytes, 0);
  assert.equal(receiver.collected().byteLength, 0);
  await receiver.cancel();
  assert.equal(receiver.state, "cancelled");

  const manifest = manifestOf(content);
  const link = loopback(receiver);
  const sender = new FabricArtifactSender({ manifest, digest: nodeDigest, channel: link.channel, read: async (offset, byteLength) => content.subarray(offset, offset + byteLength) });
  await sender.cancel();
  await sender.cancel();
  assert.equal(sender.state, "cancelled");
});

test("a resume is admitted only on a new route with the same content identity", () => {
  const content = randomBytes(FABRIC_ARTIFACT_CHUNK_BYTES + 5);
  const manifest = manifestOf(content);
  const receiver = new FabricArtifactReceiver(manifest, nodeDigest);
  const first = chunkOf(content, 0, FABRIC_ARTIFACT_CHUNK_BYTES);
  receiver.accept(first, "route-1");

  // The interrupted route is not an admitted path for the remainder.
  assert.throws(
    () => receiver.resume({ artifactId: "artifact-1", contentIdentity: "content-1", offset: FABRIC_ARTIFACT_CHUNK_BYTES, chunkDigest: first.digest, routeId: "route-1" }),
    /requires a new route/,
  );
  // A changed source content identity would stitch two different bodies.
  assert.throws(
    () => receiver.resume({ artifactId: "artifact-1", contentIdentity: "content-2", offset: FABRIC_ARTIFACT_CHUNK_BYTES, chunkDigest: first.digest, routeId: "route-2" }),
    /content identity changed/,
  );
  // A different point in the artifact is not a resume of this one.
  assert.throws(
    () => receiver.resume({ artifactId: "artifact-1", contentIdentity: "content-1", offset: 10, chunkDigest: first.digest, routeId: "route-2" }),
    /offset does not match/,
  );
  assert.throws(
    () => receiver.resume({ artifactId: "artifact-1", contentIdentity: "content-1", offset: FABRIC_ARTIFACT_CHUNK_BYTES, chunkDigest: sha256(randomBytes(4)), routeId: "route-2" }),
    /chunk digest does not match/,
  );

  receiver.resume({ artifactId: "artifact-1", contentIdentity: "content-1", offset: FABRIC_ARTIFACT_CHUNK_BYTES, chunkDigest: first.digest, routeId: "route-2" });
  assert.equal(receiver.state, "transferring");
  receiver.accept(chunkOf(content, FABRIC_ARTIFACT_CHUNK_BYTES, 5), "route-2");
  assert.equal(receiver.finish(), "complete");
  assert.deepEqual(Buffer.from(receiver.collected()), Buffer.from(content));
});

test("the manifest itself is validated before any byte moves", () => {
  const content = randomBytes(64);
  assert.throws(() => new FabricArtifactReceiver({ ...manifestOf(content), digest: "not-a-digest" }, nodeDigest), /SHA-256 hex digest/);
  assert.throws(() => new FabricArtifactReceiver({ ...manifestOf(content), byteLength: -1 }, nodeDigest), /non-negative safe integer/);
  assert.throws(() => new FabricArtifactReceiver({ ...manifestOf(content), artifactId: "" }, nodeDigest), /requires an artifactId/);
  assert.throws(() => new FabricArtifactReceiver({ ...manifestOf(content), contentIdentity: "" }, nodeDigest), /requires a contentIdentity/);
});
