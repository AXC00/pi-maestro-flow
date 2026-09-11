import {
  FabricContractError,
  projectFabricMount,
  type EndpointRouteHandle,
  type FabricMountLeaseV1,
  type PublicFabricMountLeaseV1,
} from "pi-maestro-fabric-core/v1";
import type { FabricMcpMountProvider } from "pi-maestro-fabric";
import { FabricMcpClientTransport, type FabricMcpDispatchPort } from "./fabric-transport.ts";
import {
  combineMcpSignals,
  FabricMcpRouteGuard,
  McpContinuationAuthority,
  type FabricMcpRouteLease,
} from "./fabric-route-guard.ts";
import type { McpServerManager } from "./server-manager.ts";
import type { ServerDefinition } from "./types.ts";

export interface FabricMcpResolvedTransport {
  readonly dispatcher: FabricMcpDispatchPort;
  readonly workspaceId: string;
  readonly workspaceGeneration: number;
  readonly requestTimeoutMs?: number;
}

export interface FabricMcpMountRegistryOptions {
  readonly provider: FabricMcpMountProvider;
  readonly manager: McpServerManager;
  readonly resolveTransport: (
    lease: FabricMountLeaseV1,
    route: EndpointRouteHandle,
  ) => FabricMcpResolvedTransport | Promise<FabricMcpResolvedTransport>;
  readonly onHidden?: (serverName: string) => void;
  readonly reservedServerNames?: Iterable<string>;
}

export interface FabricMcpMountedServer {
  readonly lease: PublicFabricMountLeaseV1;
  readonly serverName: string;
  readonly references: number;
}

interface MountedServerRecord {
  readonly lease: FabricMountLeaseV1;
  readonly route: EndpointRouteHandle;
  readonly serverName: string;
  readonly definition: ServerDefinition;
  readonly guard: FabricMcpRouteGuard;
  references: number;
}

/** Ephemeral MCP server registry. No mount state is written to MCP config or cache. */
export class FabricMcpMountRegistry {
  readonly #provider: FabricMcpMountProvider;
  readonly #manager: McpServerManager;
  readonly #resolveTransport: FabricMcpMountRegistryOptions["resolveTransport"];
  readonly #onHidden?: FabricMcpMountRegistryOptions["onHidden"];
  readonly #reservedServerNames: ReadonlySet<string>;
  readonly #byMount = new Map<string, MountedServerRecord>();
  readonly #byServer = new Map<string, MountedServerRecord>();
  readonly #unmounts = new Set<Promise<void>>();
  readonly #revocations = new WeakMap<MountedServerRecord, Promise<void>>();
  readonly #mounts = new Set<Promise<unknown>>();
  readonly #lifecycle = new McpContinuationAuthority("Fabric MCP mount registry");

  constructor(options: FabricMcpMountRegistryOptions) {
    this.#provider = options.provider;
    this.#manager = options.manager;
    this.#resolveTransport = options.resolveTransport;
    this.#onHidden = options.onHidden;
    this.#reservedServerNames = new Set(options.reservedServerNames ?? []);
  }

  async mount(route: EndpointRouteHandle, signal: AbortSignal): Promise<FabricMcpMountedServer> {
    const registryLease = this.#lifecycle.capture();
    const operation = this.#mount(route, combineMcpSignals(signal, registryLease.signal)!, registryLease);
    this.#mounts.add(operation);
    try {
      return await operation;
    } finally {
      this.#mounts.delete(operation);
    }
  }

  async #mount(
    route: EndpointRouteHandle,
    signal: AbortSignal,
    registryLease: ReturnType<McpContinuationAuthority["capture"]>,
  ): Promise<FabricMcpMountedServer> {
    const lease = await this.#provider.mount(route, signal);
    try {
      registryLease.assertCurrent();
      await this.#provider.validate(lease.mountId, lease.routeRevision);
      registryLease.assertCurrent();
    } catch (error) {
      await this.#provider.unmount(lease.mountId);
      throw error;
    }
    const existing = this.#byMount.get(lease.mountId);
    if (existing !== undefined) {
      existing.guard.capture().assertCurrent();
      existing.references += 1;
      return this.#project(existing);
    }
    const serverName = `${lease.providerNamespace}:${lease.serverName}`;
    if (this.#reservedServerNames.has(serverName) || this.#byServer.has(serverName)) {
      await this.#provider.unmount(lease.mountId);
      throw new FabricContractError("conflict", "Fabric MCP projected server name is already mounted", "serverName");
    }
    const definition: ServerDefinition = {
      lifecycle: "lazy",
      directTools: false,
      exposeResources: false,
    };
    let record!: MountedServerRecord;
    const guard = new FabricMcpRouteGuard({
      mountId: lease.mountId,
      serverName,
      routeRevision: lease.routeRevision,
      mutation: route.operationClass === "mcp-mutation",
      validate: async () => { await this.#provider.validate(lease.mountId, lease.routeRevision); },
      onInvalid: (error) => this.#invalidate(record, error),
    });
    record = {
      lease: structuredClone(lease),
      route: structuredClone(route),
      serverName,
      definition,
      guard,
      references: 1,
    };
    try {
      this.#manager.registerEphemeralServer(serverName, {
        definition,
        routeGuard: guard,
        create: async (createSignal) => {
          const routeLease = guard.capture();
          await routeLease.validateCurrent();
          const resolved = await this.#resolveTransport(structuredClone(lease), structuredClone(route));
          await routeLease.validateCurrent();
          return new FabricMcpClientTransport({
            lease,
            workspaceId: resolved.workspaceId,
            workspaceGeneration: resolved.workspaceGeneration,
            dispatcher: resolved.dispatcher,
            validate: routeLease.validateCurrent,
            signal: combineMcpSignals(createSignal, routeLease.signal),
            mutation: routeLease.mutation,
            ...(resolved.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: resolved.requestTimeoutMs }),
          });
        },
      });
    } catch (error) {
      guard.revoke("Fabric MCP mount registration failed");
      await this.#provider.unmount(lease.mountId);
      throw error;
    }
    registryLease.assertCurrent();
    this.#byMount.set(lease.mountId, record);
    this.#byServer.set(serverName, record);
    return this.#project(record);
  }

  async validate(mountId: string, expectedRouteRevision?: number): Promise<FabricMcpMountedServer> {
    const record = this.#byMount.get(mountId);
    if (record === undefined) throw new FabricContractError("not_found", "Fabric MCP mount is not registered in this Pi session", "mountId");
    if (expectedRouteRevision !== undefined && expectedRouteRevision !== record.lease.routeRevision) {
      throw new FabricContractError("stale_generation", "Fabric MCP mount route revision is stale", "routeRevision");
    }
    await record.guard.capture().validateCurrent();
    return this.#project(record);
  }

  async unmount(mountId: string): Promise<void> {
    const record = this.#byMount.get(mountId);
    if (record === undefined) {
      await this.#provider.unmount(mountId);
      return;
    }
    if (record.references > 1) {
      record.references -= 1;
      await this.#provider.unmount(mountId);
      return;
    }
    await this.#revoke(record, `Fabric MCP mount ${mountId} was unmounted`);
  }

  hasServer(serverName: string): boolean {
    return this.#byServer.get(serverName)?.guard.isCurrent() === true;
  }

  capture(serverName: string): FabricMcpRouteLease | undefined {
    const record = this.#byServer.get(serverName);
    if (record === undefined) return undefined;
    const lease = record.guard.capture();
    lease.assertCurrent();
    return lease;
  }

  getDefinition(serverName: string): ServerDefinition | undefined {
    const record = this.#byServer.get(serverName);
    return record?.guard.isCurrent() === true ? record.definition : undefined;
  }

  getByServer(serverName: string): FabricMcpMountedServer | undefined {
    const record = this.#byServer.get(serverName);
    return record === undefined ? undefined : this.#project(record);
  }

  list(): readonly FabricMcpMountedServer[] {
    return [...this.#byServer.values()]
      .map((record) => this.#project(record))
      .sort((left, right) => left.serverName.localeCompare(right.serverName));
  }

  async closeAll(): Promise<void> {
    this.#lifecycle.revoke("Fabric MCP mount registry closed");
    const records = [...this.#byMount.values()];
    const alreadyUnmounting = [...this.#unmounts];
    const mounting = [...this.#mounts].map((operation) => operation.then(
      () => undefined,
      () => undefined,
    ));
    const results = await Promise.allSettled([
      ...alreadyUnmounting,
      ...mounting,
      ...records.map((record) => this.#revoke(record, "Fabric MCP mount registry closed")),
    ]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure !== undefined) throw failure.reason;
  }

  #invalidate(record: MountedServerRecord, cause: unknown): void {
    if (this.#byMount.get(record.lease.mountId) !== record) return;
    const reason = cause instanceof Error ? cause.message : String(cause);
    void this.#revoke(record, `Fabric MCP mount validation failed: ${reason}`).catch((error) => {
      console.error("MCP: failed to clean up an invalid Fabric mount", error);
    });
  }

  #revoke(record: MountedServerRecord, reason: string): Promise<void> {
    const current = this.#byMount.get(record.lease.mountId);
    if (current !== record) return this.#revocations.get(record) ?? Promise.resolve();
    const releases: Promise<void>[] = [];
    for (let index = 1; index < record.references; index += 1) {
      releases.push(this.#provider.unmount(record.lease.mountId));
    }
    releases.push(this.#provider.unmount(record.lease.mountId, async () => {
      await this.#manager.unregisterEphemeralServer(record.serverName);
    }));
    record.references = 0;
    record.guard.revoke(reason);
    this.#byMount.delete(record.lease.mountId);
    this.#byServer.delete(record.serverName);
    let visibilityFailure: unknown;
    try {
      this.#onHidden?.(record.serverName);
    } catch (error) {
      visibilityFailure = error;
    }
    const operation = Promise.all(releases).then(() => {
      if (visibilityFailure !== undefined) throw visibilityFailure;
    });
    this.#unmounts.add(operation);
    this.#revocations.set(record, operation);
    void operation.then(
      () => {
        this.#unmounts.delete(operation);
        this.#revocations.delete(record);
      },
      () => {
        this.#unmounts.delete(operation);
        this.#revocations.delete(record);
      },
    );
    return operation;
  }

  #project(record: MountedServerRecord): FabricMcpMountedServer {
    return {
      lease: projectFabricMount(record.lease),
      serverName: record.serverName,
      references: record.references,
    };
  }
}
