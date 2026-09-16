/**
 * Agent identity header presets, extracted from sub2api's outbound identity
 * layer (Wei-Shaw/sub2api): each upstream gateway fingerprints the client by
 * User-Agent (and friends) and rejects traffic that does not look like the
 * official CLI. Selecting a preset stamps the same identity on pi's requests.
 *
 * This is a leaf module: both the /settings surface and the /api-manager model
 * form expand the same presets, and the settings provider already imports the
 * provider config module, so keeping the table here avoids an import cycle.
 *
 * - claude-code: claude.DefaultHeaders + applyClaudeCodeMimicHeaders (claude-cli/2.1.220)
 * - codex: codexCLIUserAgent + the originator/version pair it must stay consistent with
 * - grok: xai CLI identity = xai-grok-workspace/0.2.114 + x-grok-client-version + x-grok-client-identifier
 * - antigravity: antigravity/1.23.2 windows/amd64
 * - opencode: official OpenCode CLI identity and session headers for Zen/Go gateways
 */
export const AGENT_HEADER_PRESETS = {
  none: {},
  "claude-code": {
    "User-Agent": "claude-cli/2.1.220 (external, cli)",
    "X-Stainless-Lang": "js",
    "X-Stainless-Package-Version": "0.94.0",
    "X-Stainless-OS": "Linux",
    "X-Stainless-Arch": "arm64",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Runtime-Version": "v24.3.0",
    "X-Stainless-Retry-Count": "0",
    "X-Stainless-Timeout": "600",
    "X-App": "cli",
    "Anthropic-Dangerous-Direct-Browser-Access": "true",
  },
  // The ChatGPT Codex backend reads the client identity as one envelope: the
  // originator must equal the leading User-Agent segment, and `version` must
  // equal the User-Agent version segment and be at least 0.144.0. A mismatch or
  // a lower version is answered with 404 (Wei-Shaw/sub2api issue #3901), so the
  // three values below are only meaningful together.
  codex: {
    originator: "codex-tui",
    "User-Agent": "codex-tui/0.146.0 (Ubuntu 22.4.0; x86_64) xterm-256color",
    version: "0.146.0",
    "OpenAI-Beta": "responses=experimental",
  },
  grok: {
    "User-Agent": "xai-grok-workspace/0.2.114",
    "X-Grok-Client-Version": "0.2.114",
    "X-Grok-Client-Identifier": "grok-shell",
  },
  antigravity: {
    "User-Agent": "antigravity/1.23.2 windows/amd64",
  },
  // Keep Authorization out of the preset so pi can send the provider's configured API key.
  opencode: {
    "User-Agent": "opencode/1.15.3",
    "x-opencode-client": "cli",
    "x-opencode-session": "ses_01JQXYZ3K7MN0RSTUVWXYZabcd",
    "x-opencode-request": "msg_01JQXYZ3K7MN0RSTUVWXYZefgh",
    "x-opencode-project": "global",
  },
} as const;

export type AgentHeaderPreset = keyof typeof AGENT_HEADER_PRESETS;

export function isAgentHeaderPreset(value: unknown): value is AgentHeaderPreset {
  return typeof value === "string" && value in AGENT_HEADER_PRESETS;
}

/** The headers a preset contributes, without its "none" identity. */
export function agentHeaderPresetHeaders(preset: AgentHeaderPreset | undefined): Record<string, string> {
  return preset && preset !== "none" ? { ...AGENT_HEADER_PRESETS[preset] } : {};
}

export function expandAgentHeaderPreset(
  preset: AgentHeaderPreset | undefined,
  custom: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const merged = { ...agentHeaderPresetHeaders(preset), ...(custom ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Reduce stored effective headers back to the user-authored ones: a preset value
 * that was never overridden is reported by the preset itself, so keeping it in
 * the custom headers field would pin the old identity when the preset changes.
 * An overridden value differs from the preset and therefore survives.
 */
export function customAgentHeaders(
  headers: Record<string, string> | undefined,
  preset: AgentHeaderPreset | undefined,
): Record<string, string> {
  const presetHeaders = agentHeaderPresetHeaders(preset);
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers).filter(([name, value]) => presetHeaders[name] !== value),
  );
}
