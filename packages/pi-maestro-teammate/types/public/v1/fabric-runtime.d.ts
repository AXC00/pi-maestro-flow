/**
 * Source-side runtime port for one Fabric-routed teammate attempt.
 *
 * Flow owns the Gateway and route adapter, while Teammate owns execution. This
 * runtime-registered seam keeps that dependency one-way: Flow imports this
 * public contract and Teammate never imports Flow.
 */
import type { AttemptOutcome, BackendCapabilities, BackendRun } from "pi-maestro-backend-core/v1/backend";
import type { BackendRegistry } from "pi-maestro-backend-core/v1/registry";
import type { AgentTerminalStatus, SingleResult, TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
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
    readonly onTurnComplete?: (result: SingleResult, terminalStatus?: AgentTerminalStatus) => void;
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
export declare function createFabricTeammateRuntimePort(options?: FabricTeammateRuntimePortOptions): FabricTeammateRuntimePort;
export interface FabricTeammateRuntimeRegistration {
    readonly port: FabricTeammateRuntimePort;
    dispose(): void;
}
/** Install the source runtime used by Flow Agent Endpoint bridges in this process. */
export declare function registerFabricTeammateRuntimePort(port: FabricTeammateRuntimePort): FabricTeammateRuntimeRegistration;
/** Return the currently registered source runtime, if this host installed one. */
export declare function getFabricTeammateRuntimePort(): FabricTeammateRuntimePort | undefined;
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
/** Install the origin host's route resolver provider; the disposer is idempotent. */
export declare function registerFabricRouteResolverProvider(provider: FabricRouteResolverProvider): () => void;
/** Return the installed route resolver provider, when this host has one. */
export declare function getFabricRouteResolverProvider(): FabricRouteResolverProvider | undefined;
