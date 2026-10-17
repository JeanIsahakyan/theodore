//! The `review-tools` backend: what the MCP server calls into, implemented
//! by `app` (plan §8.3). Everything here is scoped by a run context.

use async_trait::async_trait;
use theodore_domain::{AgentId, Commit, FileStatus, FindingId, Group, Hunk, PrId, RunId, Severity};

/// Identifies the agent run calling the MCP server: which PR, which agent, which
/// invocation. One token maps to exactly one `RunContext` (see [`crate::McpHandle::register_run`]).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RunContext {
    pub run_id: RunId,
    pub pr: PrId,
    pub agent: AgentId,
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
