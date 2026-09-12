import { createHash } from "node:crypto";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { FabricContractError } from "pi-maestro-fabric-core/v1";
import { FABRIC_ARTIFACT_CHUNK_BYTES, type FabricArtifactManifestV1 } from "pi-maestro-fabric";

/** One artifact this host is willing to serve, named relative to the root. */
export interface FabricArtifactSourceEntry {
  artifactId: string;
  path: string;
}

export interface FabricArtifactSourceOptions {
  /** Absolute root every artifact path is confined to. */
  root: string;
  /** Upper bound on a single artifact, so a read cannot exhaust memory. */
  maxArtifactBytes?: number;
  now?: () => number;
}

const DEFAULT_MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

/**
 * Reads artifacts out of one configured root.
 *
 * Confinement is checked on the resolved path *and* on its real path, because a
 * lexical check alone would accept a symlink that points outside the root.
 */
export class FabricArtifactSource {
  readonly #root: string;
  readonly #maxArtifactBytes: number;
  #realRoot: string | undefined;

  constructor(options: FabricArtifactSourceOptions) {
    if (!isAbsolute(options.root)) {
      throw new FabricContractError("invalid_argument", "the artifact source root must be an absolute path");
    }
    this.#root = resolve(options.root);
    this.#maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    if (!Number.isSafeInteger(this.#maxArtifactBytes) || this.#maxArtifactBytes < 1) {
      throw new FabricContractError("invalid_argument", "maxArtifactBytes must be a positive safe integer");
    }
  }

  get root(): string { return this.#root; }

  async manifestOf(entry: FabricArtifactSourceEntry): Promise<FabricArtifactManifestV1> {
    const path = await this.#confine(entry);
    const info = await stat(path);
    if (!info.isFile()) {
      throw new FabricContractError("invalid_argument", `artifact ${entry.artifactId} is not a regular file`);
    }
    if (info.size > this.#maxArtifactBytes) {
      throw new FabricContractError("resource_exhausted", `artifact ${entry.artifactId} exceeds the maximum artifact size`);
    }
    const digest = await this.#digestOf(path, info.size);
    return {
      artifactId: entry.artifactId,
      // Content-addressed: a source whose bytes or length changed is a
      // different artifact, so a resume can never join two versions.
      contentIdentity: `${info.size}:${digest}`,
      byteLength: info.size,
      digest,
    };
  }

  async read(entry: FabricArtifactSourceEntry, offset: number, byteLength: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new FabricContractError("invalid_argument", "artifact read offset must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > FABRIC_ARTIFACT_CHUNK_BYTES) {
      throw new FabricContractError("invalid_argument", `artifact read byteLength must be between 1 and ${FABRIC_ARTIFACT_CHUNK_BYTES}`);
    }
    const path = await this.#confine(entry);
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.allocUnsafe(byteLength);
      const { bytesRead } = await handle.read(buffer, 0, byteLength, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async #digestOf(path: string, size: number): Promise<string> {
    const hasher = createHash("sha256");
    if (size === 0) return hasher.digest("hex");
    const handle = await open(path, "r");
    try {
      // Read in bounded slices: hashing a large artifact must not require
      // holding it in memory.
      const buffer = Buffer.allocUnsafe(Math.min(FABRIC_ARTIFACT_CHUNK_BYTES, size));
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, size - offset), offset);
        if (bytesRead === 0) break;
        hasher.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
    } finally {
      await handle.close();
    }
    return hasher.digest("hex");
  }

  async #confine(entry: FabricArtifactSourceEntry): Promise<string> {
    if (typeof entry.artifactId !== "string" || entry.artifactId.length === 0) {
      throw new FabricContractError("invalid_argument", "an artifact source entry requires an artifactId");
    }
    if (typeof entry.path !== "string" || entry.path.length === 0) {
      throw new FabricContractError("invalid_argument", `artifact ${entry.artifactId} has no path`);
    }
    if (isAbsolute(entry.path)) {
      throw new FabricContractError("permission_denied", "artifact paths are relative to the configured root");
    }
    const candidate = resolve(this.#root, entry.path);
    const lexical = relative(this.#root, candidate);
    if (lexical === "" || lexical.startsWith("..") || isAbsolute(lexical)) {
      throw new FabricContractError("permission_denied", `artifact ${entry.artifactId} escapes the configured root`);
    }
    const info = await lstat(candidate).catch(() => undefined);
    if (info === undefined) {
      throw new FabricContractError("not_found", `artifact ${entry.artifactId} is not present at its source`);
    }
    if (info.isSymbolicLink()) {
      throw new FabricContractError("permission_denied", `artifact ${entry.artifactId} is a symbolic link`);
    }
    this.#realRoot ??= await realpath(this.#root);
    const real = await realpath(candidate);
    const resolved = relative(this.#realRoot, real);
    if (resolved === "" || resolved.startsWith("..") || isAbsolute(resolved)) {
      throw new FabricContractError("permission_denied", `artifact ${entry.artifactId} resolves outside the configured root`);
    }
    return candidate;
  }
}
