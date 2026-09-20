//! `theme` — Devin dark/light CSS variable theme → blitz-dom UA stylesheet.
//!
//! Recovered verbatim from `devin-re/SCROLLBACK-RECON.md` §12.1 (full CSS
//! dump at `.rdata` 0x736a788..0x736d3d6, ~11KB with comments). The
//! stylesheet is injected as a user-agent sheet so component `class`
//! attributes resolve through stylo; `var(--x)` is resolved by stylo's
//! custom-property machinery.
//!
//! Root `color: transparent` maps to `Color::Reset` (terminal-native fg) in
//! `scrollback::cell_render` — matching the original's convention.

use scrollback::{CellStyle, Color, Modifier};

/// Which theme variant is active.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThemeKind {
    Dark,
    Light,
}

impl ThemeKind {
    /// The blitz-dom `ColorScheme` for the viewport.
    pub fn color_scheme(self) -> blitz_traits::shell::ColorScheme {
        match self {
            Self::Dark => blitz_traits::shell::ColorScheme::Dark,
            Self::Light => blitz_traits::shell::ColorScheme::Light,
        }
    }
}

/// Detect the theme from the environment.
///
/// `PI_TUI_THEME=dark|light` wins; otherwise `COLORFGBG` (a light terminal
/// background ends with a light fg color index like `0;15`/`15`) decides;
/// default dark.
pub fn detect() -> ThemeKind {
    match std::env::var("PI_TUI_THEME").ok().as_deref() {
        Some("light") => return ThemeKind::Light,
        Some("dark") => return ThemeKind::Dark,
        _ => {}
    }
    if let Ok(v) = std::env::var("COLORFGBG") {
        if let Some(last) = v.rsplit(';').next() {
            if let Ok(bg) = last.trim().parse::<u8>() {
                // Light backgrounds: 7, 15, or bright colors.
                if matches!(bg, 7 | 15) || bg >= 8 && bg != 8 {
                    return ThemeKind::Light;
                }
            }
        }
    }
    ThemeKind::Dark
}

/// The UA stylesheet for the given theme.
///
/// Layout contract (1 CSS px = 1 terminal cell):
/// `font-size:1px; line-height:1px` + the embedded TerminalMono font whose
/// advance == unitsPerEm (1000) make every character exactly 1 cell wide.
/// `white-space:pre-wrap` preserves newlines and wraps at the content edge.
///
/// The variable block + utility classes are verbatim from the original
/// (RECON §12.1); the `#app`/component section is our app shell.
pub fn stylesheet(kind: ThemeKind) -> String {
    let v = match kind {
        ThemeKind::Dark => Vars::DARK,
        ThemeKind::Light => Vars::LIGHT,
    };
    // `.theme-light` overrides are emitted as a flat block when kind==Light
    // (blitz-dom has no .theme-light class toggle — we bake the variant).
    format!(
        r#"
:root {{
    --text-primary: {text_primary};
    --text-secondary: {text_secondary};
    --text-muted: {text_muted};
    --accent-primary: {accent_primary};
    --accent-secondary: {accent_secondary};
    --fusion-lead: {fusion_lead};
    --fusion-sidekick: {fusion_sidekick};
    --fusion-highlight: {fusion_highlight};
    --status-success: {status_success};
    --status-warning: {status_warning};
    --status-error: {status_error};
    --status-info: {status_info};
    --surface-base: transparent;
    --surface-elevated: {surface_elevated};
    --surface-dropdown: {surface_dropdown};
    --surface-dropdown-selected: {surface_dropdown_selected};
    --surface-overlay: {surface_overlay};
    --text-inverted: {text_inverted};
    --border-default: {border_default};
    --selection-indicator: {selection_indicator};
    --surface-accent: {surface_accent};
    --text-on-surface-accent: {text_on_surface_accent};
    --link-color: {link_color};
    --link-hover: {link_hover};
    --code-block-bg: {code_block_bg};
    --code-inline-bg: {code_inline_bg};
    --diff-insert-bg: {diff_insert_bg};
    --diff-delete-bg: {diff_delete_bg};
    --diff-emphasis-insert-bg: {diff_emphasis_insert_bg};
    --diff-emphasis-delete-bg: {diff_emphasis_delete_bg};
    color: transparent;
}}

html, body {{
    width: 100%;
    margin: 0;
    padding: 0;
    font-family: "TerminalMono", monospace;
    font-size: 1px;
    line-height: 1px;
    white-space: pre-wrap;
    word-wrap: break-word;
    font-kerning: none;
    font-variant-ligatures: none;
    font-feature-settings: "kern" 0, "liga" 0, "clig" 0;
    letter-spacing: 0;
    background: var(--surface-base);
    color: transparent;
}}

main {{ display: block; }}
body > main {{ width: 100%; }}

div, p, pre, ul, ol, li, header, footer, section, article, nav,
textarea, span, a, strong, b, em, i, code, h1, h2, h3, h4, h5, h6 {{
    display: block;
    line-height: 1px;
}}
span, a, strong, b, em, i, code {{
    display: inline;
    line-height: 1px;
}}
h1, h2, h3, h4, h5, h6, p, ul, ol, li {{ margin: 0; padding: 0; }}
li p {{ display: inline; }}
h1, h2, h3, h4, h5, h6 {{ font-size: 1em; }}
a {{ color: var(--link-color); text-decoration: underline; word-break: break-all; }}
strong, b {{ font-weight: bold; }}
em, i {{ font-style: italic; }}
s, del {{ text-decoration: line-through; }}
code, pre {{ font-family: monospace; background: var(--surface-elevated); color: var(--text-primary); padding: 0; word-break: break-all; }}
pre {{ white-space: pre-wrap; }}
hr {{ display: block; width: 100%; height: 1px; margin: 0; padding: 0; border: none; }}
img {{ display: block; }}
ul, ol {{ margin: 0; padding-left: 2px; }}
button, input, select, textarea {{ background: var(--surface-elevated); color: var(--text-primary); border: none; padding: 0; }}
button:focus, input:focus, select:focus, textarea:focus {{ outline: none; background: var(--surface-overlay); color: var(--accent-primary); }}

/* Utility classes */
.text-secondary {{ color: var(--text-secondary); }}
.text-muted {{ color: var(--text-muted); }}
.text-accent {{ color: var(--accent-primary); }}
.text-success {{ color: var(--status-success); }}
.text-warning {{ color: var(--status-warning); }}
.text-error {{ color: var(--status-error); }}
.text-info {{ color: var(--status-info); }}
.text-selection {{ color: var(--selection-indicator); }}
.text-border {{ color: var(--border-default); }}
.color-muted {{ color: var(--text-muted); }}

.text-heading-h1 {{ color: #d946ef; }}

.bg-code-block {{ background: var(--surface-elevated); color: var(--text-primary); }}
.bg-code-inline {{ background: var(--surface-overlay); }}
.bg-base {{ background: var(--surface-base); }}
.bg-elevated {{ background: var(--surface-elevated); color: var(--text-primary); }}
.bg-overlay {{ background: var(--surface-overlay); color: var(--text-primary); }}

/* Inverted highlight (active tab, selected attachment). */
.inverted {{ background: var(--text-muted); color: var(--text-inverted); }}

/* Diff line backgrounds (lighter) */
.diff-line-context {{ background: var(--surface-elevated); color: var(--text-primary); }}
.diff-line-insert {{ background: {diff_insert_bg}; color: var(--text-primary); }}
.diff-line-delete {{ background: {diff_delete_bg}; color: var(--text-primary); }}
/* Diff emphasis backgrounds (stronger, for changed segments) */
.diff-emphasis-insert {{ background: {diff_emphasis_insert_bg}; color: var(--text-primary); }}
.diff-emphasis-delete {{ background: {diff_emphasis_delete_bg}; color: var(--text-primary); }}

/* User message background — flat fill, no border (RECON §12.1). */
.user-message {{ background: {user_message_bg}; color: var(--text-primary); }}

/* Syntax highlighting */
.syntax-keyword {{ color: {syn_keyword}; }}
.syntax-string {{ color: {syn_string}; }}
.syntax-comment {{ color: {syn_comment}; }}
.syntax-function {{ color: {syn_function}; }}
.syntax-type {{ color: {syn_type}; }}
.syntax-number {{ color: {syn_number}; }}
.syntax-constant {{ color: {syn_constant}; }}
.syntax-operator {{ color: var(--text-primary); }}
.syntax-variable-builtin {{ color: {syn_var_builtin}; }}
.syntax-attribute {{ color: {syn_var_builtin}; }}
.syntax-property {{ color: {syn_var_builtin}; }}

/* Hide tips on narrow terminals */
.tip-text {{ display: inline; }}
@media (max-width: 79px) {{
    .tip-text {{ display: none; }}
}}

/* Tables render as pre-formatted monospace lines (`│ a │ b │`) —
   taffy has no `display: table`, so markdown.rs emits aligned text. */
.md-table {{ display: flex; flex-direction: column; }}
.md-tr {{ color: var(--text-secondary); }}
.md-th {{ color: var(--text-primary); font-weight: bold; }}
.md-sep {{ color: var(--border-default); }}

/* Math: `$…$` inline, `$$…$$` display block (raw TeX, accent color). */
.md-math {{ color: var(--accent-primary); }}
.md-math-display {{ padding-left: 2px; }}

.model-picker {{
    --model-picker-wide-display: flex;
    --model-picker-narrow-display: none;
    --model-picker-pricing-margin-top: 1px;
}}
.model-picker .select-inline-hint {{ display: none; }}
@media (max-width: 99px) {{
    .model-picker {{
        --model-picker-wide-display: none;
        --model-picker-narrow-display: flex;
        --model-picker-pricing-margin-top: 0px;
    }}
    .model-picker .select-desc {{ display: none; }}
}}

/* ============================ app shell ============================ */

#app {{
    display: flex;
    flex-direction: column;
    overflow: hidden;
}}

#messages {{
    flex-grow: 1;
    flex-shrink: 1;
    flex-basis: 0px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    padding-top: 1px;
}}

.msg {{
    margin-bottom: 1px;
    padding-left: 1px;
    padding-right: 1px;
    flex-shrink: 0;
}}

.msg-user {{
    align-self: flex-start;
    max-width: 90%;
    background: {user_message_bg};
    color: var(--text-primary);
}}

.msg-assistant {{
    align-self: stretch;
    color: var(--text-primary);
}}

.msg-thinking {{
    align-self: stretch;
    color: var(--text-muted);
    font-style: italic;
}}

.msg-tool {{
    align-self: stretch;
    color: var(--text-muted);
}}

.msg-error {{
    align-self: stretch;
    color: var(--status-error);
}}

.msg-system {{
    align-self: stretch;
    color: var(--text-muted);
}}

/* Nested tool card of a backgrounded subagent (Devin subagent/mode). */
.msg-hidden {{ display: none; }}

.tool-glyph {{ color: var(--accent-primary); }}
.tool-glyph-ok {{ color: var(--status-success); }}
.tool-glyph-err {{ color: var(--status-error); }}
.tool-glyph-run {{ color: var(--status-warning); }}

#input-area {{
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--border-default);
    /* Bottom rule closes the input box — pickers/completion render
       below it (native pi layout). */
    border-bottom: 1px solid var(--border-default);
}}

#input-hint {{
    color: var(--text-muted);
    padding-left: 1px;
}}

#input-box {{
    display: flex;
    flex-direction: row;
    padding-left: 1px;
    padding-right: 1px;
    max-height: 8px;
    overflow: hidden;
}}

#input-prompt {{
    color: var(--accent-primary);
    font-weight: bold;
    flex-shrink: 0;
    width: 2px;
}}

#input-text {{
    flex-grow: 1;
    color: var(--text-primary);
}}

#completion-area {{
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}}
.completion-item {{
    display: flex;
    flex-direction: row;
    color: var(--text-primary);
    padding-left: 1px;
}}
.completion-item.selected {{
    background-color: var(--surface-accent);
    color: var(--text-on-surface-accent);
}}
.completion-marker {{ color: var(--accent-primary); flex-shrink: 0; }}
.completion-label {{ color: var(--text-primary); flex-shrink: 0; }}
.completion-desc {{ color: var(--text-muted); }}
.completion-more {{ color: var(--text-muted); padding-left: 2px; }}
.queued-line {{ color: var(--text-muted); padding-left: 1px; }}

#status-line {{
    flex-shrink: 0;
    display: flex;
    flex-direction: row;
    color: var(--text-muted);
    padding-left: 1px;
    padding-right: 1px;
}}

#status-right {{
    margin-left: auto;
    color: var(--text-muted);
}}

.status-accent {{ color: var(--accent-primary); }}
.status-ok {{ color: var(--status-success); }}
.status-warn {{ color: var(--status-warning); }}
.status-err {{ color: var(--status-error); }}

/* ---------- markdown ---------- */

.text-accent {{ color: var(--accent-primary); }}
.md-p {{ margin-bottom: 0px; }}
.md-h {{ font-weight: bold; }}
.md-h2 {{ color: var(--accent-primary); }}
.md-h3 {{ color: var(--accent-primary); }}
.md-h4, .md-h5, .md-h6 {{ color: var(--text-secondary); }}
.md-bq {{
    border-left: 1px solid var(--border-default);
    padding-left: 1px;
    color: var(--text-secondary);
}}
.md-muted {{ color: var(--text-muted); }}
.md-em {{ font-style: italic; }}
.md-strong {{ font-weight: bold; }}
.md-strike {{ text-decoration: line-through; }}
.md-li {{ padding-left: 1px; }}
.md-li-marker {{ color: var(--text-muted); }}
.md-task {{ color: var(--accent-primary); }}
.md-link-target {{ color: var(--accent-primary); }}

/* ---------- tool card ---------- */

.tool-head {{ display: flex; flex-direction: row; }}
.tool-name {{ color: var(--text-secondary); font-weight: bold; }}
.tool-args {{ color: var(--text-muted); }}
.tool-body {{
    border-left: 1px solid var(--border-default);
    padding-left: 1px;
}}
.tool-line {{ color: var(--text-secondary); }}
.tool-cmd {{ color: var(--text-primary); }}
.tool-foot {{
    color: var(--text-muted);
}}
.tool-trunc {{ color: var(--text-muted); font-style: italic; }}
.diff-line-hunk {{ color: var(--accent-primary); }}
.diff-line-file {{ color: var(--text-secondary); font-weight: bold; }}
.hl-line {{ color: var(--text-secondary); }}

/* ---------- spinner / tips / completion ---------- */

#spinner-line {{
    flex-shrink: 0;
    display: flex;
    flex-direction: row;
    padding-left: 1px;
    max-height: 1px;
    overflow: hidden;
}}
#spinner-label {{ color: var(--accent-primary); }}
#spinner-dots {{ color: var(--accent-primary); }}
#spinner-hint {{ color: var(--accent-primary); font-weight: bold; }}

/* ---------- select dropdown + dialogs ---------- */

#dialog-area {{ position: relative; flex-shrink: 0; }}
.select-wrap {{ display: flex; flex-direction: column; }}
.select-title {{ color: var(--text-primary); font-weight: bold; padding-left: 1px; }}
.select-filter {{ color: var(--text-muted); padding-left: 1px; }}
.select-filter-label {{ color: var(--text-muted); }}
/* Native pi style: no background block — plain rows below the input
   box, selected row marked by the cursor glyph only. */
.select-dropdown {{
    display: flex;
    flex-direction: column;
}}
.select-option {{ color: var(--text-primary); }}
.select-option.selected {{
    color: var(--text-primary);
    font-weight: bold;
}}
.select-cursor {{ color: var(--accent-primary); }}
.select-desc {{ color: var(--text-muted); }}
.select-badge {{ color: var(--selection-indicator); font-weight: bold; }}
.badge-new {{ color: var(--status-success); }}
.badge-promotion {{ color: var(--accent-primary); }}
.badge-beta {{ color: var(--status-warning); }}
.select-more {{ color: var(--text-muted); padding-left: 2px; }}
.select-footer {{ color: var(--text-muted); padding-left: 1px; border-top: 1px solid var(--border-default); }}
.select-footer-text {{ color: var(--text-muted); }}
.select-empty {{ color: var(--text-muted); }}
.select-inline-hint {{ color: var(--text-muted); }}

.toast {{
    background-color: var(--surface-dropdown);
    color: var(--text-primary);
    border-left: 1px solid var(--accent-primary);
    padding-left: 1px;
}}
.dialog-confirm, .dialog-input, .dialog-editor {{
    background-color: var(--surface-dropdown);
    border: 1px solid var(--border-default);
    padding-left: 1px;
    padding-right: 1px;
}}
.dialog-title {{ color: var(--text-primary); font-weight: bold; }}
.dialog-message {{ color: var(--text-secondary); }}
.dialog-bar {{ display: flex; flex-direction: row; }}
.dialog-btn {{ display: flex; flex-direction: row; margin-right: 2px; }}
.dialog-prompt {{ color: var(--accent-primary); font-weight: bold; }}
.dialog-input-box {{ display: flex; flex-direction: row; }}
.dialog-input-text {{ color: var(--text-primary); }}
.dialog-input-text.placeholder {{ color: var(--text-muted); }}
.dialog-editor-box {{
    border: 1px solid var(--border-default);
    color: var(--text-primary);
    max-height: 8px;
    overflow: hidden;
}}
.dialog-hint {{ display: flex; flex-direction: row; }}
#widget-area {{ flex-shrink: 0; }}
.widget-line {{ color: var(--text-secondary); padding-left: 1px; }}

/* ---------- plugin overlay (extension custom surface) ---------- */

.overlay-card {{
    background-color: var(--surface-overlay);
    border: 1px solid var(--border-default);
    padding-left: 1px;
    padding-right: 1px;
    overflow: hidden;
}}
.ov-title {{ color: var(--text-primary); font-weight: bold; }}
.ov-row {{ display: flex; flex-direction: row; color: var(--text-primary); }}
.ov-row.selected {{ background-color: var(--surface-accent); }}
.ov-hints {{ display: flex; flex-direction: row; border-top: 1px solid var(--border-default); }}
.hint-key {{ color: var(--accent-primary); font-weight: bold; }}
.hint-verb {{ color: var(--text-muted); }}
.hint-sep {{ color: var(--text-muted); }}

/* Span roles — the closed style vocabulary plugins may use. */
.role-text {{ color: var(--text-primary); }}
.role-muted {{ color: var(--text-muted); }}
.role-dim {{ color: var(--text-muted); }}
.role-accent {{ color: var(--accent-primary); }}
.role-warning {{ color: var(--status-warning); }}
.role-error {{ color: var(--status-error); }}
.role-success {{ color: var(--status-success); }}
.role-border {{ color: var(--border-default); }}
.role-selected {{ color: var(--accent-primary); font-weight: bold; }}
.role-hint-key {{ color: var(--accent-primary); font-weight: bold; }}
.role-hint-verb {{ color: var(--text-muted); }}
.bold {{ font-weight: bold; }}

/* ---------- subagent tray / tabs ---------- */

.tray-panel {{
    border: 1px solid var(--border-default);
    background-color: var(--surface-dropdown);
}}
.tray-tabs {{ display: flex; flex-direction: row; border-bottom: 1px solid var(--border-default); }}
.tray-tab {{ padding-left: 1px; padding-right: 1px; color: var(--text-muted); }}
.tray-tab.active {{ background: var(--text-muted); color: var(--text-inverted); }}
.tray-empty {{ color: var(--text-muted); padding-left: 1px; }}
.tray-empty-sub {{ color: var(--text-muted); padding-left: 1px; font-style: italic; }}
.tray-split {{ display: flex; flex-direction: row; }}
.tray-list {{ flex-shrink: 0; min-width: 30px; }}
.tray-item {{ display: flex; flex-direction: row; padding-left: 1px; }}
.tray-item.selected {{ background: var(--surface-accent); color: var(--text-on-surface-accent); }}
.tray-status {{ flex-shrink: 0; width: 10px; }}
.tray-name {{ color: var(--text-primary); }}
.tray-meta {{ color: var(--text-muted); }}
.tray-preview {{
    flex-grow: 1;
    border-left: 1px solid var(--border-default);
    padding-left: 1px;
    overflow: hidden;
}}
.tray-preview-title {{ color: var(--text-primary); font-weight: bold; }}
.tray-preview-meta {{ color: var(--text-muted); }}
.tray-preview-label {{ color: var(--accent-primary); }}
.tray-preview-tool {{ color: var(--text-secondary); }}
.tray-preview-line {{ color: var(--text-muted); }}
.tray-preview-hint {{ color: var(--text-muted); font-style: italic; }}

/* ---------- startup banner / welcome ---------- */

.startup-logo {{ color: var(--accent-primary); font-weight: bold; }}
.welcome-box {{
    border: 1px solid var(--border-default);
    padding-left: 1px;
    padding-right: 1px;
    color: var(--text-secondary);
}}

/* ---------- message action bar ---------- */

.action-bar {{ display: flex; flex-direction: row; }}
.action-btn {{ color: var(--text-muted); margin-right: 2px; }}
.action-btn:hover {{ color: var(--accent-primary); }}
"#,
        text_primary = v.text_primary,
        text_secondary = v.text_secondary,
        text_muted = v.text_muted,
        accent_primary = v.accent_primary,
        accent_secondary = v.accent_secondary,
        fusion_lead = v.fusion_lead,
        fusion_sidekick = v.fusion_sidekick,
        fusion_highlight = v.fusion_highlight,
        status_success = v.status_success,
        status_warning = v.status_warning,
        status_error = v.status_error,
        status_info = v.status_info,
        surface_elevated = v.surface_elevated,
        surface_dropdown = v.surface_dropdown,
        surface_dropdown_selected = v.surface_dropdown_selected,
        surface_overlay = v.surface_overlay,
        text_inverted = v.text_inverted,
        border_default = v.border_default,
        selection_indicator = v.selection_indicator,
        surface_accent = v.surface_accent,
        text_on_surface_accent = v.text_on_surface_accent,
        link_color = v.link_color,
        link_hover = v.link_hover,
        code_block_bg = v.code_block_bg,
        code_inline_bg = v.code_inline_bg,
        diff_insert_bg = v.diff_insert_bg,
        diff_delete_bg = v.diff_delete_bg,
        diff_emphasis_insert_bg = v.diff_emphasis_insert_bg,
        diff_emphasis_delete_bg = v.diff_emphasis_delete_bg,
        user_message_bg = v.user_message_bg,
        syn_keyword = v.syn_keyword,
        syn_string = v.syn_string,
        syn_comment = v.syn_comment,
        syn_function = v.syn_function,
        syn_type = v.syn_type,
        syn_number = v.syn_number,
        syn_constant = v.syn_constant,
        syn_var_builtin = v.syn_var_builtin,
    )
}

/// Theme variable values (dark / light), recovered from RECON §12.1.
struct Vars {
    text_primary: &'static str,
    text_secondary: &'static str,
    text_muted: &'static str,
    accent_primary: &'static str,
    accent_secondary: &'static str,
    fusion_lead: &'static str,
    fusion_sidekick: &'static str,
    fusion_highlight: &'static str,
    status_success: &'static str,
    status_warning: &'static str,
    status_error: &'static str,
    status_info: &'static str,
    surface_elevated: &'static str,
    surface_dropdown: &'static str,
    surface_dropdown_selected: &'static str,
    surface_overlay: &'static str,
    text_inverted: &'static str,
    border_default: &'static str,
    selection_indicator: &'static str,
    surface_accent: &'static str,
    text_on_surface_accent: &'static str,
    link_color: &'static str,
    link_hover: &'static str,
    code_block_bg: &'static str,
    code_inline_bg: &'static str,
    diff_insert_bg: &'static str,
    diff_delete_bg: &'static str,
    diff_emphasis_insert_bg: &'static str,
    diff_emphasis_delete_bg: &'static str,
    user_message_bg: &'static str,
    syn_keyword: &'static str,
    syn_string: &'static str,
    syn_comment: &'static str,
    syn_function: &'static str,
    syn_type: &'static str,
    syn_number: &'static str,
    syn_constant: &'static str,
    syn_var_builtin: &'static str,
}

impl Vars {
    const DARK: Vars = Vars {
        text_primary: "white",
        text_secondary: "#b0b0b0",
        text_muted: "#7c7c7c",
        accent_primary: "#5ec4ff",
        accent_secondary: "#569cd6",
        fusion_lead: "#4eb6f7",
        fusion_sidekick: "#90a9bf",
        fusion_highlight: "#cfefff",
        status_success: "#4ade80",
        status_warning: "#dcdcaa",
        status_error: "#f44747",
        status_info: "#5ec4ff",
        surface_elevated: "#1f1f1f",
        surface_dropdown: "#2a2a2a",
        surface_dropdown_selected: "#525252",
        surface_overlay: "#002b36",
        text_inverted: "#000000",
        border_default: "#444444",
        selection_indicator: "#b06ab3",
        surface_accent: "#0d1f2d",
        text_on_surface_accent: "#5ec4ff",
        link_color: "#5ec4ff",
        link_hover: "#4f94cd",
        code_block_bg: "#1f1f1f",
        code_inline_bg: "#002b36",
        diff_insert_bg: "#0d2818",
        diff_delete_bg: "#2d1517",
        diff_emphasis_insert_bg: "#1e4a28",
        diff_emphasis_delete_bg: "#4a1e22",
        user_message_bg: "#2a2a2a",
        syn_keyword: "#c586c0",
        syn_string: "#ce9178",
        syn_comment: "#6a9955",
        syn_function: "#dcdcaa",
        syn_type: "#4ec9b0",
        syn_number: "#b5cea8",
        syn_constant: "#4fc1ff",
        syn_var_builtin: "#9cdcfe",
    };

    const LIGHT: Vars = Vars {
        text_primary: "#1e1e1e",
        text_secondary: "#444444",
        text_muted: "#7f7f7f",
        accent_primary: "#0077aa",
        accent_secondary: "#005a9e",
        // color-mix(in srgb, <dark> 55-58%, black) precomputed.
        fusion_lead: "#2d6990",
        fusion_sidekick: "#54616d",
        fusion_highlight: "#74848c",
        status_success: "#22863a",
        status_warning: "#b08800",
        status_error: "#cb2431",
        status_info: "#0077aa",
        surface_elevated: "#eeeeee",
        surface_dropdown: "#e8e8e8",
        surface_dropdown_selected: "#d6d6d6",
        surface_overlay: "#e8e8e8",
        text_inverted: "#ffffff",
        border_default: "#cccccc",
        selection_indicator: "#6a0dad",
        surface_accent: "#e0f0fa",
        text_on_surface_accent: "#005a9e",
        link_color: "#0077aa",
        link_hover: "#005a9e",
        code_block_bg: "#eeeeee",
        code_inline_bg: "#e8e8e8",
        diff_insert_bg: "#d4f5d4",
        diff_delete_bg: "#f5d4d4",
        diff_emphasis_insert_bg: "#a6f3a6",
        diff_emphasis_delete_bg: "#f3a6a6",
        user_message_bg: "#e8e8e8",
        syn_keyword: "#af00db",
        syn_string: "#a31515",
        syn_comment: "#008000",
        syn_function: "#795e26",
        syn_type: "#267f99",
        syn_number: "#098658",
        syn_constant: "#0070c1",
        syn_var_builtin: "#001080",
    };
}

// ---------------------------------------------------------------------------
// CellStyle helpers — for code paths that paint outside the DOM pipeline
// (e.g. cursor post-processing) or need a concrete style value.
// ---------------------------------------------------------------------------

fn rgb(hex: &str) -> Color {
    let h = hex.trim_start_matches('#');
    let r = u8::from_str_radix(&h[0..2], 16).unwrap_or(0);
    let g = u8::from_str_radix(&h[2..4], 16).unwrap_or(0);
    let b = u8::from_str_radix(&h[4..6], 16).unwrap_or(0);
    Color::Rgb(r, g, b)
}

/// `CellStyle` for a theme variable, resolved for the active theme.
pub struct Theme {
    kind: ThemeKind,
}

impl Theme {
    pub fn new(kind: ThemeKind) -> Self {
        Self { kind }
    }

    fn var(&self, pick: fn(&Vars) -> &'static str) -> Color {
        let v = match self.kind {
            ThemeKind::Dark => &Vars::DARK,
            ThemeKind::Light => &Vars::LIGHT,
        };
        let s = pick(v);
        if s == "white" {
            return Color::Rgb(255, 255, 255);
        }
        rgb(s)
    }

    // Concrete color accessors — the `CellStyle` side of the CSS-variable
    // mapping. Used by non-DOM paint paths (cursor, future dialogs).
    #[allow(dead_code)]
    pub fn text_primary(&self) -> Color {
        self.var(|v| v.text_primary)
    }
    #[allow(dead_code)]
    pub fn text_muted(&self) -> Color {
        self.var(|v| v.text_muted)
    }
    #[allow(dead_code)]
    pub fn accent(&self) -> Color {
        self.var(|v| v.accent_primary)
    }
    #[allow(dead_code)]
    pub fn error(&self) -> Color {
        self.var(|v| v.status_error)
    }

    /// Style for the input cursor cell (inverse video block).
    pub fn cursor_style(&self) -> CellStyle {
        CellStyle {
            fg: Color::Reset,
            bg: Color::Reset,
            underline: Color::Reset,
            modifier: Modifier::INVERSE,
        }
    }
}
