import assert from "node:assert/strict";
import test from "node:test";
import { FabricContractError } from "pi-maestro-fabric-core/v1";
import {
  GATEWAY_CONTROL_SSH_COMMAND,
  GatewayControlSshChannelAdapter,
  TEAMMATE_RUNTIME_SSH_COMMAND,
  TeammateRuntimeSshChannelAdapter,
  type GatewayControlSshOpenRequest,
  type HostInjectedFixedSshChannel,
  type TeammateRuntimeSshOpenRequest,
} from "../src/index.ts";

interface TestStream { readonly streamId: string; write(data: string): string }

function hostChannel<THandle>(
  descriptor: HostInjectedFixedSshChannel<THandle>["descriptor"],
  handle: THandle,
  closes: string[],
): HostInjectedFixedSshChannel<THandle> {
  return { descriptor, handle, close: async (reason) => { closes.push(reason); } };
}

async function expectCode(action: Promise<unknown>, code: FabricContractError["code"]): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof FabricContractError && error.code === code);
}

test("Gateway control adapter preserves the exact typed host handle and closes idempotently", async () => {
  const requests: GatewayControlSshOpenRequest[] = [];
  const closes: string[] = [];
  const stream: TestStream = { streamId: "gateway-stream", write: (data) => data };
  const controller = new AbortController();
  const adapter = new GatewayControlSshChannelAdapter<TestStream>({
    open: async (request, signal) => {
      assert.equal(signal, controller.signal);
      requests.push(request);
      return hostChannel({ ...request, hostDigest: "sha256:gateway", fence: "host-fence-1" }, stream, closes);
    },
  });
  const opened = await adapter.open("host-a", controller.signal);
  assert.equal(opened.handle, stream);
  assert.equal(opened.handle.write("rpc"), "rpc");
  assert.deepEqual(requests, [{ hostRef: "host-a", purpose: "gateway-control", command: GATEWAY_CONTROL_SSH_COMMAND }]);
  await Promise.all([opened.close("done"), opened.close("ignored")]);
  assert.deepEqual(closes, ["done"]);
  assert.equal(Object.isFrozen(opened.descriptor), true);
});

test("teammate runtime adapter preserves its own handle type and different fixed command", async () => {
  const requests: TeammateRuntimeSshOpenRequest[] = [];
  const handle = { runtimeSession: "session-a" };
  const adapter = new TeammateRuntimeSshChannelAdapter<typeof handle>({
    open: async (request) => {
      requests.push(request);
      return hostChannel({ ...request, hostDigest: "sha256:runtime", fence: "host-fence-2" }, handle, []);
    },
  });
  const opened = await adapter.open("host-b", new AbortController().signal);
  assert.equal(opened.handle, handle);
  assert.deepEqual(requests, [{ hostRef: "host-b", purpose: "teammate-runtime", command: TEAMMATE_RUNTIME_SSH_COMMAND }]);
  assert.notEqual(TEAMMATE_RUNTIME_SSH_COMMAND, GATEWAY_CONTROL_SSH_COMMAND);
  assert.equal("connect" in opened, false);
});

test("invalid digest and descriptor mismatch fail closed without exposing the handle", async () => {
  const invalidCloses: string[] = [];
  const invalid = new GatewayControlSshChannelAdapter<object>({
    open: async (request) => hostChannel({ ...request, hostDigest: "", fence: "fence" }, {}, invalidCloses),
  });
  await expectCode(invalid.open("host-a", new AbortController().signal), "invalid_argument");
  assert.equal(invalidCloses.length, 1);

  const mismatchCloses: string[] = [];
  const mismatch = new GatewayControlSshChannelAdapter<object>({
    open: async (request) => hostChannel({ ...request, command: TEAMMATE_RUNTIME_SSH_COMMAND, hostDigest: "digest", fence: "fence" }, {}, mismatchCloses),
  });
  await expectCode(mismatch.open("host-a", new AbortController().signal), "conflict");
  assert.equal(mismatchCloses.length, 1);
});

test("abort before open avoids injection and abort after open closes the channel", async () => {
  let opens = 0;
  const before = new AbortController();
  before.abort();
  const adapter = new GatewayControlSshChannelAdapter<object>({
    open: async (request) => {
      opens += 1;
      return hostChannel({ ...request, hostDigest: "digest", fence: "fence" }, {}, []);
    },
  });
  await expectCode(adapter.open("host-a", before.signal), "cancelled");
  assert.equal(opens, 0);

  const closes: string[] = [];
  const after = new AbortController();
  const lateAbort = new TeammateRuntimeSshChannelAdapter<object>({
    open: async (request) => {
      after.abort();
      return hostChannel({ ...request, hostDigest: "digest", fence: "fence" }, {}, closes);
    },
  });
  await expectCode(lateAbort.open("host-b", after.signal), "cancelled");
  assert.equal(closes.length, 1);
});
