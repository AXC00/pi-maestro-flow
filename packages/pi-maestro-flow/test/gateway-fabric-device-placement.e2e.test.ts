import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { defaultGatewayConfig, type GatewayConfig } from "../src/gateway/config.ts";
import { requestGatewayIpcControl } from "../src/gateway/ipc.ts";
import { WorkspaceRegistry } from "../src/gateway/workspace-registry.ts";

const packageRoot = resolve(import.meta.dirname, "..");
const gatewayBin = join(packageRoot, "bin", "pi-maestro-gateway.mjs");
const fixturePath = join(import.meta.dirname, "fixtures", "gateway-fabric-device-placement-fixture.mjs");
const certificatePath = join(import.meta.dirname, "fixtures", "fabric-test-cert.pem");
const tlsKeyPath = join(import.meta.dirname, "fixtures", "fabric-test-key.pem");
const CHILD_TIMEOUT_MS = 10_000;
const DAEMON_START_TIMEOUT_MS = 30_000;

interface CapturedChild {
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
  label: string;
}

interface RpcReply { id: number; ok: boolean; value?: any; error?: string; code?: string }

class OriginRpc {
  readonly pending = new Map<number, { resolve(value: RpcReply): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  readonly replies: RpcReply[] = [];
  readonly child: CapturedChild;
  #nextId = 1;
  #buffer = "";
  ready: Promise<any>;

  constructor(child: CapturedChild) {
    this.child = child;
    this.ready = new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error("origin ready timed out")), CHILD_TIMEOUT_MS);
      child.child.stdout.on("data", (chunk) => {
        child.stdout += chunk.toString();
        this.#buffer += chunk.toString();
        for (;;) {
          const newline = this.#buffer.indexOf("\n");
          if (newline < 0) break;
          const line = this.#buffer.slice(0, newline).trim();
          this.#buffer = this.#buffer.slice(newline + 1);
          if (!line) continue;
          const value = JSON.parse(line);
          if (value.type === "ready") {
            clearTimeout(timer);
            resolveReady(value);
            continue;
          }
          const pending = this.pending.get(value.id);
          if (!pending) continue;
          clearTimeout(pending.timer);
          this.pending.delete(value.id);
          this.replies.push(value);
          pending.resolve(value);
        }
      });
      child.child.once("exit", (code) => {
        const error = new Error(`origin exited unexpectedly (${code})`);
        clearTimeout(timer);
        rejectReady(error);
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pending.clear();
      });
    });
    child.child.stderr.on("data", (chunk) => { child.stderr += chunk.toString(); });
  }

  async request(action: string, fields: Record<string, unknown> = {}, expectError = false): Promise<any> {
    const id = this.#nextId++;
    const reply = await new Promise<RpcReply>((resolveReply, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`origin ${action} timed out`));
      }, CHILD_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolveReply, reject, timer });
      this.child.child.stdin.write(`${JSON.stringify({ id, action, ...fields })}\n`);
    });
    if (expectError) {
      assert.equal(reply.ok, false, `origin ${action} unexpectedly succeeded`);
      return reply;
    }
    assert.equal(reply.ok, true, reply.error);
    return reply.value;
  }
}

function isolatedEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1", ...extra };
  delete env.PI_CODING_AGENT_DIR;
  delete env.PI_MAESTRO_GATEWAY_BIN;
  return env;
}

function configPath(home: string): string {
  return join(home, ".pi", "agent", "gateway", "config.yaml");
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate TCP port");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  label: string,
  timeoutMs = CHILD_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) { lastError = error; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`${label} was not reached${lastError ? `: ${String(lastError)}` : ""}`);
}

function spawnCaptured(label: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): CapturedChild {
  const child = spawn(process.execPath, args, { ...options, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const captured: CapturedChild = { child, stdout: "", stderr: "", label };
  child.stdout.on("data", (chunk) => { captured.stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { captured.stderr += chunk.toString(); });
  return captured;
}

async function runCli(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; input?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  const captured = spawnCaptured(`cli:${args.slice(0, 2).join(" ")}`, [gatewayBin, ...args], options);
  if (options.input !== undefined) captured.child.stdin.end(options.input);
  else captured.child.stdin.end();
  let code: number | null | undefined;
  try {
    // Windows production private-path enforcement can perform several bounded
    // PowerShell ACL verifications. Each child wait remains capped at 10s.
    for (let slice = 0; slice < 3 && code === undefined; slice += 1) {
      code = await waitForExitSlice(captured.child);
    }
    if (code === undefined) throw new Error(`${captured.label} did not exit after three bounded waits`);
  } catch (error) {
    captured.child.kill("SIGKILL");
    await waitForExit(captured.child, `${captured.label} forced shutdown`).catch(() => undefined);
    throw new Error(`${String(error)}; stdout=${captured.stdout.slice(0, 500)}; stderr=${captured.stderr.slice(0, 500)}`);
  }
  return { code: code ?? -1, stdout: captured.stdout, stderr: captured.stderr };
}

async function waitForExitSlice(child: ChildProcessWithoutNullStreams): Promise<number | null | undefined> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise<number | null | undefined>((resolveExit) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolveExit(undefined);
    }, CHILD_TIMEOUT_MS);
    const onExit = (code: number | null) => { clearTimeout(timer); resolveExit(code); };
    child.once("exit", onExit);
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams, label: string): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise<number | null>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      reject(new Error(`${label} did not exit within ${CHILD_TIMEOUT_MS}ms`));
    }, CHILD_TIMEOUT_MS);
    const onExit = (code: number | null) => { clearTimeout(timer); resolveExit(code); };
    child.once("exit", onExit);
  });
}

async function stopChild(captured: CapturedChild, ownerPath?: string): Promise<void> {
  if (captured.child.exitCode === null && ownerPath !== undefined) {
    const owner = parseJson(await readFile(ownerPath, "utf8"), `${captured.label} owner`) as {
      socket?: string;
      ownerToken?: string;
    };
    if (!owner.socket || !owner.ownerToken) throw new Error(`${captured.label} owner record is incomplete`);
    await requestGatewayIpcControl({
      address: owner.socket,
      ownerToken: owner.ownerToken,
      action: "stop",
      timeoutMs: CHILD_TIMEOUT_MS,
    });
  }
  if (captured.child.exitCode === null && ownerPath === undefined) captured.child.kill("SIGTERM");
  try { await waitForExit(captured.child, captured.label); }
  catch {
    captured.child.kill("SIGKILL");
    await waitForExit(captured.child, `${captured.label} forced shutdown`);
  }
  if (ownerPath) await waitFor(async () => (await readFile(ownerPath).catch(() => undefined)) === undefined ? true : undefined, `${captured.label} owner removal`);
}

function makeConfig(root: string, ownerPath: string, registryPath: string, auditFile: string): GatewayConfig {
  const config = defaultGatewayConfig();
  config.auth = { mode: "open", allowOpenMutations: true };
  config.server.host = "127.0.0.1";
  config.transport.http = { enabled: false, host: "127.0.0.1", port: 9090, path: "/mcp", tls: { enabled: false } };
  config.workspaces = [];
  config.state = {
    rootDir: join(root, "state"),
    ownerPath,
    workspaceRegistryPath: registryPath,
    pairingPath: join(root, "pairings", "pairings.json"),
    serviceManifestPath: join(root, "service", "service.json"),
    sessionsRoot: join(root, "sessions"),
    boardRoot: join(root, "board"),
    handoffRoot: join(root, "handoff"),
    operationReceiptRoot: join(root, "receipts"),
    maestroReceiptRoot: join(root, "maestro-receipts"),
  };
  config.logging = { level: "silent", auditFile };
  return config;
}

async function writeConfig(path: string, config: GatewayConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function parseJson(text: string, label: string): any {
  try { return JSON.parse(text.trim()); }
  catch (error) { throw new Error(`${label} was not JSON: ${text.slice(0, 500)}`, { cause: error }); }
}

function placement(route: any, endpoint: any, id: string): any {
  return {
    version: "fabric.placement.v1",
    placementId: id,
    routeId: route.routeId,
    workspaceBindingId: route.workspaceBindingId,
    endpointId: endpoint.endpointId,
    connectionGeneration: route.connectionGeneration,
    workspaceGeneration: route.workspaceGeneration,
    endpointGeneration: route.endpointGeneration,
    requestedRole: "general",
    requestedTaskType: "development",
    requestedModel: "fixture/model",
    deadlineAt: Math.min(route.expiresAt, Date.now() + 30_000),
  };
}

async function allTextFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(path: string): Promise<void> {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && (await stat(child)).size <= 2 * 1024 * 1024) files.push(child);
    }
  }
  await visit(root);
  return files;
}

/**
 * Scenario map: production enroll/start/ready/bind/select/open/dispatch; event
 * order and controls; source backpressure; route and binding fences; inventory
 * generation refresh; Hub offline hydration; lost ACK; Device no-auto-dial
 * restart; connection replacement; revocation; bounded teardown and leakage.
 */
test("production Hub, Device, and Origin processes execute and fence Fabric placement", { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-fabric-device-placement-"));
  const hubRoot = join(root, "hub-role");
  const deviceRoot = join(root, "device-role");
  const originRoot = join(root, "origin-role");
  const hubHome = join(hubRoot, "home");
  const deviceHome = join(deviceRoot, "home");
  const originHome = join(originRoot, "home");
  const hubWorkspace = join(hubRoot, "workspace");
  const deviceWorkspace = join(deviceRoot, "workspace");
  const originWorkspace = join(originRoot, "workspace");
  const hubOwnerPath = join(hubRoot, "owner", "owner.json");
  const deviceOwnerPath = join(deviceRoot, "owner", "owner.json");
  const originSentinelOwner = join(originRoot, "owner", "unused-owner.json");
  const hubRegistryPath = join(hubRoot, "registry", "workspaces.json");
  const deviceRegistryPath = join(deviceRoot, "registry", "workspaces.json");
  const originSentinelRegistry = join(originRoot, "registry", "unused-workspaces.json");
  const hubAudit = join(hubRoot, "audit", "audit.jsonl");
  const deviceAudit = join(deviceRoot, "audit", "audit.jsonl");
  const deviceMarkers = join(deviceRoot, "markers", "backend.jsonl");
  const originMarkers = join(originRoot, "markers", "origin.jsonl");
  const port = await freePort();
  const processes: CapturedChild[] = [];
  let origin: OriginRpc | undefined;

  await Promise.all([
    mkdir(hubWorkspace, { recursive: true }), mkdir(deviceWorkspace, { recursive: true }), mkdir(originWorkspace, { recursive: true }),
    mkdir(dirname(deviceMarkers), { recursive: true }), mkdir(dirname(originMarkers), { recursive: true }),
    mkdir(dirname(originSentinelOwner), { recursive: true }), mkdir(dirname(originSentinelRegistry), { recursive: true }),
  ]);
  await Promise.all([
    new WorkspaceRegistry({ path: hubRegistryPath }).register(originWorkspace, { id: "origin-local", mode: "permanent" }),
    new WorkspaceRegistry({ path: deviceRegistryPath }).register(deviceWorkspace, { id: "device-local", mode: "permanent" }),
  ]);

  const hubConfig = makeConfig(hubRoot, hubOwnerPath, hubRegistryPath, hubAudit);
  hubConfig.workspaces = [{ path: originWorkspace, id: "origin-local", mode: "permanent" }];
  hubConfig.fabric = { enabled: true, audience: "fabric", limits: { heartbeatIntervalMs: 1_000, heartbeatTimeoutMs: 60_000 } };
  hubConfig.server.port = port;
  hubConfig.transport.http = {
    enabled: true, host: "localhost", port, path: "/mcp",
    tls: { enabled: true, certFile: certificatePath, keyFile: tlsKeyPath },
  };
  const deviceConfig = makeConfig(deviceRoot, deviceOwnerPath, deviceRegistryPath, deviceAudit);
  deviceConfig.workspaces = [{ path: deviceWorkspace, id: "device-local", mode: "permanent" }];
  const hubConfigPath = configPath(hubHome);
  const deviceConfigPath = configPath(deviceHome);
  await Promise.all([writeConfig(hubConfigPath, hubConfig), writeConfig(deviceConfigPath, deviceConfig)]);

  const hubEnv = isolatedEnv(hubHome);
  const deviceEnv = isolatedEnv(deviceHome, { FABRIC_DEVICE_FIXTURE_MARKERS: deviceMarkers });
  const originEnv = isolatedEnv(originHome);
  assert.notEqual(hubHome, deviceHome);
  assert.notEqual(deviceHome, originHome);
  assert.equal(new Set([hubConfig.state.rootDir, deviceConfig.state.rootDir, join(originRoot, "state")]).size, 3);
  assert.equal(new Set([hubOwnerPath, deviceOwnerPath, originSentinelOwner]).size, 3);
  assert.equal(new Set([hubRegistryPath, deviceRegistryPath, originSentinelRegistry]).size, 3);

  const modelRegistry = {
    version: 2,
    mode: "model-registry",
    default: "source-local",
    defaultModel: "fixture/model",
    backends: { "source-local": { module: pathToFileURL(fixturePath).href } },
    models: {
      "fixture/model": {
        modelId: "fixture/model",
        deployment: "source-local",
        selector: { kind: "adapter-model", value: "fixture/adapter" },
        deploymentDefault: true,
      },
    },
  };
  await mkdir(join(deviceWorkspace, ".pi"), { recursive: true });
  await writeFile(join(deviceWorkspace, ".pi", "teammate-backends.json"), JSON.stringify(modelRegistry), "utf8");

  t.after(async () => {
    if (origin && origin.child.child.exitCode === null) await origin.request("shutdown").catch(() => undefined);
    for (const process of processes.reverse()) await stopChild(process).catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  let hub = spawnCaptured("hub", [gatewayBin, "serve", "--json", "--config", hubConfigPath], { cwd: originWorkspace, env: hubEnv });
  processes.push(hub);
  await waitFor(async () => {
    if (hub.child.exitCode !== null) throw new Error(`Hub exited ${hub.child.exitCode}: ${hub.stderr.slice(0, 1000)}`);
    const owner = await readFile(hubOwnerPath, "utf8").catch(() => undefined);
    if (owner && hub.stdout.includes('"status":"running"')) return true;
    throw new Error(`Hub pending; stdout=${hub.stdout.slice(0, 500)}; stderr=${hub.stderr.slice(0, 500)}`);
  }, "Hub ready", DAEMON_START_TIMEOUT_MS);

  const tokenPath = join(hubRoot, "private", "enrollment-token");
  const issued = await runCli([
    "pair", "create", "--purpose", "fabric-enrollment", "--connector-id", "fixture-connector",
    "--ttl", "120", "--token-out", tokenPath, "--config", hubConfigPath,
  ], { cwd: hubWorkspace, env: hubEnv });
  assert.equal(issued.code, 0, issued.stderr);
  const issuedSafe = parseJson(issued.stdout, "purpose-token issuance");
  assert.equal("token" in issuedSafe, false);
  const enrollmentToken = (await readFile(tokenPath, "utf8")).trim();
  assert.ok(enrollmentToken.length > 20);

  const enrolled = await runCli([
    "connector", "enroll", "--hub", `https://localhost:${port}`, "--connector-id", "fixture-connector",
    "--device-id", "fixture-device", "--token-stdin", "--ca", certificatePath, "--json",
  ], { cwd: deviceWorkspace, env: deviceEnv, input: `${enrollmentToken}\n` });
  assert.equal(enrolled.code, 0, enrolled.stderr);
  const enrolledSafe = parseJson(enrolled.stdout, "Connector enrollment");
  assert.equal(enrolledSafe.connectorId, "fixture-connector");
  assert.equal(enrolled.stdout.includes(enrollmentToken), false);
  await rm(tokenPath, { force: true });

  const connectorPath = join(deviceWorkspace, ".pi", "fabric-connector.json");
  const connector = parseJson(await readFile(connectorPath, "utf8"), "Connector config");
  connector.workspaceIds = ["device-local"];
  connector.agentSources = {
    roles: ["general"], taskTypes: ["development"], models: ["fixture/model"],
    backends: ["fixture-backend"], maxConcurrency: 1,
  };
  connector.heartbeatIntervalMs = 1_000;
  connector.reconnectDelayMs = 50;
  connector.maxReconnectAttempts = 200;
  await writeFile(connectorPath, `${JSON.stringify(connector, null, 2)}\n`, "utf8");
  const connectorPrivateKey = await readFile(connector.privateKeyPath, "utf8");
  const privateNames = [basename(connector.privateKeyPath), basename(tlsKeyPath)];

  let device = spawnCaptured("device", [gatewayBin, "serve", "--json", "--config", deviceConfigPath, "--no-http"], { cwd: deviceWorkspace, env: deviceEnv });
  processes.push(device);
  await waitFor(async () => {
    if (device.child.exitCode !== null) throw new Error(`Device exited ${device.child.exitCode}: ${device.stderr.slice(0, 1000)}`);
    const owner = await readFile(deviceOwnerPath, "utf8").catch(() => undefined);
    return owner && device.stdout.includes('"status":"running"') ? true : undefined;
  }, "Device daemon ready", DAEMON_START_TIMEOUT_MS);
  const configured = await runCli(["connector", "status", "--json"], { cwd: deviceWorkspace, env: deviceEnv });
  assert.equal(configured.code, 0, configured.stderr);
  assert.equal(parseJson(configured.stdout, "configured Connector status").state, "configured");

  const started = await runCli(["connector", "start", "--json"], { cwd: deviceWorkspace, env: deviceEnv });
  assert.equal(started.code, 0, started.stderr);
  const firstConnectorStatus = parseJson(started.stdout, "started Connector status");
  assert.equal(firstConnectorStatus.state, "ready");

  const originChild = spawnCaptured("origin", [
    "--experimental-transform-types", fixturePath, hubConfigPath, originWorkspace, originMarkers,
  ], { cwd: originWorkspace, env: originEnv });
  processes.push(originChild);
  origin = new OriginRpc(originChild);
  const originReady = await origin.ready;
  assert.equal(originReady.pid, originChild.child.pid);
  assert.ok(originReady.providerGeneration >= 1);

  const call = (tool: string, args: Record<string, unknown>, expectError = false) => origin!.request("call", { tool, args }, expectError);
  const devices = await waitFor(async () => {
    const value = await call("device", { action: "list" });
    return value.devices?.some((entry: any) => entry.deviceId === "fixture-device") ? value.devices : undefined;
  }, "Device advertisement");
  assert.equal(devices.length, 1);
  const advertisedWorkspace = (await call("device", { action: "workspaces", deviceId: "fixture-device" })).workspaces[0];
  assert.ok(advertisedWorkspace.workspaceId);
  let connection = await waitFor(async () => {
    const status = await call("device", { action: "status", deviceId: "fixture-device" });
    return status.connections.find((entry: any) => entry.state === "connected" && entry.revision >= 2);
  }, "post-heartbeat Device connection");

  async function bindAndOpen(endpointGenerationFloor = 0): Promise<{ binding: any; endpoint: any; route: any }> {
    const workspace = (await call("device", { action: "workspaces", deviceId: "fixture-device" })).workspaces.find((entry: any) => entry.endpointIds.length > 0);
    assert.ok(workspace, "an executable workspace must be advertised");
    const status = await call("device", { action: "status", deviceId: "fixture-device" });
    connection = status.connections.filter((entry: any) => entry.state === "connected").at(-1);
    assert.ok(connection, "a ready production WSS connection is required");
    const binding = (await call("workspace", {
      action: "bind", deviceId: "fixture-device", connectionId: connection.connectionId, workspaceId: workspace.workspaceId,
      localWorkspaceId: "origin-local", expectedConnectionGeneration: connection.generation,
      expectedWorkspaceGeneration: workspace.generation, expectedLocalWorkspaceGeneration: 1, requestedTtlMs: 60_000,
    })).binding;
    const listed = await call("endpoint", { action: "list", deviceId: "fixture-device", workspaceId: workspace.workspaceId, endpointKind: "agent" });
    const endpoint = listed.endpoints[0];
    assert.ok(endpoint && endpoint.generation > endpointGenerationFloor);
    const selected = await call("endpoint", { action: "select", endpointId: endpoint.endpointId });
    assert.equal(selected.selected, true);
    const route = (await call("route", {
      action: "open", connectionId: connection.connectionId, workspaceBindingId: binding.bindingId, endpointId: endpoint.endpointId,
      expectedConnectionGeneration: connection.generation, expectedWorkspaceGeneration: workspace.generation,
      expectedEndpointGeneration: endpoint.generation, requestedTtlMs: 60_000,
      operationClass: "agent-placement", pathCandidates: ["hub"],
    })).route;
    return { binding, endpoint, route };
  }

  async function dispatch(runId: string, task: string, route: any, endpoint: any): Promise<any> {
    return origin!.request("dispatch", {
      runId,
      correlationId: `attempt-${runId}`,
      placement: placement(route, endpoint, `placement-${runId}`),
      spec: { agent: "general", task, model: "fixture/model" },
    });
  }

  async function awaitRun(runId: string): Promise<any> { return origin!.request("await", { runId }); }
  async function waitMarker(gate: string, label?: string): Promise<any[]> {
    return waitFor(async () => {
      const text = await readFile(deviceMarkers, "utf8").catch(() => "");
      const rows = text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
      const found = rows.filter((row) => row.gate === gate && (label === undefined || row.label === label));
      return found.length > 0 ? found : undefined;
    }, `${gate}${label ? `:${label}` : ""}`);
  }

  let current = await bindAndOpen();
  await dispatch("clean-1", "complete:clean-1", current.route, current.endpoint);
  const clean = await awaitRun("clean-1");
  const cleanDebugMarkers = await readFile(deviceMarkers, "utf8").catch(() => "");
  assert.equal(clean.outcome.result.exitCode, 0, `${JSON.stringify(clean)}\nmarkers=${cleanDebugMarkers}\ndevice=${device.stderr}\norigin=${originChild.stderr}`);
  assert.equal(clean.outcome.result.model, "fixture/model");
  assert.equal(clean.outcome.reclamation.status, "reclaimed");
  assert.ok(clean.order.findIndex((entry: any) => entry.kind === "output") < clean.order.findIndex((entry: any) => entry.kind === "turn-complete"));
  const cleanMarkers = await waitMarker("backend-outcome", "complete:clean-1");
  assert.equal(cleanMarkers.length, 1);
  const deviceRows = (await readFile(deviceMarkers, "utf8")).trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  const outputIndex = deviceRows.findIndex((row) => row.gate === "output" && row.label === "complete:clean-1");
  const turnIndex = deviceRows.findIndex((row) => row.gate === "turn-complete" && row.label === "complete:clean-1");
  const outcomeIndex = deviceRows.findIndex((row) => row.gate === "backend-outcome" && row.label === "complete:clean-1");
  assert.ok(outputIndex >= 0 && outputIndex < turnIndex && turnIndex < outcomeIndex);
  assert.equal(deviceRows.find((row) => row.gate === "backend-start")?.model, "fixture/adapter");

  current = await bindAndOpen();
  await dispatch("controls", "hold:controls", current.route, current.endpoint);
  await waitMarker("output", "hold:controls");
  assert.equal((await origin.request("send", { runId: "controls", mode: "follow_up", message: "follow-up-message" })).accepted, true);
  assert.equal((await origin.request("send", { runId: "controls", mode: "prompt", message: "prompt-message" })).accepted, true);
  await waitMarker("send", "hold:controls");
  await origin.request("abort", { runId: "controls" });
  const controlled = await awaitRun("controls");
  assert.equal(controlled.outcome.result.terminalStatus, "terminated");
  assert.equal(controlled.outcome.reclamation.status, "reclaimed");

  current = await bindAndOpen();
  await dispatch("close-active", "hold:close-active", current.route, current.endpoint);
  await waitMarker("output", "hold:close-active");
  const closed = (await call("route", { action: "close", routeId: current.route.routeId, expectedRevision: current.route.revision })).route;
  assert.equal(closed.state, "closed");
  const closeOutcome = await awaitRun("close-active");
  assert.notEqual(closeOutcome.outcome.result.exitCode, 0);
  await waitMarker("abort", "hold:close-active");
  const oldAfterClose = await dispatch("old-close", "complete:must-not-start-close", current.route, current.endpoint).then(
    () => awaitRun("old-close"),
    (error) => ({ error: String(error) }),
  );
  assert.match(JSON.stringify(oldAfterClose), /closed|must be open|stale|unknown|unavailable/iu);
  assert.equal((await readFile(deviceMarkers, "utf8")).includes("must-not-start-close"), false);

  current = await bindAndOpen();
  await dispatch("unbind-active", "hold:unbind-active", current.route, current.endpoint);
  await waitMarker("output", "hold:unbind-active");
  const unbound = (await call("workspace", { action: "unbind", workspaceBindingId: current.binding.bindingId, expectedRevision: current.binding.revision })).binding;
  assert.equal(unbound.bindingId, current.binding.bindingId);
  const unbindOutcome = await awaitRun("unbind-active");
  assert.notEqual(unbindOutcome.outcome.result.exitCode, 0);
  await waitMarker("abort", "hold:unbind-active");
  const oldAfterUnbind = await dispatch("old-unbind", "complete:must-not-start-unbind", current.route, current.endpoint).then(
    () => awaitRun("old-unbind"),
    (error) => ({ error: String(error) }),
  );
  assert.match(JSON.stringify(oldAfterUnbind), /closed|must be open|stale|unknown|unavailable|binding/iu);
  assert.equal((await readFile(deviceMarkers, "utf8")).includes("must-not-start-unbind"), false);

  current = await bindAndOpen();
  const secondRoute = (await call("route", {
    action: "open", connectionId: connection.connectionId, workspaceBindingId: current.binding.bindingId, endpointId: current.endpoint.endpointId,
    expectedConnectionGeneration: connection.generation, expectedWorkspaceGeneration: current.route.workspaceGeneration,
    expectedEndpointGeneration: current.endpoint.generation, requestedTtlMs: 60_000,
    operationClass: "agent-placement", pathCandidates: ["hub"],
  })).route;
  await dispatch("capacity-1", "hold:capacity-1", current.route, current.endpoint);
  await waitMarker("output", "hold:capacity-1");
  await dispatch("capacity-2", "complete:must-not-start-capacity", secondRoute, current.endpoint);
  const refused = await awaitRun("capacity-2");
  assert.notEqual(refused.outcome.result.exitCode, 0);
  assert.match(JSON.stringify(refused), /concurrency|acknowledgement|unknown|resource/iu);
  assert.equal((await readFile(deviceMarkers, "utf8")).includes("must-not-start-capacity"), false);
  await origin.request("abort", { runId: "capacity-1" });
  await awaitRun("capacity-1");

  const priorEndpointGeneration = current.endpoint.generation;
  await writeFile(join(deviceWorkspace, ".pi", "teammate-backends.json"), JSON.stringify({ ...modelRegistry, models: {} }), "utf8");
  await waitFor(async () => {
    const value = await call("device", { action: "workspaces", deviceId: "fixture-device" });
    return value.workspaces.every((workspace: any) => workspace.endpointIds.length === 0) ? value : undefined;
  }, "Endpoint export removal");
  await writeFile(join(deviceWorkspace, ".pi", "teammate-backends.json"), JSON.stringify(modelRegistry), "utf8");
  await waitFor(async () => {
    const value = await call("device", { action: "workspaces", deviceId: "fixture-device" });
    return value.workspaces.some((workspace: any) => workspace.endpointIds.length > 0 && workspace.generation > priorEndpointGeneration) ? value : undefined;
  }, "Endpoint export restoration");
  current = await bindAndOpen(priorEndpointGeneration);
  await dispatch("restored", "complete:restored", current.route, current.endpoint);
  assert.equal((await awaitRun("restored")).outcome.result.exitCode, 0);

  const connectorStopped = await runCli(["connector", "stop", "--json"], { cwd: deviceWorkspace, env: deviceEnv });
  assert.equal(connectorStopped.code, 0, connectorStopped.stderr);
  const connectionBeforeHubRestart = connection.generation;
  await stopChild(hub, hubOwnerPath);
  processes.splice(processes.indexOf(hub), 1);
  hub = spawnCaptured("hub-restarted", [gatewayBin, "serve", "--json", "--config", hubConfigPath], { cwd: originWorkspace, env: hubEnv });
  processes.push(hub);
  await waitFor(async () => {
    const owner = await readFile(hubOwnerPath, "utf8").catch(() => undefined);
    return owner && hub.stdout.includes('"status":"running"') ? true : undefined;
  }, "restarted Hub ready");
  await waitFor(async () => {
    const value = await call("device", { action: "list" }).catch(() => undefined);
    return value?.devices?.some((entry: any) => entry.deviceId === "fixture-device") ? value : undefined;
  }, "offline Device identity hydration");
  const offlineState = parseJson(
    await readFile(join(hubConfig.state.rootDir!, "fabric", "state.json"), "utf8"),
    "offline Fabric store",
  );
  assert.equal(JSON.stringify(offlineState).includes(current.endpoint.endpointId), true);
  const offlineStatus = await call("device", { action: "status", deviceId: "fixture-device" });
  assert.equal(offlineStatus.connections.some((entry: any) => entry.state === "connected"), false);
  const startedAfterHubRestart = await runCli(["connector", "start", "--json"], { cwd: deviceWorkspace, env: deviceEnv });
  assert.equal(startedAfterHubRestart.code, 0, startedAfterHubRestart.stderr);
  await waitFor(async () => {
    const value = await call("device", { action: "status", deviceId: "fixture-device" });
    const ready = value.connections.find((entry: any) => entry.state === "connected" && entry.generation > connectionBeforeHubRestart);
    return ready;
  }, "fresh post-Hub-restart connection");
  current = await bindAndOpen();
  await dispatch("hub-restart", "complete:hub-restart", current.route, current.endpoint);
  assert.equal((await awaitRun("hub-restart")).outcome.result.exitCode, 0);

  const staleBeforeDeviceRestart = { route: current.route, endpoint: current.endpoint };
  await dispatch("lost-ack", "lost-ack:device-crash", current.route, current.endpoint);
  await waitMarker("lost-ack-exit", "lost-ack:device-crash");
  assert.equal(await waitForExit(device.child, "Device lost-ACK exit"), 86);
  processes.splice(processes.indexOf(device), 1);
  const lost = await awaitRun("lost-ack");
  assert.equal(lost.outcome.recovery.externalReplayRisk, true);
  assert.equal(lost.outcome.reclamation.status, "unreaped");

  device = spawnCaptured("device-restarted", [gatewayBin, "serve", "--json", "--config", deviceConfigPath, "--no-http"], { cwd: deviceWorkspace, env: deviceEnv });
  processes.push(device);
  await waitFor(async () => {
    if (device.child.exitCode !== null) throw new Error(`restarted Device exited ${device.child.exitCode}: ${device.stderr.slice(0, 1000)}`);
    const owner = await readFile(deviceOwnerPath, "utf8").catch(() => undefined);
    return owner && device.stdout.includes('"status":"running"') ? true : undefined;
  }, "restarted Device daemon ready");
  const configuredAfterRestart = await runCli(["connector", "status", "--json"], { cwd: deviceWorkspace, env: deviceEnv });
  assert.equal(configuredAfterRestart.code, 0, configuredAfterRestart.stderr);
  const restartStatus = parseJson(configuredAfterRestart.stdout, "Device restart Connector status");
  assert.equal(restartStatus.state, "configured");
  assert.equal(restartStatus.running, false);
  const noDial = await call("device", { action: "status", deviceId: "fixture-device" });
  assert.equal(noDial.connections.some((entry: any) => entry.state === "connected"), false);
  const explicitRestart = await runCli(["connector", "start", "--json"], { cwd: deviceWorkspace, env: deviceEnv });
  assert.equal(explicitRestart.code, 0, explicitRestart.stderr);
  const restartedConnectorStatus = parseJson(explicitRestart.stdout, "explicit Device restart");
  assert.ok(restartedConnectorStatus.connectionGeneration > firstConnectorStatus.connectionGeneration);

  const staleReplacement = await dispatch("old-connection", "complete:must-not-start-old-connection", staleBeforeDeviceRestart.route, staleBeforeDeviceRestart.endpoint).then(
    () => awaitRun("old-connection"),
    (error) => ({ error: String(error) }),
  );
  assert.match(JSON.stringify(staleReplacement), /stale|unknown|unavailable|connection/iu);
  assert.equal((await readFile(deviceMarkers, "utf8")).includes("must-not-start-old-connection"), false);
  current = await bindAndOpen();
  await dispatch("device-restart", "complete:device-restart", current.route, current.endpoint);
  assert.equal((await awaitRun("device-restart")).outcome.result.exitCode, 0);

  const revoked = await origin.request("revoke", {
    options: { connectorId: "fixture-connector", requestId: "revoke-fixture-connector", expectedRevision: enrolledSafe.revision },
  });
  assert.equal(revoked.status, "revoked");
  await waitFor(async () => {
    const value = await call("endpoint", { action: "list", deviceId: "fixture-device", endpointKind: "agent" }).catch(() => ({ endpoints: [] }));
    return value.endpoints.length === 0 ? true : undefined;
  }, "revocation executable inventory removal");
  const revokedOld = await dispatch("revoked-old", "complete:must-not-start-revoked", current.route, current.endpoint).then(
    () => awaitRun("revoked-old"),
    (error) => ({ error: String(error) }),
  );
  assert.match(JSON.stringify(revokedOld), /stale|unknown|unavailable|not registered|no longer exists|revok/iu);
  assert.equal((await readFile(deviceMarkers, "utf8")).includes("must-not-start-revoked"), false);

  await origin.request("shutdown");
  await waitForExit(originChild.child, "Origin shutdown");
  await stopChild(device, deviceOwnerPath);
  processes.splice(processes.indexOf(device), 1);
  await stopChild(hub, hubOwnerPath);
  processes.splice(processes.indexOf(hub), 1);
  assert.equal(await readFile(hubOwnerPath).catch(() => undefined), undefined);
  assert.equal(await readFile(deviceOwnerPath).catch(() => undefined), undefined);

  const nonSecretArtifacts = [
    issued.stdout, issued.stderr, enrolled.stdout, enrolled.stderr,
    ...processes.map((process) => `${process.stdout}\n${process.stderr}`),
    originChild.stdout, originChild.stderr,
    JSON.stringify(origin.replies),
    await readFile(hubAudit, "utf8").catch(() => ""),
    await readFile(deviceAudit, "utf8").catch(() => ""),
    await readFile(deviceMarkers, "utf8").catch(() => ""),
    await readFile(originMarkers, "utf8").catch(() => ""),
  ].join("\n");
  assert.equal(nonSecretArtifacts.includes(enrollmentToken), false, "enrollment token leaked into a non-secret artifact");
  const ownerRecords = await Promise.all([hubOwnerPath, deviceOwnerPath].map((path) => readFile(path, "utf8").catch(() => "")));
  for (const ownerRecord of ownerRecords.filter(Boolean)) {
    const token = JSON.parse(ownerRecord).ownerToken;
    assert.equal(nonSecretArtifacts.includes(token), false, "owner token leaked into a non-secret artifact");
  }
  assert.equal(nonSecretArtifacts.includes(connectorPrivateKey.trim()), false, "Connector private-key content leaked");
  assert.equal(nonSecretArtifacts.includes("BEGIN PRIVATE KEY"), false, "private-key PEM leaked");
  for (const name of privateNames) assert.equal(nonSecretArtifacts.includes(name), false, `private-key name leaked: ${name}`);

  const roots = await allTextFiles(root);
  assert.ok(roots.length > 0, "the scenario produced durable evidence");
});
