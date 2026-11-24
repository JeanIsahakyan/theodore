//! Restarting Theodore while turns run (docs/spaces.md §7 "Restart with
//! turns running", docs/releasing.md "Graceful update"): every running
//! turn is paused, not killed, and the next launch resumes it. Also the
//! agent's view of the updater: `theodore_version` and `theodore_update`.
//!
//! ```text
//! restart asked (update · quit · theodore_update)
//!   ─▶ restarting: new turns and the queues wait
//!   ─▶ each running turn: marker on the space ─▶ interrupt the agent (its control
//!      message; SIGTERM without one) ─▶ ≤ PAUSE_WAIT ─▶ not stopped: killed, marked
//!      ─▶ the turn ends "(paused)": checkpoint, reply, session kept
//!   ─▶ kept processes stopped ─▶ the shell restarts
//! next launch ─▶ each marker ─▶ "Theodore restarted (…). Continue where you left off."
//!                               on the same session (--resume) ─▶ marker cleared
//!                               ─▶ its queued messages run after
//! ```

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use theodore_contract::{
    Ephemeral, RestartReason, SpaceRestartPause, SpaceSendRequest, SpaceStatus, ToastLevel, models,
};
use theodore_ports::{
    NO_UPDATER, NewAction, SpaceToolError, SyncActionCode, TheodoreVersion, UpdateStart,
    UpdaterPort,
};

use crate::core::Core;
use crate::error::AppError;

/// How long an interrupted agent gets to end its turn before it is killed.
pub const PAUSE_WAIT: Duration = Duration::from_secs(20);
/// The most `pause_for_restart` waits for every turn to end: the
/// interrupt, then the kill (SIGTERM, 5 s, SIGKILL) of one that ignored it.
pub const PAUSE_BUDGET: Duration = Duration::from_secs(45);
/// What a paused turn's reply says it ended with (`ChatMessage::failed`).
pub const PAUSED_FOR_RESTART: &str = "paused for the restart";
/// Why a kept process's background tasks ended.
pub(crate) const NOTE_RESTART: &str = "Stopped: Theodore restarted";

/// What `pause_for_restart` did.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct RestartPaused {
    /// Turns paused and marked to resume.
    pub paused: usize,
    /// Of those, agents that didn't stop in time and were killed.
    pub killed: usize,
}

/// The message that resumes a paused turn.
pub fn continuation_text(reason: &RestartReason) -> String {
    match reason {
        RestartReason::Update { version } => {
            format!("Theodore restarted (updated to {version}). Continue where you left off.")
        }
        RestartReason::Quit | RestartReason::Restart => {
            "Theodore restarted. Continue where you left off.".to_string()
        }
    }
}

/// Your message's id, from the turn's run id (`space:<id>:<message>`).
fn message_of(space: &str, run: &str) -> String {
    run.strip_prefix(&format!("space:{space}:"))
        .unwrap_or(run)
        .to_string()
}

fn refusal(e: AppError) -> SpaceToolError {
    SpaceToolError::Unavailable(e.user_message())
}

impl Core {
    /// The shell's updater, once it is up (`theodore_version`,
    /// `theodore_update`).
    pub fn set_updater(&self, updater: Arc<dyn UpdaterPort>) {
        *self.0.updater.write().unwrap_or_else(|p| p.into_inner()) = Some(updater);
    }

    fn updater(&self) -> Option<Arc<dyn UpdaterPort>> {
        self.0
            .updater
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// A restart is under way: no turn starts, queued messages wait.
    pub fn restart_pending(&self) -> bool {
        self.0.restarting.load(Ordering::SeqCst)
    }

    /// How long an interrupted agent gets before it is killed; tests
    /// shorten it.
    pub fn set_pause_wait(&self, wait: Duration) {
        self.0
            .pause_wait_ms
            .store(wait.as_millis() as u64, Ordering::SeqCst);
    }

    pub(crate) fn pause_wait(&self) -> Duration {
        Duration::from_millis(self.0.pause_wait_ms.load(Ordering::SeqCst))
    }

    /// Space turns in flight (their `check` included).
    pub async fn running_turns(&self) -> usize {
        self.0
            .runs
            .read()
            .await
            .keys()
            .filter(|k| k.starts_with("space:"))
            .count()
    }

    /// Pauses every running turn for a restart: each is marked on its
    /// space, its agent interrupted at a safe point and given
    /// `pause_wait` to end (killed after, still marked), its edits
    /// checkpointed as the turn ends. Kept processes stop too. Returns once
    /// every turn ended or `PAUSE_BUDGET` passed. From here on no turn
    /// starts in this process.
    pub async fn pause_for_restart(&self, reason: RestartReason) -> RestartPaused {
        self.0.restarting.store(true, Ordering::SeqCst);
        let spaces = self.local_spaces(None).await.unwrap_or_default();
        let now = self.0.deps.clock.now();
        let mut waiting: Vec<String> = Vec::new();
        {
            let handles = self.0.runs.read().await;
            for s in &spaces {
                let Some(run) = &s.run else { continue };
                if s.status != SpaceStatus::Running {
                    continue;
                }
                let Some(handle) = handles.get(run) else {
                    continue;
                };
                let marker = SpaceRestartPause {
                    run: run.clone(),
                    message: message_of(&s.id, run),
                    agent: s.agent,
                    model: s.model.clone(),
                    effort: s.effort.clone(),
                    mode: s.mode,
                    session: s.agent_session.clone(),
                    reason: reason.clone(),
                    at: now,
                    killed: false,
                };
                // Written before the interrupt: a crash in between still
                // resumes it.
                let _ = self
                    .apply(vec![NewAction {
                        model: models::SPACE.into(),
                        model_id: s.id.clone(),
                        action: SyncActionCode::C,
                        data: Some(serde_json::json!({
                            "restart_pause": marker,
                            "updated_at": now,
                        })),
                    }])
                    .await;
                tracing::info!(space = %s.id, run = %run, agent = s.agent.as_str(), "pausing the turn for the restart");
                handle.pause.cancel();
                waiting.push(run.clone());
            }
        }
        let deadline = tokio::time::Instant::now() + PAUSE_BUDGET;
        while !waiting.is_empty() {
            {
                let handles = self.0.runs.read().await;
                waiting.retain(|run| handles.contains_key(run));
            }
            if waiting.is_empty() || tokio::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if !waiting.is_empty() {
            tracing::warn!(
                turns = waiting.len(),
                error.code = "space.pause_timed_out",
                "turns didn't end within the restart budget"
            );
        }
        // Their background tasks can't survive the process; the processes go.
        for s in &spaces {
            if self.has_parked(&s.id) {
                self.kill_parked(&s.id, NOTE_RESTART).await;
            }
        }
        let after = self.local_spaces(None).await.unwrap_or_default();
        let marked: Vec<&SpaceRestartPause> = after
            .iter()
            .filter_map(|s| s.restart_pause.as_ref())
            .collect();
        let report = RestartPaused {
            paused: marked.len(),
            killed: marked.iter().filter(|m| m.killed).count(),
        };
        tracing::info!(
            paused = report.paused,
            killed = report.killed,
            reason = ?reason,
            "paused the running turns for the restart"
        );
        report
    }

    /// On start: every turn paused for the restart goes on, once, on its
    /// agent session, with the continuation message; the marker goes with
    /// the turn's start. Its queued messages run after that turn.
    pub(crate) async fn resume_paused_turns(&self) {
        let Ok(spaces) = self.local_spaces(None).await else {
            return;
        };
        for s in spaces {
            if s.restart_pause.is_none() || s.status == SpaceStatus::Archived {
                continue;
            }
            self.resume_paused_turn(&s.id).await;
        }
    }

    async fn resume_paused_turn(&self, space_id: &str) {
        let _queue = self.space_queue_lock(space_id).await;
        let Ok(space) = self.space_row(space_id).await else {
            return;
        };
        let Some(marker) = space.restart_pause.clone() else {
            return;
        };
        if space.status == SpaceStatus::Running {
            return;
        }
        tracing::info!(
            space = space_id,
            run = %marker.run,
            agent = marker.agent.as_str(),
            killed = marker.killed,
            resumed = space
                .agent_session
                .as_ref()
                .is_some_and(|s| s.agent == marker.agent),
            "resuming the turn paused for the restart"
        );
        let sent = self
            .space_send_as(
                SpaceSendRequest {
                    space: space_id.to_string(),
                    text: continuation_text(&marker.reason),
                    agent: Some(marker.agent),
                    model: marker.model.clone(),
                    mode: Some(marker.mode),
                    attachments: None,
                    effort: marker.effort.clone(),
                    mentions: None,
                },
                None,
            )
            .await;
        if let Err(e) = sent {
            tracing::warn!(
                space = space_id,
                error.code = e.code(),
                error = %e,
                "the paused turn didn't resume"
            );
            self.clear_restart_pause(space_id).await;
            self.hold_queue(space_id, "resume_failed").await;
            self.emit(Ephemeral::Toast {
                level: ToastLevel::Warn,
                text: format!(
                    "{}: the paused turn didn't resume: {e}",
                    space.title.as_deref().unwrap_or(&space.name)
                ),
            });
        }
    }

    pub(crate) async fn clear_restart_pause(&self, space_id: &str) {
        let _ = self
            .apply(vec![NewAction {
                model: models::SPACE.into(),
                model_id: space_id.to_string(),
                action: SyncActionCode::C,
                data: Some(serde_json::json!({
                    "restart_pause": null,
                    "updated_at": self.0.deps.clock.now(),
                })),
            }])
            .await;
    }

    /// `theodore_version`: the running build and the updater's state.
    pub async fn space_tool_theodore_version(
        &self,
        space: &str,
    ) -> Result<TheodoreVersion, SpaceToolError> {
        self.space_row(space).await.map_err(refusal)?;
        match self.updater() {
            Some(u) => Ok(u.version().await),
            None => Ok(theodore_ports::NoUpdater.version().await),
        }
    }

    /// `theodore_update`: restarts into a downloaded update (the turns
    /// pause and resume), starts the download of an available one, or
    /// says Theodore is up to date. Never for a space hosted here for
    /// another device.
    pub async fn space_tool_theodore_update(
        &self,
        space: &str,
        run: &str,
    ) -> Result<UpdateStart, SpaceToolError> {
        let row = self.space_row(space).await.map_err(refusal)?;
        if self.fleet_hosts_local(&row.id).await {
            return Err(SpaceToolError::Unavailable(
                "this space runs here for another device: Theodore is updated from this \
                 computer, not from it"
                    .into(),
            ));
        }
        if row.run.as_deref() != Some(run) {
            return Err(SpaceToolError::Unavailable("this turn is over".into()));
        }
        if self.restart_pending() {
            return Err(SpaceToolError::Unavailable(
                "Theodore is already restarting".into(),
            ));
        }
        let Some(updater) = self.updater() else {
            return Ok(UpdateStart::Unavailable {
                reason: NO_UPDATER.into(),
            });
        };
        let started = updater.update().await;
        tracing::info!(space = %row.id, run, outcome = ?started, "an agent asked to update Theodore");
        Ok(started)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_continuation_names_the_update() {
        assert_eq!(
            continuation_text(&RestartReason::Update {
                version: "0.2.0".into()
            }),
            "Theodore restarted (updated to 0.2.0). Continue where you left off."
        );
        assert_eq!(
            continuation_text(&RestartReason::Quit),
            "Theodore restarted. Continue where you left off."
        );
    }

    #[test]
    fn the_message_id_comes_off_the_run_id() {
        assert_eq!(message_of("s1", "space:s1:m-9"), "m-9");
        assert_eq!(message_of("s1", "odd"), "odd");
    }
}
