//! Small helpers for programmatic DOM construction via `DocumentMutator`.

use blitz_dom::{Attribute, DocumentMutator, LocalName, Namespace, NodeId, QualName, ns};

/// `QualName` for an HTML element/attribute local name.
pub fn qual(local: &str) -> QualName {
    QualName {
        prefix: None,
        ns: Namespace::from(ns!(html)),
        local: LocalName::from(local),
    }
}

/// `Attribute` with an HTML-namespace name.
pub fn attr(name: &str, value: &str) -> Attribute {
    Attribute {
        name: qual(name),
        value: value.to_string(),
    }
}

/// Create an element with a `class` attribute and append it to `parent`.
/// An empty `class` is omitted.
pub fn div(m: &mut DocumentMutator<'_>, parent: NodeId, class: &str) -> NodeId {
    let attrs = if class.is_empty() {
        vec![]
    } else {
        vec![attr("class", class)]
    };
    let id = m.create_element(qual("div"), attrs);
    m.append_children(parent, &[id]);
    id
}

/// blitz-dom beta.2 keeps `layout_children`/`paint_children` caches
/// that still reference dropped NodeIds → `invalid SlotMap key` panic
/// in `flush_styles_to_layout`. Clear them after removing children.
pub fn clear_child_caches(m: &mut DocumentMutator<'_>, node: NodeId) {
    if let Some(n) = m.doc.get_node_mut(node) {
        n.layout_children.borrow_mut().take();
        n.paint_children.borrow_mut().take();
    }
}

/// `remove_and_drop_all_children` + cache clear (required, see above).
pub fn drop_children(m: &mut DocumentMutator<'_>, node: NodeId) {
    m.remove_and_drop_all_children(node);
    clear_child_caches(m, node);
}

/// `remove_and_drop_node` + cache clear on the parent (required).
pub fn drop_node(m: &mut DocumentMutator<'_>, parent: NodeId, node: NodeId) {
    m.remove_and_drop_node(node);
    clear_child_caches(m, parent);
}

/// Create a `<span>` with a class and a text child; returns `(span, text)`.
/// An empty `class` is omitted.
pub fn span_text(
    m: &mut DocumentMutator<'_>,
    parent: NodeId,
    class: &str,
    text: &str,
) -> (NodeId, NodeId) {
    let attrs = if class.is_empty() {
        vec![]
    } else {
        vec![attr("class", class)]
    };
    let span = m.create_element(qual("span"), attrs);
    m.append_children(parent, &[span]);
    let t = m.create_text_node(text);
    m.append_children(span, &[t]);
    (span, t)
}
