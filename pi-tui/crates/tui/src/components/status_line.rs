//! `StatusLine` — bottom line: model · thinking · mode · tokens · transient.
//!
//! DOM shape:
//! ```text
//! #status-line (row, border-top)
//!   ├─ <span> "{model} · thinking:{level} · {mode}"
//!   ├─ <span> "{transient}"
//!   └─ #status-right "{in} / {out} tokens"
//! ```

use blitz_dom::{DocumentMutator, NodeId};

use crate::components::dom::{div, qual, span_text};
use crate::state::StatusState;

/// Build the status line under `parent`. Returns
/// `(status_line, left_text_node, right_text_node)`.
pub fn build(m: &mut DocumentMutator<'_>, parent: NodeId) -> (NodeId, NodeId, NodeId) {
    let line = div(m, parent, "");
    m.set_attribute(line, qual("id"), "status-line");

    let (_l, left_text) = span_text(m, line, "", "");
    let (_r, right_text) = span_text(m, line, "", "");
    // Tag the right span for `margin-left:auto`.
    let right_span = m.last_child_id(line).unwrap();
    m.set_attribute(right_span, qual("id"), "status-right");

    (line, left_text, right_text)
}

/// Sync the status line text nodes from `status` + `streaming` +
/// `permission` (the Shift+Tab-cycled permission mode label).
pub fn sync(
    m: &mut DocumentMutator<'_>,
    left_text: NodeId,
    right_text: NodeId,
    status: &StatusState,
    streaming: bool,
    permission: &str,
    queued: usize,
) {
    let mut left = String::new();
    if !status.model.is_empty() {
        left.push_str(&status.model);
    }
    if !permission.is_empty() {
        if !left.is_empty() {
            left.push_str(" · ");
        }
        left.push_str(permission);
    }
    if !status.thinking.is_empty() {
        if !left.is_empty() {
            left.push_str(" · ");
        }
        left.push_str(&format!("thinking:{}", status.thinking));
    }
    if !status.mode.is_empty() {
        if !left.is_empty() {
            left.push_str(" · ");
        }
        left.push_str(&status.mode);
    }
    if streaming {
        if !left.is_empty() {
            left.push_str(" · ");
        }
        left.push_str("streaming");
    }
    if queued > 0 {
        if !left.is_empty() {
            left.push_str(" · ");
        }
        left.push_str(&format!("{queued} queued"));
    }
    if !status.transient.is_empty() {
        if !left.is_empty() {
            left.push_str(" · ");
        }
        left.push_str(&status.transient);
    }
    if left.is_empty() {
        left.push_str("pi");
    }
    m.set_node_text(left_text, &left);

    let right = if status.input_tokens > 0 || status.output_tokens > 0 {
        format!("{} / {} tokens", status.input_tokens, status.output_tokens)
    } else {
        String::new()
    };
    m.set_node_text(right_text, &right);
}
