use super::*;

fn req(origin: &str) -> RemoteRequest {
    RemoteRequest {
        req_id: "r1".into(),
        origin_device: origin.into(),
        target_device: "dev_b".into(),
        issued_at_ms: 1_000,
        op: RemoteOp::StartSpace {
            space: "rs_1".into(),
            project_id: "p1".into(),
            goal: "fix the tests".into(),
            mode: FleetMode::Edit,
            agent: None,
            model: None,
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
