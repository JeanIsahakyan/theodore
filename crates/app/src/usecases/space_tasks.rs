//! A space's background tasks (docs/spaces.md "Background tasks"): the CLI's
//! tasks, kept visible and stoppable, and the process a space keeps while
//! they run. A process is owned by exactly one of two: the turn streaming it,
//! or a parked watcher here that reads it between turns.
//!
//! ```text
//!              turn streams it                  the space's queue lock
//! spawn ─▶ Running ─result, tasks?─ no ───▶ exits (as ever)
//!             ▲          └ yes ▶ Parked ──▶ Lingering (idle for you) ─ park_cli
//!             │                       │
//!             │  you send, same CLI   ├─ task ends ─▶ FollowUp ─▶ start_follow_up
//!             └──────(same stdin)◀────┤   its own turn when the space is free
//!                                     ├─ last task, no reply expected ─▶ exits
//!                                     └─ cap ─▶ tasks cut ─▶ exits
//! ```

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use theodore_contract::{
    BackgroundTask, BackgroundTaskKind, BackgroundTaskStatus, ChatMessage, Ephemeral, SpaceMode,
    SpaceStatus, ToastLevel, TurnStep, models,
};
use theodore_domain::AgentId;
use theodore_ports::{
    AgentEvent, AgentRun, McpEndpoint, NewAction, Steer, SyncActionCode, TaskEnd, ToolResultDetail,
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::core::Core;
use crate::error::{AppError, AppResult};
use crate::usecases::spaces::space_chat_key;
use crate::usecases::tool_payloads::ToolPayloads;
use crate::usecases::turn_steps::end_summary;

/// How long a kept process gets to exit once it's told to.
const KILL_WAIT: Duration = Duration::from_secs(15);
/// How long a Stop waits for the CLI's answer.
const STOP_TASK_WAIT: Duration = Duration::from_secs(10);
/// Ended rows kept for a while: the list stays bounded.
const ENDED_KEPT: usize = 20;

/// Why a task's row says what it says.
pub(crate) const NOTE_UNDO: &str = "Stopped: Undo moves the worktree back";
pub(crate) const NOTE_ARCHIVE: &str = "Stopped: the space was archived";
pub(crate) const NOTE_NEW_PROCESS: &str = "Stopped: this message needs a new agent process \
     (another agent, model or mode, or an attachment)";
const NOTE_CRASHED: &str = "Its agent process ended before it did: how it ended isn't known";
const NOTE_RESTARTED: &str = "Theodore restarted: how it ended isn't known";
const NOTE_CUT: &str = "Cut off after running for hours with no one watching";

/// What ties a CLI process to the turns it can serve: anything else needs a
/// new process, so its background tasks end with this one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CliKey {
    pub agent: AgentId,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub mode: SpaceMode,
}

/// A running CLI between its owners: stdin open, events still coming.
pub(crate) struct LiveCli {
    pub run: AgentRun,
    pub steer: Steer,
    pub key: CliKey,
    pub mcp: Option<McpEndpoint>,
    pub cwd: PathBuf,
    /// The turn that last ran on it.
    pub last_run: String,
    /// Events a follow-up turn wrote while nobody was attached: replayed
    /// to the turn that picks it up.
    pub buffered: Vec<AgentEvent>,
    pub kill: KillOnDrop,
}

/// Cancels the run when dropped: whichever owner loses it (an error, a
/// failed start), the process doesn't linger unwatched.
pub(crate) struct KillOnDrop(pub CancellationToken);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

/// A parked process, as the rest of the core sees it.
struct Parked {
    generation: u64,
    key: CliKey,
    steer: Steer,
    cancel: CancellationToken,
    /// Asks the watcher to hand the process over.
    take: mpsc::Sender<oneshot::Sender<LiveCli>>,
    /// Set once the watcher is done with it.
    gone: CancellationToken,
    /// A follow-up turn is waiting for the space.
    follow_up: Arc<AtomicBool>,
}

/// The in-memory side of a space's background tasks.
#[derive(Default)]
pub(crate) struct SpaceTasks {
    parked: Mutex<HashMap<String, Parked>>,
    /// Serializes changes to `Space::background_tasks` (read, change,
    /// write): only that array, so a turn's own writes never wait on it.
    writes: tokio::sync::Mutex<()>,
    generation: AtomicU64,
}

impl Core {
    fn parked(&self) -> MutexGuard<'_, HashMap<String, Parked>> {
        self.0
            .space_tasks
            .parked
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    /// Hands a process that outlived its turn to a watcher, until a turn
    /// takes it back or it exits.
    pub(crate) fn park_cli(&self, space: &str, live: LiveCli) {
        let (take, take_rx) = mpsc::channel(1);
        let gone = CancellationToken::new();
        // A follow-up already read and waiting goes on waiting.
        let waiting = live
            .buffered
            .iter()
            .any(|e| matches!(e, AgentEvent::FollowUp));
        let follow_up = Arc::new(AtomicBool::new(waiting));
        let generation = self
            .0
            .space_tasks
            .generation
            .fetch_add(1, Ordering::Relaxed);
        self.parked().insert(
            space.to_string(),
            Parked {
                generation,
                key: live.key.clone(),
                steer: live.steer.clone(),
                cancel: live.run.cancel.clone(),
                take,
                gone: gone.clone(),
                follow_up: follow_up.clone(),
            },
        );
        let core = self.clone();
        let space = space.to_string();
        tokio::spawn(async move {
            watch(core, space, live, take_rx, gone, follow_up, generation).await;
        });
    }

    #[cfg(test)]
    pub(crate) fn has_parked(&self, space: &str) -> bool {
        self.parked().contains_key(space)
    }

    /// Takes the space's parked process back, for a turn to run on.
    async fn take_parked(&self, space: &str) -> Option<LiveCli> {
        let take = self.parked().remove(space)?.take;
        let (reply, answer) = oneshot::channel();
        take.send(reply).await.ok()?;
        answer.await.ok()
    }

    /// The process a new turn runs on, when one is kept and can serve it:
    /// same agent, model and mode, and no attachments (`--add-dir` is per
    /// process). A kept process that can't is ended first, tasks included,
    /// so there is never a second CLI on one session.
    pub(crate) async fn attach_parked(
        &self,
        space: &str,
        key: &CliKey,
        attachments: bool,
    ) -> Option<LiveCli> {
        let compatible = self
            .parked()
            .get(space)
            .map(|p| !attachments && p.key == *key);
        match compatible {
            None => None,
            Some(true) => self.take_parked(space).await,
            Some(false) => {
                self.kill_parked(space, NOTE_NEW_PROCESS).await;
                None
            }
        }
    }

    /// Ends the process kept for `space`, if any, and its tasks with it:
    /// Undo, archive, a turn that needs another process. Waits for it to go.
    pub(crate) async fn kill_parked(&self, space: &str, note: &str) {
        let parked = self
            .parked()
            .get(space)
            .map(|p| (p.cancel.clone(), p.gone.clone()));
        let Some((cancel, gone)) = parked else {
            return;
        };
        let stopped = self
            .end_running_tasks(space, BackgroundTaskStatus::Stopped, note)
            .await;
        if stopped > 0
            && let Ok(row) = self.space_row(space).await
        {
            self.emit(Ephemeral::Toast {
                level: ToastLevel::Warn,
                text: format!("{}: background tasks stopped. {note}.", row.name),
            });
        }
        cancel.cancel();
        let _ = tokio::time::timeout(KILL_WAIT, gone.cancelled()).await;
    }

    /// Quitting: every kept process goes, as a `run` command's does.
    pub(crate) async fn stop_all_parked(&self) {
        let all: Vec<(CancellationToken, CancellationToken)> = self
            .parked()
            .values()
            .map(|p| (p.cancel.clone(), p.gone.clone()))
            .collect();
        for (cancel, _) in &all {
            cancel.cancel();
        }
        let _ = tokio::time::timeout(KILL_WAIT, async {
            for (_, gone) in &all {
                gone.cancelled().await;
            }
        })
        .await;
    }

    /// Stop on one task: writes the CLI's `stop_task` and waits for its
    /// answer. The task's end comes through the stream as usual.
    pub async fn space_stop_task(&self, space: &str, task: &str) -> AppResult<()> {
        let row = self.space_row(space).await?;
        let found = row.background_tasks.iter().find(|t| t.id == task);
        let Some(found) = found else {
            return Err(AppError::NotFound(format!("background task {task}")));
        };
        if found.status != BackgroundTaskStatus::Running {
            return Ok(());
        }
        let steer = self
            .parked()
            .get(space)
            .map(|p| p.steer.clone())
            .or_else(|| row.run.as_deref().and_then(|run| self.steer_of(run)));
        let Some(steer) = steer else {
            return Err(AppError::Invalid(
                "its agent process is gone; it can't be stopped from here".into(),
            ));
        };
        match tokio::time::timeout(STOP_TASK_WAIT, steer.stop_task(task)).await {
            Ok(Ok(())) => {
                crate::usecases::telemetry::space_action("stop_task");
                Ok(())
            }
            Ok(Err(why)) => Err(AppError::Invalid(format!("couldn't stop it: {why}"))),
            Err(_) => Err(AppError::Invalid(
                "the agent didn't answer the stop in time".into(),
            )),
        }
    }

    /// One of the task events from the stream. `in_turn` is the run reading
    /// it, when a turn is: its own calls' ends arrive through the rows it
    /// already keeps (`ToolDetail`), any other call's row is patched here.
    /// `run` is who a task first seen now belongs to.
    pub(crate) async fn note_task_event(
        &self,
        space: &str,
        run: &str,
        in_turn: Option<&str>,
        event: &AgentEvent,
    ) {
        match event {
            AgentEvent::BackgroundTasks { tasks } => {
                let tasks = tasks.clone();
                let now = self.0.deps.clock.now();
                let run = run.to_string();
                self.update_tasks(space, move |rows| sync_set(rows, &tasks, &run, now))
                    .await;
            }
            AgentEvent::TaskStarted {
                id,
                tool_use_id,
                description,
                kind,
                backgrounded,
            } => {
                let (id, tool_use, description, kind, backgrounded) = (
                    id.clone(),
                    tool_use_id.clone(),
                    description.clone(),
                    contract_kind(*kind),
                    *backgrounded,
                );
                let now = self.0.deps.clock.now();
                let run = run.to_string();
                self.update_tasks(space, move |rows| {
                    started(
                        rows,
                        &id,
                        tool_use.as_deref(),
                        &description,
                        kind,
                        backgrounded,
                        &run,
                        now,
                    )
                })
                .await;
            }
            AgentEvent::TaskStatus {
                id,
                status: Some(status),
                ..
            } => {
                let (id, status) = (id.clone(), ended_status(status));
                let now = self.0.deps.clock.now();
                if let Some(status) = status {
                    self.update_tasks(space, move |rows| ended(rows, &id, status, now))
                        .await;
                }
            }
            AgentEvent::TaskEnded {
                id,
                tool_use_id,
                status,
                summary,
                output_file,
            } => {
                let end_status = ended_status(status).unwrap_or(BackgroundTaskStatus::Completed);
                let task_id = id.clone();
                let now = self.0.deps.clock.now();
                let task = self
                    .update_tasks(space, move |rows| ended(rows, &task_id, end_status, now))
                    .await
                    .and_then(|rows| rows.into_iter().find(|t| t.id == *id));
                if let Some(task) = task
                    && let (Some(run), Some(call)) = (
                        task.run.as_deref(),
                        task.call.as_deref().or(tool_use_id.as_deref()),
                    )
                    && Some(run) != in_turn
                {
                    let end = TaskEnd {
                        status: status.clone(),
                        summary: summary.clone(),
                        output_file: output_file.clone(),
                        duration_ms: None,
                    };
                    self.finish_tool_row(space, run, call, task.kind, end).await;
                }
            }
            _ => {}
        }
    }

    /// A process's task ended after the turn that started it: the row keeps
    /// the real output and the end, where a turn in flight would have.
    async fn finish_tool_row(
        &self,
        space: &str,
        run: &str,
        call: &str,
        kind: BackgroundTaskKind,
        end: TaskEnd,
    ) {
        let mut payloads =
            ToolPayloads::for_ended_call(run, space, call, kind == BackgroundTaskKind::Subagent);
        payloads
            .record(
                self,
                &AgentEvent::ToolDetail {
                    id: call.to_string(),
                    detail: ToolResultDetail {
                        end: Some(end.clone()),
                        ..ToolResultDetail::default()
                    },
                },
            )
            .await;
        let store = self.0.deps.store.clone();
        let key = space_chat_key(space).0;
        let Ok(Ok(rows)) =
            tokio::task::spawn_blocking(move || store.query(models::CHAT_MESSAGE, "pr", &key))
                .await
        else {
            return;
        };
        let reply = rows
            .into_iter()
            .filter_map(|r| serde_json::from_value::<ChatMessage>(r.data).ok())
            .find(|m| m.run.as_deref() == Some(run) && has_call(&m.activity, call));
        let Some(mut reply) = reply else {
            return;
        };
        for step in &mut reply.activity {
            if let TurnStep::Tool { id, summary, .. } = step
                && id.as_deref() == Some(call)
            {
                *summary = Some(end_summary(&end));
            }
        }
        let _ = self
            .apply(vec![NewAction {
                model: models::CHAT_MESSAGE.into(),
                model_id: reply.id,
                action: SyncActionCode::C,
                data: Some(serde_json::json!({ "activity": reply.activity })),
            }])
            .await;
    }

    /// Every task still marked running ends here; the count, for a toast.
    pub(crate) async fn end_running_tasks(
        &self,
        space: &str,
        status: BackgroundTaskStatus,
        note: &str,
    ) -> usize {
        let note = note.to_string();
        let now = self.0.deps.clock.now();
        let mut ended_count = 0;
        self.update_tasks(space, |rows| {
            for t in rows
                .iter_mut()
                .filter(|t| t.status == BackgroundTaskStatus::Running)
            {
                t.status = status;
                t.ended_at = Some(now);
                t.note = Some(note.clone());
                ended_count += 1;
            }
            ended_count > 0
        })
        .await;
        ended_count
    }

    /// The process is gone for a reason nobody asked for: the tasks that
    /// were still running on it can't be anything but lost (or cut).
    pub(crate) async fn process_gone(&self, space: &str, capped: bool) -> usize {
        if capped {
            self.end_running_tasks(space, BackgroundTaskStatus::Cut, NOTE_CUT)
                .await
        } else {
            self.end_running_tasks(space, BackgroundTaskStatus::Lost, NOTE_CRASHED)
                .await
        }
    }

    /// A restart: tasks left `running` have no process any more.
    pub(crate) async fn tasks_after_restart(&self, spaces: &[theodore_contract::Space]) {
        for s in spaces {
            if s.background_tasks
                .iter()
                .any(|t| t.status == BackgroundTaskStatus::Running)
            {
                self.end_running_tasks(&s.id, BackgroundTaskStatus::Lost, NOTE_RESTARTED)
                    .await;
            }
        }
    }

    /// The next turn starts: ended rows have been seen.
    pub(crate) async fn prune_ended_tasks(&self, space: &str) {
        self.update_tasks(space, |rows| {
            let before = rows.len();
            rows.retain(|t| t.status == BackgroundTaskStatus::Running);
            rows.len() != before
        })
        .await;
    }

    /// Reads the space's task rows, changes them, writes them (when `f` says
    /// they changed), one at a time; the rows as they stand, or `None` when
    /// the space is gone.
    async fn update_tasks(
        &self,
        space: &str,
        f: impl FnOnce(&mut Vec<BackgroundTask>) -> bool,
    ) -> Option<Vec<BackgroundTask>> {
        let _writes = self.0.space_tasks.writes.lock().await;
        let row = self.space_row(space).await.ok()?;
        let mut rows = row.background_tasks;
        if !f(&mut rows) {
            return Some(rows);
        }
        trim_ended(&mut rows);
        let patch = serde_json::json!({ "background_tasks": &rows });
        let _ = self
            .apply(vec![NewAction {
                model: models::SPACE.into(),
                model_id: space.to_string(),
                action: SyncActionCode::C,
                data: Some(patch),
            }])
            .await;
        Some(rows)
    }

    /// [`start_follow_up`](Self::start_follow_up) behind a named future
    /// type: a turn's end starts the next turn, whose end…
    pub(crate) fn start_follow_up_boxed<'a>(
        &'a self,
        space: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        Box::pin(self.start_follow_up(space))
    }

    /// A follow-up turn, if one is waiting and the space is free. Caller
    /// holds the space's queue lock.
    pub(crate) async fn start_follow_up(&self, space: &str) {
        let pending = self
            .parked()
            .get(space)
            .is_some_and(|p| p.follow_up.load(Ordering::SeqCst));
        if !pending {
            return;
        }
        let Ok(row) = self.space_row(space).await else {
            return;
        };
        if !matches!(row.status, SpaceStatus::Idle | SpaceStatus::Failed) {
            // A turn is finishing (its `check`, say): its end picks this up.
            return;
        }
        let Some(live) = self.take_parked(space).await else {
            return;
        };
        let name = row.name.clone();
        if let Err(e) = self.start_follow_up_turn(row, live).await {
            tracing::warn!(
                space = space,
                error.code = e.code(),
                error = %e,
                "a follow-up turn didn't start"
            );
            self.emit(Ephemeral::Toast {
                level: ToastLevel::Warn,
                text: format!("{name}: the agent's follow-up didn't start: {e}"),
            });
        }
    }

    /// Starts `start_follow_up` from a task, away from the event reader.
    fn spawn_follow_up(&self, space: &str) {
        let core = self.clone();
        let space = space.to_string();
        tokio::spawn(async move {
            let _queue = core.space_queue_lock(&space).await;
            core.start_follow_up(&space).await;
        });
    }
}

fn has_call(activity: &[TurnStep], call: &str) -> bool {
    activity
        .iter()
        .any(|s| matches!(s, TurnStep::Tool { id, .. } if id.as_deref() == Some(call)))
}

/// The set changed: new rows go in, ones gone are ended (their real status
/// may follow, in `TaskEnded`, and replaces it).
fn sync_set(
    rows: &mut Vec<BackgroundTask>,
    tasks: &[theodore_ports::BackgroundTaskInfo],
    run: &str,
    now: i64,
) -> bool {
    let mut changed = false;
    for t in tasks {
        let known = rows.iter().any(|r| r.id == t.id);
        if !known {
            rows.push(new_row(
                &t.id,
                contract_kind(t.kind),
                &t.description,
                run,
                now,
            ));
            changed = true;
        }
    }
    for r in rows.iter_mut() {
        if r.status == BackgroundTaskStatus::Running && !tasks.iter().any(|t| t.id == r.id) {
            r.status = BackgroundTaskStatus::Completed;
            r.ended_at = Some(now);
            changed = true;
        }
    }
    changed
}

fn new_row(
    id: &str,
    kind: BackgroundTaskKind,
    description: &str,
    run: &str,
    now: i64,
) -> BackgroundTask {
    BackgroundTask {
        id: id.to_string(),
        kind,
        description: description.to_string(),
        started_at: now,
        status: BackgroundTaskStatus::Running,
        ended_at: None,
        note: None,
        run: Some(run.to_string()),
        call: None,
    }
}

/// `task_started`: which call the task belongs to (the set may not have
/// named it yet); a foreground one has no row of its own.
#[allow(clippy::too_many_arguments)]
fn started(
    rows: &mut Vec<BackgroundTask>,
    id: &str,
    tool_use: Option<&str>,
    description: &str,
    kind: BackgroundTaskKind,
    backgrounded: bool,
    run: &str,
    now: i64,
) -> bool {
    let row = match rows.iter_mut().find(|t| t.id == id) {
        Some(r) => r,
        None if backgrounded => {
            rows.push(new_row(id, kind, description, run, now));
            rows.last_mut().expect("just pushed")
        }
        None => return false,
    };
    let call = tool_use.map(str::to_string);
    if row.call == call {
        return false;
    }
    row.call = call;
    true
}

/// `task_notification` or a `task_updated` naming an end.
fn ended(rows: &mut [BackgroundTask], id: &str, status: BackgroundTaskStatus, now: i64) -> bool {
    let Some(row) = rows.iter_mut().find(|t| t.id == id) else {
        return false;
    };
    if row.status == status && row.ended_at.is_some() {
        return false;
    }
    row.status = status;
    row.ended_at.get_or_insert(now);
    true
}

/// The status a `task_updated` / `task_notification` reports; `None` when
/// it isn't an end.
fn ended_status(status: &str) -> Option<BackgroundTaskStatus> {
    match status {
        "failed" | "error" => Some(BackgroundTaskStatus::Failed),
        "stopped" | "killed" => Some(BackgroundTaskStatus::Stopped),
        "completed" => Some(BackgroundTaskStatus::Completed),
        _ => None,
    }
}

fn contract_kind(kind: theodore_ports::BackgroundTaskKind) -> BackgroundTaskKind {
    match kind {
        theodore_ports::BackgroundTaskKind::Command => BackgroundTaskKind::Command,
        theodore_ports::BackgroundTaskKind::Subagent => BackgroundTaskKind::Subagent,
    }
}

fn trim_ended(rows: &mut Vec<BackgroundTask>) {
    let ended = rows
        .iter()
        .filter(|t| t.status != BackgroundTaskStatus::Running)
        .count();
    let mut extra = ended.saturating_sub(ENDED_KEPT);
    rows.retain(|t| {
        if extra > 0 && t.status != BackgroundTaskStatus::Running {
            extra -= 1;
            false
        } else {
            true
        }
    });
}

/// Reads a parked process until a turn takes it back or it exits.
async fn watch(
    core: Core,
    space: String,
    mut live: LiveCli,
    mut take_rx: mpsc::Receiver<oneshot::Sender<LiveCli>>,
    gone: CancellationToken,
    follow_up: Arc<AtomicBool>,
    generation: u64,
) {
    let mut capped = false;
    let mut takers = true;
    loop {
        tokio::select! {
            take = take_rx.recv(), if takers => match take {
                Some(reply) => {
                    // Otherwise the taker went away: still ours.
                    match reply.send(live) {
                        Ok(()) => return,
                        Err(back) => live = back,
                    }
                }
                None => takers = false,
            },
            event = live.run.events.recv() => {
                let Some(event) = event else { break };
                core.note_task_event(&space, &live.last_run, None, &event).await;
                match event {
                    AgentEvent::TasksCapped => capped = true,
                    AgentEvent::BackgroundTasks { .. }
                    | AgentEvent::TaskStarted { .. }
                    | AgentEvent::TaskStatus { .. }
                    | AgentEvent::TaskEnded { .. } => {}
                    AgentEvent::FollowUp => {
                        live.buffered.push(event);
                        if !follow_up.swap(true, Ordering::SeqCst) {
                            core.spawn_follow_up(&space);
                        }
                    }
                    other if follow_up.load(Ordering::SeqCst) => live.buffered.push(other),
                    _ => {}
                }
            }
        }
    }
    // The process is gone: tasks can't be running on it.
    let lost = core.process_gone(&space, capped).await;
    if capped {
        tracing::warn!(error.code = "space.tasks_capped", space = %space, tasks = lost, "background tasks cut off");
        if let Ok(row) = core.space_row(&space).await {
            core.emit(Ephemeral::Toast {
                level: ToastLevel::Warn,
                text: format!(
                    "{}: background tasks ran past Theodore's limit and were stopped",
                    row.name
                ),
            });
        }
    }
    if let (Some(tools), Some(mcp)) = (&core.0.deps.tools, &live.mcp) {
        tools.unregister(mcp);
    }
    // A follow-up was already written and waiting for the space: its turn
    // still lands, it just can't take more input.
    if !live.buffered.is_empty() && takers {
        tokio::select! {
            take = take_rx.recv() => {
                if let Some(reply) = take {
                    let _ = reply.send(live);
                    remove_parked(&core, &space, generation);
                    gone.cancel();
                    return;
                }
            }
            _ = live.run.cancel.cancelled() => {}
        }
    }
    remove_parked(&core, &space, generation);
    gone.cancel();
}

fn remove_parked(core: &Core, space: &str, generation: u64) {
    let mut parked = core.parked();
    if parked
        .get(space)
        .is_some_and(|p| p.generation == generation)
    {
        parked.remove(space);
    }
}
