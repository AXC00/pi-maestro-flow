//! `PiRpc` — spawns `pi --mode rpc` and exposes the JSONL protocol.
//!
//! - `send(cmd)` writes a command with a generated `id` and resolves with the
//!   matching `RpcResponse` (correlated via a pending-oneshot map).
//! - stdout lines are demuxed: `response` → pending map, agent/session events
//!   → broadcast stream, `extension_ui_request` → UI channel (and mirrored
//!   into the event stream for observers).
//! - `respond_ui(id, resp)` answers interactive UI requests on stdin.
//! - On child exit, every pending command resolves with a synthetic failure
//!   response so callers never hang.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};

use crate::events::RpcEvent;
use crate::types::{
    classify_line, RpcCommand, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcLine,
    RpcResponse,
};

/// Default CLI arguments for a clean, deterministic RPC session.
pub const DEFAULT_ARGS: &[&str] = &[
    "--mode",
    "rpc",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-session",
];

/// Broadcast channel capacity for the event stream.
const EVENT_CAPACITY: usize = 512;
/// UI request channel capacity.
const UI_CAPACITY: usize = 64;

type PendingMap = Arc<Mutex<HashMap<String, oneshot::Sender<RpcResponse>>>>;

/// A live `pi --mode rpc` child process.
pub struct PiRpc {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: PendingMap,
    events_tx: broadcast::Sender<RpcEvent>,
    ui_rx: Mutex<mpsc::Receiver<RpcExtensionUIRequest>>,
    stderr_rx: Mutex<mpsc::Receiver<String>>,
    counter: AtomicU64,
}

impl PiRpc {
    /// Spawn `pi --mode rpc` with the default deterministic args
    /// (`DEFAULT_ARGS`). Resolves the binary from `PI_BIN`, then `pi` on PATH.
    pub async fn spawn_default() -> io::Result<Self> {
        Self::spawn(None, DEFAULT_ARGS).await
    }

    /// Spawn `pi --mode rpc`.
    ///
    /// - `pi_path`: explicit binary path; `None` → `PI_BIN` env, then `pi` on PATH.
    /// - `args`: full CLI args; pass `DEFAULT_ARGS` or your own (must include
    ///   `--mode rpc` for the protocol to work).
    ///
    /// On Windows, `.cmd`/`.bat` shims (the normal npm install of `pi`) are
    /// wrapped in `cmd /c` automatically.
    pub async fn spawn(pi_path: Option<&Path>, args: &[&str]) -> io::Result<Self> {
        let bin = resolve_pi_binary(pi_path)?;
        let mut command = build_command(&bin, args);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // pi writes session files under the cwd; callers should set a
            // sensible working dir via Command options if needed.
            .kill_on_drop(true);

        let mut child = command.spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "pi stdin not piped"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "pi stdout not piped"))?;
        let stderr = child.stderr.take();

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        let (events_tx, _) = broadcast::channel(EVENT_CAPACITY);
        let (ui_tx, ui_rx) = mpsc::channel(UI_CAPACITY);
        let (stderr_tx, stderr_rx) = mpsc::channel(64);

        // stdout demux task
        {
            let pending = Arc::clone(&pending);
            let events_tx = events_tx.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    match classify_line(&line) {
                        RpcLine::Response(resp) => {
                            // Route to the pending oneshot when the id matches;
                            // a failed send hands the response back so it can
                            // still be observed on the event stream.
                            let mut leftover = Some(resp);
                            if let Some(id) = leftover.as_ref().and_then(|r| r.id.clone()) {
                                let tx = pending.lock().await.remove(&id);
                                if let Some(tx) = tx {
                                    let resp = leftover.take().unwrap();
                                    if let Err(returned) = tx.send(resp) {
                                        leftover = Some(returned);
                                    }
                                }
                            }
                            if let Some(resp) = leftover {
                                let _ = events_tx.send(RpcEvent::Response(resp));
                            }
                        }
                        RpcLine::Event(event) => {
                            let _ = events_tx.send(RpcEvent::Agent(event));
                        }
                        RpcLine::ExtensionUIRequest(req) => {
                            // Mirror into the event stream AND the dedicated UI channel.
                            let _ = events_tx.send(RpcEvent::ExtensionUiRequest(req.clone()));
                            let _ = ui_tx.send(req).await;
                        }
                        RpcLine::Other(value) => {
                            let _ = events_tx.send(RpcEvent::Other(value));
                        }
                        RpcLine::Unparseable(raw) => {
                            let _ = events_tx.send(RpcEvent::StderrLine(format!(
                                "unparseable stdout: {raw}"
                            )));
                        }
                    }
                }
                // EOF — fail every pending command so callers never hang.
                let mut map = pending.lock().await;
                for (id, tx) in map.drain() {
                    let _ = tx.send(RpcResponse::failure(
                        Some(id),
                        "process",
                        "pi process exited before responding",
                    ));
                }
            });
        }

        // stderr capture task (pi logs/errors — useful for diagnostics)
        if let Some(stderr) = stderr {
            let events_tx = events_tx.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let _ = events_tx.send(RpcEvent::StderrLine(line.clone()));
                    let _ = stderr_tx.send(line).await;
                }
            });
        }

        Ok(Self {
            child,
            stdin: Arc::new(Mutex::new(stdin)),
            pending,
            events_tx,
            ui_rx: Mutex::new(ui_rx),
            stderr_rx: Mutex::new(stderr_rx),
            counter: AtomicU64::new(1),
        })
    }

    /// Send a command and await its correlated `RpcResponse`.
    ///
    /// A `cmd-N` id is generated, registered in the pending map, then the
    /// command is written as one JSONL line. The returned response is the raw
    /// `RpcResponse` — check `success`/`error` yourself.
    pub async fn send(&self, command: &RpcCommand) -> io::Result<RpcResponse> {
        let id = format!("cmd-{}", self.counter.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);

        // Serialize the command and inject the id.
        let mut value = serde_json::to_value(command)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
        if let Value::Object(ref mut map) = value {
            map.insert("id".to_string(), Value::String(id.clone()));
        }
        let mut line = serde_json::to_string(&value)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
        line.push('\n');

        {
            let mut stdin = self.stdin.lock().await;
            if let Err(e) = stdin.write_all(line.as_bytes()).await {
                self.pending.lock().await.remove(&id);
                return Err(e);
            }
            if let Err(e) = stdin.flush().await {
                self.pending.lock().await.remove(&id);
                return Err(e);
            }
        }

        rx.await.map_err(|_| {
            io::Error::new(
                io::ErrorKind::BrokenPipe,
                "response channel closed before reply",
            )
        })
    }

    /// Answer an `extension_ui_request`. `id` must be the request's id.
    pub async fn respond_ui(&self, response: &RpcExtensionUIResponse) -> io::Result<()> {
        let mut line = serde_json::to_string(&response.to_wire_value())
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await
    }

    /// Subscribe to the event stream (agent events, unmatched responses,
    /// UI request mirrors, stderr lines, unrecognized lines).
    pub fn events(&self) -> crate::events::EventStream {
        crate::events::EventStream::new(self.events_tx.subscribe())
    }

    /// Receive the next extension UI request awaiting a response.
    /// Interactive methods (`select`/`confirm`/`input`/`editor`) block pi
    /// until you call `respond_ui`; the rest are fire-and-forget.
    pub async fn next_ui_request(&self) -> Option<RpcExtensionUIRequest> {
        self.ui_rx.lock().await.recv().await
    }

    /// Drain buffered stderr lines (non-blocking).
    pub async fn next_stderr_line(&self) -> Option<String> {
        self.stderr_rx.lock().await.recv().await
    }

    /// Send a raw JSONL command string (escape hatch for unmodeled commands).
    pub async fn send_raw(&self, json_line: &str) -> io::Result<()> {
        let mut line = json_line.trim_end().to_string();
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await?;
        stdin.flush().await
    }

    /// Terminate the child process.
    pub async fn kill(&mut self) -> io::Result<()> {
        self.child.kill().await
    }

    /// Wait for the child to exit, returning its status.
    pub async fn wait(&mut self) -> io::Result<std::process::ExitStatus> {
        self.child.wait().await
    }
}

/// Resolve the pi binary: explicit path → `PI_BIN` env → `pi` on PATH.
fn resolve_pi_binary(explicit: Option<&Path>) -> io::Result<PathBuf> {
    if let Some(p) = explicit {
        return Ok(p.to_path_buf());
    }
    if let Ok(env) = std::env::var("PI_BIN") {
        if !env.trim().is_empty() {
            return Ok(PathBuf::from(env));
        }
    }
    find_on_path("pi").ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "pi binary not found on PATH (set PI_BIN to override)",
        )
    })
}

/// Locate an executable on PATH, honoring Windows PATHEXT.
fn find_on_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&path_var) {
        if cfg!(windows) {
            // On Windows prefer PATHEXT-suffixed matches (pi.exe/pi.cmd) over a
            // bare extensionless `pi` shell script, which CreateProcess cannot
            // execute directly.
            for ext in &exts {
                for cand in [
                    dir.join(format!("{name}{ext}")),
                    dir.join(format!("{name}{}", ext.to_lowercase())),
                ] {
                    if cand.is_file() {
                        return Some(cand);
                    }
                }
            }
        }
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        if !cfg!(windows) {
            continue;
        }
    }
    None
}

/// Build the spawn command, wrapping `.cmd`/`.bat` in `cmd /c` on Windows.
fn build_command(bin: &Path, args: &[&str]) -> Command {
    let ext = bin
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if cfg!(windows) && (ext == "cmd" || ext == "bat") {
        let mut c = Command::new("cmd");
        c.arg("/c").arg(bin);
        for a in args {
            c.arg(a);
        }
        c
    } else {
        let mut c = Command::new(bin);
        for a in args {
            c.arg(a);
        }
        c
    }
}
