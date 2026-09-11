import assert from "node:assert/strict";
import { Duplex, PassThrough } from "node:stream";
import test from "node:test";
import type { ClientChannel } from "ssh2";
import {
  SshGatewayBootstrapManager,
  type SshGatewayBootstrapResult,
} from "../src/ssh-manager/gateway-bootstrap.ts";
import type {
  SshCommandChannel,
  SshExecuteOptions,
  SshExecuteRequest,
  SshExecutor,
} from "../src/ssh-manager/executor.ts";
import { SSH_GATEWAY_SESSION_COMMAND } from "../src/ssh-manager/guide.ts";
import type { SshHost } from "../src/ssh-manager/model.ts";

const PIN = `SHA256:${"A".repeat(43)}`;
const host: SshHost = {
  id: "gateway-host",
  label: "Gateway Host",
  host: "gateway.example.test",
  user: "runner",
  port: 22,
  shell: "bash",
  hostKey: PIN,
  auth: { kind: "agent" },
};

class FakeBootstrapChannel extends Duplex {
  readonly stderr = new PassThrough();
  _read(): void {}
  _write(_chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void { callback(); }
}

class FakeBootstrapExecutor {
  readonly requests: SshExecuteRequest[] = [];
  readonly channels: FakeBootstrapChannel[] = [];
  closeCount = 0;
  effectiveDigest: string | undefined = "digest-a";
  startupStatus: "running" | "already-running" = "running";

  async openChannel(
    _host: unknown,
    request: SshExecuteRequest,
    _options?: SshExecuteOptions,
  ): Promise<SshCommandChannel> {
    this.requests.push(structuredClone(request));
    const channel = new FakeBootstrapChannel();
    this.channels.push(channel);
    queueMicrotask(() => channel.push(`${JSON.stringify({ ok: true, status: this.startupStatus })}\n`));
    let closed = false;
    return {
      channel: channel as unknown as ClientChannel,
      ...(this.effectiveDigest === undefined ? {} : { effectiveDigest: this.effectiveDigest }),
      close: () => {
        if (closed) return;
        closed = true;
        this.closeCount += 1;
        channel.destroy();
        channel.stderr.destroy();
      },
    };
  }
}

const asExecutor = (executor: FakeBootstrapExecutor): Pick<SshExecutor, "openChannel"> => executor as unknown as Pick<SshExecutor, "openChannel">;
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function assertStarted(result: SshGatewayBootstrapResult): void {
  assert.deepEqual(result, { ready: true, started: true, ownership: "local-session" });
}

test("Gateway bootstrap leaves a pre-existing daemon unowned and untouched", async () => {
  const executor = new FakeBootstrapExecutor();
  const manager = new SshGatewayBootstrapManager(asExecutor(executor));
  const result = await manager.ensure(host, "digest-a", "fence-a", async () => true);
  assert.deepEqual(result, { ready: true, started: false, ownership: "pre-existing" });
  assert.deepEqual(executor.requests, []);
  await manager.invalidateHost(host.id);
  await manager.close();
  assert.equal(executor.closeCount, 0);
});

test("Gateway bootstrap shares one fixed-command admission and closes its owned channel", async () => {
  const executor = new FakeBootstrapExecutor();
  const invalidated: string[] = [];
  const manager = new SshGatewayBootstrapManager(asExecutor(executor), {
    onOwnedChannelClose(hostId) { invalidated.push(hostId); },
  });
  let probes = 0;
  const probe = async (): Promise<boolean> => ++probes >= 2;
  const first = manager.ensure(host, "digest-a", "fence-a", probe);
  const second = manager.ensure(host, "digest-a", "fence-a", probe);
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assertStarted(firstResult);
  assertStarted(secondResult);
  assert.deepEqual(executor.requests, [{ command: SSH_GATEWAY_SESSION_COMMAND, timeout: 30 }]);

  executor.channels[0]!.destroy();
  await tick();
  assert.deepEqual(invalidated, [host.id], "natural owner loss invalidates cached Gateway clients once");
  await manager.close();
  assert.equal(executor.closeCount, 0, "an already-closed owned channel is not closed twice");
});

test("Gateway bootstrap trusts the serve disposition instead of claiming a raced existing daemon", async () => {
  const executor = new FakeBootstrapExecutor();
  executor.startupStatus = "already-running";
  const manager = new SshGatewayBootstrapManager(asExecutor(executor));
  let probes = 0;
  const result = await manager.ensure(host, "digest-a", "fence-a", async () => ++probes >= 2);
  assert.deepEqual(result, { ready: true, started: false, ownership: "pre-existing" });
  assert.equal(executor.closeCount, 1, "only the bootstrap command channel is released");
  await manager.close();
  assert.equal(executor.closeCount, 1, "the pre-existing Gateway remains unowned");
});

test("Gateway bootstrap reports an early remote exit and cleans up the full SSH chain", async () => {
  const executor = new FakeBootstrapExecutor();
  const manager = new SshGatewayBootstrapManager(asExecutor(executor));
  let probes = 0;
  const pending = manager.ensure(host, "digest-a", "fence-a", async () => {
    probes += 1;
    if (probes === 2) queueMicrotask(() => executor.channels[0]!.destroy());
    return false;
  });
  await assert.rejects(pending, /exited before readiness/u);
  assert.equal(executor.closeCount, 1);
  await manager.close();
});

test("Gateway bootstrap timeout and digest mismatch cannot leave an owned daemon channel", async () => {
  let now = 0;
  const timedExecutor = new FakeBootstrapExecutor();
  const timed = new SshGatewayBootstrapManager(asExecutor(timedExecutor), {
    now: () => now,
    delay: async (milliseconds, signal) => {
      if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      now += milliseconds;
    },
  });
  await assert.rejects(
    timed.ensure(host, "digest-a", "fence-a", async () => false, { timeoutSeconds: 1 }),
    /did not become ready within 1 seconds/u,
  );
  assert.equal(timedExecutor.closeCount, 1);
  await timed.close();

  const mismatchedExecutor = new FakeBootstrapExecutor();
  mismatchedExecutor.effectiveDigest = "digest-b";
  const mismatched = new SshGatewayBootstrapManager(asExecutor(mismatchedExecutor));
  await assert.rejects(
    mismatched.ensure(host, "digest-a", "fence-a", async () => false),
    /connection chain changed/u,
  );
  assert.equal(mismatchedExecutor.closeCount, 1);
  await mismatched.close();
});

test("Gateway bootstrap invalidation retires only the prior host fence", async () => {
  const executor = new FakeBootstrapExecutor();
  const manager = new SshGatewayBootstrapManager(asExecutor(executor));
  let probes = 0;
  assertStarted(await manager.ensure(host, "digest-a", "fence-a", async () => ++probes % 2 === 0));
  await manager.invalidateHost(host.id);
  assert.equal(executor.closeCount, 1);

  assertStarted(await manager.ensure(host, "digest-a", "fence-b", async () => ++probes % 2 === 0));
  assert.equal(executor.requests.length, 2);
  await manager.close();
  assert.equal(executor.closeCount, 2);
});
