//! Claude via the cloud (docs/fleet.md "Trust"): a device of kind `mcp`,
//! whose key the cloud holds, asks and plans here like any trusted client;
//! an edit or run waits for a person here, a daemon refuses it. A child of
//! `fleet_tests`, for its harness.

use theodore_contract::{
    Ephemeral, FleetConfirmAction, FleetConfirmAnswer, SpaceMode, SpaceStatus,
};
use theodore_fleet_protocol::{
    DeviceKey, DeviceKind, FleetMode, REQUEST_WINDOW_MS, RemoteOp, ReplyOutcome, ServerMessage,
    codes,
};
use theodore_ports::FleetInbound;

use super::{
    ORIGIN, asks, claim_result, claimed, client, connect, deliver, done, local_of, project,
    refusal, reply_of, resolved, run, sealed, space, start, start_with, summary, trust, wait_until,
    which_store,
};
use crate::testkit::{Fixtures, fixtures};
use crate::usecases::fleet_host::HostedTool;
use crate::{Core, Receivers};

/// Connected, accepting, `ORIGIN` listed as Claude via the cloud (`mcp`)
/// and trusted; `daemon`: this core runs as `theodore daemon`.
async fn mcp_target(
    f: &Fixtures,
    daemon: bool,
) -> (Core, Receivers, theodore_contract::Project, DeviceKey) {
    let (core, recv) = start(f);
    core.set_fleet_daemon(daemon);
    let project = project(f, &core).await;
    let key = DeviceKey::generate().unwrap();
    connect(
        f,
        &core,
        true,
        vec![client(ORIGIN, &key, "Claude", DeviceKind::Mcp)],
    )
    .await;
    trust(&core, ORIGIN).await;
    (core, recv, project, key)
}

/// Delivers `op` from `ORIGIN` and the cloud's yes to its claim; its id.
async fn claimed_request(f: &Fixtures, key: &DeviceKey, op: RemoteOp) -> String {
    let (id, env) = sealed(f, key, op, super::now(f));
    deliver(f, env);
    wait_until("the claim", || claimed(f, &id)).await;
    claim_result(f, &id, true);
    id
}

/// The prompt for request `id`, once it shows.
async fn prompt(core: &Core, id: &str) -> theodore_contract::FleetConfirm {
    wait_until("the prompt", || {
        core.fleet_confirms().iter().any(|c| c.id == id)
    })
    .await;
    core.fleet_confirms()
        .into_iter()
        .find(|c| c.id == id)
        .unwrap()
}

fn send(space: &str, text: &str, mode: Option<FleetMode>) -> RemoteOp {
    RemoteOp::Send {
        space: space.into(),
        text: text.into(),
        mode,
        agent: None,
        model: None,
        effort: None,
        attachments: vec![],
    }
}

fn answer(core: &Core, id: &str, allow: bool) -> impl std::future::Future<Output = ()> {
    let core = core.clone();
    let id = id.to_string();
    async move {
        core.fleet_confirm(FleetConfirmAnswer { id, allow })
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn an_mcp_ask_or_plan_runs_without_a_person_and_stays_a_hosted_space() {
    let f = fixtures();
    let (core, mut recv, project, key) = mcp_target(&f, false).await;
    f.agents.push_script(done("read it"));
    let ok = run(
        &f,
        &key,
        start_with(&project.id, "rs_a", FleetMode::Ask, None, 0),
    )
    .await;
    assert!(matches!(ok, ReplyOutcome::Ok { .. }), "{ok:?}");
    f.agents.push_script(done("1. a"));
    let ok = run(
        &f,
        &key,
        start_with(&project.id, "rs_p", FleetMode::Plan, None, 0),
    )
    .await;
    assert!(matches!(ok, ReplyOutcome::Ok { .. }), "{ok:?}");
    while let Ok(e) = recv.ephemeral.try_recv() {
        assert!(!matches!(e, Ephemeral::FleetConfirm { .. }), "no prompt");
    }
    // Hosted for another device: the same limits as any.
    let local = space(&f, &local_of(&f, "rs_a"));
    assert!(
        core.fleet_hosted_may(&local, HostedTool::RunCheck)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn an_mcp_edit_waits_for_a_person_without_holding_up_others_then_runs() {
    let f = fixtures();
    let (core, mut recv, project, key) = mcp_target(&f, false).await;
    // The cloud now lists it as a computer: the pin's kind still caps it.
    f.fleet.push(FleetInbound::Message(ServerMessage::Devices {
        devices: vec![summary(ORIGIN, &key, "Claude", vec![])],
    }));
    wait_until("listed as a computer", || {
        core.fleet().devices[0].info.kind == DeviceKind::Desktop
    })
    .await;

    f.agents.push_script(done("edited"));
    let id = claimed_request(
        &f,
        &key,
        start_with(&project.id, "rs_e", FleetMode::Edit, None, 0),
    )
    .await;
    let p = prompt(&core, &id).await;
    assert_eq!(p.action, FleetConfirmAction::Start);
    assert_eq!(p.mode, SpaceMode::Edit);
    let named = core
        .fleet_projects()
        .await
        .into_iter()
        .find(|r| r.id == project.id)
        .unwrap()
        .name;
    assert_eq!(p.project_name, Some(named));
    assert_eq!(p.text, "Fix it");
    assert_eq!(p.device_name, "Claude");
    let mut shown = false;
    while let Ok(e) = recv.ephemeral.try_recv() {
        shown |= matches!(&e, Ephemeral::FleetConfirm { request } if request.id == id);
    }
    assert!(shown, "the prompt went to the UI");
    assert_eq!(reply_of(&f, &id), None);
    assert!(core.list_spaces(None).await.unwrap().is_empty());

    // Another request meanwhile isn't held up.
    f.agents.push_script(done("read"));
    let ok = run(
        &f,
        &key,
        start_with(&project.id, "rs_a", FleetMode::Ask, None, 0),
    )
    .await;
    assert!(matches!(ok, ReplyOutcome::Ok { .. }), "{ok:?}");
    assert_eq!(reply_of(&f, &id), None);

    answer(&core, &id, true).await;
    wait_until("the reply", || reply_of(&f, &id).is_some()).await;
    assert!(
        matches!(reply_of(&f, &id), Some(ReplyOutcome::Ok { .. })),
        "{:?}",
        reply_of(&f, &id)
    );
    assert_eq!(space(&f, &local_of(&f, "rs_e")).mode, SpaceMode::Edit);
    assert!(core.fleet_confirms().is_empty());
    let mut done_shown = false;
    while let Ok(e) = recv.ephemeral.try_recv() {
        done_shown |= matches!(&e, Ephemeral::FleetConfirmDone { id: d } if *d == id);
    }
    assert!(done_shown, "the prompt is dropped");
    // Answered already.
    assert!(
        core.fleet_confirm(FleetConfirmAnswer {
            id: id.clone(),
            allow: true
        })
        .await
        .is_err()
    );
}

#[tokio::test]
async fn an_mcp_edit_denied_or_unanswered_is_refused_as_denied() {
    let f = fixtures();
    let (core, _recv, project, key) = mcp_target(&f, false).await;

    let id = claimed_request(
        &f,
        &key,
        start_with(&project.id, "rs_d", FleetMode::Edit, None, 0),
    )
    .await;
    prompt(&core, &id).await;
    answer(&core, &id, false).await;
    assert_eq!(refusal(&f, &id).await, codes::DENIED);

    let id = claimed_request(
        &f,
        &key,
        start_with(&project.id, "rs_t", FleetMode::Edit, None, 0),
    )
    .await;
    prompt(&core, &id).await;
    f.clock.advance(REQUEST_WINDOW_MS as i64 + 1);
    assert_eq!(refusal(&f, &id).await, codes::DENIED);
    assert!(core.fleet_confirms().is_empty());
    assert!(core.list_spaces(None).await.unwrap().is_empty());
}

#[tokio::test]
async fn a_daemon_refuses_an_mcp_edit_outright_and_still_takes_its_ask() {
    let f = fixtures();
    let (core, _recv, project, key) = mcp_target(&f, true).await;
    let (id, env) = sealed(
        &f,
        &key,
        start_with(&project.id, "rs_e", FleetMode::Edit, None, 0),
        super::now(&f),
    );
    deliver(&f, env);
    assert_eq!(refusal(&f, &id).await, codes::DENIED);
    assert!(!claimed(&f, &id));
    assert!(core.fleet_confirms().is_empty());

    f.agents.push_script(done("read"));
    let ok = run(
        &f,
        &key,
        start_with(&project.id, "rs_a", FleetMode::Ask, None, 0),
    )
    .await;
    assert!(matches!(ok, ReplyOutcome::Ok { .. }), "{ok:?}");
}

#[tokio::test]
async fn approving_an_mcp_plan_waits_for_a_person_and_answers_and_stop_do_not() {
    let f = fixtures();
    let (core, _recv, project, key) = mcp_target(&f, false).await;
    f.agents.push_script(done("1. change a"));
    run(
        &f,
        &key,
        start_with(&project.id, "rs_p", FleetMode::Plan, None, 0),
    )
    .await;
    let local = local_of(&f, "rs_p");
    wait_until("idle", || space(&f, &local).status == SpaceStatus::Idle).await;

    // Approve: a send in the build mode.
    let id = claimed_request(
        &f,
        &key,
        send(
            "rs_p",
            crate::usecases::space_plan::APPROVED_TEXT,
            Some(FleetMode::Edit),
        ),
    )
    .await;
    let p = prompt(&core, &id).await;
    assert_eq!(p.action, FleetConfirmAction::ApprovePlan);
    assert_eq!(p.local_space.as_deref(), Some(local.as_str()));
    answer(&core, &id, false).await;
    assert_eq!(refusal(&f, &id).await, codes::DENIED);

    // A send in the space's own Plan mode needs nobody.
    f.agents.hang_next_run();
    let ok = run(&f, &key, send("rs_p", "look again", None)).await;
    assert!(matches!(ok, ReplyOutcome::Ok { .. }), "{ok:?}");
    wait_until("running", || space(&f, &local).run.is_some()).await;
    let run_id = space(&f, &local).run.unwrap();

    // Its question is answered from the cloud without a prompt.
    let asking = tokio::spawn({
        let (core, local, run_id) = (core.clone(), local.clone(), run_id.clone());
        async move { core.space_tool_ask(&local, &run_id, which_store()).await }
    });
    wait_until("the ask", || !asks(&f).is_empty()).await;
    let ask = asks(&f).remove(0);
    let ok = run(
        &f,
        &key,
        RemoteOp::Answer {
            space: "rs_p".into(),
            ask_id: ask.ask_id.clone(),
            answers: vec![vec!["SQLite".into()]],
        },
    )
    .await;
    assert!(matches!(ok, ReplyOutcome::Ok { .. }), "{ok:?}");
    assert_eq!(asking.await.unwrap().unwrap()[0].selected, ["SQLite"]);
    wait_until("resolved", || resolved(&f, &ask.ask_id)).await;

    // And stopped without one.
    let ok = run(
        &f,
        &key,
        RemoteOp::Stop {
            space: "rs_p".into(),
        },
    )
    .await;
    assert!(matches!(ok, ReplyOutcome::Ok { .. }), "{ok:?}");
    assert!(core.fleet_confirms().is_empty());
}

#[tokio::test]
async fn an_mcp_device_is_listed_trusted_and_never_followed() {
    let f = fixtures();
    let (core, _recv, _project, _key) = mcp_target(&f, false).await;
    let d = core
        .fleet_status()
        .await
        .unwrap()
        .devices
        .into_iter()
        .find(|d| d.device_id == ORIGIN)
        .unwrap();
    assert_eq!((d.kind.as_str(), d.trusted), ("mcp", true));
    let e = core.fleet_delegate(ORIGIN, true).await.unwrap_err();
    assert!(
        e.to_string().contains("phone, the web app or a computer"),
        "{e}"
    );
}
