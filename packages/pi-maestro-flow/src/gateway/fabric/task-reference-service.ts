/** Read-only, authority-qualified task snapshot boundary for Fabric placement. */
import {
  assertValidQualifiedTaskReference,
  validateWorkspaceTodoSnapshot,
  type FabricTaskAuthority,
  type QualifiedTaskReferenceV1,
  type QualifiedTaskSnapshotV1,
} from "pi-maestro-fabric-core/v1";

export const GATEWAY_FABRIC_TASK_SNAPSHOT_VERSION = "fabric.task-snapshot.v1" as const;
export const GATEWAY_FABRIC_TASK_SNAPSHOT_MAX_ITEMS = 100;
export const GATEWAY_FABRIC_TASK_SNAPSHOT_MAX_BYTES = 64 * 1024;

export interface GatewayFabricTaskReferenceSource {
  readonly authority: FabricTaskAuthority;
  read(workspaceId: string, taskId: string): Promise<unknown>;
}

export interface GatewayFabricTaskSnapshotPageV1 {
  readonly version: typeof GATEWAY_FABRIC_TASK_SNAPSHOT_VERSION;
  readonly revision: number;
  readonly capturedAt: number;
  readonly truncated: boolean;
  readonly items: readonly QualifiedTaskSnapshotV1[];
}

export interface GatewayFabricTaskReferenceServiceOptions {
  sources: readonly GatewayFabricTaskReferenceSource[];
  now?: () => number;
  maxItems?: number;
  maxBytes?: number;
}

export function qualifiedTaskReferenceKey(reference: QualifiedTaskReferenceV1): string {
  assertValidQualifiedTaskReference(reference);
  return `${reference.authority}\0${reference.workspaceId}\0${reference.taskId}`;
}

function sameReference(left: QualifiedTaskReferenceV1, right: QualifiedTaskReferenceV1): boolean {
  return left.authority === right.authority && left.workspaceId === right.workspaceId && left.taskId === right.taskId;
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export class GatewayFabricTaskReferenceService {
  private readonly sources = new Map<FabricTaskAuthority, GatewayFabricTaskReferenceSource>();
  private readonly now: () => number;
  private readonly maxItems: number;
  private readonly maxBytes: number;
  private revision = 0;
  private signature = "";

  constructor(options: GatewayFabricTaskReferenceServiceOptions) {
    this.now = options.now ?? Date.now;
    this.maxItems = options.maxItems ?? GATEWAY_FABRIC_TASK_SNAPSHOT_MAX_ITEMS;
    this.maxBytes = options.maxBytes ?? GATEWAY_FABRIC_TASK_SNAPSHOT_MAX_BYTES;
    if (!Number.isSafeInteger(this.maxItems) || this.maxItems < 1 || this.maxItems > GATEWAY_FABRIC_TASK_SNAPSHOT_MAX_ITEMS) {
      throw new Error(`Fabric task snapshot maxItems must be in [1, ${GATEWAY_FABRIC_TASK_SNAPSHOT_MAX_ITEMS}]`);
    }
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > GATEWAY_FABRIC_TASK_SNAPSHOT_MAX_BYTES) {
      throw new Error(`Fabric task snapshot maxBytes must be in [1, ${GATEWAY_FABRIC_TASK_SNAPSHOT_MAX_BYTES}]`);
    }
    for (const source of options.sources) {
      if (this.sources.has(source.authority)) throw new Error(`Duplicate Fabric task authority source: ${source.authority}`);
      this.sources.set(source.authority, source);
    }
  }

  async snapshot(reference: QualifiedTaskReferenceV1): Promise<QualifiedTaskSnapshotV1 | undefined> {
    assertValidQualifiedTaskReference(reference);
    const source = this.sources.get(reference.authority);
    if (!source) return undefined;
    const raw = await source.read(reference.workspaceId, reference.taskId);
    if (raw === undefined) return undefined;
    const snapshot = validateWorkspaceTodoSnapshot(raw);
    if (!sameReference(snapshot.reference, reference)) {
      throw new Error("Fabric task source returned a snapshot for a different qualified reference");
    }
    return structuredClone(snapshot);
  }

  async snapshotMany(references: readonly QualifiedTaskReferenceV1[]): Promise<GatewayFabricTaskSnapshotPageV1> {
    const capturedAt = this.now();
    const unique = new Map<string, QualifiedTaskReferenceV1>();
    let truncated = false;
    for (const reference of references) {
      const key = qualifiedTaskReferenceKey(reference);
      if (unique.has(key)) continue;
      if (unique.size >= this.maxItems) {
        truncated = true;
        break;
      }
      unique.set(key, reference);
    }
    const items: QualifiedTaskSnapshotV1[] = [];
    for (const reference of unique.values()) {
      const snapshot = await this.snapshot(reference);
      if (!snapshot) continue;
      items.push(snapshot);
      const probe = { version: GATEWAY_FABRIC_TASK_SNAPSHOT_VERSION, revision: Number.MAX_SAFE_INTEGER, capturedAt, truncated, items };
      if (bytes(probe) > this.maxBytes) {
        items.pop();
        truncated = true;
        break;
      }
    }
    const signature = JSON.stringify({ truncated, items });
    if (signature !== this.signature) {
      this.signature = signature;
      this.revision += 1;
    }
    const page: GatewayFabricTaskSnapshotPageV1 = {
      version: GATEWAY_FABRIC_TASK_SNAPSHOT_VERSION,
      revision: this.revision,
      capturedAt,
      truncated,
      items,
    };
    if (bytes(page) > this.maxBytes) throw new Error("Fabric task snapshot exceeds its byte budget");
    return structuredClone(page);
  }
}
