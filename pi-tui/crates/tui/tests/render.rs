//! Integration test: synthetic `RpcEvent`s → `AppState` → DOM → paint →
//! surface text. Verifies the streaming render path end-to-end without a
//! terminal or a live pi process.

use blitz_dom::{BaseDocument, DocumentConfig};
use blitz_traits::shell::Viewport;
use pi_rpc::{AgentEvent, AssistantMessageEvent, RpcEvent};
use scrollback::{PaintContext, Surface, paint_document};
use pi_fluent_tui::app;
use pi_fluent_tui::components::{input_box, message_list, status_line};
use pi_fluent_tui::state::{AppState, MsgKind};
use pi_fluent_tui::theme::{self, ThemeKind};

const W: u16 = 60;
const H: u16 = 20;

struct Fixture {
    doc: BaseDocument,
    handles: app::DomHandles,
    state: AppState,
    w: u16,
    h: u16,
}

impl Fixture {
    fn new() -> Self {
        Self::at(W, H)
    }

    /// Fixture at a custom terminal size (`.tip-text` hides <80px).
    fn at(w: u16, h: u16) -> Self {
        let font_ctx = blitz_dom::build_single_font_ctx(app::TERMINAL_MONO_BYTES);
        let mut doc = BaseDocument::new(DocumentConfig {
            viewport: Some(Viewport::new(
                w as u32,
                h as u32,
                1.0,
                ThemeKind::Dark.color_scheme(),
            )),
            font_ctx: Some(font_ctx),
            ua_stylesheets: None,
            ..Default::default()
        });
        doc.add_user_agent_stylesheet(&theme::stylesheet(ThemeKind::Dark));
        let handles = app::build_skeleton(&mut doc);
        {
            let mut m = doc.mutate();
            m.set_style_property(handles.app, "width", &format!("{w}px"));
            m.set_style_property(handles.app, "height", &format!("{h}px"));
        }
        Fixture {
            doc,
            handles,
            state: AppState::new(),
            w,
            h,
        }
    }

    /// Sync DOM → resolve → scroll → paint → surface text.
    fn frame(&mut self) -> String {
        self.frame_surface().0
    }

    /// Like `frame` but also returns the painted hit regions.
    fn frame_surface(&mut self) -> (String, Vec<scrollback::HitRegion>) {
        {
            let mut m = self.doc.mutate();
            message_list::sync(&mut m, self.handles.messages_inner, &mut self.state);
            let hint = pi_fluent_tui::components::input_box::hint_for(
                &self.state.input,
                &self.state.attachments,
                self.state.attachment_sel,
                pi_fluent_tui::components::input_box::TIPS[self.state.tip_idx],
            );
            input_box::sync(
                &mut m,
                self.handles.input_hint_text,
                self.handles.input_text,
                &self.state.input,
                self.state.dialog.is_none(),
                &hint,
            );
            status_line::sync(
                &mut m,
                self.handles.status_left,
                self.handles.status_right,
                &self.state.status,
                self.state.streaming,
                self.state.permission.label(),
                self.state.queued.len(),
            );
            pi_fluent_tui::components::spinner::sync(
                &mut m,
                &self.handles.spinner,
                self.state.streaming,
                self.state.tick,
                "esc to interrupt",
                self.state.glyphs,
            );
            pi_fluent_tui::components::dialog::sync(
                &mut m,
                self.handles.dialog_area,
                self.handles.widget_area,
                &self.state,
                self.state.glyphs,
            );
            pi_fluent_tui::components::completion::sync(
                &mut m,
                self.handles.completion_area,
                &self.state,
                self.state.glyphs,
            );
        }
        self.doc.set_viewport(Viewport::new(
            self.w as u32,
            self.h as u32,
            1.0,
            ThemeKind::Dark.color_scheme(),
        ));
        self.doc.resolve(0.0);
        message_list::apply_scroll(&mut self.doc, self.handles.messages, &mut self.state);
        let mut surface = Surface::new(self.w, self.h);
        let hits;
        {
            let mut ctx = PaintContext::new(&self.doc, &mut surface);
            paint_document(&mut ctx);
            hits = std::mem::take(&mut ctx.hit_regions);
        }
        (surface.to_text(), hits)
    }

    fn event(&mut self, e: AgentEvent) {
        self.state.apply_event(&RpcEvent::Agent(e));
    }
}

fn text_delta_ev(delta: &str) -> AgentEvent {
    AgentEvent::MessageUpdate {
        usage: None,
        assistant_message_event: AssistantMessageEvent::TextDelta {
            content_index: 0,
            delta: delta.to_string(),
        },
    }
}

#[test]
fn prompt_to_streaming_render() {
    let mut f = Fixture::new();

    // User submits a prompt.
    f.state.push_user("hello pi");
    f.event(AgentEvent::AgentStart);
    assert!(f.state.streaming);

    // Streaming text deltas accumulate into one assistant bubble.
    f.event(text_delta_ev("Hello "));
    f.event(text_delta_ev("world"));
    f.event(text_delta_ev("!"));

    let text = f.frame();
    assert!(text.contains("hello pi"), "user bubble:\n{text}");
    assert!(text.contains("Hello world!"), "streamed text:\n{text}");

    // Turn ends → streaming off.
    f.event(AgentEvent::AgentEnd {
        messages: vec![],
        will_retry: None,
    });
    assert!(!f.state.streaming);
}

#[test]
fn cjk_text_renders_without_icu_error() {
    // Regression: parley without `complex-scripts` panics/errors on
    // CJK ("No segmentation model for complex script").
    let mut f = Fixture::new();
    f.state.push_user("你好世界，这是一段中文输入");
    f.event(AgentEvent::AgentStart);
    f.event(text_delta_ev("表格渐变色改普通表格，已创建 Run。"));
    let text = f.frame();
    // Wide glyphs occupy two cells — the dump spaces them apart.
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    assert!(compact.contains("你好世界"), "cjk user:\n{text}");
    assert!(compact.contains("表格渐变色"), "cjk assistant:\n{text}");
}

#[test]
fn tool_lifecycle_renders() {
    let mut f = Fixture::new();
    f.event(AgentEvent::AgentStart);
    f.event(AgentEvent::ToolExecutionStart {
        tool_call_id: "t1".into(),
        tool_name: "bash".into(),
        args: serde_json::json!({"command": "ls -la"}),
    });
    f.event(AgentEvent::ToolExecutionEnd {
        tool_call_id: "t1".into(),
        tool_name: "bash".into(),
        result: serde_json::json!({"output": "ok"}),
        is_error: false,
    });
    let text = f.frame();
    assert!(text.contains("✓ Ran command"), "tool entry:\n{text}");
    assert!(text.contains("$ ls -la"), "command line:\n{text}");
}

#[test]
fn thinking_delta_renders_muted() {
    let mut f = Fixture::new();
    f.event(AgentEvent::AgentStart);
    f.event(AgentEvent::MessageUpdate {
        usage: None,
        assistant_message_event: AssistantMessageEvent::ThinkingDelta {
            content_index: 0,
            delta: "pondering…".into(),
        },
    });
    let text = f.frame();
    assert!(text.contains("pondering…"), "thinking trace:\n{text}");
    assert_eq!(f.state.messages.last().unwrap().kind, MsgKind::Thinking);
}

#[test]
fn input_cursor_marker_paints() {
    let mut f = Fixture::new();
    f.state.input.text = "abc".into();
    f.state.input.cursor = 1;
    let mut surface_contains_marker = false;
    {
        let mut m = f.doc.mutate();
        input_box::sync(
            &mut m,
            f.handles.input_hint_text,
            f.handles.input_text,
            &f.state.input,
            true,
            "",
        );
    }
    f.doc.resolve(0.0);
    let mut surface = Surface::new(W, H);
    {
        let mut ctx = PaintContext::new(&f.doc, &mut surface);
        paint_document(&mut ctx);
    }
    for mk in &surface.markers {
        if mk.text.contains(input_box::CURSOR_MARKER) {
            surface_contains_marker = true;
        }
    }
    assert!(surface_contains_marker, "PUA cursor marker recorded");
}

#[test]
fn scroll_follows_tail() {
    let mut f = Fixture::new();
    // Overflow the message area (16 rows) with many messages.
    for i in 0..30 {
        f.state.push_user(format!("message {i}"));
    }
    let text = f.frame();
    // Tail visible, head scrolled off.
    assert!(text.contains("message 29"), "tail visible:\n{text}");
    assert!(!text.contains("message 0│"), "head scrolled off:\n{text}");
    assert!(f.state.scroll > 0, "scroll offset advanced");
}


// ---------------------------------------------------------------------------
// P4: components (markdown / tool_card / hint_bar / spinner / select /
// dialogs / permission modes / mouse hit regions)
// ---------------------------------------------------------------------------

use pi_fluent_tui::components::{glyphs, select, tool_card};
use pi_fluent_tui::state::{DialogState, Message, PermissionMode};

#[test]
fn markdown_renders_blocks() {
    let mut f = Fixture::new();
    f.state.push(Message::new(
        MsgKind::Assistant,
        "# Title\n\npara with `code` and **bold**\n\n> quoted\n\n- [x] done\n- [ ] todo\n\n```rust\nfn f() {}\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n![alt text](img.png) [link](https://x.y)",
    ));
    let (text, hits) = f.frame_surface();
    assert!(text.contains("Title"), "h1:\n{text}");
    assert!(text.contains("code"), "inline code:\n{text}");
    assert!(text.contains("quoted"), "blockquote:\n{text}");
    assert!(text.contains("[x] done"), "task checked:\n{text}");
    assert!(text.contains("[ ] todo"), "task unchecked:\n{text}");
    assert!(text.contains("fn f()"), "code block:\n{text}");
    assert!(text.contains("[Image: alt text]"), "image:\n{text}");
    assert!(text.contains("link"), "link text:\n{text}");
    // The link span records a `data-hit-link` region with the URL.
    assert!(
        hits.iter()
            .any(|h| h.kind == "link" && h.payload.as_deref() == Some("https://x.y")),
        "link hit region: {hits:?}"
    );
}

#[test]
fn tool_card_diff_and_truncation() {
    let mut f = Fixture::new();
    let mut m = Message::new(MsgKind::Tool, "src/a.rs");
    m.tool_name = Some("edit".into());
    m.tool_status = Some('✓');
    m.tool_output = Some(
        "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,2 +1,2 @@\n-old line\n+new line\n ctx"
            .into(),
    );
    f.state.push(m);
    let text = f.frame();
    assert!(text.contains("✓ Edited src/a.rs"), "tool head:\n{text}");
    assert!(text.contains("-old line"), "delete line:\n{text}");
    assert!(text.contains("+new line"), "insert line:\n{text}");
    assert!(text.contains("@@ -1,2 +1,2 @@"), "hunk:\n{text}");

    // Truncation: >8 output lines collapse with the marker.
    let mut m2 = Message::new(MsgKind::Tool, "ls");
    m2.tool_name = Some("bash".into());
    m2.tool_status = Some('✓');
    m2.tool_output = Some(
        (1..=20)
            .map(|i| format!("line{i}"))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    f.state.push(m2);
    let (text, hits) = f.frame_surface();
    assert!(
        text.contains("[... 12 lines truncated (ctrl+o to expand) ...]"),
        "truncation marker:\n{text}"
    );
    assert!(
        hits.iter().any(|h| h.kind == "expand"),
        "expand hit region: {hits:?}"
    );

    // Ctrl+O expands.
    assert!(f.state.toggle_last_tool());
    let text = f.frame();
    assert!(text.contains("line20"), "expanded tail:\n{text}");
    assert!(!text.contains("truncated"), "marker gone:\n{text}");
}

#[test]
fn tool_card_ascii_glyphs() {
    let mut f = Fixture::new();
    f.state.glyphs = glyphs::GlyphMode::Ascii;
    let mut m = Message::new(MsgKind::Tool, "x");
    m.tool_name = Some("bash".into());
    m.tool_status = Some('✓');
    f.state.push(m);
    let text = f.frame();
    assert!(text.contains("[OK] Ran command"), "ascii glyph:\n{text}");
}

#[test]
fn permission_mode_cycles() {
    let mut f = Fixture::new();
    assert_eq!(f.state.permission, PermissionMode::Normal);
    f.state.permission = f.state.permission.next();
    assert_eq!(f.state.permission, PermissionMode::AcceptEdits);
    f.state.permission = f.state.permission.next();
    f.state.permission = f.state.permission.next();
    assert_eq!(f.state.permission, PermissionMode::Plan);
    // Wrap-around.
    for _ in 0..4 {
        f.state.permission = f.state.permission.next();
    }
    assert_eq!(f.state.permission, PermissionMode::Normal);
    let text = f.frame();
    assert!(text.contains("NORMAL"), "status shows mode:\n{text}");
}

#[test]
fn spinner_line_renders_when_streaming() {
    let mut f = Fixture::new();
    f.state.streaming = true;
    f.state.tick = 6; // frame 2
    let text = f.frame();
    assert!(text.contains("Thinking"), "thinking label:\n{text}");
    assert!(text.contains("esc to interrupt"), "interrupt hint:\n{text}");
    // Braille frame present (unicode mode default).
    assert!(
        text.contains(glyphs::GlyphMode::Unicode.spinner_frame(2)),
        "braille frame:\n{text}"
    );
}

#[test]
fn select_dialog_renders_and_filters() {
    let mut f = Fixture::new();
    f.state.dialog = Some(DialogState::Select {
        id: "r1".into(),
        sel: select::SelectState::new(
            "Pick one",
            vec!["alpha".to_string(), "beta".to_string(), "gamma".to_string()],
        ),
    });
    let (text, hits) = f.frame_surface();
    assert!(text.contains("Pick one"), "title:\n{text}");
    assert!(text.contains("Type to search"), "filter:\n{text}");
    assert!(text.contains("alpha"), "option:\n{text}");
    assert!(text.contains("›"), "cursor:\n{text}");
    // Options carry data-hit-idx regions.
    assert!(
        hits.iter().filter(|h| h.kind == "idx").count() >= 3,
        "option hit regions: {hits:?}"
    );

    // Filter narrows the list.
    if let Some(DialogState::Select { sel, .. }) = &mut f.state.dialog {
        sel.push_filter('g');
        sel.push_filter('a');
    }
    let text = f.frame();
    assert!(text.contains("gamma"), "filtered option:\n{text}");
    assert!(!text.contains("beta"), "filtered out:\n{text}");
}

#[test]
fn confirm_dialog_renders() {
    let mut f = Fixture::new();
    f.state.dialog = Some(DialogState::Confirm {
        id: "c1".into(),
        title: "Delete file?".into(),
        message: "This cannot be undone".into(),
    });
    let (text, hits) = f.frame_surface();
    assert!(text.contains("Delete file?"), "title:\n{text}");
    assert!(text.contains("yes"), "yes button:\n{text}");
    assert!(
        hits.iter()
            .any(|h| h.kind == "confirm" && h.payload.as_deref() == Some("yes")),
        "confirm hit: {hits:?}"
    );
}

#[test]
fn extension_ui_request_opens_dialog() {
    use pi_rpc::RpcExtensionUIRequest;
    let mut f = Fixture::new();
    let req = RpcExtensionUIRequest::Select {
        id: "s1".into(),
        title: "Choose".into(),
        options: vec!["a".into(), "b".into()],
        timeout: None,
    };
    f.state.apply_event(&RpcEvent::ExtensionUiRequest(req));
    assert!(matches!(f.state.dialog, Some(DialogState::Select { .. })));

    // A second interactive request queues behind the first.
    let req2 = RpcExtensionUIRequest::Confirm {
        id: "c2".into(),
        title: "Sure?".into(),
        message: "m".into(),
        timeout: None,
    };
    f.state.apply_event(&RpcEvent::ExtensionUiRequest(req2));
    assert_eq!(f.state.pending_ui.len(), 1);

    // Resolving the first promotes the queued confirm.
    f.state
        .resolve_dialog(pi_rpc::RpcExtensionUIResponse::Value {
            id: "s1".into(),
            value: "a".into(),
        });
    assert!(matches!(f.state.dialog, Some(DialogState::Confirm { .. })));
    assert!(f.state.dialog_result.is_some());
}

#[test]
fn plugin_overlay_lifecycle() {
    use pi_rpc::{OverlayDriver, OverlaySpec, RpcExtensionUIRequest, Role, Span};
    let mut f = Fixture::new();

    let spec = OverlaySpec {
        kind: "card".into(),
        title: Some("Gw tunnels".into()),
        anchor: None,
        width: Some(pi_rpc::SizeValue::Percent("72%".into())),
        min_width: None,
        max_height: Some(pi_rpc::SizeValue::Percent("85%".into())),
        margin: None,
        offset_x: None,
        offset_y: None,
        dismissable: Some(true),
        hints: vec![pi_rpc::OverlayHint { key: "esc".into(), verb: "cancel".into() }],
    };
    f.state.apply_event(&RpcEvent::ExtensionUiRequest(
        RpcExtensionUIRequest::Custom {
            id: "ov1".into(),
            driver: OverlayDriver::Plugin,
            spec,
        },
    ));
    assert!(matches!(f.state.dialog, Some(DialogState::Plugin { .. })));

    // A second surface-occupying request queues behind the plugin overlay.
    f.state.apply_event(&RpcEvent::ExtensionUiRequest(
        RpcExtensionUIRequest::Confirm {
            id: "c9".into(),
            title: "queued".into(),
            message: "m".into(),
            timeout: None,
        },
    ));
    assert_eq!(f.state.pending_ui.len(), 1);

    // overlay_frame swaps the body; the card renders title + rows + hints.
    f.state.apply_event(&RpcEvent::ExtensionUiRequest(
        RpcExtensionUIRequest::OverlayFrame {
            id: "ov1".into(),
            frame: vec![
                vec![Span { text: "row one".into(), role: None, bold: false }],
                vec![Span {
                    text: "picked".into(),
                    role: Some(Role::Selected),
                    bold: false,
                }],
            ],
            cursor: None,
        },
    ));
    let text = f.frame();
    assert!(text.contains("Gw tunnels"), "title:\n{text}");
    assert!(text.contains("row one"), "frame row:\n{text}");
    assert!(text.contains("picked"), "selected row:\n{text}");
    assert!(text.contains("esc"), "hint:\n{text}");

    // overlay_close frees the surface and promotes the queued confirm —
    // no extension_ui_response is owed for a plugin-driven overlay.
    f.state.apply_event(&RpcEvent::ExtensionUiRequest(
        RpcExtensionUIRequest::OverlayClose { id: "ov1".into() },
    ));
    assert!(matches!(f.state.dialog, Some(DialogState::Confirm { .. })));
    assert!(f.state.dialog_result.is_none());
}

#[test]
fn plugin_overlay_cancel_owes_no_response() {
    use pi_rpc::{OverlayDriver, OverlaySpec, RpcExtensionUIRequest};
    let mut f = Fixture::new();
    let spec = OverlaySpec {
        kind: "card".into(),
        title: None,
        anchor: None,
        width: None,
        min_width: None,
        max_height: None,
        margin: None,
        offset_x: None,
        offset_y: None,
        dismissable: Some(true),
        hints: vec![],
    };
    f.state.apply_event(&RpcEvent::ExtensionUiRequest(
        RpcExtensionUIRequest::Custom {
            id: "ov2".into(),
            driver: OverlayDriver::Plugin,
            spec,
        },
    ));
    f.state.cancel_dialog();
    assert!(f.state.dialog.is_none());
    assert!(f.state.dialog_result.is_none(), "plugin overlay owes no response");

    // Client-driven custom still resolves with a Cancelled response.
    let spec = OverlaySpec {
        kind: "card".into(),
        title: None,
        anchor: None,
        width: None,
        min_width: None,
        max_height: None,
        margin: None,
        offset_x: None,
        offset_y: None,
        dismissable: None,
        hints: vec![],
    };
    f.state.apply_event(&RpcEvent::ExtensionUiRequest(
        RpcExtensionUIRequest::Custom {
            id: "ov3".into(),
            driver: OverlayDriver::Client,
            spec,
        },
    ));
    f.state.cancel_dialog();
    assert!(matches!(
        f.state.dialog_result,
        Some(pi_rpc::RpcExtensionUIResponse::Cancelled { .. })
    ));
}

#[test]
fn notify_becomes_toast_and_widget_renders() {
    use pi_rpc::RpcExtensionUIRequest;
    let mut f = Fixture::new();
    f.state.apply_event(&RpcEvent::ExtensionUiRequest(
        RpcExtensionUIRequest::Notify {
            id: "n1".into(),
            message: "hello toast".into(),
            notify_type: Some("info".into()),
        },
    ));
    f.state.apply_event(&RpcEvent::ExtensionUiRequest(
        RpcExtensionUIRequest::SetWidget {
            id: "w1".into(),
            widget_key: "k".into(),
            widget_lines: Some(vec!["widget line 1".into()]),
            widget_placement: None,
        },
    ));
    let text = f.frame();
    assert!(text.contains("info: hello toast"), "toast:\n{text}");
    assert!(text.contains("widget line 1"), "widget:\n{text}");
}

#[test]
fn ctrl_l_clears_messages() {
    let mut f = Fixture::new();
    f.state.push_user("one");
    f.state.push_user("two");
    let _ = f.frame();
    f.state.clear_messages();
    let text = f.frame();
    assert!(!text.contains("one"), "cleared:\n{text}");
    assert!(f.state.messages.is_empty());
}

#[test]
fn mime_to_lang_mapping() {
    assert_eq!(tool_card::mime_to_lang("application/json"), Some("json"));
    assert_eq!(tool_card::mime_to_lang("text/x-python"), Some("py"));
    assert_eq!(tool_card::mime_to_lang(".rs"), Some("rs"));
    assert_eq!(tool_card::mime_to_lang("typescript"), Some("ts"));
    assert_eq!(tool_card::mime_to_lang("yaml"), Some("yaml"));
    assert_eq!(tool_card::mime_to_lang("exe"), None);
}

#[test]
fn diff_detection() {
    assert!(tool_card::looks_like_diff(
        "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-x\n+y"
    ));
    assert!(!tool_card::looks_like_diff("just some\nplain output\nlines"));
}


// ============================================================================
// Slash commands: apply_response reducer + local pickers
// ============================================================================

fn resp(command: &str, data: serde_json::Value) -> pi_rpc::RpcResponse {
    serde_json::from_value(serde_json::json!({
        "type": "response", "command": command, "success": true, "data": data
    }))
    .unwrap()
}

fn model_json(id: &str, provider: &str) -> serde_json::Value {
    serde_json::json!({
        "id": id, "name": id.to_uppercase(), "api": "a", "baseUrl": "u",
        "reasoning": false, "provider": provider
    })
}

#[test]
fn model_response_opens_picker_and_selects() {
    let mut f = Fixture::new();
    let r = resp(
        "get_available_models",
        serde_json::json!({"models": [model_json("k3","kimi"), model_json("swe-2","devin")]}),
    );
    assert_eq!(
        f.state.apply_response(&r),
        pi_fluent_tui::state::ResponseEffect::None
    );
    // Local picker opened with both models.
    let Some(pi_fluent_tui::state::DialogState::Local { sel, action }) = &f.state.dialog else {
        panic!("expected Local dialog, got {:?}", f.state.dialog);
    };
    assert_eq!(*action, pi_fluent_tui::state::LocalAction::SetModel);
    assert_eq!(sel.options.len(), 2);
    assert_eq!(f.state.models.len(), 2);
    // Renders through the select path.
    let text = f.frame();
    assert!(text.contains("k3"), "picker:\n{text}");
    assert!(text.contains("swe-2"), "picker:\n{text}");
    // Esc closes without a response.
    f.state.cancel_dialog();
    assert!(f.state.dialog.is_none());
    assert!(f.state.dialog_result.is_none());
}

#[test]
fn set_model_updates_status_line() {
    let mut f = Fixture::new();
    let r = resp("set_model", model_json("k3", "kimi"));
    assert_eq!(
        f.state.apply_response(&r),
        pi_fluent_tui::state::ResponseEffect::RefreshState
    );
    assert_eq!(f.state.status.model, "k3");
    let text = f.frame();
    assert!(text.contains("k3"), "status line:\n{text}");
}

#[test]
fn cycle_model_null_and_value() {
    let mut f = Fixture::new();
    let r = resp("cycle_model", serde_json::Value::Null);
    f.state.apply_response(&r);
    assert!(f
        .state
        .messages
        .iter()
        .any(|m| m.text.contains("no other scoped model")));
    let r = resp(
        "cycle_model",
        serde_json::json!({"model": model_json("m2","p"), "thinkingLevel": "high", "isScoped": true}),
    );
    f.state.apply_response(&r);
    assert_eq!(f.state.status.model, "m2");
    assert_eq!(f.state.status.thinking, "high");
}

#[test]
fn new_session_clears_only_when_not_cancelled() {
    let mut f = Fixture::new();
    f.state.push_user("old");
    let r = resp("new_session", serde_json::json!({"cancelled": true}));
    f.state.apply_response(&r);
    assert!(
        f.state.messages.iter().any(|m| m.kind == MsgKind::User),
        "cancelled keeps messages"
    );
    let r = resp("new_session", serde_json::json!({"cancelled": false}));
    assert_eq!(
        f.state.apply_response(&r),
        pi_fluent_tui::state::ResponseEffect::RefreshState
    );
    // Cleared + the "fresh session" system line.
    assert!(f
        .state
        .messages
        .iter()
        .all(|m| m.kind == MsgKind::System));
}

#[test]
fn thinking_picker_from_levels() {
    let mut f = Fixture::new();
    let r = resp(
        "get_available_thinking_levels",
        serde_json::json!({"levels": ["off","low","high","max"]}),
    );
    f.state.apply_response(&r);
    let Some(pi_fluent_tui::state::DialogState::Local { sel, action }) = &f.state.dialog else {
        panic!("expected Local dialog");
    };
    assert_eq!(*action, pi_fluent_tui::state::LocalAction::SetThinking);
    assert_eq!(sel.options.len(), 4);
    let text = f.frame();
    assert!(text.contains("xhigh") == false); // not in list
    assert!(text.contains("high"), "levels:\n{text}");
}

#[test]
fn failed_response_becomes_system_line() {
    let mut f = Fixture::new();
    let r: pi_rpc::RpcResponse = serde_json::from_value(serde_json::json!({
        "type": "response", "command": "set_model", "success": false,
        "error": "Model not found: x/y"
    }))
    .unwrap();
    f.state.apply_response(&r);
    assert!(f
        .state
        .messages
        .iter()
        .any(|m| m.kind == MsgKind::System && m.text.contains("Model not found")));
}

#[test]
fn get_commands_appends_pi_commands() {
    let mut f = Fixture::new();
    let r = resp(
        "get_commands",
        serde_json::json!({"commands": [{"name":"review","description":"Review code","source":"skill","sourceInfo":{}}]}),
    );
    f.state.apply_response(&r);
    assert!(f
        .state
        .messages
        .iter()
        .any(|m| m.text.contains("/review") && m.text.contains("skill")));
}

// ---------- subagent tray (RECON §12.2) ----------

fn tool_start(id: &str, name: &str, args: serde_json::Value) -> AgentEvent {
    AgentEvent::ToolExecutionStart {
        tool_call_id: id.into(),
        tool_name: name.into(),
        args,
    }
}

fn tool_end(id: &str, name: &str, is_error: bool) -> AgentEvent {
    AgentEvent::ToolExecutionEnd {
        tool_call_id: id.into(),
        tool_name: name.into(),
        result: serde_json::json!({"output": "done"}),
        is_error,
    }
}

#[test]
fn tray_tracks_subagent_lifecycle() {
    let mut f = Fixture::new();
    f.state.status.model = "gpt-5.6".into();
    f.event(AgentEvent::AgentStart);
    f.event(tool_start(
        "t1",
        "task",
        serde_json::json!({"prompt": "explore the codebase"}),
    ));
    assert_eq!(f.state.tray.entries.len(), 1);
    let e = &f.state.tray.entries[0];
    assert_eq!(e.title, "explore the codebase");
    assert_eq!(e.model, "gpt-5.6");
    assert_eq!(e.status, pi_fluent_tui::state::TrayStatus::Running);

    // A nested tool while the subagent runs bumps its tool count.
    f.event(tool_start("t2", "read", serde_json::json!({"path": "x"})));
    f.event(tool_end("t2", "read", false));
    assert_eq!(f.state.tray.entries[0].tools, 1);

    f.event(tool_end("t1", "task", false));
    assert_eq!(f.state.tray.entries[0].status, pi_fluent_tui::state::TrayStatus::Done);
    assert!(f.state.tray.entries[0].end_tick.is_some());
}

#[test]
fn tray_shell_and_failed_entries() {
    let mut f = Fixture::new();
    f.event(AgentEvent::AgentStart);
    // Foreground bash is NOT a tray entry.
    f.event(tool_start("t0", "bash", serde_json::json!({"command": "ls"})));
    f.event(tool_end("t0", "bash", false));
    assert!(f.state.tray.entries.is_empty());
    // Background bash → Shells tab.
    f.event(tool_start(
        "t1",
        "bash",
        serde_json::json!({"command": "make", "background": true}),
    ));
    f.event(tool_end("t1", "bash", true));
    assert_eq!(f.state.tray.entries.len(), 1);
    assert_eq!(f.state.tray.entries[0].kind, pi_fluent_tui::state::TrayKind::Shell);
    assert_eq!(f.state.tray.entries[0].status, pi_fluent_tui::state::TrayStatus::Failed);
    // Shells tab shows it; Subagents tab is empty.
    f.state.tray.set_tab(pi_fluent_tui::state::TrayTab::Shells);
    assert_eq!(f.state.tray.visible().len(), 1);
    f.state.tray.set_tab(pi_fluent_tui::state::TrayTab::Subagents);
    assert!(f.state.tray.visible().is_empty());
}

#[test]
fn tray_panel_renders_tabs_and_items() {
    let mut f = Fixture::new();
    f.event(AgentEvent::AgentStart);
    f.event(tool_start(
        "t1",
        "task",
        serde_json::json!({"prompt": "audit auth"}),
    ));
    f.state.tray.open = true;
    let text = f.frame();
    assert!(text.contains("Subagents"), "tabs:\n{text}");
    assert!(text.contains("Cloud agents"), "tabs:\n{text}");
    assert!(text.contains("Shells (0)"), "tabs:\n{text}");
    assert!(text.contains("audit auth"), "item:\n{text}");
    assert!(text.contains("[~]"), "running status:\n{text}");

    // Empty tab shows the empty state.
    f.state.tray.set_tab(pi_fluent_tui::state::TrayTab::Cloud);
    let text = f.frame();
    assert!(text.contains("No cloud agents yet."), "empty:\n{text}");
}

#[test]
fn tray_empty_subagents_hint() {
    let mut f = Fixture::new();
    f.state.tray.open = true;
    let text = f.frame();
    assert!(text.contains("No subagents yet."), "empty:\n{text}");
    assert!(text.contains("spawn a subagent"), "empty sub:\n{text}");
}

// ---------- tips / banner / action bar (RECON §9, §12.5) ----------

#[test]
fn startup_banner_shows_then_dismisses() {
    let mut f = Fixture::new();
    let text = f.frame();
    assert!(text.contains("Devin CLI"), "banner:\n{text}");
    assert!(text.contains("x.com/cognition"), "welcome link:\n{text}");

    // First prompt dismisses the banner.
    f.state.push_user("hi");
    let text = f.frame();
    assert!(!text.contains("Devin CLI"), "dismissed:\n{text}");
}

#[test]
fn input_hint_shows_rotating_tip() {
    // `.tip-text` is hidden below 80px — use a wide fixture.
    let mut f = Fixture::at(100, 20);
    let text = f.frame();
    assert!(
        text.contains("Shift+Tab to cycle permission modes"),
        "tip:\n{text}"
    );
    // Tip rotates every 300 ticks while input is empty.
    for _ in 0..300 {
        f.state.tick_frame();
    }
    assert_eq!(f.state.tip_idx, 1);
    let text = f.frame();
    assert!(text.contains("Type @ to mention files"), "tip 2:\n{text}");
    // Typing replaces the tip with nothing (or a prefix hint).
    f.state.input.insert_str("/mo");
    let text = f.frame();
    assert!(text.contains("slash command"), "prefix hint:\n{text}");
}

#[test]
fn action_bar_after_last_assistant() {
    let mut f = Fixture::new();
    f.event(AgentEvent::AgentStart);
    f.event(text_delta_ev("answer one"));
    f.event(AgentEvent::AgentEnd {
        messages: vec![],
        will_retry: None,
    });
    let text = f.frame();
    assert!(text.contains("good"), "action bar:\n{text}");
    assert!(text.contains("copy"), "action bar:\n{text}");
    // A newer assistant message moves the bar.
    f.event(AgentEvent::AgentStart);
    f.event(text_delta_ev("answer two is longer"));
    f.event(AgentEvent::AgentEnd {
        messages: vec![],
        will_retry: None,
    });
    let text = f.frame();
    // Bar should follow the last assistant bubble (only one "good").
    assert_eq!(text.matches("good").count(), 1, "one bar:\n{text}");
}

// ---------- model picker badges + settings (RECON §12.5) ----------

#[test]
fn model_picker_badges_and_footer() {
    let mut f = Fixture::at(100, 20);
    f.state.status.model = "m2".into();
    f.state.status.input_tokens = 64000;
    let r = resp(
        "get_available_models",
        serde_json::json!({"models": [
            {"id":"m1","name":"One","api":"x","provider":"p","baseUrl":"","reasoning":false,
             "cost":{"input":0,"output":0},"contextWindow":128000,"maxTokens":0},
            {"id":"m2","name":"Two","api":"x","provider":"p","baseUrl":"","reasoning":false,
             "cost":{"input":1,"output":2},"contextWindow":128000,"maxTokens":0},
            {"id":"m3","name":"Three","api":"x","provider":"p","baseUrl":"","reasoning":false,
             "cost":{"input":15,"output":75},"contextWindow":200000,"maxTokens":0}
        ]}),
    );
    f.state.apply_response(&r);
    let text = f.frame();
    assert!(text.contains("Recommended"), "first badge:\n{text}");
    assert!(text.contains("Low cost"), "m2 badge:\n{text}");
    assert!(text.contains("High cost"), "m3 badge:\n{text}");
    assert!(text.contains("64000 tokens (50% consumed)"), "footer:\n{text}");
    assert!(text.contains("estimates scaled by character ratio"), "note:\n{text}");
}

#[test]
fn settings_picker_toggles() {
    let mut f = Fixture::new();
    f.state.open_local_select(pi_fluent_tui::state::LocalAction::ToggleSetting);
    let Some(pi_fluent_tui::state::DialogState::Local { sel, .. }) = &f.state.dialog else {
        panic!("expected settings dialog");
    };
    assert_eq!(sel.options.len(), pi_fluent_tui::state::SETTINGS_KEYS.len());
    assert!(sel.options.iter().any(|o| o.label == "show_tips: on"));
    let text = f.frame();
    assert!(text.contains("show_tips: on"), "settings:\n{text}");
}

#[test]
fn show_tips_setting_gates_tip() {
    let mut f = Fixture::at(100, 20);
    f.state.settings.insert("show_tips".into(), false);
    assert!(!f.state.show_tips());
    // Rotation stops too.
    for _ in 0..300 {
        f.state.tick_frame();
    }
    assert_eq!(f.state.tip_idx, 0);
}

// ---------- `/` completion + SlotMap cache regression ----------

#[test]
fn slash_completion_filters_and_accepts() {
    let mut f = Fixture::at(100, 20);
    f.state.input.insert_str("/mo");
    f.state.update_completion();
    let comp = f.state.completion.as_ref().expect("completion open");
    assert!(comp.items.iter().any(|i| i.name == "model"));
    let text = f.frame();
    assert!(text.contains("/model"), "popup:\n{text}");

    // Accept → input becomes "/model " and popup closes.
    let name = f.state.accept_completion();
    assert_eq!(name.as_deref(), Some("model"));
    assert_eq!(f.state.input.text, "/model ");
    assert!(f.state.completion.is_none());
}

#[test]
fn slash_completion_closes_on_space_or_nonmatch() {
    let mut f = Fixture::new();
    f.state.input.insert_str("/zzz");
    f.state.update_completion();
    assert!(f.state.completion.is_none(), "no matches → closed");
    f.state.input.insert_str("/model x");
    f.state.update_completion();
    assert!(f.state.completion.is_none(), "space → closed");
}

#[test]
fn pi_commands_merge_into_completion() {
    let mut f = Fixture::new();
    f.state.commands_quiet = true;
    let r = resp(
        "get_commands",
        serde_json::json!({"commands": [{"name":"review","description":"Review code","source":"skill","sourceInfo":{}}]}),
    );
    f.state.apply_response(&r);
    // Quiet fetch: stored, not printed.
    assert!(f.state.messages.is_empty());
    assert_eq!(f.state.pi_commands.len(), 1);
    f.state.input.insert_str("/rev");
    f.state.update_completion();
    let comp = f.state.completion.as_ref().expect("completion open");
    assert_eq!(comp.items[0].name, "review");
}

#[test]
fn dialog_open_close_cycles_no_slotmap_panic() {
    // Regression: dropped dialog/tray/banner nodes left stale ids in
    // layout_children/paint_children caches → `invalid SlotMap key`.
    let mut f = Fixture::new();
    for _ in 0..3 {
        f.state.open_local_select(pi_fluent_tui::state::LocalAction::ToggleSetting);
        let _ = f.frame();
        f.state.cancel_dialog();
        let _ = f.frame();
    }
    // Tray open/close cycles too.
    for _ in 0..3 {
        f.state.tray.open = true;
        let _ = f.frame();
        f.state.tray.open = false;
        let _ = f.frame();
    }
    // Banner dismiss + action bar churn.
    f.state.push_user("hi");
    let _ = f.frame();
    f.event(AgentEvent::AgentStart);
    f.event(text_delta_ev("one"));
    f.event(AgentEvent::AgentEnd {
        messages: vec![],
        will_retry: None,
    });
    let _ = f.frame();
    f.event(AgentEvent::AgentStart);
    f.event(text_delta_ev("two"));
    f.event(AgentEvent::AgentEnd {
        messages: vec![],
        will_retry: None,
    });
    let _ = f.frame();
}

// ---------- @ mentions / attachments / queue (RECON §12.3-12.4) ----------

#[test]
fn at_completion_matches_file_index() {
    let mut f = Fixture::at(100, 20);
    f.state.file_index = Some(vec![
        "src/app.rs".into(),
        "src/state.rs".into(),
        "docs/spec.md".into(),
    ]);
    f.state.input.insert_str("check @sr");
    f.state.update_completion();
    let comp = f.state.completion.as_ref().expect("file completion open");
    assert_eq!(comp.kind, pi_fluent_tui::state::CompletionKind::File);
    assert_eq!(comp.items.len(), 2);
    assert_eq!(comp.items[0].name, "src/app.rs");

    // Accept splices the path over the @token, keeping the prefix.
    f.state.accept_completion();
    assert_eq!(f.state.input.text, "check @src/app.rs ");

    // `a@b` (no whitespace before @) does not complete.
    f.state.input.text = "mail a@b".into();
    f.state.input.cursor = 8;
    f.state.update_completion();
    assert!(f.state.completion.is_none());
}

#[test]
fn attachment_selection_and_hint() {
    let mut f = Fixture::at(100, 20);
    for i in 1..=2 {
        f.state.attachments.push(pi_fluent_tui::state::Attachment {
            data: "x".into(),
            mime: "image/png".into(),
            label: format!("image {i}"),
        });
    }
    f.state.attachment_sel = Some(1);
    let hint = pi_fluent_tui::components::input_box::hint_for(
        &f.state.input,
        &f.state.attachments,
        f.state.attachment_sel,
        "",
    );
    assert!(hint.contains("[image 1]"), "chips: {hint}");
    assert!(hint.contains("*[image 2]*"), "selected: {hint}");
}

#[test]
fn queue_update_tracks_queued() {
    let mut f = Fixture::new();
    f.event(AgentEvent::QueueUpdate {
        steering: vec![],
        follow_up: vec!["msg one".into(), "msg two".into()],
    });
    assert_eq!(f.state.queued.len(), 2);
    let text = f.frame();
    assert!(text.contains("2 queued"), "status:\n{text}");
    // Empty update clears.
    f.event(AgentEvent::QueueUpdate {
        steering: vec![],
        follow_up: vec![],
    });
    assert!(f.state.queued.is_empty());
}

#[test]
fn thinking_collapse_tool_tail_table_math() {
    let mut f = Fixture::at(80, 40);
    // Sealed thinking → collapsed.
    f.event(AgentEvent::AgentStart);
    f.event(AgentEvent::MessageUpdate {
        usage: None,
        assistant_message_event: AssistantMessageEvent::ThinkingDelta {
            content_index: 0,
            delta: "Let me think about the table gradient approach first…".into(),
        },
    });
    f.event(AgentEvent::TurnEnd {
        message: pi_rpc::types::AgentMessage::Unknown(serde_json::json!({})),
        tool_results: vec![],
    });
    // Markdown table + math in assistant text.
    f.event(text_delta_ev("Result:\n\n| Name | Value |\n|---|---|\n| alpha | 0.5 |\n| beta | 1.2 |\n\nInline $E=mc^2$ and:\n\n$$\\int_0^1 x^2 dx$$\n"));
    // Running tool with streaming output (tail window).
    f.event(AgentEvent::ToolExecutionStart {
        tool_call_id: "t1".into(),
        tool_name: "bash".into(),
        args: serde_json::json!({"command": "make test"}),
    });
    for i in 1..=12 {
        f.event(AgentEvent::BashExecutionUpdate {
            id: None,
            delta: format!("line {i} of output\n"),
        });
    }
    // Edit tool with synthesized diff.
    f.event(AgentEvent::ToolExecutionStart {
        tool_call_id: "t2".into(),
        tool_name: "edit".into(),
        args: serde_json::json!({"path": "src/app.rs", "old_string": "let x = 1;", "new_string": "let x = 2;"}),
    });
    f.event(AgentEvent::ToolExecutionEnd {
        tool_call_id: "t2".into(),
        tool_name: "edit".into(),
        result: serde_json::json!({"output": "ok"}),
        is_error: false,
    });
    let text = f.frame();
    // Thinking collapsed to a preview after TurnEnd.
    assert!(text.contains("▸ Thinking"), "collapsed thinking:\n{text}");
    // Table rendered as aligned columns.
    assert!(text.contains("│ Name"), "table header:\n{text}");
    assert!(text.contains("├"), "table separator:\n{text}");
    // Math rendered (inline + display).
    assert!(text.contains("E=mc^2"), "inline math:\n{text}");
    assert!(text.contains("int_0^1"), "display math:\n{text}");
    // Running tool: sliding tail window + closed frame.
    assert!(text.contains("… 4 lines above"), "tail window:\n{text}");
    assert!(text.contains("line 12 of output"), "tail last line:\n{text}");
    assert!(!text.contains("line 1 of output"), "head hidden:\n{text}");
    assert!(text.contains("└ Running…"), "running footer:\n{text}");
    // Edit tool: synthesized diff + closed frame.
    assert!(text.contains("✓ Edited src/app.rs"), "edit head:\n{text}");
    assert!(text.contains("-let x = 1;"), "diff delete:\n{text}");
    assert!(text.contains("+let x = 2;"), "diff insert:\n{text}");
    assert!(text.contains("└ Done"), "done footer:\n{text}");
}

#[test]
fn tray_split_preview_renders() {
    let mut f = Fixture::at(100, 26);
    f.event(AgentEvent::AgentStart);
    // Subagent spawn.
    f.event(AgentEvent::ToolExecutionStart {
        tool_call_id: "t1".into(),
        tool_name: "task".into(),
        args: serde_json::json!({"description": "explore auth flow"}),
    });
    // Nested tools while it runs.
    for (i, name) in ["read", "grep", "read"].iter().enumerate() {
        f.event(AgentEvent::ToolExecutionStart {
            tool_call_id: format!("n{i}"),
            tool_name: name.to_string(),
            args: serde_json::json!({"path": "src/auth.rs"}),
        });
    }
    // Partial output for preview.
    f.event(AgentEvent::ToolExecutionUpdate {
        tool_call_id: "t1".into(),
        tool_name: "task".into(),
        args: serde_json::json!({}),
        partial_result: serde_json::json!({"output": "scanning src/auth.rs\nfound 3 call sites\nbuilding report…"}),
    });
    // A background shell too.
    f.event(AgentEvent::ToolExecutionStart {
        tool_call_id: "s1".into(),
        tool_name: "bash".into(),
        args: serde_json::json!({"command": "cargo test", "background": true}),
    });
    f.state.tray.open = true;
    let text = f.frame();
    // Split preview: title, meta, recent tools, output tail.
    assert!(text.contains("explore auth flow"), "entry:\n{text}");
    assert!(text.contains("Recent tools"), "recent label:\n{text}");
    assert!(text.contains("· grep"), "nested tool:\n{text}");
    assert!(text.contains("found 3 call sites"), "output tail:\n{text}");
    assert!(text.contains("Shells (1)"), "shell tab count:\n{text}");
}

#[test]
fn subagent_card_activity_feed() {
    let mut f = Fixture::at(80, 24);
    f.event(AgentEvent::AgentStart);
    f.event(AgentEvent::ToolExecutionStart {
        tool_call_id: "t1".into(),
        tool_name: "task".into(),
        args: serde_json::json!({"description": "explore auth flow"}),
    });
    for (i, (name, path)) in [("read", "src/auth.rs"), ("grep", "\"login\""), ("read", "src/session.rs")].iter().enumerate() {
        f.event(AgentEvent::ToolExecutionStart {
            tool_call_id: format!("n{i}"),
            tool_name: name.to_string(),
            args: serde_json::json!({"path": path.trim_matches('"'), "pattern": path.trim_matches('"')}),
        });
    }
    let text = f.frame();
    // The spawn card carries the nested-tool activity feed.
    assert!(text.contains("● Spawned agent explore auth flow"), "head:\n{text}");
    assert!(text.contains("· read src/auth.rs"), "activity:\n{text}");
    assert!(text.contains("· grep login"), "activity:\n{text}");
    assert!(text.contains("└ Running…"), "footer:\n{text}");
}

#[test]
fn subagent_background_hides_nested_cards() {
    let mut f = Fixture::at(80, 22);
    f.event(AgentEvent::AgentStart);
    // Foreground subagent with nested tools.
    f.event(AgentEvent::ToolExecutionStart {
        tool_call_id: "t1".into(),
        tool_name: "task".into(),
        args: serde_json::json!({"description": "fg agent"}),
    });
    f.event(AgentEvent::ToolExecutionStart {
        tool_call_id: "n1".into(),
        tool_name: "read".into(),
        args: serde_json::json!({"path": "a.rs"}),
    });
    // Background it → nested cards hide (parent card stays).
    f.state.tray.entries[0].foregrounded = false;
    f.state.needs_rebuild = true;
    let text = f.frame();
    assert!(text.contains("Spawned agent fg agent"), "parent:\n{text}");
    assert!(!text.contains("Read a.rs"), "nested hidden:\n{text}");
    // Foreground again → nested cards return.
    f.state.tray.entries[0].foregrounded = true;
    f.state.needs_rebuild = true;
    let text = f.frame();
    assert!(text.contains("Read a.rs"), "nested shown:\n{text}");
}
