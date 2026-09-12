import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  FABRIC_ROUTE_TICKET_VERSION,
  FabricContractError,
  assertBoundedString,
  assertFabricIdentifier,
  assertValidFabricRouteTicket,
  assertValidFabricRouteTicketClaims,
  projectFabricRouteTicket,
  utf8ByteLength,
  type DeviceId,
  type EndpointId,
  type FabricOperationClass,
  type FabricRouteTicketClaimsV1,
  type FabricRouteTicketV1,
  type RouteId,
  type WorkspaceBindingId,
} from "pi-maestro-fabric-core/v1";

/** The algorithm this ticket format is defined with, for operators and docs. */
export const FABRIC_ROUTE_TICKET_ALGORITHM = "hmac-sha256" as const;

/** Node's digest name for that algorithm. */
const HMAC_DIGEST = "sha256" as const;

/** A direct path is only ever authorized for a bounded moment. */
export const FABRIC_ROUTE_TICKET_MAX_TTL_MS = 60_000;
export const FABRIC_ROUTE_TICKET_MIN_TTL_MS = 1_000;

/** Domain separator: a proof for a route ticket cannot be replayed as another Fabric message. */
const PAYLOAD_DOMAIN = "pi-maestro.fabric.route-ticket.v1";
const HMAC_BYTES = 32;
const MAX_SECRET_BYTES = 1_024;
const MIN_SECRET_BYTES = 16;
const DEFAULT_MAX_TRACKED_NONCES = 4_096;

/**
 * A key-id keyed HMAC keyring.
 *
 * `secretOf` is the only way to reach key material, and it is keyed by the id
 * the *claims* name. Verification therefore never falls back to the active
 * secret, and an id this keyring does not hold fails closed.
 */
export interface FabricRouteTicketKeyring {
  /** Key id new tickets are signed with. */
  readonly activeKeyId: string;
  /** Secret bytes for a key id, or undefined when this keyring does not hold it. */
  secretOf(keyId: string): Buffer | undefined;
}

export interface FabricRouteTicketKeyringInput {
  readonly activeKeyId: string;
  readonly secrets: Readonly<Record<string, Buffer | string>>;
}

/**
 * An in-memory keyring.
 *
 * It exposes the ids it holds and nothing else: no accessor returns every
 * secret at once, so a caller cannot accidentally serialize the keyring.
 */
export class FabricRouteTicketKeyringStore implements FabricRouteTicketKeyring {
  readonly activeKeyId: string;
  readonly #secrets = new Map<string, Buffer>();

  constructor(input: FabricRouteTicketKeyringInput) {
    assertFabricIdentifier(input.activeKeyId, "activeKeyId");
    const entries = Object.entries(input.secrets);
    if (entries.length === 0) {
      throw new FabricContractError("invalid_argument", "A route ticket keyring must hold at least one secret", "secrets");
    }
    for (const [keyId, secret] of entries) {
      assertFabricIdentifier(keyId, "keyId");
      const bytes = Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(secret, "utf8");
      if (bytes.length < MIN_SECRET_BYTES || bytes.length > MAX_SECRET_BYTES) {
        throw new FabricContractError(
          "invalid_argument",
          `Route ticket secret ${keyId} must be ${MIN_SECRET_BYTES}-${MAX_SECRET_BYTES} bytes`,
          "secrets",
        );
      }
      this.#secrets.set(keyId, bytes);
    }
    if (!this.#secrets.has(input.activeKeyId)) {
      throw new FabricContractError("invalid_argument", "activeKeyId must name a secret this keyring holds", "activeKeyId");
    }
    this.activeKeyId = input.activeKeyId;
  }

  secretOf(keyId: string): Buffer | undefined {
    const secret = this.#secrets.get(keyId);
    return secret === undefined ? undefined : Buffer.from(secret);
  }

  /** Key ids this keyring can verify. Never the secrets themselves. */
  keyIds(): readonly string[] {
    return [...this.#secrets.keys()].sort((left, right) => left.localeCompare(right));
  }
}

export interface FabricRouteTicketRequest {
  readonly subject: string;
  readonly audience: string;
  readonly routeId: RouteId;
  readonly deviceId: DeviceId;
  readonly endpointId: EndpointId;
  readonly workspaceBindingId?: WorkspaceBindingId;
  readonly connectionGeneration: number;
  readonly workspaceGeneration?: number;
  readonly endpointGeneration: number;
  readonly operationClasses: readonly FabricOperationClass[];
  readonly ttlMs: number;
  /** Defaults to the keyring's active key id. */
  readonly keyId?: string;
  /** Defaults to a fresh random identity; reuse is a replay. */
  readonly ticketId?: string;
  readonly nonce?: string;
}

/**
 * What the verifying side is willing to serve.
 *
 * Every field is named by the verifier, never copied from the ticket: an
 * expectation built from the claims would verify nothing.
 */
export interface FabricRouteTicketExpectation {
  /** Subjects this verifier serves. Empty admits nobody. */
  readonly subjects: readonly string[];
  readonly audience: string;
  readonly routeId: RouteId;
  readonly deviceId: DeviceId;
  readonly endpointId: EndpointId;
  readonly workspaceBindingId?: WorkspaceBindingId;
  readonly connectionGeneration: number;
  readonly workspaceGeneration?: number;
  readonly endpointGeneration: number;
  readonly operationClass: FabricOperationClass;
}

export interface FabricRouteTicketSecurityOptions {
  readonly keyring: FabricRouteTicketKeyring;
  readonly now?: () => number;
  readonly maxTtlMs?: number;
  readonly maxTrackedNonces?: number;
}

/**
 * The exact bytes an HMAC covers.
 *
 * Every field is length-prefixed before the fields are joined, so a value can
 * never shift a boundary into its neighbour: a proof over ("ab", "c") can never
 * equal one over ("a", "bc"). Optional fields carry an explicit present/absent
 * marker, so "no workspace" and "an empty workspace id" are different payloads.
 * The operation-class list is count-prefixed for the same reason.
 */
export function fabricRouteTicketPayload(claims: FabricRouteTicketClaimsV1): string {
  const field = (value: string): string => `${utf8ByteLength(value)}:${value}`;
  const optional = (value: string | undefined): string => (value === undefined ? "-" : `+${field(value)}`);
  return [
    PAYLOAD_DOMAIN,
    field(claims.version),
    field(claims.ticketId),
    field(claims.keyId),
    field(claims.subject),
    field(claims.audience),
    field(claims.routeId),
    field(claims.deviceId),
    field(claims.endpointId),
    optional(claims.workspaceBindingId),
    field(String(claims.connectionGeneration)),
    optional(claims.workspaceGeneration === undefined ? undefined : String(claims.workspaceGeneration)),
    field(String(claims.endpointGeneration)),
    field(String(claims.operationClasses.length)),
    ...claims.operationClasses.map((operationClass) => field(operationClass)),
    field(String(claims.issuedAt)),
    field(String(claims.expiresAt)),
    field(claims.nonce),
  ].join("\n");
}

function decodeRouteTicketProof(proof: string): Buffer {
  assertBoundedString(proof, "proof", 256);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(proof)) {
    throw new FabricContractError("protocol_violation", "Route ticket proof must be base64", "proof");
  }
  const bytes = Buffer.from(proof, "base64");
  if (bytes.length !== HMAC_BYTES) {
    throw new FabricContractError("protocol_violation", "Route ticket proof must be a 32-byte HMAC-SHA256 tag", "proof");
  }
  return bytes;
}

/**
 * Signs and verifies short-lived route tickets over the frozen core contract.
 *
 * Structure is decided by Fabric Core; this adapter only decides whether the
 * presented bytes are authentic for the key id they name. Nothing here returns
 * or logs a secret or a proof: verification hands back claims only.
 */
export class FabricRouteTicketSecurity {
  readonly #keyring: FabricRouteTicketKeyring;
  readonly #now: () => number;
  readonly #maxTtlMs: number;
  readonly #maxTrackedNonces: number;
  readonly #consumedNonces = new Map<string, number>();

  constructor(options: FabricRouteTicketSecurityOptions) {
    this.#keyring = options.keyring;
    this.#now = options.now ?? Date.now;
    this.#maxTtlMs = options.maxTtlMs ?? FABRIC_ROUTE_TICKET_MAX_TTL_MS;
    if (!Number.isSafeInteger(this.#maxTtlMs) || this.#maxTtlMs < FABRIC_ROUTE_TICKET_MIN_TTL_MS) {
      throw new FabricContractError("invalid_argument", "maxTtlMs must be a positive safe integer", "maxTtlMs");
    }
    if (this.#maxTtlMs > FABRIC_ROUTE_TICKET_MAX_TTL_MS) {
      throw new FabricContractError(
        "invalid_argument",
        `maxTtlMs cannot exceed ${FABRIC_ROUTE_TICKET_MAX_TTL_MS}; a longer ticket outlives the path it authorizes`,
        "maxTtlMs",
      );
    }
    this.#maxTrackedNonces = options.maxTrackedNonces ?? DEFAULT_MAX_TRACKED_NONCES;
    if (!Number.isSafeInteger(this.#maxTrackedNonces) || this.#maxTrackedNonces < 1) {
      throw new FabricContractError("invalid_argument", "maxTrackedNonces must be a positive safe integer", "maxTrackedNonces");
    }
  }

  /** Mint one ticket. The caller receives the proof; the secret stays here. */
  issue(request: FabricRouteTicketRequest): FabricRouteTicketV1 {
    const now = this.#now();
    const keyId = request.keyId ?? this.#keyring.activeKeyId;
    assertFabricIdentifier(keyId, "keyId");
    const secret = this.#keyring.secretOf(keyId);
    if (secret === undefined) {
      throw new FabricContractError("unauthenticated", "No route ticket secret is held for this key id", "keyId");
    }
    const ttlMs = request.ttlMs;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < FABRIC_ROUTE_TICKET_MIN_TTL_MS || ttlMs > this.#maxTtlMs) {
      throw new FabricContractError(
        "invalid_argument",
        `ttlMs must be between ${FABRIC_ROUTE_TICKET_MIN_TTL_MS} and ${this.#maxTtlMs}`,
        "ttlMs",
      );
    }
    const claims: FabricRouteTicketClaimsV1 = {
      version: FABRIC_ROUTE_TICKET_VERSION,
      ticketId: request.ticketId ?? `ticket-${randomUUID()}`,
      keyId,
      subject: request.subject,
      audience: request.audience,
      routeId: request.routeId,
      deviceId: request.deviceId,
      endpointId: request.endpointId,
      ...(request.workspaceBindingId === undefined ? {} : { workspaceBindingId: request.workspaceBindingId }),
      connectionGeneration: request.connectionGeneration,
      ...(request.workspaceGeneration === undefined ? {} : { workspaceGeneration: request.workspaceGeneration }),
      endpointGeneration: request.endpointGeneration,
      operationClasses: [...request.operationClasses],
      issuedAt: now,
      expiresAt: now + ttlMs,
      nonce: request.nonce ?? `nonce-${randomUUID()}`,
    };
    // Core decides what a ticket may say; this adapter only decides whether the
    // bytes are authentic. Duplicating field rules here would let the two drift.
    assertValidFabricRouteTicketClaims(claims, now);
    const proof = createHmac(HMAC_DIGEST, secret)
      .update(Buffer.from(fabricRouteTicketPayload(claims), "utf8"))
      .digest("base64");
    return { claims, proof };
  }

  /**
   * Verify a presented ticket against what this verifier serves.
   *
   * Returns claims only — the proof never leaves this call.
   */
  verify(ticket: unknown, expectation: FabricRouteTicketExpectation): FabricRouteTicketClaimsV1 {
    const now = this.#now();
    // Structure first: an unknown version, an empty class list, an unpaired
    // workspace field, or an expired window is refused before a secret is used.
    assertValidFabricRouteTicket(ticket, now);
    const { claims, proof } = ticket;
    if (claims.expiresAt - claims.issuedAt > this.#maxTtlMs) {
      throw new FabricContractError(
        "invalid_argument",
        `Route ticket lifetime exceeds ${this.#maxTtlMs}ms and is refused at verification`,
        "expiresAt",
      );
    }
    this.#assertBoundToExpectation(claims, expectation);
    const secret = this.#keyring.secretOf(claims.keyId);
    if (secret === undefined) {
      throw new FabricContractError("unauthenticated", "Route ticket names a key id this verifier does not hold", "keyId");
    }
    const expected = createHmac(HMAC_DIGEST, secret)
      .update(Buffer.from(fabricRouteTicketPayload(claims), "utf8"))
      .digest();
    if (!timingSafeEqual(expected, decodeRouteTicketProof(proof))) {
      throw new FabricContractError("unauthenticated", "Route ticket proof did not verify", "proof");
    }
    // Consumed only after the proof verifies, so a forged ticket cannot burn a
    // nonce an honest sender still needs.
    this.#consumeNonce(claims, now);
    return projectFabricRouteTicket({ claims, proof });
  }

  /** Nonces currently fenced against replay. Counts only; never the values. */
  get consumedNonceCount(): number {
    return this.#consumedNonces.size;
  }

  #assertBoundToExpectation(claims: FabricRouteTicketClaimsV1, expectation: FabricRouteTicketExpectation): void {
    if (!Array.isArray(expectation.subjects) || expectation.subjects.length === 0) {
      throw new FabricContractError("invalid_argument", "subjects must name at least one subject this verifier serves", "subjects");
    }
    for (const [index, subject] of expectation.subjects.entries()) assertFabricIdentifier(subject, `subjects[${index}]`);
    assertBoundedString(expectation.audience, "audience", 256);
    assertFabricIdentifier(expectation.routeId, "routeId");
    assertFabricIdentifier(expectation.deviceId, "deviceId");
    assertFabricIdentifier(expectation.endpointId, "endpointId");
    if (expectation.workspaceBindingId !== undefined) assertFabricIdentifier(expectation.workspaceBindingId, "workspaceBindingId");
    if (!expectation.subjects.includes(claims.subject)) {
      throw new FabricContractError("permission_denied", "Route ticket was issued for another subject", "subject");
    }
    if (claims.audience !== expectation.audience) {
      throw new FabricContractError("unauthenticated", "Route ticket audience does not match this verifier", "audience");
    }
    if (claims.routeId !== expectation.routeId
      || claims.deviceId !== expectation.deviceId
      || claims.endpointId !== expectation.endpointId) {
      throw new FabricContractError("conflict", "Route ticket names another route, Device, or Endpoint", "routeId");
    }
    if (claims.workspaceBindingId !== expectation.workspaceBindingId) {
      throw new FabricContractError("conflict", "Route ticket workspace binding does not match the current route", "workspaceBindingId");
    }
    if (claims.connectionGeneration !== expectation.connectionGeneration
      || claims.endpointGeneration !== expectation.endpointGeneration) {
      throw new FabricContractError("stale_generation", "Route ticket names a superseded route generation", "connectionGeneration");
    }
    if (claims.workspaceGeneration !== expectation.workspaceGeneration) {
      throw new FabricContractError("stale_generation", "Route ticket names a superseded workspace generation", "workspaceGeneration");
    }
    if (!claims.operationClasses.includes(expectation.operationClass)) {
      throw new FabricContractError("permission_denied", "Route ticket does not admit this operation class", "operationClasses");
    }
  }

  #consumeNonce(claims: FabricRouteTicketClaimsV1, now: number): void {
    for (const [key, expiresAt] of this.#consumedNonces) {
      if (expiresAt <= now) this.#consumedNonces.delete(key);
    }
    // Identity is the pair, not either half: a ticket id alone or a nonce alone
    // is not what the sender presented.
    const key = `${claims.ticketId}\u0000${claims.nonce}`;
    if (this.#consumedNonces.has(key)) {
      throw new FabricContractError("conflict", "Route ticket was already presented to this verifier", "nonce");
    }
    if (this.#consumedNonces.size >= this.#maxTrackedNonces) {
      throw new FabricContractError("resource_exhausted", "Route ticket replay fence is full", "maxTrackedNonces");
    }
    this.#consumedNonces.set(key, claims.expiresAt);
  }
}
