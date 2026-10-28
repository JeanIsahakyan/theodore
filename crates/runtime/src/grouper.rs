//! `app::Grouper` over the grouping pipeline (plan §5).

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use theodore_app::{Grouper, GrouperError, GroupingAgent};
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
    match e {
        theodore_grouping::GroupingPipelineError::DuplicateHunkIds(_) => {
            GrouperError::Invalid(e.to_string())
        }
        e => {
            let text = e.to_string();
            match theodore_ports::offline_message_in(&text) {
                Some(offline) => GrouperError::Offline(offline.to_string()),
                None => GrouperError::Agent(text),
            }
        }
    }
}

/// Logs a finished run and emits `grouping_done` (docs/telemetry.md).
fn done(report: theodore_grouping::GroupingReport, agent: AgentId, rev: &Revision) -> Grouping {
    let hunks = rev.hunks().count() as u32;
    let groups = report.grouping.groups.len() as u32;
    tracing::info!(
        agent = agent.as_str(),
        duration_ms = report.duration_ms,
        attempts = report.attempts,
        valid_first_try = report.valid_first_try,
        chunks = report.chunks,
        groups,
        hunks,
        "grouping done"
    );
    if !report.valid_first_try {
        tracing::warn!(
            error.code = "grouping.repaired",
            agent = agent.as_str(),
            attempts = report.attempts,
            "grouping needed a repair round or the Other fallback"
        );
    }
    theodore_telemetry::product(theodore_telemetry::ProductEvent::GroupingDone {
        ms: report.duration_ms,
        valid_first_try: report.valid_first_try,
        groups,
        hunks,
        agent: agent.as_str().to_string(),
        chunks: report.chunks,
    });
    report.grouping
}

#[async_trait]
impl Grouper for GroupingGrouper {
    async fn group(
        &self,
        rev: &Revision,
        pr: &PrDetail,
        ctx: &RepoContext,
        worktree: &Path,
        run: GroupingAgent,
    ) -> Result<Grouping, GrouperError> {
        let agent = run.id;
        let mut opts = self.opts.clone();
        opts.agent = agent;
        opts.user_mcp = run.user_mcp;
        theodore_grouping::group_revision_with(&*self.agents, &meta(pr), rev, ctx, worktree, &opts)
            .await
            .map(|r| done(r, agent, rev))
            .map_err(err)
    }

    async fn regroup(
        &self,
        prev: &Grouping,
        rev: &Revision,
        pr: &PrDetail,
        // Head files and co-change sharpen the relatedness graph that
        // suggests a group for each new hunk.
        ctx: &RepoContext,
        worktree: &Path,
        run: GroupingAgent,
    ) -> Result<Grouping, GrouperError> {
        let agent = run.id;
        let mut opts = self.opts.clone();
        opts.agent = agent;
        opts.user_mcp = run.user_mcp;
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
        theodore_grouping::regroup_with(
            &*self.agents,
            &meta(pr),
            prev,
            rev,
            &changes,
            ctx,
            worktree,
            &opts,
        )
        .await
        .map(|r| done(r, agent, rev))
        .map_err(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use theodore_grouping::GroupingPipelineError;

    #[test]
    fn an_agent_that_could_not_connect_is_offline_not_a_failure() {
        let offline = theodore_ports::offline_message("claude");
        let e = err(GroupingPipelineError::AgentRun(format!(
            "{offline}: getaddrinfo ENOTFOUND api.anthropic.com"
        )));
        assert!(
            matches!(&e, GrouperError::Offline(m) if *m == offline),
            "{e:?}"
        );
        assert_eq!(e.code(), "agent.offline");
        let e = err(GroupingPipelineError::AgentRun("exited 1: boom".into()));
        assert!(matches!(e, GrouperError::Agent(_)), "{e:?}");
    }
}
