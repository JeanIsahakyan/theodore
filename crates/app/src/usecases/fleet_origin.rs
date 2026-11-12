//! Fleet, this device as the origin (docs/fleet.md "App side"): spaces it
//! starts and steers on other devices, their history as it arrives, and
//! questions the cloud routes here.
//!
//! ```text
//! fleet_start_space ─▶ rs_<uuid> + req_id ─▶ seal(device key) ─▶ request
//!   ─▶ tracked `starting`, subscribe{since 0} ─▶ reply ok ─▶ name, branch
//!                                            └▶ reply err ─▶ failed + error
//! space_event ─▶ status, last reply, question ─▶ FleetSpace + FleetSpaceLine
//! reconnect ─▶ subscribe{since: last seq seen}
//! ask{ask, via} ─▶ FleetAsk        dismiss ─▶ FleetAskDismissed
//! ```

use std::collections::VecDeque;
use std::time::Duration;

use theodore_contract::{
    Ephemeral, FleetAnswerRequest, FleetLineKind, FleetQuestion, FleetRemoteSpace,
    FleetSendRequest, FleetSpaceLine, FleetSpaceStatus, FleetStartRequest, SpaceMode,
};
use theodore_fleet_protocol::{
    AskVia, ClientMessage, RemoteAsk, RemoteOp, RemoteRequest, RemoteSpaceEvent, RemoteSpaceStatus,
    ReplyOutcome, SignedEnvelope, StartedSpace, TurnOutcome,
};
use tokio::sync::oneshot;

use crate::core::Core;
use crate::error::{AppError, AppResult};
use crate::usecases::fleet::{Outbound, PendingReply, fleet_mode, space_mode};
use crate::usecases::fleet_host::{ui_questions, ui_status};

/// History kept per remote space in memory.
const LINES_KEPT: usize = 500;
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
        RemoteSpaceEvent::Gap { from, to } => (
            FleetLineKind::Gap,
            format!("Events {from}–{to} are no longer available"),
        ),
    };
    FleetSpaceLine { seq, kind, text }
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
    async fn fleet_request(
        &self,
        target: &str,
        op: RemoteOp,
        start: bool,
    ) -> AppResult<oneshot::Receiver<ReplyOutcome>> {
        let me = self.fleet_ready()?;
        let key = self.fleet_key().await?;
        let space = op.space().to_string();
        let req = RemoteRequest {
            req_id: uuid::Uuid::new_v4().to_string(),
            origin_device: me,
            target_device: target.to_string(),
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

    /// The other device's word on a request, within `wait`.
    pub(crate) async fn fleet_await(
        rx: oneshot::Receiver<ReplyOutcome>,
        wait: Duration,
    ) -> AppResult<serde_json::Value> {
        match tokio::time::timeout(wait, rx).await {
            Ok(Ok(ReplyOutcome::Ok { value })) => Ok(value),
            Ok(Ok(ReplyOutcome::Err { code, message })) => {
                Err(AppError::Refused(format!("{message} ({code})")))
            }
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
    ) -> AppResult<(FleetRemoteSpace, oneshot::Receiver<ReplyOutcome>)> {
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
            host_name: target.info.name.clone(),
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
        self.fleet_send_msg(ClientMessage::Subscribe {
            space: space.clone(),
            since: 0,
        });
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

    pub(crate) fn fleet_on_reply(&self, req_id: &str, outcome: ReplyOutcome) {
        let Some(mut pending) = self.fleet().replies.remove(req_id) else {
            return;
        };
        if pending.start {
            let view = {
                let mut mem = self.fleet();
                let Some(o) = mem.outbound.get_mut(&pending.space) else {
                    return;
                };
                match &outcome {
                    ReplyOutcome::Ok { value } => {
                        if let Ok(started) = serde_json::from_value::<StartedSpace>(value.clone()) {
                            o.view.name = started.name;
                            o.view.branch = started.branch;
                        }
                        if o.view.status == FleetSpaceStatus::Starting {
                            o.view.status = FleetSpaceStatus::Running;
                        }
                    }
                    ReplyOutcome::Err { code, message } => {
                        o.view.status = FleetSpaceStatus::Failed;
                        o.view.error = Some(if message.is_empty() {
                            code.clone()
                        } else {
                            message.clone()
                        });
                    }
                }
                o.view.clone()
            };
            self.emit(Ephemeral::FleetSpace { space: view });
            self.0.fleet.changed.notify_waiters();
        }
        if let Some(tx) = pending.tx.take() {
            let _ = tx.send(outcome);
        }
    }

    /// An event of a space this device follows.
    pub(crate) fn fleet_on_event(&self, space: &str, seq: u64, event: RemoteSpaceEvent) {
        let (view, line) = {
            let mut mem = self.fleet();
            let Some(o) = mem.outbound.get_mut(space) else {
                return;
            };
            if seq <= o.last_seq {
                return;
            }
            o.last_seq = seq;
            let v = &mut o.view;
            match &event {
                RemoteSpaceEvent::Started {
                    host_device,
                    project_name,
                    name,
                    branch,
                    mode,
                    parent,
                    depth,
                    ..
                } => {
                    v.host_device = host_device.clone();
                    v.project_name = project_name.clone();
                    v.name = name.clone();
                    v.branch = branch.clone();
                    v.mode = space_mode(*mode);
                    v.parent = parent.clone();
                    v.depth = *depth;
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
                        from: format!("{} · {}", v.host_name, v.name),
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
                | RemoteSpaceEvent::TurnEnded { .. }
                | RemoteSpaceEvent::Gap { .. } => {}
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

    /// A question from a space elsewhere, routed to this device.
    pub(crate) fn fleet_on_ask(&self, ask: RemoteAsk, via: AskVia) {
        let question = FleetQuestion {
            ask_id: ask.ask_id.clone(),
            space: ask.space.clone(),
            from: ask.from.clone(),
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
