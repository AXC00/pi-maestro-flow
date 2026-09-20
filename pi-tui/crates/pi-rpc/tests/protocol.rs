//! Unit tests for the serde protocol models — no real pi process needed.

use pi_rpc::types::*;
use serde_json::json;

// ============================================================================
// Command serialization
// ============================================================================

#[test]
fn serializes_all_command_types() {
    let cases: Vec<(RpcCommand, &str)> = vec![
        (RpcCommand::Prompt { message: "hi".into(), images: None, streaming_behavior: None }, "prompt"),
        (RpcCommand::Steer { message: "s".into(), images: None }, "steer"),
        (RpcCommand::FollowUp { message: "f".into(), images: None }, "follow_up"),
        (RpcCommand::Abort, "abort"),
        (RpcCommand::ClearQueue, "clear_queue"),
        (RpcCommand::NewSession { parent_session: None }, "new_session"),
        (RpcCommand::GetState, "get_state"),
        (RpcCommand::SetModel { provider: "p".into(), model_id: "m".into() }, "set_model"),
        (RpcCommand::CycleModel, "cycle_model"),
        (RpcCommand::GetAvailableModels, "get_available_models"),
        (RpcCommand::SetThinkingLevel { level: ThinkingLevel::High }, "set_thinking_level"),
        (RpcCommand::CycleThinkingLevel, "cycle_thinking_level"),
        (RpcCommand::GetAvailableThinkingLevels, "get_available_thinking_levels"),
        (RpcCommand::SetSteeringMode { mode: QueueMode::All }, "set_steering_mode"),
        (RpcCommand::SetFollowUpMode { mode: QueueMode::OneAtATime }, "set_follow_up_mode"),
        (RpcCommand::Compact { custom_instructions: None }, "compact"),
        (RpcCommand::SetAutoCompaction { enabled: true }, "set_auto_compaction"),
        (RpcCommand::SetAutoRetry { enabled: false }, "set_auto_retry"),
        (RpcCommand::AbortRetry, "abort_retry"),
        (RpcCommand::Bash { command: "ls".into(), exclude_from_context: None }, "bash"),
        (RpcCommand::AbortBash, "abort_bash"),
        (RpcCommand::GetSessionStats, "get_session_stats"),
        (RpcCommand::ExportHtml { output_path: None }, "export_html"),
        (RpcCommand::SwitchSession { session_path: "/tmp/s".into() }, "switch_session"),
        (RpcCommand::Fork { entry_id: "e1".into() }, "fork"),
        (RpcCommand::Clone, "clone"),
        (RpcCommand::GetForkMessages, "get_fork_messages"),
        (RpcCommand::GetEntries { since: None }, "get_entries"),
        (RpcCommand::GetTree, "get_tree"),
        (RpcCommand::GetLastAssistantText, "get_last_assistant_text"),
        (RpcCommand::SetSessionName { name: "n".into() }, "set_session_name"),
        (RpcCommand::GetMessages, "get_messages"),
        (RpcCommand::GetCommands, "get_commands"),
        (RpcCommand::GetCapabilities, "get_capabilities"),
    ];
    // rpc-types.d.ts defines 33 command variants; GetCapabilities is our
    // extension on top (older agents answer it with an error response).
    assert_eq!(cases.len(), 34, "protocol has 33 upstream + 1 extension command");
    for (cmd, expected) in cases {
        let v = serde_json::to_value(&cmd).unwrap();
        assert_eq!(v["type"], expected, "wrong type for {expected}");
        assert_eq!(cmd.command_type(), expected);
    }
}

#[test]
fn command_field_names_match_wire() {
    let v = serde_json::to_value(&RpcCommand::Prompt {
        message: "hello".into(),
        images: None,
        streaming_behavior: Some(StreamingBehavior::FollowUp),
    })
    .unwrap();
    assert_eq!(v["streamingBehavior"], "followUp");
    assert!(v.get("images").is_none(), "None fields are omitted");

    let v = serde_json::to_value(&RpcCommand::SetModel {
        provider: "openai".into(),
        model_id: "gpt-5".into(),
    })
    .unwrap();
    assert_eq!(v["modelId"], "gpt-5");

    let v = serde_json::to_value(&RpcCommand::Bash {
        command: "ls".into(),
        exclude_from_context: Some(true),
    })
    .unwrap();
    assert_eq!(v["excludeFromContext"], true);
}

// ============================================================================
// Response deserialization
// ============================================================================

#[test]
fn parses_success_response_with_data() {
    let line = r#"{"id":"t1","type":"response","command":"get_state","success":true,"data":{"thinkingLevel":"max","isStreaming":false,"isCompacting":false,"steeringMode":"one-at-a-time","followUpMode":"one-at-a-time","sessionId":"abc","autoCompactionEnabled":true,"messageCount":0,"pendingMessageCount":0}}"#;
    let resp: RpcResponse = serde_json::from_str(line).unwrap();
    assert!(resp.success);
    assert_eq!(resp.id.as_deref(), Some("t1"));
    let state = resp.session_state().unwrap();
    assert_eq!(state.session_id, "abc");
    assert_eq!(state.thinking_level, ThinkingLevel::Max);
    assert_eq!(state.steering_mode, QueueMode::OneAtATime);
    assert!(state.model.is_none());
}

#[test]
fn parses_error_response() {
    let line = r#"{"id":"t2","type":"response","command":"set_model","success":false,"error":"Model not found: x/y"}"#;
    let resp: RpcResponse = serde_json::from_str(line).unwrap();
    assert!(!resp.success);
    assert_eq!(resp.error.as_deref(), Some("Model not found: x/y"));
}

#[test]
fn parses_get_state_with_model() {
    let line = r#"{"type":"response","command":"get_state","success":true,"data":{"model":{"id":"swe-2","name":"SWE-2","api":"devin-agent","baseUrl":"https://x","reasoning":true,"thinkingLevelMap":{"off":null,"medium":"medium"},"input":["text","image"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":262000,"maxTokens":128000,"provider":"devin"},"thinkingLevel":"max","isStreaming":false,"isCompacting":false,"steeringMode":"one-at-a-time","followUpMode":"one-at-a-time","sessionFile":"C:\\s.jsonl","sessionId":"01","autoCompactionEnabled":true,"messageCount":3,"pendingMessageCount":0}}"#;
    let resp: RpcResponse = serde_json::from_str(line).unwrap();
    let state = resp.session_state().unwrap();
    let model = state.model.unwrap();
    assert_eq!(model.id, "swe-2");
    assert_eq!(model.provider, "devin");
    assert_eq!(model.context_window, 262000.0);
    assert_eq!(model.thinking_level_map.unwrap()["off"], None);
}

// ============================================================================
// Event deserialization
// ============================================================================

#[test]
fn parses_agent_lifecycle_events() {
    for (line, expected) in [
        (r#"{"type":"agent_start"}"#, "agent_start"),
        (r#"{"type":"turn_start"}"#, "turn_start"),
        (r#"{"type":"agent_settled"}"#, "agent_settled"),
        (r#"{"type":"agent_end","messages":[],"willRetry":false}"#, "agent_end"),
    ] {
        let ev: AgentEvent = serde_json::from_str(line).unwrap();
        assert_eq!(ev.event_type(), expected);
    }
}

#[test]
fn parses_message_start_with_user_message() {
    let line = r#"{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"hi"}],"timestamp":1}}"#;
    let ev: AgentEvent = serde_json::from_str(line).unwrap();
    match ev {
        AgentEvent::MessageStart { message: AgentMessage::User { content, .. } } => {
            match content {
                UserContent::Parts(parts) => assert_eq!(parts.len(), 1),
                _ => panic!("expected parts"),
            }
        }
        _ => panic!("expected MessageStart/User"),
    }
}

#[test]
fn parses_wire_message_update_text_delta() {
    // Wire form: usage + stripped assistantMessageEvent (no partial/message).
    let line = r#"{"type":"message_update","usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":15,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"ok"}}"#;
    let ev: AgentEvent = serde_json::from_str(line).unwrap();
    match &ev {
        AgentEvent::MessageUpdate {
            assistant_message_event: AssistantMessageEvent::TextDelta { delta, content_index },
            usage,
        } => {
            assert_eq!(delta, "ok");
            assert_eq!(*content_index, 0);
            assert_eq!(usage.as_ref().unwrap().total_tokens, 15.0);
        }
        _ => panic!("expected MessageUpdate/TextDelta, got {ev:?}"),
    }
    assert_eq!(pi_rpc::events::text_delta(&ev), Some("ok"));
}

#[test]
fn parses_wire_message_update_toolcall_start() {
    let line = r#"{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","contentIndex":1,"id":"tc1","toolName":"bash"}}"#;
    let ev: AgentEvent = serde_json::from_str(line).unwrap();
    match ev {
        AgentEvent::MessageUpdate {
            assistant_message_event: AssistantMessageEvent::ToolcallStart { id, tool_name, .. },
            ..
        } => {
            assert_eq!(id.as_deref(), Some("tc1"));
            assert_eq!(tool_name.as_deref(), Some("bash"));
        }
        _ => panic!("expected ToolcallStart"),
    }
}

#[test]
fn parses_tool_execution_events() {
    let line = r#"{"type":"tool_execution_end","toolCallId":"t1","toolName":"bash","result":{"out":"x"},"isError":false}"#;
    let ev: AgentEvent = serde_json::from_str(line).unwrap();
    match ev {
        AgentEvent::ToolExecutionEnd { tool_call_id, is_error, .. } => {
            assert_eq!(tool_call_id, "t1");
            assert!(!is_error);
        }
        _ => panic!("expected ToolExecutionEnd"),
    }
}

#[test]
fn unknown_event_type_falls_back() {
    let line = r#"{"type":"some_future_event","payload":{"a":1}}"#;
    let ev: AgentEvent = serde_json::from_str(line).unwrap();
    match ev {
        AgentEvent::Unknown(v) => assert_eq!(v["type"], "some_future_event"),
        _ => panic!("expected Unknown fallback"),
    }
    assert_eq!(
        serde_json::from_str::<AgentEvent>(line).unwrap().event_type(),
        "some_future_event"
    );
}

#[test]
fn parses_session_events() {
    let line = r#"{"type":"auto_retry_start","attempt":1,"maxAttempts":10,"delayMs":1000,"errorMessage":"fetch failed"}"#;
    let ev: AgentEvent = serde_json::from_str(line).unwrap();
    match ev {
        AgentEvent::AutoRetryStart { attempt, max_attempts, .. } => {
            assert_eq!(attempt, 1);
            assert_eq!(max_attempts, 10);
        }
        _ => panic!("expected AutoRetryStart"),
    }

    let line = r#"{"type":"queue_update","steering":["a"],"followUp":[]}"#;
    let ev: AgentEvent = serde_json::from_str(line).unwrap();
    match ev {
        AgentEvent::QueueUpdate { steering, .. } => assert_eq!(steering, vec!["a"]),
        _ => panic!("expected QueueUpdate"),
    }
}

// ============================================================================
// Extension UI
// ============================================================================

#[test]
fn parses_all_ui_request_methods() {
    let cases = [
        (r#"{"type":"extension_ui_request","id":"u1","method":"select","title":"Pick","options":["a","b"],"timeout":30}"#, "select"),
        (r#"{"type":"extension_ui_request","id":"u2","method":"confirm","title":"T","message":"Sure?"}"#, "confirm"),
        (r#"{"type":"extension_ui_request","id":"u3","method":"input","title":"T","placeholder":"p"}"#, "input"),
        (r#"{"type":"extension_ui_request","id":"u4","method":"editor","title":"T","prefill":"x"}"#, "editor"),
        (r#"{"type":"extension_ui_request","id":"u5","method":"notify","message":"hi","notifyType":"info"}"#, "notify"),
        (r#"{"type":"extension_ui_request","id":"u6","method":"setStatus","statusKey":"k","statusText":"v"}"#, "setStatus"),
        (r#"{"type":"extension_ui_request","id":"u7","method":"setWidget","widgetKey":"w","widgetLines":["l1"],"widgetPlacement":"aboveEditor"}"#, "setWidget"),
        (r#"{"type":"extension_ui_request","id":"u8","method":"setTitle","title":"T"}"#, "setTitle"),
        (r#"{"type":"extension_ui_request","id":"u9","method":"set_editor_text","text":"abc"}"#, "set_editor_text"),
        (r#"{"type":"extension_ui_request","id":"u10","method":"custom","driver":"plugin","spec":{"kind":"card","title":"T","width":"72%","maxHeight":"85%","hints":[{"key":"esc","verb":"cancel"}]}}"#, "custom"),
        (r#"{"type":"extension_ui_request","id":"u11","method":"overlay_frame","frame":[[{"text":"hi","role":"accent","bold":true}]],"cursor":[1,2]}"#, "overlay_frame"),
        (r#"{"type":"extension_ui_request","id":"u12","method":"overlay_close"}"#, "overlay_close"),
    ];
    for (line, method) in cases {
        let req: RpcExtensionUIRequest = serde_json::from_str(line).unwrap();
        assert_eq!(req.method(), method);
        assert!(!req.id().is_empty());
    }
}

#[test]
fn ui_request_expects_response_flags() {
    let select: RpcExtensionUIRequest = serde_json::from_str(
        r#"{"type":"extension_ui_request","id":"u1","method":"select","title":"T","options":[]}"#,
    )
    .unwrap();
    assert!(select.expects_response());

    let notify: RpcExtensionUIRequest = serde_json::from_str(
        r#"{"type":"extension_ui_request","id":"u2","method":"notify","message":"m"}"#,
    )
    .unwrap();
    assert!(!notify.expects_response());

    // client-driven custom blocks on a response; plugin-driven does not.
    let client: RpcExtensionUIRequest = serde_json::from_str(
        r#"{"type":"extension_ui_request","id":"u3","method":"custom","driver":"client","spec":{"kind":"card"}}"#,
    )
    .unwrap();
    assert!(client.expects_response());
    assert!(client.occupies_surface());

    let plugin: RpcExtensionUIRequest = serde_json::from_str(
        r#"{"type":"extension_ui_request","id":"u4","method":"custom","driver":"plugin","spec":{"kind":"card"}}"#,
    )
    .unwrap();
    assert!(!plugin.expects_response());
    assert!(plugin.occupies_surface());

    let frame: RpcExtensionUIRequest = serde_json::from_str(
        r#"{"type":"extension_ui_request","id":"u4","method":"overlay_frame","frame":[]}"#,
    )
    .unwrap();
    assert!(!frame.occupies_surface());
}

#[test]
fn custom_overlay_wire_shapes() {
    // OverlaySpec field names match the TS overlay-spec.ts mirror.
    let req: RpcExtensionUIRequest = serde_json::from_str(
        r#"{"type":"extension_ui_request","id":"u1","method":"custom","driver":"plugin","spec":{"kind":"card","title":"Gw","anchor":"center","width":"72%","minWidth":40,"maxHeight":"85%","offsetY":-2,"dismissable":false,"hints":[{"key":"enter","verb":"select"}]}}"#,
    )
    .unwrap();
    match req {
        RpcExtensionUIRequest::Custom { driver, spec, .. } => {
            assert_eq!(driver, OverlayDriver::Plugin);
            assert_eq!(spec.title.as_deref(), Some("Gw"));
            assert_eq!(spec.anchor, Some(OverlayAnchor::Center));
            assert_eq!(spec.width, Some(SizeValue::Percent("72%".into())));
            assert_eq!(spec.min_width, Some(40));
            assert_eq!(spec.offset_y, Some(-2));
            assert_eq!(spec.dismissable, Some(false));
            assert_eq!(spec.hints[0].key, "enter");
        }
        _ => panic!("expected Custom"),
    }

    // Span roles serialize snake_case; absent role/bold are omitted.
    let frame: Frame = vec![vec![
        Span { text: "k".into(), role: Some(Role::HintKey), bold: true },
        Span { text: "v".into(), role: None, bold: false },
    ]];
    let v = serde_json::to_value(&RpcExtensionUIRequest::OverlayFrame {
        id: "u1".into(),
        frame,
        cursor: None,
    })
    .unwrap();
    assert_eq!(v["method"], "overlay_frame");
    assert_eq!(v["frame"][0][0], json!({"text":"k","role":"hint_key","bold":true}));
    assert_eq!(v["frame"][0][1], json!({"text":"v"}));
}

#[test]
fn extension_ui_event_wire_shape() {
    let ev = RpcExtensionUIEvent {
        id: "u1".into(),
        event: UiEvent::Key { key: "j".into(), mods: vec![] },
    }
    .to_wire_value();
    assert_eq!(ev["type"], "extension_ui_event");
    assert_eq!(ev["id"], "u1");
    assert_eq!(ev["event"], json!({"kind":"key","key":"j"}));

    let ev = RpcExtensionUIEvent { id: "u2".into(), event: UiEvent::Dismissed }.to_wire_value();
    assert_eq!(ev["event"], json!({"kind":"dismissed"}));

    let ev = RpcExtensionUIEvent {
        id: "u3".into(),
        event: UiEvent::Resize { w: 120, h: 40 },
    }
    .to_wire_value();
    assert_eq!(ev["event"], json!({"kind":"resize","w":120,"h":40}));
}

#[test]
fn ui_capabilities_accessor() {
    let resp: RpcResponse = serde_json::from_value(json!({
        "type":"response","command":"get_capabilities","success":true,
        "data":{"ui":{"custom":true,"spec_version":1,"events":true}}
    }))
    .unwrap();
    let caps = resp.ui_capabilities().unwrap();
    assert!(caps.custom && caps.events && caps.spec_version == 1);

    // Older agents: error response or no ui field → None.
    let resp: RpcResponse = serde_json::from_value(json!({
        "type":"response","command":"get_capabilities","success":false,"error":"unknown command"
    }))
    .unwrap();
    assert!(resp.ui_capabilities().is_none());
}

#[test]
fn ui_response_wire_shapes() {
    let v = RpcExtensionUIResponse::Value { id: "u1".into(), value: "x".into() }.to_wire_value();
    assert_eq!(v["type"], "extension_ui_response");
    assert_eq!(v["value"], "x");

    let v = RpcExtensionUIResponse::Confirmed { id: "u2".into(), confirmed: true }.to_wire_value();
    assert_eq!(v["confirmed"], true);

    let v = RpcExtensionUIResponse::Cancelled { id: "u3".into(), cancelled: true }.to_wire_value();
    assert_eq!(v["cancelled"], true);
}

#[test]
fn ui_request_status_text_can_be_absent() {
    // pi emits `statusText: undefined` → key absent on the wire.
    let req: RpcExtensionUIRequest = serde_json::from_str(
        r#"{"type":"extension_ui_request","id":"u1","method":"setStatus","statusKey":"k"}"#,
    )
    .unwrap();
    match req {
        RpcExtensionUIRequest::SetStatus { status_text, .. } => assert!(status_text.is_none()),
        _ => panic!("expected SetStatus"),
    }
}

// ============================================================================
// classify_line
// ============================================================================

#[test]
fn classifies_each_line_kind() {
    assert!(matches!(
        classify_line(r#"{"type":"response","command":"abort","success":true}"#),
        RpcLine::Response(_)
    ));
    assert!(matches!(
        classify_line(r#"{"type":"agent_start"}"#),
        RpcLine::Event(_)
    ));
    assert!(matches!(
        classify_line(r#"{"type":"extension_ui_request","id":"u","method":"notify","message":"m"}"#),
        RpcLine::ExtensionUIRequest(_)
    ));
    assert!(matches!(
        classify_line(r#"{"type":"extension_error","error":"x"}"#),
        RpcLine::Other(_)
    ));
    assert!(matches!(classify_line("not json"), RpcLine::Unparseable(_)));
}

#[test]
fn slash_command_deserializes() {
    let cmd: RpcSlashCommand = serde_json::from_value(json!({
        "name": "skill:review",
        "description": "Review code",
        "source": "skill",
        "sourceInfo": {"path": "/x"}
    }))
    .unwrap();
    assert_eq!(cmd.name, "skill:review");
    assert_eq!(cmd.source, "skill");
}

#[test]
fn response_data_helpers() {
    // set_model → data is the Model itself.
    let resp: RpcResponse = serde_json::from_value(json!({
        "type": "response", "command": "set_model", "success": true,
        "data": {"id":"k3","name":"K3","api":"k","baseUrl":"https://x","reasoning":false,"provider":"kimi"}
    }))
    .unwrap();
    let m = resp.model_data().unwrap();
    assert_eq!(m.id, "k3");
    assert_eq!(m.provider, "kimi");

    // cycle_model → {model, thinkingLevel, isScoped}; null data → None.
    let resp: RpcResponse = serde_json::from_value(json!({
        "type": "response", "command": "cycle_model", "success": true,
        "data": {"model":{"id":"m2","name":"M2","api":"a","baseUrl":"u","reasoning":true,"provider":"p"},
                 "thinkingLevel":"high","isScoped":true}
    }))
    .unwrap();
    let (m, lvl) = resp.cycle_model_data().unwrap();
    assert_eq!(m.id, "m2");
    assert_eq!(lvl, ThinkingLevel::High);
    let resp: RpcResponse = serde_json::from_value(json!({
        "type": "response", "command": "cycle_model", "success": true, "data": null
    }))
    .unwrap();
    assert!(resp.cycle_model_data().is_none());

    // export_html → {path}; new_session → {cancelled}.
    let resp: RpcResponse = serde_json::from_value(json!({
        "type": "response", "command": "export_html", "success": true,
        "data": {"path": "C:/out/s.html"}
    }))
    .unwrap();
    assert_eq!(resp.export_path().as_deref(), Some("C:/out/s.html"));
    let resp: RpcResponse = serde_json::from_value(json!({
        "type": "response", "command": "new_session", "success": true,
        "data": {"cancelled": false}
    }))
    .unwrap();
    assert!(!resp.cancelled());

    // cycle_thinking_level → {level}.
    let resp: RpcResponse = serde_json::from_value(json!({
        "type": "response", "command": "cycle_thinking_level", "success": true,
        "data": {"level": "low"}
    }))
    .unwrap();
    assert_eq!(resp.cycle_thinking_level(), Some(ThinkingLevel::Low));
}
