import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startGatewayHttpServer } from "../src/gateway/http-server.ts";
import { connectGatewayIpc, gatewayIpcAddress, requestGatewayIpcControl, startGatewayIpcServer } from "../src/gateway/ipc.ts";
import { createLocalGatewayPrincipal } from "../src/gateway/principal.ts";
import { gatewayOk } from "../src/gateway/result.ts";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import { FabricOriginDataPlaneGrantAuthority } from "../src/gateway/fabric/origin-runtime.ts";
import { createTestGatewayConfig } from "./gateway-test-helpers.ts";

const certificatePath = join(import.meta.dirname, "fixtures", "fabric-test-cert.pem");
const keyPath = join(import.meta.dirname, "fixtures", "fabric-test-key.pem");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

test("runtime close independently fences Fabric origin grants at entry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-lifecycle-close-fence-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  let fences = 0;
  class TrackingGrantAuthority extends FabricOriginDataPlaneGrantAuthority {
    override fence(): void {
      fences += 1;
      super.fence();
    }
  }
  const grants = new TrackingGrantAuthority({
    hubRuntimeEpoch: "hub-close-fence",
    daemonGeneration: "daemon-close-fence",
    authority: {
      routeOf: () => { throw new Error("not used"); },
      endpointOf: () => undefined,
    },
  });
  const runtime = await GatewayRuntime.create({
    config: createTestGatewayConfig(root),
    cwd: root,
    fabricOriginDataPlaneGrants: grants,
  });
  await runtime.close();
  assert.equal(fences, 1);
});

test("quiesce drains admitted work, refuses new mutation/subscription, and permits bounded status reads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-lifecycle-drain-"));
  const runtime = await GatewayRuntime.create({ config: createTestGatewayConfig(root), cwd: root });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const principal = createLocalGatewayPrincipal("lifecycle-test", { scopes: ["gateway"] });
  const host = runtime.catalog.get("host")!;
  const original = host.handler;
  const pending = deferred<ReturnType<typeof gatewayOk>>();
  host.handler = async (_principal, args) => args.action === "status" ? gatewayOk({ reachable: true }) : pending.promise;

  const inFlight = runtime.call("host", { action: "test" }, principal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.inFlightRequestCount, 1);
  const drain = runtime.beginQuiesce(Date.now() + 1_000);
  assert.equal(runtime.canAcceptNewSessions, false);

  const rejected = await runtime.call("host", { action: "test" }, principal);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error?.code, "gateway_quiescing");
  const statusRead = await runtime.call("host", { action: "status" }, principal);
  assert.equal(statusRead.ok, true, "bounded status reads remain available while quiescing");

  pending.resolve(gatewayOk({ reachable: true }));
  assert.equal((await inFlight).ok, true);
  assert.equal(await drain, true);
  host.handler = original;
});

test("quiesce drain obeys an absolute timeout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-lifecycle-timeout-"));
  const runtime = await GatewayRuntime.create({ config: createTestGatewayConfig(root), cwd: root });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const principal = createLocalGatewayPrincipal("lifecycle-timeout", { scopes: ["gateway"] });
  const host = runtime.catalog.get("host")!;
  const pending = deferred<ReturnType<typeof gatewayOk>>();
  host.handler = async () => pending.promise;
  const inFlight = runtime.call("host", { action: "test" }, principal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await runtime.beginQuiesce(Date.now() + 20), false);
  pending.resolve(gatewayOk({ reachable: true }));
  await inFlight;
});

test("quiesce synchronously fences Fabric HTTP registration", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-lifecycle-fabric-"));
  const config = createTestGatewayConfig(root);
  config.fabric = { enabled: true, audience: "fabric" };
  config.transport.http = { enabled: true, host: "localhost", port: 0, path: "/mcp", tls: { enabled: true, certFile: certificatePath, keyFile: keyPath } };
  const runtime = await GatewayRuntime.create({ config, cwd: root });
  const http = await startGatewayHttpServer(runtime, { host: "localhost", port: 0 });
  t.after(async () => { await http.close(); await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const quiesce = runtime.beginQuiesce(Date.now() + 100);
  assert.equal(runtime.fabricAdmissionReady, false);
  const ca = await readFile(certificatePath);
  const status = await new Promise<number>((resolve, reject) => {
    const request = httpsRequest(new URL("/fabric/v1/enroll", http.url), { method: "POST", ca, headers: { "content-type": "application/json" } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end("{}");
  });
  assert.equal(status, 503);
  assert.deepEqual(await runtime.fabricRegistration!.list(), []);
  assert.equal(await quiesce, true);
});

test("quiescing rejects new HTTPS initialize and IPC sessions while local control remains responsive", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gateway-lifecycle-transports-"));
  const config = createTestGatewayConfig(root);
  const runtime = await GatewayRuntime.create({ config, cwd: root });
  const http = await startGatewayHttpServer(runtime, { host: "127.0.0.1", port: 0 });
  const ipc = await startGatewayIpcServer(runtime, { address: gatewayIpcAddress(root, join(root, "owner.json")), ownerToken: "lifecycle-owner-token" });
  t.after(async () => { await http.close(); await ipc.close(); await runtime.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal(await runtime.beginQuiesce(Date.now() + 100), true);

  const response = await fetch(http.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
  });
  assert.equal(response.status, 503);
  assert.equal((await fetch(new URL("/readyz", http.url))).status, 503);
  await assert.rejects(() => connectGatewayIpc({ address: ipc.address, ownerToken: "lifecycle-owner-token", timeoutMs: 200 }), /quiescing/u);
  const status = await requestGatewayIpcControl({ address: ipc.address, ownerToken: "lifecycle-owner-token", action: "status", timeoutMs: 200 }) as { ok?: boolean };
  assert.equal(status.ok, true);
});
