//! Fleet, this device as the origin (docs/fleet.md "App side"): spaces it
//! starts and steers on other devices, their history as it arrives, and
//! questions the cloud routes here.
//!
//! ```text
//! fleet_start_space (a device pinned here) ─▶ rs_<uuid> + req_id
//!   ─▶ seal(device key, target_key = the target's pin) ─▶ request
//!   ─▶ tracked `starting` (host = the target, for good), subscribe{since 0}
//!   ─▶ reply ─▶ open_as(that pin, Reply) ─▶ ok ─▶ name, branch
//!                │                       └▶ err ─▶ failed + code, ≤ 200 chars
//!                └▶ doesn't verify ─▶ dropped (the request times out)
//!   ─▶ refused (the cloud's, unsigned) ─▶ failed + its code only
//! space_event ─▶ open_as(host's pinned key, Event) ─▶ status, last reply,
//!   question ─▶ FleetSpace + FleetSpaceLine          else dropped
//! space_gap ─▶ a gap line, nothing else
//! reconnect ─▶ subscribe{since: last seq seen}
//! ask ─▶ open_as(asker's pinned key, Ask) ─▶ FleetAsk "<pin> · <started name>"
//! dismiss ─▶ FleetAskDismissed
//! ```

use std::collections::VecDeque;
use std::time::Duration;

use theodore_contract::{
    Ephemeral, FleetAnswerRequest, FleetLineKind, FleetQuestion, FleetRemoteSpace,
    FleetSendRequest, FleetSpaceLine, FleetSpaceStatus, FleetStartRequest, SpaceMode,
};
use theodore_fleet_protocol::{
    AskVia, ClientMessage, Domain, RemoteAsk, RemoteOp, RemoteRequest, RemoteSpaceEvent,
    RemoteSpaceStatus, ReplyBody, ReplyOutcome, SignedEnvelope, SpaceEventBody, StartedSpace,
    TurnOutcome,
};
use tokio::sync::oneshot;

use crate::core::Core;
use crate::error::{AppError, AppResult};
use crate::usecases::fleet::{
    Answer, ERROR_TEXT_MAX, Outbound, PendingReply, fleet_mode, safe_code, space_mode,
};
use crate::usecases::fleet_host::{ui_questions, ui_status};

/// History kept per remote space in memory.
const LINES_KEPT: usize = 500;
/// Most characters of a space name or branch taken from a signed reply.
const NAME_MAX: usize = 200;

/// A refusal as the UI and an agent may read it: a verified target's code
/// and words, or the cloud's code alone. `None` for a success.
pub(crate) fn answer_error(answer: &Answer) -> Option<String> {
    match answer {
        Answer::Ok(_) => None,
        Answer::Err { code, message } if message.is_empty() => {
            Some(format!("the other device refused: {code}"))
        }
        Answer::Err { code, message } => {
            Some(format!("the other device refused: {code}: {message}"))
        }
        Answer::Refused { code } => Some(format!("refused by the cloud: {code}")),
    }
}
/// How long a send, stop or answer waits for the other device's word.
pub(crate) const REPLY_WAIT: Duration = Duration::from_secs(15);
/// Replies never heard back are forgotten past this many.
const REPLIES_KEPT: usize = 256;

/// At most `max` characters of `s`.
pub(crate) fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn status_word(s: RemoteSpaceStatus) -> &'static str {
    match s {
        RemoteSpaceStatus::Running => "running",
        RemoteSpaceStatus::Idle => "idle",
        RemoteSpaceStatus::Waiting => "waiting for an answer",
        RemoteSpaceStatus::Stopped => "stopped",
        RemoteSpaceStatus::Failed => "failed",
    }
}

/// One event as a line of history.
pub(crate) fn line_of(seq: u64, ev: &RemoteSpaceEvent) -> FleetSpaceLine {
    let (kind, text) = match ev {
        RemoteSpaceEvent::Started {
            name, branch, mode, ..
        } => (
            FleetLineKind::Started,
            format!(
                "Started {name} on {branch} ({})",
                crate::usecases::fleet::mode_str(*mode)
            ),
        ),
        RemoteSpaceEvent::Status { status } => {
            (FleetLineKind::Status, status_word(*status).to_string())
        }
        RemoteSpaceEvent::TurnStarted { turn, text } => {
            (FleetLineKind::Turn, format!("Turn {turn}: {text}"))
        }
        RemoteSpaceEvent::Tool { name, summary, .. } => (
            FleetLineKind::Tool,
            if summary.is_empty() {
                name.clone()
            } else {
                format!("{name} {summary}")
            },
        ),
        RemoteSpaceEvent::Reply { text, .. } => (FleetLineKind::Reply, text.clone()),
        RemoteSpaceEvent::TurnEnded {
            turn,
            outcome,
            message,
        } => {
            let word = match outcome {
                TurnOutcome::Done => "done",
                TurnOutcome::Stopped => "stopped",
                TurnOutcome::Failed => "failed",
            };
            (
                FleetLineKind::Ended,
                match message {
                    Some(m) => format!("Turn {turn} {word}: {m}"),
                    None => format!("Turn {turn} {word}"),
                },
            )
        }
        RemoteSpaceEvent::Question { questions, .. } => (
            FleetLineKind::Question,
            questions
                .iter()
                .map(|q| q.question.clone())
                .collect::<Vec<_>>()
                .join(" / "),
        ),
        RemoteSpaceEvent::QuestionCleared { .. } => (
            FleetLineKind::Question,
            "Question answered or withdrawn".into(),
        ),
    };
    FleetSpaceLine { seq, kind, text }
}

/// The cloud's word that events `from..=to` are gone (`space_gap`).
pub(crate) fn gap_line(from: u64, to: u64) -> FleetSpaceLine {
    FleetSpaceLine {
        seq: from,
        kind: FleetLineKind::Gap,
        text: format!("Events {from}–{to} are no longer available"),
    }
}

fn via_word(v: AskVia) -> &'static str {
    match v {
        AskVia::Active => "active",
        AskVia::Origin => "origin",
        AskVia::Escalated => "escalated",
        AskVia::Moved => "moved",
    }
}

/// Settled: nothing runs until someone sends something.
pub(crate) fn settled(s: FleetSpaceStatus) -> bool {
    matches!(
        s,
        FleetSpaceStatus::Idle
            | FleetSpaceStatus::Waiting
            | FleetSpaceStatus::Stopped
            | FleetSpaceStatus::Failed
    )
}

impl Core {
    /// This device's id, when connected.
    pub(crate) fn fleet_ready(&self) -> AppResult<String> {
        let mem = self.fleet();
        match (&mem.device_id, mem.connected) {
            (Some(id), true) => Ok(id.clone()),
            _ => Err(AppError::Invalid(
                "not connected to the fleet: turn it on in Settings and check the connection"
                    .into(),
            )),
        }
    }

    /// Signs `op` for `target` and sends it; the receiver gets its reply.
    /// Only to a target pinned here: the request names the pinned key
    /// (`target_key`), and only a reply signed by it counts.
    async fn fleet_request(
        &self,
        target: &str,
        op: RemoteOp,
        start: bool,
    ) -> AppResult<oneshot::Receiver<Answer>> {
        let me = self.fleet_ready()?;
        let pinned = self.fleet_pinned(target).await.ok_or_else(|| {
            AppError::Invalid(format!(
                "device {target} isn't trusted on this device: trust it in Settings → Devices first"
            ))
        })?;
        let key = self.fleet_key().await?;
        let space = op.space().to_string();
        let req = RemoteRequest {
            req_id: uuid::Uuid::new_v4().to_string(),
            origin_device: me,
            target_device: target.to_string(),
            target_key: pinned.public_key.clone(),
            issued_at_ms: self.0.deps.clock.now().max(0) as u64,
            op,
        };
        let envelope = SignedEnvelope::seal(&req, &key);
        let (tx, rx) = oneshot::channel();
        {
            let mut mem = self.fleet();
            if mem.replies.len() >= REPLIES_KEPT {
                mem.replies.clear();
            }
            mem.replies.insert(
                req.req_id.clone(),
                PendingReply {
                    space,
                    start,
                    target: target.to_string(),
                    target_key: pinned.public_key,
                    tx: Some(tx),
                },
            );
        }
        if !self.fleet_send_msg(ClientMessage::Request { envelope }) {
            self.fleet().replies.remove(&req.req_id);
            return Err(AppError::Invalid("not connected to the fleet".into()));
        }
        Ok(rx)
    }

    /// The other device's word on a request, within `wait`. A refusal is
    /// `AppError::Refused` with what may reach an agent: the verified
    /// target's code and words (cut to `ERROR_TEXT_MAX`), or only the
    /// cloud's code.
    pub(crate) async fn fleet_await(
        rx: oneshot::Receiver<Answer>,
        wait: Duration,
    ) -> AppResult<serde_json::Value> {
        match tokio::time::timeout(wait, rx).await {
            Ok(Ok(Answer::Ok(value))) => Ok(value),
            Ok(Ok(answer)) => Err(AppError::Refused(answer_error(&answer).unwrap_or_default())),
            Ok(Err(_)) => Err(AppError::Invalid("the request got no reply".into())),
            Err(_) => Err(AppError::Invalid(
                "the other device didn't answer in time".into(),
            )),
        }
    }

    /// Starts a space on another device (the UI's New remote space).
    pub async fn fleet_start_space(&self, req: FleetStartRequest) -> AppResult<FleetRemoteSpace> {
        let (view, _rx) = self
            .fleet_start_remote(
                &req.device_id,
                &req.project_id,
                &req.goal,
                req.mode,
                None,
                0,
                None,
            )
            .await?;
        Ok(view)
    }

    /// Asks `device` for a space and tracks it as `starting`; the receiver
    /// gets the start's reply.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn fleet_start_remote(
        &self,
        device: &str,
        project_id: &str,
        goal: &str,
        mode: SpaceMode,
        parent: Option<String>,
        depth: u32,
        started_by: Option<String>,
    ) -> AppResult<(FleetRemoteSpace, oneshot::Receiver<Answer>)> {
        let me = self.fleet_ready()?;
        let goal = goal.trim();
        if goal.is_empty() {
            return Err(AppError::Invalid("say what the space should do".into()));
        }
        let target = self
            .fleet()
            .devices
            .iter()
            .find(|d| d.device_id == device)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("device {device} isn't in the fleet")))?;
        // Only a device trusted here, with the key it had when trusted:
        // its events and questions are checked against that key.
        let pinned = match self.fleet_pinned(device).await {
            Some(p) if p.public_key == target.public_key => p,
            _ => {
                return Err(AppError::Invalid(format!(
                    "{} isn't trusted on this device: trust it in Settings → Devices first",
                    target.info.name
                )));
            }
        };
        let project_name = target
            .info
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .map_or_else(|| project_id.to_string(), |p| p.name.clone());
        let space = format!("rs_{}", uuid::Uuid::new_v4().simple());
        let view = FleetRemoteSpace {
            space: space.clone(),
            host_device: target.device_id.clone(),
            // As pinned here: who the user trusted, not what it says now.
            host_name: pinned.name,
            origin_device: me,
            project_name,
            name: String::new(),
            branch: String::new(),
            status: FleetSpaceStatus::Starting,
            mode,
            depth,
            parent: parent.clone(),
            last_reply: None,
            question: None,
            hosted_here: false,
            local_space: None,
            error: None,
        };
        self.fleet().outbound.insert(
            space.clone(),
            Outbound {
                view: view.clone(),
                started_name: None,
                lines: VecDeque::new(),
                last_seq: 0,
                started_by,
            },
        );
        let rx = match self
            .fleet_request(
                &target.device_id,
                RemoteOp::StartSpace {
                    space: space.clone(),
                    project_id: project_id.to_string(),
                    goal: goal.to_string(),
                    mode: fleet_mode(mode),
                    agent: None,
                    model: None,
                    parent,
                    depth,
                },
                true,
            )
            .await
        {
            Ok(rx) => rx,
            Err(e) => {
                self.fleet().outbound.remove(&space);
                return Err(e);
            }
        };
        // Subscribed once the host's signed ok arrives (`fleet_answered`):
        // before that the cloud doesn't know the space and refuses it.
        self.emit(Ephemeral::FleetSpace {
            space: view.clone(),
        });
        tracing::info!(remote = %space, device = %target.device_id, "asked another device for a space");
        Ok((view, rx))
    }

    /// The device hosting `space` (started from here, or asking here).
    fn fleet_host_of(&self, space: &str) -> AppResult<String> {
        let mem = self.fleet();
        if let Some(o) = mem.outbound.get(space) {
            return Ok(o.view.host_device.clone());
        }
        mem.asks
            .values()
            .find(|(q, _)| q.space == space)
            .map(|(_, host)| host.clone())
            .ok_or_else(|| AppError::NotFound(format!("no fleet space {space} here")))
    }

    fn fleet_set_status(&self, space: &str, status: FleetSpaceStatus) -> Option<FleetSpaceStatus> {
        let mut mem = self.fleet();
        let o = mem.outbound.get_mut(space)?;
        let before = o.view.status;
        o.view.status = status;
        let view = o.view.clone();
        drop(mem);
        self.emit(Ephemeral::FleetSpace { space: view });
        self.0.fleet.changed.notify_waiters();
        Some(before)
    }

    /// A message for a space on another device; refused there or here
    /// with the reason.
    pub async fn fleet_send(&self, req: FleetSendRequest) -> AppResult<()> {
        let host = self.fleet_host_of(&req.space)?;
        if req.text.trim().is_empty() {
            return Err(AppError::Invalid("empty message".into()));
        }
        // Running from now: a wait right after must not see the last
        // turn's idle.
        let before = self.fleet_set_status(&req.space, FleetSpaceStatus::Running);
        let sent = async {
            let rx = self
                .fleet_request(
                    &host,
                    RemoteOp::Send {
                        space: req.space.clone(),
                        text: req.text.clone(),
                        mode: req.mode.map(fleet_mode),
                    },
                    false,
                )
                .await?;
            Self::fleet_await(rx, REPLY_WAIT).await
        }
        .await;
        if let (Err(_), Some(before)) = (&sent, before) {
            self.fleet_set_status(&req.space, before);
        }
        sent.map(|_| ())
    }

    pub async fn fleet_stop(&self, space: &str) -> AppResult<()> {
        let host = self.fleet_host_of(space)?;
        let rx = self
            .fleet_request(
                &host,
                RemoteOp::Stop {
                    space: space.to_string(),
                },
                false,
            )
            .await?;
        Self::fleet_await(rx, REPLY_WAIT).await.map(|_| ())
    }

    /// Answers a question from a space on another device.
    pub async fn fleet_answer(&self, req: FleetAnswerRequest) -> AppResult<()> {
        let host = self.fleet_host_of(&req.space)?;
        let rx = self
            .fleet_request(
                &host,
                RemoteOp::Answer {
                    space: req.space.clone(),
                    ask_id: req.ask_id.clone(),
                    answers: req.answers.clone(),
                },
                false,
            )
            .await?;
        Self::fleet_await(rx, REPLY_WAIT).await?;
        if self.fleet().asks.remove(&req.ask_id).is_some() {
            self.emit(Ephemeral::FleetAskDismissed { ask_id: req.ask_id });
        }
        Ok(())
    }

    /// A target's reply: only as the target signed it, against the key
    /// pinned for it when the request went out; anything else is dropped
    /// and the request keeps waiting.
    pub(crate) async fn fleet_on_reply(&self, envelope: SignedEnvelope) {
        let Ok(peeked) = envelope.peek_as::<ReplyBody>() else {
            tracing::debug!("dropped an unreadable fleet reply");
            return;
        };
        let me = self.fleet().device_id.clone();
        let body = {
            let mem = self.fleet();
            let Some(pending) = mem.replies.get(&peeked.req_id) else {
                tracing::debug!("dropped a reply to no request waiting here");
                return;
            };
            if envelope.device_id != pending.target {
                tracing::debug!("dropped a reply not from the request's target");
                return;
            }
            match envelope.open_as::<ReplyBody>(&pending.target_key, Domain::Reply) {
                Ok(b) => b,
                Err(e) => {
                    tracing::debug!(error = %e, "dropped a reply that doesn't verify");
                    return;
                }
            }
        };
        if me.as_deref() != Some(body.origin_device.as_str()) {
            tracing::debug!("dropped a reply to another device's request");
            return;
        }
        let answer = match body.outcome {
            ReplyOutcome::Ok { value } => Answer::Ok(value),
            ReplyOutcome::Err { code, message } => Answer::Err {
                code: safe_code(&code),
                message: truncate(message.trim(), ERROR_TEXT_MAX),
            },
        };
        self.fleet_answered(&body.req_id, answer);
    }

    /// The cloud's own refusal of a request sent from here: unsigned, so
    /// only its code is kept.
    pub(crate) fn fleet_on_refused(&self, req_id: &str, code: &str) {
        self.fleet_answered(
            req_id,
            Answer::Refused {
                code: safe_code(code),
            },
        );
    }

    fn fleet_answered(&self, req_id: &str, answer: Answer) {
        let Some(mut pending) = self.fleet().replies.remove(req_id) else {
            return;
        };
        if pending.start {
            let mut subscribe = false;
            let view = {
                let mut mem = self.fleet();
                let Some(o) = mem.outbound.get_mut(&pending.space) else {
                    return;
                };
                match &answer {
                    Answer::Ok(value) => {
                        if let Ok(started) = serde_json::from_value::<StartedSpace>(value.clone()) {
                            o.view.name = truncate(&started.name, NAME_MAX);
                            o.view.branch = truncate(&started.branch, NAME_MAX);
                        }
                        if o.view.status == FleetSpaceStatus::Starting {
                            o.view.status = FleetSpaceStatus::Running;
                        }
                        subscribe = true;
                    }
                    Answer::Err { .. } | Answer::Refused { .. } => {
                        o.view.status = FleetSpaceStatus::Failed;
                        o.view.error = answer_error(&answer);
                    }
                }
                o.view.clone()
            };
            if subscribe {
                self.fleet_send_msg(ClientMessage::Subscribe {
                    space: pending.space.clone(),
                    since: 0,
                });
            }
            self.emit(Ephemeral::FleetSpace { space: view });
            self.0.fleet.changed.notify_waiters();
        }
        if let Some(tx) = pending.tx.take() {
            let _ = tx.send(answer);
        }
    }

    /// An event of a space this device follows: only as its host signed
    /// it, checked against the host's key pinned here.
    pub(crate) async fn fleet_on_event(&self, envelope: SignedEnvelope) {
        let Ok(peeked) = envelope.peek_as::<SpaceEventBody>() else {
            tracing::debug!("dropped an unreadable fleet event");
            return;
        };
        let Some(host) = self
            .fleet()
            .outbound
            .get(&peeked.space)
            .map(|o| o.view.host_device.clone())
        else {
            tracing::debug!(space = %peeked.space, "dropped an event of a space not followed here");
            return;
        };
        if envelope.device_id != host {
            tracing::debug!(space = %peeked.space, "dropped an event not from the space's host");
            return;
        }
        let Some(pinned) = self.fleet_pinned(&host).await else {
            tracing::debug!(space = %peeked.space, "dropped an event from a host not trusted here");
            return;
        };
        let body = match envelope.open_as::<SpaceEventBody>(&pinned.public_key, Domain::Event) {
            Ok(b) => b,
            Err(e) => {
                tracing::debug!(space = %peeked.space, error = %e, "dropped an event that doesn't verify");
                return;
            }
        };
        self.fleet_apply_event(&body.space, body.seq, body.event);
    }

    /// The cloud lost events of a space followed here: a line, nothing more.
    pub(crate) fn fleet_on_gap(&self, space: &str, from: u64, to: u64) {
        let line = gap_line(from, to);
        {
            let mut mem = self.fleet();
            let Some(o) = mem.outbound.get_mut(space) else {
                return;
            };
            if o.lines.iter().any(|l| *l == line) {
                return;
            }
            o.lines.push_back(line.clone());
            while o.lines.len() > LINES_KEPT {
                o.lines.pop_front();
            }
        }
        self.emit(Ephemeral::FleetSpaceLine {
            space: space.to_string(),
            line,
        });
    }

    /// A verified event of a space this device follows.
    fn fleet_apply_event(&self, space: &str, seq: u64, event: RemoteSpaceEvent) {
        let (view, line) = {
            let mut mem = self.fleet();
            let Some(o) = mem.outbound.get_mut(space) else {
                return;
            };
            if seq <= o.last_seq {
                return;
            }
            o.last_seq = seq;
            if let RemoteSpaceEvent::Started { name, .. } = &event {
                o.started_name = Some(name.clone());
            }
            let started_name = o.started_name.clone().unwrap_or_default();
            let v = &mut o.view;
            match &event {
                // Host, parent and depth stay what this device asked for,
                // whatever the event says.
                RemoteSpaceEvent::Started {
                    project_name,
                    name,
                    branch,
                    mode,
                    ..
                } => {
                    v.project_name = project_name.clone();
                    v.name = name.clone();
                    v.branch = branch.clone();
                    v.mode = space_mode(*mode);
                    if v.status == FleetSpaceStatus::Starting {
                        v.status = FleetSpaceStatus::Running;
                    }
                }
                RemoteSpaceEvent::Status { status } => v.status = ui_status(*status),
                RemoteSpaceEvent::Reply { text, .. } => v.last_reply = Some(text.clone()),
                RemoteSpaceEvent::Question { ask_id, questions } => {
                    v.question = Some(FleetQuestion {
                        ask_id: ask_id.clone(),
                        space: space.to_string(),
                        from: if started_name.is_empty() {
                            v.host_name.clone()
                        } else {
                            format!("{} · {started_name}", v.host_name)
                        },
                        questions: ui_questions(questions),
                        via: None,
                    });
                }
                RemoteSpaceEvent::QuestionCleared { ask_id } => {
                    if v.question.as_ref().is_some_and(|q| &q.ask_id == ask_id) {
                        v.question = None;
                    }
                }
                RemoteSpaceEvent::TurnStarted { .. }
                | RemoteSpaceEvent::Tool { .. }
                | RemoteSpaceEvent::TurnEnded { .. } => {}
            }
            let line = line_of(seq, &event);
            o.lines.push_back(line.clone());
            while o.lines.len() > LINES_KEPT {
                o.lines.pop_front();
            }
            (o.view.clone(), line)
        };
        self.emit(Ephemeral::FleetSpace { space: view });
        self.emit(Ephemeral::FleetSpaceLine {
            space: space.to_string(),
            line,
        });
        self.0.fleet.changed.notify_waiters();
    }

    /// A question from a space elsewhere, routed to this device: only as
    /// a device pinned here signed it. Who asks is told from the pin and
    /// the space's signed `started` event, never the ask's own words.
    pub(crate) async fn fleet_on_ask(&self, envelope: SignedEnvelope, via: AskVia) {
        let Some(pinned) = self.fleet_pinned(&envelope.device_id).await else {
            tracing::debug!("dropped a question from a device not trusted here");
            return;
        };
        let ask = match envelope.open_as::<RemoteAsk>(&pinned.public_key, Domain::Ask) {
            Ok(a) => a,
            Err(e) => {
                tracing::debug!(error = %e, "dropped a question that doesn't verify");
                return;
            }
        };
        let started_name = {
            let mem = self.fleet();
            match mem.outbound.get(&ask.space) {
                Some(o) if o.view.host_device != ask.host_device => {
                    tracing::debug!(space = %ask.space, "dropped a question not from the space's host");
                    return;
                }
                Some(o) => o.started_name.clone(),
                None => None,
            }
        };
        let from = match started_name {
            Some(n) if !n.is_empty() => format!("{} · {n}", pinned.name),
            _ => pinned.name.clone(),
        };
        let question = FleetQuestion {
            ask_id: ask.ask_id.clone(),
            space: ask.space.clone(),
            from,
            questions: ui_questions(&ask.questions),
            via: Some(via_word(via).to_string()),
        };
        self.fleet()
            .asks
            .insert(ask.ask_id.clone(), (question.clone(), ask.host_device));
        self.emit(Ephemeral::FleetAsk { question });
    }

    /// Spaces started from here, then those hosted here.
    pub async fn fleet_spaces(&self) -> AppResult<Vec<FleetRemoteSpace>> {
        let mem = self.fleet();
        let mut out: Vec<FleetRemoteSpace> =
            mem.outbound.values().map(|o| o.view.clone()).collect();
        out.sort_by(|a, b| a.space.cmp(&b.space));
        let mut hosted: Vec<FleetRemoteSpace> =
            mem.hosted.values().map(|h| h.view.clone()).collect();
        hosted.sort_by(|a, b| a.space.cmp(&b.space));
        out.extend(hosted);
        Ok(out)
    }

    /// A fleet space's history after `since`.
    pub async fn fleet_space_lines(
        &self,
        space: &str,
        since: u64,
    ) -> AppResult<Vec<FleetSpaceLine>> {
        let hosted = {
            let mem = self.fleet();
            if let Some(o) = mem.outbound.get(space) {
                return Ok(o.lines.iter().filter(|l| l.seq > since).cloned().collect());
            }
            mem.hosted.contains_key(space)
        };
        if !hosted {
            return Err(AppError::NotFound(format!("no fleet space {space} here")));
        }
        let store = self.0.deps.store.clone();
        let id = space.to_string();
        let events = tokio::task::spawn_blocking(move || {
            store.fleet_journal_since(&id, since, theodore_fleet_protocol::DEVICE_JOURNAL)
        })
        .await
        .map_err(AppError::join)??;
        Ok(events
            .into_iter()
            .filter_map(|(seq, v)| {
                serde_json::from_value::<RemoteSpaceEvent>(v)
                    .ok()
                    .map(|e| line_of(seq, &e))
            })
            .collect())
    }
}
