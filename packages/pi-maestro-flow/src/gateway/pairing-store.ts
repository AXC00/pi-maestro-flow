/** Persistent least-privilege pairing credentials. Raw bearer tokens are never stored. */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { GATEWAY_STATE_VERSION } from "./contracts.ts";
import { isPrimaryGatewayScope } from "./capabilities.ts";
import { gatewayPairingPath, readGatewayJson, writeGatewayJsonAtomic } from "./state-paths.ts";

const MAX_PAIRING_BYTES = 1024 * 1024;
const MAX_PAIRINGS = 256;
const MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000;
export const GATEWAY_PRIMARY_AUDIENCE = "gateway";

export interface GatewayPairingRecord {
  version: typeof GATEWAY_STATE_VERSION;
  id: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  scopes: string[];
  audience: string;
  generation: number;
  workspaceId?: string;
  provider?: string;
  instance?: string;
  label?: string;
  replacesId?: string;
  replacedById?: string;
  revokedAt?: number;
  revokedBy?: string;
}
interface PairingDocument { version: typeof GATEWAY_STATE_VERSION; pairings: GatewayPairingRecord[] }
export type GatewayPairingPublicRecord = Omit<GatewayPairingRecord, "tokenHash">;
export interface GatewayPairingIssue extends GatewayPairingPublicRecord { token: string }
export interface GatewayPairingIssueOptions {
  ttlMs?: number;
  label?: string;
  scopes?: readonly string[];
  audience?: string;
  workspaceId?: string;
  /** Compatibility alias accepted at the control boundary. */
  workspace?: string;
  provider?: string;
  instance?: string;
  generation?: number;
  replacesId?: string;
}
export interface GatewayPairingAuthenticationContext {
  audience?: string;
  workspaceId?: string;
  provider?: string;
  instance?: string;
  generation?: number;
}
export interface GatewayPairingRevokeOptions {
  revokedBy?: string;
  replacementId?: string;
  /** Human-readable reason carried to in-process revocation listeners. */
  reason?: string;
}

export interface GatewayPairingRevocationEvent {
  /** Pairing id; `pairingId` is retained as an explicit principal spelling. */
  id: string;
  pairingId: string;
  record: GatewayPairingPublicRecord;
  revokedAt: number;
  reason: string;
  replacementId?: string;
}

export type GatewayPairingRevocationListener = (event: GatewayPairingRevocationEvent) => void | Promise<void>;

export interface GatewayPairingMatchRevokeOptions {
  audience: string;
  provider: string;
  instance: string;
  reason: string;
  revokedBy?: string;
}

const MAX_REVOCATION_LISTENERS = 64;

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}
function publicRecord(record: GatewayPairingRecord): GatewayPairingPublicRecord {
  const { tokenHash: _secret, ...value } = record;
  return structuredClone(value);
}
function boundedString(value: unknown, label: string, maximum = 256): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "" || Buffer.byteLength(value, "utf8") > maximum) throw new Error(`${label} is invalid`);
  return value.trim();
}

/** Canonical form used at every pairing audience boundary (including IPC). */
export function canonicalizeGatewayPairingAudience(value: unknown): string {
  const audience = boundedString(value, "pairing audience", 128);
  if (audience === undefined || /\s|\0/u.test(audience)) throw new Error("pairing audience is invalid");
  return audience;
}

function normalizedScopes(value: readonly string[] | undefined, audience: string): string[] {
  const scopes = value === undefined ? (audience === GATEWAY_PRIMARY_AUDIENCE ? ["gateway"] : []) : [...value];
  if (scopes.length > 64 || new Set(scopes).size !== scopes.length || scopes.some((scope) => scope !== "*" && !/^[A-Za-z0-9][A-Za-z0-9.*:_-]{0,127}$/.test(scope))) {
    throw new Error("pairing scopes are invalid");
  }
  if (audience !== GATEWAY_PRIMARY_AUDIENCE && (scopes.length === 0 || scopes.some(isPrimaryGatewayScope))) {
    throw new Error("non-primary pairing requires narrow scopes and cannot receive a primary Gateway umbrella scope");
  }
  return scopes;
}

export class GatewayPairingStore {
  readonly path: string;
  private readonly now: () => number;
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly revocationListeners = new Set<GatewayPairingRevocationListener>();

  constructor(options: { path?: string; now?: () => number } = {}) {
    this.path = options.path ?? gatewayPairingPath();
    this.now = options.now ?? (() => Date.now());
  }

  /** Subscribe to durable revocations. The returned function is idempotent. */
  subscribeRevocations(listener: GatewayPairingRevocationListener): () => void {
    if (this.revocationListeners.size >= MAX_REVOCATION_LISTENERS) throw new Error("pairing revocation listener limit reached");
    this.revocationListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.revocationListeners.delete(listener);
    };
  }

  /** Alias for callers that use event-emitter terminology. */
  onRevocation(listener: GatewayPairingRevocationListener): () => void { return this.subscribeRevocations(listener); }

  async issue(options: GatewayPairingIssueOptions = {}): Promise<GatewayPairingIssue> {
    const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) throw new Error("pairing ttlMs is out of range");
    const label = boundedString(options.label, "pairing label");
    const audience = canonicalizeGatewayPairingAudience(options.audience ?? GATEWAY_PRIMARY_AUDIENCE);
    const workspaceId = boundedString(options.workspaceId ?? options.workspace, "pairing workspace", 256);
    const provider = boundedString(options.provider, "pairing provider", 128);
    const instance = boundedString(options.instance, "pairing instance", 256);
    const replacesId = boundedString(options.replacesId, "pairing replacesId", 256);
    const generation = options.generation ?? 1;
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("pairing generation is invalid");
    const scopes = normalizedScopes(options.scopes, audience);
    return this.mutate(async () => {
      const document = await this.load();
      if (document.pairings.length >= MAX_PAIRINGS) throw new Error(`pairing limit ${MAX_PAIRINGS} reached`);
      const now = this.now();
      const token = randomBytes(32).toString("base64url");
      const record: GatewayPairingRecord = {
        version: GATEWAY_STATE_VERSION,
        id: `pair-${randomUUID()}`,
        tokenHash: hashToken(token).toString("hex"),
        createdAt: now,
        expiresAt: now + ttlMs,
        scopes,
        audience,
        generation,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(provider === undefined ? {} : { provider }),
        ...(instance === undefined ? {} : { instance }),
        ...(label === undefined ? {} : { label }),
        ...(replacesId === undefined ? {} : { replacesId }),
      };
      let replaced: GatewayPairingRecord | undefined;
      if (replacesId !== undefined) {
        replaced = document.pairings.find((entry) => entry.id === replacesId);
        if (!replaced) throw new Error("pairing replacement target was not found");
        if (replaced.revokedAt !== undefined) throw new Error("pairing replacement target is already revoked");
        replaced.revokedAt = now;
        replaced.replacedById = record.id;
      }
      document.pairings.push(record);
      await this.save(document);
      // Emit only after the replacement and successor are durable together.
      if (replaced !== undefined) this.emitRevocation(revocationEvent(replaced, "replacement", record.id));
      return { ...publicRecord(record), token };
    });
  }

  async list(options: { includeInactive?: boolean } = {}): Promise<GatewayPairingPublicRecord[]> {
    const document = await this.load();
    const now = this.now();
    return document.pairings
      .filter((entry) => options.includeInactive === true || (entry.expiresAt > now && entry.revokedAt === undefined))
      .map(publicRecord);
  }

  async revoke(id: string, options: GatewayPairingRevokeOptions = {}): Promise<boolean> {
    const revokedBy = boundedString(options.revokedBy, "pairing revokedBy", 256);
    const replacementId = boundedString(options.replacementId, "pairing replacementId", 256);
    const reason = boundedString(options.reason, "pairing reason", 256);
    return this.mutate(async () => {
      const document = await this.load();
      const record = document.pairings.find((entry) => entry.id === id);
      if (!record || record.revokedAt !== undefined) return false;
      if (replacementId !== undefined && !document.pairings.some((entry) => entry.id === replacementId)) throw new Error("pairing replacement was not found");
      const revokedAt = this.now();
      record.revokedAt = revokedAt;
      if (revokedBy !== undefined) record.revokedBy = revokedBy;
      if (replacementId !== undefined) record.replacedById = replacementId;
      await this.save(document);
      this.emitRevocation(revocationEvent(record, reason ?? revokedBy ?? "explicit-revoke", replacementId));
      return true;
    });
  }

  /** Revoke all active generations at one durable startup fence. */
  async revokeActiveMatching(options: GatewayPairingMatchRevokeOptions): Promise<GatewayPairingPublicRecord[]> {
    const audience = canonicalizeGatewayPairingAudience(options.audience);
    const provider = boundedString(options.provider, "pairing provider", 128)!;
    const instance = boundedString(options.instance, "pairing instance", 256)!;
    const reason = boundedString(options.reason, "pairing reason", 256)!;
    const revokedBy = boundedString(options.revokedBy, "pairing revokedBy", 256);
    return this.mutate(async () => {
      const document = await this.load();
      const now = this.now();
      const matches = document.pairings.filter((entry) => entry.revokedAt === undefined
        && entry.expiresAt > now
        && entry.audience === audience
        && entry.provider === provider
        && entry.instance === instance);
      if (matches.length === 0) return [];
      for (const record of matches) {
        record.revokedAt = now;
        record.revokedBy = revokedBy ?? reason;
      }
      await this.save(document);
      // All events follow one durable save, so consumers can close every old
      // generation without observing a partially persisted replacement fence.
      for (const record of matches) this.emitRevocation(revocationEvent(record, reason));
      return matches.map(publicRecord);
    });
  }

  /** Explicit name for the OpenAI startup orphan-recovery operation. */
  async revokeOpenAiTunnelPairings(instance: string, reason: string): Promise<GatewayPairingPublicRecord[]> {
    return this.revokeActiveMatching({ audience: "gateway.tunnel", provider: "openai", instance, reason });
  }

  async authenticate(token: string, context: GatewayPairingAuthenticationContext = {}): Promise<GatewayPairingPublicRecord | undefined> {
    if (!token) return undefined;
    const candidate = hashToken(token);
    const now = this.now();
    const expectedAudience = canonicalizeGatewayPairingAudience(context.audience ?? GATEWAY_PRIMARY_AUDIENCE);
    for (const record of (await this.load()).pairings) {
      if (record.expiresAt <= now || record.revokedAt !== undefined) continue;
      const stored = Buffer.from(record.tokenHash, "hex");
      if (stored.byteLength !== candidate.byteLength || !timingSafeEqual(stored, candidate)) continue;
      if (record.audience !== expectedAudience) return undefined;
      if (context.workspaceId !== undefined && record.workspaceId !== context.workspaceId) return undefined;
      if (context.provider !== undefined && record.provider !== context.provider) return undefined;
      if (context.instance !== undefined && record.instance !== context.instance) return undefined;
      if (context.generation !== undefined && record.generation !== context.generation) return undefined;
      return publicRecord(record);
    }
    return undefined;
  }

  private async load(): Promise<PairingDocument> {
    const raw = await readGatewayJson<unknown>(this.path, MAX_PAIRING_BYTES);
    if (raw === undefined) return { version: GATEWAY_STATE_VERSION, pairings: [] };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid Gateway pairing store");
    const value = raw as { version?: unknown; pairings?: unknown };
    if (value.version !== GATEWAY_STATE_VERSION || !Array.isArray(value.pairings) || value.pairings.length > MAX_PAIRINGS) throw new Error("Invalid Gateway pairing store");
    const pairings = value.pairings.map((item): GatewayPairingRecord => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid Gateway pairing record");
      const entry = item as Record<string, unknown>;
      if (entry.version !== GATEWAY_STATE_VERSION || typeof entry.id !== "string" || typeof entry.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(entry.tokenHash) || !Number.isSafeInteger(entry.createdAt) || !Number.isSafeInteger(entry.expiresAt)) throw new Error("Invalid Gateway pairing record");
      const audience = canonicalizeGatewayPairingAudience(entry.audience ?? GATEWAY_PRIMARY_AUDIENCE);
      const scopes = normalizedScopes(Array.isArray(entry.scopes) ? entry.scopes as string[] : undefined, audience);
      const generation = entry.generation ?? 1;
      if (!Number.isSafeInteger(generation) || (generation as number) < 1) throw new Error("Invalid Gateway pairing record");
      const normalized: GatewayPairingRecord = {
        version: GATEWAY_STATE_VERSION,
        id: entry.id,
        tokenHash: entry.tokenHash,
        createdAt: entry.createdAt as number,
        expiresAt: entry.expiresAt as number,
        scopes,
        audience,
        generation: generation as number,
      };
      for (const key of ["workspaceId", "provider", "instance", "label", "replacesId", "replacedById", "revokedBy"] as const) {
        const result = boundedString(entry[key], `pairing ${key}`, key === "workspaceId" || key === "instance" || key === "revokedBy" ? 256 : 128);
        if (result !== undefined) normalized[key] = result;
      }
      if (entry.revokedAt !== undefined) {
        if (!Number.isSafeInteger(entry.revokedAt) || (entry.revokedAt as number) < 0) throw new Error("Invalid Gateway pairing record");
        normalized.revokedAt = entry.revokedAt as number;
      }
      return normalized;
    });
    return { version: GATEWAY_STATE_VERSION, pairings };
  }

  private emitRevocation(event: GatewayPairingRevocationEvent): void {
    for (const listener of [...this.revocationListeners]) {
      try {
        const result = listener(structuredClone(event));
        if (result !== undefined) void Promise.resolve(result).catch(() => undefined);
      } catch {
        // Revocation is already durable; one observer must not block others.
      }
    }
  }

  private async save(document: PairingDocument): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeGatewayJsonAtomic(this.path, document, { mode: 0o600, maximumBytes: MAX_PAIRING_BYTES });
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.mutationTail;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

function revocationEvent(record: GatewayPairingRecord, reason: string, replacementId?: string): GatewayPairingRevocationEvent {
  return {
    id: record.id,
    pairingId: record.id,
    record: publicRecord(record),
    revokedAt: record.revokedAt ?? Date.now(),
    reason,
    ...(replacementId === undefined ? {} : { replacementId }),
  };
}
