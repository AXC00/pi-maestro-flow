//! Repro: after the model picker closes, the input box must return to
//! the bottom of the screen (above the status line).

use blitz_dom::{BaseDocument, DocumentConfig};
use blitz_traits::shell::Viewport;
use scrollback::{PaintContext, Surface, paint_document};
use pi_fluent_tui::app;
use pi_fluent_tui::components::{completion, dialog, input_box, message_list, spinner, status_line};
use pi_fluent_tui::state::AppState;
use pi_fluent_tui::theme::{self, ThemeKind};

const W: u16 = 80;
const H: u16 = 24;

struct Fixture {
    doc: BaseDocument,
    handles: app::DomHandles,
    state: AppState,
}

impl Fixture {
    fn new() -> Self {
        let font_ctx = blitz_dom::build_single_font_ctx(app::TERMINAL_MONO_BYTES);
        let mut doc = BaseDocument::new(DocumentConfig {
            viewport: Some(Viewport::new(W as u32, H as u32, 1.0, ThemeKind::Dark.color_scheme())),
            font_ctx: Some(font_ctx),
            ua_stylesheets: None,
            ..Default::default()
        });
        doc.add_user_agent_stylesheet(&theme::stylesheet(ThemeKind::Dark));
        let handles = app::build_skeleton(&mut doc);
        {
            let mut m = doc.mutate();
            m.set_style_property(handles.app, "width", &format!("{W}px"));
            m.set_style_property(handles.app, "height", &format!("{H}px"));
        }
        Fixture { doc, handles, state: AppState::new() }
    }

    /// One full frame; returns (surface text, input_area y, input_area h).
    fn frame(&mut self) -> (String, f32, f32) {
        {
            let mut m = self.doc.mutate();
            message_list::sync(&mut m, self.handles.messages_inner, &mut self.state);
            let hint = input_box::hint_for(
                &self.state.input,
                &self.state.attachments,
                self.state.attachment_sel,
                input_box::TIPS[self.state.tip_idx],
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
            spinner::sync(&mut m, &self.handles.spinner, self.state.streaming, self.state.tick, "esc", self.state.glyphs);
            dialog::sync(&mut m, self.handles.dialog_area, self.handles.widget_area, &self.state, self.state.glyphs);
            completion::sync(&mut m, self.handles.completion_area, &self.state, self.state.glyphs);
        }
        self.doc.set_viewport(Viewport::new(W as u32, H as u32, 1.0, ThemeKind::Dark.color_scheme()));
        self.doc.resolve(0.0);
        message_list::apply_scroll(&mut self.doc, self.handles.messages, &mut self.state);

        // Find #input-area: it's the parent of the #input-text node.
        let input_text = self.doc.get_node(self.handles.input_text).unwrap();
        let input_box_id = input_text.parent.unwrap();
        let input_area_id = self.doc.get_node(input_box_id).unwrap().parent.unwrap();
        let l = self.doc.get_node(input_area_id).unwrap().final_layout();
        let (y, h) = (l.location.y, l.size.height);

        let mut surface = Surface::new(W, H);
        {
            let mut ctx = PaintContext::new(&self.doc, &mut surface);
            paint_document(&mut ctx);
        }
        (surface.to_text(), y, h)
    }
}

fn resp(command: &str, data: serde_json::Value) -> pi_rpc::RpcResponse {
    serde_json::from_value(serde_json::json!({
        "type": "response", "command": command, "success": true, "data": data
    }))
    .unwrap()
}

#[test]
fn input_returns_to_bottom_after_model_picker() {
    let mut f = Fixture::new();

    // Baseline: input sits near the bottom.
    let (text, y0, h0) = f.frame();
    eprintln!("=== baseline (y={y0} h={h0}) ===\n{text}");
    assert!(y0 > (H as f32) / 2.0, "input should start in lower half, y={y0}");

    // Open the model picker (as /model does).
    let r = resp(
        "get_available_models",
        serde_json::json!({"models": [
            {"id":"m1","name":"One","api":"x","provider":"p","baseUrl":"","reasoning":false,
             "cost":{"input":0,"output":0},"contextWindow":128000,"maxTokens":0},
            {"id":"m2","name":"Two","api":"x","provider":"p","baseUrl":"","reasoning":false,
             "cost":{"input":1,"output":2},"contextWindow":128000,"maxTokens":0}
        ]}),
    );
    f.state.apply_response(&r);
    let (text, y1, h1) = f.frame();
    eprintln!("=== picker open (y={y1} h={h1}) ===\n{text}");
    assert!(text.contains("select model"), "picker open:\n{text}");

    // Pick a model → dialog closes.
    f.state.cancel_dialog();
    let (text, y2, h2) = f.frame();
    eprintln!("=== picker closed (y={y2} h={h2}) ===\n{text}");
    assert!(
        (y2 - y0).abs() < 1.0,
        "input must return to baseline y={y0}, got y={y2}\n{text}"
    );
}
