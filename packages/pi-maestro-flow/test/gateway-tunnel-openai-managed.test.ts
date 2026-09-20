import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { createGatewayTunnelDeadline } from "../src/gateway/tunnel/probe.ts";
import {
  OPENAI_TUNNEL_CLIENT_ASSETS,
  OPENAI_TUNNEL_CLIENT_MAX_BINARY_BYTES,
  ensureManagedOpenAiTunnelClient,
  extractZipMember,
  managedOpenAiTunnelClientPath,
  openAiTunnelClientAssetFor,
  sha256File,
  type OpenAiTunnelClientAsset,
} from "../src/gateway/tunnel/providers/openai-client-managed.ts";

const PLATFORM: NodeJS.Platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const TARGET = `${PLATFORM === "win32" ? "windows" : PLATFORM}-amd64`;
const MEMBER = PLATFORM === "win32" ? "tunnel-client.exe" : "tunnel-client";
const BINARY_BYTES = Buffer.from(`fake tunnel-client binary ${"x".repeat(128)}`);

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function testAsset(archive: Buffer): OpenAiTunnelClientAsset {
  return {
    target: TARGET,
    fileName: `tunnel-client-test-${TARGET}.zip`,
    archiveSha256: sha256(archive),
    binarySha256: sha256(BINARY_BYTES),
    memberName: MEMBER,
  };
}

/** Minimal ZIP writer: local header + central directory + EOCD, stored or deflated. */
function buildZip(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const payload = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const method = entry.deflate ? 8 : 0;
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, payload);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + payload.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

function zipResponse(archive: Buffer): typeof fetch {
  return (async () => new Response(new Uint8Array(archive), {
    status: 200,
    headers: { "content-length": String(archive.byteLength) },
  })) as typeof fetch;
}

async function tempRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openai-managed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("asset table covers six pinned targets and maps platform/arch", () => {
  assert.equal(OPENAI_TUNNEL_CLIENT_ASSETS.length, 6);
  for (const asset of OPENAI_TUNNEL_CLIENT_ASSETS) {
    assert.match(asset.archiveSha256, /^[a-f0-9]{64}$/u);
    assert.match(asset.binarySha256, /^[a-f0-9]{64}$/u);
    assert.equal(asset.fileName, `tunnel-client-v0.0.14-${asset.target}.zip`);
  }
  assert.equal(openAiTunnelClientAssetFor("linux", "x64")?.target, "linux-amd64");
  assert.equal(openAiTunnelClientAssetFor("linux", "arm64")?.target, "linux-arm64");
  assert.equal(openAiTunnelClientAssetFor("darwin", "arm64")?.target, "darwin-arm64");
  assert.equal(openAiTunnelClientAssetFor("win32", "x64")?.target, "windows-amd64");
  assert.equal(openAiTunnelClientAssetFor("freebsd" as NodeJS.Platform, "x64"), undefined);
  assert.equal(openAiTunnelClientAssetFor("linux", "riscv64"), undefined);
});

test("extractZipMember extracts stored and deflated members and rejects bad archives", async (t) => {
  const root = await tempRoot(t);
  const stored = buildZip([{ name: "a.txt", data: Buffer.from("stored-content") }]);
  const deflated = buildZip([{ name: MEMBER, data: BINARY_BYTES, deflate: true }, { name: "other", data: Buffer.from("x") }]);
  const archivePath = join(root, "a.zip");
  await writeFile(archivePath, stored);
  await extractZipMember(archivePath, "a.txt", join(root, "out.txt"));
  assert.equal(readFileSync(join(root, "out.txt"), "utf8"), "stored-content");
  await writeFile(archivePath, deflated);
  await extractZipMember(archivePath, MEMBER, join(root, "out2"));
  assert.deepEqual(readFileSync(join(root, "out2")), BINARY_BYTES);
  await assert.rejects(() => extractZipMember(archivePath, "missing", join(root, "out3")), /does not contain/u);
  await writeFile(archivePath, Buffer.from("not a zip"));
  await assert.rejects(() => extractZipMember(archivePath, "a", join(root, "out4")), /not a valid ZIP/u);
});

test("managed install downloads, verifies both hashes, and installs atomically", async (t) => {
  const root = await tempRoot(t);
  const archive = buildZip([{ name: MEMBER, data: BINARY_BYTES, deflate: true }, { name: "LICENSE", data: Buffer.from("license") }]);
  const asset = testAsset(archive);
  const context = createGatewayTunnelDeadline(10_000);
  t.after(() => context.close());
  let fetches = 0;
  const fetchImpl: typeof fetch = (async (input: unknown) => { fetches += 1; assert.match(String(input), /tunnel-client-test/u); return zipResponse(archive)(input as never); }) as typeof fetch;
  const versions: string[] = [];
  const verifyVersion = async (path: string) => { versions.push(path); return true; };
  const installed = await ensureManagedOpenAiTunnelClient({ managedRoot: root, platform: PLATFORM, arch: "x64", context, fetch: fetchImpl, verifyVersion, assets: [asset] });
  const expected = managedOpenAiTunnelClientPath(root, asset);
  assert.equal(installed, expected);
  assert.deepEqual(readFileSync(installed), BINARY_BYTES);
  assert.equal(fetches, 1);
  assert.ok(versions.length >= 2, "candidate and installed binary are both version-verified");
  // Second call reuses the verified install without downloading again.
  const again = await ensureManagedOpenAiTunnelClient({ managedRoot: root, platform: PLATFORM, arch: "x64", context, fetch: fetchImpl, verifyVersion, assets: [asset] });
  assert.equal(again, expected);
  assert.equal(fetches, 1);
});

test("managed install rejects tampered archives and binaries before install", async (t) => {
  const root = await tempRoot(t);
  const context = createGatewayTunnelDeadline(10_000);
  t.after(() => context.close());
  const good = buildZip([{ name: MEMBER, data: BINARY_BYTES }]);
  const asset = testAsset(good);
  const tamperedArchive = Buffer.from(good);
  tamperedArchive[40] ^= 0xff;
  await assert.rejects(
    () => ensureManagedOpenAiTunnelClient({ managedRoot: root, platform: PLATFORM, arch: "x64", context, fetch: zipResponse(tamperedArchive), verifyVersion: async () => true, assets: [asset] }),
    /archive failed SHA-256/u,
  );
  const wrongBinary = buildZip([{ name: MEMBER, data: Buffer.from("evil binary") }]);
  const asset2 = { ...asset, archiveSha256: sha256(wrongBinary) };
  await assert.rejects(
    () => ensureManagedOpenAiTunnelClient({ managedRoot: join(root, "b"), platform: PLATFORM, arch: "x64", context, fetch: zipResponse(wrongBinary), verifyVersion: async () => true, assets: [asset2] }),
    /binary failed SHA-256/u,
  );
  const destination = managedOpenAiTunnelClientPath(join(root, "b"), asset2);
  assert.equal(existsSync(destination), false, "failed installs never publish a binary");
});

test("managed install enforces download size limit and unsupported platforms", async (t) => {
  const root = await tempRoot(t);
  const context = createGatewayTunnelDeadline(10_000);
  t.after(() => context.close());
  const asset = testAsset(Buffer.alloc(0));
  const oversized: typeof fetch = (async () => new Response(null, { status: 200, headers: { "content-length": String(OPENAI_TUNNEL_CLIENT_MAX_BINARY_BYTES + 1) } })) as typeof fetch;
  await assert.rejects(
    () => ensureManagedOpenAiTunnelClient({ managedRoot: root, platform: PLATFORM, arch: "x64", context, fetch: oversized, verifyVersion: async () => true, assets: [asset] }),
    /size limit/u,
  );
  await assert.rejects(
    () => ensureManagedOpenAiTunnelClient({ managedRoot: root, platform: "aix", arch: "ppc64", context, fetch: zipResponse(Buffer.alloc(0)), verifyVersion: async () => true, assets: [asset] }),
    /unsupported on aix/u,
  );
});

test("corrupt managed installs are re-downloaded and re-verified", async (t) => {
  const root = await tempRoot(t);
  const archive = buildZip([{ name: MEMBER, data: BINARY_BYTES }]);
  const asset = testAsset(archive);
  const context = createGatewayTunnelDeadline(10_000);
  t.after(() => context.close());
  const destination = managedOpenAiTunnelClientPath(root, asset);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, "corrupt");
  const installed = await ensureManagedOpenAiTunnelClient({ managedRoot: root, platform: PLATFORM, arch: "x64", context, fetch: zipResponse(archive), verifyVersion: async () => true, assets: [asset] });
  assert.equal(installed, destination);
  assert.deepEqual(readFileSync(installed), BINARY_BYTES);
});
