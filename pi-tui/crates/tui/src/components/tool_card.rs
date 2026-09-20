//! `tool_card` — `ToolView` / `ToolOutputLines` / `DiffComponent` /
//! `HighlightedLine` (RECON §9 `tool_content`).
//!
//! DOM shape inside the `.msg.msg-tool` bubble:
//! ```text
//! .tool-head (row)
//!   ├─ .tool-glyph-{run|ok|err|partial} "{glyph}"
//!   ├─ .tool-name  "{tool_name}"
//!   └─ .tool-args  "{args summary}"
//! .tool-body (column, only when output present)
//!   ├─ .tool-line / .diff-line-{context,delete,insert,hunk,file}
//!   │    └─ .hl-line spans (+ .diff-emphasis-{delete,insert} middles)
//!   └─ .tool-trunc "[... N lines truncated (ctrl+o to expand) ...]"
//! ```
//!
//! v0 highlighting: `mime_to_lang` maps mime/extension → lang id
//! (sh/json/py/rs/js/ts/yaml/toml/md); `highlight_line` emits a single
//! `hl-line` span per line — tree-sitter token colors are a later
//! increment (the span seam is already in place).

use blitz_dom::{DocumentMutator, NodeId};

use crate::components::dom::{div, qual, span_text};
use crate::components::glyphs::{GlyphMode, status_glyph};
use crate::state::Message;

/// Output lines shown when the card is collapsed.
pub const COLLAPSED_LINES: usize = 8;

/// Lifecycle status of a tool call (drives glyph + color class).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolStatus {
    Running,
    Ok,
    Err,
    Partial,
    Pending,
}

impl ToolStatus {
    /// From the stored status char on `Message::tool_status`.
    pub fn from_char(c: Option<char>) -> Self {
        match c {
            Some('✓') => Self::Ok,
            Some('✗') => Self::Err,
            Some('◔') => Self::Partial,
            Some('○') => Self::Pending,
            _ => Self::Running,
        }
    }

    fn class(self) -> &'static str {
        match self {
            Self::Ok => "tool-glyph tool-glyph-ok",
            Self::Err => "tool-glyph tool-glyph-err",
            Self::Partial => "tool-glyph tool-glyph-run",
            Self::Pending => "tool-glyph",
            Self::Running => "tool-glyph tool-glyph-run",
        }
    }
}

/// mime type / extension / language name → tree-sitter lang id.
/// Returns `None` for unmapped inputs (plain text).
pub fn mime_to_lang(s: &str) -> Option<&'static str> {
    let s = s.trim().to_ascii_lowercase();
    let s = s.rsplit('/').next().unwrap_or(&s); // strip "text/" etc.
    let s = s.strip_prefix("x-").unwrap_or(s);
    let s = s.strip_prefix('.').unwrap_or(s);
    Some(match s {
        "sh" | "bash" | "shell" | "shellscript" | "zsh" => "sh",
        "json" | "jsonl" | "ndjson" => "json",
        "py" | "python" | "python3" => "py",
        "rs" | "rust" => "rs",
        "js" | "javascript" | "mjs" | "cjs" | "jsx" => "js",
        "ts" | "typescript" | "mts" | "cts" | "tsx" => "ts",
        "yaml" | "yml" => "yaml",
        "toml" => "toml",
        "md" | "markdown" | "mdown" => "md",
        _ => return None,
    })
}

/// Guess the output language for a tool call from its name, args, and
/// result (`mime`/`language`/`path` fields, file extensions).
pub fn detect_lang(tool_name: &str, args: &serde_json::Value, result: &serde_json::Value) -> Option<&'static str> {
    // Explicit fields on the result win.
    for v in [result, args] {
        for key in ["mime", "mimeType", "language", "lang"] {
            if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
                if let Some(l) = mime_to_lang(s) {
                    return Some(l);
                }
            }
        }
        for key in ["path", "file", "file_path", "filePath", "filename"] {
            if let Some(s) = v.get(key).and_then(|x| x.as_str()) {
                if let Some(ext) = s.rsplit('.').next() {
                    if ext != s {
                        if let Some(l) = mime_to_lang(ext) {
                            return Some(l);
                        }
                    }
                }
            }
        }
    }
    // Tool-name conventions: `bash`/`shell` output is shell-ish.
    match tool_name {
        "bash" | "shell" | "sh" => Some("sh"),
        _ => None,
    }
}

/// One highlighted span (v0: a whole line is one span).
pub struct HighlightedLine<'a> {
    pub line: &'a str,
    pub lang: Option<&'static str>,
}

/// Emit a highlighted line under `parent`. v0: single `hl-line` span;
/// the `lang` is carried as a class so tree-sitter token classes can be
/// added incrementally without changing call sites.
pub fn highlight_line(m: &mut DocumentMutator<'_>, parent: NodeId, hl: &HighlightedLine<'_>) {
    let class = match hl.lang {
        Some(l) => format!("hl-line hl-lang-{l}"),
        None => "hl-line".to_string(),
    };
    span_text(m, parent, &class, hl.line);
}

/// True when `text` looks like unified diff output.
pub fn looks_like_diff(text: &str) -> bool {
    let mut markers = 0usize;
    let mut pm = 0usize;
    for line in text.lines() {
        if line.starts_with("diff --git")
            || line.starts_with("--- ")
            || line.starts_with("+++ ")
            || line.starts_with("@@")
            || line.starts_with("Index: ")
        {
            markers += 1;
        } else if line.starts_with('-') || line.starts_with('+') {
            pm += 1;
        }
    }
    markers >= 2 || (markers >= 1 && pm >= 2)
}

/// Diff line classification → CSS class.
fn diff_class(line: &str, is_file_header: bool) -> &'static str {
    if line.starts_with("@@") {
        "diff-line-hunk"
    } else if is_file_header
        || line.starts_with("diff --git")
        || line.starts_with("Index: ")
    {
        "diff-line-file"
    } else if line.starts_with('-') {
        "diff-line-delete"
    } else if line.starts_with('+') {
        "diff-line-insert"
    } else {
        "diff-line-context"
    }
}

/// Common prefix length (chars) of `a`/`b` after the leading +/- sigil.
fn common_prefix(a: &str, b: &str) -> usize {
    a.chars()
        .zip(b.chars())
        .take_while(|(x, y)| x == y)
        .count()
}

/// Common suffix length (chars) of `a`/`b`, not overlapping `prefix`.
fn common_suffix(a: &str, b: &str, prefix: usize) -> usize {
    let ac: Vec<char> = a.chars().collect();
    let bc: Vec<char> = b.chars().collect();
    let a_max = ac.len().saturating_sub(prefix);
    let b_max = bc.len().saturating_sub(prefix);
    let mut n = 0;
    while n < a_max && n < b_max && ac[ac.len() - 1 - n] == bc[bc.len() - 1 - n] {
        n += 1;
    }
    n
}

/// Emit one diff line, splitting the differing middle into an emphasis
/// span when `paired_with` is the opposite-side line.
fn emit_diff_line(
    m: &mut DocumentMutator<'_>,
    parent: NodeId,
    line: &str,
    class: &str,
    paired_with: Option<&str>,
) {
    let row = div(m, parent, class);
    match paired_with {
        Some(other) => {
            // Skip the leading +/- sigil when comparing.
            let a = line.get(1..).unwrap_or(line);
            let b = other.get(1..).unwrap_or(other);
            let pre = common_prefix(a, b);
            let suf = common_suffix(a, b, pre);
            let chars: Vec<char> = line.chars().collect();
            // +1 for the sigil, then prefix chars, emphasis, suffix.
            let head_end = (1 + pre).min(chars.len());
            let suf_start = chars.len().saturating_sub(suf).max(head_end);
            let head: String = chars[..head_end].iter().collect();
            let mid: String = chars[head_end..suf_start].iter().collect();
            let tail: String = chars[suf_start..].iter().collect();
            if !head.is_empty() {
                span_text(m, row, "", &head);
            }
            if !mid.is_empty() {
                let em = if class == "diff-line-delete" {
                    "diff-emphasis-delete"
                } else {
                    "diff-emphasis-insert"
                };
                span_text(m, row, em, &mid);
            }
            if !tail.is_empty() {
                span_text(m, row, "", &tail);
            }
        }
        None => {
            span_text(m, row, "", line);
        }
    }
}

/// `DiffComponent` — render unified-diff text with line classes and
/// intra-line emphasis on paired delete/insert runs.
pub fn build_diff(m: &mut DocumentMutator<'_>, parent: NodeId, text: &str, max_lines: Option<usize>) {
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    let (shown, truncated) = match max_lines {
        Some(max) if total > max => (&lines[..max], total - max),
        _ => (&lines[..], 0),
    };

    // Pair consecutive delete-runs with the insert-run that follows.
    let mut paired: Vec<Option<usize>> = vec![None; shown.len()];
    let mut i = 0;
    while i < shown.len() {
        if shown[i].starts_with('-') && !shown[i].starts_with("---") {
            let d_start = i;
            while i < shown.len() && shown[i].starts_with('-') {
                i += 1;
            }
            let d_end = i; // deletes: [d_start, d_end)
            let i_start = i;
            while i < shown.len() && shown[i].starts_with('+') {
                i += 1;
            }
            let i_end = i; // inserts: [i_start, i_end)
            for k in 0..(d_end - d_start).min(i_end - i_start) {
                paired[d_start + k] = Some(i_start + k);
                paired[i_start + k] = Some(d_start + k);
            }
        } else {
            i += 1;
        }
    }

    for (idx, line) in shown.iter().enumerate() {
        let is_file_header = (line.starts_with("--- ") || line.starts_with("+++ "))
            && idx < 4;
        let class = diff_class(line, is_file_header);
        let pair = paired[idx].map(|j| shown[j]);
        emit_diff_line(m, parent, line, class, pair);
    }
    if truncated > 0 {
        trunc_marker(m, parent, truncated);
    }
}

/// `ToolOutputLines` — plain (non-diff) output lines with truncation.
/// `tail: true` shows the LAST `max` lines (live sliding window while
/// the tool runs); `false` shows the first `max` + truncation marker.
pub fn build_output_lines(
    m: &mut DocumentMutator<'_>,
    parent: NodeId,
    text: &str,
    lang: Option<&'static str>,
    max_lines: Option<usize>,
    tail: bool,
) {
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    let (shown, hidden) = match max_lines {
        Some(max) if total > max => {
            if tail {
                (&lines[total - max..], total - max)
            } else {
                (&lines[..max], total - max)
            }
        }
        _ => (&lines[..], 0),
    };
    if tail && hidden > 0 {
        let row = div(m, parent, "tool-trunc");
        span_text(m, row, "", &format!("… {hidden} lines above"));
    }
    for line in shown {
        let row = div(m, parent, "tool-line");
        highlight_line(m, row, &HighlightedLine { line, lang });
    }
    if !tail && hidden > 0 {
        trunc_marker(m, parent, hidden);
    }
}

/// The `[... N lines truncated (ctrl+o to expand) ...]` marker row —
/// clickable (`data-hit-expand` toggles `msg.expanded`).
fn trunc_marker(m: &mut DocumentMutator<'_>, parent: NodeId, hidden: usize) {
    let row = div(m, parent, "tool-trunc");
    m.set_attribute(row, qual("data-hit-expand"), "");
    span_text(
        m,
        row,
        "",
        &format!("[... {hidden} lines truncated (ctrl+o to expand) ...]"),
    );
}

/// Short target for a tool's args (path / pattern / url / command).
pub fn tool_target(args: &serde_json::Value) -> String {
    let get = |keys: &[&str]| -> Option<String> {
        for k in keys {
            if let Some(s) = args.get(*k).and_then(|v| v.as_str()) {
                if !s.is_empty() {
                    return Some(s.to_string());
                }
            }
        }
        None
    };
    get(&["path", "file", "file_path", "filePath", "filename"])
        .or_else(|| get(&["pattern", "query", "glob"]).map(|q| format!("\"{q}\"")))
        .or_else(|| get(&["url", "uri"]))
        .or_else(|| get(&["command", "cmd"]).map(|c| {
            c.lines().next().unwrap_or("").chars().take(80).collect()
        }))
        .or_else(|| get(&["description", "prompt", "name", "task"]).map(|d| {
            d.lines().next().unwrap_or("").chars().take(60).collect()
        }))
        .unwrap_or_default()
}

/// Devin-style display verb + target for a tool call
/// (`● Ran command`, `● Wrote src/app.rs`, `● Searched "foo"`).
pub fn tool_display(tool_name: &str, args: Option<&serde_json::Value>, fallback: &str) -> String {
    let n = tool_name.to_ascii_lowercase();
    let verb = match n.as_str() {
        "bash" | "shell" | "sh" | "run_command" => "Ran command",
        "write" | "write_file" | "create_file" => "Wrote",
        "edit" | "edit_file" | "str_replace" | "apply_patch" => "Edited",
        "read" | "read_file" | "view" => "Read",
        "grep" | "search" | "find" | "rg" | "glob" | "ls" => "Searched",
        "fetch" | "web_fetch" | "curl" | "http" => "Fetched",
        "task" | "agent" | "subagent" | "teammate" => "Spawned agent",
        "todo" | "plan" => "Updated plan",
        _ => "",
    };
    let target = args
        .map(tool_target)
        .filter(|t| !t.is_empty())
        .or_else(|| (!fallback.is_empty()).then(|| fallback.to_string()))
        .unwrap_or_default();
    if verb.is_empty() {
        // Unknown tool: `name target` (or the args summary).
        return if target.is_empty() {
            if fallback.is_empty() {
                tool_name.to_string()
            } else {
                format!("{tool_name} {fallback}")
            }
        } else {
            format!("{tool_name} {target}")
        };
    }
    if target.is_empty() || verb == "Ran command" {
        verb.to_string()
    } else {
        format!("{verb} {target}")
    }
}

/// Synthesized diff lines for edit/write tools: `(line, is_delete)`.
/// Devin shows `-old`/`+new` inside the card body.
pub fn edit_diff_lines(args: &serde_json::Value) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    let push_pair = |old: Option<&str>, new: Option<&str>, out: &mut Vec<(String, bool)>| {
        if let Some(o) = old {
            for l in o.lines() {
                out.push((format!("-{l}"), true));
            }
        }
        if let Some(n) = new {
            for l in n.lines() {
                out.push((format!("+{l}"), false));
            }
        }
    };
    // Single edit: old_string/new_string (or oldText/newText).
    let old = args
        .get("old_string")
        .or_else(|| args.get("oldText"))
        .or_else(|| args.get("old"))
        .and_then(|v| v.as_str());
    let new = args
        .get("new_string")
        .or_else(|| args.get("newText"))
        .or_else(|| args.get("new"))
        .and_then(|v| v.as_str());
    push_pair(old, new, &mut out);
    // Multi-edit: `edits: [{old_string, new_string}, …]`.
    if let Some(edits) = args.get("edits").and_then(|v| v.as_array()) {
        for e in edits {
            let o = e
                .get("old_string")
                .or_else(|| e.get("oldText"))
                .and_then(|v| v.as_str());
            let n = e
                .get("new_string")
                .or_else(|| e.get("newText"))
                .and_then(|v| v.as_str());
            push_pair(o, n, &mut out);
        }
    }
    // Write: whole-file content → all `+` lines.
    if out.is_empty() {
        if let Some(c) = args
            .get("content")
            .or_else(|| args.get("text"))
            .and_then(|v| v.as_str())
        {
            for l in c.lines() {
                out.push((format!("+{l}"), false));
            }
        }
    }
    out
}

/// `ToolView` — fill the `.msg.msg-tool` bubble with header + body +
/// footer. Devin style: `● Ran command` header, `│ $ cmd` / diff /
/// output / subagent-activity body, and a closing `└ …` footer on
/// every call. `tray_entry` feeds the subagent activity stream.
/// Returns `(glyph_text_node, head_text_node)` for incremental patching.
pub fn build_card(
    m: &mut DocumentMutator<'_>,
    bubble: NodeId,
    msg: &Message,
    mode: GlyphMode,
    tray_entry: Option<&crate::state::TrayEntry>,
) -> (NodeId, NodeId) {
    let status = ToolStatus::from_char(msg.tool_status);
    let head = div(m, bubble, "tool-head");
    let (_gs, glyph_text) = span_text(m, head, status.class(), status_glyph(mode, msg.tool_status));
    let name = msg.tool_name.as_deref().unwrap_or("tool");
    let title = tool_display(name, msg.tool_args.as_ref(), &msg.text);
    let (_ns, head_text) = span_text(m, head, "tool-name", &format!(" {title}"));

    // Body: `$ command` line for shell tools, synthesized diff for
    // edit/write, then output (diff-aware) — truncated unless expanded.
    let cmd = msg
        .tool_args
        .as_ref()
        .and_then(|a| a.get("command").or_else(|| a.get("cmd")))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let diff_lines = msg
        .tool_args
        .as_ref()
        .map(edit_diff_lines)
        .unwrap_or_default();
    let has_body = cmd.is_some()
        || !diff_lines.is_empty()
        || tray_entry.is_some_and(|e| !e.recent_tools.is_empty())
        || msg.tool_output.as_ref().is_some_and(|o| !o.is_empty());
    if has_body {
        let body = div(m, bubble, "tool-body");
        if let Some(c) = &cmd {
            let row = div(m, body, "tool-line tool-cmd");
            span_text(m, row, "", &format!("$ {c}"));
        }
        // Subagent activity feed: nested tools as `· name target` rows.
        if let Some(e) = tray_entry {
            for (name, target) in &e.recent_tools {
                let row = div(m, body, "tool-line tool-activity");
                let text = if target.is_empty() {
                    format!("· {name}")
                } else {
                    format!("· {name} {target}")
                };
                span_text(m, row, "", &text);
            }
        }
        if !diff_lines.is_empty() {
            let max = if msg.expanded {
                usize::MAX
            } else {
                COLLAPSED_LINES
            };
            let total = diff_lines.len();
            for (line, is_del) in diff_lines.iter().take(max) {
                let class = if *is_del {
                    "diff-line-delete"
                } else {
                    "diff-line-insert"
                };
                let row = div(m, body, class);
                span_text(m, row, "", line);
            }
            if total > max {
                trunc_marker(m, body, total - max);
            }
        }
        if let Some(output) = &msg.tool_output {
            if !output.is_empty() {
                // Running/partial: fixed-height sliding tail window;
                // finished: collapsed head + truncation marker.
                let running = matches!(status, ToolStatus::Running | ToolStatus::Partial);
                let max = if msg.expanded {
                    None
                } else {
                    Some(COLLAPSED_LINES)
                };
                if looks_like_diff(output) {
                    build_diff(m, body, output, max);
                } else {
                    build_output_lines(m, body, output, msg.tool_lang, max, running);
                }
            }
        }
    }
    // Footer: always close the tree frame — `└ Exited with code N`
    // when the result carried an exit code, else a status word.
    let foot = div(m, bubble, "tool-foot");
    let label = if let Some(code) = msg.tool_exit {
        format!("Exited with code {code}")
    } else {
        match status {
            ToolStatus::Running => "Running…".to_string(),
            ToolStatus::Pending => "Pending".to_string(),
            ToolStatus::Partial => "Partial".to_string(),
            ToolStatus::Ok => "Done".to_string(),
            ToolStatus::Err => "Failed".to_string(),
        }
    };
    span_text(m, foot, "", &format!("└ {label}"));
    (glyph_text, head_text)
}
