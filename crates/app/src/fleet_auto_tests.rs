//! Auto mode and remote prompts (docs/fleet.md "Auto mode and remote
//! prompts"): Claude via the cloud's Edit (or Edit and Run) goes through
//! without a person while the user turned auto on here, never past
//! `max_mode`; a prompt waiting here is answered from a device this one
//! delegates to, and a prompt waiting on another computer is shown and
//! answered here. A child of `fleet_tests`, for its harness.

use theodore_contract::{
    Ephemeral, FleetAuto, FleetAutoRequest, FleetConfirmAction, FleetConfirmAnswer,
    FleetSettingsRequest, SpaceMode,
};
use theodore_fleet_protocol::{
    ClientMessage, ConfirmAction, DeviceKey, DeviceKind, Domain, FleetMode, McpAuto, RemoteConfirm,
    RemoteOp, RemoteRequest, ReplyOutcome, ServerMessage, SignedEnvelope, codes,
};
use theodore_ports::FleetInbound;

use super::{
    ME, ORIGIN, PHONE, STRANGER, TARGET, claim_result, claimed, client, connect, deliver,
    ephemerals, my_key, now, project, refusal, reply_of, requests, run, run_from, sealed,
    sealed_from, signed_reply, start, start_with, summary, trust, wait_until,
};
use crate::testkit::{FakeFleetCommand, Fixtures, fixtures};
use crate::{Core, Receivers};

const HOUR: u64 = 60 * 60 * 1000;

/// Connected, accepting up to `max`, `ORIGIN` listed as Claude via the
/// cloud and trusted, `PHONE` and `TARGET` (a computer) listed too.
async fn host(
    f: &Fixtures,
    daemon: bool,
    max: SpaceMode,
) -> (
    Core,
    Receivers,
    theodore_contract::Project,
    DeviceKey,
    DeviceKey,
    DeviceKey,
) {
    let (core, recv) = start(f);
    core.set_fleet_daemon(daemon);
    let project = project(f, &core).await;
    let (mcp, phone, mac) = (
        DeviceKey::generate().unwrap(),
        DeviceKey::generate().unwrap(),
        DeviceKey::generate().unwrap(),
    );
    connect(
        f,
        &core,
        true,
        vec![
            client(ORIGIN, &mcp, "Claude (MCP)", DeviceKind::Mcp),
            client(PHONE, &phone, "iPhone", DeviceKind::Mobile),
            summary(TARGET, &mac, "mac1", vec![]),
        ],
    )
    .await;
    core.fleet_set_settings(FleetSettingsRequest {
        enabled: None,
        accept_remote: None,
        max_mode: Some(max),
        name: None,
    })
    .await
    .unwrap();
    trust(&core, ORIGIN).await;
    (core, recv, project, mcp, phone, mac)
}

async fn set_auto(core: &Core, auto: FleetAuto, until_ms: Option<u64>) {
    core.fleet_set_auto(FleetAutoRequest {
        device_id: ORIGIN.into(),
        auto,
        until_ms,
        host_device: None,
    })
    .await
    .unwrap();
}

fn no_prompt(core: &Core, recv: &mut Receivers) {
    assert!(core.fleet_confirms().is_empty());
    assert!(
        !ephemerals(recv)
            .iter()
            .any(|e| matches!(e, Ephemeral::FleetConfirm { .. })),
        "no prompt"
    );
}

/// Delivers `op` from `ORIGIN` and the cloud's yes to its claim; its id.
async fn claimed_request(f: &Fixtures, key: &DeviceKey, op: RemoteOp) -> String {
    let (id, env) = sealed(f, key, op, now(f));
    deliver(f, env);
    wait_until("the claim", || claimed(f, &id)).await;
    claim_result(f, &id, true);
    id
}

async fn prompt_shows(core: &Core, id: &str) {
    wait_until("the prompt", || {
        core.fleet_confirms().iter().any(|c| c.id == id)
    })
    .await;
}

fn ok(outcome: &ReplyOutcome) -> bool {
    matches!(outcome, ReplyOutcome::Ok { .. })
}

#[tokio::test]
async fn edit_auto_runs_an_edit_without_a_prompt_and_still_prompts_for_run() {
    let f = fixtures();
    let (core, mut recv, project, mcp, _, _) = host(&f, false, SpaceMode::Run).await;
    set_auto(&core, FleetAuto::Edit, None).await;
    let status = core.fleet_status().await.unwrap();
    let row = status
        .devices
        .iter()
        .find(|d| d.device_id == ORIGIN)
        .unwrap();
    assert_eq!((row.auto, row.auto_until_ms), (FleetAuto::Edit, None));
    assert_eq!(status.autos.len(), 1);
    assert_eq!(status.autos[0].device_name, "Claude (MCP)");

    f.agents.push_script(super::done("edited"));
    let out = run(
        &f,
        &mcp,
        start_with(&project.id, "rs_e", FleetMode::Edit, None, 0),
    )
    .await;
    assert!(ok(&out), "{out:?}");
    no_prompt(&core, &mut recv);

    let id = claimed_request(
        &f,
        &mcp,
        start_with(&project.id, "rs_r", FleetMode::Run, None, 0),
    )
    .await;
    prompt_shows(&core, &id).await;
    core.fleet_confirm(FleetConfirmAnswer {
        id: id.clone(),
        allow: false,
    })
    .await
    .unwrap();
    assert_eq!(refusal(&f, &id).await, codes::DENIED);
}

#[tokio::test]
async fn full_auto_runs_edit_and_run() {
    let f = fixtures();
    let (core, mut recv, project, mcp, _, _) = host(&f, false, SpaceMode::Run).await;
    set_auto(&core, FleetAuto::Full, Some(now(&f) + HOUR)).await;
    for (space, mode) in [("rs_e", FleetMode::Edit), ("rs_r", FleetMode::Run)] {
        f.agents.push_script(super::done("done"));
        let out = run(&f, &mcp, start_with(&project.id, space, mode, None, 0)).await;
        assert!(ok(&out), "{space}: {out:?}");
    }
    no_prompt(&core, &mut recv);
}

#[tokio::test]
async fn an_expired_auto_reads_off_says_so_and_prompts_again() {
    let f = fixtures();
    let (core, mut recv, project, mcp, _, _) = host(&f, false, SpaceMode::Edit).await;
    set_auto(&core, FleetAuto::Edit, Some(now(&f) + HOUR)).await;
    // The computer's info tells the other devices.
    let announced = commands_info(&f);
    assert!(
        announced.iter().any(|i| i
            .iter()
            .any(|a| a.device_id == ORIGIN && a.auto == McpAuto::Edit)),
        "{announced:?}"
    );
    let _ = ephemerals(&mut recv);

    f.clock.advance(HOUR as i64 + 1);
    super::eventually("auto off", || async {
        core.fleet_status().await.unwrap().autos.is_empty()
    })
    .await;
    wait_until("the update", || {
        ephemerals(&mut recv)
            .iter()
            .any(|e| matches!(e, Ephemeral::FleetStatus { status } if status.autos.is_empty()))
    })
    .await;
    let row = core
        .fleet_status()
        .await
        .unwrap()
        .devices
        .into_iter()
        .find(|d| d.device_id == ORIGIN)
        .unwrap();
    assert_eq!(row.auto, FleetAuto::Off);

    let id = claimed_request(
        &f,
        &mcp,
        start_with(&project.id, "rs_e", FleetMode::Edit, None, 0),
    )
    .await;
    prompt_shows(&core, &id).await;
}

#[tokio::test]
async fn a_daemon_with_auto_runs_an_edit() {
    let f = fixtures();
    let (core, _recv, project, mcp, _, _) = host(&f, true, SpaceMode::Edit).await;
    set_auto(&core, FleetAuto::Edit, None).await;
    f.agents.push_script(super::done("edited"));
    let out = run(
        &f,
        &mcp,
        start_with(&project.id, "rs_e", FleetMode::Edit, None, 0),
    )
    .await;
    assert!(ok(&out), "{out:?}");
}

#[tokio::test]
async fn auto_never_lifts_max_mode() {
    let f = fixtures();
    let (core, _recv, project, mcp, _, _) = host(&f, false, SpaceMode::Edit).await;
    set_auto(&core, FleetAuto::Full, None).await;
    let (id, env) = sealed(
        &f,
        &mcp,
        start_with(&project.id, "rs_r", FleetMode::Run, None, 0),
        now(&f),
    );
    deliver(&f, env);
    assert_eq!(refusal(&f, &id).await, codes::MODE_NOT_ALLOWED);
    assert!(core.list_spaces(None).await.unwrap().is_empty());
}

#[tokio::test]
async fn auto_is_only_for_claude_via_cloud_and_never_in_the_past() {
    let f = fixtures();
    let (core, _recv, _project, _mcp, _, _) = host(&f, false, SpaceMode::Edit).await;
    trust(&core, PHONE).await;
    let e = core
        .fleet_set_auto(FleetAutoRequest {
            device_id: PHONE.into(),
            auto: FleetAuto::Edit,
            until_ms: None,
            host_device: None,
        })
        .await
        .unwrap_err();
    assert!(e.to_string().contains("only for Claude via cloud"), "{e}");
    let e = core
        .fleet_set_auto(FleetAutoRequest {
            device_id: ORIGIN.into(),
            auto: FleetAuto::Edit,
            until_ms: Some(now(&f) - 1),
            host_device: None,
        })
        .await
        .unwrap_err();
    assert!(e.to_string().contains("passed"), "{e}");
    let e = core
        .fleet_set_auto(FleetAutoRequest {
            device_id: STRANGER.into(),
            auto: FleetAuto::Edit,
            until_ms: None,
            host_device: None,
        })
        .await
        .unwrap_err();
    assert!(e.to_string().contains("isn't trusted"), "{e}");
}

/// The `mcp_auto` lists this device announced, in order.
fn commands_info(f: &Fixtures) -> Vec<Vec<theodore_fleet_protocol::McpAutoState>> {
    super::commands(f, 0)
        .into_iter()
        .filter_map(|c| match c {
            FakeFleetCommand::Update { info, .. } => Some(info.mcp_auto),
            _ => None,
        })
        .collect()
}

/// Prompts this device sent its delegates, each opened with its own key.
fn published(f: &Fixtures) -> Vec<RemoteConfirm> {
    f.fleet
        .sent()
        .into_iter()
        .filter_map(|m| match m {
            ClientMessage::Confirm { envelope } => Some(
                envelope
                    .open_as(&my_key(f), Domain::Confirm)
                    .expect("signed by this device as the host"),
            ),
            _ => None,
        })
        .collect()
}

fn resolved(f: &Fixtures, id: &str) -> bool {
    f.fleet
        .sent()
        .into_iter()
        .any(|m| matches!(m, ClientMessage::ConfirmResolved { confirm_id } if confirm_id == id))
}

fn confirm_op(id: &str, allow: bool) -> RemoteOp {
    RemoteOp::Confirm {
        confirm_id: id.into(),
        allow,
    }
}

/// `host` with `PHONE` trusted and sent this device's prompts.
async fn delegating_host(
    f: &Fixtures,
) -> (
    Core,
    theodore_contract::Project,
    DeviceKey,
    DeviceKey,
    DeviceKey,
) {
    let (core, _recv, project, mcp, phone, mac) = host(f, false, SpaceMode::Edit).await;
    trust(&core, PHONE).await;
    core.fleet_delegate(PHONE, true).await.unwrap();
    (core, project, mcp, phone, mac)
}

#[tokio::test]
async fn a_prompt_goes_to_the_delegates_and_their_allow_runs_it() {
    let f = fixtures();
    let (core, project, mcp, phone, _) = delegating_host(&f).await;
    f.agents.push_script(super::done("edited"));
    let id = claimed_request(
        &f,
        &mcp,
        start_with(&project.id, "rs_e", FleetMode::Edit, None, 0),
    )
    .await;
    prompt_shows(&core, &id).await;
    wait_until("published", || !published(&f).is_empty()).await;
    let p = published(&f).remove(0);
    assert_eq!(
        (
            p.confirm_id.as_str(),
            p.host_device.as_str(),
            p.mcp_device.as_str()
        ),
        (id.as_str(), ME, ORIGIN)
    );
    assert_eq!(
        (p.action, p.mode, p.text.as_str()),
        (ConfirmAction::Start, FleetMode::Edit, "Fix it")
    );

    let out = run_from(&f, PHONE, &phone, confirm_op(&id, true)).await;
    assert!(ok(&out), "{out:?}");
    wait_until("the reply", || reply_of(&f, &id).is_some()).await;
    assert!(ok(&reply_of(&f, &id).unwrap()));
    assert!(core.fleet_confirms().is_empty());
    wait_until("resolved", || resolved(&f, &id)).await;

    // First answer wins: a late one is refused, nothing runs twice.
    let late = run_from(&f, PHONE, &phone, confirm_op(&id, false)).await;
    assert!(matches!(late, ReplyOutcome::Err { ref code, .. } if code == codes::INVALID));
}

#[tokio::test]
async fn a_delegates_deny_refuses_it_and_a_local_answer_wins_over_a_later_one() {
    let f = fixtures();
    let (core, project, mcp, phone, _) = delegating_host(&f).await;
    let id = claimed_request(
        &f,
        &mcp,
        start_with(&project.id, "rs_d", FleetMode::Edit, None, 0),
    )
    .await;
    prompt_shows(&core, &id).await;
    let out = run_from(&f, PHONE, &phone, confirm_op(&id, false)).await;
    assert!(ok(&out), "{out:?}");
    assert_eq!(refusal(&f, &id).await, codes::DENIED);

    let id = claimed_request(
        &f,
        &mcp,
        start_with(&project.id, "rs_l", FleetMode::Edit, None, 0),
    )
    .await;
    prompt_shows(&core, &id).await;
    core.fleet_confirm(FleetConfirmAnswer {
        id: id.clone(),
        allow: false,
    })
    .await
    .unwrap();
    let late = run_from(&f, PHONE, &phone, confirm_op(&id, true)).await;
    assert!(matches!(late, ReplyOutcome::Err { ref code, .. } if code == codes::INVALID));
    assert_eq!(refusal(&f, &id).await, codes::DENIED);
    assert!(core.list_spaces(None).await.unwrap().is_empty());
}

#[tokio::test]
async fn only_a_trusted_delegate_that_isnt_claude_may_answer() {
    let f = fixtures();
    let (core, project, mcp, _, mac) = delegating_host(&f).await;
    let id = claimed_request(
        &f,
        &mcp,
        start_with(&project.id, "rs_e", FleetMode::Edit, None, 0),
    )
    .await;
    prompt_shows(&core, &id).await;

    // Not trusted here.
    let stranger = DeviceKey::generate().unwrap();
    let (rid, env) = sealed_from(&f, STRANGER, &stranger, confirm_op(&id, true));
    deliver(&f, env);
    assert_eq!(refusal(&f, &rid).await, codes::UNTRUSTED_DEVICE);
    // Claude via the cloud itself.
    let out = run(&f, &mcp, confirm_op(&id, true)).await;
    assert!(matches!(out, ReplyOutcome::Err { ref code, .. } if code == codes::INVALID));
    // A trusted computer this device doesn't send its prompts to.
    trust(&core, TARGET).await;
    let out = run_from(&f, TARGET, &mac, confirm_op(&id, true)).await;
    assert!(matches!(out, ReplyOutcome::Err { ref code, .. } if code == codes::INVALID));

    assert!(
        core.fleet_confirms().iter().any(|c| c.id == id),
        "still waiting"
    );
    assert_eq!(reply_of(&f, &id), None);
}

#[tokio::test]
async fn a_trusted_device_that_isnt_claude_sets_auto_from_afar() {
    let f = fixtures();
    let (core, _recv, project, mcp, phone, _) = host(&f, false, SpaceMode::Edit).await;
    trust(&core, PHONE).await;
    let set = |auto| RemoteOp::SetMcpAuto {
        mcp_device: ORIGIN.into(),
        auto,
        until_ms: None,
    };
    // Claude can't turn on its own auto mode.
    let out = run(&f, &mcp, set(McpAuto::Full)).await;
    assert!(matches!(out, ReplyOutcome::Err { ref code, .. } if code == codes::INVALID));
    // Nor can a device not trusted here.
    let stranger = DeviceKey::generate().unwrap();
    let (rid, env) = sealed_from(&f, STRANGER, &stranger, set(McpAuto::Full));
    deliver(&f, env);
    assert_eq!(refusal(&f, &rid).await, codes::UNTRUSTED_DEVICE);
    // Only for an mcp device.
    let out = run_from(
        &f,
        PHONE,
        &phone,
        RemoteOp::SetMcpAuto {
            mcp_device: PHONE.into(),
            auto: McpAuto::Edit,
            until_ms: None,
        },
    )
    .await;
    assert!(matches!(out, ReplyOutcome::Err { ref code, .. } if code == codes::INVALID));
    assert!(core.fleet_status().await.unwrap().autos.is_empty());

    let out = run_from(&f, PHONE, &phone, set(McpAuto::Edit)).await;
    assert!(ok(&out), "{out:?}");
    let autos = core.fleet_status().await.unwrap().autos;
    assert_eq!((autos.len(), autos[0].auto), (1, FleetAuto::Edit));
    f.agents.push_script(super::done("edited"));
    let out = run(
        &f,
        &mcp,
        start_with(&project.id, "rs_e", FleetMode::Edit, None, 0),
    )
    .await;
    assert!(ok(&out), "{out:?}");
}

fn remote_confirm(f: &Fixtures, key: &DeviceKey, id: &str) -> FleetInbound {
    remote_confirm_from(f, TARGET, key, id)
}

/// `host`'s prompt, signed with `key`.
fn remote_confirm_from(f: &Fixtures, host: &str, key: &DeviceKey, id: &str) -> FleetInbound {
    FleetInbound::Message(ServerMessage::Confirm {
        envelope: SignedEnvelope::seal_as(
            &RemoteConfirm {
                confirm_id: id.into(),
                host_device: host.into(),
                mcp_device: ORIGIN.into(),
                action: ConfirmAction::Send,
                mode: FleetMode::Run,
                project_name: None,
                space_name: Some("Fix login".into()),
                text: "go".into(),
                expires_at_ms: now(f) + 60_000,
            },
            key,
            Domain::Confirm,
        ),
    })
}

#[tokio::test]
async fn another_computers_prompt_shows_here_and_is_answered_there() {
    let f = fixtures();
    let (core, mut recv, _project, _mcp, _, mac) = host(&f, false, SpaceMode::Edit).await;
    trust(&core, TARGET).await;
    // From a computer not trusted here: dropped.
    let stranger = DeviceKey::generate().unwrap();
    f.fleet
        .push(remote_confirm_from(&f, STRANGER, &stranger, "c0"));
    // Signed by another key: dropped.
    f.fleet
        .push(remote_confirm(&f, &DeviceKey::generate().unwrap(), "c1"));
    f.fleet.push(remote_confirm(&f, &mac, "c2"));
    wait_until("the prompt", || !core.fleet_confirms().is_empty()).await;
    let shown = core.fleet_confirms();
    assert_eq!(shown.len(), 1);
    let c = &shown[0];
    assert_eq!(c.id, "c2");
    assert_eq!(c.host_device.as_deref(), Some(TARGET));
    assert_eq!(c.host_name.as_deref(), Some("mac1"));
    assert_eq!(c.device_name, "Claude (MCP)");
    assert_eq!(
        (c.action, c.mode),
        (FleetConfirmAction::Send, SpaceMode::Run)
    );
    assert!(
        ephemerals(&mut recv)
            .iter()
            .any(|e| matches!(e, Ephemeral::FleetConfirm { request } if request.id == "c2"))
    );

    let answering = tokio::spawn({
        let core = core.clone();
        async move {
            core.fleet_confirm(FleetConfirmAnswer {
                id: "c2".into(),
                allow: true,
            })
            .await
        }
    });
    wait_until("the signed answer", || !requests(&f).is_empty()).await;
    let req: RemoteRequest = requests(&f)[0].open(&my_key(&f)).unwrap();
    assert_eq!(
        (req.origin_device.as_str(), req.target_device.as_str()),
        (ME, TARGET)
    );
    assert_eq!(req.target_key, mac.public_key());
    assert_eq!(req.op, confirm_op("c2", true));
    f.fleet.push(signed_reply(
        &mac,
        TARGET,
        &req.req_id,
        ReplyOutcome::Ok {
            value: serde_json::json!({}),
        },
    ));
    answering.await.unwrap().unwrap();
    assert!(core.fleet_confirms().is_empty());

    // Answered elsewhere: the cloud dismisses it.
    f.fleet.push(remote_confirm(&f, &mac, "c3"));
    wait_until("the prompt", || !core.fleet_confirms().is_empty()).await;
    f.fleet
        .push(FleetInbound::Message(ServerMessage::ConfirmDismissed {
            confirm_id: "c3".into(),
        }));
    wait_until("dismissed", || core.fleet_confirms().is_empty()).await;
}

#[tokio::test]
async fn auto_on_another_computer_goes_there_as_a_signed_request() {
    let f = fixtures();
    let (core, _recv, _project, _mcp, _, mac) = host(&f, false, SpaceMode::Edit).await;
    trust(&core, TARGET).await;
    let until = now(&f) + HOUR;
    let setting = tokio::spawn({
        let core = core.clone();
        async move {
            core.fleet_set_auto(FleetAutoRequest {
                device_id: ORIGIN.into(),
                auto: FleetAuto::Full,
                until_ms: Some(until),
                host_device: Some(TARGET.into()),
            })
            .await
        }
    });
    wait_until("the request", || !requests(&f).is_empty()).await;
    let req: RemoteRequest = requests(&f)[0].open(&my_key(&f)).unwrap();
    assert_eq!(req.target_device, TARGET);
    assert_eq!(
        req.op,
        RemoteOp::SetMcpAuto {
            mcp_device: ORIGIN.into(),
            auto: McpAuto::Full,
            until_ms: Some(until),
        }
    );
    f.fleet.push(signed_reply(
        &mac,
        TARGET,
        &req.req_id,
        ReplyOutcome::Ok {
            value: serde_json::json!({}),
        },
    ));
    setting.await.unwrap().unwrap();
    // Nothing changed here.
    assert!(core.fleet_status().await.unwrap().autos.is_empty());
}
