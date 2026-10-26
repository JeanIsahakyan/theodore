//! Read-only view of an open PR for adapters outside `app` (the MCP
//! `review-tools` backend).

use std::path::PathBuf;
use std::sync::Arc;

use theodore_contract::models;
use theodore_domain::{Grouping, PrDetail, PrId, Revision};

use crate::core::Core;
use crate::error::{AppError, AppResult};

pub struct PrSnapshot {
    pub detail: PrDetail,
    pub revision: Arc<Revision>,
    pub grouping: Option<Grouping>,
    pub worktree: PathBuf,
}

impl Core {
    /// The PR's current head revision, detail and grouping. `NotFound` if the
    /// PR is not open in this session.
    pub async fn snapshot(&self, pr: &PrId) -> AppResult<PrSnapshot> {
        let head = self
            .0
            .current_head
            .read()
            .await
            .get(pr)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("pr {pr} is not open")))?;
        let (revision, worktree) = {
            let revisions = self.0.revisions.read().await;
            let e = revisions
                .get(&(pr.clone(), head))
                .ok_or_else(|| AppError::NotFound(format!("revision of {pr}")))?;
            (e.revision.clone(), e.worktree_path.clone())
        };
        let store = self.0.deps.store.clone();
        let id = pr.0.clone();
        let (detail, grouping) = tokio::task::spawn_blocking(move || {
            Ok::<_, AppError>((
                store.get(models::PR_DETAIL, &id)?,
                store.get(models::GROUPING, &id)?,
            ))
        })
        .await
        .map_err(AppError::join)??;
        let detail = detail.ok_or_else(|| AppError::NotFound(format!("detail of {pr}")))?;
        let detail: PrDetail =
            serde_json::from_value(detail.data).map_err(|e| AppError::Invalid(e.to_string()))?;
        let grouping = grouping.and_then(|r| serde_json::from_value(r.data).ok());
        Ok(PrSnapshot {
            detail,
            revision,
            grouping,
            worktree,
        })
    }
}
