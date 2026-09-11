import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, type StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FabricContractError, assertFabricIdentifier, type JsonValue } from "pi-maestro-fabric-core/v1";
import type { GatewayPolicy } from "../policy.ts";
import type { WorkspaceRegistry } from "../workspace-registry.ts";
import type { FabricEndpointDispatchContext, FabricEndpointHandler } from "./endpoint-dispatcher.ts";

export const FABRIC_MCP_OPERATIONS = ["mcp.initialize", "mcp.list", "mcp.call"] as const;
export type FabricMcpOperation = typeof FABRIC_MCP_OPERATIONS[number];

export interface FabricMcpSourceRegistration {
  readonly endpointId: string;
  readonly url: URL | string;
  readonly workspaceId?: string;
  readonly requestInit?: RequestInit;
  readonly fetch?: StreamableHTTPClientTransportOptions["fetch"];
}

export interface McpEndpointBridgeOptions {
  readonly registry: WorkspaceRegistry;
  readonly policy: GatewayPolicy;
  readonly registrations?: readonly FabricMcpSourceRegistration[];
  readonly maxOutputBytes?: number;
}

type CanonicalMcpSourceRegistration = FabricMcpSourceRegistration & { readonly url: URL };

interface McpClientState {
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;
  readonly connected: Promise<void>;
  readonly endpointGeneration: number;
  readonly source: CanonicalMcpSourceRegistration;
}

function byteLength(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
  catch { return Number.POSITIVE_INFINITY; }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) throw new FabricContractError("invalid_argument", "maxOutputBytes must be a positive safe integer", "maxOutputBytes");
  return result;
}

function requiredString(record: Record<string, JsonValue>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new FabricContractError("invalid_argument", `${key} is required`, key);
  return value;
}

function requiredGeneration(record: Record<string, JsonValue>): number {
  const value = record.workspaceGeneration;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new FabricContractError("invalid_argument", "workspaceGeneration must be a positive safe integer", "workspaceGeneration");
  }
  return value as number;
}

function asJson(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new FabricContractError("protocol_violation", "MCP source returned a non-JSON result");
  return JSON.parse(serialized) as JsonValue;
}

/**
 * Source-side MCP bridge. Fabric owns only the outer route; the SDK Client and
 * StreamableHTTPClientTransport remain the MCP protocol/session authority.
 */
export class McpEndpointBridge implements FabricEndpointHandler {
  readonly #registry: WorkspaceRegistry;
  readonly #policy: GatewayPolicy;
  readonly #registrations = new Map<string, CanonicalMcpSourceRegistration>();
  readonly #clients = new Map<string, McpClientState>();
  readonly #maxOutputBytes: number;

  constructor(options: McpEndpointBridgeOptions) {
    this.#registry = options.registry;
    this.#policy = options.policy;
    this.#maxOutputBytes = positiveLimit(options.maxOutputBytes, 1024 * 1024);
    for (const registration of options.registrations ?? []) this.register(registration);
  }

  register(registration: FabricMcpSourceRegistration): void {
    assertFabricIdentifier(registration.endpointId, "endpointId");
    const url = new URL(registration.url);
    if (url.protocol !== "https:") throw new FabricContractError("permission_denied", "Fabric MCP source URL must use HTTPS", "url");
    if (url.username || url.password || url.hash) throw new FabricContractError("invalid_argument", "Fabric MCP source URL must not contain credentials or a fragment", "url");
    if (this.#registrations.has(registration.endpointId)) throw new FabricContractError("conflict", "Fabric MCP source is already registered", "endpointId");
    this.#registrations.set(registration.endpointId, { ...registration, url });
  }

  async handle(context: FabricEndpointDispatchContext): Promise<JsonValue> {
    if (context.endpoint.kind !== "mcp") throw new FabricContractError("conflict", "MCP bridge requires an MCP Endpoint", "endpointKind");
    const operation = context.request.operation;
    if (!FABRIC_MCP_OPERATIONS.includes(operation as FabricMcpOperation)) {
      throw new FabricContractError("invalid_argument", "Unsupported Fabric MCP operation", "operation");
    }
    const registration = this.#registrations.get(context.endpoint.endpointId);
    if (registration === undefined) throw new FabricContractError("not_found", "Fabric MCP source URL is not registered", "endpointId");

    let callInput: { name: string; arguments?: Record<string, unknown> } | undefined;
    if (operation === "mcp.call") {
      const name = requiredString(context.request.input as Record<string, JsonValue>, "name");
      const supplied = context.request.input.arguments;
      if (supplied !== undefined && (typeof supplied !== "object" || supplied === null || Array.isArray(supplied))) {
        throw new FabricContractError("invalid_argument", "arguments must be a JSON object", "arguments");
      }
      callInput = { name, ...(supplied === undefined ? {} : { arguments: supplied as Record<string, unknown> }) };
    }

    await this.#reauthorize(context, registration);
    const client = await this.#client(registration, context.endpoint.generation, context.signal, context.request.deadlineAt);

    // Client connection is source I/O too. Reauthorize after its await, and for
    // list/call make the MCP invocation the very next operation: no intervening
    // await may reopen the workspace revocation window.
    let result: unknown;
    if (operation === "mcp.initialize") {
      await this.#reauthorize(context, registration);
      result = {
        serverVersion: client.getServerVersion(),
        capabilities: client.getServerCapabilities(),
        instructions: client.getInstructions(),
      };
    } else if (operation === "mcp.list") {
      await this.#reauthorize(context, registration);
      result = await client.listTools(undefined, { signal: context.signal, timeout: this.#remaining(context.request.deadlineAt) });
    } else {
      await this.#reauthorize(context, registration);
      result = await client.callTool(
        callInput!,
        undefined,
        { signal: context.signal, timeout: this.#remaining(context.request.deadlineAt) },
      );
    }

    await this.#reauthorize(context, registration);
    if (byteLength(result) > this.#maxOutputBytes) throw new FabricContractError("resource_exhausted", "Fabric MCP result exceeds maxOutputBytes", "maxOutputBytes");
    return asJson(result);
  }

  async close(): Promise<void> {
    const states = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.allSettled(states.map((state) => state.client.close()));
  }

  async #reauthorize(context: FabricEndpointDispatchContext, registration: CanonicalMcpSourceRegistration): Promise<void> {
    const input = context.request.input as Record<string, JsonValue>;
    const workspaceId = requiredString(input, "workspaceId");
    const workspaceGeneration = requiredGeneration(input);
    if (registration.workspaceId !== undefined && registration.workspaceId !== workspaceId) {
      throw new FabricContractError("permission_denied", "Fabric MCP source is registered for a different workspace", "workspaceId");
    }
    if (context.route.workspaceGeneration !== undefined && context.route.workspaceGeneration !== workspaceGeneration) {
      throw new FabricContractError("stale_generation", "Fabric route workspace generation is stale", "workspaceGeneration");
    }
    const before = await this.#registry.get(workspaceId);
    if (before === undefined) throw new FabricContractError("permission_denied", "Local workspace is not currently registered", "workspaceId");
    if (before.generation !== workspaceGeneration) throw new FabricContractError("stale_generation", "Local workspace generation is stale", "workspaceGeneration");
    const decision = await this.#policy.authorizeWorkspace(context.principal, workspaceId);
    if (!decision.allowed) throw new FabricContractError("permission_denied", `Local workspace authorization failed: ${decision.reason}`, "workspaceId");

    // The final registry read is deliberately the last await in this method.
    // It fences revocation/replacement that occurred during policy evaluation.
    const after = await this.#registry.get(workspaceId);
    if (after === undefined) throw new FabricContractError("permission_denied", "Local workspace was revoked during authorization", "workspaceId");
    if (after.id !== before.id || after.path !== before.path || after.generation !== workspaceGeneration) {
      throw new FabricContractError("stale_generation", "Local workspace changed during authorization", "workspaceGeneration");
    }
    if (this.#registrations.get(context.endpoint.endpointId) !== registration) {
      throw new FabricContractError("stale_generation", "Fabric MCP source registration changed during authorization", "endpointId");
    }
  }

  async #client(registration: CanonicalMcpSourceRegistration, endpointGeneration: number, signal: AbortSignal, deadlineAt: number): Promise<Client> {
    const existing = this.#clients.get(registration.endpointId);
    if (existing !== undefined) {
      if (existing.endpointGeneration !== endpointGeneration || existing.source !== registration) {
        await this.#evict(existing, signal, deadlineAt);
        // Another caller may have installed the replacement while stale close
        // yielded. Re-enter lookup instead of creating a competing client.
        return this.#client(registration, endpointGeneration, signal, deadlineAt);
      }
      try {
        await this.#bounded(existing.connected, signal, deadlineAt);
        if (this.#clients.get(registration.endpointId) !== existing) {
          throw new FabricContractError("stale_generation", "Fabric MCP client ownership changed while connecting", "endpointGeneration");
        }
        return existing.client;
      } catch (error) {
        await this.#evict(existing, signal, deadlineAt);
        throw error;
      }
    }

    this.#remaining(deadlineAt);
    if (signal.aborted) throw new FabricContractError("cancelled", "Fabric MCP operation was cancelled");
    const transport = new StreamableHTTPClientTransport(registration.url, {
      ...(registration.requestInit === undefined ? {} : { requestInit: registration.requestInit }),
      ...(registration.fetch === undefined ? {} : { fetch: registration.fetch }),
      reconnectionOptions: { maxReconnectionDelay: 1000, initialReconnectionDelay: 50, reconnectionDelayGrowFactor: 1.5, maxRetries: 0 },
    });
    const client = new Client({ name: "pi-maestro-fabric-mcp-source", version: "1" });
    const connected = Promise.resolve().then(() => client.connect(transport));
    const state: McpClientState = { client, transport, connected, endpointGeneration, source: registration };
    this.#clients.set(registration.endpointId, state);
    try {
      await this.#bounded(connected, signal, deadlineAt);
      if (this.#clients.get(registration.endpointId) !== state) {
        throw new FabricContractError("stale_generation", "Fabric MCP client ownership changed while connecting", "endpointGeneration");
      }
      return client;
    } catch (error) {
      await this.#evict(state, signal, deadlineAt);
      throw error;
    }
  }

  async #evict(state: McpClientState, signal: AbortSignal, deadlineAt: number): Promise<void> {
    if (this.#clients.get(state.source.endpointId) === state) this.#clients.delete(state.source.endpointId);
    const closing = Promise.resolve().then(() => state.client.close());
    // Start and observe cleanup even when the failed waiter is already aborted;
    // never let a hung close keep a stale cache entry visible.
    closing.catch(() => undefined);
    await this.#bounded(closing, signal, deadlineAt).catch(() => undefined);
  }

  #remaining(deadlineAt: number): number {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new FabricContractError("deadline_exceeded", "Fabric MCP deadline has passed", "deadlineAt");
    return remaining;
  }

  async #bounded<T>(promise: Promise<T>, signal: AbortSignal, deadlineAt: number): Promise<T> {
    const remaining = this.#remaining(deadlineAt);
    if (signal.aborted) throw new FabricContractError("cancelled", "Fabric MCP operation was cancelled");
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = (): void => finish(() => reject(new FabricContractError("cancelled", "Fabric MCP operation was cancelled")));
      const timer = setTimeout(() => finish(() => reject(new FabricContractError("deadline_exceeded", "Fabric MCP deadline has passed", "deadlineAt"))), remaining);
      timer.unref?.();
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
    });
  }
}
