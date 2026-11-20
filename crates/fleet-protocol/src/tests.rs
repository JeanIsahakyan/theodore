use super::*;

#[test]
fn every_code_is_listed_once_and_looks_like_one() {
    let mut seen = std::collections::HashSet::new();
    for (name, code) in codes::ALL {
        assert!(seen.insert(*code), "{code} listed twice");
        assert!(code.starts_with("fleet."), "{name}: {code}");
    }
    assert!(seen.contains(codes::DENIED));
}

fn req(origin: &str) -> RemoteRequest {
    RemoteRequest {
        req_id: "r1".into(),
        origin_device: origin.into(),
        target_device: "dev_b".into(),
        target_key: "key_b".into(),
        issued_at_ms: 1_000,
        op: RemoteOp::StartSpace {
            space: "rs_1".into(),
            project_id: "p1".into(),
            goal: "fix the tests".into(),
            mode: FleetMode::Edit,
            agent: None,
            model: None,
            effort: None,
            parent: None,
            depth: 0,
        },
    }
}

#[test]
fn a_sealed_request_opens_with_the_origin_key() {
    let key = DeviceKey::generate().unwrap();
    let env = SignedEnvelope::seal(&req("dev_a"), &key);
    assert_eq!(env.open(&key.public_key()).unwrap(), req("dev_a"));
}

#[test]
fn another_key_or_a_changed_body_fails() {
    let key = DeviceKey::generate().unwrap();
    let other = DeviceKey::generate().unwrap();
    let env = SignedEnvelope::seal(&req("dev_a"), &key);
    assert_eq!(
        env.open(&other.public_key()),
        Err(EnvelopeError::BadSignature)
    );
    let mut tampered = env.clone();
    tampered.body = tampered.body.replace("fix the tests", "rm -rf ~");
    assert_eq!(
        tampered.open(&key.public_key()),
        Err(EnvelopeError::BadSignature)
    );
}

#[test]
fn the_envelope_device_must_be_the_body_origin() {
    let key = DeviceKey::generate().unwrap();
    let mut env = SignedEnvelope::seal(&req("dev_a"), &key);
    env.device_id = "dev_x".into();
    assert!(matches!(
        env.open(&key.public_key()),
        Err(EnvelopeError::OriginMismatch { .. })
    ));
}

#[test]
fn keys_round_trip_through_the_keychain_form() {
    let key = DeviceKey::generate().unwrap();
    let back = DeviceKey::from_secret(key.to_secret()).unwrap();
    assert_eq!(back.public_key(), key.public_key());
    assert!(verify(&key.public_key(), b"x", &back.sign(b"x")));
    assert_eq!(
        DeviceKey::from_secret("not base64!").unwrap_err(),
        KeyError::Unreadable
    );
    assert!(!format!("{key:?}").contains(key.to_secret()));
}

#[test]
fn verify_rejects_garbage() {
    let key = DeviceKey::generate().unwrap();
    assert!(!verify("nope", b"x", &key.sign(b"x")));
    assert!(!verify(&key.public_key(), b"x", "nope"));
    assert!(!verify(&b64(&[0u8; 31]), b"x", &key.sign(b"x")));
}

#[test]
fn fingerprints_are_short_and_stable() {
    let key = DeviceKey::generate().unwrap();
    let f = fingerprint(&key.public_key());
    assert_eq!(f.len(), 39);
    assert_eq!(f, fingerprint(&key.public_key()));
}

#[test]
fn freshness_window() {
    assert!(fresh(1_000, 1_000 + REQUEST_WINDOW_MS));
    assert!(!fresh(1_000, 1_001 + REQUEST_WINDOW_MS));
    assert!(fresh(1_000 + REQUEST_WINDOW_MS, 1_000));
}

#[test]
fn modes_are_ordered_by_power() {
    assert!(FleetMode::Ask < FleetMode::Plan);
    assert!(FleetMode::Plan < FleetMode::Edit);
    assert!(FleetMode::Edit < FleetMode::Run);
}

#[test]
fn messages_are_tagged_json() {
    let m = ClientMessage::Claim {
        req_id: "r1".into(),
        generation: 3,
    };
    assert_eq!(
        serde_json::to_value(&m).unwrap(),
        serde_json::json!({"type": "claim", "req_id": "r1", "generation": 3})
    );
    let s: ServerMessage = serde_json::from_str(r#"{"type":"challenge","nonce":"AAAA"}"#).unwrap();
    assert_eq!(
        s,
        ServerMessage::Challenge {
            nonce: "AAAA".into()
        }
    );
    let e = RemoteSpaceEvent::Status {
        status: RemoteSpaceStatus::Idle,
    };
    assert_eq!(
        serde_json::to_value(&e).unwrap(),
        serde_json::json!({"kind": "status", "status": "idle"})
    );
    let op = serde_json::to_value(RemoteOp::Stop {
        space: "rs_1".into(),
    })
    .unwrap();
    assert_eq!(op, serde_json::json!({"op": "stop", "space": "rs_1"}));
}

#[test]
fn a_hello_signature_never_verifies_as_a_request() {
    // The attack: a cloud passes a request body off as a challenge nonce.
    let key = DeviceKey::generate().unwrap();
    let r = req("dev_a");
    let body = serde_json::to_string(&r).unwrap();
    // Not 32 bytes: refused outright.
    assert_eq!(sign_hello(&key, &b64(body.as_bytes())), None);
    // Even a 32-byte "nonce" is signed under the hello tag only.
    let nonce = [7u8; NONCE_BYTES];
    let sig = sign_hello(&key, &b64(&nonce)).unwrap();
    assert!(verify_hello(&key.public_key(), &nonce, &sig));
    let forged = SignedEnvelope {
        device_id: "dev_a".into(),
        body: String::from_utf8_lossy(&nonce).into_owned(),
        signature: sig,
    };
    assert_eq!(
        forged.open(&key.public_key()),
        Err(EnvelopeError::BadSignature)
    );
    assert!(!verify_hello(
        &key.public_key(),
        &nonce[..31],
        &sign_hello(&key, &b64(&nonce)).unwrap()
    ));
}

#[test]
fn a_signature_is_bound_to_its_domain() {
    let key = DeviceKey::generate().unwrap();
    let ask = RemoteAsk {
        ask_id: "q1".into(),
        space: "rs_1".into(),
        host_device: "dev_b".into(),
        from: "mac-B · fix".into(),
        questions: vec![],
    };
    let env = SignedEnvelope::seal_as(&ask, &key, Domain::Ask);
    assert_eq!(env.device_id, "dev_b");
    assert_eq!(
        env.open_as::<RemoteAsk>(&key.public_key(), Domain::Ask)
            .unwrap(),
        ask
    );
    assert_eq!(
        env.open_as::<RemoteAsk>(&key.public_key(), Domain::Event),
        Err(EnvelopeError::BadSignature)
    );
    let ev = SpaceEventBody {
        space: "rs_1".into(),
        seq: 4,
        host_device: "dev_b".into(),
        event: RemoteSpaceEvent::Status {
            status: RemoteSpaceStatus::Idle,
        },
    };
    let env = SignedEnvelope::seal_as(&ev, &key, Domain::Event);
    assert_eq!(
        env.open_as::<SpaceEventBody>(&key.public_key(), Domain::Event)
            .unwrap(),
        ev
    );
    let mut lying = env.clone();
    lying.device_id = "dev_x".into();
    assert!(matches!(
        lying.open_as::<SpaceEventBody>(&key.public_key(), Domain::Event),
        Err(EnvelopeError::OriginMismatch { .. })
    ));
}

#[test]
fn a_reply_is_signed_by_its_target() {
    let key = DeviceKey::generate().unwrap();
    let body = ReplyBody {
        req_id: "r1".into(),
        origin_device: "dev_a".into(),
        target_device: "dev_b".into(),
        outcome: ReplyOutcome::Err {
            code: "fleet.remote_off".into(),
            message: "no".into(),
        },
    };
    let env = SignedEnvelope::seal_as(&body, &key, Domain::Reply);
    assert_eq!(env.device_id, "dev_b");
    assert_eq!(
        env.open_as::<ReplyBody>(&key.public_key(), Domain::Reply)
            .unwrap(),
        body
    );
    assert_eq!(
        env.open_as::<ReplyBody>(&key.public_key(), Domain::Event),
        Err(EnvelopeError::BadSignature)
    );
}

#[test]
fn an_os_this_build_doesnt_know_reads_as_other() {
    let os: DeviceOs = serde_json::from_str("\"plan9\"").unwrap();
    assert_eq!(os, DeviceOs::Other);
    let os: DeviceOs = serde_json::from_str("\"ios\"").unwrap();
    assert_eq!(os, DeviceOs::Ios);
    assert_eq!(
        serde_json::to_string(&DeviceOs::Android).unwrap(),
        "\"android\""
    );
}

fn info_with(agents: Vec<FleetAgentInfo>) -> DeviceInfo {
    DeviceInfo {
        name: "mac".into(),
        os: DeviceOs::Macos,
        kind: DeviceKind::Desktop,
        app_version: "0.1.19".into(),
        projects: vec![],
        accepts_remote: true,
        max_mode: FleetMode::Edit,
        agents,
        mcp_auto: vec![],
    }
}

fn model(id: &str) -> FleetModelInfo {
    FleetModelInfo {
        id: id.into(),
        label: id.to_uppercase(),
        efforts: vec!["low".into(), "medium".into(), "high".into()],
        default_effort: Some("medium".into()),
    }
}

#[test]
fn device_info_agents_round_trip_and_default_to_none() {
    let info = info_with(vec![FleetAgentInfo {
        id: "claude".into(),
        label: "Claude".into(),
        default_model: Some("opus".into()),
        default_effort: Some("high".into()),
        models: vec![model("opus"), model("sonnet")],
    }]);
    let text = serde_json::to_string(&info).unwrap();
    assert_eq!(serde_json::from_str::<DeviceInfo>(&text).unwrap(), info);
    // An older device's info has no `agents`.
    let mut old = serde_json::to_value(&info).unwrap();
    old.as_object_mut().unwrap().remove("agents");
    let back: DeviceInfo = serde_json::from_value(old).unwrap();
    assert!(back.agents.is_empty());
}

#[test]
fn ops_carry_agent_model_and_effort_and_older_bodies_still_read() {
    let send = RemoteOp::Send {
        space: "rs_1".into(),
        text: "go".into(),
        mode: None,
        agent: Some("codex".into()),
        model: Some("gpt-5.5".into()),
        effort: Some("high".into()),
    };
    let v = serde_json::to_value(&send).unwrap();
    assert_eq!(v["agent"], "codex");
    assert_eq!(v["effort"], "high");
    let old: RemoteOp =
        serde_json::from_str(r#"{"op":"send","space":"rs_1","text":"go","mode":null}"#).unwrap();
    assert!(matches!(
        old,
        RemoteOp::Send {
            agent: None,
            model: None,
            effort: None,
            ..
        }
    ));
    let old: RemoteOp = serde_json::from_str(
        r#"{"op":"start_space","space":"rs_1","project_id":"p","goal":"g","mode":"edit","depth":0}"#,
    )
    .unwrap();
    assert!(matches!(old, RemoteOp::StartSpace { effort: None, .. }));
    // Signed like any request: the effort is under the signature.
    let key = DeviceKey::generate().unwrap();
    let mut r = req("dev_a");
    r.op = send;
    let env = SignedEnvelope::seal(&r, &key);
    let mut tampered = env.clone();
    tampered.body = tampered.body.replace("\"high\"", "\"max\"");
    assert_eq!(
        tampered.open(&key.public_key()),
        Err(EnvelopeError::BadSignature)
    );
    assert_eq!(env.open(&key.public_key()).unwrap(), r);
}

#[test]
fn fit_agents_caps_counts_lengths_and_the_info_size() {
    let long = "x".repeat(MAX_MODEL_ID_CHARS + 1);
    let mut first = model("opus");
    first.label = "L".repeat(200);
    first.efforts.push("e".repeat(MAX_EFFORT_CHARS + 1));
    let mut models: Vec<FleetModelInfo> = (0..20).map(|i| model(&format!("m{i}"))).collect();
    models.insert(0, first);
    models.insert(1, model(&long));
    let agent = |id: &str| FleetAgentInfo {
        id: id.into(),
        label: id.into(),
        default_model: Some(long.clone()),
        default_effort: Some("medium".into()),
        models: models.clone(),
    };
    let mut info = info_with((0..6).map(|i| agent(&format!("a{i}"))).collect());
    info.fit_agents();
    assert_eq!(info.agents.len(), MAX_AGENTS);
    for a in &info.agents {
        assert!(a.models.len() <= MAX_AGENT_MODELS);
        assert_eq!(a.default_model, None, "an overlong id isn't cut");
        assert!(a.models.iter().all(|m| m.id != long));
        assert_eq!(a.models[0].label.chars().count(), MAX_AGENT_LABEL_CHARS);
        assert_eq!(a.models[0].efforts, ["low", "medium", "high"]);
    }
    assert!(serde_json::to_string(&info).unwrap().len() <= MAX_INFO_BYTES);

    // Over the size: the agent listing the most loses its last models
    // first; a short list is left as it was.
    let mut big = info_with(vec![
        FleetAgentInfo {
            models: (0..12)
                .map(|i| model(&format!("{}{i:02}", "m".repeat(60))))
                .collect(),
            ..agent("claude")
        },
        FleetAgentInfo {
            models: vec![model("gpt")],
            ..agent("codex")
        },
    ]);
    big.projects = (0..40)
        .map(|i| ProjectRef {
            id: format!("p{i}"),
            name: "n".repeat(150),
        })
        .collect();
    big.fit_agents();
    assert!(serde_json::to_string(&big).unwrap().len() <= MAX_INFO_BYTES);
    assert_eq!(big.agents.len(), 2);
    assert!(big.agents[0].models.len() < 12);
    assert!(big.agents[0].models[0].id.ends_with("00"), "the first stay");
    assert_eq!(big.agents[1].models.len(), 1);
}

#[test]
fn auto_covers_edit_or_everything() {
    assert!(!McpAuto::Off.covers(FleetMode::Edit));
    assert!(McpAuto::Edit.covers(FleetMode::Edit));
    assert!(!McpAuto::Edit.covers(FleetMode::Run));
    assert!(McpAuto::Full.covers(FleetMode::Run));
    assert_eq!(McpAuto::default(), McpAuto::Off);
}

#[test]
fn confirm_and_auto_ops_are_tagged_and_on_no_space() {
    let op = RemoteOp::Confirm {
        confirm_id: "r1".into(),
        allow: true,
    };
    assert_eq!(op.space(), "");
    assert_eq!(
        serde_json::to_value(&op).unwrap(),
        serde_json::json!({"op": "confirm", "confirm_id": "r1", "allow": true})
    );
    let op: RemoteOp = serde_json::from_value(serde_json::json!({
        "op": "set_mcp_auto", "mcp_device": "dev_m", "auto": "full"
    }))
    .unwrap();
    assert_eq!(
        op,
        RemoteOp::SetMcpAuto {
            mcp_device: "dev_m".into(),
            auto: McpAuto::Full,
            until_ms: None
        }
    );
    // An older host's info has no auto list.
    let info: DeviceInfo = serde_json::from_value(serde_json::json!({
        "name": "mac", "os": "macos", "kind": "desktop", "app_version": "1",
        "projects": [], "accepts_remote": false, "max_mode": "edit"
    }))
    .unwrap();
    assert!(info.mcp_auto.is_empty());
}

#[test]
fn ops_on_any_space_are_tagged_and_on_no_cloud_space() {
    let ops = [
        (
            RemoteOp::ListSpaces { project: None },
            serde_json::json!({"op": "list_spaces", "project": null}),
        ),
        (
            RemoteOp::ReadSpace {
                space: "a1".into(),
                messages: Some(5),
            },
            serde_json::json!({"op": "read_space", "space": "a1", "messages": 5}),
        ),
        (
            RemoteOp::AskSpace {
                space: "a1".into(),
                question: "why?".into(),
            },
            serde_json::json!({"op": "ask_space", "space": "a1", "question": "why?"}),
        ),
        (
            RemoteOp::SendTo {
                space: "a1".into(),
                message: "go".into(),
            },
            serde_json::json!({"op": "send_to", "space": "a1", "message": "go"}),
        ),
        (
            RemoteOp::AnswerSpace {
                space: "a1".into(),
                ask: "q1".into(),
                answers: vec![vec!["Yes".into()]],
            },
            serde_json::json!({"op": "answer_space", "space": "a1", "ask": "q1", "answers": [["Yes"]]}),
        ),
        (
            RemoteOp::MergeChild {
                parent: "rs_1".into(),
                child: "c1".into(),
            },
            serde_json::json!({"op": "merge_child", "parent": "rs_1", "child": "c1"}),
        ),
    ];
    for (op, json) in ops {
        assert!(op.on_any_space(), "{op:?}");
        assert_eq!(op.space(), "", "{op:?}");
        assert_eq!(serde_json::to_value(&op).unwrap(), json);
        assert_eq!(serde_json::from_value::<RemoteOp>(json).unwrap(), op);
    }
    assert!(
        !RemoteOp::Stop {
            space: "rs_1".into()
        }
        .on_any_space()
    );
    // Optional fields may be left out.
    let op: RemoteOp = serde_json::from_value(serde_json::json!({"op": "list_spaces"})).unwrap();
    assert_eq!(op, RemoteOp::ListSpaces { project: None });
    assert!(MIRROR_MODELS.contains(&SUB_SPACE_MODEL));
}

#[test]
fn a_confirm_is_signed_by_its_host_for_its_own_domain() {
    let key = DeviceKey::generate().unwrap();
    let c = RemoteConfirm {
        confirm_id: "r1".into(),
        host_device: "dev_h".into(),
        mcp_device: "dev_m".into(),
        action: ConfirmAction::ApprovePlan,
        mode: FleetMode::Edit,
        project_name: None,
        space_name: Some("fix".into()),
        text: "Plan approved".into(),
        expires_at_ms: 9,
    };
    let env = SignedEnvelope::seal_as(&c, &key, Domain::Confirm);
    assert_eq!(env.device_id, "dev_h");
    assert_eq!(
        env.open_as::<RemoteConfirm>(&key.public_key(), Domain::Confirm)
            .unwrap(),
        c
    );
    assert_eq!(
        env.open_as::<RemoteConfirm>(&key.public_key(), Domain::Ask),
        Err(EnvelopeError::BadSignature)
    );
}
