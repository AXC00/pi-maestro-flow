# P0 Spike Notes — headless blitz-dom layout pipeline

Status: **verified** (2026-09-18, cargo 1.94.0, Windows).

Two runnable spikes prove the headless pipeline end-to-end:
`vdom/mutation → BaseDocument::resolve() → set_viewport() → taffy final_layout + parley inline_layout_data`.

| Spike | Crate | DOM source | blitz-dom | parley | taffy | Result |
|---|---|---|---|---|---|---|
| A | `pi-tui/spikes/dioxus-blitz/` (standalone workspace) | Dioxus `VirtualDom` via `DioxusDocument` | 0.3.0-**beta.1** | 0.10 | 0.12 | 7 non-zero rects, 3 text runs |
| B | `pi-tui/crates/tui` → `src/bin/spike.rs` | `DocumentMutator` (programmatic) | 0.3.0-**beta.2** | 0.11 | 0.14 | 6 non-zero rects, 3 text runs |

Run them:

```bash
cargo run -p tui --bin spike                 # pipeline B (workspace)
cd spikes/dioxus-blitz && cargo run          # pipeline A (standalone)
```

Both print identical geometry for the same tree
(`h1` y=21 h=39, `p` y=97 h=19, nested `div` y=132 w=120 h=40;
text runs with `font_size`, `advance`, `baseline`, `brush_node`).

---

## ⚠ Version pinning finding (drives the split)

`dioxus-native-dom 0.8.0-alpha.1` declares `blitz-dom = "=0.3.0-beta.1"`.
Cargo treats `0.3.0-beta.1` and `0.3.0-beta.2` as **semver-compatible
prereleases** and unifies them to a single version per dependency graph —
so `=0.3.0-beta.1` and `=0.3.0-beta.2` **cannot coexist in one workspace**.
That is why pipeline A lives in `spikes/dioxus-blitz/` with its own
`[workspace]` table + lockfile, excluded from the root workspace.

**Decision for downstream tasks**: the workspace (`crates/tui`, and later
`scrollback`) standardizes on **blitz-dom 0.3.0-beta.2** — the task's stated
target and the newer API line. If a Dioxus-driven vdom is wanted later,
either (a) keep it in its own crate like this spike, or (b) downgrade the
workspace to blitz-dom beta.1 and adopt pipeline A wholesale — the API
sequence below is verified to compile and run.

---

## Pipeline A — DioxusDocument API call sequence (beta.1 line)

Deps: `dioxus = "=0.8.0-alpha.1"` (features `macro, html, signals, hooks`),
`dioxus-native-dom = "=0.8.0-alpha.1"`, `blitz-dom = "=0.3.0-beta.1"`,
`blitz-traits = "=0.3.0-beta.1"`, `parley = "0.10"`.

```rust
use blitz_dom::{BaseDocument, Document as _, NodeData};
use blitz_traits::shell::{ColorScheme, Viewport};
use dioxus::prelude::*;
use dioxus_native_dom::{DioxusDocument, DocumentConfig};

fn app() -> Element {
    rsx! {
        div { style: "width: 400px; height: 200px;",
            h1 { "Hello pi-tui" }
        }
    }
}

// 1. construct — DioxusDocument::new(vdom, DocumentConfig)
//    internally creates <html><head/><body><main id="main"/></body></html>
//    and adds DEFAULT_CSS as UA stylesheet.
let vdom = VirtualDom::new(app);
let mut doc = DioxusDocument::new(vdom, DocumentConfig {
    viewport: Some(Viewport::new(800, 600, 1.0, ColorScheme::Light)),
    ..Default::default()
});

// 2. flush vdom → DOM mutations (vdom.rebuild via MutationWriter)
doc.initial_build();
//    per-frame updates instead: doc.poll(None) -> bool  (Document trait)

// 3. viewport + resolve — via Document::inner_mut() -> DocGuardMut
//    (DerefMut to BaseDocument)
{
    let mut inner = doc.inner_mut();
    inner.set_viewport(Viewport::new(800, 600, 1.0, ColorScheme::Light));
    inner.resolve(0.0);   // style → taffy layout → parley inline layout
}

// 4. traverse — Document::inner() -> DocGuard (Deref to BaseDocument)
let guard = doc.inner();
let root_id = guard.root_node().id;      // usize in beta.1
// guard.get_node(id) -> Option<&Node>; node.children: ThinVec<usize>
```

beta.1 specifics:
- `NodeId` = plain `usize`.
- `node.final_layout` is a **public field** (`taffy::Layout`), safe on every
  node kind (zero for text/comment).
- `NodeData::Comment` is a **unit variant**.
- `DioxusDocument` also exposes `pub inner: Rc<RefCell<BaseDocument>>` —
  `doc.inner.borrow_mut()` works without the `Document` trait, but
  `inner()/inner_mut()/poll()` need `use blitz_dom::Document`.
- `rsx!` requires `dioxus_signals` in scope → enable dioxus features
  `signals` + `hooks` (and `macro`, `html`); `default-features = false` is fine.
- Dioxus `style: "..."` attribute is parsed as inline CSS; per-property
  `ns="style"` attributes route to `set_style_property`.

## Pipeline B — direct blitz-dom beta.2 API call sequence

Deps: `blitz-dom = "=0.3.0-beta.2"` (`default-features = false`,
`features = ["system-fonts"]`), `blitz-traits = "=0.3.0-beta.2"`,
`parley = "0.11"`.

```rust
use blitz_dom::{Attribute, BaseDocument, DocumentConfig,
                LocalName, Namespace, NodeId, QualName, ns};
use blitz_traits::shell::{ColorScheme, Viewport};

fn qual(local: &str) -> QualName {
    QualName { prefix: None, ns: Namespace::from(ns!(html)),
               local: LocalName::from(local) }
}

// 1. construct
let mut doc = BaseDocument::new(DocumentConfig {
    viewport: Some(Viewport::new(800, 600, 1.0, ColorScheme::Light)),
    ..Default::default()
});
let root_id = doc.root_node().id;        // blitz_traits::node_id::NodeId

// 2. mutate — DocumentMutator (doc.mutate()); mutr.doc is the BaseDocument
{
    let mut m = doc.mutate();
    let html = m.create_element(qual("html"), vec![]);
    m.append_children(root_id, &[html]);
    let body = m.create_element(qual("body"), vec![]);
    m.append_children(html, &[body]);
    let div = m.create_element(qual("div"),
        vec![Attribute { name: qual("id"), value: "main".into() }]);
    m.append_children(body, &[div]);
    m.set_style_property(div, "width", "400px");   // per-property styling
    let t = m.create_text_node("Hello pi-tui");
    m.append_children(div, &[t]);
}   // mutator Drop flushes + requests redraw

// 3. viewport + resolve
doc.set_viewport(Viewport::new(800, 600, 1.0, ColorScheme::Light));
doc.resolve(0.0);

// 4. traverse — doc.get_node(id) -> Option<&Node>;
//    node.children: ThinVec<NodeId>
```

beta.2 specifics:
- `NodeId` is a **newtype** (`blitz_traits::node_id::NodeId`, re-exported as
  `blitz_dom::NodeId`); print with `{:?}` → `NodeId(5v1)`.
- `node.final_layout()` is a **method** (universal accessor over
  `ElementData`/`DocumentData`) that **panics on Text/Comment nodes** —
  guard with `matches!(node.data, NodeData::Text(_) | NodeData::Comment{..})`.
- `NodeData::Document(DocumentData)` carries data (not a unit variant);
  `NodeData::Comment { contents }` is a struct variant.
- `DocumentMutator` methods used: `create_element(QualName, Vec<Attribute>)`,
  `create_text_node(&str)`, `append_children(parent, &[ids])`,
  `set_style_property(node, name, value)`, `set_attribute(node, QualName, value)`.

## Reading layout + text (both lines)

```rust
// taffy rect (CSS px, viewport scale applied at resolve time)
let l = node.final_layout();        // beta.2 method; beta.1: node.final_layout
// l.location.x / l.location.y / l.size.width / l.size.height : f32

// parley text runs live on the ELEMENT that owns the inline context:
if let Some(ed) = node.element_data() {
    if let Some(tl) = &ed.inline_layout_data {   // Box<TextLayout>
        // tl.text: String — full inline text of this block
        for line in tl.layout.lines() {          // parley Layout<TextBrush>
            for item in line.items() {
                if let parley::layout::PositionedLayoutItem::GlyphRun(gr) = item {
                    let run = gr.run();
                    let range = run.text_range();      // byte range into tl.text
                    let text = tl.text.get(range.clone());
                    run.font_size();                   // f32
                    gr.advance(); gr.offset(); gr.baseline();
                    gr.style().brush.id;               // TextBrush { id: NodeId }
                }
            }
        }
    }
}
```

`TextBrush.id` (blitz-dom `node/text.rs`) carries the DOM `NodeId` of the
text's owning span — this is the hook P1's `paint_node` uses to map glyphs
back to DOM nodes.

## Fonts

Both spikes run with `font_ctx: None` → `BaseDocument` builds a default
`FontContext` with `system_fonts: cfg!(feature = "system-fonts")` and the
embedded `BULLET_FONT` fallback. On Windows this resolves real system fonts
(h1 → 32px run advance 155.6, p → 16px advance 202.2).

For the terminal renderer (1px = 1cell, monospace assumption), inject a
pinned `FontContext` via `DocumentConfig.font_ctx` — e.g.
`blitz_dom::build_single_font_ctx(font_bytes)` (exists in beta.2) registers
one font as fallback for every generic family with `system_fonts: false`.
Font metrics then become deterministic across machines.

## Gotchas hit during the spike

1. `rsx!` expands to `dioxus_core::` / `dioxus_elements::` /
   `dioxus_signals::` paths — all three must resolve; `use dioxus::prelude::*`
   plus features `macro, html, signals, hooks` covers it.
2. `dioxus-native-dom` default features pull `accessibility`+`svg`+
   `system-fonts`; `custom-widget` (always on) transitively enables
   `blitz-dom/accessibility` anyway, so accesskit is unavoidable on the
   Dioxus path.
3. `DocumentMutator` borrows `&mut BaseDocument` — grab `root_node().id`
   *before* `doc.mutate()`.
4. `resolve(current_time_for_animations: f64)` — pass `0.0` for a static
   headless frame; it internally handles stylist → damage → construct →
   taffy → transforms → deferred inline-layout tasks.
5. Text nodes have no layout box; their glyphs are reported through the
   parent element's `inline_layout_data` (anonymous block parents possible).
