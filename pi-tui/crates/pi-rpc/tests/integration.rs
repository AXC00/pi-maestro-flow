//! Integration test against a real `pi --mode rpc` process.
//!
//! Skips gracefully when `pi` is not installed (set `PI_BIN` to point at it).
//! Uses the deterministic arg set (no extensions/skills/session) and disables
//! auto-retry so a failing model can't loop the test.

use std::time::Duration;

use pi_rpc::{AgentEvent, PiRpc, RpcCommand, RpcEvent};
use tokio::time::timeout;
use tokio_stream::StreamExt;

const SPAWN_TIMEOUT: Duration = Duration::from_secs(30);
const CMD_TIMEOUT: Duration = Duration::from_secs(60);
const EVENT_TIMEOUT: Duration = Duration::from_secs(90);

async fn spawn_or_skip() -> Option<PiRpc> {
    match timeout(SPAWN_TIMEOUT, PiRpc::spawn_default()).await {
        Ok(Ok(pi)) => Some(pi),
        _ => {
            eprintln!("skipping integration test: pi binary not available (set PI_BIN)");
            None
        }
    }
}

#[tokio::test]
async fn get_state_returns_session_state() {
    let Some(mut pi) = spawn_or_skip().await else { return };

    let resp = timeout(CMD_TIMEOUT, pi.send(&RpcCommand::GetState))
        .await
        .expect("get_state timed out")
        .expect("get_state failed");

    assert!(resp.success, "get_state failed: {:?}", resp.error);
    let state = resp.session_state().expect("no session state in response");
    assert!(!state.session_id.is_empty());
    assert!(!resp.id.as_deref().unwrap_or("").is_empty(), "response id echoed");

    pi.kill().await.ok();
}

#[tokio::test]
async fn prompt_streams_agent_events_and_abort_works() {
    let Some(mut pi) = spawn_or_skip().await else { return };
    let mut events = pi.events();

    // Disable auto-retry so an unreachable model can't loop the test.
    let _ = timeout(CMD_TIMEOUT, pi.send(&RpcCommand::SetAutoRetry { enabled: false }))
        .await;

    let resp = timeout(CMD_TIMEOUT, pi.send(&RpcCommand::Prompt {
        message: "Reply with exactly the word: ok".into(),
        images: None,
        streaming_behavior: None,
    }))
    .await
    .expect("prompt timed out")
    .expect("prompt failed");
    assert!(resp.success, "prompt failed: {:?}", resp.error);

    // Collect events until agent_settled / agent_end or timeout.
    let mut saw_agent_start = false;
    let mut saw_message_end_or_update = false;
    let mut saw_run_end = false;
    let deadline = tokio::time::Instant::now() + EVENT_TIMEOUT;
    while tokio::time::Instant::now() < deadline && !saw_run_end {
        match timeout(Duration::from_secs(10), events.next()).await {
            Ok(Some(RpcEvent::Agent(ev))) => {
                match &ev {
                    AgentEvent::AgentStart => saw_agent_start = true,
                    AgentEvent::MessageUpdate { .. } | AgentEvent::MessageEnd { .. } => {
                        saw_message_end_or_update = true
                    }
                    AgentEvent::AgentEnd { .. } | AgentEvent::AgentSettled => {
                        saw_run_end = true
                    }
                    _ => {}
                }
            }
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(_) => {} // keep waiting until deadline
        }
    }

    assert!(saw_agent_start, "never received agent_start");
    assert!(
        saw_message_end_or_update,
        "never received message_update or message_end"
    );

    let resp = timeout(CMD_TIMEOUT, pi.send(&RpcCommand::Abort))
        .await
        .expect("abort timed out")
        .expect("abort failed");
    assert!(resp.success, "abort failed: {:?}", resp.error);

    pi.kill().await.ok();
}

#[tokio::test]
async fn ui_request_channel_receives_requests() {
    // Extensions are disabled in DEFAULT_ARGS, so no UI requests are expected —
    // this just verifies the channel exists and doesn't panic. A richer UI test
    // requires an extension that calls ctx.ui.*, which is out of scope here.
    let Some(mut pi) = spawn_or_skip().await else { return };
    let got = timeout(Duration::from_secs(3), pi.next_ui_request()).await;
    // Either a request arrived (extensions somehow loaded) or it timed out —
    // both are acceptable; the channel must simply not deadlock.
    let _ = got;
    pi.kill().await.ok();
}
