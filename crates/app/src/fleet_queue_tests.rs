//! A send from another device while the space works (docs/fleet.md
//! "Sends queue"): queued like a local message, run after the turn in
//! order, capped per space, and checked again right before it runs. A
//! child of `fleet_spaces_tests`, for its harness.

use serde_json::json;
use theodore_contract::{
    ChatMessage, ChatNotice, FleetAuto, FleetAutoRequest, FleetSettingsRequest, FleetTrustRequest,
    SpaceMode, SpaceSendRequest, SpaceStatus, models,
};
use theodore_fleet_protocol::{DeviceKind, RemoteOp, codes};
use tokio::sync::oneshot;

use super::super::{
    ORIGIN, claim_result, claimed, deliver, done, local_of, now, refusal, reply_of, run, sealed,
    space, start_op, target, wait_until,
};
use super::{answer, claimed_request, host, ok_value, own_space, send_to, the_prompt};
use crate::Core;
use crate::testkit::{Fixtures, fixtures};
use crate::usecases::fleet_queue::REMOTE_QUEUE_MAX;
use crate::usecases::spaces::space_chat_key;
use theodore_ports::Store;

fn send(space: &str, text: &str) -> RemoteOp {
    RemoteOp::Send {
        space: space.into(),
        text: text.into(),
        mode: None,
        agent: None,
        model: None,
        effort: None,
        attachments: vec![],
    }
}

fn local_send(space: &str, text: &str) -> SpaceSendRequest {
    SpaceSendRequest {
        space: space.into(),
        text: text.into(),
        agent: None,
        model: None,
        mode: None,
        attachments: None,
        effort: None,
        mentions: None,
    }
}

/// A turn of this computer's own running in `id` until the sender fires.
async fn busy(f: &Fixtures, core: &Core, id: &str) -> oneshot::Sender<()> {
    let go = f.agents.pause_next_run();
    core.space_send(local_send(id, "mine")).await.unwrap();
    wait_until("running", || space(f, id).status == SpaceStatus::Running).await;
    go
}

fn chat(f: &Fixtures, id: &str) -> Vec<ChatMessage> {
    f.store
        .query(models::CHAT_MESSAGE, "pr", &space_chat_key(id).0)
        .unwrap()
        .into_iter()
        .map(|r| serde_json::from_value(r.data).unwrap())
        .collect()
}

fn dropped(f: &Fixtures, id: &str) -> Vec<(String, String)> {
    chat(f, id)
        .into_iter()
        .filter_map(|m| match m.notice {
            Some(ChatNotice::RemoteDropped { from, reason }) => Some((from, reason)),
            _ => None,
        })
        .collect()
}

/// Whether a turn's prompt ended with `text`; where among the turns.
fn turn_of(f: &Fixtures, text: &str) -> Option<usize> {
    f.agents
        .requests()
        .iter()
        .position(|r| r.prompt.ends_with(text))
}

async fn settled_after(f: &Fixtures, id: &str, turns: u32) {
    wait_until("the queue ran", || {
        let s = space(f, id);
        s.turns >= turns && s.status != SpaceStatus::Running
    })
    .await;
}

/// A space hosted here as `rs_1`, its first turn over.
async fn hosted(
    f: &Fixtures,
) -> (
    Core,
    crate::Receivers,
    String,
    theodore_fleet_protocol::DeviceKey,
) {
    let (core, recv, project, origin) = target(f).await;
    f.agents.push_script(done("one"));
    run(f, &origin, start_op(&project.id, "rs_1")).await;
    let local = local_of(f, "rs_1");
    wait_until("idle", || space(f, &local).status == SpaceStatus::Idle).await;
    (core, recv, local, origin)
}

#[tokio::test]
async fn a_send_while_the_space_runs_is_queued_then_runs_after_the_turn_in_order() {
    let f = fixtures();
    let (core, _recv, local, origin) = hosted(&f).await;

    // Idle at the gate, running by the time it's claimed: queued.
    let (first, env) = sealed(&f, &origin, send("rs_1", "first"), now(&f));
    deliver(&f, env);
    wait_until("the claim", || claimed(&f, &first)).await;
    let go = busy(&f, &core, &local).await;
    claim_result(&f, &first, true);
    wait_until("the reply", || reply_of(&f, &first).is_some()).await;
    let v = ok_value(reply_of(&f, &first).unwrap());
    assert_eq!((&v["queued"], &v["position"]), (&json!(true), &json!(1)));
    assert!(v["message"].is_string());

    // Running at the gate: claimed all the same, and behind it.
    let v = ok_value(run(&f, &origin, send("rs_1", "second")).await);
    assert_eq!((&v["queued"], &v["position"]), (&json!(true), &json!(2)));
    let queue = core.queued_messages(&local).await.unwrap();
    let texts: Vec<&str> = queue.iter().map(|m| m.text.as_str()).collect();
    assert_eq!(
        texts,
        ["first", "second"],
        "the queue a local message waits in"
    );
    assert_eq!(turn_of(&f, "first"), None, "nothing ran yet");

    go.send(()).unwrap();
    settled_after(&f, &local, 4).await;
    let (mine, first, second) = (
        turn_of(&f, "mine").unwrap(),
        turn_of(&f, "first").unwrap(),
        turn_of(&f, "second").unwrap(),
    );
    assert!(mine < first && first < second, "{mine} {first} {second}");
    assert!(core.queued_messages(&local).await.unwrap().is_empty());
    assert!(dropped(&f, &local).is_empty());
}

#[tokio::test]
async fn past_the_cap_of_queued_remote_sends_it_is_busy() {
    let f = fixtures();
    let (core, _recv, local, origin) = hosted(&f).await;
    let _go = busy(&f, &core, &local).await;
    for i in 1..=REMOTE_QUEUE_MAX {
        let v = ok_value(run(&f, &origin, send("rs_1", &format!("m{i}"))).await);
        assert_eq!(v["position"], json!(i));
    }
    // One more: refused before any claim.
    let (id, env) = sealed(&f, &origin, send("rs_1", "one too many"), now(&f));
    deliver(&f, env);
    assert_eq!(refusal(&f, &id).await, codes::BUSY);
    assert!(!claimed(&f, &id));
    // The cap is other devices': this computer's own still queue.
    core.space_send(local_send(&local, "mine too"))
        .await
        .unwrap();
    assert_eq!(
        core.queued_messages(&local).await.unwrap().len(),
        REMOTE_QUEUE_MAX + 1
    );
    core.space_stop(&local).await.unwrap();
}

#[tokio::test]
async fn a_queued_send_is_dropped_when_trust_goes_before_it_runs() {
    let f = fixtures();
    let (core, _recv, local, origin) = hosted(&f).await;
    let go = busy(&f, &core, &local).await;
    let v = ok_value(run(&f, &origin, send("rs_1", "after trust")).await);
    assert_eq!(v["queued"], json!(true));
    core.space_send(local_send(&local, "my next"))
        .await
        .unwrap();

    core.fleet_trust_device(FleetTrustRequest {
        device_id: ORIGIN.into(),
        trusted: false,
        public_key: None,
    })
    .await
    .unwrap();
    go.send(()).unwrap();
    settled_after(&f, &local, 3).await;

    let notes = dropped(&f, &local);
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert_eq!(notes[0].0, "mac1");
    assert!(notes[0].1.contains("isn't trusted"), "{}", notes[0].1);
    assert_eq!(turn_of(&f, "after trust"), None, "it never ran");
    assert!(turn_of(&f, "my next").is_some(), "the queue went on");
    assert!(!chat(&f, &local).iter().any(|m| m.text == "after trust"));
    assert!(core.queued_messages(&local).await.unwrap().is_empty());
}

#[tokio::test]
async fn a_queued_send_is_dropped_when_the_mode_cap_goes_down() {
    let f = fixtures();
    let (core, _recv, local, origin) = hosted(&f).await;
    let go = busy(&f, &core, &local).await;
    ok_value(run(&f, &origin, send("rs_1", "edit more")).await);
    core.fleet_set_settings(FleetSettingsRequest {
        enabled: None,
        accept_remote: None,
        max_mode: Some(SpaceMode::Plan),
        name: None,
    })
    .await
    .unwrap();
    go.send(()).unwrap();
    wait_until("dropped", || !dropped(&f, &local).is_empty()).await;
    settled_after(&f, &local, 2).await;
    let reason = dropped(&f, &local).remove(0).1;
    assert!(
        reason.contains("above what this computer allows"),
        "{reason}"
    );
    assert_eq!(turn_of(&f, "edit more"), None);
}

#[tokio::test]
async fn an_mcp_edit_send_still_needs_a_yes_then_queues_and_auto_is_checked_again() {
    let f = fixtures();
    let h = host(&f, DeviceKind::Mcp, SpaceMode::Edit).await;
    let a = own_space(&f, &h, "Fix login", SpaceMode::Edit).await;
    let go = busy(&f, &h.core, &a.id).await;

    // An Edit space's message waits for a person before it's queued.
    let id = claimed_request(&f, &h.key, send_to(&a.id, "go on")).await;
    let p = the_prompt(&h.core).await;
    assert_eq!(p.id, id);
    assert_eq!(reply_of(&f, &id), None);
    assert!(h.core.queued_messages(&a.id).await.unwrap().is_empty());
    answer(&h.core, &id, true).await;
    wait_until("the reply", || reply_of(&f, &id).is_some()).await;
    let v = ok_value(reply_of(&f, &id).unwrap());
    assert_eq!((&v["queued"], &v["position"]), (&json!(true), &json!(1)));

    // Auto Edit lets the next one through, queued behind it…
    let auto = |auto| FleetAutoRequest {
        device_id: ORIGIN.into(),
        auto,
        until_ms: None,
        host_device: None,
    };
    h.core.fleet_set_auto(auto(FleetAuto::Edit)).await.unwrap();
    let v = ok_value(run(&f, &h.key, send_to(&a.id, "on auto")).await);
    assert_eq!(v["position"], json!(2));
    // …until auto goes off before its turn: the person's yes stands,
    // auto's doesn't.
    h.core.fleet_set_auto(auto(FleetAuto::Off)).await.unwrap();
    go.send(()).unwrap();
    wait_until("dropped", || !dropped(&f, &a.id).is_empty()).await;
    settled_after(&f, &a.id, a.turns + 2).await;
    assert!(turn_of(&f, "go on").is_some());
    assert_eq!(turn_of(&f, "on auto"), None);
    let reason = dropped(&f, &a.id).remove(0).1;
    assert!(reason.contains("auto mode"), "{reason}");
}
