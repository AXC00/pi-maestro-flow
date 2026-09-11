import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { GatewayTunnelProviderRequest, GatewayTunnelStartResult } from "../src/gateway/tunnel/contracts.ts";
import { createGatewayTunnelDeadline, probeGatewayTunnel } from "../src/gateway/tunnel/probe.ts";
import { setGatewayControlClientForTest, updateGatewayConfigServerURL } from "../src/gateway/workspace-client.ts";
import type { GatewayTunnelPublicState } from "../src/gateway/tunnel/provider.ts";
import {
  CloudflareQuickTunnelProvider,
  cloudflareNamedTunnelArgs,
  cloudflareQuickTunnelArgs,
  isCloudflareQuickTunnelCommandLine,
  parseCloudflareQuickTunnelUrl,
} from "../src/gateway/tunnel/providers/cloudflare.ts";

const request: GatewayTunnelProviderRequest = {
  provider: "cloudflare",
  instance: "default",
  generation: 1,
  ownerToken: "owner-token-00000001",
  input: { mode: "quick", localPort: 19090 },
};

function fakeChild(pid = 41001): ChildProcess & { stdout: PassThrough; stderr: PassThrough; setExit(code: number | null, signal?: NodeJS.Signals | null): void } {
  const child = new EventEmitter() as ChildProcess & { stdout: PassThrough; stderr: PassThrough; setExit(code: number | null, signal?: NodeJS.Signals | null): void };
  Object.assign(child, {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: null,
    stdio: [],
    connected: false,
    killed: false,
    exitCode: null,
    signalCode: null,
    spawnargs: [],
    spawnfile: "cloudflared",
    channel: undefined,
    unref() {},
    ref() {},
    kill() { return true; },
    disconnect() {},
    send() { return false; },
    setExit(code: number | null, signal: NodeJS.Signals | null = null) {
      child.exitCode = code;
      child.signalCode = signal;
      child.emit("exit", code, signal);
    },
  });
  return child;
}

async function fixture(t: test.TestContext, options: {
  fetch?: typeof fetch;
  discover?: () => Array<{ pid: number; commandLine: string }> | undefined;
  child?: ReturnType<typeof fakeChild>;
  maxOutputBytes?: number;
  processAlive?: (pid: number) => boolean;
  signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  now?: () => number;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "gateway-cloudflare-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  await writeFile(binary, "test binary");
  const child = options.child ?? fakeChild();
  const spawned: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const provider = new CloudflareQuickTunnelProvider({
    binaryPath: binary,
    fetch: options.fetch,
    discoverProcesses: options.discover ?? (() => []),
    spawn: ((command: string, args: readonly string[], spawnOptions: SpawnOptions) => {
      spawned.push({ command, args: [...args], options: spawnOptions });
      return child;
    }) as typeof import("node:child_process").spawn,
    processAlive: options.processAlive ?? (() => child.exitCode === null),
    signalProcess: options.signalProcess,
    maxOutputBytes: options.maxOutputBytes,
    now: options.now,
    platform: "linux",
  });
  return { provider, child, binary, root, spawned };
}

function deadline(timeoutMs = 2_000) {
  return createGatewayTunnelDeadline(timeoutMs);
}

test("Quick Tunnel argv and URL parsing reject named or mutated tunnels", () => {
  assert.deepEqual(cloudflareQuickTunnelArgs(19090), ["tunnel", "--protocol", "http2", "--url", "http://127.0.0.1:19090"]);
  assert.equal(isCloudflareQuickTunnelCommandLine("cloudflared tunnel --protocol http2 --url http://127.0.0.1:19090", 19090), true);
  assert.equal(isCloudflareQuickTunnelCommandLine("cloudflared tunnel --url http://127.0.0.1:19090", 19090), true, "legacy quick processes remain detectable for duplicate prevention");
  assert.equal(isCloudflareQuickTunnelCommandLine("cloudflared tunnel run named-tunnel", 19090), false);
  assert.equal(isCloudflareQuickTunnelCommandLine("cloudflared tunnel --protocol quic --url http://127.0.0.1:19090", 19090), false);
  assert.equal(parseCloudflareQuickTunnelUrl("INF https://abc-123.trycloudflare.com ready"), "https://abc-123.trycloudflare.com");
  assert.equal(parseCloudflareQuickTunnelUrl("https://example.com"), undefined);
});

test("Named Tunnel argv supports credentials-file and token-file references", async (t) => {
  for (const credential of [
    { field: "credentialsFile", flag: "--credentials-file", filename: "credentials.json" },
    { field: "tokenFile", flag: "--token-file", filename: "token.txt" },
  ] as const) {
    await t.test(credential.field, async (t) => {
      const probed: string[] = [];
      const fetchImpl: typeof fetch = async (input) => {
        probed.push(String(input));
        return new Response("ready", { status: 200 });
      };
      const { provider, child, binary, root, spawned } = await fixture(t, { fetch: fetchImpl });
      const credentialPath = join(root, credential.filename);
      await writeFile(credentialPath, "reference-only-secret");
      const namedRequest: GatewayTunnelProviderRequest = {
        ...request,
        generation: credential.field === "credentialsFile" ? 10 : 11,
        ownerToken: `owner-token-${credential.field}-0001`,
        input: {
          mode: "named",
          tunnelId: "prod_gateway-01",
          publicUrl: "https://gateway.example.com/",
          [credential.field]: credentialPath,
          localPort: 19091,
          binaryPath: binary,
        },
      };
      const context = deadline();
      t.after(() => context.close());

      assert.deepEqual(await provider.doctor(context, namedRequest), { ok: true, executablePath: binary });
      const started = await provider.start(context, namedRequest);
      const expectedArgs = cloudflareNamedTunnelArgs({
        localPort: 19091,
        tunnelId: "prod_gateway-01",
        credentialFlag: credential.flag,
        credentialPath,
      });
      assert.deepEqual(started.args, expectedArgs);
      assert.deepEqual(spawned, [{
        command: binary,
        args: expectedArgs,
        options: { detached: true, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true },
      }]);
      assert.equal(started.endpoint, "https://gateway.example.com");

      child.stderr.write("INF unrelated https://wrong.trycloudflare.com URL\n");
      const ready = await provider.probe(context, started, namedRequest);
      assert.deepEqual(probed, ["http://127.0.0.1:19091/mcp", "https://gateway.example.com/mcp"]);
      assert.equal(ready.ready, true);
      assert.equal(ready.endpoint, "https://gateway.example.com");
      assert.match(ready.detail ?? "", /provider: configured URL/u);

      child.stderr.write(`must-not-persist ${credentialPath} reference-only-secret\n`);
      child.setExit(7);
      const exit = await started.exited;
      assert.equal(exit.detail, undefined, "Named Tunnel logs and argv references are not exposed to durable exit state");
    });
  }
});

test("Named Tunnel rejects missing, ambiguous, relative, or unavailable credential references", async (t) => {
  const { provider, root } = await fixture(t);
  const credentialsFile = join(root, "credentials.json");
  const tokenFile = join(root, "token.txt");
  await Promise.all([writeFile(credentialsFile, "{}"), writeFile(tokenFile, "token")]);
  const base = { mode: "named", tunnelId: "prod-01", publicUrl: "https://gateway.example.com", localPort: 19091 } as const;
  const context = deadline();
  t.after(() => context.close());

  await assert.rejects(() => provider.doctor(context, { ...request, input: base }), /exactly one/u);
  await assert.rejects(() => provider.doctor(context, { ...request, input: { ...base, credentialsFile, tokenFile } }), /exactly one/u);
  await assert.rejects(() => provider.doctor(context, { ...request, input: { ...base, credentialsFile: "relative.json" } }), /absolute existing file path/u);
  await assert.rejects(() => provider.doctor(context, { ...request, input: { ...base, tokenFile: join(root, "missing-token.txt") } }), /absolute existing file path/u);
  await assert.rejects(() => provider.doctor(context, { ...request, input: { ...base, tokenFile: root } }), /regular file/u);
  const symlinkPath = join(root, "token-link.txt");
  try {
    await symlink(tokenFile, symlinkPath, "file");
    await assert.rejects(() => provider.doctor(context, { ...request, input: { ...base, tokenFile: symlinkPath } }), /non-symlink regular file/u);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EACCES") throw error;
    t.diagnostic(`symlink creation unavailable on this platform (${code})`);
  }
  assert.equal((await provider.doctor(context, { ...request, input: { ...base, tokenFile, binaryPath: "relative-cloudflared" } })).ok, false);
  assert.equal((await provider.doctor(context, { ...request, input: { ...base, tokenFile, binaryPath: join(root, "missing-cloudflared") } })).ok, false);
});

test("Named Tunnel rejects literal secrets/config and unsafe identifiers or public URLs", async (t) => {
  const { provider, root } = await fixture(t);
  const tokenFile = join(root, "token.txt");
  await writeFile(tokenFile, "token");
  const base: Readonly<Record<string, unknown>> = {
    mode: "named",
    tunnelId: "prod-01",
    publicUrl: "https://gateway.example.com",
    tokenFile,
    localPort: 19091,
  };
  const context = deadline();
  t.after(() => context.close());

  for (const key of ["token", "credentials", "credentialsContents", "config", "configContents", "configFile"] as const) {
    await assert.rejects(
      () => provider.doctor(context, { ...request, input: { ...base, [key]: "literal-secret-or-config" } }),
      /rejects literal secret\/config input/u,
    );
  }
  for (const tunnelId of ["../prod", "-prod", "prod.", "prod tunnel", "a".repeat(129)]) {
    await assert.rejects(() => provider.doctor(context, { ...request, input: { ...base, tunnelId } }), /safe identifier/u);
  }
  for (const publicUrl of [
    "http://gateway.example.com",
    "https://user:pass@gateway.example.com",
    "https://gateway.example.com/mcp",
    "https://gateway.example.com?secret=value",
    "https://gateway.example.com#fragment",
  ]) {
    await assert.rejects(() => provider.doctor(context, { ...request, input: { ...base, publicUrl } }), /HTTPS origin/u);
  }
});

test("stderr URL delay and Cloudflare 1033 do not bypass local/provider/public readiness", async (t) => {
  let publicAttempts = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1:")) return new Response("local", { status: 200 });
    publicAttempts += 1;
    return publicAttempts === 1
      ? new Response("Cloudflare Tunnel Error 1033", { status: 530 })
      : new Response("", { status: 401, headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://meta.invalid"' } });
  };
  const { provider, child, binary } = await fixture(t, { fetch: fetchImpl });
  const context = deadline();
  t.after(() => context.close());
  assert.deepEqual(await provider.doctor(context, request), { ok: true, executablePath: binary });
  const started = await provider.start(context, request);
  const waitingForUrl = await provider.probe(context, started, request);
  assert.equal(waitingForUrl.ready, false);
  assert.match(waitingForUrl.detail ?? "", /provider: waiting/u);

  child.stderr.write("INF Your quick Tunnel has been created at https://delayed.trycloudflare.com\n");
  const edgePending = await provider.probe(context, started, request);
  assert.equal(edgePending.ready, false, "1033 is registration pending, never ready");
  assert.equal(edgePending.endpoint, "https://delayed.trycloudflare.com");
  assert.match(edgePending.detail ?? "", /1033/u);

  const ready = await provider.probe(context, started, request);
  assert.equal(ready.ready, true);
  assert.equal(ready.endpoint, "https://delayed.trycloudflare.com");
  assert.match(ready.detail ?? "", /local: ready.*provider: URL acquired.*public: OAuth/u);
});

test("clean and nonzero exits before readiness are terminal and retain bounded stderr evidence", async (t) => {
  for (const code of [0, 7]) {
    await t.test(`exit ${code}`, async (t) => {
      const child = fakeChild(42000 + code);
      const { provider } = await fixture(t, { child, maxOutputBytes: 1024 });
      const context = deadline();
      t.after(() => context.close());
      const started = await provider.start(context, { ...request, generation: code + 1, ownerToken: `owner-token-0000000${code + 1}` });
      child.stderr.write(`prefix-${"x".repeat(4_000)}-diagnostic-tail-${code}\n`);
      child.setExit(code);
      const result = await provider.probe(context, started, { ...request, generation: code + 1, ownerToken: `owner-token-0000000${code + 1}` });
      assert.equal(result.ready, false);
      assert.equal(result.terminal, true);
      assert.match(result.detail ?? "", new RegExp(`exit=${code}`));
      assert.match(result.detail ?? "", new RegExp(`diagnostic-tail-${code}`));
      assert.doesNotMatch(result.detail ?? "", /prefix-/u, "old output is evicted by the byte cap");
      assert.ok(Buffer.byteLength(result.detail ?? "", "utf8") <= 16 * 1024);
    });
  }
});

test("duplicate or incomplete process discovery fails closed before spawning", async (t) => {
  for (const [label, discover, pattern] of [
    ["duplicate", () => [{ pid: 99, commandLine: "cloudflared tunnel --url http://127.0.0.1:19090" }], /existing Cloudflare Quick Tunnel/u],
    ["incomplete", () => undefined, /discovery was incomplete/u],
  ] as const) {
    await t.test(label, async (t) => {
      const child = fakeChild();
      let spawned = false;
      const { provider } = await fixture(t, { discover });
      provider["spawnImpl"] = ((..._args: unknown[]) => { spawned = true; return child; }) as never;
      const context = deadline();
      t.after(() => context.close());
      await assert.rejects(() => provider.start(context, request), pattern);
      assert.equal(spawned, false);
    });
  }
});

test("an absolute timeout aborts a hung local readiness probe and cleans up through the supervisor helper", async (t) => {
  const fetchImpl = (() => new Promise<Response>(() => undefined)) as typeof fetch;
  const { provider, child } = await fixture(t, { fetch: fetchImpl });
  const context = deadline(40);
  const started = await provider.start(context, request);
  child.stderr.write("https://timeout.trycloudflare.com\n");
  await assert.rejects(() => probeGatewayTunnel(context, () => provider.probe(context, started, request)), /deadline/u);
  context.close();
});

test("stop escalates TERM to KILL only for the supervisor-verified pid", async (t) => {
  let alive = true;
  let clock = 0;
  const signals: Array<[number, NodeJS.Signals | 0]> = [];
  const { provider } = await fixture(t, {
    processAlive: () => alive,
    signalProcess: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === "SIGKILL") alive = false;
    },
    now: () => { clock += 1_000; return clock; },
  });
  const context = deadline(5_000);
  t.after(() => context.close());
  const started = await provider.start(context, request);
  await provider.stop(context, {
    pid: started.pid,
    executableRealpath: started.executablePath,
    processStartIdentity: "boot:1",
    invocationDigest: "digest",
    generation: request.generation,
    ownerToken: request.ownerToken,
  }, { ...request, reason: "explicit" });
  assert.deepEqual(signals, [[-started.pid, "SIGTERM"], [-started.pid, "SIGKILL"]]);
});

test("a stale native generation cannot overwrite the configured public endpoint", async (t) => {
  const agentRoot = await mkdtemp(join(tmpdir(), "gateway-cloudflare-config-fence-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentRoot;
  const configPath = join(agentRoot, "gateway", "config.yaml");
  await mkdir(join(agentRoot, "gateway"), { recursive: true });
  await writeFile(configPath, "auth:\n  mode: oauth\n  oauth:\n    server_url: https://original.trycloudflare.com\n");
  const current: GatewayTunnelPublicState = {
    version: 1,
    provider: "cloudflare",
    instance: "default",
    desiredState: "running",
    observed: { phase: "ready", changedAt: 1, endpoint: "https://new.trycloudflare.com" },
    generation: 4,
    pid: 44,
    executableRealpath: "/cloudflared",
    processStartIdentity: "boot:44",
    invocationDigest: "a".repeat(64),
    restartHistory: [],
    updatedAt: 1,
  };
  const restore = setGatewayControlClientForTest({ tunnelStatus: async () => current } as never);
  t.after(async () => {
    restore();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentRoot, { recursive: true, force: true });
  });
  await assert.rejects(
    () => updateGatewayConfigServerURL("https://stale.trycloudflare.com", { generation: 3, endpoint: "https://stale.trycloudflare.com" }),
    /generation is stale/u,
  );
  assert.match(await readFile(configPath, "utf8"), /original\.trycloudflare\.com/u);
  await updateGatewayConfigServerURL(current.observed.endpoint!, { generation: 4, endpoint: current.observed.endpoint! });
  assert.match(await readFile(configPath, "utf8"), /new\.trycloudflare\.com/u);
});

test("unavailable explicit binaries are rejected without download", async (t) => {
  const context = deadline();
  t.after(() => context.close());
  const missing = new CloudflareQuickTunnelProvider({ binaryPath: join(tmpdir(), "definitely-missing-cloudflared"), discoverProcesses: () => [] });
  assert.equal((await missing.doctor(context, request)).ok, false);
});
