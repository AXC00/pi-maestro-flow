//! `MessageList` — the scrollable conversation area.
//!
//! DOM shape:
//! ```text
//! #messages (flex:1, overflow:hidden, data-hit-scroll)
//!   ├─ .msg.msg-user      > text
//!   ├─ .msg.msg-assistant > markdown blocks (pulldown-cmark → styled DOM)
//!   ├─ .msg.msg-thinking  > text
//!   ├─ .msg.msg-tool      > tool_card (head + truncated/diff body)
//!   └─ …
//! ```
//!
//! Incremental sync: new messages append bubbles; assistant text changes
//! re-render the markdown subtree in place; tool cards rebuild when
//! `msg.dirty` (status/output/expanded changed).

use blitz_dom::{BaseDocument, DocumentMutator, NodeId};

use crate::components::dom::{attr, div, qual, span_text};
use crate::components::{markdown, tool_card};
use crate::state::{AppState, Message, MsgKind};

/// Build the `#messages` container under `parent`.
/// Returns `(container, container)` — bubbles append directly; content
/// flows top-down and `scroll_offset` on the container scrolls it.
/// `data-hit-scroll` marks the region for mouse wheel routing.
pub fn build(m: &mut DocumentMutator<'_>, parent: NodeId) -> (NodeId, NodeId) {
    let container = div(m, parent, "");
    m.set_attribute(container, qual("id"), "messages");
    m.set_attribute(container, qual("data-hit-scroll"), "");
    (container, container)
}

/// Rebuild every message bubble under `inner` from `state.messages`.
///
/// Used for the initial build and after structural resets (Ctrl+L).
pub fn rebuild(m: &mut DocumentMutator<'_>, inner: NodeId, state: &mut AppState) {
    m.remove_and_drop_all_children(inner);
    // blitz-dom beta.2 keeps the parent's `layout_children`/`paint_children`
    // caches after dropping children; `flush_styles_to_layout` then walks
    // stale NodeIds and panics on an invalid SlotMap key. Clear them so the
    // next resolve recomputes from the (now empty) child list.
    if let Some(node) = m.doc.get_node_mut(inner) {
        node.layout_children.borrow_mut().take();
        node.paint_children.borrow_mut().take();
    }
    // Banner + action bar nodes were dropped with the children.
    state.banner_node = None;
    state.action_bar_node = None;
    state.action_bar_idx = None;
    if state.banner_visible {
        let b = crate::components::banner::render(m, inner);
        state.banner_node = Some(b);
    }
    let glyphs = state.glyphs;
    for msg in state.messages.iter_mut() {
        msg.node_id = None;
        msg.text_node_id = None;
        msg.glyph_node_id = None;
        msg.rendered_len = 0;
        msg.dirty = false;
        append_bubble(m, inner, msg, glyphs, &state.tray.entries);
    }
    state.needs_rebuild = false;
}

/// Append one `.msg` bubble for `msg`, recording node ids back into it.
fn append_bubble(m: &mut DocumentMutator<'_>, inner: NodeId, msg: &mut Message, glyphs: crate::components::glyphs::GlyphMode, tray_entries: &[crate::state::TrayEntry]) {
    let mut class = match msg.kind {
        MsgKind::User => "msg msg-user".to_string(),
        MsgKind::Assistant => "msg msg-assistant".to_string(),
        MsgKind::Thinking => "msg msg-thinking".to_string(),
        MsgKind::Tool => "msg msg-tool".to_string(),
        MsgKind::Error => "msg msg-error".to_string(),
        MsgKind::System => "msg msg-system".to_string(),
    };
    // Devin subagent/mode: nested cards of a backgrounded entry are
    // hidden until it finishes (or is foregrounded).
    if let Some(owner) = msg.nested_under {
        if let Some(e) = tray_entries.get(owner) {
            if !e.foregrounded && e.status == crate::state::TrayStatus::Running {
                class.push_str(" msg-hidden");
            }
        }
    }
    let bubble = m.create_element(qual("div"), vec![attr("class", &class)]);
    m.append_children(inner, &[bubble]);
    msg.node_id = Some(bubble);

    match msg.kind {
        MsgKind::Tool => {
            let entry = msg.tray_entry.and_then(|i| tray_entries.get(i));
            let (g, t) = tool_card::build_card(m, bubble, msg, glyphs, entry);
            msg.glyph_node_id = Some(g);
            msg.text_node_id = Some(t);
        }
        MsgKind::Assistant => {
            markdown::render(m, bubble, &msg.text);
            msg.text_node_id = None;
        }
        MsgKind::Thinking => {
            build_thinking(m, bubble, msg);
        }
        _ => {
            let t = m.create_text_node(&msg.text);
            m.append_children(bubble, &[t]);
            msg.text_node_id = Some(t);
        }
    }
    msg.rendered_len = msg.text.len();
}

/// Thinking bubble: full text while streaming; once sealed it collapses
/// to `▸ Thinking — {first line}` (click / ctrl+o expands).
fn build_thinking(m: &mut DocumentMutator<'_>, bubble: NodeId, msg: &mut Message) {
    if msg.sealed && !msg.expanded {
        let row = div(m, bubble, "thinking-collapsed");
        m.set_attribute(row, qual("data-hit-expand"), "");
        let preview: String = msg
            .text
            .lines()
            .next()
            .unwrap_or("")
            .chars()
            .take(60)
            .collect();
        span_text(
            m,
            row,
            "",
            &format!("▸ Thinking — {preview} (ctrl+o to expand)"),
        );
        msg.text_node_id = None;
        return;
    }
    let t = m.create_text_node(&msg.text);
    m.append_children(bubble, &[t]);
    msg.text_node_id = Some(t);
}

/// Re-render a bubble's children in place (markdown re-render / tool
/// card state change). Keeps the bubble node itself.
fn rebuild_bubble(m: &mut DocumentMutator<'_>, msg: &mut Message, glyphs: crate::components::glyphs::GlyphMode, tray_entries: &[crate::state::TrayEntry]) {
    let Some(bubble) = msg.node_id else { return };
    crate::components::dom::drop_children(m, bubble);
    match msg.kind {
        MsgKind::Tool => {
            let entry = msg.tray_entry.and_then(|i| tray_entries.get(i));
            let (g, t) = tool_card::build_card(m, bubble, msg, glyphs, entry);
            msg.glyph_node_id = Some(g);
            msg.text_node_id = Some(t);
        }
        MsgKind::Assistant => {
            markdown::render(m, bubble, &msg.text);
            msg.text_node_id = None;
        }
        MsgKind::Thinking => {
            build_thinking(m, bubble, msg);
        }
        _ => {
            let t = m.create_text_node(&msg.text);
            m.append_children(bubble, &[t]);
            msg.text_node_id = Some(t);
        }
    }
    msg.rendered_len = msg.text.len();
    msg.dirty = false;
}

/// Sync the DOM with `state.messages` incrementally:
/// * `state.needs_rebuild` → full rebuild (Ctrl+L);
/// * messages without a `node_id` get a new appended bubble;
/// * `msg.dirty` or changed text → re-render the bubble's children
///   (markdown for assistant, card for tools);
/// * plain messages patch their text node in place.
///
/// Returns `true` when any mutation was applied.
pub fn sync(m: &mut DocumentMutator<'_>, inner: NodeId, state: &mut AppState) -> bool {
    if state.needs_rebuild {
        rebuild(m, inner, state);
        return true;
    }
    let glyphs = state.glyphs;
    let mut changed = false;

    // Startup banner: prepend once, drop when dismissed.
    if state.banner_visible && state.banner_node.is_none() {
        let b = crate::components::banner::render(m, inner);
        state.banner_node = Some(b);
        changed = true;
    } else if !state.banner_visible {
        if let Some(b) = state.banner_node.take() {
            crate::components::dom::drop_node(m, inner, b);
            changed = true;
        }
    }
    for msg in state.messages.iter_mut() {
        if msg.node_id.is_none() {
            append_bubble(m, inner, msg, glyphs, &state.tray.entries);
            changed = true;
            continue;
        }
        if msg.dirty || msg.rendered_len != msg.text.len() {
            match msg.kind {
                // Markdown/tool/thinking bubbles re-render their subtree
                // (thinking collapses on seal → structural change).
                MsgKind::Assistant | MsgKind::Tool | MsgKind::Thinking => {
                    rebuild_bubble(m, msg, glyphs, &state.tray.entries);
                    changed = true;
                }
                // Plain bubbles patch the single text node.
                _ => {
                    if let Some(tid) = msg.text_node_id {
                        m.set_node_text(tid, &msg.text);
                        msg.rendered_len = msg.text.len();
                        msg.dirty = false;
                        changed = true;
                    }
                }
            }
        }
    }

    // Message action bar (RECON §12.4 feedback_up/feedback_down + copy):
    // a `.action-bar` row inserted after the last assistant bubble.
    let last_assistant = state
        .messages
        .iter()
        .rposition(|m| m.kind == MsgKind::Assistant);
    if last_assistant != state.action_bar_idx {
        if let Some(old) = state.action_bar_node.take() {
            crate::components::dom::drop_node(m, inner, old);
        }
        state.action_bar_idx = last_assistant;
        if let Some(idx) = last_assistant {
            if let Some(bubble) = state.messages[idx].node_id {
                let bar = build_action_bar(m, bubble);
                state.action_bar_node = Some(bar);
            }
        }
        changed = true;
    }
    changed
}

/// Build the `.action-bar` row and insert it right after `bubble`.
/// Buttons carry `data-hit-action` payloads for mouse routing.
fn build_action_bar(m: &mut DocumentMutator<'_>, bubble: NodeId) -> NodeId {
    use crate::components::dom::span_text;
    let bar = m.create_element(qual("div"), vec![attr("class", "action-bar")]);
    m.insert_nodes_after(bubble, &[bar]);
    for (payload, key, verb) in [
        ("up", "▲", " good"),
        ("down", "▼", " bad"),
        ("copy", "⧉", " copy"),
    ] {
        let btn = div(m, bar, "action-btn");
        m.set_attribute(btn, qual("data-hit-action"), payload);
        span_text(m, btn, "hint-key", key);
        span_text(m, btn, "hint-verb", verb);
    }
    bar
}

/// Clamp `state.scroll` to the valid range for the current layout and
/// write it into the `#messages` node's `scroll_offset`.
///
/// Must run *after* `doc.resolve()` (needs `scrollable_overflow`).
pub fn apply_scroll(doc: &mut BaseDocument, container: NodeId, state: &mut AppState) {
    let (content_h, view_h) = {
        let Some(node) = doc.get_node(container) else { return };
        let overflow = node.scrollable_overflow();
        let content_h = overflow.height();
        let view_h = node.final_layout().size.height as f64;
        (content_h, view_h)
    };
    let max_scroll = (content_h - view_h).max(0.0);
    if state.follow_tail {
        state.scroll = max_scroll as u32;
    } else {
        state.scroll = (state.scroll as f64).min(max_scroll) as u32;
    }
    if let Some(node) = doc.get_node_mut(container) {
        node.scroll_offset_mut().y = state.scroll as f64;
    }
}
