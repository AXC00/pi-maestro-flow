import assert from "node:assert/strict";
import test from "node:test";
import { FabricContractError, type CapabilityBinding, type FabricLiveConnection } from "pi-maestro-fabric-core/v1";
import {
  FabricConnectionManager,
  FabricDirectory,
  TransportRegistry,
  type FabricAdvertisementSnapshot,
} from "../src/index.ts";

const limits = {
  maxFrameBytes: 1024, maxInFlightOperations: 2, heartbeatIntervalMs: 10,
  heartbeatTimeoutMs: 20, maxAdvertisementItems: 20, maxResultBytes: 2048,
};

const connector = {
  connectorId: "connector-a", label: "Connector A", transport: "ssh" as const,
  credentialGeneration: 1, instanceNonce: "nonce-private", enabled: true, revision: 1,
};
const device = {
  deviceId: "device-a", connectorId: "connector-a", label: "Device A", connectionMode: "ssh" as const,
  enabled: true, revision: 1,
};

function snapshot(
  connectionGeneration = 1,
  advertisementRevision = 1,
  entityGeneration = 1,
): FabricAdvertisementSnapshot {
  return {
    connectionId: `connection-${connectionGeneration}`,
    connectionGeneration,
    capabilityDigest: "digest-a",
    advertisementRevision,
    devices: [{ ...device }],
    workspaces: [{
      workspaceId: "workspace-a", deviceId: "device-a", localWorkspaceId: "local-private",
      label: "Workspace A", mode: "permanent", generation: entityGeneration,
      policyDigest: `policy-${entityGeneration}`, endpointIds: ["endpoint-a"], revision: advertisementRevision,
    }],
    endpoints: [{
      endpointId: "endpoint-a", deviceId: "device-a", connectorId: "connector-a",
      scope: { kind: "workspace", workspaceId: "workspace-a" }, generation: entityGeneration,
      contractHash: `contract-${entityGeneration}`, status: "online", revision: advertisementRevision,
      kind: "agent", roles: ["general"], taskTypes: ["development"], models: ["provider/model"], maxConcurrency: 1,
    }],
    capabilities: [{
      capabilityId: "capability-a", kind: "agent-competency", endpointId: "endpoint-a",
      contractHash: `contract-${entityGeneration}`, trustLevel: "owner", priority: 5,
      inputSchema: { type: "object", properties: { task: { type: "string" } } },
    }],
  };
}

function live(generation: number): FabricLiveConnection {
  return {
    descriptor: {
      protocolVersion: "fabric.v1", limits,
      lease: {
        connectionId: `connection-${generation}`, deviceId: "device-a", connectorId: "connector-a",
        connectorInstanceNonce: "nonce-private", generation, state: "connected", capabilityDigest: "digest-a",
        establishedAt: 1000, expiresAt: 3000, revision: 0,
      },
    },
    exchange: async (envelope) => envelope,
    close: async () => undefined,
  };
}

async function kernel(maxAdvertisementItems = 20): Promise<{ directory: FabricDirectory; manager: FabricConnectionManager }> {
  const directory = new FabricDirectory();
  directory.seedAuthority({ connector, devices: [device] });
  const transports = new TransportRegistry();
  transports.register({ kind: "ssh", connect: async () => {
    const connection = live(1);
    connection.descriptor.limits.maxAdvertisementItems = maxAdvertisementItems;
    return connection;
  } });
  const manager = new FabricConnectionManager(directory, transports, { now: () => 1100 });
  await manager.connect({
    requestId: "request-a", deviceId: "device-a", connectorId: "connector-a",
    expectedCredentialGeneration: 1, deadlineAt: 2000, limits: { ...limits, maxAdvertisementItems },
  }, new AbortController().signal);
  return { directory, manager };
}

function expectCode(action: () => unknown, code: FabricContractError["code"]): void {
  assert.throws(action, (error: unknown) => error instanceof FabricContractError && error.code === code);
}

test("durable authority seeding is separate from advertisement execution readiness", async () => {
  const { directory, manager } = await kernel();
  assert.equal(directory.getDevice("device-a")?.label, "Device A");
  assert.equal(directory.getWorkspace("workspace-a"), undefined);
  expectCode(() => manager.requireReady("connection-1", 1), "invalid_state");
  manager.acceptAdvertisement(snapshot());
  assert.equal(directory.getWorkspace("workspace-a")?.label, "Workspace A");
  assert.equal(manager.requireReady("connection-1", 1).generation, 1);
});

test("directory publication returns redacted clones and capability allowlist projections", async () => {
  const { directory, manager } = await kernel();
  const input = snapshot();
  const untrusted = input.capabilities[0] as CapabilityBinding & { secret: string; absolutePath: string };
  untrusted.secret = "credential";
  untrusted.absolutePath = "/private/workspace";
  manager.acceptAdvertisement(input);
  input.devices[0]!.label = "mutated";
  input.workspaces[0]!.endpointIds = ["mutated"];
  const listed = directory.list();
  assert.equal(listed.devices[0]?.label, "Device A");
  assert.equal(listed.workspaces[0]?.endpointIds[0], "endpoint-a");
  assert.equal("localWorkspaceId" in (listed.workspaces[0] ?? {}), false);
  assert.equal("instanceNonce" in (listed.connectors[0] ?? {}), false);
  assert.equal("secret" in (listed.capabilities[0] ?? {}), false);
  assert.equal("absolutePath" in (directory.resolveCapabilities()[0]?.binding ?? {}), false);
  const schema = listed.capabilities[0]?.inputSchema as { properties?: { task?: { type?: string } } };
  if (schema.properties?.task) schema.properties.task.type = "number";
  assert.equal((directory.list().capabilities[0]?.inputSchema as { properties: { task: { type: string } } }).properties.task.type, "string");
});

test("advertisements are fenced by connection identity, generation, and monotonic per-connection revision", async () => {
  const { manager } = await kernel();
  manager.acceptAdvertisement(snapshot());
  expectCode(() => manager.acceptAdvertisement({ ...snapshot(1, 2), connectionId: "connection-old" }), "stale_generation");
  expectCode(() => manager.acceptAdvertisement(snapshot(1, 1)), "stale_generation");
  expectCode(() => manager.acceptAdvertisement(snapshot(2, 1)), "stale_generation");
  assert.equal(manager.requireReady("connection-1", 1).generation, 1);
});

test("workspace and endpoint high-water/tombstones reject rollback, same-generation changes, and resurrection", async () => {
  const { manager } = await kernel();
  manager.acceptAdvertisement(snapshot(1, 1, 2));
  expectCode(() => manager.acceptAdvertisement(snapshot(1, 2, 1)), "stale_generation");

  const changedPolicy = snapshot(1, 2, 2);
  changedPolicy.workspaces[0]!.policyDigest = "changed-policy";
  expectCode(() => manager.acceptAdvertisement(changedPolicy), "stale_generation");
  const changedContract = snapshot(1, 2, 2);
  changedContract.endpoints[0]!.contractHash = "changed-contract";
  changedContract.capabilities[0]!.contractHash = "changed-contract";
  expectCode(() => manager.acceptAdvertisement(changedContract), "stale_generation");

  manager.acceptAdvertisement({ ...snapshot(1, 2, 2), workspaces: [], endpoints: [], capabilities: [] });
  expectCode(() => manager.acceptAdvertisement(snapshot(1, 3, 2)), "stale_generation");
  manager.acceptAdvertisement(snapshot(1, 3, 3));
});

test("Capability contractHash must match its Endpoint contractHash", async () => {
  const { manager } = await kernel();
  const mismatched = snapshot();
  mismatched.capabilities[0]!.contractHash = "different";
  expectCode(() => manager.acceptAdvertisement(mismatched), "conflict");
});

test("inputSchema rejects getters, symbols, toJSON, non-JSON, depth, and size", async () => {
  const invalidSchemas: unknown[] = [];
  const getterSchema: Record<string, unknown> = {};
  Object.defineProperty(getterSchema, "type", { enumerable: true, get: () => "object" });
  invalidSchemas.push(getterSchema);
  invalidSchemas.push({ [Symbol("secret")]: true });
  invalidSchemas.push({ toJSON: () => ({}) });
  invalidSchemas.push({ invalid: undefined });
  let deep: Record<string, unknown> = {};
  for (let index = 0; index < 34; index += 1) deep = { nested: deep };
  invalidSchemas.push(deep);
  invalidSchemas.push({ huge: "x".repeat(70_000) });

  for (const [index, inputSchema] of invalidSchemas.entries()) {
    const { manager } = await kernel();
    const base = snapshot();
    const candidate = {
      ...base,
      capabilities: [{ ...base.capabilities[0]!, inputSchema: inputSchema as CapabilityBinding["inputSchema"] }],
    };
    assert.throws(() => manager.acceptAdvertisement(candidate), (error: unknown) => {
      return error instanceof FabricContractError && ["invalid_argument", "resource_exhausted"].includes(error.code);
    }, `schema ${index}`);
  }
});

test("negotiated maxAdvertisementItems applies to every category and the total", async () => {
  const perCategory = await kernel(1);
  const tooManyDevices = snapshot();
  tooManyDevices.devices = [device, { ...device, deviceId: "device-b" }];
  expectCode(() => perCategory.manager.acceptAdvertisement(tooManyDevices), "resource_exhausted");

  const total = await kernel(3);
  expectCode(() => total.manager.acceptAdvertisement(snapshot()), "resource_exhausted");
});

test("invalid references preserve the prior atomic snapshot", async () => {
  const { directory, manager } = await kernel();
  manager.acceptAdvertisement(snapshot());
  const before = directory.list();
  const invalid = snapshot(1, 2);
  invalid.capabilities[0]!.endpointId = "missing";
  expectCode(() => manager.acceptAdvertisement(invalid), "conflict");
  assert.deepEqual(directory.list(), before);
  assert.equal(directory.getAdvertisementRevision("connector-a"), 1);
});
