import type {
  AttemptOutcome,
  AttemptReclamation,
  AttemptRecoveryFacts,
} from "pi-maestro-backend-core/v1/backend";
import type {
  AgentTerminalStatus,
  SingleResult,
  TeammateRunSpec,
  Usage,
} from "pi-maestro-backend-core/v1/spec";
import {
  FabricContractError,
  type FabricPlacementEventV1,
} from "pi-maestro-fabric-core/v1";
import type {
  FabricAgentRecoveryReceiptV1,
  FabricAgentReclamationReceiptV1,
  FabricAgentStartAckV1,
  FabricBackendChannelWaitResult,
} from "./channel.ts";
import { assertFabricAgentEvent } from "./channel.ts";

export interface FabricOutcomeInput {
  readonly spec: TeammateRunSpec;
  readonly correlationId: string;
  readonly placementId: string;
  readonly events: readonly FabricPlacementEventV1[];
  readonly startAck?: FabricAgentStartAckV1;
  readonly recoveryReceipt?: FabricAgentRecoveryReceiptV1;
  readonly reclamationReceipt?: FabricAgentReclamationReceiptV1;
  readonly wait: FabricBackendChannelWaitResult;
  readonly startedAt: number;
  readonly settledAt: number;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FabricContractError("protocol_violation", `${path} must be an object`, path);
  }
  return value as Record<string, unknown>;
}

function nonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new FabricContractError("protocol_violation", `${path} must be a finite non-negative number`, path);
  }
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new FabricContractError("protocol_violation", `${path} must be a non-negative safe integer`, path);
  }
  return value as number;
}

function usageOf(value: unknown): Usage {
  const usage = object(value, "result.usage");
  return {
    inputTokens: nonNegativeNumber(usage.inputTokens, "result.usage.inputTokens"),
    outputTokens: nonNegativeNumber(usage.outputTokens, "result.usage.outputTokens"),
    cacheReadTokens: nonNegativeNumber(usage.cacheReadTokens, "result.usage.cacheReadTokens"),
    cacheWriteTokens: nonNegativeNumber(usage.cacheWriteTokens, "result.usage.cacheWriteTokens"),
    cost: nonNegativeNumber(usage.cost, "result.usage.cost"),
    turns: nonNegativeInteger(usage.turns, "result.usage.turns"),
  };
}

function terminalStatus(value: unknown): AgentTerminalStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "completed" || value === "failed" || value === "terminated") return value;
  throw new FabricContractError("protocol_violation", "result.terminalStatus is invalid", "result.terminalStatus");
}

/** Validate the source result before it reaches origin publication. */
export function fabricTurnResult(
  event: FabricPlacementEventV1,
  spec: TeammateRunSpec,
  correlationId: string,
): SingleResult {
  if (event.kind !== "turn-complete") {
    throw new FabricContractError("invalid_state", "Fabric event is not a turn completion", "kind");
  }
  const result = object(event.payload.result, "result");
  if (result.agent !== spec.agent || result.task !== spec.task || result.correlationId !== correlationId) {
    throw new FabricContractError("conflict", "Fabric turn result identity does not match the requested attempt", "result");
  }
  if (typeof result.exitCode !== "number" || !Number.isSafeInteger(result.exitCode)) {
    throw new FabricContractError("protocol_violation", "result.exitCode must be a safe integer", "result.exitCode");
  }
  if (!Array.isArray(result.messages)) {
    throw new FabricContractError("protocol_violation", "result.messages must be an array", "result.messages");
  }
  const messages = result.messages.map((message, index) => {
    const entry = object(message, `result.messages[${index}]`);
    if (typeof entry.role !== "string" || typeof entry.content !== "string") {
      throw new FabricContractError("protocol_violation", "Fabric result messages must contain text role/content", `result.messages[${index}]`);
    }
    return { role: entry.role, content: entry.content };
  });
  if (typeof result.model !== "string" || typeof result.durationMs !== "number" || !Number.isFinite(result.durationMs) || result.durationMs < 0) {
    throw new FabricContractError("protocol_violation", "Fabric turn result has invalid model or duration", "result");
  }
  const status = terminalStatus(result.terminalStatus);
  const safe = structuredClone(result);
  // Publication identity, origin paths, and registry provenance belong to the
  // origin teammate host. A source-local value must never become agent://
  // authority merely because it crossed a Fabric result envelope.
  delete safe.publicationId;
  delete safe.originCwd;
  delete safe.provenance;
  delete safe.backend;
  delete safe.lifecyclePending;
  return {
    ...(safe as unknown as SingleResult),
    agent: spec.agent,
    task: spec.task,
    correlationId,
    exitCode: result.exitCode,
    messages,
    usage: usageOf(result.usage),
    model: result.model,
    durationMs: result.durationMs,
    wakeable: false,
    ...(status === undefined ? {} : { terminalStatus: status }),
  };
}

function recoveryFacts(value: unknown): AttemptRecoveryFacts {
  const facts = object(value, "recovery");
  const authority = facts.settlementAuthority;
  if (authority !== "authoritative" && authority !== "inferred" && authority !== "unknown") {
    throw new FabricContractError("protocol_violation", "recovery settlementAuthority is invalid", "settlementAuthority");
  }
  if (typeof facts.preActivityInfrastructureExit !== "boolean" || typeof facts.externalReplayRisk !== "boolean") {
    throw new FabricContractError("protocol_violation", "recovery booleans are invalid", "recovery");
  }
  return {
    settlementAuthority: authority,
    completedToolCount: nonNegativeInteger(facts.completedToolCount, "completedToolCount"),
    inFlightToolCount: nonNegativeInteger(facts.inFlightToolCount, "inFlightToolCount"),
    preActivityInfrastructureExit: facts.preActivityInfrastructureExit,
    externalReplayRisk: facts.externalReplayRisk,
  };
}

function reclamationOf(value: unknown): AttemptReclamation {
  const reclamation = object(value, "reclamation");
  if (reclamation.status === "reclaimed") return { status: "reclaimed" };
  if (reclamation.status === "unreaped" && typeof reclamation.reason === "string" && reclamation.reason.length > 0) {
    return { status: "unreaped", reason: reclamation.reason };
  }
  throw new FabricContractError("protocol_violation", "Fabric reclamation evidence is invalid", "reclamation");
}

function lastEvent(events: readonly FabricPlacementEventV1[], kind: FabricPlacementEventV1["kind"]): FabricPlacementEventV1 | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.kind === kind) return events[index];
  }
  return undefined;
}

function verifiedEvents(events: readonly FabricPlacementEventV1[], placementId: string): void {
  let previous = 0;
  for (const event of events) {
    assertFabricAgentEvent(event, placementId);
    if (event.sequence <= previous) {
      throw new FabricContractError("protocol_violation", "Fabric placement event sequence is not strictly increasing", "sequence");
    }
    previous = event.sequence;
  }
}

function unknownResult(input: FabricOutcomeInput, reason: string): SingleResult {
  return {
    agent: input.spec.agent,
    ...(input.spec.name === undefined ? {} : { name: input.spec.name }),
    task: input.spec.task,
    exitCode: 1,
    messages: [{ role: "system", content: `Fabric attempt outcome is unknown: ${reason}` }],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 0 },
    model: input.startAck?.acceptedModel ?? input.spec.model ?? "unknown",
    correlationId: input.correlationId,
    durationMs: Math.max(0, input.settledAt - input.startedAt),
    wakeable: false,
    terminalStatus: "failed",
  };
}

/** Fold only explicit source evidence; missing tool events never imply safe replay. */
export function foldFabricOutcome(input: FabricOutcomeInput): AttemptOutcome {
  verifiedEvents(input.events, input.placementId);
  const turn = lastEvent(input.events, "turn-complete");
  let result: SingleResult;
  try {
    const recovered = input.recoveryReceipt?.result;
    result = turn !== undefined
      ? fabricTurnResult(turn, input.spec, input.correlationId)
      : recovered !== undefined
        ? fabricTurnResult({
            version: "fabric.placement.v1",
            placementId: input.placementId,
            sequence: 1,
            kind: "turn-complete",
            occurredAt: input.settledAt,
            payload: { result: recovered as never },
          }, input.spec, input.correlationId)
        : unknownResult(input, input.wait.reason ?? "the source emitted no turn completion");
  } catch (error) {
    result = unknownResult(input, error instanceof Error ? error.message : String(error));
  }

  let recovery: AttemptRecoveryFacts | undefined;
  try {
    recovery = input.recoveryReceipt?.recovery === undefined
      ? undefined
      : recoveryFacts(input.recoveryReceipt.recovery);
    if (recovery === undefined) {
      const event = lastEvent(input.events, "recovery-facts");
      if (event !== undefined) recovery = recoveryFacts(event.payload);
    }
  } catch {
    recovery = undefined;
  }
  recovery ??= {
    settlementAuthority: "unknown",
    completedToolCount: 0,
    inFlightToolCount: 0,
    // Absence of events proves only absence of evidence. The source may have
    // accepted work before the channel disappeared.
    preActivityInfrastructureExit: false,
    externalReplayRisk: true,
  };

  let reclamation: AttemptReclamation | undefined;
  try {
    reclamation = input.reclamationReceipt === undefined
      ? undefined
      : reclamationOf(input.reclamationReceipt.reclamation);
    if (reclamation === undefined) {
      const event = lastEvent(input.events, "reclamation");
      if (event !== undefined) reclamation = reclamationOf(event.payload);
    }
  } catch {
    reclamation = undefined;
  }
  reclamation ??= {
    status: "unreaped",
    reason: input.wait.status === "transport-lost"
      ? `Fabric transport lost before source reclamation was confirmed${input.wait.reason ? `: ${input.wait.reason}` : ""}`
      : "Fabric source did not provide valid reclamation evidence",
  };

  return { result, recovery, reclamation: Promise.resolve(reclamation) };
}
