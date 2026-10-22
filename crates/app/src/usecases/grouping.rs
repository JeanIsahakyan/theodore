//! `regroup` (plan §5.3): re-run the grouper against the cached revision,
//! continuing from the previous grouping when there is one.

use std::path::{Component, Path};

use theodore_contract::{Ephemeral, models};
use theodore_domain::grouping::{CO_CHANGE_MAX_COMMITS, CO_CHANGE_MAX_FILES, RepoContext};
use theodore_domain::{AgentId, FileFlag, FileStatus, Grouping, PrId, Revision};
use theodore_ports::{NewAction, SyncActionCode};

use crate::core::Core;
use crate::error::{AppError, AppResult};

impl Core {
    pub async fn regroup(&self, pr: PrId) -> AppResult<()> {
        self.ensure_open(&pr).await?;
        self.check_budget(&pr).await?;
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
        // Continue from the previous grouping only after a push to a newer
        // head, and only if the current algorithm made it; an explicit
        // regroup of the same head starts fresh (incremental regroup keeps
        // the previous groups' shape, including their fragmentation).
        let prev: Option<Grouping> = prev_row.and_then(|r| {
            let algo = theodore_domain::grouping::row_algo(&r.data);
            serde_json::from_value::<Grouping>(r.data)
                .ok()
                .filter(|g| g.rev != head && algo >= theodore_domain::grouping::ALGO_VERSION)
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
        let result = self.regroup_run(&prev, &entry, &detail, agent).await;
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
        let grouping = result?;
        let data = theodore_domain::grouping::to_row(&grouping)
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
    ) -> AppResult<Grouping> {
        let ctx = self
            .grouping_context(&entry.worktree_path, &entry.revision)
            .await;
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
                    .group(&entry.revision, detail, &ctx, &entry.worktree_path, agent)
                    .await?
            }
        };
        Ok(grouping)
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
