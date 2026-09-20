//! `markdown` — pulldown-cmark → styled DOM nodes (RECON §9
//! `terminal_markdown`).
//!
//! Style mapping (classes live in `theme::stylesheet`):
//! * `h1` → `text-heading-h1` (#d946ef magenta); `h2..h6` → `md-h2..md-h6`
//! * `blockquote` → `md-bq` (`border-left:1px solid --border-default;
//!   padding-left:1px`)
//! * fenced/indented code → `bg-code-block` (+ `md-lang-{lang}`)
//! * inline code → `bg-code-inline text-warning`
//! * links → `text-accent underline` + `data-hit-link="{url}"` (clickable)
//! * task list items → `[x]` / `[ ]` marker
//! * images → `[Image: {alt}]` muted text
//! * tables → `md-table table-cols-N` responsive cards (media query)
//! * `em`/`strong`/`del` → `md-em` / `md-strong` / `md-strike`
//! * `hr` → a real `<hr>` element (painted as `─` rule by scrollback)

use blitz_dom::{DocumentMutator, NodeId};
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use unicode_width::UnicodeWidthStr;

use crate::components::dom::{attr, div, qual, span_text};

/// Render markdown `src` as block nodes appended under `parent`.
pub fn render(m: &mut DocumentMutator<'_>, parent: NodeId, src: &str) {
    if src.trim().is_empty() {
        return;
    }
    let opts = Options::ENABLE_TABLES
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_MATH;
    let mut b = Builder::new(m, parent);
    for ev in Parser::new_ext(src, opts) {
        b.event(ev);
    }
    b.finish();
}

/// Incremental builder: pulldown events → DOM nodes under `root`.
struct Builder<'a, 'd> {
    m: &'a mut DocumentMutator<'d>,
    /// Open block elements; last = current append target.
    blocks: Vec<NodeId>,
    /// Open inline style classes (`md-em`, `md-strong`, …).
    inline: Vec<&'static str>,
    /// Ordered-list counters (`None` = bullet list).
    lists: Vec<Option<u64>>,
    /// Buffered table rows (header is row 0); cells are plain text.
    /// Tables render as aligned monospace columns — taffy has no
    /// `display: table`, so we pre-format `│ a │ b │` lines.
    table: Option<Vec<Vec<String>>>,
    /// Row being accumulated while inside `TableRow`/`TableHead`.
    table_row: Vec<String>,
    /// True while inside a `TableCell` (text goes to `cell_text`).
    in_cell: bool,
    /// Cell text accumulator.
    cell_text: String,
    /// `Some(alt)` while inside an image tag — text goes to the alt buffer.
    img_alt: Option<String>,
    /// Code-block accumulator (`Some` while inside a code block).
    code: Option<String>,
    /// Root node blocks append to when `blocks` is empty.
    root: NodeId,
}

impl<'a, 'd> Builder<'a, 'd> {
    fn new(m: &'a mut DocumentMutator<'d>, root: NodeId) -> Self {
        Builder {
            m,
            blocks: Vec::new(),
            inline: Vec::new(),
            lists: Vec::new(),
            table: None,
            table_row: Vec::new(),
            in_cell: false,
            cell_text: String::new(),
            img_alt: None,
            code: None,
            root,
        }
    }

    fn parent(&self) -> NodeId {
        *self.blocks.last().unwrap_or(&self.root)
    }

    /// Open a `<div class="{class}">` block under the current parent.
    fn open_block(&mut self, class: &str) -> NodeId {
        let el = div(self.m, self.parent(), class);
        self.blocks.push(el);
        el
    }

    /// Emit a text run under the current parent, wrapped in a `<span>`
    /// carrying the open inline classes when any are active.
    fn emit_text(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        if let Some(alt) = &mut self.img_alt {
            alt.push_str(text);
            return;
        }
        if let Some(code) = &mut self.code {
            code.push_str(text);
            return;
        }
        if self.in_cell {
            self.cell_text.push_str(text);
            return;
        }
        let parent = self.parent();
        if self.inline.is_empty() {
            let t = self.m.create_text_node(text);
            self.m.append_children(parent, &[t]);
        } else {
            let class = self.inline.join(" ");
            span_text(self.m, parent, &class, text);
        }
    }

    /// Emit a leaf `<span class="{class}">{text}</span>` (markers etc.).
    fn emit_span(&mut self, class: &str, text: &str) {
        let parent = self.parent();
        span_text(self.m, parent, class, text);
    }

    fn event(&mut self, ev: Event<'_>) {
        match ev {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(t) => self.emit_text(&t),
            Event::Code(c) => self.emit_span("bg-code-inline text-warning", &c),
            Event::InlineMath(c) => {
                self.emit_span("md-math", &c)
            }
            Event::DisplayMath(c) => {
                let b = self.open_block("md-math-display");
                span_text(self.m, b, "md-math", &c);
                self.blocks.pop();
            }
            Event::Html(h) | Event::InlineHtml(h) => {
                self.emit_span("md-muted", &h)
            }
            Event::SoftBreak | Event::HardBreak => self.emit_text("\n"),
            Event::Rule => {
                let parent = self.parent();
                let hr = self.m.create_element(qual("hr"), vec![]);
                self.m.append_children(parent, &[hr]);
            }
            Event::TaskListMarker(checked) => {
                self.emit_span("md-task", if checked { "[x] " } else { "[ ] " });
            }
            Event::FootnoteReference(name) => {
                self.emit_span("md-muted", &format!("[^{name}]"));
            }
        }
    }

    fn start(&mut self, tag: Tag<'_>) {
        match tag {
            Tag::Paragraph => {
                self.open_block("md-p");
            }
            Tag::Heading { level, .. } => {
                let class = match level {
                    HeadingLevel::H1 => "md-h text-heading-h1",
                    HeadingLevel::H2 => "md-h md-h2",
                    HeadingLevel::H3 => "md-h md-h3",
                    HeadingLevel::H4 => "md-h md-h4",
                    HeadingLevel::H5 => "md-h md-h5",
                    HeadingLevel::H6 => "md-h md-h6",
                };
                self.open_block(class);
            }
            Tag::BlockQuote(_) => {
                self.open_block("md-bq");
            }
            Tag::CodeBlock(kind) => {
                let class = match &kind {
                    CodeBlockKind::Fenced(lang) if !lang.is_empty() => {
                        format!("bg-code-block md-lang-{lang}")
                    }
                    _ => "bg-code-block".to_string(),
                };
                let el = div(self.m, self.parent(), &class);
                self.blocks.push(el);
                self.code = Some(String::new());
            }
            Tag::HtmlBlock => {
                self.open_block("md-muted");
            }
            Tag::List(start) => {
                self.lists.push(start);
                self.open_block("md-list");
            }
            Tag::Item => {
                let marker = match self.lists.last_mut() {
                    Some(Some(n)) => {
                        let s = format!("{n}. ");
                        *n += 1;
                        s
                    }
                    _ => "• ".to_string(),
                };
                self.open_block("md-li");
                self.emit_span("md-li-marker", &marker);
            }
            Tag::FootnoteDefinition(name) => {
                self.open_block("md-muted");
                self.emit_span("md-muted", &format!("[^{name}]: "));
            }
            Tag::Table(_) => {
                self.table = Some(Vec::new());
            }
            Tag::TableHead | Tag::TableRow => {
                self.table_row = Vec::new();
            }
            Tag::TableCell => {
                self.in_cell = true;
                self.cell_text.clear();
            }
            Tag::Emphasis => self.inline.push("md-em"),
            Tag::Strong => self.inline.push("md-strong"),
            Tag::Strikethrough => self.inline.push("md-strike"),
            Tag::Link { dest_url, .. } => {
                self.inline.push("text-accent underline");
                // Emit a real `<a href>` so scrollback's `find_link`
                // (which walks the run's owner chain for `a[href]`)
                // records the link hit region with the URL payload.
                let parent = self.parent();
                let span = self.m.create_element(
                    qual("a"),
                    vec![
                        attr("class", "md-link-target"),
                        attr("href", &dest_url),
                    ],
                );
                self.m.append_children(parent, &[span]);
                self.blocks.push(span);
            }
            Tag::Image { .. } => {
                self.img_alt = Some(String::new());
            }
            // Definition lists, super/subscript, metadata: plain text.
            Tag::DefinitionList
            | Tag::DefinitionListTitle
            | Tag::DefinitionListDefinition
            | Tag::Superscript
            | Tag::Subscript
            | Tag::MetadataBlock(_) => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph
            | TagEnd::Heading(_)
            | TagEnd::BlockQuote(_)
            | TagEnd::HtmlBlock
            | TagEnd::Item
            | TagEnd::FootnoteDefinition => {
                self.blocks.pop();
            }
            TagEnd::TableCell => {
                self.in_cell = false;
                self.table_row.push(self.cell_text.trim().to_string());
            }
            TagEnd::TableHead | TagEnd::TableRow => {
                let row = std::mem::take(&mut self.table_row);
                if let Some(t) = &mut self.table {
                    t.push(row);
                }
            }
            TagEnd::CodeBlock => {
                if let Some(code) = self.code.take() {
                    let parent = self.parent();
                    let t = self.m.create_text_node(code.trim_end_matches('\n'));
                    self.m.append_children(parent, &[t]);
                }
                self.blocks.pop();
            }
            TagEnd::List(_) => {
                self.lists.pop();
                self.blocks.pop();
            }
            TagEnd::Table => {
                if let Some(rows) = self.table.take() {
                    self.emit_table(&rows);
                }
            }
            TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough => {
                self.inline.pop();
            }
            TagEnd::Link => {
                self.inline.pop();
                self.blocks.pop(); // the md-link-target span
            }
            TagEnd::Image => {
                let alt = self.img_alt.take().unwrap_or_default();
                self.emit_span("md-muted", &format!("[Image: {alt}]"));
            }
            TagEnd::DefinitionListTitle | TagEnd::DefinitionListDefinition => {}
            TagEnd::DefinitionList | TagEnd::MetadataBlock(_) => {}
            TagEnd::Superscript | TagEnd::Subscript => {}
        }
    }

    /// Emit a buffered table as aligned monospace lines:
    /// `│ h1 │ h2 │`, `─┼─` header rule, `│ a │ b │` rows.
    /// Column widths use display width (CJK-aware), capped at 40.
    fn emit_table(&mut self, rows: &[Vec<String>]) {
        if rows.is_empty() {
            return;
        }
        const MAX_COL: usize = 40;
        let cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        if cols == 0 {
            return;
        }
        let mut widths = vec![0usize; cols];
        for r in rows {
            for (i, c) in r.iter().enumerate() {
                widths[i] = widths[i].max(UnicodeWidthStr::width(c.as_str()));
            }
        }
        for w in &mut widths {
            *w = (*w).min(MAX_COL).max(1);
        }
        let cell = |c: &str, w: usize| -> String {
            let mut s = if UnicodeWidthStr::width(c) > w {
                // Truncate to w-1 display cells + ellipsis.
                let mut out = String::new();
                let mut used = 0usize;
                for ch in c.chars() {
                    let cw = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
                    if used + cw > w.saturating_sub(1) {
                        break;
                    }
                    out.push(ch);
                    used += cw;
                }
                out.push('…');
                out
            } else {
                c.to_string()
            };
            let pad = w.saturating_sub(UnicodeWidthStr::width(s.as_str()));
            s.push_str(&" ".repeat(pad));
            s
        };
        let tbl = div(self.m, self.parent(), "md-table");
        for (ri, r) in rows.iter().enumerate() {
            let mut line = String::from("│");
            for (i, w) in widths.iter().enumerate() {
                let c = r.get(i).map(|s| s.as_str()).unwrap_or("");
                line.push(' ');
                line.push_str(&cell(c, *w));
                line.push(' ');
                line.push('│');
            }
            let class = if ri == 0 { "md-tr md-th" } else { "md-tr" };
            let row = div(self.m, tbl, class);
            span_text(self.m, row, "", &line);
            if ri == 0 && rows.len() > 1 {
                // Header separator: `─┼─` between columns.
                let mut sep = String::from("├");
                for (i, w) in widths.iter().enumerate() {
                    sep.push_str(&"─".repeat(w + 2));
                    sep.push(if i + 1 == cols { '┤' } else { '┼' });
                }
                let s = div(self.m, tbl, "md-tr md-sep");
                span_text(self.m, s, "", &sep);
            }
        }
    }

    fn finish(self) {}
}

#[cfg(test)]
mod tests {
    // DOM-level tests live in `tests/render.rs` (needs a BaseDocument).
}
