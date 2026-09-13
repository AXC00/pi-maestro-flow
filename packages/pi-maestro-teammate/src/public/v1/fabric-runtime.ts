/**
 * Source-side runtime port for one Fabric-routed teammate attempt.
 *
 * Flow owns the Gateway and route adapter, while Teammate owns execution. This
 * runtime-registered seam keeps that dependency one-way: Flow imports this
 * public contract and Teammate never imports Flow.
 */

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
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
import type {
  FabricBackendRouteResolver,
  FabricBackendRouteResolverAcquireRequest,
  FabricBackendRouteResolverAcquirer,
  FabricBackendRouteResolverLease,
} from "pi-maestro-backends/fabric";
import { assertFabricIdentifier } from "pi-maestro-fabric-core/v1";
import { discoverAgents, listAgentSummaries } from "../../agents/agents.ts";
import {
  FABRIC_BACKEND,
  REMOTE_WORKERS,
  dispatchRegistryForProjectionSync,
  modelRegistryPairSync,
} from "../../backends/registry-host.ts";
import { sharedModelHealthCoordinator } from "../../models/model-circuit-breaker.ts";
import {
  exactBackendCapabilities,
  isFabricSourceLocalTransport,
} from "../../models/model-registry.ts";
import { discoverRoutingTaskTypes } from "../../models/model-routing.ts";

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

export interface TeammateSourceBackendAvailability {
  readonly name: string;
  /** Capabilities evaluated from this exact, loadable backend registration. */
  readonly capabilities: BackendCapabilities;
}

/** Package-neutral positive facts about executable teammate sources. */
export interface TeammateSourceAvailability {
  readonly roles: readonly string[];
  readonly taskTypes: readonly string[];
  readonly models: readonly string[];
  readonly backends: readonly TeammateSourceBackendAvailability[];
}

export interface TeammateSourceAvailabilityRequest {
  /** Workspace whose role, routing, model, and backend authorities are queried. */
  readonly cwd: string;
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
  /**
   * Return only source-local capabilities that are presently proven executable.
   * Absence means the runtime cannot prove a complete source projection.
   */
  getSourceAvailability?(
    request: TeammateSourceAvailabilityRequest,
  ): Promise<TeammateSourceAvailability | undefined>;
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
    async getSourceAvailability(request) {
      // An injected registry has no corresponding model-registry projection,
      // so its model identities cannot be proven and it is intentionally not
      // advertised by this production discovery method.
      if (options.backendRegistry !== undefined) return undefined;
      try {
        const cwd = realpathSync(request.cwd);
        // Consult the revision-aware authority first. It detects mode changes,
        // refreshes valid edits, and clears publication for invalid edits.
        const pair = modelRegistryPairSync(cwd);
        if (pair === undefined) return undefined;
        sharedModelHealthCoordinator.reconcileProjection(pair.dispatch);

        const discovery = discoverAgents(cwd, { includeDiagnostics: true });
        const roles = listAgentSummaries(discovery)
          .map((agent) => agent.name)
          .filter(validSourceIdentifier);
        const taskTypes = [
          ...discoverRoutingTaskTypes(cwd, discovery.agents),
          ...discovery.agents.flatMap((agent) => agent.taskType === undefined ? [] : [agent.taskType]),
        ].filter(validSourceIdentifier);
        if (roles.length === 0 || taskTypes.length === 0) return undefined;

        // The source execution path uses this same immutable dispatch
        // projection and the same transport predicate. Adapter-owned modules
        // remain candidates here, but become advertisable only after the exact
        // configured module loads and its capability table validates below.
        const localRoutes = [...pair.dispatch.routesByRegistrationId.values()].filter((route) => {
          const deployment = pair.dispatch.deploymentsById.get(route.deploymentId);
          return sharedModelHealthCoordinator.isHealthy(route.modelRegistrationId)
            && deployment !== undefined
            && isFabricSourceLocalTransport(deployment.runtime)
            && deployment.registration.module !== FABRIC_BACKEND
            && deployment.registration.module !== REMOTE_WORKERS;
        });
        if (localRoutes.length === 0) return undefined;

        const registry = dispatchRegistryForProjectionSync(pair.dispatch, () => {
          throw new Error("Source availability probing never starts a backend");
        });
        const availabilityByDeployment = new Map<string, TeammateSourceBackendAvailability>();
        for (const route of localRoutes) {
          if (availabilityByDeployment.has(route.deploymentId)) continue;
          try {
            const resolved = await registry.resolve({
              agent: "general",
              task: "Fabric source availability probe",
              backend: route.deploymentId,
              ...(route.selector.kind === "adapter-model" ? { model: route.selector.value } : {}),
            }, route.deploymentId);
            const capabilities = exactBackendCapabilities(resolved.capabilities);
            const backendName = resolved.backend.name;
            if (capabilities !== undefined
              && validSourceIdentifier(backendName)
              && backendName !== FABRIC_BACKEND
              && backendName !== REMOTE_WORKERS) {
              availabilityByDeployment.set(route.deploymentId, { name: backendName, capabilities });
            }
          } catch {
            // A registration that cannot load and validate now is unavailable.
          }
        }
        if (availabilityByDeployment.size === 0) return undefined;
        const admittedRoutes = localRoutes.filter((route) => {
          const availability = availabilityByDeployment.get(route.deploymentId);
          return availability !== undefined
            && (route.selector.kind !== "adapter-model"
              || availability.capabilities.modelSelection !== "unsupported");
        });
        const models = admittedRoutes
          .map((route) => route.modelRegistrationId)
          .filter(validModelRegistration);
        if (models.length === 0) return undefined;

        const backends = new Map<string, BackendCapabilities>();
        for (const route of admittedRoutes) {
          const availability = availabilityByDeployment.get(route.deploymentId)!;
          const previous = backends.get(availability.name);
          if (previous === undefined) {
            backends.set(availability.name, availability.capabilities);
          } else if (!sameBackendCapabilities(previous, availability.capabilities)) {
            return undefined;
          }
        }
        return {
          roles: uniqueSorted(roles),
          taskTypes: uniqueSorted(taskTypes),
          models: uniqueSorted(models),
          backends: [...backends]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, capabilities]) => ({ name, capabilities })),
        };
      } catch {
        // Discovery, registry publication, and backend loading are authority
        // reads. Any uncertainty fails closed instead of creating an Endpoint.
        return undefined;
      }
    },
  };
}

function sameBackendCapabilities(left: BackendCapabilities, right: BackendCapabilities): boolean {
  return left.outputSchema === right.outputSchema
    && left.forkContext === right.forkContext
    && left.modelSelection === right.modelSelection
    && left.thinkingLevel === right.thinkingLevel
    && left.todoBinding === right.todoBinding
    && left.toolFilter === right.toolFilter
    && left.steer === right.steer
    && left.followUp === right.followUp
    && left.abort === right.abort;
}

function validSourceIdentifier(value: string): boolean {
  try {
    assertFabricIdentifier(value, "sourceIdentifier");
    return true;
  } catch {
    return false;
  }
}

function validModelRegistration(value: string): boolean {
  return value.length > 0
    && Buffer.byteLength(value, "utf8") <= 256
    && !/\s|[\u0000-\u001f\u007f]/u.test(value);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
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

/** Legacy process-scoped provider retained for existing Flow embedders. */
export type FabricRouteResolverProvider = () => FabricBackendRouteResolver | undefined;

/** Generation and owner identity supplied to every managed acquisition. */
export interface FabricRouteResolverProviderAcquireRequest
  extends FabricBackendRouteResolverAcquireRequest {
  readonly generation: number;
  readonly ownerId: string;
}

/** Provider-owned resource returned for one placed dispatch. */
export interface FabricRouteResolverProviderLease {
  readonly resolver: FabricBackendRouteResolver;
  release(): void | Promise<void>;
}

/** New providers can allocate and release dispatch-scoped resolver resources. */
export interface GenerationTrackedFabricRouteResolverProvider {
  acquire(
    request: FabricRouteResolverProviderAcquireRequest,
    signal: AbortSignal,
  ): FabricRouteResolverProviderLease | undefined | Promise<FabricRouteResolverProviderLease | undefined>;
}

export type FabricRouteResolverProviderInput =
  | FabricRouteResolverProvider
  | GenerationTrackedFabricRouteResolverProvider;

export interface FabricRouteResolverProviderRegistrationOptions {
  /** Stable identity of the owning host lifecycle; generated when omitted. */
  readonly ownerId?: string;
}

/** Callable for legacy disposal, with explicit generation ownership metadata. */
export interface FabricRouteResolverProviderRegistration {
  (): void;
  readonly provider: FabricRouteResolverProviderInput;
  readonly generation: number;
  readonly ownerId: string;
  dispose(): void;
}

/** A dispatch capture that acquires from exactly one registered generation. */
export interface FabricRouteResolverProviderBinding extends FabricBackendRouteResolverAcquirer {
  readonly generation: number;
  readonly ownerId: string;
}

interface ResolverProviderRecord {
  readonly provider: FabricRouteResolverProviderInput;
  readonly generation: number;
  readonly ownerId: string;
}

interface ResolverProviderRegistry {
  readonly version: 2;
  nextGeneration: number;
  current?: ResolverProviderRecord;
}

const RESOLVER_KEY = Symbol.for("pi-maestro.fabric-route-resolver-provider.v1");

function isResolverProviderRegistry(value: unknown): value is ResolverProviderRegistry {
  return typeof value === "object" && value !== null
    && "version" in value && value.version === 2
    && "nextGeneration" in value && typeof value.nextGeneration === "number"
    && Number.isSafeInteger(value.nextGeneration) && value.nextGeneration >= 1;
}

function resolverProviderRegistry(): ResolverProviderRegistry {
  const existing = globals[RESOLVER_KEY];
  if (existing === undefined) {
    const created: ResolverProviderRegistry = { version: 2, nextGeneration: 1 };
    globals[RESOLVER_KEY] = created;
    return created;
  }
  if (!isResolverProviderRegistry(existing)) {
    throw new Error("A legacy Fabric route resolver provider is already installed in this process");
  }
  return existing;
}

function isManagedProvider(
  provider: FabricRouteResolverProviderInput,
): provider is GenerationTrackedFabricRouteResolverProvider {
  return typeof provider === "object" && provider !== null
    && "acquire" in provider && typeof provider.acquire === "function";
}

/**
 * Install one origin route resolver provider lifecycle.
 *
 * A live owner is never overwritten. Disposal is generation-fenced and
 * idempotent, so a stale disposer cannot remove a subsequently registered
 * owner.
 */
export function registerFabricRouteResolverProvider(
  provider: FabricRouteResolverProviderInput,
  options: FabricRouteResolverProviderRegistrationOptions = {},
): FabricRouteResolverProviderRegistration {
  if (typeof provider !== "function" && !isManagedProvider(provider)) {
    throw new TypeError("Fabric route resolver provider must be a function or implement acquire");
  }
  const registry = resolverProviderRegistry();
  if (registry.current !== undefined) {
    throw new Error(
      `Fabric route resolver provider generation ${registry.current.generation} `
      + `owned by ${JSON.stringify(registry.current.ownerId)} is still live`,
    );
  }
  const ownerId = options.ownerId ?? randomUUID();
  if (typeof ownerId !== "string" || ownerId.length === 0) {
    throw new TypeError("Fabric route resolver provider ownerId must be non-empty");
  }
  if (!Number.isSafeInteger(registry.nextGeneration)) {
    throw new Error("Fabric route resolver provider generation space is exhausted");
  }
  const generation = registry.nextGeneration++;
  const record: ResolverProviderRecord = { provider, generation, ownerId };
  registry.current = record;

  const dispose = (): void => {
    if (registry.current === record) delete registry.current;
  };
  const registration: FabricRouteResolverProviderRegistration = Object.assign(dispose, {
    provider,
    generation,
    ownerId,
    dispose,
  });
  return registration;
}

/** Return an installed legacy provider; managed hosts use the binding API below. */
export function getFabricRouteResolverProvider(): FabricRouteResolverProvider | undefined {
  const existing = globals[RESOLVER_KEY];
  const provider = isResolverProviderRegistry(existing) ? existing.current?.provider : undefined;
  return typeof provider === "function" ? provider : undefined;
}

/** Capture the current provider generation for one dispatch. */
export function getFabricRouteResolverProviderBinding(): FabricRouteResolverProviderBinding | undefined {
  const existing = globals[RESOLVER_KEY];
  if (!isResolverProviderRegistry(existing) || existing.current === undefined) return undefined;
  const captured = existing.current;
  return {
    generation: captured.generation,
    ownerId: captured.ownerId,
    async acquire(request, signal): Promise<FabricBackendRouteResolverLease | undefined> {
      if (existing.current !== captured) return undefined;
      const acquired = isManagedProvider(captured.provider)
        ? await captured.provider.acquire({
            ...request,
            generation: captured.generation,
            ownerId: captured.ownerId,
          }, signal)
        : captured.provider();
      if (acquired === undefined) return undefined;
      const providerLease = "resolver" in acquired ? acquired : {
        resolver: acquired,
        release: (): void => undefined,
      };
      if (existing.current !== captured) {
        await providerLease.release();
        return undefined;
      }
      let released = false;
      return {
        resolver: providerLease.resolver,
        generation: captured.generation,
        ownerId: captured.ownerId,
        async release(): Promise<void> {
          if (released) return;
          released = true;
          await providerLease.release();
        },
      };
    },
  };
}
