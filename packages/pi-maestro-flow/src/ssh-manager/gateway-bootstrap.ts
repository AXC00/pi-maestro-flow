import type { ClientChannel } from "ssh2";
import type { SshCommandChannel, SshExecutor } from "./executor.ts";
import { SSH_GATEWAY_SESSION_COMMAND } from "./guide.ts";
import type { SshHost } from "./model.ts";

const DEFAULT_BOOTSTRAP_TIMEOUT_SECONDS = 30;
const BOOTSTRAP_RETRY_DELAY_MS = 100;

export interface SshGatewayBootstrapResult {
  readonly ready: true;
  readonly started: boolean;
  readonly ownership: "local-session" | "pre-existing";
}

export interface SshGatewayBootstrapManagerOptions {
  now?: () => number;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onOwnedChannelClose?: (hostId: string) => void | Promise<void>;
}

interface BootstrapEntry {
  readonly hostId: string;
  readonly fence: string;
  readonly controller: AbortController;
  promise: Promise<SshGatewayBootstrapResult>;
  handle?: SshCommandChannel;
  ready: boolean;
}

export class SshGatewayBootstrapManager {
  private readonly entries = new Map<string, BootstrapEntry>();
  private readonly now: () => number;
  private readonly delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly onOwnedChannelClose?: (hostId: string) => void | Promise<void>;
  private closed = false;

  constructor(
    private readonly executor: Pick<SshExecutor, "openChannel">,
    options: SshGatewayBootstrapManagerOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.delay = options.delay ?? abortableDelay;
    this.onOwnedChannelClose = options.onOwnedChannelClose;
  }

  async ensure(
    host: SshHost,
    effectiveDigest: string,
    cacheFence: string,
    probe: (signal: AbortSignal) => Promise<boolean>,
    options: { timeoutSeconds?: number; signal?: AbortSignal } = {},
  ): Promise<SshGatewayBootstrapResult> {
    if (this.closed) throw new Error("SSH Gateway bootstrap is unavailable during shutdown");
    if (options.signal?.aborted) throw abortError();
    const timeoutSeconds = boundedTimeout(options.timeoutSeconds);
    const current = this.entries.get(host.id);
    if (current?.fence === cacheFence) return current.promise;
    if (current) await this.retire(current);

    const controller = new AbortController();
    const relayAbort = (): void => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", relayAbort, { once: true });
    const entry: BootstrapEntry = {
      hostId: host.id,
      fence: cacheFence,
      controller,
      promise: Promise.resolve({ ready: true, started: false, ownership: "pre-existing" }),
      ready: false,
    };
    entry.promise = this.start(entry, host, effectiveDigest, timeoutSeconds, probe)
      .finally(() => {
        options.signal?.removeEventListener("abort", relayAbort);
      });
    this.entries.set(host.id, entry);
    try {
      const result = await entry.promise;
      if (!result.started && this.entries.get(host.id) === entry) this.entries.delete(host.id);
      return result;
    } catch (error) {
      if (this.entries.get(host.id) === entry) this.entries.delete(host.id);
      entry.handle?.close();
      if (controller.signal.aborted) throw abortError();
      throw error;
    }
  }

  async invalidateHost(hostId: string): Promise<void> {
    const entry = this.entries.get(hostId);
    if (!entry) return;
    await this.retire(entry);
  }

  async invalidateAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => this.retire(entry)));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.invalidateAll();
  }

  private async start(
    entry: BootstrapEntry,
    host: SshHost,
    effectiveDigest: string,
    timeoutSeconds: number,
    probe: (signal: AbortSignal) => Promise<boolean>,
  ): Promise<SshGatewayBootstrapResult> {
    if (await probe(entry.controller.signal)) {
      return { ready: true, started: false, ownership: "pre-existing" };
    }
    const handle = await this.executor.openChannel(
      host,
      { command: SSH_GATEWAY_SESSION_COMMAND, timeout: timeoutSeconds },
      { signal: entry.controller.signal },
    );
    entry.handle = handle;
    if (handle.effectiveDigest !== undefined && handle.effectiveDigest !== effectiveDigest) {
      handle.close();
      throw new Error("SSH Gateway bootstrap connection chain changed while opening");
    }

    const channel = handle.channel;
    let channelClosed = channelIsClosed(channel);
    const discard = (_chunk: Buffer | string): void => undefined;
    const onClose = (): void => {
      channelClosed = true;
      if (!entry.ready || this.entries.get(entry.hostId) !== entry) return;
      this.entries.delete(entry.hostId);
      void this.onOwnedChannelClose?.(entry.hostId);
    };
    channel.stderr.on("data", discard);
    channel.once("close", onClose);

    const deadline = this.now() + timeoutSeconds * 1_000;
    try {
      const disposition = await readBootstrapDisposition(channel, entry.controller.signal, timeoutSeconds);
      channel.on("data", discard);
      if (disposition === "already-running") {
        handle.close();
        if (!await probe(entry.controller.signal)) {
          throw new Error("Remote Gateway reported an existing daemon that was not reachable");
        }
        return { ready: true, started: false, ownership: "pre-existing" };
      }
      while (true) {
        if (await probe(entry.controller.signal)) {
          if (channelClosed || channelIsClosed(channel)) throw new Error("Remote Gateway bootstrap exited before readiness");
          entry.ready = true;
          return { ready: true, started: true, ownership: "local-session" };
        }
        if (channelClosed || channelIsClosed(channel)) {
          throw new Error("Remote Gateway bootstrap exited before readiness");
        }
        const remaining = deadline - this.now();
        if (remaining <= 0) throw new Error(`Remote Gateway bootstrap did not become ready within ${timeoutSeconds} seconds`);
        await this.delay(Math.min(BOOTSTRAP_RETRY_DELAY_MS, remaining), entry.controller.signal);
      }
    } catch (error) {
      channel.off("close", onClose);
      handle.close();
      throw error;
    }
  }

  private async retire(entry: BootstrapEntry): Promise<void> {
    if (this.entries.get(entry.hostId) === entry) this.entries.delete(entry.hostId);
    entry.controller.abort();
    entry.handle?.close();
    await entry.promise.catch(() => undefined);
  }
}

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_BOOTSTRAP_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) {
    throw new Error("SSH Gateway bootstrap timeout must be an integer between 1 and 300 seconds");
  }
  return timeout;
}

function channelIsClosed(channel: ClientChannel): boolean {
  const state = channel as ClientChannel & { destroyed?: boolean; readableEnded?: boolean; writableEnded?: boolean };
  return state.destroyed === true || state.readableEnded === true || state.writableEnded === true;
}

function readBootstrapDisposition(
  channel: ClientChannel,
  signal: AbortSignal,
  timeoutSeconds: number,
): Promise<"running" | "already-running"> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffered = Buffer.alloc(0);
    const finish = (error?: Error, disposition?: "running" | "already-running"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      channel.off("data", onData);
      channel.off("close", onClose);
      buffered.fill(0);
      buffered = Buffer.alloc(0);
      if (error) reject(error);
      else resolve(disposition!);
    };
    const onAbort = (): void => finish(abortError());
    const onClose = (): void => finish(new Error("Remote Gateway bootstrap exited before reporting startup status"));
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, "utf8");
      buffered = Buffer.concat([buffered, bytes]);
      bytes.fill(0);
      if (buffered.length > 4 * 1024) {
        finish(new Error("Remote Gateway bootstrap returned an oversized startup status"));
        return;
      }
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffered.subarray(0, newline)));
      } catch {
        finish(new Error("Remote Gateway bootstrap returned an invalid startup status"));
        return;
      }
      const status = value && typeof value === "object" && !Array.isArray(value)
        ? (value as { ok?: unknown; status?: unknown })
        : undefined;
      if (status?.ok !== true || (status.status !== "running" && status.status !== "already-running")) {
        finish(new Error("Remote Gateway bootstrap returned an invalid startup status"));
        return;
      }
      finish(undefined, status.status);
    };
    const timer = setTimeout(
      () => finish(new Error(`Remote Gateway bootstrap did not report startup status within ${timeoutSeconds} seconds`)),
      timeoutSeconds * 1_000,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    channel.on("data", onData);
    channel.once("close", onClose);
  });
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("SSH Gateway bootstrap was cancelled");
  error.name = "AbortError";
  return error;
}
