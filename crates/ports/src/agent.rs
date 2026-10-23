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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpEndpoint {
    pub url: String,
    pub token: String,
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
    /// No output for this long → `AgentEvent::Stalled`.
    pub stall_after_ms: u64,
    /// Added to the child's environment after Theodore's own `THEODORE_*`
    /// secrets are stripped from the inherited one: a space's `env` and
    /// variables (docs/config.md).
    #[serde(default)]
    pub env: Vec<(String, String)>,
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

/// A running agent. Events end with exactly one `Done` or `Error`.
pub struct AgentRun {
    pub events: mpsc::Receiver<AgentEvent>,
    pub cancel: CancellationToken,
}

#[async_trait]
pub trait AgentPort: Send + Sync {
    async fn detect(&self) -> Vec<AgentInfo>;
    async fn run(&self, req: AgentRequest) -> Result<AgentRun, AgentError>;
}
