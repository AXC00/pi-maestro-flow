import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import {
  FABRIC_ROUTE_TICKET_VERSION,
  FabricContractError,
  type FabricRouteTicketClaimsV1,
  type FabricRouteTicketV1,
} from "pi-maestro-fabric-core/v1";
import {
  FABRIC_ROUTE_TICKET_ALGORITHM,
  FABRIC_ROUTE_TICKET_MAX_TTL_MS,
  FabricRouteTicketKeyringStore,
  FabricRouteTicketSecurity,
  fabricRouteTicketPayload,
  type FabricRouteTicketExpectation,
  type FabricRouteTicketRequest,
} from "../src/gateway/fabric/route-ticket.ts";

const NOW = 1_000_000;
const SECRET = "route-ticket-secret-0000000001";
const OTHER_SECRET = "route-ticket-secret-0000000002";
const AUDIENCE = "edge.example.test";

function expectCode(error: unknown, code: FabricContractError["code"]): boolean {
  return error instanceof FabricContractError && error.code === code;
}

function security(options: { now?: () => number; secrets?: Record<string, string> } = {}): FabricRouteTicketSecurity {
  return new FabricRouteTicketSecurity({
    keyring: new FabricRouteTicketKeyringStore({
      activeKeyId: "key-1",
      secrets: options.secrets ?? { "key-1": SECRET },
    }),
    now: options.now ?? (() => NOW),
  });
}

function request(overrides: Partial<FabricRouteTicketRequest> = {}): FabricRouteTicketRequest {
  return {
    subject: "subject-a",
    audience: AUDIENCE,
    routeId: "route-1",
    deviceId: "device-1",
    endpointId: "endpoint-1",
    connectionGeneration: 2,
    endpointGeneration: 3,
    operationClasses: ["mcp-read"],
    ttlMs: 30_000,
    ...overrides,
  };
}

function expectation(overrides: Partial<FabricRouteTicketExpectation> = {}): FabricRouteTicketExpectation {
  return {
    subjects: ["subject-a"],
    audience: AUDIENCE,
    routeId: "route-1",
    deviceId: "device-1",
    endpointId: "endpoint-1",
    connectionGeneration: 2,
    endpointGeneration: 3,
    operationClass: "mcp-read",
    ...overrides,
  };
}

/** Sign arbitrary claims so a test can present a well-formed but inadmissible ticket. */
function signClaims(claims: FabricRouteTicketClaimsV1, secret = SECRET): FabricRouteTicketV1 {
  return {
    claims,
    proof: createHmac("sha256", secret).update(Buffer.from(fabricRouteTicketPayload(claims), "utf8")).digest("base64"),
  };
}

function claimsOf(overrides: Partial<FabricRouteTicketClaimsV1> = {}): FabricRouteTicketClaimsV1 {
  return {
    version: FABRIC_ROUTE_TICKET_VERSION,
    ticketId: "ticket-1",
    keyId: "key-1",
    subject: "subject-a",
    audience: AUDIENCE,
    routeId: "route-1",
    deviceId: "device-1",
    endpointId: "endpoint-1",
    connectionGeneration: 2,
    endpointGeneration: 3,
    operationClasses: ["mcp-read"],
    issuedAt: NOW,
    expiresAt: NOW + 30_000,
    nonce: "nonce-1",
    ...overrides,
  };
}

test("a ticket round trips and verification returns claims only", () => {
  const authority = security();
  const ticket = authority.issue(request());

  assert.equal(ticket.claims.version, FABRIC_ROUTE_TICKET_VERSION);
  assert.equal(FABRIC_ROUTE_TICKET_ALGORITHM, "hmac-sha256");
  assert.equal(ticket.claims.keyId, "key-1");
  assert.equal(ticket.claims.subject, "subject-a");
  assert.equal(ticket.claims.expiresAt - ticket.claims.issuedAt, 30_000);
  assert.ok(ticket.claims.ticketId.length > 0, "ticket identity was not minted");
  assert.ok(ticket.claims.nonce.length > 0, "nonce was not minted");
  assert.equal(ticket.proof.includes(SECRET), false, "the proof leaked the secret");

  const claims = authority.verify(ticket, expectation());
  assert.equal(claims.routeId, "route-1");
  assert.equal(claims.deviceId, "device-1");
  assert.equal(claims.endpointId, "endpoint-1");
  // The projection rule: verification hands back claims and never the proof.
  assert.equal("proof" in claims, false);
  assert.equal(JSON.stringify(claims).includes(SECRET), false);
  assert.equal(authority.consumedNonceCount, 1);
});

test("a ticket is bound to subject, audience, route, Device, Endpoint, and generations", () => {
  const authority = security();
  const ticket = authority.issue(request());

  assert.throws(() => authority.verify(ticket, expectation({ subjects: ["subject-b"] })), (error) => expectCode(error, "permission_denied"));
  assert.throws(() => authority.verify(ticket, expectation({ audience: "other.example.test" })), (error) => expectCode(error, "unauthenticated"));
  assert.throws(() => authority.verify(ticket, expectation({ routeId: "route-2" })), (error) => expectCode(error, "conflict"));
  assert.throws(() => authority.verify(ticket, expectation({ deviceId: "device-2" })), (error) => expectCode(error, "conflict"));
  assert.throws(() => authority.verify(ticket, expectation({ endpointId: "endpoint-2" })), (error) => expectCode(error, "conflict"));
  assert.throws(() => authority.verify(ticket, expectation({ connectionGeneration: 3 })), (error) => expectCode(error, "stale_generation"));
  assert.throws(() => authority.verify(ticket, expectation({ endpointGeneration: 4 })), (error) => expectCode(error, "stale_generation"));
  assert.throws(() => authority.verify(ticket, expectation({ operationClass: "mcp-mutation" })), (error) => expectCode(error, "permission_denied"));
  assert.throws(() => authority.verify(ticket, expectation({ subjects: [] })), (error) => expectCode(error, "invalid_argument"));
});

test("the workspace binding is bound together with its generation, in both directions", () => {
  const authority = security();
  const bound = authority.issue(request({ workspaceBindingId: "binding-1", workspaceGeneration: 5 }));
  const boundExpectation = expectation({ workspaceBindingId: "binding-1", workspaceGeneration: 5 });
  assert.equal(authority.verify(bound, boundExpectation).workspaceBindingId, "binding-1");

  assert.throws(
    () => authority.verify(bound, expectation({ workspaceBindingId: "binding-1", workspaceGeneration: 6 })),
    (error) => expectCode(error, "stale_generation"),
  );
  assert.throws(
    () => authority.verify(bound, expectation()),
    (error) => expectCode(error, "conflict"),
  );

  const unbound = authority.issue(request());
  assert.throws(
    () => authority.verify(unbound, expectation({ workspaceBindingId: "binding-1", workspaceGeneration: 5 })),
    (error) => expectCode(error, "conflict"),
  );
});

test("issuance refuses a missing paired workspace field and an empty operation class list", () => {
  const authority = security();
  assert.throws(() => authority.issue(request({ workspaceBindingId: "binding-1" })), (error) => expectCode(error, "invalid_argument"));
  assert.throws(() => authority.issue(request({ workspaceGeneration: 5 })), (error) => expectCode(error, "invalid_argument"));
  assert.throws(() => authority.issue(request({ operationClasses: [] })), (error) => expectCode(error, "invalid_argument"));
  assert.throws(() => authority.issue(request({ operationClasses: ["mcp-read", "mcp-read"] })), (error) => expectCode(error, "conflict"));
});

test("verification refuses a missing paired workspace field and an empty operation class list", () => {
  const authority = security();
  const unpaired = signClaims(claimsOf({ workspaceBindingId: "binding-1" }));
  assert.throws(() => authority.verify(unpaired, expectation()), (error) => expectCode(error, "invalid_argument"));

  const empty = signClaims(claimsOf({ operationClasses: [] }));
  assert.throws(() => authority.verify(empty, expectation()), (error) => expectCode(error, "invalid_argument"));
});

test("an unknown version fails closed before any signature check", () => {
  const authority = security();
  const unknownVersion = signClaims({ ...claimsOf(), version: "fabric.route-ticket.v2" } as unknown as FabricRouteTicketClaimsV1);
  assert.throws(() => authority.verify(unknownVersion, expectation()), (error) => expectCode(error, "unsupported_version"));
});

test("an expired ticket fails closed", () => {
  let now = NOW;
  const authority = security({ now: () => now });
  const ticket = authority.issue(request({ ttlMs: 5_000 }));
  now = NOW + 5_000;
  assert.throws(() => authority.verify(ticket, expectation()), (error) => expectCode(error, "expired"));
});

test("a lifetime longer than the maximum is refused at issuance and at verification", () => {
  const authority = security();
  assert.throws(
    () => authority.issue(request({ ttlMs: FABRIC_ROUTE_TICKET_MAX_TTL_MS + 1 })),
    (error) => expectCode(error, "invalid_argument"),
  );
  assert.throws(() => authority.issue(request({ ttlMs: 0 })), (error) => expectCode(error, "invalid_argument"));

  // A ticket minted elsewhere with an over-long window is still refused here.
  const longLived = signClaims(claimsOf({ expiresAt: NOW + 120_000 }));
  assert.throws(() => authority.verify(longLived, expectation()), (error) => expectCode(error, "invalid_argument"));
});

test("an unknown key id fails closed instead of falling back to the active key", () => {
  const other = security({ secrets: { "key-1": OTHER_SECRET } });
  const foreign = other.issue(request({ keyId: "key-1" }));
  assert.equal(foreign.claims.keyId, "key-1");

  const authority = security();
  assert.throws(() => authority.verify(foreign, expectation()), (error) => expectCode(error, "unauthenticated"));

  // Issuance with a key id this keyring does not hold is refused too.
  assert.throws(() => authority.issue(request({ keyId: "key-2" })), (error) => expectCode(error, "unauthenticated"));
});

test("a tampered proof and malformed proof text are both refused", () => {
  const authority = security();
  const ticket = authority.issue(request());

  const tampered = { claims: ticket.claims, proof: Buffer.alloc(32).toString("base64") };
  assert.throws(() => authority.verify(tampered, expectation()), (error) => expectCode(error, "unauthenticated"));

  const malformed = { claims: ticket.claims, proof: "not base64 !!" };
  assert.throws(() => authority.verify(malformed, expectation()), (error) => expectCode(error, "protocol_violation"));

  const truncated = { claims: ticket.claims, proof: "AAAA" };
  assert.throws(() => authority.verify(truncated, expectation()), (error) => expectCode(error, "protocol_violation"));
});

test("every bound field is inside the signature, not merely compared", () => {
  const authority = security();
  const ticket = authority.issue(request());

  // Each edit is verified against an expectation that agrees with the edit, so
  // only the signature can be what refuses it.
  const movedSubject = { claims: { ...ticket.claims, subject: "subject-b" }, proof: ticket.proof };
  assert.throws(
    () => authority.verify(movedSubject, expectation({ subjects: ["subject-b"] })),
    (error) => expectCode(error, "unauthenticated"),
  );

  const movedEndpoint = { claims: { ...ticket.claims, endpointId: "endpoint-2" }, proof: ticket.proof };
  assert.throws(
    () => authority.verify(movedEndpoint, expectation({ endpointId: "endpoint-2" })),
    (error) => expectCode(error, "unauthenticated"),
  );

  const widened = { claims: { ...ticket.claims, operationClasses: ["mcp-read", "mcp-mutation"] }, proof: ticket.proof };
  assert.throws(() => authority.verify(widened, expectation()), (error) => expectCode(error, "unauthenticated"));

  const extended = { claims: { ...ticket.claims, expiresAt: ticket.claims.expiresAt + 1_000 }, proof: ticket.proof };
  assert.throws(() => authority.verify(extended, expectation()), (error) => expectCode(error, "unauthenticated"));
});

test("a replayed ticket is refused on the verifying side", () => {
  const authority = security();
  const ticket = authority.issue(request());
  assert.equal(authority.verify(ticket, expectation()).nonce, ticket.claims.nonce);
  assert.throws(() => authority.verify(ticket, expectation()), (error) => expectCode(error, "conflict"));
  // A different nonce under the same ticket id is a different presentation.
  const other = authority.issue(request({ ticketId: ticket.claims.ticketId, nonce: "nonce-2" }));
  assert.equal(authority.verify(other, expectation()).ticketId, ticket.claims.ticketId);
});

test("the canonical payload cannot shift a boundary between fields", () => {
  const left = fabricRouteTicketPayload(claimsOf({ subject: "ab", audience: "c" }));
  const right = fabricRouteTicketPayload(claimsOf({ subject: "a", audience: "bc" }));
  assert.notEqual(left, right, "concatenating fields without lengths made two tickets share one payload");

  const present = fabricRouteTicketPayload(claimsOf({ workspaceBindingId: "b", workspaceGeneration: 1 }));
  const absent = fabricRouteTicketPayload(claimsOf());
  assert.notEqual(present, absent);
  assert.equal(fabricRouteTicketPayload(claimsOf()), fabricRouteTicketPayload(claimsOf()), "the payload is not deterministic");
});

test("the keyring exposes key ids and never a secret", () => {
  const keyring = new FabricRouteTicketKeyringStore({ activeKeyId: "key-2", secrets: { "key-1": SECRET, "key-2": OTHER_SECRET } });
  assert.deepEqual(keyring.keyIds(), ["key-1", "key-2"]);
  assert.equal(JSON.stringify(keyring).includes(SECRET), false);
  assert.equal(JSON.stringify(keyring).includes(OTHER_SECRET), false);
  assert.equal(JSON.stringify(keyring), JSON.stringify({ activeKeyId: "key-2" }));
  assert.throws(() => new FabricRouteTicketKeyringStore({ activeKeyId: "key-3", secrets: { "key-1": SECRET } }), /activeKeyId/);
  assert.throws(() => new FabricRouteTicketKeyringStore({ activeKeyId: "key-1", secrets: { "key-1": "short" } }), /must be 16-/);
});
