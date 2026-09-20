//! P0 spike — dioxus-native-dom 0.8.0-alpha.1 headless layout pipeline.
//!
//! `DioxusDocument` bridges a Dioxus `VirtualDom` into a blitz-dom
//! `BaseDocument` (beta.1 line: parley 0.10, taffy 0.12). This binary
//! builds a small vdom, resolves style+layout headless at a fixed
//! viewport, then walks the DOM printing each node's taffy
//! `final_layout` rect (x/y/w/h) and every parley text run found in
//! `element_data().inline_layout_data`.
//!
//! Standalone crate (own workspace): dioxus-native-dom pins
//! blitz-dom =0.3.0-beta.1 which cannot coexist with the main
//! workspace's blitz-dom 0.3.0-beta.2. See pi-tui/SPIKE-NOTES.md.

use blitz_dom::{BaseDocument, Document as _, NodeData};
use blitz_traits::shell::{ColorScheme, Viewport};
use dioxus::prelude::*;
use dioxus_native_dom::{DioxusDocument, DocumentConfig};

fn app() -> Element {
    rsx! {
        div {
            style: "width: 400px; height: 200px; display: flex; flex-direction: column;",
            h1 { "Hello pi-tui" }
            p { "headless blitz-dom layout spike" }
            div {
                style: "width: 120px; height: 40px;",
                "nested box"
            }
        }
    }
}

fn main() {
    // 1. Build the Dioxus vdom and the bridging document.
    let vdom = VirtualDom::new(app);
    let mut doc = DioxusDocument::new(
        vdom,
        DocumentConfig {
            viewport: Some(Viewport::new(800, 600, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    );

    // 2. Flush vdom → DOM mutations, then poll once (no-op for a static
    //    vdom, but this is the call a real event loop would make).
    doc.initial_build();
    let _ = doc.poll(None);

    // 3. Set viewport + resolve style/layout.
    {
        let mut inner = doc.inner_mut();
        inner.set_viewport(Viewport::new(800, 600, 1.0, ColorScheme::Light));
        inner.resolve(0.0);
    }

    // 4. Walk the DOM.
    let guard = doc.inner();
    let root_id = guard.root_node().id;
    let mut counts = (0usize, 0usize);
    walk(&guard, root_id, 0, &mut counts);

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

fn walk(doc: &BaseDocument, id: usize, depth: usize, counts: &mut (usize, usize)) {
    let Some(node) = doc.get_node(id) else { return };
    let indent = "  ".repeat(depth);

    let kind = match &node.data {
        NodeData::Document => "document".to_string(),
        NodeData::Element(e) => format!("element <{}>", &*e.name.local),
        NodeData::AnonymousBlock(_) => "anonymous-block".to_string(),
        NodeData::Text(t) => {
            let preview: String = t.content.chars().take(24).collect();
            format!("text {:?}", preview)
        }
        NodeData::Comment => "comment".to_string(),
    };

    // beta.1: `final_layout` is a plain field on Node (zero for non-layout nodes).
    let l = &node.final_layout;
    let non_zero = l.size.width > 0.0 && l.size.height > 0.0;
    if non_zero {
        counts.0 += 1;
    }
    println!(
        "{indent}#{id} {kind}  layout x={:.1} y={:.1} w={:.1} h={:.1}{}",
        l.location.x,
        l.location.y,
        l.size.width,
        l.size.height,
        if non_zero { "" } else { "  (zero)" },
    );

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
