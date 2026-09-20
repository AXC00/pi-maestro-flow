//! `InputBox` — multi-line input with a `›` prompt, `/`/`@` prefix hints,
//! and a block cursor rendered through a PUA marker cell.
//!
//! DOM shape:
//! ```text
//! #input-area (border-top)
//!   ├─ #input-hint   (muted hint line, hidden when empty)
//!   └─ #input-box    (row)
//!        ├─ #input-prompt "› "
//!        └─ #input-text  > text  (contains \u{EE80} at the cursor)
//! ```
//!
//! The cursor is the private-use marker `\u{EE80}` spliced into the text
//! node. `Surface::draw_str` records it in `surface.markers`; `app.rs`
//! post-processes that cell into an inverse-video block cursor.

use blitz_dom::{DocumentMutator, NodeId};

use crate::components::dom::{div, qual, span_text};
use crate::state::InputState;

/// PUA marker spliced into the input text at the cursor position.
/// `scrollback::surface::PUA_MARKER` records the cell it lands in.
pub const CURSOR_MARKER: char = scrollback::PUA_MARKER;

/// Rotating tips shown in `#input-hint` while the input is empty
/// (RECON §9 tip strings).
pub const TIPS: [&str; 5] = [
    "Shift+Tab to cycle permission modes",
    "Type @ to mention files",
    "Ctrl+O to view the full thinking trace",
    "Ctrl+L clear, Ctrl+Shift+L redraw",
    "Looking for plan mode? /plan",
];

/// Build the input area under `parent`. Returns
/// `(input_area, hint_text_node, input_text_node)`.
pub fn build(m: &mut DocumentMutator<'_>, parent: NodeId) -> (NodeId, NodeId, NodeId) {
    // Hint line sits ABOVE the bordered input box (not inside it).
    let hint = div(m, parent, "tip-text");
    m.set_attribute(hint, qual("id"), "input-hint");
    let hint_text = m.create_text_node("");
    m.append_children(hint, &[hint_text]);

    let area = div(m, parent, "");
    m.set_attribute(area, qual("id"), "input-area");

    let box_el = div(m, area, "");
    m.set_attribute(box_el, qual("id"), "input-box");
    span_text(m, box_el, "", "› ")
        .0;
    // Give the prompt its id for styling + the hit marker (RECON §12.3).
    let prompt = m.last_child_id(box_el).unwrap();
    m.set_attribute(prompt, qual("id"), "input-prompt");
    m.set_attribute(prompt, qual("data-hit-prompt-mark"), "");

    let text_el = div(m, box_el, "");
    m.set_attribute(text_el, qual("id"), "input-text");
    let text_node = m.create_text_node("");
    m.append_children(text_el, &[text_node]);

    (area, hint_text, text_node)
}

/// Compute the `#input-hint` line: attachment chips when present,
/// prefix hints for `/`/`@`, else the rotating tip.
pub fn hint_for(
    input: &InputState,
    attachments: &[crate::state::Attachment],
    sel: Option<usize>,
    tip: &str,
) -> String {
    if !attachments.is_empty() {
        let chips: Vec<String> = attachments
            .iter()
            .enumerate()
            .map(|(i, a)| {
                if sel == Some(i) {
                    format!("*[{}]*", a.label)
                } else {
                    format!("[{}]", a.label)
                }
            })
            .collect();
        return format!(
            "{}  (←→ select · del remove · esc deselect)",
            chips.join(" ")
        );
    }
    if input.text.starts_with('/') {
        "slash command — enter to run".to_string()
    } else if input.text.starts_with('@') {
        "file mention — @path/to/file".to_string()
    } else if input.text.is_empty() {
        tip.to_string()
    } else {
        String::new()
    }
}

/// Sync the input DOM nodes from `state`.
///
/// * `hint_text` — the `#input-hint` text node.
/// * `text_node` — the `#input-text` text node (gets the cursor marker).
/// * `show_cursor` — false while a dialog owns the cursor (avoids two
///   inverse-block cursors on screen).
/// * `hint` — precomputed hint line (`hint_for`).
pub fn sync(
    m: &mut DocumentMutator<'_>,
    hint_text: NodeId,
    text_node: NodeId,
    input: &InputState,
    show_cursor: bool,
    hint: &str,
) {
    m.set_node_text(hint_text, hint);

    // Text with the cursor marker spliced in.
    let mut shown = String::with_capacity(input.text.len() + 1);
    shown.push_str(&input.text[..input.cursor]);
    if show_cursor {
        shown.push(CURSOR_MARKER);
    }
    shown.push_str(&input.text[input.cursor..]);
    m.set_node_text(text_node, &shown);
}
