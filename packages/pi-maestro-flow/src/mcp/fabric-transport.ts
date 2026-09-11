import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/sdk/types.js";
import { FabricContractError, assertFabricIdentifier, type FabricMountLeaseV1, type JsonValue } from "pi-maestro-fabric-core/v1";
import type { FabricHttpsDispatchInput } from "../gateway/fabric/https-transport.ts";

export interface FabricMcpDispatchPort {
  dispatch(input: FabricHttpsDispatchInput, signal: AbortSignal): Promise<JsonValue>;
}

export interface FabricMcpClientTransportOptions {
  lease: FabricMountLeaseV1;
  workspaceId: string;
  workspaceGeneration: number;
  dispatcher: FabricMcpDispatchPort;
  validate: () => Promise<void>;
  requestTimeoutMs?: number;
  now?: () => number;
}

function requestIdKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

function objectParams(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asJsonRecord(value: Record<string, unknown>): Readonly<Record<string, JsonValue>> {
  return JSON.parse(JSON.stringify(value)) as Readonly<Record<string, JsonValue>>;
}

/** MCP SDK transport backed by one explicit, route-bound Fabric mount. */
export class FabricMcpClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  readonly sessionId: string;
  readonly #lease: FabricMountLeaseV1;
  readonly #workspaceId: string;
  readonly #workspaceGeneration: number;
  readonly #dispatcher: FabricMcpDispatchPort;
  readonly #validate: () => Promise<void>;
  readonly #requestTimeoutMs: number;
  readonly #now: () => number;
  readonly #pending = new Map<string, AbortController>();
  #started = false;
  #closed = false;

  constructor(options: FabricMcpClientTransportOptions) {
    assertFabricIdentifier(options.workspaceId, "workspaceId");
    if (!Number.isSafeInteger(options.workspaceGeneration) || options.workspaceGeneration < 1) {
      throw new FabricContractError("invalid_argument", "workspaceGeneration must be a positive safe integer", "workspaceGeneration");
    }
    if (options.lease.workspaceGeneration !== undefined && options.lease.workspaceGeneration !== options.workspaceGeneration) {
      throw new FabricContractError("stale_generation", "Fabric MCP transport Workspace generation does not match its mount", "workspaceGeneration");
    }
    const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
      throw new FabricContractError("invalid_argument", "requestTimeoutMs must be a positive safe integer", "requestTimeoutMs");
    }
    this.#lease = structuredClone(options.lease);
    this.#workspaceId = options.workspaceId;
    this.#workspaceGeneration = options.workspaceGeneration;
    this.#dispatcher = options.dispatcher;
    this.#validate = options.validate;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#now = options.now ?? Date.now;
    this.sessionId = options.lease.mountId;
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error("Fabric MCP transport is closed");
    if (this.#started) throw new Error("Fabric MCP transport is already started");
    await this.#validate();
    this.#started = true;
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this.#started || this.#closed) throw new Error("Fabric MCP transport is not connected");
    if (!("method" in message)) return;
    if (!("id" in message)) {
      if (message.method === "notifications/cancelled") {
        const requestId = objectParams(message.params).requestId;
        if (typeof requestId === "string" || typeof requestId === "number") {
          this.#pending.get(requestIdKey(requestId))?.abort(new FabricContractError("cancelled", "MCP request was cancelled"));
        }
      }
      return;
    }

    const id = message.id;
    const controller = new AbortController();
    const key = requestIdKey(id);
    if (this.#pending.has(key)) throw new FabricContractError("conflict", "MCP request identity is already pending", "requestId");
    this.#pending.set(key, controller);
    try {
      const params = objectParams(message.params);
      const deadlineAt = Math.min(this.#lease.expiresAt, this.#now() + this.#requestTimeoutMs);
      if (deadlineAt <= this.#now()) throw new FabricContractError("deadline_exceeded", "Fabric MCP mount has expired", "expiresAt");
      await this.#validate();
      const result = await this.#dispatch(message.method, params, deadlineAt, controller.signal);
      await this.#validate();
      if (this.#closed || this.#pending.get(key) !== controller) return;
      this.onmessage?.({ jsonrpc: "2.0", id, result } as JSONRPCMessage);
    } catch (error) {
      if (this.#closed || this.#pending.get(key) !== controller) return;
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.onmessage?.({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: normalized.message },
      } as JSONRPCMessage);
    } finally {
      if (this.#pending.get(key) === controller) this.#pending.delete(key);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#pending.values()) {
      controller.abort(new FabricContractError("cancelled", "Fabric MCP transport closed"));
    }
    this.#pending.clear();
    this.onclose?.();
  }

  async #dispatch(
    method: string,
    params: Record<string, unknown>,
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const common = {
      routeId: this.#lease.routeId,
      endpointId: this.#lease.endpointId,
      endpointKind: "mcp" as const,
      endpointGeneration: this.#lease.endpointGeneration,
      deadlineAt,
    };
    const workspace = {
      workspaceId: this.#workspaceId,
      workspaceGeneration: this.#workspaceGeneration,
    };
    if (method === "initialize") {
      const initialized = await this.#dispatcher.dispatch({
        ...common,
        operation: "mcp.initialize",
        input: workspace,
      }, signal) as Record<string, JsonValue>;
      return {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-11-25",
        capabilities: initialized.capabilities ?? {},
        serverInfo: initialized.serverVersion ?? { name: this.#lease.serverName, version: "1" },
        ...(typeof initialized.instructions === "string" ? { instructions: initialized.instructions } : {}),
      };
    }
    if (method === "tools/list") {
      return this.#dispatcher.dispatch({
        ...common,
        operation: "mcp.list",
        input: workspace,
      }, signal);
    }
    if (method === "tools/call") {
      if (typeof params.name !== "string" || params.name.length === 0) {
        throw new FabricContractError("invalid_argument", "MCP tool name is required", "name");
      }
      return this.#dispatcher.dispatch({
        ...common,
        operation: "mcp.call",
        input: asJsonRecord({
          ...workspace,
          name: params.name,
          ...(params.arguments === undefined ? {} : { arguments: params.arguments }),
        }),
      }, signal);
    }
    if (method === "resources/list") return { resources: [] };
    if (method === "ping") return {};
    throw new FabricContractError("invalid_argument", `Unsupported Fabric MCP method: ${method}`, "method");
  }
}
