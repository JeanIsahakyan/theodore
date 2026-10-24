//! `submit_review` (plan §3.2, §6.7): drafts of the PR become one outbox
//! item. Nothing is written to the host until the outbox runs it.

use theodore_contract::{Ephemeral, SubmitReviewRequest, ToastLevel, models};
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

        let mut outdated = 0usize;
        let comments: Vec<DraftComment> = rows
            .iter()
            .filter_map(|r| {
                let draft: Draft = serde_json::from_value(r.data.clone()).ok()?;
                if draft.outdated {
                    // A push moved the diff out from under this anchor
                    // (plan §4): the host would reject (or misplace) a
                    // comment anchored there, so skip it rather than fail
                    // the whole review.
                    outdated += 1;
                    return None;
                }
                Some(DraftComment {
                    draft_id: draft.id.0.clone(),
                    marker: draft.id.0.clone(),
                    anchor: draft.anchor,
                    body: draft.body,
                })
            })
            .collect();
        if outdated > 0 {
            self.emit(Ephemeral::Toast {
                level: ToastLevel::Warn,
                text: format!(
                    "{outdated} draft comment(s) skipped: their lines changed in a later push"
                ),
            });
        }

        let review_event = crate::usecases::telemetry::wire_str(&req.event);
        let comment_count = comments.len() as u32;
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
        theodore_telemetry::product(theodore_telemetry::ProductEvent::ReviewSubmitted {
            comments: comment_count,
            review_event,
        });
        Ok(())
    }
}
