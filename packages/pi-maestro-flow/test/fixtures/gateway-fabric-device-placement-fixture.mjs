import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const CAPABILITIES = Object.freeze({
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

function mark(event) {
  const path = process.env.FABRIC_DEVICE_FIXTURE_MARKERS;
  if (path) appendFileSync(path, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...event })}\n`, "utf8");
}

function result(spec, options, terminalStatus, text) {
  return {
    agent: spec.agent,
    task: spec.task,
    exitCode: terminalStatus === "completed" ? 0 : 1,
    messages: [{ role: "assistant", content: text }],
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 1 },
    model: spec.model ?? "fixture/adapter",
    correlationId: options.correlationId,
    durationMs: 1,
    terminalStatus,
  };
}

/** Deterministic source-local backend used through the production model registry. */
const backend = {
  name: "fixture-backend",
  protocolVersion: 1,
  recoveryShape: "in-context-continuation",
  capabilities: () => CAPABILITIES,
  async start(spec, options) {
    const label = spec.task.replace(/[^A-Za-z0-9_.:-]/gu, "-").slice(0, 96);
    mark({ gate: "backend-start", label, model: spec.model, cwd: spec.cwd });
    if (spec.task.startsWith("lost-ack:")) {
      mark({ gate: "lost-ack-exit", label });
      process.exit(86);
    }

    let settled = false;
    let settle;
    const outcome = new Promise((resolveOutcome) => { settle = resolveOutcome; });
    const finish = (terminalStatus, text) => {
      if (settled) return;
      settled = true;
      const value = result(spec, options, terminalStatus, text);
      options.onTurnComplete?.(value, terminalStatus);
      mark({ gate: "turn-complete", label, terminalStatus });
      settle({
        result: value,
        recovery: {
          settlementAuthority: "authoritative",
          completedToolCount: 0,
          inFlightToolCount: 0,
          preActivityInfrastructureExit: false,
          externalReplayRisk: false,
        },
        reclamation: Promise.resolve({ status: "reclaimed" }),
      });
      mark({ gate: "backend-outcome", label, terminalStatus });
    };

    setImmediate(() => {
      if (settled) return;
      options.onChildEvent?.({ type: "text", text: `fixture-output:${label}` });
      mark({ gate: "output", label });
      if (spec.task.startsWith("complete:")) finish("completed", `fixture-complete:${label}`);
    });

    return {
      outcome,
      send(message, mode) {
        if (settled) return false;
        mark({ gate: "send", label, mode, message });
        options.onChildEvent?.({ type: "text", text: `fixture-${mode}:${message}` });
        return true;
      },
      abort() {
        mark({ gate: "abort", label });
        finish("terminated", `fixture-aborted:${label}`);
      },
    };
  },
};

export default backend;

function jsonLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function originMain() {
  const [configPath, workspaceRoot, markerPath] = process.argv.slice(2);
  if (!configPath || !workspaceRoot || !markerPath) throw new Error("origin mode requires CONFIG WORKSPACE MARKERS");
  const [readline, { randomUUID }, { GatewayControlClient }, { GatewayLocalClient }, originRuntime, teammateFabric, registryHost] = await Promise.all([
    import("node:readline"),
    import("node:crypto"),
    import("../../src/gateway/control-client.ts"),
    import("../../src/gateway/local-client.ts"),
    import("../../src/gateway/fabric/origin-runtime.ts"),
    import("pi-maestro-teammate/v1/fabric-runtime"),
    import("../../../pi-maestro-teammate/src/backends/registry-host.ts"),
  ]);
  const control = new GatewayControlClient({ cwd: workspaceRoot, configPath, startupTimeoutMs: 9_000, stopTimeoutMs: 5_000 });
  const local = new GatewayLocalClient({ cwd: workspaceRoot, timeoutMs: 9_000, controlClient: control });
  const registration = teammateFabric.registerFabricRouteResolverProvider(
    new originRuntime.FabricOriginRouteResolverProvider({ control }),
    { ownerId: `fixture-origin-${process.pid}` },
  );
  const binding = teammateFabric.getFabricRouteResolverProviderBinding();
  if (!binding || binding.generation !== registration.generation || binding.ownerId !== registration.ownerId) {
    throw new Error("failed to capture the registered production resolver generation");
  }
  const runs = new Map();
  const publicRecords = [];
  const marker = (event) => appendFileSync(markerPath, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...event })}\n`, "utf8");

  async function fabricCall(tool, args) {
    const response = await local.call(tool, {
      ...args,
      version: "fabric.control.v1",
      requestId: `fixture-${randomUUID()}`,
      deadlineAt: Date.now() + 60_000,
    });
    const content = response.structuredContent;
    if (!content || typeof content !== "object") throw new Error(`${tool} returned no structured content`);
    const envelope = content;
    if (response.isError || envelope.ok !== true) {
      const message = envelope.error?.message ?? `${tool} ${String(args.action)} failed`;
      const error = new Error(message);
      error.code = envelope.error?.code;
      throw error;
    }
    return envelope.data?.result;
  }

  async function dispatch(command) {
    const runId = command.runId;
    const correlationId = command.correlationId ?? `attempt-${randomUUID()}`;
    const spec = { ...command.spec, backend: registryHost.FABRIC_BACKEND, placement: command.placement };
    const order = [];
    const registry = registryHost.dispatchFabricPlacementRegistrySync(
      workspaceRoot,
      () => { throw new Error("Pi extras must not be used by a placed Fabric dispatch"); },
      binding,
    );
    const resolved = await registry.resolve(spec, registryHost.FABRIC_BACKEND);
    marker({ gate: "origin-dispatch", runId, correlationId, providerGeneration: binding.generation });
    const handle = await resolved.backend.start(spec, {
      correlationId,
      baseCwd: workspaceRoot,
      host: {},
      config: resolved.config,
      onChildEvent(event) { order.push({ kind: "output", event }); marker({ gate: "origin-output", runId }); },
      onTurnComplete(value, terminalStatus) {
        order.push({ kind: "turn-complete", terminalStatus, value });
        marker({ gate: "origin-turn-complete", runId, terminalStatus });
      },
      onProgress(value) { marker({ gate: "origin-progress", runId, value }); },
    });
    runs.set(runId, { handle, order, correlationId });
    return { runId, correlationId, providerGeneration: binding.generation };
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  jsonLine({ type: "ready", pid: process.pid, providerGeneration: binding.generation, providerOwnerId: binding.ownerId });
  marker({ gate: "origin-ready", providerGeneration: binding.generation });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let command;
    try { command = JSON.parse(line); } catch (error) { jsonLine({ id: null, ok: false, error: String(error) }); continue; }
    try {
      let value;
      switch (command.action) {
        case "call": value = await fabricCall(command.tool, command.args); break;
        case "dispatch": value = await dispatch(command); break;
        case "send": {
          const run = runs.get(command.runId);
          if (!run) throw new Error("unknown run");
          value = { accepted: run.handle.send(command.message, command.mode) };
          break;
        }
        case "abort": {
          const run = runs.get(command.runId);
          if (!run) throw new Error("unknown run");
          run.handle.abort(); value = { requested: true }; break;
        }
        case "await": {
          const run = runs.get(command.runId);
          if (!run) throw new Error("unknown run");
          const outcome = await run.handle.outcome;
          value = { outcome: { ...outcome, reclamation: await outcome.reclamation }, order: run.order };
          publicRecords.push(value);
          marker({ gate: "origin-outcome", runId: command.runId });
          break;
        }
        case "revoke": value = await control.revokeFabricConnector(command.options); break;
        case "status": value = await control.status(); break;
        case "shutdown": registration.dispose(); value = { disposed: true }; break;
        default: throw new Error(`unsupported origin action ${String(command.action)}`);
      }
      jsonLine({ id: command.id, ok: true, value });
      if (command.action === "shutdown") break;
    } catch (error) {
      marker({ gate: "origin-error", action: command.action, code: error?.code, message: String(error?.message ?? error).slice(0, 256) });
      jsonLine({ id: command.id, ok: false, error: String(error?.message ?? error), code: error?.code });
    }
  }
  rl.close();
  process.stdin.pause();
  process.stdin.unref?.();
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  originMain().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
