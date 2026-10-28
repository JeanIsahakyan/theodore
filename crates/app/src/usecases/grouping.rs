//! `regroup` (plan §5.3): re-run the grouper against the cached revision,
//! continuing from the previous grouping when there is one.

use std::path::{Component, Path};

use theodore_contract::{Ephemeral, models};
use theodore_domain::grouping::{CO_CHANGE_MAX_COMMITS, CO_CHANGE_MAX_FILES, RepoContext};
use theodore_domain::review_rules::ReviewRules;
use theodore_domain::{AgentId, FileFlag, FileStatus, Grouping, PrId, Revision};
use theodore_ports::{NewAction, SyncActionCode};
use tracing::Instrument as _;

use crate::core::Core;
use crate::error::{AppError, AppResult};

impl Core {
    pub async fn regroup(&self, pr: PrId) -> AppResult<()> {
        self.ensure_open(&pr).await?;
        let head = self.0.current_head.read().await.get(&pr).cloned();
        let Some(head) = head else {
            return Err(AppError::Invalid("pr is not open".into()));
        };
        let entry = self
            .0
            .revisions
            .read()
            .await
            .get(&(pr.clone(), head.clone()))
            .cloned();
        let Some(entry) = entry else {
            return Err(AppError::Invalid("revision not cached".into()));
        };
        let detail = self.load_pr_detail(&pr).await?;

        // Held for the whole run (plan "worktree locks"): see `agents::run_skill`.
        let _lease = self.0.deps.worktree_lease.acquire(entry.pr_ref.clone());

        let pr_s = pr.0.clone();
        let store = self.0.deps.store.clone();
        let prev_row = tokio::task::spawn_blocking(move || store.get(models::GROUPING, &pr_s))
            .await
            .map_err(AppError::join)??;
        let prior = prev_row.as_ref().map(|r| r.data.clone());
        // Continue from the previous grouping only after a push to a newer
        // head, and only if the current algorithm made it; an explicit
        // regroup of the same head starts fresh (incremental regroup keeps
        // the previous groups' shape, including their fragmentation).
        // A changed review config (`hide`, `skim`, `checklist`) starts
        // fresh too: the previous groups were cut under other rules.
        let rules = self.review_rules_at(entry.config_source()).await;
        let hash = rules.grouping_hash();
        let prev: Option<Grouping> = prev_row.and_then(|r| {
            let algo = theodore_domain::grouping::row_algo(&r.data);
            let same_rules = theodore_domain::grouping::row_review_hash(&r.data) == hash.as_deref();
            serde_json::from_value::<Grouping>(r.data).ok().filter(|g| {
                g.rev != head
                    && !g.in_progress
                    && algo >= theodore_domain::grouping::ALGO_VERSION
                    && same_rules
            })
        });
        let repo_scope = detail.summary.pr.repo.slug();
        let configured = self
            .setting_agent_scoped("agents.grouping", Some(&repo_scope), AgentId::Claude)
            .await;
        let agent = self.effective_agent(configured).await;

        {
            let mut inflight = self
                .0
                .grouping_inflight
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            if !inflight.insert(pr.clone()) {
                return Err(AppError::Invalid("grouping is already running".into()));
            }
        }
        self.emit(Ephemeral::Grouping {
            pr: pr.clone(),
            running: true,
            error: None,
        });
        let span = grouping_span(&pr, agent, prev.is_some());
        let started = std::time::Instant::now();
        let writer = PartialWriter::start(
            self,
            pr.clone(),
            entry.revision.clone(),
            rules.clone(),
            prior,
        );
        let result = self
            .regroup_run(&prev, &entry, &detail, agent, rules, &|g| writer.send(g))
            .instrument(span)
            .await;
        writer.finish(result.is_ok()).await;
        if let Err(e @ AppError::Grouper(crate::error::GrouperError::Offline(_))) = &result {
            // The agent couldn't reach its servers: the network, not a bug.
            tracing::info!(
                error.code = e.code(),
                pr = %pr.0,
                agent = agent.as_str(),
                duration_ms = started.elapsed().as_millis() as u64,
                error = %e,
                "grouping couldn't run"
            );
        } else if let Err(e) = &result {
            tracing::warn!(
                error.code = e.code(),
                pr = %pr.0,
                agent = agent.as_str(),
                duration_ms = started.elapsed().as_millis() as u64,
                error = %e,
                "grouping failed"
            );
            theodore_telemetry::product(theodore_telemetry::ProductEvent::GroupingFailed {
                code: e.code().to_string(),
            });
        }
        self.0
            .grouping_inflight
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&pr);
        self.emit(Ephemeral::Grouping {
            pr: pr.clone(),
            running: false,
            error: result.as_ref().err().map(|e| e.to_string()),
        });
        let (grouping, ctx) = result?;
        let data = grouping_row(grouping, &entry.revision, &ctx)
            .map_err(|e| AppError::Invalid(e.to_string()))?;
        let action = NewAction {
            model: models::GROUPING.into(),
            model_id: pr.0.clone(),
            action: SyncActionCode::U,
            data: Some(data),
        };
        self.apply(vec![action]).await?;
        Ok(())
    }

    async fn regroup_run(
        &self,
        prev: &Option<Grouping>,
        entry: &crate::core::RevisionEntry,
        detail: &theodore_domain::PrDetail,
        agent: AgentId,
        rules: ReviewRules,
        on_partial: crate::deps::OnPartial<'_>,
    ) -> AppResult<(Grouping, RepoContext)> {
        let mut ctx = self
            .grouping_context(&entry.worktree_path, &entry.revision)
            .await;
        ctx.review = rules;
        let agent = crate::deps::GroupingAgent {
            id: agent,
            // Grouping never uses the user's MCP servers: starting
            // them on every chunk would only slow it down.
            user_mcp: false,
        };
        let grouping = match prev {
            Some(p) => {
                self.0
                    .deps
                    .grouper
                    .regroup(
                        p,
                        &entry.revision,
                        detail,
                        &ctx,
                        &entry.worktree_path,
                        agent,
                    )
                    .await?
            }
            None => {
                self.0
                    .deps
                    .grouper
                    .group(
                        &entry.revision,
                        detail,
                        &ctx,
                        &entry.worktree_path,
                        agent,
                        on_partial,
                    )
                    .await?
            }
        };
        Ok((grouping, ctx))
    }

    /// What the grouper can use beyond the diff: head contents of the
    /// changed text files (imports outside the hunks) and which of them
    /// changed together before this PR (`GitPort::co_change_commits` from
    /// the base). Best-effort: anything unreadable is simply left out.
    pub(crate) async fn grouping_context(&self, worktree: &Path, rev: &Revision) -> RepoContext {
        let mut ctx = RepoContext::default();
        let mut budget = HEAD_FILES_MAX_TOTAL_BYTES;
        for f in rev.files.iter().take(HEAD_FILES_MAX_COUNT) {
            let readable = f.status != FileStatus::Deleted
                && !f.hunks.is_empty()
                && !f.flags.iter().any(|fl| {
                    matches!(
                        fl,
                        FileFlag::Binary { .. }
                            | FileFlag::Generated { .. }
                            | FileFlag::Lfs
                            | FileFlag::Submodule
                    )
                })
                && is_plain_relative(&f.path);
            if !readable {
                continue;
            }
            let path = worktree.join(&f.path);
            let Ok(meta) = tokio::fs::metadata(&path).await else {
                continue;
            };
            let size = meta.len() as usize;
            if !meta.is_file() || size > HEAD_FILE_MAX_BYTES || size > budget {
                continue;
            }
            if let Ok(text) = tokio::fs::read_to_string(&path).await {
                budget -= size;
                ctx.head_files.insert(f.path.clone(), text);
            }
        }
        let paths: Vec<String> = rev.files.iter().map(|f| f.path.clone()).collect();
        ctx.co_change_commits = self
            .0
            .deps
            .git
            .co_change_commits(
                worktree,
                &rev.base,
                &paths,
                CO_CHANGE_MAX_COMMITS,
                CO_CHANGE_MAX_FILES,
            )
            .await
            .unwrap_or_default();
        ctx
    }
}

/// The span a grouping run goes in. The grouper records when the first
/// group was shown on it (`first_group_ms`).
pub(crate) fn grouping_span(pr: &PrId, agent: AgentId, incremental: bool) -> tracing::Span {
    tracing::info_span!(
        "grouping",
        pr = %pr.0,
        agent = agent.as_str(),
        incremental,
        first_group_ms = tracing::field::Empty,
    )
}

/// The grouping as stored: the config's checklist items added to its
/// groups, then the row with the algorithm version and the hash of the
/// review rules it was made under.
pub(crate) fn grouping_row(
    grouping: Grouping,
    rev: &Revision,
    ctx: &RepoContext,
) -> serde_json::Result<serde_json::Value> {
    grouping_row_under(grouping, rev, &ctx.review)
}

fn grouping_row_under(
    mut grouping: Grouping,
    rev: &Revision,
    rules: &ReviewRules,
) -> serde_json::Result<serde_json::Value> {
    rules.apply_checklist(&mut grouping, rev);
    theodore_domain::grouping::to_row_with(&grouping, rules.grouping_hash().as_deref())
}

/// A stored grouping row is still good for `head` under rules hashing to
/// `hash`: same head, current algorithm, same review rules, and finished
/// (a run that failed or was cut short mid-stream left `in_progress` set).
pub(crate) fn row_is_current(
    data: &serde_json::Value,
    head: &theodore_domain::Sha,
    hash: Option<&str>,
) -> bool {
    use theodore_domain::grouping::{ALGO_VERSION, row_algo, row_review_hash};
    data.get("rev").and_then(|v| v.as_str()) == Some(head.as_str())
        && row_algo(data) >= ALGO_VERSION
        && row_review_hash(data) == hash
        && !data
            .get("in_progress")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
}

/// Writes a run's provisional groupings (`Grouper::group`'s `on_partial`)
/// as the PR's grouping row while the run is in flight, so the UI shows
/// groups as the agent writes them:
///
/// ```text
/// grouper ─on_partial─▶ channel ─▶ writer task ─▶ grouping row (U, in_progress)
///                                  └─ several queued: only the newest
/// run returns ─▶ finish(ok): channel closed, last write awaited
///    ok     ─▶ caller writes the final row after it
///    failed ─▶ the row from before the run is put back, if there was one;
///              else the in_progress row stays (shown as unfinished)
/// ```
pub(crate) struct PartialWriter {
    tx: Option<tokio::sync::mpsc::UnboundedSender<Grouping>>,
    /// Resolves to whether any row was written.
    task: tokio::task::JoinHandle<bool>,
    core: Core,
    pr: PrId,
    /// The PR's grouping row from before the run.
    prior: Option<serde_json::Value>,
}

impl PartialWriter {
    pub(crate) fn start(
        core: &Core,
        pr: PrId,
        rev: impl Into<std::sync::Arc<Revision>>,
        rules: ReviewRules,
        prior: Option<serde_json::Value>,
    ) -> Self {
        let rev: std::sync::Arc<Revision> = rev.into();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Grouping>();
        let task = tokio::spawn({
            let core = core.clone();
            let pr = pr.clone();
            async move {
                let mut wrote = false;
                while let Some(mut grouping) = rx.recv().await {
                    while let Ok(newer) = rx.try_recv() {
                        grouping = newer;
                    }
                    // Closed while the agent worked: no orphaned row.
                    if !core.0.current_head.read().await.contains_key(&pr) {
                        continue;
                    }
                    grouping.in_progress = true;
                    let Ok(data) = grouping_row_under(grouping, &rev, &rules) else {
                        continue;
                    };
                    wrote |= core
                        .apply(vec![NewAction {
                            model: models::GROUPING.into(),
                            model_id: pr.0.clone(),
                            action: SyncActionCode::U,
                            data: Some(data),
                        }])
                        .await
                        .is_ok();
                }
                wrote
            }
            .in_current_span()
        });
        Self {
            tx: Some(tx),
            task,
            core: core.clone(),
            pr,
            prior,
        }
    }

    /// Queue `grouping` for writing (the grouper's `on_partial`).
    pub(crate) fn send(&self, grouping: Grouping) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(grouping);
        }
    }

    /// Wait for the queued writes, so a final row written next lands last.
    /// A failed run (`!ok`) that wrote any puts the row from before it
    /// back.
    pub(crate) async fn finish(self, ok: bool) {
        let Self {
            tx,
            task,
            core,
            pr,
            prior,
        } = self;
        drop(tx);
        let wrote = task.await.unwrap_or(false);
        if ok || !wrote {
            return;
        }
        let Some(data) = prior else { return };
        if !core.0.current_head.read().await.contains_key(&pr) {
            return;
        }
        let _ = core
            .apply(vec![NewAction {
                model: models::GROUPING.into(),
                model_id: pr.0.clone(),
                action: SyncActionCode::U,
                data: Some(data),
            }])
            .await;
    }
}

/// Caps on how much of the worktree `grouping_context` reads.
const HEAD_FILE_MAX_BYTES: usize = 512 * 1024;
const HEAD_FILES_MAX_TOTAL_BYTES: usize = 24 * 1024 * 1024;
const HEAD_FILES_MAX_COUNT: usize = 3000;

/// A diff path that stays inside the worktree (no `..`, not absolute).
fn is_plain_relative(path: &str) -> bool {
    Path::new(path)
        .components()
        .all(|c| matches!(c, Component::Normal(_)))
}
