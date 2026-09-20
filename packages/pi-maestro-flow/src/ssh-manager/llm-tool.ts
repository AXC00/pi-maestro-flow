import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  MAX_SSH_COMMAND_BYTES,
  MAX_SSH_TIMEOUT_SECONDS,
  SshExecutor,
  type SshExecuteOptions,
  type SshExecutionResult,
} from "./executor.ts";
import { SshBgParams, type SshBgInput } from "./ssh-bg.ts";
import { SSH_HOST_ID_PATTERN, type SshHost } from "./model.ts";
import type { SshStartPiInput } from "./gateway-session-launch.ts";

const sshCommandProperties = {
  command: Type.String({
    minLength: 1,
    maxLength: MAX_SSH_COMMAND_BYTES,
    description: "Command to execute on the resolved SSH target",
  }),
  cwd: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 4096,
    description: "Optional working directory on the resolved target",
  })),
  timeout: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: MAX_SSH_TIMEOUT_SECONDS,
    description: "Timeout in seconds (default 30, maximum 300)",
  })),
};

const sshTargetId = () => Type.Optional(Type.String({
  pattern: SSH_HOST_ID_PATTERN.source,
  minLength: 1,
  maxLength: 64,
  description: "Provider-owned target id returned by action=targets; omit only when exactly one #ssh server is attached",
}));

export const SshCommandToolParams = Type.Object(sshCommandProperties, { additionalProperties: false });

const gatewayToolName = Type.String({ minLength: 1, maxLength: 128 });
const SSH_ACTIONS = [
  "guide",
  "targets",
  "ensure_gateway",
  "status",
  "list",
  "describe",
  "call",
  "start_pi",
  "sync_pi_config",
  "job_start",
  "job_run",
  "job_exec",
  "job_status",
  "job_wait",
  "job_kill",
  "job_list",
  "job_close",
] as const;
type SshToolAction = (typeof SSH_ACTIONS)[number];
const SSH_CONFIG_CATEGORIES = ["models", "auth", "teammate"] as const;
type SshConfigCategory = (typeof SSH_CONFIG_CATEGORIES)[number];

const COMMAND_KEYS = new Set(["command", "cwd", "timeout", "targetId"]);
const ACTION_KEYS: Record<SshToolAction, ReadonlySet<string>> = {
  guide: new Set(["action"]),
  targets: new Set(["action"]),
  ensure_gateway: new Set(["action", "targetId", "timeout"]),
  status: new Set(["action", "targetId"]),
  list: new Set(["action", "targetId"]),
  describe: new Set(["action", "targetId", "tool"]),
  call: new Set(["action", "targetId", "tool", "args", "timeout"]),
  start_pi: new Set(["action", "targetId", "todoIds", "objective", "agent", "timeout", "requestId"]),
  sync_pi_config: new Set(["action", "targetId", "categories"]),
  job_start: new Set(["action", "targetId", "sessionId", "command", "cwd", "timeout"]),
  job_run: new Set(["action", "targetId", "sessionId", "command", "cwd", "timeout", "tail"]),
  job_exec: new Set(["action", "sessionId", "command", "cwd", "timeout", "tail"]),
  job_status: new Set(["action", "jobId", "tail"]),
  job_wait: new Set(["action", "jobId", "timeout", "tail"]),
  job_kill: new Set(["action", "jobId"]),
  job_list: new Set(["action"]),
  job_close: new Set(["action", "sessionId"]),
};

// Keep the function schema rooted at an object. Pi publishes only top-level
// properties; a root Union/anyOf is sent to the model as `{ properties: {} }`.
// Action-specific exclusivity is enforced by parseSshToolInput().
export const SshToolParams = Type.Object({
  action: Type.Optional(Type.Unsafe<SshToolAction>({
    type: "string",
    enum: [...SSH_ACTIONS],
    description: "Gateway or listing action. Omit this field to run a remote command.",
  })),
  targetId: sshTargetId(),
  command: Type.Optional(Type.String({
    minLength: 1,
    maxLength: MAX_SSH_COMMAND_BYTES,
    description: "Command to execute on the resolved SSH target. Mutually exclusive with action.",
  })),
  cwd: Type.Optional(Type.String({
    minLength: 1,
    maxLength: 4096,
    description: "Optional working directory on the resolved target (command only)",
  })),
  timeout: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: MAX_SSH_TIMEOUT_SECONDS,
    description: "Timeout in seconds (default 30, maximum 300)",
  })),
  tool: Type.Optional(gatewayToolName),
  args: Type.Optional(Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.Unknown(), {
    maxProperties: 256,
    description: "Arguments for the selected Gateway tool. Call action=describe for that tool first; use its exact inputSchema and action names.",
  })),
  categories: Type.Optional(Type.Array(Type.Unsafe<SshConfigCategory>({
    type: "string",
    enum: [...SSH_CONFIG_CATEGORIES],
  }), { minItems: 1, maxItems: 3, uniqueItems: true })),
  todoIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32, uniqueItems: true })),
  objective: Type.Optional(Type.String({ minLength: 1, maxLength: 16 * 1024 })),
  agent: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  requestId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "SSH background session id" })),
  jobId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "SSH background job id" })),
  tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Output lines to include" })),
}, {
  additionalProperties: false,
  description: "List unlocked SSH targets, execute a remote command, use the built-in Gateway, or manage background jobs. Pass command without action to run a shell command. Pass action without command for listing or Gateway. ensure_gateway may start a non-persistent remote daemon tied to the current local Pi session. job_start backgrounds immediately; job_run waits up to timeout then detaches; job_exec appends a command on the same SSH TCP session and backgrounds it immediately; job_status, job_wait, job_kill, job_list, and job_close provide job control. targetId selects a provider-owned configured server; omission works only when exactly one #ssh server is attached and errors for none or multiple. Host, authentication, and Gateway command parameters are never accepted. For dynamic Gateway calls, use action=describe tool=<name> to retrieve the authoritative inputSchema before action=call. session.start-pi returns taskId and monitorHandle; pass either value as monitor.handle.",
});

export type SshCommandToolInput = Static<typeof SshCommandToolParams>;
export type SshToolInput = Static<typeof SshToolParams>;
export type { SshBgInput, SshStartPiInput };

export type ParsedSshToolInput =
  | { kind: "command"; targetId?: string; command: string; cwd?: string; timeout?: number }
  | { kind: "guide" }
  | { kind: "targets" }
  | { kind: "ensure_gateway"; targetId?: string; timeout?: number }
  | { kind: "status"; targetId?: string }
  | { kind: "list"; targetId?: string }
  | { kind: "describe"; targetId?: string; tool: string }
  | { kind: "call"; targetId?: string; tool: string; args?: Record<string, unknown>; timeout?: number }
  | { kind: "start_pi"; targetId?: string; todoIds?: string[]; objective?: string; agent?: string; timeout?: number; requestId: string }
  | { kind: "sync_pi_config"; targetId?: string; categories: SshConfigCategory[] }
  | { kind: "job"; input: SshBgInput };

export function parseSshToolInput(params: unknown): ParsedSshToolInput {
  if (!Value.Check(SshToolParams, params)) throw new Error("Invalid SSH tool arguments");
  const input = params as SshToolInput;
  const keys = presentKeys(input);
  const hasAction = typeof input.action === "string";
  const hasCommand = typeof input.command === "string";
  if (hasAction && input.action!.startsWith("job_")) {
    if (!Value.Check(SshBgParams, params)) throw new Error(`Invalid SSH ${input.action} arguments`);
    return { kind: "job", input: params as SshBgInput };
  }
  if (hasAction === hasCommand) {
    throw new Error("SSH tool requires either a command or an action, not both");
  }
  if (!hasAction) {
    if (keys.some((key) => !COMMAND_KEYS.has(key))) {
      throw new Error("SSH command accepts only command, cwd, timeout, and targetId");
    }
    return {
      kind: "command",
      ...(input.targetId ? { targetId: input.targetId } : {}),
      command: input.command!,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
    };
  }
  const action = input.action!;
  if (keys.some((key) => !ACTION_KEYS[action].has(key))) {
    throw new Error(`SSH action ${action} does not accept extra fields`);
  }
  if (action === "guide" || action === "targets") return { kind: action };
  if (action === "status" || action === "list") {
    return { kind: action, ...(input.targetId ? { targetId: input.targetId } : {}) };
  }
  if (action === "ensure_gateway") {
    return {
      kind: action,
      ...(input.targetId ? { targetId: input.targetId } : {}),
      ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
    };
  }
  if (action === "describe" || action === "call") {
    if (typeof input.tool !== "string") throw new Error(`SSH action ${action} requires tool`);
    if (action === "describe") {
      return { kind: action, tool: input.tool, ...(input.targetId ? { targetId: input.targetId } : {}) };
    }
    return {
      kind: action,
      tool: input.tool,
      ...(input.targetId ? { targetId: input.targetId } : {}),
      ...(input.args ? { args: input.args } : {}),
      ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
    };
  }
  if (action === "sync_pi_config") {
    if (!input.categories) throw new Error("SSH action sync_pi_config requires categories");
    return {
      kind: action,
      categories: input.categories,
      ...(input.targetId ? { targetId: input.targetId } : {}),
    };
  }
  if (typeof input.requestId !== "string") throw new Error("SSH action start_pi requires requestId");
  return {
    kind: "start_pi",
    requestId: input.requestId,
    ...(input.targetId ? { targetId: input.targetId } : {}),
    ...(input.todoIds ? { todoIds: input.todoIds } : {}),
    ...(input.objective ? { objective: input.objective } : {}),
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
  };
}

function presentKeys(input: SshToolInput): string[] {
  return Object.keys(input).filter((key) => input[key as keyof SshToolInput] !== undefined);
}

export interface SshHostProvider {
  getHosts(): SshHost[];
}

export interface BoundSshToolContext {
  readonly hostId: string;
  readonly systemContext: string;
  execute(input: SshCommandToolInput, options?: SshExecuteOptions): Promise<SshExecutionResult>;
}

export function createBoundSshToolContext(
  hosts: SshHostProvider,
  executor: SshExecutor,
  selectedHostId: string,
): BoundSshToolContext {
  if (!SSH_HOST_ID_PATTERN.test(selectedHostId)) throw new Error("Selected SSH host id is invalid");
  const selected = findSelectedHost(hosts, selectedHostId);
  return Object.freeze({
    hostId: selectedHostId,
    systemContext: `SSH commands run only on the user-selected server ${JSON.stringify(selected.label)}. The tool accepts command, cwd, and timeout only; never request or provide host or authentication data.`,
    async execute(input: SshCommandToolInput, options?: SshExecuteOptions) {
      const current = findSelectedHost(hosts, selectedHostId);
      return executor.execute(current, input, options);
    },
  });
}

function findSelectedHost(hosts: SshHostProvider, selectedHostId: string): SshHost {
  const host = hosts.getHosts().find((candidate) => candidate.id === selectedHostId);
  if (!host) throw new Error("Selected SSH host is unavailable");
  return host;
}
