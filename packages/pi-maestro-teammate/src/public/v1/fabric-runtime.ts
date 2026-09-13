/**
 * Source-side runtime port for one Fabric-routed teammate attempt.
 *
 * Flow owns the Gateway and route adapter, while Teammate owns execution. This
 * runtime-registered seam keeps that dependency one-way: Flow imports this
 * public contract and Teammate never imports Flow.
 */

import type {
  AttemptOutcome,
  BackendCapabilities,
  BackendRun,
} from "pi-maestro-backend-core/v1/backend";
import type { BackendRegistry } from "pi-maestro-backend-core/v1/registry";
import type {
  AgentTerminalStatus,
  SingleResult,
  TeammateRunSpec,
} from "pi-maestro-backend-core/v1/spec";
import type { TeammatePlacementV1 } from "pi-maestro-fabric-core/v1/placement";
import type { FabricBackendRouteResolver } from "pi-maestro-backends/fabric";

/** One already-authorized, device-local attempt. */
export interface FabricTeammateAttemptRequest {
  readonly placement: TeammatePlacementV1;
  /**
   * Source-local backend spec. `placement`, the origin Fabric backend selector,
   * origin cwd, and origin Todo ids must already have been removed.
   */
  readonly spec: TeammateRunSpec;
  readonly correlationId: string;
  /** Trusted source-local workspace path; it never comes from the wire. */
  readonly baseCwd: string;
  readonly signal: AbortSignal;
  readonly onChildEvent?: (event: Record<string, unknown>) => void;
  readonly onTurnComplete?: (
    result: SingleResult,
    terminalStatus?: AgentTerminalStatus,
  ) => void;
}

/** A live source attempt plus the exact backend admission that accepted it. */
export interface FabricTeammateAttempt extends BackendRun {
  readonly acceptedBackend: string;
  readonly acceptedModel?: string;
  readonly acceptedCapabilities: BackendCapabilities;
  readonly outcome: Promise<AttemptOutcome>;
}

/**
 * Executes exactly one source attempt.
 *
 * Implementations must resolve only after the selected local backend has
 * acknowledged start. They must not perform model fallback, create a DAG, or
 * publish a canonical completion; those remain origin-host responsibilities.
 */
export interface FabricTeammateRuntimePort {
  startAttempt(request: FabricTeammateAttemptRequest): Promise<FabricTeammateAttempt>;
}

export interface FabricTeammateRuntimePortOptions {
  /** Test/embedder override; production resolves the source workspace registry. */
  readonly backendRegistry?: BackendRegistry;
}

/**
 * Create the production source-side runtime.
 *
 * Each call resolves and starts exactly one source-local backend attempt. It
 * never enters the teammate orchestration loop, so it cannot retry another
 * model, publish an agent:// result, or recursively place through Fabric.
 */
export function createFabricTeammateRuntimePort(
  options: FabricTeammateRuntimePortOptions = {},
): FabricTeammateRuntimePort {
  return {
    async startAttempt(request) {
      // Keep the registry getter a light process seam. The execution engine is
      // loaded only when a source Endpoint actually admits an attempt.
      const { startFabricSourceBackendAttempt } = await import("../../runs/execution.ts");
      return startFabricSourceBackendAttempt(request, options);
    },
  };
}

export interface FabricTeammateRuntimeRegistration {
  readonly port: FabricTeammateRuntimePort;
  dispose(): void;
}

const REGISTRY_KEY = Symbol.for("pi-maestro.fabric-teammate-runtime.v1");
const globals = globalThis as typeof globalThis & Record<symbol, unknown>;

/** Install the source runtime used by Flow Agent Endpoint bridges in this process. */
export function registerFabricTeammateRuntimePort(
  port: FabricTeammateRuntimePort,
): FabricTeammateRuntimeRegistration {
  if (!port || typeof port.startAttempt !== "function") {
    throw new TypeError("Fabric teammate runtime port must implement startAttempt");
  }
  globals[REGISTRY_KEY] = port;
  return {
    port,
    dispose(): void {
      if (globals[REGISTRY_KEY] === port) delete globals[REGISTRY_KEY];
    },
  };
}

/** Return the currently registered source runtime, if this host installed one. */
export function getFabricTeammateRuntimePort(): FabricTeammateRuntimePort | undefined {
  const candidate = globals[REGISTRY_KEY] as Partial<FabricTeammateRuntimePort> | undefined;
  return candidate && typeof candidate.startAttempt === "function"
    ? candidate as FabricTeammateRuntimePort
    : undefined;
}

/**
 * Supplies the origin host's Fabric route resolver to a dispatch that loads the
 * Fabric backend.
 *
 * The resolver is transport wiring: it owns the paired connection to the
 * Gateway that admitted the route. It is consulted lazily, so a purely local
 * dispatch never pays for it and a dispatch with no provider refuses a placed
 * task by name instead of running it on this machine.
 */
export type FabricRouteResolverProvider = () => FabricBackendRouteResolver | undefined;

const RESOLVER_KEY = Symbol.for("pi-maestro.fabric-route-resolver-provider.v1");

/** Install the origin host's route resolver provider; the disposer is idempotent. */
export function registerFabricRouteResolverProvider(
  provider: FabricRouteResolverProvider,
): () => void {
  if (typeof provider !== "function") {
    throw new TypeError("Fabric route resolver provider must be a function");
  }
  globals[RESOLVER_KEY] = provider;
  return () => {
    if (globals[RESOLVER_KEY] === provider) delete globals[RESOLVER_KEY];
  };
}

/** Return the installed route resolver provider, when this host has one. */
export function getFabricRouteResolverProvider(): FabricRouteResolverProvider | undefined {
  const candidate = globals[RESOLVER_KEY];
  return typeof candidate === "function" ? candidate as FabricRouteResolverProvider : undefined;
}
