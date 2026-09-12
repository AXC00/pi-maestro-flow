import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FabricContractError } from "pi-maestro-fabric-core/v1";
import { FabricArtifactSource } from "../src/gateway/fabric/artifact-source.ts";
import { FabricArtifactService } from "../src/gateway/fabric/artifact-service.ts";
import { FABRIC_ARTIFACT_SCHEME, resolveFabricArtifactResource } from "../src/tools/artifact-resource.ts";
import { resolveResource } from "../src/tools/resource.ts";

const BODY = "fabric artifact body";

async function artifactService(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "fabric-artifact-resource-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "data.bin"), Buffer.from(BODY));
  const service = new FabricArtifactService({ source: new FabricArtifactSource({ root }), entries: [{ artifactId: "a1", path: "data.bin" }] });
  return { root, service };
}

test("artifact:// reads an artifact's identity through the resource dispatcher", async (t) => {
  const { service } = await artifactService(t);
  assert.equal(FABRIC_ARTIFACT_SCHEME, "artifact");

  const digest = createHash("sha256").update(BODY).digest("hex");
  const result = await resolveResource("artifact://a1", process.cwd(), undefined, { fabricArtifacts: service });
  assert.equal(result.title, "artifact://a1");
  assert.equal(result.cached, false);
  assert.deepEqual(JSON.parse(result.content), {
    artifactId: "a1",
    state: "available",
    byteLength: Buffer.byteLength(BODY),
    digest,
    contentIdentity: `${Buffer.byteLength(BODY)}:${digest}`,
  });
  // The read is metadata only: no bytes and no source-local path are exposed.
  assert.equal(result.content.includes("data.bin"), false);
});

test("an unreachable or unknown artifact is reported rather than fabricated", async (t) => {
  const { root, service } = await artifactService(t);

  await unlink(join(root, "data.bin"));
  const gone = await resolveFabricArtifactResource("artifact://a1", ["a1"], { service });
  assert.equal(JSON.parse(gone.content).state, "unavailable");

  await assert.rejects(() => resolveFabricArtifactResource("artifact://a1", [], { service }), /Expected artifact:\/\/<artifactId>/);
  await assert.rejects(() => resolveFabricArtifactResource("artifact://a1", ["a1", "extra"], { service }), /Expected artifact:\/\/<artifactId>/);
  await assert.rejects(
    () => resolveResource("artifact://unknown", process.cwd(), undefined, { fabricArtifacts: service }),
    (error: FabricContractError) => {
      assert.equal(error.code, "not_found");
      return true;
    },
  );
});

test("artifact:// without a connected source fails closed and leaves other schemes alone", async () => {
  await assert.rejects(
    () => resolveResource("artifact://a1", process.cwd(), undefined, {}),
    /requires a Fabric artifact source/,
  );
  // The scheme list still names every supported scheme, and an unknown one is
  // refused with the same error shape as before.
  await assert.rejects(() => resolveResource("unknown://x", process.cwd(), undefined, {}), /Unsupported scheme "unknown:\/\/"/);
  await assert.rejects(() => resolveResource("not a uri", process.cwd(), undefined, {}), /Unsupported URI format/);
});
