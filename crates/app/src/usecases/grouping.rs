//! `regroup` (plan §5.3): re-run the grouper against the cached revision,
//! continuing from the previous grouping when there is one.

use theodore_contract::{Ephemeral, models};
use theodore_domain::{AgentId, Grouping, PrId};
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
        let grouping = match prev {
            Some(p) => {
                self.0
                    .deps
                    .grouper
                    .regroup(p, &entry.revision, detail, &entry.worktree_path, agent)
                    .await?
            }
            None => {
                self.0
                    .deps
                    .grouper
                    .group(&entry.revision, detail, &entry.worktree_path, agent)
                    .await?
            }
        };
        Ok(grouping)
    }
}
