//! # pi-rpc
//!
//! JSON-RPC/stdio client for `pi --mode rpc`.
//!
//! Spawns the pi CLI as a child process, writes `RpcCommand`s as JSONL on
//! stdin, and demultiplexes stdout into:
//! - `RpcResponse`s correlated by `id` (returned from `send`)
//! - `AgentEvent`s on a broadcast `Stream`
//! - `extension_ui_request`s on a dedicated channel, answered via `respond_ui`
//!
//! ```no_run
//! use pi_rpc::{PiRpc, RpcCommand};
//!
//! # async fn demo() -> std::io::Result<()> {
//! let pi = PiRpc::spawn_default().await?;
//! let resp = pi.send(&RpcCommand::GetState).await?;
//! assert!(resp.success);
//! # Ok(())
//! # }
//! ```

pub mod client;
pub mod events;
pub mod types;

pub use client::{PiRpc, DEFAULT_ARGS};
pub use events::{EventStream, RpcEvent};
pub use types::{
    classify_line, AgentEvent, AgentMessage, AssistantMessageEvent, Frame, MessageContent, Model,
    OverlayAnchor, OverlayDriver, OverlayHint, OverlayMargin, OverlaySpec, QueueMode, Role,
    RpcCommand, RpcExtensionUIEvent, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcLine,
    RpcResponse, RpcSessionState, RpcSlashCommand, SizeValue, Span, StreamingBehavior,
    ThinkingLevel, UiCapabilities, UiEvent, Usage, UserContent,
};
