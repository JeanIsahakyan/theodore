//! `triage` (plan "Triage"): take, decline, or reassign a review request
//! straight from the inbox/My PRs row, without opening the PR first.
//!
//! The write (and, for `decline`, the local `inbox_state` flip) goes through
//! the outbox like every other host write (plan §6.7): retried with
//! backoff, and the PR's rows refreshed on success.

use theodore_contract::{TriageRequest, models};
use theodore_domain::{Check, PrDetail, PrId};
use theodore_ports::{NewAction, SyncActionCode};

use crate::core::Core;
use crate::error::AppResult;
use crate::usecases::merge::reject_if_local;

impl Core {
    pub async fn triage(&self, req: TriageRequest) -> AppResult<()> {
        let pr_ref = self
            .pr_ref(&req.pr)
            .await
            .ok_or_else(|| crate::error::AppError::NotFound(format!("pr {}", req.pr)))?;
        reject_if_local(&pr_ref, "triaging a review request")?;
        let data = serde_json::to_value(&req)
            .map_err(|e| crate::error::AppError::Invalid(e.to_string()))?;
        self.enqueue_outbox("triage", data).await?;
        Ok(())
    }

    /// `Check` matching `check_id` in the PR's last stored `pr_detail`, so
    /// an outbox item re-running later never acts on a stale UI value.
    pub(crate) async fn pr_check(&self, pr: &PrId, check_id: &str) -> Option<Check> {
        let detail = self.stored_pr_detail(pr).await?;
        detail.checks.into_iter().find(|c| c.id == check_id)
    }

    /// Names of teams with an open review request on the PR (plan "take":
    /// the viewer stepping in replaces the team's standing request). Asks
    /// the host: a PR taken straight from the inbox was usually never
    /// opened, so there is no stored `pr_detail` to read them from.
    pub(crate) async fn pr_requested_teams(&self, pr: &PrId) -> Vec<String> {
        let detail = match self.pr_ref(pr).await {
            Some(pr_ref) => match self.0.deps.host.get_pr(&pr_ref, None).await {
                Ok(theodore_ports::Fetched::Modified { value, .. }) => Some(value),
                _ => self.stored_pr_detail(pr).await,
            },
            None => self.stored_pr_detail(pr).await,
        };
        detail
            .map(|d| d.reviewers.into_iter().filter_map(|r| r.team).collect())
            .unwrap_or_default()
    }

    async fn stored_pr_detail(&self, pr: &PrId) -> Option<PrDetail> {
        let row = self
            .get_row(models::PR_DETAIL, &pr.0)
            .await
            .ok()
            .flatten()?;
        serde_json::from_value(row).ok()
    }

    /// Marks the inbox row done (plan "decline"): the viewer stepped away,
    /// so the PR drops off their inbox the same way a manual "done" would.
    pub(crate) async fn mark_inbox_done(&self, pr: &PrId) {
        let _ = self
            .apply(vec![NewAction {
                model: models::INBOX_STATE.into(),
                model_id: pr.0.clone(),
                action: SyncActionCode::C,
                data: Some(serde_json::json!({ "done": true })),
            }])
            .await;
    }
}
