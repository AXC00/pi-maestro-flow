import {
  FABRIC_ARTIFACT_VERSION,
  FabricContractError,
  assertValidFabricArtifactChunk,
  type FabricArtifactChunkV1,
  type FabricCancellationSignal,
  type FabricStreamChannel,
  type FabricStreamFrameV1,
  type JsonValue,
} from "pi-maestro-fabric-core/v1";

/**
 * 24 KiB: the encoded chunk has to fit inside one protocol frame.
 *
 * 48 KiB base64-encodes to exactly 65,536 bytes — the entire JSON payload
 * budget — and the chunk's own fields then push the frame over it, so a larger
 * chunk could never travel the stream seam at all.
 */
export const FABRIC_ARTIFACT_CHUNK_BYTES = 24 * 1024;
export const FABRIC_ARTIFACT_TRANSFER_STATES = ["available", "transferring", "partial", "complete", "cancelled"] as const;
export type FabricArtifactTransferState = (typeof FABRIC_ARTIFACT_TRANSFER_STATES)[number];

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const DEFAULT_MAX_IN_FLIGHT = 4;
/** This runtime never cancels through the stream signal; callers use cancel(). */
const NO_SIGNAL: FabricCancellationSignal = { aborted: false };

/**
 * What a transfer is about, independent of where the bytes live.
 *
 * `contentIdentity` is the source's own identity for the current content. A
 * resume compares it so that a source whose content changed cannot be resumed
 * into the middle of an older transfer: the two halves would never have been
 * one artifact.
 */
export interface FabricArtifactManifestV1 {
  artifactId: string;
  contentIdentity: string;
  byteLength: number;
  digest: string;
}

/** A streaming digest, so a body larger than memory can still be verified. */
export interface FabricArtifactHasher {
  update(bytes: Uint8Array): void;
  digestHex(): string;
}

/**
 * SHA-256 supplied by the host.
 *
 * This package is host-neutral: it owns the transfer rules, not the hash
 * implementation, so hashing stays injectable rather than importing a runtime
 * crypto module here.
 */
export interface FabricArtifactDigest {
  create(): FabricArtifactHasher;
  of(bytes: Uint8Array): string;
}

export interface FabricArtifactSenderOptions {
  manifest: FabricArtifactManifestV1;
  channel: FabricStreamChannel;
  digest: FabricArtifactDigest;
  /** Reads at most `byteLength` bytes at `offset` from the source. */
  read: (offset: number, byteLength: number) => Promise<Uint8Array>;
  maxInFlightChunks?: number;
  now?: () => number;
}

function assertManifest(manifest: FabricArtifactManifestV1): void {
  if (typeof manifest.artifactId !== "string" || manifest.artifactId.length === 0) {
    throw new FabricContractError("invalid_argument", "artifact manifest requires an artifactId");
  }
  if (typeof manifest.contentIdentity !== "string" || manifest.contentIdentity.length === 0) {
    throw new FabricContractError("invalid_argument", "artifact manifest requires a contentIdentity");
  }
  if (!Number.isSafeInteger(manifest.byteLength) || manifest.byteLength < 0) {
    throw new FabricContractError("invalid_argument", "artifact manifest byteLength must be a non-negative safe integer");
  }
  if (!SHA256_HEX.test(manifest.digest)) {
    throw new FabricContractError("invalid_argument", "artifact manifest digest must be a SHA-256 hex digest");
  }
}

function positiveBound(value: number | undefined, path: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new FabricContractError("invalid_argument", `${path} must be a positive safe integer`, path);
  }
  return value;
}

/**
 * Streams an artifact out of its source as independently digested chunks.
 *
 * The sender hashes the bytes it actually read and compares the result to the
 * manifest digest before it will call the transfer complete. A source that
 * changes mid-transfer therefore fails instead of publishing a body that is
 * half one version and half another.
 */
export class FabricArtifactSender {
  readonly #options: FabricArtifactSenderOptions;
  readonly #maxInFlight: number;
  #state: FabricArtifactTransferState = "available";
  #acknowledgedBytes = 0;
  #sentBytes = 0;
  #sequence = 0;
  #routeId: string | undefined;
  #cancelled = false;

  constructor(options: FabricArtifactSenderOptions) {
    assertManifest(options.manifest);
    this.#options = options;
    this.#maxInFlight = positiveBound(options.maxInFlightChunks, "maxInFlightChunks", DEFAULT_MAX_IN_FLIGHT);
  }

  get state(): FabricArtifactTransferState { return this.#state; }
  get acknowledgedBytes(): number { return this.#acknowledgedBytes; }
  get routeId(): string | undefined { return this.#routeId; }

  async start(): Promise<void> {
    if (this.#state === "complete") throw new FabricContractError("invalid_argument", "artifact transfer already completed");
    if (this.#state === "cancelled") throw new FabricContractError("cancelled", "artifact transfer was cancelled");
    this.#state = "transferring";
    const { manifest, channel, read, digest: digester } = this.#options;
    this.#routeId = channel.routeId;
    const running = digester.create();
    let offset = 0;
    let inFlight = 0;
    try {
      await this.#send("open", { artifactId: manifest.artifactId, contentIdentity: manifest.contentIdentity, byteLength: manifest.byteLength, digest: manifest.digest });
      while (offset < manifest.byteLength) {
        const byteLength = Math.min(FABRIC_ARTIFACT_CHUNK_BYTES, manifest.byteLength - offset);
        const bytes = await read(offset, byteLength);
        if (bytes.byteLength === 0) {
          throw new FabricContractError("invalid_state", `the source returned no bytes at the requested offset`);
        }
        if (bytes.byteLength > byteLength) {
          throw new FabricContractError("invalid_argument", `the source returned more bytes than requested`);
        }
        running.update(bytes);
        const chunk: FabricArtifactChunkV1 = {
          version: FABRIC_ARTIFACT_VERSION,
          artifactId: manifest.artifactId,
          offset,
          byteLength: bytes.byteLength,
          digest: digester.of(bytes),
          encodedData: Buffer.from(bytes).toString("base64"),
          final: offset + bytes.byteLength >= manifest.byteLength,
        };
        assertValidFabricArtifactChunk(chunk);
        await this.#send("data", {
          version: chunk.version,
          artifactId: chunk.artifactId,
          offset: chunk.offset,
          byteLength: chunk.byteLength,
          digest: chunk.digest,
          encodedData: chunk.encodedData,
          final: chunk.final,
        });
        inFlight += 1;
        offset += bytes.byteLength;
        this.#sentBytes = offset;
        if (inFlight >= this.#maxInFlight) {
          await this.#drainAcks();
          inFlight = 0;
        }
      }
      await this.#drainAcks();
      const readDigest = running.digestHex();
      await this.#send("end", { artifactId: manifest.artifactId, byteLength: offset, digest: readDigest });
      if (offset !== manifest.byteLength) {
        throw new FabricContractError("invalid_state", "the source ended before the manifest byteLength was reached");
      }
      if (readDigest !== manifest.digest) {
        // The bytes read are not the artifact the manifest describes.
        throw new FabricContractError("invalid_state", "the source content changed during transfer");
      }
      this.#state = "complete";
    } catch (error) {
      // A transport failure after the receiver may already hold bytes is not a
      // completion: the transfer stays partial so a resume is required.
      this.#state = this.#cancelled ? "cancelled" : "partial";
      throw error;
    }
  }

  async cancel(reason = "artifact transfer cancelled"): Promise<void> {
    if (this.#state === "complete" || this.#state === "cancelled") return;
    this.#cancelled = true;
    this.#state = "cancelled";
    await this.#send("cancel", { artifactId: this.#options.manifest.artifactId, reason }).catch(() => undefined);
  }

  async #drainAcks(): Promise<void> {
    while (this.#acknowledgedBytes < this.#sentBytes) {
      const frame = await this.#options.channel.receive(NO_SIGNAL);
      if (frame === undefined) {
        throw new FabricContractError("unavailable", "the artifact stream closed before every chunk was acknowledged");
      }
      if (frame.kind === "ack") {
        const offset = frame.payload.offset;
        if (typeof offset !== "number") {
          throw new FabricContractError("invalid_argument", "artifact acknowledgement is missing its offset");
        }
        this.#acknowledgedBytes = Math.max(this.#acknowledgedBytes, offset);
        continue;
      }
      if (frame.kind === "error") throw new FabricContractError("invalid_state", `the receiver refused an artifact chunk: ${String(frame.payload.reason ?? "no reason given")}`);
      if (frame.kind === "cancel") throw new FabricContractError("cancelled", "the receiver cancelled the artifact transfer");
    }
  }

  async #send(kind: FabricStreamFrameV1["kind"], payload: Readonly<Record<string, JsonValue>>): Promise<void> {
    this.#sequence += 1;
    await this.#options.channel.send({
      version: "fabric.stream.v1",
      streamId: this.#options.channel.streamId,
      routeId: this.#options.channel.routeId,
      operationId: this.#options.channel.operationId,
      sequence: this.#sequence,
      kind,
      sentAt: (this.#options.now ?? Date.now)(),
      payload,
    }, NO_SIGNAL);
  }
}

export interface FabricArtifactResumeRequest {
  artifactId: string;
  contentIdentity: string;
  /** Byte offset the receiver already holds; the transfer restarts here. */
  offset: number;
  /** Digest of the last chunk the receiver accepted. */
  chunkDigest: string;
  /** Route the resumed transfer runs on; it must differ from the interrupted one. */
  routeId: string;
}

/**
 * Reassembles an artifact from independently digested chunks.
 *
 * Chunks are accepted only in strict offset order and only at their expected
 * size, so a gap, an overlap, or a reordered chunk cannot silently become part
 * of the artifact. Completion requires the whole-artifact digest.
 */
export class FabricArtifactReceiver {
  readonly #manifest: FabricArtifactManifestV1;
  #state: FabricArtifactTransferState = "available";
  #receivedBytes = 0;
  #lastChunkDigest: string | undefined;
  #routeId: string | undefined;
  readonly #parts: Uint8Array[] = [];
  readonly #running: FabricArtifactHasher;
  readonly #digester: FabricArtifactDigest;
  #finalDigest: string | undefined;

  constructor(manifest: FabricArtifactManifestV1, digester: FabricArtifactDigest) {
    assertManifest(manifest);
    this.#manifest = manifest;
    this.#digester = digester;
    this.#running = digester.create();
  }

  get state(): FabricArtifactTransferState { return this.#state; }
  get receivedBytes(): number { return this.#receivedBytes; }
  get routeId(): string | undefined { return this.#routeId; }

  /** Validates one chunk; returns the acknowledgement offset to send back. */
  accept(chunk: unknown, routeId: string): number {
    assertValidFabricArtifactChunk(chunk);
    const value = chunk;
    if (this.#state === "complete" || this.#state === "cancelled") {
      throw new FabricContractError("invalid_state", `artifact transfer is ${this.#state}`);
    }
    if (value.artifactId !== this.#manifest.artifactId) {
      throw new FabricContractError("invalid_argument", "artifact chunk names a different artifact");
    }
    if (value.offset !== this.#receivedBytes) {
      // A gap or an overlap would make the reassembled body depend on arrival
      // order, so the transfer refuses rather than guessing.
      throw new FabricContractError("invalid_argument", `artifact chunk offset ${value.offset} does not continue at ${this.#receivedBytes}`);
    }
    if (value.byteLength === 0 || value.byteLength > FABRIC_ARTIFACT_CHUNK_BYTES) {
      throw new FabricContractError("invalid_argument", "artifact chunk byteLength is outside the admitted range");
    }
    if (this.#receivedBytes + value.byteLength > this.#manifest.byteLength) {
      throw new FabricContractError("invalid_argument", "artifact chunk overruns the manifest byteLength");
    }
    const isLast = this.#receivedBytes + value.byteLength === this.#manifest.byteLength;
    if (value.final !== isLast) {
      throw new FabricContractError("invalid_argument", "artifact chunk final flag disagrees with the manifest byteLength");
    }
    if (!value.final && value.byteLength !== FABRIC_ARTIFACT_CHUNK_BYTES) {
      throw new FabricContractError("invalid_argument", "a non-final artifact chunk must be a full chunk");
    }
    const bytes = Buffer.from(value.encodedData, "base64");
    if (bytes.byteLength !== value.byteLength) {
      throw new FabricContractError("invalid_argument", "artifact chunk encodedData does not match its byteLength");
    }
    if (this.#digester.of(bytes) !== value.digest) {
      throw new FabricContractError("invalid_argument", "artifact chunk digest does not match its bytes");
    }
    this.#parts.push(bytes);
    this.#running.update(bytes);
    this.#receivedBytes += value.byteLength;
    this.#lastChunkDigest = value.digest;
    this.#routeId = routeId;
    this.#state = "transferring";
    return this.#receivedBytes;
  }

  /**
   * Whole-artifact check. Only a matching digest and byte length report
   * complete; anything else leaves an explicit partial state.
   */
  finish(): FabricArtifactTransferState {
    if (this.#state === "cancelled") return this.#state;
    if (this.#receivedBytes !== this.#manifest.byteLength) {
      this.#state = "partial";
      return this.#state;
    }
    // A hash is digestible once, and callers may ask for the verdict again.
    this.#finalDigest ??= this.#running.digestHex();
    this.#state = this.#finalDigest === this.#manifest.digest ? "complete" : "partial";
    return this.#state;
  }

  /**
   * Admits a resume onto a new route.
   *
   * The bytes already held are reusable only if they came from the same
   * artifact content and the same point in it. The new route is required
   * because the interrupted route is no longer an admitted path.
   */
  resume(request: FabricArtifactResumeRequest): void {
    if (this.#state === "complete" || this.#state === "cancelled") {
      throw new FabricContractError("invalid_state", `artifact transfer is ${this.#state}`);
    }
    if (request.artifactId !== this.#manifest.artifactId) {
      throw new FabricContractError("invalid_argument", "resume names a different artifact");
    }
    if (request.contentIdentity !== this.#manifest.contentIdentity) {
      throw new FabricContractError("invalid_state", "resume source content identity changed");
    }
    if (request.offset !== this.#receivedBytes) {
      throw new FabricContractError("invalid_argument", "resume offset does not match the bytes already received");
    }
    if (request.offset > 0 && request.chunkDigest !== this.#lastChunkDigest) {
      throw new FabricContractError("invalid_argument", "resume chunk digest does not match the last accepted chunk");
    }
    if (this.#routeId !== undefined && request.routeId === this.#routeId) {
      throw new FabricContractError("invalid_argument", "resume requires a new route, not the interrupted one");
    }
    this.#routeId = request.routeId;
    this.#state = "transferring";
  }

  async cancel(): Promise<void> {
    if (this.#state === "complete" || this.#state === "cancelled") return;
    this.#state = "cancelled";
    this.#parts.length = 0;
    this.#receivedBytes = 0;
    this.#lastChunkDigest = undefined;
  }

  /** Reassembled bytes; only meaningful once finish() reported complete. */
  collected(): Uint8Array { return Buffer.concat(this.#parts.map((part) => Buffer.from(part))); }
}
