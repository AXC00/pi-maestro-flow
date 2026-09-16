/**
 * Devin (Codeium Cascade) chat transport for pi.
 *
 * Implements the Connect/protobuf protocol the Devin CLI speaks: `GetUserJwt`
 * exchanges the stored CLI session token for a user JWT, then `GetChatMessage`
 * streams one Cascade turn as gzip-framed protobuf deltas. It is registered as
 * the `devin` provider's `api`/`streamSimple` pair (see devin-provider.ts), so
 * the credential `/login devin` stored is what authenticates every request.
 *
 * The wire shape follows oh-my-pi's Devin provider (MIT; see LICENSE.oh-my-pi).
 * Deliberate differences: router (`adaptive`) models and `AssignModel` are not
 * implemented, the model uid is the seed id, and `options.onPayload` is not
 * fired because the request body is a protobuf message rather than JSON.
 */

import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  calculateCost,
  createAssistantMessageEventStream,
  parseStreamingJson,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type ToolResultMessage,
  type Usage,
  type UserMessage,
} from "@earendil-works/pi-ai";

import {
  AssignModelRequestSchema,
  AssignModelResponseSchema,
  CacheControlType,
  ChatMessagePromptSchema,
  ChatMessageRequestType,
  ChatMessageSource,
  ChatToolCallSchema,
  ChatToolChoiceSchema,
  ChatToolDefinitionSchema,
  CompletionConfigurationSchema,
  ConversationalPlannerMode,
  GetChatMessageRequestSchema,
  GetChatMessageResponseSchema,
  GetUserJwtRequestSchema,
  GetUserJwtResponseSchema,
  ImageDataSchema,
  MetadataSchema,
  PromptCacheOptionsSchema,
  StopReason,
  type ChatMessagePrompt,
  type ChatToolCall,
  type GetChatMessageRequest,
  type Metadata,
  type ModelAssignment,
} from "./devin-proto.ts";
import { create, fromBinary, toBinary, type MessageCodec, type ProtoMessage } from "./protobuf.ts";
import {
  DEVIN_API_BASE_URL,
  isDevinRouterModel,
  resolveDevinWireUid,
} from "./routing.ts";

/** API selector registered by devin-provider.ts. */
export const DEVIN_API = "devin-agent";
export { DEVIN_API_BASE_URL };

const CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
const ASSIGN_MODEL_PATH = "/exa.api_server_pb.ApiServerService/AssignModel";
const DEVIN_AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
const DEVIN_DEFAULT_STOP_PATTERNS = [
  "<|user|>",
  "<|bot|>",
  "<|context_request|>",
  "<|endoftext|>",
  "<|end_of_turn|>",
];
/** `devin-session-token$` prefix the Cascade API expects on the stored token. */
const SESSION_TOKEN_PREFIX = "devin-session-token$";
/** Connect streaming framing: bit 0x01 = gzip payload, bit 0x02 = end-of-stream trailers. */
const CONNECT_COMPRESSED_FLAG = 0x01;
const CONNECT_END_STREAM_FLAG = 0x02;
/**
 * Cap on one Connect frame payload. The 4-byte length prefix is peer-controlled
 * (up to 2**32-1), so a corrupt prefix must fail fast instead of buffering.
 */
const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024;
const MAX_ERROR_DETAIL_CHARS = 2048;
const HTML_BODY_PATTERN = /^\s*(?:<!doctype\s+html\b|<html\b)/i;
const CLI_IDENTITY = {
  ideName: "devin-cli",
  ideType: "chisel",
  ideVersion: "3000.6.2",
  extensionName: "chisel",
  extensionVersion: "3000.6.2",
} as const;

/** pi thinking levels are encoded in the model uid, so the transport keeps none. */
const DEVIN_SESSION_TOKEN_HELP =
  "Devin is not signed in or the stored session token was rejected; run /login devin.";

/** Cascade per-turn state shared by the auth handshake and the chat request. */
interface DevinTurn {
  apiKey: string | undefined;
  userJwt: string;
  cascadeId: string;
}

/** Stream one Cascade turn as pi assistant message events. */
export function streamDevin(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const startTime = Date.now();
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "pending",
      timestamp: startTime,
    };
    let currentTextBlock: TextContent | null = null;
    let currentThinkingBlock: ThinkingContent | null = null;
    const toolBlocks = new Map<string, ToolCall>();
    const toolPartialJson = new Map<string, string>();
    let activeToolCallId: string | undefined;
    let latestStopReason = StopReason.UNSPECIFIED;

    const endTextBlock = (): void => {
      const block = currentTextBlock;
      if (!block) return;
      currentTextBlock = null;
      stream.push({
        type: "text_end",
        contentIndex: output.content.indexOf(block),
        content: block.text,
        partial: output,
      });
    };
    const endThinkingBlock = (): void => {
      const block = currentThinkingBlock;
      if (!block) return;
      currentThinkingBlock = null;
      stream.push({
        type: "thinking_end",
        contentIndex: output.content.indexOf(block),
        content: block.thinking,
        partial: output,
      });
    };

    try {
      const fetchImpl = options?.fetch ?? fetch;
      const baseUrl = (model.baseUrl || DEVIN_API_BASE_URL).replace(/\/+$/, "");
      const auth = await fetchDevinAuthMetadata(model, fetchImpl, baseUrl, options);
      const turn: DevinTurn = {
        apiKey: options?.apiKey,
        userJwt: auth.userJwt,
        cascadeId: crypto.randomUUID(),
      };
      const messages = prepareMessages(context.messages, model);
      // Cascade encodes reasoning strength as a wire uid, and router lanes must
      // be resolved by the server before the turn is sent.
      const wireUid = resolveDevinWireUid(model.id, options?.reasoning);
      const assignment = isDevinRouterModel(model.id)
        ? await assignDevinModel(model, turn, auth.baseUrl ?? baseUrl, fetchImpl, messages, options)
        : undefined;
      const request = buildDevinChatRequest(model, context, messages, turn, options, {
        wireUid: assignment?.modelUid ?? wireUid,
        ...(assignment ? { assignmentJwt: assignment.assignmentJwt } : {}),
      });
      const compressed = gzipSync(toBinary(GetChatMessageRequestSchema, request));
      const frame = Buffer.alloc(5 + compressed.length);
      frame[0] = CONNECT_COMPRESSED_FLAG;
      frame.writeUInt32BE(compressed.length, 1);
      frame.set(compressed, 5);

      const response = await fetchImpl(`${auth.baseUrl ?? baseUrl}${CHAT_MESSAGE_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/connect+proto",
          "connect-protocol-version": "1",
          "connect-content-encoding": "gzip",
          "accept-encoding": "identity",
          "connect-accept-encoding": "gzip",
          ...options?.headers,
        },
        body: frame,
        signal: options?.signal,
      });
      await options?.onResponse?.(providerResponse(response), model);
      if (!response.ok) throw await devinHttpError("API", response);
      if (!response.body) throw new Error("Devin API error: response body is empty");

      stream.push({ type: "start", partial: output });

      const reader = response.body.getReader();
      let pending: Buffer = Buffer.alloc(0);
      for (;;) {
        const { done, value } = await reader.read();
        if (value && value.length > 0) {
          pending = pending.length === 0
            ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
            : Buffer.concat([pending, value]);
        }

        while (pending.length >= 5) {
          const flag = pending[0] ?? 0;
          const length = pending.readUInt32BE(1);
          if (length > MAX_CONNECT_FRAME_PAYLOAD) {
            throw new Error(
              `Devin Connect frame length ${length} exceeds the ${MAX_CONNECT_FRAME_PAYLOAD}-byte cap`,
            );
          }
          if (pending.length < 5 + length) break;
          const payload = pending.subarray(5, 5 + length);
          pending = pending.subarray(5 + length);

          if (flag & CONNECT_END_STREAM_FLAG) {
            const text = (flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload).toString("utf8").trim();
            const trailer = readConnectTrailerError(text);
            if (trailer) throw new Error(trailer);
            continue;
          }

          const raw = flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload;
          const message = fromBinary(GetChatMessageResponseSchema, raw);
          if (message.messageId && !output.responseId) output.responseId = message.messageId;
          if (message.actualModelUid) output.responseModel = message.actualModelUid;

          if (message.deltaThinking) {
            if (!currentThinkingBlock) {
              currentThinkingBlock = { type: "thinking", thinking: "" };
              output.content.push(currentThinkingBlock);
              stream.push({
                type: "thinking_start",
                contentIndex: output.content.length - 1,
                partial: output,
              });
            }
            currentThinkingBlock.thinking += message.deltaThinking;
            if (message.deltaSignature) currentThinkingBlock.thinkingSignature = message.deltaSignature;
            stream.push({
              type: "thinking_delta",
              contentIndex: output.content.indexOf(currentThinkingBlock),
              delta: message.deltaThinking,
              partial: output,
            });
          }

          if (message.deltaText) {
            endThinkingBlock();
            if (!currentTextBlock) {
              currentTextBlock = { type: "text", text: "" };
              output.content.push(currentTextBlock);
              stream.push({
                type: "text_start",
                contentIndex: output.content.length - 1,
                partial: output,
              });
            }
            currentTextBlock.text += message.deltaText;
            stream.push({
              type: "text_delta",
              contentIndex: output.content.indexOf(currentTextBlock),
              delta: message.deltaText,
              partial: output,
            });
          }

          if (message.deltaToolCalls.length > 0) {
            endTextBlock();
            endThinkingBlock();
            for (const delta of message.deltaToolCalls) {
              const toolCallId = delta.id || activeToolCallId;
              if (!toolCallId) continue;
              let block = toolBlocks.get(toolCallId);
              if (!block) {
                block = { type: "toolCall", id: toolCallId, name: delta.name, arguments: {} };
                output.content.push(block);
                toolBlocks.set(toolCallId, block);
                toolPartialJson.set(toolCallId, "");
                stream.push({
                  type: "toolcall_start",
                  contentIndex: output.content.length - 1,
                  partial: output,
                });
              }
              if (delta.name) block.name = delta.name;
              activeToolCallId = toolCallId;
              if (!delta.argumentsJson) continue;
              const previous = toolPartialJson.get(toolCallId) ?? "";
              // The backend sends either whole-state or appended fragments; a
              // fragment that does not continue the buffer is appended verbatim.
              const accumulated = delta.argumentsJson.startsWith(previous)
                ? delta.argumentsJson
                : previous + delta.argumentsJson;
              toolPartialJson.set(toolCallId, accumulated);
              block.arguments = parseStreamingJson<Record<string, unknown>>(accumulated);
              stream.push({
                type: "toolcall_delta",
                contentIndex: output.content.indexOf(block),
                delta: accumulated.slice(previous.length),
                partial: output,
              });
            }
          }

          if (message.stopReason !== StopReason.UNSPECIFIED) latestStopReason = message.stopReason;
          if (message.usage) {
            output.usage.input = Number(message.usage.inputTokens);
            output.usage.output = Number(message.usage.outputTokens);
            output.usage.cacheRead = Number(message.usage.cacheReadTokens);
            output.usage.cacheWrite = Number(message.usage.cacheWriteTokens);
            output.usage.totalTokens =
              output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          }
        }

        if (done) break;
      }

      endTextBlock();
      endThinkingBlock();
      for (const [id, block] of toolBlocks) {
        block.arguments = parseStreamingJson<Record<string, unknown>>(toolPartialJson.get(id));
        stream.push({
          type: "toolcall_end",
          contentIndex: output.content.indexOf(block),
          toolCall: block,
          partial: output,
        });
      }

      const reason: "stop" | "length" | "toolUse" = toolBlocks.size > 0
        ? "toolUse"
        : latestStopReason === StopReason.MAX_TOKENS
          ? "length"
          : "stop";
      output.stopReason = reason;
      calculateCost(model, output.usage);
      stream.push({ type: "done", reason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = errorMessage(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

const USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

/**
 * Cascade lanes see text only, so history written by a vision model must not
 * ship image payloads they ignore. Semantic copy of pi's own message downgrade;
 * implemented locally because pi's `transformMessages` sits behind a pi-ai
 * subpath the extension loader does not alias (only `/compat`, `/oauth` and
 * `/providers/all` are mapped). Tool-call ids need no normalization here: every
 * id this transport replays was minted by this transport.
 */
function prepareMessages(messages: Message[], model: Model<Api>): Message[] {
  if (model.input.includes("image")) return messages;
  return messages.map((message) => {
    if (message.role === "user" && Array.isArray(message.content)) {
      return { ...message, content: replaceImagesWithPlaceholder(message.content, USER_IMAGE_PLACEHOLDER) };
    }
    if (message.role === "toolResult") {
      return { ...message, content: replaceImagesWithPlaceholder(message.content, TOOL_IMAGE_PLACEHOLDER) };
    }
    return message;
  });
}

function replaceImagesWithPlaceholder(
  content: (TextContent | ImageContent)[],
  placeholder: string,
): (TextContent | ImageContent)[] {
  const result: (TextContent | ImageContent)[] = [];
  let previousWasPlaceholder = false;
  for (const block of content) {
    if (block.type === "image") {
      if (!previousWasPlaceholder) result.push({ type: "text", text: placeholder });
      previousWasPlaceholder = true;
      continue;
    }
    result.push(block);
    previousWasPlaceholder = block.text === placeholder;
  }
  return result;
}

/** Cascade `Metadata` for released-CLI calls; `userJwt` stays empty until the handshake. */
function devinCliMetadata(apiKey: string | undefined, userJwt = ""): Metadata {
  return create(MetadataSchema, {
    apiKey: normalizeSessionToken(apiKey),
    userJwt,
    ideName: CLI_IDENTITY.ideName,
    ideType: CLI_IDENTITY.ideType,
    ideVersion: CLI_IDENTITY.ideVersion,
    extensionName: CLI_IDENTITY.extensionName,
    extensionVersion: CLI_IDENTITY.extensionVersion,
    locale: "en",
    os: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux",
  });
}

/** The wire format requires the scheme prefix on the session token. */
function normalizeSessionToken(apiKey: string | undefined): string {
  if (!apiKey) return "";
  return apiKey.startsWith(SESSION_TOKEN_PREFIX) ? apiKey : `${SESSION_TOKEN_PREFIX}${apiKey}`;
}

/**
 * Exchange the stored session token for a user JWT. Cascade additionally reports
 * the account's own API server host, which replaces the default base URL for the
 * chat call and doubles as the Cascade session id.
 */
async function fetchDevinAuthMetadata(
  model: Model<Api>,
  fetchImpl: typeof fetch,
  baseUrl: string,
  options: SimpleStreamOptions | undefined,
): Promise<{ userJwt: string; baseUrl?: string }> {
  const request = create(GetUserJwtRequestSchema, {
    metadata: devinCliMetadata(options?.apiKey),
  });
  const response = await fetchImpl(`${baseUrl}${DEVIN_AUTH_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/proto",
      "connect-protocol-version": "1",
      accept: "*/*",
    },
    body: toBinary(GetUserJwtRequestSchema, request),
    signal: options?.signal,
  });
  await options?.onResponse?.(providerResponse(response), model);
  if (!response.ok) throw await devinHttpError("auth", response);
  const payload = new Uint8Array(await response.arrayBuffer());
  const decoded = decodeDevinUnaryMessage(GetUserJwtResponseSchema, payload);
  if (!decoded?.userJwt) throw new Error(`Devin auth error: GetUserJwt returned no user JWT. ${DEVIN_SESSION_TOKEN_HELP}`);
  const custom = decoded.customApiServerUrl.trim();
  return { userJwt: decoded.userJwt, ...(custom ? { baseUrl: custom.replace(/\/+$/, "") } : {}) };
}

/**
 * Decode a unary Connect response. Edges variously return bare protobuf or a
 * gzipped body, so the direct decode is attempted before the gzip fallback.
 */
function decodeDevinUnaryMessage<T extends ProtoMessage>(
  schema: MessageCodec<T>,
  payload: Uint8Array,
): T | null {
  try {
    return fromBinary(schema, payload);
  } catch {
    try {
      return fromBinary(schema, gunzipSync(payload));
    } catch {
      return null;
    }
  }
}

/** Wire model selection for one turn. */
export interface DevinTurnTarget {
  /** Wire uid to send, after effort routing and any router assignment. */
  wireUid: string;
  /** Assignment JWT authorizing a router-resolved uid. */
  assignmentJwt?: string;
}

/**
 * Ask the server to resolve a router lane into a concrete model uid. The router
 * uid is never a legal chat uid, so a failed assignment must fail the turn
 * rather than fall back to sending it.
 */
async function assignDevinModel(
  model: Model<Api>,
  turn: DevinTurn,
  baseUrl: string,
  fetchImpl: typeof fetch,
  messages: Message[],
  options: SimpleStreamOptions | undefined,
): Promise<ModelAssignment> {
  const request = create(AssignModelRequestSchema, {
    metadata: devinCliMetadata(turn.apiKey),
    modelRouterUid: model.id,
    cascadeId: turn.cascadeId,
    chatMessagePrompt: buildRouterPrompt(messages),
  });
  const response = await fetchImpl(`${baseUrl}${ASSIGN_MODEL_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/proto",
      "connect-protocol-version": "1",
      accept: "*/*",
    },
    body: toBinary(AssignModelRequestSchema, request),
    signal: options?.signal,
  });
  await options?.onResponse?.(providerResponse(response), model);
  if (!response.ok) throw await devinHttpError("AssignModel", response);
  const payload = new Uint8Array(await response.arrayBuffer());
  const assignment = decodeDevinUnaryMessage(AssignModelResponseSchema, payload)?.assignment;
  if (!assignment?.assignmentJwt || !assignment.modelUid) {
    throw new Error("Devin AssignModel error: the response carried no assignment JWT and model uid");
  }
  return assignment;
}

/**
 * The prompt the router scores: the current user turn on its own. Its message id
 * stays empty — the chat request that follows mints the turn's id.
 */
function buildRouterPrompt(messages: Message[]): ChatMessagePrompt | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user") return buildUserPrompt(message, "");
  }
  return undefined;
}

/** Build the `GetChatMessage` request for one Cascade turn. */
export function buildDevinChatRequest(
  model: Model<Api>,
  context: Context,
  messages: Message[],
  turn: DevinTurn,
  options?: SimpleStreamOptions,
  target?: DevinTurnTarget,
): GetChatMessageRequest {
  const tools = (context.tools ?? []).map((tool) =>
    create(ChatToolDefinitionSchema, {
      name: tool.name,
      description: tool.description,
      jsonSchemaString: JSON.stringify(tool.parameters),
      strict: false,
    })
  );
  return create(GetChatMessageRequestSchema, {
    metadata: devinCliMetadata(turn.apiKey, turn.userJwt),
    prompt: context.systemPrompt ?? "",
    chatMessagePrompts: buildChatMessagePrompts(messages, turn.cascadeId, model),
    chatModelUid: target?.wireUid ?? model.id,
    ...(target?.assignmentJwt ? { modelAssignmentJwt: target.assignmentJwt } : {}),
    requestType: ChatMessageRequestType.CASCADE,
    plannerMode: ConversationalPlannerMode.DEFAULT,
    toolChoice: create(ChatToolChoiceSchema, { choice: { case: "optionName", value: "auto" } }),
    systemPromptCacheOptions: create(PromptCacheOptionsSchema, { type: CacheControlType.EPHEMERAL }),
    // Both bundled lanes declare parallel tool-call support upstream, so the
    // Cascade request keeps that capability instead of forcing serial calls.
    disableParallelToolCalls: false,
    cascadeId: turn.cascadeId,
    executionId: crypto.randomUUID(),
    configuration: create(CompletionConfigurationSchema, {
      numCompletions: 1n,
      maxTokens: BigInt(options?.maxTokens ?? model.maxTokens ?? 64_000),
      maxNewlines: 200n,
      temperature: options?.temperature ?? 0.4,
      firstTemperature: options?.temperature ?? 0.4,
      topK: 50n,
      topP: 1,
      stopPatterns: [...DEVIN_DEFAULT_STOP_PATTERNS],
      fimEotProbThreshold: 1,
    }),
    tools,
  });
}

/** Flatten one user turn into a Cascade USER prompt, keeping inline images. */
function buildUserPrompt(message: UserMessage, messageId: string): ChatMessagePrompt {
  let prompt = "";
  const images = [];
  if (typeof message.content === "string") {
    prompt = message.content;
  } else {
    for (const part of message.content) {
      if (part.type === "text") prompt += part.text;
      else if (part.type === "image") {
        images.push(create(ImageDataSchema, { base64Data: part.data, mimeType: part.mimeType }));
      }
    }
  }
  return create(ChatMessagePromptSchema, {
    messageId,
    source: ChatMessageSource.USER,
    prompt,
    images,
  });
}

/** Map pi history onto Cascade USER / SYSTEM / TOOL channels. */
function buildChatMessagePrompts(
  messages: Message[],
  cascadeId: string,
  model: Model<Api>,
): ChatMessagePrompt[] {
  const prompts: ChatMessagePrompt[] = [];
  // Ids are seeded from the cascade id, position, and role only, so editing a
  // message never changes its id and the server keeps threading history.
  for (const [index, message] of messages.entries()) {
    if (message.role === "user") {
      prompts.push(buildUserPrompt(message, deterministicUuid(`${cascadeId}\0${index}\0${message.role}`)));
      continue;
    }
    if (message.role === "assistant") {
      let text = "";
      let thinking = "";
      let signature = "";
      const toolCalls: ChatToolCall[] = [];
      const isNativeDevinMessage = message.api === model.api
        && message.provider === model.provider
        && message.model === model.id;
      for (const part of message.content) {
        if (part.type === "text") text += part.text;
        else if (part.type === "thinking") {
          thinking += part.thinking;
          if (isNativeDevinMessage && !signature && part.thinkingSignature) {
            signature = part.thinkingSignature;
          }
        } else if (part.type === "toolCall") {
          toolCalls.push(create(ChatToolCallSchema, {
            id: part.id,
            name: part.name,
            argumentsJson: JSON.stringify(part.arguments),
          }));
        }
      }
      if (!text && !thinking && !signature && toolCalls.length === 0) continue;
      prompts.push(create(ChatMessagePromptSchema, {
        messageId: isNativeDevinMessage && message.responseId
          ? message.responseId
          : `bot-${deterministicUuid(`${cascadeId}\0${index}\0assistant`)}`,
        source: ChatMessageSource.SYSTEM,
        prompt: text,
        thinking,
        signature,
        toolCalls,
      }));
      continue;
    }
    prompts.push(buildToolPrompt(message, cascadeId, index));
  }
  return prompts;
}

function buildToolPrompt(message: ToolResultMessage, cascadeId: string, index: number): ChatMessagePrompt {
  let text = "";
  const images = [];
  for (const part of message.content) {
    if (part.type === "text") text += part.text;
    else if (part.type === "image") {
      images.push(create(ImageDataSchema, { base64Data: part.data, mimeType: part.mimeType }));
    }
  }
  return create(ChatMessagePromptSchema, {
    messageId: deterministicUuid(`${cascadeId}\0${index}\0tool\0${message.toolCallId}`),
    source: ChatMessageSource.TOOL,
    toolCallId: message.toolCallId,
    toolResultIsError: message.isError,
    prompt: text,
    images,
  });
}

/**
 * UUID-shaped id derived from a seed's SHA-256 digest. Deterministic ids keep
 * Cascade history stable across turns without persisting a seed→id mapping.
 */
export function deterministicUuid(seed: string): string {
  const hex = createHash("sha256").update(seed, "utf8").digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Parse a Connect end-of-stream trailer. Returns the formatted error when it
 * carries `{ error: { code, message } }`, else undefined. The trailer is
 * untrusted server output, so the shape is guarded rather than asserted.
 */
export function readConnectTrailerError(text: string): string | undefined {
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return undefined;
  const error = (parsed as { error?: unknown }).error;
  if (!error || typeof error !== "object") return undefined;
  const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "";
  const message = typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : "";
  if (!code && !message) return undefined;
  return `Devin stream error${code ? ` ${code}` : ""}: ${message || "no message"}`;
}

/**
 * Non-2xx Devin response. The body is bounded and suppressed for HTML, which
 * proxies and gateways return instead of a protocol error.
 */
async function devinHttpError(operation: string, response: Response): Promise<Error> {
  let detail = "";
  try {
    const text = (await response.text()).trim();
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (text && !contentType.includes("text/html") && !HTML_BODY_PATTERN.test(text)) {
      const collapsed = text.replace(/\s+/g, " ");
      detail = `: ${collapsed.length > MAX_ERROR_DETAIL_CHARS ? `${collapsed.slice(0, MAX_ERROR_DETAIL_CHARS)}…` : collapsed}`;
    }
  } catch {
    // A body that cannot be read adds no diagnostic value.
  }
  const hint = response.status === 401 || response.status === 403 ? ` ${DEVIN_SESSION_TOKEN_HELP}` : "";
  return new Error(`Devin ${operation} error ${response.status}${detail}${hint}`);
}

/** Minimal `ProviderResponse` projection for the `onResponse` callback. */
function providerResponse(response: Response): { status: number; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  for (const [key, value] of response.headers.entries()) headers[key] = value;
  return { status: response.status, headers };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
