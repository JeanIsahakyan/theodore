//! What a space's agent gets from the `space-tools` MCP server
//! (docs/spaces.md "Tools the agent gets"): the space's configured
//! commands, never an arbitrary shell. `app` produces these, the MCP
//! server sends them back as JSON.
//!
//! ```text
//! agent ─▶ run_check ─────────────▶ check, now ─▶ exit code + output tail
//!       ─▶ start_app / stop_app ──▶ `run`      ─▶ running?, ports, URLs
//!       ─▶ app_status · read_logs · space_info   (read only)
//! a repo command not allowed yet ─▶ NotAllowed, nothing runs
//! ```

use serde::{Deserialize, Serialize};

/// One of a space's commands (docs/config.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpaceCommandName {
    Setup,
    Run,
    Check,
    Archive,
}

impl SpaceCommandName {
    pub const ALL: [SpaceCommandName; 4] = [Self::Setup, Self::Run, Self::Check, Self::Archive];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Setup => "setup",
            Self::Run => "run",
            Self::Check => "check",
            Self::Archive => "archive",
        }
    }
}

/// `run_check`: how the check ended and its last lines.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CheckOutcome {
    pub passed: bool,
    /// `None` when killed, timed out or never started.
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    /// One line: "check finished", "check exited with 1", …
    pub summary: String,
    /// The last lines of output, oldest first (bounded).
    pub output: Vec<String>,
}

/// `app_status` (and what `start_app` / `stop_app` return): the space's
/// `run` command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppStatus {
    /// A `spaces.run` command is set.
    pub configured: bool,
    /// …and may run (not a repo command the user hasn't allowed yet).
    pub allowed: bool,
    pub running: bool,
    /// The space's reserved ports (`$THEODORE_PORT`, `_1`, …).
    pub ports: Vec<u16>,
    /// `http://localhost:<port>` for each port.
    pub urls: Vec<String>,
    /// How the last run ended, when it has: "exited", "stopped", "failed".
    pub last_status: Option<String>,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
}

/// `read_logs`: the last lines of one command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LogTail {
    pub kind: SpaceCommandName,
    /// Oldest first; stderr lines start with `! `.
    pub lines: Vec<String>,
    /// Lines of this command Theodore still holds (`lines` is the tail).
    pub available: usize,
}

/// One command in `space_info`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommandInfo {
    pub kind: SpaceCommandName,
    pub configured: bool,
    pub allowed: bool,
}

/// `space_info`. Environment variable names only, never their values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SpaceInfo {
    pub name: String,
    pub branch: String,
    pub base: String,
    pub worktree: String,
    pub ports: Vec<u16>,
    pub urls: Vec<String>,
    pub env: Vec<String>,
    pub commands: Vec<CommandInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SpaceToolError {
    /// The trust gate: a repo command the user hasn't allowed (or said
    /// "Not now" to). Nothing ran.
    #[error("not allowed by the user yet: {0}")]
    NotAllowed(String),
    /// Not configured, archived, unknown space…
    #[error("{0}")]
    Unavailable(String),
}

/// `http://localhost:<port>` for each port.
pub fn local_urls(ports: &[u16]) -> Vec<String> {
    ports
        .iter()
        .map(|p| format!("http://localhost:{p}"))
        .collect()
}
