//! `get_revision` / `get_file` (plan §3.2): diffs and file contents are
//! immutable per commit, so they're fetched by query, not synced.

use std::sync::Arc;

use theodore_contract::{FileRequest, RevisionRequest, models};
use theodore_domain::{PrDetail, Revision};
use theodore_ports::DiffOptions;

use crate::core::{Core, RevisionEntry};
use crate::error::{AppError, AppResult};

impl Core {
    pub async fn get_revision(&self, req: RevisionRequest) -> AppResult<Revision> {
        if let Some(entry) = self
            .0
            .revisions
            .read()
            .await
            .get(&(req.pr.clone(), req.head.clone()))
        {
            return Ok((*entry.revision).clone());
        }

        let detail = self.load_pr_detail(&req.pr).await?;
        let repo_path = self.0.deps.git.ensure_repo(&detail.summary.pr.repo).await?;
        let worktree = self
            .0
            .deps
            .git
            .worktree(&detail.summary.pr, &req.head)
            .await?;
        let revision = self
            .0
            .deps
            .git
            .diff(
                &repo_path,
                &detail.base_sha,
                &req.head,
                &DiffOptions::default(),
            )
            .await?;

        self.0.revisions.write().await.insert(
            (req.pr.clone(), req.head.clone()),
            Arc::new(RevisionEntry {
                revision: Arc::new(revision.clone()),
                repo_path,
                worktree_path: worktree.path,
                pr_ref: detail.summary.pr,
            }),
        );
        Ok(revision)
    }

    pub async fn get_file(&self, req: FileRequest) -> AppResult<Option<String>> {
        let repo_path = {
            let revisions = self.0.revisions.read().await;
            revisions
                .iter()
                .find(|((pr, _), _)| *pr == req.pr)
                .map(|(_, e)| e.repo_path.clone())
        };
        let repo_path = match repo_path {
            Some(p) => p,
            None => {
                let detail = self.load_pr_detail(&req.pr).await?;
                self.0.deps.git.ensure_repo(&detail.summary.pr.repo).await?
            }
        };
        let bytes = self
            .0
            .deps
            .git
            .show(&repo_path, &req.rev, &req.path)
            .await?;
        Ok(bytes.map(|b| String::from_utf8_lossy(&b).into_owned()))
    }

    pub(crate) async fn load_pr_detail(&self, pr: &theodore_domain::PrId) -> AppResult<PrDetail> {
        let pr_s = pr.0.clone();
        let store = self.0.deps.store.clone();
        let row = tokio::task::spawn_blocking(move || store.get(models::PR_DETAIL, &pr_s))
            .await
            .map_err(AppError::join)??;
        let Some(row) = row else {
            return Err(AppError::NotFound(format!("pr {pr}")));
        };
        serde_json::from_value(row.data).map_err(|e| AppError::Invalid(e.to_string()))
    }
}
