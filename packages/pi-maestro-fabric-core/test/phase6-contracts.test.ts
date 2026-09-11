import assert from "node:assert/strict";
import test from "node:test";
import {
  FABRIC_ARTIFACT_VERSION,
  FABRIC_ROUTE_TICKET_VERSION,
  FABRIC_STREAM_VERSION,
  FabricContractError,
  assertValidEndpointRouteHandle,
  assertValidFabricArtifactChunk,
  assertValidFabricArtifactDescriptor,
  assertValidFabricRouteTicket,
  assertValidFabricStreamFrame,
  projectFabricArtifact,
  projectFabricRouteTicket,
  type EndpointRouteHandle,
  type FabricArtifactDescriptorV1,
  type FabricRouteTicketV1,
  type FabricStreamFrameV1,
} from "../src/public/v1/index.ts";

const now = 20_000;

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof FabricContractError && error.code === code);
}

test("stream frames carry route, operation and monotonic sequence identity", () => {
  const frame: FabricStreamFrameV1 = {
    version: FABRIC_STREAM_VERSION,
    streamId: "stream-a",
    routeId: "route-a",
    operationId: "operation-a",
    sequence: 0,
    kind: "open",
    sentAt: now,
    payload: { protocol: "mcp" },
  };
  assert.doesNotThrow(() => assertValidFabricStreamFrame(frame));
  expectCode(() => assertValidFabricStreamFrame({ ...frame, version: "fabric.stream.v2" }), "unsupported_version");
  expectCode(() => assertValidFabricStreamFrame({ ...frame, sequence: -1 }), "invalid_argument");
});

test("route paths permit same-endpoint fallback only from admitted candidates", () => {
  const route: EndpointRouteHandle = {
    routeId: "route-a",
    connectionId: "connection-a",
    endpointId: "endpoint-a",
    connectionGeneration: 2,
    endpointGeneration: 3,
    issuedAt: now,
    expiresAt: now + 10_000,
    state: "open",
    revision: 0,
    deviceId: "device-a",
    operationClass: "artifact-read",
    pathCandidates: ["lan-direct", "edge-relay"],
    selectedPath: "lan-direct",
  };
  assert.doesNotThrow(() => assertValidEndpointRouteHandle(route, now + 1));
  expectCode(() => assertValidEndpointRouteHandle({ ...route, selectedPath: "vps-relay" }), "invalid_argument");
  expectCode(() => assertValidEndpointRouteHandle({ ...route, pathCandidates: ["lan-direct", "lan-direct"] }), "conflict");
});

test("route tickets bind subject, audience, endpoint and generations while projection removes proof", () => {
  const ticket: FabricRouteTicketV1 = {
    claims: {
      version: FABRIC_ROUTE_TICKET_VERSION,
      ticketId: "ticket-a",
      keyId: "key-a",
      subject: "agent-a",
      audience: "edge-a",
      routeId: "route-a",
      deviceId: "device-a",
      endpointId: "endpoint-a",
      connectionGeneration: 2,
      endpointGeneration: 3,
      operationClasses: ["artifact-read"],
      issuedAt: now,
      expiresAt: now + 5_000,
      nonce: "nonce-a",
    },
    proof: "opaque-signed-proof",
  };
  assert.doesNotThrow(() => assertValidFabricRouteTicket(ticket, now + 1));
  assert.equal("proof" in projectFabricRouteTicket(ticket), false);
  expectCode(() => assertValidFabricRouteTicket({ ...ticket, claims: { ...ticket.claims, version: "fabric.route-ticket.v2" } }), "unsupported_version");
  expectCode(() => assertValidFabricRouteTicket({ ...ticket, claims: { ...ticket.claims, operationClasses: [] } }), "invalid_argument");
});

test("artifacts are bounded, generation-fenced metadata with redacted source references", () => {
  const artifact: FabricArtifactDescriptorV1 = {
    version: FABRIC_ARTIFACT_VERSION,
    artifactId: "artifact-a",
    operationId: "operation-a",
    routeId: "route-a",
    deviceId: "device-a",
    endpointId: "endpoint-a",
    connectionGeneration: 2,
    endpointGeneration: 3,
    mediaType: "application/json",
    byteLength: 3,
    digest: "sha256:artifact",
    storage: "source",
    state: "available",
    createdAt: now,
    expiresAt: now + 10_000,
    metadata: { name: "result.json" },
    sourceRef: "device-private://result",
  };
  assert.doesNotThrow(() => assertValidFabricArtifactDescriptor(artifact, now + 1));
  const projected = projectFabricArtifact(artifact);
  assert.equal("sourceRef" in projected, false);
  assert.notEqual(projected.metadata, artifact.metadata);
  expectCode(() => assertValidFabricArtifactDescriptor({ ...artifact, expiresAt: now }), "invalid_argument");
  expectCode(() => assertValidFabricArtifactDescriptor({ ...artifact, storage: "hub-cache" }), "invalid_argument");
});

test("artifact chunks reject non-base64 and oversized payload declarations", () => {
  const chunk = {
    version: FABRIC_ARTIFACT_VERSION,
    artifactId: "artifact-a",
    offset: 0,
    byteLength: 3,
    digest: "sha256:chunk",
    encodedData: "YWJj",
    final: true,
  } as const;
  assert.doesNotThrow(() => assertValidFabricArtifactChunk(chunk));
  expectCode(() => assertValidFabricArtifactChunk({ ...chunk, encodedData: "***" }), "invalid_argument");
  expectCode(() => assertValidFabricArtifactChunk({ ...chunk, byteLength: 1_048_577 }), "resource_exhausted");
});
