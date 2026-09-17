import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import type { AssistantMessageEvent, Api, Context, Model } from "@earendil-works/pi-ai";

import { registerDevinProvider, refreshDevinModels } from "../src/providers/devin-provider.ts";
import {
  discoverDevinModels,
  normalizeDevinModels,
} from "../src/providers/devin/discovery.ts";
import {
  clearDevinRoutes,
  lookupDevinRoute,
  registerDevinRoutes,
  resolveDevinWireUid,
} from "../src/providers/devin/routing.ts";

import {
  AssignModelRequestSchema,
  AssignModelResponseSchema,
  ChatMessageRequestType,
  ChatMessageSource,
  ChatToolCallSchema,
  ClientModelConfigSchema,
  ConversationalPlannerMode,
  DisplayOption,
  GetChatMessageRequestSchema,
  GetChatMessageResponseSchema,
  GetCliModelConfigsRequestSchema,
  GetCliModelConfigsResponseSchema,
  GetUserJwtRequestSchema,
  GetUserJwtResponseSchema,
  ModelDimensionKind,
  ModelFamilyMetadataSchema,
  ModelInfoSchema,
  ModelUsageStatsSchema,
  StopReason,
  type GetChatMessageRequest,
  type GetChatMessageResponse,
  type GetUserJwtRequest,
} from "../src/providers/devin/devin-proto.ts";
import { create, fromBinary, toBinary } from "../src/providers/devin/protobuf.ts";
import {
  deterministicUuid,
  readConnectTrailerError,
  streamDevin,
} from "../src/providers/devin/transport.ts";

/**
 * Fake Devin edge: serves the two unary/streaming Cascade endpoints with frames
 * built from the vendored schema, so the transport is exercised end to end
 * (HTTP + gzip + Connect framing) without a Devin account.
 */

interface EdgeRequest {
  path: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

interface EdgeReply {
  status?: number;
  headers?: Record<string, string>;
  /** Response chunks, written in order so tests can split frames across reads. */
  chunks: Buffer[];
}

interface FakeEdge {
  baseUrl: string;
  requests: EdgeRequest[];
  close(): Promise<void>;
}

async function startFakeEdge(
  reply: (request: EdgeRequest) => EdgeReply | Promise<EdgeReply>,
): Promise<FakeEdge> {
  const requests: EdgeRequest[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const edgeRequest: EdgeRequest = {
      path: request.url ?? "/",
      headers: request.headers,
      body: Buffer.concat(chunks),
    };
    requests.push(edgeRequest);
    const result = await reply(edgeRequest);
    response.writeHead(result.status ?? 200, result.headers ?? { "content-type": "application/proto" });
    for (const chunk of result.chunks) response.write(chunk);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Connect frame: 5-byte header (flag, big-endian length) plus the payload. */
function connectFrame(message: Uint8Array, compressed = true): Buffer {
  const payload = compressed ? gzipSync(message) : message;
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = compressed ? 0x01 : 0x00;
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

/** Connect end-of-stream frame: flag 0x02 carries JSON trailers, never protobuf. */
function trailerFrame(trailer: unknown, compressed = false): Buffer {
  const payload = Buffer.from(JSON.stringify(trailer), "utf8");
  const bytes = compressed ? gzipSync(payload) : payload;
  const frame = Buffer.alloc(5 + bytes.length);
  frame[0] = 0x02 | (compressed ? 0x01 : 0x00);
  frame.writeUInt32BE(bytes.length, 1);
  frame.set(bytes, 5);
  return frame;
}

function responseFrame(partial: Partial<GetChatMessageResponse>): Buffer {
  return connectFrame(toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, partial)));
}

function authReply(userJwt = "user-jwt-1", customApiServerUrl = ""): EdgeReply {
  return {
    chunks: [Buffer.from(toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, {
      userJwt,
      customApiServerUrl,
    })))],
  };
}

function devinModel(baseUrl: string, id = "swe-1-6"): Model<Api> {
  return {
    id,
    name: id === "swe-1-6" ? "SWE-1.6" : id,
    api: "devin-agent",
    provider: "devin",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 128_000,
  };
}

async function collectEvents(
  model: Model<Api>,
  context: Context,
  options: Parameters<typeof streamDevin>[2],
): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of streamDevin(model, context, options)) events.push(event);
  return events;
}

function toolSchemaString(request: GetChatMessageRequest, index = 0): Record<string, unknown> {
  const raw = request.tools[index]?.jsonSchemaString ?? "";
  const parsed: unknown = JSON.parse(raw);
  assert.ok(parsed && typeof parsed === "object");
  return parsed as Record<string, unknown>;
}

const HISTORY: Context["messages"] = [
  { role: "user", content: "fix the failing test", timestamp: 1 },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "look at the suite" },
      { type: "text", text: "running the suite" },
      { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } },
    ],
    api: "devin-agent",
    provider: "devin",
    model: "swe-1-6",
    responseId: "response-1",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: 2,
  },
  {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "bash",
    content: [{ type: "text", text: "1 failing" }],
    isError: true,
    timestamp: 3,
  },
  { role: "user", content: "please fix it", timestamp: 4 },
];

const TOOLS: Context["tools"] = [
  {
    name: "bash",
    description: "Run a shell command",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
];

test("streamDevin authenticates, encodes the Cascade request, and streams text", async () => {
  const edge = await startFakeEdge((request) => {
    if (request.path.endsWith("/GetUserJwt")) return authReply();
    return {
      chunks: [
        responseFrame({ messageId: "msg-1", deltaText: "hello " }),
        responseFrame({ deltaText: "world", stopReason: StopReason.STOP_PATTERN }),
      ],
    };
  });
  try {
    const responses: Array<{ status: number; headers: Record<string, string> }> = [];
    const model = devinModel(edge.baseUrl);
    const events = await collectEvents(
      model,
      { systemPrompt: "you are devin", messages: HISTORY, tools: TOOLS },
      {
        apiKey: "session-token-abc",
        maxTokens: 4_096,
        temperature: 0.2,
        onResponse: (response) => { responses.push(response); },
      },
    );

    assert.deepEqual(events.map((event) => event.type), [
      "start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
      "done",
    ]);
    const done = events.at(-1);
    assert.equal(done?.type, "done");
    if (done?.type !== "done") return;
    assert.equal(done.reason, "stop");
    assert.equal(done.message.content[0]?.type === "text" ? done.message.content[0].text : "", "hello world");
    assert.equal(done.message.responseId, "msg-1");
    assert.equal(done.message.stopReason, "stop");
    assert.equal(done.message.api, "devin-agent");
    assert.equal(responses.length, 2);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);

    const [auth, chat] = edge.requests;
    assert.match(auth?.path ?? "", /\/exa\.auth_pb\.AuthService\/GetUserJwt$/);
    assert.equal(auth?.headers["content-type"], "application/proto");
    assert.equal(auth?.headers["connect-protocol-version"], "1");
    const authBody = fromBinary(GetUserJwtRequestSchema, auth?.body ?? Buffer.alloc(0)) as GetUserJwtRequest;
    assert.equal(authBody.metadata?.apiKey, "devin-session-token$session-token-abc");
    assert.equal(authBody.metadata?.ideName, "devin-cli");
    assert.equal(authBody.metadata?.ideType, "chisel");
    assert.equal(authBody.metadata?.userJwt, "");

    assert.match(chat?.path ?? "", /\/exa\.api_server_pb\.ApiServerService\/GetChatMessage$/);
    assert.equal(chat?.headers["content-type"], "application/connect+proto");
    assert.equal(chat?.headers["connect-content-encoding"], "gzip");
    assert.equal(chat?.headers["connect-protocol-version"], "1");
    const chatFrame = chat?.body ?? Buffer.alloc(0);
    assert.equal(chatFrame[0], 0x01, "the request body must be a gzip Connect frame");
    const request = fromBinary(
      GetChatMessageRequestSchema,
      gunzipSync(chatFrame.subarray(5)),
    );
    assert.equal(request.prompt, "you are devin");
    assert.equal(request.chatModelUid, "swe-1-6");
    assert.equal(request.requestType, ChatMessageRequestType.CASCADE);
    assert.equal(request.plannerMode, ConversationalPlannerMode.DEFAULT);
    assert.equal(request.disableParallelToolCalls, false);
    assert.equal(request.configuration?.maxTokens, 4_096n);
    assert.equal(request.configuration?.temperature, 0.2);
    assert.deepEqual(request.configuration?.stopPatterns.includes("<|endoftext|>"), true);
    assert.deepEqual(request.toolChoice?.choice, { case: "optionName", value: "auto" });
    assert.match(request.cascadeId, /^[0-9a-f-]{36}$/);
    assert.match(request.executionId, /^[0-9a-f-]{36}$/);
    assert.equal(request.metadata?.apiKey, "devin-session-token$session-token-abc");
    assert.equal(request.metadata?.userJwt, "user-jwt-1");

    assert.equal(request.tools.length, 1);
    assert.equal(request.tools[0]?.name, "bash");
    assert.equal(request.tools[0]?.description, "Run a shell command");
    assert.equal(request.tools[0]?.strict, false);
    assert.deepEqual(toolSchemaString(request), TOOLS[0]?.parameters);

    // USER / SYSTEM / TOOL channels, with ids stable across turns.
    assert.deepEqual(
      request.chatMessagePrompts.map((prompt) => prompt.source),
      [
        ChatMessageSource.USER,
        ChatMessageSource.SYSTEM,
        ChatMessageSource.TOOL,
        ChatMessageSource.USER,
      ],
    );
    const [user, assistant, toolResult, followUp] = request.chatMessagePrompts;
    assert.equal(user?.prompt, "fix the failing test");
    assert.equal(assistant?.prompt, "running the suite");
    assert.equal(assistant?.thinking, "look at the suite");
    assert.equal(assistant?.messageId, "response-1");
    assert.equal(assistant?.toolCalls[0]?.id, "call-1");
    assert.equal(assistant?.toolCalls[0]?.name, "bash");
    assert.deepEqual(JSON.parse(assistant?.toolCalls[0]?.argumentsJson ?? "{}"), { command: "npm test" });
    assert.equal(toolResult?.toolCallId, "call-1");
    assert.equal(toolResult?.prompt, "1 failing");
    assert.equal(toolResult?.toolResultIsError, true);
    assert.equal(followUp?.prompt, "please fix it");
    assert.notEqual(user?.messageId, followUp?.messageId);
    assert.equal(user?.messageId, deterministicUuid(`${request.cascadeId}\0` + "0\0user"));
  } finally {
    await edge.close();
  }
});

test("streamDevin streams thinking, tool calls, usage, and reports toolUse", async () => {
  const edge = await startFakeEdge((request) => {
    if (request.path.endsWith("/GetUserJwt")) return authReply();
    return {
      chunks: [
        responseFrame({ deltaThinking: "planning" }),
        responseFrame({ deltaText: "checking" }),
        responseFrame({
          deltaToolCalls: [create(ChatToolCallSchema, { id: "call-9", name: "read", argumentsJson: '{"path":' })],
        }),
        responseFrame({ deltaToolCalls: [create(ChatToolCallSchema, { id: "call-9", argumentsJson: '"a.ts"}' })] }),
        responseFrame({
          usage: create(ModelUsageStatsSchema, { inputTokens: 120n, outputTokens: 30n, cacheReadTokens: 5n, cacheWriteTokens: 7n }),
          stopReason: StopReason.FUNCTION_CALL,
          actualModelUid: "swe-1-6-fast",
        }),
      ],
    };
  });
  try {
    const events = await collectEvents(
      devinModel(edge.baseUrl),
      { systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { apiKey: "token" },
    );

    assert.deepEqual(events.map((event) => event.type), [
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected a done event");
    assert.equal(done.reason, "toolUse");
    assert.deepEqual(done.message.content.map((block) => block.type), ["thinking", "text", "toolCall"]);
    const toolCall = done.message.content[2];
    assert.equal(toolCall?.type === "toolCall" ? toolCall.name : "", "read");
    assert.deepEqual(toolCall?.type === "toolCall" ? toolCall.arguments : {}, { path: "a.ts" });
    assert.deepEqual(done.message.usage.input, 120);
    assert.deepEqual(done.message.usage.output, 30);
    assert.deepEqual(done.message.usage.cacheRead, 5);
    assert.deepEqual(done.message.usage.cacheWrite, 7);
    assert.equal(done.message.usage.totalTokens, 162);
    assert.deepEqual(done.message.usage.cost.total, 0);
    assert.equal(done.message.responseModel, "swe-1-6-fast");
  } finally {
    await edge.close();
  }
});

test("streamDevin reassembles frames split across response chunks", async () => {
  const frame = responseFrame({ deltaText: "split-safe" });
  const tail = trailerFrame({}, false);
  const edge = await startFakeEdge((request) => {
    if (request.path.endsWith("/GetUserJwt")) return authReply();
    return {
      chunks: [
        frame.subarray(0, 2),
        frame.subarray(2, 7),
        frame.subarray(7),
        tail.subarray(0, 3),
        tail.subarray(3),
      ],
    };
  });
  try {
    const events = await collectEvents(
      devinModel(edge.baseUrl),
      { systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { apiKey: "token" },
    );
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected a done event");
    assert.equal(done.message.content[0]?.type === "text" ? done.message.content[0].text : "", "split-safe");
  } finally {
    await edge.close();
  }
});

test("streamDevin accepts an uncompressed frame", async () => {
  const edge = await startFakeEdge((request) => {
    if (request.path.endsWith("/GetUserJwt")) return authReply();
    return { chunks: [connectFrame(toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, {
      deltaText: "plain",
    })), false)] };
  });
  try {
    const events = await collectEvents(
      devinModel(edge.baseUrl),
      { systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { apiKey: "token" },
    );
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected a done event");
    assert.equal(done.message.content[0]?.type === "text" ? done.message.content[0].text : "", "plain");
  } finally {
    await edge.close();
  }
});

test("streamDevin surfaces a Connect trailer rejection as an error event", async () => {
  const edge = await startFakeEdge((request) => {
    if (request.path.endsWith("/GetUserJwt")) return authReply();
    return {
      chunks: [
        responseFrame({ deltaText: "partial" }),
        trailerFrame({ error: { code: "invalid_argument", message: "request rejected" } }, true),
      ],
    };
  });
  try {
    const events = await collectEvents(
      devinModel(edge.baseUrl),
      { systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { apiKey: "token" },
    );
    const last = events.at(-1);
    if (last?.type !== "error") throw new Error(`expected an error event, got ${last?.type}`);
    assert.equal(last.reason, "error");
    assert.equal(last.error.errorMessage, "Devin stream error invalid_argument: request rejected");
    assert.equal(last.error.stopReason, "error");
    assert.equal(last.error.content[0]?.type === "text" ? last.error.content[0].text : "", "partial");
  } finally {
    await edge.close();
  }
});

test("streamDevin rejects a frame length above the payload cap", async () => {
  const oversized = Buffer.alloc(5);
  oversized[0] = 0x01;
  oversized.writeUInt32BE(64 * 1024 * 1024, 1);
  const edge = await startFakeEdge((request) => {
    if (request.path.endsWith("/GetUserJwt")) return authReply();
    return { chunks: [oversized] };
  });
  try {
    const events = await collectEvents(
      devinModel(edge.baseUrl),
      { systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { apiKey: "token" },
    );
    const last = events.at(-1);
    if (last?.type !== "error") throw new Error(`expected an error event, got ${last?.type}`);
    assert.match(last.error.errorMessage ?? "", /frame length 67108864 exceeds the 16777216-byte cap/);
  } finally {
    await edge.close();
  }
});

test("streamDevin suppresses proxy HTML on chat failures", async () => {
  const edge = await startFakeEdge((request) => {
    if (request.path.endsWith("/GetUserJwt")) return authReply();
    return {
      status: 502,
      headers: { "content-type": "text/html" },
      chunks: [Buffer.from("<!doctype html><html><body>Bad gateway</body></html>")],
    };
  });
  try {
    const events = await collectEvents(
      devinModel(edge.baseUrl),
      { systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { apiKey: "token" },
    );
    const failure = events.at(-1);
    if (failure?.type !== "error") throw new Error("expected a chat error event");
    assert.equal(failure.error.errorMessage, "Devin API error 502");
  } finally {
    await edge.close();
  }
});

test("streamDevin hints at /login when the handshake is rejected", async () => {
  const edge = await startFakeEdge((request) => {
    if (request.path.endsWith("/GetUserJwt")) {
      return {
        status: 401,
        headers: { "content-type": "application/json" },
        chunks: [Buffer.from(JSON.stringify({ error: { message: "Invalid session token" } }))],
      };
    }
    return { chunks: [responseFrame({ deltaText: "unused" })] };
  });
  try {
    const events = await collectEvents(
      devinModel(edge.baseUrl),
      { systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { apiKey: "token" },
    );
    const failure = events.at(-1);
    if (failure?.type !== "error") throw new Error("expected an auth error event");
    assert.match(failure.error.errorMessage ?? "", /Devin auth error 401/);
    assert.match(failure.error.errorMessage ?? "", /Invalid session token/);
    assert.match(failure.error.errorMessage ?? "", /run \/login devin/);
    assert.equal(edge.requests.some((request) => request.path.endsWith("/GetChatMessage")), false);
  } finally {
    await edge.close();
  }
});

test("streamDevin fails when the handshake returns no user JWT", async () => {
  const edge = await startFakeEdge((request) => {
    if (request.path.endsWith("/GetUserJwt")) return authReply("");
    return { chunks: [responseFrame({ deltaText: "unused" })] };
  });
  try {
    const events = await collectEvents(
      devinModel(edge.baseUrl),
      { systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { apiKey: "token" },
    );
    const last = events.at(-1);
    if (last?.type !== "error") throw new Error("expected an error event");
    assert.match(last.error.errorMessage ?? "", /GetUserJwt returned no user JWT/);
    assert.equal(edge.requests.some((request) => request.path.endsWith("/GetChatMessage")), false);
  } finally {
    await edge.close();
  }
});

test("streamDevin follows the account's own API server URL from the handshake", async () => {
  const chatEdge = await startFakeEdge(() => ({ chunks: [responseFrame({ deltaText: "custom host" })] }));
  const edge = await startFakeEdge((request) => {
    if (request.path.endsWith("/GetUserJwt")) return authReply("user-jwt-2", chatEdge.baseUrl);
    return { chunks: [] };
  });
  try {
    const events = await collectEvents(
      devinModel(edge.baseUrl),
      { systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { apiKey: "token" },
    );
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error("expected a done event");
    assert.equal(done.message.content[0]?.type === "text" ? done.message.content[0].text : "", "custom host");
    assert.equal(chatEdge.requests.length, 1);
    assert.equal(edge.requests.filter((request) => request.path.endsWith("/GetChatMessage")).length, 0);
  } finally {
    await edge.close();
    await chatEdge.close();
  }
});

test("deterministicUuid is stable, seed-specific, and UUID-shaped", () => {
  const first = deterministicUuid("devin\u0000cascade\u00000");
  assert.equal(first, deterministicUuid("devin\u0000cascade\u00000"));
  assert.notEqual(first, deterministicUuid("devin\u0000cascade\u00001"));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("readConnectTrailerError only reports guarded Connect errors", () => {
  assert.equal(
    readConnectTrailerError('{"error":{"code":"invalid_argument","message":"boom"}}'),
    "Devin stream error invalid_argument: boom",
  );
  assert.equal(readConnectTrailerError('{"error":{"code":"unavailable"}}'), "Devin stream error unavailable: no message");
  assert.equal(readConnectTrailerError('{"error":"plain"}'), undefined);
  assert.equal(readConnectTrailerError("{}"), undefined);
  assert.equal(readConnectTrailerError("not json"), undefined);
  assert.equal(readConnectTrailerError(""), undefined);
});

test("streamDevin replaces image parts for the text-only lanes", async () => {
  const edge = await startFakeEdge((request) => {
    if (request.path.endsWith("/GetUserJwt")) return authReply();
    return { chunks: [responseFrame({ deltaText: "ok" })] };
  });
  try {
    await collectEvents(
      devinModel(edge.baseUrl),
      {
        systemPrompt: "",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image", data: "AAAA", mimeType: "image/png" },
            ],
            timestamp: 1,
          },
          {
            role: "toolResult",
            toolCallId: "call-img",
            toolName: "read",
            content: [
              { type: "image", data: "BBBB", mimeType: "image/png" },
              { type: "text", text: "rendered" },
            ],
            isError: false,
            timestamp: 2,
          },
        ],
      },
      { apiKey: "token" },
    );

    const chatFrame = edge.requests[1]?.body ?? Buffer.alloc(0);
    const request = fromBinary(GetChatMessageRequestSchema, gunzipSync(chatFrame.subarray(5)));
    const [user, toolResult] = request.chatMessagePrompts;
    assert.equal(user?.prompt, "look(image omitted: model does not support images)");
    assert.equal(user?.images.length, 0);
    assert.equal(toolResult?.prompt, "(tool image omitted: model does not support images)rendered");
    assert.equal(toolResult?.images.length, 0);
  } finally {
    await edge.close();
  }
});

// pi-coding-agent's exports map blocks deep subpath specifiers, so its dist is
// resolved from the public ESM entry (same approach as devin-auth.test.ts).
const piDist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { AuthStorage } = await import(pathToFileURL(join(piDist, "core/auth-storage.js")).href);
const { ModelRegistry } = await import(pathToFileURL(join(piDist, "core/model-registry.js")).href);
const { ModelRuntime } = await import(pathToFileURL(join(piDist, "core/model-runtime.js")).href);

test("pi drives the transport with the credential /login devin stored", async (t) => {
  const edge = await startFakeEdge((request) => {
    if (request.path.endsWith("/GetUserJwt")) return authReply("user-jwt-from-pi");
    return { chunks: [responseFrame({ deltaText: "from the stored credential" })] };
  });
  const dir = mkdtempSync(join(tmpdir(), "pi-devin-transport-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const modelsPath = join(dir, "models.json");
  writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
  try {
    const registry = new ModelRegistry(await ModelRuntime.create({
      credentials: AuthStorage.inMemory({
        devin: { type: "oauth", access: "session-token-xyz", refresh: "session-token-xyz", expires: Date.now() + 3_600_000 },
      }),
      modelsPath,
    }));
    registerDevinProvider({
      registerProvider(name: string, config: unknown) {
        registry.registerProvider(name, config as never);
      },
    } as never);

    // Registration also installs the seed wire ladder, so the seeded lane can be
    // driven without any discovery round.
    const model = registry.find("devin", "swe-2");
    assert.ok(model, "the seeded model must be resolvable");
    const result = await registry.complete(
      { ...model, baseUrl: edge.baseUrl },
      { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { reasoning: "max" },
    );
    assert.equal(result.stopReason, "stop");
    assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "from the stored credential");

    const authBody = fromBinary(GetUserJwtRequestSchema, edge.requests[0]?.body ?? Buffer.alloc(0)) as GetUserJwtRequest;
    assert.equal(authBody.metadata?.apiKey, "devin-session-token$session-token-xyz");
    const chatBody = edge.requests[1]?.body ?? Buffer.alloc(0);
    const request = fromBinary(GetChatMessageRequestSchema, gunzipSync(chatBody.subarray(5)));
    assert.equal(request.metadata?.userJwt, "user-jwt-from-pi");
    assert.equal(request.metadata?.apiKey, "devin-session-token$session-token-xyz");
    assert.equal(request.chatModelUid, "swe-2-max", "the seed route resolves the thinking level");
  } finally {
    await edge.close();
  }
});

// ---------------------------------------------------------------------------
// Discovery + routing
// ---------------------------------------------------------------------------

/** One Cascade `ClientModelConfig` fixture. */
function clientModelConfig(config: Record<string, unknown>) {
  return create(ClientModelConfigSchema, config as never);
}

function familyMetadata(label: string, entries: Array<{ key: string; name: string; order: number }>) {
  return create(ModelFamilyMetadataSchema, {
    modelFamilyLabel: label,
    isDefaultModelInFamily: false,
    entries: entries.map(({ key, name, order }) => ({ key, value: { name, order } })),
  });
}

function modelInfo(info: Record<string, unknown>) {
  return create(ModelInfoSchema, info as never);
}

function costDimension(label: string, value: number, denominator = "1M tokens", kind = ModelDimensionKind.COST) {
  return { label, value, denominator, minRange: 0, maxRange: 0, kind };
}

/** Fixture catalog: effort ladder, fast lane, 1M lane, router, blind lane, disabled + internal. */
function discoveryFixtures() {
  return [
    clientModelConfig({
      modelUid: "swe-1-7-low",
      label: "SWE-1.7",
      maxTokens: 200_000,
      modelFamilyMetadata: familyMetadata("SWE-1.7", [{ key: "Reasoning Effort", name: "Low", order: 1 }]),
      modelInfo: modelInfo({ maxOutputTokens: 64_000, modelFeatures: { supportsThinking: true, supportsImages: true } }),
    }),
    clientModelConfig({
      modelUid: "swe-1-7-medium",
      label: "SWE-1.7",
      maxTokens: 200_000,
      isDefaultModelInFamily: true,
      modelFamilyMetadata: familyMetadata("SWE-1.7", [{ key: "Reasoning Effort", name: "Medium", order: 2 }]),
      modelInfo: modelInfo({ maxOutputTokens: 64_000, modelFeatures: { supportsThinking: true, supportsImages: true } }),
    }),
    clientModelConfig({
      modelUid: "swe-1-7-high",
      label: "SWE-1.7",
      maxTokens: 200_000,
      modelFamilyMetadata: familyMetadata("SWE-1.7", [{ key: "reasoning effort", name: "XHigh", order: 3 }]),
      modelInfo: modelInfo({ maxOutputTokens: 96_000, modelFeatures: { supportsThinking: true, supportsImages: true } }),
      modelDimensions: [
        costDimension("Input", 3, "1M tokens"),
        costDimension("Output", 15, "1M tokens"),
        costDimension("Cached Input", 0.3, "1M tokens"),
      ],
    }),
    clientModelConfig({
      modelUid: "swe-1-7-fast",
      label: "SWE-1.7 Fast",
      maxTokens: 200_000,
      modelFamilyMetadata: familyMetadata("SWE-1.7", [
        { key: "Fast Mode", name: "Fast", order: 1 },
        { key: "Reasoning Effort", name: "Medium", order: 2 },
      ]),
      modelInfo: modelInfo({ maxOutputTokens: 64_000, modelFeatures: { supportsThinking: true } }),
    }),
    clientModelConfig({
      modelUid: "swe-1-7-1m-medium",
      label: "SWE-1.7",
      maxTokens: 1_000_000,
      modelFamilyMetadata: familyMetadata("SWE-1.7", [
        { key: "1M Context", name: "1M", order: 1 },
        { key: "Reasoning Effort", name: "Medium", order: 2 },
      ]),
      modelInfo: modelInfo({ maxOutputTokens: 128_000, modelFeatures: { supportsThinking: true } }),
      modelDimensions: [costDimension("Input", 1.2345e-3, "1K tokens")],
    }),
    clientModelConfig({
      modelUid: "swe-2-medium",
      label: "SWE-2 Medium",
      maxTokens: 262_000,
      modelFamilyMetadata: familyMetadata("SWE-2", [{ key: "Reasoning Effort", name: "Medium", order: 2 }]),
      modelInfo: modelInfo({ maxOutputTokens: 128_000, modelFeatures: { supportsThinking: true, supportsImages: true } }),
    }),
    clientModelConfig({
      modelUid: "swe-2-high",
      label: "SWE-2 High",
      maxTokens: 262_000,
      isDefaultModelInFamily: true,
      modelFamilyMetadata: familyMetadata("SWE-2", [{ key: "Reasoning Effort", name: "High", order: 1 }]),
      modelInfo: modelInfo({ maxOutputTokens: 128_000, modelFeatures: { supportsThinking: true, supportsImages: true } }),
    }),
    clientModelConfig({
      modelUid: "swe-2-max",
      label: "SWE-2 Max",
      maxTokens: 262_000,
      modelFamilyMetadata: familyMetadata("SWE-2", [{ key: "Reasoning Effort", name: "Max", order: 3 }]),
      modelInfo: modelInfo({ maxOutputTokens: 128_000, modelFeatures: { supportsThinking: true, supportsImages: true } }),
    }),
    clientModelConfig({
      modelUid: "MODEL_ROUTER",
      label: "Auto",
      maxTokens: 200_000,
      modelInfo: modelInfo({ displayOption: DisplayOption.MODEL_ROUTER, maxOutputTokens: 32_000 }),
    }),
    clientModelConfig({
      modelUid: "claude-sonnet-1",
      label: "Claude Sonnet",
      maxTokens: 200_000,
      supportsImages: true,
      modelInfo: modelInfo({
        maxOutputTokens: 32_000,
        modelFeatures: { supportsImages: true, supportsThinking: true },
      }),
    }),
    clientModelConfig({
      modelUid: "swe-1-6",
      label: "SWE-1.6",
      maxTokens: 200_000,
      modelInfo: modelInfo({
        maxOutputTokens: 128_000,
        modelFeatures: { supportsImages: true, supportsThinking: true },
      }),
    }),
    clientModelConfig({ modelUid: "disabled-lane", label: "Disabled", disabled: true, maxTokens: 1_000 }),
    clientModelConfig({
      modelUid: "quick-review",
      label: "Quick Review",
      maxTokens: 1_000,
      modelInfo: modelInfo({ displayOption: DisplayOption.QUICK_REVIEW }),
    }),
  ];
}

test("normalizeDevinModels collapses a family ladder into one pi model with thinkingLevelMap", (t) => {
  t.after(() => clearDevinRoutes());
  const { models, routes } = normalizeDevinModels(discoveryFixtures(), "https://edge.example");
  // Discovery hands the routes back; the provider publishes them. Register them
  // here so the transport-facing lookups are exercised too.
  registerDevinRoutes(routes);
  assert.deepEqual(
    models.map((model) => model.id).sort(),
    ["MODEL_ROUTER", "claude-sonnet-1", "swe-1-6", "swe-1-7", "swe-1-7-1m", "swe-1-7-fast", "swe-2"],
  );

  const lane = models.find((model) => model.id === "swe-1-7");
  assert.ok(lane);
  assert.equal(lane.name, "SWE-1.7");
  assert.equal(lane.api, "devin-agent");
  assert.equal(lane.baseUrl, "https://edge.example");
  assert.equal(lane.reasoning, true);
  // Only the levels the ladder serves stay selectable; the lane id doubles as
  // the pi handle while the wire uid comes from the route table.
  assert.deepEqual(lane.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: null,
    xhigh: "xhigh",
    max: null,
  });
  assert.equal(lane.contextWindow, 200_000);
  assert.equal(lane.maxTokens, 96_000);
  assert.deepEqual(lane.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(models.find((model) => model.id === "swe-1-7-high"), undefined, "ladder members collapse");

  assert.equal(models.find((model) => model.id === "swe-1-7-fast")?.name, "SWE-1.7 Fast");
  // The fast and 1M services are separate lanes of the same family, each with
  // its own route, but they never share a member uid.
  assert.deepEqual(lookupDevinRoute("swe-1-7-fast"), {
    uid: "swe-1-7-fast",
    byEffort: { medium: "swe-1-7-fast" },
    router: false,
  });
  assert.equal(lookupDevinRoute("swe-1-7-1m")?.uid, "swe-1-7-1m-medium");
  const long = models.find((model) => model.id === "swe-1-7-1m");
  assert.equal(long?.name, "SWE-1.7 1M");
  assert.equal(long?.contextWindow, 1_000_000);
  assert.equal(long?.maxTokens, 128_000);
  // 0.0012345 per 1K tokens normalizes to 1.2345 per million.
  assert.equal(long?.cost.input, 1.2345);

  const router = models.find((model) => model.id === "MODEL_ROUTER");
  assert.equal(router?.name, "Auto");
  assert.equal(router?.reasoning, false);
  assert.equal(lookupDevinRoute("MODEL_ROUTER")?.router, true);
  assert.equal(routes.get("swe-1-7")?.uid, "swe-1-7-medium");
  assert.equal(routes.size, 7, "one route per router/standalone/lane model");
  assert.deepEqual(lookupDevinRoute("swe-1-7"), {
    uid: "swe-1-7-medium",
    byEffort: { low: "swe-1-7-low", medium: "swe-1-7-medium", xhigh: "swe-1-7-high" },
    router: false,
  });
  assert.equal(resolveDevinWireUid("swe-1-7", "xhigh"), "swe-1-7-high");
  assert.equal(resolveDevinWireUid("swe-1-7", "low"), "swe-1-7-low");
  assert.equal(resolveDevinWireUid("swe-1-7", "max"), "swe-1-7-medium");
  assert.equal(resolveDevinWireUid("swe-1-7", undefined), "swe-1-7-medium");
  assert.equal(resolveDevinWireUid("swe-1-6", "high"), "swe-1-6");

  // Image support follows the server features, with the image-blind carve-out.
  assert.deepEqual(models.find((model) => model.id === "claude-sonnet-1")?.input, ["text", "image"]);
  assert.deepEqual(models.find((model) => model.id === "swe-1-6")?.input, ["text"]);
  assert.deepEqual(models.find((model) => model.id === "swe-1-7-fast")?.input, ["text"]);
});

test("discoverDevinModels requests the native catalog with the dev-channel identity", async (t) => {
  t.after(() => clearDevinRoutes());
  const edge = await startFakeEdge(() => ({
    chunks: [
      Buffer.from(toBinary(
        GetCliModelConfigsResponseSchema,
        create(GetCliModelConfigsResponseSchema, { clientModelConfigs: discoveryFixtures() }),
      )),
    ],
  }));
  try {
    const discovered = await discoverDevinModels({ apiKey: "cli-token", baseUrl: edge.baseUrl });
    assert.ok(discovered);
    assert.ok(discovered.models.length >= 6);
    assert.equal(discovered.routes.get("swe-1-7")?.uid, "swe-1-7-medium");

    const request = edge.requests[0];
    assert.match(request?.path ?? "", /\/exa\.api_server_pb\.ApiServerService\/GetCliModelConfigs$/);
    assert.equal(request?.headers["content-type"], "application/proto");
    assert.equal(request?.headers["connect-protocol-version"], "1");
    const body = fromBinary(GetCliModelConfigsRequestSchema, request?.body ?? Buffer.alloc(0));
    assert.equal(body.metadata?.apiKey, "devin-session-token$cli-token");
    // The dev-channel client identity is what unlocks the native catalog.
    assert.equal(body.metadata?.ideName, "chisel");
    assert.equal(body.metadata?.ideVersion, "0.0.0-dev");
    assert.equal(body.metadata?.extensionName, "chisel");
    assert.ok(body.metadata?.supportedModelDisplays.includes(DisplayOption.MODEL_ROUTER));
    assert.ok(body.metadata?.supportedModelDisplays.includes(6 as DisplayOption));
  } finally {
    await edge.close();
  }
});

test("discoverDevinModels reports failure instead of an empty roster", async () => {
  const failing = await startFakeEdge(() => ({ status: 500, chunks: [Buffer.from("boom")] }));
  try {
    assert.equal(await discoverDevinModels({ apiKey: "t", baseUrl: failing.baseUrl }), null);
  } finally {
    await failing.close();
  }
  const empty = await startFakeEdge(() => ({
    chunks: [Buffer.from(toBinary(GetCliModelConfigsResponseSchema, create(GetCliModelConfigsResponseSchema, {})))],
  }));
  try {
    assert.equal(await discoverDevinModels({ apiKey: "t", baseUrl: empty.baseUrl }), null);
  } finally {
    await empty.close();
  }
});

test("streamDevin sends the wire uid for the selected thinking level", async (t) => {
  t.after(() => clearDevinRoutes());
  const edge = await startFakeEdge((request) => {
    if (request.path.endsWith("/GetUserJwt")) return authReply();
    return { chunks: [responseFrame({ deltaText: "ok" })] };
  });
  try {
    registerDevinRoutes(new Map([["swe-1-7", {
      uid: "swe-1-7-medium",
      byEffort: { high: "swe-1-7-high" },
      router: false,
    }]]));
    const model = { ...devinModel(edge.baseUrl, "swe-1-7"), reasoning: true } as Model<Api>;
    const context: Context = { systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: 1 }] };

    await collectEvents(model, context, { apiKey: "token", reasoning: "high" });
    await collectEvents(model, context, { apiKey: "token", reasoning: "low" });

    const chatUids = edge.requests
      .filter((request) => request.path.endsWith("/GetChatMessage"))
      .map((request) => fromBinary(GetChatMessageRequestSchema, gunzipSync(request.body.subarray(5))).chatModelUid);
    assert.deepEqual(chatUids, ["swe-1-7-high", "swe-1-7-medium"]);
  } finally {
    await edge.close();
  }
});

test("streamDevin resolves a router lane through AssignModel", async (t) => {
  t.after(() => clearDevinRoutes());
  const edge = await startFakeEdge((request) => {
    if (request.path.endsWith("/GetUserJwt")) return authReply();
    if (request.path.endsWith("/AssignModel")) {
      return {
        chunks: [Buffer.from(toBinary(
          AssignModelResponseSchema,
          create(AssignModelResponseSchema, {
            assignment: { modelUid: "swe-1-9", assignmentJwt: "assignment-jwt-9", harnessUids: [] },
          }),
        ))],
      };
    }
    return { chunks: [responseFrame({ deltaText: "routed" })] };
  });
  try {
    registerDevinRoutes(new Map([["MODEL_ROUTER", { uid: "MODEL_ROUTER", byEffort: {}, router: true }]]));
    const router = { ...devinModel(edge.baseUrl, "MODEL_ROUTER"), name: "Auto" } as Model<Api>;
    const events = await collectEvents(
      router,
      { systemPrompt: "", messages: [{ role: "user", content: "route this turn", timestamp: 1 }] },
      { apiKey: "token" },
    );
    const done = events.at(-1);
    if (done?.type !== "done") throw new Error(`expected a done event, got ${done?.type}`);
    assert.equal(done.message.content[0]?.type === "text" ? done.message.content[0].text : "", "routed");

    const assignRequest = edge.requests.find((request) => request.path.endsWith("/AssignModel"));
    assert.ok(assignRequest, "the router lane must call AssignModel");
    assert.equal(assignRequest.headers["content-type"], "application/proto");
    const assign = fromBinary(AssignModelRequestSchema, assignRequest.body);
    assert.equal(assign.modelRouterUid, "MODEL_ROUTER");
    assert.equal(assign.chatMessagePrompt?.prompt, "route this turn");
    assert.equal(assign.chatMessagePrompt?.messageId, "", "the router prompt carries no message id");
    assert.equal(assign.metadata?.apiKey, "devin-session-token$token");

    const chatBody = edge.requests.find((request) => request.path.endsWith("/GetChatMessage"))?.body ?? Buffer.alloc(0);
    const chat = fromBinary(GetChatMessageRequestSchema, gunzipSync(chatBody.subarray(5)));
    assert.equal(chat.chatModelUid, "swe-1-9", "the router uid must never reach the chat request");
    assert.equal(chat.modelAssignmentJwt, "assignment-jwt-9");
  } finally {
    await edge.close();
  }
});

test("streamDevin fails the turn when AssignModel returns no assignment", async (t) => {
  t.after(() => clearDevinRoutes());
  const edge = await startFakeEdge((request) => {
    if (request.path.endsWith("/GetUserJwt")) return authReply();
    if (request.path.endsWith("/AssignModel")) {
      return { chunks: [Buffer.from(toBinary(AssignModelResponseSchema, create(AssignModelResponseSchema, {})))] };
    }
    return { chunks: [responseFrame({ deltaText: "unreachable" })] };
  });
  try {
    registerDevinRoutes(new Map([["MODEL_ROUTER", { uid: "MODEL_ROUTER", byEffort: {}, router: true }]]));
    const events = await collectEvents(
      devinModel(edge.baseUrl, "MODEL_ROUTER"),
      { systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
      { apiKey: "token" },
    );
    const last = events.at(-1);
    if (last?.type !== "error") throw new Error("expected an error event");
    assert.match(last.error.errorMessage ?? "", /AssignModel error: the response carried no assignment JWT/);
    assert.equal(edge.requests.some((request) => request.path.endsWith("/GetChatMessage")), false);
  } finally {
    await edge.close();
  }
});

test("refreshDevinModels keeps a roster on every fallback path", async (t) => {
  t.after(() => clearDevinRoutes());
  // The seed ladder is installed by provider registration.
  registerDevinProvider({} as never);
  const signal = new AbortController().signal;
  const published: Array<{ persist?: { models: Array<{ id: string; provider?: string }>; checkedAt?: number } }> = [];
  const publish = async (publication: unknown) => { published.push(publication as never); return true; };
  const storedModels = [{ id: "stored-lane" }] as never;

  // Offline: the persisted catalog wins verbatim, else the seed stands in;
  // nothing is published.
  const offline = await refreshDevinModels(
    { allowNetwork: false, signal, stored: { models: storedModels }, publish } as never,
  );
  assert.deepEqual(offline.map((model) => model.id), ["stored-lane"]);
  const offlineSeed = await refreshDevinModels({ allowNetwork: false, signal, publish } as never);
  assert.deepEqual(offlineSeed.map((model) => model.id), ["swe-2"]);
  // The offline seed still carries its wire ladder, so a signed-out install can
  // talk to Cascade as soon as a credential appears.
  assert.equal(resolveDevinWireUid("swe-2", "max"), "swe-2-max");
  assert.equal(resolveDevinWireUid("swe-2", undefined), "swe-2-high");
  assert.equal(published.length, 0);

  // Online without a credential: the seed stands in for the roster.
  const anonymous = await refreshDevinModels({ allowNetwork: true, signal, publish } as never);
  assert.deepEqual(anonymous.map((model) => model.id), ["swe-2"]);

  // Online with a credential but a failing catalog: still the seed.
  const failing = await startFakeEdge(() => ({ status: 500, chunks: [Buffer.from("boom")] }));
  try {
    const fallback = await refreshDevinModels(
      {
        allowNetwork: true,
        signal,
        publish,
        credential: { type: "oauth", access: "token", refresh: "token", expires: 0 },
      } as never,
      { baseUrl: failing.baseUrl },
    );
    assert.deepEqual(fallback.map((model) => model.id), ["swe-2"]);
  } finally {
    await failing.close();
  }

  // Online with a working catalog: the allowlisted lanes replace the seed,
  // their ladders reach the route table, and the catalog is persisted.
  const edge = await startFakeEdge(() => ({
    chunks: [
      Buffer.from(toBinary(
        GetCliModelConfigsResponseSchema,
        create(GetCliModelConfigsResponseSchema, { clientModelConfigs: discoveryFixtures() }),
      )),
    ],
  }));
  try {
    const discovered = await refreshDevinModels(
      {
        allowNetwork: true,
        signal,
        publish,
        credential: { type: "oauth", access: "token", refresh: "token", expires: 0 },
      } as never,
      { baseUrl: edge.baseUrl },
    );
    const ids = discovered.map((model) => model.id).sort();
    assert.deepEqual(ids, ["swe-2"], "only allowlisted lanes are published");
    assert.deepEqual(lookupDevinRoute("swe-2"), {
      uid: "swe-2-high",
      byEffort: { medium: "swe-2-medium", high: "swe-2-high", max: "swe-2-max" },
      router: false,
    });
    assert.equal(lookupDevinRoute("swe-1-7"), undefined, "non-allowlisted lanes keep no route");
    assert.equal(lookupDevinRoute("MODEL_ROUTER"), undefined, "routers are filtered out");
    assert.equal(published.length, 1);
    const persist = published[0]?.persist;
    assert.ok(persist);
    assert.equal(persist.models.length, discovered.length);
    assert.equal(persist.models.every((model) => model.provider === "devin"), true);
    assert.equal(typeof persist.checkedAt, "number");
  } finally {
    await edge.close();
  }
});
