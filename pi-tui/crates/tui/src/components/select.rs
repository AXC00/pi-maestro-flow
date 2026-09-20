//! `select` — dropdown select component (RECON §9 `select`).
//!
//! DOM shape (inside `.select-wrap`, `position:relative`):
//! ```text
//! .select-title    "{title}"
//! .select-filter   "Type to search: {filter}▌"   (when filterable)
//! .select-dropdown (position:absolute; bottom:0; background:
//!                   --surface-dropdown; border --border-default)
//!   ├─ .select-more "↑ more above"      (when scrolled)
//!   ├─ .select-option[.selected] "› {label} {badge}"
//!   │     selected: background:--surface-accent;
//!   │               color:--text-on-surface-accent; font-weight:bold
//!   └─ .select-more "↓ more below"      (when more below)
//! ```
//!
//! Options carry `data-hit-idx="{i}"` so mouse clicks map back to the
//! option index. `model-picker` adds the `model-picker` class whose
//! `@media (max-width:99px)` rules collapse the description column.

use blitz_dom::{DocumentMutator, NodeId};

use crate::components::dom::{div, qual, span_text};
use crate::components::glyphs::GlyphMode;

/// Max visible option rows before scroll markers appear.
pub const MAX_VISIBLE: usize = 8;

/// One option row.
#[derive(Clone, Debug)]
pub struct SelectOption {
    /// Display label (also the value returned on submit).
    pub label: String,
    /// Optional description column (model picker).
    pub description: String,
    /// Optional badge: `New` / `Promotion` / `Beta`.
    pub badge: Option<String>,
}

impl SelectOption {
    pub fn new(label: impl Into<String>) -> Self {
        SelectOption {
            label: label.into(),
            description: String::new(),
            badge: None,
        }
    }
}

/// Interactive select state.
#[derive(Clone, Debug)]
pub struct SelectState {
    pub title: String,
    pub options: Vec<SelectOption>,
    /// Cursor index into `filtered()` (not `options`).
    pub cursor: usize,
    /// Filter text (`Type to search`).
    pub filter: String,
    /// First visible index into `filtered()`.
    pub scroll: usize,
    /// Extra class on the dropdown (`model-picker` enables the
    /// `@media (max-width:99px)` responsive rules).
    pub extra_class: &'static str,
    /// Optional footer line under the options (context usage, notes).
    pub footer: String,
}

impl SelectState {
    pub fn new(title: impl Into<String>, options: Vec<String>) -> Self {
        SelectState {
            title: title.into(),
            options: options.into_iter().map(SelectOption::new).collect(),
            cursor: 0,
            filter: String::new(),
            scroll: 0,
            extra_class: "",
            footer: String::new(),
        }
    }

    /// Options matching the filter (case-insensitive substring).
    pub fn filtered(&self) -> Vec<usize> {
        if self.filter.is_empty() {
            return (0..self.options.len()).collect();
        }
        let f = self.filter.to_lowercase();
        self.options
            .iter()
            .enumerate()
            .filter(|(_, o)| {
                o.label.to_lowercase().contains(&f)
                    || o.description.to_lowercase().contains(&f)
            })
            .map(|(i, _)| i)
            .collect()
    }

    /// Currently selected option index (into `options`).
    pub fn selected(&self) -> Option<usize> {
        self.filtered().get(self.cursor).copied()
    }

    /// The selected label (the `value` for `extension_ui_response`).
    pub fn selected_label(&self) -> Option<String> {
        self.selected().map(|i| self.options[i].label.clone())
    }

    pub fn move_up(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
        self.clamp_scroll();
    }

    pub fn move_down(&mut self) {
        let n = self.filtered().len();
        if n > 0 {
            self.cursor = (self.cursor + 1).min(n - 1);
        }
        self.clamp_scroll();
    }

    /// Set the cursor to `filtered`-index `i` (mouse click).
    pub fn click(&mut self, i: usize) {
        if i < self.filtered().len() {
            self.cursor = i;
            self.clamp_scroll();
        }
    }

    pub fn push_filter(&mut self, c: char) {
        self.filter.push(c);
        self.cursor = 0;
        self.scroll = 0;
    }

    pub fn pop_filter(&mut self) {
        self.filter.pop();
        self.cursor = 0;
        self.scroll = 0;
    }

    fn clamp_scroll(&mut self) {
        if self.cursor < self.scroll {
            self.scroll = self.cursor;
        }
        if self.cursor >= self.scroll + MAX_VISIBLE {
            self.scroll = self.cursor + 1 - MAX_VISIBLE;
        }
    }
}

/// Render the select dialog under `parent` (rebuilt each sync).
pub fn render(
    m: &mut DocumentMutator<'_>,
    parent: NodeId,
    sel: &SelectState,
    mode: GlyphMode,
) {
    let wrap = div(m, parent, "select-wrap");
    if !sel.title.is_empty() {
        let t = div(m, wrap, "select-title");
        span_text(m, t, "", &sel.title);
    }
    let f = div(m, wrap, "select-filter");
    span_text(
        m,
        f,
        "select-filter-label",
        &format!("Type to search: {}", sel.filter),
    );

    let dd_class = if sel.extra_class.is_empty() {
        "select-dropdown".to_string()
    } else {
        format!("select-dropdown {}", sel.extra_class)
    };
    let dd = div(m, wrap, &dd_class);

    let filtered = sel.filtered();
    let total = filtered.len();
    let start = sel.scroll.min(total);
    let end = (start + MAX_VISIBLE).min(total);

    if start > 0 {
        let up = div(m, dd, "select-more");
        span_text(
            m,
            up,
            "",
            &format!("{} more above", mode.arrow_up()),
        );
    }
    for (fi, &oi) in filtered.iter().enumerate().take(end).skip(start) {
        let opt = &sel.options[oi];
        let selected = fi == sel.cursor;
        let row = div(
            m,
            dd,
            if selected {
                "select-option selected"
            } else {
                "select-option"
            },
        );
        m.set_attribute(row, qual("data-hit-idx"), &fi.to_string());
        let cursor = if selected { mode.chevron() } else { " " };
        span_text(m, row, "select-cursor", &format!("{cursor} "));
        span_text(m, row, "select-label", &opt.label);
        if let Some(badge) = &opt.badge {
            let bclass = match badge.as_str() {
                "New" => "select-badge badge-new",
                "Promotion" => "select-badge badge-promotion",
                "Beta" => "select-badge badge-beta",
                _ => "select-badge",
            };
            span_text(m, row, bclass, &format!(" {badge}"));
        }
        if !opt.description.is_empty() {
            span_text(m, row, "select-desc", &format!("  {}", opt.description));
        }
    }
    if total == 0 {
        let row = div(m, dd, "select-option select-empty");
        span_text(m, row, "", "  (no matches)");
    }
    if end < total {
        let down = div(m, dd, "select-more");
        span_text(
            m,
            down,
            "",
            &format!("{} more below", mode.arrow_down()),
        );
    }
    if !sel.footer.is_empty() {
        let f = div(m, dd, "select-footer");
        span_text(m, f, "select-footer-text", &sel.footer);
    }
}

/// Cost badge for a model (RECON §12.5: `Low/Med/High cost`, `Free`).
/// Thresholds on `cost.input + cost.output` ($/Mtok).
fn cost_badge(m: &pi_rpc::Model) -> &'static str {
    let c = m.cost.input + m.cost.output;
    if c <= 0.0 {
        "Free"
    } else if c < 5.0 {
        "Low cost"
    } else if c < 20.0 {
        "Med cost"
    } else {
        "High cost"
    }
}

/// Build a model-picker select from `get_available_models` data.
/// `model-picker` class enables the `@media (max-width:99px)` rules.
/// `current_id` marks the active model; `input_tokens` drives the
/// context-usage footer (`{n} tokens ({pct} consumed)`).
pub fn model_picker(
    title: &str,
    models: &[pi_rpc::Model],
    current_id: &str,
    input_tokens: u64,
) -> SelectState {
    let options = models
        .iter()
        .enumerate()
        .map(|(i, m)| {
            // First entry is the recommended one (Devin: "Recommended
            // Sidekick"); the active model is marked in the description.
            let badge = if i == 0 {
                "Recommended".to_string()
            } else {
                cost_badge(m).to_string()
            };
            let current = if m.id == current_id { " ●" } else { "" };
            SelectOption {
                label: m.id.clone(),
                description: format!("{} · {}{}", m.provider, m.name, current),
                badge: Some(badge),
            }
        })
        .collect();
    // Context usage vs the current model's window (fallback: the
    // largest window in the list).
    let window = models
        .iter()
        .find(|m| m.id == current_id)
        .or_else(|| models.iter().max_by(|a, b| {
            a.context_window.partial_cmp(&b.context_window).unwrap_or(std::cmp::Ordering::Equal)
        }))
        .map(|m| m.context_window)
        .unwrap_or(0.0);
    let footer = if window > 0.0 {
        let pct = (input_tokens as f64 / window * 100.0).min(100.0);
        format!(
            "{input_tokens} tokens ({pct:.0}% consumed) · Note: Token counts are estimates scaled by character ratio."
        )
    } else {
        String::new()
    };
    SelectState {
        title: title.to_string(),
        options,
        cursor: 0,
        filter: String::new(),
        scroll: 0,
        extra_class: "model-picker",
        footer,
    }
}

/// Build a thinking-level picker from `get_available_thinking_levels`.
pub fn thinking_picker(title: &str, levels: &[pi_rpc::ThinkingLevel]) -> SelectState {
    let options = levels
        .iter()
        .map(|l| SelectOption {
            label: format!("{l:?}").to_lowercase(),
            description: String::new(),
            badge: None,
        })
        .collect();
    SelectState {
        title: title.to_string(),
        options,
        cursor: 0,
        filter: String::new(),
        scroll: 0,
        extra_class: "model-picker",
        footer: String::new(),
    }
}
