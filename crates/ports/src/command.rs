//! Command port (docs/config.md): runs one shell script — a space's
//! `setup`, `run`, `check` or `archive` command — and streams its output.
//!
//! ```text
//! spawn `sh -c <script>` (cwd, env) ─▶ Line… ─▶ Exit
//!    │                                       ▲
//!    ├─ cancel  ─▶ SIGTERM ─▶ grace ─▶ SIGKILL┤ (the whole process group)
//!    └─ timeout ─▶ same, `timed_out` ─────────┘
//! ```

use std::path::PathBuf;
use std::time::Duration;

use async_trait::async_trait;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    /// Shell text, run as `sh -c <script>`.
    pub script: String,
    pub cwd: PathBuf,
    /// Added on top of the inherited environment (Theodore's own secrets
    /// are never inherited).
    pub env: Vec<(String, String)>,
    /// `None`: runs until it exits or is cancelled (a space's `run`).
    pub timeout: Option<Duration>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandEvent {
    /// One line of output, without its newline; capped in length.
    Line { stderr: bool, text: String },
    /// Always the last event, exactly once.
    Exit(CommandExit),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommandExit {
    /// The exit code; `None` when killed by a signal or never started.
    pub code: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
    /// Set when the command could not be started at all.
    pub error: Option<String>,
}

impl CommandExit {
    pub fn success(&self) -> bool {
        self.code == Some(0) && !self.timed_out && !self.cancelled && self.error.is_none()
    }
}

/// A started command. Dropping it does not stop it; cancel does.
pub struct CommandRun {
    pub events: mpsc::Receiver<CommandEvent>,
    pub cancel: CancellationToken,
}

#[async_trait]
pub trait CommandPort: Send + Sync {
    /// Starts `spec`. A command that can't be spawned still yields a run
    /// whose only event is an `Exit` with `error` set.
    async fn spawn(&self, spec: CommandSpec) -> CommandRun;
}
