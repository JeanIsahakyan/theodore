//! Injected dependencies (plan §2.1): `app` depends only on `domain` and
//! `ports`, adapters are wired in by whoever constructs `Deps` (the desktop
//! shell, the CLI, or a test's `testkit` fakes).

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use theodore_domain::{Grouping, PrDetail, Revision};
use theodore_ports::{AgentPort, Clock, GitPort, HostAdapter, Secrets, Store};

use crate::error::GrouperError;

/// Groups a revision by meaning (plan §5). Implemented by the `grouping`
/// crate at integration time; `app` only needs the trait.
#[async_trait]
pub trait Grouper: Send + Sync {
    async fn group(
        &self,
        rev: &Revision,
        pr: &PrDetail,
        worktree: &Path,
    ) -> Result<Grouping, GrouperError>;

    /// Re-group after a push: unchanged hunks keep their group (plan §5.3).
    async fn regroup(
        &self,
        prev: &Grouping,
        rev: &Revision,
        pr: &PrDetail,
        worktree: &Path,
    ) -> Result<Grouping, GrouperError>;
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
}
