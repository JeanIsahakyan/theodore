//! Fleet, a person's yes (docs/fleet.md "Trust"): a device whose key the
//! cloud holds (`DeviceKind::Mcp`, Claude via the cloud) may ask and plan
//! here like any trusted client, but whatever would edit or run waits for
//! someone at this computer.
//!
//! ```text
//! gate: origin pinned as mcp (or listed as mcp now) + start/send in Edit|Run
//!   daemon (nobody here) ─▶ fleet.denied, nothing claimed
//!   else ─▶ claim ─▶ claimed ─▶ FleetConfirm prompt (Allow / Deny)
//!            Allow ─▶ recheck ─▶ run ─▶ reply
//!            Deny | issued_at + REQUEST_WINDOW_MS passes ─▶ reply{fleet.denied}
//! answer (ask reply), stop, Ask, Plan ─▶ no prompt
//! ```
//!
//! Each prompt waits in its own task (the claim's), so it never holds up
//! another request. Pending prompts live in memory only.

use std::time::Duration;

use theodore_contract::{Ephemeral, FleetConfirm, FleetConfirmAction, FleetConfirmAnswer};
use theodore_fleet_protocol::{DeviceKind, FleetMode, REQUEST_WINDOW_MS, RemoteOp, codes};
use tokio::sync::oneshot;

use crate::core::Core;
use crate::error::{AppError, AppResult};
use crate::usecases::fleet::{Claimed, PendingConfirm, TrustedDevice, kind_str, space_mode};
use crate::usecases::fleet_host::{Refusal, space_label};
use crate::usecases::fleet_origin::truncate;
use crate::usecases::space_plan::APPROVED_TEXT;

/// Most characters of the goal or message a prompt shows.
const CONFIRM_TEXT_MAX: usize = 500;

/// Whether `op` edits or runs here: a start or a send in Edit or Run (a
/// send's mode already resolved by the gate). Approving a plan is a send
/// in its build mode, so it counts; answering a question and stopping
/// don't.
pub(crate) fn needs_person(op: &RemoteOp) -> bool {
    let writes = |m: FleetMode| m >= FleetMode::Edit;
    match op {
        RemoteOp::StartSpace { mode, .. } => writes(*mode),
        RemoteOp::Send { mode, .. } => mode.is_some_and(writes),
        RemoteOp::Stop { .. } | RemoteOp::Answer { .. } => false,
    }
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

    /// The gate's word on a verified request that needs a person: a daemon
    /// has nobody to ask, so it's refused before any claim.
    pub(crate) fn fleet_confirm_gate(&self) -> Result<(), Refusal> {
        if self.fleet_kind() == DeviceKind::Daemon {
            return Err(denied(
                "nobody sits at this device to allow an edit or run from Claude via the cloud",
            ));
        }
        Ok(())
    }

    /// Shows the prompt for claimed request `c` and waits for Allow, Deny
    /// or the end of its window (`issued_at + REQUEST_WINDOW_MS`).
    pub(crate) async fn fleet_confirm_wait(&self, c: &Claimed) -> Result<(), Refusal> {
        let deadline = c.req.issued_at_ms.saturating_add(REQUEST_WINDOW_MS);
        let view = self.fleet_confirm_view(c, deadline).await;
        let id = view.id.clone();
        let (tx, rx) = oneshot::channel();
        self.fleet().confirms.insert(
            id.clone(),
            PendingConfirm {
                view: view.clone(),
                tx: Some(tx),
            },
        );
        tracing::info!(req_id = %id, origin = %c.req.origin_device, "a fleet request waits for a person here");
        self.emit(Ephemeral::FleetConfirm { request: view });
        let clock = self.0.deps.clock.clone();
        let left = (deadline as i64).saturating_sub(clock.now()).max(0) as u64;
        let answer = tokio::select! {
            a = rx => a.ok(),
            () = clock.sleep(Duration::from_millis(left)) => None,
            () = self.0.shutdown.cancelled() => None,
        };
        self.fleet().confirms.remove(&id);
        self.emit(Ephemeral::FleetConfirmDone { id: id.clone() });
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
            RemoteOp::Stop { .. } | RemoteOp::Answer { .. } => base,
        }
    }

    /// The person's answer to a waiting request (`fleet_confirm`).
    pub async fn fleet_confirm(&self, req: FleetConfirmAnswer) -> AppResult<()> {
        let tx = self
            .fleet()
            .confirms
            .get_mut(&req.id)
            .and_then(|p| p.tx.take());
        let Some(tx) = tx else {
            return Err(AppError::NotFound(
                "that request isn't waiting any more".into(),
            ));
        };
        tracing::info!(req_id = %req.id, allow = req.allow, "a person answered a fleet request");
        let _ = tx.send(req.allow);
        Ok(())
    }

    /// Requests waiting for a person here, oldest window first.
    pub fn fleet_confirms(&self) -> Vec<FleetConfirm> {
        let mut out: Vec<FleetConfirm> = self
            .fleet()
            .confirms
            .values()
            .filter(|p| p.tx.is_some())
            .map(|p| p.view.clone())
            .collect();
        out.sort_by_key(|v| v.expires_at_ms);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn send(mode: Option<FleetMode>) -> RemoteOp {
        RemoteOp::Send {
            space: "rs_1".into(),
            text: "go".into(),
            mode,
            agent: None,
            model: None,
            effort: None,
        }
    }

    #[test]
    fn only_what_edits_or_runs_needs_a_person() {
        assert!(!needs_person(&send(Some(FleetMode::Ask))));
        assert!(!needs_person(&send(Some(FleetMode::Plan))));
        assert!(needs_person(&send(Some(FleetMode::Edit))));
        assert!(needs_person(&send(Some(FleetMode::Run))));
        assert!(!needs_person(&RemoteOp::Stop {
            space: "rs_1".into()
        }));
        assert!(!needs_person(&RemoteOp::Answer {
            space: "rs_1".into(),
            ask_id: "q".into(),
            answers: vec![],
        }));
    }
}
