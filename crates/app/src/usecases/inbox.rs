//! `refresh_inbox` (plan §6.5, §6.6): one `HostAdapter::search` per inbox
//! section, written as `pr` rows plus `inbox_state` rows that are created
//! once and never overwritten afterwards (so `done`/`snooze` survive).
//! Called once in the background on `Core::start` and again whenever the
//! poller's `changed_since` reports something changed.

use std::collections::BTreeSet;

use theodore_contract::{Ephemeral, InboxState, ToastLevel, models};
use theodore_ports::{InboxSection, NewAction, SyncActionCode};

use crate::core::Core;
use crate::error::{AppError, AppResult};

const SECTIONS: [InboxSection; 4] = [
    InboxSection::ReviewRequested,
    InboxSection::Assigned,
    InboxSection::Authored,
    InboxSection::Mentioned,
];

impl Core {
    pub async fn refresh_inbox(&self) -> AppResult<()> {
        let mut actions = Vec::new();
        let mut seen = BTreeSet::new();
        let mut complete = true;

        for section in &SECTIONS {
            let summaries = match self.0.deps.host.search(section).await {
                Ok(s) => s,
                Err(e) => {
                    complete = false;
                    self.emit(Ephemeral::Toast {
                        level: ToastLevel::Warn,
                        text: format!("inbox refresh failed ({section:?}): {e}"),
                    });
                    continue;
                }
            };
            for summary in summaries {
                let pr_id = summary.pr.id();
                if !seen.insert(pr_id.clone()) {
                    // Already queued by an earlier section in this pass.
                    continue;
                }
                let pr_s = pr_id.0.clone();
                if self.is_stale_summary(&pr_s, summary.updated_at).await {
                    // Keep the newer row; only the inbox's reasons are news.
                    actions.push(NewAction {
                        model: models::PR.into(),
                        model_id: pr_s.clone(),
                        action: SyncActionCode::C,
                        data: Some(serde_json::json!({ "reasons": summary.reasons })),
                    });
                } else {
                    let data = serde_json::to_value(&summary)
                        .map_err(|e| AppError::Invalid(e.to_string()))?;
                    actions.push(NewAction {
                        model: models::PR.into(),
                        model_id: pr_s.clone(),
                        action: SyncActionCode::U,
                        data: Some(data),
                    });
                }

                let store = self.0.deps.store.clone();
                let existing =
                    tokio::task::spawn_blocking(move || store.get(models::INBOX_STATE, &pr_s))
                        .await
                        .map_err(AppError::join)??;
                if existing.is_none() {
                    let state = InboxState {
                        pr: pr_id.clone(),
                        done: false,
                        snooze: None,
                    };
                    let data = serde_json::to_value(&state)
                        .map_err(|e| AppError::Invalid(e.to_string()))?;
                    actions.push(NewAction {
                        model: models::INBOX_STATE.into(),
                        model_id: pr_id.0.clone(),
                        action: SyncActionCode::I,
                        data: Some(data),
                    });
                }
            }
        }

        // A PR no search returned any more (you reviewed it, it was
        // reassigned, …) has no reason to be in the inbox: clear its stored
        // reasons. Only after a complete pass — a failed section would
        // otherwise empty the inbox.
        if complete {
            let store = self.0.deps.store.clone();
            let rows = tokio::task::spawn_blocking(move || store.all(models::PR))
                .await
                .map_err(AppError::join)??;
            for row in rows {
                let had_reasons = row
                    .data
                    .get("reasons")
                    .and_then(|v| v.as_array())
                    .is_some_and(|a| !a.is_empty());
                if had_reasons && !seen.contains(&theodore_domain::PrId(row.id.clone())) {
                    actions.push(NewAction {
                        model: models::PR.into(),
                        model_id: row.id,
                        action: SyncActionCode::C,
                        data: Some(serde_json::json!({ "reasons": [] })),
                    });
                }
            }
        }

        self.apply(actions).await?;
        self.refresh_stacks().await?;
        Ok(())
    }
}
