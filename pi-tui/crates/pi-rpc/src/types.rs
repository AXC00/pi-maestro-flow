//! Serde models for the `pi --mode rpc` JSONL protocol.
//!
//! Authoritative source:
//! `packages/pi-maestro-flow/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts`
//! plus `pi-agent-core/dist/types.d.ts` (AgentEvent) and `pi-ai/dist/types.d.ts`
//! (AssistantMessageEvent, Message, Model, Usage).
//!
//! Wire notes verified against `rpc-mode.js` / `json-event.js`:
//! - Commands go in on stdin as JSONL; `id` is optional and echoed back on the response.
//! - stdout carries `type:"response"` objects, `AgentSessionEvent` objects, and
//!   `type:"extension_ui_request"` objects (plus `extension_error`).
//! - `message_update` is transformed on the wire: it carries `usage` and a
//!   stripped `assistantMessageEvent` (no `partial`; `toolcall_start` gains
//!   `id`/`toolName`; `done` keeps `message`; `error` keeps `error`).
//! - Unknown event/command types must not break parsing — every externally
//!   tagged enum ends with an `#[serde(untagged)] Unknown(Value)` fallback.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

// ============================================================================
// Shared scalar types
// ============================================================================

/// `ThinkingLevel` as used by `RpcSessionState` / `set_thinking_level`.
/// pi-agent-core includes `"off"` in addition to pi-ai's levels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

/// `"all" | "one-at-a-time"` queue modes for steering / follow-up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum QueueMode {
    #[serde(rename = "all")]
    All,
    #[serde(rename = "one-at-a-time")]
    OneAtATime,
}

/// `streamingBehavior` on `prompt`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StreamingBehavior {
    #[serde(rename = "steer")]
    Steer,
    #[serde(rename = "followUp")]
    FollowUp,
}

// ============================================================================
// Content / message models (pi-ai)
// ============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MessageContent {
    Text {
        text: String,
        #[serde(rename = "textSignature", skip_serializing_if = "Option::is_none")]
        text_signature: Option<String>,
    },
    Thinking {
        thinking: String,
        #[serde(rename = "thinkingSignature", skip_serializing_if = "Option::is_none")]
        thinking_signature: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        redacted: Option<bool>,
    },
    Image {
        data: String,
        #[serde(rename = "mimeType")]
        mime_type: String,
    },
    /// pi-ai uses camelCase `"toolCall"` on the wire.
    #[serde(rename = "toolCall")]
    ToolCall {
        id: String,
        name: String,
        arguments: Value,
        #[serde(rename = "thoughtSignature", skip_serializing_if = "Option::is_none")]
        thought_signature: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        namespace: Option<String>,
    },
    /// Forward-compat for content types we don't model yet.
    #[serde(untagged)]
    Unknown(Value),
}

/// `UserMessage.content` is `string | (TextContent|ImageContent)[]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum UserContent {
    Text(String),
    Parts(Vec<MessageContent>),
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    #[serde(default)]
    pub input: f64,
    #[serde(default)]
    pub output: f64,
    #[serde(rename = "cacheRead", default)]
    pub cache_read: f64,
    #[serde(rename = "cacheWrite", default)]
    pub cache_write: f64,
    #[serde(rename = "cacheWrite1h", skip_serializing_if = "Option::is_none")]
    pub cache_write_1h: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<f64>,
    #[serde(rename = "totalTokens", default)]
    pub total_tokens: f64,
    #[serde(default)]
    pub cost: UsageCost,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct UsageCost {
    #[serde(default)]
    pub input: f64,
    #[serde(default)]
    pub output: f64,
    #[serde(rename = "cacheRead", default)]
    pub cache_read: f64,
    #[serde(rename = "cacheWrite", default)]
    pub cache_write: f64,
    #[serde(default)]
    pub total: f64,
}

/// `AgentMessage` — user / assistant / toolResult, with a tolerant fallback
/// for custom agent message roles.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "camelCase")]
pub enum AgentMessage {
    #[serde(rename = "user")]
    User {
        content: UserContent,
        timestamp: f64,
        #[serde(flatten)]
        extra: HashMap<String, Value>,
    },
    #[serde(rename = "assistant")]
    Assistant {
        content: Vec<MessageContent>,
        api: String,
        provider: String,
        model: String,
        usage: Usage,
        #[serde(rename = "stopReason")]
        stop_reason: String,
        timestamp: f64,
        #[serde(flatten)]
        extra: HashMap<String, Value>,
    },
    #[serde(rename = "toolResult")]
    ToolResult {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        content: Vec<MessageContent>,
        #[serde(rename = "isError")]
        is_error: bool,
        timestamp: f64,
        #[serde(flatten)]
        extra: HashMap<String, Value>,
    },
    /// Custom agent message roles (extensions can register their own).
    #[serde(untagged)]
    Unknown(Value),
}

// ============================================================================
// Model (pi-ai `Model<Api>`)
// ============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Model {
    pub id: String,
    pub name: String,
    pub api: String,
    pub provider: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    pub reasoning: bool,
    /// Maps pi thinking levels to provider values; `null` = unsupported.
    #[serde(rename = "thinkingLevelMap", skip_serializing_if = "Option::is_none")]
    pub thinking_level_map: Option<HashMap<String, Option<String>>>,
    /// e.g. `["text","image"]`
    #[serde(default)]
    pub input: Vec<String>,
    #[serde(default)]
    pub cost: ModelCost,
    #[serde(rename = "contextWindow", default)]
    pub context_window: f64,
    #[serde(rename = "maxTokens", default)]
    pub max_tokens: f64,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ModelCost {
    #[serde(default)]
    pub input: f64,
    #[serde(default)]
    pub output: f64,
    #[serde(rename = "cacheRead", default)]
    pub cache_read: f64,
    #[serde(rename = "cacheWrite", default)]
    pub cache_write: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tiers: Option<Vec<ModelCostTier>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelCostTier {
    #[serde(default)]
    pub input: f64,
    #[serde(default)]
    pub output: f64,
    #[serde(rename = "cacheRead", default)]
    pub cache_read: f64,
    #[serde(rename = "cacheWrite", default)]
    pub cache_write: f64,
    #[serde(rename = "inputTokensAbove", default)]
    pub input_tokens_above: f64,
}

// ============================================================================
// RpcCommand — the 34 command types written to stdin
// ============================================================================

/// All 34 `RpcCommand` variants. `id` is NOT part of the enum — the client
/// injects it when correlating responses (see `PiRpc::send`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RpcCommand {
    Prompt {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        images: Option<Vec<MessageContent>>,
        #[serde(rename = "streamingBehavior", skip_serializing_if = "Option::is_none")]
        streaming_behavior: Option<StreamingBehavior>,
    },
    Steer {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        images: Option<Vec<MessageContent>>,
    },
    FollowUp {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        images: Option<Vec<MessageContent>>,
    },
    Abort,
    ClearQueue,
    NewSession {
        #[serde(rename = "parentSession", skip_serializing_if = "Option::is_none")]
        parent_session: Option<String>,
    },
    GetState,
    SetModel {
        provider: String,
        #[serde(rename = "modelId")]
        model_id: String,
    },
    CycleModel,
    GetAvailableModels,
    SetThinkingLevel {
        level: ThinkingLevel,
    },
    CycleThinkingLevel,
    GetAvailableThinkingLevels,
    SetSteeringMode {
        mode: QueueMode,
    },
    SetFollowUpMode {
        mode: QueueMode,
    },
    Compact {
        #[serde(rename = "customInstructions", skip_serializing_if = "Option::is_none")]
        custom_instructions: Option<String>,
    },
    SetAutoCompaction {
        enabled: bool,
    },
    SetAutoRetry {
        enabled: bool,
    },
    AbortRetry,
    Bash {
        command: String,
        #[serde(rename = "excludeFromContext", skip_serializing_if = "Option::is_none")]
        exclude_from_context: Option<bool>,
    },
    AbortBash,
    GetSessionStats,
    ExportHtml {
        #[serde(rename = "outputPath", skip_serializing_if = "Option::is_none")]
        output_path: Option<String>,
    },
    SwitchSession {
        #[serde(rename = "sessionPath")]
        session_path: String,
    },
    Fork {
        #[serde(rename = "entryId")]
        entry_id: String,
    },
    Clone,
    GetForkMessages,
    GetEntries {
        #[serde(skip_serializing_if = "Option::is_none")]
        since: Option<String>,
    },
    GetTree,
    GetLastAssistantText,
    SetSessionName {
        name: String,
    },
    GetMessages,
    GetCommands,
    /// Extension: asks the agent which UI surfaces it can drive. Not part of
    /// the upstream 33-command set — older agents answer with a `parse`-style
    /// error response, which callers treat as "no custom overlay support".
    GetCapabilities,
}

impl RpcCommand {
    /// The wire `type` string for this command (matches `command` on responses).
    pub fn command_type(&self) -> &'static str {
        match self {
            Self::Prompt { .. } => "prompt",
            Self::Steer { .. } => "steer",
            Self::FollowUp { .. } => "follow_up",
            Self::Abort => "abort",
            Self::ClearQueue => "clear_queue",
            Self::NewSession { .. } => "new_session",
            Self::GetState => "get_state",
            Self::SetModel { .. } => "set_model",
            Self::CycleModel => "cycle_model",
            Self::GetAvailableModels => "get_available_models",
            Self::SetThinkingLevel { .. } => "set_thinking_level",
            Self::CycleThinkingLevel => "cycle_thinking_level",
            Self::GetAvailableThinkingLevels => "get_available_thinking_levels",
            Self::SetSteeringMode { .. } => "set_steering_mode",
            Self::SetFollowUpMode { .. } => "set_follow_up_mode",
            Self::Compact { .. } => "compact",
            Self::SetAutoCompaction { .. } => "set_auto_compaction",
            Self::SetAutoRetry { .. } => "set_auto_retry",
            Self::AbortRetry => "abort_retry",
            Self::Bash { .. } => "bash",
            Self::AbortBash => "abort_bash",
            Self::GetSessionStats => "get_session_stats",
            Self::ExportHtml { .. } => "export_html",
            Self::SwitchSession { .. } => "switch_session",
            Self::Fork { .. } => "fork",
            Self::Clone => "clone",
            Self::GetForkMessages => "get_fork_messages",
            Self::GetEntries { .. } => "get_entries",
            Self::GetTree => "get_tree",
            Self::GetLastAssistantText => "get_last_assistant_text",
            Self::SetSessionName { .. } => "set_session_name",
            Self::GetMessages => "get_messages",
            Self::GetCommands => "get_commands",
            Self::GetCapabilities => "get_capabilities",
        }
    }
}

// ============================================================================
// RpcResponse — `type:"response"` lines on stdout
// ============================================================================

/// A response line. `data` is kept as `serde_json::Value` — per-command
/// payloads differ widely; use the typed accessors for the common ones.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// Always `"response"` on the wire.
    #[serde(rename = "type", default = "default_response_type")]
    pub kind: String,
    /// The command type this answers (e.g. `"get_state"`, `"parse"` for
    /// malformed input, or an unknown command name).
    pub command: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn default_response_type() -> String {
    "response".to_string()
}

impl RpcResponse {
    /// Synthetic failure response (e.g. emitted when the child process exits
    /// while commands are still pending).
    pub fn failure(id: Option<String>, command: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            id,
            kind: "response".to_string(),
            command: command.into(),
            success: false,
            data: None,
            error: Some(error.into()),
        }
    }

    /// `get_state` → `RpcSessionState`.
    pub fn session_state(&self) -> Option<RpcSessionState> {
        self.data
            .as_ref()
            .and_then(|d| serde_json::from_value(d.clone()).ok())
    }

    /// `get_available_models` → `Vec<Model>`.
    pub fn available_models(&self) -> Option<Vec<Model>> {
        self.data
            .as_ref()
            .and_then(|d| d.get("models"))
            .and_then(|m| serde_json::from_value(m.clone()).ok())
    }

    /// `get_available_thinking_levels` → `Vec<ThinkingLevel>`.
    pub fn available_thinking_levels(&self) -> Option<Vec<ThinkingLevel>> {
        self.data
            .as_ref()
            .and_then(|d| d.get("levels"))
            .and_then(|l| serde_json::from_value(l.clone()).ok())
    }

    /// `get_capabilities` → `data.ui` as `UiCapabilities`. Absent on older
    /// agents (they answer with an error response instead).
    pub fn ui_capabilities(&self) -> Option<UiCapabilities> {
        self.data
            .as_ref()
            .and_then(|d| d.get("ui"))
            .and_then(|u| serde_json::from_value(u.clone()).ok())
    }

    /// `get_messages` → `Vec<AgentMessage>`.
    pub fn messages(&self) -> Option<Vec<AgentMessage>> {
        self.data
            .as_ref()
            .and_then(|d| d.get("messages"))
            .and_then(|m| serde_json::from_value(m.clone()).ok())
    }

    /// `get_commands` → `Vec<RpcSlashCommand>`.
    pub fn slash_commands(&self) -> Option<Vec<RpcSlashCommand>> {
        self.data
            .as_ref()
            .and_then(|d| d.get("commands"))
            .and_then(|c| serde_json::from_value(c.clone()).ok())
    }

    /// `get_last_assistant_text` → `Option<String>` (null-safe).
    pub fn last_assistant_text(&self) -> Option<String> {
        self.data
            .as_ref()
            .and_then(|d| d.get("text"))
            .and_then(|t| t.as_str().map(str::to_string))
    }

    /// `set_model` → the active `Model` (data is the model itself).
    pub fn model_data(&self) -> Option<Model> {
        self.data
            .as_ref()
            .and_then(|d| serde_json::from_value(d.clone()).ok())
    }

    /// `cycle_model` → `(model, thinking_level)`; `data` is `null` when
    /// cycling is a no-op (single scoped model).
    pub fn cycle_model_data(&self) -> Option<(Model, ThinkingLevel)> {
        let d = self.data.as_ref()?;
        let model = serde_json::from_value(d.get("model")?.clone()).ok()?;
        let level = serde_json::from_value(d.get("thinkingLevel")?.clone()).ok()?;
        Some((model, level))
    }

    /// `export_html` → written file path.
    pub fn export_path(&self) -> Option<String> {
        self.data_string("path")
    }

    /// `new_session` / `switch_session` / `clone` → `cancelled` flag.
    pub fn cancelled(&self) -> bool {
        self.data
            .as_ref()
            .and_then(|d| d.get("cancelled"))
            .and_then(|c| c.as_bool())
            .unwrap_or(false)
    }

    /// `cycle_thinking_level` → new level (`data` may be `null`).
    pub fn cycle_thinking_level(&self) -> Option<ThinkingLevel> {
        self.data
            .as_ref()
            .and_then(|d| d.get("level"))
            .and_then(|l| serde_json::from_value(l.clone()).ok())
    }

    /// Generic `data.<key>` string accessor.
    pub fn data_string(&self, key: &str) -> Option<String> {
        self.data
            .as_ref()
            .and_then(|d| d.get(key))
            .and_then(|v| v.as_str().map(str::to_string))
    }
}

// ============================================================================
// RpcSessionState / RpcSlashCommand
// ============================================================================

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcSessionState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<Model>,
    #[serde(rename = "thinkingLevel")]
    pub thinking_level: ThinkingLevel,
    #[serde(rename = "isStreaming")]
    pub is_streaming: bool,
    #[serde(rename = "isCompacting")]
    pub is_compacting: bool,
    #[serde(rename = "steeringMode")]
    pub steering_mode: QueueMode,
    #[serde(rename = "followUpMode")]
    pub follow_up_mode: QueueMode,
    #[serde(rename = "sessionFile", skip_serializing_if = "Option::is_none")]
    pub session_file: Option<String>,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "sessionName", skip_serializing_if = "Option::is_none")]
    pub session_name: Option<String>,
    #[serde(rename = "autoCompactionEnabled")]
    pub auto_compaction_enabled: bool,
    #[serde(rename = "messageCount")]
    pub message_count: u64,
    #[serde(rename = "pendingMessageCount")]
    pub pending_message_count: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcSlashCommand {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// `"extension" | "prompt" | "skill"` (kept as String for forward-compat).
    pub source: String,
    #[serde(rename = "sourceInfo", default)]
    pub source_info: Value,
}

// ============================================================================
// AgentEvent — session event stream on stdout
// ============================================================================

/// `AssistantMessageEvent` as it appears inside a wire `message_update`.
/// The `partial` field is stripped by `toJsonAssistantMessageEvent`;
/// `toolcall_start` gains `id`/`toolName`; `done` keeps `message`;
/// `error` keeps `error`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AssistantMessageEvent {
    Start,
    TextStart {
        #[serde(rename = "contentIndex")]
        content_index: u64,
    },
    TextDelta {
        #[serde(rename = "contentIndex")]
        content_index: u64,
        delta: String,
    },
    TextEnd {
        #[serde(rename = "contentIndex")]
        content_index: u64,
        content: String,
    },
    ThinkingStart {
        #[serde(rename = "contentIndex")]
        content_index: u64,
    },
    ThinkingDelta {
        #[serde(rename = "contentIndex")]
        content_index: u64,
        delta: String,
    },
    ThinkingEnd {
        #[serde(rename = "contentIndex")]
        content_index: u64,
        content: String,
    },
    ToolcallStart {
        #[serde(rename = "contentIndex")]
        content_index: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(rename = "toolName", skip_serializing_if = "Option::is_none")]
        tool_name: Option<String>,
    },
    ToolcallDelta {
        #[serde(rename = "contentIndex")]
        content_index: u64,
        delta: String,
    },
    ToolcallEnd {
        #[serde(rename = "contentIndex")]
        content_index: u64,
        #[serde(rename = "toolCall")]
        tool_call: Value,
    },
    Done {
        reason: String,
        message: Box<AgentMessage>,
    },
    Error {
        reason: String,
        error: Box<AgentMessage>,
    },
    /// Unknown/new assistant event types — never break the stream.
    #[serde(untagged)]
    Unknown(Value),
}

/// `AgentSessionEvent` — the superset of `AgentEvent` emitted on stdout.
/// Includes the 10 core agent events plus session-level events
/// (`agent_settled`, `queue_update`, `compaction_*`, `auto_retry_*`, …).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    AgentStart,
    AgentEnd {
        messages: Vec<AgentMessage>,
        /// Session-level extension: present on the wire, absent in core AgentEvent.
        #[serde(rename = "willRetry", skip_serializing_if = "Option::is_none")]
        will_retry: Option<bool>,
    },
    TurnStart,
    TurnEnd {
        message: AgentMessage,
        #[serde(rename = "toolResults", default)]
        tool_results: Vec<AgentMessage>,
    },
    MessageStart {
        message: AgentMessage,
    },
    /// Wire form: `usage` + stripped `assistantMessageEvent` (no `message`).
    MessageUpdate {
        #[serde(skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
        #[serde(rename = "assistantMessageEvent")]
        assistant_message_event: AssistantMessageEvent,
    },
    MessageEnd {
        message: AgentMessage,
    },
    ToolExecutionStart {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        args: Value,
    },
    ToolExecutionUpdate {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        args: Value,
        #[serde(rename = "partialResult")]
        partial_result: Value,
    },
    ToolExecutionEnd {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        result: Value,
        #[serde(rename = "isError")]
        is_error: bool,
    },
    // ---- session-level events ----
    AgentSettled,
    QueueUpdate {
        #[serde(default)]
        steering: Vec<String>,
        #[serde(rename = "followUp", default)]
        follow_up: Vec<String>,
    },
    CompactionStart {
        reason: String,
    },
    CompactionEnd {
        reason: String,
        #[serde(flatten)]
        extra: HashMap<String, Value>,
    },
    AutoRetryStart {
        attempt: u64,
        #[serde(rename = "maxAttempts")]
        max_attempts: u64,
        #[serde(rename = "delayMs")]
        delay_ms: u64,
        #[serde(rename = "errorMessage")]
        error_message: String,
    },
    AutoRetryEnd {
        success: bool,
        attempt: u64,
        #[serde(rename = "finalError", skip_serializing_if = "Option::is_none")]
        final_error: Option<String>,
    },
    BashExecutionUpdate {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        delta: String,
    },
    ThinkingLevelChanged {
        level: ThinkingLevel,
    },
    SessionInfoChanged {
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    /// Any other session/extension event — never break the stream.
    #[serde(untagged)]
    Unknown(Value),
}

impl AgentEvent {
    /// The wire `type` string, including for `Unknown` variants.
    pub fn event_type(&self) -> &str {
        match self {
            Self::AgentStart => "agent_start",
            Self::AgentEnd { .. } => "agent_end",
            Self::TurnStart => "turn_start",
            Self::TurnEnd { .. } => "turn_end",
            Self::MessageStart { .. } => "message_start",
            Self::MessageUpdate { .. } => "message_update",
            Self::MessageEnd { .. } => "message_end",
            Self::ToolExecutionStart { .. } => "tool_execution_start",
            Self::ToolExecutionUpdate { .. } => "tool_execution_update",
            Self::ToolExecutionEnd { .. } => "tool_execution_end",
            Self::AgentSettled => "agent_settled",
            Self::QueueUpdate { .. } => "queue_update",
            Self::CompactionStart { .. } => "compaction_start",
            Self::CompactionEnd { .. } => "compaction_end",
            Self::AutoRetryStart { .. } => "auto_retry_start",
            Self::AutoRetryEnd { .. } => "auto_retry_end",
            Self::BashExecutionUpdate { .. } => "bash_execution_update",
            Self::ThinkingLevelChanged { .. } => "thinking_level_changed",
            Self::SessionInfoChanged { .. } => "session_info_changed",
            Self::Unknown(v) => v
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("unknown"),
        }
    }
}

// ============================================================================
// Extension UI — bidirectional channel
// ============================================================================

// --- Plugin overlay model (extension over upstream protocol) ----------------
//
// Mirrors `packages/pi-maestro-settings-core/src/ui/overlay-spec.ts` — the two
// schemas must stay field-for-field identical. Style is enforced by the
// protocol: `Role` is a closed enum so a plugin can request a semantic color
// but never a raw one; the client maps roles onto its theme.

/// Semantic style role for one `Span` (wire: snake_case).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Text,
    Muted,
    Dim,
    Accent,
    Warning,
    Error,
    Success,
    Border,
    Selected,
    HintKey,
    HintVerb,
}

/// One styled run of text inside an overlay frame row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Span {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<Role>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub bold: bool,
}

/// One overlay frame: rows of styled spans.
pub type Frame = Vec<Vec<Span>>;

/// Absolute cells or a percentage string ("72%"). Mirrors pi-tui `SizeValue`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SizeValue {
    Cells(u32),
    Percent(String),
}

/// pi-tui `OverlayAnchor` mirror.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OverlayAnchor {
    #[serde(rename = "center")]
    Center,
    #[serde(rename = "top-left")]
    TopLeft,
    #[serde(rename = "top-right")]
    TopRight,
    #[serde(rename = "bottom-left")]
    BottomLeft,
    #[serde(rename = "bottom-right")]
    BottomRight,
    #[serde(rename = "top-center")]
    TopCenter,
    #[serde(rename = "bottom-center")]
    BottomCenter,
    #[serde(rename = "left-center")]
    LeftCenter,
    #[serde(rename = "right-center")]
    RightCenter,
}

/// Uniform margin or per-side values. Mirrors pi-tui `OverlayMargin`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OverlayMargin {
    Uniform(u32),
    Sides {
        top: Option<u32>,
        right: Option<u32>,
        bottom: Option<u32>,
        left: Option<u32>,
    },
}

/// One key hint rendered in the bottom border (`esc cancel`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OverlayHint {
    pub key: String,
    pub verb: String,
}

/// Declarative overlay chrome — the `spec` payload of `method:"custom"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OverlaySpec {
    /// Only `"card"` exists for now; kept as a field for future kinds.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<OverlayAnchor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<SizeValue>,
    #[serde(rename = "minWidth", skip_serializing_if = "Option::is_none")]
    pub min_width: Option<u32>,
    #[serde(rename = "maxHeight", skip_serializing_if = "Option::is_none")]
    pub max_height: Option<SizeValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub margin: Option<OverlayMargin>,
    #[serde(rename = "offsetX", skip_serializing_if = "Option::is_none")]
    pub offset_x: Option<i32>,
    #[serde(rename = "offsetY", skip_serializing_if = "Option::is_none")]
    pub offset_y: Option<i32>,
    /// When false the client must not close on Esc; the plugin decides.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dismissable: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hints: Vec<OverlayHint>,
}

/// Who drives a `custom` overlay: the client renders interactive fields
/// (`Client`) or the plugin streams frames and consumes input (`Plugin`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OverlayDriver {
    Client,
    Plugin,
}

/// `type:"extension_ui_event"` — client → agent input for plugin-driven
/// overlays. Written to stdin; routed by the agent to the extension that owns
/// the request `id`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcExtensionUIEvent {
    pub id: String,
    pub event: UiEvent,
}

impl RpcExtensionUIEvent {
    /// Serialize with the `type` discriminator added (same pattern as
    /// `RpcExtensionUIResponse::to_wire_value`).
    pub fn to_wire_value(&self) -> Value {
        let mut v = serde_json::to_value(self).unwrap_or_else(|_| Value::Null);
        if let Value::Object(ref mut map) = v {
            map.insert(
                "type".to_string(),
                Value::String("extension_ui_event".to_string()),
            );
        }
        v
    }
}

/// One input/lifecycle event delivered to a plugin-driven overlay.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UiEvent {
    /// A keypress while the overlay holds focus. `key` is the pi-tui key id
    /// (e.g. "j", "up", "escape", "ctrl+c"); `mods` lists active modifiers.
    Key {
        key: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        mods: Vec<String>,
    },
    /// The overlay was dismissed locally (Esc on a dismissable spec).
    Dismissed,
    /// The terminal resized; the plugin should re-render at the new budget.
    Resize { w: u32, h: u32 },
}

/// `get_capabilities` response payload (`data.ui`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UiCapabilities {
    #[serde(default)]
    pub custom: bool,
    #[serde(rename = "spec_version", default)]
    pub spec_version: u32,
    #[serde(default)]
    pub events: bool,
}

/// `type:"extension_ui_request"` — emitted when an extension needs UI.
/// Interactive methods (`select`, `confirm`, `input`, `editor`) expect an
/// `extension_ui_response`; the rest are fire-and-forget notifications.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum RpcExtensionUIRequest {
    Select {
        id: String,
        title: String,
        options: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        timeout: Option<u64>,
    },
    Confirm {
        id: String,
        title: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        timeout: Option<u64>,
    },
    Input {
        id: String,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        placeholder: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        timeout: Option<u64>,
    },
    Editor {
        id: String,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        prefill: Option<String>,
    },
    Notify {
        id: String,
        message: String,
        #[serde(rename = "notifyType", skip_serializing_if = "Option::is_none")]
        notify_type: Option<String>,
    },
    #[serde(rename = "setStatus")]
    SetStatus {
        id: String,
        #[serde(rename = "statusKey")]
        status_key: String,
        /// `undefined` clears the status — arrives as missing/null.
        #[serde(rename = "statusText", default)]
        status_text: Option<String>,
    },
    #[serde(rename = "setWidget")]
    SetWidget {
        id: String,
        #[serde(rename = "widgetKey")]
        widget_key: String,
        /// `undefined` clears the widget.
        #[serde(rename = "widgetLines", default)]
        widget_lines: Option<Vec<String>>,
        #[serde(rename = "widgetPlacement", skip_serializing_if = "Option::is_none")]
        widget_placement: Option<String>,
    },
    #[serde(rename = "setTitle")]
    SetTitle {
        id: String,
        title: String,
    },
    #[serde(rename = "set_editor_text")]
    SetEditorText {
        id: String,
        text: String,
    },
    /// Extension: mount a plugin overlay. `driver:"client"` expects an
    /// `extension_ui_response` when the client-side fields resolve;
    /// `driver:"plugin"` is fire-and-forget — the plugin streams
    /// `overlay_frame` updates and closes with `overlay_close`.
    #[serde(rename = "custom")]
    Custom {
        id: String,
        driver: OverlayDriver,
        spec: OverlaySpec,
    },
    /// Extension: replace the body frame of an open plugin overlay.
    #[serde(rename = "overlay_frame")]
    OverlayFrame {
        id: String,
        frame: Frame,
        /// Optional cursor cell (row, col) inside the overlay body.
        #[serde(skip_serializing_if = "Option::is_none")]
        cursor: Option<(u16, u16)>,
    },
    /// Extension: close the plugin overlay opened by request `id`.
    #[serde(rename = "overlay_close")]
    OverlayClose { id: String },
    /// Unknown UI methods — never break the channel.
    #[serde(untagged)]
    Unknown(Value),
}

impl RpcExtensionUIRequest {
    /// The request `id` to echo back in `extension_ui_response`.
    pub fn id(&self) -> &str {
        match self {
            Self::Select { id, .. }
            | Self::Confirm { id, .. }
            | Self::Input { id, .. }
            | Self::Editor { id, .. }
            | Self::Notify { id, .. }
            | Self::SetStatus { id, .. }
            | Self::SetWidget { id, .. }
            | Self::SetTitle { id, .. }
            | Self::SetEditorText { id, .. }
            | Self::Custom { id, .. }
            | Self::OverlayFrame { id, .. }
            | Self::OverlayClose { id } => id,
            Self::Unknown(v) => v
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or(""),
        }
    }

    /// The wire `method` name.
    pub fn method(&self) -> &str {
        match self {
            Self::Select { .. } => "select",
            Self::Confirm { .. } => "confirm",
            Self::Input { .. } => "input",
            Self::Editor { .. } => "editor",
            Self::Notify { .. } => "notify",
            Self::SetStatus { .. } => "setStatus",
            Self::SetWidget { .. } => "setWidget",
            Self::SetTitle { .. } => "setTitle",
            Self::SetEditorText { .. } => "set_editor_text",
            Self::Custom { .. } => "custom",
            Self::OverlayFrame { .. } => "overlay_frame",
            Self::OverlayClose { .. } => "overlay_close",
            Self::Unknown(v) => v
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("unknown"),
        }
    }

    /// Whether pi awaits an `extension_ui_response` for this request.
    /// `select`, `confirm`, `input`, `editor`, and client-driven `custom`
    /// block on a reply; plugin-driven `custom` resolves via `overlay_close`.
    pub fn expects_response(&self) -> bool {
        match self {
            Self::Select { .. }
            | Self::Confirm { .. }
            | Self::Input { .. }
            | Self::Editor { .. } => true,
            Self::Custom { driver, .. } => *driver == OverlayDriver::Client,
            _ => false,
        }
    }

    /// Whether this request occupies the modal surface (interactive or
    /// plugin-driven overlay) — used for queue promotion on close.
    pub fn occupies_surface(&self) -> bool {
        self.expects_response() || matches!(self, Self::Custom { .. })
    }
}

/// `type:"extension_ui_response"` — written to stdin to answer a UI request.
/// Untagged: `{id,value}` for select/input/editor, `{id,confirmed}` for
/// confirm, `{id,cancelled:true}` to cancel any of them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RpcExtensionUIResponse {
    Value {
        id: String,
        value: String,
    },
    Confirmed {
        id: String,
        confirmed: bool,
    },
    Cancelled {
        id: String,
        cancelled: bool,
    },
}

impl RpcExtensionUIResponse {
    /// Serialize with the `type:"extension_ui_response"` discriminator added.
    pub fn to_wire_value(&self) -> Value {
        let mut v = serde_json::to_value(self).unwrap_or_else(|_| Value::Null);
        if let Value::Object(ref mut map) = v {
            map.insert(
                "type".to_string(),
                Value::String("extension_ui_response".to_string()),
            );
        }
        v
    }
}

// ============================================================================
// Top-level line classification
// ============================================================================

/// What a single stdout line can be.
#[derive(Debug, Clone, PartialEq)]
pub enum RpcLine {
    Response(RpcResponse),
    Event(AgentEvent),
    ExtensionUIRequest(RpcExtensionUIRequest),
    /// `type:"extension_error"` or any other unrecognized line.
    Other(Value),
    /// A line that is not valid JSON.
    Unparseable(String),
}

/// Classify one stdout line without failing on unknown shapes.
pub fn classify_line(line: &str) -> RpcLine {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return RpcLine::Unparseable(line.to_string());
    }
    let value: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => return RpcLine::Unparseable(line.to_string()),
    };
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "response" => match serde_json::from_value::<RpcResponse>(value.clone()) {
            Ok(r) => RpcLine::Response(r),
            Err(_) => RpcLine::Other(value),
        },
        "extension_ui_request" => match serde_json::from_value::<RpcExtensionUIRequest>(value.clone()) {
            Ok(r) => RpcLine::ExtensionUIRequest(r),
            Err(_) => RpcLine::Other(value),
        },
        // `extension_error` is a known non-event line; keep it out of the
        // AgentEvent::Unknown fallback so consumers can distinguish it.
        "extension_error" => RpcLine::Other(value),
        _ => match serde_json::from_value::<AgentEvent>(value.clone()) {
            Ok(e) => RpcLine::Event(e),
            Err(_) => RpcLine::Other(value),
        },
    }
}
