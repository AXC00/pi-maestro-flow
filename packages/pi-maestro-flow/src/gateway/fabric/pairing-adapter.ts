import {
  FabricContractError,
  assertFabricIdentifier,
} from "pi-maestro-fabric-core/v1";
import type { GatewayPairingPublicRecord, GatewayPairingStore } from "../pairing-store.ts";
import { FabricConnectorSecurity, type FabricConnectorCredentialV1 } from "./security.ts";

/** Audience a Fabric Connector pairing must carry; a legacy token never matches. */
export const FABRIC_PAIRING_AUDIENCE = "fabric" as const;

export interface FabricPairingEnrollmentRequest {
  /** Existing Gateway pairing id that authorizes this enrollment. */
  pairingId: string;
  connectorId: string;
  keyId: string;
  publicKey: string;
}

export interface FabricPairingAdapterOptions {
  readonly pairings: GatewayPairingStore;
  readonly security: FabricConnectorSecurity;
  readonly now?: () => number;
}

/**
 * Bridge an existing Gateway pairing to a Fabric Connector enrollment.
 *
 * The bridge is one-way and narrow on purpose: a pairing authorizes *an
 * enrollment*, and the Fabric credential it produces is a separate identity
 * with its own generation. A legacy `gateway`-audience token is never upgraded
 * into Fabric authority, and only the pairing's Fabric-dedicated scopes are
 * carried over.
 */
export class FabricPairingAdapter {
  readonly #pairings: GatewayPairingStore;
  readonly #security: FabricConnectorSecurity;
  readonly #now: () => number;
  readonly #byPairing = new Map<string, string>();

  constructor(options: FabricPairingAdapterOptions) {
    this.#pairings = options.pairings;
    this.#security = options.security;
    this.#now = options.now ?? Date.now;
  }

  /** Enroll the Connector named by an active Fabric-audience pairing. */
  async enrollFromPairing(request: FabricPairingEnrollmentRequest): Promise<FabricConnectorCredentialV1> {
    assertFabricIdentifier(request.pairingId, "pairingId");
    assertFabricIdentifier(request.connectorId, "connectorId");
    const record = await this.#pairingRecord(request.pairingId);
    const scopes = this.#fabricScopes(record);
    const credential = this.#security.enroll({
      connectorId: request.connectorId,
      keyId: request.keyId,
      publicKey: request.publicKey,
      scopes,
    });
    this.#byPairing.set(request.pairingId, request.connectorId);
    return credential;
  }

  /**
   * Revoke both halves together.
   *
   * Revoking the pairing alone would leave a live Fabric credential behind, and
   * revoking the credential alone would leave the pairing able to enroll
   * another one, so neither half is optional.
   */
  async revokeForPairing(pairingId: string): Promise<FabricConnectorCredentialV1 | undefined> {
    assertFabricIdentifier(pairingId, "pairingId");
    const connectorId = this.#byPairing.get(pairingId);
    let revoked: FabricConnectorCredentialV1 | undefined;
    if (connectorId !== undefined) {
      const credential = this.#security.credentialOf(connectorId);
      if (credential !== undefined && !credential.revoked) {
        revoked = this.#security.revoke(connectorId, credential.revision);
      }
      this.#byPairing.delete(pairingId);
    }
    await this.#pairings.revoke(pairingId, { revokedBy: "fabric-pairing-adapter" });
    return revoked;
  }

  /** Connector this pairing enrolled, when one is bound. */
  connectorOfPairing(pairingId: string): string | undefined {
    return this.#byPairing.get(pairingId);
  }

  async #pairingRecord(pairingId: string): Promise<GatewayPairingPublicRecord> {
    const record = (await this.#pairings.list({ includeInactive: true })).find((entry) => entry.id === pairingId);
    if (record === undefined) {
      throw new FabricContractError("not_found", "Gateway pairing is not known", "pairingId");
    }
    if (record.audience !== FABRIC_PAIRING_AUDIENCE) {
      // The legacy audience is the migration boundary: a `gateway` token is not
      // a Fabric credential and must not become one by being presented here.
      throw new FabricContractError(
        "permission_denied",
        "Gateway pairing audience is not a Fabric audience; a legacy Gateway token never grants Fabric authority",
        "pairingId",
      );
    }
    if (record.revokedAt !== undefined) {
      throw new FabricContractError("permission_denied", "Gateway pairing is revoked", "pairingId");
    }
    if (record.expiresAt <= this.#now()) {
      throw new FabricContractError("expired", "Gateway pairing has expired", "pairingId");
    }
    return record;
  }

  #fabricScopes(record: GatewayPairingPublicRecord): string[] {
    const scopes = record.scopes.filter((scope) => scope.startsWith("fabric."));
    if (scopes.length === 0) {
      throw new FabricContractError(
        "permission_denied",
        "Gateway pairing carries no Fabric-dedicated scope, so it authorizes no Connector enrollment",
        "pairingId",
      );
    }
    return scopes;
  }
}
