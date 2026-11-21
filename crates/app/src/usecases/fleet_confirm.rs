//! Fleet, a person's yes (docs/fleet.md "Trust"): a device whose key the
//! cloud holds (`DeviceKind::Mcp`, Claude via the cloud) may ask and plan
//! here like any trusted client, but whatever would edit or run waits for
//! someone at this computer.
//!
//! ```text
//! gate: origin pinned as mcp (or listed as mcp now) + a request in Edit|Run
//!   (start/send in Edit|Run, send_to a space in Edit|Run, merge_child)
//!   auto mode covers it (fleet_auto) ─▶ claim ─▶ runs, logged "auto"
//!   daemon (nobody here) ─▶ fleet.denied, nothing claimed
//!   else ─▶ claim ─▶ claimed ─▶ FleetConfirm prompt (Allow / Deny)
//!            ├─ to the devices this one delegates to: confirm{RemoteConfirm}
//!            Allow (here, or a delegate's signed confirm op) ─▶ recheck ─▶ run
//!            Deny | issued_at + REQUEST_WINDOW_MS passes ─▶ reply{fleet.denied}
//!            either way ─▶ confirm_resolved (the cloud dismisses it there)
//! answer (ask reply), stop, Ask, Plan, reading and asking spaces ─▶ no prompt
//! a hosted mcp space's sub-space tool in Edit|Run (fleet_confirm_hosted)
//!   ─▶ the same: auto, else this prompt (its own id), a daemon refuses
//!
//! a host's confirm{RemoteConfirm} here (this device is its delegate)
//!   ─▶ host pinned, signature (Domain::Confirm) ─▶ the same prompt, "on <host>"
//!   Allow / Deny ─▶ signed confirm{confirm_id, allow} ─▶ host; first wins
//!   confirm_dismissed ─▶ gone
//! ```
//!
//! Each prompt waits in its own task (the claim's), so it never holds up
//! another request. Pending prompts live in memory only.

use std::time::Duration;

use theodore_contract::{Ephemeral, FleetConfirm, FleetConfirmAction, FleetConfirmAnswer};
use theodore_fleet_protocol::{
    CONFIRM_TEXT_MAX, ClientMessage, ConfirmAction, DeviceKind, Domain, FleetMode,
    REQUEST_WINDOW_MS, RemoteConfirm, RemoteOp, SignedEnvelope, codes,
};
use tokio::sync::oneshot;

use crate::core::Core;
use crate::error::{AppError, AppResult};
use crate::usecases::fleet::{
    Answer, Claimed, PendingConfirm, TrustedDevice, fleet_mode, kind_str, pin_name, space_mode,
};
use crate::usecases::fleet_host::{Refusal, space_label};
use crate::usecases::fleet_origin::{FleetFail, REPLY_WAIT, truncate};
use crate::usecases::space_plan::APPROVED_TEXT;

/// Most prompts from other computers kept here at once.
const REMOTE_CONFIRMS_KEPT: usize = 20;
/// Most characters of a project or space name in a prompt sent elsewhere.
const NAME_MAX: usize = 200;

fn wire_action(a: FleetConfirmAction) -> ConfirmAction {
    match a {
        FleetConfirmAction::Start => ConfirmAction::Start,
        FleetConfirmAction::Send => ConfirmAction::Send,
        FleetConfirmAction::ApprovePlan => ConfirmAction::ApprovePlan,
        FleetConfirmAction::Merge => ConfirmAction::Merge,
    }
}

fn ui_action(a: ConfirmAction) -> FleetConfirmAction {
    match a {
        ConfirmAction::Start => FleetConfirmAction::Start,
        ConfirmAction::Send => FleetConfirmAction::Send,
        ConfirmAction::ApprovePlan => FleetConfirmAction::ApprovePlan,
        ConfirmAction::Merge => FleetConfirmAction::Merge,
    }
}

/// Whether a request in `mode` (`Claimed::mode`, as the gate resolved
/// it) edits or runs here: a start or a send in Edit or Run, a `send_to`
/// to a space in Edit or Run, a `merge_child`. Approving a plan is a send
/// in its build mode, so it counts; reading, asking, answering a question
/// and stopping don't.
pub(crate) fn needs_person(mode: Option<FleetMode>) -> bool {
    mode.is_some_and(|m| m >= FleetMode::Edit)
}

fn denied(why: &str) -> Refusal {
    (codes::DENIED, why.to_string())
}

impl Core {
    /// Whether requests from `pin` are capped as an `mcp` device's: pinned
    /// as one, or listed as one by the cloud now (the stricter of the two:
    /// a listing can add the cap, never lift it).
    pub(crate) fn fleet_origin_mcp(&self, pin: &TrustedDevice) -> bool {
        pin.kind.as_deref() == Some(kind_str(DeviceKind::Mcp))
            || self
                .fleet()
                .devices
                .iter()
                .any(|d| d.device_id == pin.device_id && d.info.kind == DeviceKind::Mcp)
    }

    /// The gate's word on a verified request that needs a person: auto
    /// mode passes it on; else a daemon has nobody to ask, so it's refused
    /// before any claim.
    pub(crate) fn fleet_confirm_gate(
        &self,
        pin: &TrustedDevice,
        mode: Option<FleetMode>,
    ) -> Result<(), Refusal> {
        if self.fleet_auto_covers(pin, mode) {
            return Ok(());
        }
        if self.fleet_kind() == DeviceKind::Daemon {
            return Err(denied(
                "nobody sits at this device to allow an edit or run from Claude via the cloud",
            ));
        }
        Ok(())
    }

    /// After the claim, right before a request that needs a person runs:
    /// auto mode (read again now, from the pin it verified against) lets it
    /// through, logged like an allowed one; else a person's yes, or a
    /// daemon's no. `Ok(true)`: a person said yes (`Ok(false)`: auto).
    pub(crate) async fn fleet_confirm_or_auto(&self, c: &Claimed) -> Result<bool, Refusal> {
        let pin = self
            .fleet_pinned(&c.req.origin_device)
            .await
            .filter(|p| p.public_key == c.key);
        if let Some(pin) = pin
            && self.fleet_auto_covers(&pin, c.mode)
        {
            tracing::info!(
                req_id = %c.req.req_id,
                origin = %c.req.origin_device,
                mode = %self.fleet_auto_note(&pin, c.mode),
                "auto"
            );
            return Ok(false);
        }
        if self.fleet_kind() == DeviceKind::Daemon {
            return Err(denied(
                "nobody sits at this device to allow an edit or run from Claude via the cloud",
            ));
        }
        self.fleet_confirm_wait(c).await.map(|()| true)
    }

    /// Shows the prompt for claimed request `c` and waits for Allow, Deny
    /// or the end of its window (`issued_at + REQUEST_WINDOW_MS`).
    pub(crate) async fn fleet_confirm_wait(&self, c: &Claimed) -> Result<(), Refusal> {
        let deadline = c.req.issued_at_ms.saturating_add(REQUEST_WINDOW_MS);
        let view = self.fleet_confirm_view(c, deadline).await;
        self.fleet_confirm_prompt(view).await
    }

    /// What a space hosted here for an `mcp` device (or a sub-space of
    /// one) asks to do with its sub-space tools, when it edits or runs:
    /// auto mode (read now, from `pin`) lets it through, a daemon refuses
    /// it, else the same prompt as a request's, for `REQUEST_WINDOW_MS`.
    /// `view` names the action; its id, device, deadline are filled here.
    pub(crate) async fn fleet_confirm_hosted(
        &self,
        pin: &TrustedDevice,
        mode: FleetMode,
        view: FleetConfirm,
    ) -> Result<(), Refusal> {
        if self.fleet_auto_covers(pin, Some(mode)) {
            tracing::info!(
                origin = %pin.device_id,
                mode = %self.fleet_auto_note(pin, Some(mode)),
                "auto (sub-space tool)"
            );
            return Ok(());
        }
        if self.fleet_kind() == DeviceKind::Daemon {
            return Err(denied(
                "nobody sits at this device to allow an edit or run from Claude via the cloud",
            ));
        }
        let now = self.0.deps.clock.now().max(0) as u64;
        let view = FleetConfirm {
            id: format!("sub_{}", uuid::Uuid::new_v4().simple()),
            device_id: pin.device_id.clone(),
            device_name: pin.name.clone(),
            expires_at_ms: now.saturating_add(REQUEST_WINDOW_MS),
            ..view
        };
        self.fleet_confirm_prompt(view).await
    }

    /// Shows `view` here and on the delegates, and waits for Allow, Deny
    /// or `view.expires_at_ms`.
    async fn fleet_confirm_prompt(&self, view: FleetConfirm) -> Result<(), Refusal> {
        let deadline = view.expires_at_ms;
        let id = view.id.clone();
        let (tx, rx) = oneshot::channel();
        self.fleet().confirms.insert(
            id.clone(),
            PendingConfirm {
                view: view.clone(),
                tx: Some(tx),
            },
        );
        tracing::info!(req_id = %id, origin = %view.device_id, "a fleet request waits for a person here");
        self.emit(Ephemeral::FleetConfirm {
            request: view.clone(),
        });
        let published = self.fleet_publish_confirm(&view).await;
        let clock = self.0.deps.clock.clone();
        let left = (deadline as i64).saturating_sub(clock.now()).max(0) as u64;
        let answer = tokio::select! {
            a = rx => a.ok(),
            () = clock.sleep(Duration::from_millis(left)) => None,
            () = self.0.shutdown.cancelled() => None,
        };
        self.fleet().confirms.remove(&id);
        self.emit(Ephemeral::FleetConfirmDone { id: id.clone() });
        if published {
            self.fleet_send_msg(ClientMessage::ConfirmResolved {
                confirm_id: id.clone(),
            });
        }
        match answer {
            Some(true) => {
                tracing::info!(req_id = %id, "allowed here");
                Ok(())
            }
            Some(false) => Err(denied("the person at this device said no")),
            None => Err(denied("nobody at this device allowed it in time")),
        }
    }

    async fn fleet_confirm_view(&self, c: &Claimed, deadline: u64) -> FleetConfirm {
        let device_name = self
            .fleet_pinned(&c.req.origin_device)
            .await
            .map_or_else(|| c.req.origin_device.clone(), |p| p.name);
        let base = FleetConfirm {
            id: c.req.req_id.clone(),
            device_id: c.req.origin_device.clone(),
            device_name,
            action: FleetConfirmAction::Start,
            mode: theodore_contract::SpaceMode::Edit,
            project_name: None,
            space_name: None,
            local_space: None,
            text: String::new(),
            expires_at_ms: deadline,
            host_device: None,
            host_name: None,
        };
        match &c.req.op {
            RemoteOp::StartSpace {
                project_id,
                goal,
                mode,
                ..
            } => {
                let project = self
                    .fleet_projects()
                    .await
                    .into_iter()
                    .find(|p| &p.id == project_id)
                    .map_or_else(|| project_id.clone(), |p| p.name);
                FleetConfirm {
                    mode: space_mode(*mode),
                    project_name: Some(project),
                    text: truncate(goal, CONFIRM_TEXT_MAX),
                    ..base
                }
            }
            RemoteOp::Send {
                space, text, mode, ..
            } => {
                let local = self.fleet_hosted_local(space);
                let name = match &local {
                    Some(l) => self
                        .space_row(l)
                        .await
                        .ok()
                        .map(|s| space_label(&s).to_string()),
                    None => None,
                };
                FleetConfirm {
                    action: if text.trim() == APPROVED_TEXT {
                        FleetConfirmAction::ApprovePlan
                    } else {
                        FleetConfirmAction::Send
                    },
                    mode: space_mode(mode.unwrap_or(FleetMode::Edit)),
                    space_name: Some(name.unwrap_or_else(|| space.clone())),
                    local_space: local,
                    text: truncate(text, CONFIRM_TEXT_MAX),
                    ..base
                }
            }
            RemoteOp::SendTo { space, message } => {
                let local = self.fleet_any_local(&c.req.origin_device, space);
                let name = self
                    .space_row(&local)
                    .await
                    .ok()
                    .map(|s| space_label(&s).to_string());
                FleetConfirm {
                    action: FleetConfirmAction::Send,
                    mode: space_mode(c.mode.unwrap_or(FleetMode::Edit)),
                    space_name: Some(name.unwrap_or_else(|| space.clone())),
                    local_space: Some(local),
                    text: truncate(message, CONFIRM_TEXT_MAX),
                    ..base
                }
            }
            RemoteOp::MergeChild { parent, child } => {
                let local = self.fleet_any_local(&c.req.origin_device, parent);
                let label = |s: theodore_contract::Space| space_label(&s).to_string();
                let parent_name = self.space_row(&local).await.ok().map(label);
                let child_name = self.space_row(child).await.ok().map(label);
                FleetConfirm {
                    action: FleetConfirmAction::Merge,
                    mode: theodore_contract::SpaceMode::Edit,
                    space_name: Some(parent_name.unwrap_or_else(|| parent.clone())),
                    local_space: Some(local),
                    text: truncate(
                        &child_name.unwrap_or_else(|| child.clone()),
                        CONFIRM_TEXT_MAX,
                    ),
                    ..base
                }
            }
            _ => base,
        }
    }

    /// Shows a prompt waiting here on the devices this one delegates to
    /// (a phone, the web app, another computer), signed as its host; the
    /// cloud routes it. `true` when it went out.
    async fn fleet_publish_confirm(&self, view: &FleetConfirm) -> bool {
        if self.fleet_settings().await.delegates.is_empty() {
            return false;
        }
        let Some(me) = self.fleet().device_id.clone() else {
            return false;
        };
        let key = match self.fleet_key().await {
            Ok(k) => k,
            Err(e) => {
                tracing::warn!(error.code = e.code(), error = %e, "no fleet device key to sign a prompt");
                return false;
            }
        };
        let body = RemoteConfirm {
            confirm_id: view.id.clone(),
            host_device: me,
            mcp_device: view.device_id.clone(),
            action: wire_action(view.action),
            mode: fleet_mode(view.mode),
            project_name: view.project_name.as_deref().map(|n| truncate(n, NAME_MAX)),
            space_name: view.space_name.as_deref().map(|n| truncate(n, NAME_MAX)),
            text: truncate(&view.text, CONFIRM_TEXT_MAX),
            expires_at_ms: view.expires_at_ms,
        };
        let envelope = SignedEnvelope::seal_as(&body, &key, Domain::Confirm);
        self.fleet_send_msg(ClientMessage::Confirm { envelope })
    }

    /// Whether request `id` waits for a person here (a delegate's answer
    /// counts only then).
    pub(crate) fn fleet_confirm_waiting(&self, id: &str) -> bool {
        self.fleet()
            .confirms
            .get(id)
            .is_some_and(|p| p.tx.is_some())
    }

    /// Allow or Deny of a request waiting here; `by`: where it was said,
    /// for the log. The first answer wins.
    pub(crate) fn fleet_confirm_here(&self, id: &str, allow: bool, by: &str) -> AppResult<()> {
        let tx = self.fleet().confirms.get_mut(id).and_then(|p| p.tx.take());
        let Some(tx) = tx else {
            return Err(AppError::NotFound(
                "that request isn't waiting any more".into(),
            ));
        };
        tracing::info!(req_id = %id, allow, by, "a person answered a fleet request");
        let _ = tx.send(allow);
        Ok(())
    }

    /// The person's answer to a waiting request (`fleet_confirm`): one
    /// waiting here, or one shown here for another computer, signed and
    /// sent there.
    pub async fn fleet_confirm(&self, req: FleetConfirmAnswer) -> AppResult<()> {
        if self.fleet_confirm_waiting(&req.id) {
            return self.fleet_confirm_here(&req.id, req.allow, "here");
        }
        let remote = self.fleet().remote_confirms.get(&req.id).cloned();
        let Some(view) = remote else {
            return Err(AppError::NotFound(
                "that request isn't waiting any more".into(),
            ));
        };
        let host = view.host_device.clone().unwrap_or_default();
        let rx = self
            .fleet_request(
                &host,
                RemoteOp::Confirm {
                    confirm_id: req.id.clone(),
                    allow: req.allow,
                },
                false,
            )
            .await?;
        // Sent: the prompt goes here whatever the host answers.
        self.fleet_drop_remote_confirm(&req.id);
        tracing::info!(req_id = %req.id, host = %host, allow = req.allow, "answered another computer's prompt");
        match Self::fleet_await(rx, REPLY_WAIT).await {
            Ok(_) => Ok(()),
            // Answered there or elsewhere first: nothing to tell.
            Err(FleetFail::Refused(Answer::Err { code, .. })) if code == codes::INVALID => Ok(()),
            Err(e) => Err(e.for_ui()),
        }
    }

    fn fleet_drop_remote_confirm(&self, id: &str) {
        if self.fleet().remote_confirms.remove(id).is_some() {
            self.emit(Ephemeral::FleetConfirmDone { id: id.to_string() });
        }
    }

    /// A host's prompt, shown here as its delegate: only as a computer
    /// pinned here signed it, and only until it runs out.
    pub(crate) async fn fleet_on_remote_confirm(&self, envelope: SignedEnvelope) {
        let Some(host) = self.fleet_pinned(&envelope.device_id).await else {
            tracing::debug!("dropped a prompt from a device not trusted here");
            return;
        };
        if self.fleet_origin_mcp(&host) {
            tracing::debug!("dropped a prompt from Claude via the cloud");
            return;
        }
        let c = match envelope.open_as::<RemoteConfirm>(&host.public_key, Domain::Confirm) {
            Ok(c) => c,
            Err(e) => {
                tracing::debug!(error = %e, "dropped a prompt that doesn't verify");
                return;
            }
        };
        let now = self.0.deps.clock.now().max(0) as u64;
        if c.expires_at_ms <= now {
            return;
        }
        // Who asks: the pin here, else the cloud's listing, cut like a pin.
        let device_name = match self.fleet_pinned(&c.mcp_device).await {
            Some(p) => p.name,
            None => self
                .fleet()
                .devices
                .iter()
                .find(|d| d.device_id == c.mcp_device)
                .map_or_else(|| "Claude".to_string(), |d| pin_name(&d.info.name)),
        };
        let view = FleetConfirm {
            id: c.confirm_id.clone(),
            device_id: c.mcp_device.clone(),
            device_name,
            action: ui_action(c.action),
            mode: space_mode(c.mode),
            project_name: c.project_name.map(|n| truncate(&n, NAME_MAX)),
            space_name: c.space_name.map(|n| truncate(&n, NAME_MAX)),
            local_space: None,
            text: truncate(&c.text, CONFIRM_TEXT_MAX),
            expires_at_ms: c.expires_at_ms,
            host_device: Some(c.host_device.clone()),
            host_name: Some(host.name.clone()),
        };
        {
            let mut mem = self.fleet();
            if mem.remote_confirms.len() >= REMOTE_CONFIRMS_KEPT
                && !mem.remote_confirms.contains_key(&view.id)
            {
                tracing::debug!("dropped a prompt: too many waiting here");
                return;
            }
            mem.remote_confirms.insert(view.id.clone(), view.clone());
        }
        self.emit(Ephemeral::FleetConfirm { request: view });
    }

    /// The cloud's word that a host's prompt isn't waiting any more.
    pub(crate) fn fleet_on_confirm_dismissed(&self, id: &str) {
        self.fleet_drop_remote_confirm(id);
    }

    /// Prompts from other computers, forgotten when the link restarts (the
    /// cloud sends those still waiting again after the welcome).
    pub(crate) fn fleet_clear_remote_confirms(&self) {
        let ids: Vec<String> = self
            .fleet()
            .remote_confirms
            .drain()
            .map(|(k, _)| k)
            .collect();
        for id in ids {
            self.emit(Ephemeral::FleetConfirmDone { id });
        }
    }

    /// Requests waiting for a person here, then those shown here for
    /// another computer, oldest window first.
    pub fn fleet_confirms(&self) -> Vec<FleetConfirm> {
        let now = self.0.deps.clock.now().max(0) as u64;
        let mem = self.fleet();
        let mut out: Vec<FleetConfirm> = mem
            .confirms
            .values()
            .filter(|p| p.tx.is_some())
            .map(|p| p.view.clone())
            .chain(
                mem.remote_confirms
                    .values()
                    .filter(|v| v.expires_at_ms > now)
                    .cloned(),
            )
            .collect();
        out.sort_by_key(|v| v.expires_at_ms);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_what_edits_or_runs_needs_a_person() {
        assert!(!needs_person(Some(FleetMode::Ask)));
        assert!(!needs_person(Some(FleetMode::Plan)));
        assert!(needs_person(Some(FleetMode::Edit)));
        assert!(needs_person(Some(FleetMode::Run)));
        // Stop and answers run in no mode.
        assert!(!needs_person(None));
    }
}
