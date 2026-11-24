//! Fleet, any space on this computer (docs/fleet.md "Any space on a
//! computer"): a trusted device lists, reads, asks, messages and answers
//! this computer's spaces and merges their sub-spaces, through the same
//! core functions as a space's own agent (`space_children`); and what a
//! space hosted here for another device may do with its sub-space tools.
//!
//! ```text
//! request (the gate in fleet_host: pin, target_key, fresh, accept_remote)
//!   ─▶ space: a local id, or an rs_ id hosted here for this origin
//!   ─▶ reach: not a mirror, not archived, not hosted for another device
//!   list_spaces / read_space / ask_space ─▶ Ask: read only, any origin
//!   send_to      ─▶ the space's own mode (never changed) ≤ max_mode;
//!                   queued while it runs (fleet_queue), busy when full
//!   answer_space ─▶ the question set waits, the answers fit it
//!   merge_child  ─▶ Edit ≤ max_mode, the parent not running
//!   mode ≥ Edit from an mcp origin ─▶ auto, else a person's yes
//!   ─▶ reply, its value ≤ REPLY_VALUE_MAX_BYTES (oldest items, then the
//!      longest texts, cut first)
//!
//! sub-space tool of a space hosted for device D (or under one)
//!   ─▶ start / send / merge in mode m: accept_remote, D still pinned,
//!      m ≤ max_mode; m ≥ Edit and D is mcp ─▶ auto, else a person's yes
//! ```

use serde_json::Value;
use theodore_contract::{
    FleetConfirm, FleetConfirmAction, Space, SpaceAnswerRequest, SpaceSendRequest, SpaceStatus,
};
use theodore_fleet_protocol::{
    FleetMode, QueuedMessageAction, REPLY_VALUE_MAX_BYTES, RemoteOp, RemoteRequest, codes,
};
use theodore_ports::{SPACE_READ_MESSAGES, SpaceToolError};

use crate::core::Core;
use crate::usecases::fleet::{FleetSettings, fleet_mode, mode_str};
use crate::usecases::fleet_host::{Refusal, answer_items, space_label};
use crate::usecases::fleet_mirror::{floor_boundary, longest_string};
use crate::usecases::fleet_queue::RemoteQueued;
use crate::usecases::space_children::refuse as tool_refuse;

fn refuse(code: &'static str, message: impl Into<String>) -> Refusal {
    (code, message.into())
}

/// A sub-space tool's refusal (`sub_spaces.<code>: <why>`) as a fleet one.
pub(crate) fn tool_refusal(e: SpaceToolError) -> Refusal {
    let text = e.to_string();
    let code = match &e {
        SpaceToolError::NotAllowed(_) => codes::INVALID,
        SpaceToolError::Unavailable(m) => {
            match m
                .strip_prefix("sub_spaces.")
                .and_then(|r| r.split(':').next())
                .unwrap_or("")
            {
                "unknown" | "no_question" => codes::UNKNOWN_SPACE,
                "running" | "busy" | "asks" => codes::BUSY,
                "timeout" => codes::TIMEOUT,
                "denied" => codes::DENIED,
                "failed" | "closing" => codes::INTERNAL,
                _ => codes::INVALID,
            }
        }
    };
    (code, text)
}

/// What a space hosted here for another device asks to do (the prompt's
/// words, when it needs a person's yes).
pub(crate) struct HostedAsk {
    pub action: FleetConfirmAction,
    pub project_name: Option<String>,
    pub space_name: Option<String>,
    pub text: String,
}

/// `v` within [`REPLY_VALUE_MAX_BYTES`] as it sits in the signed reply:
/// the oldest messages go first, then the last spaces or files, then the
/// longest text is halved, with a note.
pub(crate) fn fit_reply(mut v: Value) -> Value {
    let size = |v: &Value| {
        serde_json::to_string(v)
            .ok()
            .and_then(|t| serde_json::to_string(&t).ok())
            .map_or(usize::MAX, |t| t.len())
    };
    let note = "… (cut to fit)";
    while size(&v) > REPLY_VALUE_MAX_BYTES {
        if let Some(Value::Array(a)) = v.get_mut("messages")
            && a.len() > 1
        {
            a.remove(0);
            continue;
        }
        let mut dropped = false;
        for key in ["spaces", "files"] {
            if let Some(Value::Array(a)) = v.get_mut(key)
                && a.len() > 1
            {
                a.pop();
                dropped = true;
                break;
            }
        }
        if dropped {
            if let Some(t) = v.get_mut("truncated") {
                *t = Value::Bool(true);
            }
            continue;
        }
        let mut best = None;
        longest_string(&v, "", &mut best);
        match best {
            Some((at, n)) if n > note.len() + 64 => {
                if let Some(Value::String(s)) = v.pointer_mut(&at) {
                    let base = s.strip_suffix(note).unwrap_or(s);
                    let keep = floor_boundary(base, base.len() / 2);
                    *s = format!("{}{note}", &base[..keep]);
                }
            }
            _ => return serde_json::json!({ "truncated": true }),
        }
    }
    v
}

impl Core {
    /// `id` as a request from `origin` names it: an `rs_` id this device
    /// hosts for `origin` is its local space; anything else is taken as a
    /// local id.
    pub(crate) fn fleet_any_local(&self, origin: &str, id: &str) -> String {
        self.fleet()
            .hosted
            .get(id)
            .filter(|h| h.row.origin_device == origin)
            .map_or_else(|| id.to_string(), |h| h.row.local_space.clone())
    }

    /// The space `id` names for `origin`, if `origin` may reach it: not a
    /// mirror, not archived, not hosted here for another device.
    async fn fleet_reach(&self, origin: &str, id: &str) -> Result<Space, Refusal> {
        let local = self.fleet_any_local(origin, id);
        self.reachable_space(&local, (Some(origin.to_string()), true))
            .await
            .map_err(tool_refusal)
    }

    /// What an op on any space must fit before the claim; the mode it
    /// counts as (`Claimed::mode`).
    pub(crate) async fn fleet_check_any_space(
        &self,
        req: &RemoteRequest,
        s: &FleetSettings,
    ) -> Result<Option<FleetMode>, Refusal> {
        let origin = req.origin_device.as_str();
        let above = |m: FleetMode| {
            refuse(
                codes::MODE_NOT_ALLOWED,
                format!(
                    "{} is above what this device allows ({})",
                    mode_str(m),
                    mode_str(s.max_mode)
                ),
            )
        };
        match &req.op {
            RemoteOp::ListSpaces { .. } => Ok(Some(FleetMode::Ask)),
            RemoteOp::ReadSpace { space, .. } => {
                let local = self.fleet_any_local(origin, space);
                self.space_row(&local)
                    .await
                    .map_err(|_| refuse(codes::UNKNOWN_SPACE, "no such space on this device"))?;
                Ok(Some(FleetMode::Ask))
            }
            RemoteOp::AskSpace { space, question } => {
                self.fleet_reach(origin, space).await?;
                if question.trim().is_empty() {
                    return Err(refuse(codes::INVALID, "the question is empty"));
                }
                Ok(Some(FleetMode::Ask))
            }
            RemoteOp::SendTo { space, message, .. } => {
                let row = self.fleet_reach(origin, space).await?;
                if message.trim().is_empty() {
                    return Err(refuse(codes::INVALID, "empty message"));
                }
                // Protocol 8: the attachments within their bounds.
                req.op
                    .validate_blobs()
                    .map_err(|e| crate::usecases::fleet_files::blob_refusal(&e))?;
                // Queued while it runs, as a send to a hosted space.
                self.fleet_check_queue(&row).await?;
                // Its own mode, never changed: what the cap and the yes
                // are checked against.
                let m = fleet_mode(row.mode);
                if m > s.max_mode {
                    return Err(above(m));
                }
                Ok(Some(m))
            }
            RemoteOp::AnswerSpace {
                space,
                ask,
                answers,
            } => {
                let row = self.fleet_reach(origin, space).await?;
                let questions = self.pending_questions(&row.id, ask).ok_or_else(|| {
                    refuse(codes::UNKNOWN_SPACE, "this question is no longer waiting")
                })?;
                let items = answer_items(&questions, answers.as_slice());
                match crate::usecases::space_questions::invalid_answers(&questions, &items) {
                    Some(why) => Err(refuse(codes::INVALID, why)),
                    None => Ok(None),
                }
            }
            RemoteOp::MergeChild { parent, child } => {
                let p = self.fleet_reach(origin, parent).await?;
                let c = self
                    .space_row(child)
                    .await
                    .map_err(|_| refuse(codes::UNKNOWN_SPACE, "no such space on this device"))?;
                if c.parent.as_ref().map(|x| x.space.as_str()) != Some(p.id.as_str()) {
                    return Err(refuse(
                        codes::INVALID,
                        format!("{child} isn't a sub-space of {parent}"),
                    ));
                }
                // Its worktree takes the change: not under a running turn.
                if p.status == SpaceStatus::Running {
                    return Err(refuse(
                        codes::BUSY,
                        "the parent space is still working: wait until it settles, then merge",
                    ));
                }
                if FleetMode::Edit > s.max_mode {
                    return Err(above(FleetMode::Edit));
                }
                Ok(Some(FleetMode::Edit))
            }
            // Protocol 10 (docs/fleet.md "Sends queue"): the message must
            // still wait in the space's queue. Send counts as the mode the
            // message runs in (its own pick, else the space's); Remove as
            // nothing more than reading the space.
            RemoteOp::QueuedMessage {
                space,
                message,
                action,
            } => {
                let row = self.fleet_reach(origin, space).await?;
                let queued = self
                    .queued_messages(&row.id)
                    .await
                    .ok()
                    .and_then(|q| q.into_iter().find(|m| &m.id == message))
                    .ok_or_else(|| {
                        refuse(
                            codes::UNKNOWN_SPACE,
                            "this message isn't waiting in the space's queue any more",
                        )
                    })?;
                match action {
                    QueuedMessageAction::Cancel => Ok(Some(FleetMode::Ask)),
                    QueuedMessageAction::Send => {
                        let m = fleet_mode(
                            queued
                                .queued
                                .as_ref()
                                .and_then(|q| q.mode)
                                .unwrap_or(row.mode),
                        );
                        if m > s.max_mode {
                            return Err(above(m));
                        }
                        Ok(Some(m))
                    }
                }
            }
            // Protocol 8 (docs/fleet.md "Files (blobs)"): as `read_space`,
            // for a space that has a worktree here.
            RemoteOp::ReadFile { space, .. } => {
                req.op
                    .validate_blobs()
                    .map_err(|e| refuse(codes::INVALID, e.to_string()))?;
                let local = self.fleet_any_local(origin, space);
                let row = self
                    .space_row(&local)
                    .await
                    .map_err(|_| refuse(codes::UNKNOWN_SPACE, "no such space on this device"))?;
                if row.worktree.is_empty() {
                    return Err(refuse(
                        codes::INVALID,
                        "this space has no worktree on this device",
                    ));
                }
                Ok(Some(FleetMode::Ask))
            }
            _ => Err(refuse(codes::INTERNAL, "not an op on any space")),
        }
    }

    /// Runs a claimed op on any space (its mode `mode`, as the gate
    /// resolved it); its result as the reply's value.
    pub(crate) async fn fleet_run_any_space(
        &self,
        req: &RemoteRequest,
        mode: Option<FleetMode>,
        from: RemoteQueued,
    ) -> Result<Value, Refusal> {
        let origin = req.origin_device.as_str();
        let json = |v: Result<Value, serde_json::Error>| {
            v.map_err(|e| refuse(codes::INTERNAL, e.to_string()))
        };
        let value = match req.op.clone() {
            RemoteOp::ListSpaces { project } => {
                let list = self
                    .spaces_list_for(None, project.as_deref(), false)
                    .await
                    .map_err(tool_refusal)?;
                json(serde_json::to_value(list))?
            }
            RemoteOp::ReadSpace { space, messages } => {
                let local = self.fleet_any_local(origin, &space);
                let n = messages.map_or(SPACE_READ_MESSAGES, |n| n as usize);
                let read = self
                    .space_read_for(None, &local, n)
                    .await
                    .map_err(tool_refusal)?;
                json(serde_json::to_value(read))?
            }
            RemoteOp::AskSpace { space, question } => {
                let row = self.fleet_reach(origin, &space).await?;
                let name = self
                    .fleet_pinned(origin)
                    .await
                    .map_or_else(|| "another device".to_string(), |p| p.name);
                let asked = self
                    .ask_space_as(
                        crate::usecases::space_children::AskFrom::Device(name),
                        &format!("device:{origin}"),
                        None,
                        row,
                        &question,
                    )
                    .await
                    .map_err(tool_refusal)?;
                json(serde_json::to_value(asked))?
            }
            RemoteOp::SendTo {
                space,
                message,
                attachments,
            } => {
                let row = self.fleet_reach(origin, &space).await?;
                // Allowed (and maybe said yes to) in the mode it had then.
                if mode.is_some_and(|m| fleet_mode(row.mode) > m) {
                    return Err(refuse(
                        codes::MODE_NOT_ALLOWED,
                        "the space's mode changed since the request was allowed",
                    ));
                }
                // Its files first: none of the turn without all of them.
                let files = self
                    .fleet_receive_attachments(std::path::Path::new(&row.worktree), &attachments)
                    .await?;
                let from = RemoteQueued {
                    space: row.id.clone(),
                    ..from
                };
                self.fleet_send_or_queue(
                    SpaceSendRequest {
                        space: row.id,
                        text: message,
                        agent: None,
                        model: None,
                        // Never changed from another device.
                        mode: None,
                        attachments: None,
                        effort: None,
                        mentions: None,
                    },
                    from,
                    files,
                )
                .await?
            }
            RemoteOp::AnswerSpace {
                space,
                ask,
                answers,
            } => {
                let row = self.fleet_reach(origin, &space).await?;
                let questions = self.pending_questions(&row.id, &ask).unwrap_or_default();
                // First answer wins: answered here meanwhile, it's gone.
                self.answer_space_question(SpaceAnswerRequest {
                    space: row.id,
                    question: ask,
                    answers: answer_items(&questions, &answers),
                })
                .await
                .map_err(|e| refuse(codes::UNKNOWN_SPACE, e.user_message()))?;
                serde_json::json!({})
            }
            RemoteOp::MergeChild { parent, child } => {
                let p = self.fleet_reach(origin, &parent).await?;
                let merged = self
                    .merge_child_into(&p, &child, None)
                    .await
                    .map_err(tool_refusal)?;
                tracing::info!(parent = %p.id, child = %child, origin, "merged a sub-space for another device");
                json(serde_json::to_value(merged))?
            }
            // Protocol 10: as the host's own Send / Cancel on a queued row
            // (`space_queued`): Send runs it now when the space is free,
            // else releases it to the queue; Cancel drops it.
            RemoteOp::QueuedMessage {
                space,
                message,
                action,
            } => {
                let row = self.fleet_reach(origin, &space).await?;
                let action = match action {
                    QueuedMessageAction::Send => theodore_contract::QueuedAction::Send,
                    QueuedMessageAction::Cancel => theodore_contract::QueuedAction::Cancel,
                };
                self.space_queued(theodore_contract::SpaceQueuedRequest {
                    space: row.id.clone(),
                    message: message.clone(),
                    action: action.clone(),
                })
                .await
                .map_err(|e| match e {
                    crate::AppError::NotFound(_) => refuse(
                        codes::UNKNOWN_SPACE,
                        "this message isn't waiting in the space's queue any more",
                    ),
                    other => crate::usecases::fleet_host::app_refusal(other),
                })?;
                tracing::info!(space = %row.id, message = %message, ?action, origin, "a queued message was acted on from another device");
                serde_json::json!({})
            }
            // Protocol 8 (docs/fleet.md "Files (blobs)"): sealed for the key
            // the request verified against (the origin's pin).
            RemoteOp::ReadFile {
                space,
                path,
                max_bytes,
            } => {
                let local = self.fleet_any_local(origin, &space);
                let row = self
                    .space_row(&local)
                    .await
                    .map_err(|_| refuse(codes::UNKNOWN_SPACE, "no such space on this device"))?;
                return self
                    .fleet_read_file(&row, &from.key, &path, max_bytes)
                    .await;
            }
            _ => return Err(refuse(codes::INTERNAL, "not an op on any space")),
        };
        Ok(fit_reply(value))
    }

    /// For a space hosted here for another device (or under one), what
    /// that device's trust allows for an action in `mode`: accepting remote
    /// requests, the device still pinned, `mode` ≤ `max_mode`; an Edit or
    /// Run from Claude via cloud (`mcp`) also needs auto mode or a person's
    /// yes. Nothing to check for this device's own spaces.
    pub(crate) async fn fleet_hosted_gate(
        &self,
        me: &Space,
        mode: FleetMode,
        ask: HostedAsk,
    ) -> Result<(), SpaceToolError> {
        let Some(origin) = self.fleet_hosted_origin(&me.id).await else {
            return Ok(());
        };
        let s = self.fleet_settings().await;
        if !s.accept_remote {
            return Err(tool_refuse(
                "hosted",
                "this space runs here for another device, and this computer takes no remote \
                 requests now",
            ));
        }
        let Some(pin) = s.trusted_devices.iter().find(|t| t.device_id == origin) else {
            return Err(tool_refuse(
                "hosted",
                "this space runs here for another device that isn't trusted here any more",
            ));
        };
        if mode > s.max_mode {
            return Err(tool_refuse(
                "mode",
                format!(
                    "{} is above what this computer allows for other devices ({})",
                    mode_str(mode),
                    mode_str(s.max_mode)
                ),
            ));
        }
        if mode < FleetMode::Edit || !self.fleet_origin_mcp(pin) {
            return Ok(());
        }
        let view = FleetConfirm {
            id: String::new(),
            device_id: String::new(),
            device_name: String::new(),
            action: ask.action,
            mode: crate::usecases::fleet::space_mode(mode),
            project_name: ask.project_name,
            space_name: ask.space_name.or_else(|| Some(space_label(me).to_string())),
            local_space: Some(me.id.clone()),
            text: crate::usecases::fleet_origin::truncate(
                &ask.text,
                theodore_fleet_protocol::CONFIRM_TEXT_MAX,
            ),
            expires_at_ms: 0,
            host_device: None,
            host_name: None,
        };
        self.fleet_confirm_hosted(pin, mode, view)
            .await
            .map_err(|(_, why)| tool_refuse("denied", why))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reply_too_big_loses_its_oldest_messages_then_its_longest_texts() {
        let messages: Vec<Value> = (0..200)
            .map(|i| serde_json::json!({"from": "user", "text": format!("{i} {}", "x".repeat(2000))}))
            .collect();
        let v = fit_reply(serde_json::json!({"note": "n", "messages": messages}));
        let len = serde_json::to_string(&serde_json::to_string(&v).unwrap())
            .unwrap()
            .len();
        assert!(len <= REPLY_VALUE_MAX_BYTES, "{len}");
        let kept = v["messages"].as_array().unwrap();
        assert!(kept.len() < 200);
        assert!(
            kept.last().unwrap()["text"]
                .as_str()
                .unwrap()
                .starts_with("199 ")
        );

        let v = fit_reply(serde_json::json!({"answer": "é".repeat(200_000)}));
        let answer = v["answer"].as_str().unwrap();
        assert!(answer.ends_with("… (cut to fit)"));
        assert!(serde_json::to_string(&v).unwrap().len() <= REPLY_VALUE_MAX_BYTES);

        let spaces: Vec<Value> = (0..2000)
            .map(|i| serde_json::json!({"space": format!("s{i}"), "title": "t".repeat(100)}))
            .collect();
        let v = fit_reply(serde_json::json!({"spaces": spaces, "truncated": false}));
        assert_eq!(v["truncated"], true);
        assert_eq!(v["spaces"][0]["space"], "s0", "the newest stay");
    }

    #[test]
    fn sub_space_refusals_map_to_fleet_codes() {
        let code = |m: &str| tool_refusal(SpaceToolError::Unavailable(m.into())).0;
        assert_eq!(code("sub_spaces.unknown: x"), codes::UNKNOWN_SPACE);
        assert_eq!(code("sub_spaces.running: x"), codes::BUSY);
        assert_eq!(code("sub_spaces.timeout: x"), codes::TIMEOUT);
        assert_eq!(code("sub_spaces.hosted: x"), codes::INVALID);
        assert_eq!(code("sub_spaces.failed: x"), codes::INTERNAL);
    }
}
