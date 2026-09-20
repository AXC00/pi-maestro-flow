//! Event stream for `PiRpc` — a `Stream<Item = RpcEvent>` over the
//! broadcast channel fed by the stdout demux task.

use std::pin::Pin;
use std::task::{Context, Poll};

use futures_core::Stream;
use serde_json::Value;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;

use crate::types::{AgentEvent, AssistantMessageEvent, RpcExtensionUIRequest, RpcResponse};

/// Everything the stdout demux can emit.
#[derive(Debug, Clone)]
pub enum RpcEvent {
    /// An agent/session event (`agent_start`, `message_update`, …).
    Agent(AgentEvent),
    /// A response that didn't match a pending command (no id / unknown id).
    Response(RpcResponse),
    /// Mirror of an `extension_ui_request` (also delivered on the UI channel).
    ExtensionUiRequest(RpcExtensionUIRequest),
    /// A line on stderr (pi logs/errors).
    StderrLine(String),
    /// Any other unrecognized stdout object (`extension_error`, new types).
    Other(Value),
}

impl RpcEvent {
    /// Convenience: is this an agent event of the given wire type?
    pub fn is_agent_type(&self, kind: &str) -> bool {
        matches!(self, Self::Agent(e) if e.event_type() == kind)
    }

    /// Borrow the inner `AgentEvent`, if any.
    pub fn as_agent(&self) -> Option<&AgentEvent> {
        match self {
            Self::Agent(e) => Some(e),
            _ => None,
        }
    }
}

/// `Stream<Item = RpcEvent>` — lagging receivers silently skip missed items
/// (broadcast semantics), so a slow consumer never blocks the demux task.
pub struct EventStream {
    inner: BroadcastStream<RpcEvent>,
}

impl EventStream {
    pub(crate) fn new(rx: broadcast::Receiver<RpcEvent>) -> Self {
        Self {
            inner: BroadcastStream::new(rx),
        }
    }
}

impl Stream for EventStream {
    type Item = RpcEvent;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            match Pin::new(&mut self.inner).poll_next(cx) {
                Poll::Ready(Some(Ok(event))) => return Poll::Ready(Some(event)),
                // Lagged: skip missed items and keep polling.
                Poll::Ready(Some(Err(_))) => continue,
                Poll::Ready(None) => return Poll::Ready(None),
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

// ============================================================================
// Classification helpers
// ============================================================================

/// Extract the text delta from a `message_update` event, if it carries one.
pub fn text_delta(event: &AgentEvent) -> Option<&str> {
    match event {
        AgentEvent::MessageUpdate {
            assistant_message_event: AssistantMessageEvent::TextDelta { delta, .. },
            ..
        } => Some(delta),
        _ => None,
    }
}

/// Extract the thinking delta from a `message_update` event, if it carries one.
pub fn thinking_delta(event: &AgentEvent) -> Option<&str> {
    match event {
        AgentEvent::MessageUpdate {
            assistant_message_event: AssistantMessageEvent::ThinkingDelta { delta, .. },
            ..
        } => Some(delta),
        _ => None,
    }
}

/// Whether the event marks the end of a run (`agent_end` or `agent_settled`).
pub fn is_run_end(event: &AgentEvent) -> bool {
    matches!(event, AgentEvent::AgentEnd { .. } | AgentEvent::AgentSettled)
}

/// Whether the event is a tool lifecycle event.
pub fn is_tool_event(event: &AgentEvent) -> bool {
    matches!(
        event,
        AgentEvent::ToolExecutionStart { .. }
            | AgentEvent::ToolExecutionUpdate { .. }
            | AgentEvent::ToolExecutionEnd { .. }
    )
}
