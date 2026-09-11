/** Delivers committed Fabric outbox events to the existing in-memory Gateway journal. */
import { FABRIC_STORE_KINDS, type FabricStoreEventV1 } from "pi-maestro-fabric-core/v1";
import type { GatewayEventAppendInput } from "../event-journal.ts";
import { GatewayEventJournal } from "../event-journal.ts";
import { GATEWAY_FABRIC_OUTBOX_CONSUMER_ID, GatewayFabricStore } from "./store.ts";

export interface GatewayFabricEventAdapterOptions {
  store: GatewayFabricStore;
  journal: GatewayEventJournal;
  consumerId?: string;
  project?: (event: FabricStoreEventV1) => GatewayEventAppendInput;
  /** Test-only delivery-boundary seam. */
  fault?: (point: "before-append" | "after-append" | "before-ack" | "after-ack", event: FabricStoreEventV1) => void | Promise<void>;
}

export class GatewayFabricEventAdapter {
  readonly store: GatewayFabricStore;
  readonly journal: GatewayEventJournal;
  readonly consumerId: string;
  private readonly project: (event: FabricStoreEventV1) => GatewayEventAppendInput;
  private readonly fault?: GatewayFabricEventAdapterOptions["fault"];

  constructor(options: GatewayFabricEventAdapterOptions) {
    this.store = options.store;
    this.journal = options.journal;
    this.consumerId = options.consumerId ?? GATEWAY_FABRIC_OUTBOX_CONSUMER_ID;
    if (this.consumerId !== GATEWAY_FABRIC_OUTBOX_CONSUMER_ID) throw new Error("Fabric outbox supports only the Gateway journal delivery consumer");
    this.project = options.project ?? projectFabricEvent;
    this.fault = options.fault;
  }

  async replayRetained(limitPerStore = Math.min(256, this.store.maxEventsPerStore)): Promise<number> {
    if (!Number.isSafeInteger(limitPerStore) || limitPerStore < 1 || limitPerStore > this.store.maxEventsPerStore) throw new Error("Fabric replay limit is invalid");
    let replayed = 0;
    for (const storeKind of FABRIC_STORE_KINDS) {
      let afterSequence = 0;
      while (true) {
        const page = await this.store.pageEvents(storeKind, afterSequence, limitPerStore);
        if (page.gap) afterSequence = page.gap.resumeSequence;
        for (const event of page.events) {
          const projected = this.project(event);
          if (this.journal.watermark(projected.handle) < event.sequence) {
            await this.append(projected, event);
            replayed += 1;
          }
          afterSequence = event.sequence;
        }
        if (page.events.length < limitPerStore) break;
      }
    }
    return replayed;
  }

  async deliverPending(limit = Math.min(256, this.store.maxOutboxEvents)): Promise<number> {
    const events = await this.store.pendingOutbox(limit);
    let delivered = 0;
    for (const event of events) {
      const projected = this.project(event);
      if (this.journal.watermark(projected.handle) < event.sequence) await this.append(projected, event);
      await this.fault?.("before-ack", event);
      await this.store.acknowledgeOutbox(event.eventId, this.consumerId);
      await this.fault?.("after-ack", event);
      delivered += 1;
    }
    return delivered;
  }

  private async append(projected: GatewayEventAppendInput, event: FabricStoreEventV1): Promise<void> {
    await this.fault?.("before-append", event);
    this.journal.append(projected);
    await this.fault?.("after-append", event);
  }
}

export function projectFabricEvent(event: FabricStoreEventV1): GatewayEventAppendInput {
  return {
    eventId: event.eventId,
    cursor: event.sequence,
    workspaceId: "fabric",
    sessionId: "fabric",
    handle: `fabric:${event.storeKind}`,
    kind: "state",
    payload: {
      storeKind: event.storeKind,
      eventKind: event.eventKind,
      subjectId: event.subjectId,
      subjectRevision: event.subjectRevision,
      payload: event.payload,
    },
    at: event.occurredAt,
  };
}
