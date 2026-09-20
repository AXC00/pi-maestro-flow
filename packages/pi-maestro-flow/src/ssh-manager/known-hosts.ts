import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SSH_HOST_KEY_PATTERN, type SshHost } from "./model.ts";

export const KNOWN_HOSTS_MAX_FILE_BYTES = 1024 * 1024;

export interface KnownHostsLookupOptions {
  files?: readonly string[];
  homeDirectory?: string;
}

interface KnownHostRecord {
  names: string[];
  hashed: Array<{ salt: Buffer; digest: Buffer }>;
  fingerprint: string;
}

export function defaultKnownHostsFiles(homeDirectory = homedir()): string[] {
  const directory = join(homeDirectory, ".ssh");
  return [join(directory, "known_hosts"), join(directory, "known_hosts2")];
}

export function knownHostLookupNames(hostname: string, port: number): string[] {
  const names = new Set<string>([hostname, `[${hostname}]:${port}`]);
  if (port === 22) names.add(`[${hostname}]:22`);
  return [...names];
}

export async function lookupKnownHostFingerprints(
  hostname: string,
  port: number,
  options: KnownHostsLookupOptions = {},
): Promise<string[]> {
  if (!hostname || !Number.isInteger(port) || port < 1 || port > 65_535) return [];
  return fingerprintsForHost(await loadKnownHostRecords(options), hostname, port);
}

function uniqueStrings(values: readonly string[]): string[] { return [...new Set(values)]; }

function fingerprintsForHost(records: readonly KnownHostRecord[], hostname: string, port: number): string[] {
  const names = knownHostLookupNames(hostname, port);
  const fingerprints = new Set<string>();
  for (const record of records) {
    if (!names.some((name) => recordMatchesName(record, name))) continue;
    fingerprints.add(record.fingerprint);
  }
  return [...fingerprints];
}

export async function pinUntrustedHostsFromKnownHosts(
  hosts: readonly SshHost[],
  update: (host: SshHost, fingerprint: string) => Promise<void>,
  options: KnownHostsLookupOptions = {},
): Promise<number> {
  const untrusted = hosts.filter((host) => host.hostKey === null);
  if (untrusted.length === 0) return 0;
  const records = await loadKnownHostRecords(options);
  let pinned = 0;
  for (const host of untrusted) {
    const fingerprints = uniqueStrings([
      ...fingerprintsForHost(records, host.host, host.port),
      ...(host.label !== host.host ? fingerprintsForHost(records, host.label, host.port) : []),
    ]);
    if (fingerprints.length !== 1) continue;
    await update(host, fingerprints[0]!);
    pinned += 1;
  }
  return pinned;
}

async function loadKnownHostRecords(options: KnownHostsLookupOptions): Promise<KnownHostRecord[]> {
  const files = options.files ?? defaultKnownHostsFiles(options.homeDirectory);
  const records: KnownHostRecord[] = [];
  for (const file of files) {
    const text = await readKnownHostsFile(file);
    if (text === undefined) continue;
    records.push(...parseKnownHosts(text));
  }
  return records;
}

export function parseKnownHosts(text: string): KnownHostRecord[] {
  const records: KnownHostRecord[] = [];
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const tokens = line.split(/\s+/u);
    if (tokens[0]?.startsWith("@")) continue;
    if (tokens.length < 3) continue;
    const [hostField, , key] = tokens;
    if (!hostField || !key) continue;
    let blob: Buffer;
    try { blob = Buffer.from(key, "base64"); } catch { continue; }
    if (blob.length === 0) continue;
    const fingerprint = `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/u, "")}`;
    blob.fill(0);
    if (!SSH_HOST_KEY_PATTERN.test(fingerprint)) continue;
    const names: string[] = [];
    const hashed: KnownHostRecord["hashed"] = [];
    for (const part of hostField.split(",")) {
      if (part.startsWith("|1|")) {
        const parsed = parseHashedName(part);
        if (parsed) hashed.push(parsed);
        continue;
      }
      if (part) names.push(part);
    }
    if (names.length === 0 && hashed.length === 0) continue;
    records.push({ names, hashed, fingerprint });
  }
  return records;
}

function recordMatchesName(record: KnownHostRecord, name: string): boolean {
  if (record.names.includes(name)) return true;
  const encoded = Buffer.from(name, "utf8");
  try {
    return record.hashed.some((entry) => hashedNameMatches(entry, encoded));
  } finally {
    encoded.fill(0);
  }
}

function parseHashedName(value: string): { salt: Buffer; digest: Buffer } | undefined {
  const parts = value.split("|");
  if (parts.length !== 4 || parts[1] !== "1" || !parts[2] || !parts[3]) return undefined;
  try {
    const salt = Buffer.from(parts[2], "base64");
    const digest = Buffer.from(parts[3], "base64");
    if (salt.length === 0 || digest.length === 0) return undefined;
    return { salt, digest };
  } catch {
    return undefined;
  }
}

function hashedNameMatches(entry: { salt: Buffer; digest: Buffer }, name: Buffer): boolean {
  const actual = createHmac("sha1", entry.salt).update(name).digest();
  try {
    return actual.length === entry.digest.length && timingSafeEqual(actual, entry.digest);
  } finally {
    actual.fill(0);
  }
}

async function readKnownHostsFile(path: string): Promise<string | undefined> {
  const absolute = resolve(path);
  if (await inspectSafeRegularFile(absolute) !== "regular") return undefined;
  const before = await lstat(absolute);
  if (before.size <= 0 || before.size > KNOWN_HOSTS_MAX_FILE_BYTES) return undefined;
  const handle = await open(absolute, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  let bytes: Buffer | undefined;
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.size !== before.size || after.size > KNOWN_HOSTS_MAX_FILE_BYTES) return undefined;
    bytes = Buffer.alloc(Number(after.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) return undefined;
      offset += bytesRead;
    }
    return bytes.toString("utf8");
  } catch {
    return undefined;
  } finally {
    bytes?.fill(0);
    await handle.close().catch(() => undefined);
  }
}

async function inspectSafeRegularFile(path: string): Promise<"regular" | "missing" | "unsafe"> {
  try {
    const info = await lstat(resolve(path));
    if (info.isSymbolicLink()) return "unsafe";
    return info.isFile() ? "regular" : "unsafe";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unsafe";
  }
}
