import { createPublicKey, verify as verifySignature } from "node:crypto";
import {
  FabricContractError,
  assertBoundedString,
  assertEpochMilliseconds,
  assertFabricIdentifier,
  assertGeneration,
  assertRevision,
  utf8ByteLength,
  type JsonValue,
} from "pi-maestro-fabric-core/v1";

export const FABRIC_CONNECTOR_CREDENTIAL_VERSION = "fabric.connector-credential.v1" as const;
export const FABRIC_CHALLENGE_VERSION = "fabric.challenge.v1" as const;
export const FABRIC_CHALLENGE_PROOF_VERSION = "fabric.challenge-proof.v1" as const;

/** Domain separator: a proof signed for this protocol cannot be replayed into another. */
const PROOF_DOMAIN = "pi-maestro.fabric.connector-proof.v1";
const ED25519_SPKI_MAX_BYTES = 512;
const SIGNATURE_BYTES = 64;
const NONCE_MAX_BYTES = 128;

/**
 * One enrolled Connector identity.
 *
 * The Hub holds a public key, never a secret: enrollment is out-of-band and the
 * key is published by the operator. `credentialGeneration` is the fence that
 * makes rotation authoritative — a proof naming a superseded generation fails
 * even while its signature still verifies.
 */
export interface FabricConnectorCredentialV1 {
  version: typeof FABRIC_CONNECTOR_CREDENTIAL_VERSION;
  connectorId: string;
  keyId: string;
  /** Base64 SPKI DER of an Ed25519 public key. */
  publicKey: string;
  audience: string;
  /** Fabric-dedicated grants; legacy Gateway scopes are never accepted here. */
  scopes: readonly string[];
  credentialGeneration: number;
  createdAt: number;
  expiresAt?: number;
  revoked: boolean;
  revision: number;
}

/** A single-use challenge issued to one Connector. */
export interface FabricChallengeV1 {
  version: typeof FABRIC_CHALLENGE_VERSION;
  challengeId: string;
  connectorId: string;
  challengeNonce: string;
  audience: string;
  protocolVersion: string;
  issuedAt: number;
  expiresAt: number;
}

/** What a Connector returns: identity claims plus a detached Ed25519 signature. */
export interface FabricChallengeProofV1 {
  version: typeof FABRIC_CHALLENGE_PROOF_VERSION;
  challengeId: string;
  connectorId: string;
  instanceNonce: string;
  challengeNonce: string;
  audience: string;
  protocolVersion: string;
  credentialGeneration: number;
  /** Base64 detached signature over {@link fabricChallengeProofPayload}. */
  signature: string;
}

export interface FabricConnectorEnrollmentInput {
  connectorId: string;
  keyId: string;
  publicKey: string;
  scopes: readonly string[];
}

export interface FabricConnectorSecurityOptions {
  /** Audience every challenge and proof must name. */
  readonly audience: string;
  readonly protocolVersion?: string;
  readonly now?: () => number;
  readonly challengeTtlMs?: number;
  readonly maxPendingChallenges?: number;
  readonly maxConnectors?: number;
  readonly credentialExpiresAt?: number;
}

/**
 * The exact bytes a Connector signs.
 *
 * Shared by both sides so the Hub never has to guess an encoding, and
 * domain-separated so a signature over these fields cannot be replayed as any
 * other Fabric message.
 */
export function fabricChallengeProofPayload(claims: {
  connectorId: string;
  instanceNonce: string;
  challengeNonce: string;
  protocolVersion: string;
  audience: string;
  credentialGeneration: number;
}): string {
  return [
    PROOF_DOMAIN,
    claims.connectorId,
    claims.instanceNonce,
    claims.challengeNonce,
    claims.protocolVersion,
    claims.audience,
    String(claims.credentialGeneration),
  ].join("\n");
}

function positive(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new FabricContractError("invalid_argument", `${label} must be a positive safe integer`, label);
  }
  return result;
}

/** A Fabric-dedicated grant. Legacy Gateway scopes never authorize Fabric. */
function assertFabricScope(scope: unknown, path: string): asserts scope is string {
  assertBoundedString(scope, path, 128);
  if (!scope.startsWith("fabric.")) {
    throw new FabricContractError(
      "invalid_argument",
      `${path} must be a Fabric-dedicated scope beginning with "fabric."; legacy Gateway grants never authorize Fabric`,
      path,
    );
  }
}

function decodeEd25519Key(publicKey: string, path: string): ReturnType<typeof createPublicKey> {
  assertBoundedString(publicKey, path, ED25519_SPKI_MAX_BYTES);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey)) {
    throw new FabricContractError("invalid_argument", `${path} must be base64 SPKI DER`, path);
  }
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
  } catch {
    throw new FabricContractError("invalid_argument", `${path} is not a parsable public key`, path);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new FabricContractError("invalid_argument", `${path} must be an Ed25519 public key`, path);
  }
  return key;
}

function decodeSignature(signature: string): Buffer {
  assertBoundedString(signature, "signature", 256);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
    throw new FabricContractError("protocol_violation", "signature must be base64", "signature");
  }
  const bytes = Buffer.from(signature, "base64");
  if (bytes.length !== SIGNATURE_BYTES) {
    throw new FabricContractError("protocol_violation", "signature must be a 64-byte Ed25519 signature", "signature");
  }
  return bytes;
}

function jsonScopes(scopes: readonly string[]): readonly JsonValue[] {
  return scopes as unknown as readonly JsonValue[];
}

/**
 * Hub-side Connector security: enrollment, single-use challenges, and proof
 * verification.
 *
 * Every rejection is fail-closed and indistinguishable where it matters: an
 * unknown, revoked, or expired Connector is reported as unauthenticated so the
 * Hub never confirms which connector ids exist.
 */
export class FabricConnectorSecurity {
  readonly #audience: string;
  readonly #protocolVersion: string;
  readonly #now: () => number;
  readonly #challengeTtlMs: number;
  readonly #maxPendingChallenges: number;
  readonly #maxConnectors: number;
  readonly #credentialExpiresAt?: number;
  readonly #credentials = new Map<string, FabricConnectorCredentialV1>();
  readonly #challenges = new Map<string, FabricChallengeV1>();
  #sequence = 0;

  constructor(options: FabricConnectorSecurityOptions) {
    assertBoundedString(options.audience, "audience", 256);
    this.#audience = options.audience;
    this.#protocolVersion = options.protocolVersion ?? "fabric.v1";
    this.#now = options.now ?? Date.now;
    this.#challengeTtlMs = positive(options.challengeTtlMs, 30_000, "challengeTtlMs");
    this.#maxPendingChallenges = positive(options.maxPendingChallenges, 64, "maxPendingChallenges");
    this.#maxConnectors = positive(options.maxConnectors, 256, "maxConnectors");
    this.#credentialExpiresAt = options.credentialExpiresAt;
    if (this.#credentialExpiresAt !== undefined) assertEpochMilliseconds(this.#credentialExpiresAt, "credentialExpiresAt");
  }

  /** Enroll a Connector from its out-of-band published key. */
  enroll(input: FabricConnectorEnrollmentInput): FabricConnectorCredentialV1 {
    assertFabricIdentifier(input.connectorId, "connectorId");
    assertFabricIdentifier(input.keyId, "keyId");
    decodeEd25519Key(input.publicKey, "publicKey");
    if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
      throw new FabricContractError("invalid_argument", "scopes must name at least one Fabric grant", "scopes");
    }
    for (const [index, scope] of input.scopes.entries()) assertFabricScope(scope, `scopes[${index}]`);
    if (this.#credentials.has(input.connectorId)) {
      throw new FabricContractError("conflict", "Connector is already enrolled; rotate it instead", "connectorId");
    }
    if (this.#credentials.size >= this.#maxConnectors) {
      throw new FabricContractError("resource_exhausted", "Connector enrollment capacity is full", "maxConnectors");
    }
    const credential: FabricConnectorCredentialV1 = {
      version: FABRIC_CONNECTOR_CREDENTIAL_VERSION,
      connectorId: input.connectorId,
      keyId: input.keyId,
      publicKey: input.publicKey,
      audience: this.#audience,
      scopes: [...input.scopes],
      credentialGeneration: 1,
      createdAt: this.#now(),
      ...(this.#credentialExpiresAt === undefined ? {} : { expiresAt: this.#credentialExpiresAt }),
      revoked: false,
      revision: 0,
    };
    this.#credentials.set(credential.connectorId, credential);
    return structuredClone(credential);
  }

  /**
   * Commit a new key and generation while revoking the predecessor.
   *
   * Both halves happen in one step so there is no window in which two
   * generations are acceptable, and the predecessor can never be presented
   * again.
   */
  rotate(connectorId: string, input: FabricConnectorEnrollmentInput, expectedRevision: number): FabricConnectorCredentialV1 {
    assertFabricIdentifier(connectorId, "connectorId");
    assertRevision(expectedRevision, "expectedRevision");
    const current = this.#credentials.get(connectorId);
    if (current === undefined) {
      throw new FabricContractError("unauthenticated", "Connector is not enrolled", "connectorId");
    }
    if (current.revision !== expectedRevision) {
      throw new FabricContractError("conflict", "Connector credential revision is stale", "expectedRevision");
    }
    assertFabricIdentifier(input.keyId, "keyId");
    decodeEd25519Key(input.publicKey, "publicKey");
    if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
      throw new FabricContractError("invalid_argument", "scopes must name at least one Fabric grant", "scopes");
    }
    for (const [index, scope] of input.scopes.entries()) assertFabricScope(scope, `scopes[${index}]`);
    const next: FabricConnectorCredentialV1 = {
      ...current,
      keyId: input.keyId,
      publicKey: input.publicKey,
      scopes: [...input.scopes],
      credentialGeneration: current.credentialGeneration + 1,
      createdAt: this.#now(),
      revoked: false,
      revision: current.revision + 1,
    };
    this.#credentials.set(connectorId, next);
    // Any challenge minted under the predecessor generation is dead with it.
    for (const [id, challenge] of this.#challenges) {
      if (challenge.connectorId === connectorId) this.#challenges.delete(id);
    }
    return structuredClone(next);
  }

  /** Revoke a Connector and drop its outstanding challenges. */
  revoke(connectorId: string, expectedRevision: number): FabricConnectorCredentialV1 {
    assertFabricIdentifier(connectorId, "connectorId");
    assertRevision(expectedRevision, "expectedRevision");
    const current = this.#credentials.get(connectorId);
    if (current === undefined) {
      throw new FabricContractError("unauthenticated", "Connector is not enrolled", "connectorId");
    }
    if (current.revision !== expectedRevision) {
      throw new FabricContractError("conflict", "Connector credential revision is stale", "expectedRevision");
    }
    const next: FabricConnectorCredentialV1 = { ...current, revoked: true, revision: current.revision + 1 };
    this.#credentials.set(connectorId, next);
    for (const [id, challenge] of this.#challenges) {
      if (challenge.connectorId === connectorId) this.#challenges.delete(id);
    }
    return structuredClone(next);
  }

  /** Public, secret-free view of one enrollment. */
  credentialOf(connectorId: string): FabricConnectorCredentialV1 | undefined {
    const credential = this.#credentials.get(connectorId);
    return credential === undefined ? undefined : structuredClone(credential);
  }

  /** Public projection for inventory: identity and grants, never key material. */
  publicCredentialOf(connectorId: string): Omit<FabricConnectorCredentialV1, "publicKey"> | undefined {
    const credential = this.credentialOf(connectorId);
    if (credential === undefined) return undefined;
    const { publicKey: _publicKey, ...publicFields } = credential;
    return publicFields;
  }

  /** Mint a single-use challenge for an enrolled, live Connector. */
  issueChallenge(connectorId: string): FabricChallengeV1 {
    assertFabricIdentifier(connectorId, "connectorId");
    const credential = this.#liveCredential(connectorId);
    const now = this.#now();
    // Expired challenges are dropped first so the pending set stays bounded by
    // live work rather than by traffic.
    for (const [id, challenge] of this.#challenges) {
      if (challenge.expiresAt <= now) this.#challenges.delete(id);
    }
    if (this.#challenges.size >= this.#maxPendingChallenges) {
      throw new FabricContractError("resource_exhausted", "Fabric challenge capacity is full", "maxPendingChallenges");
    }
    this.#sequence += 1;
    const challenge: FabricChallengeV1 = {
      version: FABRIC_CHALLENGE_VERSION,
      challengeId: `challenge-${credential.connectorId}-${this.#sequence}`,
      connectorId: credential.connectorId,
      challengeNonce: `nonce-${this.#sequence}-${this.#now().toString(36)}`,
      audience: this.#audience,
      protocolVersion: this.#protocolVersion,
      issuedAt: now,
      expiresAt: now + this.#challengeTtlMs,
    };
    this.#challenges.set(challenge.challengeId, challenge);
    return structuredClone(challenge);
  }

  /**
   * Verify a Connector's proof and consume its challenge.
   *
   * The challenge is consumed on the first attempt, successful or not: a
   * failed proof must not leave a nonce a second guess can reuse.
   */
  verifyProof(proof: FabricChallengeProofV1): FabricConnectorCredentialV1 {
    const challenge = this.#takeChallenge(proof);
    const credential = this.#liveCredential(proof.connectorId);
    if (proof.audience !== this.#audience || challenge.audience !== this.#audience) {
      throw new FabricContractError("unauthenticated", "Fabric proof audience does not match this Hub", "audience");
    }
    if (proof.protocolVersion !== this.#protocolVersion || challenge.protocolVersion !== this.#protocolVersion) {
      throw new FabricContractError("unsupported_version", "Fabric proof protocol version is not supported", "protocolVersion");
    }
    assertGeneration(proof.credentialGeneration, "credentialGeneration");
    if (proof.credentialGeneration !== credential.credentialGeneration) {
      throw new FabricContractError(
        "stale_generation",
        "Fabric proof names a superseded credential generation",
        "credentialGeneration",
      );
    }
    assertBoundedString(proof.instanceNonce, "instanceNonce", NONCE_MAX_BYTES);
    if (proof.challengeNonce !== challenge.challengeNonce) {
      throw new FabricContractError("unauthenticated", "Fabric proof does not answer this challenge", "challengeNonce");
    }
    const signature = decodeSignature(proof.signature);
    const payload = Buffer.from(fabricChallengeProofPayload({
      connectorId: credential.connectorId,
      instanceNonce: proof.instanceNonce,
      challengeNonce: proof.challengeNonce,
      protocolVersion: proof.protocolVersion,
      audience: proof.audience,
      credentialGeneration: proof.credentialGeneration,
    }), "utf8");
    let verified = false;
    try {
      verified = verifySignature(null, payload, createPublicKey({
        key: Buffer.from(credential.publicKey, "base64"),
        format: "der",
        type: "spki",
      }), signature);
    } catch {
      verified = false;
    }
    if (!verified) {
      throw new FabricContractError("unauthenticated", "Fabric proof signature did not verify", "signature");
    }
    return structuredClone(credential);
  }

  get pendingChallengeCount(): number {
    return this.#challenges.size;
  }

  #liveCredential(connectorId: string): FabricConnectorCredentialV1 {
    const credential = this.#credentials.get(connectorId);
    // Unknown, revoked, and expired are one answer on purpose: the Hub must not
    // confirm which connector ids exist or why one stopped being accepted.
    if (credential === undefined || credential.revoked) {
      throw new FabricContractError("unauthenticated", "Connector is not accepted by this Hub", "connectorId");
    }
    if (credential.expiresAt !== undefined && credential.expiresAt <= this.#now()) {
      throw new FabricContractError("unauthenticated", "Connector credential has expired", "connectorId");
    }
    return credential;
  }

  #takeChallenge(proof: FabricChallengeProofV1): FabricChallengeV1 {
    if (proof.version !== FABRIC_CHALLENGE_PROOF_VERSION) {
      throw new FabricContractError("unsupported_version", "Unsupported Fabric challenge proof version", "version");
    }
    assertFabricIdentifier(proof.challengeId, "challengeId");
    assertFabricIdentifier(proof.connectorId, "connectorId");
    const challenge = this.#challenges.get(proof.challengeId);
    if (challenge === undefined) {
      throw new FabricContractError("unauthenticated", "Fabric challenge is unknown or already used", "challengeId");
    }
    this.#challenges.delete(proof.challengeId);
    if (challenge.connectorId !== proof.connectorId) {
      throw new FabricContractError("unauthenticated", "Fabric challenge belongs to another Connector", "connectorId");
    }
    if (challenge.expiresAt <= this.#now()) {
      throw new FabricContractError("expired", "Fabric challenge has expired", "challengeId");
    }
    if (utf8ByteLength(challenge.challengeNonce) === 0) {
      throw new FabricContractError("protocol_violation", "Fabric challenge nonce is empty", "challengeNonce");
    }
    return challenge;
  }
}
