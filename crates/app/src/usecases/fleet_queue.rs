//! Fleet, a send while the space works (docs/fleet.md "Sends queue"): a
//! trusted device's `send` (a space hosted for it) or `send_to` (any space
//! here) to a running space waits in that space's queue, the one a local
//! message waits in, and the gate runs once more when it's its turn.
//!
//! ```text
//! send / send_to ─▶ the gate (fleet_host) ─▶ claim ─▶ a person's yes or auto
//!   (mcp, Edit / Run) ─▶ under the space's queue lock:
//!     idle    ─▶ turn now                        ─▶ ok {message}
//!     running ─▶ < REMOTE_QUEUE_MAX from others  ─▶ queued, remembered here
//!                                                ─▶ ok {message, queued, position}
//!             └▶ full                            ─▶ fleet.busy
//! its turn (drain, or Send on a held one) ─▶ accept_remote, same pin,
//!   mode ≤ max_mode, the space's own mode not raised (send_to), mcp:
//!   a person's yes stands, auto must still cover it
//!     ─▶ runs    else ─▶ dropped + a notice row in the chat
//! ```
//!
//! What a queued message came with lives in memory: a restart holds every
//! queue anyway (docs/spaces.md §8), and a held message runs only on a
//! person's Send here.

use serde_json::Value;
use theodore_contract::{ChatMessage, ChatNotice, Space, SpaceSendRequest, SpaceStatus, models};
use theodore_domain::Author;
use theodore_fleet_protocol::{FleetMode, codes};
use theodore_ports::{NewAction, SyncActionCode};

use crate::core::Core;
use crate::usecases::fleet::{fleet_mode, mode_str};
use crate::usecases::fleet_confirm::needs_person;
use crate::usecases::fleet_host::{Refusal, app_refusal};
use crate::usecases::space_limits::notice_text;
use crate::usecases::spaces::space_chat_key;

/// Messages other devices may have waiting in one space's queue.
pub(crate) const REMOTE_QUEUE_MAX: usize = 5;

/// Who queued a message from another device, and on what it was allowed:
/// checked again right before it runs.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RemoteQueued {
    /// The local space it waits in.
    pub space: String,
    pub origin: String,
    /// The pinned key the request verified against.
    pub key: String,
    /// The origin's pinned name, for the notice if it's dropped.
    pub name: String,
    /// The mode it was allowed in (`Claimed::mode`).
    pub mode: Option<FleetMode>,
    /// `send_to`: it runs in the space's own mode, which must not have
    /// gone above `mode` meanwhile.
    pub own_mode: bool,
    /// A person here said yes to it (Claude via cloud, Edit or Run): that
    /// yes stands. Allowed by auto mode instead, auto must still cover it.
    pub person: bool,
}

pub(crate) fn busy() -> Refusal {
    (
        codes::BUSY,
        format!(
            "the space is still working and {REMOTE_QUEUE_MAX} messages from other devices \
             already wait in its queue: wait until it settles, then send"
        ),
    )
}

impl Core {
    /// Messages from other devices waiting in `space`'s queue; forgets
    /// those no longer queued (sent, cancelled, deleted).
    pub(crate) async fn fleet_remote_queued(&self, space: &str) -> usize {
        let queued: Vec<String> = self
            .queued_messages(space)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|m| m.id)
            .collect();
        let mut remote = self
            .0
            .space_queue
            .remote
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        remote.retain(|id, q| q.space != space || queued.contains(id));
        remote.values().filter(|q| q.space == space).count()
    }

    /// Refused before the claim when `space` runs and its queue already
    /// holds [`REMOTE_QUEUE_MAX`] messages from other devices.
    pub(crate) async fn fleet_check_queue(&self, row: &Space) -> Result<(), Refusal> {
        if row.status == SpaceStatus::Running
            && self.fleet_remote_queued(&row.id).await >= REMOTE_QUEUE_MAX
        {
            return Err(busy());
        }
        Ok(())
    }

    /// A claimed send from another device: its turn now, or, while the
    /// space runs, the last place in its queue (`{queued, position}`).
    /// Under the space's queue lock, so a turn can't end in between.
    pub(crate) async fn fleet_send_or_queue(
        &self,
        req: SpaceSendRequest,
        from: RemoteQueued,
    ) -> Result<Value, Refusal> {
        let _queue = self.space_queue_lock(&req.space).await;
        let row = self.space_row(&req.space).await.map_err(app_refusal)?;
        let running = row.status == SpaceStatus::Running;
        if running && self.fleet_remote_queued(&row.id).await >= REMOTE_QUEUE_MAX {
            return Err(busy());
        }
        let id = self.space_send_as(req, None).await.map_err(app_refusal)?;
        if !running {
            return Ok(serde_json::json!({ "message": id }));
        }
        let position = self
            .queued_messages(&row.id)
            .await
            .unwrap_or_default()
            .iter()
            .position(|m| m.id == id)
            .map_or(1, |i| i + 1);
        tracing::info!(
            space = %row.id,
            origin = %from.origin,
            position,
            "queued a message from another device"
        );
        self.0
            .space_queue
            .remote
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id.clone(), from);
        Ok(serde_json::json!({ "message": id, "queued": true, "position": position }))
    }

    /// What `message` came with, if another device queued it; forgotten.
    pub(crate) fn fleet_queued_take(&self, message: &str) -> Option<RemoteQueued> {
        self.0
            .space_queue
            .remote
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(message)
    }

    /// Right before queued `message` runs in `space`: `false` when it came
    /// from another device whose rights no longer cover it, and it was
    /// dropped (a notice row says why). Caller holds the queue lock.
    pub(crate) async fn fleet_queued_may_run(&self, space: &Space, message: &ChatMessage) -> bool {
        let q = self
            .0
            .space_queue
            .remote
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&message.id)
            .cloned();
        let Some(q) = q else {
            return true;
        };
        let Some(why) = self.fleet_queued_refusal(space, &q).await else {
            return true;
        };
        tracing::info!(
            space = %space.id,
            origin = %q.origin,
            reason = %why,
            "dropped a queued message from another device"
        );
        let notice = ChatNotice::RemoteDropped {
            from: q.name.clone(),
            reason: why,
        };
        let now = self.0.deps.clock.now();
        let row = ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            pr: space_chat_key(&space.id),
            author: Author::Agent(space.agent),
            text: notice_text(&notice, now),
            refs: vec![],
            at: now,
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
            notice: Some(notice),
        };
        let applied = self
            .apply(vec![
                NewAction {
                    model: models::CHAT_MESSAGE.into(),
                    model_id: message.id.clone(),
                    action: SyncActionCode::D,
                    data: None,
                },
                NewAction {
                    model: models::CHAT_MESSAGE.into(),
                    model_id: row.id.clone(),
                    action: SyncActionCode::I,
                    data: serde_json::to_value(&row).ok(),
                },
            ])
            .await;
        // Not deleted: it stays refused, so it never runs on a lost drop.
        if applied.is_ok() {
            self.fleet_queued_take(&message.id);
        }
        false
    }

    /// Why `q` may no longer run in `space`, if it may not: the gate's
    /// checks once more, as they stand now.
    async fn fleet_queued_refusal(&self, space: &Space, q: &RemoteQueued) -> Option<String> {
        let s = self.fleet_settings().await;
        if !s.accept_remote {
            return Some("this computer stopped taking remote requests".into());
        }
        let Some(pin) = s
            .trusted_devices
            .iter()
            .find(|t| t.device_id == q.origin && t.public_key == q.key)
        else {
            return Some(format!("{} isn't trusted here any more", q.name));
        };
        let mode = if q.own_mode {
            let own = fleet_mode(space.mode);
            if q.mode.is_some_and(|m| own > m) {
                return Some(format!(
                    "the space is in {} now, above the {} it was sent in",
                    mode_str(own),
                    q.mode.map_or("", mode_str)
                ));
            }
            Some(own)
        } else {
            q.mode
        };
        if let Some(m) = mode
            && m > s.max_mode
        {
            return Some(format!(
                "{} is above what this computer allows now ({})",
                mode_str(m),
                mode_str(s.max_mode)
            ));
        }
        if needs_person(mode)
            && self.fleet_origin_mcp(pin)
            && !q.person
            && !self.fleet_auto_covers(pin, mode)
        {
            return Some(format!(
                "auto mode no longer covers {} for {}",
                mode.map_or("", mode_str),
                q.name
            ));
        }
        None
    }
}
