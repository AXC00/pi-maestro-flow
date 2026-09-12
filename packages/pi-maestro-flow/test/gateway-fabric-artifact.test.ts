import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FabricContractError } from "pi-maestro-fabric-core/v1";
import { FABRIC_ARTIFACT_CHUNK_BYTES } from "pi-maestro-fabric";
import { FabricArtifactSource } from "../src/gateway/fabric/artifact-source.ts";
import { FabricArtifactService, type FabricArtifactReader } from "../src/gateway/fabric/artifact-service.ts";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function workspace(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "gateway-fabric-artifact-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const content = Buffer.alloc(FABRIC_ARTIFACT_CHUNK_BYTES + 128);
  for (let index = 0; index < content.byteLength; index += 1) content[index] = index % 251;
  await writeFile(join(root, "data.bin"), content);
  return { root, content };
}

function serviceOf(root: string, entries = [{ artifactId: "a1", path: "data.bin" }]): FabricArtifactService {
  return new FabricArtifactService({ source: new FabricArtifactSource({ root }), entries });
}

test("a read serves the source bytes and its content-addressed identity", async (t) => {
  const { root, content } = await workspace(t);
  const service = serviceOf(root);

  const view = await service.inspect("a1");
  assert.equal(view.state, "available");
  assert.equal(view.byteLength, content.byteLength);
  assert.equal(view.digest, sha256(content));
  assert.equal(view.contentIdentity, `${content.byteLength}:${sha256(content)}`);

  const first = await service.readChunk("a1", 0, FABRIC_ARTIFACT_CHUNK_BYTES);
  assert.deepEqual(Buffer.from(first), content.subarray(0, FABRIC_ARTIFACT_CHUNK_BYTES));
  // A read cannot be asked for more than one chunk.
  await assert.rejects(() => service.readChunk("a1", 0, FABRIC_ARTIFACT_CHUNK_BYTES + 1), /between 1 and/);
  await assert.rejects(() => service.readChunk("a1", -1, 16), FabricContractError);
});

test("nothing is cached: a source that goes away becomes unavailable", async (t) => {
  const { root } = await workspace(t);
  const service = serviceOf(root);
  assert.equal((await service.inspect("a1")).state, "available");

  await rm(join(root, "data.bin"));
  assert.equal((await service.inspect("a1")).state, "unavailable");
  await assert.rejects(() => service.manifest("a1"), (error: FabricContractError) => {
    assert.equal(error.code, "unavailable");
    return true;
  });
  await assert.rejects(() => service.readChunk("a1", 0, 16), (error: FabricContractError) => {
    assert.equal(error.code, "not_found");
    return true;
  });
});

test("artifacts outside the configured root are refused", async (t) => {
  const { root } = await workspace(t);
  const outside = await mkdtemp(join(tmpdir(), "gateway-fabric-outside-"));
  t.after(async () => { await rm(outside, { recursive: true, force: true }); });
  await writeFile(join(outside, "secret.bin"), "secret");

  await assert.rejects(() => serviceOf(root, [{ artifactId: "a1", path: "../escape.bin" }]).inspect("a1"), /escapes the configured root/);
  await assert.rejects(
    () => serviceOf(root, [{ artifactId: "a1", path: join(outside, "secret.bin") }]).inspect("a1"),
    /relative to the configured root/,
  );
  // A missing source is unavailable, not an error: the artifact is simply not
  // reachable from here right now.
  assert.equal((await serviceOf(root, [{ artifactId: "a1", path: "missing.bin" }]).inspect("a1")).state, "unavailable");
  await assert.rejects(
    () => serviceOf(root, [{ artifactId: "a1", path: "missing.bin" }]).manifest("a1"),
    /unavailable at its source/,
  );
  await assert.rejects(() => serviceOf(root, [{ artifactId: "a1", path: "." }]).inspect("a1"), FabricContractError);
  await assert.rejects(() => serviceOf(root, [{ artifactId: "other", path: "data.bin" }]).inspect("a1"), /not served by this host/);
});

test("a source path that is a symbolic link is refused", async (t) => {
  const { root } = await workspace(t);
  const link = join(root, "link.bin");
  let linked = false;
  try {
    await symlink(join(root, "data.bin"), link);
    linked = true;
  } catch {
    // Creating symlinks needs a privilege Windows does not grant by default.
  }
  if (linked) {
    await assert.rejects(() => serviceOf(root, [{ artifactId: "a1", path: "link.bin" }]).inspect("a1"), /is a symbolic link/);
  }
  // The lexical guard holds on every platform, with or without symlink support.
  await assert.rejects(() => serviceOf(root, [{ artifactId: "a1", path: "../../etc/passwd" }]).inspect("a1"), /escapes the configured root/);
});

test("a download needs an explicit destination and lands atomically", async (t) => {
  const { root, content } = await workspace(t);
  const service = serviceOf(root);
  const destination = join(root, "out", "copy.bin");

  await assert.rejects(() => service.downloadTo("a1", "copy.bin"), /explicit absolute path/);
  await assert.rejects(() => service.downloadTo("a1", ""), /explicit absolute path/);

  const written = await service.downloadTo("a1", destination);
  assert.equal(written.byteLength, content.byteLength);
  assert.equal(written.digest, sha256(content));
  assert.deepEqual(await readFile(destination), content);
  // No temp file survives a successful transfer.
  assert.deepEqual((await readdir(join(root, "out"))).filter((name) => name.includes("fabric-partial")), []);
});

test("a failed download leaves neither a destination nor a temp file", async (t) => {
  const { root, content } = await workspace(t);
  // A source that reports a digest its bytes will never match.
  const lying: FabricArtifactReader = {
    manifestOf: async () => ({ artifactId: "a1", contentIdentity: "content-1", byteLength: content.byteLength, digest: sha256(Buffer.from("other")) }),
    read: async (entry, offset, byteLength) => content.subarray(offset, offset + byteLength),
  };
  const service = new FabricArtifactService({ source: lying, entries: [{ artifactId: "a1", path: "data.bin" }] });
  const destination = join(root, "out", "copy.bin");

  await assert.rejects(() => service.downloadTo("a1", destination), /changed while it was being read/);
  await assert.rejects(() => readFile(destination), "the destination must not exist after a failed transfer");
  const leftovers = await readdir(join(root, "out"));
  assert.deepEqual(leftovers.filter((name) => name.includes("fabric-partial")), []);
});

test("reading an artifact never writes bytes into the serving root", async (t) => {
  const { root } = await workspace(t);
  const before = (await readdir(root)).sort();
  const service = serviceOf(root);
  await service.inspect("a1");
  await service.readChunk("a1", 0, FABRIC_ARTIFACT_CHUNK_BYTES);
  // The Hub holds no bytes: serving an artifact adds nothing next to its source.
  assert.deepEqual((await readdir(root)).sort(), before);
});
