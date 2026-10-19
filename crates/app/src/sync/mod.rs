//! The sync engine (plan §3): `bootstrap`, `catch_up`, `transact`. Every
//! other write path in `app` (outbox results, the poller, agent runs) goes
//! through `Core::apply` too, so all of them share one sync-id sequence.

mod validate;

use std::sync::atomic::Ordering;

use theodore_contract::{
    Bootstrap, BootstrapScope, MutationOp, SyncFrame, Transaction, TransactionResult, models,
};
use theodore_ports::{NewAction, StoreError, SyncActionCode};

use crate::core::Core;
use crate::error::{AppError, AppResult};
use crate::wire::{to_wire_action, to_wire_row};

impl Core {
    pub async fn bootstrap(&self, scope: BootstrapScope) -> AppResult<Bootstrap> {
        let store = self.0.deps.store.clone();
        let rows = match scope {
            BootstrapScope::Global => tokio::task::spawn_blocking(move || {
                let mut out = Vec::new();
                for m in [
                    models::PR,
                    models::INBOX_STATE,
                    models::TASK,
                    models::SETTING,
                    models::PROJECT,
                ] {
                    out.extend(store.all(m)?);
                }
                Ok::<_, StoreError>(out)
            })
            .await
            .map_err(AppError::join)??,
            BootstrapScope::Pr(pr) => {
                if !self.0.current_head.read().await.contains_key(&pr) {
                    let core = self.clone();
                    let pr = pr.clone();
                    tokio::spawn(async move {
                        if let Err(e) = core.ensure_open(&pr).await {
                            core.emit(theodore_contract::Ephemeral::Toast {
                                level: theodore_contract::ToastLevel::Error,
                                text: format!("Could not open {pr}: {e}"),
                            });
                        }
                    });
                }
                let pr_s = pr.0.clone();
                tokio::task::spawn_blocking(move || {
                    let mut out = Vec::new();
                    if let Some(row) = store.get(models::PR_DETAIL, &pr_s)? {
                        out.push(row);
                    }
                    if let Some(row) = store.get(models::GROUPING, &pr_s)? {
                        out.push(row);
                    }
                    for m in [
                        models::HUNK_READ,
                        models::FILE_VIEWED,
                        models::THREAD,
                        models::DRAFT,
                        models::FINDING,
                        models::SKILL_RUN,
                        models::CHAT_MESSAGE,
                    ] {
                        out.extend(store.query(m, "pr", &pr_s)?);
                    }
                    Ok::<_, StoreError>(out)
                })
                .await
                .map_err(AppError::join)??
            }
        };
        let store = self.0.deps.store.clone();
        let last_sync_id = tokio::task::spawn_blocking(move || store.last_sync_id())
            .await
            .map_err(AppError::join)??;
        Ok(Bootstrap {
            last_sync_id,
            rows: rows.into_iter().map(to_wire_row).collect(),
        })
    }

    /// Replays `(since, last]` over IPC (the UI calls this after a missed
    /// `sync` event, per the event's doc).
    pub async fn catch_up(&self, since: u64) -> AppResult<SyncFrame> {
        let store = self.0.deps.store.clone();
        let actions = tokio::task::spawn_blocking(move || store.since(since, 5_000))
            .await
            .map_err(AppError::join)??;
        let last = actions.last().map(|a| a.id).unwrap_or(since);
        Ok(SyncFrame {
            from_sync_id: since,
            last_sync_id: last,
            actions: actions.into_iter().map(to_wire_action).collect(),
        })
    }

    pub async fn transact(&self, tx: Transaction) -> TransactionResult {
        match self.transact_inner(tx).await {
            Ok(r) => r,
            Err(e) => TransactionResult::Rejected {
                reason: e.to_string(),
            },
        }
    }

    async fn transact_inner(&self, tx: Transaction) -> AppResult<TransactionResult> {
        let dedup_key = format!("tx:{}", tx.id);
        if let Some(last_sync_id) = self.dedup_lookup(&dedup_key).await? {
            return Ok(TransactionResult::Ok { last_sync_id });
        }

        for op in &tx.ops {
            if let Err(reason) = validate::validate_op(self, op).await {
                return Ok(TransactionResult::Rejected { reason });
            }
        }

        let actions: Vec<NewAction> = tx.ops.iter().map(op_to_new_action).collect();
        let applied = self.apply(actions).await?;
        let last_sync_id = applied
            .last()
            .map(|a| a.id)
            .unwrap_or_else(|| self.0.last_broadcast.load(Ordering::SeqCst));
        self.dedup_remember(&dedup_key, last_sync_id).await;

        crate::reading::handle_reads(self, &tx).await;

        Ok(TransactionResult::Ok { last_sync_id })
    }

    async fn dedup_lookup(&self, key: &str) -> AppResult<Option<u64>> {
        let store = self.0.deps.store.clone();
        let key = key.to_string();
        let cached = tokio::task::spawn_blocking(move || store.kv_get(&key))
            .await
            .map_err(AppError::join)??;
        Ok(cached.and_then(|v| serde_json::from_value::<u64>(v).ok()))
    }

    async fn dedup_remember(&self, key: &str, last_sync_id: u64) {
        let store = self.0.deps.store.clone();
        let key = key.to_string();
        let value = serde_json::json!(last_sync_id);
        let _ = tokio::task::spawn_blocking(move || store.kv_set(&key, &value)).await;
    }
}

fn op_to_new_action(op: &MutationOp) -> NewAction {
    match op {
        MutationOp::Create { model, id, data } => NewAction {
            model: model.clone(),
            model_id: id.clone(),
            action: SyncActionCode::I,
            data: Some(data.clone()),
        },
        // `data` holds changed fields only: a partial (`C`) update, not a
        // full replace (`U`, reserved for server-side overwrites).
        MutationOp::Update { model, id, data } => NewAction {
            model: model.clone(),
            model_id: id.clone(),
            action: SyncActionCode::C,
            data: Some(data.clone()),
        },
        MutationOp::Archive { model, id } => NewAction {
            model: model.clone(),
            model_id: id.clone(),
            action: SyncActionCode::A,
            data: None,
        },
        MutationOp::Delete { model, id } => NewAction {
            model: model.clone(),
            model_id: id.clone(),
            action: SyncActionCode::D,
            data: None,
        },
    }
}
