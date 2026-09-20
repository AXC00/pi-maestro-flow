//! P0 spike — headless blitz-dom 0.3.0-beta.2 layout pipeline.
//!
//! Builds a DOM programmatically via `DocumentMutator` (no Dioxus — see
//! `pi-tui/SPIKE-NOTES.md` for why the dioxus-native-dom path lives in a
//! separate standalone spike crate), resolves style+layout headless at a
//! fixed viewport, then walks the DOM printing each node's taffy
//! `final_layout` rect (x/y/w/h) and every parley text run found in
//! `element_data().inline_layout_data`.

use blitz_dom::{
    Attribute, BaseDocument, DocumentConfig, LocalName, Namespace, NodeId, QualName, ns,
};
use blitz_traits::shell::{ColorScheme, Viewport};

fn qual(local: &str) -> QualName {
    QualName {
        prefix: None,
        ns: Namespace::from(ns!(html)),
        local: LocalName::from(local),
    }
}

fn attr(name: &str, value: &str) -> Attribute {
    Attribute {
        name: qual(name),
        value: value.to_string(),
    }
}

fn main() {
    // 1. Empty document, then build the DOM programmatically.
    let mut doc = BaseDocument::new(DocumentConfig {
        viewport: Some(Viewport::new(800, 600, 1.0, ColorScheme::Light)),
        ..Default::default()
    });
    let root_id = doc.root_node().id;

    {
        let mut m = doc.mutate();
        let html = m.create_element(qual("html"), vec![]);
        m.append_children(root_id, &[html]);
        let body = m.create_element(qual("body"), vec![]);
        m.append_children(html, &[body]);

        let div = m.create_element(qual("div"), vec![attr("id", "main")]);
        m.append_children(body, &[div]);
        m.set_style_property(div, "width", "400px");
        m.set_style_property(div, "height", "200px");
        m.set_style_property(div, "display", "flex");
        m.set_style_property(div, "flex-direction", "column");

        let h1 = m.create_element(qual("h1"), vec![]);
        m.append_children(div, &[h1]);
        let t1 = m.create_text_node("Hello pi-tui");
        m.append_children(h1, &[t1]);

        let p = m.create_element(qual("p"), vec![]);
        m.append_children(div, &[p]);
        let t2 = m.create_text_node("headless blitz-dom layout spike");
        m.append_children(p, &[t2]);

        let nested = m.create_element(qual("div"), vec![]);
        m.append_children(div, &[nested]);
        m.set_style_property(nested, "width", "120px");
        m.set_style_property(nested, "height", "40px");
        let t3 = m.create_text_node("nested box");
        m.append_children(nested, &[t3]);
    }

    // 2. Viewport + resolve (style → taffy layout → parley inline layout).
    doc.set_viewport(Viewport::new(800, 600, 1.0, ColorScheme::Light));
    doc.resolve(0.0);

    // 3. Walk the DOM.
    let mut counts = (0usize, 0usize);
    walk(&doc, root_id, 0, &mut counts);

    println!();
    println!(
        "=== Summary: {} non-zero layout rects, {} text runs ===",
        counts.0, counts.1
    );
    if counts.0 == 0 || counts.1 == 0 {
        eprintln!("SPIKE FAILED: no non-zero layout rect or no text run produced");
        std::process::exit(1);
    }
    println!("SPIKE OK");
}

fn walk(doc: &BaseDocument, id: NodeId, depth: usize, counts: &mut (usize, usize)) {
    let Some(node) = doc.get_node(id) else { return };
    let indent = "  ".repeat(depth);

    let kind = match &node.data {
        blitz_dom::NodeData::Document(_) => "document".to_string(),
        blitz_dom::NodeData::Element(e) => format!("element <{}>", &*e.name.local),
        blitz_dom::NodeData::AnonymousBlock(_) => "anonymous-block".to_string(),
        blitz_dom::NodeData::Text(t) => {
            let preview: String = t.content.chars().take(24).collect();
            format!("text {:?}", preview)
        }
        blitz_dom::NodeData::Comment { .. } => "comment".to_string(),
    };

    // `final_layout()` is a universal accessor that panics on text/comment
    // nodes — guard it.
    let has_layout = !matches!(
        node.data,
        blitz_dom::NodeData::Text(_) | blitz_dom::NodeData::Comment { .. }
    );
    if has_layout {
        let l = node.final_layout();
        let non_zero = l.size.width > 0.0 && l.size.height > 0.0;
        if non_zero {
            counts.0 += 1;
        }
        println!(
            "{indent}#{id:?} {kind}  layout x={:.1} y={:.1} w={:.1} h={:.1}{}",
            l.location.x,
            l.location.y,
            l.size.width,
            l.size.height,
            if non_zero { "" } else { "  (zero)" },
        );
    } else {
        println!("{indent}#{id:?} {kind}  (no layout box)");
    }

    // Parley inline text layout lives on the *element* that owns the text.
    if let Some(ed) = node.element_data() {
        if let Some(tl) = &ed.inline_layout_data {
            for (line_idx, line) in tl.layout.lines().enumerate() {
                for item in line.items() {
                    if let parley::layout::PositionedLayoutItem::GlyphRun(gr) = item {
                        let run = gr.run();
                        let range = run.text_range();
                        let text = tl.text.get(range.clone()).unwrap_or("<oob>");
                        println!(
                            "{indent}  text-run line={line_idx} range={range:?} \
                             text={text:?} font_size={:.1} advance={:.1} \
                             offset={:.1} baseline={:.1} brush_node={:?}",
                            run.font_size(),
                            gr.advance(),
                            gr.offset(),
                            gr.baseline(),
                            gr.style().brush.id,
                        );
                        counts.1 += 1;
                    }
                }
            }
        }
    }

    for &child in node.children.iter() {
        walk(doc, child, depth + 1, counts);
    }
}
