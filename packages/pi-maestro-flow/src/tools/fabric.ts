import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FABRIC_CONTROL_VERSION } from "pi-maestro-fabric-core/v1";
import { Type, type Static } from "typebox";
import { createGatewayLocalClient } from "../gateway/local-client.ts";
import { resultSummary, toolCallLine, toolResultLine } from "../quiet-render.ts";
import type { FlowToolResult } from "./tool-result.ts";

const id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" });
const deadline = Type.Optional(Type.Integer({ minimum: 0, description: "Absolute Unix epoch deadline; defaults to 30 seconds from dispatch." }));
const ttl = Type.Integer({ minimum: 1, maximum: 86_400_000 });
const base = { deadlineAt: deadline };

export const FabricDeviceParams = Type.Union([
  Type.Object({ action: Type.Literal("list"), ...base }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("get"), deviceId: id, ...base }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("pair"), connectorId: id, deviceId: id, pairingRef: Type.String({ minLength: 1, maxLength: 2048 }), ...base }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("connect"), deviceId: id, connectorId: id, expectedCredentialGeneration: Type.Integer({ minimum: 1 }), ...base }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("disconnect"), deviceId: id, connectionId: id, expectedConnectionGeneration: Type.Integer({ minimum: 1 }), ...base }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("status"), deviceId: id, ...base }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("workspaces"), deviceId: id, ...base }, { additionalProperties: false }),
], { type: "object" });

export const FabricWorkspaceParams = Type.Union([
  Type.Object({ action: Type.Literal("list"), deviceId: Type.Optional(id), ...base }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("bind"), deviceId: id, connectionId: id, workspaceId: id,
    expectedConnectionGeneration: Type.Integer({ minimum: 1 }), expectedWorkspaceGeneration: Type.Integer({ minimum: 1 }),
    requestedTtlMs: ttl, ...base,
  }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("renew"), workspaceBindingId: id, expectedRevision: Type.Integer({ minimum: 0 }), requestedTtlMs: ttl, ...base }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("unbind"), workspaceBindingId: id, expectedRevision: Type.Integer({ minimum: 0 }), ...base }, { additionalProperties: false }),
], { type: "object" });

export const FabricEndpointParams = Type.Union([
  Type.Object({
    action: Type.Literal("list"), deviceId: Type.Optional(id), workspaceId: Type.Optional(id),
    endpointKind: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("mcp")])),
    endpointStatus: Type.Optional(Type.Union([Type.Literal("unknown"), Type.Literal("online"), Type.Literal("offline"), Type.Literal("disabled")])),
    ...base,
  }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("describe"), endpointId: id, ...base }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("select"), endpointId: id, ...base }, { additionalProperties: false }),
], { type: "object" });

export const FabricRouteParams = Type.Union([
  Type.Object({
    action: Type.Literal("open"), connectionId: id, workspaceBindingId: Type.Optional(id), endpointId: id,
    expectedConnectionGeneration: Type.Integer({ minimum: 1 }), expectedWorkspaceGeneration: Type.Optional(Type.Integer({ minimum: 1 })),
    expectedEndpointGeneration: Type.Integer({ minimum: 1 }), requestedTtlMs: ttl,
    operationClass: Type.Union([Type.Literal("agent-placement"), Type.Literal("mcp-read"), Type.Literal("mcp-mutation"), Type.Literal("artifact-read")]),
    pathCandidates: Type.Array(Type.Union([Type.Literal("hub"), Type.Literal("lan-direct"), Type.Literal("edge-relay"), Type.Literal("vps-relay")]), { minItems: 1, maxItems: 4, uniqueItems: true }),
    ...base,
  }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("renew"), routeId: id, expectedRevision: Type.Integer({ minimum: 0 }), requestedTtlMs: ttl, ...base }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("close"), routeId: id, expectedRevision: Type.Integer({ minimum: 0 }), ...base }, { additionalProperties: false }),
], { type: "object" });

export interface GatewayFabricToolDetails {
  tool: "device" | "workspace" | "endpoint" | "route";
  action: string;
  ok: boolean;
}

export interface GatewayFabricCaller {
  call(tool: string, args: Record<string, unknown>, options: { cwd: string; signal?: AbortSignal }): Promise<CallToolResult>;
}

const defaultCaller: GatewayFabricCaller = {
  async call(tool, args, options) {
    return createGatewayLocalClient({ cwd: options.cwd }).call(tool, args, options.signal);
  },
};

async function executeFabric(
  tool: GatewayFabricToolDetails["tool"],
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  cwd: string,
  caller: GatewayFabricCaller,
): Promise<AgentToolResult<GatewayFabricToolDetails>> {
  const action = String(params.action);
  const response = await caller.call(tool, {
    ...params,
    version: FABRIC_CONTROL_VERSION,
    requestId: randomUUID(),
    deadlineAt: params.deadlineAt ?? Date.now() + 30_000,
  }, { cwd, signal });
  const text = response.content.find((item) => item.type === "text" && typeof item.text === "string");
  const output = text?.type === "text" ? text.text : JSON.stringify(response.structuredContent ?? response);
  return {
    content: [{ type: "text", text: output }],
    details: { tool, action, ok: response.isError !== true },
    ...(response.isError === true ? { isError: true } : {}),
  } as FlowToolResult<GatewayFabricToolDetails>;
}

function render(tool: string, args: Record<string, unknown>, theme: Parameters<typeof toolCallLine>[0]) {
  return toolCallLine(theme, tool, String(args.action ?? "?"));
}

function renderOutput(tool: string, result: AgentToolResult<GatewayFabricToolDetails>, options: { isPartial: boolean; expanded: boolean }, theme: Parameters<typeof toolResultLine>[0], context: { isError: boolean; args: Record<string, unknown> }) {
  if (options.isPartial) return new Text("", 0, 0);
  const text = result.content.find((item) => item.type === "text");
  return toolResultLine(theme, {
    name: tool,
    ok: !context.isError,
    arg: String(context.args.action ?? "?"),
    summary: resultSummary(result),
    expanded: options.expanded,
    detail: text && "text" in text ? text.text : "",
  });
}

export function createFabricDeviceTool(caller: GatewayFabricCaller = defaultCaller): ToolDefinition<typeof FabricDeviceParams, GatewayFabricToolDetails> {
  return {
    name: "device", label: "Fabric Device",
    description: "Explicit Fabric Device control: list, get, pair, connect, disconnect, status, workspaces. Discovery never connects; pair returns only safe out-of-band guidance.",
    parameters: FabricDeviceParams, executionMode: "sequential",
    execute: async (_id, params, signal, _update, ctx) => executeFabric("device", params, signal, ctx.cwd, caller),
    renderCall: (args, theme, ctx) => ctx?.isPartial === false ? new Text("", 0, 0) : render("device", args, theme),
    renderResult: (result, options, theme, ctx) => renderOutput("device", result, options, theme, ctx),
  };
}

export function createFabricWorkspaceTool(caller: GatewayFabricCaller = defaultCaller): ToolDefinition<typeof FabricWorkspaceParams, GatewayFabricToolDetails> {
  return {
    name: "workspace", label: "Fabric Workspace",
    description: "List authorized Fabric Workspace projections and explicitly bind, renew, or unbind them. Fabric binding accepts stable IDs only; path-only input is invalid.",
    parameters: FabricWorkspaceParams, executionMode: "sequential",
    execute: async (_id, params, signal, _update, ctx) => executeFabric("workspace", params, signal, ctx.cwd, caller),
    renderCall: (args, theme, ctx) => ctx?.isPartial === false ? new Text("", 0, 0) : render("workspace", args, theme),
    renderResult: (result, options, theme, ctx) => renderOutput("workspace", result, options, theme, ctx),
  };
}

export function createFabricEndpointTool(caller: GatewayFabricCaller = defaultCaller): ToolDefinition<typeof FabricEndpointParams, GatewayFabricToolDetails> {
  return {
    name: "endpoint", label: "Fabric Endpoint",
    description: "List, describe, or select an exact Fabric Endpoint. Selection returns a descriptor only and never connects or executes.",
    parameters: FabricEndpointParams, executionMode: "sequential",
    execute: async (_id, params, signal, _update, ctx) => executeFabric("endpoint", params, signal, ctx.cwd, caller),
    renderCall: (args, theme, ctx) => ctx?.isPartial === false ? new Text("", 0, 0) : render("endpoint", args, theme),
    renderResult: (result, options, theme, ctx) => renderOutput("endpoint", result, options, theme, ctx),
  };
}

export function createFabricRouteTool(caller: GatewayFabricCaller = defaultCaller): ToolDefinition<typeof FabricRouteParams, GatewayFabricToolDetails> {
  return {
    name: "route", label: "Fabric Route",
    description: "Explicitly open, renew, or close one generation-fenced Fabric Route. route.open never performs Endpoint selection or connection.",
    parameters: FabricRouteParams, executionMode: "sequential",
    execute: async (_id, params, signal, _update, ctx) => executeFabric("route", params, signal, ctx.cwd, caller),
    renderCall: (args, theme, ctx) => ctx?.isPartial === false ? new Text("", 0, 0) : render("route", args, theme),
    renderResult: (result, options, theme, ctx) => renderOutput("route", result, options, theme, ctx),
  };
}

export function registerGatewayFabricTools(pi: ExtensionAPI, caller?: GatewayFabricCaller): void {
  pi.registerTool(createFabricDeviceTool(caller));
  pi.registerTool(createFabricWorkspaceTool(caller));
  pi.registerTool(createFabricEndpointTool(caller));
  pi.registerTool(createFabricRouteTool(caller));
}

export type FabricDeviceToolParams = Static<typeof FabricDeviceParams>;
export type FabricWorkspaceToolParams = Static<typeof FabricWorkspaceParams>;
export type FabricEndpointToolParams = Static<typeof FabricEndpointParams>;
export type FabricRouteToolParams = Static<typeof FabricRouteParams>;
