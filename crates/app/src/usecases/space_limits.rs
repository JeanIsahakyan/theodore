//! A space turn cut off by its account's usage limit (docs/spaces.md
//! "Usage limits"): another account of the same agent takes over, else a
//! fallback agent (`agents.fallback_agents`), else the space waits for the
//! earliest reset and continues on its own (`agents.auto_continue`).
//!
//! ```text
//! turn ─▶ Limit{limited} + Error ─▶ account marked limited
//!   next account of the agent? ──yes──▶ row "A hit its limit: continuing on B"
//!   │                                   └▶ "Continue from where you stopped…" on B
//!   fallback agent with an account? ─yes─▶ same, on that agent
//!   else ─▶ Space::paused {until: earliest reset}
//!             ├─ until passes ─▶ the continue message (`continue_due_pauses`)
//!             ├─ Continue now ─▶ the same, at once
//!             └─ Cancel ──────▶ paused cleared, queue held
//! ```

use theodore_contract::{
    AgentAccount, ChatMessage, ChatNotice, Space, SpacePause, SpaceSendRequest, SpaceStatus, models,
};
use theodore_domain::{AgentId, Author, Millis};
use theodore_ports::{NewAction, SyncActionCode};

use crate::core::Core;
use crate::error::{AppError, AppResult};
use crate::usecases::agent_accounts::account_label;
use crate::usecases::spaces::space_chat_key;

/// What the automatic message says when a turn goes on elsewhere.
pub const CONTINUE_TEXT: &str =
    "Continue from where you stopped (the previous account hit its usage limit).";

/// How often paused spaces are looked at.
const PAUSE_TICK: std::time::Duration = std::time::Duration::from_secs(30);

/// `at` as the local wall clock: `18:00` today, `Nov 20 18:00` another day.
pub fn reset_time(at: Millis, now: Millis) -> String {
    use chrono::{Local, TimeZone};
    let (Some(at), Some(now)) = (
        Local.timestamp_millis_opt(at).single(),
        Local.timestamp_millis_opt(now).single(),
    ) else {
        return String::new();
    };
    if at.date_naive() == now.date_naive() {
        at.format("%H:%M").to_string()
    } else {
        at.format("%b %-d %H:%M").to_string()
    }
}

/// A notice's words, for anything that shows `text`.
pub fn notice_text(notice: &ChatNotice, now: Millis) -> String {
    let resets = |at: &Option<Millis>| {
        at.map(|at| format!(" (resets {})", reset_time(at, now)))
            .unwrap_or_default()
    };
    match notice {
        ChatNotice::AccountSwitch {
            from,
            to,
            resets_at,
            continued,
        } => {
            let then = if *continued {
                "continuing on"
            } else {
                "the next turn runs on"
            };
            format!("{from} hit its limit{}: {then} {to}", resets(resets_at))
        }
        ChatNotice::LimitHit { account, resets_at } => {
            format!("{account} hit its limit{}", resets(resets_at))
        }
        ChatNotice::RemoteDropped { from, reason } => {
            format!("A message queued from {from} was dropped: {reason}")
        }
    }
}

impl Core {
    /// The turn on `from` stopped at its usage limit (already recorded): go
    /// on elsewhere, or pause. Takes the space's queue lock.
    pub(crate) async fn after_limit(
        &self,
        space_id: &str,
        from: &AgentAccount,
        resets_at: Option<Millis>,
    ) {
        let _queue = self.space_queue_lock(space_id).await;
        let Ok(space) = self.space_row(space_id).await else {
            return;
        };
        if matches!(space.status, SpaceStatus::Running | SpaceStatus::Archived) {
            return;
        }
        let auto = self.auto_continue().await;
        let agent = from.agent;
        let mut next = self
            .pick_account(agent, None, std::slice::from_ref(&from.id))
            .await
            .map(|a| (agent, a));
        let fallbacks = self.fallback_agents(agent).await;
        if next.is_none() {
            for fa in &fallbacks {
                if let Some(a) = self.pick_account(*fa, None, &[]).await {
                    next = Some((*fa, a));
                    break;
                }
            }
        }
        let from_label = account_label(from);
        match next {
            Some((to_agent, to)) => {
                let notice = ChatNotice::AccountSwitch {
                    from: from_label,
                    to: account_label(&to),
                    resets_at,
                    continued: auto,
                };
                self.post_notice(&space, to_agent, notice).await;
                tracing::info!(
                    space = space_id,
                    from = %from.id,
                    to_agent = to_agent.as_str(),
                    to = %to.id,
                    auto,
                    "usage limit: the space goes on on another account"
                );
                if !auto {
                    self.hold_queue(space_id, "limited").await;
                    return;
                }
                if let Err(e) = self.send_continue(&space, to_agent).await {
                    tracing::warn!(space = space_id, error = %e, "the continue didn't start");
                    self.hold_queue(space_id, "start_failed").await;
                }
            }
            None => {
                let notice = ChatNotice::LimitHit {
                    account: from_label,
                    resets_at,
                };
                self.post_notice(&space, agent, notice).await;
                if !auto {
                    self.hold_queue(space_id, "limited").await;
                    return;
                }
                let mut agents = vec![agent];
                agents.extend(fallbacks);
                let until = self.earliest_reset(&agents).await.or(resets_at);
                let pause = SpacePause {
                    until,
                    agent,
                    since: self.0.deps.clock.now(),
                };
                tracing::info!(
                    space = space_id,
                    agent = agent.as_str(),
                    until,
                    "usage limit: every account is limited, the space waits"
                );
                self.set_pause(space_id, Some(pause)).await;
            }
        }
    }

    /// `after_limit` behind a box: it starts a turn, whose end may come
    /// back here.
    pub(crate) fn after_limit_boxed<'a>(
        &'a self,
        space_id: &'a str,
        from: &'a AgentAccount,
        resets_at: Option<Millis>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        Box::pin(self.after_limit(space_id, from, resets_at))
    }

    /// A notice row in the space's chat, as `agent`'s.
    async fn post_notice(&self, space: &Space, agent: AgentId, notice: ChatNotice) {
        let now = self.0.deps.clock.now();
        let msg = ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            pr: space_chat_key(&space.id),
            author: Author::Agent(agent),
            text: notice_text(&notice, now),
            refs: vec![],
            at: now,
            failed: None,
            attachments: vec![],
            queued: None,
            from_tasks: vec![],
            activity: vec![],
            duration_ms: None,
            changed_files: vec![],
            model: None,
            model_resolved: false,
            text_in_steps: false,
            run: None,
            vote: None,
            effort: None,
            effort_resolved: false,
            mode: None,
            from_space: None,
            notice: Some(notice),
            mentions: vec![],
        };
        let Ok(data) = serde_json::to_value(&msg) else {
            return;
        };
        let _ = self
            .apply(vec![NewAction {
                model: models::CHAT_MESSAGE.into(),
                model_id: msg.id,
                action: SyncActionCode::I,
                data: Some(data),
            }])
            .await;
    }

    /// The automatic message that continues the space on `agent` (its
    /// account picked as for any turn). Caller holds the queue lock.
    async fn send_continue(&self, space: &Space, agent: AgentId) -> AppResult<String> {
        self.space_send_as(
            SpaceSendRequest {
                space: space.id.clone(),
                text: CONTINUE_TEXT.to_string(),
                agent: Some(agent),
                model: None,
                mode: None,
                attachments: None,
                effort: None,
                mentions: None,
            },
            None,
        )
        .await
    }

    async fn set_pause(&self, space_id: &str, pause: Option<SpacePause>) {
        let _ = self
            .apply(vec![NewAction {
                model: models::SPACE.into(),
                model_id: space_id.to_string(),
                action: SyncActionCode::C,
                data: Some(serde_json::json!({
                    "paused": pause,
                    "updated_at": self.0.deps.clock.now(),
                })),
            }])
            .await;
    }

    /// "Continue now" on a paused space, or its reset came: the pause ends
    /// and the continue message goes out (on whichever account is free,
    /// else the preferred one all the same).
    pub async fn space_pause_continue(&self, space_id: &str) -> AppResult<()> {
        let _queue = self.space_queue_lock(space_id).await;
        let space = self.space_row(space_id).await?;
        if space.remote.is_some() {
            return Err(AppError::Invalid(
                "this space runs on another device: continue it there".into(),
            ));
        }
        let Some(pause) = space.paused.clone() else {
            return Ok(());
        };
        if space.status == SpaceStatus::Running {
            return Err(AppError::Invalid(
                "the agent is already working in this space".into(),
            ));
        }
        self.set_pause(space_id, None).await;
        let space = self.space_row(space_id).await?;
        if let Err(e) = self.send_continue(&space, pause.agent).await {
            self.hold_queue(space_id, "start_failed").await;
            return Err(e);
        }
        Ok(())
    }

    /// "Cancel" on a paused space: nothing continues on its own; what's
    /// queued waits for you.
    pub async fn space_pause_cancel(&self, space_id: &str) -> AppResult<()> {
        let _queue = self.space_queue_lock(space_id).await;
        let space = self.space_row(space_id).await?;
        if space.paused.is_none() {
            return Ok(());
        }
        self.set_pause(space_id, None).await;
        self.hold_queue(space_id, "limit_cancelled").await;
        Ok(())
    }

    /// Continues every paused space whose reset time has come (by the
    /// core's clock). Returns how many it continued.
    pub(crate) async fn continue_due_pauses(&self) -> usize {
        let now = self.0.deps.clock.now();
        let Ok(spaces) = self.local_spaces(None).await else {
            return 0;
        };
        let due: Vec<String> = spaces
            .into_iter()
            .filter(|s| s.status != SpaceStatus::Archived)
            .filter(|s| {
                s.paused
                    .as_ref()
                    .and_then(|p| p.until)
                    .is_some_and(|until| until <= now)
            })
            .map(|s| s.id)
            .collect();
        let mut n = 0;
        for id in due {
            match self.space_pause_continue(&id).await {
                Ok(()) => n += 1,
                Err(e) => tracing::warn!(space = %id, error = %e, "a paused space didn't continue"),
            }
        }
        n
    }

    /// Looks at paused spaces every `PAUSE_TICK` until shutdown: pauses are
    /// stored on the space, so one set before a restart continues after it.
    pub(crate) async fn run_pause_loop(&self) {
        loop {
            tokio::select! {
                _ = self.0.shutdown.cancelled() => return,
                _ = tokio::time::sleep(PAUSE_TICK) => {}
            }
            self.continue_due_pauses().await;
        }
    }
}
