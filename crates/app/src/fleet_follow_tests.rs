//! Following a space that runs on another device (docs/fleet.md "One space
//! UI: mirrored rows"): the host's rows kept as ordinary rows, what is
//! dropped, what survives a restart, and which space commands go to the
//! host and which are refused here. A child of `fleet_tests`, for its
//! harness.

use serde_json::{Value, json};
use theodore_contract::{
    BootstrapScope, Ephemeral, FleetLineKind, MutationOp, RemoteSubSpace, RemoteSubSpaceStatus,
    SetSpaceSettingsRequest, Space, SpaceAnswerItem, SpaceAnswerRequest, SpaceMode,
    SpaceReviewRequest, SpaceSendRequest, SpaceStatus, Transaction, TransactionResult, models,
};
use theodore_fleet_protocol::{
    ClientMessage, DeviceKey, FleetMode, RemoteOp, RemoteSpaceEvent, ReplyOutcome, StartedSpace,
};
use theodore_ports::{NewAction, Store, SyncActionCode};

use super::{
    TARGET, app_project, connect, connect_nth, eventually, remote_event, requests, signed_reply,
    start, start_remote, summary, trust, wait_until,
};
use crate::testkit::{Fixtures, fixtures};
use crate::{Core, Receivers};

/// Connected, `TARGET` ("mac1", key returned) trusted, a space started
/// there from here and acknowledged: its fleet id.
async fn following(f: &Fixtures) -> (Core, Receivers, DeviceKey, String) {
    let (core, recv) = start(f);
    let host = DeviceKey::generate().unwrap();
    connect(
        f,
        &core,
        false,
        vec![summary(TARGET, &host, "mac1", vec![app_project()])],
    )
    .await;
    trust(&core, TARGET).await;
    let (rs, req) = start_remote(f, &core, 0).await;
    f.fleet.push(signed_reply(
        &host,
        TARGET,
        &req.req_id,
        ReplyOutcome::Ok {
            value: serde_json::to_value(StartedSpace {
                space: rs.clone(),
                name: "port-it".into(),
                branch: "ada/port-it".into(),
            })
            .unwrap(),
        },
    ));
    wait_until("subscribed", || {
        f.fleet
            .sent()
            .iter()
            .any(|m| matches!(m, ClientMessage::Subscribe { space, since: 0 } if *space == rs))
    })
    .await;
    (core, recv, host, rs)
}

/// The host's space row as it may send it (local-only parts not blanked,
/// to see that they are here).
fn host_space(rs: &str, status: &str) -> Value {
    json!({
        "id": rs,
        "project": "local:app",
        "name": "port-it",
        "goal": "Port it",
        "branch": "ada/port-it",
        "base": "main",
        "base_sha": "base000",
        "head_sha": "head111",
        "worktree": "/Users/host/.theodore/spaces/s1",
        "status": status,
        "agent": "claude",
        "mode": "edit",
        "turns": 1,
        "created_at": 1,
        "updated_at": 2,
        "ports": [4100],
        "review_pr": "space-review",
        "agent_session": { "agent": "claude", "id": "sess", "cwd": "/Users/host/x" },
        "process": { "status": "running", "started_at": 1, "pgid": 4242, "script": "npm start" },
    })
}

fn host_message(rs: &str, id: &str, text: &str) -> Value {
    json!({
        "id": id,
        "pr": format!("space:{rs}"),
        "author": { "kind": "me" },
        "text": text,
        "refs": [],
        "at": 5,
    })
}

fn mirror(f: &Fixtures, key: &DeviceKey, rs: &str, seq: u64, model: &str, id: &str, data: Value) {
    remote_event(
        f,
        key,
        rs,
        seq,
        RemoteSpaceEvent::Mirror {
            model: model.into(),
            id: id.into(),
            data: (!data.is_null()).then_some(data),
        },
    );
}

fn row(f: &Fixtures, model: &str, id: &str) -> Option<Value> {
    f.store.get(model, id).unwrap().map(|r| r.data)
}

fn space_here(f: &Fixtures, id: &str) -> Space {
    serde_json::from_value(row(f, models::SPACE, id).expect("the space row")).unwrap()
}

async fn mirrored(f: &Fixtures, key: &DeviceKey, rs: &str, seq: u64, status: &str) {
    mirror(f, key, rs, seq, models::SPACE, rs, host_space(rs, status));
    wait_until("the mirrored space", || {
        row(f, models::SPACE, rs).is_some_and(|r| r["status"] == json!(status))
    })
    .await;
}

/// Waits for an ephemeral matching `want`, keeping what came.
async fn ephemeral(
    recv: &mut Receivers,
    seen: &mut Vec<Ephemeral>,
    want: impl Fn(&Ephemeral) -> bool,
) {
    let deadline = tokio::time::Instant::now() + super::WAIT;
    loop {
        while let Ok(e) = recv.ephemeral.try_recv() {
            seen.push(e);
        }
        if seen.iter().any(&want) {
            return;
        }
        assert!(tokio::time::Instant::now() < deadline, "no such ephemeral");
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
}

fn run_steps(seen: &[Ephemeral]) -> Vec<String> {
    seen.iter()
        .filter_map(|e| match e {
            Ephemeral::RunStep { run, .. } => Some(run.clone()),
            _ => None,
        })
        .collect()
}

/// The `n`th request sent from here (0-based), once sent, answered ok by
/// the host; its op.
async fn answered(f: &Fixtures, host: &DeviceKey, n: usize) -> RemoteOp {
    wait_until("the request", || requests(f).len() > n).await;
    let req = requests(f).remove(n).peek().unwrap();
    f.fleet.push(signed_reply(
        host,
        TARGET,
        &req.req_id,
        ReplyOutcome::Ok { value: json!({}) },
    ));
    req.op
}

#[tokio::test]
async fn a_followed_space_is_kept_as_an_ordinary_space_row() {
    let f = fixtures();
    let (core, mut recv, host, rs) = following(&f).await;

    mirrored(&f, &host, &rs, 1, "running").await;
    let s = space_here(&f, &rs);
    let remote = s.remote.clone().expect("marked as running elsewhere");
    assert_eq!(
        (
            remote.space.as_str(),
            remote.host_device.as_str(),
            remote.host_name.as_str(),
            remote.project_name.as_str(),
            remote.started_here
        ),
        (rs.as_str(), TARGET, "mac1", "app", true)
    );
    // What only the host can use is blanked here, whatever it sent.
    assert_eq!(s.worktree, "");
    assert!(s.ports.is_empty() && s.review_pr.is_none() && s.agent_session.is_none());
    let p = s.process.expect("the process is shown");
    assert_eq!((p.pgid, p.script), (None, None));
    assert_eq!(
        (s.name.as_str(), s.status),
        ("port-it", SpaceStatus::Running)
    );

    // In the UI's list; not among this device's own.
    assert!(
        core.list_spaces(None)
            .await
            .unwrap()
            .iter()
            .any(|s| s.id == rs)
    );
    assert!(
        !core
            .local_spaces(None)
            .await
            .unwrap()
            .iter()
            .any(|s| s.id == rs)
    );

    // Chat rows come and go; a live step is shown, never kept.
    mirror(
        &f,
        &host,
        &rs,
        2,
        models::CHAT_MESSAGE,
        "m1",
        host_message(&rs, "m1", "Port it"),
    );
    mirror(
        &f,
        &host,
        &rs,
        3,
        models::CHAT_MESSAGE,
        "m2",
        host_message(&rs, "m2", "draft"),
    );
    wait_until("the chat", || row(&f, models::CHAT_MESSAGE, "m2").is_some()).await;
    assert_eq!(
        row(&f, models::CHAT_MESSAGE, "m1").unwrap()["text"],
        json!("Port it")
    );
    mirror(&f, &host, &rs, 4, models::CHAT_MESSAGE, "m2", Value::Null);
    wait_until("deleted", || row(&f, models::CHAT_MESSAGE, "m2").is_none()).await;
    let run = format!("space:{rs}:m1");
    mirror(
        &f,
        &host,
        &rs,
        5,
        "turn_step",
        &format!("{run}:0"),
        json!({ "kind": "thinking", "text": "Looking" }),
    );
    let mut seen = Vec::new();
    ephemeral(&mut recv, &mut seen, |e| {
        matches!(e, Ephemeral::RunStep { .. })
    })
    .await;
    assert_eq!(run_steps(&seen), vec![run]);
    // Mirrors aren't history lines.
    assert!(core.fleet_space_lines(&rs, 0).await.unwrap().is_empty());

    // An update keeps the follower's own pin.
    core.set_space_pinned(&rs, true).await.unwrap();
    let mut next = host_space(&rs, "idle");
    next["pinned"] = json!(false);
    mirror(&f, &host, &rs, 6, models::SPACE, &rs, next);
    wait_until("idle", || {
        row(&f, models::SPACE, &rs).is_some_and(|r| r["status"] == json!("idle"))
    })
    .await;
    assert!(space_here(&f, &rs).pinned);
}

#[tokio::test]
async fn mirrors_naming_another_space_or_not_parsing_are_dropped() {
    let f = fixtures();
    let (_core, mut recv, host, rs) = following(&f).await;
    mirrored(&f, &host, &rs, 1, "idle").await;
    let other = "rs_0000000000000000000000000000other";

    // A space row under another id, or of another id inside.
    mirror(
        &f,
        &host,
        &rs,
        2,
        models::SPACE,
        other,
        host_space(other, "idle"),
    );
    mirror(
        &f,
        &host,
        &rs,
        3,
        models::SPACE,
        &rs,
        host_space(other, "failed"),
    );
    // A run of another space.
    let mut foreign_run = host_space(&rs, "failed");
    foreign_run["run"] = json!(format!("space:{other}:m1"));
    mirror(&f, &host, &rs, 4, models::SPACE, &rs, foreign_run);
    // Not a space row.
    mirror(
        &f,
        &host,
        &rs,
        5,
        models::SPACE,
        &rs,
        json!({ "id": rs, "status": "failed" }),
    );
    // Chat of another space, under another id, of another space's run.
    mirror(
        &f,
        &host,
        &rs,
        6,
        models::CHAT_MESSAGE,
        "x1",
        host_message(other, "x1", "no"),
    );
    mirror(
        &f,
        &host,
        &rs,
        7,
        models::CHAT_MESSAGE,
        "x2",
        host_message(&rs, "x3", "no"),
    );
    let mut reply = host_message(&rs, "x4", "no");
    reply["run"] = json!(format!("space:{other}:m1"));
    mirror(&f, &host, &rs, 8, models::CHAT_MESSAGE, "x4", reply);
    // A model that isn't mirrored.
    mirror(&f, &host, &rs, 9, "pr", "x5", json!({ "id": "x5" }));
    // A step of another space's run, and one that isn't a step.
    mirror(
        &f,
        &host,
        &rs,
        10,
        "turn_step",
        &format!("space:{other}:m1:0"),
        json!({ "kind": "thinking", "text": "no" }),
    );
    mirror(
        &f,
        &host,
        &rs,
        11,
        "turn_step",
        &format!("space:{rs}:m1:0"),
        json!({ "kind": "nope" }),
    );
    // Then a good one: everything before it was handled.
    mirror(
        &f,
        &host,
        &rs,
        12,
        models::CHAT_MESSAGE,
        "ok",
        host_message(&rs, "ok", "yes"),
    );
    wait_until("the good one", || {
        row(&f, models::CHAT_MESSAGE, "ok").is_some()
    })
    .await;

    assert!(row(&f, models::SPACE, other).is_none());
    assert_eq!(space_here(&f, &rs).status, SpaceStatus::Idle);
    for id in ["x1", "x2", "x3", "x4", "x5"] {
        assert!(row(&f, models::CHAT_MESSAGE, id).is_none(), "{id}");
    }
    let mut seen = Vec::new();
    while let Ok(e) = recv.ephemeral.try_recv() {
        seen.push(e);
    }
    assert!(run_steps(&seen).is_empty());
}

#[tokio::test]
async fn a_mirror_never_writes_over_a_local_space_or_its_chat() {
    let f = fixtures();
    let (_core, mut recv, host, rs) = following(&f).await;
    // A space of this device's own under that id, and a local message.
    let mut local = host_space(&rs, "idle");
    local["name"] = json!("mine");
    let mut mine = host_message("local1", "m-local", "my own");
    mine["pr"] = json!("space:local1");
    f.store
        .apply(vec![
            NewAction {
                model: models::SPACE.into(),
                model_id: rs.clone(),
                action: SyncActionCode::I,
                data: Some(local),
            },
            NewAction {
                model: models::CHAT_MESSAGE.into(),
                model_id: "m-local".into(),
                action: SyncActionCode::I,
                data: Some(mine),
            },
        ])
        .unwrap();

    mirror(
        &f,
        &host,
        &rs,
        1,
        models::SPACE,
        &rs,
        host_space(&rs, "running"),
    );
    mirror(&f, &host, &rs, 2, models::SPACE, &rs, Value::Null);
    mirror(
        &f,
        &host,
        &rs,
        3,
        models::CHAT_MESSAGE,
        "m1",
        host_message(&rs, "m1", "no"),
    );
    mirror(
        &f,
        &host,
        &rs,
        4,
        models::CHAT_MESSAGE,
        "m-local",
        Value::Null,
    );
    let run = format!("space:{rs}:m9");
    mirror(
        &f,
        &host,
        &rs,
        5,
        "turn_step",
        &format!("{run}:0"),
        json!({ "kind": "thinking", "text": "." }),
    );
    let mut seen = Vec::new();
    ephemeral(&mut recv, &mut seen, |e| {
        matches!(e, Ephemeral::RunStep { .. })
    })
    .await;

    let s = space_here(&f, &rs);
    assert_eq!(
        (s.name.as_str(), s.status, s.remote),
        ("mine", SpaceStatus::Idle, None)
    );
    assert!(row(&f, models::CHAT_MESSAGE, "m1").is_none());
    assert_eq!(
        row(&f, models::CHAT_MESSAGE, "m-local").unwrap()["text"],
        json!("my own")
    );
}

#[tokio::test]
async fn send_stop_answer_and_approve_go_to_the_host() {
    let f = fixtures();
    let (core, _recv, host, rs) = following(&f).await;
    let mut planned = host_space(&rs, "idle");
    planned["turn_log"] = json!([{
        "message": "m1", "reply": "m2", "before": "a", "after": "a", "plan": "1. do it"
    }]);
    mirror(&f, &host, &rs, 1, models::SPACE, &rs, planned);
    wait_until("mirrored", || row(&f, models::SPACE, &rs).is_some()).await;
    let n = requests(&f).len();

    // Send: the text, the mode and the picks (the host checks them);
    // files stay here.
    let sent = {
        let core = core.clone();
        let rs = rs.clone();
        tokio::spawn(async move {
            core.space_send(SpaceSendRequest {
                space: rs,
                text: "Go on".into(),
                agent: Some(theodore_domain::AgentId::Codex),
                model: Some("x".into()),
                mode: Some(SpaceMode::Plan),
                attachments: None,
                effort: Some("high".into()),
                mentions: None,
            })
            .await
        })
    };
    assert_eq!(
        answered(&f, &host, n).await,
        RemoteOp::Send {
            space: rs.clone(),
            text: "Go on".into(),
            mode: Some(FleetMode::Plan),
            agent: Some("codex".into()),
            model: Some("x".into()),
            effort: Some("high".into()),
            attachments: vec![],
        }
    );
    sent.await.unwrap().unwrap();
    // Files can't go along: refused here, nothing sent.
    let with_files = core
        .space_send(SpaceSendRequest {
            space: rs.clone(),
            text: "See this".into(),
            agent: None,
            model: None,
            mode: None,
            attachments: Some(vec!["att1".into()]),
            effort: None,
            mentions: None,
        })
        .await;
    assert!(with_files.unwrap_err().to_string().contains("mac1"));
    assert_eq!(requests(&f).len(), n + 1);

    let stopped = {
        let core = core.clone();
        let rs = rs.clone();
        tokio::spawn(async move { core.space_stop(&rs).await })
    };
    assert_eq!(
        answered(&f, &host, n + 1).await,
        RemoteOp::Stop { space: rs.clone() }
    );
    stopped.await.unwrap().unwrap();

    let answer = {
        let core = core.clone();
        let rs = rs.clone();
        tokio::spawn(async move {
            core.answer_space_question(SpaceAnswerRequest {
                space: rs,
                question: "q1".into(),
                answers: vec![
                    SpaceAnswerItem {
                        selected: vec!["yes".into()],
                        other: None,
                    },
                    SpaceAnswerItem {
                        selected: vec![],
                        other: Some("later".into()),
                    },
                ],
            })
            .await
        })
    };
    assert_eq!(
        answered(&f, &host, n + 2).await,
        RemoteOp::Answer {
            space: rs.clone(),
            ask_id: "q1".into(),
            answers: vec![vec!["yes".into()], vec!["later".into()]],
        }
    );
    answer.await.unwrap().unwrap();

    let approved = {
        let core = core.clone();
        let rs = rs.clone();
        tokio::spawn(async move { core.approve_space_plan(&rs).await })
    };
    assert_eq!(
        answered(&f, &host, n + 3).await,
        RemoteOp::Send {
            space: rs.clone(),
            text: crate::usecases::space_plan::APPROVED_TEXT.into(),
            mode: Some(FleetMode::Edit),
            agent: None,
            model: None,
            effort: None,
            attachments: vec![],
        }
    );
    approved.await.unwrap().unwrap();
}

#[tokio::test]
async fn local_only_parts_of_a_mirrored_space_say_where_it_runs() {
    let f = fixtures();
    let (core, _recv, host, rs) = following(&f).await;
    mirrored(&f, &host, &rs, 1, "idle").await;
    let n = requests(&f).len();

    let refused = |r: Result<(), crate::error::AppError>| {
        let e = r.expect_err("refused here");
        assert!(e.to_string().contains("runs on mac1"), "{e}");
    };
    refused(
        core.space_review(SpaceReviewRequest {
            space: rs.clone(),
            group: false,
        })
        .await
        .map(|_| ()),
    );
    refused(core.undo_space_turn(&rs).await.map(|_| ()));
    refused(core.unarchive_space(&rs).await.map(|_| ()));
    refused(core.space_config(&rs).await.map(|_| ()));
    refused(core.open_space_terminal(&rs, 80, 24).await.map(|_| ()));
    refused(core.space_base_status(&rs).await.map(|_| ()));
    refused(
        core.set_space_settings(SetSpaceSettingsRequest {
            space: rs.clone(),
            agent: None,
            model: None,
            effort: None,
            mode: Some(SpaceMode::Run),
        })
        .await
        .map(|_| ()),
    );
    // Nothing went to the host, and the row is as the host sent it.
    assert_eq!(requests(&f).len(), n);
    assert_eq!(space_here(&f, &rs).mode, SpaceMode::Edit);
}

#[tokio::test]
async fn archiving_a_mirrored_space_stops_it_and_forgets_the_copy() {
    let f = fixtures();
    let (core, _recv, host, rs) = following(&f).await;
    let mut running = host_space(&rs, "running");
    running["run"] = json!(format!("space:{rs}:m1"));
    mirror(&f, &host, &rs, 1, models::SPACE, &rs, running);
    mirror(
        &f,
        &host,
        &rs,
        2,
        models::CHAT_MESSAGE,
        "m1",
        host_message(&rs, "m1", "Port it"),
    );
    wait_until("mirrored", || row(&f, models::CHAT_MESSAGE, "m1").is_some()).await;
    let n = requests(&f).len();

    let archived = {
        let core = core.clone();
        let rs = rs.clone();
        tokio::spawn(async move { core.archive_space(&rs).await })
    };
    assert_eq!(
        answered(&f, &host, n).await,
        RemoteOp::Stop { space: rs.clone() }
    );
    archived.await.unwrap().unwrap();
    assert!(row(&f, models::SPACE, &rs).is_none());
    assert!(row(&f, models::CHAT_MESSAGE, "m1").is_none());
    assert!(
        f.fleet
            .sent()
            .iter()
            .any(|m| matches!(m, ClientMessage::Unsubscribe { space } if *space == rs))
    );
    assert!(
        !core
            .fleet_spaces()
            .await
            .unwrap()
            .iter()
            .any(|v| v.space == rs)
    );
    // What the host still sends is no longer kept.
    mirror(
        &f,
        &host,
        &rs,
        3,
        models::SPACE,
        &rs,
        host_space(&rs, "idle"),
    );
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(row(&f, models::SPACE, &rs).is_none());
}

#[tokio::test]
async fn a_mirrored_space_survives_a_restart_and_is_followed_from_its_last_seq() {
    let f = fixtures();
    let (core, _recv, host, rs) = following(&f).await;
    let mut running = host_space(&rs, "running");
    running["run"] = json!(format!("space:{rs}:m1"));
    mirror(&f, &host, &rs, 3, models::SPACE, &rs, running);
    mirror(
        &f,
        &host,
        &rs,
        7,
        models::CHAT_MESSAGE,
        "m1",
        host_message(&rs, "m1", "Port it"),
    );
    wait_until("mirrored", || row(&f, models::CHAT_MESSAGE, "m1").is_some()).await;
    // The seq is kept once the event is: wait for it.
    eventually("the seq kept", || async {
        f.store
            .kv_get(&format!("fleet.follow:{rs}"))
            .unwrap()
            .is_some_and(|v| v["seq"] == json!(7))
    })
    .await;
    drop(core);

    let (core, _recv) = start(&f);
    // Recovery: the host's running turn isn't this device's to fail.
    core.fail_interrupted_spaces().await;
    let s = space_here(&f, &rs);
    assert_eq!(
        (s.status, s.run.as_deref()),
        (
            SpaceStatus::Running,
            Some(format!("space:{rs}:m1").as_str())
        )
    );
    connect_nth(
        &f,
        &core,
        false,
        vec![summary(TARGET, &host, "mac1", vec![app_project()])],
        2,
    )
    .await;
    // The new link's: subscribed from the last seq kept.
    wait_until("resubscribed from the last seq", || {
        f.fleet
            .sent()
            .iter()
            .any(|m| matches!(m, ClientMessage::Subscribe { space, since: 7 } if *space == rs))
    })
    .await;
    let v = core
        .fleet_spaces()
        .await
        .unwrap()
        .into_iter()
        .find(|v| v.space == rs)
        .expect("followed again");
    assert_eq!((v.host_name.as_str(), v.name.as_str()), ("mac1", "port-it"));

    // Events go on from there; an old one is a replay.
    mirror(
        &f,
        &host,
        &rs,
        6,
        models::CHAT_MESSAGE,
        "old",
        host_message(&rs, "old", "old"),
    );
    let mut done = host_space(&rs, "idle");
    done["done_at"] = json!(1);
    mirror(&f, &host, &rs, 8, models::SPACE, &rs, done);
    wait_until("idle", || {
        row(&f, models::SPACE, &rs).is_some_and(|r| r["status"] == json!("idle"))
    })
    .await;
    assert!(row(&f, models::CHAT_MESSAGE, "old").is_none());

    // The sweep doesn't auto-archive a mirrored space done long ago.
    core.sweep_spaces().await;
    assert_eq!(space_here(&f, &rs).status, SpaceStatus::Idle);

    // Steering works after the restart.
    let n = requests(&f).len();
    let stopped = {
        let core = core.clone();
        let rs = rs.clone();
        tokio::spawn(async move { core.space_stop(&rs).await })
    };
    assert_eq!(
        answered(&f, &host, n).await,
        RemoteOp::Stop { space: rs.clone() }
    );
    stopped.await.unwrap().unwrap();
}

fn sub(id: &str, parent: &str, title: &str, status: &str, done: bool) -> Value {
    json!({
        "space": id, "parent": parent, "title": title,
        "status": status, "mode": "edit", "done": done,
    })
}

fn sub_row(f: &Fixtures, rs: &str, id: &str) -> Option<RemoteSubSpace> {
    row(f, models::REMOTE_SUB_SPACE, &format!("{rs}:{id}"))
        .map(|v| serde_json::from_value(v).expect("a remote sub-space row"))
}

async fn sub_lines(core: &Core, rs: &str) -> Vec<String> {
    core.fleet_space_lines(rs, 0)
        .await
        .unwrap()
        .into_iter()
        .filter(|l| l.kind == FleetLineKind::SubSpace)
        .map(|l| l.text)
        .collect()
}

#[tokio::test]
async fn a_followed_spaces_sub_spaces_are_kept_as_its_tree_never_as_spaces() {
    let f = fixtures();
    let (core, _recv, host, rs) = following(&f).await;
    mirrored(&f, &host, &rs, 1, "running").await;
    let c1 = sub("c1", &rs, "Port the parser", "running", false);
    mirror(&f, &host, &rs, 2, "sub_space", "c1", c1);
    // A grandchild: under c1, not the root.
    let c2 = sub("c2", "c1", "Its tests", "question", false);
    mirror(&f, &host, &rs, 3, "sub_space", "c2", c2);
    wait_until("the tree", || sub_row(&f, &rs, "c2").is_some()).await;

    let c1 = sub_row(&f, &rs, "c1").expect("the child");
    assert_eq!(
        (
            c1.root.as_str(),
            c1.space.as_str(),
            c1.parent.as_str(),
            c1.title.as_str()
        ),
        (rs.as_str(), "c1", rs.as_str(), "Port the parser")
    );
    assert_eq!(
        (c1.status, c1.mode, c1.done, c1.seq),
        (RemoteSubSpaceStatus::Running, SpaceMode::Edit, false, 2)
    );
    let c2 = sub_row(&f, &rs, "c2").expect("the grandchild");
    assert_eq!(
        (c2.parent.as_str(), c2.status),
        ("c1", RemoteSubSpaceStatus::Question)
    );
    // The history lines stay.
    eventually("both lines", || async {
        sub_lines(&core, &rs).await
            == [
                "c1 · Port the parser · running".to_string(),
                "c2 · Its tests · question".to_string(),
            ]
    })
    .await;

    // Never a space here: no row, not listed, no command reaches it.
    for id in ["c1", "c2"] {
        assert!(row(&f, models::SPACE, id).is_none());
        assert!(core.space_stop(id).await.is_err());
        assert!(core.archive_space(id).await.is_err());
    }
    assert!(
        core.list_spaces(None)
            .await
            .unwrap()
            .iter()
            .all(|s| s.id == rs)
    );
    // The UI gets them with the other global rows.
    let boot = core.bootstrap(BootstrapScope::Global).await.unwrap();
    let mut kept: Vec<&str> = boot
        .rows
        .iter()
        .filter(|r| r.model == models::REMOTE_SUB_SPACE)
        .map(|r| r.id.as_str())
        .collect();
    kept.sort_unstable();
    assert_eq!(kept, [format!("{rs}:c1"), format!("{rs}:c2")]);
    // ...and can't write them.
    let refused = core
        .transact(Transaction {
            id: "t1".into(),
            ops: vec![MutationOp::Delete {
                model: models::REMOTE_SUB_SPACE.into(),
                id: format!("{rs}:c1"),
            }],
        })
        .await;
    assert!(
        matches!(refused, TransactionResult::Rejected { .. }),
        "{refused:?}"
    );
    assert!(sub_row(&f, &rs, "c1").is_some());
}

#[tokio::test]
async fn a_remote_sub_space_keeps_its_latest_state_and_goes_on_null() {
    let f = fixtures();
    let (core, _recv, host, rs) = following(&f).await;
    mirrored(&f, &host, &rs, 1, "running").await;
    let c1 = sub("c1", &rs, "Port the parser", "running", false);
    mirror(&f, &host, &rs, 2, "sub_space", "c1", c1);
    wait_until("the child", || sub_row(&f, &rs, "c1").is_some()).await;

    // An update: the latest wins.
    let merged = sub("c1", &rs, "Port the parser", "idle", true);
    mirror(&f, &host, &rs, 3, "sub_space", "c1", merged);
    wait_until("merged", || {
        sub_row(&f, &rs, "c1").is_some_and(|s| s.done && s.seq == 3)
    })
    .await;
    assert_eq!(
        sub_row(&f, &rs, "c1").unwrap().status,
        RemoteSubSpaceStatus::Idle
    );

    // Dropped, nothing kept: under another id, its own parent.
    let other = sub("c2", &rs, "x", "idle", false);
    mirror(&f, &host, &rs, 4, "sub_space", "c9", other);
    let looped = sub("c3", "c3", "loop", "idle", false);
    mirror(&f, &host, &rs, 5, "sub_space", "c3", looped);

    // `null` removes the row; the history says so.
    mirror(&f, &host, &rs, 6, "sub_space", "c1", Value::Null);
    wait_until("removed", || sub_row(&f, &rs, "c1").is_none()).await;
    for id in ["c2", "c3", "c9"] {
        assert!(sub_row(&f, &rs, id).is_none(), "{id} kept");
    }
    eventually("the lines", || async {
        sub_lines(&core, &rs).await
            == [
                "c1 · Port the parser · running".to_string(),
                "c1 · Port the parser · merged".to_string(),
                "c1 · gone".to_string(),
            ]
    })
    .await;
    // A `null` for one never seen writes nothing.
    mirror(&f, &host, &rs, 7, "sub_space", "c8", Value::Null);
    eventually("its line", || async {
        sub_lines(&core, &rs).await.iter().any(|l| l == "c8 · gone")
    })
    .await;
    assert!(sub_row(&f, &rs, "c8").is_none());
}

#[tokio::test]
async fn forgetting_a_followed_space_drops_its_tree() {
    let f = fixtures();
    let (core, _recv, host, rs) = following(&f).await;
    mirrored(&f, &host, &rs, 1, "idle").await;
    let c1 = sub("c1", &rs, "a", "idle", false);
    mirror(&f, &host, &rs, 2, "sub_space", "c1", c1);
    let c2 = sub("c2", "c1", "b", "idle", false);
    mirror(&f, &host, &rs, 3, "sub_space", "c2", c2);
    wait_until("the tree", || sub_row(&f, &rs, "c2").is_some()).await;

    core.archive_space(&rs).await.unwrap();
    assert!(row(&f, models::SPACE, &rs).is_none());
    assert!(sub_row(&f, &rs, "c1").is_none() && sub_row(&f, &rs, "c2").is_none());
    // No longer followed: what the host still sends isn't kept.
    let again = sub("c1", &rs, "a", "running", false);
    mirror(&f, &host, &rs, 4, "sub_space", "c1", again);
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(sub_row(&f, &rs, "c1").is_none());
}

#[tokio::test]
async fn the_hosts_removal_of_a_followed_space_takes_its_tree() {
    let f = fixtures();
    let (_core, _recv, host, rs) = following(&f).await;
    mirrored(&f, &host, &rs, 1, "idle").await;
    let c1 = sub("c1", &rs, "a", "idle", false);
    mirror(&f, &host, &rs, 2, "sub_space", "c1", c1);
    wait_until("the child", || sub_row(&f, &rs, "c1").is_some()).await;

    mirror(&f, &host, &rs, 3, models::SPACE, &rs, Value::Null);
    wait_until("the space gone", || row(&f, models::SPACE, &rs).is_none()).await;
    assert!(sub_row(&f, &rs, "c1").is_none());
}
