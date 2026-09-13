import { randomUUID } from "node:crypto";
import { FabricContractError, assertFabricIdentifier, type DeviceRecord } from "pi-maestro-fabric-core/v1";
import type { GatewayPairingPublicRecord, GatewayPairingStore } from "../pairing-store.ts";
import {
  FABRIC_ENROLL_SCOPE,
  FABRIC_PAIRING_PROVIDER,
  FABRIC_ROTATE_SCOPE,
  GatewayFabricRegistrationAuthority,
  type GatewayFabricRegistrationReceiptV1,
} from "./registration.ts";
import type { FabricConnectorSecurity } from "./security.ts";

/** Audience a Fabric Connector purpose token must carry; a legacy token never matches. */
export const FABRIC_PAIRING_AUDIENCE = "fabric" as const;

export interface FabricPairingEnrollmentRequest {
  /** Raw bearer token. A pairing id alone is never authorization. */
  token: string;
  requestId: string;
  connectorId: string;
  keyId: string;
  publicKey: string;
  label?: string;
  transport?: "outbound-wss" | "ssh" | "direct-https" | "edge-relay";
  devices?: readonly Omit<DeviceRecord, "connectorId" | "revision">[];
}

export interface FabricPairingRotationRequest {
  token: string;
  requestId: string;
  connectorId: string;
  expectedRevision: number;
  expectedCredentialGeneration: number;
  keyId: string;
  publicKey: string;
}

export interface FabricConnectorRevocationRequest {
  requestId: string;
  connectorId: string;
  expectedRevision: number;
  pairingId?: string;
}

export type FabricRegistrationOperation = "enroll" | "rotate" | "revoke";

export interface FabricPostCommitResult {
  readonly cleanupComplete: boolean;
}

export interface FabricConnectorRevocationResult extends GatewayFabricRegistrationReceiptV1 {
  /** Durable registry state; kept distinct from retryable physical cleanup. */
  readonly durableStatus: "revoked";
  readonly cleanupStatus: "complete" | "pending";
  readonly lifecycleStatus: "revoked" | "revoked-cleanup-pending";
}

/**
 * Daemon-owned ordering boundary for purpose-token issuance/revocation and the
 * complete authenticate-to-registration-commit interval.
 */
export class FabricRegistrationLifecycleGate {
  #tail: Promise<void> = Promise.resolve();
  readonly #revokedPairings = new Set<string>();

  fencePairingRevocation(pairingId: string): void {
    assertFabricIdentifier(pairingId, "pairingId");
    this.#revokedPairings.add(pairingId);
  }

  pairingRevocationPending(pairingId: string): boolean {
    return this.#revokedPairings.has(pairingId);
  }

  clearPairingRevocationFence(pairingId: string): void {
    this.#revokedPairings.delete(pairingId);
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); }
    finally { release(); }
  }
}

export interface FabricPairingAdapterOptions {
  readonly pairings: GatewayPairingStore;
  readonly authority: GatewayFabricRegistrationAuthority;
  /** Optional live challenge owner; invalidated only after durable commits. */
  readonly security?: FabricConnectorSecurity;
  readonly gate?: FabricRegistrationLifecycleGate;
  /** Post-commit projection/session fence. A failure must leave admission blocked. */
  readonly afterCommit?: (connectorId: string, operation: FabricRegistrationOperation) => FabricPostCommitResult | Promise<FabricPostCommitResult>;
}

/**
 * Authenticates narrow Fabric-purpose tokens, then consumes them atomically with
 * the durable registration mutation. Pairing-store cleanup happens only after
 * the registry commit and is never the authority for single-use enforcement.
 */
export class FabricPairingAdapter {
  readonly #pairings: GatewayPairingStore;
  readonly #authority: GatewayFabricRegistrationAuthority;
  readonly #security?: FabricConnectorSecurity;
  readonly #gate: FabricRegistrationLifecycleGate;
  readonly #afterCommit?: FabricPairingAdapterOptions["afterCommit"];

  constructor(options: FabricPairingAdapterOptions) {
    this.#pairings = options.pairings;
    this.#authority = options.authority;
    this.#security = options.security;
    this.#gate = options.gate ?? new FabricRegistrationLifecycleGate();
    this.#afterCommit = options.afterCommit;
  }

  async enrollFromPairing(request: FabricPairingEnrollmentRequest): Promise<GatewayFabricRegistrationReceiptV1> {
    return this.#gate.run(async () => {
      assertFabricIdentifier(request.connectorId, "connectorId");
      const pairing = await this.#authenticatePurpose(request.token, request.connectorId, FABRIC_ENROLL_SCOPE);
      if (this.#gate.pairingRevocationPending(pairing.id)) {
        throw new FabricContractError("permission_denied", "Fabric purpose token revocation is pending", "authorization");
      }
      const revalidated = await this.#authenticatePurpose(request.token, request.connectorId, FABRIC_ENROLL_SCOPE);
      if (revalidated.id !== pairing.id || this.#gate.pairingRevocationPending(pairing.id)) {
        throw new FabricContractError("permission_denied", "Fabric purpose token revocation is pending", "authorization");
      }
      const receipt = await this.#authority.enroll({
        requestId: request.requestId,
        pairingId: pairing.id,
        rawToken: request.token,
        authorizationExpiresAt: revalidated.expiresAt,
        connector: {
          connectorId: request.connectorId,
          label: request.label ?? request.connectorId,
          transport: request.transport ?? "outbound-wss",
        },
        devices: request.devices ?? [],
        keyId: request.keyId,
        publicKeySpki: request.publicKey,
      });
      await this.#postCommit(request.connectorId, "enroll");
      // Best-effort bootstrap cleanup. The durable consumption tombstone already
      // makes reuse impossible if this independent write fails. Deliberately do
      // not call the coupled public revoke path here: that would revoke the new
      // Connector whose bootstrap token was just consumed.
      await this.#pairings.revoke(pairing.id, { revokedBy: "fabric-registration-consumed" }).catch(() => false);
      return receipt;
    });
  }

  async rotateFromPairing(request: FabricPairingRotationRequest): Promise<GatewayFabricRegistrationReceiptV1> {
    return this.#gate.run(async () => {
      assertFabricIdentifier(request.connectorId, "connectorId");
      const pairing = await this.#authenticatePurpose(
        request.token,
        request.connectorId,
        FABRIC_ROTATE_SCOPE,
        request.expectedCredentialGeneration,
      );
      if (this.#gate.pairingRevocationPending(pairing.id)) {
        throw new FabricContractError("permission_denied", "Fabric purpose token revocation is pending", "authorization");
      }
      const revalidated = await this.#authenticatePurpose(
        request.token,
        request.connectorId,
        FABRIC_ROTATE_SCOPE,
        request.expectedCredentialGeneration,
      );
      if (revalidated.id !== pairing.id || this.#gate.pairingRevocationPending(pairing.id)) {
        throw new FabricContractError("permission_denied", "Fabric purpose token revocation is pending", "authorization");
      }
      const receipt = await this.#authority.rotate({
        requestId: request.requestId,
        pairingId: pairing.id,
        rawToken: request.token,
        authorizationExpiresAt: revalidated.expiresAt,
        connectorId: request.connectorId,
        expectedRevision: request.expectedRevision,
        expectedCredentialGeneration: request.expectedCredentialGeneration,
        keyId: request.keyId,
        publicKeySpki: request.publicKey,
      });
      await this.#postCommit(request.connectorId, "rotate");
      await this.#pairings.revoke(pairing.id, { revokedBy: "fabric-registration-consumed" }).catch(() => false);
      return receipt;
    });
  }

  /** Owner-authenticated Connector revoke, ordered against purpose enrollment. */
  async revokeConnector(request: FabricConnectorRevocationRequest): Promise<FabricConnectorRevocationResult> {
    return this.#gate.run(async () => {
      const receipt = await this.#authority.revoke(request);
      const projected = await this.#postCommit(request.connectorId, "revoke");
      const pairingsCleaned = await this.#cleanupConnectorPairings(request.connectorId, "fabric-connector-revoke");
      const cleanupComplete = projected.cleanupComplete && pairingsCleaned;
      return {
        ...receipt,
        durableStatus: "revoked",
        cleanupStatus: cleanupComplete ? "complete" : "pending",
        lifecycleStatus: cleanupComplete ? "revoked" : "revoked-cleanup-pending",
      };
    });
  }

  /**
   * Operator-side coupled revoke. Durable Connector revocation commits first;
   * pairing cleanup may fail without resurrecting the Connector.
   */
  async revokeForPairing(
    pairingId: string,
    options: { requestId?: string; expectedRevision?: number } = {},
  ): Promise<GatewayFabricRegistrationReceiptV1 | undefined> {
    this.#gate.fencePairingRevocation(pairingId);
    try {
      return await this.#gate.run(async () => (await this.#revokePairingUnlocked(pairingId, options)).receipt);
    } finally {
      this.#gate.clearPairingRevocationFence(pairingId);
    }
  }

  /** Generic control-compatible revoke result, still ordered with enrollment. */
  async revokePairing(
    pairingId: string,
    options: { requestId?: string; expectedRevision?: number; revokedBy?: string; replacementId?: string } = {},
  ): Promise<{ revoked: boolean; receipt?: GatewayFabricRegistrationReceiptV1; cleanupStatus?: "complete" | "pending" }> {
    this.#gate.fencePairingRevocation(pairingId);
    try {
      return await this.#gate.run(() => this.#revokePairingUnlocked(pairingId, options));
    } finally {
      this.#gate.clearPairingRevocationFence(pairingId);
    }
  }

  async connectorOfPairing(pairingId: string): Promise<string | undefined> {
    return this.#authority.connectorOfPairing(pairingId);
  }

  async #revokePairingUnlocked(
    pairingId: string,
    options: { requestId?: string; expectedRevision?: number; revokedBy?: string; replacementId?: string },
  ): Promise<{ revoked: boolean; receipt?: GatewayFabricRegistrationReceiptV1; cleanupStatus?: "complete" | "pending" }> {
    assertFabricIdentifier(pairingId, "pairingId");
    const connectorId = await this.#authority.connectorOfPairing(pairingId);
    if (connectorId === undefined) {
      const revoked = await this.#pairings.revoke(pairingId, {
        ...(options.revokedBy === undefined ? {} : { revokedBy: options.revokedBy }),
        ...(options.replacementId === undefined ? {} : { replacementId: options.replacementId }),
      });
      return { revoked };
    }
    const registration = await this.#authority.read(connectorId);
    if (registration === undefined) throw new FabricContractError("protocol_violation", "Consumed pairing references a missing Connector", "pairingId");
    const receipt = await this.#authority.revoke({
      requestId: options.requestId ?? `revoke:${randomUUID()}`,
      connectorId,
      expectedRevision: options.expectedRevision ?? registration.connector.revision,
      pairingId,
    });
    const projected = await this.#postCommit(connectorId, "revoke");
    const pairingsCleaned = await this.#cleanupConnectorPairings(connectorId, options.revokedBy ?? "fabric-pairing-adapter");
    return { revoked: true, receipt, cleanupStatus: projected.cleanupComplete && pairingsCleaned ? "complete" : "pending" };
  }

  async #cleanupConnectorPairings(connectorId: string, revokedBy: string): Promise<boolean> {
    try {
      const durableIds = await this.#authority.pairingIdsOfConnector(connectorId);
      const issuedIds = (await this.#pairings.list({ includeInactive: true }))
        .filter((pairing) => pairing.audience === FABRIC_PAIRING_AUDIENCE && pairing.provider === FABRIC_PAIRING_PROVIDER && pairing.instance === connectorId)
        .map((pairing) => pairing.id);
      const pairingIds = [...new Set([...durableIds, ...issuedIds])];
      const results = await Promise.all(pairingIds.map((pairingId) => this.#pairings.revoke(pairingId, { revokedBy }).then(() => true, () => false)));
      return results.every(Boolean);
    } catch {
      return false;
    }
  }

  async #postCommit(connectorId: string, operation: FabricRegistrationOperation): Promise<FabricPostCommitResult> {
    if (operation !== "enroll") this.#security?.invalidateChallenges(connectorId);
    return await this.#afterCommit?.(connectorId, operation) ?? { cleanupComplete: true };
  }

  async #authenticatePurpose(
    token: string,
    connectorId: string,
    scope: typeof FABRIC_ENROLL_SCOPE | typeof FABRIC_ROTATE_SCOPE,
    generation?: number,
  ): Promise<GatewayPairingPublicRecord> {
    const record = await this.#pairings.authenticate(token, {
      audience: FABRIC_PAIRING_AUDIENCE,
      provider: FABRIC_PAIRING_PROVIDER,
      instance: connectorId,
      ...(generation === undefined ? {} : { generation }),
    });
    if (record === undefined) {
      throw new FabricContractError("unauthenticated", "Fabric purpose token is invalid or unavailable", "authorization");
    }
    if (record.scopes.length !== 1 || record.scopes[0] !== scope) {
      throw new FabricContractError("permission_denied", `Fabric purpose token must grant exactly ${scope}`, "authorization");
    }
    return record;
  }
}
