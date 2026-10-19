//! `Core`: the headless app object. Owns the sync log's broadcast, the
//! revision cache, running agents, and the outbox/poller background tasks
//! (plan §2.1, §3).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use theodore_contract::{Ephemeral, SyncFrame, models};
use theodore_domain::{PrId, PrRef, PrSummary, Revision, Sha};
use theodore_ports::{NewAction, StoreResult, SyncAction};
use tokio::sync::{Mutex, Notify, RwLock, broadcast};
use tokio_util::sync::CancellationToken;

use crate::deps::Deps;
use crate::wire::to_wire_action;

/// A cached revision plus what's needed to re-derive it (git paths) without
/// re-fetching from the host.
pub(crate) struct RevisionEntry {
    pub revision: Arc<Revision>,
    pub repo_path: PathBuf,
    pub worktree_path: PathBuf,
    pub pr_ref: PrRef,
}

pub(crate) struct RunHandle {
    pub cancel: CancellationToken,
}

pub(crate) struct Inner {
    pub deps: Deps,
    pub sync_tx: broadcast::Sender<SyncFrame>,
    pub ephemeral_tx: broadcast::Sender<Ephemeral>,
    /// Serializes every `Store::apply` + broadcast so sync frames are
    /// published in the same order sync ids were assigned, with no gaps.
    pub apply_lock: Mutex<()>,
    pub last_broadcast: AtomicU64,
    pub revisions: RwLock<HashMap<(PrId, Sha), Arc<RevisionEntry>>>,
    pub current_head: RwLock<HashMap<PrId, Sha>>,
    pub etags: RwLock<HashMap<PrId, String>>,
    pub runs: RwLock<HashMap<String, RunHandle>>,
    /// Wakes the outbox worker as soon as an item is pushed, so it doesn't
    /// wait for its idle poll (which is paced by `Clock`, not wall time).
    pub outbox_notify: Notify,
    pub shutdown: CancellationToken,
    /// Serializes PR opens so two callers never clone/fetch the same PR twice.
    pub open_lock: tokio::sync::Mutex<()>,
    /// PRs whose grouping is running, so a PR is never grouped twice at once.
    pub grouping_inflight: std::sync::Mutex<std::collections::HashSet<PrId>>,
}

/// Inbound streams the shell (Tauri or the CLI) forwards to the UI.
pub struct Receivers {
    pub sync: broadcast::Receiver<SyncFrame>,
    pub ephemeral: broadcast::Receiver<Ephemeral>,
}

#[derive(Clone)]
pub struct Core(pub(crate) Arc<Inner>);

impl Core {
    /// Starts the core: an initial `last_sync_id` read from the store, and
    /// the outbox + poller background loops.
    pub fn start(deps: Deps) -> (Core, Receivers) {
        let (sync_tx, sync_rx) = broadcast::channel(1024);
        let (ephemeral_tx, ephemeral_rx) = broadcast::channel(1024);
        let last = deps.store.last_sync_id().unwrap_or(0);

        let inner = Arc::new(Inner {
            deps,
            sync_tx,
            ephemeral_tx,
            apply_lock: Mutex::new(()),
            last_broadcast: AtomicU64::new(last),
            revisions: RwLock::new(HashMap::new()),
            current_head: RwLock::new(HashMap::new()),
            etags: RwLock::new(HashMap::new()),
            runs: RwLock::new(HashMap::new()),
            outbox_notify: Notify::new(),
            shutdown: CancellationToken::new(),
            open_lock: tokio::sync::Mutex::new(()),
            grouping_inflight: std::sync::Mutex::new(std::collections::HashSet::new()),
        });

        let core = Core(inner.clone());
        {
            let core = core.clone();
            tokio::spawn(async move { core.fail_interrupted_runs().await });
        }
        tokio::spawn(crate::outbox::run(inner.clone()));
        tokio::spawn(crate::poller::run(inner.clone()));
        {
            let core = core.clone();
            tokio::spawn(async move {
                let _ = core.refresh_inbox().await;
            });
        }
        {
            let core = core.clone();
            tokio::spawn(async move {
                let _ = core.resume_cloning_projects().await;
            });
        }

        (
            core,
            Receivers {
                sync: sync_rx,
                ephemeral: ephemeral_rx,
            },
        )
    }

    /// Stops the background loops. Idempotent.
    /// Runs left `running` by a previous process can never finish: mark them
    /// failed so the UI doesn't show them spinning forever.
    async fn fail_interrupted_runs(&self) {
        use theodore_contract::models;
        let store = self.0.deps.store.clone();
        let Ok(Ok(rows)) = tokio::task::spawn_blocking(move || store.all(models::SKILL_RUN)).await
        else {
            return;
        };
        let actions: Vec<theodore_ports::NewAction> = rows
            .into_iter()
            .filter(|r| r.data.get("status").and_then(|s| s.as_str()) == Some("running"))
            .map(|r| theodore_ports::NewAction {
                model: models::SKILL_RUN.into(),
                model_id: r.id,
                action: theodore_ports::SyncActionCode::C,
                data: Some(serde_json::json!({ "status": "failed", "error": "interrupted: Theodore was closed" })),
            })
            .collect();
        if !actions.is_empty() {
            let _ = self.apply(actions).await;
        }
    }

    pub fn shutdown(&self) {
        self.0.shutdown.cancel();
    }

    pub fn deps(&self) -> &Deps {
        &self.0.deps
    }

    pub fn emit(&self, event: Ephemeral) {
        let _ = self.0.ephemeral_tx.send(event);
    }

    /// Applies a batch through `Store::apply` on `spawn_blocking`, then
    /// broadcasts one contiguous `SyncFrame`. The single `apply_lock` keeps
    /// concurrent writers (transactions, the outbox, the poller, agent
    /// runs) from interleaving sync ids out of order.
    pub(crate) async fn apply(&self, actions: Vec<NewAction>) -> StoreResult<Vec<SyncAction>> {
        if actions.is_empty() {
            return Ok(Vec::new());
        }
        let _guard = self.0.apply_lock.lock().await;
        let store = self.0.deps.store.clone();
        let applied = tokio::task::spawn_blocking(move || store.apply(actions))
            .await
            .map_err(|e| theodore_ports::StoreError::Db(e.to_string()))??;
        self.publish(&applied);
        Ok(applied)
    }

    /// Queues an outbox item and wakes the worker immediately (it would
    /// otherwise only notice on its next, `Clock`-paced idle poll).
    pub(crate) async fn enqueue_outbox(
        &self,
        op: &'static str,
        payload: serde_json::Value,
    ) -> theodore_ports::StoreResult<u64> {
        let store = self.0.deps.store.clone();
        let id = tokio::task::spawn_blocking(move || store.outbox_push(op, payload))
            .await
            .map_err(|e| theodore_ports::StoreError::Db(e.to_string()))??;
        self.0.outbox_notify.notify_one();
        Ok(id)
    }

    /// `apply` plus `enqueue_outbox`, atomically (plan "Fix target" accept
    /// flow): a caller that both changes a model row and enqueues a host
    /// write for it must not land one half without the other.
    pub(crate) async fn apply_with_outbox(
        &self,
        actions: Vec<NewAction>,
        op: &'static str,
        payload: serde_json::Value,
    ) -> theodore_ports::StoreResult<Vec<SyncAction>> {
        let _guard = self.0.apply_lock.lock().await;
        let store = self.0.deps.store.clone();
        let (applied, _outbox_id) =
            tokio::task::spawn_blocking(move || store.apply_with_outbox(actions, op, payload))
                .await
                .map_err(|e| theodore_ports::StoreError::Db(e.to_string()))??;
        self.publish(&applied);
        self.0.outbox_notify.notify_one();
        Ok(applied)
    }

    /// Looks up the host-side `PrRef` for a locally known PR (outbox calls
    /// need it; the UI only ever deals in `PrId`).
    pub(crate) async fn pr_ref(&self, pr: &PrId) -> Option<PrRef> {
        if let Some(entry) = self
            .0
            .revisions
            .read()
            .await
            .values()
            .find(|e| &e.pr_ref.id() == pr)
        {
            return Some(entry.pr_ref.clone());
        }
        let store = self.0.deps.store.clone();
        let id = pr.0.clone();
        let row = tokio::task::spawn_blocking(move || store.get(models::PR, &id))
            .await
            .ok()?
            .ok()??;
        let summary: PrSummary = serde_json::from_value(row.data).ok()?;
        Some(summary.pr)
    }

    /// Writes `pr` + `pr_detail` from an already-fetched `PrDetail` (plan
    /// §3/§6): the one place every path that has a fresh `PrDetail` —
    /// opening a PR, a push, a host-write follow-up refresh — turns it
    /// into sync actions, so the shape can't drift between them.
    pub(crate) async fn apply_pr_detail(
        &self,
        detail: &theodore_domain::PrDetail,
    ) -> crate::error::AppResult<()> {
        let pr_s = detail.summary.pr.id().0.clone();
        let summary_data = serde_json::to_value(&detail.summary)
            .map_err(|e| crate::error::AppError::Invalid(e.to_string()))?;
        let detail_data = serde_json::to_value(detail)
            .map_err(|e| crate::error::AppError::Invalid(e.to_string()))?;
        let actions = vec![
            NewAction {
                model: models::PR.into(),
                model_id: pr_s.clone(),
                action: theodore_ports::SyncActionCode::U,
                data: Some(summary_data),
            },
            NewAction {
                model: models::PR_DETAIL.into(),
                model_id: pr_s,
                action: theodore_ports::SyncActionCode::U,
                data: Some(detail_data),
            },
        ];
        self.apply(actions).await?;
        Ok(())
    }

    /// Conditionally fetches `pr` by its etag and, if the host reports it
    /// modified, applies the fresh `pr_detail` — regardless of whether the
    /// head moved (plan §6.6): comments, threads, checks and labels can all
    /// change without a push, and must not be silently dropped. Returns the
    /// detail so a caller (the poller) can keep using it without fetching
    /// twice.
    pub(crate) async fn refresh_pr(
        &self,
        pr: &PrId,
        pr_ref: &PrRef,
    ) -> Option<theodore_domain::PrDetail> {
        let etag = self.0.etags.read().await.get(pr).cloned();
        let theodore_ports::Fetched::Modified { etag, value } = self
            .0
            .deps
            .host
            .get_pr(pr_ref, etag.as_deref())
            .await
            .ok()?
        else {
            return None;
        };
        if let Some(etag) = etag {
            self.0.etags.write().await.insert(pr.clone(), etag);
        }
        self.apply_pr_detail(&value).await.ok()?;
        Some(value)
    }

    fn publish(&self, actions: &[SyncAction]) {
        if actions.is_empty() {
            return;
        }
        let from = self.0.last_broadcast.load(Ordering::SeqCst);
        let last = actions.last().expect("non-empty").id;
        let frame = SyncFrame {
            from_sync_id: from,
            last_sync_id: last,
            actions: actions.iter().cloned().map(to_wire_action).collect(),
            resync_required: false,
        };
        self.0.last_broadcast.store(last, Ordering::SeqCst);
        let _ = self.0.sync_tx.send(frame);
    }
}
