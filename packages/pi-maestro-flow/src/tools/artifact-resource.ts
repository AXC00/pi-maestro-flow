import { FabricContractError } from "pi-maestro-fabric-core/v1";
import type { FabricArtifactService } from "../gateway/fabric/artifact-service.ts";

/** URI scheme served by the resource dispatcher for Fabric artifacts. */
export const FABRIC_ARTIFACT_SCHEME = "artifact";

export interface FabricArtifactResourceOptions {
  service: FabricArtifactService;
}

/**
 * `artifact://<artifactId>` — the artifact's identity and current state.
 *
 * Deliberately metadata only: an artifact body is large and belongs at its
 * source, so fetching bytes is an explicit-destination download rather than a
 * resource read. This read never mutates anything, and a resume that restores
 * the bytes of an interrupted transfer restores a read, never a mutation.
 */
export async function resolveFabricArtifactResource(
  uri: string,
  segments: readonly string[],
  options: FabricArtifactResourceOptions,
): Promise<{ content: string; title: string; cached: boolean }> {
  if (segments.length !== 1 || segments[0] === undefined || segments[0].length === 0) {
    throw new FabricContractError("invalid_argument", `Invalid artifact URI: "${uri}". Expected artifact://<artifactId>.`);
  }
  const artifactId = decodeURIComponent(segments[0]);
  const view = await options.service.inspect(artifactId);
  return {
    content: JSON.stringify(view, null, 2),
    title: `artifact://${artifactId}`,
    cached: false,
  };
}
