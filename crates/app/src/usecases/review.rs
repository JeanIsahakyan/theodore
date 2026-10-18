//! `submit_review` (plan §3.2, §6.7): drafts of the PR become one outbox
//! item. Nothing is written to the host until the outbox runs it.

use theodore_contract::{SubmitReviewRequest, models};
use theodore_domain::Draft;

use crate::error::{AppError, AppResult};
use crate::outbox::{DraftComment, SubmitReviewPayload};

use crate::core::Core;

impl Core {
    pub async fn submit_review(&self, req: SubmitReviewRequest) -> AppResult<()> {
        self.ensure_open(&req.pr).await?;
        let head = self.0.current_head.read().await.get(&req.pr).cloned();
        let Some(head) = head else {
            return Err(AppError::Invalid("pr is not open".into()));
        };

        let pr_s = req.pr.0.clone();
        let store = self.0.deps.store.clone();
        let rows = tokio::task::spawn_blocking(move || store.query(models::DRAFT, "pr", &pr_s))
            .await
            .map_err(AppError::join)??;

        let comments: Vec<DraftComment> = rows
            .iter()
            .filter_map(|r| {
                let draft: Draft = serde_json::from_value(r.data.clone()).ok()?;
                Some(DraftComment {
                    draft_id: draft.id.0.clone(),
                    marker: format!("theodore:{}", draft.id.0),
                    anchor: draft.anchor,
                    body: draft.body,
                })
            })
            .collect();

        let payload = SubmitReviewPayload {
            pr: req.pr.clone(),
            head,
            event: req.event,
            body: req.body.clone(),
            comments,
        };
        let payload_json =
            serde_json::to_value(&payload).map_err(|e| AppError::Invalid(e.to_string()))?;
        self.enqueue_outbox("submit_review", payload_json).await?;
        Ok(())
    }
}
