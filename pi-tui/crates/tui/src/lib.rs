//! tui — pi-tui application crate.
//!
//! P3: the Devin-style TUI — `pi-rpc` (agent kernel) + `blitz-dom`
//! (DOM/layout) + `scrollback` (cell renderer), driven by a tokio event
//! loop. The headless layout spike lives in `src/bin/spike.rs`; the
//! binary entry point is `src/main.rs`.

pub mod app;
pub mod commands;
pub mod components;
pub mod state;
pub mod theme;
