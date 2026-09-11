import {
  FabricContractError,
  projectFabricMount,
  type EndpointRouteHandle,
  type FabricMountLeaseV1,
  type PublicFabricMountLeaseV1,
} from "pi-maestro-fabric-core/v1";
import type { FabricMcpMountProvider } from "pi-maestro-fabric";
import { FabricMcpClientTransport, type FabricMcpDispatchPort } from "./fabric-transport.ts";
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

  constructor(options: FabricMcpMountRegistryOptions) {
    this.#provider = options.provider;
    this.#manager = options.manager;
    this.#resolveTransport = options.resolveTransport;
    this.#onHidden = options.onHidden;
    this.#reservedServerNames = new Set(options.reservedServerNames ?? []);
  }

  async mount(route: EndpointRouteHandle, signal: AbortSignal): Promise<FabricMcpMountedServer> {
    const lease = await this.#provider.mount(route, signal);
    const existing = this.#byMount.get(lease.mountId);
    if (existing !== undefined) {
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
    const record: MountedServerRecord = {
      lease: structuredClone(lease),
      route: structuredClone(route),
      serverName,
      definition,
      references: 1,
    };
    try {
      this.#manager.registerEphemeralServer(serverName, {
        definition,
        create: async () => {
          await this.#provider.validate(lease.mountId, lease.routeRevision);
          const resolved = await this.#resolveTransport(structuredClone(lease), structuredClone(route));
          return new FabricMcpClientTransport({
            lease,
            workspaceId: resolved.workspaceId,
            workspaceGeneration: resolved.workspaceGeneration,
            dispatcher: resolved.dispatcher,
            validate: async () => { await this.#provider.validate(lease.mountId, lease.routeRevision); },
            ...(resolved.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: resolved.requestTimeoutMs }),
          });
        },
      });
    } catch (error) {
      await this.#provider.unmount(lease.mountId);
      throw error;
    }
    this.#byMount.set(lease.mountId, record);
    this.#byServer.set(serverName, record);
    return this.#project(record);
  }

  async validate(mountId: string, expectedRouteRevision?: number): Promise<FabricMcpMountedServer> {
    const record = this.#byMount.get(mountId);
    if (record === undefined) throw new FabricContractError("not_found", "Fabric MCP mount is not registered in this Pi session", "mountId");
    await this.#provider.validate(mountId, expectedRouteRevision ?? record.lease.routeRevision);
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
    const operation = this.#provider.unmount(mountId, async () => {
      this.#byMount.delete(mountId);
      this.#byServer.delete(record.serverName);
      let visibilityFailure: unknown;
      try {
        this.#onHidden?.(record.serverName);
      } catch (error) {
        visibilityFailure = error;
      }
      await this.#manager.unregisterEphemeralServer(record.serverName);
      if (visibilityFailure !== undefined) throw visibilityFailure;
    });
    this.#unmounts.add(operation);
    try {
      await operation;
    } finally {
      this.#unmounts.delete(operation);
    }
  }

  hasServer(serverName: string): boolean {
    return this.#byServer.has(serverName);
  }

  getDefinition(serverName: string): ServerDefinition | undefined {
    return this.#byServer.get(serverName)?.definition;
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
    const records = [...this.#byMount.values()];
    const alreadyUnmounting = [...this.#unmounts];
    const results = await Promise.allSettled([
      ...alreadyUnmounting,
      ...records.map(async (record) => {
        record.references = 1;
        await this.unmount(record.lease.mountId);
      }),
    ]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure !== undefined) throw failure.reason;
  }

  #project(record: MountedServerRecord): FabricMcpMountedServer {
    return {
      lease: projectFabricMount(record.lease),
      serverName: record.serverName,
      references: record.references,
    };
  }
}
