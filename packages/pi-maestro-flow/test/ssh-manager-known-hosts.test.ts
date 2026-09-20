import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sha256HostKeyFingerprint } from "../src/ssh-manager/executor.ts";
import {
  lookupKnownHostFingerprints,
  parseKnownHosts,
  pinUntrustedHostsFromKnownHosts,
} from "../src/ssh-manager/known-hosts.ts";
import type { SshHost } from "../src/ssh-manager/model.ts";

const KEY = Buffer.from("server-public-key-blob");
const PIN = sha256HostKeyFingerprint(KEY);
const KEY_B64 = KEY.toString("base64");
const OTHER_KEY = Buffer.from("other-public-key-blob");
const OTHER_PIN = sha256HostKeyFingerprint(OTHER_KEY);
const OTHER_B64 = OTHER_KEY.toString("base64");

function host(overrides: Partial<SshHost> = {}): SshHost {
  return {
    id: "server-1",
    label: "Server",
    host: "example.com",
    user: "tester",
    port: 22,
    shell: "bash",
    hostKey: null,
    auth: { kind: "agent" },
    tags: [],
    jumpHostId: null,
    monitorEnabled: false,
    ...overrides,
  };
}

test("parseKnownHosts reads plain, bracketed, and hashed host names", () => {
  const salt = randomBytes(20);
  const hashed = `|1|${salt.toString("base64")}|${createHmac("sha1", salt).update("hashed.example").digest("base64")}`;
  const records = parseKnownHosts([
    `# comment`,
    `example.com ssh-ed25519 ${KEY_B64} comment`,
    `[other.example]:2222 ssh-rsa ${OTHER_B64}`,
    `${hashed} ssh-ed25519 ${KEY_B64}`,
    `@revoked bad.example ssh-ed25519 ${KEY_B64}`,
  ].join("\n"));
  assert.equal(records.length, 3);
  assert.equal(records[0]?.fingerprint, PIN);
  assert.deepEqual(records[0]?.names, ["example.com"]);
  assert.deepEqual(records[1]?.names, ["[other.example]:2222"]);
  assert.equal(records[1]?.fingerprint, OTHER_PIN);
  assert.equal(records[2]?.names.length, 0);
  assert.equal(records[2]?.hashed.length, 1);
});

test("lookupKnownHostFingerprints matches host, port, and hashed names from a file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "known-hosts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const salt = randomBytes(20);
  const hashed = `|1|${salt.toString("base64")}|${createHmac("sha1", salt).update("[hashed.example]:2200").digest("base64")}`;
  const file = join(root, "known_hosts");
  await writeFile(file, [
    `example.com ssh-ed25519 ${KEY_B64}`,
    `example.com ssh-rsa ${OTHER_B64}`,
    `[alt.example]:2222 ssh-ed25519 ${KEY_B64}`,
    `${hashed} ssh-ed25519 ${KEY_B64}`,
  ].join("\n"));
  const options = { files: [file] };
  assert.deepEqual((await lookupKnownHostFingerprints("example.com", 22, options)).sort(), [PIN, OTHER_PIN].sort());
  assert.deepEqual(await lookupKnownHostFingerprints("alt.example", 2222, options), [PIN]);
  assert.deepEqual(await lookupKnownHostFingerprints("hashed.example", 2200, options), [PIN]);
  assert.deepEqual(await lookupKnownHostFingerprints("missing.example", 22, options), []);
});

test("pinUntrustedHostsFromKnownHosts pins only unique fingerprints", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "known-hosts-pin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "known_hosts");
  await writeFile(file, [
    `unique.example ssh-ed25519 ${KEY_B64}`,
    `multi.example ssh-ed25519 ${KEY_B64}`,
    `multi.example ssh-rsa ${OTHER_B64}`,
  ].join("\n"));
  const hosts = [
    host({ id: "unique", host: "unique.example" }),
    host({ id: "multi", host: "multi.example" }),
    host({ id: "already", host: "unique.example", hostKey: OTHER_PIN }),
  ];
  const pinned: string[] = [];
  const count = await pinUntrustedHostsFromKnownHosts(
    hosts,
    async (item, fingerprint) => { item.hostKey = fingerprint; pinned.push(item.id); },
    { files: [file] },
  );
  assert.equal(count, 1);
  assert.deepEqual(pinned, ["unique"]);
  assert.equal(hosts[0]?.hostKey, PIN);
  assert.equal(hosts[1]?.hostKey, null);
  assert.equal(hosts[2]?.hostKey, OTHER_PIN);
});
