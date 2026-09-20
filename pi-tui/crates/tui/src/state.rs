//! `state` — application state model + `RpcEvent` → state reduction.
//!
//! The DOM is a *projection* of this state: `app.rs` rebuilds/patches the
//! DOM from `AppState` each time it changes. Streaming text deltas update
//! the last message's text node in place (`set_node_text`); structural
//! changes (new message, tool lifecycle) append/remove nodes.

use std::collections::VecDeque;

use pi_rpc::events::{is_run_end, text_delta, thinking_delta};
use pi_rpc::types::{
    AgentEvent, AgentMessage, AssistantMessageEvent, MessageContent, Model, RpcResponse,
    ThinkingLevel, UserContent,
};
use pi_rpc::{
    Frame, OverlayDriver, OverlaySpec, RpcEvent, RpcExtensionUIRequest, RpcExtensionUIResponse,
};

use crate::components::glyphs::GlyphMode;
use crate::components::select::SelectState;

/// What kind of bubble a message renders as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MsgKind {
    User,
    Assistant,
    Thinking,
    Tool,
    Error,
    System,
}

/// One entry in the message list.
#[derive(Clone, Debug)]
pub struct Message {
    pub kind: MsgKind,
    /// Primary text content (streamed for assistant/thinking); for tools,
    /// the args summary shown in the card header.
    pub text: String,
    /// Tool name for `MsgKind::Tool`.
    pub tool_name: Option<String>,
    /// `toolCallId` — matches execution_update/end to the right card
    /// (nested tools interleave, so `last_mut` is wrong).
    pub tool_call_id: Option<String>,
    /// Index into `state.tray.entries` when this card is a subagent/
    /// shell spawn (drives the in-card activity feed).
    pub tray_entry: Option<usize>,
    /// Index of the tray entry this card is nested under (a tool that
    /// ran inside a subagent). Backgrounded owners hide the card.
    pub nested_under: Option<usize>,
    /// Tool status glyph: `●` running, `✓` ok, `✗` error, `◔` partial.
    pub tool_status: Option<char>,
    /// Full tool output (`tool_execution_end` result) — rendered as the
    /// card body, truncated unless `expanded`.
    pub tool_output: Option<String>,
    /// Raw tool args (kept for `detect_lang` + the Devin-style
    /// `$ command` body line at execution end).
    pub tool_args: Option<serde_json::Value>,
    /// Shell exit code extracted from the tool result (bash).
    pub tool_exit: Option<i64>,
    /// Detected output language (`tool_card::detect_lang`).
    pub tool_lang: Option<&'static str>,
    /// Ctrl+O / click-expand: show full tool output.
    pub expanded: bool,
    /// DOM node id of the bubble element (set by the DOM builder).
    pub node_id: Option<blitz_dom::NodeId>,
    /// DOM node id of the primary text node inside the bubble.
    pub text_node_id: Option<blitz_dom::NodeId>,
    /// DOM node id of the tool glyph text node (MsgKind::Tool only).
    pub glyph_node_id: Option<blitz_dom::NodeId>,
    /// Sealed bubbles no longer accept streamed appends (set at turn_end).
    pub sealed: bool,
    /// Structural rebuild requested (tool card state changed).
    pub dirty: bool,
    /// Length of `text` already rendered into the DOM (markdown/tool
    /// rebuilds compare against this to skip no-op work).
    pub rendered_len: usize,
}

impl Message {
    /// New message bubble of `kind` with `text`.
    pub fn new(kind: MsgKind, text: impl Into<String>) -> Self {
        Message {
            kind,
            text: text.into(),
            tool_name: None,
            tool_call_id: None,
            tray_entry: None,
            nested_under: None,
            tool_status: None,
            tool_output: None,
            tool_args: None,
            tool_exit: None,
            tool_lang: None,
            expanded: false,
            node_id: None,
            text_node_id: None,
            glyph_node_id: None,
            sealed: false,
            dirty: false,
            rendered_len: 0,
        }
    }
}

/// Input box editing state (Emacs-style line editing + kill ring).
#[derive(Clone, Debug, Default)]
pub struct InputState {
    /// Current input text (may contain newlines).
    pub text: String,
    /// Cursor position as a *byte* index (always on a char boundary).
    pub cursor: usize,
    /// Submitted prompt history (oldest → newest).
    pub history: Vec<String>,
    /// `Some(i)` while navigating history; `history[i]` is shown.
    pub history_idx: Option<usize>,
    /// Stash of the in-progress input while browsing history.
    pub history_stash: String,
    /// Kill ring: text removed by kill_* ops (oldest → newest).
    pub kill_ring: Vec<String>,
}

/// Emacs word-case transform applied to the word after the cursor.
#[derive(Clone, Copy, Debug)]
pub enum WordCase {
    Upper,
    Lower,
    Capitalize,
}

/// Max kill-ring depth (Emacs default is 60).
const KILL_RING_MAX: usize = 60;

/// Emacs word constituent: alphanumerics plus `_`.
fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

impl InputState {
    /// Byte index of the next char boundary at/after `pos + 1`.
    fn next_boundary_at(&self, pos: usize) -> usize {
        let mut i = pos + 1;
        while i < self.text.len() && !self.text.is_char_boundary(i) {
            i += 1;
        }
        i.min(self.text.len())
    }

    /// Byte index of the previous char boundary before `pos`.
    fn prev_boundary_at(&self, pos: usize) -> usize {
        if pos == 0 {
            return 0;
        }
        let mut i = pos - 1;
        while i > 0 && !self.text.is_char_boundary(i) {
            i -= 1;
        }
        i
    }

    fn next_boundary(&self) -> usize {
        self.next_boundary_at(self.cursor)
    }

    fn prev_boundary(&self) -> usize {
        self.prev_boundary_at(self.cursor)
    }

    /// Byte index of the char-boundary `n` chars after `pos`.
    fn nth_char_pos(&self, pos: usize, n: usize) -> usize {
        let mut i = pos;
        for _ in 0..n {
            if i >= self.text.len() {
                return self.text.len();
            }
            i = self.next_boundary_at(i);
        }
        i
    }

    /// Byte index of the start of the line containing `pos`.
    fn line_start(&self, pos: usize) -> usize {
        self.text[..pos].rfind('\n').map_or(0, |i| i + 1)
    }

    /// Byte index of the end of the line containing `pos` (the `\n` or EOF).
    fn line_end(&self, pos: usize) -> usize {
        self.text[pos..]
            .find('\n')
            .map_or(self.text.len(), |i| pos + i)
    }

    /// Cursor column in *chars* within its line.
    fn cursor_col(&self) -> usize {
        self.text[self.line_start(self.cursor)..self.cursor]
            .chars()
            .count()
    }

    /// Any text mutation exits history-browse mode (the recalled entry
    /// becomes the new in-progress input).
    fn touch(&mut self) {
        self.history_idx = None;
        self.history_stash.clear();
    }

    /// Push killed text onto the ring.
    fn push_kill(&mut self, s: String) {
        if s.is_empty() {
            return;
        }
        self.kill_ring.push(s);
        if self.kill_ring.len() > KILL_RING_MAX {
            self.kill_ring.remove(0);
        }
    }

    /// Remove `start..end`, push it on the kill ring, place the cursor.
    fn kill_range(&mut self, start: usize, end: usize) {
        if start >= end {
            return;
        }
        let killed = self.text[start..end].to_string();
        self.text.replace_range(start..end, "");
        self.cursor = start;
        self.push_kill(killed);
        self.touch();
    }

    /// Emacs forward-word: skip non-word chars, then the word run.
    fn word_forward(&self, pos: usize) -> usize {
        let mut i = pos;
        while i < self.text.len() {
            let c = self.text[i..].chars().next().unwrap();
            if is_word_char(c) {
                break;
            }
            i += c.len_utf8();
        }
        while i < self.text.len() {
            let c = self.text[i..].chars().next().unwrap();
            if !is_word_char(c) {
                break;
            }
            i += c.len_utf8();
        }
        i
    }

    /// Emacs backward-word: skip non-word chars back, then the word run.
    fn word_backward(&self, pos: usize) -> usize {
        let mut i = pos;
        while i > 0 {
            let p = self.prev_boundary_at(i);
            if is_word_char(self.text[p..i].chars().next().unwrap()) {
                break;
            }
            i = p;
        }
        while i > 0 {
            let p = self.prev_boundary_at(i);
            if !is_word_char(self.text[p..i].chars().next().unwrap()) {
                break;
            }
            i = p;
        }
        i
    }

    /// End boundary of the word before `pos` (skips non-word chars
    /// back; returns `pos` when already at a word end).
    fn word_end_backward(&self, pos: usize) -> usize {
        let mut i = pos;
        while i > 0 {
            let p = self.prev_boundary_at(i);
            if is_word_char(self.text[p..i].chars().next().unwrap()) {
                break;
            }
            i = p;
        }
        i
    }

    /// unix-word-rubout word: whitespace-delimited, backwards.
    fn unix_word_backward(&self, pos: usize) -> usize {
        let mut i = pos;
        while i > 0 {
            let p = self.prev_boundary_at(i);
            if !self.text[p..i].chars().next().unwrap().is_whitespace() {
                break;
            }
            i = p;
        }
        while i > 0 {
            let p = self.prev_boundary_at(i);
            if self.text[p..i].chars().next().unwrap().is_whitespace() {
                break;
            }
            i = p;
        }
        i
    }

    pub fn insert_str(&mut self, s: &str) {
        self.text.insert_str(self.cursor, s);
        self.cursor += s.len();
        self.touch();
    }

    pub fn insert_char(&mut self, c: char) {
        self.text.insert(self.cursor, c);
        self.cursor += c.len_utf8();
        self.touch();
    }

    pub fn backspace(&mut self) {
        if self.cursor > 0 {
            let prev = self.prev_boundary();
            self.text.replace_range(prev..self.cursor, "");
            self.cursor = prev;
            self.touch();
        }
    }

    pub fn delete(&mut self) {
        if self.cursor < self.text.len() {
            let next = self.next_boundary();
            self.text.replace_range(self.cursor..next, "");
            self.touch();
        }
    }

    pub fn move_left(&mut self) {
        self.cursor = self.prev_boundary();
    }

    pub fn move_right(&mut self) {
        self.cursor = self.next_boundary();
    }

    /// Emacs move-beginning-of-line (Ctrl+A / Home).
    pub fn move_home(&mut self) {
        self.cursor = self.line_start(self.cursor);
    }

    /// Emacs move-end-of-line (Ctrl+E / End).
    pub fn move_end(&mut self) {
        self.cursor = self.line_end(self.cursor);
    }

    /// Emacs forward-word (Alt+F / Ctrl+Right).
    pub fn move_word_right(&mut self) {
        self.cursor = self.word_forward(self.cursor);
    }

    /// Emacs backward-word (Alt+B / Ctrl+Left).
    pub fn move_word_left(&mut self) {
        self.cursor = self.word_backward(self.cursor);
    }

    /// Move up one logical line, same column. Returns false on the
    /// first line (caller falls back to history).
    pub fn prev_line(&mut self) -> bool {
        let start = self.line_start(self.cursor);
        if start == 0 {
            return false;
        }
        let col = self.cursor_col();
        let prev_end = start - 1;
        let prev_start = self.line_start(prev_end);
        let prev_len = self.text[prev_start..prev_end].chars().count();
        self.cursor = self.nth_char_pos(prev_start, col.min(prev_len));
        true
    }

    /// Move down one logical line, same column. Returns false on the
    /// last line (caller falls back to history).
    pub fn next_line(&mut self) -> bool {
        let end = self.line_end(self.cursor);
        if end >= self.text.len() {
            return false;
        }
        let col = self.cursor_col();
        let next_start = end + 1;
        let next_end = self.line_end(next_start);
        let next_len = self.text[next_start..next_end].chars().count();
        self.cursor = self.nth_char_pos(next_start, col.min(next_len));
        true
    }

    /// Emacs kill-line (Ctrl+K): to end of line; at EOL kills the `\n`.
    pub fn kill_line(&mut self) {
        let end = self.line_end(self.cursor);
        if end == self.cursor {
            if self.cursor < self.text.len() {
                self.kill_range(self.cursor, self.cursor + 1);
            }
        } else {
            self.kill_range(self.cursor, end);
        }
    }

    /// Emacs backward-kill-line (Ctrl+U): to start of line.
    pub fn backward_kill_line(&mut self) {
        let start = self.line_start(self.cursor);
        self.kill_range(start, self.cursor);
    }

    /// Emacs kill-word (Alt+D).
    pub fn kill_word(&mut self) {
        let end = self.word_forward(self.cursor);
        self.kill_range(self.cursor, end);
    }

    /// Emacs backward-kill-word (Alt+Backspace / Ctrl+Backspace).
    pub fn backward_kill_word(&mut self) {
        let start = self.word_backward(self.cursor);
        self.kill_range(start, self.cursor);
    }

    /// unix-word-rubout (Ctrl+W): kill the whitespace-delimited word.
    pub fn unix_word_rubout(&mut self) {
        let start = self.unix_word_backward(self.cursor);
        self.kill_range(start, self.cursor);
    }

    /// Emacs yank (Ctrl+Y): insert the most recent kill.
    pub fn yank(&mut self) {
        if let Some(s) = self.kill_ring.last().cloned() {
            self.insert_str(&s);
        }
    }

    /// Emacs transpose-chars (Ctrl+T).
    pub fn transpose_chars(&mut self) {
        let len = self.text.len();
        if len == 0 || self.text[..len].chars().count() < 2 {
            return;
        }
        // At EOL Emacs swaps the two chars before point.
        let (i, j) = if self.cursor == 0 {
            return;
        } else if self.cursor >= len {
            (
                self.prev_boundary_at(self.prev_boundary_at(len)),
                self.prev_boundary_at(len),
            )
        } else {
            (self.prev_boundary(), self.cursor)
        };
        let k = self.next_boundary_at(j);
        let a = self.text[i..j].to_string();
        let b = self.text[j..k].to_string();
        self.text
            .replace_range(i..k, &format!("{b}{a}"));
        self.cursor = k;
        self.touch();
    }

    /// First word-char boundary at/after `pos` (skips non-word chars).
    fn word_start_forward(&self, pos: usize) -> usize {
        let mut i = pos;
        while i < self.text.len() {
            let c = self.text[i..].chars().next().unwrap();
            if is_word_char(c) {
                break;
            }
            i += c.len_utf8();
        }
        i
    }

    /// Emacs transpose-words (Alt+T): drag the word before point past
    /// the word after point.
    pub fn transpose_words(&mut self) {
        // w1 = word ending at/after point (or the previous word when
        // point sits between words); w2 = the next word after it.
        let mut w1e = if self.cursor > 0
            && is_word_char(
                self.text[self.prev_boundary()..self.cursor]
                    .chars()
                    .next()
                    .unwrap(),
            ) {
            self.word_forward(self.cursor)
        } else {
            self.word_end_backward(self.cursor)
        };
        let mut w1s = self.word_backward(w1e);
        let mut w2s = self.word_start_forward(w1e);
        let mut w2e = self.word_forward(w2s);
        if w1s >= w1e && w2s < w2e {
            // BOB: no word before point — transpose the two after.
            w1s = w2s;
            w1e = w2e;
            w2s = self.word_start_forward(w1e);
            w2e = self.word_forward(w2s);
        } else if w2s >= w2e && w1s < w1e {
            // EOB: no word after point — transpose the two before.
            w2s = w1s;
            w2e = w1e;
            w1e = self.word_end_backward(w1s);
            w1s = self.word_backward(w1e);
        }
        if w1s >= w1e || w1e > w2s || w2s >= w2e {
            return;
        }
        let a = self.text[w1s..w1e].to_string();
        let mid = &self.text[w1e..w2s];
        let b = self.text[w2s..w2e].to_string();
        self.text
            .replace_range(w1s..w2e, &format!("{b}{mid}{a}"));
        self.cursor = w2e;
        self.touch();
    }

    /// Emacs upcase/downcase/capitalize-word (Alt+U / Alt+L / Alt+C).
    pub fn case_word(&mut self, case: WordCase) {
        let start = self.word_forward(self.cursor);
        // word_forward lands at the word *end*; the word starts at the
        // first word-char at/after the original cursor.
        let mut s = self.cursor;
        while s < self.text.len() {
            let c = self.text[s..].chars().next().unwrap();
            if is_word_char(c) {
                break;
            }
            s += c.len_utf8();
        }
        if s >= start {
            self.cursor = start;
            return;
        }
        let word = &self.text[s..start];
        let new: String = match case {
            WordCase::Upper => word.chars().flat_map(char::to_uppercase).collect(),
            WordCase::Lower => word.chars().flat_map(char::to_lowercase).collect(),
            WordCase::Capitalize => {
                let mut it = word.chars();
                match it.next() {
                    Some(c) => c
                        .to_uppercase()
                        .chain(it.flat_map(char::to_lowercase))
                        .collect(),
                    None => String::new(),
                }
            }
        };
        self.text.replace_range(s..start, &new);
        self.cursor = s + new.len();
        self.touch();
    }

    /// Ctrl+R: recall the previous history entry containing the
    /// in-progress text (repeating steps further back).
    pub fn history_search(&mut self) {
        if self.history.is_empty() {
            return;
        }
        let (query, start) = match self.history_idx {
            Some(i) => (self.history_stash.clone(), i),
            None => {
                self.history_stash = self.text.clone();
                (self.history_stash.clone(), self.history.len())
            }
        };
        for i in (0..start).rev() {
            if self.history[i].contains(&query) {
                self.history_idx = Some(i);
                self.text = self.history[i].clone();
                self.cursor = self.text.len();
                return;
            }
        }
    }

    /// Take the input for submission, pushing it onto history.
    pub fn take_submitted(&mut self) -> String {
        let text = std::mem::take(&mut self.text);
        self.cursor = 0;
        self.history_idx = None;
        self.history_stash.clear();
        if !text.trim().is_empty() {
            self.history.push(text.clone());
        }
        text
    }

    /// Up: recall an older history entry.
    pub fn history_up(&mut self) {
        if self.history.is_empty() {
            return;
        }
        match self.history_idx {
            None => {
                self.history_stash = self.text.clone();
                self.history_idx = Some(self.history.len() - 1);
            }
            Some(0) => return,
            Some(i) => self.history_idx = Some(i - 1),
        }
        self.text = self.history[self.history_idx.unwrap()].clone();
        self.cursor = self.text.len();
    }

    /// Down: recall a newer history entry, or restore the stash.
    pub fn history_down(&mut self) {
        let Some(i) = self.history_idx else { return };
        if i + 1 < self.history.len() {
            self.history_idx = Some(i + 1);
            self.text = self.history[i + 1].clone();
        } else {
            self.history_idx = None;
            self.text = std::mem::take(&mut self.history_stash);
        }
        self.cursor = self.text.len();
    }
}

/// Session metadata shown in the status line.
#[derive(Clone, Debug, Default)]
pub struct StatusState {
    pub model: String,
    pub thinking: String,
    pub mode: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Extra transient status (e.g. "compacting…", "retrying 2/5").
    pub transient: String,
}

/// Permission modes (RECON §9 tips: `Shift+Tab to cycle permission
/// modes`). Displayed in the status line; pi-rpc has no permission
/// command, so this is a local UI mode for now.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PermissionMode {
    #[default]
    Normal,
    AcceptEdits,
    Smart,
    Plan,
    Ask,
    Bypass,
    Autonomous,
}

impl PermissionMode {
    /// `Shift+Tab` cycles forward through the modes.
    pub fn next(self) -> Self {
        match self {
            Self::Normal => Self::AcceptEdits,
            Self::AcceptEdits => Self::Smart,
            Self::Smart => Self::Plan,
            Self::Plan => Self::Ask,
            Self::Ask => Self::Bypass,
            Self::Bypass => Self::Autonomous,
            Self::Autonomous => Self::Normal,
        }
    }

    /// Status-line label.
    pub fn label(self) -> &'static str {
        match self {
            Self::Normal => "NORMAL",
            Self::AcceptEdits => "ACCEPT EDITS",
            Self::Smart => "SMART",
            Self::Plan => "PLAN",
            Self::Ask => "ASK",
            Self::Bypass => "BYPASS",
            Self::Autonomous => "AUTONOMOUS",
        }
    }
}

/// A transient notification (`notify` extension UI request).
#[derive(Clone, Debug)]
pub struct Toast {
    pub text: String,
    /// Remaining app ticks before auto-dismiss.
    pub ticks_left: u64,
}

/// The active extension-UI dialog (one at a time; extras queue).
#[derive(Clone, Debug)]
pub enum DialogState {
    Select {
        id: String,
        sel: SelectState,
    },
    Confirm {
        id: String,
        title: String,
        message: String,
    },
    Input {
        id: String,
        title: String,
        placeholder: Option<String>,
        input: InputState,
    },
    Editor {
        id: String,
        title: String,
        input: InputState,
    },
    /// A locally-opened picker (model / thinking level). Resolving it
    /// dispatches a local action instead of an `extension_ui_response`.
    Local {
        sel: SelectState,
        action: LocalAction,
    },
    /// A plugin overlay (`method:"custom"`). `driver:Plugin` streams frames
    /// and consumes `extension_ui_event` input; `driver:Client` renders the
    /// spec's declarative fields (P3) and resolves with a response.
    Plugin {
        id: String,
        spec: OverlaySpec,
        driver: OverlayDriver,
        /// Latest body frame (plugin-driven); empty until the first
        /// `overlay_frame` arrives.
        frame: Frame,
        /// Optional cursor cell (row, col) inside the body.
        cursor: Option<(u16, u16)>,
    },
}

/// What a resolved `DialogState::Local` should do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalAction {
    /// Send `set_model` for the selected entry in `state.models`.
    SetModel,
    /// Send `set_thinking_level` for the selected level.
    SetThinking,
    /// Toggle the boolean setting at the selected row (stays open).
    ToggleSetting,
}

/// `/settings` — local boolean toggles (RECON §12.5 config keys).
/// Values are display-only unless the app wires them (show_tips is).
pub const SETTINGS_KEYS: [&str; 8] = [
    "subagents_enabled",
    "show_tips",
    "mouse_capture",
    "symbol_mode",
    "theme_auto_detect",
    "include_gitignored_in_mentions",
    "show_cwd_in_input_border",
    "startup_tips_remaining",
];

/// Side effects `apply_response` asks the app to perform (it can't send
/// RPCs or touch the clipboard itself).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum ResponseEffect {
    #[default]
    None,
    /// Re-pull `get_state` (model/thinking/session changed).
    RefreshState,
    /// Copy this text to the clipboard.
    CopyToClipboard(String),
}

impl DialogState {
    /// The request id this dialog answers (extension dialogs only).
    pub fn id(&self) -> &str {
        match self {
            Self::Select { id, .. }
            | Self::Confirm { id, .. }
            | Self::Input { id, .. }
            | Self::Editor { id, .. } => id,
            Self::Plugin { id, .. } => id,
            Self::Local { .. } => "",
        }
    }

    /// True for locally-opened pickers (no `extension_ui_response`).
    pub fn is_local(&self) -> bool {
        matches!(self, Self::Local { .. })
    }
}

/// Compact one-line rendering of a `data` payload for system lines:
/// `k=v` pairs for scalars, JSON for the rest.
fn compact_json(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Object(map) => map
            .iter()
            .map(|(k, val)| match val {
                serde_json::Value::String(s) => format!("{k}={s}"),
                serde_json::Value::Number(_) | serde_json::Value::Bool(_) => {
                    format!("{k}={val}")
                }
                _ => format!("{k}={val}"),
            })
            .collect::<Vec<_>>()
            .join(" "),
        other => other.to_string(),
    }
}

/// One row in the subagent tray (RECON §12.2).
#[derive(Clone, Debug)]
pub struct TrayEntry {
    /// Which tab this entry lists under.
    pub kind: TrayKind,
    /// Display title (prompt/description/command from tool args).
    pub title: String,
    /// Spawning tool name (`task`, `bash`, …).
    pub tool: String,
    /// Model id at spawn time (status.model snapshot).
    pub model: String,
    /// Lifecycle status.
    pub status: TrayStatus,
    /// Nested tool executions observed while this entry ran.
    pub tools: u32,
    /// Recent nested tools `(name, target)` (≤6, newest last) —
    /// preview panel + subagent card activity feed.
    pub recent_tools: Vec<(String, String)>,
    /// App tick at `tool_execution_start`.
    pub start_tick: u64,
    /// App tick at `tool_execution_end` (None while running).
    pub end_tick: Option<u64>,
    /// Index into `messages` of the tool card (for `view`).
    pub msg_idx: usize,
    /// Devin `subagent/mode`: foregrounded entries stream their nested
    /// tool cards into the main scrollback; backgrounded ones hide them
    /// until the entry finishes. Shells default to background.
    pub foregrounded: bool,
}

/// Tray tab an entry belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayKind {
    Subagent,
    Shell,
}

/// Lifecycle status of a tray entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayStatus {
    Running,
    Done,
    Failed,
    Cancelled,
}

/// The three tray tabs (RECON §12.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayTab {
    Subagents,
    Cloud,
    Shells,
}

impl TrayTab {
    pub fn next(self) -> Self {
        match self {
            Self::Subagents => Self::Cloud,
            Self::Cloud => Self::Shells,
            Self::Shells => Self::Subagents,
        }
    }

    pub fn prev(self) -> Self {
        match self {
            Self::Subagents => Self::Shells,
            Self::Cloud => Self::Subagents,
            Self::Shells => Self::Cloud,
        }
    }

    pub fn label(self, shells: usize) -> String {
        match self {
            Self::Subagents => "Subagents".to_string(),
            Self::Cloud => "Cloud agents".to_string(),
            Self::Shells => format!("Shells ({shells})"),
        }
    }
}

/// Subagent/shell tray panel state (RECON §12.2 `TrayContent`).
#[derive(Clone, Debug, Default)]
pub struct TrayState {
    /// Panel visible (F2 toggles).
    pub open: bool,
    /// Active tab.
    pub tab: TrayTab,
    /// Cursor row within `visible()`.
    pub cursor: usize,
    /// All tracked entries (oldest → newest).
    pub entries: Vec<TrayEntry>,
}

impl Default for TrayTab {
    fn default() -> Self {
        TrayTab::Subagents
    }
}

impl TrayState {
    /// Entry indexes visible under the active tab.
    pub fn visible(&self) -> Vec<usize> {
        self.entries
            .iter()
            .enumerate()
            .filter(|(_, e)| match self.tab {
                TrayTab::Subagents => e.kind == TrayKind::Subagent,
                TrayTab::Cloud => false,
                TrayTab::Shells => e.kind == TrayKind::Shell,
            })
            .map(|(i, _)| i)
            .collect()
    }

    /// The selected entry index (into `entries`).
    pub fn selected(&self) -> Option<usize> {
        self.visible().get(self.cursor).copied()
    }

    pub fn move_up(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    pub fn move_down(&mut self) {
        let n = self.visible().len();
        if n > 0 {
            self.cursor = (self.cursor + 1).min(n - 1);
        }
    }

    /// Switch tab; cursor resets to the first row.
    pub fn set_tab(&mut self, tab: TrayTab) {
        self.tab = tab;
        self.cursor = 0;
    }

    /// Most recent still-running entry index.
    fn last_running(&self) -> Option<usize> {
        self.entries
            .iter()
            .rposition(|e| e.status == TrayStatus::Running)
    }

}

/// Classify a tool call as a tray entry: `bash` with `background:true`
/// is a shell; `task`/`agent`/`subagent`/`teammate`-named tools are
/// subagents. Everything else is a normal tool.
pub fn tray_kind(tool_name: &str, args: &serde_json::Value) -> Option<TrayKind> {
    let n = tool_name.to_ascii_lowercase();
    if n == "bash" || n == "shell" {
        if args.get("background").and_then(|v| v.as_bool()) == Some(true) {
            return Some(TrayKind::Shell);
        }
        return None;
    }
    if n == "task"
        || n == "agent"
        || n == "subagent"
        || n == "teammate"
        || n.contains("subagent")
        || n.ends_with("_agent")
        || n.ends_with("_task")
    {
        return Some(TrayKind::Subagent);
    }
    None
}

/// Display title for a tray entry: `description`/`prompt`/`command`/
/// `name` arg, else the tool name. First line, truncated to 48 chars.
fn tray_title(tool_name: &str, args: &serde_json::Value) -> String {
    for key in ["description", "prompt", "command", "name", "task"] {
        if let Some(s) = args.get(key).and_then(|v| v.as_str()) {
            let first = s.lines().next().unwrap_or("").trim();
            if !first.is_empty() {
                return first.chars().take(48).collect();
            }
        }
    }
    tool_name.to_string()
}

/// What the completion popup is completing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompletionKind {
    /// `/cmd` — slash commands.
    Command,
    /// `@path` — file mentions.
    File,
}

/// One completion row: `name` is what accept inserts, `display` is
/// the rendered label (may include usage args), `desc` the right column.
#[derive(Clone, Debug)]
pub struct CompletionItem {
    pub name: String,
    pub display: String,
    pub desc: String,
}

/// `/`/`@` completion popup state (native pi TUI autocomplete;
/// Devin `completion` keymap context: next/prev/accept/close).
#[derive(Clone, Debug, Default)]
pub struct CompletionState {
    /// Filtered items.
    pub items: Vec<CompletionItem>,
    /// Highlighted row.
    pub cursor: usize,
    /// What is being completed.
    pub kind: CompletionKind,
    /// Byte index where the completed token starts (the `/` or `@`).
    pub token_start: usize,
}

impl Default for CompletionKind {
    fn default() -> Self {
        CompletionKind::Command
    }
}

impl CompletionState {
    pub fn next(&mut self) {
        if !self.items.is_empty() {
            self.cursor = (self.cursor + 1) % self.items.len();
        }
    }

    pub fn prev(&mut self) {
        if !self.items.is_empty() {
            self.cursor = self
                .cursor
                .checked_sub(1)
                .unwrap_or(self.items.len() - 1);
        }
    }
}

/// A pasted image awaiting the next prompt (Ctrl+V).
#[derive(Clone, Debug)]
pub struct Attachment {
    /// Base64-encoded PNG.
    pub data: String,
    /// Always `image/png` for clipboard pastes.
    pub mime: String,
    /// Short label for the input hint (`image 1`).
    pub label: String,
}

/// Root application state.
#[derive(Default)]
pub struct AppState {
    pub messages: Vec<Message>,
    pub input: InputState,
    pub status: StatusState,
    /// True while the agent is streaming a response.
    pub streaming: bool,
    /// Message-list scroll offset in cells (0 = top).
    pub scroll: u32,
    /// Follow the tail when new content arrives.
    pub follow_tail: bool,
    /// Active extension-UI dialog (select/confirm/input/editor).
    pub dialog: Option<DialogState>,
    /// Queued interactive UI requests behind the active dialog.
    pub pending_ui: VecDeque<RpcExtensionUIRequest>,
    /// Completed dialog responses awaiting `respond_ui` on the wire.
    pub dialog_result: Option<RpcExtensionUIResponse>,
    /// Transient `notify` toasts.
    pub toasts: Vec<Toast>,
    /// `setWidget` lines, keyed by widget key (insertion order kept).
    pub widgets: Vec<(String, Vec<String>)>,
    /// Pending terminal title (`setTitle`) — emitted as OSC on next frame.
    pub term_title: Option<String>,
    /// Permission mode (Shift+Tab cycles).
    pub permission: PermissionMode,
    /// Glyph table (unicode/ASCII).
    pub glyphs: GlyphMode,
    /// App tick counter (33ms) — drives spinner/toasts.
    pub tick: u64,
    /// Full message-list rebuild requested (Ctrl+L clear, etc).
    pub needs_rebuild: bool,
    /// Set when the user asked to quit.
    pub quit: bool,
    /// Dirty flag: DOM needs a rebuild/patch before next paint.
    pub dom_dirty: bool,
    /// Cached `get_available_models` result (model picker + `/model <id>`
    /// provider lookup).
    pub models: Vec<Model>,
    /// Cached `get_available_thinking_levels` result.
    pub thinking_levels: Vec<ThinkingLevel>,
    /// `/settings` boolean toggles (key → on).
    pub settings: std::collections::HashMap<String, bool>,
    /// pi-reported slash commands (name, "desc (source)") merged into
    /// the `/` completion list; filled by `get_commands`.
    pub pi_commands: Vec<(String, String)>,
    /// Suppress `get_commands` system lines for the background fetch
    /// (startup + completion refresh); `/help` prints them instead.
    pub commands_quiet: bool,
    /// Active `/`/`@` completion popup (None when closed).
    pub completion: Option<CompletionState>,
    /// Pasted images attached to the next prompt (Ctrl+V).
    pub attachments: Vec<Attachment>,
    /// Selected attachment index (attachment_selection context).
    pub attachment_sel: Option<usize>,
    /// Queued messages while streaming (`queue_update` event).
    pub queued: Vec<String>,
    /// Lazily-built file index for `@` completion (cwd-relative paths).
    /// `None` = not built yet; `Some` may be empty.
    pub file_index: Option<Vec<String>>,
    /// Subagent/shell tray panel (F2).
    pub tray: TrayState,
    /// Rotating input-hint tip index (RECON §9 tips).
    pub tip_idx: usize,
    /// Startup banner (`WelcomeBox`) still showing; hidden after the
    /// first submitted prompt.
    pub banner_visible: bool,
    /// DOM node id of the banner element (owned by message_list::sync).
    pub banner_node: Option<blitz_dom::NodeId>,
    /// Message index the action bar is attached to (last assistant).
    pub action_bar_idx: Option<usize>,
    /// DOM node id of the action bar element.
    pub action_bar_node: Option<blitz_dom::NodeId>,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            follow_tail: true,
            dom_dirty: true,
            glyphs: GlyphMode::detect(),
            banner_visible: true,
            settings: SETTINGS_KEYS
                .iter()
                .map(|k| (k.to_string(), true))
                .collect(),
            ..Default::default()
        }
    }

    /// `show_tips` setting (drives the rotating input hint).
    pub fn show_tips(&self) -> bool {
        self.settings.get("show_tips").copied().unwrap_or(true)
    }

    /// Advance the tick: spinner frames + toast lifetimes + tip
    /// rotation (~10s per tip while the input is empty).
    /// Returns `true` when a repaint is needed.
    pub fn tick_frame(&mut self) -> bool {
        self.tick += 1;
        let mut dirty = self.streaming;
        if self.input.text.is_empty() && self.show_tips() && self.tick % 300 == 0 {
            self.tip_idx = (self.tip_idx + 1) % crate::components::input_box::TIPS.len();
            dirty = true;
        }
        if !self.toasts.is_empty() {
            dirty = true;
            for t in &mut self.toasts {
                t.ticks_left = t.ticks_left.saturating_sub(1);
            }
            self.toasts.retain(|t| t.ticks_left > 0);
        }
        dirty
    }

    /// Push a message and mark the DOM dirty.
    pub fn push(&mut self, msg: Message) {
        self.messages.push(msg);
        self.dom_dirty = true;
    }

    pub fn push_user(&mut self, text: impl Into<String>) {
        // First real prompt dismisses the startup banner.
        self.banner_visible = false;
        self.push(Message::new(MsgKind::User, text));
    }

    pub fn push_system(&mut self, text: impl Into<String>) {
        self.push(Message::new(MsgKind::System, text));
    }

    /// Append text to the last message of `kind`, or start a new one.
    /// Returns the index of the message that received the text.
    fn append_to_last(&mut self, kind: MsgKind, delta: &str) -> usize {
        match self.messages.last_mut() {
            Some(m) if m.kind == kind && !m.sealed => {
                m.text.push_str(delta);
                self.messages.len() - 1
            }
            _ => {
                self.messages.push(Message::new(kind, delta));
                self.messages.len() - 1
            }
        }
    }

    /// Reduce one `RpcEvent` into state. Returns `true` when the DOM needs
    /// updating.
    pub fn apply_event(&mut self, event: &RpcEvent) -> bool {
        match event {
            RpcEvent::Agent(e) => self.apply_agent(e),
            RpcEvent::ExtensionUiRequest(req) => {
                self.open_ui(req);
                true
            }
            RpcEvent::StderrLine(line) => {
                // Surface pi stderr as a system line only when it looks like
                // an error (avoid noise).
                let l = line.to_lowercase();
                if l.contains("error") || l.contains("panic") || l.contains("fatal") {
                    self.push_system(format!("pi: {line}"));
                    true
                } else {
                    false
                }
            }
            RpcEvent::Response(_) | RpcEvent::Other(_) => false,
        }
    }

    fn apply_agent(&mut self, e: &AgentEvent) -> bool {
        match e {
            AgentEvent::AgentStart => {
                self.streaming = true;
                self.status.transient.clear();
                true
            }
            AgentEvent::MessageUpdate { usage, .. } => {
                if let Some(u) = usage {
                    self.status.input_tokens = u.input as u64;
                    self.status.output_tokens = u.output as u64;
                }
                if let Some(d) = text_delta(e) {
                    self.append_to_last(MsgKind::Assistant, d);
                    self.dom_dirty = true;
                } else if let Some(d) = thinking_delta(e) {
                    self.append_to_last(MsgKind::Thinking, d);
                    self.dom_dirty = true;
                } else {
                    // Other assistant sub-events (toolcall_*, text_start/end)
                    // don't change visible state.
                    match &e {
                        AgentEvent::MessageUpdate {
                            assistant_message_event: AssistantMessageEvent::Error { .. },
                            ..
                        } => {
                            self.push(Message::new(MsgKind::Error, "assistant stream error"));
                        }
                        _ => {}
                    }
                }
                true
            }
            AgentEvent::ToolExecutionStart {
                tool_call_id,
                tool_name,
                args,
                ..
            } => {
                // Tray: a tray tool opens a new entry; any other tool
                // started while one runs counts as a nested tool.
                let mut tray_idx = None;
                let mut nested_under = None;
                match tray_kind(tool_name, args) {
                    Some(kind) => {
                        tray_idx = Some(self.tray.entries.len());
                        // Devin: `background:true` spawns start hidden;
                        // interactive subagents stream in the foreground.
                        let background = args
                            .get("background")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(kind == TrayKind::Shell);
                        self.tray.entries.push(TrayEntry {
                            kind,
                            title: tray_title(tool_name, args),
                            tool: tool_name.clone(),
                            model: self.status.model.clone(),
                            status: TrayStatus::Running,
                            tools: 0,
                            recent_tools: Vec::new(),
                            start_tick: self.tick,
                            end_tick: None,
                            msg_idx: self.messages.len(),
                            foregrounded: !background,
                        });
                    }
                    None => {
                        if let Some(i) = self.tray.last_running() {
                            nested_under = Some(i);
                            let e = &mut self.tray.entries[i];
                            e.tools += 1;
                            e.recent_tools.push((
                                tool_name.clone(),
                                crate::components::tool_card::tool_target(args),
                            ));
                            if e.recent_tools.len() > 6 {
                                e.recent_tools.remove(0);
                            }
                            // Refresh the parent card's activity feed.
                            if let Some(pm) = self.messages.get_mut(e.msg_idx) {
                                pm.dirty = true;
                            }
                        }
                    }
                }
                let mut m = Message::new(MsgKind::Tool, summarize_args(args));
                m.tool_name = Some(tool_name.clone());
                m.tool_call_id = Some(tool_call_id.clone());
                m.tool_status = Some('●');
                m.tool_args = Some(args.clone());
                m.tray_entry = tray_idx;
                m.nested_under = nested_under;
                self.push(m);
                true
            }
            AgentEvent::ToolExecutionUpdate {
                tool_call_id,
                tool_name,
                partial_result,
                ..
            } => {
                // Partial result → live tail window in the card body.
                // Match by tool_call_id — nested tools interleave.
                let partial_out = full_text(partial_result);
                let idx = self
                    .messages
                    .iter()
                    .rposition(|m| {
                        m.kind == MsgKind::Tool
                            && m.tool_call_id.as_deref() == Some(tool_call_id)
                    })
                    .or_else(|| {
                        self.messages
                            .iter()
                            .rposition(|m| m.kind == MsgKind::Tool)
                    });
                if let Some(i) = idx {
                    let m = &mut self.messages[i];
                    m.tool_name = Some(tool_name.clone());
                    if !partial_out.is_empty() {
                        m.tool_output = Some(partial_out);
                    }
                    m.dirty = true;
                    self.dom_dirty = true;
                }
                true
            }
            AgentEvent::ToolExecutionEnd {
                tool_call_id,
                tool_name,
                result,
                is_error,
            } => {
                // Tray: close the newest running entry with this tool.
                if let Some(i) = self
                    .tray
                    .entries
                    .iter()
                    .rposition(|e| {
                        e.status == TrayStatus::Running && e.tool == *tool_name
                    })
                {
                    let e = &mut self.tray.entries[i];
                    e.status = if *is_error {
                        TrayStatus::Failed
                    } else {
                        TrayStatus::Done
                    };
                    e.end_tick = Some(self.tick);
                    // Backgrounded entries reveal their nested cards on
                    // finish ("user will not see output until you finish").
                    if !e.foregrounded {
                        self.needs_rebuild = true;
                    }
                }
                let status = if *is_error { '✗' } else { '✓' };
                let output = full_text(result);
                let exit = extract_exit_code(result);
                // Match the card by tool_call_id (nested tools interleave).
                if let Some(m) = self
                    .messages
                    .iter_mut()
                    .rev()
                    .find(|m| {
                        m.kind == MsgKind::Tool
                            && m.tool_call_id.as_deref() == Some(tool_call_id)
                    })
                {
                    m.tool_status = Some(status);
                    m.tool_name = Some(tool_name.clone());
                    m.tool_exit = exit;
                    if m.text.is_empty() {
                        m.text = summarize_args(result);
                    }
                    if !output.is_empty() {
                        m.tool_output = Some(output);
                    }
                    let args = m.tool_args.clone().unwrap_or(serde_json::Value::Null);
                    m.tool_lang = crate::components::tool_card::detect_lang(
                        tool_name,
                        &args,
                        result,
                    );
                    m.dirty = true;
                    self.dom_dirty = true;
                    return true;
                }
                let mut m = Message::new(MsgKind::Tool, summarize_args(result));
                m.tool_name = Some(tool_name.clone());
                m.tool_call_id = Some(tool_call_id.clone());
                m.tool_status = Some(status);
                m.tool_exit = exit;
                if !output.is_empty() {
                    m.tool_output = Some(output);
                }
                m.tool_lang = crate::components::tool_card::detect_lang(
                    tool_name,
                    &serde_json::Value::Null,
                    result,
                );
                self.push(m);
                true
            }
            AgentEvent::TurnEnd { .. } => {
                // Finalize the streaming bubble: seal it so the next turn's
                // deltas start a fresh bubble instead of appending.
                if let Some(m) = self.messages.last_mut() {
                    if matches!(m.kind, MsgKind::Assistant | MsgKind::Thinking) {
                        m.sealed = true;
                        // Thinking collapses to a preview once sealed.
                        if m.kind == MsgKind::Thinking {
                            m.dirty = true;
                            self.dom_dirty = true;
                        }
                    }
                }
                false
            }
            AgentEvent::MessageEnd { message } => {
                // If the final assistant message carries usage, update tokens.
                if let AgentMessage::Assistant { usage, .. } = message {
                    self.status.input_tokens = usage.input as u64;
                    self.status.output_tokens = usage.output as u64;
                }
                false
            }
            AgentEvent::AgentEnd { .. } | AgentEvent::AgentSettled => {
                self.streaming = false;
                self.status.transient.clear();
                true
            }
            AgentEvent::CompactionStart { reason } => {
                self.status.transient = format!("compacting ({reason})");
                true
            }
            AgentEvent::CompactionEnd { .. } => {
                self.status.transient.clear();
                true
            }
            AgentEvent::AutoRetryStart {
                attempt,
                max_attempts,
                error_message,
                ..
            } => {
                self.status.transient =
                    format!("retry {attempt}/{max_attempts}: {error_message}");
                true
            }
            AgentEvent::AutoRetryEnd { success, .. } => {
                self.status.transient.clear();
                if !success {
                    self.push(Message::new(MsgKind::Error, "auto-retry exhausted"));
                }
                true
            }
            AgentEvent::ThinkingLevelChanged { level } => {
                self.status.thinking = format!("{level:?}").to_lowercase();
                true
            }
            AgentEvent::BashExecutionUpdate { delta, .. } => {
                // Stream into the card body (sliding tail window), not
                // the header text.
                match self.messages.last_mut() {
                    Some(m) if m.kind == MsgKind::Tool => {
                        m.tool_output
                            .get_or_insert_with(String::new)
                            .push_str(delta);
                        m.dirty = true;
                    }
                    _ => {
                        let mut m = Message::new(MsgKind::Tool, "");
                        m.tool_output = Some(delta.to_string());
                        m.tool_status = Some('●');
                        self.push(m);
                    }
                }
                self.dom_dirty = true;
                true
            }
            AgentEvent::QueueUpdate {
                steering,
                follow_up,
            } => {
                self.queued = steering
                    .iter()
                    .chain(follow_up.iter())
                    .cloned()
                    .collect();
                true
            }
            _ => is_run_end(e),
        }
    }

    /// Reduce one `extension_ui_request`: interactive methods open a
    /// dialog (or queue behind the active one); notifications update
    /// toasts / status / widgets / title / editor text directly.
    fn open_ui(&mut self, req: &RpcExtensionUIRequest) {
        match req {
            RpcExtensionUIRequest::Select {
                id, title, options, ..
            } => {
                if self.dialog.is_some() {
                    self.pending_ui.push_back(req.clone());
                } else {
                    self.dialog = Some(DialogState::Select {
                        id: id.clone(),
                        sel: SelectState::new(title.clone(), options.clone()),
                    });
                }
            }
            RpcExtensionUIRequest::Confirm {
                id, title, message, ..
            } => {
                if self.dialog.is_some() {
                    self.pending_ui.push_back(req.clone());
                } else {
                    self.dialog = Some(DialogState::Confirm {
                        id: id.clone(),
                        title: title.clone(),
                        message: message.clone(),
                    });
                }
            }
            RpcExtensionUIRequest::Input {
                id,
                title,
                placeholder,
                ..
            } => {
                if self.dialog.is_some() {
                    self.pending_ui.push_back(req.clone());
                } else {
                    self.dialog = Some(DialogState::Input {
                        id: id.clone(),
                        title: title.clone(),
                        placeholder: placeholder.clone(),
                        input: InputState::default(),
                    });
                }
            }
            RpcExtensionUIRequest::Editor { id, title, prefill } => {
                if self.dialog.is_some() {
                    self.pending_ui.push_back(req.clone());
                } else {
                    let mut input = InputState::default();
                    if let Some(p) = prefill {
                        input.insert_str(p);
                    }
                    self.dialog = Some(DialogState::Editor {
                        id: id.clone(),
                        title: title.clone(),
                        input,
                    });
                }
            }
            RpcExtensionUIRequest::Notify {
                message, notify_type, ..
            } => {
                let text = match notify_type.as_deref() {
                    Some(t) if !t.is_empty() => format!("{t}: {message}"),
                    _ => message.clone(),
                };
                self.toasts.push(Toast {
                    text,
                    ticks_left: crate::components::dialog::TOAST_TICKS,
                });
            }
            RpcExtensionUIRequest::SetStatus {
                status_key,
                status_text,
                ..
            } => {
                let _ = status_key;
                self.status.transient = status_text.clone().unwrap_or_default();
            }
            RpcExtensionUIRequest::SetWidget {
                widget_key,
                widget_lines,
                ..
            } => {
                match widget_lines {
                    Some(lines) => {
                        if let Some(slot) = self
                            .widgets
                            .iter_mut()
                            .find(|(k, _)| k == widget_key)
                        {
                            slot.1 = lines.clone();
                        } else {
                            self.widgets.push((widget_key.clone(), lines.clone()));
                        }
                    }
                    None => self.widgets.retain(|(k, _)| k != widget_key),
                }
            }
            RpcExtensionUIRequest::SetTitle { title, .. } => {
                self.term_title = Some(title.clone());
            }
            RpcExtensionUIRequest::SetEditorText { text, .. } => {
                self.input.text = text.clone();
                self.input.cursor = text.len();
            }
            RpcExtensionUIRequest::Custom { id, driver, spec } => {
                if self.dialog.is_some() {
                    self.pending_ui.push_back(req.clone());
                } else {
                    self.dialog = Some(DialogState::Plugin {
                        id: id.clone(),
                        spec: spec.clone(),
                        driver: *driver,
                        frame: Vec::new(),
                        cursor: None,
                    });
                }
            }
            RpcExtensionUIRequest::OverlayFrame { id, frame, cursor } => {
                // Frames only apply to the surface they were opened under;
                // a stale id (overlay already closed) is dropped.
                if let Some(DialogState::Plugin {
                    id: active,
                    frame: slot,
                    cursor: cur,
                    ..
                }) = &mut self.dialog
                {
                    if active == id {
                        *slot = frame.clone();
                        *cur = *cursor;
                    }
                }
            }
            RpcExtensionUIRequest::OverlayClose { id } => {
                if let Some(d) = &self.dialog {
                    if d.id() == id {
                        match d {
                            // Agent-driven close of a client-driven overlay:
                            // unblock the pending request with a cancel.
                            DialogState::Plugin {
                                driver: OverlayDriver::Client,
                                id,
                                ..
                            } => {
                                let id = id.clone();
                                self.resolve_dialog(RpcExtensionUIResponse::Cancelled {
                                    id,
                                    cancelled: true,
                                });
                            }
                            // Plugin-driven close: free the surface, promote
                            // the queue, no response is owed.
                            DialogState::Plugin { .. } => {
                                self.dialog = None;
                                self.promote_pending_ui();
                            }
                            _ => {}
                        }
                    }
                }
            }
            RpcExtensionUIRequest::Unknown(v) => {
                self.push_system(format!(
                    "ui request: {} ({})",
                    v.get("method").and_then(|m| m.as_str()).unwrap_or("?"),
                    req.id()
                ));
            }
        }
        self.dom_dirty = true;
    }

    /// Resolve the active dialog with `resp` (queued for `respond_ui`),
    /// then promote the next queued interactive request if any.
    pub fn resolve_dialog(&mut self, resp: RpcExtensionUIResponse) {
        self.dialog = None;
        self.dialog_result = Some(resp);
        self.promote_pending_ui();
    }

    /// Promote queued UI requests after the modal surface frees up: apply
    /// fire-and-forget requests inline, stop at the next surface-occupying
    /// one (interactive dialog or plugin overlay).
    fn promote_pending_ui(&mut self) {
        while let Some(next) = self.pending_ui.pop_front() {
            if next.occupies_surface() {
                self.open_ui(&next);
                break;
            }
            // Non-interactive requests queued behind a dialog still apply.
            self.open_ui(&next);
        }
        self.dom_dirty = true;
    }

    /// Cancel the active dialog (Esc) — extension dialogs respond
    /// `cancelled:true`; local pickers just close.
    pub fn cancel_dialog(&mut self) {
        match &self.dialog {
            Some(DialogState::Local { .. }) => {
                self.dialog = None;
                self.dom_dirty = true;
            }
            // Plugin-driven overlays owe no response; the dismissal is
            // reported to the plugin as an `extension_ui_event` by the app.
            Some(DialogState::Plugin {
                driver: OverlayDriver::Plugin,
                ..
            }) => {
                self.dialog = None;
                self.promote_pending_ui();
            }
            Some(d) => {
                let id = d.id().to_string();
                self.resolve_dialog(RpcExtensionUIResponse::Cancelled {
                    id,
                    cancelled: true,
                });
            }
            None => {}
        }
    }

    /// Reduce one command `RpcResponse` into state. Returns the side
    /// effect the app must perform (state refresh, clipboard write).
    /// Failure responses become system lines here too.
    pub fn apply_response(&mut self, resp: &RpcResponse) -> ResponseEffect {
        if !resp.success {
            self.push_system(format!(
                "{} failed: {}",
                resp.command,
                resp.error.as_deref().unwrap_or("unknown error")
            ));
            return ResponseEffect::None;
        }
        match resp.command.as_str() {
            "set_model" => {
                if let Some(m) = resp.model_data() {
                    self.status.model = m.id.clone();
                    self.push_system(format!("model → {}", m.id));
                }
                ResponseEffect::RefreshState
            }
            "cycle_model" => match resp.cycle_model_data() {
                Some((m, level)) => {
                    self.status.model = m.id.clone();
                    self.status.thinking = format!("{level:?}").to_lowercase();
                    self.push_system(format!("model → {}", m.id));
                    ResponseEffect::RefreshState
                }
                None => {
                    self.push_system("cycle_model: no other scoped model");
                    ResponseEffect::None
                }
            },
            "set_thinking_level" => ResponseEffect::RefreshState,
            "cycle_thinking_level" => match resp.cycle_thinking_level() {
                Some(l) => {
                    self.status.thinking = format!("{l:?}").to_lowercase();
                    ResponseEffect::RefreshState
                }
                None => ResponseEffect::None,
            },
            "get_available_models" => {
                if let Some(models) = resp.available_models() {
                    self.models = models;
                    self.open_local_select(LocalAction::SetModel);
                }
                ResponseEffect::None
            }
            "get_available_thinking_levels" => {
                if let Some(levels) = resp.available_thinking_levels() {
                    self.thinking_levels = levels;
                    self.open_local_select(LocalAction::SetThinking);
                }
                ResponseEffect::None
            }
            "new_session" | "switch_session" | "clone" => {
                if resp.cancelled() {
                    self.push_system(format!("{} cancelled", resp.command));
                    ResponseEffect::None
                } else {
                    self.clear_messages();
                    self.push_system(format!("{}: fresh session", resp.command));
                    ResponseEffect::RefreshState
                }
            }
            "compact" => {
                self.push_system("session compacted");
                ResponseEffect::RefreshState
            }
            "get_session_stats" => {
                let line = resp
                    .data
                    .as_ref()
                    .map(|d| format!("session stats: {}", compact_json(d)))
                    .unwrap_or_else(|| "session stats: (none)".to_string());
                self.push_system(line);
                ResponseEffect::None
            }
            "export_html" => match resp.export_path() {
                Some(p) => {
                    self.push_system(format!("exported → {p}"));
                    ResponseEffect::None
                }
                None => ResponseEffect::None,
            },
            "set_session_name" => {
                self.push_system("session renamed");
                ResponseEffect::None
            }
            "get_last_assistant_text" => match resp.last_assistant_text() {
                Some(t) if !t.is_empty() => ResponseEffect::CopyToClipboard(t),
                _ => {
                    self.push_system("nothing to copy");
                    ResponseEffect::None
                }
            },
            "get_commands" => {
                if let Some(cmds) = resp.slash_commands() {
                    self.pi_commands = cmds
                        .iter()
                        .map(|c| {
                            let desc = c.description.as_deref().unwrap_or("");
                            (c.name.clone(), format!("{desc} ({})", c.source))
                        })
                        .collect();
                    if self.commands_quiet {
                        self.commands_quiet = false;
                    } else {
                        let lines: Vec<String> = self
                            .pi_commands
                            .iter()
                            .map(|(name, desc)| format!("/{name} — {desc}"))
                            .collect();
                        for line in lines {
                            self.push_system(line);
                        }
                    }
                }
                ResponseEffect::None
            }
            _ => ResponseEffect::None,
        }
    }

    /// Open a local picker for `action` from the cached lists.
    pub fn open_local_select(&mut self, action: LocalAction) {
        let sel = match action {
            LocalAction::SetModel => {
                if self.models.is_empty() {
                    self.push_system("no models reported by pi");
                    return;
                }
                crate::components::select::model_picker(
                    "select model",
                    &self.models,
                    &self.status.model,
                    self.status.input_tokens,
                )
            }
            LocalAction::SetThinking => {
                if self.thinking_levels.is_empty() {
                    self.push_system("no thinking levels reported by pi");
                    return;
                }
                crate::components::select::thinking_picker(
                    "thinking level",
                    &self.thinking_levels,
                )
            }
            LocalAction::ToggleSetting => {
                let options = SETTINGS_KEYS
                    .iter()
                    .map(|k| {
                        let on = self.settings.get(*k).copied().unwrap_or(true);
                        format!("{k}: {}", if on { "on" } else { "off" })
                    })
                    .collect();
                crate::components::select::SelectState::new("settings", options)
            }
        };
        self.dialog = Some(DialogState::Local { sel, action });
        self.dom_dirty = true;
    }

    /// Full `/` completion candidates: built-ins + pi commands.
    /// `display` keeps the usage string (`/model [provider/id]`).
    pub fn command_list(&self) -> Vec<CompletionItem> {
        let mut v: Vec<CompletionItem> = crate::commands::BUILTIN_HELP
            .iter()
            .map(|(usage, desc)| {
                // "/model [provider/id]" → name "model"
                let name = usage[1..]
                    .split(char::is_whitespace)
                    .next()
                    .unwrap_or("")
                    .to_string();
                CompletionItem {
                    name,
                    display: usage.to_string(),
                    desc: desc.to_string(),
                }
            })
            .collect();
        for (name, desc) in &self.pi_commands {
            if !v.iter().any(|i| i.name == *name) {
                v.push(CompletionItem {
                    name: name.clone(),
                    display: format!("/{name}"),
                    desc: desc.clone(),
                });
            }
        }
        v
    }

    /// Recompute the completion popup from the current input.
    /// `/word` (single token) → commands; `@tok` → file mentions.
    pub fn update_completion(&mut self) {
        let upto = &self.input.text[..self.input.cursor];
        // `/cmd` — only when the slash is the first char and no
        // whitespace precedes the cursor.
        if upto.starts_with('/') && !upto[1..].contains(char::is_whitespace) {
            let prefix = upto[1..].to_lowercase();
            let items: Vec<CompletionItem> = self
                .command_list()
                .into_iter()
                .filter(|i| i.name.to_lowercase().starts_with(&prefix))
                .collect();
            self.set_completion(items, CompletionKind::Command, 0);
            return;
        }
        // `@file` — token after the last `@` before the cursor; the
        // char before `@` must be start/whitespace (not `a@b`).
        if let Some(at) = upto.rfind('@') {
            let before_ok = at == 0
                || upto[..at]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_whitespace());
            let token = &upto[at + 1..];
            if before_ok && !token.contains(char::is_whitespace) {
                let items = self.file_matches(token);
                self.set_completion(items, CompletionKind::File, at);
                return;
            }
        }
        self.completion = None;
    }

    fn set_completion(
        &mut self,
        items: Vec<CompletionItem>,
        kind: CompletionKind,
        token_start: usize,
    ) {
        if items.is_empty() {
            self.completion = None;
            return;
        }
        let keep = self
            .completion
            .as_ref()
            .filter(|c| c.kind == kind && c.token_start == token_start)
            .map(|c| c.cursor)
            .unwrap_or(0);
        self.completion = Some(CompletionState {
            cursor: keep.min(items.len() - 1),
            items,
            kind,
            token_start,
        });
    }

    /// File-index matches for an `@` token: prefix first, then
    /// substring, capped at 50.
    fn file_matches(&self, token: &str) -> Vec<CompletionItem> {
        let Some(index) = &self.file_index else {
            return Vec::new();
        };
        let t = token.to_lowercase();
        let mut prefix: Vec<&String> = Vec::new();
        let mut sub: Vec<&String> = Vec::new();
        for p in index {
            let lp = p.to_lowercase();
            if lp.starts_with(&t) {
                prefix.push(p);
            } else if lp.contains(&t) {
                sub.push(p);
            }
        }
        prefix.sort();
        sub.sort();
        prefix
            .into_iter()
            .chain(sub)
            .take(50)
            .map(|p| CompletionItem {
                name: p.clone(),
                display: format!("@{p}"),
                desc: String::new(),
            })
            .collect()
    }

    /// Accept the highlighted completion: splice the item over the
    /// token and close the popup. Returns the accepted name.
    pub fn accept_completion(&mut self) -> Option<String> {
        let c = self.completion.take()?;
        let name = c.items.get(c.cursor)?.name.clone();
        let (prefix, suffix) = match c.kind {
            CompletionKind::Command => ("/", " "),
            CompletionKind::File => ("@", " "),
        };
        let mut text = String::with_capacity(name.len() + 8);
        text.push_str(&self.input.text[..c.token_start]);
        text.push_str(prefix);
        text.push_str(&name);
        text.push_str(suffix);
        let cursor = text.len();
        text.push_str(&self.input.text[self.input.cursor..]);
        self.input.text = text;
        self.input.cursor = cursor;
        self.input.history_idx = None;
        self.dom_dirty = true;
        Some(name)
    }

    /// Clear the message list (Ctrl+L).
    pub fn clear_messages(&mut self) {
        self.messages.clear();
        self.scroll = 0;
        self.follow_tail = true;
        self.needs_rebuild = true;
        self.dom_dirty = true;
    }

    /// Toggle `expanded` on the most recent collapsible message — a
    /// tool card with output or a sealed thinking bubble (Ctrl+O).
    /// Returns `true` when a card toggled.
    pub fn toggle_last_tool(&mut self) -> bool {
        if let Some(m) = self.messages.iter_mut().rev().find(|m| {
            (m.kind == MsgKind::Tool && m.tool_output.is_some())
                || (m.kind == MsgKind::Thinking && m.sealed)
        }) {
            m.expanded = !m.expanded;
            m.dirty = true;
            self.dom_dirty = true;
            true
        } else {
            false
        }
    }

    /// Devin `subagent/foreground|background`: toggle whether the
    /// selected tray entry's nested tool cards stream into the
    /// scrollback. Returns the new foregrounded state.
    pub fn toggle_tray_foreground(&mut self) -> Option<bool> {
        let i = self.tray.selected()?;
        let e = &mut self.tray.entries[i];
        e.foregrounded = !e.foregrounded;
        self.needs_rebuild = true;
        self.dom_dirty = true;
        Some(e.foregrounded)
    }

    /// Toggle `expanded` on the collapsible message whose bubble node id
    /// is `node` (mouse click on a `data-hit-expand` region).
    pub fn toggle_tool_by_node(&mut self, node: blitz_dom::NodeId) -> bool {
        if let Some(m) = self.messages.iter_mut().find(|m| {
            (m.kind == MsgKind::Tool || m.kind == MsgKind::Thinking)
                && m.node_id == Some(node)
        }) {
            m.expanded = !m.expanded;
            m.dirty = true;
            self.dom_dirty = true;
            true
        } else {
            false
        }
    }
}

/// Extract the full display text of a tool result (for the card body).
/// Strings pass through; objects try `output`/`text`/`content` fields,
/// then pretty-printed JSON.
fn full_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        serde_json::Value::Object(map) => {
            for key in ["output", "text", "content", "stdout"] {
                if let Some(s) = map.get(key).and_then(|x| x.as_str()) {
                    return s.to_string();
                }
            }
            serde_json::to_string_pretty(v).unwrap_or_default()
        }
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}

/// Compact one-line summary of a tool args/result JSON value.
/// Extract a shell exit code from a tool result (`exit_code` /
/// `exitCode` / `code` at top level or under `details`/`result`).
fn extract_exit_code(v: &serde_json::Value) -> Option<i64> {
    for key in ["exit_code", "exitCode", "exit", "code"] {
        if let Some(n) = v.get(key).and_then(|x| x.as_i64()) {
            return Some(n);
        }
    }
    for key in ["details", "result", "output"] {
        if let Some(inner) = v.get(key) {
            if let Some(n) = extract_exit_code(inner) {
                return Some(n);
            }
        }
    }
    None
}

fn summarize_args(v: &serde_json::Value) -> String {
    let s = match v {
        serde_json::Value::String(s) => s.clone(),
        other => {
            let j = serde_json::to_string(other).unwrap_or_default();
            j
        }
    };
    // Collapse whitespace/newlines for the single-line tool entry.
    let collapsed: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX: usize = 120;
    if collapsed.chars().count() > MAX {
        let mut out: String = collapsed.chars().take(MAX - 1).collect();
        out.push('…');
        out
    } else {
        collapsed
    }
}

/// Extract displayable text from an `AgentMessage` (for `message_start`
/// dedup / history restore).
pub fn agent_message_text(msg: &AgentMessage) -> Option<(MsgKind, String)> {
    match msg {
        AgentMessage::User { content, .. } => {
            let text = match content {
                UserContent::Text(t) => t.clone(),
                UserContent::Parts(parts) => parts
                    .iter()
                    .filter_map(|p| match p {
                        MessageContent::Text { text, .. } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join(""),
            };
            Some((MsgKind::User, text))
        }
        AgentMessage::Assistant { content, .. } => {
            let text = content
                .iter()
                .filter_map(|p| match p {
                    MessageContent::Text { text, .. } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("");
            Some((MsgKind::Assistant, text))
        }
        AgentMessage::ToolResult {
            tool_name,
            is_error,
            ..
        } => Some((
            MsgKind::Tool,
            format!("{tool_name} {}", if *is_error { "✗" } else { "✓" }),
        )),
        AgentMessage::Unknown(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(text: &str, cursor: usize) -> InputState {
        InputState {
            text: text.into(),
            cursor,
            ..Default::default()
        }
    }

    #[test]
    fn word_motion() {
        let mut i = input("foo  bar_baz qux", 0);
        i.move_word_right();
        assert_eq!(i.cursor, 3);
        i.move_word_right();
        assert_eq!(i.cursor, 12);
        i.move_word_left();
        assert_eq!(i.cursor, 5);
        i.move_word_left();
        assert_eq!(i.cursor, 0);
    }

    #[test]
    fn kill_line_variants() {
        // kill_line to EOL
        let mut i = input("hello world", 5);
        i.kill_line();
        assert_eq!(i.text, "hello");
        assert_eq!(i.kill_ring, [" world"]);
        // at EOL kills the newline
        let mut i = input("ab\ncd", 2);
        i.kill_line();
        assert_eq!(i.text, "abcd");
        // backward_kill_line to BOL
        let mut i = input("ab\ncdef", 5);
        i.backward_kill_line();
        assert_eq!(i.text, "ab\nef");
        assert_eq!(i.cursor, 3);
    }

    #[test]
    fn kill_words_and_yank() {
        let mut i = input("foo bar baz", 0);
        i.kill_word();
        assert_eq!(i.text, " bar baz");
        i.kill_word();
        assert_eq!(i.text, " baz");
        assert_eq!(i.kill_ring, ["foo", " bar"]);
        i.yank();
        assert_eq!(i.text, " bar baz");
        // backward kill word
        let mut i = input("foo bar", 7);
        i.backward_kill_word();
        assert_eq!(i.text, "foo ");
        // unix word rubout stops at whitespace only
        let mut i = input("foo/bar baz", 11);
        i.unix_word_rubout();
        assert_eq!(i.text, "foo/bar ");
    }

    #[test]
    fn transpose_chars() {
        let mut i = input("ab", 1);
        i.transpose_chars();
        assert_eq!(i.text, "ba");
        assert_eq!(i.cursor, 2);
        // at EOL swaps the two before point
        let mut i = input("abc", 3);
        i.transpose_chars();
        assert_eq!(i.text, "acb");
    }

    #[test]
    fn transpose_words() {
        let mut i = input("foo bar", 4);
        i.transpose_words();
        assert_eq!(i.text, "bar foo");
        assert_eq!(i.cursor, 7);
        // cursor inside first word
        let mut i = input("foo bar", 1);
        i.transpose_words();
        assert_eq!(i.text, "bar foo");
    }

    #[test]
    fn case_words() {
        let mut i = input("foo BAR", 0);
        i.case_word(WordCase::Upper);
        assert_eq!(i.text, "FOO BAR");
        assert_eq!(i.cursor, 3);
        i.case_word(WordCase::Lower);
        assert_eq!(i.text, "FOO bar");
        let mut i = input("foo bar", 0);
        i.case_word(WordCase::Capitalize);
        assert_eq!(i.text, "Foo bar");
    }

    #[test]
    fn line_motion_multiline() {
        let mut i = input("abc\nde\nfghi", 6); // 'e' col 2 of line 2
        assert!(i.prev_line());
        assert_eq!(i.cursor, 2);
        assert!(i.next_line());
        assert_eq!(i.cursor, 6); // back to col 2 of line 2
        // clamp to shorter line
        let mut i = input("a\nbcd", 4);
        assert!(i.prev_line());
        assert_eq!(i.cursor, 1);
        // first line → false (caller falls back to history)
        let mut i = input("ab\ncd", 1);
        assert!(!i.prev_line());
        let mut i = input("ab\ncd", 4);
        assert!(!i.next_line());
    }

    #[test]
    fn history_search() {
        let mut i = input("car", 3);
        i.history = vec!["foo".into(), "cargo".into(), "bar".into(), "car2".into()];
        i.history_search();
        assert_eq!(i.text, "car2");
        i.history_search();
        assert_eq!(i.text, "cargo");
        i.history_search(); // no earlier match — stays
        assert_eq!(i.text, "cargo");
        // editing exits history mode
        i.insert_char('x');
        assert_eq!(i.history_idx, None);
    }

    #[test]
    fn home_end_are_line_based() {
        let mut i = input("ab\ncd", 4);
        i.move_home();
        assert_eq!(i.cursor, 3);
        i.move_end();
        assert_eq!(i.cursor, 5);
    }
}
