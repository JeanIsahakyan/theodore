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
            attachments: vec![],
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
        attachments: vec![],
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
                attachments: vec![],
            },
            serde_json::json!({"op": "send_to", "space": "a1", "message": "go", "attachments": []}),
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

// ── files (blobs) ───────────────────────────────────────────────────────────

mod blobs {
    use super::*;
    use crate::blob::{
        self, CHUNK_BYTES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_CHUNKS, MAX_NAME_CHARS,
        SealParams, blob_key, chunk_count, seal_blob_with, x25519_public_from_ed25519,
        x25519_secret_from_ed25519_seed,
    };
    use curve25519_dalek::edwards::CompressedEdwardsY;
    use sha2::Digest;

    fn hexs(s: &str) -> [u8; 32] {
        hex::decode(s).unwrap().try_into().unwrap()
    }

    #[test]
    fn the_ed25519_basepoint_maps_to_u_9() {
        // The one conversion everybody agrees on: B = (x, 4/5) ─▶ u = 9,
        // the X25519 basepoint (RFC 7748 and libsodium's
        // `crypto_sign_ed25519_pk_to_curve25519`).
        let b = hexs("5866666666666666666666666666666666666666666666666666666666666666");
        let mut nine = [0u8; 32];
        nine[0] = 9;
        assert_eq!(x25519_public_from_ed25519(&b), Some(nine));
        // Not a point, or the identity: unusable.
        assert_eq!(x25519_public_from_ed25519(&not_a_point()), None);
        let mut identity = [0u8; 32];
        identity[0] = 1;
        assert_eq!(x25519_public_from_ed25519(&identity), None);
    }

    /// 32 bytes that aren't a compressed Edwards point (about half of all
    /// y values aren't; the first such one).
    fn not_a_point() -> [u8; 32] {
        (2u8..)
            .map(|y| {
                let mut b = [0u8; 32];
                b[0] = y;
                b
            })
            .find(|b| CompressedEdwardsY(*b).decompress().is_none())
            .unwrap()
    }

    #[test]
    fn the_derived_secret_matches_the_derived_public_key() {
        // libsodium's pair is consistent: X25519(sk_to_curve25519(seed), 9)
        // equals pk_to_curve25519(ed25519_pk(seed)). Checked for the RFC
        // 8032 test keys and a fresh one.
        for seed in [
            hexs("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"),
            hexs("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb"),
            hexs("c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7"),
            [7u8; 32],
        ] {
            let key = DeviceKey::from_seed_for_vectors(&seed).unwrap();
            let pk: [u8; 32] = unb64(&key.public_key()).unwrap().try_into().unwrap();
            let sk = x25519_secret_from_ed25519_seed(&seed);
            assert_eq!(sk[0] & 7, 0);
            assert_eq!(sk[31] & 0xc0, 0x40);
            let from_sk = x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(sk));
            assert_eq!(
                Some(from_sk.to_bytes()),
                x25519_public_from_ed25519(&pk),
                "{}",
                hex::encode(seed)
            );
        }
        // RFC 8032 test 1's public key, as its seed derives it.
        let key = DeviceKey::from_seed_for_vectors(&hexs(
            "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
        ))
        .unwrap();
        assert_eq!(
            hex::encode(unb64(&key.public_key()).unwrap()),
            "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
        );
    }

    #[test]
    fn a_generated_key_exposes_the_seed_it_signs_with() {
        let key = DeviceKey::generate().unwrap();
        let again = DeviceKey::from_seed_for_vectors(key.seed()).unwrap();
        assert_eq!(again.public_key(), key.public_key());
        let back = DeviceKey::from_secret(key.to_secret()).unwrap();
        assert_eq!(back.seed(), key.seed());
    }

    #[test]
    fn blob_key_is_hkdf_of_the_shared_secret_with_both_public_keys_as_salt() {
        use hkdf::Hkdf;
        use sha2::Sha256;
        let eph_sk = [3u8; 32];
        let seed = [4u8; 32];
        let key = DeviceKey::from_seed_for_vectors(&seed).unwrap();
        let pk: [u8; 32] = unb64(&key.public_key()).unwrap().try_into().unwrap();
        let rx = x25519_public_from_ed25519(&pk).unwrap();
        let (eph_pk, k) = blob_key(&eph_sk, &rx);
        // By hand.
        let s = x25519_dalek::StaticSecret::from(eph_sk);
        assert_eq!(x25519_dalek::PublicKey::from(&s).to_bytes(), eph_pk);
        let shared = s.diffie_hellman(&x25519_dalek::PublicKey::from(rx));
        let salt = [eph_pk.as_slice(), rx.as_slice()].concat();
        let mut want = [0u8; 32];
        Hkdf::<Sha256>::new(Some(&salt), shared.as_bytes())
            .expand(b"theodore-blob-v1", &mut want)
            .unwrap();
        assert_eq!(k, want);
        // The recipient gets the same key from its side.
        let rsk = x25519_dalek::StaticSecret::from(x25519_secret_from_ed25519_seed(&seed));
        assert_eq!(
            rsk.diffie_hellman(&x25519_dalek::PublicKey::from(eph_pk))
                .as_bytes(),
            shared.as_bytes()
        );
    }

    fn params(id: u8) -> SealParams {
        SealParams {
            blob_id: hex::encode([id; 16]),
            eph_sk: [id.wrapping_add(1); 32],
            nonce_prefix: [id.wrapping_add(2); 16],
        }
    }

    fn pattern(len: usize) -> Vec<u8> {
        (0..len).map(|i| ((i * 31) % 251) as u8).collect()
    }

    #[test]
    fn seal_then_open_round_trips_for_every_chunk_shape() {
        let key = DeviceKey::generate().unwrap();
        for len in [
            0,
            1,
            10,
            CHUNK_BYTES - 1,
            CHUNK_BYTES,
            CHUNK_BYTES + 3,
            2 * CHUNK_BYTES,
        ] {
            let plain = pattern(len);
            let (r, chunks) = seal_blob(&key.public_key(), &plain, "a.txt", "text/plain").unwrap();
            assert_eq!(r.size, len as u64);
            assert_eq!(u64::from(r.chunks), chunk_count(len as u64));
            assert_eq!(chunks.len(), r.chunks as usize);
            for (i, c) in chunks.iter().enumerate() {
                let start = i * CHUNK_BYTES;
                let want = plain.len().saturating_sub(start).min(CHUNK_BYTES) + 16;
                assert_eq!(c.len(), want, "chunk {i} of {len}");
            }
            assert_eq!(r.sha256, hex::encode(sha2::Sha256::digest(&plain)));
            assert_eq!(open_blob(key.seed(), &r, &chunks).unwrap(), plain, "{len}");
        }
        let (r, _) = seal_blob(&key.public_key(), b"", "x", "").unwrap();
        assert_eq!(r.chunks, 1, "an empty file is one empty chunk");
    }

    #[test]
    fn the_same_inputs_seal_the_same_bytes_and_random_ones_differ() {
        let key = DeviceKey::from_seed_for_vectors(&[1; 32]).unwrap();
        let a = seal_blob_with(&params(9), &key.public_key(), b"hello", "h", "t").unwrap();
        let b = seal_blob_with(&params(9), &key.public_key(), b"hello", "h", "t").unwrap();
        assert_eq!(a, b);
        let c = seal_blob(&key.public_key(), b"hello", "h", "t").unwrap();
        let d = seal_blob(&key.public_key(), b"hello", "h", "t").unwrap();
        assert_ne!(c.0.blob_id, d.0.blob_id);
        assert_ne!(c.0.eph_pk, d.0.eph_pk);
        assert_ne!(c.0.nonce_prefix, d.0.nonce_prefix);
        assert_ne!(c.1, d.1);
        assert_eq!(c.0.sha256, d.0.sha256);
    }

    #[test]
    fn tampering_anywhere_fails_and_nothing_is_returned() {
        let key = DeviceKey::generate().unwrap();
        let plain = pattern(CHUNK_BYTES + 3);
        let (r, chunks) = seal_blob(&key.public_key(), &plain, "a.bin", "").unwrap();
        // A flipped ciphertext byte, in each chunk.
        for i in 0..chunks.len() {
            let mut t = chunks.clone();
            t[i][0] ^= 1;
            assert_eq!(
                open_blob(key.seed(), &r, &t),
                Err(BlobError::Tamper(i as u32))
            );
            let mut t = chunks.clone();
            let n = t[i].len();
            t[i][n - 1] ^= 1;
            assert_eq!(
                open_blob(key.seed(), &r, &t),
                Err(BlobError::Tamper(i as u32))
            );
        }
        // Chunks swapped: the index is in the nonce and the AAD.
        let swapped = vec![chunks[1].clone(), chunks[0].clone()];
        assert_eq!(
            open_blob(key.seed(), &r, &swapped),
            Err(BlobError::Tamper(0))
        );
        // One missing, one extra.
        assert_eq!(
            open_blob(key.seed(), &r, &chunks[..1]),
            Err(BlobError::ChunkCount {
                expected: 2,
                got: 1
            })
        );
        // Another blob id (the AAD binds it) or chunk count.
        let mut other = r.clone();
        other.blob_id = hex::encode([0xab; 16]);
        assert_eq!(
            open_blob(key.seed(), &other, &chunks),
            Err(BlobError::Tamper(0))
        );
        // A changed reference: size or digest.
        let mut other = r.clone();
        other.sha256 = "0".repeat(64);
        assert_eq!(
            open_blob(key.seed(), &other, &chunks),
            Err(BlobError::Digest)
        );
        let mut other = r.clone();
        other.size += 1;
        assert_eq!(
            open_blob(key.seed(), &other, &chunks),
            Err(BlobError::Digest)
        );
        // Another nonce prefix.
        let mut other = r.clone();
        other.nonce_prefix = b64(&[0u8; 16]);
        assert_eq!(
            open_blob(key.seed(), &other, &chunks),
            Err(BlobError::Tamper(0))
        );
        // A chunk too long to be one at all isn't even tried.
        let mut t = chunks.clone();
        t[0] = vec![0; CHUNK_BYTES + 17];
        assert_eq!(open_blob(key.seed(), &r, &t), Err(BlobError::Tamper(0)));
    }

    #[test]
    fn only_the_recipient_opens_it() {
        let alice = DeviceKey::generate().unwrap();
        let bob = DeviceKey::generate().unwrap();
        let (r, chunks) = seal_blob(&alice.public_key(), b"for alice", "n", "").unwrap();
        assert_eq!(
            open_blob(alice.seed(), &r, &chunks).unwrap(),
            b"for alice".to_vec()
        );
        assert_eq!(
            open_blob(bob.seed(), &r, &chunks),
            Err(BlobError::Tamper(0))
        );
        // A recipient key that isn't one.
        assert_eq!(
            seal_blob("nope", b"x", "n", "").unwrap_err(),
            BlobError::BadRecipientKey
        );
        assert_eq!(
            seal_blob(&b64(&not_a_point()), b"x", "n", "").unwrap_err(),
            BlobError::BadRecipientKey
        );
        assert_eq!(
            seal_blob(&b64(&[1; 31]), b"x", "n", "").unwrap_err(),
            BlobError::BadRecipientKey
        );
    }

    fn good() -> BlobRef {
        let key = DeviceKey::from_seed_for_vectors(&[1; 32]).unwrap();
        seal_blob_with(
            &params(5),
            &key.public_key(),
            b"hello",
            "notes.md",
            "text/markdown",
        )
        .unwrap()
        .0
    }

    #[test]
    fn validate_checks_every_bound() {
        let r = good();
        assert_eq!(r.validate(), Ok(()));
        let bad = |f: &dyn Fn(&mut BlobRef), field: &'static str| {
            let mut r = good();
            f(&mut r);
            assert_eq!(
                r.validate(),
                Err(BlobError::Invalid(field)),
                "{field}: {r:?}"
            );
        };
        bad(
            &|r| r.blob_id = "ABCDEF0123456789abcdef0123456789".into(),
            "blob_id",
        );
        bad(&|r| r.blob_id.pop().map(drop).unwrap_or(()), "blob_id");
        bad(&|r| r.blob_id.push('0'), "blob_id");
        bad(&|r| r.name = String::new(), "name");
        bad(&|r| r.name = "x".repeat(MAX_NAME_CHARS + 1), "name");
        bad(&|r| r.name = "a/b".into(), "name");
        bad(&|r| r.name = "a\\b".into(), "name");
        bad(&|r| r.name = "a\0b".into(), "name");
        bad(&|r| r.mime = "x".repeat(101), "mime");
        bad(&|r| r.mime = "text/\nplain".into(), "mime");
        bad(&|r| r.chunks = 0, "chunks");
        bad(&|r| r.chunks = 2, "chunks");
        bad(
            &|r| {
                r.size = u64::from(MAX_CHUNKS + 1) * CHUNK_BYTES as u64;
                r.chunks = MAX_CHUNKS + 1;
            },
            "chunks",
        );
        bad(&|r| r.sha256 = "0".repeat(63), "sha256");
        bad(&|r| r.sha256 = "G".repeat(64), "sha256");
        bad(&|r| r.eph_pk = b64(&[0; 31]), "eph_pk");
        bad(&|r| r.eph_pk = "not base64!".into(), "eph_pk");
        bad(&|r| r.nonce_prefix = b64(&[0; 15]), "nonce_prefix");
        // The name may have 200 chars, the mime 100; a big size fits.
        let mut r = good();
        r.name = "é".repeat(MAX_NAME_CHARS);
        r.mime = "m".repeat(100);
        assert_eq!(r.validate(), Ok(()));
        let mut r = good();
        r.size = u64::from(MAX_CHUNKS) * CHUNK_BYTES as u64;
        r.chunks = MAX_CHUNKS;
        assert_eq!(r.validate(), Ok(()));
        // Open refuses what validate refuses, before any crypto.
        let mut r = good();
        r.blob_id = "x".into();
        assert_eq!(
            open_blob(&[1; 32], &r, &[vec![]]),
            Err(BlobError::Invalid("blob_id"))
        );
        // Sealing more than the chunks allow.
        assert_eq!(
            chunk_count(u64::from(MAX_CHUNKS) * CHUNK_BYTES as u64 + 1),
            u64::from(MAX_CHUNKS) + 1
        );
    }

    #[test]
    fn safe_names_keep_the_file_name_and_its_extension_only() {
        let s = safe_attachment_name;
        assert_eq!(s("notes.md"), "notes.md");
        assert_eq!(s("/etc/passwd"), "passwd");
        assert_eq!(s("..\\..\\win.ini"), "win.ini");
        assert_eq!(s("dir/../x.txt"), "x.txt");
        assert_eq!(s("a/b/"), "b");
        assert_eq!(s(".."), "file");
        assert_eq!(s(".hidden"), "hidden");
        assert_eq!(s(""), "file");
        assert_eq!(s("   "), "file");
        assert_eq!(s("/"), "file");
        assert_eq!(s("ta\0b\u{7}.txt\n"), "tab.txt");
        assert_eq!(s(" spaced name.pdf "), "spaced name.pdf");
        assert_eq!(s("рисунок.png"), "рисунок.png");
        let long = format!("{}.tar.gz", "n".repeat(300));
        let cut = s(&long);
        assert_eq!(cut.chars().count(), MAX_NAME_CHARS);
        assert!(cut.ends_with(".gz"));
        let no_ext = s(&"n".repeat(300));
        assert_eq!(no_ext.chars().count(), MAX_NAME_CHARS);
        // A long "extension" isn't one.
        let odd = format!("a.{}", "e".repeat(250));
        assert_eq!(s(&odd).chars().count(), MAX_NAME_CHARS);
        // Whatever comes out passes validation.
        for n in ["/etc/passwd", "..", "", &long, "a\0b"] {
            let mut r = good();
            r.name = s(n);
            assert_eq!(r.validate(), Ok(()), "{n:?}");
        }
    }

    #[test]
    fn ops_carry_attachments_and_older_bodies_default_to_none() {
        let r = good();
        let op = RemoteOp::Send {
            space: "rs_1".into(),
            text: "see the file".into(),
            mode: None,
            agent: None,
            model: None,
            effort: None,
            attachments: vec![r.clone()],
        };
        let v = serde_json::to_value(&op).unwrap();
        assert_eq!(
            v["attachments"][0],
            serde_json::json!({
                "blob_id": r.blob_id, "name": "notes.md", "mime": "text/markdown",
                "size": 5, "chunks": 1, "sha256": r.sha256,
                "eph_pk": r.eph_pk, "nonce_prefix": r.nonce_prefix,
            })
        );
        assert_eq!(serde_json::from_value::<RemoteOp>(v).unwrap(), op);
        assert_eq!(op.attachments(), std::slice::from_ref(&r));
        // Without files: an empty list, written (an older peer ignores it).
        let none = RemoteOp::Send {
            space: "rs_1".into(),
            text: "see the file".into(),
            mode: None,
            agent: None,
            model: None,
            effort: None,
            attachments: vec![],
        };
        let v = serde_json::to_value(&none).unwrap();
        assert_eq!(v["attachments"], serde_json::json!([]));
        assert_eq!(op.validate_blobs(), Ok(()));
        // v7 bodies: no `attachments` at all.
        for body in [
            r#"{"op":"send","space":"rs_1","text":"go"}"#,
            r#"{"op":"start_space","space":"rs_1","project_id":"p","goal":"g","mode":"edit","depth":0}"#,
            r#"{"op":"send_to","space":"a1","message":"go"}"#,
        ] {
            let op: RemoteOp = serde_json::from_str(body).unwrap();
            assert!(op.attachments().is_empty(), "{body}");
            assert_eq!(op.validate_blobs(), Ok(()));
        }
        assert!(
            RemoteOp::Stop {
                space: "rs_1".into()
            }
            .attachments()
            .is_empty()
        );
        // Under the signature like every field.
        let key = DeviceKey::generate().unwrap();
        let mut req = req("dev_a");
        req.op = op;
        let env = SignedEnvelope::seal(&req, &key);
        let mut t = env.clone();
        t.body = t.body.replace(&r.sha256, &"0".repeat(64));
        assert_eq!(t.open(&key.public_key()), Err(EnvelopeError::BadSignature));
        assert_eq!(env.open(&key.public_key()).unwrap(), req);
    }

    #[test]
    fn validate_blobs_caps_the_list_and_each_size() {
        let r = good();
        let with = |list: Vec<BlobRef>| RemoteOp::StartSpace {
            space: "rs_1".into(),
            project_id: "p".into(),
            goal: "g".into(),
            mode: FleetMode::Edit,
            agent: None,
            model: None,
            effort: None,
            parent: None,
            depth: 0,
            attachments: list,
        };
        let distinct = |n: usize| -> Vec<BlobRef> {
            (0..n)
                .map(|i| BlobRef {
                    blob_id: hex::encode([i as u8; 16]),
                    ..r.clone()
                })
                .collect()
        };
        assert_eq!(with(distinct(MAX_ATTACHMENTS)).validate_blobs(), Ok(()));
        assert_eq!(
            with(distinct(MAX_ATTACHMENTS + 1)).validate_blobs(),
            Err(BlobError::TooManyAttachments)
        );
        assert_eq!(
            with(vec![r.clone(), r.clone()]).validate_blobs(),
            Err(BlobError::Invalid("blob id listed twice"))
        );
        let mut big = r.clone();
        big.size = MAX_ATTACHMENT_BYTES + 1;
        big.chunks = 6;
        assert_eq!(big.validate(), Ok(()));
        assert_eq!(with(vec![big]).validate_blobs(), Err(BlobError::TooLarge));
        let mut bad = r.clone();
        bad.name = "../x".into();
        assert_eq!(
            with(vec![bad]).validate_blobs(),
            Err(BlobError::Invalid("name"))
        );
    }

    #[test]
    fn read_file_is_an_op_on_any_space_with_a_bounded_path() {
        let op = RemoteOp::ReadFile {
            space: "a1".into(),
            path: "src/main.rs".into(),
            max_bytes: 1024,
        };
        assert!(op.on_any_space());
        assert_eq!(op.space(), "");
        assert!(op.attachments().is_empty());
        assert_eq!(op.validate_blobs(), Ok(()));
        let json = serde_json::json!({"op": "read_file", "space": "a1", "path": "src/main.rs", "max_bytes": 1024});
        assert_eq!(serde_json::to_value(&op).unwrap(), json);
        assert_eq!(serde_json::from_value::<RemoteOp>(json).unwrap(), op);
        for path in ["", &"p".repeat(blob::MAX_PATH_CHARS + 1), "a\0b"] {
            let op = RemoteOp::ReadFile {
                space: "a1".into(),
                path: path.into(),
                max_bytes: 1,
            };
            assert_eq!(op.validate_blobs(), Err(BlobError::Invalid("path")));
        }
        let ok = RemoteOp::ReadFile {
            space: "a1".into(),
            path: "p".repeat(blob::MAX_PATH_CHARS),
            max_bytes: 1,
        };
        assert_eq!(ok.validate_blobs(), Ok(()));
        let v = serde_json::to_value(ReadFileResult { blob: good() }).unwrap();
        assert_eq!(v["blob"]["name"], "notes.md");
        assert_eq!(PROTOCOL_VERSION, 8);
        assert_eq!(codes::BLOB_NOT_FOUND, "fleet.blob_not_found");
        assert_eq!(codes::QUOTA, "fleet.quota");
    }
}
