//! `app` — the Devin-style event loop (`App::run` / `render_frame`).
//!
//! ```text
//! loop {
//!   tokio::select! { rpc_event, terminal input (crossterm), tick }
//!     → update AppState → patch DOM (DocumentMutator)
//!   render_frame:
//!     terminal::size → set_viewport → resolve() → apply_scroll
//!     → scrollback::paint_document → Renderer::draw → stdout ANSI
//! }
//! ```
//!
//! Resize is implicit (size cached from crossterm Resize events; the
//! `Renderer` forces a full redraw on size change). Frames are wrapped in
//! synchronized-output markers `?2026h`/`?2026l`; alt-screen `?1049h`/`?1049l`
//! brackets the run.

use std::io::{self, Write};
use std::sync::Arc;
use std::time::{Duration, Instant};

use blitz_dom::{BaseDocument, DocumentConfig};
use blitz_traits::shell::Viewport;
use crossterm::event::{
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
    Event as TermEvent, EventStream as TermEventStream, KeyCode, KeyEvent, KeyEventKind,
    KeyModifiers, MouseEventKind,
};
use crossterm::{execute, terminal};
use futures_util::StreamExt;
use pi_rpc::{AgentEvent, PiRpc, RpcCommand, RpcEvent, RpcResponse};
use scrollback::{Frame, PaintContext, Renderer, Surface, ansi, paint_document};
use tokio::sync::mpsc;

use crate::commands::{self, Command, LocalCmd};
use crate::components::{completion, dialog, input_box, message_list, select, spinner, status_line};
use crate::state::{AppState, DialogState, LocalAction, MsgKind, ResponseEffect, agent_message_text};
use crate::theme::{self, Theme, ThemeKind};

/// Embedded TerminalMono metrics font (advance == upm → 1px = 1 cell).
pub const TERMINAL_MONO_BYTES: &[u8] = include_bytes!("../assets/TerminalMono.ttf");

/// Frame tick rate (also the max streaming repaint cadence).
const TICK: Duration = Duration::from_millis(33);

/// DOM node ids the app keeps for incremental updates.
pub struct DomHandles {
    #[allow(dead_code)]
    pub root: blitz_dom::NodeId,
    pub app: blitz_dom::NodeId,
    pub messages: blitz_dom::NodeId,
    pub messages_inner: blitz_dom::NodeId,
    pub spinner: spinner::SpinnerHandles,
    pub dialog_area: blitz_dom::NodeId,
    pub widget_area: blitz_dom::NodeId,
    pub input_hint_text: blitz_dom::NodeId,
    pub input_text: blitz_dom::NodeId,
    /// In-flow completion list below the input (native pi style).
    pub completion_area: blitz_dom::NodeId,
    pub status_left: blitz_dom::NodeId,
    pub status_right: blitz_dom::NodeId,
}

/// The TUI application.
pub struct App {
    rpc: Arc<PiRpc>,
    doc: BaseDocument,
    handles: DomHandles,
    state: AppState,
    renderer: Renderer,
    theme: Theme,
    theme_kind: ThemeKind,
    /// Height of the `#messages` viewport from the last frame (for
    /// PageUp/PageDown scroll math).
    messages_view_h: u32,
    /// Outbound command results / async notices.
    notice_rx: mpsc::UnboundedReceiver<String>,
    notice_tx: mpsc::UnboundedSender<String>,
    /// Full `RpcResponse`s from `send_report` (slash-command dispatch).
    cmd_rx: mpsc::UnboundedReceiver<RpcResponse>,
    cmd_tx: mpsc::UnboundedSender<RpcResponse>,
    /// `data-hit-*` regions recorded by the last paint (mouse routing).
    hit_regions: Vec<scrollback::HitRegion>,
    /// Last Esc press — a second Esc within `ESC_INTERRUPT_WINDOW`
    /// while streaming sends `abort` (Devin: "esc twice to interrupt").
    last_esc: Option<Instant>,
    /// Cached terminal size — `terminal::size()` is an ioctl; only
    /// re-read on crossterm Resize events.
    term_size: (u16, u16),
    /// Last viewport pushed to the doc — `set_viewport` rebuilds the
    /// stylo Device + re-evaluates media queries, so skip when same.
    last_viewport: (u16, u16),
    /// Signatures of the per-frame component syncs — skip rebuilds
    /// when their inputs haven't changed.
    dialog_sig: u64,
    completion_sig: u64,
    /// Signatures of the text-mutating syncs — decide whether
    /// `doc.resolve` is needed at all this frame.
    input_sig: u64,
    spinner_sig: u64,
    status_sig: u64,
    /// Reusable surface buffer (double-buffered with the renderer's
    /// previous frame).
    surface_spare: Option<Surface>,
}

/// Double-Esc interrupt window.
const ESC_INTERRUPT_WINDOW: Duration = Duration::from_millis(800);

impl App {
    /// Build the app: document, DOM skeleton, renderer, RPC handle.
    pub fn new(rpc: PiRpc, theme_kind: ThemeKind) -> Self {
        let font_ctx = blitz_dom::build_single_font_ctx(TERMINAL_MONO_BYTES);
        let (w, h) = terminal::size().unwrap_or((80, 24));
        let mut doc = BaseDocument::new(DocumentConfig {
            viewport: Some(Viewport::new(
                w as u32,
                h as u32,
                1.0,
                theme_kind.color_scheme(),
            )),
            font_ctx: Some(font_ctx),
            // `None` keeps blitz's DEFAULT_CSS; our sheet is added on top.
            ua_stylesheets: None,
            ..Default::default()
        });
        doc.add_user_agent_stylesheet(&theme::stylesheet(theme_kind));

        let handles = build_skeleton(&mut doc);

        let (notice_tx, notice_rx) = mpsc::unbounded_channel();
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();

        App {
            rpc: Arc::new(rpc),
            doc,
            handles,
            state: AppState::new(),
            renderer: Renderer::new(),
            theme: Theme::new(theme_kind),
            theme_kind,
            messages_view_h: 0,
            notice_rx,
            notice_tx,
            cmd_rx,
            cmd_tx,
            hit_regions: Vec::new(),
            last_esc: None,
            term_size: (w, h),
            last_viewport: (0, 0),
            dialog_sig: u64::MAX,
            completion_sig: u64::MAX,
            input_sig: u64::MAX,
            spinner_sig: u64::MAX,
            status_sig: u64::MAX,
            surface_spare: None,
        }
    }

    /// Signature of the input-line inputs (text/cursor/hint/dialog).
    fn input_signature(state: &AppState, hint: &str) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut s = std::collections::hash_map::DefaultHasher::new();
        state.input.text.hash(&mut s);
        state.input.cursor.hash(&mut s);
        hint.hash(&mut s);
        state.dialog.is_some().hash(&mut s);
        s.finish()
    }

    /// Signature of the spinner inputs (active/frame/dots/hint).
    fn spinner_signature(state: &AppState) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut s = std::collections::hash_map::DefaultHasher::new();
        state.streaming.hash(&mut s);
        state.tick.hash(&mut s);
        s.finish()
    }

    /// Signature of the status-line inputs.
    fn status_signature(state: &AppState) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut s = std::collections::hash_map::DefaultHasher::new();
        state.status.model.hash(&mut s);
        state.status.thinking.hash(&mut s);
        state.status.mode.hash(&mut s);
        state.status.transient.hash(&mut s);
        state.status.input_tokens.hash(&mut s);
        state.status.output_tokens.hash(&mut s);
        state.streaming.hash(&mut s);
        state.permission.label().hash(&mut s);
        state.queued.len().hash(&mut s);
        s.finish()
    }

    /// Detect the terminal's ANSI color level and publish it on the
    /// renderer's shared cell.
    fn detect_level(&mut self) {
        let level = if std::env::var("NO_COLOR").is_ok() {
            scrollback::Level::NONE
        } else {
            match std::env::var("COLORTERM").ok().as_deref() {
                Some("truecolor") | Some("24bit") => scrollback::Level::TRUECOLOR,
                _ => match std::env::var("TERM").ok().as_deref() {
                    Some(t) if t.contains("256color") => scrollback::Level::ANSI256,
                    Some("dumb") => scrollback::Level::NONE,
                    _ => scrollback::Level::TRUECOLOR,
                },
            }
        };
        let _ = self.renderer.level.set(level);
    }

    /// Run the event loop until quit / child exit. Restores the terminal
    /// on the way out.
    pub async fn run(&mut self) -> io::Result<()> {
        self.detect_level();
        terminal_setup_enter()?;

        let result = self.run_inner().await;

        terminal_setup_leave()?;
        result
    }

    async fn run_inner(&mut self) -> io::Result<()> {
        let mut events = self.rpc.events();
        let mut term_events = TermEventStream::new();
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        // Initial session state → status line.
        self.bootstrap_state().await;
        // Background command list for `/` completion (quiet — no
        // system lines; `/help` prints the stored list instead).
        self.state.commands_quiet = true;
        self.send_report(RpcCommand::GetCommands);

        // First paint.
        self.render_frame()?;

        loop {
            let mut frame_dirty = false;

            tokio::select! {
                // RPC event from the pi child.
                maybe_event = events.next() => {
                    match maybe_event {
                        Some(ev) => {
                            frame_dirty = self.handle_rpc_event(ev);
                        }
                        None => {
                            // Event stream closed → child exited.
                            self.state.push_system("pi process exited");
                            self.state.quit = true;
                            frame_dirty = true;
                        }
                    }
                }
                // Terminal input.
                maybe_term = term_events.next() => {
                    match maybe_term {
                        Some(Ok(ev)) => {
                            frame_dirty = self.handle_term_event(ev);
                        }
                        Some(Err(_)) | None => {
                            self.state.quit = true;
                        }
                    }
                }
                // Async notices (send failures, etc).
                Some(note) = self.notice_rx.recv() => {
                    self.state.push_system(note);
                    frame_dirty = true;
                }
                // Slash-command responses (send_report).
                Some(resp) = self.cmd_rx.recv() => {
                    frame_dirty = self.handle_cmd_response(resp);
                }
                // Frame tick — repaint only when something changed.
                _ = tick.tick() => {
                    if self.state.tick_frame() {
                        frame_dirty = true;
                    }
                }
            }

            if self.state.quit {
                break;
            }
            if frame_dirty || self.state.dom_dirty {
                self.render_frame()?;
            }
        }
        Ok(())
    }

    /// Headless end-to-end check: send `prompt`, pump the event loop until
    /// `agent_end`, then return the final painted surface as text.
    /// Used by `--headless-prompt` (no terminal, no alt-screen).
    pub async fn headless_prompt(&mut self, prompt: &str, w: u16, h: u16) -> String {
        use futures_util::StreamExt;
        let mut events = self.rpc.events();
        self.state.push_user(prompt);
        let cmd = RpcCommand::Prompt {
            message: prompt.to_string(),
            images: None,
            streaming_behavior: None,
        };
        let _ = self.rpc.send(&cmd).await;
        // Pump events until the run ends (or a generous timeout).
        let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        loop {
            let next = tokio::time::timeout_at(deadline, events.next()).await;
            match next {
                Ok(Some(ev)) => {
                    if std::env::var("TUI_DEBUG_EVENTS").is_ok() {
                        let s = format!("{ev:?}");
                        eprintln!("[ev] {}", &s[..s.len().min(200)]);
                    }
                    self.state.apply_event(&ev);
                    // Headless mode can't show dialogs — auto-cancel any
                    // interactive request so the agent never blocks.
                    if self.state.dialog.is_some() {
                        self.state.cancel_dialog();
                        self.flush_dialog_result();
                    }
                    if self.state.dom_dirty {
                        let _ = self.paint_frame_at(w, h);
                    }
                    if matches!(
                        ev.as_agent(),
                        Some(AgentEvent::AgentEnd { .. } | AgentEvent::AgentSettled)
                    ) {
                        break;
                    }
                }
                Ok(None) => {
                    eprintln!("[ev] stream closed (child exited)");
                    break;
                }
                Err(_) => {
                    eprintln!("[ev] timeout waiting for agent_end");
                    break;
                }
            }
        }
        self.paint_frame_at(w, h).to_text()
    }

    /// Pull `get_state` for the status line.
    async fn bootstrap_state(&mut self) {
        match self.rpc.send(&RpcCommand::GetState).await {
            Ok(resp) => {
                if let Some(s) = resp.session_state() {
                    if let Some(m) = s.model {
                        self.state.status.model = m.id;
                    }
                    self.state.status.thinking =
                        format!("{:?}", s.thinking_level).to_lowercase();
                    self.state.status.mode = format!("{:?}", s.steering_mode).to_lowercase();
                    self.state.streaming = s.is_streaming;
                }
            }
            Err(e) => {
                self.state.push_system(format!("get_state failed: {e}"));
            }
        }
    }

    /// Reduce one RPC event; returns whether a repaint is needed.
    fn handle_rpc_event(&mut self, ev: RpcEvent) -> bool {
        // Dedup: a locally-echoed user message may arrive as
        // message_start. Check the last few messages — a tool/system
        // line may have landed between the echo and the event.
        if let RpcEvent::Agent(AgentEvent::MessageStart { message }) = &ev {
            if let Some((MsgKind::User, text)) = agent_message_text(message) {
                if self
                    .state
                    .messages
                    .iter()
                    .rev()
                    .take(8)
                    .any(|m| m.kind == MsgKind::User && m.text == text)
                {
                    return false;
                }
            }
        }
        let dirty = self.state.apply_event(&ev);
        // Flush any dialog response queued by the reducer (e.g. a queued
        // request promoted after a resolve).
        self.flush_dialog_result();
        dirty
    }

    /// Send a queued `extension_ui_response` to pi (fire-and-forget).
    fn flush_dialog_result(&mut self) {
        if let Some(resp) = self.state.dialog_result.take() {
            let rpc = Arc::clone(&self.rpc);
            let tx = self.notice_tx.clone();
            tokio::spawn(async move {
                if let Err(e) = rpc.respond_ui(&resp).await {
                    let _ = tx.send(format!("respond_ui failed: {e}"));
                }
            });
        }
    }

    /// Forward one UI event to the plugin that owns overlay request `id`.
    fn send_ui_event(&self, id: &str, event: pi_rpc::UiEvent) {
        let line = pi_rpc::RpcExtensionUIEvent {
            id: id.to_string(),
            event,
        }
        .to_wire_value()
        .to_string();
        let rpc = Arc::clone(&self.rpc);
        let tx = self.notice_tx.clone();
        tokio::spawn(async move {
            if let Err(e) = rpc.send_raw(&line).await {
                let _ = tx.send(format!("ui event failed: {e}"));
            }
        });
    }

    /// Reduce one terminal event; returns whether a repaint is needed.
    fn handle_term_event(&mut self, ev: TermEvent) -> bool {
        let dirty = match ev {
            TermEvent::Key(key) => self.handle_key(key),
            TermEvent::Paste(s) => {
                let s = s.replace("\r\n", "\n").replace('\r', "\n");
                match &mut self.state.dialog {
                    Some(DialogState::Input { input, .. })
                    | Some(DialogState::Editor { input, .. }) => input.insert_str(&s),
                    _ => self.state.input.insert_str(&s),
                }
                true
            }
            TermEvent::Mouse(m) => self.handle_mouse(m),
            TermEvent::Resize(w, h) => {
                self.term_size = (w, h);
                // Plugin-driven overlays re-render at the new budget.
                if let Some(DialogState::Plugin {
                    id,
                    driver: pi_rpc::OverlayDriver::Plugin,
                    ..
                }) = &self.state.dialog
                {
                    let id = id.clone();
                    self.send_ui_event(&id, pi_rpc::UiEvent::Resize {
                        w: u32::from(w),
                        h: u32::from(h),
                    });
                }
                true
            }
            _ => false,
        };
        // A dialog key/click may have queued a response.
        self.flush_dialog_result();
        dirty
    }

    /// Route a mouse event through the painted `data-hit-*` regions.
    fn handle_mouse(&mut self, m: crossterm::event::MouseEvent) -> bool {
        let (col, row) = (m.column as i32, m.row as i32);
        let hit = self
            .hit_regions
            .iter()
            .rev() // topmost (last painted) wins
            .find(|r| {
                col >= r.rect.x
                    && col < r.rect.x + r.rect.w
                    && row >= r.rect.y
                    && row < r.rect.y + r.rect.h
            })
            .cloned();
        match m.kind {
            MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
                let up = m.kind == MouseEventKind::ScrollUp;
                match hit.as_ref().map(|r| r.kind.as_str()) {
                    // Wheel over the select dropdown moves its cursor.
                    Some("idx") | Some("option") => {
                        let sel = match &mut self.state.dialog {
                            Some(DialogState::Select { sel, .. })
                            | Some(DialogState::Local { sel, .. }) => Some(sel),
                            _ => None,
                        };
                        if let Some(sel) = sel {
                            if up {
                                sel.move_up();
                            } else {
                                sel.move_down();
                            }
                            self.state.dom_dirty = true;
                        }
                        true
                    }
                    _ => {
                        self.scroll_messages(if up { -3 } else { 3 });
                        true
                    }
                }
            }
            MouseEventKind::Down(crossterm::event::MouseButton::Left) => {
                let Some(hit) = hit else { return false };
                match hit.kind.as_str() {
                    // Select option: click moves the cursor; clicking the
                    // already-selected row submits it. With no dialog,
                    // `idx` rows belong to the `/` completion popup.
                    "idx" => {
                        let i = hit
                            .payload
                            .as_deref()
                            .unwrap_or("")
                            .parse::<usize>()
                            .ok();
                        if self.state.dialog.is_none() && self.state.completion.is_some() {
                            if let Some(i) = i {
                                if let Some(c) = &mut self.state.completion {
                                    c.cursor = i.min(c.items.len() - 1);
                                }
                                self.state.accept_completion();
                            }
                            return true;
                        }
                        match &mut self.state.dialog {
                            Some(DialogState::Select { id, sel }) => {
                                if let Some(i) = i {
                                    let was = sel.cursor;
                                    sel.click(i);
                                    if sel.cursor == was {
                                        if let Some(value) = sel.selected_label() {
                                            let id = id.clone();
                                            self.state.resolve_dialog(
                                                pi_rpc::RpcExtensionUIResponse::Value { id, value },
                                            );
                                        }
                                    }
                                }
                                self.state.dom_dirty = true;
                            }
                            Some(DialogState::Local { sel, action }) => {
                                if let Some(i) = i {
                                    let was = sel.cursor;
                                    sel.click(i);
                                    if sel.cursor == was {
                                        // Clicked the already-selected row → submit.
                                        let action = *action;
                                        if let Some(idx) = sel.selected() {
                                            self.state.dialog = None;
                                            self.dispatch_local_select(action, idx);
                                        }
                                    }
                                }
                                self.state.dom_dirty = true;
                            }
                            _ => {}
                        }
                        true
                    }
                    // Confirm buttons: yes / no / cancel.
                    "confirm" => {
                        let id = self
                            .state
                            .dialog
                            .as_ref()
                            .map(|d| d.id().to_string())
                            .unwrap_or_default();
                        match hit.payload.as_deref() {
                            Some("yes") => self.state.resolve_dialog(
                                pi_rpc::RpcExtensionUIResponse::Confirmed {
                                    id,
                                    confirmed: true,
                                },
                            ),
                            Some("no") => self.state.resolve_dialog(
                                pi_rpc::RpcExtensionUIResponse::Confirmed {
                                    id,
                                    confirmed: false,
                                },
                            ),
                            _ => self.state.cancel_dialog(),
                        }
                        true
                    }
                    // Truncation marker: expand/collapse that tool card.
                    "expand" => {
                        self.state.toggle_tool_by_node(hit.node);
                        true
                    }
                    // Message action bar: feedback / copy.
                    "action" => {
                        match hit.payload.as_deref() {
                            Some("copy") => {
                                self.send_report(RpcCommand::GetLastAssistantText);
                            }
                            Some("up") => {
                                self.state.push_system("feedback: 👍");
                            }
                            Some("down") => {
                                self.state.push_system("feedback: 👎");
                            }
                            _ => {}
                        }
                        true
                    }
                    // Tray row click: move the cursor to that row.
                    "tray" => {
                        if let Some(row) =
                            hit.payload.as_deref().and_then(|p| p.parse().ok())
                        {
                            if row < self.state.tray.visible().len() {
                                self.state.tray.cursor = row;
                                self.state.dom_dirty = true;
                            }
                        }
                        true
                    }
                    // Link: open in the system browser.
                    "link" => {
                        if let Some(url) = &hit.payload {
                            open_url(url);
                        }
                        true
                    }
                    _ => false,
                }
            }
            _ => false,
        }
    }

    fn handle_key(&mut self, key: KeyEvent) -> bool {
        // Only act on presses (Windows emits release events too).
        if key.kind == KeyEventKind::Release {
            return false;
        }
        // Dialogs capture all keys while active.
        if self.state.dialog.is_some() {
            return self.handle_dialog_key(key);
        }
        // The tray panel captures keys while open (F2 toggles).
        if self.state.tray.open {
            return self.handle_tray_key(key);
        }
        // Attachment selection context (RECON §12.4: left/right/exit).
        // Once a chip is selected these keys edit the selection until
        // Esc/any other key exits back to the editor.
        if let Some(sel) = self.state.attachment_sel {
            let n = self.state.attachments.len();
            match key.code {
                KeyCode::Left => {
                    self.state.attachment_sel = Some(sel.saturating_sub(1));
                    self.state.dom_dirty = true;
                    return true;
                }
                KeyCode::Right => {
                    self.state.attachment_sel = Some((sel + 1).min(n - 1));
                    self.state.dom_dirty = true;
                    return true;
                }
                KeyCode::Backspace | KeyCode::Delete => {
                    self.state.attachments.remove(sel.min(n - 1));
                    self.state.attachment_sel = None;
                    self.state.dom_dirty = true;
                    return true;
                }
                KeyCode::Esc => {
                    self.state.attachment_sel = None;
                    self.state.dom_dirty = true;
                    return true;
                }
                _ => {
                    // Any other key exits selection, then falls through.
                    self.state.attachment_sel = None;
                }
            }
        }
        // `/`/`@` completion popup: recompute from the input as of the
        // previous key, then let it shadow nav/accept keys.
        if self.state.file_index.is_none()
            && self.state.input.text[..self.state.input.cursor].contains('@')
        {
            self.state.file_index = Some(build_file_index(&self.state));
        }
        self.state.update_completion();
        if self.state.completion.is_some() {
            match key.code {
                KeyCode::Up => {
                    if let Some(c) = &mut self.state.completion {
                        c.prev();
                    }
                    self.state.dom_dirty = true;
                    return true;
                }
                KeyCode::Down => {
                    if let Some(c) = &mut self.state.completion {
                        c.next();
                    }
                    self.state.dom_dirty = true;
                    return true;
                }
                // Native pi: tab/shift+tab cycle, enter accepts.
                KeyCode::Tab if key.modifiers.contains(KeyModifiers::SHIFT) => {
                    if let Some(c) = &mut self.state.completion {
                        c.prev();
                    }
                    self.state.dom_dirty = true;
                    return true;
                }
                KeyCode::BackTab => {
                    if let Some(c) = &mut self.state.completion {
                        c.prev();
                    }
                    self.state.dom_dirty = true;
                    return true;
                }
                KeyCode::Tab => {
                    if let Some(c) = &mut self.state.completion {
                        c.next();
                    }
                    self.state.dom_dirty = true;
                    return true;
                }
                KeyCode::Enter => {
                    self.state.accept_completion();
                    return true;
                }
                KeyCode::Esc => {
                    self.state.completion = None;
                    self.state.dom_dirty = true;
                    return true;
                }
                _ => {}
            }
        }
        // Any non-Esc key breaks the esc-twice interrupt window.
        if key.code != KeyCode::Esc {
            self.last_esc = None;
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        let shift = key.modifiers.contains(KeyModifiers::SHIFT);
        // F2: open the subagent tray (backgrounds the foreground view).
        if key.code == KeyCode::F(2) {
            self.state.tray.open = true;
            self.state.dom_dirty = true;
            return true;
        }
        // Alt (Meta) bindings — the Emacs word ops.
        if alt {
            match key.code {
                KeyCode::Char('b') | KeyCode::Char('B') => {
                    self.state.input.move_word_left();
                    return true;
                }
                KeyCode::Char('f') | KeyCode::Char('F') => {
                    self.state.input.move_word_right();
                    return true;
                }
                KeyCode::Char('d') | KeyCode::Char('D') => {
                    self.state.input.kill_word();
                    return true;
                }
                KeyCode::Char('u') | KeyCode::Char('U') => {
                    self.state.input.case_word(crate::state::WordCase::Upper);
                    return true;
                }
                KeyCode::Char('l') | KeyCode::Char('L') => {
                    self.state.input.case_word(crate::state::WordCase::Lower);
                    return true;
                }
                KeyCode::Char('c') | KeyCode::Char('C') => {
                    self.state
                        .input
                        .case_word(crate::state::WordCase::Capitalize);
                    return true;
                }
                KeyCode::Char('t') | KeyCode::Char('T') => {
                    self.state.input.transpose_words();
                    return true;
                }
                KeyCode::Backspace => {
                    self.state.input.backward_kill_word();
                    return true;
                }
                // Unknown Alt+Char still inserts (macOS Option typing).
                KeyCode::Char(c) => {
                    self.state.input.insert_char(c);
                    return true;
                }
                _ => return false,
            }
        }
        match (key.code, ctrl, shift) {
            (KeyCode::Char('c'), true, _) => {
                if self.state.streaming {
                    self.send_cmd(RpcCommand::Abort);
                } else {
                    self.state.quit = true;
                }
                true
            }
            // Shift+Tab: cycle permission modes.
            (KeyCode::BackTab, _, _) => {
                self.state.permission = self.state.permission.next();
                self.state.dom_dirty = true;
                true
            }
            // Ctrl+B: run the input as a background bash command.
            (KeyCode::Char('b'), true, _) => {
                let cmd = self.state.input.take_submitted();
                if cmd.trim().is_empty() {
                    self.state
                        .push_system("Ctrl+B: type a command first (runs it in background)");
                } else {
                    self.state
                        .push_system(format!("background: {cmd}"));
                    self.send_cmd(RpcCommand::Bash {
                        command: cmd,
                        exclude_from_context: None,
                    });
                }
                true
            }
            // Ctrl+O: expand/collapse the latest tool card.
            (KeyCode::Char('o'), true, _) => {
                self.state.toggle_last_tool();
                true
            }
            // Ctrl+G: open the input in $EDITOR (RECON §12.4
            // open_external_editor).
            (KeyCode::Char('g'), true, _) => {
                self.open_external_editor();
                true
            }
            // Ctrl+V: paste clipboard — image → attachment, else text
            // (RECON §12.3 "ctrl+v to paste image in clipboard").
            (KeyCode::Char('v'), true, _) => {
                self.paste_clipboard();
                true
            }
            // Ctrl+P: cycle model (pi keybinding: cycle model forward).
            (KeyCode::Char('p'), true, _) => {
                self.send_report(RpcCommand::CycleModel);
                true
            }
            // Ctrl+D: quit when the input is empty (pi: exit on empty),
            // otherwise delete-char (Emacs).
            (KeyCode::Char('d'), true, _) => {
                if self.state.input.text.is_empty() {
                    self.state.quit = true;
                } else {
                    self.state.input.delete();
                }
                true
            }
            // Ctrl+L: clear the message list; Ctrl+Shift+L: full redraw.
            (KeyCode::Char('l'), true, true) => {
                self.renderer.needs_full_redraw = true;
                true
            }
            (KeyCode::Char('l'), true, false) => {
                self.state.clear_messages();
                self.renderer.needs_full_redraw = true;
                true
            }
            // Esc twice to interrupt (Devin). First Esc while streaming
            // only arms the window; non-streaming Esc clears the input.
            (KeyCode::Esc, _, _) => {
                if self.state.streaming {
                    let armed = self
                        .last_esc
                        .is_some_and(|t| t.elapsed() < ESC_INTERRUPT_WINDOW);
                    if armed {
                        self.last_esc = None;
                        self.send_cmd(RpcCommand::Abort);
                    } else {
                        self.last_esc = Some(Instant::now());
                        self.state.push_system("esc again to interrupt");
                    }
                } else if !self.state.input.text.is_empty() {
                    self.state.input.text.clear();
                    self.state.input.cursor = 0;
                }
                true
            }
            (KeyCode::Enter, false, _) => {
                self.submit_input();
                true
            }
            (KeyCode::Char('j'), true, _) | (KeyCode::Enter, true, _) => {
                self.state.input.insert_char('\n');
                true
            }
            // Emacs editing ops (editor context).
            (KeyCode::Char('a'), true, _) => {
                self.state.input.move_home();
                true
            }
            (KeyCode::Char('e'), true, _) => {
                self.state.input.move_end();
                true
            }
            (KeyCode::Char('f'), true, _) => {
                self.state.input.move_right();
                true
            }
            (KeyCode::Char('h'), true, _) => {
                self.state.input.backspace();
                true
            }
            (KeyCode::Char('k'), true, _) => {
                self.state.input.kill_line();
                true
            }
            (KeyCode::Char('u'), true, _) => {
                self.state.input.backward_kill_line();
                true
            }
            (KeyCode::Char('w'), true, _) => {
                self.state.input.unix_word_rubout();
                true
            }
            (KeyCode::Char('y'), true, _) => {
                self.state.input.yank();
                true
            }
            (KeyCode::Char('t'), true, _) => {
                self.state.input.transpose_chars();
                true
            }
            // Ctrl+R: reverse history search (previous entry containing
            // the in-progress text).
            (KeyCode::Char('r'), true, _) => {
                self.state.input.history_search();
                true
            }
            (KeyCode::Backspace, true, _) => {
                self.state.input.backward_kill_word();
                true
            }
            (KeyCode::Backspace, _, _) => {
                self.state.input.backspace();
                true
            }
            (KeyCode::Delete, _, _) => {
                self.state.input.delete();
                true
            }
            (KeyCode::Left, true, _) => {
                self.state.input.move_word_left();
                true
            }
            (KeyCode::Left, _, _) => {
                self.state.input.move_left();
                true
            }
            (KeyCode::Right, true, _) => {
                self.state.input.move_word_right();
                true
            }
            (KeyCode::Right, _, _) => {
                self.state.input.move_right();
                true
            }
            (KeyCode::Home, _, _) => {
                self.state.input.move_home();
                true
            }
            (KeyCode::End, _, _) => {
                self.state.input.move_end();
                true
            }
            // Up/Down: move between input lines; on the first/last line
            // fall back to prompt history.
            (KeyCode::Up, _, _) => {
                if !self.state.input.prev_line() {
                    self.state.input.history_up();
                }
                true
            }
            (KeyCode::Down, _, _) => {
                if !self.state.input.next_line() {
                    self.state.input.history_down();
                }
                true
            }
            (KeyCode::PageUp, _, _) => {
                let page = self.messages_view_h.max(1) as i32;
                self.scroll_messages(-page);
                true
            }
            (KeyCode::PageDown, _, _) => {
                let page = self.messages_view_h.max(1) as i32;
                self.scroll_messages(page);
                true
            }
            (KeyCode::Char(c), false, _) => {
                self.state.input.insert_char(c);
                true
            }
            _ => false,
        }
    }

    /// Key handling while an extension-UI dialog is active.
    fn handle_dialog_key(&mut self, key: KeyEvent) -> bool {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let code = key.code;
        match &mut self.state.dialog {
            Some(DialogState::Select { id, sel }) => match (code, ctrl) {
                (KeyCode::Esc, _) => {
                    let id = id.clone();
                    self.state.resolve_dialog(
                        pi_rpc::RpcExtensionUIResponse::Cancelled {
                            id,
                            cancelled: true,
                        },
                    );
                }
                (KeyCode::Up, _) => sel.move_up(),
                (KeyCode::Down, _) => sel.move_down(),
                (KeyCode::PageUp, _) => {
                    for _ in 0..select::MAX_VISIBLE {
                        sel.move_up();
                    }
                }
                (KeyCode::PageDown, _) => {
                    for _ in 0..select::MAX_VISIBLE {
                        sel.move_down();
                    }
                }
                (KeyCode::Enter, _) => {
                    if let Some(value) = sel.selected_label() {
                        let id = id.clone();
                        self.state.resolve_dialog(
                            pi_rpc::RpcExtensionUIResponse::Value { id, value },
                        );
                    }
                }
                (KeyCode::Backspace, _) => sel.pop_filter(),
                (KeyCode::Char(c), false) => sel.push_filter(c),
                _ => {}
            },
            Some(DialogState::Confirm { id, .. }) => {
                let id = id.clone();
                match code {
                    KeyCode::Char('y') | KeyCode::Char('Y') | KeyCode::Enter => {
                        self.state.resolve_dialog(
                            pi_rpc::RpcExtensionUIResponse::Confirmed {
                                id,
                                confirmed: true,
                            },
                        );
                    }
                    KeyCode::Char('n') | KeyCode::Char('N') => {
                        self.state.resolve_dialog(
                            pi_rpc::RpcExtensionUIResponse::Confirmed {
                                id,
                                confirmed: false,
                            },
                        );
                    }
                    KeyCode::Esc => self.state.cancel_dialog(),
                    _ => {}
                }
            }
            Some(DialogState::Input { id, input, .. }) => match (code, ctrl) {
                (KeyCode::Esc, _) => {
                    let id = id.clone();
                    self.state.resolve_dialog(
                        pi_rpc::RpcExtensionUIResponse::Cancelled {
                            id,
                            cancelled: true,
                        },
                    );
                }
                (KeyCode::Enter, _) => {
                    let value = input.take_submitted();
                    let id = id.clone();
                    self.state.resolve_dialog(
                        pi_rpc::RpcExtensionUIResponse::Value { id, value },
                    );
                }
                _ => edit_keys(input, key),
            },
            Some(DialogState::Editor { id, input, .. }) => match (code, ctrl) {
                (KeyCode::Esc, _) => {
                    let id = id.clone();
                    self.state.resolve_dialog(
                        pi_rpc::RpcExtensionUIResponse::Cancelled {
                            id,
                            cancelled: true,
                        },
                    );
                }
                // Ctrl+Enter / Ctrl+S submit; Enter inserts a newline.
                (KeyCode::Enter, true) | (KeyCode::Char('s'), true) => {
                    let value = input.take_submitted();
                    let id = id.clone();
                    self.state.resolve_dialog(
                        pi_rpc::RpcExtensionUIResponse::Value { id, value },
                    );
                }
                (KeyCode::Enter, false) => input.insert_char('\n'),
                _ => edit_keys(input, key),
            },
            Some(DialogState::Plugin { id, spec, driver, .. }) => {
                match driver {
                    // Plugin-driven: every key is forwarded as an
                    // `extension_ui_event`; Esc dismisses locally only when
                    // the spec allows it.
                    pi_rpc::OverlayDriver::Plugin => {
                        let id = id.clone();
                        if code == KeyCode::Esc && spec.dismissable.unwrap_or(true) {
                            self.send_ui_event(&id, pi_rpc::UiEvent::Dismissed);
                            self.state.cancel_dialog();
                        } else {
                            self.send_ui_event(&id, pi_rpc::UiEvent::Key {
                                key: key_id(key),
                                mods: key_mods(key),
                            });
                        }
                    }
                    // Client-driven fields land in P3; for now Esc cancels.
                    pi_rpc::OverlayDriver::Client => {
                        if code == KeyCode::Esc {
                            self.state.cancel_dialog();
                        }
                    }
                }
            }
            Some(DialogState::Local { sel, action }) => match (code, ctrl) {
                (KeyCode::Esc, _) => self.state.cancel_dialog(),
                (KeyCode::Up, _) => sel.move_up(),
                (KeyCode::Down, _) => sel.move_down(),
                (KeyCode::PageUp, _) => {
                    for _ in 0..select::MAX_VISIBLE {
                        sel.move_up();
                    }
                }
                (KeyCode::PageDown, _) => {
                    for _ in 0..select::MAX_VISIBLE {
                        sel.move_down();
                    }
                }
                (KeyCode::Enter, _) => {
                    let action = *action;
                    if let Some(i) = sel.selected() {
                        self.state.dialog = None;
                        self.dispatch_local_select(action, i);
                    }
                }
                (KeyCode::Backspace, _) => sel.pop_filter(),
                (KeyCode::Char(c), false) => sel.push_filter(c),
                _ => {}
            },
            None => return false,
        }
        self.state.dom_dirty = true;
        true
    }

    /// Key handling while the subagent tray is open (RECON §12.2 tray
    /// keymap: view/kill/foreground/close + tab navigation).
    fn handle_tray_key(&mut self, key: KeyEvent) -> bool {
        if key.kind == KeyEventKind::Release {
            return false;
        }
        match key.code {
            KeyCode::Esc | KeyCode::F(2) | KeyCode::Char('q') => {
                self.state.tray.open = false;
            }
            KeyCode::Tab | KeyCode::Right => {
                let t = self.state.tray.tab.next();
                self.state.tray.set_tab(t);
            }
            KeyCode::BackTab | KeyCode::Left => {
                let t = self.state.tray.tab.prev();
                self.state.tray.set_tab(t);
            }
            KeyCode::Up => self.state.tray.move_up(),
            KeyCode::Down => self.state.tray.move_down(),
            // view: expand the entry's tool card and scroll to it.
            KeyCode::Enter => {
                if let Some(ei) = self.state.tray.selected() {
                    let msg_idx = self.state.tray.entries[ei].msg_idx;
                    if let Some(m) = self.state.messages.get_mut(msg_idx) {
                        if m.tool_output.is_some() {
                            m.expanded = true;
                            m.dirty = true;
                        }
                    }
                    self.state.tray.open = false;
                    self.scroll_to_message(msg_idx);
                }
            }
            // kill: shells get `abort_bash`; subagents share the run,
            // so abort is session-scoped (no per-subagent primitive).
            KeyCode::Char('x') | KeyCode::Char('k') => {
                if let Some(ei) = self.state.tray.selected() {
                    let e = &mut self.state.tray.entries[ei];
                    if e.status == crate::state::TrayStatus::Running {
                        e.status = crate::state::TrayStatus::Cancelled;
                        match e.kind {
                            crate::state::TrayKind::Shell => {
                                self.send_cmd(RpcCommand::AbortBash);
                            }
                            crate::state::TrayKind::Subagent => {
                                if self.state.streaming {
                                    self.send_cmd(RpcCommand::Abort);
                                    self.state.push_system(
                                        "abort sent (cancels the whole run)",
                                    );
                                }
                            }
                        }
                    }
                }
            }
            // foreground/background: Devin subagent/mode — toggle
            // whether the entry's nested tool cards stream into the
            // main scrollback.
            KeyCode::Char('f') => {
                if let Some(fg) = self.state.toggle_tray_foreground() {
                    self.state.push_system(if fg {
                        "subagent moved to foreground"
                    } else {
                        "subagent moved to background"
                    });
                }
            }
            // view: close the tray and jump to the entry's output.
            KeyCode::Char('v') => {
                if let Some(ei) = self.state.tray.selected() {
                    let msg_idx = self.state.tray.entries[ei].msg_idx;
                    self.state.tray.open = false;
                    self.scroll_to_message(msg_idx);
                } else {
                    self.state.tray.open = false;
                }
            }
            _ => {}
        }
        self.state.dom_dirty = true;
        true
    }

    /// Scroll the message list so `msg_idx`'s bubble is at the top.
    /// `state.scroll` is a bottom-anchored offset (0 = tail), so the
    /// target is `content_height - (bubble height + heights below)`.
    fn scroll_to_message(&mut self, msg_idx: usize) {
        self.state.follow_tail = false;
        let Some(target) = self
            .state
            .messages
            .get(msg_idx)
            .and_then(|m| m.node_id)
        else {
            return;
        };
        let content_h = self
            .doc
            .get_node(self.handles.messages)
            .map(|n| n.scrollable_overflow().height())
            .unwrap_or(0.0);
        let target_h = self
            .doc
            .get_node(target)
            .map(|n| n.final_layout().size.height as f64 + 1.0)
            .unwrap_or(0.0);
        let mut below = 0.0;
        for m in self.state.messages.iter().skip(msg_idx + 1) {
            if let Some(id) = m.node_id {
                if let Some(n) = self.doc.get_node(id) {
                    below += n.final_layout().size.height as f64 + 1.0;
                }
            }
        }
        self.state.scroll = (content_h - below - target_h).max(0.0) as u32;
    }

    /// The `#input-hint` line for this frame.
    fn input_hint(&self) -> String {
        let tip = if self.state.show_tips() {
            input_box::TIPS[self.state.tip_idx]
        } else {
            ""
        };
        input_box::hint_for(
            &self.state.input,
            &self.state.attachments,
            self.state.attachment_sel,
            tip,
        )
    }

    /// Scroll the message list by `delta` cells (negative = up).
    fn scroll_messages(&mut self, delta: i32) {
        if delta < 0 {
            self.state.follow_tail = false;
            self.state.scroll = self.state.scroll.saturating_sub((-delta) as u32);
        } else {
            self.state.scroll = self.state.scroll.saturating_add(delta as u32);
            // Re-enable follow when we hit the bottom (clamped in
            // apply_scroll; approximate here).
            let max = self.max_scroll();
            if self.state.scroll >= max {
                self.state.follow_tail = true;
            }
        }
    }

    fn max_scroll(&self) -> u32 {
        let Some(node) = self.doc.get_node(self.handles.messages) else {
            return 0;
        };
        let content = node.scrollable_overflow().height();
        let view = node.final_layout().size.height as f64;
        (content - view).max(0.0) as u32
    }

    /// Submit the current input: slash commands are handled locally,
    /// everything else goes to pi as a `prompt`.
    fn submit_input(&mut self) {
        let text = self.state.input.take_submitted();
        if text.trim().is_empty() {
            return;
        }
        match commands::parse(&text) {
            Command::Prompt(p) => {
                // Local echo (deduped against message_start).
                self.state.push_user(p.clone());
                self.state.follow_tail = true;
                // Attached images (Ctrl+V) ride along with the prompt.
                let images = if self.state.attachments.is_empty() {
                    None
                } else {
                    Some(
                        self.state
                            .attachments
                            .drain(..)
                            .map(|a| pi_rpc::MessageContent::Image {
                                data: a.data,
                                mime_type: a.mime,
                            })
                            .collect(),
                    )
                };
                self.state.attachment_sel = None;
                if self.state.streaming {
                    // pi queues prompts while streaming (follow_up).
                    self.send_cmd(RpcCommand::FollowUp {
                        message: p,
                        images,
                    });
                } else {
                    self.send_cmd(RpcCommand::Prompt {
                        message: p,
                        images,
                        streaming_behavior: None,
                    });
                }
            }
            Command::Local(cmd) => self.dispatch_local(cmd),
        }
    }

    /// Execute a locally-handled slash command.
    fn dispatch_local(&mut self, cmd: LocalCmd) {
        match cmd {
            LocalCmd::Model(None) => self.send_report(RpcCommand::GetAvailableModels),
            LocalCmd::Model(Some(spec)) => self.set_model_from_spec(&spec),
            LocalCmd::Thinking(None) => {
                self.send_report(RpcCommand::GetAvailableThinkingLevels)
            }
            LocalCmd::Thinking(Some(level)) => {
                match parse_thinking_level(&level) {
                    Some(level) => self.send_report(RpcCommand::SetThinkingLevel { level }),
                    None => self.state.push_system(format!(
                        "unknown thinking level '{level}' (off|minimal|low|medium|high|xhigh|max)"
                    )),
                }
            }
            LocalCmd::NewSession => self.send_report(RpcCommand::NewSession {
                parent_session: None,
            }),
            LocalCmd::Compact(instructions) => self.send_report(RpcCommand::Compact {
                custom_instructions: instructions,
            }),
            LocalCmd::Session => self.send_report(RpcCommand::GetSessionStats),
            LocalCmd::Export(path) => self.send_report(RpcCommand::ExportHtml {
                output_path: path,
            }),
            LocalCmd::Name(name) => self.send_report(RpcCommand::SetSessionName { name }),
            LocalCmd::Copy => self.send_report(RpcCommand::GetLastAssistantText),
            LocalCmd::Clear => self.state.clear_messages(),
            LocalCmd::Settings => self.state.open_local_select(LocalAction::ToggleSetting),
            // /unqueue: recall the last queued message into the input.
            // pi only exposes `clear_queue`, so we clear then re-queue
            // the remaining messages as follow-ups.
            LocalCmd::Unqueue => {
                if let Some(last) = self.state.queued.pop() {
                    let rest = std::mem::take(&mut self.state.queued);
                    self.send_cmd(RpcCommand::ClearQueue);
                    for msg in rest {
                        self.send_cmd(RpcCommand::FollowUp {
                            message: msg,
                            images: None,
                        });
                    }
                    self.state.input.text = last;
                    self.state.input.cursor = self.state.input.text.len();
                    self.state.dom_dirty = true;
                } else {
                    self.state.push_system("queue is empty");
                }
            }
            LocalCmd::Help => {
                for (name, desc) in commands::BUILTIN_HELP {
                    self.state.push_system(format!("{name} — {desc}"));
                }
                // pi-side commands (extension/prompt/skill) appended async.
                self.send_report(RpcCommand::GetCommands);
            }
            LocalCmd::Quit => self.state.quit = true,
        }
    }

    /// `/model <spec>` — `provider/id` splits directly; a bare id is
    /// resolved against the cached `get_available_models` list.
    fn set_model_from_spec(&mut self, spec: &str) {
        if let Some((provider, id)) = spec.split_once('/') {
            self.send_report(RpcCommand::SetModel {
                provider: provider.to_string(),
                model_id: id.to_string(),
            });
            return;
        }
        match self.state.models.iter().find(|m| m.id == spec) {
            Some(m) => {
                let (provider, id) = (m.provider.clone(), m.id.clone());
                self.send_report(RpcCommand::SetModel {
                    provider,
                    model_id: id,
                });
            }
            None => {
                if self.state.models.is_empty() {
                    // No cache — fetch the list, then let the user pick.
                    self.state.push_system(format!(
                        "model list not loaded; use /model to pick (or /model provider/{spec})"
                    ));
                    self.send_report(RpcCommand::GetAvailableModels);
                } else {
                    self.state.push_system(format!(
                        "unknown model '{spec}' — use /model to pick"
                    ));
                }
            }
        }
    }

    /// A `DialogState::Local` selection was confirmed: dispatch the
    /// command for the picked index.
    fn dispatch_local_select(&mut self, action: LocalAction, index: usize) {
        match action {
            LocalAction::SetModel => {
                if let Some(m) = self.state.models.get(index) {
                    let (provider, id) = (m.provider.clone(), m.id.clone());
                    self.send_report(RpcCommand::SetModel {
                        provider,
                        model_id: id,
                    });
                }
            }
            LocalAction::SetThinking => {
                if let Some(level) = self.state.thinking_levels.get(index).copied() {
                    self.send_report(RpcCommand::SetThinkingLevel { level });
                }
            }
            LocalAction::ToggleSetting => {
                // Toggle in place and keep the picker open: flip the
                // value, then re-open on the same row (the Enter arm
                // already closed the dialog).
                if let Some(key) = crate::state::SETTINGS_KEYS.get(index).copied() {
                    let on = !self.state.settings.get(key).copied().unwrap_or(true);
                    self.state.settings.insert(key.to_string(), on);
                    self.state.open_local_select(LocalAction::ToggleSetting);
                    if let Some(DialogState::Local { sel, .. }) = &mut self.state.dialog {
                        sel.cursor = index;
                    }
                }
            }
        }
        self.state.dom_dirty = true;
    }

    /// Send an RPC command and route the full response back through the
    /// event loop (`cmd_rx` → `handle_cmd_response`).
    fn send_report(&self, cmd: RpcCommand) {
        let rpc = Arc::clone(&self.rpc);
        let tx = self.cmd_tx.clone();
        tokio::spawn(async move {
            match rpc.send(&cmd).await {
                Ok(resp) => {
                    let _ = tx.send(resp);
                }
                Err(e) => {
                    let _ = tx.send(RpcResponse::failure(
                        None,
                        cmd.command_type(),
                        format!("send error: {e}"),
                    ));
                }
            }
        });
    }

    /// Reduce a slash-command response: state reducer + side effects.
    fn handle_cmd_response(&mut self, resp: RpcResponse) -> bool {
        match self.state.apply_response(&resp) {
            ResponseEffect::RefreshState => {
                // Fire-and-forget: the get_state response comes back on
                // cmd_rx and lands in the `get_state` arm below.
                self.send_report(RpcCommand::GetState);
                true
            }
            ResponseEffect::CopyToClipboard(text) => {
                match copy_to_clipboard(&text) {
                    Ok(()) => self.state.push_system("copied to clipboard"),
                    Err(e) => self
                        .state
                        .push_system(format!("clipboard failed: {e}")),
                }
                true
            }
            ResponseEffect::None => {
                // `get_state` responses land here — refresh the status line.
                if resp.command == "get_state" {
                    if let Some(s) = resp.session_state() {
                        if let Some(m) = s.model {
                            self.state.status.model = m.id;
                        }
                        self.state.status.thinking =
                            format!("{:?}", s.thinking_level).to_lowercase();
                        self.state.status.mode =
                            format!("{:?}", s.steering_mode).to_lowercase();
                        self.state.streaming = s.is_streaming;
                        return true;
                    }
                }
                self.state.dom_dirty
            }
        }
    }

    /// Fire-and-forget an RPC command; failures surface as system lines.
    pub fn send_cmd(&self, cmd: RpcCommand) {
        let rpc = Arc::clone(&self.rpc);
        let tx = self.notice_tx.clone();
        tokio::spawn(async move {
            match rpc.send(&cmd).await {
                Ok(resp) if !resp.success => {
                    let _ = tx.send(format!(
                        "{} failed: {}",
                        cmd.command_type(),
                        resp.error.as_deref().unwrap_or("unknown error")
                    ));
                }
                Err(e) => {
                    let _ = tx.send(format!("{} send error: {e}", cmd.command_type()));
                }
                _ => {}
            }
        });
    }

    /// One frame: sync DOM → viewport → resolve → scroll → paint → ANSI.
    fn render_frame(&mut self) -> io::Result<()> {
        let surface = self.paint_frame();

        // 7. Diff → ANSI, wrapped in synchronized output. The
        //    renderer hands back the replaced frame's surface for
        //    reuse as the next paint buffer.
        let frame = Frame::new(surface);
        let mut out = String::new();
        ansi::begin_sync(&mut out);
        out.push_str(&self.renderer.draw(frame));
        ansi::end_sync(&mut out);
        if self.surface_spare.is_none() {
            self.surface_spare = self.renderer.spare_surface.take();
        }
        // `setTitle` → OSC window-title escape (outside the sync block).
        if let Some(title) = self.state.term_title.take() {
            out.push_str(&format!("\x1b]2;{title}\x07"));
        }

        let mut stdout = io::stdout().lock();
        stdout.write_all(out.as_bytes())?;
        stdout.flush()
    }

    /// Steps 1–6 of a frame at the current terminal size.
    /// Returns the painted surface (headless modes use `to_text` on it).
    pub fn paint_frame(&mut self) -> Surface {
        let (w, h) = self.term_size;
        self.paint_frame_at(w, h)
    }

    /// Steps 1–6 of a frame: DOM sync → layout → scroll → paint → cursor.
    ///
    /// Frame gating: DOM mutations only happen when inputs changed
    /// (component signature caches), `set_viewport`/`resolve` only when
    /// the size or DOM changed, and the paint surface is double-buffered
    /// instead of freshly allocated.
    pub fn paint_frame_at(&mut self, w: u16, h: u16) -> Surface {
        let hint = self.input_hint();
        let dialog_sig = dialog::signature(&self.state);
        let completion_sig = completion::signature(&self.state);
        let input_sig = Self::input_signature(&self.state, &hint);
        let spinner_sig = Self::spinner_signature(&self.state);
        let status_sig = Self::status_signature(&self.state);
        let mut layout_dirty = self.state.dom_dirty
            || input_sig != self.input_sig
            || spinner_sig != self.spinner_sig
            || status_sig != self.status_sig
            || dialog_sig != self.dialog_sig
            || completion_sig != self.completion_sig;

        // 1. Patch the DOM from state — one mutate scope for everything.
        {
            let mut m = self.doc.mutate();
            if self.state.dom_dirty {
                message_list::sync(&mut m, self.handles.messages_inner, &mut self.state);
                status_line::sync(
                    &mut m,
                    self.handles.status_left,
                    self.handles.status_right,
                    &self.state.status,
                    self.state.streaming,
                    self.state.permission.label(),
                    self.state.queued.len(),
                );
                self.state.dom_dirty = false;
            }
            // Input cursor may have moved without a state-marked dirty.
            input_box::sync(
                &mut m,
                self.handles.input_hint_text,
                self.handles.input_text,
                &self.state.input,
                self.state.dialog.is_none(),
                &hint,
            );

            // 1b. Per-frame components — signature-gated rebuilds.
            spinner::sync(
                &mut m,
                &self.handles.spinner,
                self.state.streaming,
                self.state.tick,
                "esc to interrupt",
                self.state.glyphs,
            );
            if dialog_sig != self.dialog_sig {
                dialog::sync(
                    &mut m,
                    self.handles.dialog_area,
                    self.handles.widget_area,
                    &self.state,
                    self.state.glyphs,
                );
                self.dialog_sig = dialog_sig;
            }
            if completion_sig != self.completion_sig {
                completion::sync(
                    &mut m,
                    self.handles.completion_area,
                    &self.state,
                    self.state.glyphs,
                );
                self.completion_sig = completion_sig;
            }
            self.input_sig = input_sig;
            self.spinner_sig = spinner_sig;
            self.status_sig = status_sig;

            // 2. Pin #app to the terminal size only when it changed
            //    (set_style_property parses + marks restyle damage).
            if (w, h) != self.last_viewport {
                m.set_style_property(self.handles.app, "width", &format!("{w}px"));
                m.set_style_property(self.handles.app, "height", &format!("{h}px"));
            }
            drop(m);
        }

        // 2b. Viewport: `set_viewport` rebuilds the stylo Device and
        //     re-evaluates media queries — only on actual resize.
        if (w, h) != self.last_viewport {
            self.doc.set_viewport(Viewport::new(
                w as u32,
                h as u32,
                1.0,
                self.theme_kind.color_scheme(),
            ));
            self.last_viewport = (w, h);
            layout_dirty = true;
        }

        // 3. Style + layout — skip entirely when nothing mutated
        //    (resolve still walks the whole DOM three times).
        if layout_dirty {
            self.doc.resolve(0.0);
        }

        // 4. Scroll clamp + write.
        message_list::apply_scroll(&mut self.doc, self.handles.messages, &mut self.state);
        self.messages_view_h = self
            .doc
            .get_node(self.handles.messages)
            .map(|n| n.final_layout().size.height as u32)
            .unwrap_or(0);

        // 5. Paint DOM → cell surface; keep the hit regions for mouse
        //    routing on the next event. Reuse the previous frame's
        //    buffer (double-buffered with the renderer).
        let mut surface = match self.surface_spare.take() {
            Some(mut s) if s.width == w && s.height == h => {
                s.reset();
                s
            }
            _ => Surface::new(w, h),
        };
        {
            let mut ctx = PaintContext::new(&self.doc, &mut surface);
            paint_document(&mut ctx);
            self.hit_regions = std::mem::take(&mut ctx.hit_regions);
        }

        // 6. Cursor post-process: the PUA marker cell → inverse block.
        let cursor_cells: Vec<(u16, u16)> = surface
            .markers
            .iter()
            .filter(|m| m.text.contains(input_box::CURSOR_MARKER))
            .map(|m| (m.x, m.y))
            .collect();
        let cursor = self.theme.cursor_style();
        for (x, y) in cursor_cells {
            if let Some(cell) = surface.cell_mut(x, y) {
                cell.symbol = " ".into();
                cell.modifier |= cursor.modifier;
            }
        }

        surface
    }
}

/// pi-tui-style key id for a crossterm `KeyEvent` ("up", "escape", "f2",
/// or the character itself). Modifiers are reported separately via
/// `key_mods` — the pair is what `extension_ui_event` carries.
fn key_id(key: KeyEvent) -> String {
    match key.code {
        KeyCode::Char(c) => c.to_string(),
        KeyCode::Enter => "enter".into(),
        KeyCode::Esc => "escape".into(),
        KeyCode::Tab => "tab".into(),
        KeyCode::BackTab => "backtab".into(),
        KeyCode::Backspace => "backspace".into(),
        KeyCode::Delete => "delete".into(),
        KeyCode::Insert => "insert".into(),
        KeyCode::Home => "home".into(),
        KeyCode::End => "end".into(),
        KeyCode::PageUp => "pageUp".into(),
        KeyCode::PageDown => "pageDown".into(),
        KeyCode::Up => "up".into(),
        KeyCode::Down => "down".into(),
        KeyCode::Left => "left".into(),
        KeyCode::Right => "right".into(),
        KeyCode::F(n) => format!("f{n}"),
        other => format!("{other:?}").to_lowercase(),
    }
}

/// Active modifier names for `UiEvent::Key.mods`.
fn key_mods(key: KeyEvent) -> Vec<String> {
    let mut mods = Vec::new();
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        mods.push("ctrl".into());
    }
    if key.modifiers.contains(KeyModifiers::ALT) {
        mods.push("alt".into());
    }
    if key.modifiers.contains(KeyModifiers::SHIFT) {
        mods.push("shift".into());
    }
    mods
}

/// Shared line-editing keys for dialog input/editor fields — the same
/// Emacs ops as the main input (word nav, kill ring, transpose, case).
fn edit_keys(input: &mut crate::state::InputState, key: KeyEvent) {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    if alt {
        match key.code {
            KeyCode::Char('b') | KeyCode::Char('B') => input.move_word_left(),
            KeyCode::Char('f') | KeyCode::Char('F') => input.move_word_right(),
            KeyCode::Char('d') | KeyCode::Char('D') => input.kill_word(),
            KeyCode::Char('u') | KeyCode::Char('U') => {
                input.case_word(crate::state::WordCase::Upper)
            }
            KeyCode::Char('l') | KeyCode::Char('L') => {
                input.case_word(crate::state::WordCase::Lower)
            }
            KeyCode::Char('c') | KeyCode::Char('C') => {
                input.case_word(crate::state::WordCase::Capitalize)
            }
            KeyCode::Char('t') | KeyCode::Char('T') => input.transpose_words(),
            KeyCode::Backspace => input.backward_kill_word(),
            KeyCode::Char(c) => input.insert_char(c),
            _ => {}
        }
        return;
    }
    match (key.code, ctrl) {
        (KeyCode::Backspace, true) => input.backward_kill_word(),
        (KeyCode::Backspace, _) => input.backspace(),
        (KeyCode::Delete, _) => input.delete(),
        (KeyCode::Left, true) => input.move_word_left(),
        (KeyCode::Left, _) => input.move_left(),
        (KeyCode::Right, true) => input.move_word_right(),
        (KeyCode::Right, _) => input.move_right(),
        (KeyCode::Home, _) => input.move_home(),
        (KeyCode::End, _) => input.move_end(),
        (KeyCode::Up, _) => {
            input.prev_line();
        }
        (KeyCode::Down, _) => {
            input.next_line();
        }
        (KeyCode::Char('a'), true) => input.move_home(),
        (KeyCode::Char('e'), true) => input.move_end(),
        (KeyCode::Char('f'), true) => input.move_right(),
        (KeyCode::Char('b'), true) => input.move_left(),
        (KeyCode::Char('h'), true) => input.backspace(),
        (KeyCode::Char('d'), true) => input.delete(),
        (KeyCode::Char('k'), true) => input.kill_line(),
        (KeyCode::Char('u'), true) => input.backward_kill_line(),
        (KeyCode::Char('w'), true) => input.unix_word_rubout(),
        (KeyCode::Char('y'), true) => input.yank(),
        (KeyCode::Char('t'), true) => input.transpose_chars(),
        (KeyCode::Char('r'), true) => input.history_search(),
        (KeyCode::Char(c), false) => input.insert_char(c),
        _ => {}
    }
}

/// Open a URL in the system browser (best-effort, fire-and-forget).
fn open_url(url: &str) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

/// Build the static DOM skeleton: `html > body > #app > (#messages,
/// #spinner-line, #dialog-area, #widget-area, #input-area,
/// #completion-area, #status-line)`. Returns the handles the app patches.
pub fn build_skeleton(doc: &mut BaseDocument) -> DomHandles {
    use crate::components::dom::{div, qual};

    let root = doc.root_node().id;
    let mut m = doc.mutate();

    let html = m.create_element(qual("html"), vec![]);
    m.append_children(root, &[html]);
    let body = m.create_element(qual("body"), vec![]);
    m.append_children(html, &[body]);
    let app = div(&mut m, body, "");
    m.set_attribute(app, qual("id"), "app");

    let (messages, messages_inner) = message_list::build(&mut m, app);
    let spinner = spinner::build(&mut m, app);
    let (dialog_area, widget_area) = dialog::build(&mut m, app);
    let (_area, hint_text, input_text) = input_box::build(&mut m, app);
    let completion_area = completion::build(&mut m, app);
    let (_line, status_left, status_right) = status_line::build(&mut m, app);

    drop(m);

    DomHandles {
        root,
        app,
        messages,
        messages_inner,
        spinner,
        dialog_area,
        widget_area,
        input_hint_text: hint_text,
        input_text,
        completion_area,
        status_left,
        status_right,
    }
}

/// Enter alt-screen, raw mode, hide cursor, enable paste + mouse scroll.
fn terminal_setup_enter() -> io::Result<()> {
    terminal::enable_raw_mode()?;
    let mut out = io::stdout().lock();
    execute!(
        out,
        EnableBracketedPaste,
        EnableMouseCapture,
        terminal::EnterAlternateScreen,
        crossterm::cursor::Hide,
    )?;
    out.flush()
}

/// Leave alt-screen, restore cursor, disable raw mode.
fn terminal_setup_leave() -> io::Result<()> {
    let mut out = io::stdout().lock();
    let _ = execute!(
        out,
        crossterm::cursor::Show,
        terminal::LeaveAlternateScreen,
        DisableMouseCapture,
        DisableBracketedPaste,
    );
    let _ = out.flush();
    terminal::disable_raw_mode()
}

/// Parse a thinking-level name (`off|minimal|low|medium|high|xhigh|max`).
fn parse_thinking_level(s: &str) -> Option<pi_rpc::ThinkingLevel> {
    use pi_rpc::ThinkingLevel as T;
    match s.to_ascii_lowercase().as_str() {
        "off" => Some(T::Off),
        "minimal" | "min" => Some(T::Minimal),
        "low" => Some(T::Low),
        "medium" | "med" => Some(T::Medium),
        "high" => Some(T::High),
        "xhigh" | "x-high" => Some(T::Xhigh),
        "max" => Some(T::Max),
        _ => None,
    }
}

/// `/copy` — write text to the system clipboard.
fn copy_to_clipboard(text: &str) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text).map_err(|e| e.to_string())
}

impl App {
    /// Ctrl+V: clipboard image → attachment; text → insert.
    fn paste_clipboard(&mut self) {
        let mut cb = match arboard::Clipboard::new() {
            Ok(c) => c,
            Err(e) => {
                self.state.push_system(format!("clipboard: {e}"));
                return;
            }
        };
        if let Ok(img) = cb.get_image() {
            match encode_png(&img) {
                Ok(png) => {
                    let n = self.state.attachments.len() + 1;
                    self.state.attachments.push(crate::state::Attachment {
                        data: base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            png,
                        ),
                        mime: "image/png".into(),
                        label: format!("image {n}"),
                    });
                    self.state.push_system(format!("attached image {n}"));
                }
                Err(e) => self.state.push_system(format!("image encode: {e}")),
            }
        } else if let Ok(text) = cb.get_text() {
            let text = text.replace("\r\n", "\n").replace('\r', "\n");
            self.state.input.insert_str(&text);
        }
        self.state.dom_dirty = true;
    }

    /// Ctrl+G: edit the input in $EDITOR (RECON `open_external_editor`).
    /// Leaves the alt-screen, blocks on the editor, restores.
    fn open_external_editor(&mut self) {
        let editor = std::env::var("EDITOR")
            .or_else(|_| std::env::var("VISUAL"))
            .unwrap_or_else(|_| "notepad".into());
        let path = std::env::temp_dir().join("pi-tui-input.md");
        if std::fs::write(&path, &self.state.input.text).is_err() {
            self.state.push_system("cannot write temp file");
            return;
        }
        let _ = terminal_setup_leave();
        let status = std::process::Command::new(&editor).arg(&path).status();
        let _ = terminal_setup_enter();
        match status {
            Ok(s) if s.success() => {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    self.state.input.text = text.trim_end().to_string();
                    self.state.input.cursor = self.state.input.text.len();
                }
            }
            Ok(_) => self.state.push_system("editor exited non-zero"),
            Err(e) => self
                .state
                .push_system(format!("editor '{editor}': {e}")),
        }
        self.renderer.needs_full_redraw = true;
        self.state.dom_dirty = true;
    }
}

/// Encode RGBA8 clipboard pixels as PNG.
fn encode_png(img: &arboard::ImageData<'_>) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, img.width as u32, img.height as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut w = enc.write_header().map_err(|e| e.to_string())?;
        w.write_image_data(&img.bytes).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// Build the `@` file index: cwd-relative paths, gitignore-aware
/// (`ignore` crate), hidden files included except `.git`.
fn build_file_index(state: &crate::state::AppState) -> Vec<String> {
    let include_gitignored = state
        .settings
        .get("include_gitignored_in_mentions")
        .copied()
        .unwrap_or(false);
    let mut wb = ignore::WalkBuilder::new(".");
    wb.hidden(false)
        .git_ignore(!include_gitignored)
        .git_global(!include_gitignored)
        .git_exclude(!include_gitignored)
        .filter_entry(|e| e.file_name() != ".git");
    let mut files = Vec::new();
    for entry in wb.build().flatten() {
        if entry.file_type().is_some_and(|t| t.is_file()) {
            let p = entry.path();
            let s = p.strip_prefix(".").unwrap_or(p).to_string_lossy();
            files.push(s.trim_start_matches(['/', '\\']).replace('\\', "/"));
        }
        if files.len() >= 20_000 {
            break;
        }
    }
    files.sort();
    files
}
