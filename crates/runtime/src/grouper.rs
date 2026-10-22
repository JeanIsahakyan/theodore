//! `app::Grouper` over the grouping pipeline (plan §5).

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use theodore_app::{Grouper, GrouperError};
use theodore_domain::grouping::RepoContext;
use theodore_domain::{AgentId, Grouping, PrDetail, Revision};
use theodore_grouping::{GroupingOptions, PrMeta};
use theodore_ports::AgentPort;

pub struct GroupingGrouper {
    agents: Arc<dyn AgentPort>,
    opts: GroupingOptions,
}

impl GroupingGrouper {
    pub fn new(agents: Arc<dyn AgentPort>) -> Self {
        Self {
            agents,
            opts: GroupingOptions::default(),
        }
    }

    pub fn with_options(mut self, opts: GroupingOptions) -> Self {
        self.opts = opts;
        self
    }
}

fn meta(pr: &PrDetail) -> PrMeta {
    PrMeta {
        title: pr.summary.title.clone(),
        body: pr.body.clone(),
        commits: pr.commits.iter().map(|c| c.title.clone()).collect(),
    }
}

fn err(e: theodore_grouping::GroupingPipelineError) -> GrouperError {
    GrouperError::Agent(e.to_string())
}

#[async_trait]
impl Grouper for GroupingGrouper {
    async fn group(
        &self,
        rev: &Revision,
        pr: &PrDetail,
        ctx: &RepoContext,
        worktree: &Path,
        agent: AgentId,
    ) -> Result<Grouping, GrouperError> {
        let mut opts = self.opts.clone();
        opts.agent = agent;
        theodore_grouping::group_revision_with(&*self.agents, &meta(pr), rev, ctx, worktree, &opts)
            .await
            .map(|r| r.grouping)
            .map_err(err)
    }

    async fn regroup(
        &self,
        prev: &Grouping,
        rev: &Revision,
        pr: &PrDetail,
        // Incremental regroup only places new hunks into existing groups;
        // the relatedness graph is for whole-PR grouping.
        _ctx: &RepoContext,
        worktree: &Path,
        agent: AgentId,
    ) -> Result<Grouping, GrouperError> {
        let mut opts = self.opts.clone();
        opts.agent = agent;
        // The previous grouping's hunk ids stand in for the old revision:
        // unchanged hunks keep their ids, so anything not in `prev` is new.
        let known: std::collections::BTreeSet<_> = prev
            .groups
            .iter()
            .flat_map(|g| g.hunks.iter().cloned())
            .collect();
        let changes = rev
            .hunks()
            .map(|h| {
                let c = if known.contains(&h.id) {
                    theodore_domain::interdiff::HunkChange::Unchanged
                } else {
                    theodore_domain::interdiff::HunkChange::New
                };
                (h.id.clone(), c)
            })
            .collect();
        theodore_grouping::regroup(
            &*self.agents,
            &meta(pr),
            prev,
            rev,
            &changes,
            worktree,
            &opts,
        )
        .await
        .map(|r| r.grouping)
        .map_err(err)
    }
}
