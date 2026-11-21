//! Fleet, this device following a space that runs on another device
//! (docs/fleet.md "One space UI: mirrored rows"): the host's own `space`
//! and `chat_message` rows are kept here as ordinary rows with
//! `Space.remote` set, so the space UI works on them unchanged, and what
//! you do on such a space goes to its host.
//!
//! ```text
//! verified mirror{model, id, data} of a followed rs_ space
//!   space        ─▶ id = rs_, run under it ─▶ local-only fields blanked,
//!                   remote set ─▶ upsert (never over a local space)
//!   chat_message ─▶ pr = space:rs_, run under it ─▶ upsert / delete
//!   turn_step    ─▶ <run>:<n>, run under it ─▶ Ephemeral::RunStep (not kept)
//!   else         ─▶ dropped (debug log)
//! each event ─▶ kv fleet.follow:<rs_> {seq, …} (a space with a row)
//! start ─▶ Space rows with remote ─▶ followed again ─▶ subscribe{since: seq}
//!
//! send / send now / approve ─▶ fleet_send     stop ─▶ fleet_stop
//! answer ─▶ fleet_answer                      archive ─▶ stop if running,
//! anything local-only ─▶ "runs on <host>"       rows deleted, unsubscribed
//! ```

use std::collections::{HashMap, VecDeque};

use serde::{Deserialize, Serialize};
use theodore_contract::{
    ChatMessage, Ephemeral, FleetAnswerRequest, FleetLineKind, FleetRemoteSpace, FleetSendRequest,
    FleetSpaceLine, FleetSpaceStatus, Space, SpaceAnswerRequest, SpaceRemote, SpaceSendRequest,
    SpaceStatus, TurnStep, models,
};
use theodore_fleet_protocol::{ClientMessage, MIRROR_MODELS, MirroredSubSpace, SUB_SPACE_MODEL};
use theodore_ports::{NewAction, SyncActionCode};

use crate::core::Core;
use crate::error::{AppError, AppResult};
use crate::usecases::fleet::Outbound;
use crate::usecases::spaces::space_chat_key;

/// The mirrored model of a run's live steps (not a stored model).
pub(crate) const TURN_STEP: &str = "turn_step";

/// Where a followed space's bookkeeping is kept across restarts.
fn follow_key(space: &str) -> String {
    format!("fleet.follow:{space}")
}

/// What a restart needs to follow a mirrored space again: the last seq
/// seen (the resubscribe's `since`) and what the start asked for.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct FollowRecord {
    pub seq: u64,
    #[serde(default)]
    pub started_by: Option<String>,
    #[serde(default)]
    pub parent: Option<String>,
    #[serde(default)]
    pub depth: u32,
}

/// Refused here: a mirrored space's worktree, git, terminal and commands
/// are its host's.
pub(crate) fn runs_elsewhere(r: &SpaceRemote) -> AppError {
    AppError::Invalid(format!(
        "this space runs on {}: do that on {}",
        r.host_name, r.host_name
    ))
}

/// The run id prefix every run of mirrored space `space` has.
fn run_prefix(space: &str) -> String {
    format!("space:{space}:")
}

fn runs_under(run: &str, space: &str) -> bool {
    run.strip_prefix(&run_prefix(space))
        .is_some_and(|rest| !rest.is_empty())
}

/// The host's space row as kept here: what only the host can use is
/// blanked (whatever the host sent), `remote` says where it runs.
fn as_mirror(mut row: Space, remote: SpaceRemote, pinned: bool) -> Space {
    row.worktree = String::new();
    row.ports = Vec::new();
    row.agent_session = None;
    row.sent_feedback = Vec::new();
    row.review_pr = None;
    // Mirroring into a folder is the host's folder.
    row.mirror = None;
    // A process group on the host is nothing to reap here.
    if let Some(p) = &mut row.process {
        p.pgid = None;
        p.script = None;
    }
    row.remote = Some(remote);
    // Pinning is this device's own.
    row.pinned = pinned;
    row
}

fn ui_status(s: &Space) -> FleetSpaceStatus {
    match s.status {
        SpaceStatus::Running if s.question.is_some() => FleetSpaceStatus::Waiting,
        SpaceStatus::Running => FleetSpaceStatus::Running,
        SpaceStatus::Idle => FleetSpaceStatus::Idle,
        SpaceStatus::Failed => FleetSpaceStatus::Failed,
        SpaceStatus::Archived => FleetSpaceStatus::Stopped,
    }
}

/// A `turn_step` mirror's data: the step itself, or `{run, step}`.
#[derive(Deserialize)]
struct RunStepData {
    run: String,
    step: TurnStep,
}

impl Core {
    /// `id`'s `remote`, when it is a mirrored space.
    pub(crate) async fn space_remote_of(&self, id: &str) -> Option<SpaceRemote> {
        self.get_row(models::SPACE, id)
            .await
            .ok()
            .flatten()
            .and_then(|v| v.get("remote").cloned())
            .filter(|v| !v.is_null())
            .and_then(|v| serde_json::from_value(v).ok())
    }

    /// The space row, mirrored or not.
    pub(crate) async fn space_row_any(&self, id: &str) -> AppResult<Space> {
        let data = self
            .get_row(models::SPACE, id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("space {id}")))?;
        serde_json::from_value(data).map_err(|e| AppError::Invalid(e.to_string()))
    }

    // ── following ───────────────────────────────────────────────────────

    /// Once per process: every mirrored space in the store is followed
    /// again, from the last seq seen, so the next welcome resubscribes it.
    pub(crate) async fn fleet_load_followed(&self) {
        self.0
            .fleet
            .followed_loaded
            .get_or_init(|| async {
                let Ok(spaces) = self.list_spaces(None).await else {
                    return;
                };
                let me = self.fleet().device_id.clone().unwrap_or_default();
                let mut loaded: Vec<(Space, SpaceRemote, FollowRecord)> = Vec::new();
                for s in spaces {
                    let Some(r) = s.remote.clone() else { continue };
                    if r.space != s.id {
                        continue;
                    }
                    let store = self.0.deps.store.clone();
                    let key = follow_key(&s.id);
                    let rec = tokio::task::spawn_blocking(move || store.kv_get(&key))
                        .await
                        .ok()
                        .and_then(Result::ok)
                        .flatten()
                        .and_then(|v| serde_json::from_value::<FollowRecord>(v).ok())
                        .unwrap_or_default();
                    loaded.push((s, r, rec));
                }
                let n = loaded.len();
                let mut mem = self.fleet();
                for (s, r, rec) in loaded {
                    if mem.outbound.contains_key(&s.id) {
                        continue;
                    }
                    let view = FleetRemoteSpace {
                        space: s.id.clone(),
                        host_device: r.host_device.clone(),
                        host_name: r.host_name.clone(),
                        origin_device: me.clone(),
                        project_name: r.project_name.clone(),
                        name: s.name.clone(),
                        branch: s.branch.clone(),
                        status: ui_status(&s),
                        mode: s.mode,
                        depth: rec.depth,
                        parent: rec.parent.clone(),
                        last_reply: None,
                        question: None,
                        hosted_here: false,
                        local_space: None,
                        error: None,
                    };
                    mem.outbound.insert(
                        s.id.clone(),
                        Outbound {
                            view,
                            started_name: Some(s.name.clone()),
                            lines: VecDeque::new(),
                            last_seq: rec.seq,
                            started_by: rec.started_by,
                            agent_error: None,
                            mirrored: true,
                            live: Default::default(),
                        },
                    );
                }
                drop(mem);
                if n > 0 {
                    tracing::info!(spaces = n, "following mirrored fleet spaces again");
                }
            })
            .await;
    }

    /// Keeps `space`'s last seq (and what its start asked for) once it has
    /// a row here: a restart resubscribes from there.
    pub(crate) async fn fleet_keep_follow(&self, space: &str) {
        let rec = {
            let mem = self.fleet();
            match mem.outbound.get(space) {
                Some(o) if o.mirrored => FollowRecord {
                    seq: o.last_seq,
                    started_by: o.started_by.clone(),
                    parent: o.view.parent.clone(),
                    depth: o.view.depth,
                },
                _ => return,
            }
        };
        let store = self.0.deps.store.clone();
        let key = follow_key(space);
        let Ok(value) = serde_json::to_value(&rec) else {
            return;
        };
        match tokio::task::spawn_blocking(move || store.kv_set(&key, &value)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                tracing::warn!(error.code = e.code(), error = %e, "couldn't keep a followed fleet space")
            }
            Err(e) => {
                tracing::warn!(error.code = "app.internal", error = %e, "couldn't keep a followed fleet space")
            }
        }
    }

    /// Stops following `space`: its rows here go, the cloud stops sending.
    pub(crate) async fn fleet_forget_followed(&self, space: &str) -> AppResult<()> {
        let store = self.0.deps.store.clone();
        let key = space_chat_key(space).0;
        let chat =
            tokio::task::spawn_blocking(move || store.query(models::CHAT_MESSAGE, "pr", &key))
                .await
                .map_err(AppError::join)??;
        let mut actions: Vec<NewAction> = chat
            .into_iter()
            .map(|r| NewAction {
                model: models::CHAT_MESSAGE.into(),
                model_id: r.id,
                action: SyncActionCode::D,
                data: None,
            })
            .collect();
        actions.push(NewAction {
            model: models::SPACE.into(),
            model_id: space.to_string(),
            action: SyncActionCode::D,
            data: None,
        });
        self.apply(actions).await?;
        self.fleet().outbound.remove(space);
        let store = self.0.deps.store.clone();
        let key = follow_key(space);
        let _ =
            tokio::task::spawn_blocking(move || store.kv_set(&key, &serde_json::Value::Null)).await;
        self.fleet_send_msg(ClientMessage::Unsubscribe {
            space: space.to_string(),
        });
        self.0.fleet.changed.notify_waiters();
        tracing::info!(remote = %space, "stopped following a fleet space");
        Ok(())
    }

    // ── mirrored rows ───────────────────────────────────────────────────

    /// A verified `mirror` of followed space `space` (its host signed it).
    pub(crate) async fn fleet_apply_mirror(
        &self,
        space: &str,
        model: &str,
        id: &str,
        data: Option<serde_json::Value>,
    ) {
        if !MIRROR_MODELS.contains(&model) {
            tracing::debug!(remote = %space, model, "dropped a mirror of a model not mirrored");
            return;
        }
        let applied = match model {
            models::SPACE => self.fleet_mirror_space(space, id, data).await,
            models::CHAT_MESSAGE => self.fleet_mirror_chat(space, id, data).await,
            SUB_SPACE_MODEL => self.fleet_follow_sub_space(space, id, data),
            _ => self.fleet_follow_step(space, id, data).await,
        };
        match applied {
            Ok(()) => {}
            Err(Dropped::Invalid(why)) => {
                tracing::debug!(remote = %space, model, why, "dropped a mirrored row");
            }
            Err(Dropped::Store(e)) => {
                tracing::warn!(remote = %space, model, error.code = e.code(), error = %e, "couldn't keep a mirrored row");
            }
        }
    }

    /// A sub-space the followed space started on its host: a line of its
    /// history (`<id> · <title> · <status>`), at the event's seq.
    fn fleet_follow_sub_space(
        &self,
        space: &str,
        id: &str,
        data: Option<serde_json::Value>,
    ) -> Result<(), Dropped> {
        let text = match data {
            None => format!("{id} · gone"),
            Some(v) => {
                let s: MirroredSubSpace =
                    serde_json::from_value(v).map_err(|_| Dropped::Invalid("not a sub-space"))?;
                if s.space != id {
                    return Err(Dropped::Invalid("a sub-space row of another id"));
                }
                let title = crate::usecases::fleet_origin::truncate(&s.title, 120);
                let status = if s.done { "merged" } else { s.status.as_str() };
                format!("{id} · {title} · {status}")
            }
        };
        let line = {
            let mut mem = self.fleet();
            let o = mem
                .outbound
                .get_mut(space)
                .ok_or(Dropped::Invalid("a space not followed here"))?;
            let line = FleetSpaceLine {
                seq: o.last_seq,
                kind: FleetLineKind::SubSpace,
                text,
            };
            o.lines.push_back(line.clone());
            while o.lines.len() > crate::usecases::fleet_origin::LINES_KEPT {
                o.lines.pop_front();
            }
            line
        };
        self.emit(Ephemeral::FleetSpaceLine {
            space: space.to_string(),
            line,
        });
        Ok(())
    }

    /// What this device knows of `space` as its follower: where it runs.
    fn fleet_follow_remote(&self, space: &str) -> Option<SpaceRemote> {
        let mem = self.fleet();
        let o = mem.outbound.get(space)?;
        Some(SpaceRemote {
            space: space.to_string(),
            host_device: o.view.host_device.clone(),
            // As pinned here when it started, never what the host says.
            host_name: o.view.host_name.clone(),
            project_name: o.view.project_name.clone(),
            started_here: true,
        })
    }

    /// The stored row `id` of `model`, parsed.
    async fn fleet_stored<T: serde::de::DeserializeOwned>(
        &self,
        model: &str,
        id: &str,
    ) -> Result<Option<T>, Dropped> {
        match self.get_row(model, id).await {
            Ok(None) => Ok(None),
            Ok(Some(v)) => serde_json::from_value(v)
                .map(Some)
                .map_err(|_| Dropped::Invalid("the stored row doesn't parse")),
            Err(e) => Err(Dropped::Store(e)),
        }
    }

    /// A row `space` here must be a mirror of the same host's: a local
    /// space is never written over.
    async fn fleet_own_mirror(
        &self,
        space: &str,
        remote: &SpaceRemote,
    ) -> Result<Option<Space>, Dropped> {
        let existing: Option<Space> = self.fleet_stored(models::SPACE, space).await?;
        match existing.as_ref().map(|e| &e.remote) {
            None => Ok(None),
            Some(None) => Err(Dropped::Invalid("a local space has that id")),
            Some(Some(r)) if r.host_device != remote.host_device => {
                Err(Dropped::Invalid("another host's space has that id"))
            }
            Some(Some(_)) => Ok(existing),
        }
    }

    async fn fleet_mirror_space(
        &self,
        space: &str,
        id: &str,
        data: Option<serde_json::Value>,
    ) -> Result<(), Dropped> {
        if id != space {
            return Err(Dropped::Invalid("a space row of another space"));
        }
        let remote = self
            .fleet_follow_remote(space)
            .ok_or(Dropped::Invalid("a space not followed here"))?;
        let existing = self.fleet_own_mirror(space, &remote).await?;
        let Some(data) = data else {
            if existing.is_some() {
                self.apply(vec![NewAction {
                    model: models::SPACE.into(),
                    model_id: space.to_string(),
                    action: SyncActionCode::D,
                    data: None,
                }])
                .await
                .map_err(|e| Dropped::Store(e.into()))?;
            }
            return Ok(());
        };
        let row: Space =
            serde_json::from_value(data).map_err(|_| Dropped::Invalid("not a space row"))?;
        if row.id != space {
            return Err(Dropped::Invalid("a space row of another space"));
        }
        if row.run.as_deref().is_some_and(|r| !runs_under(r, space)) {
            return Err(Dropped::Invalid("a run of another space"));
        }
        let pinned = existing.is_some_and(|e| e.pinned);
        let row = as_mirror(row, remote, pinned);
        let value = serde_json::to_value(&row).map_err(|_| Dropped::Invalid("not a space row"))?;
        self.apply(vec![NewAction {
            model: models::SPACE.into(),
            model_id: space.to_string(),
            action: SyncActionCode::U,
            data: Some(value),
        }])
        .await
        .map_err(|e| Dropped::Store(e.into()))?;
        if let Some(o) = self.fleet().outbound.get_mut(space) {
            o.mirrored = true;
        }
        Ok(())
    }

    async fn fleet_mirror_chat(
        &self,
        space: &str,
        id: &str,
        data: Option<serde_json::Value>,
    ) -> Result<(), Dropped> {
        let remote = self
            .fleet_follow_remote(space)
            .ok_or(Dropped::Invalid("a space not followed here"))?;
        // No chat into a local space's transcript.
        self.fleet_own_mirror(space, &remote).await?;
        let key = space_chat_key(space);
        let existing: Option<ChatMessage> = self.fleet_stored(models::CHAT_MESSAGE, id).await?;
        if existing.as_ref().is_some_and(|m| m.pr != key) {
            return Err(Dropped::Invalid("a message of another chat has that id"));
        }
        let Some(data) = data else {
            if existing.is_some() {
                self.apply(vec![NewAction {
                    model: models::CHAT_MESSAGE.into(),
                    model_id: id.to_string(),
                    action: SyncActionCode::D,
                    data: None,
                }])
                .await
                .map_err(|e| Dropped::Store(e.into()))?;
            }
            return Ok(());
        };
        let message: ChatMessage =
            serde_json::from_value(data).map_err(|_| Dropped::Invalid("not a chat message"))?;
        if message.id != id {
            return Err(Dropped::Invalid("a message under another id"));
        }
        if message.pr != key {
            return Err(Dropped::Invalid("a message of another chat"));
        }
        if message
            .run
            .as_deref()
            .is_some_and(|r| !runs_under(r, space))
        {
            return Err(Dropped::Invalid("a reply of another space's run"));
        }
        let value =
            serde_json::to_value(&message).map_err(|_| Dropped::Invalid("not a chat message"))?;
        self.apply(vec![NewAction {
            model: models::CHAT_MESSAGE.into(),
            model_id: id.to_string(),
            action: SyncActionCode::U,
            data: Some(value),
        }])
        .await
        .map_err(|e| Dropped::Store(e.into()))?;
        Ok(())
    }

    /// A live step of a run: shown, never kept (a finished turn's steps
    /// are in its reply's `activity`). A step seen again is an update: a
    /// tool call's end goes as `RunStepDone`, the run's own text as the
    /// `AgentDelta` of what's new (a new text row after `RunTextBreak`), as
    /// the host's own UI gets them.
    async fn fleet_follow_step(
        &self,
        space: &str,
        id: &str,
        data: Option<serde_json::Value>,
    ) -> Result<(), Dropped> {
        let (run, n) = id
            .rsplit_once(':')
            .ok_or(Dropped::Invalid("a step id that isn't <run>:<n>"))?;
        if n.parse::<u64>().is_err() {
            return Err(Dropped::Invalid("a step id that isn't <run>:<n>"));
        }
        if !runs_under(run, space) {
            return Err(Dropped::Invalid("a step of another space's run"));
        }
        let data = data.ok_or(Dropped::Invalid("a step with nothing in it"))?;
        let step = match serde_json::from_value::<TurnStep>(data.clone()) {
            Ok(step) => step,
            Err(_) => {
                let wrapped: RunStepData = serde_json::from_value(data)
                    .map_err(|_| Dropped::Invalid("not a turn step"))?;
                if wrapped.run != run {
                    return Err(Dropped::Invalid("a step of another run"));
                }
                wrapped.step
            }
        };
        let own_text = matches!(&step, TurnStep::Text { parent: None, .. });
        let agent = if own_text {
            match self.space_row_any(space).await {
                Ok(s) => Some(s.agent),
                Err(_) => return Err(Dropped::Invalid("text of a space not kept here")),
            }
        } else {
            None
        };
        let out = {
            let mut mem = self.fleet();
            let Some(o) = mem.outbound.get_mut(space) else {
                return Err(Dropped::Invalid("a step of a space not followed here"));
            };
            // A new run: what the last one showed is done.
            if o.live
                .keys()
                .next()
                .is_some_and(|k| !k.starts_with(&format!("{run}:")))
            {
                o.live.clear();
            }
            live_out(&mut o.live, run, id, step, agent)
        };
        for e in out {
            self.emit(e);
        }
        Ok(())
    }

    // ── what you do on a mirrored space ─────────────────────────────────

    /// A message for a mirrored space: its next turn, on the host. Files
    /// stay here; an agent, model or effort picked goes along, for the
    /// host to check against what it lists (`fleet.agent_unavailable`).
    pub(crate) async fn remote_space_send(
        &self,
        r: &SpaceRemote,
        req: SpaceSendRequest,
    ) -> AppResult<String> {
        if req.attachments.as_ref().is_some_and(|a| !a.is_empty()) {
            return Err(AppError::Invalid(format!(
                "files can't be sent to a space on {}: send the message without them",
                r.host_name
            )));
        }
        if req.mentions.as_ref().is_some_and(|m| !m.is_empty()) {
            return Err(AppError::Invalid(format!(
                "other spaces can't be mentioned to a space on {}: send the message without them",
                r.host_name
            )));
        }
        self.fleet_load_followed().await;
        self.fleet_send(FleetSendRequest {
            space: r.space.clone(),
            text: req.text,
            mode: req.mode,
            agent: req.agent,
            model: req.model,
            effort: req.effort,
        })
        .await?;
        crate::usecases::telemetry::space_action("fleet_send");
        // The message's row comes from the host.
        Ok(String::new())
    }

    pub(crate) async fn remote_space_stop(&self, r: &SpaceRemote) -> AppResult<()> {
        self.fleet_load_followed().await;
        self.fleet_stop(&r.space).await
    }

    pub(crate) async fn remote_space_answer(
        &self,
        r: &SpaceRemote,
        req: SpaceAnswerRequest,
    ) -> AppResult<()> {
        self.fleet_load_followed().await;
        let answers = req
            .answers
            .into_iter()
            .map(|a| match a.other.filter(|o| !o.trim().is_empty()) {
                Some(other) => vec![other],
                None => a.selected,
            })
            .collect();
        self.fleet_answer(FleetAnswerRequest {
            space: r.space.clone(),
            ask_id: req.question,
            answers,
        })
        .await
    }

    /// Approve on a mirrored space's plan card: its next turn, on the
    /// host, in the build mode.
    pub(crate) async fn remote_approve_plan(&self, r: &SpaceRemote) -> AppResult<String> {
        use crate::usecases::space_plan::{APPROVED_TEXT, build_mode};
        let row = self.space_row_any(&r.space).await?;
        if row.status == SpaceStatus::Running {
            return Err(AppError::Invalid(
                "the agent is still working in this space".into(),
            ));
        }
        if !row
            .turn_log
            .iter()
            .rev()
            .find(|t| !t.undone)
            .is_some_and(|t| t.plan.is_some())
        {
            return Err(AppError::Invalid(
                "the last turn has no plan to approve".into(),
            ));
        }
        self.remote_space_send(
            r,
            SpaceSendRequest {
                space: r.space.clone(),
                text: APPROVED_TEXT.into(),
                agent: None,
                model: None,
                mode: Some(build_mode(row.build_mode)),
                attachments: None,
                effort: None,
                mentions: None,
            },
        )
        .await
    }

    /// Archive on a mirrored space: a running turn is stopped on the host
    /// (best effort), then this device forgets its copy and unfollows.
    pub(crate) async fn remote_space_archive(&self, r: &SpaceRemote) -> AppResult<()> {
        let row = self.space_row_any(&r.space).await?;
        if row.status == SpaceStatus::Running || row.run.is_some() {
            self.fleet_load_followed().await;
            if let Err(e) = self.fleet_stop(&r.space).await {
                tracing::warn!(remote = %r.space, error.code = e.code(), error = %e, "couldn't stop a fleet space before forgetting it");
            }
        }
        self.fleet_forget_followed(&r.space).await?;
        crate::usecases::telemetry::space_action("fleet_forget");
        Ok(())
    }
}

/// Why a mirrored row wasn't kept.
enum Dropped {
    /// Not what the host may send: dropped, a debug line.
    Invalid(&'static str),
    /// The store failed.
    Store(AppError),
}

/// What showing live step `id` of `run` takes, given what `o` showed so far.
fn live_out(
    live: &mut HashMap<String, crate::usecases::fleet::LiveStep>,
    run: &str,
    id: &str,
    step: TurnStep,
    agent: Option<theodore_domain::AgentId>,
) -> Vec<Ephemeral> {
    use crate::usecases::fleet::LiveStep;
    let run = run.to_string();
    match (live.get_mut(id), step) {
        (None, TurnStep::Text { text, parent: None }) => {
            let Some(agent) = agent else {
                return vec![];
            };
            let had_text = live.values().any(|l| matches!(l, LiveStep::Text(_)));
            live.insert(id.to_string(), LiveStep::Text(text.clone()));
            let mut out = Vec::new();
            if had_text {
                out.push(Ephemeral::RunTextBreak { run: run.clone() });
            }
            if !text.is_empty() {
                out.push(Ephemeral::AgentDelta { run, agent, text });
            }
            out
        }
        (None, step) => {
            let seen = match &step {
                TurnStep::Tool { id, .. } => LiveStep::Tool(id.clone()),
                _ => LiveStep::Other,
            };
            live.insert(id.to_string(), seen);
            vec![Ephemeral::RunStep { run, step }]
        }
        (Some(LiveStep::Text(shown)), TurnStep::Text { text, .. }) => {
            // Only what follows what was shown; a cut or rewritten text
            // waits for the reply.
            let Some(more) = text.strip_prefix(shown.as_str()).filter(|m| !m.is_empty()) else {
                return vec![];
            };
            let Some(agent) = agent else {
                return vec![];
            };
            let more = more.to_string();
            *shown = text;
            vec![Ephemeral::AgentDelta {
                run,
                agent,
                text: more,
            }]
        }
        (
            Some(LiveStep::Tool(Some(call))),
            TurnStep::Tool {
                ok,
                summary,
                background,
                ..
            },
        ) => vec![Ephemeral::RunStepDone {
            run,
            id: call.clone(),
            ok,
            summary,
            background,
        }],
        _ => vec![],
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::usecases::fleet::LiveStep;
    use theodore_domain::AgentId;

    const RUN: &str = "space:rs_1:m1";

    fn text(t: &str) -> TurnStep {
        TurnStep::Text {
            text: t.into(),
            parent: None,
        }
    }

    fn tool(ok: Option<bool>) -> TurnStep {
        TurnStep::Tool {
            name: "Bash".into(),
            target: Some("ls".into()),
            ok,
            id: Some("t1".into()),
            parent: None,
            detail: None,
            summary: ok.map(|_| "2 files".into()),
            added: None,
            removed: None,
            background: false,
        }
    }

    fn deltas(out: &[Ephemeral]) -> Vec<String> {
        out.iter()
            .filter_map(|e| match e {
                Ephemeral::AgentDelta { text, .. } => Some(text.clone()),
                Ephemeral::RunTextBreak { .. } => Some("|".into()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn the_runs_text_streams_as_deltas_of_whats_new() {
        let mut live: HashMap<String, LiveStep> = HashMap::new();
        let a = Some(AgentId::Claude);
        let id = format!("{RUN}:0");
        assert_eq!(
            deltas(&live_out(&mut live, RUN, &id, text("Hel"), a)),
            ["Hel"]
        );
        assert_eq!(
            deltas(&live_out(&mut live, RUN, &id, text("Hello"), a)),
            ["lo"]
        );
        // Same again, or rewritten: nothing.
        assert!(live_out(&mut live, RUN, &id, text("Hello"), a).is_empty());
        assert!(live_out(&mut live, RUN, &id, text("Bye"), a).is_empty());
        // A second text row starts with a break.
        let id2 = format!("{RUN}:2");
        assert_eq!(
            deltas(&live_out(&mut live, RUN, &id2, text("Next"), a)),
            ["|", "Next"]
        );
    }

    #[test]
    fn a_tool_seen_again_is_its_end() {
        let mut live: HashMap<String, LiveStep> = HashMap::new();
        let id = format!("{RUN}:1");
        let out = live_out(&mut live, RUN, &id, tool(None), None);
        assert!(matches!(&out[..], [Ephemeral::RunStep { .. }]));
        let out = live_out(&mut live, RUN, &id, tool(Some(true)), None);
        match &out[..] {
            [
                Ephemeral::RunStepDone {
                    id, ok, summary, ..
                },
            ] => {
                assert_eq!(id, "t1");
                assert_eq!(*ok, Some(true));
                assert_eq!(summary.as_deref(), Some("2 files"));
            }
            other => panic!("{other:?}"),
        }
    }
}
