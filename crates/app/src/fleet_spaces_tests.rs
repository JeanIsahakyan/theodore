//! Any space on a computer (docs/fleet.md "Any space on a computer"): a
//! trusted device lists, reads, asks, messages and answers this computer's
//! spaces and merges their sub-spaces, through the gate like any request;
//! a space hosted here for another device starts sub-spaces within that
//! device's rights, mirrored to it. A child of `fleet_tests`, for its
//! harness.

use theodore_contract::{
    CreateSpaceRequest, FleetAuto, FleetAutoRequest, FleetConfirm, FleetConfirmAction,
    FleetConfirmAnswer, FleetSettingsRequest, Project, Space, SpaceMode, SpaceStatus,
};
use theodore_domain::Sha;
use theodore_fleet_protocol::{
    DeviceKey, DeviceKind, FleetMode, MirroredSubSpace, RemoteOp, RemoteSpaceEvent, ReplyOutcome,
    SUB_SPACE_MODEL, codes,
};
use theodore_ports::{AgentEvent, LocalSpaceStart, SpaceToolError};

use super::{
    ORIGIN, STRANGER, claim_result, claimed, client, connect, deliver, done, events, local_of,
    project, refusal, reply_of, run, sealed, sealed_from, space, start, start_with, summary, trust,
    wait_until, which_store,
};
use crate::testkit::{Fixtures, fixtures};
use crate::usecases::fleet_host::HostedTool;
use crate::{Core, Receivers};

struct Host {
    core: Core,
    _recv: Receivers,
    project: Project,
    key: DeviceKey,
    _spaces: tempfile::TempDir,
}

/// Connected, accepting up to `max`, `ORIGIN` listed as `kind` and
/// trusted; worktrees are real folders (`space_ask` runs in one).
async fn host(f: &Fixtures, kind: DeviceKind, max: SpaceMode) -> Host {
    let spaces = tempfile::tempdir().unwrap();
    f.git.set_space_root(spaces.path());
    let (core, recv) = start(f);
    let project = project(f, &core).await;
    let key = DeviceKey::generate().unwrap();
    let origin = match kind {
        DeviceKind::Desktop => summary(ORIGIN, &key, "mac1", vec![]),
        other => client(ORIGIN, &key, "Claude", other),
    };
    connect(f, &core, true, vec![origin]).await;
    core.fleet_set_settings(FleetSettingsRequest {
        enabled: None,
        accept_remote: None,
        max_mode: Some(max),
        name: None,
    })
    .await
    .unwrap();
    trust(&core, ORIGIN).await;
    Host {
        core,
        _recv: recv,
        project,
        key,
        _spaces: spaces,
    }
}

/// A space of this computer's own in `mode`, its first turn over.
async fn own_space(f: &Fixtures, h: &Host, goal: &str, mode: SpaceMode) -> Space {
    f.agents.push_script(done("Built it on SQLite."));
    let s = h
        .core
        .create_space(CreateSpaceRequest {
            project: h.project.id.clone(),
            goal: goal.into(),
            name: None,
            branch: None,
            base: None,
            agent: None,
            model: None,
            start_from: None,
            effort: None,
            mode: Some(mode),
        })
        .await
        .unwrap();
    settled(f, &s.id).await
}

async fn settled(f: &Fixtures, id: &str) -> Space {
    wait_until("settled", || {
        let s = space(f, id);
        s.turns >= 1 && s.run.is_none() && s.status != SpaceStatus::Running
    })
    .await;
    space(f, id)
}

fn ok_value(o: ReplyOutcome) -> serde_json::Value {
    match o {
        ReplyOutcome::Ok { value } => value,
        err => panic!("expected ok, got {err:?}"),
    }
}

fn err_code(o: ReplyOutcome) -> String {
    match o {
        ReplyOutcome::Err { code, .. } => code,
        ok => panic!("expected a refusal, got {ok:?}"),
    }
}

/// Delivers `op` from `ORIGIN` and the cloud's yes to its claim; its id.
async fn claimed_request(f: &Fixtures, key: &DeviceKey, op: RemoteOp) -> String {
    let (id, env) = sealed(f, key, op, super::now(f));
    deliver(f, env);
    wait_until("the claim", || claimed(f, &id)).await;
    claim_result(f, &id, true);
    id
}

/// The one prompt waiting here, once it shows.
async fn the_prompt(core: &Core) -> FleetConfirm {
    wait_until("a prompt", || !core.fleet_confirms().is_empty()).await;
    core.fleet_confirms().remove(0)
}

async fn answer(core: &Core, id: &str, allow: bool) {
    core.fleet_confirm(FleetConfirmAnswer {
        id: id.to_string(),
        allow,
    })
    .await
    .unwrap();
}

fn tool_code(r: Result<impl std::fmt::Debug, SpaceToolError>) -> String {
    match r {
        Err(SpaceToolError::Unavailable(m)) => m.split(':').next().unwrap_or_default().to_string(),
        other => panic!("not refused: {other:?}"),
    }
}

fn send_to(space: &str, message: &str) -> RemoteOp {
    RemoteOp::SendTo {
        space: space.into(),
        message: message.into(),
    }
}

// ── the gate ────────────────────────────────────────────────────────────

#[tokio::test]
async fn every_op_needs_trust_and_remote_on_even_reading() {
    let f = fixtures();
    let h = host(&f, DeviceKind::Desktop, SpaceMode::Edit).await;
    let own = own_space(&f, &h, "Pick a store", SpaceMode::Edit).await;
    let ops = [
        RemoteOp::ListSpaces { project: None },
        RemoteOp::ReadSpace {
            space: own.id.clone(),
            messages: None,
        },
        RemoteOp::AskSpace {
            space: own.id.clone(),
            question: "Which store?".into(),
        },
        send_to(&own.id, "go"),
        RemoteOp::AnswerSpace {
            space: own.id.clone(),
            ask: "q".into(),
            answers: vec![],
        },
        RemoteOp::MergeChild {
            parent: own.id.clone(),
            child: "c".into(),
        },
    ];
    // From a device not trusted here: nothing, not even a list.
    let stranger = DeviceKey::generate().unwrap();
    for op in ops.clone() {
        let (id, env) = sealed_from(&f, STRANGER, &stranger, op);
        deliver(&f, env);
        assert_eq!(refusal(&f, &id).await, codes::UNTRUSTED_DEVICE);
        assert!(!claimed(&f, &id));
    }
    // Remote requests off: the same.
    h.core
        .fleet_set_settings(FleetSettingsRequest {
            enabled: None,
            accept_remote: Some(false),
            max_mode: None,
            name: None,
        })
        .await
        .unwrap();
    for op in ops {
        let (id, env) = sealed(&f, &h.key, op, super::now(&f));
        deliver(&f, env);
        assert_eq!(refusal(&f, &id).await, codes::REMOTE_OFF);
        assert!(!claimed(&f, &id));
    }
    assert_eq!(space(&f, &own.id).turns, own.turns, "nothing ran");
}

#[tokio::test]
async fn a_trusted_device_lists_and_reads_every_space_here() {
    let f = fixtures();
    let h = host(&f, DeviceKind::Desktop, SpaceMode::Edit).await;
    let a = own_space(&f, &h, "Pick a store", SpaceMode::Edit).await;
    let b = own_space(&f, &h, "Write the docs", SpaceMode::Plan).await;

    let list = ok_value(run(&f, &h.key, RemoteOp::ListSpaces { project: None }).await);
    let ids: Vec<&str> = list["spaces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["space"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&a.id.as_str()) && ids.contains(&b.id.as_str()));
    assert_eq!(list["note"], theodore_ports::OTHER_SPACE_NOTE);
    let none = ok_value(
        run(
            &f,
            &h.key,
            RemoteOp::ListSpaces {
                project: Some("elsewhere".into()),
            },
        )
        .await,
    );
    assert!(none["spaces"].as_array().unwrap().is_empty());

    let read = ok_value(
        run(
            &f,
            &h.key,
            RemoteOp::ReadSpace {
                space: a.id.clone(),
                messages: Some(5),
            },
        )
        .await,
    );
    assert_eq!(read["space"]["space"], a.id.as_str());
    assert_eq!(read["goal"], "Pick a store");
    assert!(
        read["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["text"] == "Built it on SQLite."),
        "{read}"
    );
    let gone = run(
        &f,
        &h.key,
        RemoteOp::ReadSpace {
            space: "nope".into(),
            messages: None,
        },
    )
    .await;
    assert_eq!(err_code(gone), codes::UNKNOWN_SPACE);
}

#[tokio::test]
async fn ask_space_answers_from_the_space_and_leaves_it_unchanged() {
    let f = fixtures();
    let h = host(&f, DeviceKind::Desktop, SpaceMode::Edit).await;
    let a = own_space(&f, &h, "Pick a store", SpaceMode::Edit).await;
    let before = h.core.space_history(&a).await.unwrap().len();
    f.agents.push_tagged(
        |r| {
            r.prompt
                .contains("Question asked from the user's device \"mac1\"")
        },
        done("SQLite."),
    );
    let asked = ok_value(
        run(
            &f,
            &h.key,
            RemoteOp::AskSpace {
                space: a.id.clone(),
                question: "Which store?".into(),
            },
        )
        .await,
    );
    assert_eq!(asked["answer"], "SQLite.");
    assert_eq!(asked["space"]["space"], a.id.as_str());
    let after = space(&f, &a.id);
    assert_eq!((after.turns, after.mode), (a.turns, a.mode));
    assert_eq!(h.core.space_history(&after).await.unwrap().len(), before);
    let ask = f
        .agents
        .utility_requests()
        .into_iter()
        .find(|r| r.prompt.contains("Which store?"))
        .unwrap();
    assert_eq!(ask.mode, theodore_ports::AgentMode::ReadOnly);
}

#[tokio::test]
async fn send_to_keeps_the_spaces_mode_never_queues_and_stays_under_the_cap() {
    let f = fixtures();
    let h = host(&f, DeviceKind::Desktop, SpaceMode::Edit).await;
    let plan = own_space(&f, &h, "Look around", SpaceMode::Plan).await;
    f.agents.push_script(done("1. a"));
    let sent = ok_value(run(&f, &h.key, send_to(&plan.id, "look again")).await);
    assert!(sent["message"].is_string());
    let row = settled(&f, &plan.id).await;
    assert_eq!(
        row.mode,
        SpaceMode::Plan,
        "never changed from another device"
    );
    assert_eq!(row.turns, plan.turns + 1);

    // While it works: refused, not queued.
    f.agents.hang_next_run();
    h.core
        .space_send(crate::space_children_tests::send(&plan.id, "busy"))
        .await
        .unwrap();
    wait_until("running", || space(&f, &plan.id).run.is_some()).await;
    let busy = run(&f, &h.key, send_to(&plan.id, "now")).await;
    assert_eq!(err_code(busy), codes::BUSY);
    h.core.space_stop(&plan.id).await.unwrap();

    // A Run space is above this computer's Edit cap.
    let wide = own_space(&f, &h, "Run it", SpaceMode::Run).await;
    let above = run(&f, &h.key, send_to(&wide.id, "go")).await;
    assert_eq!(err_code(above), codes::MODE_NOT_ALLOWED);
    assert_eq!(space(&f, &wide.id).turns, wide.turns);
}

#[tokio::test]
async fn answer_space_answers_any_spaces_question() {
    let f = fixtures();
    let h = host(&f, DeviceKind::Desktop, SpaceMode::Edit).await;
    let a = own_space(&f, &h, "Pick a store", SpaceMode::Edit).await;
    f.agents.hang_next_run();
    h.core
        .space_send(crate::space_children_tests::send(&a.id, "and now?"))
        .await
        .unwrap();
    wait_until("running", || space(&f, &a.id).run.is_some()).await;
    let run_id = space(&f, &a.id).run.unwrap();
    let asking = tokio::spawn({
        let (core, local) = (h.core.clone(), a.id.clone());
        async move { core.space_tool_ask(&local, &run_id, which_store()).await }
    });
    wait_until("the question", || space(&f, &a.id).question.is_some()).await;
    let ask = space(&f, &a.id).question.unwrap().id;
    let bad = run(
        &f,
        &h.key,
        RemoteOp::AnswerSpace {
            space: a.id.clone(),
            ask: ask.clone(),
            answers: vec![],
        },
    )
    .await;
    assert_eq!(err_code(bad), codes::INVALID);
    let ok = run(
        &f,
        &h.key,
        RemoteOp::AnswerSpace {
            space: a.id.clone(),
            ask,
            answers: vec![vec!["SQLite".into()]],
        },
    )
    .await;
    assert!(matches!(ok, ReplyOutcome::Ok { .. }), "{ok:?}");
    assert_eq!(asking.await.unwrap().unwrap()[0].selected, ["SQLite"]);
}

// ── Claude via the cloud ────────────────────────────────────────────────

#[tokio::test]
async fn an_mcp_send_to_waits_for_a_person_and_auto_lets_it_through() {
    let f = fixtures();
    let h = host(&f, DeviceKind::Mcp, SpaceMode::Edit).await;
    let a = own_space(&f, &h, "Fix login", SpaceMode::Edit).await;
    let plan = own_space(&f, &h, "Look around", SpaceMode::Plan).await;

    // A Plan space's message needs nobody.
    f.agents.push_script(done("1. a"));
    let ok = run(&f, &h.key, send_to(&plan.id, "look again")).await;
    assert!(matches!(ok, ReplyOutcome::Ok { .. }), "{ok:?}");
    assert!(h.core.fleet_confirms().is_empty());

    // An Edit space's waits: pending until a person says yes.
    let id = claimed_request(&f, &h.key, send_to(&a.id, "go on")).await;
    let p = the_prompt(&h.core).await;
    assert_eq!(p.id, id);
    assert_eq!(p.action, FleetConfirmAction::Send);
    assert_eq!(p.mode, SpaceMode::Edit);
    assert_eq!(p.local_space.as_deref(), Some(a.id.as_str()));
    assert_eq!(p.text, "go on");
    assert_eq!(reply_of(&f, &id), None);
    assert_eq!(space(&f, &a.id).turns, a.turns, "nothing ran yet");
    f.agents.push_script(done("went on"));
    answer(&h.core, &id, true).await;
    wait_until("the reply", || reply_of(&f, &id).is_some()).await;
    assert!(matches!(reply_of(&f, &id), Some(ReplyOutcome::Ok { .. })));
    let row = settled(&f, &a.id).await;
    assert_eq!((row.turns, row.mode), (a.turns + 1, SpaceMode::Edit));

    // Denied: refused, nothing runs.
    let id = claimed_request(&f, &h.key, send_to(&a.id, "again")).await;
    answer(&h.core, &the_prompt(&h.core).await.id, false).await;
    assert_eq!(refusal(&f, &id).await, codes::DENIED);

    // Auto Edit: straight through.
    h.core
        .fleet_set_auto(FleetAutoRequest {
            device_id: ORIGIN.into(),
            auto: FleetAuto::Edit,
            until_ms: None,
            host_device: None,
        })
        .await
        .unwrap();
    f.agents.push_script(done("auto"));
    let ok = run(&f, &h.key, send_to(&a.id, "once more")).await;
    assert!(matches!(ok, ReplyOutcome::Ok { .. }), "{ok:?}");
    assert!(h.core.fleet_confirms().is_empty());
}

#[tokio::test]
async fn an_mcp_merge_waits_for_a_person_then_merges_the_child() {
    let f = fixtures();
    let h = host(&f, DeviceKind::Mcp, SpaceMode::Edit).await;
    let parent = own_space(&f, &h, "Split the work", SpaceMode::Edit).await;
    f.git.push_checkpoint(Sha::new("child1"));
    f.agents.push_script(done("ported"));
    let child = h
        .core
        .sub_space_start(
            &parent.id,
            SpaceMode::Edit,
            LocalSpaceStart {
                goal: "Port the parser".into(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let child = settled(&f, &child.space).await;
    assert_eq!(child.head_sha, Sha::new("child1"));

    // Not its child: refused at the gate.
    let other = own_space(&f, &h, "Elsewhere", SpaceMode::Edit).await;
    let wrong = run(
        &f,
        &h.key,
        RemoteOp::MergeChild {
            parent: parent.id.clone(),
            child: other.id.clone(),
        },
    )
    .await;
    assert_eq!(err_code(wrong), codes::INVALID);

    let op = RemoteOp::MergeChild {
        parent: parent.id.clone(),
        child: child.id.clone(),
    };
    let id = claimed_request(&f, &h.key, op).await;
    let p = the_prompt(&h.core).await;
    assert_eq!(p.action, FleetConfirmAction::Merge);
    assert_eq!(p.mode, SpaceMode::Edit);
    assert_eq!(p.local_space.as_deref(), Some(parent.id.as_str()));
    assert!(f.git.apply_calls.lock().unwrap().is_empty(), "nothing yet");
    answer(&h.core, &id, true).await;
    wait_until("the reply", || reply_of(&f, &id).is_some()).await;
    let merged = ok_value(reply_of(&f, &id).unwrap());
    assert_eq!(merged["to"], "child1");
    assert_eq!(merged["space"]["done"], true);
    assert_eq!(f.git.apply_calls.lock().unwrap().len(), 1);
}

// ── sub-spaces of a hosted space ────────────────────────────────────────

fn goal(text: &str) -> LocalSpaceStart {
    LocalSpaceStart {
        goal: text.into(),
        ..Default::default()
    }
}

#[tokio::test]
async fn a_hosted_mcp_space_starts_sub_spaces_with_a_persons_yes_mirrored_to_its_origin() {
    let f = fixtures();
    let h = host(&f, DeviceKind::Mcp, SpaceMode::Edit).await;
    f.agents.push_script(done("1. split"));
    let ok = run(
        &f,
        &h.key,
        start_with(&h.project.id, "rs_h", FleetMode::Plan, None, 0),
    )
    .await;
    assert!(matches!(ok, ReplyOutcome::Ok { .. }), "{ok:?}");
    let local = local_of(&f, "rs_h");
    settled(&f, &local).await;

    // Its Edit child waits for a person here.
    let starting = tokio::spawn({
        let (core, local) = (h.core.clone(), local.clone());
        async move {
            core.sub_space_start(&local, SpaceMode::Edit, goal("Port the parser"))
                .await
        }
    });
    let p = the_prompt(&h.core).await;
    assert_eq!(p.action, FleetConfirmAction::Start);
    assert_eq!(p.mode, SpaceMode::Edit);
    assert_eq!(p.device_id, ORIGIN);
    assert_eq!(p.local_space.as_deref(), Some(local.as_str()));
    assert_eq!(p.text, "Port the parser");
    assert!(!starting.is_finished());
    f.agents.push_script(done("ported"));
    answer(&h.core, &p.id, true).await;
    let child = starting.await.unwrap().unwrap();
    let row = settled(&f, &child.space).await;
    assert_eq!(row.parent.as_ref().unwrap().space, local);
    // Owned by the hosted space, hosted like it: the same limits.
    assert!(h.core.fleet_hosts_local(&row.id).await);
    assert!(
        h.core
            .fleet_hosted_may(&row, HostedTool::RunCheck)
            .await
            .is_err()
    );

    // The origin sees it in the hosted space's tree.
    let sub = |f: &Fixtures| {
        events(f, "rs_h")
            .into_iter()
            .rev()
            .filter_map(|(_, e)| match e {
                RemoteSpaceEvent::Mirror { model, id, data }
                    if model == SUB_SPACE_MODEL && id == row.id =>
                {
                    data.and_then(|d| serde_json::from_value::<MirroredSubSpace>(d).ok())
                }
                _ => None,
            })
            .next()
    };
    wait_until("mirrored", || sub(&f).is_some()).await;
    let m = sub(&f).unwrap();
    assert_eq!((m.parent.as_str(), m.mode), ("rs_h", FleetMode::Edit));
    assert_eq!(m.title, "Port the parser");

    // Denied: refused, nothing started.
    let n = h.core.list_spaces(None).await.unwrap().len();
    let starting = tokio::spawn({
        let (core, local) = (h.core.clone(), local.clone());
        async move {
            core.sub_space_start(&local, SpaceMode::Edit, goal("More"))
                .await
        }
    });
    answer(&h.core, &the_prompt(&h.core).await.id, false).await;
    assert_eq!(tool_code(starting.await.unwrap()), "sub_spaces.denied");
    assert_eq!(h.core.list_spaces(None).await.unwrap().len(), n);

    // A message to its own child in Edit asks too.
    let sending = tokio::spawn({
        let (core, local, child) = (h.core.clone(), local.clone(), row.id.clone());
        async move {
            core.sub_space_send(&local, SpaceMode::Edit, &child, "and tests", None)
                .await
        }
    });
    let p = the_prompt(&h.core).await;
    assert_eq!(p.action, FleetConfirmAction::Send);
    answer(&h.core, &p.id, false).await;
    assert_eq!(tool_code(sending.await.unwrap()), "sub_spaces.denied");

    // A Plan child needs nobody; nor does an Edit one under auto mode.
    f.agents.push_script(done("looked"));
    let plan = LocalSpaceStart {
        mode: Some("plan".into()),
        ..goal("Look around")
    };
    h.core
        .sub_space_start(&local, SpaceMode::Edit, plan)
        .await
        .unwrap();
    h.core
        .fleet_set_auto(FleetAutoRequest {
            device_id: ORIGIN.into(),
            auto: FleetAuto::Edit,
            until_ms: None,
            host_device: None,
        })
        .await
        .unwrap();
    f.agents.push_script(done("auto"));
    h.core
        .sub_space_start(&local, SpaceMode::Edit, goal("Auto"))
        .await
        .unwrap();
    assert!(h.core.fleet_confirms().is_empty());

    // It doesn't steer this computer's own spaces.
    let own = own_space(&f, &h, "Mine", SpaceMode::Edit).await;
    let r = h
        .core
        .sub_space_send(&local, SpaceMode::Edit, &own.id, "x", None)
        .await;
    assert_eq!(tool_code(r), "sub_spaces.hosted");
}

#[tokio::test]
async fn a_hosted_computers_space_starts_sub_spaces_within_max_mode() {
    let f = fixtures();
    let h = host(&f, DeviceKind::Desktop, SpaceMode::Edit).await;
    f.agents.push_script(done("ok"));
    run(
        &f,
        &h.key,
        start_with(&h.project.id, "rs_h", FleetMode::Edit, None, 0),
    )
    .await;
    let local = local_of(&f, "rs_h");
    settled(&f, &local).await;

    // No yes needed from a computer's space…
    f.agents.push_script(vec![AgentEvent::Done {
        final_text: "child".into(),
        usage: Default::default(),
    }]);
    h.core
        .sub_space_start(&local, SpaceMode::Edit, goal("Port it"))
        .await
        .unwrap();
    assert!(h.core.fleet_confirms().is_empty());
    // …but never above this computer's cap.
    let run_child = LocalSpaceStart {
        mode: Some("run".into()),
        ..goal("Run it")
    };
    let r = h
        .core
        .sub_space_start(&local, SpaceMode::Run, run_child)
        .await;
    assert_eq!(tool_code(r), "sub_spaces.mode");
    // Nor once that computer isn't trusted here any more.
    h.core
        .fleet_trust_device(theodore_contract::FleetTrustRequest {
            device_id: ORIGIN.into(),
            trusted: false,
            public_key: None,
        })
        .await
        .unwrap();
    let r = h
        .core
        .sub_space_start(&local, SpaceMode::Edit, goal("More"))
        .await;
    assert_eq!(tool_code(r), "sub_spaces.hosted");
}
