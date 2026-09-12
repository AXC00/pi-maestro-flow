import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { FabricContractError, type FabricArtifactState } from "pi-maestro-fabric-core/v1";
import { FABRIC_ARTIFACT_CHUNK_BYTES, type FabricArtifactManifestV1 } from "pi-maestro-fabric";
import type { FabricArtifactSourceEntry } from "./artifact-source.ts";

/** What the service needs from a source, so a host can supply its own reader. */
export interface FabricArtifactReader {
  manifestOf(entry: FabricArtifactSourceEntry): Promise<FabricArtifactManifestV1>;
  read(entry: FabricArtifactSourceEntry, offset: number, byteLength: number): Promise<Uint8Array>;
}

/** `unavailable` means the source could not be reached; it is not a success. */
export type FabricArtifactAvailability = FabricArtifactState | "unavailable";

export interface FabricArtifactView {
  artifactId: string;
  state: FabricArtifactAvailability;
  byteLength?: number;
  digest?: string;
  contentIdentity?: string;
}

export interface FabricArtifactServiceOptions {
  source: FabricArtifactReader;
  /** The artifacts this host serves; anything else is not found. */
  entries: readonly FabricArtifactSourceEntry[];
  now?: () => number;
}

/**
 * Serves artifacts from their source and writes them only where a caller named.
 *
 * Nothing here caches bytes: a Fabric artifact lives at its source, so a Hub or
 * an Edge that cannot reach it reports `unavailable` rather than serving a copy.
 */
export class FabricArtifactService {
  readonly #source: FabricArtifactReader;
  readonly #entries: Map<string, FabricArtifactSourceEntry>;

  constructor(options: FabricArtifactServiceOptions) {
    this.#source = options.source;
    this.#entries = new Map(options.entries.map((entry) => [entry.artifactId, entry]));
  }

  async inspect(artifactId: string): Promise<FabricArtifactView> {
    const entry = this.#require(artifactId);
    try {
      const manifest = await this.#source.manifestOf(entry);
      return { artifactId, state: "available", byteLength: manifest.byteLength, digest: manifest.digest, contentIdentity: manifest.contentIdentity };
    } catch (error) {
      if (error instanceof FabricContractError && error.code === "not_found") {
        return { artifactId, state: "unavailable" };
      }
      throw error;
    }
  }

  async manifest(artifactId: string): Promise<FabricArtifactManifestV1> {
    const entry = this.#require(artifactId);
    try {
      return await this.#source.manifestOf(entry);
    } catch (error) {
      if (error instanceof FabricContractError && error.code === "not_found") {
        throw new FabricContractError("unavailable", `artifact ${artifactId} is unavailable at its source`);
      }
      throw error;
    }
  }

  async readChunk(artifactId: string, offset: number, byteLength: number): Promise<Uint8Array> {
    return await this.#source.read(this.#require(artifactId), offset, byteLength);
  }

  /**
   * Writes the artifact to a caller-named destination.
   *
   * The destination is never derived: an implicit path would silently overwrite
   * whatever happened to be there. The bytes land in a sibling temp file and are
   * renamed only after the whole-artifact digest matches, so a failed or partial
   * transfer can never leave a file that looks like a finished artifact.
   */
  async downloadTo(artifactId: string, destination: string): Promise<{ byteLength: number; digest: string }> {
    if (typeof destination !== "string" || destination.length === 0 || !isAbsolute(destination)) {
      throw new FabricContractError("invalid_argument", "the artifact destination must be an explicit absolute path");
    }
    const manifest = await this.manifest(artifactId);
    const directory = dirname(destination);
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `.${artifactId}.fabric-partial`);
    const hasher = createHash("sha256");
    try {
      let offset = 0;
      const parts: Buffer[] = [];
      while (offset < manifest.byteLength) {
        const byteLength = Math.min(FABRIC_ARTIFACT_CHUNK_BYTES, manifest.byteLength - offset);
        const bytes = await this.#source.read(this.#require(artifactId), offset, byteLength);
        if (bytes.byteLength === 0) {
          throw new FabricContractError("invalid_state", `artifact ${artifactId} ended before its manifest byteLength was reached`);
        }
        hasher.update(bytes);
        parts.push(Buffer.from(bytes));
        offset += bytes.byteLength;
      }
      const digest = hasher.digest("hex");
      if (digest !== manifest.digest) {
        // The file changed while it was being read; publishing it would present
        // a mixture as the artifact the caller asked for.
        throw new FabricContractError("invalid_state", `artifact ${artifactId} changed while it was being read`);
      }
      await writeFile(temporary, Buffer.concat(parts));
      await rename(temporary, destination);
      return { byteLength: offset, digest };
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  #require(artifactId: string): FabricArtifactSourceEntry {
    if (typeof artifactId !== "string" || artifactId.length === 0) {
      throw new FabricContractError("invalid_argument", "an artifact read requires an artifactId");
    }
    const entry = this.#entries.get(artifactId);
    if (entry === undefined) {
      throw new FabricContractError("not_found", `artifact ${artifactId} is not served by this host`);
    }
    return entry;
  }
}
