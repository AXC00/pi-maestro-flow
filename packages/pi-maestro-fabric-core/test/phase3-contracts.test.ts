import assert from "node:assert/strict";
import test from "node:test";
import {
  FABRIC_CONTROL_VERSION,
  FABRIC_MOUNT_VERSION,
  FABRIC_PLACEMENT_VERSION,
  FABRIC_STORE_CURSOR_VERSION,
  FABRIC_STORE_EVENT_VERSION,
  FABRIC_STORE_KINDS,
  FABRIC_STORE_TRANSACTION_VERSION,
  FabricContractError,
  assertValidFabricControlRequest,
  assertValidFabricMountLease,
  assertValidFabricStoreTransaction,
  assertValidTeammatePlacement,
  migrateFabricPersistedStoreState,
  validateWorkspaceTodoSnapshot,
  type FabricMountLeaseV1,
  type FabricStoreCursorV1,
  type FabricStoreEventV1,
  type FabricStoreTransactionV1,
  type TeammatePlacementV1,
} from "../src/public/v1/index.ts";

const now = 10_000;

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof FabricContractError && error.code === code);
}

function event(storeKind: (typeof FABRIC_STORE_KINDS)[number]): FabricStoreEventV1 {
  return {
    version: FABRIC_STORE_EVENT_VERSION,
    eventId: `event-${storeKind}`,
    storeKind,
    sequence: 1,
    eventKind: "record.updated",
    subjectId: "subject-a",
    subjectRevision: 1,
    occurredAt: now,
    payload: { state: "safe" },
  };
}

function cursor(storeKind: (typeof FABRIC_STORE_KINDS)[number]): FabricStoreCursorV1 {
  return {
    version: FABRIC_STORE_CURSOR_VERSION,
    consumerId: "monitor-a",
    storeKind,
    nextSequence: 2,
    snapshotRevision: 1,
    updatedAt: now,
  };
}

test("control requests are explicit, bounded and fail closed", () => {
  const request = {
    version: FABRIC_CONTROL_VERSION,
    requestId: "request-a",
    action: "route.open",
    deadlineAt: now + 1_000,
    connectionId: "connection-a",
    endpointId: "endpoint-a",
    expectedConnectionGeneration: 2,
    expectedEndpointGeneration: 4,
    operationClass: "agent-placement",
    requestedTtlMs: 30_000,
    pathCandidates: ["hub", "edge-relay"],
  } as const;
  assert.doesNotThrow(() => assertValidFabricControlRequest(request, now));
  expectCode(() => assertValidFabricControlRequest({ ...request, version: "fabric.control.v2" }, now), "unsupported_version");
  const { endpointId: _endpointId, ...missingEndpoint } = request;
  expectCode(() => assertValidFabricControlRequest(missingEndpoint, now), "invalid_argument");
  expectCode(() => assertValidFabricControlRequest({ ...request, requestedTtlMs: 86_400_001 }, now), "resource_exhausted");

  for (const action of ["device.get", "device.status", "device.workspaces"] as const) {
    assert.doesNotThrow(() => assertValidFabricControlRequest({
      version: FABRIC_CONTROL_VERSION, requestId: `request-${action}`, action, deadlineAt: now + 1_000, deviceId: "device-a",
    }, now));
  }
  assert.doesNotThrow(() => assertValidFabricControlRequest({
    version: FABRIC_CONTROL_VERSION, requestId: "request-pair", action: "device.pair", deadlineAt: now + 1_000,
    connectorId: "connector-a", deviceId: "device-a", pairingRef: "ssh-host-a",
  }, now));
  assert.doesNotThrow(() => assertValidFabricControlRequest({
    version: FABRIC_CONTROL_VERSION, requestId: "request-connect", action: "device.connect", deadlineAt: now + 1_000,
    connectorId: "connector-a", deviceId: "device-a", expectedCredentialGeneration: 2,
  }, now));
  assert.doesNotThrow(() => assertValidFabricControlRequest({
    version: FABRIC_CONTROL_VERSION, requestId: "request-disconnect", action: "device.disconnect", deadlineAt: now + 1_000,
    deviceId: "device-a", connectionId: "connection-a", expectedConnectionGeneration: 3,
  }, now));
  expectCode(() => assertValidFabricControlRequest({
    version: FABRIC_CONTROL_VERSION, requestId: "request-pair", action: "device.pair", deadlineAt: now + 1_000,
    connectorId: "connector-a", deviceId: "device-a",
  }, now), "invalid_argument");
});

test("all five store authorities share revision-fenced transaction, event and cursor contracts", () => {
  for (const storeKind of FABRIC_STORE_KINDS) {
    const transaction: FabricStoreTransactionV1 = {
      version: FABRIC_STORE_TRANSACTION_VERSION,
      transactionId: `transaction-${storeKind}`,
      storeKind,
      expectedRevision: 0,
      nextRevision: 1,
      committedAt: now,
      mutations: [{ kind: "upsert", subjectId: "subject-a", value: { revision: 1 } }],
      events: [event(storeKind)],
    };
    assert.doesNotThrow(() => assertValidFabricStoreTransaction(transaction));
    expectCode(() => assertValidFabricStoreTransaction({ ...transaction, nextRevision: 2 }), "conflict");
  }
});

test("persisted store state migrates at the read boundary and rejects unknown or incomplete shapes", () => {
  const legacy = {
    storeKind: "event",
    revision: 1,
    events: [event("event")],
    cursor: cursor("event"),
  } as const;
  const migrated = migrateFabricPersistedStoreState(legacy);
  assert.equal(migrated.shapeVersion, 1);
  assert.equal(migrated.cursors.length, 1);
  assert.notEqual(migrated.events, legacy.events);

  expectCode(() => migrateFabricPersistedStoreState({ ...legacy, shapeVersion: 2 }), "unsupported_version");
  expectCode(() => migrateFabricPersistedStoreState({ shapeVersion: 1, storeKind: "event", revision: 0, events: [] }), "invalid_argument");
});

test("mount leases are session- and route-bound and redact credentials through projection", async () => {
  const { projectFabricMount } = await import("../src/public/v1/index.ts");
  const mount: FabricMountLeaseV1 = {
    version: FABRIC_MOUNT_VERSION,
    mountId: "mount-a",
    sessionId: "session-a",
    routeId: "route-a",
    routeRevision: 3,
    connectionId: "connection-a",
    endpointId: "endpoint-a",
    connectionGeneration: 2,
    endpointGeneration: 4,
    providerNamespace: "fabric",
    serverName: "files",
    transport: "streamable-http",
    issuedAt: now,
    expiresAt: now + 10_000,
    state: "active",
    revision: 0,
    credentialRef: "vault://credential-a",
  };
  assert.doesNotThrow(() => assertValidFabricMountLease(mount, now + 1));
  assert.equal("credentialRef" in projectFabricMount(mount), false);
  expectCode(() => assertValidFabricMountLease({ ...mount, workspaceGeneration: 3 }), "invalid_argument");
});

test("qualified task references preserve authority and Todo snapshot text is display-safe", () => {
  const snapshot = validateWorkspaceTodoSnapshot({
    reference: { authority: "pi-todo", workspaceId: "workspace-a", taskId: "task-a" },
    subject: "build\r\nforge\u001b[31m\t",
    status: "in_progress",
    summary: "safe\u0000summary",
    revision: 2,
    capturedAt: now,
    truncated: true,
  });
  assert.equal(snapshot.subject, "build forge[31m");
  assert.equal(snapshot.summary, "safesummary");
  assert.equal(snapshot.capturedAt, now);
  assert.equal(snapshot.truncated, true);
  expectCode(() => validateWorkspaceTodoSnapshot({ ...snapshot, reference: { ...snapshot.reference, authority: "local" } }), "invalid_argument");
});

test("teammate placement binds route generations without owning dispatch", () => {
  const placement: TeammatePlacementV1 = {
    version: FABRIC_PLACEMENT_VERSION,
    placementId: "placement-a",
    routeId: "route-a",
    endpointId: "endpoint-a",
    connectionGeneration: 2,
    endpointGeneration: 4,
    task: { authority: "board", workspaceId: "workspace-a", taskId: "task-a" },
    requestedModel: "openai-codex/gpt-5.4",
    requestedRole: "general",
    requestedTaskType: "development",
    deadlineAt: now + 1_000,
  };
  assert.doesNotThrow(() => assertValidTeammatePlacement(placement, now));
  expectCode(() => assertValidTeammatePlacement({ ...placement, version: "fabric.placement.v2" }, now), "unsupported_version");
  expectCode(() => assertValidTeammatePlacement({ ...placement, deadlineAt: now }, now), "deadline_exceeded");
});
