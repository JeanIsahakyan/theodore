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
    /// The child's own pid, known as soon as it's spawned; `None` if it
    /// never started. A space's `run` command is its own process group
    /// leader (`process_group(0)`), so this doubles as its pgid.
    pub pid: Option<u32>,
}

#[async_trait]
pub trait CommandPort: Send + Sync {
    /// Starts `spec`. A command that can't be spawned still yields a run
    /// whose only event is an `Exit` with `error` set.
    async fn spawn(&self, spec: CommandSpec) -> CommandRun;

    /// Whether process group `pgid` (a `run` command's own pid, recorded by
    /// a previous Theodore process) is still alive and its leader's command
    /// line still contains `script` — the guard against a pid that's since
    /// been reused by an unrelated process. `false` on anything that isn't
    /// a confident match, including the group no longer existing.
    async fn group_matches(&self, pgid: u32, script: &str) -> bool;

    /// SIGTERM the group, `grace` to exit, then SIGKILL — the same
    /// discipline a command gets on cancel/timeout (`ShellRunner`), applied
    /// here to a group this process didn't itself spawn: one left running
    /// by a previous Theodore process that didn't exit cleanly. Only ever
    /// called after `group_matches` confirms it's ours.
    async fn reap_group(&self, pgid: u32, grace: Duration);
}
