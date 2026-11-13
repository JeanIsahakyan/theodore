//! Fleet, this device as the target (docs/fleet.md "App side"): the trust
//! gate in front of every request, the spaces it hosts for other devices,
//! and the journal of their events.
//!
//! ```text
//! request ─▶ peek: for this device? ─▶ accept_remote ─▶ origin pinned?
//!   ─▶ open(pinned key) ─▶ target_key is this device's key
//!   ─▶ fresh + not replayed (seen, kept in the store)
//!   ─▶ op fits (mode, project, depth, space, not busy, answers; a start
//!      reserves its slot) ─▶ claim
//!   ─▶ claim_result{claimed} ─▶ seen done kept (else internal, no run)
//!      ─▶ accept_remote, same pin, max_mode again ─▶ run ─▶ reply
//!   every reply ─▶ seal_as(ReplyBody, Domain::Reply)
//!   any refusal ─▶ reply{err:{code}}            not claimed ─▶ nothing runs
//!
//! observer (one task): sync frames + run steps of hosted spaces
//!   ─▶ diff the space row against what was last reported
//!   ─▶ RemoteSpaceEvent, seq+1 ─▶ journal (last 2000)
//!   ─▶ space_event{seal_as(SpaceEventBody, Domain::Event)}
//!   question set / cleared ─▶ also ask{seal_as(RemoteAsk, Domain::Ask)} /
//!   ask_resolved
//! welcome{resume} ─▶ replay the journal after the cloud's seq, re-ask
//! ```
//!
//! The observer only reads: it never takes a space's locks and the space
//! flow never waits on it.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use theodore_contract::{
    ChatMessage, CreateSpaceRequest, Ephemeral, FleetQuestion, FleetQuestionItem, FleetRemoteSpace,
    FleetSpaceStatus, FleetTrustNeeded, Space, SpaceAnswerItem, SpaceAnswerRequest, SpaceMode,
    SpaceQuestionItem, SpaceSendRequest, SpaceStatus, SyncFrame, TurnStep, models,
};
use theodore_domain::{AgentId, Author};
use theodore_fleet_protocol::{
    ClientMessage, DEVICE_JOURNAL, Domain, FleetMode, MAX_CHILDREN, MAX_DEPTH, RemoteAsk, RemoteOp,
    RemoteQuestion, RemoteRequest, RemoteSpaceEvent, RemoteSpaceStatus, ReplyBody, ReplyOutcome,
    SignedEnvelope, SpaceEventBody, StartedSpace, TurnOutcome, codes, fingerprint, fresh,
};
use theodore_ports::{FleetHostedRow, ShipToolAction, SpaceToolError};
use tokio::sync::{broadcast, mpsc};

use crate::core::Core;
use crate::error::AppError;
use crate::usecases::fleet::{
    Claimed, FleetSettings, Hosted, Reserved, Seen, fleet_mode, mode_str, space_mode,
};
use crate::usecases::fleet_origin::{line_of, truncate};
use crate::usecases::spaces::space_chat_key;

/// A refusal: code and words for the origin.
pub(crate) type Refusal = (&'static str, String);

fn refuse(code: &'static str, message: impl Into<String>) -> Refusal {
    (code, message.into())
}

/// What the observer has told the fleet about a hosted space.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct Track {
    /// Last journaled event.
    pub seq: u64,
    pub started: bool,
    /// Turns reported so far.
    pub turn: u32,
    /// The run whose `turn_started` went out and whose end didn't yet.
    pub current: Option<String>,
    /// Runs whose end went out (the last ones; older replies are skipped by
    /// `reply_at`).
    pub ended: Vec<String>,
    /// `at` of the last reply reported.
    pub reply_at: i64,
    /// `Space::turns` at the last look.
    pub turns: u32,
    pub question: Option<String>,
    pub status: Option<RemoteSpaceStatus>,
    pub last_reply: Option<String>,
}

/// `FleetHostedRow::data`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct HostedData {
    pub mode: FleetMode,
    pub project_id: String,
    pub project_name: String,
    pub name: String,
    pub branch: String,
    #[serde(default)]
    pub track: Track,
}

pub(crate) enum ObserverCmd {
    /// A new hosted space: `started`, then whatever already happened.
    Hosted(String),
    /// Connected: replay what the cloud lacks (space → its last seq).
    Replay(BTreeMap<String, u64>),
    /// Look at every hosted space again.
    PassAll,
}

const ENDED_KEPT: usize = 64;

/// What a pass sends besides events, after them.
enum Outgoing {
    Ask(RemoteAsk),
    Resolved(String),
}

pub(crate) fn remote_status(s: &Space) -> RemoteSpaceStatus {
    match s.status {
        SpaceStatus::Archived => RemoteSpaceStatus::Stopped,
        SpaceStatus::Failed => RemoteSpaceStatus::Failed,
        SpaceStatus::Running if s.question.is_some() => RemoteSpaceStatus::Waiting,
        SpaceStatus::Running => RemoteSpaceStatus::Running,
        SpaceStatus::Idle => RemoteSpaceStatus::Idle,
    }
}

pub(crate) fn ui_status(s: RemoteSpaceStatus) -> FleetSpaceStatus {
    match s {
        RemoteSpaceStatus::Running => FleetSpaceStatus::Running,
        RemoteSpaceStatus::Idle => FleetSpaceStatus::Idle,
        RemoteSpaceStatus::Waiting => FleetSpaceStatus::Waiting,
        RemoteSpaceStatus::Stopped => FleetSpaceStatus::Stopped,
        RemoteSpaceStatus::Failed => FleetSpaceStatus::Failed,
    }
}

pub(crate) fn remote_questions(items: &[SpaceQuestionItem]) -> Vec<RemoteQuestion> {
    items
        .iter()
        .map(|q| RemoteQuestion {
            question: q.question.clone(),
            options: q.options.clone(),
            multi: q.multi,
        })
        .collect()
}

pub(crate) fn ui_questions(items: &[RemoteQuestion]) -> Vec<FleetQuestionItem> {
    items
        .iter()
        .map(|q| FleetQuestionItem {
            question: q.question.clone(),
            options: q.options.clone(),
            multi: q.multi,
        })
        .collect()
}

/// The fleet's answers (per question: the options picked, or one free
/// text for "Other") as the question card's.
pub(crate) fn answer_items(
    questions: &[SpaceQuestionItem],
    answers: &[Vec<String>],
) -> Vec<SpaceAnswerItem> {
    answers
        .iter()
        .enumerate()
        .map(|(i, a)| {
            let other =
                a.len() == 1 && questions.get(i).is_some_and(|q| !q.options.contains(&a[0]));
            if other {
                SpaceAnswerItem {
                    selected: vec![],
                    other: Some(a[0].clone()),
                }
            } else {
                SpaceAnswerItem {
                    selected: a.clone(),
                    other: None,
                }
            }
        })
        .collect()
}

fn busy() -> Refusal {
    refuse(
        codes::BUSY,
        "the space is still working: wait until it settles, then send",
    )
}

fn app_refusal(e: AppError) -> Refusal {
    match e {
        AppError::NotFound(m) => refuse(codes::UNKNOWN_SPACE, m),
        AppError::Invalid(m) => refuse(codes::INVALID, m),
        other => refuse(codes::INTERNAL, other.to_string()),
    }
}

/// What the agent of a space hosted here for another device runs against
/// this machine (docs/fleet.md "What a hosted space's agent may do").
#[derive(Debug, Clone, Copy)]
pub(crate) enum HostedTool {
    RunCheck,
    StartApp,
    Ship(ShipToolAction),
}

impl Core {
    /// `Err` with why when `space` is hosted here for another device and
    /// its mode doesn't allow `tool`: `run_check` / `start_app` only in
    /// Run, `ship` only in Edit or Run, and never `merge_locally` (that
    /// writes into the user's own checkout). Any other space: `Ok`.
    pub(crate) async fn fleet_hosted_may(
        &self,
        space: &Space,
        tool: HostedTool,
    ) -> Result<(), SpaceToolError> {
        if !self.fleet_hosts_local(&space.id).await {
            return Ok(());
        }
        let mode = space.mode;
        let why = match tool {
            HostedTool::RunCheck | HostedTool::StartApp if mode != SpaceMode::Run => {
                let name = if matches!(tool, HostedTool::RunCheck) {
                    "run_check"
                } else {
                    "start_app"
                };
                Some(format!(
                    "this space runs here for another device: {name} needs Run mode"
                ))
            }
            HostedTool::Ship(ShipToolAction::MergeLocally) => Some(
                "this space runs here for another device: it can't merge into the local \
                 folder; push or open a PR instead"
                    .to_string(),
            ),
            HostedTool::Ship(_) if !matches!(mode, SpaceMode::Edit | SpaceMode::Run) => Some(
                "this space runs here for another device: ship needs Edit or Run mode".to_string(),
            ),
            _ => None,
        };
        match why {
            Some(why) => Err(SpaceToolError::NotAllowed(why)),
            None => Ok(()),
        }
    }

    /// Sends `outcome` for request `req_id` from `origin`, signed by this
    /// device as its target (`Domain::Reply`): the origin trusts nothing
    /// else.
    async fn fleet_send_reply(&self, req_id: &str, origin: &str, outcome: ReplyOutcome) {
        let Some(me) = self.fleet().device_id.clone() else {
            return;
        };
        let key = match self.fleet_key().await {
            Ok(k) => k,
            Err(e) => {
                tracing::warn!(error.code = e.code(), error = %e, "no fleet key to sign a reply");
                return;
            }
        };
        let body = ReplyBody {
            req_id: req_id.to_string(),
            origin_device: origin.to_string(),
            target_device: me,
            outcome,
        };
        self.fleet_send_msg(ClientMessage::Reply {
            envelope: SignedEnvelope::seal_as(&body, &key, Domain::Reply),
        });
    }

    async fn fleet_refuse(&self, req_id: &str, origin: &str, (code, message): Refusal) {
        tracing::info!(req_id, code, reason = %message, "refused a fleet request");
        let outcome = ReplyOutcome::Err {
            code: code.to_string(),
            message,
        };
        self.fleet_send_reply(req_id, origin, outcome).await;
    }

    fn fleet_hosted_local(&self, remote: &str) -> Option<String> {
        self.fleet()
            .hosted
            .get(remote)
            .map(|h| h.row.local_space.clone())
    }

    /// A request from the cloud: through the gate, then claimed.
    pub(crate) async fn fleet_on_request(&self, envelope: SignedEnvelope) {
        let peeked = match envelope.peek() {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error.code = "fleet.malformed", error = %e, "dropped an unreadable fleet request");
                return;
            }
        };
        match self.fleet_gate(&envelope, &peeked).await {
            Ok(claimed) => {
                let req_id = claimed.req.req_id.clone();
                let generation = {
                    let mut mem = self.fleet();
                    mem.claims.insert(req_id.clone(), claimed);
                    mem.generation
                };
                self.fleet_send_msg(ClientMessage::Claim { req_id, generation });
            }
            Err(refusal) => {
                self.fleet_refuse(&peeked.req_id, &peeked.origin_device, refusal)
                    .await
            }
        }
    }

    /// docs/fleet.md "Trust", in order. `Ok`: verified, fresh, fits (a
    /// send's mode resolved); still to be claimed before anything runs.
    async fn fleet_gate(
        &self,
        envelope: &SignedEnvelope,
        peeked: &RemoteRequest,
    ) -> Result<Claimed, Refusal> {
        let me = self.fleet().device_id.clone();
        if me.as_deref() != Some(peeked.target_device.as_str()) {
            return Err(refuse(
                codes::NOT_YOURS,
                "this request is for another device",
            ));
        }
        let s = self.fleet_settings().await;
        if !s.accept_remote {
            return Err(refuse(
                codes::REMOTE_OFF,
                "this device doesn't take remote requests",
            ));
        }
        let Some(pinned) = s
            .trusted_devices
            .iter()
            .find(|t| t.device_id == envelope.device_id)
        else {
            let listed = self
                .fleet()
                .devices
                .iter()
                .find(|d| d.device_id == envelope.device_id)
                .cloned();
            let name = listed
                .as_ref()
                .map_or_else(|| envelope.device_id.clone(), |d| d.info.name.clone());
            self.emit(Ephemeral::FleetTrustNeeded {
                request: FleetTrustNeeded {
                    device_id: envelope.device_id.clone(),
                    device_name: name,
                    fingerprint: listed
                        .as_ref()
                        .map(|d| fingerprint(&d.public_key))
                        .unwrap_or_default(),
                    public_key: listed
                        .as_ref()
                        .map(|d| d.public_key.clone())
                        .unwrap_or_default(),
                },
            });
            // Its id, not the name the cloud lists: the reply goes back to
            // the origin's agent.
            return Err(refuse(
                codes::UNTRUSTED_DEVICE,
                format!("device {} isn't trusted on this device", envelope.device_id),
            ));
        };
        let mut req = envelope.open(&pinned.public_key).map_err(|_| {
            refuse(
                codes::BAD_SIGNATURE,
                "the request's signature doesn't check out",
            )
        })?;
        // Signed for this machine: the cloud assigns device ids, so only the
        // key the origin pinned for its target says which one.
        let mine = self.fleet_key().await.map(|k| k.public_key()).ok();
        if mine.as_deref() != Some(req.target_key.as_str()) {
            return Err(refuse(
                codes::NOT_YOURS,
                "this request was signed for another device's key",
            ));
        }
        let now = self.0.deps.clock.now().max(0) as u64;
        if !fresh(req.issued_at_ms, now) {
            return Err(refuse(
                codes::STALE_REQUEST,
                "the request is too old, or this device's clock is off",
            ));
        }
        // Seen before, here or before a restart: a re-delivery of a claim
        // still open is claimed again; anything else is a replay.
        self.fleet_load_seen().await;
        let issued_at = req.issued_at_ms as i64;
        if let Some((_, Seen::Done)) = self.fleet().seen.get(&req.req_id) {
            return Err(refuse(
                codes::STALE_REQUEST,
                "this request was seen already",
            ));
        }
        if !self
            .fleet_mark_seen(&req.req_id, issued_at, Seen::Claiming)
            .await
        {
            return Err(refuse(
                codes::INTERNAL,
                "this device couldn't record the request",
            ));
        }
        if let Err(refusal) = self.fleet_check_op(&mut req, &s).await {
            // Refused either way; a store failure only costs the replay
            // memory of a request that ran nothing.
            let _ = self
                .fleet_mark_seen(&req.req_id, issued_at, Seen::Done)
                .await;
            return Err(refusal);
        }
        Ok(Claimed {
            req,
            key: pinned.public_key.clone(),
        })
    }

    /// What the op itself must fit, checked before the claim. A send
    /// without a mode gets the space's (what the cap was checked against).
    async fn fleet_check_op(
        &self,
        req: &mut RemoteRequest,
        s: &FleetSettings,
    ) -> Result<(), Refusal> {
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
        let unknown = || refuse(codes::UNKNOWN_SPACE, "no such space on this device");
        let req_id = req.req_id.clone();
        match &mut req.op {
            RemoteOp::StartSpace {
                space,
                project_id,
                goal,
                mode,
                parent,
                depth,
                ..
            } => {
                if *mode > s.max_mode {
                    return Err(above(*mode));
                }
                if !self
                    .fleet_projects()
                    .await
                    .iter()
                    .any(|p| &p.id == project_id)
                {
                    return Err(refuse(
                        codes::UNKNOWN_PROJECT,
                        format!("no project {project_id} on this device"),
                    ));
                }
                if *depth > MAX_DEPTH {
                    return Err(refuse(
                        codes::DEPTH,
                        format!("spaces nest at most {MAX_DEPTH} deep"),
                    ));
                }
                if goal.trim().is_empty() {
                    return Err(refuse(codes::INVALID, "a remote space needs a goal"));
                }
                // Checked and reserved under one lock: starts that passed
                // the gate count until they end, so concurrent ones can't
                // all pass. A re-delivery of the same request keeps its own
                // slot.
                let mut mem = self.fleet();
                let others = |r: &Reserved| r.req_id != req_id;
                if let Some(p) = parent {
                    let children = mem
                        .hosted
                        .values()
                        .filter(|h| h.row.parent.as_ref() == Some(p))
                        .count()
                        + mem
                            .reserved
                            .values()
                            .filter(|r| others(r) && r.parent.as_ref() == Some(p))
                            .count();
                    if children >= MAX_CHILDREN as usize {
                        return Err(refuse(
                            codes::DEPTH,
                            format!("a space starts at most {MAX_CHILDREN} others"),
                        ));
                    }
                }
                if mem.hosted.contains_key(space)
                    || mem.reserved.get(space.as_str()).is_some_and(others)
                {
                    return Err(refuse(codes::INVALID, "this space was started already"));
                }
                mem.reserved.insert(
                    space.clone(),
                    Reserved {
                        req_id,
                        parent: parent.clone(),
                    },
                );
                Ok(())
            }
            RemoteOp::Send { space, text, mode } => {
                let local = self.fleet_hosted_local(space).ok_or_else(unknown)?;
                if text.trim().is_empty() {
                    return Err(refuse(codes::INVALID, "empty message"));
                }
                let row = self.space_row(&local).await.map_err(app_refusal)?;
                // Never queued behind a running turn: a queued message
                // would run later, past any change to the trust, the key
                // or max_mode made meanwhile.
                if row.status == SpaceStatus::Running {
                    return Err(busy());
                }
                let m = match mode {
                    Some(m) => *m,
                    None => fleet_mode(row.mode),
                };
                if m > s.max_mode {
                    return Err(above(m));
                }
                *mode = Some(m);
                Ok(())
            }
            RemoteOp::Stop { space } => self
                .fleet_hosted_local(space)
                .map(|_| ())
                .ok_or_else(unknown),
            RemoteOp::Answer {
                space,
                ask_id,
                answers,
            } => {
                let local = self.fleet_hosted_local(space).ok_or_else(unknown)?;
                let questions = self.pending_questions(&local, ask_id).ok_or_else(|| {
                    refuse(codes::UNKNOWN_SPACE, "this question is no longer waiting")
                })?;
                let items = answer_items(&questions, answers.as_slice());
                match crate::usecases::space_questions::invalid_answers(&questions, &items) {
                    Some(why) => Err(refuse(codes::INVALID, why)),
                    None => Ok(()),
                }
            }
        }
    }

    /// The cloud's word on a claim: only `claimed` runs anything.
    pub(crate) fn fleet_on_claim(&self, req_id: &str, claimed: bool, rejection: Option<String>) {
        let c = {
            let mut mem = self.fleet();
            if let Some((_, seen)) = mem.seen.get_mut(req_id) {
                *seen = Seen::Done;
            }
            mem.claims.remove(req_id)
        };
        let Some(c) = c else {
            return;
        };
        if !claimed {
            tracing::info!(
                req_id,
                rejection = rejection.as_deref().unwrap_or(""),
                "a fleet claim was rejected; nothing runs"
            );
            self.fleet().release(c.req.op.space(), req_id);
        }
        let core = self.clone();
        tokio::spawn(async move {
            // Done in the store before anything runs: after a restart it's
            // a replay, never a second run. Not kept ─▶ not run.
            let kept = core
                .fleet_mark_seen(&c.req.req_id, c.req.issued_at_ms as i64, Seen::Done)
                .await;
            if !claimed {
                return;
            }
            if !kept {
                core.fleet().release(c.req.op.space(), &c.req.req_id);
                let refusal = refuse(
                    codes::INTERNAL,
                    "this device couldn't record the request, so it didn't run it",
                );
                core.fleet_reply(c.req, Err(refusal)).await;
                return;
            }
            core.fleet_run(c).await;
        });
    }

    /// The gate's settings checks once more, right before a claimed
    /// request runs: still accepting, the origin still pinned with the key
    /// it verified against, the mode still allowed.
    async fn fleet_recheck(&self, c: &Claimed) -> Result<(), Refusal> {
        let s = self.fleet_settings().await;
        if !s.accept_remote {
            return Err(refuse(
                codes::REMOTE_OFF,
                "this device doesn't take remote requests",
            ));
        }
        if !s
            .trusted_devices
            .iter()
            .any(|t| t.device_id == c.req.origin_device && t.public_key == c.key)
        {
            return Err(refuse(
                codes::UNTRUSTED_DEVICE,
                "the requesting device isn't trusted on this device any more",
            ));
        }
        let mode = match &c.req.op {
            RemoteOp::StartSpace { mode, .. } => Some(*mode),
            RemoteOp::Send { mode, .. } => *mode,
            RemoteOp::Stop { .. } | RemoteOp::Answer { .. } => None,
        };
        if let Some(m) = mode
            && m > s.max_mode
        {
            return Err(refuse(
                codes::MODE_NOT_ALLOWED,
                format!(
                    "{} is above what this device allows ({})",
                    mode_str(m),
                    mode_str(s.max_mode)
                ),
            ));
        }
        Ok(())
    }

    /// Runs a claimed request and replies.
    async fn fleet_run(&self, c: Claimed) {
        let checked = self.fleet_recheck(&c).await;
        let req = c.req;
        let outcome = match checked {
            Err(refusal) => Err(refusal),
            Ok(()) => self.fleet_run_op(&req).await,
        };
        // A start's slot goes either way: hosted now, or not at all.
        self.fleet().release(req.op.space(), &req.req_id);
        self.fleet_reply(req, outcome).await;
    }

    /// A send to hosted space `local`: only while it isn't running, checked
    /// under the space's queue lock so it can't start running in between
    /// and the message wait in its queue (docs/fleet.md "Sends never
    /// queue").
    async fn fleet_host_send(
        &self,
        local: String,
        text: String,
        mode: Option<FleetMode>,
    ) -> Result<serde_json::Value, Refusal> {
        let _queue = self.space_queue_lock(&local).await;
        let row = self.space_row(&local).await.map_err(app_refusal)?;
        if row.status == SpaceStatus::Running {
            return Err(busy());
        }
        self.space_send_as(
            SpaceSendRequest {
                space: local,
                text,
                agent: None,
                model: None,
                mode: mode.map(space_mode),
                attachments: None,
                effort: None,
            },
            None,
        )
        .await
        .map(|id| serde_json::json!({ "message": id }))
        .map_err(app_refusal)
    }

    async fn fleet_run_op(&self, req: &RemoteRequest) -> Result<serde_json::Value, Refusal> {
        match req.op.clone() {
            RemoteOp::StartSpace { .. } => self.fleet_host_start(req).await,
            RemoteOp::Send { space, text, mode } => match self.fleet_hosted_local(&space) {
                Some(local) => self.fleet_host_send(local, text, mode).await,
                None => Err(refuse(codes::UNKNOWN_SPACE, "no such space on this device")),
            },
            RemoteOp::Stop { space } => match self.fleet_hosted_local(&space) {
                Some(local) => self
                    .space_stop(&local)
                    .await
                    .map(|()| serde_json::json!({}))
                    .map_err(app_refusal),
                None => Err(refuse(codes::UNKNOWN_SPACE, "no such space on this device")),
            },
            RemoteOp::Answer {
                space,
                ask_id,
                answers,
            } => match self.fleet_hosted_local(&space) {
                Some(local) => {
                    let questions = self.pending_questions(&local, &ask_id).unwrap_or_default();
                    // First answer wins: answered here meanwhile, it's gone.
                    self.answer_space_question(SpaceAnswerRequest {
                        space: local,
                        question: ask_id,
                        answers: answer_items(&questions, &answers),
                    })
                    .await
                    .map(|()| serde_json::json!({}))
                    .map_err(app_refusal)
                }
                None => Err(refuse(codes::UNKNOWN_SPACE, "no such space on this device")),
            },
        }
    }

    async fn fleet_reply(&self, req: RemoteRequest, outcome: Result<serde_json::Value, Refusal>) {
        let outcome = match outcome {
            Ok(value) => ReplyOutcome::Ok { value },
            Err((code, message)) => {
                tracing::info!(req_id = %req.req_id, code, reason = %message, "a fleet request failed");
                ReplyOutcome::Err {
                    code: code.to_string(),
                    message,
                }
            }
        };
        self.fleet_send_reply(&req.req_id, &req.origin_device, outcome)
            .await;
    }

    /// `start_space`: the space is made the usual way, then mapped.
    async fn fleet_host_start(&self, req: &RemoteRequest) -> Result<serde_json::Value, Refusal> {
        let RemoteOp::StartSpace {
            space: remote,
            project_id,
            goal,
            mode,
            agent,
            model,
            parent,
            depth,
        } = req.op.clone()
        else {
            return Err(refuse(codes::INTERNAL, "not a start"));
        };
        let agent = agent.and_then(|a| AgentId::ALL.into_iter().find(|x| x.as_str() == a));
        // Marked hosted before its first turn starts: that turn's tools
        // must already be a hosted space's.
        let core = self.clone();
        let mark: crate::usecases::spaces::OnSpaceCreated = Box::new(move |s: &Space| {
            core.fleet().hosting.insert(s.id.clone());
        });
        let space = self
            .create_space_then(
                CreateSpaceRequest {
                    project: project_id.clone(),
                    goal,
                    name: None,
                    branch: None,
                    base: None,
                    agent,
                    model,
                    start_from: None,
                    effort: None,
                    mode: Some(space_mode(mode)),
                },
                Some(mark),
            )
            .await
            .map_err(|e| refuse(codes::INTERNAL, e.to_string()))?;
        let project_name = self
            .fleet_projects()
            .await
            .into_iter()
            .find(|p| p.id == project_id)
            .map_or_else(|| project_id.clone(), |p| p.name);
        let data = HostedData {
            mode,
            project_id,
            project_name,
            name: space.name.clone(),
            branch: space.branch.clone(),
            track: Track::default(),
        };
        let row = FleetHostedRow {
            space: remote.clone(),
            local_space: space.id.clone(),
            origin_device: req.origin_device.clone(),
            parent,
            depth,
            created_at: self.0.deps.clock.now(),
            data: serde_json::to_value(&data).unwrap_or_default(),
        };
        self.fleet_put_hosted(&row).await;
        let name = self.fleet_name(&self.fleet_settings().await).await;
        {
            let mut mem = self.fleet();
            let me = mem.device_id.clone().unwrap_or_default();
            let view = hosted_view(&row, &data, &me, &name);
            mem.hosted
                .insert(remote.clone(), Hosted { row, data, view });
            mem.release(&remote, &req.req_id);
            mem.hosting.remove(&space.id);
        }
        tracing::info!(space = %space.id, remote = %remote, origin = %req.origin_device, "started a space for another device");
        self.fleet_observe(ObserverCmd::Hosted(remote.clone()));
        self.fleet_announce().await;
        Ok(serde_json::to_value(StartedSpace {
            space: remote,
            name: space.name,
            branch: space.branch,
        })
        .unwrap_or_default())
    }

    async fn fleet_put_hosted(&self, row: &FleetHostedRow) {
        let store = self.0.deps.store.clone();
        let row = row.clone();
        let stored = tokio::task::spawn_blocking(move || store.fleet_hosted_put(&row)).await;
        if let Ok(Err(e)) = stored {
            tracing::warn!(error.code = e.code(), error = %e, "couldn't store a hosted fleet space");
        }
    }

    /// Reads the hosted spaces once per process.
    pub(crate) async fn fleet_load_hosted(&self) {
        self.0
            .fleet
            .hosted_loaded
            .get_or_init(|| async {
                let store = self.0.deps.store.clone();
                let rows = tokio::task::spawn_blocking(move || store.fleet_hosted_all())
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .unwrap_or_default();
                if rows.is_empty() {
                    return;
                }
                let name = self.fleet_name(&self.fleet_settings().await).await;
                let mut loaded = Vec::new();
                for row in rows {
                    let Ok(mut data) = serde_json::from_value::<HostedData>(row.data.clone())
                    else {
                        continue;
                    };
                    // A crash between a journal write and the row's: the
                    // journal knows the last seq.
                    let store = self.0.deps.store.clone();
                    let (space, since) = (row.space.clone(), data.track.seq);
                    let last = tokio::task::spawn_blocking(move || {
                        store.fleet_journal_since(&space, since, DEVICE_JOURNAL)
                    })
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .and_then(|evs| evs.last().map(|(s, _)| *s));
                    if let Some(last) = last {
                        data.track.seq = data.track.seq.max(last);
                    }
                    loaded.push((row, data));
                }
                {
                    let mut mem = self.fleet();
                    let me = mem.device_id.clone().unwrap_or_default();
                    for (row, data) in loaded {
                        let view = hosted_view(&row, &data, &me, &name);
                        mem.hosted
                            .insert(row.space.clone(), Hosted { row, data, view });
                    }
                }
                // What happened while closed (a restart clears questions).
                self.fleet_observe(ObserverCmd::PassAll);
            })
            .await;
    }

    // ── the observer ────────────────────────────────────────────────────

    /// Hands `cmd` to the observer, starting it on first use.
    pub(crate) fn fleet_observe(&self, cmd: ObserverCmd) {
        let tx = self.0.fleet.observer.get_or_init(|| {
            let (tx, rx) = mpsc::unbounded_channel();
            let sync = self.0.sync_tx.subscribe();
            let eph = self.0.ephemeral_tx.subscribe();
            let core = self.clone();
            tokio::spawn(async move { core.fleet_observer(rx, sync, eph).await });
            tx
        });
        let _ = tx.send(cmd);
    }

    async fn fleet_observer(
        &self,
        mut cmds: mpsc::UnboundedReceiver<ObserverCmd>,
        mut sync: broadcast::Receiver<SyncFrame>,
        mut eph: broadcast::Receiver<Ephemeral>,
    ) {
        use broadcast::error::RecvError;
        loop {
            // Frames first: a turn's start is published before its steps.
            tokio::select! {
                biased;
                _ = self.0.shutdown.cancelled() => return,
                frame = sync.recv() => match frame {
                    Ok(f) => self.fleet_observe_frame(&f).await,
                    Err(RecvError::Lagged(_)) => self.fleet_pass_all().await,
                    Err(RecvError::Closed) => return,
                },
                cmd = cmds.recv() => match cmd {
                    Some(ObserverCmd::Hosted(remote)) => self.fleet_pass(&remote, true).await,
                    Some(ObserverCmd::Replay(resume)) => self.fleet_replay(resume).await,
                    Some(ObserverCmd::PassAll) => self.fleet_pass_all().await,
                    None => return,
                },
                ev = eph.recv() => match ev {
                    Ok(Ephemeral::RunStep { run, step }) => self.fleet_observe_step(&run, &step).await,
                    Ok(_) | Err(RecvError::Lagged(_)) => {}
                    Err(RecvError::Closed) => return,
                },
            }
        }
    }

    fn fleet_by_local(&self) -> HashMap<String, String> {
        self.fleet()
            .hosted
            .values()
            .map(|h| (h.row.local_space.clone(), h.row.space.clone()))
            .collect()
    }

    async fn fleet_pass_all(&self) {
        let remotes: Vec<String> = self.fleet().hosted.keys().cloned().collect();
        for r in remotes {
            self.fleet_pass(&r, true).await;
        }
    }

    async fn fleet_observe_frame(&self, frame: &SyncFrame) {
        let by_local = self.fleet_by_local();
        if by_local.is_empty() {
            return;
        }
        let mut dirty: BTreeMap<String, bool> = BTreeMap::new();
        for a in &frame.actions {
            if a.model == models::SPACE {
                if let Some(r) = by_local.get(&a.model_id) {
                    dirty.entry(r.clone()).or_insert(false);
                }
            } else if a.model == models::CHAT_MESSAGE
                && let Some(local) = a
                    .data
                    .as_ref()
                    .and_then(|d| d.get("pr"))
                    .and_then(|p| p.as_str())
                    .and_then(|p| p.strip_prefix("space:"))
                && let Some(r) = by_local.get(local)
            {
                dirty.insert(r.clone(), true);
            }
        }
        for (remote, chat) in dirty {
            self.fleet_pass(&remote, chat).await;
        }
    }

    async fn fleet_observe_step(&self, run: &str, step: &TurnStep) {
        let TurnStep::Tool {
            name,
            target,
            detail,
            parent: None,
            ..
        } = step
        else {
            return;
        };
        let Some(local) = run.strip_prefix("space:").and_then(|r| r.split(':').next()) else {
            return;
        };
        let Some(remote) = self.fleet_by_local().get(local).cloned() else {
            return;
        };
        // The turn's start first, if its frame hasn't been looked at yet.
        let current = self
            .fleet()
            .hosted
            .get(&remote)
            .and_then(|h| h.data.track.current.clone());
        if current.as_deref() != Some(run) {
            self.fleet_pass(&remote, false).await;
        }
        let Some(mut track) = self
            .fleet()
            .hosted
            .get(&remote)
            .map(|h| h.data.track.clone())
        else {
            return;
        };
        let summary = target
            .as_deref()
            .or(detail.as_deref())
            .unwrap_or_default()
            .lines()
            .next()
            .unwrap_or_default();
        let event = RemoteSpaceEvent::Tool {
            turn: track.turn,
            name: truncate(name, 80),
            summary: truncate(summary, 200),
        };
        self.fleet_journal(&remote, &mut track, event).await;
        if let Some(h) = self.fleet().hosted.get_mut(&remote) {
            h.data.track.seq = track.seq;
        }
    }

    /// The text that started `run`'s turn.
    async fn fleet_turn_text(&self, run: &str) -> String {
        let Some(message) = run.rsplit(':').next() else {
            return String::new();
        };
        let store = self.0.deps.store.clone();
        let id = message.to_string();
        tokio::task::spawn_blocking(move || store.get(models::CHAT_MESSAGE, &id))
            .await
            .ok()
            .and_then(Result::ok)
            .flatten()
            .and_then(|r| serde_json::from_value::<ChatMessage>(r.data).ok())
            .map(|m| truncate(&m.text, 2000))
            .unwrap_or_default()
    }

    /// Agent replies of `local` not reported yet, oldest first.
    async fn fleet_new_replies(&self, local: &str, track: &Track) -> Vec<ChatMessage> {
        let store = self.0.deps.store.clone();
        let key = space_chat_key(local).0;
        let rows =
            tokio::task::spawn_blocking(move || store.query(models::CHAT_MESSAGE, "pr", &key))
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default();
        let mut out: Vec<ChatMessage> = rows
            .into_iter()
            .filter_map(|r| serde_json::from_value::<ChatMessage>(r.data).ok())
            .filter(|m| matches!(m.author, Author::Agent(_)) && m.queued.is_none())
            .filter(|m| {
                m.at >= track.reply_at && m.run.as_ref().is_some_and(|r| !track.ended.contains(r))
            })
            .collect();
        out.sort_by_key(|m| m.at);
        out
    }

    /// Compares hosted space `remote` with what was last reported, and
    /// reports the difference.
    async fn fleet_pass(&self, remote: &str, chat: bool) {
        let Some((row_meta, data)) = self
            .fleet()
            .hosted
            .get(remote)
            .map(|h| (h.row.clone(), h.data.clone()))
        else {
            return;
        };
        let local = row_meta.local_space.clone();
        let Ok(space) = self.space_row(&local).await else {
            return;
        };
        let mut track = data.track.clone();
        let mut events = Vec::new();
        let me = self.fleet().device_id.clone().unwrap_or_default();
        let device_name = self.fleet_name(&self.fleet_settings().await).await;
        if !track.started {
            track.started = true;
            events.push(RemoteSpaceEvent::Started {
                host_device: me.clone(),
                origin_device: row_meta.origin_device.clone(),
                project_id: data.project_id.clone(),
                project_name: data.project_name.clone(),
                name: space.name.clone(),
                branch: space.branch.clone(),
                mode: data.mode,
                parent: row_meta.parent.clone(),
                depth: row_meta.depth,
            });
        }
        if space.status == SpaceStatus::Running
            && let Some(run) = &space.run
            && track.current.as_ref() != Some(run)
            && !track.ended.contains(run)
        {
            track.turn += 1;
            track.current = Some(run.clone());
            events.push(RemoteSpaceEvent::TurnStarted {
                turn: track.turn,
                text: self.fleet_turn_text(run).await,
            });
        }
        let look = chat
            || space.turns != track.turns
            || (track.current.is_some() && space.run != track.current);
        if look {
            for m in self.fleet_new_replies(&local, &track).await {
                let Some(run) = m.run.clone() else { continue };
                if track.current.as_ref() != Some(&run) {
                    track.turn += 1;
                    events.push(RemoteSpaceEvent::TurnStarted {
                        turn: track.turn,
                        text: self.fleet_turn_text(&run).await,
                    });
                }
                if !m.text.trim().is_empty() {
                    let text = truncate(&m.text, 8000);
                    track.last_reply = Some(text.clone());
                    events.push(RemoteSpaceEvent::Reply {
                        turn: track.turn,
                        text,
                    });
                }
                let (outcome, message) = match m.failed.as_deref() {
                    None => (TurnOutcome::Done, None),
                    Some("stopped") => (TurnOutcome::Stopped, None),
                    Some(e) => (TurnOutcome::Failed, Some(truncate(e, 500))),
                };
                events.push(RemoteSpaceEvent::TurnEnded {
                    turn: track.turn,
                    outcome,
                    message,
                });
                track.ended.push(run);
                if track.ended.len() > ENDED_KEPT {
                    track.ended.remove(0);
                }
                track.reply_at = track.reply_at.max(m.at);
                track.current = None;
            }
            track.turns = space.turns;
        }
        let mut asks = Vec::new();
        let qid = space.question.as_ref().map(|q| q.id.clone());
        if qid != track.question {
            if let Some(old) = track.question.take() {
                events.push(RemoteSpaceEvent::QuestionCleared {
                    ask_id: old.clone(),
                });
                asks.push(Outgoing::Resolved(old));
            }
            if let Some(q) = &space.question {
                let questions = remote_questions(&q.questions);
                events.push(RemoteSpaceEvent::Question {
                    ask_id: q.id.clone(),
                    questions: questions.clone(),
                });
                asks.push(Outgoing::Ask(RemoteAsk {
                    ask_id: q.id.clone(),
                    space: remote.to_string(),
                    host_device: me.clone(),
                    from: format!("{device_name} · {}", space.name),
                    questions,
                }));
            }
            track.question = qid;
        }
        let status = remote_status(&space);
        if track.status != Some(status) {
            track.status = Some(status);
            events.push(RemoteSpaceEvent::Status { status });
        }
        let renamed = space.name != data.name || space.branch != data.branch;
        let changed = !events.is_empty() || renamed;
        if !changed && track == data.track {
            return;
        }
        for event in events {
            self.fleet_journal(remote, &mut track, event).await;
        }
        for msg in asks {
            match msg {
                Outgoing::Ask(ask) => self.fleet_send_ask(&ask).await,
                Outgoing::Resolved(ask_id) => {
                    self.fleet_send_msg(ClientMessage::AskResolved { ask_id });
                }
            }
        }
        let (row, view) = {
            let mut mem = self.fleet();
            let Some(h) = mem.hosted.get_mut(remote) else {
                return;
            };
            h.data.track = track;
            h.data.name = space.name.clone();
            h.data.branch = space.branch.clone();
            h.row.data = serde_json::to_value(&h.data).unwrap_or_default();
            let mut view = hosted_view(&h.row, &h.data, &me, &device_name);
            view.question = space.question.as_ref().map(|q| FleetQuestion {
                ask_id: q.id.clone(),
                space: remote.to_string(),
                from: format!("{device_name} · {}", space.name),
                questions: ui_questions(&remote_questions(&q.questions)),
                via: None,
            });
            h.view = view.clone();
            (h.row.clone(), view)
        };
        self.fleet_put_hosted(&row).await;
        if changed {
            self.emit(Ephemeral::FleetSpace { space: view });
            self.0.fleet.changed.notify_waiters();
        }
    }

    /// Journals `event` as `remote`'s next and sends it.
    async fn fleet_journal(&self, remote: &str, track: &mut Track, event: RemoteSpaceEvent) {
        track.seq += 1;
        let seq = track.seq;
        if let Ok(value) = serde_json::to_value(&event) {
            let store = self.0.deps.store.clone();
            let space = remote.to_string();
            let kept = tokio::task::spawn_blocking(move || {
                store.fleet_journal_append(&space, seq, &value, DEVICE_JOURNAL)
            })
            .await;
            if let Ok(Err(e)) = kept {
                tracing::warn!(error.code = e.code(), error = %e, "couldn't journal a fleet event");
            }
        }
        self.emit(Ephemeral::FleetSpaceLine {
            space: remote.to_string(),
            line: line_of(seq, &event),
        });
        self.fleet_send_event(remote, seq, event).await;
    }

    /// Sends event `seq` of hosted space `remote`, signed as its host.
    async fn fleet_send_event(&self, remote: &str, seq: u64, event: RemoteSpaceEvent) {
        let Some(me) = self.fleet().device_id.clone() else {
            return;
        };
        let key = match self.fleet_key().await {
            Ok(k) => k,
            Err(e) => {
                tracing::warn!(error.code = e.code(), error = %e, "no fleet key to sign an event");
                return;
            }
        };
        let body = SpaceEventBody {
            space: remote.to_string(),
            seq,
            host_device: me,
            event,
        };
        self.fleet_send_msg(ClientMessage::SpaceEvent {
            envelope: SignedEnvelope::seal_as(&body, &key, Domain::Event),
        });
    }

    /// Sends a question of a hosted space, signed as its host.
    async fn fleet_send_ask(&self, ask: &RemoteAsk) {
        let key = match self.fleet_key().await {
            Ok(k) => k,
            Err(e) => {
                tracing::warn!(error.code = e.code(), error = %e, "no fleet key to sign a question");
                return;
            }
        };
        self.fleet_send_msg(ClientMessage::Ask {
            envelope: SignedEnvelope::seal_as(ask, &key, Domain::Ask),
        });
    }

    /// After a welcome: what the cloud lacks of each hosted space, then the
    /// questions still waiting (an `ask` sent while offline was dropped).
    async fn fleet_replay(&self, resume: BTreeMap<String, u64>) {
        self.fleet_pass_all().await;
        let hosted: Vec<(String, String, u64)> = self
            .fleet()
            .hosted
            .values()
            .map(|h| {
                (
                    h.row.space.clone(),
                    h.row.local_space.clone(),
                    h.data.track.seq,
                )
            })
            .collect();
        let me = self.fleet().device_id.clone().unwrap_or_default();
        let device_name = self.fleet_name(&self.fleet_settings().await).await;
        for (remote, local, seq) in hosted {
            let since = resume.get(&remote).copied().unwrap_or(0);
            if since < seq {
                let store = self.0.deps.store.clone();
                let space = remote.clone();
                let events = tokio::task::spawn_blocking(move || {
                    store.fleet_journal_since(&space, since, DEVICE_JOURNAL)
                })
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default();
                for (seq, value) in events {
                    let Ok(event) = serde_json::from_value::<RemoteSpaceEvent>(value) else {
                        continue;
                    };
                    self.fleet_send_event(&remote, seq, event).await;
                }
            }
            if let Ok(space) = self.space_row(&local).await
                && let Some(q) = &space.question
            {
                self.fleet_send_ask(&RemoteAsk {
                    ask_id: q.id.clone(),
                    space: remote.clone(),
                    host_device: me.clone(),
                    from: format!("{device_name} · {}", space.name),
                    questions: remote_questions(&q.questions),
                })
                .await;
            }
        }
    }
}

/// A hosted space as the UI lists it.
pub(crate) fn hosted_view(
    row: &FleetHostedRow,
    data: &HostedData,
    me: &str,
    device_name: &str,
) -> FleetRemoteSpace {
    FleetRemoteSpace {
        space: row.space.clone(),
        host_device: me.to_string(),
        host_name: device_name.to_string(),
        origin_device: row.origin_device.clone(),
        project_name: data.project_name.clone(),
        name: data.name.clone(),
        branch: data.branch.clone(),
        status: data
            .track
            .status
            .map_or(FleetSpaceStatus::Running, ui_status),
        mode: space_mode(data.mode),
        depth: row.depth,
        parent: row.parent.clone(),
        last_reply: data.track.last_reply.clone(),
        question: None,
        hosted_here: true,
        local_space: Some(row.local_space.clone()),
        error: None,
    }
}
