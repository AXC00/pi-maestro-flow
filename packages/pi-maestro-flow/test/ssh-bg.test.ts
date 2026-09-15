import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Value } from "typebox/value";
import {
  SshBgManager,
  SshBgParams,
  type SshBgResolvedTarget,
} from "../src/ssh-manager/ssh-bg.ts";
import type { SshCommandChannel, SshCommandSession, SshExecuteRequest, SshExecutor } from "../src/ssh-manager/executor.ts";
import type { SshHost } from "../src/ssh-manager/model.ts";

const PIN = `SHA256:${"A".repeat(43)}`;
const host: SshHost = {
  id: "host-1",
  label: "Test host",
  host: "host.example.test",
  user: "runner",
  port: 22,
  shell: "bash",
  hostKey: PIN,
  auth: { kind: "agent" },
};

class FakeChannel extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly output = new PassThrough();
  signalName: string | undefined;
  destroyed = false;

  write(chunk: unknown): boolean {
    this.output.write(chunk as string | Buffer);
    return true;
  }

  end(): this {
    this.destroy();
    return this;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit("close");
    return this;
  }

  signal(name: string): void {
    this.signalName = name;
    this.emit("exit", null, name);
    this.destroy();
  }

  complete(stdout = "", stderr = "", exitCode: number | null = 0, signal?: string): void {
    if (stdout) this.emit("data", Buffer.from(stdout));
    if (stderr) this.stderr.emit("data", Buffer.from(stderr));
    this.emit("exit", exitCode, signal);
    this.destroy();
  }
}

class FakeSession implements SshCommandSession {
  readonly requests: SshExecuteRequest[] = [];
  readonly channels: FakeChannel[] = [];
  closed = false;

  async openChannel(request: SshExecuteRequest): Promise<SshCommandChannel> {
    if (this.closed) throw new Error("session closed");
    this.requests.push(structuredClone(request));
    const channel = new FakeChannel();
    this.channels.push(channel);
    return {
      channel: channel as never,
      close: () => channel.destroy(),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const channel of this.channels) channel.destroy();
  }
}

class FakeExecutor {
  readonly sessions: FakeSession[] = [];

  async openSession(): Promise<SshCommandSession> {
    const session = new FakeSession();
    this.sessions.push(session);
    return session;
  }
}

function target(): SshBgResolvedTarget {
  return { host, fence: "fence-1" };
}

function manager(executor = new FakeExecutor(), completions: unknown[] = []) {
  const instance = new SshBgManager({
    executor: executor as unknown as SshExecutor,
    resolveTarget: async () => target(),
    onCompletion: (completion) => completions.push(completion),
  });
  return { instance, executor };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("ssh_bg schema distinguishes session commands from job controls", () => {
  assert.equal(Value.Check(SshBgParams, { action: "job_start", targetId: "host-1", command: "sleep 10" }), true);
  assert.equal(Value.Check(SshBgParams, { action: "job_exec", sessionId: "ssh-session-1", command: "echo next" }), true);
  assert.equal(Value.Check(SshBgParams, { action: "job_status", jobId: "ssh-bg-1", tail: 20 }), true);
  assert.equal(Value.Check(SshBgParams, { action: "job_exec", targetId: "host-1", sessionId: "ssh-session-1", command: "echo next" }), false);
  assert.equal(Value.Check(SshBgParams, { action: "job_start", command: "" }), false);
});

test("ssh_bg reuses one SSH session for appended commands and notifies background completion", async () => {
  const completions: unknown[] = [];
  const fixture = manager(new FakeExecutor(), completions);
  const started = await fixture.instance.execute({ action: "job_start", targetId: "host-1", command: "long-running" });
  const sessionId = started.details?.sessionId;
  assert.ok(sessionId);
  assert.equal(fixture.executor.sessions.length, 1);
  const session = fixture.executor.sessions[0]!;
  assert.deepEqual(session.requests, [{ command: "long-running" }]);

  const appended = await fixture.instance.execute({ action: "job_exec", sessionId, command: "echo appended", tail: 20 });
  await tick();
  assert.equal(fixture.executor.sessions.length, 1);
  assert.deepEqual(session.requests, [{ command: "long-running" }, { command: "echo appended" }]);
  assert.equal(appended.details?.background, true);
  assert.equal(appended.details?.status, "running");
  session.channels[1]!.complete("appended output\n");
  await tick();
  const appendedStatus = await fixture.instance.execute({ action: "job_status", jobId: appended.details!.jobId!, tail: 20 });
  assert.match(appendedStatus.content[0]!.type === "text" ? appendedStatus.content[0]!.text : "", /appended output/);

  session.channels[0]!.complete("done\n");
  await tick();
  assert.equal(completions.length, 2);
  assert.equal((completions[0] as { status: string }).status, "completed");
  assert.equal((completions[0] as { sessionId: string }).sessionId, sessionId);
});

test("ssh_bg kill stops a remote channel and close reclaims the shared session", async () => {
  const completions: unknown[] = [];
  const fixture = manager(new FakeExecutor(), completions);
  const started = await fixture.instance.execute({ action: "job_start", targetId: "host-1", command: "watch" });
  const jobId = started.details?.jobId;
  const sessionId = started.details?.sessionId;
  assert.ok(jobId);
  assert.ok(sessionId);
  const session = fixture.executor.sessions[0]!;

  const killed = await fixture.instance.execute({ action: "job_kill", jobId });
  assert.equal(killed.details?.status, "killed");
  assert.equal(session.channels[0]!.signalName, "SIGTERM");
  assert.equal(completions.length, 1);
  assert.equal((completions[0] as { status: string }).status, "killed");

  const closed = await fixture.instance.execute({ action: "job_close", sessionId });
  assert.match(closed.content[0]!.type === "text" ? closed.content[0]!.text : "", /Closed SSH session/);
  assert.equal(session.closed, true);
  const listed = await fixture.instance.execute({ action: "job_list" });
  assert.match(listed.content[0]!.type === "text" ? listed.content[0]!.text : "", /No SSH background sessions/);
});

test("ssh_bg run returns completed output inline and preserves the session for later commands", async () => {
  const fixture = manager();
  const runPromise = fixture.instance.execute({ action: "job_run", targetId: "host-1", command: "printf ok", timeout: 1, tail: 10 });
  await tick();
  fixture.executor.sessions[0]!.channels[0]!.complete("ok\n");
  const result = await runPromise;
  assert.equal(result.details?.status, "completed");
  assert.equal(result.details?.background, false);
  assert.match(result.content[0]!.type === "text" ? result.content[0]!.text : "", /ok/);
  assert.equal((await fixture.instance.execute({ action: "job_list" })).content[0]!.type, "text");
});

test("ssh_bg can be initialized again after session shutdown", async () => {
  const fixture = manager();
  await fixture.instance.close();
  await assert.rejects(fixture.instance.execute({ action: "job_list" }), /outside an active session runtime/);
  fixture.instance.initialize();
  const listed = await fixture.instance.execute({ action: "job_list" });
  assert.match(listed.content[0]!.type === "text" ? listed.content[0]!.text : "", /No SSH background sessions/);
});
