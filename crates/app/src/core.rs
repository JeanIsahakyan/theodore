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
        });

        let core = Core(inner.clone());
        tokio::spawn(crate::outbox::run(inner.clone()));
        tokio::spawn(crate::poller::run(inner.clone()));

        (
            core,
            Receivers {
                sync: sync_rx,
                ephemeral: ephemeral_rx,
            },
        )
    }

    /// Stops the background loops. Idempotent.
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
        };
        self.0.last_broadcast.store(last, Ordering::SeqCst);
        let _ = self.0.sync_tx.send(frame);
    }
}
