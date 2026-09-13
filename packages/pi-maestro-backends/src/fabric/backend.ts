import type {
  AttemptOutcome,
  BackendCapabilities,
  BackendRun,
  BackendRunOptions,
  TeammateBackend,
} from "pi-maestro-backend-core/v1/backend";
import type {
  ControlMode,
  SingleResult,
  TeammateRunSpec,
} from "pi-maestro-backend-core/v1/spec";
import {
  FabricContractError,
  assertValidTeammatePlacement,
  type FabricPlacementEventV1,
} from "pi-maestro-fabric-core/v1";
import { validateBackendCapabilities } from "../capabilities.ts";
import {
  FABRIC_AGENT_ATTEMPT_VERSION,
  assertFabricAgentControlReceipt,
  assertFabricAgentEvent,
  assertFabricAgentRecoveryReceipt,
  assertFabricAgentReclamationReceipt,
  assertFabricAgentStartAck,
  assertPreparedFabricChannel,
  fabricStartRequest,
  type FabricAgentRunSpecV1,
  type FabricBackendChannelWaitResult,
  type FabricBackendRouteResolver,
  type FabricBackendRouteResolverLease,
  type FabricBackendRouteResolverSource,
  type PreparedFabricBackendChannel,
} from "./channel.ts";
import { fabricTurnResult, foldFabricOutcome } from "./outcome.ts";

const CAPABILITIES: BackendCapabilities = Object.freeze({
  outputSchema: "native",
  forkContext: "unsupported",
  modelSelection: "native",
  thinkingLevel: "native",
  todoBinding: "unsupported",
  toolFilter: "unsupported",
  steer: "native",
  followUp: "native",
  abort: "native",
});

export interface FabricBackendOptions {
  readonly now?: () => number;
  readonly controlTimeoutMs?: number;
  readonly maxEvents?: number;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new TypeError(`Fabric backend ${label} must be a positive safe integer`);
  }
  return result;
}

function sourceSpec(spec: TeammateRunSpec): FabricAgentRunSpecV1 {
  return {
    agent: spec.agent,
    task: spec.task,
    ...(spec.name === undefined ? {} : { name: spec.name }),
    ...(spec.context === undefined ? {} : { context: spec.context }),
    ...(spec.model === undefined ? {} : { model: spec.model }),
    ...(spec.thinking === undefined ? {} : { thinking: spec.thinking }),
    ...(spec.outputSchema === undefined ? {} : { outputSchema: spec.outputSchema }),
  };
}

function assertSelection(spec: TeammateRunSpec, channel: PreparedFabricBackendChannel): void {
  const placement = spec.placement!;
  const endpoint = channel.endpoint;
  if (placement.requestedRole !== undefined && placement.requestedRole !== spec.agent) {
    throw new FabricContractError("conflict", "Placement requestedRole does not match the teammate agent", "requestedRole");
  }
  if (!endpoint.roles.includes(spec.agent)) {
    throw new FabricContractError("permission_denied", "Selected Agent Endpoint does not advertise the requested role", "agent");
  }
  if (placement.requestedTaskType !== undefined && !endpoint.taskTypes.includes(placement.requestedTaskType)) {
    throw new FabricContractError("permission_denied", "Selected Agent Endpoint does not advertise the requested task type", "requestedTaskType");
  }
  if (placement.requestedModel !== undefined && placement.requestedModel !== spec.model) {
    throw new FabricContractError("conflict", "Placement requestedModel does not match the teammate model", "requestedModel");
  }
  if (spec.model !== undefined && !endpoint.models.includes(spec.model)) {
    throw new FabricContractError("permission_denied", "Selected Agent Endpoint does not advertise the requested model", "model");
  }
}

interface LinkedSignal {
  readonly signal: AbortSignal;
  dispose(): void;
}

function linkedSignal(deadlineAt: number, parent: AbortSignal | undefined, now: () => number): LinkedSignal {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(parent?.reason);
  parent?.addEventListener("abort", onAbort, { once: true });
  if (parent?.aborted) onAbort();
  const remaining = deadlineAt - now();
  const timer = setTimeout(() => controller.abort(new FabricContractError(
    "deadline_exceeded",
    "Fabric placement deadline has passed",
    "deadlineAt",
  )), Math.max(0, remaining));
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose(): void {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

async function boundedControl<T>(
  run: (signal: AbortSignal) => Promise<T>,
  placementDeadline: number,
  timeoutMs: number,
  now: () => number,
): Promise<T> {
  const deadline = Math.min(placementDeadline, now() + timeoutMs);
  if (deadline <= now()) throw new FabricContractError("deadline_exceeded", "Fabric control deadline has passed", "deadlineAt");
  const linked = linkedSignal(deadline, undefined, now);
  try {
    return await run(linked.signal);
  } finally {
    linked.dispose();
  }
}

function progress(options: BackendRunOptions, message: string): void {
  try {
    options.onProgress?.({ status: "running", lastMessage: message });
  } catch {
    // Progress observers are advisory.
  }
}

async function closeChannel(channel: PreparedFabricBackendChannel, timeoutMs: number): Promise<void> {
  const closing = Promise.resolve().then(() => channel.close());
  closing.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  try {
    await Promise.race([closing.catch(() => undefined), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isResolverAcquirer(
  source: FabricBackendRouteResolverSource,
): source is Exclude<FabricBackendRouteResolverSource, FabricBackendRouteResolver> {
  return "acquire" in source && typeof source.acquire === "function";
}

function validResolverLease(lease: FabricBackendRouteResolverLease): void {
  if (!Number.isSafeInteger(lease.generation) || lease.generation < 1) {
    throw new TypeError("Fabric route resolver lease generation must be a positive safe integer");
  }
  if (typeof lease.ownerId !== "string" || lease.ownerId.length === 0) {
    throw new TypeError("Fabric route resolver lease ownerId must be non-empty");
  }
  if (!lease.resolver || typeof lease.resolver.prepare !== "function") {
    throw new TypeError("Fabric route resolver lease must carry a resolver");
  }
  if (typeof lease.release !== "function") {
    throw new TypeError("Fabric route resolver lease must implement release");
  }
}

/** Create the route-pinned Fabric teammate backend. */
export function createFabricBackend(
  resolverSource: FabricBackendRouteResolverSource,
  backendOptions: FabricBackendOptions = {},
): TeammateBackend {
  const now = backendOptions.now ?? Date.now;
  const controlTimeoutMs = positiveInteger(backendOptions.controlTimeoutMs, 5_000, "controlTimeoutMs");
  const maxEvents = positiveInteger(backendOptions.maxEvents, 512, "maxEvents");
  return {
    name: "fabric",
    protocolVersion: 1,
    capabilities: () => CAPABILITIES,
    recoveryShape: "in-context-continuation",

    async start(spec: TeammateRunSpec, options: BackendRunOptions): Promise<BackendRun> {
      const placement = spec.placement;
      if (placement === undefined) {
        throw new FabricContractError("invalid_argument", "Fabric backend requires an explicit placement", "placement");
      }
      assertValidTeammatePlacement(placement, now());
      const startedAt = now();
      const lifetime = linkedSignal(placement.deadlineAt, options.signal, now);
      let resolver: FabricBackendRouteResolver;
      let resolverLease: FabricBackendRouteResolverLease | undefined;
      try {
        if (isResolverAcquirer(resolverSource)) {
          resolverLease = await resolverSource.acquire({
            correlationId: options.correlationId,
            placement,
          }, lifetime.signal);
          if (resolverLease === undefined) {
            throw new FabricContractError(
              "unavailable",
              "Fabric route resolver provider is unavailable for this placed dispatch",
              "placement",
            );
          }
          validResolverLease(resolverLease);
          resolver = resolverLease.resolver;
        } else {
          resolver = resolverSource;
        }
      } catch (error) {
        lifetime.dispose();
        if (resolverLease !== undefined) await resolverLease.release();
        throw error;
      }

      let released = false;
      const releaseResolver = async (): Promise<void> => {
        if (released) return;
        released = true;
        await resolverLease?.release();
      };
      let channel: PreparedFabricBackendChannel | undefined;
      try {
        channel = await resolver.prepare({ placement, attemptId: options.correlationId }, lifetime.signal);
        assertPreparedFabricChannel(channel, placement, now());
        assertSelection(spec, channel);
      } catch (error) {
        lifetime.dispose();
        if (channel !== undefined) await closeChannel(channel, controlTimeoutMs);
        await releaseResolver();
        throw error;
      }

      const events: FabricPlacementEventV1[] = [];
      let lastSequence = 0;
      let streamFailure: string | undefined;
      let turnReported = false;
      let admitted = false;
      let settled = false;
      let aborted = false;
      const deliverEvent = (event: FabricPlacementEventV1): void => {
        try { options.onChildEvent?.(structuredClone(event) as unknown as Record<string, unknown>); } catch { /* advisory */ }
        if (event.kind === "turn-complete" && !turnReported) {
          const result = fabricTurnResult(event, spec, options.correlationId);
          turnReported = true;
          try { options.onTurnComplete?.(result, result.terminalStatus); } catch { /* advisory */ }
        }
      };
      let unsubscribe = (): void => undefined;
      let request: ReturnType<typeof fabricStartRequest>;
      try {
        request = fabricStartRequest(options.correlationId, placement, sourceSpec(spec), now());
        unsubscribe = channel.subscribe((event) => {
        if (streamFailure !== undefined) return;
        try {
          assertFabricAgentEvent(event, placement.placementId);
          if (event.sequence <= lastSequence) {
            throw new FabricContractError("protocol_violation", "Fabric placement event sequence is not increasing", "sequence");
          }
          if (events.length >= maxEvents) {
            throw new FabricContractError("resource_exhausted", "Fabric placement event buffer is full", "maxEvents");
          }
          lastSequence = event.sequence;
          const accepted = structuredClone(event);
          events.push(accepted);
          // Subscription precedes start so no source event is lost, but no event
          // reaches host publication until the ACK and source capabilities pass.
          if (admitted) deliverEvent(accepted);
        } catch (error) {
          streamFailure = error instanceof Error ? error.message : String(error);
          void boundedControl(
            (signal) => channel.abort(options.correlationId, placement.placementId, signal),
            placement.deadlineAt,
            controlTimeoutMs,
            now,
          ).catch(() => undefined);
        }
        });
      } catch (error) {
        lifetime.dispose();
        await closeChannel(channel, controlTimeoutMs);
        await releaseResolver();
        throw error;
      }

      let startAck: Awaited<ReturnType<typeof channel.start>> | undefined;
      let startFailure: string | undefined;
      try {
        startAck = await channel.start(request, lifetime.signal);
        assertFabricAgentStartAck(startAck, request);
        if (startAck.acceptedModel !== undefined && !channel.endpoint.models.includes(startAck.acceptedModel)) {
          throw new FabricContractError("conflict", "Source ACK selected a model not advertised by the Endpoint", "acceptedModel");
        }
        if (spec.model !== undefined && startAck.acceptedModel !== spec.model) {
          throw new FabricContractError("conflict", "Source ACK selected a different model", "acceptedModel");
        }
        const sourceRunSpec: TeammateRunSpec = sourceSpec(spec);
        const capabilityErrors = validateBackendCapabilities(
          [{ spec: sourceRunSpec, ...(sourceRunSpec.name === undefined ? {} : { name: sourceRunSpec.name }) }],
          () => ({ name: startAck!.acceptedBackend, capabilities: startAck!.acceptedCapabilities }),
        ).errors;
        if (capabilityErrors.length > 0) {
          throw new FabricContractError("conflict", capabilityErrors.join("\n"), "acceptedCapabilities");
        }
        if (streamFailure !== undefined) {
          throw new FabricContractError("protocol_violation", streamFailure, "events");
        }
        // Validate every buffered completion before exposing any buffered event.
        for (const event of events) {
          if (event.kind === "turn-complete") fabricTurnResult(event, spec, options.correlationId);
        }
        admitted = true;
        for (const event of events) deliverEvent(event);
      } catch (error) {
        // A failed or lost ACK is not proof that the source did not start. Keep
        // the run in the explicit recovery path and report it unreaped unless
        // source authority later proves otherwise.
        startFailure = error instanceof Error ? error.message : String(error);
        void boundedControl(
          (signal) => channel.abort(options.correlationId, placement.placementId, signal),
          placement.deadlineAt,
          controlTimeoutMs,
          now,
        ).catch(() => undefined);
      }

      const outcome = (async (): Promise<AttemptOutcome> => {
        try {
          let wait: FabricBackendChannelWaitResult;
          try {
            wait = await channel.wait(lifetime.signal);
          } catch (error) {
            wait = {
              status: "transport-lost",
              reason: streamFailure ?? startFailure ?? (error instanceof Error ? error.message : String(error)),
            };
          }
          if (streamFailure !== undefined) wait = { status: "transport-lost", reason: streamFailure };

          let recoveryReceipt: Awaited<ReturnType<typeof channel.recover>> | undefined;
          try {
            recoveryReceipt = await boundedControl(
              (signal) => channel.recover(options.correlationId, placement.placementId, signal),
              placement.deadlineAt,
              controlTimeoutMs,
              now,
            );
            assertFabricAgentRecoveryReceipt(recoveryReceipt, options.correlationId, placement.placementId);
          } catch {
            // Missing recovery authority is represented explicitly by the fold.
          }
          const outcomeAdmitted = admitted && streamFailure === undefined;
          if (outcomeAdmitted && !turnReported && recoveryReceipt?.result !== undefined) {
            const recovered = recoveryReceipt.result;
            if (
              recovered.agent === spec.agent && recovered.task === spec.task &&
              recovered.correlationId === options.correlationId
            ) {
              turnReported = true;
              try { options.onTurnComplete?.(recovered, recovered.terminalStatus); } catch { /* advisory */ }
            }
          }

          let reclamationReceipt: Awaited<ReturnType<typeof channel.reclaim>> | undefined;
          try {
            reclamationReceipt = await boundedControl(
              (signal) => channel.reclaim(options.correlationId, placement.placementId, signal),
              placement.deadlineAt,
              controlTimeoutMs,
              now,
            );
            assertFabricAgentReclamationReceipt(reclamationReceipt, options.correlationId, placement.placementId);
          } catch {
            // Unknown release must remain unreaped; provider cleanup is separate.
          }

          const foldRecovery = outcomeAdmitted || recoveryReceipt === undefined
            ? recoveryReceipt
            : { ...recoveryReceipt, result: undefined };
          return foldFabricOutcome({
            spec,
            correlationId: options.correlationId,
            placementId: placement.placementId,
            events: outcomeAdmitted ? events : [],
            startAck: outcomeAdmitted ? startAck : undefined,
            recoveryReceipt: foldRecovery,
            reclamationReceipt,
            wait: startFailure === undefined ? wait : {
              status: "transport-lost",
              reason: `start acknowledgement was not established: ${startFailure}`,
            },
            startedAt,
            settledAt: now(),
          });
        } finally {
          settled = true;
          try { unsubscribe(); } catch { /* channel cleanup remains mandatory */ }
          lifetime.dispose();
          try {
            await closeChannel(channel, controlTimeoutMs);
          } finally {
            await releaseResolver();
          }
        }
      })();

      return {
        outcome,
        send(message: string, mode: ControlMode): boolean {
          if (settled || aborted || !admitted || startAck === undefined || streamFailure !== undefined) return false;
          void boundedControl(
            (signal) => channel.send({
              version: FABRIC_AGENT_ATTEMPT_VERSION,
              attemptId: options.correlationId,
              placementId: placement.placementId,
              message,
              mode,
            }, signal),
            placement.deadlineAt,
            controlTimeoutMs,
            now,
          ).then(
            (receipt) => {
              assertFabricAgentControlReceipt(receipt, options.correlationId, placement.placementId, "send");
              progress(options, `Fabric ${mode} receipt: ${receipt.state} (${receipt.receiptRef})`);
            },
            (error: unknown) => progress(options, `Fabric ${mode} failed: ${String(error)}`),
          );
          return true;
        },
        abort(): void {
          if (settled || aborted) return;
          aborted = true;
          void boundedControl(
            (signal) => channel.abort(options.correlationId, placement.placementId, signal),
            placement.deadlineAt,
            controlTimeoutMs,
            now,
          ).then(
            (receipt) => {
              assertFabricAgentControlReceipt(receipt, options.correlationId, placement.placementId, "abort");
              progress(options, `Fabric abort receipt: ${receipt.state} (${receipt.receiptRef})`);
            },
            (error: unknown) => progress(options, `Fabric abort failed: ${String(error)}`),
          );
        },
      };
    },
  };
}

export default createFabricBackend;
