//! `regroup` (plan §5.3): re-run the grouper against the cached revision,
//! continuing from the previous grouping when there is one.

use theodore_contract::models;
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
            .get(&(pr.clone(), head))
            .cloned();
        let Some(entry) = entry else {
            return Err(AppError::Invalid("revision not cached".into()));
        };
        let detail = self.load_pr_detail(&pr).await?;

        let pr_s = pr.0.clone();
        let store = self.0.deps.store.clone();
        let prev_row = tokio::task::spawn_blocking(move || store.get(models::GROUPING, &pr_s))
            .await
            .map_err(AppError::join)??;
        let prev: Option<Grouping> = prev_row.and_then(|r| serde_json::from_value(r.data).ok());
        let repo_scope = detail.summary.pr.repo.slug();
        let agent = self
            .setting_agent_scoped("agents.grouping", Some(&repo_scope), AgentId::Claude)
            .await;

        let grouping = match &prev {
            Some(p) => {
                self.0
                    .deps
                    .grouper
                    .regroup(p, &entry.revision, &detail, &entry.worktree_path, agent)
                    .await?
            }
            None => {
                self.0
                    .deps
                    .grouper
                    .group(&entry.revision, &detail, &entry.worktree_path, agent)
                    .await?
            }
        };
        let data = serde_json::to_value(&grouping).map_err(|e| AppError::Invalid(e.to_string()))?;
        let action = NewAction {
            model: models::GROUPING.into(),
            model_id: pr.0.clone(),
            action: SyncActionCode::U,
            data: Some(data),
        };
        self.apply(vec![action]).await?;
        Ok(())
    }
}
