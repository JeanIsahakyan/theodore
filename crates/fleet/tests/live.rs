//! Live check against a deployed cloud (ignored by default): two real
//! adapters, as two devices of one user, through the real `OrgHub`.
//!
//! ```sh
//! FLEET_LIVE_CLOUD=https://… FLEET_LIVE_TOKEN_A=<access JWT with org_id> \
//! FLEET_LIVE_TOKEN_B=<another session's JWT, same user and org> \
//!   cargo test -p theodore-fleet --test live -- --ignored --nocapture
//! ```

use std::sync::Arc;
use std::time::Duration;

use theodore_fleet::WsFleet;
use theodore_fleet_protocol::{
    AskVia, ClientMessage, DeviceInfo, DeviceKey, DeviceKind, DeviceOs, DismissReason, Domain,
    FleetMode, ProjectRef, RemoteAsk, RemoteOp, RemoteQuestion, RemoteRequest, RemoteSpaceEvent,
    RemoteSpaceStatus, ReplyBody, ReplyOutcome, ServerMessage, SignedEnvelope, SpaceEventBody,
};
use theodore_ports::fleet::{FleetCommand, FleetConnect, FleetInbound, FleetLink, FleetPort};

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}

fn info(name: &str) -> DeviceInfo {
    DeviceInfo {
        name: name.into(),
        os: DeviceOs::Macos,
        kind: DeviceKind::Desktop,
        app_version: "live-test".into(),
        projects: vec![ProjectRef {
            id: "p1".into(),
            name: "demo".into(),
        }],
        accepts_remote: true,
        max_mode: FleetMode::Edit,
    }
}

fn connect(cloud: &str, token: &str, key: Arc<DeviceKey>, name: &str) -> FleetLink {
    WsFleet::new().start(FleetConnect {
        cloud_url: cloud.into(),
        access_token: token.into(),
        device_id: None,
        key,
        info: info(name),
        spaces: vec![],
    })
}

async fn next(link: &mut FleetLink, what: &str) -> FleetInbound {
    tokio::time::timeout(Duration::from_secs(20), link.inbound.recv())
        .await
        .unwrap_or_else(|_| panic!("timed out waiting for {what}"))
        .unwrap_or_else(|| panic!("link ended waiting for {what}"))
}

/// The next server message matching `pick`, skipping others (devices pushes…).
async fn wait_for<T>(
    link: &mut FleetLink,
    what: &str,
    mut pick: impl FnMut(&ServerMessage) -> Option<T>,
) -> T {
    loop {
        match next(link, what).await {
            FleetInbound::Message(m) => {
                if let Some(t) = pick(&m) {
                    return t;
                }
            }
            FleetInbound::Fatal { code, message } => panic!("fatal {code}: {message}"),
            other => println!("  (while waiting for {what}: {other:?})"),
        }
    }
}

async fn connected(link: &mut FleetLink) -> (String, u64) {
    loop {
        match next(link, "connected").await {
            FleetInbound::Connected {
                device_id,
                generation,
                ..
            } => return (device_id, generation),
            FleetInbound::Fatal { code, message } => panic!("fatal {code}: {message}"),
            other => println!("  ({other:?})"),
        }
    }
}

fn send(link: &FleetLink, m: ClientMessage) {
    link.commands.send(FleetCommand::Send(m)).unwrap();
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

#[tokio::test]
#[ignore = "needs a deployed cloud and two live sessions"]
async fn two_devices_through_the_real_hub() {
    let cloud = env("FLEET_LIVE_CLOUD");
    let key_a = Arc::new(DeviceKey::generate().unwrap());
    let key_b = Arc::new(DeviceKey::generate().unwrap());
    let mut a = connect(&cloud, &env("FLEET_LIVE_TOKEN_A"), key_a.clone(), "live-a");
    let mut b = connect(&cloud, &env("FLEET_LIVE_TOKEN_B"), key_b.clone(), "live-b");
    let (dev_a, _) = connected(&mut a).await;
    let (dev_b, gen_b) = connected(&mut b).await;
    println!("PASS connect: a={dev_a} b={dev_b} gen_b={gen_b}");
    assert_ne!(dev_a, dev_b);

    // Both see both.
    let listed = wait_for(&mut a, "devices with b", |m| match m {
        ServerMessage::Devices { devices } if devices.iter().any(|d| d.device_id == dev_b) => {
            Some(devices.clone())
        }
        _ => None,
    })
    .await;
    let b_listed = listed.iter().find(|d| d.device_id == dev_b).unwrap();
    assert_eq!(b_listed.public_key, key_b.public_key());
    assert!(b_listed.online);
    println!("PASS devices: a sees b online with b's real public key");

    // A asks B to start a space: forwarded unchanged, claimed, replied.
    // Bound to b's key as a pins it (here: as the cloud listed it).
    let req = RemoteRequest {
        req_id: format!("live-{}", now_ms()),
        origin_device: dev_a.clone(),
        target_device: dev_b.clone(),
        target_key: b_listed.public_key.clone(),
        issued_at_ms: now_ms(),
        op: RemoteOp::StartSpace {
            space: format!("rs_live_{}", now_ms()),
            project_id: "p1".into(),
            goal: "live check".into(),
            mode: FleetMode::Edit,
            agent: None,
            model: None,
            parent: None,
            depth: 0,
        },
    };
    let space = req.op.space().to_string();
    let sealed = SignedEnvelope::seal(&req, &key_a);
    send(
        &a,
        ClientMessage::Request {
            envelope: sealed.clone(),
        },
    );
    let (got, generation) = wait_for(&mut b, "request at b", |m| match m {
        ServerMessage::Request {
            envelope,
            generation,
        } => Some((envelope.clone(), *generation)),
        _ => None,
    })
    .await;
    assert_eq!(got, sealed, "the cloud must forward the envelope unchanged");
    let opened = got.open(&key_a.public_key()).unwrap();
    assert_eq!(opened, req);
    assert_eq!(
        opened.target_key,
        key_b.public_key(),
        "signed for b's own key"
    );
    println!("PASS route: envelope arrived byte-identical, verifies with a's key, bound to b's");

    send(
        &b,
        ClientMessage::Claim {
            req_id: req.req_id.clone(),
            generation: generation + 1,
        },
    );
    let stale = wait_for(&mut b, "stale claim result", |m| match m {
        ServerMessage::ClaimResult {
            claimed, rejection, ..
        } => Some((*claimed, rejection.clone())),
        _ => None,
    })
    .await;
    assert_eq!(stale, (false, Some("stale_generation".into())));
    println!("PASS fencing: a claim with the wrong generation is rejected");

    send(
        &b,
        ClientMessage::Claim {
            req_id: req.req_id.clone(),
            generation,
        },
    );
    let claimed = wait_for(&mut b, "claim result", |m| match m {
        ServerMessage::ClaimResult { claimed, .. } => Some(*claimed),
        _ => None,
    })
    .await;
    assert!(claimed);
    send(
        &b,
        ClientMessage::Claim {
            req_id: req.req_id.clone(),
            generation,
        },
    );
    let twice = wait_for(&mut b, "second claim", |m| match m {
        ServerMessage::ClaimResult { rejection, .. } => Some(rejection.clone()),
        _ => None,
    })
    .await;
    assert_eq!(twice.as_deref(), Some("already_claimed"));
    println!("PASS claim: claimed once, a second claim is already_claimed");

    // b signs its reply as the target; a opens it with b's key.
    let sealed_reply = SignedEnvelope::seal_as(
        &ReplyBody {
            req_id: req.req_id.clone(),
            origin_device: dev_a.clone(),
            target_device: dev_b.clone(),
            outcome: ReplyOutcome::Ok {
                value: serde_json::json!({"space": space, "name": "live", "branch": "live"}),
            },
        },
        &key_b,
        Domain::Reply,
    );
    send(
        &b,
        ClientMessage::Reply {
            envelope: sealed_reply.clone(),
        },
    );
    let (got_reply, body) = wait_for(&mut a, "reply at a", |m| match m {
        ServerMessage::Reply { envelope } => {
            let body: ReplyBody = envelope
                .open_as(&key_b.public_key(), Domain::Reply)
                .expect("the reply verifies with b's key");
            (body.req_id == req.req_id).then(|| (envelope.clone(), body))
        }
        _ => None,
    })
    .await;
    assert_eq!(
        got_reply, sealed_reply,
        "the cloud must forward the reply unchanged"
    );
    assert!(
        got_reply
            .open_as::<ReplyBody>(&key_a.public_key(), Domain::Reply)
            .is_err(),
        "only b's key opens it"
    );
    assert_eq!(body.origin_device, dev_a);
    assert!(matches!(body.outcome, ReplyOutcome::Ok { .. }));
    println!("PASS reply: b's signed reply reached a unchanged and verifies with b's key");

    // Events: b hosts, a subscribes and gets history then live.
    let started = RemoteSpaceEvent::Started {
        host_device: dev_b.clone(),
        origin_device: dev_a.clone(),
        project_id: "p1".into(),
        project_name: "demo".into(),
        name: "live".into(),
        branch: "live".into(),
        mode: FleetMode::Edit,
        parent: None,
        depth: 0,
    };
    // Signed by b as the host; the cloud forwards the envelope unchanged.
    let event = |seq: u64, event: RemoteSpaceEvent| ClientMessage::SpaceEvent {
        envelope: SignedEnvelope::seal_as(
            &SpaceEventBody {
                space: space.clone(),
                seq,
                host_device: dev_b.clone(),
                event,
            },
            &key_b,
            Domain::Event,
        ),
    };
    let event_seq = |m: &ServerMessage| match m {
        ServerMessage::SpaceEvent { envelope } => {
            let body: SpaceEventBody = envelope
                .open_as(&key_b.public_key(), Domain::Event)
                .expect("the event verifies with b's key");
            (body.space == space).then_some(body.seq)
        }
        _ => None,
    };
    for (seq, ev) in [
        (1, started),
        (
            2,
            RemoteSpaceEvent::Status {
                status: RemoteSpaceStatus::Running,
            },
        ),
    ] {
        send(&b, event(seq, ev));
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    send(
        &a,
        ClientMessage::Subscribe {
            space: space.clone(),
            since: 0,
        },
    );
    let mut seqs = vec![];
    while seqs.len() < 2 {
        let s = wait_for(&mut a, "history", event_seq).await;
        seqs.push(s);
    }
    send(
        &b,
        event(
            3,
            RemoteSpaceEvent::Status {
                status: RemoteSpaceStatus::Idle,
            },
        ),
    );
    let live = wait_for(&mut a, "live event", event_seq).await;
    seqs.push(live);
    assert_eq!(seqs, vec![1, 2, 3]);
    println!("PASS events: history 1,2 then live 3, in order, signed by b");

    // A hole in b's seqs: the cloud says so, unsigned, then the event.
    send(
        &b,
        event(
            5,
            RemoteSpaceEvent::Status {
                status: RemoteSpaceStatus::Running,
            },
        ),
    );
    let gap = wait_for(&mut a, "gap", |m| match m {
        ServerMessage::SpaceGap { space: s, from, to } if *s == space => Some((*from, *to)),
        _ => None,
    })
    .await;
    assert_eq!(gap, (4, 4));
    assert_eq!(wait_for(&mut a, "event after the gap", event_seq).await, 5);
    println!("PASS gap: space_gap 4..4, then 5");

    // Question from b's space goes to a (focused, active).
    send(
        &a,
        ClientMessage::Presence {
            focused: true,
            locked: false,
            idle_ms: 0,
        },
    );
    send(
        &b,
        ClientMessage::Presence {
            focused: false,
            locked: false,
            idle_ms: 600_000,
        },
    );
    tokio::time::sleep(Duration::from_millis(300)).await;
    let ask_id = format!("ask_{}", now_ms());
    send(
        &b,
        ClientMessage::Ask {
            envelope: SignedEnvelope::seal_as(
                &RemoteAsk {
                    ask_id: ask_id.clone(),
                    space: space.clone(),
                    host_device: dev_b.clone(),
                    from: "live-b · live".into(),
                    questions: vec![RemoteQuestion {
                        question: "Which one?".into(),
                        options: vec!["one".into(), "two".into()],
                        multi: false,
                    }],
                },
                &key_b,
                Domain::Ask,
            ),
        },
    );
    let via = wait_for(&mut a, "ask at a", |m| match m {
        ServerMessage::Ask { envelope, via } => {
            let ask: RemoteAsk = envelope
                .open_as(&key_b.public_key(), Domain::Ask)
                .expect("the ask verifies with b's key");
            (ask.ask_id == ask_id).then_some(*via)
        }
        _ => None,
    })
    .await;
    assert_eq!(via, AskVia::Active);
    send(
        &b,
        ClientMessage::AskResolved {
            ask_id: ask_id.clone(),
        },
    );
    let reason = wait_for(&mut a, "dismiss at a", |m| match m {
        ServerMessage::Dismiss { ask_id: id, reason } if *id == ask_id => Some(*reason),
        _ => None,
    })
    .await;
    assert_eq!(reason, DismissReason::Resolved);
    println!("PASS asks: routed to the active device, dismissed when resolved");

    // The cloud refuses a request that claims another origin.
    let forged = RemoteRequest {
        req_id: format!("forged-{}", now_ms()),
        origin_device: dev_b.clone(),
        target_device: dev_b.clone(),
        target_key: key_b.public_key(),
        issued_at_ms: now_ms(),
        op: RemoteOp::Stop {
            space: space.clone(),
        },
    };
    send(
        &a,
        ClientMessage::Request {
            envelope: SignedEnvelope::seal(&forged, &key_a),
        },
    );
    let code = wait_for(&mut a, "not_yours", |m| match m {
        ServerMessage::Error { code, .. } => Some(code.clone()),
        ServerMessage::Refused { req_id, code, .. } if *req_id == forged.req_id => {
            Some(code.clone())
        }
        _ => None,
    })
    .await;
    assert_eq!(code, "fleet.not_yours");
    println!("PASS spoof: a request posing as another origin is refused (fleet.not_yours)");

    // A request bound to a key that isn't b's: the cloud's own refusal,
    // unsigned, as `refused`.
    let wrong_key = RemoteRequest {
        req_id: format!("wrong-key-{}", now_ms()),
        origin_device: dev_a.clone(),
        target_device: dev_b.clone(),
        target_key: key_a.public_key(),
        issued_at_ms: now_ms(),
        op: RemoteOp::Stop {
            space: space.clone(),
        },
    };
    send(
        &a,
        ClientMessage::Request {
            envelope: SignedEnvelope::seal(&wrong_key, &key_a),
        },
    );
    let code = wait_for(&mut a, "refused", |m| match m {
        ServerMessage::Refused { req_id, code, .. } if *req_id == wrong_key.req_id => {
            Some(code.clone())
        }
        _ => None,
    })
    .await;
    assert_eq!(code, "fleet.not_yours");
    println!("PASS target key: a request bound to another key is refused (refused, not_yours)");

    a.commands.send(FleetCommand::Close).unwrap();
    b.commands.send(FleetCommand::Close).unwrap();
}
