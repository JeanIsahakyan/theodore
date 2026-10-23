//! The backends the MCP server calls into, implemented by `app` (plan
//! §8.3): `review-tools` over a PR, `space-tools` over a space. Everything
//! here is scoped by a run context.

use async_trait::async_trait;
use theodore_domain::{AgentId, Commit, FileStatus, FindingId, Group, Hunk, PrId, RunId, Severity};
pub use theodore_ports::{
    AppStatus, CheckOutcome, LogTail, SpaceCommandName, SpaceInfo, SpaceToolError,
};

/// Which server a run talks to, and so which tools it sees.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ToolSet {
    /// `review-tools`: a PR run (skill, chat, fix). On a space's PR
    /// ([`RunContext::space`] set) also the read-only `read_logs` and
    /// `app_status`.
    Review,
    /// `space-tools`: a space's agent turn.
    Space,
}

/// The `review-tools` tools.
pub const REVIEW_TOOL_NAMES: &[&str] = &[
    "get_pr_context",
    "get_group",
    "get_base_file",
    "add_finding",
    "propose_patch",
];
/// Added to `review-tools` on a space's PR: nothing that runs anything.
pub const REVIEW_SPACE_TOOL_NAMES: &[&str] = &["read_logs", "app_status"];
/// The `space-tools` tools.
pub const SPACE_TOOL_NAMES: &[&str] = &[
    "run_check",
    "start_app",
    "stop_app",
    "app_status",
    "read_logs",
    "space_info",
];

/// Identifies the agent run calling the MCP server: which PR, which agent, which
/// invocation. One token maps to exactly one `RunContext` (see [`crate::McpHandle::register_run`]).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RunContext {
    pub run_id: RunId,
    /// A space turn's is the space's chat key (`space:<id>`).
    pub pr: PrId,
    pub agent: AgentId,
    /// The space this run belongs to: the space of a space turn, or the
    /// space whose PR a review run is on.
    pub space: Option<String>,
    pub tools: ToolSet,
}

impl RunContext {
    /// A PR run outside any space.
    pub fn review(run_id: RunId, pr: PrId, agent: AgentId) -> Self {
        Self {
            run_id,
            pr,
            agent,
            space: None,
            tools: ToolSet::Review,
        }
    }

    /// The MCP server name the agent CLI registers this run's endpoint under.
    pub fn server_name(&self) -> &'static str {
        match self.tools {
            ToolSet::Review => theodore_ports::REVIEW_TOOLS,
            ToolSet::Space => theodore_ports::SPACE_TOOLS,
        }
    }

    /// Whether this run may list and call `tool`.
    pub fn allows(&self, tool: &str) -> bool {
        match self.tools {
            ToolSet::Review => {
                REVIEW_TOOL_NAMES.contains(&tool)
                    || (self.space.is_some() && REVIEW_SPACE_TOOL_NAMES.contains(&tool))
            }
            ToolSet::Space => self.space.is_some() && SPACE_TOOL_NAMES.contains(&tool),
        }
    }
}

/// One file in the PR, as listed by `get_pr_context`.
#[derive(Debug, Clone)]
pub struct FileSummary {
    pub path: String,
    pub status: FileStatus,
    pub additions: u32,
    pub deletions: u32,
}

/// One group in the PR's current grouping, as listed by `get_pr_context`.
#[derive(Debug, Clone)]
pub struct GroupSummary {
    pub id: String,
    pub title: String,
    pub why: String,
    pub hunk_count: usize,
}

/// Everything `get_pr_context` returns.
#[derive(Debug, Clone)]
pub struct PrContext {
    pub title: String,
    pub body: String,
    pub commits: Vec<Commit>,
    pub files: Vec<FileSummary>,
    pub groups: Vec<GroupSummary>,
}

/// A group together with the hunks it contains, in reading order. The MCP
/// server renders these as unified diff text for `get_group`.
#[derive(Debug, Clone)]
pub struct GroupWithHunks {
    pub group: Group,
    pub hunks: Vec<Hunk>,
}

/// A new finding reported by an agent (`add_finding`).
#[derive(Debug, Clone)]
pub struct NewFinding {
    pub file: String,
    pub line: u32,
    pub severity: Severity,
    pub title: String,
    pub body: String,
}

/// A proposed fix attached to an existing finding (`propose_patch`).
#[derive(Debug, Clone)]
pub struct NewPatch {
    pub finding_id: FindingId,
    pub file: String,
    pub before: Vec<String>,
    pub after: Vec<String>,
    pub note: String,
}

#[derive(Debug, thiserror::Error)]
pub enum BackendError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid request: {0}")]
    Invalid(String),
    #[error("internal: {0}")]
    Internal(String),
}

/// What the `review-tools` MCP server calls into. Implemented by `app` over
/// the real PR state; tests use an in-memory fake (see `tests/`).
#[async_trait]
pub trait ReviewToolsBackend: Send + Sync {
    async fn get_pr_context(&self, run: &RunContext) -> Result<PrContext, BackendError>;
    async fn get_group(
        &self,
        run: &RunContext,
        group_id: &str,
    ) -> Result<GroupWithHunks, BackendError>;
    /// File contents at the base revision, `None` if the file does not exist there
    /// (e.g. it was added in this PR).
    async fn get_base_file(
        &self,
        run: &RunContext,
        path: &str,
    ) -> Result<Option<String>, BackendError>;
    async fn add_finding(
        &self,
        run: &RunContext,
        finding: NewFinding,
    ) -> Result<FindingId, BackendError>;
    async fn propose_patch(&self, run: &RunContext, patch: NewPatch) -> Result<(), BackendError>;
}

/// What the `space-tools` server (and the read-only part of
/// `review-tools` on a space's PR) calls into: the space's configured
/// commands, never an arbitrary shell. Every call names the space the run
/// was registered for; the server never takes one from the agent.
#[async_trait]
pub trait SpaceToolsBackend: Send + Sync {
    /// Runs the space's `check` now. `run_id` is the turn, whose Stop
    /// stops the check too.
    async fn run_check(&self, space: &str, run_id: &RunId) -> Result<CheckOutcome, SpaceToolError>;
    /// Starts `run` unless it is running already.
    async fn start_app(&self, space: &str) -> Result<AppStatus, SpaceToolError>;
    /// Stops `run` and waits (a while) for it to exit.
    async fn stop_app(&self, space: &str) -> Result<AppStatus, SpaceToolError>;
    async fn app_status(&self, space: &str) -> Result<AppStatus, SpaceToolError>;
    /// The last `tail` lines of `kind`; the backend bounds `tail`.
    async fn read_logs(
        &self,
        space: &str,
        kind: SpaceCommandName,
        tail: usize,
    ) -> Result<LogTail, SpaceToolError>;
    async fn space_info(&self, space: &str) -> Result<SpaceInfo, SpaceToolError>;
}

/// For servers started without spaces (tests, the CLI): every call fails.
pub struct NoSpaceTools;

#[async_trait]
impl SpaceToolsBackend for NoSpaceTools {
    async fn run_check(&self, _: &str, _: &RunId) -> Result<CheckOutcome, SpaceToolError> {
        Err(unavailable())
    }
    async fn start_app(&self, _: &str) -> Result<AppStatus, SpaceToolError> {
        Err(unavailable())
    }
    async fn stop_app(&self, _: &str) -> Result<AppStatus, SpaceToolError> {
        Err(unavailable())
    }
    async fn app_status(&self, _: &str) -> Result<AppStatus, SpaceToolError> {
        Err(unavailable())
    }
    async fn read_logs(
        &self,
        _: &str,
        _: SpaceCommandName,
        _: usize,
    ) -> Result<LogTail, SpaceToolError> {
        Err(unavailable())
    }
    async fn space_info(&self, _: &str) -> Result<SpaceInfo, SpaceToolError> {
        Err(unavailable())
    }
}

fn unavailable() -> SpaceToolError {
    SpaceToolError::Unavailable("spaces are not available here".into())
}
