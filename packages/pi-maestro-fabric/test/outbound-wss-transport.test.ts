import assert from "node:assert/strict";
import test from "node:test";
import { FabricContractError, type FabricConnectRequest, type FabricEnvelopeV1 } from "pi-maestro-fabric-core/v1";
import {
  FabricOutboundWssTransport,
  type FabricOutboundWssDialer,
  type FabricOutboundWssSession,
} from "../src/outbound-wss-transport.ts";

const NOW = 1_000_000;

function request(overrides: Partial<FabricConnectRequest> = {}): FabricConnectRequest {
  return {
    requestId: "request-1",
    deviceId: "device-1",
    connectorId: "connector-1",
    expectedCredentialGeneration: 1,
    deadlineAt: NOW + 60_000,
    limits: {
      maxFrameBytes: 64 * 1024,
      maxInFlightOperations: 8,
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 5_000,
      maxAdvertisementItems: 32,
      maxResultBytes: 64 * 1024,
    },
    ...overrides,
  };
}

function envelope(kind: FabricEnvelopeV1["kind"], extra: Partial<FabricEnvelopeV1> = {}): FabricEnvelopeV1 {
  return { version: "fabric.v1", messageId: `m-${kind}`, kind, sentAt: NOW, payload: {}, ...extra };
}

class FakeDialer implements FabricOutboundWssDialer {
  readonly dialed: Array<{ connectorId: string; credentialGeneration: number; deviceId: string }> = [];
  closed: string[] = [];
  response: FabricEnvelopeV1 | Error = envelope("control_response");
  failDial?: Error;

  async dial(input: { connectorId: string; credentialGeneration: number; deviceId: string }): Promise<FabricOutboundWssSession> {
    this.dialed.push({ connectorId: input.connectorId, credentialGeneration: input.credentialGeneration, deviceId: input.deviceId });
    if (this.failDial !== undefined) throw this.failDial;
    return {
      connectionId: "connection-1",
      connectionGeneration: 3,
      exchange: async () => {
        if (this.response instanceof Error) throw this.response;
        return this.response;
      },
      close: async (reason: string) => { this.closed.push(reason); },
    };
  }
}

function transport(dialer: FakeDialer): FabricOutboundWssTransport {
  return new FabricOutboundWssTransport({
    dialer,
    hubUrl: "wss://hub.example.test/fabric/v1/connector",
    connectorId: "connector-1",
    keyId: "key-1",
    audience: "hub.example.test",
    credentialGeneration: 1,
    now: () => NOW,
  });
}

const live = { aborted: false } as const;

test("an outbound-WSS transport dials the enrolled Connector and leases its generation", async () => {
  const dialer = new FakeDialer();
  const connection = await transport(dialer).connect(request(), live);

  assert.equal(transport(dialer).kind, "outbound-wss");
  assert.deepEqual(dialer.dialed, [{ connectorId: "connector-1", credentialGeneration: 1, deviceId: "device-1" }]);
  assert.equal(connection.descriptor.protocolVersion, "fabric.v1");
  assert.equal(connection.descriptor.lease.generation, 3);
  assert.equal(connection.descriptor.lease.state, "connected");

  await connection.exchange(envelope("control_request", { connectionId: "connection-1", connectionGeneration: 3 }), live);
  await connection.close("test complete");
  assert.deepEqual(dialer.closed, ["test complete"]);
  await connection.close("again");
  assert.deepEqual(dialer.closed, ["test complete"], "close was not idempotent");
});

test("a superseded credential generation is refused before any dial", async () => {
  const dialer = new FakeDialer();
  await assert.rejects(
    () => transport(dialer).connect(request({ expectedCredentialGeneration: 2 }), live),
    (error: FabricContractError) => {
      assert.equal(error.code, "stale_generation");
      return true;
    },
  );
  await assert.rejects(
    () => transport(dialer).connect(request({ connectorId: "connector-2" }), live),
    (error: FabricContractError) => {
      assert.equal(error.code, "conflict");
      return true;
    },
  );
  assert.deepEqual(dialer.dialed, []);
});

test("exchange is fenced by the connection's own generation and by close", async () => {
  const dialer = new FakeDialer();
  const connection = await transport(dialer).connect(request(), live);

  await assert.rejects(
    () => connection.exchange(envelope("control_request", { connectionId: "connection-other" }), live),
    /addresses another connection/,
  );
  await assert.rejects(
    () => connection.exchange(
      envelope("control_request", { connectionId: "connection-1", connectionGeneration: 9 }),
      live,
    ),
    /addresses another connection generation/,
  );
  await assert.rejects(
    () => connection.exchange(envelope("control_request", { deadlineAt: NOW - 1 }), live),
    /deadline has passed/,
  );
  assert.deepEqual(dialer.dialed.length, 1, "a refused exchange redialed");

  await connection.close("done");
  await assert.rejects(() => connection.exchange(envelope("control_request"), live), /connection is closed/);
});

test("a mismatched response correlation and an oversized frame are refused", async () => {
  const dialer = new FakeDialer();
  dialer.response = envelope("control_response", { correlationId: "other-correlation" });
  const connection = await transport(dialer).connect(request(), live);
  await assert.rejects(
    () => connection.exchange(envelope("control_request", { correlationId: "expected-correlation" }), live),
    /does not answer this request/,
  );

  const oversized = new FabricOutboundWssTransport({
    dialer,
    hubUrl: "wss://hub.example.test/fabric/v1/connector",
    connectorId: "connector-1",
    keyId: "key-1",
    audience: "hub.example.test",
    credentialGeneration: 1,
    limits: { maxFrameBytes: 64 },
    now: () => NOW,
  });
  const small = await oversized.connect(request(), live);
  await assert.rejects(
    () => small.exchange({
      ...envelope("control_request"),
      payload: { padding: "x".repeat(200) },
    }, live),
    /exceeds maxFrameBytes/,
  );
});

test("a Hub URL that is not wss is refused at construction", () => {
  assert.throws(
    () => new FabricOutboundWssTransport({
      dialer: new FakeDialer(),
      hubUrl: "ws://hub.example.test/fabric/v1/connector",
      connectorId: "connector-1",
      keyId: "key-1",
      audience: "hub.example.test",
      credentialGeneration: 1,
    }),
    /must use wss/,
  );
});
