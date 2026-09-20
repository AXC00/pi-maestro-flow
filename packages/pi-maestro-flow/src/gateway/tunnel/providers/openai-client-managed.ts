/**
 * Managed OpenAI tunnel-client discovery and pinned, verified installation.
 *
 * The provider never guesses a download URL: every installable asset below is
 * pinned to one published openai/tunnel-client release with both the archive
 * and the extracted binary SHA-256 recorded. Auto-install stays opt-in; the
 * caller decides whether a missing client may be downloaded.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { GatewayTunnelDeadlineContext } from "../contracts.ts";
import { runWithinTunnelDeadline } from "../probe.ts";

export const OPENAI_TUNNEL_CLIENT_PINNED_VERSION = "0.0.14" as const;
export const OPENAI_TUNNEL_CLIENT_RELEASE_BASE =
  `https://github.com/openai/tunnel-client/releases/download/v${OPENAI_TUNNEL_CLIENT_PINNED_VERSION}` as const;
export const OPENAI_TUNNEL_CLIENT_MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
export const OPENAI_TUNNEL_CLIENT_MAX_BINARY_BYTES = 64 * 1024 * 1024;

export interface OpenAiTunnelClientAsset {
  readonly target: string;
  readonly fileName: string;
  readonly archiveSha256: string;
  readonly binarySha256: string;
  readonly memberName: string;
}

/** Pinned v0.0.14 assets; hashes verified against the release SHA256SUMS.txt and extracted binaries. */
export const OPENAI_TUNNEL_CLIENT_ASSETS: readonly OpenAiTunnelClientAsset[] = Object.freeze([
  { target: "linux-amd64", fileName: "tunnel-client-v0.0.14-linux-amd64.zip", archiveSha256: "15bd17e805cad39d412199115bb9e10a978dd35258a114cdf25dd2ae6681c7d3", binarySha256: "472eb9dd9dd625b4e6023c3b4a5736b3a2e5a1b6dbe9338e001887a64ec992a6", memberName: "tunnel-client" },
  { target: "linux-arm64", fileName: "tunnel-client-v0.0.14-linux-arm64.zip", archiveSha256: "2de3fb879a18edb847e0313592c912f1983685488290a7fdba7ac403e6a4fb0a", binarySha256: "ab6c05258f15dc43a8e23f39460beb69892a8ced03e4c345a6f1aef0dd009b0f", memberName: "tunnel-client" },
  { target: "darwin-amd64", fileName: "tunnel-client-v0.0.14-darwin-amd64.zip", archiveSha256: "75e10be774184fb42189e347b16eb6bc9fb0780135d8af714d34e30ce068dc53", binarySha256: "89478d1d58350818275b852169745e1af0e18c02ff9b5b46d50df22018c95be9", memberName: "tunnel-client" },
  { target: "darwin-arm64", fileName: "tunnel-client-v0.0.14-darwin-arm64.zip", archiveSha256: "b540493c5bdbcdbb755700c8e2e16597e28b1569e425007e0f73111047bd6a64", binarySha256: "309fd85da5a8c2ca8dae920deea8ac10a4d7934ed18ac46e7df0c200139cc9c5", memberName: "tunnel-client" },
  { target: "windows-amd64", fileName: "tunnel-client-v0.0.14-windows-amd64.zip", archiveSha256: "784ab8da7b5a88f0109f1fd8aaf0a1c86067430b896dddf307ef7e3cc49fa1a5", binarySha256: "fcc85a69ec0ad82518e4f8964f60c45e31787957782a0fc9c1b0c44e82d61b9b", memberName: "tunnel-client.exe" },
  { target: "windows-arm64", fileName: "tunnel-client-v0.0.14-windows-arm64.zip", archiveSha256: "fa775db8897df543dd4ba66404f69492a2acfbc6a291f10df27aced064a16568", binarySha256: "7260ec886a7efd34202c6506bd35b068e94723a5402ea6f76af5a3af3dbd0a0b", memberName: "tunnel-client.exe" },
]);

export interface OpenAiManagedInstallOptions {
  managedRoot: string;
  platform: NodeJS.Platform;
  arch?: string;
  context: GatewayTunnelDeadlineContext;
  fetch?: typeof fetch;
  /** Returns true when the candidate binary passes the caller's version policy. */
  verifyVersion?: (executablePath: string) => Promise<boolean>;
  assets?: readonly OpenAiTunnelClientAsset[];
}

export function openAiTunnelClientAssetFor(platform: NodeJS.Platform, arch: string = process.arch, assets: readonly OpenAiTunnelClientAsset[] = OPENAI_TUNNEL_CLIENT_ASSETS): OpenAiTunnelClientAsset | undefined {
  const target = `${platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : platform}-${arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : arch}`;
  return assets.find((asset) => asset.target === target);
}

export function managedOpenAiTunnelClientPath(managedRoot: string, asset: OpenAiTunnelClientAsset, version: string = OPENAI_TUNNEL_CLIENT_PINNED_VERSION): string {
  return join(managedRoot, version, asset.target, asset.memberName);
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function managedClientValid(path: string, asset: OpenAiTunnelClientAsset, verifyVersion: (executablePath: string) => Promise<boolean>): Promise<boolean> {
  try {
    if (!statSync(path).isFile()) return false;
    if (await sha256File(path) !== asset.binarySha256) return false;
    return await verifyVersion(path);
  } catch {
    return false;
  }
}

/**
 * Return the verified managed binary, downloading and installing the pinned
 * release asset when it is absent or fails verification. The binary is staged
 * in a private temporary directory, verified end to end, then renamed into
 * place so a partial install can never look finished.
 */
export async function ensureManagedOpenAiTunnelClient(options: OpenAiManagedInstallOptions): Promise<string> {
  const asset = openAiTunnelClientAssetFor(options.platform, options.arch, options.assets);
  if (!asset) {
    throw managedError("client_platform_unsupported", `automatic tunnel-client installation is unsupported on ${options.platform}/${options.arch ?? process.arch}; set binaryPath or install a supported client manually`);
  }
  const verifyVersion = options.verifyVersion ?? (async () => true);
  const destination = managedOpenAiTunnelClientPath(options.managedRoot, asset);
  if (await managedClientValid(destination, asset, verifyVersion)) return destination;

  const installDir = dirname(destination);
  await mkdir(installDir, { recursive: true, mode: 0o700 });
  await chmod(installDir, 0o700).catch(() => undefined);
  const temporary = await mkdtemp(join(installDir, ".install-"));
  await chmod(temporary, 0o700).catch(() => undefined);
  try {
    const archivePath = join(temporary, asset.fileName);
    await downloadOpenAiTunnelClientAsset(`${OPENAI_TUNNEL_CLIENT_RELEASE_BASE}/${asset.fileName}`, archivePath, options);
    if (await sha256File(archivePath) !== asset.archiveSha256) {
      throw managedError("client_verification_failed", "downloaded tunnel-client archive failed SHA-256 verification");
    }
    const candidate = join(temporary, asset.memberName);
    await extractZipMember(archivePath, asset.memberName, candidate);
    if (await sha256File(candidate) !== asset.binarySha256) {
      throw managedError("client_verification_failed", "extracted tunnel-client binary failed SHA-256 verification");
    }
    await chmod(candidate, 0o700).catch(() => undefined);
    if (!(await verifyVersion(candidate))) {
      throw managedError("client_verification_failed", `managed tunnel-client failed pinned ${OPENAI_TUNNEL_CLIENT_PINNED_VERSION} version verification`);
    }
    await rm(destination, { force: true }).catch(() => undefined);
    await rename(candidate, destination).catch(() => {
      throw managedError("client_install_failed", "managed tunnel-client could not be installed atomically");
    });
    if (!(await managedClientValid(destination, asset, verifyVersion))) {
      throw managedError("client_verification_failed", "installed managed tunnel-client failed post-install verification");
    }
    return destination;
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function downloadOpenAiTunnelClientAsset(url: string, destination: string, options: OpenAiManagedInstallOptions): Promise<void> {
  const fetchImpl = options.fetch ?? fetch;
  const response = await runWithinTunnelDeadline(options.context, "client download", () => fetchImpl(url, { redirect: "follow", signal: options.context.signal }));
  if (!response.ok) throw managedError("client_download_failed", `tunnel-client download returned HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > OPENAI_TUNNEL_CLIENT_MAX_DOWNLOAD_BYTES) throw managedError("client_download_failed", "tunnel-client archive exceeds the download size limit");
  const chunks: Buffer[] = [];
  let total = 0;
  if (response.body) {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > OPENAI_TUNNEL_CLIENT_MAX_DOWNLOAD_BYTES) throw managedError("client_download_failed", "tunnel-client archive exceeds the download size limit");
      chunks.push(Buffer.from(chunk));
    }
  }
  await writeFile(destination, Buffer.concat(chunks), { mode: 0o600, flag: "wx" });
}

/**
 * Extract one member from a ZIP archive. Only the central directory is
 * trusted for sizes; stored and deflated members are supported, which covers
 * the published tunnel-client release assets.
 */
export async function extractZipMember(archivePath: string, memberName: string, destination: string): Promise<void> {
  const archive = await readFile(archivePath);
  const member = findZipMember(archive, memberName);
  const local = member.offset;
  if (archive.readUInt32LE(local) !== 0x04034b50) throw managedError("client_extraction_failed", "tunnel-client archive member header is invalid");
  const nameLength = archive.readUInt16LE(local + 26);
  const extraLength = archive.readUInt16LE(local + 28);
  const dataStart = local + 30 + nameLength + extraLength;
  const dataEnd = dataStart + member.compressedSize;
  if (dataEnd > archive.byteLength) throw managedError("client_extraction_failed", "tunnel-client archive member is truncated");
  const compressed = archive.subarray(dataStart, dataEnd);
  let bytes: Buffer;
  if (member.method === 0) bytes = Buffer.from(compressed);
  else if (member.method === 8) {
    try { bytes = inflateRawSync(compressed, { maxOutputLength: OPENAI_TUNNEL_CLIENT_MAX_BINARY_BYTES }); }
    catch { throw managedError("client_extraction_failed", "tunnel-client archive member could not be inflated"); }
  } else {
    throw managedError("client_extraction_failed", `tunnel-client archive member uses unsupported compression method ${member.method}`);
  }
  if (bytes.byteLength !== member.size) throw managedError("client_extraction_failed", "tunnel-client archive member size mismatch");
  await writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
}

interface ZipMember { offset: number; method: number; size: number; compressedSize: number }

function findZipMember(archive: Buffer, memberName: string): ZipMember {
  // End of central directory: scan backwards for the signature within the
  // maximum comment window.
  const minimum = Math.max(0, archive.byteLength - (0xffff + 22));
  let eocd = -1;
  for (let index = archive.byteLength - 22; index >= minimum; index -= 1) {
    if (archive.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) throw managedError("client_extraction_failed", "tunnel-client archive is not a valid ZIP file");
  const entries = archive.readUInt16LE(eocd + 10);
  const directoryOffset = archive.readUInt32LE(eocd + 16);
  for (let index = 0, cursor = directoryOffset; index < entries; index += 1) {
    if (cursor + 46 > archive.byteLength || archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw managedError("client_extraction_failed", "tunnel-client archive central directory is invalid");
    }
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const offset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (name === memberName) {
      if (size === 0xffffffff || compressedSize === 0xffffffff || offset === 0xffffffff) {
        throw managedError("client_extraction_failed", "tunnel-client archive member requires ZIP64, which is unsupported");
      }
      if (size > OPENAI_TUNNEL_CLIENT_MAX_BINARY_BYTES) throw managedError("client_extraction_failed", "tunnel-client archive member exceeds the binary size limit");
      return { offset, method, size, compressedSize };
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw managedError("client_extraction_failed", `tunnel-client archive does not contain ${memberName}`);
}

export function managedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
