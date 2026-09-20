//! `tui` — pi-tui binary: pi-rpc (agent kernel) + blitz-dom (DOM/layout)
//! + scrollback (cell renderer), Devin-style event loop.
//!
//! Usage:
//!   tui [--pi <path>] [--theme dark|light] [--headless-dump]
//!
//! `--headless-dump` renders one frame to stdout text (no alt-screen, no
//! pi spawn) — a CI-friendly end-to-end check of DOM → layout → cells.

use std::io;
use std::path::PathBuf;

use pi_rpc::PiRpc;
use pi_fluent_tui::{app, components, state, theme};
use pi_fluent_tui::theme::ThemeKind;

fn main() -> io::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut pi_path: Option<PathBuf> = None;
    let mut theme_kind: Option<ThemeKind> = None;
    let mut headless_dump = false;
    let mut headless_demo = false;
    let mut headless_prompt: Option<String> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--pi" => {
                i += 1;
                pi_path = args.get(i).map(PathBuf::from);
            }
            "--theme" => {
                i += 1;
                theme_kind = match args.get(i).map(String::as_str) {
                    Some("light") => Some(ThemeKind::Light),
                    Some("dark") => Some(ThemeKind::Dark),
                    _ => None,
                };
            }
            "--headless-dump" => headless_dump = true,
            "--headless-demo" => headless_demo = true,
            "--headless-prompt" => {
                i += 1;
                headless_prompt = args.get(i).cloned();
            }
            "-h" | "--help" => {
                eprintln!(
                    "tui — pi-tui\n\
                     usage: tui [--pi <path>] [--theme dark|light] [--headless-dump] [--headless-demo] [--headless-prompt <text>]\n\
                     env: PI_BIN (pi binary path), PI_TUI_THEME (dark|light)"
                );
                return Ok(());
            }
            other => {
                eprintln!("tui: unknown arg {other:?} (see --help)");
                return Err(io::Error::new(io::ErrorKind::InvalidInput, "bad arg"));
            }
        }
        i += 1;
    }

    let theme_kind = theme_kind.unwrap_or_else(theme::detect);

    if headless_dump {
        return headless_dump_frame(theme_kind);
    }
    if headless_demo {
        return headless_demo_frame(theme_kind);
    }

    // Install a panic hook that restores the terminal before the process
    // dies (raw mode + alt-screen would otherwise leak).
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = crossterm::terminal::disable_raw_mode();
        let mut out = io::stdout().lock();
        let _ = crossterm::execute!(
            out,
            crossterm::cursor::Show,
            crossterm::terminal::LeaveAlternateScreen,
        );
        default_hook(info);
    }));

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    rt.block_on(async move {
        let rpc = match PiRpc::spawn(pi_path.as_deref(), pi_rpc::DEFAULT_ARGS).await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("tui: failed to spawn pi: {e}");
                eprintln!("  set PI_BIN or pass --pi <path>");
                return Err(e);
            }
        };
        let mut app = app::App::new(rpc, theme_kind);
        if let Some(prompt) = headless_prompt {
            let text = app.headless_prompt(&prompt, 80, 24).await;
            print!("{text}");
            println!("--- headless prompt done ---");
            return Ok(());
        }
        app.run().await
    })
}

/// Render one frame headless and print the surface as text — verifies the
/// DOM → layout → paint pipeline without a terminal or pi process.
fn headless_dump_frame(kind: ThemeKind) -> io::Result<()> {
    use blitz_dom::{BaseDocument, DocumentConfig};
    use blitz_traits::shell::Viewport;
    use scrollback::{PaintContext, Surface, paint_document};

    let font_ctx = blitz_dom::build_single_font_ctx(app::TERMINAL_MONO_BYTES);
    let mut doc = BaseDocument::new(DocumentConfig {
        viewport: Some(Viewport::new(60, 20, 1.0, kind.color_scheme())),
        font_ctx: Some(font_ctx),
        ua_stylesheets: None,
        ..Default::default()
    });
    doc.add_user_agent_stylesheet(&theme::stylesheet(kind));

    let mut st = state::AppState::new();
    st.status.model = "test-model".into();
    st.status.thinking = "high".into();
    st.push_user("hello pi");
    st.push(state::Message::new(state::MsgKind::Assistant, "hi there — streaming reply"));
    st.input.text = "next prompt".into();
    st.input.cursor = 5;

    let handles = app::build_skeleton(&mut doc);
    {
        let mut m = doc.mutate();
        m.set_style_property(handles.app, "width", "60px");
        m.set_style_property(handles.app, "height", "20px");
        components::message_list::sync(&mut m, handles.messages_inner, &mut st);
        components::input_box::sync(
            &mut m,
            handles.input_hint_text,
            handles.input_text,
            &st.input,
            true,
            "",
        );
        components::status_line::sync(
            &mut m,
            handles.status_left,
            handles.status_right,
            &st.status,
            false,
            st.permission.label(),
            st.queued.len(),
        );
    }
    doc.set_viewport(Viewport::new(60, 20, 1.0, kind.color_scheme()));
    doc.resolve(0.0);
    components::message_list::apply_scroll(&mut doc, handles.messages, &mut st);

    let mut surface = Surface::new(60, 20);
    {
        let mut ctx = PaintContext::new(&doc, &mut surface);
        paint_document(&mut ctx);
    }
    print!("{}", surface.to_text());
    println!("--- headless dump ok ({} markers) ---", surface.markers.len());

    if std::env::var("TUI_DEBUG_LAYOUT").is_ok() {
        dump_layout(&doc, doc.root_node().id, 0);
    }
    Ok(())
}

/// Render a fixture exercising every P4 component (markdown, tool card
/// with diff + truncation, select dialog, toast, widget, spinner, hint
/// bar, permission mode) and print the surface — the headless snapshot
/// for component verification.
fn headless_demo_frame(kind: ThemeKind) -> io::Result<()> {
    use blitz_dom::{BaseDocument, DocumentConfig};
    use blitz_traits::shell::Viewport;
    use scrollback::{PaintContext, Surface, paint_document};
    use pi_fluent_tui::components::{completion, dialog, input_box, message_list, spinner, status_line};
    use pi_fluent_tui::state::{DialogState, PermissionMode, Toast};

    const W: u16 = 72;
    const H: u16 = 30;

    let font_ctx = blitz_dom::build_single_font_ctx(app::TERMINAL_MONO_BYTES);
    let mut doc = BaseDocument::new(DocumentConfig {
        viewport: Some(Viewport::new(W as u32, H as u32, 1.0, kind.color_scheme())),
        font_ctx: Some(font_ctx),
        ua_stylesheets: None,
        ..Default::default()
    });
    doc.add_user_agent_stylesheet(&theme::stylesheet(kind));

    let mut st = state::AppState::new();
    st.status.model = "gpt-5.6-sol".into();
    st.status.thinking = "high".into();
    st.permission = PermissionMode::Smart;
    st.streaming = true;
    st.tick = 7;

    st.push_user("refactor the parser and show a diff");
    st.push(state::Message::new(
        state::MsgKind::Assistant,
        "# Plan\n\n- [x] read the code\n- [ ] patch `parse()`\n\n> note: **bold** and *em* and `code`\n\n```rust\nfn main() {}\n```\n\n| col A | col B |\n|---|---|\n| 1 | 2 |\n\nsee [docs](https://example.com) and ![img](x.png)",
    ));
    let mut tool = state::Message::new(state::MsgKind::Tool, "src/parser.rs");
    tool.tool_name = Some("edit".into());
    tool.tool_status = Some('✓');
    tool.tool_output = Some(
        "diff --git a/src/parser.rs b/src/parser.rs\n--- a/src/parser.rs\n+++ b/src/parser.rs\n@@ -10,3 +10,3 @@\n fn parse() {\n-    let x = old_value;\n+    let x = new_value;\n }"
            .to_string(),
    );
    st.push(tool);
    let mut tool2 = state::Message::new(state::MsgKind::Tool, "cargo test");
    tool2.tool_name = Some("bash".into());
    tool2.tool_status = Some('●');
    tool2.tool_output = Some(
        (1..20)
            .map(|i| format!("test case_{i} ... ok"))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    st.push(tool2);

    st.toasts.push(Toast {
        text: "info: extension loaded".into(),
        ticks_left: 100,
    });
    st.widgets
        .push(("w1".into(), vec!["widget: 3 tasks pending".into()]));
    st.dialog = Some(DialogState::Select {
        id: "demo".into(),
        sel: pi_fluent_tui::components::select::SelectState::new(
            "Pick a model",
            vec![
                "gpt-5.6-sol".to_string(),
                "gpt-6-astra".to_string(),
                "kimi-for-coding".to_string(),
            ],
        ),
    });
    st.input.text = "next prompt".into();
    st.input.cursor = 5;

    let handles = app::build_skeleton(&mut doc);
    {
        let mut m = doc.mutate();
        m.set_style_property(handles.app, "width", &format!("{W}px"));
        m.set_style_property(handles.app, "height", &format!("{H}px"));
        message_list::sync(&mut m, handles.messages_inner, &mut st);
        input_box::sync(&mut m, handles.input_hint_text, handles.input_text, &st.input, false, "");
        status_line::sync(
            &mut m,
            handles.status_left,
            handles.status_right,
            &st.status,
            st.streaming,
            st.permission.label(),
            st.queued.len(),
        );
        spinner::sync(&mut m, &handles.spinner, true, st.tick, "esc to interrupt", st.glyphs);
        dialog::sync(&mut m, handles.dialog_area, handles.widget_area, &st, st.glyphs);
        completion::sync(&mut m, handles.completion_area, &st, st.glyphs);
    }
    doc.set_viewport(Viewport::new(W as u32, H as u32, 1.0, kind.color_scheme()));
    doc.resolve(0.0);
    message_list::apply_scroll(&mut doc, handles.messages, &mut st);

    let mut surface = Surface::new(W, H);
    {
        let mut ctx = PaintContext::new(&doc, &mut surface);
        paint_document(&mut ctx);
        eprintln!(
            "[demo] hit regions: {:?}",
            ctx.hit_regions
                .iter()
                .map(|r| (r.kind.as_str(), r.payload.as_deref().unwrap_or(""), r.rect))
                .collect::<Vec<_>>()
        );
    }
    print!("{}", surface.to_text());
    println!("--- headless demo ok ---");
    Ok(())
}

fn dump_layout(doc: &blitz_dom::BaseDocument, id: blitz_dom::NodeId, depth: usize) {
    let Some(node) = doc.get_node(id) else { return };
    let has_layout = !matches!(
        node.data,
        blitz_dom::NodeData::Text(_) | blitz_dom::NodeData::Comment { .. }
    );
    let tag = node
        .element_data()
        .map(|e| e.name.local.to_string())
        .unwrap_or_else(|| format!("{:?}", std::mem::discriminant(&node.data)));
    if has_layout {
        let l = node.final_layout();
        let bstyle = node
            .primary_styles()
            .map(|s| format!("{:?}", s.get_border().border_left_style))
            .unwrap_or_default();
        eprintln!(
            "{}{} <{}> x={:.0} y={:.0} w={:.0} h={:.0} border[l={:.0} t={:.0} r={:.0} b={:.0}] pad[l={:.0}] bls={}",
            "  ".repeat(depth),
            format!("{:?}", id),
            tag,
            l.location.x, l.location.y, l.size.width, l.size.height,
            l.border.left, l.border.top, l.border.right, l.border.bottom,
            l.padding.left,
            bstyle,
        );
    }
    for &c in node.children.iter() {
        dump_layout(doc, c, depth + 1);
    }
}
