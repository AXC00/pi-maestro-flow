import assert from "node:assert/strict";
import test from "node:test";
import type { SingleResult, TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
import { fabricPlacementEvent } from "../src/fabric/channel.ts";
import { foldFabricOutcome } from "../src/fabric/outcome.ts";

const SPEC: TeammateRunSpec = { agent: "general", task: "inspect the workspace", model: "model-a" };

function result(): SingleResult {
  return {
    agent: SPEC.agent,
    task: SPEC.task,
    exitCode: 0,
    messages: [{ role: "assistant", content: "done" }],
    usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 },
    model: "model-a",
    correlationId: "attempt-1",
    durationMs: 20,
    terminalStatus: "completed",
  };
}

test("Fabric outcome trusts explicit turn, recovery, and reclamation evidence", async () => {
  const events = [
    fabricPlacementEvent("placement-1", 1, "turn-complete", 1_010, { result: result() as never }),
    fabricPlacementEvent("placement-1", 2, "recovery-facts", 1_011, {
      settlementAuthority: "authoritative",
      completedToolCount: 1,
      inFlightToolCount: 0,
      preActivityInfrastructureExit: false,
      externalReplayRisk: false,
    }),
    fabricPlacementEvent("placement-1", 3, "reclamation", 1_012, { status: "reclaimed" }),
    fabricPlacementEvent("placement-1", 4, "completion", 1_013, { terminalStatus: "completed" }),
  ];
  const outcome = foldFabricOutcome({
    spec: SPEC,
    correlationId: "attempt-1",
    placementId: "placement-1",
    events,
    wait: { status: "completed" },
    startedAt: 1_000,
    settledAt: 1_020,
  });

  assert.equal(outcome.result.messages[0]?.content, "done");
  assert.equal(outcome.recovery.settlementAuthority, "authoritative");
  assert.equal(outcome.recovery.completedToolCount, 1);
  assert.deepEqual(await outcome.reclamation, { status: "reclaimed" });
});

test("missing events never imply a pre-activity safe replay", async () => {
  const outcome = foldFabricOutcome({
    spec: SPEC,
    correlationId: "attempt-1",
    placementId: "placement-1",
    events: [],
    wait: { status: "transport-lost", reason: "ACK response disappeared" },
    startedAt: 1_000,
    settledAt: 1_020,
  });

  assert.equal(outcome.result.terminalStatus, "failed");
  assert.equal(outcome.recovery.settlementAuthority, "unknown");
  assert.equal(outcome.recovery.preActivityInfrastructureExit, false);
  assert.equal(outcome.recovery.externalReplayRisk, true);
  const reclamation = await outcome.reclamation;
  assert.equal(reclamation.status, "unreaped");
  assert.match(reclamation.status === "unreaped" ? reclamation.reason : "", /ACK response disappeared/);
});

test("source-claimed publication identity, origin path, and registry provenance are stripped", async () => {
  const claimed = {
    ...result(),
    publicationId: "source-invented-publication",
    originCwd: "C:/source/secret",
    backend: "pi-subprocess",
    lifecyclePending: true,
    provenance: { registryVersion: 1, registryRevision: 1, registryHash: "x", modelRegistrationId: "r", modelId: "m", deploymentId: "d", harness: "pi", transport: { kind: "adapter-owned" } },
  };
  const outcome = foldFabricOutcome({
    spec: SPEC,
    correlationId: "attempt-1",
    placementId: "placement-1",
    events: [fabricPlacementEvent("placement-1", 1, "turn-complete", 1_010, { result: claimed as never })],
    wait: { status: "completed" },
    startedAt: 1_000,
    settledAt: 1_020,
  });

  assert.equal(outcome.result.publicationId, undefined);
  assert.equal(outcome.result.originCwd, undefined);
  assert.equal(outcome.result.backend, undefined);
  assert.equal(outcome.result.provenance, undefined);
  assert.equal(outcome.result.lifecyclePending, undefined);
  assert.equal(outcome.result.wakeable, false);
});

test("a recovered result can settle a stream that lost its turn event", async () => {
  const outcome = foldFabricOutcome({
    spec: SPEC,
    correlationId: "attempt-1",
    placementId: "placement-1",
    events: [],
    recoveryReceipt: {
      version: "fabric.agent-attempt.v1",
      attemptId: "attempt-1",
      placementId: "placement-1",
      startAcknowledged: true,
      terminal: true,
      lastSequence: 4,
      recovery: {
        settlementAuthority: "authoritative",
        completedToolCount: 0,
        inFlightToolCount: 0,
        preActivityInfrastructureExit: false,
        externalReplayRisk: false,
      },
      result: result(),
      receiptRef: "placement-1:recovery:4",
    },
    reclamationReceipt: {
      version: "fabric.agent-attempt.v1",
      attemptId: "attempt-1",
      placementId: "placement-1",
      reclamation: { status: "reclaimed" },
      receiptRef: "placement-1:reclamation:4",
    },
    wait: { status: "transport-lost" },
    startedAt: 1_000,
    settledAt: 1_020,
  });

  assert.equal(outcome.result.exitCode, 0);
  assert.equal(outcome.result.messages[0]?.content, "done");
  assert.deepEqual(await outcome.reclamation, { status: "reclaimed" });
});
