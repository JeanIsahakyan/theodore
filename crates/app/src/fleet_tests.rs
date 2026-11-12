//! Fleet (docs/fleet.md) against `Core` + `testkit::FakeFleet`: the trust
//! gate and its refusals in order, nothing running before a claim, hosted
//! spaces and their journal, questions both ways, spaces started from here,
//! the link following the account, and the agent's fleet tools.

use std::collections::BTreeMap;
use std::future::Future;
use std::time::Duration;

use serde_json::json;
use theodore_contract::{
    AddProjectRequest, Ephemeral, FleetSettingsRequest, FleetSpaceStatus, FleetStartRequest,
    FleetTrustRequest, Project, Space, SpaceAnswerItem, SpaceAnswerRequest, SpaceMode, SpaceStatus,
    models,
};
use theodore_domain::{Sha, Usage};
use theodore_fleet_protocol::{
    ClientMessage, DeviceInfo, DeviceKey, DeviceKind, DeviceOs, DeviceSummary, FleetMode,
    ProjectRef, REQUEST_WINDOW_MS, RemoteOp, RemoteQuestion, RemoteRequest, RemoteSpaceEvent,
    RemoteSpaceStatus, ReplyOutcome, ServerMessage, SignedEnvelope, StartedSpace, TurnOutcome,
    codes, fingerprint, fresh,
};
use theodore_ports::{
    AccountSession, AgentEvent, Clock, FleetHostedRow, FleetInbound, Secrets, Store, UserQuestion,
};

use crate::testkit::{FakeFleetCommand, Fixtures, fixtures, sample_account_session};
use crate::{Core, Deps, Receivers};

const CLOUD: &str = "https://cloud.example";
const ME: &str = "dev_me";
const ORIGIN: &str = "dev_o";
const TARGET: &str = "dev_t";
const GENERATION: u64 = 7;

async fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
    for _ in 0..600 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("not in time: {what}");
}

async fn eventually<F, Fut>(what: &str, mut cond: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    for _ in 0..600 {
        if cond().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("not in time: {what}");
}

fn session(f: &Fixtures, refresh: &str, org: &str) -> AccountSession {
    AccountSession {
        organization_id: Some(org.into()),
        role: Some("admin".into()),
        ..sample_account_session(refresh, f.clock.now() + 300_000)
    }
}

/// Signed in, in `org_a`, with a cloud; the fleet off until a test turns it on.
fn start(f: &Fixtures) -> (Core, Receivers) {
    f.secrets
        .set(
            theodore_secrets::THEODORE_ACCOUNT,
            &serde_json::to_string(&session(f, "rt_1", "org_a")).unwrap(),
        )
        .unwrap();
    let deps = Deps {
        account_client_id: Some("client_01TEST".into()),
        account_cloud_url: Some(CLOUD.into()),
        ..f.deps_with_fleet()
    };
    Core::start(deps)
}

async fn project(f: &Fixtures, core: &Core) -> Project {
    let project = core
        .add_project(AddProjectRequest {
            repo: None,
            path: Some("/tmp/fleet-app".into()),
        })
        .await
        .expect("add_project");
    wait_until("the project is ready", || {
        f.store
            .get(models::PROJECT, &project.id)
            .unwrap()
            .is_some_and(|r| r.data["status"] == json!("ready"))
    })
    .await;
    f.git.set_resolve("main", Sha::new("base000"));
    project
}

fn summary(id: &str, key: &DeviceKey, name: &str, projects: Vec<ProjectRef>) -> DeviceSummary {
    DeviceSummary {
        device_id: id.into(),
        info: DeviceInfo {
            name: name.into(),
            os: DeviceOs::Macos,
            kind: DeviceKind::Desktop,
            app_version: "0.1.0".into(),
            accepts_remote: !projects.is_empty(),
            projects,
            max_mode: FleetMode::Edit,
        },
        online: true,
        last_seen_ms: 0,
        public_key: key.public_key(),
    }
}

fn settings(accept: bool) -> FleetSettingsRequest {
    FleetSettingsRequest {
        enabled: Some(true),
        accept_remote: Some(accept),
        max_mode: None,
        name: Some("mac2".into()),
    }
}

/// The fleet on, link 0 connected as `ME`, the user's devices listed.
async fn connect(f: &Fixtures, core: &Core, accept: bool, devices: Vec<DeviceSummary>) {
    core.fleet_set_settings(settings(accept)).await.unwrap();
    wait_until("a link", || f.fleet.starts() == 1).await;
    f.fleet.push(FleetInbound::Connected {
        device_id: ME.into(),
        generation: GENERATION,
        resume: BTreeMap::new(),
    });
    wait_until("connected", || core.fleet_tools_available()).await;
    let n = devices.len();
    f.fleet
        .push(FleetInbound::Message(ServerMessage::Devices { devices }));
    eventually("the devices", || async {
        core.fleet_status().await.unwrap().devices.len() == n
    })
    .await;
}

async fn trust(core: &Core, device: &str) {
    core.fleet_trust_device(FleetTrustRequest {
        device_id: device.into(),
        trusted: true,
    })
    .await
    .unwrap();
}

fn now(f: &Fixtures) -> u64 {
    f.clock.now() as u64
}

fn sealed(key: &DeviceKey, op: RemoteOp, at: u64) -> (String, SignedEnvelope) {
    let req = RemoteRequest {
        req_id: uuid::Uuid::new_v4().to_string(),
        origin_device: ORIGIN.into(),
        target_device: ME.into(),
        issued_at_ms: at,
        op,
    };
    (req.req_id.clone(), SignedEnvelope::seal(&req, key))
}

fn deliver(f: &Fixtures, envelope: SignedEnvelope) {
    f.fleet.push(FleetInbound::Message(ServerMessage::Request {
        envelope,
        generation: GENERATION,
    }));
}

fn claim_result(f: &Fixtures, req_id: &str, claimed: bool) {
    f.fleet
        .push(FleetInbound::Message(ServerMessage::ClaimResult {
            req_id: req_id.into(),
            claimed,
            rejection: (!claimed).then(|| "claimed by another connection".into()),
        }));
}

fn reply_of(f: &Fixtures, req_id: &str) -> Option<ReplyOutcome> {
    f.fleet.sent().into_iter().find_map(|m| match m {
        ClientMessage::Reply { req_id: r, outcome } if r == req_id => Some(outcome),
        _ => None,
    })
}

fn claimed(f: &Fixtures, req_id: &str) -> bool {
    f.fleet.sent().into_iter().any(|m| {
        matches!(m, ClientMessage::Claim { req_id: r, generation } if r == req_id && generation == GENERATION)
    })
}

async fn refusal(f: &Fixtures, req_id: &str) -> String {
    wait_until("a reply", || reply_of(f, req_id).is_some()).await;
    match reply_of(f, req_id).unwrap() {
        ReplyOutcome::Err { code, .. } => code,
        ok => panic!("expected a refusal, got {ok:?}"),
    }
}

/// Delivers a request and, once claimed, the cloud's yes; its reply.
async fn run(f: &Fixtures, key: &DeviceKey, op: RemoteOp) -> ReplyOutcome {
    let (id, env) = sealed(key, op, now(f));
    deliver(f, env);
    wait_until("the claim", || {
        claimed(f, &id) || reply_of(f, &id).is_some()
    })
    .await;
    if reply_of(f, &id).is_none() {
        claim_result(f, &id, true);
    }
    wait_until("the reply", || reply_of(f, &id).is_some()).await;
    reply_of(f, &id).unwrap()
}

fn start_op(project: &str, space: &str) -> RemoteOp {
    start_with(project, space, FleetMode::Edit, None, 0)
}

fn start_with(
    project: &str,
    space: &str,
    mode: FleetMode,
    parent: Option<&str>,
    depth: u32,
) -> RemoteOp {
    RemoteOp::StartSpace {
        space: space.into(),
        project_id: project.into(),
        goal: "Fix it".into(),
        mode,
        agent: None,
        model: None,
        parent: parent.map(str::to_string),
        depth,
    }
}

fn events(f: &Fixtures, space: &str) -> Vec<(u64, RemoteSpaceEvent)> {
    f.fleet
        .sent()
        .into_iter()
        .filter_map(|m| match m {
            ClientMessage::SpaceEvent {
                space: s,
                seq,
                event,
            } if s == space => Some((seq, event)),
            _ => None,
        })
        .collect()
}

fn space(f: &Fixtures, id: &str) -> Space {
    serde_json::from_value(f.store.get(models::SPACE, id).unwrap().unwrap().data).unwrap()
}

fn done(text: &str) -> Vec<AgentEvent> {
    vec![AgentEvent::Done {
        final_text: text.into(),
        usage: Usage {
            input_tokens: 1,
            output_tokens: 1,
            usd: 0.0,
        },
    }]
}

/// The local space hosted as `remote`.
fn local_of(f: &Fixtures, remote: &str) -> String {
    f.store
        .fleet_hosted_all()
        .unwrap()
        .into_iter()
        .find(|r| r.space == remote)
        .expect("hosted")
        .local_space
}

/// Connected, accepting, `ORIGIN` trusted: what a target needs.
async fn target(f: &Fixtures) -> (Core, Receivers, Project, DeviceKey) {
    let (core, recv) = start(f);
    let project = project(f, &core).await;
    let origin = DeviceKey::generate().unwrap();
    connect(
        f,
        &core,
        true,
        vec![summary(ORIGIN, &origin, "mac1", vec![])],
    )
    .await;
    trust(&core, ORIGIN).await;
    (core, recv, project, origin)
}

// ── the gate ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_gate_refuses_in_order() {
    let f = fixtures();
    let (core, mut recv) = start(&f);
    let project = project(&f, &core).await;
    let origin = DeviceKey::generate().unwrap();
    connect(
        &f,
        &core,
        false,
        vec![summary(ORIGIN, &origin, "mac1", vec![])],
    )
    .await;
    let start = |at| sealed(&origin, start_op(&project.id, "rs_1"), at);

    // For another device.
    let mut req = RemoteRequest {
        req_id: "r-other".into(),
        origin_device: ORIGIN.into(),
        target_device: "dev_else".into(),
        issued_at_ms: now(&f),
        op: start_op(&project.id, "rs_1"),
    };
    deliver(&f, SignedEnvelope::seal(&req, &origin));
    assert_eq!(refusal(&f, "r-other").await, codes::NOT_YOURS);

    // Remote requests off.
    let (id, env) = start(now(&f));
    deliver(&f, env);
    assert_eq!(refusal(&f, &id).await, codes::REMOTE_OFF);

    // Untrusted: refused, and "Trust mac1?" shown.
    core.fleet_set_settings(settings(true)).await.unwrap();
    while recv.ephemeral.try_recv().is_ok() {}
    let (id, env) = start(now(&f));
    deliver(&f, env);
    assert_eq!(refusal(&f, &id).await, codes::UNTRUSTED_DEVICE);
    let mut asked = None;
    while let Ok(e) = recv.ephemeral.try_recv() {
        if let Ephemeral::FleetTrustNeeded { request } = e {
            asked = Some(request);
        }
    }
    let asked = asked.expect("FleetTrustNeeded");
    assert_eq!(asked.device_id, ORIGIN);
    assert_eq!(asked.device_name, "mac1");
    assert_eq!(asked.fingerprint, fingerprint(&origin.public_key()));

    // Trusted, but signed by another key.
    trust(&core, ORIGIN).await;
    let forged = DeviceKey::generate().unwrap();
    req.req_id = "r-forged".into();
    req.target_device = ME.into();
    deliver(&f, SignedEnvelope::seal(&req, &forged));
    assert_eq!(refusal(&f, "r-forged").await, codes::BAD_SIGNATURE);

    // Too old.
    let (id, env) = start(now(&f) - REQUEST_WINDOW_MS - 1);
    deliver(&f, env);
    assert_eq!(refusal(&f, &id).await, codes::STALE_REQUEST);

    // Above the mode cap (Edit by default).
    let (id, env) = sealed(
        &origin,
        start_with(&project.id, "rs_1", FleetMode::Run, None, 0),
        now(&f),
    );
    deliver(&f, env);
    assert_eq!(refusal(&f, &id).await, codes::MODE_NOT_ALLOWED);

    // A project this device doesn't have.
    let (id, env) = sealed(&origin, start_op("local:nope", "rs_1"), now(&f));
    deliver(&f, env);
    assert_eq!(refusal(&f, &id).await, codes::UNKNOWN_PROJECT);

    // Too deep.
    let (id, env) = sealed(
        &origin,
        start_with(&project.id, "rs_1", FleetMode::Edit, Some("rs_p"), 3),
        now(&f),
    );
    deliver(&f, env);
    assert_eq!(refusal(&f, &id).await, codes::DEPTH);

    // A space it doesn't host.
    let (id, env) = sealed(
        &origin,
        RemoteOp::Stop {
            space: "rs_ghost".into(),
        },
        now(&f),
    );
    deliver(&f, env);
    assert_eq!(refusal(&f, &id).await, codes::UNKNOWN_SPACE);

    // Nothing was claimed, nothing was made.
    assert!(
        !f.fleet
            .sent()
            .iter()
            .any(|m| matches!(m, ClientMessage::Claim { .. }))
    );
    assert!(core.list_spaces(None).await.unwrap().is_empty());
}

#[tokio::test]
async fn nothing_runs_before_the_claim_and_a_rejected_claim_runs_nothing() {
    let f = fixtures();
    let (core, _recv, project, origin) = target(&f).await;

    let (id, env) = sealed(&origin, start_op(&project.id, "rs_1"), now(&f));
    deliver(&f, env.clone());
    wait_until("the claim", || claimed(&f, &id)).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(core.list_spaces(None).await.unwrap().is_empty());

    claim_result(&f, &id, false);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(core.list_spaces(None).await.unwrap().is_empty());
    assert_eq!(reply_of(&f, &id), None);

    // The same request again is a replay.
    deliver(&f, env);
    assert_eq!(refusal(&f, &id).await, codes::STALE_REQUEST);

    // A new one, claimed: runs.
    let reply = run(&f, &origin, start_op(&project.id, "rs_2")).await;
    assert!(matches!(reply, ReplyOutcome::Ok { .. }), "{reply:?}");
    assert_eq!(core.list_spaces(None).await.unwrap().len(), 1);
}

#[tokio::test]
async fn a_run_request_is_refused_as_a_replay_after_it_ran() {
    let f = fixtures();
    let (_core, _recv, project, origin) = target(&f).await;
    let (id, env) = sealed(&origin, start_op(&project.id, "rs_1"), now(&f));
    deliver(&f, env.clone());
    wait_until("the claim", || claimed(&f, &id)).await;
    claim_result(&f, &id, true);
    wait_until("the reply", || reply_of(&f, &id).is_some()).await;
    let before = f.fleet.sent().len();
    deliver(&f, env);
    wait_until("a second reply", || f.fleet.sent().len() > before).await;
    let again = f.fleet.sent()[before..]
        .iter()
        .find_map(|m| match m {
            ClientMessage::Reply { outcome, .. } => Some(outcome.clone()),
            _ => None,
        })
        .unwrap();
    assert!(
        matches!(&again, ReplyOutcome::Err { code, .. } if code == codes::STALE_REQUEST),
        "{again:?}"
    );
}

#[tokio::test]
async fn a_parent_with_five_children_starts_no_sixth() {
    let f = fixtures();
    for i in 0..5 {
        f.store
            .fleet_hosted_put(&FleetHostedRow {
                space: format!("rs_c{i}"),
                local_space: format!("gone{i}"),
                origin_device: ORIGIN.into(),
                parent: Some("rs_p".into()),
                depth: 1,
                created_at: 0,
                data: json!({"mode": "edit", "project_id": "p", "project_name": "p", "name": "n", "branch": "b"}),
            })
            .unwrap();
    }
    let (_core, _recv, project, origin) = target(&f).await;
    let (id, env) = sealed(
        &origin,
        start_with(&project.id, "rs_6", FleetMode::Edit, Some("rs_p"), 1),
        now(&f),
    );
    deliver(&f, env);
    assert_eq!(refusal(&f, &id).await, codes::DEPTH);
}

// ── hosted spaces ─────────────────────────────────────────────────────────

#[tokio::test]
async fn a_started_space_is_mapped_and_its_events_journaled_in_order() {
    let f = fixtures();
    let (core, _recv, project, origin) = target(&f).await;
    f.agents.push_script(done("All fixed"));

    let reply = run(&f, &origin, start_op(&project.id, "rs_1")).await;
    let ReplyOutcome::Ok { value } = reply else {
        panic!("{reply:?}")
    };
    let started: StartedSpace = serde_json::from_value(value).unwrap();
    assert_eq!(started.space, "rs_1");

    let spaces = core.list_spaces(None).await.unwrap();
    assert_eq!(spaces.len(), 1);
    let s = &spaces[0];
    assert_eq!(s.project, project.id);
    assert_eq!(s.goal, "Fix it");
    assert_eq!(s.mode, SpaceMode::Edit);
    assert_eq!(started.branch, s.branch);
    let row = f.store.fleet_hosted_all().unwrap().remove(0);
    assert_eq!(
        (row.local_space.as_str(), row.origin_device.as_str()),
        (s.id.as_str(), ORIGIN)
    );
    assert_eq!((row.parent, row.depth), (None, 0));

    wait_until("the turn's end", || {
        events(&f, "rs_1").iter().any(|(_, e)| {
            matches!(
                e,
                RemoteSpaceEvent::Status {
                    status: RemoteSpaceStatus::Idle
                }
            )
        })
    })
    .await;
    let evs = events(&f, "rs_1");
    let seqs: Vec<u64> = evs.iter().map(|(s, _)| *s).collect();
    assert_eq!(seqs, (1..=evs.len() as u64).collect::<Vec<_>>());
    let RemoteSpaceEvent::Started {
        host_device,
        origin_device,
        project_id,
        mode,
        ..
    } = &evs[0].1
    else {
        panic!("first: {:?}", evs[0])
    };
    assert_eq!(
        (
            host_device.as_str(),
            origin_device.as_str(),
            project_id.as_str(),
            *mode
        ),
        (ME, ORIGIN, project.id.as_str(), FleetMode::Edit)
    );
    let kinds: Vec<&RemoteSpaceEvent> = evs.iter().map(|(_, e)| e).collect();
    assert!(
        kinds.iter().any(
            |e| matches!(e, RemoteSpaceEvent::TurnStarted { turn: 1, text } if text == "Fix it")
        )
    );
    assert!(kinds.iter().any(
        |e| matches!(e, RemoteSpaceEvent::Reply { turn: 1, text } if text.contains("All fixed"))
    ));
    assert!(kinds.iter().any(|e| matches!(
        e,
        RemoteSpaceEvent::TurnEnded {
            turn: 1,
            outcome: TurnOutcome::Done,
            ..
        }
    )));
    // Journaled as sent.
    let journal = f.store.fleet_journal_since("rs_1", 0, 100).unwrap();
    assert_eq!(journal.len(), evs.len());

    let listed = core.fleet_spaces().await.unwrap();
    let hosted = listed.iter().find(|v| v.space == "rs_1").unwrap();
    assert!(hosted.hosted_here);
    assert_eq!(hosted.local_space.as_deref(), Some(s.id.as_str()));
    assert_eq!(hosted.status, FleetSpaceStatus::Idle);
    assert!(
        hosted
            .last_reply
            .as_deref()
            .is_some_and(|r| r.contains("All fixed"))
    );
    let lines = core.fleet_space_lines("rs_1", 1).await.unwrap();
    assert_eq!(lines.len(), evs.len() - 1);

    // A reconnect replays what the cloud lacks.
    f.fleet.push(FleetInbound::Disconnected {
        reason: "gone".into(),
        retry_in_ms: 500,
    });
    wait_until("disconnected", || !core.fleet_tools_available()).await;
    let before = f.fleet.sent().len();
    f.fleet.push(FleetInbound::Connected {
        device_id: ME.into(),
        generation: GENERATION + 1,
        resume: BTreeMap::from([("rs_1".to_string(), 2)]),
    });
    let last = evs.len() as u64;
    wait_until("the replay", || {
        f.fleet.sent()[before..].iter().any(
            |m| matches!(m, ClientMessage::SpaceEvent { space, seq, .. } if space == "rs_1" && *seq == last),
        )
    })
    .await;
    let replayed: Vec<u64> = f.fleet.sent()[before..]
        .iter()
        .filter_map(|m| match m {
            ClientMessage::SpaceEvent { space, seq, .. } if space == "rs_1" => Some(*seq),
            _ => None,
        })
        .collect();
    assert_eq!(replayed, (3..=last).collect::<Vec<_>>());
}

#[tokio::test]
async fn send_and_stop_steer_a_hosted_space() {
    let f = fixtures();
    let (core, _recv, project, origin) = target(&f).await;
    f.agents.push_script(done("one"));
    run(&f, &origin, start_op(&project.id, "rs_1")).await;
    let local = local_of(&f, "rs_1");
    wait_until("turn 1 ended", || {
        events(&f, "rs_1")
            .iter()
            .any(|(_, e)| matches!(e, RemoteSpaceEvent::TurnEnded { turn: 1, .. }))
    })
    .await;
    wait_until("idle", || space(&f, &local).status == SpaceStatus::Idle).await;

    // Above the cap, refused before it's claimed.
    let (id, env) = sealed(
        &origin,
        RemoteOp::Send {
            space: "rs_1".into(),
            text: "go".into(),
            mode: Some(FleetMode::Run),
        },
        now(&f),
    );
    deliver(&f, env);
    assert_eq!(refusal(&f, &id).await, codes::MODE_NOT_ALLOWED);

    f.agents.hang_next_run();
    let sent = run(
        &f,
        &origin,
        RemoteOp::Send {
            space: "rs_1".into(),
            text: "next".into(),
            mode: None,
        },
    )
    .await;
    assert!(matches!(sent, ReplyOutcome::Ok { .. }), "{sent:?}");
    wait_until("turn 2 started", || {
        events(&f, "rs_1").iter().any(
            |(_, e)| matches!(e, RemoteSpaceEvent::TurnStarted { turn: 2, text } if text == "next"),
        )
    })
    .await;
    assert_eq!(space(&f, &local).status, SpaceStatus::Running);

    let stopped = run(
        &f,
        &origin,
        RemoteOp::Stop {
            space: "rs_1".into(),
        },
    )
    .await;
    assert!(matches!(stopped, ReplyOutcome::Ok { .. }), "{stopped:?}");
    wait_until("turn 2 stopped", || {
        events(&f, "rs_1").iter().any(|(_, e)| {
            matches!(
                e,
                RemoteSpaceEvent::TurnEnded {
                    turn: 2,
                    outcome: TurnOutcome::Stopped,
                    ..
                }
            )
        })
    })
    .await;
    wait_until("idle again", || {
        space(&f, &local).status == SpaceStatus::Idle
    })
    .await;
    let _ = core;
}

fn which_store() -> Vec<UserQuestion> {
    vec![UserQuestion {
        question: "Which store?".into(),
        options: vec!["SQLite".into(), "Postgres".into()],
        multi: false,
    }]
}

fn asks(f: &Fixtures) -> Vec<theodore_fleet_protocol::RemoteAsk> {
    f.fleet
        .sent()
        .into_iter()
        .filter_map(|m| match m {
            ClientMessage::Ask { ask } => Some(ask),
            _ => None,
        })
        .collect()
}

fn resolved(f: &Fixtures, ask_id: &str) -> bool {
    f.fleet
        .sent()
        .iter()
        .any(|m| matches!(m, ClientMessage::AskResolved { ask_id: a } if a == ask_id))
}

#[tokio::test]
async fn a_hosted_question_goes_out_and_is_answered_from_either_side() {
    let f = fixtures();
    let (core, _recv, project, origin) = target(&f).await;
    f.agents.hang_next_run();
    run(&f, &origin, start_op(&project.id, "rs_1")).await;
    let local = local_of(&f, "rs_1");
    wait_until("running", || space(&f, &local).run.is_some()).await;
    let run_id = space(&f, &local).run.unwrap();

    let asking = tokio::spawn({
        let (core, local, run_id) = (core.clone(), local.clone(), run_id.clone());
        async move { core.space_tool_ask(&local, &run_id, which_store()).await }
    });
    wait_until("the ask", || !asks(&f).is_empty()).await;
    let ask = asks(&f).remove(0);
    // The local card, as always.
    let q = space(&f, &local).question.expect("the card");
    assert_eq!(ask.ask_id, q.id);
    assert_eq!(ask.space, "rs_1");
    assert_eq!(ask.host_device, ME);
    assert_eq!(ask.from, format!("mac2 · {}", space(&f, &local).name));
    assert_eq!(
        ask.questions,
        vec![RemoteQuestion {
            question: "Which store?".into(),
            options: vec!["SQLite".into(), "Postgres".into()],
            multi: false,
        }]
    );
    assert!(events(&f, "rs_1").iter().any(|(_, e)| matches!(
        e,
        RemoteSpaceEvent::Status {
            status: RemoteSpaceStatus::Waiting
        }
    )));

    // Answers that don't fit are refused; so is another set's id.
    let answer = |ask_id: &str, picks: Vec<Vec<&str>>| RemoteOp::Answer {
        space: "rs_1".into(),
        ask_id: ask_id.into(),
        answers: picks
            .into_iter()
            .map(|a| a.into_iter().map(str::to_string).collect())
            .collect(),
    };
    let (id, env) = sealed(
        &origin,
        answer(&ask.ask_id, vec![vec!["SQLite", "Postgres"]]),
        now(&f),
    );
    deliver(&f, env);
    assert_eq!(refusal(&f, &id).await, codes::INVALID);
    let (id, env) = sealed(&origin, answer("nope", vec![vec!["SQLite"]]), now(&f));
    deliver(&f, env);
    assert_eq!(refusal(&f, &id).await, codes::UNKNOWN_SPACE);

    // A fitting one resolves the same question.
    let ok = run(&f, &origin, answer(&ask.ask_id, vec![vec!["SQLite"]])).await;
    assert!(matches!(ok, ReplyOutcome::Ok { .. }), "{ok:?}");
    let answers = asking.await.unwrap().unwrap();
    assert_eq!(answers[0].selected, ["SQLite"]);
    wait_until("resolved", || resolved(&f, &ask.ask_id)).await;
    assert_eq!(space(&f, &local).question, None);

    // Answered here: resolved for the fleet too. "Other" text works remotely.
    let asking = tokio::spawn({
        let (core, local, run_id) = (core.clone(), local.clone(), run_id.clone());
        async move { core.space_tool_ask(&local, &run_id, which_store()).await }
    });
    wait_until("the second ask", || asks(&f).len() == 2).await;
    let second = asks(&f).remove(1);
    core.answer_space_question(SpaceAnswerRequest {
        space: local.clone(),
        question: second.ask_id.clone(),
        answers: vec![SpaceAnswerItem {
            selected: vec!["Postgres".into()],
            other: None,
        }],
    })
    .await
    .unwrap();
    assert_eq!(asking.await.unwrap().unwrap()[0].selected, ["Postgres"]);
    wait_until("resolved locally", || resolved(&f, &second.ask_id)).await;

    let asking = tokio::spawn({
        let (core, local, run_id) = (core.clone(), local.clone(), run_id.clone());
        async move { core.space_tool_ask(&local, &run_id, which_store()).await }
    });
    wait_until("the third ask", || asks(&f).len() == 3).await;
    let third = asks(&f).remove(2);
    run(&f, &origin, answer(&third.ask_id, vec![vec!["DuckDB"]])).await;
    let other = asking.await.unwrap().unwrap();
    assert_eq!(other[0].other.as_deref(), Some("DuckDB"));
    core.space_stop(&local).await.unwrap();
}

// ── spaces started from here ──────────────────────────────────────────────

fn requests(f: &Fixtures) -> Vec<SignedEnvelope> {
    f.fleet
        .sent()
        .into_iter()
        .filter_map(|m| match m {
            ClientMessage::Request { envelope } => Some(envelope),
            _ => None,
        })
        .collect()
}

fn remote_event(f: &Fixtures, space: &str, seq: u64, event: RemoteSpaceEvent) {
    f.fleet
        .push(FleetInbound::Message(ServerMessage::SpaceEvent {
            space: space.into(),
            seq,
            event,
        }));
}

async fn view(core: &Core, space: &str) -> theodore_contract::FleetRemoteSpace {
    core.fleet_spaces()
        .await
        .unwrap()
        .into_iter()
        .find(|v| v.space == space)
        .unwrap()
}

#[tokio::test]
async fn a_space_started_from_here_is_signed_and_tracked() {
    let f = fixtures();
    let (core, _recv) = start(&f);
    let other = DeviceKey::generate().unwrap();
    let app = ProjectRef {
        id: "local:app".into(),
        name: "app".into(),
    };
    connect(
        &f,
        &core,
        false,
        vec![summary(TARGET, &other, "mac1", vec![app])],
    )
    .await;

    let started = core
        .fleet_start_space(FleetStartRequest {
            device_id: TARGET.into(),
            project_id: "local:app".into(),
            goal: "Port it".into(),
            mode: SpaceMode::Plan,
        })
        .await
        .unwrap();
    assert_eq!(started.status, FleetSpaceStatus::Starting);
    assert!(started.space.starts_with("rs_"));
    assert_eq!(
        (started.host_name.as_str(), started.project_name.as_str()),
        ("mac1", "app")
    );

    // Signed by this device's key, over exactly what it asks.
    let env = requests(&f).remove(0);
    let mine = f.fleet.connect(0).public_key;
    let req = env.open(&mine).expect("signed by this device");
    assert!(env.open(&other.public_key()).is_err());
    assert_eq!(
        (req.origin_device.as_str(), req.target_device.as_str()),
        (ME, TARGET)
    );
    assert!(fresh(req.issued_at_ms, now(&f)));
    assert_eq!(
        req.op,
        RemoteOp::StartSpace {
            space: started.space.clone(),
            project_id: "local:app".into(),
            goal: "Port it".into(),
            mode: FleetMode::Plan,
            agent: None,
            model: None,
            parent: None,
            depth: 0,
        }
    );
    assert!(f.fleet.sent().iter().any(
        |m| matches!(m, ClientMessage::Subscribe { space, since: 0 } if *space == started.space)
    ));

    // The reply names it; events move it along.
    f.fleet.push(FleetInbound::Message(ServerMessage::Reply {
        req_id: req.req_id.clone(),
        outcome: ReplyOutcome::Ok {
            value: serde_json::to_value(StartedSpace {
                space: started.space.clone(),
                name: "port-it".into(),
                branch: "ada/port-it".into(),
            })
            .unwrap(),
        },
    }));
    eventually("named", || async {
        view(&core, &started.space).await.name == "port-it"
    })
    .await;
    let v = view(&core, &started.space).await;
    assert_eq!(
        (v.branch.as_str(), v.status),
        ("ada/port-it", FleetSpaceStatus::Running)
    );

    remote_event(
        &f,
        &started.space,
        1,
        RemoteSpaceEvent::Reply {
            turn: 1,
            text: "Ported".into(),
        },
    );
    remote_event(
        &f,
        &started.space,
        2,
        RemoteSpaceEvent::Question {
            ask_id: "q1".into(),
            questions: vec![RemoteQuestion {
                question: "Keep it?".into(),
                options: vec!["yes".into(), "no".into()],
                multi: false,
            }],
        },
    );
    remote_event(
        &f,
        &started.space,
        3,
        RemoteSpaceEvent::Status {
            status: RemoteSpaceStatus::Waiting,
        },
    );
    // A duplicate is dropped.
    remote_event(
        &f,
        &started.space,
        2,
        RemoteSpaceEvent::Status {
            status: RemoteSpaceStatus::Failed,
        },
    );
    eventually("three lines", || async {
        core.fleet_space_lines(&started.space, 0)
            .await
            .unwrap()
            .len()
            == 3
    })
    .await;
    let v = view(&core, &started.space).await;
    assert_eq!(v.status, FleetSpaceStatus::Waiting);
    assert_eq!(v.last_reply.as_deref(), Some("Ported"));
    assert_eq!(v.question.as_ref().map(|q| q.ask_id.as_str()), Some("q1"));
    assert_eq!(
        core.fleet_space_lines(&started.space, 1)
            .await
            .unwrap()
            .len(),
        2
    );

    // A refused start fails with the host's words.
    let refused = core
        .fleet_start_space(FleetStartRequest {
            device_id: TARGET.into(),
            project_id: "local:app".into(),
            goal: "Run it all".into(),
            mode: SpaceMode::Run,
        })
        .await
        .unwrap();
    let req2 = requests(&f).remove(1).peek().unwrap();
    f.fleet.push(FleetInbound::Message(ServerMessage::Reply {
        req_id: req2.req_id,
        outcome: ReplyOutcome::Err {
            code: codes::MODE_NOT_ALLOWED.into(),
            message: "run is above what this device allows (edit)".into(),
        },
    }));
    eventually("failed", || async {
        view(&core, &refused.space).await.status == FleetSpaceStatus::Failed
    })
    .await;
    assert!(
        view(&core, &refused.space)
            .await
            .error
            .unwrap()
            .contains("above")
    );

    // Reconnected: subscribed again from the last seq seen.
    f.fleet.push(FleetInbound::Disconnected {
        reason: "gone".into(),
        retry_in_ms: 500,
    });
    wait_until("disconnected", || !core.fleet_tools_available()).await;
    let offline = core
        .fleet_start_space(FleetStartRequest {
            device_id: TARGET.into(),
            project_id: "local:app".into(),
            goal: "Later".into(),
            mode: SpaceMode::Edit,
        })
        .await;
    assert!(offline.unwrap_err().to_string().contains("not connected"));
    let before = f.fleet.sent().len();
    f.fleet.push(FleetInbound::Connected {
        device_id: ME.into(),
        generation: GENERATION + 1,
        resume: BTreeMap::new(),
    });
    wait_until("resubscribed", || {
        f.fleet.sent()[before..].iter().any(
            |m| matches!(m, ClientMessage::Subscribe { space, since: 3 } if *space == started.space),
        )
    })
    .await;
}

#[tokio::test]
async fn an_ask_routed_here_is_shown_and_dismissed() {
    let f = fixtures();
    let (core, mut recv) = start(&f);
    connect(&f, &core, false, vec![]).await;
    while recv.ephemeral.try_recv().is_ok() {}
    f.fleet.push(FleetInbound::Message(ServerMessage::Ask {
        ask: theodore_fleet_protocol::RemoteAsk {
            ask_id: "q9".into(),
            space: "rs_9".into(),
            host_device: TARGET.into(),
            from: "mac1 · fix-login".into(),
            questions: vec![],
        },
        via: theodore_fleet_protocol::AskVia::Active,
    }));
    f.fleet.push(FleetInbound::Message(ServerMessage::Dismiss {
        ask_id: "q9".into(),
        reason: theodore_fleet_protocol::DismissReason::AnsweredElsewhere,
    }));
    let (mut shown, mut dismissed) = (None, false);
    for _ in 0..200 {
        while let Ok(e) = recv.ephemeral.try_recv() {
            match e {
                Ephemeral::FleetAsk { question } => shown = Some(question),
                Ephemeral::FleetAskDismissed { ask_id } if ask_id == "q9" => dismissed = true,
                _ => {}
            }
        }
        if dismissed {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let shown = shown.expect("FleetAsk");
    assert_eq!(
        (shown.space.as_str(), shown.via.as_deref()),
        ("rs_9", Some("active"))
    );
    assert!(dismissed);
}

// ── the link and the account ──────────────────────────────────────────────

fn commands(f: &Fixtures, link: usize) -> Vec<FakeFleetCommand> {
    f.fleet.commands(link)
}

#[tokio::test]
async fn the_link_follows_the_account() {
    let f = fixtures();
    let (core, _recv) = start(&f);
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(f.fleet.starts(), 0, "off by default");

    core.fleet_set_settings(settings(false)).await.unwrap();
    wait_until("a link", || f.fleet.starts() == 1).await;
    let c = f.fleet.connect(0);
    assert_eq!(
        (c.cloud_url.as_str(), c.access_token.as_str()),
        (CLOUD, "at-rt_1")
    );
    assert_eq!(c.device_id, None);
    assert_eq!(c.info.name, "mac2");
    assert!(!c.info.accepts_remote);
    f.fleet.push(FleetInbound::Connected {
        device_id: ME.into(),
        generation: 1,
        resume: BTreeMap::new(),
    });
    eventually("connected", || async {
        core.fleet_status().await.unwrap().connected
    })
    .await;

    // A refresh: the new token goes up as reauth, same link.
    f.clock.advance(290_000);
    f.account.push_refresh(Ok(session(&f, "rt_2", "org_a")));
    assert_eq!(
        core.account_access_token().await.unwrap().as_deref(),
        Some("at-rt_2")
    );
    wait_until("reauth", || {
        commands(&f, 0).contains(&FakeFleetCommand::Reauth("at-rt_2".into()))
    })
    .await;
    assert_eq!(f.fleet.starts(), 1);

    // Another organization: a new hub, a new link.
    f.account.push_refresh(Ok(session(&f, "rt_3", "org_b")));
    core.account_switch_organization("org_b").await.unwrap();
    wait_until("a second link", || f.fleet.starts() == 2).await;
    assert!(commands(&f, 0).contains(&FakeFleetCommand::Close));
    assert_eq!(f.fleet.connect(1).access_token, "at-rt_3");

    // Signed out: closed.
    core.account_sign_out().await.unwrap();
    wait_until("closed", || {
        commands(&f, 1).contains(&FakeFleetCommand::Close)
    })
    .await;
    eventually("disconnected", || async {
        !core.fleet_status().await.unwrap().connected
    })
    .await;
}

#[tokio::test]
async fn a_fatal_refusal_stops_redialing_until_the_settings_change() {
    let f = fixtures();
    let (core, _recv) = start(&f);
    core.fleet_set_settings(settings(false)).await.unwrap();
    wait_until("a link", || f.fleet.starts() == 1).await;
    // The device id from an earlier welcome goes into the next hello.
    f.fleet.push(FleetInbound::Connected {
        device_id: ME.into(),
        generation: 1,
        resume: BTreeMap::new(),
    });
    wait_until("connected", || core.fleet_tools_available()).await;
    f.fleet.push(FleetInbound::Fatal {
        code: "fleet.key_mismatch".into(),
        message: "this device's key changed".into(),
    });
    eventually("the error", || async {
        core.fleet_status()
            .await
            .unwrap()
            .error
            .is_some_and(|e| e.contains("key_mismatch"))
    })
    .await;
    assert!(!core.fleet_tools_available());

    core.fleet_account_changed();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(f.fleet.starts(), 1, "no redial after a fatal refusal");

    core.fleet_set_settings(FleetSettingsRequest {
        enabled: None,
        accept_remote: None,
        max_mode: None,
        name: Some("mac2 (office)".into()),
    })
    .await
    .unwrap();
    wait_until("redialed", || f.fleet.starts() == 2).await;
    assert_eq!(f.fleet.connect(1).device_id.as_deref(), Some(ME));
    assert_eq!(f.fleet.connect(1).info.name, "mac2 (office)");

    // Off: closed.
    core.fleet_set_settings(FleetSettingsRequest {
        enabled: Some(false),
        accept_remote: None,
        max_mode: None,
        name: None,
    })
    .await
    .unwrap();
    wait_until("closed", || {
        commands(&f, 1).contains(&FakeFleetCommand::Close)
    })
    .await;
}

#[tokio::test]
async fn accepting_remote_announces_this_devices_projects() {
    let f = fixtures();
    let (core, _recv) = start(&f);
    let project = project(&f, &core).await;
    connect(&f, &core, false, vec![]).await;
    assert!(f.fleet.connect(0).info.projects.is_empty());
    core.fleet_set_settings(settings(true)).await.unwrap();
    wait_until("announced", || {
        commands(&f, 0).iter().any(|c| {
            matches!(c, FakeFleetCommand::Update { info, .. }
                if info.accepts_remote && info.projects.iter().any(|p| p.id == project.id))
        })
    })
    .await;
}

// ── the agent's tools ─────────────────────────────────────────────────────

fn hosted_row(space: &str, local: &str, depth: u32) -> FleetHostedRow {
    FleetHostedRow {
        space: space.into(),
        local_space: local.into(),
        origin_device: ORIGIN.into(),
        parent: None,
        depth,
        created_at: 0,
        data: json!({"mode": "edit", "project_id": "p", "project_name": "p", "name": "n", "branch": "b"}),
    }
}

#[tokio::test]
async fn the_fleet_tools_follow_the_connection_and_nest_spaces() {
    let f = fixtures();
    f.store
        .fleet_hosted_put(&hosted_row("rs_h", "loc1", 1))
        .unwrap();
    f.store
        .fleet_hosted_put(&hosted_row("rs_deep", "loc2", 2))
        .unwrap();
    let (core, _recv) = start(&f);
    assert!(!core.fleet_tools_available());
    assert!(core.fleet_tool_devices().await.is_err());
    let other = DeviceKey::generate().unwrap();
    let me = DeviceKey::generate().unwrap();
    let app = ProjectRef {
        id: "local:app".into(),
        name: "app".into(),
    };
    connect(
        &f,
        &core,
        false,
        vec![
            summary(TARGET, &other, "mac1", vec![app]),
            summary(ME, &me, "mac2", vec![]),
        ],
    )
    .await;
    assert!(core.fleet_tools_available());
    let devices = core.fleet_tool_devices().await.unwrap();
    assert_eq!(devices.len(), 1, "others that take spaces: {devices:?}");
    assert_eq!(
        (devices[0].name.as_str(), devices[0].max_mode.as_str()),
        ("mac1", "edit")
    );

    // From a space hosted here for the fleet: its child, one deeper.
    let starting = tokio::spawn({
        let core = core.clone();
        async move {
            core.fleet_tool_start("loc1", "mac1", "app", "Split it", "plan")
                .await
        }
    });
    wait_until("the request", || !requests(&f).is_empty()).await;
    let req = requests(&f).remove(0).peek().unwrap();
    let RemoteOp::StartSpace {
        parent,
        depth,
        mode,
        space,
        ..
    } = &req.op
    else {
        panic!("{req:?}")
    };
    assert_eq!(
        (parent.as_deref(), *depth, *mode),
        (Some("rs_h"), 2, FleetMode::Plan)
    );
    f.fleet.push(FleetInbound::Message(ServerMessage::Reply {
        req_id: req.req_id.clone(),
        outcome: ReplyOutcome::Ok {
            value: serde_json::to_value(StartedSpace {
                space: space.clone(),
                name: "split-it".into(),
                branch: "ada/split-it".into(),
            })
            .unwrap(),
        },
    }));
    let made = starting.await.unwrap().unwrap();
    assert_eq!(
        (made.name.as_str(), made.status.as_str()),
        ("split-it", "running")
    );

    // Already at the deepest: refused here.
    let deep = core
        .fleet_tool_start("loc2", "mac1", "app", "Deeper", "edit")
        .await
        .unwrap_err();
    assert!(deep.to_string().contains("deep"), "{deep}");

    // From a space of this device's own: a child at depth 1, no parent.
    let plain = tokio::spawn({
        let core = core.clone();
        async move {
            core.fleet_tool_start("mine", TARGET, "local:app", "Look", "ask")
                .await
        }
    });
    wait_until("the second request", || requests(&f).len() == 2).await;
    let req = requests(&f).remove(1).peek().unwrap();
    assert!(
        matches!(
            &req.op,
            RemoteOp::StartSpace {
                parent: None,
                depth: 1,
                ..
            }
        ),
        "{req:?}"
    );
    f.fleet.push(FleetInbound::Message(ServerMessage::Reply {
        req_id: req.req_id.clone(),
        outcome: ReplyOutcome::Err {
            code: codes::UNTRUSTED_DEVICE.into(),
            message: "mac2 isn't trusted on this device".into(),
        },
    }));
    let err = plain.await.unwrap().unwrap_err();
    assert!(err.to_string().contains("isn't trusted"), "{err}");

    // Wait: settles on the host's word; a timeout says it didn't.
    let waited = core
        .fleet_tool_wait(std::slice::from_ref(&made.space), 30)
        .await
        .unwrap();
    assert!(!waited.settled);
    remote_event(
        &f,
        &made.space,
        1,
        RemoteSpaceEvent::Status {
            status: RemoteSpaceStatus::Idle,
        },
    );
    let waited = core
        .fleet_tool_wait(std::slice::from_ref(&made.space), 5_000)
        .await
        .unwrap();
    assert!(waited.settled, "{waited:?}");
    let read = core.fleet_tool_read(&made.space, 0).await.unwrap();
    assert_eq!(read.lines.len(), 1);
    assert_eq!(read.lines[0].kind, "status");

    f.fleet.push(FleetInbound::Disconnected {
        reason: "gone".into(),
        retry_in_ms: 500,
    });
    wait_until("off", || !core.fleet_tools_available()).await;
    assert!(core.fleet_tool_devices().await.is_err());
}
