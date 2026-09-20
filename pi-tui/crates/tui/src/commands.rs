//! Slash-command parsing.
//!
//! In RPC mode pi's built-in slash commands are the client's job: pi only
//! exposes primitives (`set_model`, `compact`, `new_session`, …). Commands
//! we don't own are forwarded verbatim as a `prompt` — pi resolves
//! extension/prompt/skill commands server-side (`get_commands`).

/// What a submitted input line resolves to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// Send to pi as a `prompt` (plain text or an unknown `/x`).
    Prompt(String),
    /// Handled locally (maps to an RPC primitive or pure UI action).
    Local(LocalCmd),
}

/// Locally-handled slash commands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalCmd {
    /// `/model` → picker; `/model provider/id` → direct set.
    Model(Option<String>),
    /// `/thinking` → picker; `/thinking <level>` → direct set.
    Thinking(Option<String>),
    /// `/new` — start a fresh session.
    NewSession,
    /// `/compact [instructions]`.
    Compact(Option<String>),
    /// `/session` — stats as a system line.
    Session,
    /// `/export [path]` — HTML export.
    Export(Option<String>),
    /// `/name <name>` — session display name.
    Name(String),
    /// `/copy` — last assistant text to clipboard.
    Copy,
    /// `/clear` — clear the message list (same as Ctrl+L).
    Clear,
    /// `/settings` — local boolean toggles picker.
    Settings,
    /// `/unqueue` — recall the last queued (follow-up) message.
    Unqueue,
    /// `/help` — list built-in + pi-reported commands.
    Help,
    /// `/quit` / `/exit`.
    Quit,
}

/// Parse a submitted input line. `input` is the raw text (no leading
/// whitespace trimmed by the caller).
pub fn parse(input: &str) -> Command {
    let text = input.trim();
    if !text.starts_with('/') || text == "/" {
        return Command::Prompt(input.to_string());
    }
    // Split "/name args…" at the first whitespace.
    let body = &text[1..];
    let (name, args) = match body.find(char::is_whitespace) {
        Some(i) => (&body[..i], body[i..].trim()),
        None => (body, ""),
    };
    let args = if args.is_empty() {
        None
    } else {
        Some(args.to_string())
    };
    let local = match name {
        "model" | "m" => LocalCmd::Model(args),
        "thinking" | "think" | "t" => LocalCmd::Thinking(args),
        "new" => LocalCmd::NewSession,
        "compact" => LocalCmd::Compact(args),
        "session" | "stats" => LocalCmd::Session,
        "export" => LocalCmd::Export(args),
        "name" => match args {
            Some(n) => LocalCmd::Name(n),
            None => return Command::Prompt(input.to_string()),
        },
        "copy" => LocalCmd::Copy,
        "clear" | "cls" => LocalCmd::Clear,
        "settings" | "setting" => LocalCmd::Settings,
        "unqueue" => LocalCmd::Unqueue,
        "help" | "h" | "?" => LocalCmd::Help,
        "quit" | "exit" | "q" => LocalCmd::Quit,
        _ => return Command::Prompt(input.to_string()),
    };
    Command::Local(local)
}

/// Built-in command list for `/help` output.
pub const BUILTIN_HELP: &[(&str, &str)] = &[
    ("/model [provider/id]", "select or switch model"),
    ("/thinking [level]", "select or set thinking level"),
    ("/new", "start a new session"),
    ("/compact [instructions]", "compact session context"),
    ("/session", "session stats"),
    ("/export [path]", "export session as HTML"),
    ("/name <name>", "set session display name"),
    ("/copy", "copy last assistant message"),
    ("/clear", "clear the message list"),
    ("/settings", "toggle local settings"),
    ("/unqueue", "recall last queued message"),
    ("/help", "this list"),
    ("/quit", "exit"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_is_prompt() {
        assert_eq!(parse("hello"), Command::Prompt("hello".into()));
        assert_eq!(parse("  spaced  "), Command::Prompt("  spaced  ".into()));
        assert_eq!(parse("/"), Command::Prompt("/".into()));
    }

    #[test]
    fn known_commands() {
        assert_eq!(parse("/model"), Command::Local(LocalCmd::Model(None)));
        assert_eq!(
            parse("/model kimi/k3"),
            Command::Local(LocalCmd::Model(Some("kimi/k3".into())))
        );
        assert_eq!(
            parse("/thinking high"),
            Command::Local(LocalCmd::Thinking(Some("high".into())))
        );
        assert_eq!(parse("/new"), Command::Local(LocalCmd::NewSession));
        assert_eq!(
            parse("/compact keep the diff"),
            Command::Local(LocalCmd::Compact(Some("keep the diff".into())))
        );
        assert_eq!(parse("/session"), Command::Local(LocalCmd::Session));
        assert_eq!(
            parse("/export out.html"),
            Command::Local(LocalCmd::Export(Some("out.html".into())))
        );
        assert_eq!(
            parse("/name my session"),
            Command::Local(LocalCmd::Name("my session".into()))
        );
        assert_eq!(parse("/copy"), Command::Local(LocalCmd::Copy));
        assert_eq!(parse("/clear"), Command::Local(LocalCmd::Clear));
        assert_eq!(parse("/settings"), Command::Local(LocalCmd::Settings));
        assert_eq!(parse("/unqueue"), Command::Local(LocalCmd::Unqueue));
        assert_eq!(parse("/help"), Command::Local(LocalCmd::Help));
        assert_eq!(parse("/quit"), Command::Local(LocalCmd::Quit));
        assert_eq!(parse("/exit"), Command::Local(LocalCmd::Quit));
    }

    #[test]
    fn unknown_and_bare_args_forward() {
        // Unknown slash commands go to pi verbatim (skill/extension cmds).
        assert_eq!(parse("/review src"), Command::Prompt("/review src".into()));
        assert_eq!(parse("/foo"), Command::Prompt("/foo".into()));
        // /name without an argument is meaningless → forward.
        assert_eq!(parse("/name"), Command::Prompt("/name".into()));
    }
}
