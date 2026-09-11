import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GatewayTunnelProviderRequest } from "../src/gateway/tunnel/contracts.ts";
import { gatewayTunnelInvocationDigest } from "../src/gateway/tunnel/process-owner.ts";
import { createGatewayTunnelDeadline } from "../src/gateway/tunnel/probe.ts";
import {
  SshReverseTunnelProvider,
  resolveSshExecutable,
  sshReverseTunnelArgs,
  type SshReverseCommandResult,
} from "../src/gateway/tunnel/providers/ssh-reverse.ts";
import { SshReverseTunnelProvider as PublicSshReverseTunnelProvider } from "../src/gateway/public/v1/index.ts";

function fakeChild(pid = 61001): ChildProcess & { setExit(code: number | null, signal?: NodeJS.Signals | null): void } {
  const child = new EventEmitter() as ChildProcess & { setExit(code: number | null, signal?: NodeJS.Signals | null): void };
  Object.assign(child, {
    pid,
    stdout: null,
    stderr: null,
    stdin: null,
    stdio: [],
    connected: false,
    killed: false,
    exitCode: null,
    signalCode: null,
    spawnargs: [],
    spawnfile: "ssh",
    channel: undefined,
    unref() {},
    ref() {},
    kill() { child.killed = true; return true; },
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

function request(input: Readonly<Record<string, unknown>>): GatewayTunnelProviderRequest {
  return {
    provider: "ssh",
    instance: "ssh-prod",
    generation: 7,
    ownerToken: "owner-token-ssh-0007",
    input,
  };
}

function baseInput(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    mode: "reverse",
    publicUrl: "https://mcp.example.com",
    host: "gateway-edge.example.net",
    user: "tunnel",
    port: 2222,
    remoteBindHost: "127.0.0.1",
    remotePort: 19090,
    localHost: "127.0.0.1",
    localPort: 9090,
    mcpPath: "/mcp",
    connectTimeoutSeconds: 10,
    serverAliveIntervalSeconds: 15,
    serverAliveCountMax: 3,
    ...overrides,
  };
}

function deadline(timeoutMs = 2_000) {
  return createGatewayTunnelDeadline(timeoutMs);
}

test("gateway/v1 exports the managed SSH provider", () => {
  assert.equal(PublicSshReverseTunnelProvider, SshReverseTunnelProvider);
});

async function fixture(t: test.TestContext, options: {
  fetch?: typeof fetch;
  child?: ReturnType<typeof fakeChild>;
  processAlive?: (pid: number) => boolean;
  signalProcess?: (pid: number, signal: NodeJS.Signals | 0) => void;
  now?: () => number;
  runCommand?: (command: string, args: readonly string[]) => Promise<SshReverseCommandResult>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "gateway-ssh-reverse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, process.platform === "win32" ? "ssh.exe" : "ssh");
  const identityFile = join(root, "id_ed25519");
  const configFile = join(root, "ssh_config");
  const knownHostsFile = join(root, "known_hosts");
  await Promise.all([
    writeFile(binary, "fake ssh"),
    writeFile(identityFile, "fake identity"),
    writeFile(configFile, "Host *\n"),
    writeFile(knownHostsFile, "example ssh-ed25519 AAAA\n"),
  ]);
  if (process.platform !== "win32") await chmod(binary, 0o755);
  const child = options.child ?? fakeChild();
  const spawned: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const commandCalls: Array<{ command: string; args: readonly string[] }> = [];
  const runCommand = options.runCommand ?? (async (command: string, args: readonly string[]) => {
    commandCalls.push({ command, args: [...args] });
    return args[0] === "-V"
      ? { code: 0, stdout: "", stderr: "OpenSSH_9.8p1 test" }
      : { code: 0, stdout: "hostname gateway-edge.example.net\n", stderr: "" };
  });
  const provider = new SshReverseTunnelProvider({
    binaryPath: binary,
    fetch: options.fetch,
    spawn: ((command: string, args: readonly string[], spawnOptions: SpawnOptions) => {
      spawned.push({ command, args: [...args], options: spawnOptions });
      return child;
    }) as typeof import("node:child_process").spawn,
    runCommand: async (command, args) => runCommand(command, args),
    processAlive: options.processAlive ?? (() => child.exitCode === null),
    signalProcess: options.signalProcess,
    now: options.now,
  });
  return { provider, child, binary, identityFile, configFile, knownHostsFile, spawned, commandCalls };
}

test("managed reverse tunnel uses exact safe argv and shell:false", async (t) => {
  const fx = await fixture(t);
  const profileRequest = request(baseInput({
    binaryPath: fx.binary,
    identityFile: fx.identityFile,
    configFile: fx.configFile,
    knownHostsFile: fx.knownHostsFile,
  }));
  const context = deadline();
  t.after(() => context.close());

  assert.deepEqual(await fx.provider.doctor(context, profileRequest), {
    ok: true,
    executablePath: fx.binary,
    version: "9.8p1",
  });
  const started = await fx.provider.start(context, profileRequest);
  const expected = [
    "-F", fx.configFile,
    "-i", fx.identityFile,
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "PermitLocalCommand=no",
    "-o", "RequestTTY=no",
    "-o", "ForkAfterAuthentication=no",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ControlPersist=no",
    "-o", "ClearAllForwardings=no",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", `UserKnownHostsFile=${fx.knownHostsFile}`,
    "-p", "2222",
    "-N",
    "-R", "127.0.0.1:19090:127.0.0.1:9090",
    "tunnel@gateway-edge.example.net",
  ];
  assert.deepEqual(started.args, expected);
  assert.equal(started.endpoint, "https://mcp.example.com");
  assert.deepEqual(fx.spawned, [{
    command: fx.binary,
    args: expected,
    options: { detached: false, stdio: ["ignore", "ignore", "ignore"], shell: false, windowsHide: true },
  }]);
  assert.equal(fx.commandCalls.filter((call) => call.args[0] === "-V").length, 2, "start revalidates executable identity");
  const rendered = JSON.stringify(expected);
  assert.doesNotMatch(rendered, /password|private key|remoteCommand/u);
});

test("IPv6 loopback forwarding is bracketed without exposing arbitrary argv", () => {
  assert.deepEqual(sshReverseTunnelArgs({
    localPort: 9090,
    host: "2001:db8::10",
    port: 22,
    remoteBindHost: "::1",
    remotePort: 19090,
    localHost: "::1",
    connectTimeoutSeconds: 12,
    serverAliveIntervalSeconds: 20,
    serverAliveCountMax: 2,
  }), [
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "PermitLocalCommand=no",
    "-o", "RequestTTY=no",
    "-o", "ForkAfterAuthentication=no",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ControlPersist=no",
    "-o", "ClearAllForwardings=no",
    "-o", "ConnectTimeout=12",
    "-o", "ServerAliveInterval=20",
    "-o", "ServerAliveCountMax=2",
    "-p", "22",
    "-N",
    "-R", "[::1]:19090:[::1]:9090",
    "2001:db8::10",
  ]);
});

test("input rejects unsafe destinations, bind addresses, URLs, secrets, commands, and unknown fields", async (t) => {
  const fx = await fixture(t);
  const cases: Array<[string, Readonly<Record<string, unknown>>, RegExp]> = [
    ["mode", baseInput({ mode: "forward" }), /mode is supported/u],
    ["host option", baseInput({ host: "-proxy" }), /host must be/u],
    ["host whitespace", baseInput({ host: "gateway edge" }), /host must be/u],
    ["user option", baseInput({ user: "-root" }), /user must be/u],
    ["port", baseInput({ port: 0 }), /port must be/u],
    ["remote bind", baseInput({ remoteBindHost: "0.0.0.0" }), /must be loopback/u],
    ["local bind", baseInput({ localHost: "localhost" }), /must be loopback/u],
    ["path", baseInput({ mcpPath: "/mcp?token=x" }), /mcpPath/u],
    ["public URL", baseInput({ publicUrl: "https://mcp.example.com/mcp" }), /HTTPS origin/u],
    ["password", baseInput({ password: "do-not-log-me" }), /rejects secret/u],
    ["private key", baseInput({ privateKeyContents: "do-not-log-me" }), /rejects secret/u],
    ["argv", baseInput({ argv: ["-L", "0.0.0.0:1:x:1"] }), /arbitrary argv/u],
    ["command", baseInput({ remoteCommand: "uname" }), /command/u],
    ["unknown", baseInput({ surprise: true }), /Unknown SSH/u],
  ];
  for (const [label, input, pattern] of cases) {
    await t.test(label, async () => {
      const context = deadline();
      try {
        const result = await fx.provider.doctor(context, request(input));
        assert.equal(result.ok, false);
        assert.match(result.detail ?? "", pattern);
        assert.doesNotMatch(result.detail ?? "", /do-not-log-me/u);
      } finally { context.close(); }
    });
  }
});

test("doctor resolves system or explicit ssh and rejects bad files, identity, or configured forwards", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-ssh-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, process.platform === "win32" ? "ssh.exe" : "ssh");
  const identityFile = join(root, "id_ed25519");
  await Promise.all([writeFile(binary, "fake ssh"), writeFile(identityFile, "identity")]);
  if (process.platform !== "win32") await chmod(binary, 0o755);
  assert.equal(resolveSshExecutable(binary), binary);
  assert.equal(resolveSshExecutable(join(root, "missing-ssh")), undefined);

  const resolved: Array<string | undefined> = [];
  let configOutput = "hostname gateway-edge.example.net\n";
  let configTruncated = false;
  let versionOutput = "OpenSSH_for_Windows_9.5p1";
  let configArgs: readonly string[] = [];
  const provider = new SshReverseTunnelProvider({
    resolveBinary: (explicit) => { resolved.push(explicit); return explicit === "missing" ? undefined : binary; },
    runCommand: async (_command, args) => {
      if (args[0] === "-V") return { code: 0, stdout: "", stderr: versionOutput };
      configArgs = [...args];
      return { code: 0, stdout: configOutput, stderr: "", ...(configTruncated ? { stdoutTruncated: true } : {}) };
    },
  });

  let context = deadline();
  assert.equal((await provider.doctor(context, request(baseInput()))).ok, true);
  context.close();
  assert.equal(resolved[0], undefined, "omitted binary path resolves the system ssh client");
  assert.equal(configArgs[0], "-G");
  assert.equal(configArgs.includes("-R"), false, "doctor inspects only pre-existing effective forwards");
  assert.equal(configArgs.includes("ClearAllForwardings=no"), true);

  context = deadline();
  assert.equal((await provider.doctor(context, request(baseInput({ binaryPath: binary })))).ok, true);
  context.close();
  assert.equal(resolved.includes(binary), true);

  context = deadline();
  const missingBinary = await provider.doctor(context, request(baseInput({ binaryPath: "missing" })));
  context.close();
  assert.equal(missingBinary.ok, false);
  assert.match(missingBinary.detail ?? "", /unavailable or not executable/u);

  context = deadline();
  const missingFile = await provider.doctor(context, request(baseInput({ identityFile: join(root, "missing-id") })));
  context.close();
  assert.equal(missingFile.ok, false);
  assert.match(missingFile.detail ?? "", /non-symlink regular file/u);

  const identityLink = join(root, "identity-link");
  try {
    await symlink(identityFile, identityLink, "file");
    context = deadline();
    const linked = await provider.doctor(context, request(baseInput({ identityFile: identityLink })));
    context.close();
    assert.equal(linked.ok, false);
    assert.match(linked.detail ?? "", /non-symlink regular file/u);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EACCES") throw error;
    t.diagnostic(`symlink creation unavailable on this platform (${code})`);
  }

  configOutput = "remoteforward [127.0.0.1]:1234 [127.0.0.1]:5678\n";
  context = deadline();
  const configuredForward = await provider.doctor(context, request(baseInput()));
  context.close();
  assert.equal(configuredForward.ok, false);
  assert.match(configuredForward.detail ?? "", /contains forwarding directives/u);

  configOutput = "hostname gateway-edge.example.net\n";
  configTruncated = true;
  context = deadline();
  const oversizedConfig = await provider.doctor(context, request(baseInput()));
  context.close();
  assert.equal(oversizedConfig.ok, false);
  assert.match(oversizedConfig.detail ?? "", /exceeded the bounded doctor output/u);

  configTruncated = false;
  versionOutput = "not-openssh";
  context = deadline();
  const wrongExecutable = await provider.doctor(context, request(baseInput()));
  context.close();
  assert.equal(wrongExecutable.ok, false);
  assert.match(wrongExecutable.detail ?? "", /OpenSSH identity/u);
});

test("probe requires the owned pid, valid local MCP, and matching public OAuth endpoint", async (t) => {
  const probed: string[] = [];
  let localResponse: "oauth" | "mcp" | "wrong-oauth" = "oauth";
  let publicResponse: "oauth" | "html" | "wrong-oauth" = "oauth";
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    probed.push(url);
    if (url.startsWith("http://127.0.0.1:")) {
      if (localResponse === "mcp") return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } });
      const metadata = localResponse === "oauth"
        ? "https://mcp.example.com/.well-known/oauth-protected-resource/mcp"
        : "https://other.example.com/.well-known/oauth-protected-resource/mcp";
      return new Response("", { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata=\"${metadata}\"` } });
    }
    if (publicResponse === "html") return new Response("<html>wrong upstream</html>", { status: 200, headers: { "Content-Type": "text/html" } });
    const metadata = publicResponse === "oauth"
      ? "https://mcp.example.com/.well-known/oauth-protected-resource/mcp"
      : "https://other.example.com/.well-known/oauth-protected-resource/mcp";
    return new Response("", { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata=\"${metadata}\"` } });
  };
  const fx = await fixture(t, { fetch: fetchImpl });
  const profileRequest = request(baseInput());
  const context = deadline();
  t.after(() => context.close());
  const started = await fx.provider.start(context, profileRequest);

  const wrongPid = await fx.provider.probe(context, { ...started, pid: started.pid + 1 }, profileRequest);
  assert.equal(wrongPid.ready, false);
  assert.equal(wrongPid.terminal, true);
  assert.equal(probed.length, 0);

  const ready = await fx.provider.probe(context, started, profileRequest);
  assert.equal(ready.ready, true);
  assert.equal(ready.endpoint, "https://mcp.example.com");
  assert.deepEqual(probed, ["http://127.0.0.1:9090/mcp", "https://mcp.example.com/mcp"]);
  assert.match(ready.detail ?? "", /local: OAuth challenge reachable; public: OAuth challenge reachable/u);

  localResponse = "wrong-oauth";
  const wrongLocalOAuth = await fx.provider.probe(context, started, profileRequest);
  assert.equal(wrongLocalOAuth.ready, false);
  assert.match(wrongLocalOAuth.detail ?? "", /local: OAuth challenge resource metadata does not match/u);

  localResponse = "mcp";
  publicResponse = "html";
  const wrongUpstream = await fx.provider.probe(context, started, profileRequest);
  assert.equal(wrongUpstream.ready, false);
  assert.match(wrongUpstream.detail ?? "", /public: HTTP 200/u);
  publicResponse = "wrong-oauth";
  const wrongOAuth = await fx.provider.probe(context, started, profileRequest);
  assert.equal(wrongOAuth.ready, false);
  assert.match(wrongOAuth.detail ?? "", /does not match/u);

  fx.child.setExit(7);
  assert.ok(started.exited);
  assert.deepEqual(await started.exited, { code: 7, signal: null, at: (await started.exited).at });
  const exited = await fx.provider.probe(context, started, profileRequest);
  assert.equal(exited.ready, false);
  assert.equal(exited.terminal, true);
  assert.match(exited.detail ?? "", /exit=7/u);
});

test("adopt requests a verified stop and fresh start even for a matching digest", async (t) => {
  const fx = await fixture(t, { processAlive: () => true });
  const profileRequest = request(baseInput());
  const args = sshReverseTunnelArgs({
    localPort: 9090,
    host: "gateway-edge.example.net",
    user: "tunnel",
    port: 2222,
    remoteBindHost: "127.0.0.1",
    remotePort: 19090,
    localHost: "127.0.0.1",
    connectTimeoutSeconds: 10,
    serverAliveIntervalSeconds: 15,
    serverAliveCountMax: 3,
  });
  const identity = {
    pid: 62001,
    executableRealpath: fx.binary,
    processStartIdentity: "boot:62001",
    invocationDigest: gatewayTunnelInvocationDigest(fx.binary, args),
    generation: profileRequest.generation,
    ownerToken: profileRequest.ownerToken,
  };
  const context = deadline();
  t.after(() => context.close());

  assert.equal(await fx.provider.adopt(context, identity, profileRequest), undefined);
});

test("spawn failure without a pid consumes a later child error", async (t) => {
  const child = fakeChild();
  child.pid = undefined;
  const fx = await fixture(t, { child });
  const context = deadline();
  t.after(() => context.close());
  await assert.rejects(() => fx.provider.start(context, request(baseInput())), /did not publish a process id/u);
  assert.doesNotThrow(() => child.emit("error", new Error("ENOENT")));
});

test("stop is deadline-bounded and signals only the supervisor-verified pid", async (t) => {
  let alive = true;
  let clock = 0;
  const signals: Array<[number, NodeJS.Signals | 0]> = [];
  const fx = await fixture(t, {
    processAlive: () => alive,
    signalProcess: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === "SIGKILL") alive = false;
    },
    now: () => { clock += 1_000; return clock; },
  });
  const profileRequest = request(baseInput());
  const context = deadline(5_000);
  t.after(() => context.close());
  const started = await fx.provider.start(context, profileRequest);
  await fx.provider.stop(context, {
    pid: started.pid,
    executableRealpath: started.executablePath,
    processStartIdentity: "boot:61001",
    invocationDigest: gatewayTunnelInvocationDigest(started.executablePath, started.args),
    generation: profileRequest.generation,
    ownerToken: profileRequest.ownerToken,
  }, { ...profileRequest, reason: "explicit" });
  assert.deepEqual(signals, [[started.pid, "SIGTERM"], [started.pid, "SIGKILL"]]);
});
