import {
  FABRIC_ERROR_MESSAGE_MAX_BYTES,
  FabricContractError,
  assertBoundedString,
  assertEpochMilliseconds,
  assertFabricIdentifier,
  assertValidFabricStreamFrame,
  utf8ByteLength,
  type FabricCancellationSignal,
  type FabricStreamChannel,
  type FabricStreamFrameV1,
} from "pi-maestro-fabric-core/v1";
import type { FabricAdmissionManager } from "./admission-manager.ts";

export interface FabricStreamChannelLimits {
  maxFrameBytes: number;
  maxBufferedFrames: number;
  maxResultBytes: number;
}

export interface FabricStreamChannelIo {
  send(frame: FabricStreamFrameV1): Promise<void>;
  close(reason: string): Promise<void>;
}

export interface RouteBoundFabricStreamChannelOptions {
  streamId: string;
  routeId: string;
  operationId: string;
  deadlineAt: number;
  limits: FabricStreamChannelLimits;
  io: FabricStreamChannelIo;
  now?: () => number;
}

export type FabricRouteValidator = Pick<FabricAdmissionManager, "validateRoute">;

type PendingReceive = {
  resolve(frame: FabricStreamFrameV1 | undefined): void;
  reject(error: FabricContractError): void;
};

type ObservableCancellationSignal = FabricCancellationSignal & {
  addEventListener?(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener?(type: "abort", listener: () => void): void;
};

const RESULT_FRAME_KINDS = new Set<FabricStreamFrameV1["kind"]>(["data", "end", "error"]);
const FULL_TERMINAL_FRAME_KINDS = new Set<FabricStreamFrameV1["kind"]>(["cancel", "error"]);

function assertPositiveLimit(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new FabricContractError("invalid_argument", `${path} must be a positive safe integer`, path);
  }
}

function frameByteLength(frame: FabricStreamFrameV1): number {
  return utf8ByteLength(JSON.stringify(frame));
}

function resultByteLength(frame: FabricStreamFrameV1): number {
  return RESULT_FRAME_KINDS.has(frame.kind) ? utf8ByteLength(JSON.stringify(frame.payload)) : 0;
}

function cancellationError(): FabricContractError {
  return new FabricContractError("cancelled", "Fabric stream operation was cancelled");
}

/**
 * A transport-neutral, route-bound Fabric stream. Transports inject writes and
 * feed received frames through accept(); this class owns validation and bounds.
 */
export class RouteBoundFabricStreamChannel implements FabricStreamChannel {
  readonly streamId: string;
  readonly routeId: string;
  readonly operationId: string;
  readonly deadlineAt: number;
  readonly limits: Readonly<FabricStreamChannelLimits>;

  readonly #admissions: FabricRouteValidator;
  readonly #io: FabricStreamChannelIo;
  readonly #now: () => number;
  readonly #inbound: FabricStreamFrameV1[] = [];
  readonly #receivers: PendingReceive[] = [];
  #lastInboundSequence = -1;
  #lastOutboundSequence = -1;
  #inboundResultBytes = 0;
  #outboundResultBytes = 0;
  #pendingOutbound = 0;
  #sendTail: Promise<void> = Promise.resolve();
  #inboundEnded = false;
  #outboundEnded = false;
  #closed = false;
  #failure: FabricContractError | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(admissions: FabricRouteValidator, options: RouteBoundFabricStreamChannelOptions) {
    assertFabricIdentifier(options.streamId, "streamId");
    assertFabricIdentifier(options.routeId, "routeId");
    assertFabricIdentifier(options.operationId, "operationId");
    assertEpochMilliseconds(options.deadlineAt, "deadlineAt");
    assertPositiveLimit(options.limits.maxFrameBytes, "maxFrameBytes");
    assertPositiveLimit(options.limits.maxBufferedFrames, "maxBufferedFrames");
    assertPositiveLimit(options.limits.maxResultBytes, "maxResultBytes");

    this.streamId = options.streamId;
    this.routeId = options.routeId;
    this.operationId = options.operationId;
    this.deadlineAt = options.deadlineAt;
    this.limits = Object.freeze({ ...options.limits });
    this.#admissions = admissions;
    this.#io = options.io;
    this.#now = options.now ?? Date.now;
    this.#assertDeadline();
    this.#validateRoute();
  }

  send(frame: FabricStreamFrameV1, signal: FabricCancellationSignal): Promise<void> {
    try {
      this.#assertActive();
      this.#assertNotCancelled(signal);
      this.#assertDeadline();
      this.#validateRoute();
      if (this.#outboundEnded) {
        throw new FabricContractError("invalid_state", "Fabric stream outbound direction is terminal", "kind");
      }
      const resultBytes = this.#validateFrame(frame, this.#lastOutboundSequence, this.#outboundResultBytes);
      if (this.#pendingOutbound >= this.limits.maxBufferedFrames) {
        throw new FabricContractError("resource_exhausted", "Fabric stream outbound queue is full", "maxBufferedFrames");
      }

      this.#lastOutboundSequence = frame.sequence;
      this.#outboundResultBytes = resultBytes;
      this.#pendingOutbound += 1;
      if (frame.kind === "end" || FULL_TERMINAL_FRAME_KINDS.has(frame.kind)) this.#outboundEnded = true;
      if (FULL_TERMINAL_FRAME_KINDS.has(frame.kind)) {
        this.#inboundEnded = true;
        for (const receiver of this.#receivers.splice(0)) receiver.resolve(undefined);
      }

      const write = this.#sendTail.then(async () => {
        this.#assertActive();
        this.#assertDeadline();
        this.#validateRoute();
        await this.#io.send(frame);
        this.#assertActive();
        this.#assertDeadline();
        this.#validateRoute();
      });
      this.#sendTail = write.catch(() => undefined);
      const bounded = this.#withBounds(write, signal);
      return bounded.catch((error: unknown) => {
        const normalized = this.#normalizeError(error, "Fabric stream send failed");
        this.#fail(normalized);
        throw normalized;
      }).finally(() => {
        this.#pendingOutbound -= 1;
      });
    } catch (error) {
      const normalized = this.#normalizeError(error, "Fabric stream send failed");
      this.#fail(normalized);
      return Promise.reject(normalized);
    }
  }

  receive(signal: FabricCancellationSignal): Promise<FabricStreamFrameV1 | undefined> {
    try {
      if (this.#failure !== undefined) throw this.#failure;
      if (this.#closed && this.#inbound.length === 0) return Promise.resolve(undefined);
      this.#assertNotCancelled(signal);
      this.#assertDeadline();
      this.#validateRoute();
      const available = this.#inbound.shift();
      if (available !== undefined) {
        this.#validateRoute();
        return Promise.resolve(available);
      }
      if (this.#inboundEnded || this.#closed) return Promise.resolve(undefined);

      let waiter!: PendingReceive;
      const pending = new Promise<FabricStreamFrameV1 | undefined>((resolve, reject) => {
        waiter = { resolve, reject };
        this.#receivers.push(waiter);
      });
      return this.#withBounds(pending, signal).then((frame) => {
        if (frame !== undefined) {
          this.#assertActive();
          this.#validateRoute();
        }
        return frame;
      }).catch((error: unknown) => {
        const normalized = this.#normalizeError(error, "Fabric stream receive failed");
        this.#fail(normalized);
        throw normalized;
      }).finally(() => {
        const index = this.#receivers.indexOf(waiter);
        if (index >= 0) this.#receivers.splice(index, 1);
      });
    } catch (error) {
      const normalized = this.#normalizeError(error, "Fabric stream receive failed");
      this.#fail(normalized);
      return Promise.reject(normalized);
    }
  }

  /** Accept one frame received by the injected transport. */
  accept(frame: FabricStreamFrameV1): void {
    try {
      this.#assertActive();
      this.#assertDeadline();
      this.#validateRoute();
      if (this.#inboundEnded) {
        throw new FabricContractError("invalid_state", "Fabric stream inbound direction is terminal", "kind");
      }
      const resultBytes = this.#validateFrame(frame, this.#lastInboundSequence, this.#inboundResultBytes);
      if (this.#receivers.length === 0 && this.#inbound.length >= this.limits.maxBufferedFrames) {
        throw new FabricContractError("resource_exhausted", "Fabric stream inbound queue is full", "maxBufferedFrames");
      }

      this.#lastInboundSequence = frame.sequence;
      this.#inboundResultBytes = resultBytes;
      if (frame.kind === "end" || FULL_TERMINAL_FRAME_KINDS.has(frame.kind)) this.#inboundEnded = true;
      if (FULL_TERMINAL_FRAME_KINDS.has(frame.kind)) this.#outboundEnded = true;

      const receiver = this.#receivers.shift();
      if (receiver === undefined) this.#inbound.push(frame);
      else receiver.resolve(frame);

      if (this.#inboundEnded) {
        for (const pending of this.#receivers.splice(0)) pending.resolve(undefined);
      }
    } catch (error) {
      const normalized = this.#normalizeError(error, "Fabric stream received an invalid frame");
      this.#fail(normalized);
      throw normalized;
    }
  }

  close(reason: string): Promise<void> {
    try {
      assertBoundedString(reason, "reason", FABRIC_ERROR_MESSAGE_MAX_BYTES);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#inbound.length = 0;
    for (const receiver of this.#receivers.splice(0)) receiver.resolve(undefined);
    // Fence new sends first, then wait for every send already admitted before
    // closing the transport. This is the transport-neutral ordering contract:
    // close() cannot complete while a captured send can still deliver a frame.
    const capturedSendTail = this.#sendTail;
    this.#closePromise = capturedSendTail.catch(() => undefined).then(() => this.#io.close(reason)).catch(() => {
      throw new FabricContractError("unavailable", "Fabric stream transport close failed");
    });
    return this.#closePromise;
  }

  #validateFrame(frame: FabricStreamFrameV1, previousSequence: number, currentResultBytes: number): number {
    assertValidFabricStreamFrame(frame);
    if (frame.streamId !== this.streamId || frame.routeId !== this.routeId || frame.operationId !== this.operationId) {
      throw new FabricContractError("conflict", "Fabric stream frame correlation does not match the channel", "streamFrame");
    }
    if (frame.sequence <= previousSequence) {
      throw new FabricContractError("protocol_violation", "Fabric stream sequence must increase monotonically", "sequence");
    }
    if (frameByteLength(frame) > this.limits.maxFrameBytes) {
      throw new FabricContractError("resource_exhausted", "Fabric stream frame exceeds maxFrameBytes", "maxFrameBytes");
    }
    const nextResultBytes = currentResultBytes + resultByteLength(frame);
    if (nextResultBytes > this.limits.maxResultBytes) {
      throw new FabricContractError("resource_exhausted", "Fabric stream result exceeds maxResultBytes", "maxResultBytes");
    }
    return nextResultBytes;
  }

  #validateRoute(): void {
    this.#admissions.validateRoute(this.routeId);
  }

  #assertDeadline(): void {
    if (this.#now() >= this.deadlineAt) {
      throw new FabricContractError("deadline_exceeded", "Fabric stream deadline has passed", "deadlineAt");
    }
  }

  #assertNotCancelled(signal: FabricCancellationSignal): void {
    if (signal.aborted) throw cancellationError();
  }

  #assertActive(): void {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#closed) throw new FabricContractError("invalid_state", "Fabric stream channel is closed");
  }

  #withBounds<T>(operation: Promise<T>, inputSignal: FabricCancellationSignal): Promise<T> {
    const signal = inputSignal as ObservableCancellationSignal;
    const remaining = this.deadlineAt - this.#now();
    if (remaining <= 0) return Promise.reject(new FabricContractError("deadline_exceeded", "Fabric stream deadline has passed", "deadlineAt"));
    if (signal.aborted) return Promise.reject(cancellationError());

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener?.("abort", onAbort);
        action();
      };
      const onAbort = (): void => finish(() => reject(cancellationError()));
      const timer = setTimeout(() => finish(() => reject(
        new FabricContractError("deadline_exceeded", "Fabric stream deadline has passed", "deadlineAt"),
      )), remaining);
      timer.unref?.();
      signal.addEventListener?.("abort", onAbort, { once: true });
      operation.then(
        (value) => finish(() => signal.aborted ? reject(cancellationError()) : resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  #normalizeError(error: unknown, fallback: string): FabricContractError {
    return error instanceof FabricContractError ? error : new FabricContractError("unavailable", fallback);
  }

  #fail(error: FabricContractError): void {
    if (this.#failure !== undefined || this.#closed) return;
    this.#failure = error;
    this.#closed = true;
    this.#inbound.length = 0;
    for (const receiver of this.#receivers.splice(0)) receiver.reject(error);
    void this.close(`Fabric stream failed: ${error.code}`).catch(() => undefined);
  }
}
