//! `pr_spend`, budget gate (plan §8.4): spend is computed from the PR's own
//! `skill_run` and `chat_message` rows rather than kept in a separate
//! counter, so it never drifts from what's actually stored and survives a
//! restart for free. `agents.grouping`'s own cost isn't tracked here: the
//! `Grouper` port doesn't report usage back to `app` (see final report).

use theodore_contract::{Ephemeral, PrSpend, ToastLevel, models};
use theodore_domain::{PrId, Usage};

use crate::core::Core;
use crate::error::{AppError, AppResult};

impl Core {
    pub async fn pr_spend(&self, pr: PrId) -> AppResult<PrSpend> {
        let usage = self.current_spend(&pr).await?;
        let repo_scope = self.repo_scope_of(&pr).await;
        let budget_usd = self
            .setting_f64_scoped("budget.per_pr_usd", repo_scope.as_deref())
            .await;
        Ok(PrSpend {
            pr,
            usage,
            budget_usd,
        })
    }

    /// Sum of every `skill_run.usage` and `chat_message.usage` stored for
    /// `pr`. Usage from a still-running run isn't counted until it finishes
    /// and patches its row — an approximation, not a hard real-time cap.
    pub(crate) async fn current_spend(&self, pr: &PrId) -> AppResult<Usage> {
        let store = self.0.deps.store.clone();
        let pr_s = pr.0.clone();
        let (runs, chats) = tokio::task::spawn_blocking(move || {
            let runs = store.query(models::SKILL_RUN, "pr", &pr_s)?;
            let chats = store.query(models::CHAT_MESSAGE, "pr", &pr_s)?;
            Ok::<_, theodore_ports::StoreError>((runs, chats))
        })
        .await
        .map_err(AppError::join)??;

        let mut total = Usage::default();
        for row in runs.iter().chain(chats.iter()) {
            if let Some(usage) = row
                .data
                .get("usage")
                .filter(|v| !v.is_null())
                .and_then(|v| serde_json::from_value::<Usage>(v.clone()).ok())
            {
                total += usage;
            }
        }
        Ok(total)
    }

    /// Refuses with a toast once `pr`'s spend has reached `budget.per_pr_usd`
    /// (plan §8.4). Called before `run_skill`, `ask`, `delegate_task` and
    /// `regroup` start a new agent run.
    pub(crate) async fn check_budget(&self, pr: &PrId) -> AppResult<()> {
        let repo_scope = self.repo_scope_of(pr).await;
        let Some(budget) = self
            .setting_f64_scoped("budget.per_pr_usd", repo_scope.as_deref())
            .await
        else {
            return Ok(());
        };
        let spent = self.current_spend(pr).await?;
        if spent.usd >= budget {
            let text = format!(
                "PR budget of ${budget:.2} reached (spent ${:.2})",
                spent.usd
            );
            self.emit(Ephemeral::Toast {
                level: ToastLevel::Error,
                text: text.clone(),
            });
            return Err(AppError::Invalid(text));
        }
        Ok(())
    }
}
