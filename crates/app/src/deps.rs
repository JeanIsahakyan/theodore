//! Injected dependencies (plan §2.1): `app` depends only on `domain` and
//! `ports`, adapters are wired in by whoever constructs `Deps` (the desktop
//! shell, the CLI, or a test's `testkit` fakes).

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use theodore_contract::TokenSource;
use theodore_domain::{AgentId, Grouping, PrDetail, PrId, Revision};
use theodore_ports::{
    AgentPort, Clock, GitPort, HostAdapter, McpEndpoint, Secrets, Store, WorktreeLease,
};

use crate::error::GrouperError;

/// Groups a revision by meaning (plan §5). Implemented by the `grouping`
/// crate at integration time; `app` only needs the trait. `agent` is the
/// `agents.grouping` setting, read by the caller and passed in here so the
/// grouper never has to know about settings (plan §8.5).
#[async_trait]
pub trait Grouper: Send + Sync {
    async fn group(
        &self,
        rev: &Revision,
        pr: &PrDetail,
        worktree: &Path,
        agent: AgentId,
    ) -> Result<Grouping, GrouperError>;

    /// Re-group after a push: unchanged hunks keep their group (plan §5.3).
    async fn regroup(
        &self,
        prev: &Grouping,
        rev: &Revision,
        pr: &PrDetail,
        worktree: &Path,
        agent: AgentId,
    ) -> Result<Grouping, GrouperError>;
}

/// Per-run MCP `review-tools` access for agents (plan §8.3). Implemented
/// over the MCP server by whoever wires `Deps`.
pub trait RunTools: Send + Sync {
    fn register(&self, run_id: &str, pr: &PrId, agent: AgentId) -> McpEndpoint;
    fn unregister(&self, endpoint: &McpEndpoint);
}

/// Where the active host token came from (plan §6.8), and the ability to
/// drop a cached fallback (`gh`/env) lookup once the keychain token
/// changes. Implemented over `runtime::HostToken`; `app` stays ignorant of
/// keychains and the `gh` CLI.
pub trait TokenStatus: Send + Sync {
    fn source(&self) -> TokenSource;
    fn invalidate(&self);
}

#[derive(Clone)]
pub struct Deps {
    pub host: Arc<dyn HostAdapter>,
    pub git: Arc<dyn GitPort>,
    pub agents: Arc<dyn AgentPort>,
    pub store: Arc<dyn Store>,
    pub secrets: Arc<dyn Secrets>,
    pub clock: Arc<dyn Clock>,
    pub grouper: Arc<dyn Grouper>,
    /// `None` runs agents without MCP (tests, CLI).
    pub tools: Option<Arc<dyn RunTools>>,
    /// `None` when the shell doesn't wire one in (tests, the CLI): `viewer`
    /// and friends still work, `host_status` just reports `TokenSource::None`.
    pub token_status: Option<Arc<dyn TokenStatus>>,
    /// `~/.claude/skills` in production; whoever builds `Deps` resolves it
    /// (plan §8.4) — kept out of `app` itself so tests can point it at a
    /// throwaway directory instead of the real home directory.
    pub claude_home: std::path::PathBuf,
    /// Holds a PR's worktree open against the periodic GC sweep for the
    /// duration of an agent run (plan "worktree locks"). A no-op in tests
    /// and the CLI, where nothing sweeps worktrees.
    pub worktree_lease: Arc<dyn WorktreeLease>,
}
