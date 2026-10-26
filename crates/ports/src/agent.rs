//! Agent port (plan §8): runs a local agent CLI and streams normalized events.

use std::path::PathBuf;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use theodore_domain::{AgentId, Usage};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: AgentId,
    pub path: Option<PathBuf>,
    pub version: Option<String>,
    pub installed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentMode {
    /// read / grep / MCP only
    ReadOnly,
    /// may edit files inside `cwd`
    Edit,
    /// may edit files and run any shell command without asking (a space's
    /// Run mode, docs/spaces.md §5). Theodore adds no sandbox of its own:
    /// the CLI's own configuration is what limits it.
    Run,
}

/// The MCP server name a PR run's tools go under (`mcp__review-tools__*`).
pub const REVIEW_TOOLS: &str = "review-tools";
/// The MCP server name a space turn's tools go under (`mcp__space-tools__*`).
pub const SPACE_TOOLS: &str = "space-tools";

fn review_tools() -> String {
    REVIEW_TOOLS.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpEndpoint {
    pub url: String,
    pub token: String,
    /// The server name the agent CLI registers it under: [`REVIEW_TOOLS`]
    /// or [`SPACE_TOOLS`]. Decides the tool names the agent sees.
    #[serde(default = "review_tools")]
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRequest {
    pub agent: AgentId,
    pub prompt: String,
    pub system: Option<String>,
    pub cwd: PathBuf,
    pub mode: AgentMode,
    pub mcp: Option<McpEndpoint>,
    pub model: Option<String>,
    /// How hard the agent thinks (`low` … `max`). Claude Code takes it as
    /// `--effort`, Codex as `-c model_reasoning_effort=…`; Gemini ignores it.
    #[serde(default)]
    pub effort: Option<String>,
    /// No output for this long → `AgentEvent::Stalled`.
    pub stall_after_ms: u64,
    /// Added to the child's environment after Theodore's own `THEODORE_*`
    /// secrets are stripped from the inherited one: a space's `env` and
    /// variables (docs/config.md).
    #[serde(default)]
    pub env: Vec<(String, String)>,
    /// The CLI may also load the user's own MCP servers (Claude Code's
    /// `~/.claude.json`, the repo's `.mcp.json`, claude.ai connectors) next
    /// to `mcp`: the `agents.user_mcp` setting. `false` = only `mcp`.
    #[serde(default)]
    pub user_mcp: bool,
    /// Files sent with this turn (chat attachments). The prompt already
    /// lists their paths; each runner adds what its CLI needs to open them
    /// (Claude Code: `--add-dir`, Codex: `-i` for images).
    #[serde(default)]
    pub attachments: Vec<AgentAttachment>,
}

/// One file the agent should read, outside `cwd`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentAttachment {
    pub path: PathBuf,
    pub mime: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    ToolResult {
        id: String,
        ok: bool,
        output: String,
    },
    Usage {
        usage: Usage,
    },
    Stalled,
    Done {
        final_text: String,
        usage: Usage,
    },
    Error {
        message: String,
        stderr_tail: String,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("{0:?} CLI not installed")]
    NotInstalled(AgentId),
    #[error("spawn failed: {0}")]
    Spawn(String),
}

impl AgentError {
    /// The stable error code logged as `error.code` (docs/telemetry.md).
    pub fn code(&self) -> &'static str {
        match self {
            AgentError::NotInstalled(_) => "agent.not_installed",
            AgentError::Spawn(_) => "agent.spawn_failed",
        }
    }
}

/// A running agent. Events end with exactly one `Done` or `Error`.
pub struct AgentRun {
    pub events: mpsc::Receiver<AgentEvent>,
    pub cancel: CancellationToken,
}

/// One model an agent CLI can run, and the effort levels it takes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelInfo {
    /// What the CLI's model flag takes (`opus`, `gpt-5.5`).
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    /// Effort levels the model takes, in the CLI's order; empty = none.
    pub efforts: Vec<String>,
    /// The effort the CLI uses when none is passed, when it says.
    pub default_effort: Option<String>,
    /// An earlier version the CLI still runs: listed under "More models".
    #[serde(default)]
    pub older: bool,
}

#[async_trait]
pub trait AgentPort: Send + Sync {
    async fn detect(&self) -> Vec<AgentInfo>;
    async fn run(&self, req: AgentRequest) -> Result<AgentRun, AgentError>;
    /// The models `agent` can run, for the model picker. Never fails: an
    /// agent that can't list them (not installed, no listing) gives `[]`.
    async fn models(&self, _agent: AgentId) -> Vec<ModelInfo> {
        Vec::new()
    }
}
