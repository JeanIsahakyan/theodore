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

        for section in &SECTIONS {
            let summaries = match self.0.deps.host.search(section).await {
                Ok(s) => s,
                Err(e) => {
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
                let data =
                    serde_json::to_value(&summary).map_err(|e| AppError::Invalid(e.to_string()))?;
                actions.push(NewAction {
                    model: models::PR.into(),
                    model_id: pr_s.clone(),
                    action: SyncActionCode::U,
                    data: Some(data),
                });

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

        self.apply(actions).await?;
        self.refresh_stacks().await?;
        Ok(())
    }
}
