import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";
import type { ClientChannel } from "ssh2";
import {
  DEFAULT_SSH_TIMEOUT_SECONDS,
  type SshCommandChannel,
  type SshExecutor,
} from "./executor.ts";
import { SSH_GATEWAY_COMMAND } from "./guide.ts";
import {
  GatewaySessionLauncher,
  type GatewayLaunchBindingPersistence,
  type SshStartPiInput,
} from "./gateway-session-launch.ts";
import type { TodoTask } from "../tools/todo.ts";
import type { SshGatewayBinding, SshGatewayLaunchBinding, SshHost } from "./model.ts";
import { GatewayObserver, type GatewayObservationSink } from "../gateway/observability.ts";
import {
  classifyGatewayOperation,
  gatewayOperationMayReplay,
  type GatewayOperationPolicy,
} from "../gateway/operation-policy.ts";
import {
  GATEWAY_EVENT_NOTIFICATION_METHOD,
  type GatewayEventGap,
  type GatewayEventNotification,
} from "../gateway/event-contracts.ts";

const DEFAULT_POOL_SIZE = 4;
const MAX_STDIO_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MONITOR_STREAM_FEATURE = "monitor-stream-v1";
const MONITOR_RECONNECT_MIN_MS = 250;
const MONITOR_RECONNECT_MAX_MS = 5_000;
const MONITOR_RENEW_WINDOW_MS = 30_000;
const MAX_BUFFERED_MONITOR_NOTIFICATIONS = 128;

export type SshGatewayInput =
  | { action: "guide" }
  | { action: "status" }
  | { action: "list" }
  | { action: "describe"; tool: string }
  | { action: "call"; tool: string; args?: Record<string, unknown>; timeout?: number }
  | SshStartPiInput;

export interface SshGatewayStartPiContext {
  readonly piSessionRef: string;
  readonly todos: readonly TodoTask[];
}

export interface SshGatewayActionResult {
  readonly action: SshGatewayInput["action"];
  readonly tool?: string;
  readonly data: unknown;
  readonly text: string;
  readonly isError?: boolean;
  readonly summary: string;
  readonly durationMs: number;
}

export class SshGatewayCapabilityError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      `Pi Maestro Gateway is unavailable on the selected SSH server. Install and start it there, then verify \`${SSH_GATEWAY_COMMAND}\`. No shell fallback was attempted.`,
      options,
    );
    this.name = "SshGatewayCapabilityError";
  }
}

export class GatewayOutcomeUnknownError extends Error {
  readonly code = "gateway_outcome_unknown" as const;
  readonly retryable = false;

  constructor(readonly operation: GatewayOperationPolicy, options?: ErrorOptions) {
    const action = operation.action === undefined ? operation.tool : `${operation.tool}.${operation.action}`;
    super(`gateway_outcome_unknown: ${action} may have reached the Gateway; it was not replayed on another transport`, options);
    this.name = "GatewayOutcomeUnknownError";
  }
}

const MCP_LIST_OPERATION: GatewayOperationPolicy = { retryClass: "read", tool: "$mcp", action: "tools/list" };

interface GatewayPoolEntry {
  readonly key: string;
  readonly hostId: string;
  readonly hostDigest: string;
  readonly client: Client;
  readonly transport: Transport;
  readonly mode: "https" | "stdio";
  readonly endpointIdentity: string;
}

export interface SshGatewayMonitorEvent {
  readonly binding: Extract<SshGatewayLaunchBinding, { version: 2 }>;
  readonly notification: GatewayEventNotification["params"];
}

export interface SshGatewayMonitorGap {
  readonly binding: Extract<SshGatewayLaunchBinding, { version: 2 }>;
  readonly gap: GatewayEventGap;
}

export interface SshGatewayMonitorStatus {
  readonly binding: Extract<SshGatewayLaunchBinding, { version: 2 }>;
  readonly status: "connected" | "reconnecting" | "unsupported" | "error";
  readonly error?: string;
}

export interface SshGatewayMonitorSink {
  onEvent(event: SshGatewayMonitorEvent): void | Promise<void>;
  onGap?(event: SshGatewayMonitorGap): void | Promise<void>;
  onStatus?(event: SshGatewayMonitorStatus): void | Promise<void>;
}

export interface SshGatewayResumeTarget {
  readonly host: SshHost;
  readonly effectiveDigest: string;
  readonly cacheFence?: string;
}

interface DesiredMonitor {
  readonly bindingId: string;
  readonly generation: number;
  readonly piSessionRef: string;
  readonly host: SshHost;
  readonly effectiveDigest: string;
  readonly cacheFence: string;
  readonly timeoutSeconds: number;
}

interface ActiveMonitorSubscription {
  readonly subscriptionId: string;
  readonly bindingId: string;
  readonly generation: number;
  readonly handle: string;
  readonly entry: GatewayPoolEntry;
  tail: Promise<void>;
}

export interface SshGatewayBindingSource extends Partial<GatewayLaunchBindingPersistence> {
  getGatewayBinding(hostId: string): SshGatewayBinding | undefined;
  getGatewayLaunchBinding?(hostId: string, bindingId: string): SshGatewayLaunchBinding | undefined;
  getGatewayLaunchBindings?(piSessionRef?: string): SshGatewayLaunchBinding[];
}

export interface SshGatewayClientPoolOptions {
  maxEntries?: number;
  bindingSource?: SshGatewayBindingSource;
  fetch?: typeof fetch;
  now?: () => number;
  observer?: GatewayObservationSink;
  monitorSink?: SshGatewayMonitorSink;
}

/** A bounded pool of initialized MCP clients, isolated by SSH host id and full host digest. */
export class SshGatewayClientPool {
  private readonly entries = new Map<string, Promise<GatewayPoolEntry>>();
  private readonly launches: GatewaySessionLauncher;
  private readonly hostFences = new Map<string, string>();
  private readonly hostEpochs = new Map<string, number>();
  private poolEpoch = 0;
  private readonly maxEntries: number;
  private readonly bindingSource?: SshGatewayBindingSource;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private monitorSink?: SshGatewayMonitorSink;
  private readonly desiredMonitors = new Map<string, DesiredMonitor>();
  private readonly monitorSubscriptions = new Map<string, ActiveMonitorSubscription>();
  private readonly monitorSubscriptionByBinding = new Map<string, string>();
  private readonly bufferedMonitorNotifications = new Map<string, GatewayEventNotification["params"][]>();
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly renewalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingMonitorSubscriptions = 0;
  readonly observer: GatewayObservationSink;

  constructor(
    private readonly executor: Pick<SshExecutor, "openChannel">,
    options: SshGatewayClientPoolOptions = {},
  ) {
    const maxEntries = options.maxEntries ?? DEFAULT_POOL_SIZE;
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 32) {
      throw new Error("SSH Gateway client pool size must be an integer between 1 and 32");
    }
    this.maxEntries = maxEntries;
    this.bindingSource = options.bindingSource;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.observer = options.observer ?? new GatewayObserver();
    this.monitorSink = options.monitorSink;
    const persistence = options.bindingSource
      && options.bindingSource.getGatewayLaunchBinding
      && options.bindingSource.saveGatewayLaunchBinding
      ? options.bindingSource as GatewayLaunchBindingPersistence
      : undefined;
    this.launches = new GatewaySessionLauncher(this.now, persistence);
  }

  get size(): number {
    return this.entries.size;
  }

  setMonitorSink(sink: SshGatewayMonitorSink | undefined): void {
    this.monitorSink = sink;
  }

  async resumeMonitorSession(piSessionRef: string, targets: readonly SshGatewayResumeTarget[]): Promise<void> {
    if (!this.monitorSink || !this.bindingSource?.getGatewayLaunchBindings) return;
    const byHost = new Map(targets.map((target) => [target.host.id, target]));
    const bindings = this.bindingSource.getGatewayLaunchBindings(piSessionRef)
      .filter((binding): binding is Extract<SshGatewayLaunchBinding, { version: 2 }> => binding.version === 2);
    for (const binding of bindings) {
      const target = byHost.get(binding.hostId);
      if (!target || target.effectiveDigest !== binding.effectiveHostDigest) continue;
      const desired = this.desiredFor(binding, target.host, target.effectiveDigest, target.cacheFence ?? target.effectiveDigest, DEFAULT_SSH_TIMEOUT_SECONDS);
      this.desiredMonitors.set(binding.bindingId, desired);
      await this.ensureMonitorSubscription(desired).catch((error) => {
        void this.publishMonitorStatus(binding, "error", error);
        this.scheduleMonitorReconnect(binding.hostId);
      });
    }
  }

  async pauseMonitorSession(piSessionRef: string): Promise<void> {
    const bindingIds = [...this.desiredMonitors.values()]
      .filter((desired) => desired.piSessionRef === piSessionRef)
      .map((desired) => desired.bindingId);
    await Promise.all(bindingIds.map((bindingId) => this.unsubscribeBinding(bindingId)));
    for (const bindingId of bindingIds) this.desiredMonitors.delete(bindingId);
    for (const [hostId, timer] of this.reconnectTimers) {
      if ([...this.desiredMonitors.values()].some((desired) => desired.host.id === hostId)) continue;
      clearTimeout(timer);
      this.reconnectTimers.delete(hostId);
      this.reconnectAttempts.delete(hostId);
    }
  }

  async execute(
    host: SshHost,
    effectiveDigest: string,
    input: Exclude<SshGatewayInput, { action: "guide" }>,
    signal?: AbortSignal,
    startPiContext?: SshGatewayStartPiContext,
    cacheFence = effectiveDigest,
  ): Promise<SshGatewayActionResult> {
    const startedAt = Date.now();
    const timeoutSeconds = input.action === "call" || input.action === "start_pi"
      ? input.timeout ?? DEFAULT_SSH_TIMEOUT_SECONDS
      : DEFAULT_SSH_TIMEOUT_SECONDS;
    const requestOptions = {
      signal,
      timeout: timeoutSeconds * 1000,
      maxTotalTimeout: timeoutSeconds * 1000,
    };
    let entry = await this.acquire(host, effectiveDigest, cacheFence, timeoutSeconds, signal);
    let reconnects = 0;
    const invoke = async <T>(operation: (client: Client) => Promise<T>, policy: GatewayOperationPolicy): Promise<T> => {
      try { return await operation(entry.client); }
      catch (error) {
        if (entry.mode !== "https") throw error;
        if (isHttpSessionLoss(error)) this.observer.observe({ category: "transport", event: "session-loss" });
        if (!gatewayOperationMayReplay(policy)) {
          if (!isOutcomeUncertainFailure(error)) throw error;
          await this.retireEntry(entry);
          throw new GatewayOutcomeUnknownError(policy, { cause: error });
        }
        if (reconnects >= 1 || !isReplayableTransportFailure(error)) throw error;
        reconnects += 1;
        await this.retireEntry(entry);
        entry = await this.acquire(host, effectiveDigest, cacheFence, timeoutSeconds, signal);
        try { return await operation(entry.client); }
        catch (retryError) {
          if (entry.mode !== "https" || !isTransientServerFailure(retryError)) throw retryError;
          await this.retireEntry(entry);
          this.observer.observe({ category: "transport", event: "fallback" });
          entry = await this.publishStdioReplacement(host, effectiveDigest, cacheFence, timeoutSeconds, signal);
          return operation(entry.client);
        }
      }
    };
    const callGateway = (tool: string, args: Record<string, unknown>, timeout: number, requestSignal?: AbortSignal) => invoke((client) => client.callTool(
      { name: tool, arguments: args }, undefined,
      { signal: requestSignal, timeout: timeout * 1000, maxTotalTimeout: timeout * 1000 },
    ), classifyGatewayOperation(tool, args));
    let data: unknown;
    let isError = false;
    let summary: string;

    if (input.action === "start_pi") {
      if (!startPiContext) throw new Error("start_pi requires the current host Pi session context");
      data = await this.launches.start(
        async (tool, args, timeout, requestSignal) => decodeGatewayEnvelope(await callGateway(tool, args, timeout, requestSignal)),
        host.id, effectiveDigest, startPiContext.piSessionRef, startPiContext.todos, input, signal, entry.endpointIdentity,
      );
      const launch = data as { binding: { bindingId: string; generation: number; piSessionRef: string }; executionHandle: string };
      const stored = this.bindingSource?.getGatewayLaunchBinding?.(host.id, launch.binding.bindingId);
      if (this.monitorSink && stored?.version === 2) {
        const desired = this.desiredFor(stored, host, effectiveDigest, cacheFence, timeoutSeconds);
        this.desiredMonitors.set(stored.bindingId, desired);
        await this.subscribeMonitor(entry, desired).catch((error) => {
          void this.publishMonitorStatus(stored, "error", error);
          this.scheduleMonitorReconnect(host.id);
        });
      }
      summary = `Pi execution ${launch.executionHandle} · monitor ready`;
    } else if (input.action === "status") {
      const listed = await invoke((client) => client.listTools({}, requestOptions), MCP_LIST_OPERATION);
      data = { connected: true, command: SSH_GATEWAY_COMMAND, server: entry.client.getServerVersion(), tools: listed.tools.map((tool) => tool.name) };
      summary = `gateway connected · ${listed.tools.length} tools`;
    } else if (input.action === "list") {
      const listed = await invoke((client) => client.listTools({}, requestOptions), MCP_LIST_OPERATION);
      data = { tools: listed.tools };
      summary = `${listed.tools.length} gateway tools`;
    } else if (input.action === "describe") {
      const listed = await invoke((client) => client.listTools({}, requestOptions), MCP_LIST_OPERATION);
      const tool = listed.tools.find((candidate) => candidate.name === input.tool);
      if (!tool) throw new Error(`Gateway tool ${JSON.stringify(input.tool)} is not available`);
      data = tool;
      summary = `gateway tool ${input.tool}`;
    } else {
      if (input.tool === "monitor") {
        await this.launches.restoreMonitorBinding(
          async (tool, args, timeout, requestSignal) => decodeGatewayEnvelope(await callGateway(tool, args, timeout, requestSignal)),
          host.id, effectiveDigest, entry.endpointIdentity, input.args ?? {}, timeoutSeconds, signal,
        );
      }
      const prepared = input.tool === "monitor" ? this.launches.prepareMonitorCall(host.id, effectiveDigest, input.args ?? {}) : { args: input.args ?? {}, record: undefined };
      if (input.tool === "monitor" && prepared.record) {
        await this.launches.refreshMonitorLease(async (tool, args, timeout, requestSignal) => decodeGatewayEnvelope(await callGateway(tool, args, timeout, requestSignal)), prepared.record, timeoutSeconds, signal);
      }
      const result = await invoke(
        (client) => client.callTool({ name: input.tool, arguments: prepared.args }, undefined, requestOptions),
        classifyGatewayOperation(input.tool, prepared.args),
      );
      data = result;
      isError = result.isError === true;
      if (!isError && input.tool === "monitor" && (prepared.args.action === "observe" || prepared.args.action === "result")) {
        await this.launches.updateMonitorCursor(prepared.record, decodeGatewayEnvelope(result), prepared.args.action);
      }
      summary = `${input.tool} · ${isError ? "failed" : "completed"}`;
    }

    return {
      action: input.action,
      ...(input.action === "describe" || input.action === "call" ? { tool: input.tool } : {}),
      data,
      text: JSON.stringify(data, null, 2),
      ...(isError ? { isError: true } : {}),
      summary,
      durationMs: Date.now() - startedAt,
    };
  }

  async invalidateHost(hostId: string): Promise<void> {
    this.hostEpochs.set(hostId, (this.hostEpochs.get(hostId) ?? 0) + 1);
    this.launches.invalidateHost(hostId);
    this.hostFences.delete(hostId);
    for (const [bindingId, desired] of this.desiredMonitors) if (desired.host.id === hostId) this.desiredMonitors.delete(bindingId);
    const reconnectTimer = this.reconnectTimers.get(hostId);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    this.reconnectTimers.delete(hostId);
    this.reconnectAttempts.delete(hostId);
    const prefix = `${hostId}\0`;
    const matches = [...this.entries.entries()].filter(([key]) => key.startsWith(prefix));
    for (const [key] of matches) this.entries.delete(key);
    await this.closePending(matches.map(([, pending]) => pending));
  }

  async close(): Promise<void> {
    this.poolEpoch += 1;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    for (const timer of this.renewalTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    this.reconnectAttempts.clear();
    this.renewalTimers.clear();
    this.desiredMonitors.clear();
    this.monitorSubscriptions.clear();
    this.monitorSubscriptionByBinding.clear();
    this.bufferedMonitorNotifications.clear();
    const pending = [...this.entries.values()];
    this.entries.clear();
    this.launches.clear();
    this.hostFences.clear();
    await this.closePending(pending);
  }

  private async acquire(
    host: SshHost,
    effectiveDigest: string,
    cacheFence: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<GatewayPoolEntry> {
    const key = poolKey(host.id, cacheFence);
    const existing = this.entries.get(key);
    if (existing) return existing;

    const retired: Promise<GatewayPoolEntry>[] = [];
    const previousFence = this.hostFences.get(host.id);
    if (previousFence !== undefined && previousFence !== cacheFence) {
      this.hostEpochs.set(host.id, (this.hostEpochs.get(host.id) ?? 0) + 1);
      this.launches.invalidateHost(host.id);
      const prefix = `${host.id}\0`;
      for (const [staleKey, stale] of this.entries) {
        if (!staleKey.startsWith(prefix)) continue;
        this.entries.delete(staleKey);
        retired.push(stale);
      }
    }
    this.hostFences.set(host.id, cacheFence);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.entries().next().value as [string, Promise<GatewayPoolEntry>] | undefined;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      retired.push(oldest[1]);
    }

    const hostEpoch = this.hostEpochs.get(host.id) ?? 0;
    const poolEpoch = this.poolEpoch;
    let pending!: Promise<GatewayPoolEntry>;
    pending = this.createAdmittedEntry(
      key,
      host,
      effectiveDigest,
      timeoutSeconds,
      retired,
      () => this.entries.get(key) === pending
        && this.poolEpoch === poolEpoch
        && (this.hostEpochs.get(host.id) ?? 0) === hostEpoch,
      signal,
    );
    this.entries.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.entries.get(key) === pending) this.entries.delete(key);
      if (signal?.aborted) throw error;
      throw new SshGatewayCapabilityError({ cause: error });
    }
  }

  private async createAdmittedEntry(
    key: string,
    host: SshHost,
    effectiveDigest: string,
    timeoutSeconds: number,
    retired: readonly Promise<GatewayPoolEntry>[],
    isCurrent: () => boolean,
    signal?: AbortSignal,
  ): Promise<GatewayPoolEntry> {
    await this.closePending(retired);
    if (!isCurrent()) throw new Error("SSH Gateway client admission was invalidated");
    const entry = await this.createEntry(key, host, effectiveDigest, timeoutSeconds, signal);
    if (isCurrent()) return entry;
    await entry.client.close().catch(() => undefined);
    throw new Error("SSH Gateway client admission was invalidated");
  }

  private async createEntry(
    key: string,
    host: SshHost,
    effectiveDigest: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<GatewayPoolEntry> {
    const binding = this.bindingSource?.getGatewayBinding(host.id);
    if (!binding) return this.createStdioEntry(key, host, effectiveDigest, timeoutSeconds, signal);
    if (binding.effectiveHostDigest !== effectiveDigest) throw new Error("SSH Gateway binding no longer matches the effective host configuration");
    if (binding.expiresAt <= this.now()) throw new Error("SSH Gateway pairing has expired");
    try {
      return await this.createHttpEntry(key, host.id, binding, timeoutSeconds, signal);
    } catch (error) {
      if (!allowsStdioFallback(error)) throw error;
      this.observer.observe({ category: "transport", event: "fallback" });
      return this.createStdioEntry(key, host, effectiveDigest, timeoutSeconds, signal);
    }
  }

  private async createHttpEntry(key: string, hostId: string, binding: SshGatewayBinding, timeoutSeconds: number, signal?: AbortSignal): Promise<GatewayPoolEntry> {
    const requestController = new AbortController();
    const abort = (): void => requestController.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => requestController.abort(new Error("Gateway HTTPS request timed out")), timeoutSeconds * 1000);
    let transport!: StreamableHTTPClientTransport;
    const classifiedFetch: typeof fetch = async (input, init) => {
      try {
        const requestSignal = init?.signal ? AbortSignal.any([requestController.signal, init.signal]) : requestController.signal;
        const response = await this.fetchImpl(input, { ...init, signal: requestSignal });
        if ([401, 403].includes(response.status)) { await response.body?.cancel(); throw new GatewayHttpFailure("auth", response.status); }
        if ([404, 405].includes(response.status) && String(init?.method ?? "GET").toUpperCase() === "POST") { await response.body?.cancel(); throw new GatewayHttpFailure("protocol", response.status); }
        if (response.status >= 500) { await response.body?.cancel(); throw new GatewayHttpFailure("server", response.status); }
        return response;
      } catch (error) {
        if (error instanceof GatewayHttpFailure) throw error;
        throw classifyNetworkFailure(error);
      }
    };
    transport = new StreamableHTTPClientTransport(new URL(binding.endpoint), {
      requestInit: { headers: { authorization: `Bearer ${binding.token}` } },
      fetch: classifiedFetch,
      reconnectionOptions: { initialReconnectionDelay: 100, maxReconnectionDelay: 500, reconnectionDelayGrowFactor: 1, maxRetries: 1 },
    });
    this.bindDisconnect(key, transport);
    const client = new Client({ name: "pi-maestro-flow-ssh", version: "1" });
    let entry: GatewayPoolEntry | undefined;
    client.fallbackNotificationHandler = async (notification) => {
      if (entry) await this.handleMonitorNotification(entry, notification);
    };
    try {
      await client.connect(transport, { signal: requestController.signal, timeout: timeoutSeconds * 1000, maxTotalTimeout: timeoutSeconds * 1000 });
      await verifyGatewayIdentity(client, { signal: requestController.signal, timeout: timeoutSeconds * 1000, maxTotalTimeout: timeoutSeconds * 1000 });
      this.observer.observe({ category: "transport", event: "connect", transport: "https" });
      entry = { key, hostId, hostDigest: binding.effectiveHostDigest, client, transport, mode: "https", endpointIdentity: gatewayEndpointIdentity(binding) };
      return entry;
    } catch (error) {
      await client.close().catch(() => transport.close());
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  private async createStdioEntry(key: string, host: SshHost, effectiveDigest: string, timeoutSeconds: number, signal?: AbortSignal): Promise<GatewayPoolEntry> {
    const handle = await this.executor.openChannel(host, { command: SSH_GATEWAY_COMMAND, timeout: timeoutSeconds }, { signal });
    if (handle.effectiveDigest !== undefined && handle.effectiveDigest !== effectiveDigest) {
      handle.close();
      throw new Error("SSH Gateway connection chain changed while opening");
    }
    const transport = new SshGatewayTransport(handle, () => this.dropDisconnected(key, transport));
    const client = new Client({ name: "pi-maestro-flow-ssh", version: "1" });
    let entry: GatewayPoolEntry | undefined;
    client.fallbackNotificationHandler = async (notification) => {
      if (entry) await this.handleMonitorNotification(entry, notification);
    };
    try {
      await client.connect(transport, { signal, timeout: timeoutSeconds * 1000, maxTotalTimeout: timeoutSeconds * 1000 });
      await verifyGatewayIdentity(client, { signal, timeout: timeoutSeconds * 1000, maxTotalTimeout: timeoutSeconds * 1000 });
      this.observer.observe({ category: "transport", event: "connect", transport: "stdio" });
      entry = { key, hostId: host.id, hostDigest: effectiveDigest, client, transport, mode: "stdio", endpointIdentity: gatewayEndpointIdentity() };
      return entry;
    } catch (error) {
      await client.close().catch(() => transport.close());
      throw error;
    }
  }

  private bindDisconnect(key: string, transport: Transport): void {
    const prior = transport.onclose;
    transport.onclose = () => { prior?.(); this.dropDisconnected(key, transport); };
  }

  private dropDisconnected(key: string, transport: Transport): void {
    const current = this.entries.get(key);
    if (!current) return;
    void current.then((entry) => {
      if (entry.transport !== transport || this.entries.get(key) !== current) return;
      this.entries.delete(key);
      this.retireMonitorSubscriptions(entry);
      this.scheduleMonitorReconnect(entry.hostId);
    }, () => { if (this.entries.get(key) === current) this.entries.delete(key); });
  }

  private async retireEntry(entry: GatewayPoolEntry): Promise<void> {
    const pending = this.entries.get(entry.key);
    if (pending) this.entries.delete(entry.key);
    this.retireMonitorSubscriptions(entry);
    this.scheduleMonitorReconnect(entry.hostId);
    await entry.client.close().catch(() => entry.transport.close());
  }

  private async publishStdioReplacement(host: SshHost, effectiveDigest: string, cacheFence: string, timeoutSeconds: number, signal?: AbortSignal): Promise<GatewayPoolEntry> {
    const key = poolKey(host.id, cacheFence);
    const hostEpoch = this.hostEpochs.get(host.id) ?? 0;
    const poolEpoch = this.poolEpoch;
    const entry = await this.createStdioEntry(key, host, effectiveDigest, timeoutSeconds, signal);
    if (poolEpoch !== this.poolEpoch || hostEpoch !== (this.hostEpochs.get(host.id) ?? 0) || this.entries.has(key)) {
      await entry.client.close().catch(() => undefined);
      throw new Error("SSH Gateway reconnect fallback was invalidated");
    }
    this.entries.set(key, Promise.resolve(entry));
    return entry;
  }

  private desiredFor(
    binding: Extract<SshGatewayLaunchBinding, { version: 2 }>,
    host: SshHost,
    effectiveDigest: string,
    cacheFence: string,
    timeoutSeconds: number,
  ): DesiredMonitor {
    return {
      bindingId: binding.bindingId,
      generation: binding.generation,
      piSessionRef: binding.piSessionRef,
      host: structuredClone(host),
      effectiveDigest,
      cacheFence,
      timeoutSeconds,
    };
  }

  private async ensureMonitorSubscription(desired: DesiredMonitor): Promise<void> {
    const entry = await this.acquire(desired.host, desired.effectiveDigest, desired.cacheFence, desired.timeoutSeconds);
    await this.subscribeMonitor(entry, desired);
  }

  private async subscribeMonitor(entry: GatewayPoolEntry, desired: DesiredMonitor): Promise<void> {
    const currentSubscriptionId = this.monitorSubscriptionByBinding.get(desired.bindingId);
    const currentSubscription = currentSubscriptionId ? this.monitorSubscriptions.get(currentSubscriptionId) : undefined;
    if (currentSubscription?.entry === entry) return;
    if (!this.monitorSink) return;
    const capabilities = entry.client.getServerCapabilities();
    const experimental = capabilities?.experimental as Record<string, unknown> | undefined;
    const binding = this.bindingSource?.getGatewayLaunchBinding?.(entry.hostId, desired.bindingId);
    if (!binding || binding.version !== 2 || binding.generation !== desired.generation) {
      throw new Error("SSH launch Monitor binding is unavailable");
    }
    if (binding.effectiveHostDigest !== desired.effectiveDigest || binding.endpointIdentity !== entry.endpointIdentity) {
      throw new Error("SSH launch Monitor connection fence changed");
    }
    if (!experimental || !(MONITOR_STREAM_FEATURE in experimental)) {
      await this.publishMonitorStatus(binding, "unsupported");
      return;
    }
    const caller = async (tool: string, args: Record<string, unknown>, timeout: number, signal?: AbortSignal): Promise<unknown> => {
      const result = await entry.client.callTool(
        { name: tool, arguments: args },
        undefined,
        { signal, timeout: timeout * 1000, maxTotalTimeout: timeout * 1000 },
      );
      return decodeGatewayEnvelope(result);
    };
    const fence = { bindingId: binding.bindingId, generation: binding.generation };
    const launchArgs = {
      action: "subscribe",
      sessionId: binding.gatewaySessionId,
      memberId: binding.gatewayMemberId,
      handle: binding.executionHandle,
      cursor: binding.eventCursor,
      _sshLaunch: fence,
    };
    await this.launches.restoreMonitorBinding(caller, entry.hostId, desired.effectiveDigest, entry.endpointIdentity, launchArgs, desired.timeoutSeconds);
    const prepared = this.launches.prepareMonitorCall(entry.hostId, desired.effectiveDigest, launchArgs);
    await this.launches.refreshMonitorLease(caller, prepared.record, desired.timeoutSeconds);
    const currentBinding = this.bindingSource?.getGatewayLaunchBinding?.(entry.hostId, desired.bindingId);
    if (!currentBinding || currentBinding.version !== 2 || currentBinding.generation !== desired.generation) {
      throw new Error("SSH launch Monitor binding changed during subscription");
    }
    this.pendingMonitorSubscriptions += 1;
    let envelope: unknown;
    try {
      envelope = await caller("monitor", prepared.args, desired.timeoutSeconds);
    } finally {
      this.pendingMonitorSubscriptions -= 1;
    }
    const subscription = parseMonitorSubscription(envelope, currentBinding.executionHandle, currentBinding.gatewayPrincipalId);
    if (currentSubscription) {
      this.monitorSubscriptions.delete(currentSubscription.subscriptionId);
      if (this.monitorSubscriptionByBinding.get(currentSubscription.bindingId) === currentSubscription.subscriptionId) {
        this.monitorSubscriptionByBinding.delete(currentSubscription.bindingId);
      }
      await this.unsubscribeSubscription(currentSubscription);
    }
    const active: ActiveMonitorSubscription = {
      subscriptionId: subscription.subscriptionId,
      bindingId: binding.bindingId,
      generation: binding.generation,
      handle: currentBinding.executionHandle,
      entry,
      tail: Promise.resolve(),
    };
    this.monitorSubscriptions.set(active.subscriptionId, active);
    this.monitorSubscriptionByBinding.set(active.bindingId, active.subscriptionId);
    this.reconnectAttempts.delete(entry.hostId);
    await this.publishMonitorStatus(currentBinding, "connected");
    if (subscription.gap) {
      await this.monitorSink.onGap?.({ binding: currentBinding, gap: subscription.gap });
      await this.launches.advanceEventCursor(entry.hostId, desired.effectiveDigest, currentBinding.bindingId, currentBinding.generation, subscription.gap.resumeCursor, true);
    }
    const buffered = this.bufferedMonitorNotifications.get(active.subscriptionId) ?? [];
    this.bufferedMonitorNotifications.delete(active.subscriptionId);
    for (const notification of buffered) this.enqueueMonitorNotification(active, notification);
    this.scheduleMonitorRenewal(currentBinding);
  }

  private async handleMonitorNotification(entry: GatewayPoolEntry, notification: unknown): Promise<void> {
    const parsed = parseMonitorNotification(notification);
    if (!parsed) return;
    const active = this.monitorSubscriptions.get(parsed.subscriptionId);
    if (!active) {
      if (this.pendingMonitorSubscriptions <= 0) return;
      const buffered = this.bufferedMonitorNotifications.get(parsed.subscriptionId) ?? [];
      if (buffered.length < MAX_BUFFERED_MONITOR_NOTIFICATIONS) buffered.push(parsed);
      this.bufferedMonitorNotifications.set(parsed.subscriptionId, buffered);
      return;
    }
    if (active.entry !== entry || active.handle !== parsed.handle) return;
    this.enqueueMonitorNotification(active, parsed);
  }

  private enqueueMonitorNotification(active: ActiveMonitorSubscription, notification: GatewayEventNotification["params"]): void {
    active.tail = active.tail.then(async () => {
      const desired = this.desiredMonitors.get(active.bindingId);
      const binding = desired && this.bindingSource?.getGatewayLaunchBinding?.(desired.host.id, active.bindingId);
      if (!desired || !binding || binding.version !== 2 || binding.generation !== active.generation) return;
      if (notification.cursor <= binding.eventCursor) return;
      if (notification.cursor !== binding.eventCursor + 1) {
        await this.monitorSink?.onGap?.({
          binding,
          gap: {
            reason: "connection-closed",
            fromCursor: binding.eventCursor + 1,
            toCursor: notification.cursor - 1,
            resumeCursor: binding.eventCursor,
          },
        });
        await this.unsubscribeBinding(binding.bindingId);
        this.scheduleMonitorReconnect(binding.hostId);
        return;
      }
      await this.monitorSink?.onEvent({ binding, notification });
      await this.launches.advanceEventCursor(binding.hostId, binding.effectiveHostDigest, binding.bindingId, binding.generation, notification.cursor);
    }).catch(async (error) => {
      const desired = this.desiredMonitors.get(active.bindingId);
      const binding = desired && this.bindingSource?.getGatewayLaunchBinding?.(desired.host.id, active.bindingId);
      if (binding?.version === 2) await this.publishMonitorStatus(binding, "error", error);
      await this.unsubscribeBinding(active.bindingId);
      if (desired) this.scheduleMonitorReconnect(desired.host.id);
    });
  }

  private retireMonitorSubscriptions(entry: GatewayPoolEntry): void {
    for (const subscription of [...this.monitorSubscriptions.values()]) {
      if (subscription.entry !== entry) continue;
      this.monitorSubscriptions.delete(subscription.subscriptionId);
      if (this.monitorSubscriptionByBinding.get(subscription.bindingId) === subscription.subscriptionId) {
        this.monitorSubscriptionByBinding.delete(subscription.bindingId);
      }
      const desired = this.desiredMonitors.get(subscription.bindingId);
      const binding = desired && this.bindingSource?.getGatewayLaunchBinding?.(desired.host.id, subscription.bindingId);
      if (binding?.version === 2) void this.publishMonitorStatus(binding, "reconnecting");
    }
  }

  private async unsubscribeBinding(bindingId: string): Promise<void> {
    const timer = this.renewalTimers.get(bindingId);
    if (timer) clearTimeout(timer);
    this.renewalTimers.delete(bindingId);
    const subscriptionId = this.monitorSubscriptionByBinding.get(bindingId);
    if (!subscriptionId) return;
    const subscription = this.monitorSubscriptions.get(subscriptionId);
    this.monitorSubscriptionByBinding.delete(bindingId);
    this.monitorSubscriptions.delete(subscriptionId);
    if (subscription) await this.unsubscribeSubscription(subscription);
  }

  private async unsubscribeSubscription(subscription: ActiveMonitorSubscription): Promise<void> {
    const desired = this.desiredMonitors.get(subscription.bindingId);
    const binding = desired && this.bindingSource?.getGatewayLaunchBinding?.(desired.host.id, subscription.bindingId);
    if (!binding || binding.version !== 2) return;
    await subscription.entry.client.callTool({
      name: "monitor",
      arguments: {
        action: "unsubscribe",
        sessionId: binding.gatewaySessionId,
        memberId: binding.gatewayMemberId,
        subscriptionId: subscription.subscriptionId,
      },
    }, undefined, { timeout: 5_000, maxTotalTimeout: 5_000 }).catch(() => undefined);
  }

  private scheduleMonitorReconnect(hostId: string): void {
    if (!this.monitorSink || this.reconnectTimers.has(hostId)) return;
    const desired = [...this.desiredMonitors.values()].filter((candidate) => candidate.host.id === hostId);
    if (desired.length === 0) return;
    const attempt = this.reconnectAttempts.get(hostId) ?? 0;
    const delay = Math.min(MONITOR_RECONNECT_MAX_MS, MONITOR_RECONNECT_MIN_MS * 2 ** attempt);
    const epoch = this.poolEpoch;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(hostId);
      if (epoch !== this.poolEpoch) return;
      void (async () => {
        try {
          const entry = await this.acquire(desired[0]!.host, desired[0]!.effectiveDigest, desired[0]!.cacheFence, desired[0]!.timeoutSeconds);
          for (const candidate of desired) await this.subscribeMonitor(entry, candidate);
          this.reconnectAttempts.delete(hostId);
        } catch (error) {
          this.reconnectAttempts.set(hostId, Math.min(attempt + 1, 8));
          for (const candidate of desired) {
            const binding = this.bindingSource?.getGatewayLaunchBinding?.(hostId, candidate.bindingId);
            if (binding?.version === 2) await this.publishMonitorStatus(binding, "error", error);
          }
          this.scheduleMonitorReconnect(hostId);
        }
      })();
    }, delay);
    timer.unref?.();
    this.reconnectTimers.set(hostId, timer);
  }

  private scheduleMonitorRenewal(binding: Extract<SshGatewayLaunchBinding, { version: 2 }>): void {
    const existing = this.renewalTimers.get(binding.bindingId);
    if (existing) clearTimeout(existing);
    const delay = Math.max(1_000, binding.leaseExpiresAt - this.now() - MONITOR_RENEW_WINDOW_MS);
    const timer = setTimeout(() => {
      this.renewalTimers.delete(binding.bindingId);
      const desired = this.desiredMonitors.get(binding.bindingId);
      if (!desired) return;
      void (async () => {
        await this.unsubscribeBinding(binding.bindingId);
        await this.ensureMonitorSubscription(desired);
      })().catch((error) => {
        const current = this.bindingSource?.getGatewayLaunchBinding?.(binding.hostId, binding.bindingId);
        if (current?.version === 2) void this.publishMonitorStatus(current, "error", error);
        this.scheduleMonitorReconnect(binding.hostId);
      });
    }, delay);
    timer.unref?.();
    this.renewalTimers.set(binding.bindingId, timer);
  }

  private async publishMonitorStatus(
    binding: Extract<SshGatewayLaunchBinding, { version: 2 }>,
    status: SshGatewayMonitorStatus["status"],
    error?: unknown,
  ): Promise<void> {
    try {
      await this.monitorSink?.onStatus?.({
        binding,
        status,
        ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
      });
    } catch {
      // Status projection is advisory and must not tear down a valid subscription.
    }
  }

  private async closePending(pending: Iterable<Promise<GatewayPoolEntry>>): Promise<void> {
    const entries = await Promise.all([...pending].map((entry) => entry.catch(() => undefined)));
    for (const entry of entries) {
      if (!entry) continue;
      this.retireMonitorSubscriptions(entry);
      this.scheduleMonitorReconnect(entry.hostId);
    }
    await Promise.all(entries.map((entry) => entry?.client.close().catch(() => undefined)));
  }
}

const GATEWAY_EVENT_KINDS = new Set(["state", "progress", "child", "published", "complete", "send", "cancel", "error", "gap"]);
const GATEWAY_GAP_REASONS = new Set<GatewayEventGap["reason"]>(["retention", "slow-consumer", "revoked", "connection-closed"]);

function parseMonitorNotification(value: unknown): GatewayEventNotification["params"] | undefined {
  if (!value || typeof value !== "object" || (value as { method?: unknown }).method !== GATEWAY_EVENT_NOTIFICATION_METHOD) return undefined;
  const params = (value as { params?: unknown }).params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const record = params as Record<string, unknown>;
  const subscriptionId = monitorText(record.subscriptionId, 128);
  const handle = monitorText(record.handle, 128);
  const eventId = monitorText(record.eventId, 256);
  if (!subscriptionId || !handle || !eventId || !Number.isSafeInteger(record.cursor) || (record.cursor as number) < 1) return undefined;
  if (typeof record.kind !== "string" || !GATEWAY_EVENT_KINDS.has(record.kind)) return undefined;
  return {
    subscriptionId,
    handle,
    eventId,
    cursor: record.cursor as number,
    kind: record.kind as GatewayEventNotification["params"]["kind"],
    payload: record.payload,
  };
}

function parseMonitorSubscription(
  value: unknown,
  expectedHandle: string,
  expectedPrincipal: string,
): { subscriptionId: string; gap?: GatewayEventGap } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Gateway returned an invalid Monitor subscription");
  const envelope = value as { ok?: unknown; data?: unknown; meta?: unknown; error?: { message?: unknown } };
  if (envelope.ok !== true) throw new Error(typeof envelope.error?.message === "string" ? envelope.error.message : "Gateway Monitor subscription failed");
  const meta = envelope.meta && typeof envelope.meta === "object" && !Array.isArray(envelope.meta) ? envelope.meta as Record<string, unknown> : undefined;
  const principal = monitorText(meta?.principalId, 256);
  const separator = expectedPrincipal.indexOf(":");
  if (!principal || separator <= 0 || principal !== expectedPrincipal.slice(separator + 1)) throw new Error("Gateway principal changed during Monitor subscription");
  if (!envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) throw new Error("Gateway returned an invalid Monitor subscription");
  const data = envelope.data as Record<string, unknown>;
  const subscriptionId = monitorText(data.subscriptionId, 128);
  if (!subscriptionId || data.handle !== expectedHandle) throw new Error("Gateway returned a mismatched Monitor subscription");
  return { subscriptionId, ...(data.gap === undefined ? {} : { gap: parseMonitorGap(data.gap) }) };
}

function parseMonitorGap(value: unknown): GatewayEventGap {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Gateway returned an invalid Monitor gap");
  const gap = value as Record<string, unknown>;
  if (typeof gap.reason !== "string" || !GATEWAY_GAP_REASONS.has(gap.reason as GatewayEventGap["reason"])) throw new Error("Gateway returned an invalid Monitor gap");
  for (const field of ["fromCursor", "toCursor", "resumeCursor"] as const) {
    if (!Number.isSafeInteger(gap[field]) || (gap[field] as number) < 0) throw new Error("Gateway returned an invalid Monitor gap");
  }
  return {
    reason: gap.reason as GatewayEventGap["reason"],
    fromCursor: gap.fromCursor as number,
    toCursor: gap.toCursor as number,
    resumeCursor: gap.resumeCursor as number,
  };
}

function monitorText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && Buffer.byteLength(text, "utf8") <= maximum && !/[\u0000-\u001f\u007f]/u.test(text) ? text : undefined;
}

class SshGatewayTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly readBuffer = new ReadBuffer({ maxBufferSize: MAX_STDIO_BUFFER_BYTES });
  private started = false;
  private closed = false;
  private stderrBytes = 0;

  constructor(
    private readonly handle: SshCommandChannel,
    private readonly onDisconnect: () => void,
  ) {}

  async start(): Promise<void> {
    if (this.started) throw new Error("SSH Gateway transport is already started");
    if (this.closed) throw new Error("SSH Gateway transport is closed");
    this.started = true;
    this.handle.channel.on("data", this.handleData);
    this.handle.channel.once("error", this.handleError);
    this.handle.channel.once("close", this.handleClose);
    this.handle.channel.stderr.on("data", this.handleStderr);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.started || this.closed || !this.handle.channel.writable) {
      throw new Error("SSH Gateway transport is not connected");
    }
    await new Promise<void>((resolve, reject) => {
      this.handle.channel.write(serializeMessage(message), (error?: Error | null) => {
        if (error) reject(error); else resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.finish();
  }

  private readonly handleData = (chunk: Buffer | string): void => {
    try {
      this.readBuffer.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
      let message: JSONRPCMessage | null;
      while ((message = this.readBuffer.readMessage()) !== null) this.onmessage?.(message);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      this.finish();
    }
  };

  private readonly handleError = (error: Error): void => {
    this.onerror?.(error);
    this.finish();
  };

  private readonly handleClose = (): void => this.finish();

  private readonly handleStderr = (chunk: Buffer | string): void => {
    this.stderrBytes = Math.min(
      MAX_STDERR_BYTES,
      this.stderrBytes + (Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk, "utf8")),
    );
  };

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.readBuffer.clear();
    this.handle.channel.off("data", this.handleData);
    this.handle.channel.off("error", this.handleError);
    this.handle.channel.off("close", this.handleClose);
    this.handle.channel.stderr.off("data", this.handleStderr);
    this.handle.close();
    this.onDisconnect();
    this.onclose?.();
  }
}

class GatewayHttpFailure extends Error {
  constructor(readonly category: "availability" | "protocol" | "auth" | "tls" | "server", readonly status?: number, options?: ErrorOptions) {
    super(`Secure Gateway HTTPS ${category} failure`, options);
    this.name = "GatewayHttpFailure";
  }
}

function classifyNetworkFailure(error: unknown): GatewayHttpFailure {
  const value = error as { cause?: { code?: unknown }; code?: unknown; name?: unknown; message?: unknown };
  const code = String(value?.cause?.code ?? value?.code ?? "");
  const message = String(value?.message ?? "").toLowerCase();
  const tls = /CERT|TLS|SSL|HOSTNAME|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/u.test(code)
    || /certificate|hostname|tls|ssl/u.test(message);
  if (tls) return new GatewayHttpFailure("tls", undefined, { cause: error });
  const available = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT/u.test(code)
    || /timed out|timeout|connection refused/u.test(message);
  return new GatewayHttpFailure(available ? "availability" : "tls", undefined, { cause: error });
}

function isHttpSessionLoss(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 400 && /session|initialize|valid session/iu.test(error.message);
}

function isTransientServerFailure(error: unknown): boolean {
  return error instanceof GatewayHttpFailure && error.category === "server"
    || error instanceof StreamableHTTPError && error.code !== undefined && error.code >= 500 && error.code <= 599;
}

function isOutcomeUncertainFailure(error: unknown): boolean {
  if (isHttpSessionLoss(error) || isTransientServerFailure(error)) return true;
  if (error instanceof GatewayHttpFailure) return error.category === "availability";
  if (!(error instanceof Error)) return false;
  return /connection (?:closed|lost|reset)|socket|fetch failed|network|terminated|ECONNRESET|EPIPE/iu.test(error.message);
}

function isReplayableTransportFailure(error: unknown): boolean {
  return isOutcomeUncertainFailure(error);
}

function allowsStdioFallback(error: unknown): boolean {
  if (error instanceof GatewayHttpFailure) return error.category === "availability" || error.category === "protocol";
  if (error instanceof StreamableHTTPError) return error.code === 404 || error.code === 405;
  return false;
}

async function verifyGatewayIdentity(client: Client, requestOptions: { signal?: AbortSignal; timeout: number; maxTotalTimeout: number }): Promise<void> {
  if (client.getServerVersion()?.name !== "pi-maestro-gateway") throw new Error("Gateway server identity verification failed");
  const listed = await client.listTools({}, requestOptions);
  if (!listed.tools.some((tool) => tool.name === "host")) throw new Error("Gateway tool identity verification failed");
}

function poolKey(hostId: string, hostDigest: string): string {
  return `${hostId}\0${hostDigest}`;
}

export function gatewayEndpointIdentity(binding?: Pick<SshGatewayBinding, "endpoint" | "pairingId">): string {
  const value = binding ? `https\0${binding.endpoint}\0${binding.pairingId}` : `stdio\0${SSH_GATEWAY_COMMAND}`;
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function decodeGatewayEnvelope(result: unknown): unknown {
  if (!result || typeof result !== "object") throw new Error("Gateway returned an invalid MCP tool result");
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("Gateway returned an invalid MCP tool result");
  const text = content.find((item): item is { type: "text"; text: string } => Boolean(
    item && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string",
  ))?.text;
  if (text === undefined) throw new Error("Gateway returned no result envelope");
  try { return JSON.parse(text) as unknown; }
  catch { throw new Error("Gateway returned malformed result JSON"); }
}
