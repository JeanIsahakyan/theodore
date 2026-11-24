//! Sending while a space's agent works (docs/spaces.md §8). A message sent
//! during a turn is stored as a queued `chat_message` and runs as its own
//! turn when the queue drains; "Send now" writes it into the running turn
//! instead, when the agent's CLI takes messages mid-run (Claude Code).
//!
//! ```text
//! send ─▶ running? ── no ──▶ turn now
//!            └─ yes ─▶ queued (seq n) ──▶ turn ends (ok · stopped · failed · restart)
//!                                             └─▶ next queued runs, then the next …
//!                                                   ├─ it can't start ─▶ that one held, the rest go on
//!                                                   └─ usage limit, you decide ─▶ held: "Send" or Cancel
//! ```
//!
//! One drain at a time per space: every drain runs under the space's queue
//! lock, from the end of a turn or from the app's start.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use theodore_contract::{
    ChatMessage, Ephemeral, QueuedAction, QueuedSend, Space, SpaceQueuedRequest, SpaceSendRequest,
    SpaceStatus, ToastLevel, models,
};
use theodore_domain::Author;
use theodore_ports::{NewAction, Steer, SyncActionCode};

use crate::core::Core;
use crate::error::{AppError, AppResult};
use crate::usecases::spaces::space_chat_key;

/// The queue's in-memory side: one lock per space, and the running turns
/// that can take a steered message.
#[derive(Default)]
pub(crate) struct QueueState {
    /// Held while a send decides between "now" and "queued" and while a
    /// turn ends and hands over to the next queued message, so the queue's
    /// order holds against a send that comes in between.
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// By run id: the turn's steer handle while its agent runs, and the
    /// messages steered into it so far.
    steers: Mutex<HashMap<String, Steered>>,
    /// By message id: queued messages another device sent, with what they
    /// were allowed on (`fleet_queue`).
    pub(crate) remote: Mutex<HashMap<String, crate::usecases::fleet_queue::RemoteQueued>>,
}

#[derive(Default)]
struct Steered {
    steer: Option<Steer>,
    messages: Vec<String>,
}

/// How a turn ended, for the queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TurnEnd {
    /// Finished on its own: the next queued message runs.
    Done,
    /// Stopped or failed, for this reason: the next queued message runs
    /// all the same (what you queued still stands; Cancel drops it).
    Interrupted(&'static str),
    /// Cut off by its account's usage limit: the queue waits, unheld,
    /// for what comes next (`space_limits::after_limit`): a turn on another
    /// account, a pause, or held there.
    Limited,
}

impl Core {
    /// The space's queue lock (see [`QueueState::locks`]).
    pub(crate) async fn space_queue_lock(&self, space: &str) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = self
            .0
            .space_queue
            .locks
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(space.to_string())
            .or_default()
            .clone();
        lock.lock_owned().await
    }

    /// Stores `req` as the last queued message of the space. Caller holds
    /// the space's queue lock and has validated the message.
    pub(crate) async fn queue_message(
        &self,
        space: &Space,
        req: &SpaceSendRequest,
        text: String,
        attachments: Vec<theodore_contract::Attachment>,
        mentions: Vec<theodore_contract::SpaceMention>,
        from: Option<theodore_contract::FromSpace>,
    ) -> AppResult<String> {
        let queue = self.queued_messages(&space.id).await?;
        let seq = queue
            .iter()
            .filter_map(|m| m.queued.as_ref())
            .map(|q| q.seq)
            .max()
            .unwrap_or(0)
            + 1;
        let id = uuid::Uuid::new_v4().to_string();
        let message = ChatMessage {
            id: id.clone(),
            pr: space_chat_key(&space.id),
            author: Author::Me,
            text,
            refs: vec![],
            at: self.0.deps.clock.now(),
            failed: None,
            from_tasks: vec![],
            attachments,
            queued: Some(QueuedSend {
                seq,
                agent: req.agent,
                model: req.model.clone(),
                mode: req.mode,
                effort: req.effort.clone(),
                held: false,
            }),
            activity: vec![],
            duration_ms: None,
            changed_files: vec![],
            model: None,
            text_in_steps: false,
            model_resolved: false,
            effort_resolved: false,
            run: None,
            vote: None,
            effort: None,
            mode: None,
            from_space: from,
            notice: None,
            mentions,
        };
        self.apply(vec![NewAction {
            model: models::CHAT_MESSAGE.into(),
            model_id: id.clone(),
            action: SyncActionCode::I,
            data: Some(to_json(&message)?),
        }])
        .await?;
        Ok(id)
    }

    /// The space's queued messages, in queue order.
    pub(crate) async fn queued_messages(&self, space: &str) -> AppResult<Vec<ChatMessage>> {
        let store = self.0.deps.store.clone();
        let key = space_chat_key(space).0;
        let rows =
            tokio::task::spawn_blocking(move || store.query(models::CHAT_MESSAGE, "pr", &key))
                .await
                .map_err(AppError::join)??;
        let mut queue: Vec<ChatMessage> = rows
            .into_iter()
            .filter_map(|r| serde_json::from_value(r.data).ok())
            .filter(|m: &ChatMessage| m.queued.is_some())
            .collect();
        queue.sort_by_key(|m| m.queued.as_ref().map(|q| q.seq));
        Ok(queue)
    }

    /// Send / Cancel / Edit on one queued message.
    pub async fn space_queued(&self, req: SpaceQueuedRequest) -> AppResult<()> {
        // A mirrored space's queue is its host's: this copy only shows it.
        if let Some(r) = self.space_remote_of(&req.space).await {
            return Err(AppError::Invalid(format!(
                "this message waits in the queue on {}: change it there",
                r.host_name
            )));
        }
        let _queue = self.space_queue_lock(&req.space).await;
        let message = self
            .queued_messages(&req.space)
            .await?
            .into_iter()
            .find(|m| m.id == req.message)
            .ok_or_else(|| AppError::NotFound(format!("queued message {}", req.message)))?;
        match req.action {
            QueuedAction::Cancel => {
                let remote = self.fleet_queued_take(&message.id).is_some();
                self.apply(vec![NewAction {
                    model: models::CHAT_MESSAGE.into(),
                    model_id: message.id.clone(),
                    action: SyncActionCode::D,
                    data: None,
                }])
                .await?;
                // Another device's files, for a message that never ran.
                if remote && let Ok(space) = self.space_row(&req.space).await {
                    self.fleet_remove_context_files(&space, &message.attachments)
                        .await;
                }
            }
            QueuedAction::Edit { text } => {
                let text = text.trim().to_string();
                if text.is_empty() && message.attachments.is_empty() {
                    return Err(AppError::Invalid("empty message".into()));
                }
                self.patch_message(&message.id, serde_json::json!({ "text": text }))
                    .await?;
            }
            QueuedAction::Send => {
                let space = self.space_row(&req.space).await?;
                match space.status {
                    SpaceStatus::Archived => {
                        return Err(AppError::Invalid("this space is archived".into()));
                    }
                    // Back in line: it goes when the running turn ends.
                    SpaceStatus::Running => {
                        if let Some(mut queued) = message.queued.clone() {
                            queued.held = false;
                            self.patch_message(
                                &message.id,
                                serde_json::json!({ "queued": queued }),
                            )
                            .await?;
                        }
                    }
                    SpaceStatus::Idle | SpaceStatus::Failed => {
                        self.check_setup_done(&space)?;
                        // Another device's, no longer allowed: dropped,
                        // and the chat says why.
                        if self.fleet_queued_may_run(&space, &message).await {
                            self.start_queued(space, message).await?;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Starts the turn of a queued message, which stops being queued.
    /// Caller holds the space's queue lock; the space isn't running.
    async fn start_queued(&self, space: Space, message: ChatMessage) -> AppResult<String> {
        self.fleet_queued_take(&message.id);
        let queued = message.queued.clone();
        let req = SpaceSendRequest {
            space: space.id.clone(),
            text: message.text.clone(),
            agent: queued.as_ref().and_then(|q| q.agent),
            model: queued.as_ref().and_then(|q| q.model.clone()),
            mode: queued.as_ref().and_then(|q| q.mode),
            attachments: None,
            effort: queued.as_ref().and_then(|q| q.effort.clone()),
            mentions: None,
        };
        let message = ChatMessage {
            // Sent now: it sorts after the turn it waited for.
            at: self.0.deps.clock.now(),
            queued: None,
            activity: vec![],
            duration_ms: None,
            changed_files: vec![],
            model: None,
            text_in_steps: false,
            model_resolved: false,
            effort_resolved: false,
            run: None,
            ..message
        };
        self.start_turn(space, &req, message, true, None).await
    }

    /// [`start_queued`](Self::start_queued) behind a named future type: a
    /// turn's end starts the next turn, whose end starts the next…
    fn start_queued_boxed(
        &self,
        space: Space,
        message: ChatMessage,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<String>> + Send + '_>> {
        Box::pin(self.start_queued(space, message))
    }

    /// A turn ended: its final space patch, then the queue — the next
    /// message runs, whether the turn finished, was stopped or failed.
    /// `park`: the turn's CLI, kept for its background tasks, parked once
    /// its reply is stored. One step under the space's queue lock, so no
    /// send slips in between. Cut off by a usage limit, the queue waits for
    /// what `space_limits::after_limit` decides instead.
    pub(crate) async fn end_turn(
        &self,
        space: &str,
        mut actions: Vec<NewAction>,
        end: TurnEnd,
        park: Option<crate::usecases::space_tasks::LiveCli>,
    ) {
        let _queue = self.space_queue_lock(space).await;
        let now = self.0.deps.clock.now();
        actions.push(NewAction {
            model: models::SPACE.into(),
            model_id: space.to_string(),
            action: SyncActionCode::C,
            data: Some(serde_json::json!({ "attention_at": now, "updated_at": now })),
        });
        let _ = self.apply(actions).await;
        if let Some(live) = park {
            self.park_cli(space, live);
        }
        // Already written by the CLI: it goes before anything queued.
        self.start_follow_up_boxed(space).await;
        match end {
            TurnEnd::Done => self.drain_queue(space).await,
            TurnEnd::Interrupted(reason) => {
                if let Ok(queue) = self.queued_messages(space).await
                    && !queue.is_empty()
                {
                    tracing::info!(
                        space,
                        reason,
                        queued = queue.len(),
                        "the turn didn't finish on its own; the queue goes on"
                    );
                }
                self.drain_queue(space).await;
            }
            TurnEnd::Limited => {}
        }
    }

    /// The steer handle of the running turn `run`, if it has one.
    pub(crate) fn steer_of(&self, run: &str) -> Option<Steer> {
        self.0
            .space_queue
            .steers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(run)
            .and_then(|s| s.steer.clone())
    }

    /// Runs the first waiting message, if the space is free for it. One
    /// from another device no longer allowed is dropped, and one whose turn
    /// can't start is held (you decide about it); either way the next one
    /// is tried. Caller holds the space's queue lock: one drain at a time.
    async fn drain_queue(&self, space_id: &str) {
        let Ok(space) = self.space_row(space_id).await else {
            return;
        };
        if !matches!(space.status, SpaceStatus::Idle | SpaceStatus::Failed) {
            return;
        }
        // A pause for usage limits (`space_limits`) owns what comes next.
        if space.paused.is_some() {
            return;
        }
        if self.check_setup_done(&space).is_err() {
            // Still setting up: the setup's end sends the goal, and the
            // queue goes after that turn.
            return;
        }
        // Tried and left in place (a drop the store refused, a start that
        // failed): never twice in one drain.
        let mut skipped = Vec::new();
        loop {
            let Ok(queue) = self.queued_messages(space_id).await else {
                return;
            };
            let Some(next) = queue
                .into_iter()
                .find(|m| m.queued.as_ref().is_some_and(|q| !q.held))
            else {
                return;
            };
            if skipped.contains(&next.id) {
                return;
            }
            skipped.push(next.id.clone());
            if !self.fleet_queued_may_run(&space, &next).await {
                continue;
            }
            let id = next.id.clone();
            match self.start_queued_boxed(space.clone(), next).await {
                Ok(_) => return,
                Err(e) => {
                    // It can't start (agent gone, worktree trouble): held
                    // for you to send again or drop; the rest go on.
                    tracing::warn!(
                        space = space_id,
                        message = %id,
                        error.code = e.code(),
                        error = %e,
                        "the queued message didn't start"
                    );
                    self.hold_message(space_id, &id, "start_failed").await;
                    self.emit(Ephemeral::Toast {
                        level: ToastLevel::Warn,
                        text: format!("{}: a queued message didn't start: {e}", space.name),
                    });
                }
            }
        }
    }

    /// Every queued message of the space waits for your "Send": a usage
    /// limit left the space without an account to run them on, and you
    /// chose not to continue by itself (`space_limits`).
    pub(crate) async fn hold_queue(&self, space: &str, reason: &str) {
        let Ok(queue) = self.queued_messages(space).await else {
            return;
        };
        let actions: Vec<NewAction> = queue
            .into_iter()
            .filter_map(|m| hold_action(m.id, m.queued?))
            .collect();
        if !actions.is_empty() {
            let messages = actions.len();
            let _ = self.apply(actions).await;
            crate::usecases::telemetry::queue_held(space, reason, messages);
        }
    }

    /// One queued message waits for your "Send": its turn couldn't start.
    async fn hold_message(&self, space: &str, message: &str, reason: &str) {
        let Ok(queue) = self.queued_messages(space).await else {
            return;
        };
        let action = queue
            .into_iter()
            .find(|m| m.id == message)
            .and_then(|m| hold_action(m.id, m.queued?));
        if let Some(action) = action {
            let _ = self.apply(vec![action]).await;
            crate::usecases::telemetry::queue_held(space, reason, 1);
        }
    }

    /// On start: a turn left running by the last process is failed by now
    /// (docs/spaces.md §7 "Crash recovery"), and whatever waited behind it
    /// runs, as after any turn.
    pub(crate) async fn drain_queues_after_restart(&self, spaces: &[Space]) {
        for s in spaces {
            let has_queue = self
                .queued_messages(&s.id)
                .await
                .is_ok_and(|q| q.iter().any(|m| m.queued.as_ref().is_some_and(|x| !x.held)));
            if !has_queue {
                continue;
            }
            tracing::info!(space = %s.id, "queued messages found on start; the queue goes on");
            let _queue = self.space_queue_lock(&s.id).await;
            self.drain_queue(&s.id).await;
        }
    }

    /// "Send now": into the running turn when its agent takes messages
    /// mid-run and the message needs nothing the run can't change (another
    /// agent, model or mode, attachments); otherwise the usual send, so
    /// queued while a turn runs. A mirrored space's is a send to its host,
    /// which queues it behind a running turn (docs/fleet.md "Sends queue").
    pub async fn space_send_now(&self, req: SpaceSendRequest) -> AppResult<String> {
        if let Some(r) = self.space_remote_of(&req.space).await {
            return self.remote_space_send(&r, req).await;
        }
        let queue = self.space_queue_lock(&req.space).await;
        let space = self.space_row(&req.space).await?;
        let text = req.text.trim().to_string();
        let plain = req.attachments.as_ref().is_none_or(|a| a.is_empty())
            && req.mentions.as_ref().is_none_or(|m| m.is_empty())
            && req.agent.is_none_or(|a| a == space.agent)
            && req
                .model
                .as_ref()
                .is_none_or(|m| Some(m) == space.model.as_ref())
            && req.mode.is_none_or(|m| m == space.mode)
            && req
                .effort
                .as_ref()
                .is_none_or(|e| Some(e) == space.effort.as_ref());
        let steer = match (&space.run, space.status) {
            (Some(run), SpaceStatus::Running) if plain && !text.is_empty() => self
                .0
                .space_queue
                .steers
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(run)
                .and_then(|s| s.steer.clone())
                .map(|steer| (run.clone(), steer)),
            _ => None,
        };
        let Some((run, steer)) = steer else {
            drop(queue);
            return self.space_send(req).await;
        };
        let worktree = std::path::PathBuf::from(&space.worktree);
        let claude_home = &self.0.deps.claude_home;
        let ask = crate::usecases::skills::expand_skill(&text, |id| {
            crate::usecases::skills::space_skill_content(id, &worktree, claude_home)
        })
        .unwrap_or_else(|| text.clone());
        let id = uuid::Uuid::new_v4().to_string();
        let at = self.0.deps.clock.now();
        if !steer.send(ask).await {
            // The run ended meanwhile: it waits for the next turn instead.
            drop(queue);
            return self.space_send(req).await;
        }
        if let Some(s) = self
            .0
            .space_queue
            .steers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(&run)
        {
            s.messages.push(id.clone());
        }
        crate::usecases::telemetry::space_action("send_now");
        let message = ChatMessage {
            id: id.clone(),
            pr: space_chat_key(&space.id),
            author: Author::Me,
            text,
            refs: vec![],
            at,
            failed: None,
            from_tasks: vec![],
            attachments: vec![],
            queued: None,
            activity: vec![],
            duration_ms: None,
            changed_files: vec![],
            model: None,
            text_in_steps: false,
            model_resolved: false,
            effort_resolved: false,
            run: None,
            vote: None,
            effort: None,
            mode: None,
            from_space: None,
            notice: None,
            mentions: vec![],
        };
        self.apply(vec![NewAction {
            model: models::CHAT_MESSAGE.into(),
            model_id: id.clone(),
            action: SyncActionCode::I,
            data: Some(to_json(&message)?),
        }])
        .await?;
        Ok(id)
    }

    /// The running agent of `run` takes steered messages through `steer`.
    pub(crate) fn steer_run(&self, run: &str, steer: Option<Steer>) {
        let mut steers = self
            .0
            .space_queue
            .steers
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        steers.entry(run.to_string()).or_default().steer = steer;
    }

    /// The agent of `run` exited: nothing more can be steered into it.
    pub(crate) fn unsteer_run(&self, run: &str) {
        if let Some(s) = self
            .0
            .space_queue
            .steers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(run)
        {
            s.steer = None;
        }
    }

    /// The messages steered into `run`; forgets the run.
    pub(crate) fn take_steered(&self, run: &str) -> Vec<String> {
        self.0
            .space_queue
            .steers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(run)
            .map(|s| s.messages)
            .unwrap_or_default()
    }

    async fn patch_message(&self, id: &str, data: serde_json::Value) -> AppResult<()> {
        self.apply(vec![NewAction {
            model: models::CHAT_MESSAGE.into(),
            model_id: id.to_string(),
            action: SyncActionCode::C,
            data: Some(data),
        }])
        .await?;
        Ok(())
    }
}

/// Queued messages are left out of the transcript a turn replays.
pub(crate) fn is_queued(m: &ChatMessage) -> bool {
    m.queued.is_some()
}

/// The write that holds a queued message, if it isn't held yet.
fn hold_action(id: String, mut q: QueuedSend) -> Option<NewAction> {
    (!q.held).then(|| {
        q.held = true;
        NewAction {
            model: models::CHAT_MESSAGE.into(),
            model_id: id,
            action: SyncActionCode::C,
            data: Some(serde_json::json!({ "queued": q })),
        }
    })
}

fn to_json<T: serde::Serialize>(v: &T) -> AppResult<serde_json::Value> {
    serde_json::to_value(v).map_err(|e| AppError::Invalid(e.to_string()))
}
