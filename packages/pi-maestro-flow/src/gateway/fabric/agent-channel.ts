import { randomUUID } from "node:crypto";
import {
  FABRIC_AGENT_ATTEMPT_VERSION,
  assertFabricAgentEvent,
  type FabricAgentControlReceiptV1,
  type FabricAgentEventPageV1,
  type FabricAgentRecoveryReceiptV1,
  type FabricAgentReclamationReceiptV1,
  type FabricAgentSendRequestV1,
  type FabricAgentStartAckV1,
  type FabricAgentStartRequestV1,
  type FabricBackendPrepareRequest,
  type FabricBackendRouteResolver,
  type PreparedFabricBackendChannel,
} from "pi-maestro-backends/fabric";
import {
  FabricContractError,
  type AgentRuntimeEndpoint,
  type EndpointRecord,
  type EndpointRouteHandle,
  type FabricPlacementEventV1,
  type JsonValue,
} from "pi-maestro-fabric-core/v1";
import type { FabricHttpsDispatchInput } from "./https-transport.ts";
import type { FabricHttpsTransport } from "./https-transport.ts";
import { registerFabricRouteResolverProvider } from "pi-maestro-teammate/v1/fabric-runtime";

/**
 * The admitted route and Endpoint records this host already holds.
 *
 * The resolver never infers them from config: a route the host has not admitted
 * is not a target, and reading one here would let a stale id select an Endpoint
 * the host never opened.
 */
export interface FabricAgentChannelAuthority {
  routeOf(routeId: string): EndpointRouteHandle;
  endpointOf(endpointId: string): EndpointRecord | undefined;
}

/** The paired Gateway transport, narrowed to what an agent route needs. */
export interface FabricAgentChannelTransport {
  dispatch(input: FabricHttpsDispatchInput, signal: AbortSignal): Promise<JsonValue>;
}

export interface FabricAgentRouteResolverOptions {
  readonly transport: FabricAgentChannelTransport;
  readonly authority: FabricAgentChannelAuthority;
  readonly now?: () => number;
  /** Bounded pause between event reads; the pump stops when the route closes. */
  readonly pollIntervalMs?: number;
  readonly maxEventBatch?: number;
}

function positive(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new FabricContractError("invalid_argument", `${label} must be a positive safe integer`, label);
  }
  return result;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One origin-side Agent channel over the paired Fabric HTTPS data plane.
 *
 * The channel owns no attempt lifecycle: it forwards the placements's own
 * operations and the Endpoint's events, and the teammate host remains the
 * dispatch, recovery, reclamation, and publication authority.
 */
class FabricAgentChannel implements PreparedFabricBackendChannel {
  readonly route: EndpointRouteHandle;
  readonly endpoint: AgentRuntimeEndpoint;
  readonly #options: FabricAgentRouteResolverOptions;
  readonly #now: () => number;
  readonly #pollIntervalMs: number;
  readonly #maxEventBatch: number;
  readonly #listeners = new Set<(event: FabricPlacementEventV1) => void>();
  #afterSequence = 0;
  #attemptId?: string;
  #attemptDeadlineAt?: number;
  #placementId?: string;
  #pump?: Promise<void>;
  #pumpController?: AbortController;
  #terminal = false;
  #closed = false;
  #failure?: string;
  #settle?: (result: { status: "completed" | "transport-lost"; reason?: string }) => void;

  constructor(
    options: FabricAgentRouteResolverOptions,
    route: EndpointRouteHandle,
    endpoint: AgentRuntimeEndpoint,
  ) {
    this.#options = options;
    this.route = route;
    this.endpoint = endpoint;
    this.#now = options.now ?? Date.now;
    this.#pollIntervalMs = positive(options.pollIntervalMs, 250, "pollIntervalMs");
    this.#maxEventBatch = positive(options.maxEventBatch, 128, "maxEventBatch");
  }

  subscribe(listener: (event: FabricPlacementEventV1) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  async start(request: FabricAgentStartRequestV1, signal: AbortSignal): Promise<FabricAgentStartAckV1> {
    this.#attemptId = request.attemptId;
    this.#attemptDeadlineAt = request.placement.deadlineAt;
    this.#placementId = request.placement.placementId;
    try {
      const ack = await this.#dispatch(request.attemptId, "agent.start", request as unknown as Record<string, JsonValue>, signal);
      return ack as unknown as FabricAgentStartAckV1;
    } finally {
      // The Endpoint retains attempt events, so starting the pump after the
      // unary ACK settles cannot lose output and also covers an uncertain ACK.
      this.#startPump();
    }
  }

  async wait(signal: AbortSignal): Promise<{ status: "completed" | "transport-lost"; reason?: string }> {
    if (this.#failure !== undefined) return { status: "transport-lost", reason: this.#failure };
    if (this.#terminal) return { status: "completed" };
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: { status: "completed" | "transport-lost"; reason?: string }): void => {
        if (settled) return;
        settled = true;
        this.#settle = undefined;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = (): void => finish({ status: "transport-lost", reason: "the caller aborted the Fabric agent channel" });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      this.#settle = finish;
    });
  }

  async send(request: FabricAgentSendRequestV1, signal: AbortSignal): Promise<FabricAgentControlReceiptV1> {
    return await this.#dispatch(
      request.attemptId,
      "agent.send",
      request as unknown as Record<string, JsonValue>,
      signal,
    ) as unknown as FabricAgentControlReceiptV1;
  }

  async abort(attemptId: string, placementId: string, signal: AbortSignal): Promise<FabricAgentControlReceiptV1> {
    return await this.#dispatch(
      attemptId,
      "agent.abort",
      { version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId, placementId },
      signal,
    ) as unknown as FabricAgentControlReceiptV1;
  }

  async recover(attemptId: string, placementId: string, signal: AbortSignal): Promise<FabricAgentRecoveryReceiptV1> {
    return await this.#dispatch(
      attemptId,
      "agent.recover",
      { version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId, placementId },
      signal,
    ) as unknown as FabricAgentRecoveryReceiptV1;
  }

  async reclaim(attemptId: string, placementId: string, signal: AbortSignal): Promise<FabricAgentReclamationReceiptV1> {
    return await this.#dispatch(
      attemptId,
      "agent.reclaim",
      { version: FABRIC_AGENT_ATTEMPT_VERSION, attemptId, placementId },
      signal,
    ) as unknown as FabricAgentReclamationReceiptV1;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#pumpController?.abort(new FabricContractError("cancelled", "Fabric agent channel closed"));
    await this.#pump?.catch(() => undefined);
    this.#listeners.clear();
  }

  async #dispatch(
    attemptId: string,
    operation: string,
    input: Record<string, JsonValue>,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    if (this.#closed) throw new FabricContractError("invalid_state", "Fabric agent channel is closed");
    if (this.#failure !== undefined) throw new FabricContractError("unavailable", this.#failure);
    return await this.#options.transport.dispatch({
      routeId: this.route.routeId,
      endpointId: this.endpoint.endpointId,
      endpointKind: "agent",
      endpointGeneration: this.endpoint.generation,
      deadlineAt: Math.min(this.route.expiresAt, this.#attemptDeadlineAt ?? this.route.expiresAt, this.#now() + 60_000),
      operation,
      input,
      operationId: randomUUID(),
    }, signal);
  }

  #startPump(): void {
    if (this.#pump !== undefined || this.#closed) return;
    const controller = new AbortController();
    this.#pumpController = controller;
    this.#pump = (async () => {
      while (!controller.signal.aborted && !this.#terminal) {
        try {
          if (this.#attemptId === undefined || this.#placementId === undefined) return;
          const priorSequence = this.#afterSequence;
          const page = await this.#dispatch(
            this.#attemptId,
            "agent.events",
            {
              version: FABRIC_AGENT_ATTEMPT_VERSION,
              attemptId: this.#attemptId,
              placementId: this.#placementId,
              afterSequence: priorSequence,
              limit: this.#maxEventBatch,
            },
            controller.signal,
          ) as unknown as FabricAgentEventPageV1;
          if (!Array.isArray(page.events) || !Number.isSafeInteger(page.nextSequence) || page.nextSequence < priorSequence) {
            throw new FabricContractError("protocol_violation", "Fabric Agent event page is invalid", "events");
          }
          let nextSequence = priorSequence;
          for (const candidate of page.events) {
            assertFabricAgentEvent(candidate, this.#placementId);
            if (candidate.sequence <= nextSequence) {
              throw new FabricContractError("protocol_violation", "Fabric Agent event sequence is not increasing", "sequence");
            }
            nextSequence = candidate.sequence;
            this.#afterSequence = candidate.sequence;
            for (const listener of this.#listeners) listener(candidate);
            if (candidate.kind === "completion" || candidate.kind === "error") {
              this.#terminal = true;
              this.#settle?.({ status: "completed" });
              break;
            }
          }
          if (!this.#terminal && page.nextSequence !== nextSequence) {
            throw new FabricContractError("protocol_violation", "Fabric Agent event cursor is invalid", "nextSequence");
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          this.#failure = `Fabric agent event stream failed: ${message(error)}`;
          this.#settle?.({ status: "transport-lost", reason: this.#failure });
          return;
        }
        if (this.#terminal || controller.signal.aborted) return;
        // Deliberately not unref'd: a caller awaiting `wait()` has nothing else
        // keeping the loop alive, and the pump stops on terminal, failure, or
        // close, so the timer cannot outlive the operation.
        await new Promise((resolve) => {
          setTimeout(resolve, this.#pollIntervalMs);
        });
      }
    })();
  }
}

/** Origin-side resolver: prepares exactly the route the placement names. */
export class FabricAgentRouteResolver implements FabricBackendRouteResolver {
  readonly #options: FabricAgentRouteResolverOptions;

  constructor(options: FabricAgentRouteResolverOptions) {
    this.#options = options;
  }

  async prepare(request: FabricBackendPrepareRequest, signal: AbortSignal): Promise<PreparedFabricBackendChannel> {
    if (signal.aborted) throw new FabricContractError("cancelled", "Fabric route preparation was cancelled");
    const route = this.#options.authority.routeOf(request.placement.routeId);
    const endpoint = this.#options.authority.endpointOf(request.placement.endpointId);
    if (endpoint === undefined) {
      throw new FabricContractError("not_found", "Fabric Agent Endpoint is not known to this host", "endpointId");
    }
    if (endpoint.kind !== "agent") {
      throw new FabricContractError("conflict", "Fabric placement requires an Agent Endpoint", "endpointId");
    }
    return new FabricAgentChannel(this.#options, route, endpoint);
  }
}

/**
 * Compile-time proof that the paired HTTPS transport satisfies this seam as
 * written: a signature change there must fail here rather than at a call site.
 */
type TransportSatisfiesAgentChannelSeam = FabricHttpsTransport extends FabricAgentChannelTransport ? true : never;
const _transportSatisfiesSeam: TransportSatisfiesAgentChannelSeam = true;
void _transportSatisfiesSeam;

/**
 * Install this host's Fabric route resolver for the teammate dispatch surface.
 *
 * Flow owns the paired connection and the admitted-route authority, so it
 * installs the resolver once a Fabric connection is live and disposes it when
 * that connection closes. Until then a placed dispatch has no provider, which
 * the teammate host reports as an unloadable registration rather than running
 * the task locally.
 *
 * @param options - the paired transport and this host's admitted-route authority.
 * @returns a disposer that removes the resolver; it is idempotent.
 */
export function registerFabricAgentRouteResolver(
  options: FabricAgentRouteResolverOptions,
): () => void {
  const resolver = new FabricAgentRouteResolver(options);
  return registerFabricRouteResolverProvider(() => resolver);
}
