//! `WsFleet` against a local WebSocket server that plays the cloud.

// tungstenite's accept callback returns `Result<Response, ErrorResponse>`.
#![allow(clippy::result_large_err)]

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use pretty_assertions::assert_eq;
use theodore_fleet::{FleetTiming, OUTBOX_LIMIT, WsFleet};
use theodore_fleet_protocol::{
    ClientMessage, DeviceInfo, DeviceKey, DeviceKind, DeviceOs, FleetMode, MAX_FRAME_BYTES,
    PROTOCOL_VERSION, ReplyBody, ReplyOutcome, ServerMessage, SignedEnvelope, SpaceCursor, b64,
    codes, verify, verify_hello,
};
use theodore_ports::fleet::{FleetCommand, FleetConnect, FleetInbound, FleetLink, FleetPort};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Message, protocol::WebSocketConfig};

const WAIT: Duration = Duration::from_secs(5);
const NONCE: [u8; 32] = [7; 32];

// ── the fake cloud ──────────────────────────────────────────────────────────

struct Cloud {
    listener: TcpListener,
    url: String,
}

struct Conn {
    ws: WebSocketStream<TcpStream>,
    auth: Option<String>,
    user_agent: Option<String>,
    path: String,
}

#[derive(Debug)]
struct Hello {
    device_id: Option<String>,
    info: DeviceInfo,
    spaces: Vec<SpaceCursor>,
}

impl Cloud {
    async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        Cloud { listener, url }
    }

    async fn accept(&self) -> Conn {
        let (tcp, _) = timeout(WAIT, self.listener.accept())
            .await
            .expect("the device dials")
            .unwrap();
        let mut seen = (None, None, String::new());
        let header = |req: &Request, name: &str| {
            req.headers()
                .get(name)
                .map(|v| v.to_str().unwrap().to_string())
        };
        let config = WebSocketConfig::default()
            .max_message_size(None)
            .max_frame_size(None);
        let ws = tokio_tungstenite::accept_hdr_async_with_config(
            tcp,
            |req: &Request, resp: Response| {
                seen = (
                    header(req, "authorization"),
                    header(req, "user-agent"),
                    req.uri().path().to_string(),
                );
                Ok(resp)
            },
            Some(config),
        )
        .await
        .unwrap();
        Conn {
            ws,
            auth: seen.0,
            user_agent: seen.1,
            path: seen.2,
        }
    }

    async fn refuse(&self, status: StatusCode) {
        let (tcp, _) = timeout(WAIT, self.listener.accept())
            .await
            .expect("the device dials")
            .unwrap();
        let _ = tokio_tungstenite::accept_hdr_async(tcp, |_: &Request, _: Response| {
            let mut resp = ErrorResponse::new(None);
            *resp.status_mut() = status;
            Err(resp)
        })
        .await;
    }

    /// Whether the device dials again within `within`.
    async fn redials(&self, within: Duration) -> bool {
        timeout(within, self.listener.accept()).await.is_ok()
    }
}

impl Conn {
    async fn send(&mut self, msg: &ServerMessage) {
        let text = serde_json::to_string(msg).unwrap();
        self.ws.send(Message::text(text)).await.unwrap();
    }

    /// The next frame, pings included.
    async fn frame(&mut self) -> Option<Message> {
        timeout(WAIT, self.ws.next())
            .await
            .expect("a frame in time")
            .map(|r| r.unwrap())
    }

    /// The device ends the socket without another text frame.
    async fn dropped(&mut self) -> bool {
        loop {
            match timeout(WAIT, self.ws.next()).await.expect("in time") {
                None | Some(Err(_)) | Some(Ok(Message::Close(_))) => return true,
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                Some(Ok(_)) => return false,
            }
        }
    }

    /// The next client message, skipping pings.
    async fn recv(&mut self) -> ClientMessage {
        loop {
            match self.frame().await.expect("the socket stays open") {
                Message::Text(t) => return serde_json::from_str(&t).unwrap(),
                Message::Ping(_) | Message::Pong(_) => continue,
                other => panic!("unexpected frame {other:?}"),
            }
        }
    }

    /// challenge ─▶ hello (signature checked) ─▶ welcome.
    async fn handshake(
        &mut self,
        device_id: &str,
        generation: u64,
        resume: BTreeMap<String, u64>,
    ) -> Hello {
        self.send(&ServerMessage::Challenge { nonce: b64(&NONCE) })
            .await;
        let ClientMessage::Hello {
            protocol,
            device_id: hello_id,
            public_key,
            signature,
            info,
            spaces,
        } = self.recv().await
        else {
            panic!("hello first");
        };
        assert_eq!(protocol, PROTOCOL_VERSION);
        assert!(
            verify_hello(&public_key, &NONCE, &signature),
            "hello signs the nonce, for hello"
        );
        assert!(
            !verify(&public_key, &NONCE, &signature),
            "never the bare nonce"
        );
        self.send(&ServerMessage::Welcome {
            device_id: device_id.into(),
            generation,
            resume,
        })
        .await;
        Hello {
            device_id: hello_id,
            info,
            spaces,
        }
    }

    async fn drop_socket(self) {
        drop(self.ws);
    }
}

// ── the device ──────────────────────────────────────────────────────────────

fn timing() -> FleetTiming {
    FleetTiming {
        backoff_min: Duration::from_millis(20),
        backoff_max: Duration::from_millis(100),
        ping_every: Duration::from_secs(30),
        silence: Duration::from_secs(30),
    }
}

fn info(name: &str) -> DeviceInfo {
    DeviceInfo {
        name: name.into(),
        os: DeviceOs::Macos,
        kind: DeviceKind::Desktop,
        app_version: "0.1.17".into(),
        projects: vec![],
        accepts_remote: false,
        max_mode: FleetMode::Edit,
    }
}

fn start(cloud: &Cloud, timing: FleetTiming) -> (FleetLink, Arc<DeviceKey>) {
    let key = Arc::new(DeviceKey::generate().unwrap());
    let link = WsFleet::with_timing(timing).start(FleetConnect {
        cloud_url: cloud.url.clone(),
        access_token: "tok1".into(),
        device_id: None,
        key: key.clone(),
        info: info("mac1"),
        spaces: vec![SpaceCursor {
            space: "rs_1".into(),
            seq: 3,
        }],
    });
    (link, key)
}

async fn next(link: &mut FleetLink) -> FleetInbound {
    timeout(WAIT, link.inbound.recv())
        .await
        .expect("an event in time")
        .expect("the link is alive")
}

async fn ended(link: &mut FleetLink) {
    assert!(
        timeout(WAIT, link.inbound.recv())
            .await
            .expect("the link ends")
            .is_none()
    );
}

fn send(link: &FleetLink, msg: ClientMessage) {
    link.commands.send(FleetCommand::Send(msg)).unwrap();
}

/// A reply as the core hands it over: signed already (the adapter only
/// carries it), so any envelope does here.
fn reply_with(req_id: &str, value: serde_json::Value) -> ClientMessage {
    let body = ReplyBody {
        req_id: req_id.into(),
        origin_device: "dev_o".into(),
        target_device: "dev_1".into(),
        outcome: ReplyOutcome::Ok { value },
    };
    ClientMessage::Reply {
        envelope: SignedEnvelope {
            device_id: "dev_1".into(),
            body: serde_json::to_string(&body).unwrap(),
            signature: "c2ln".into(),
        },
    }
}

fn reply(req_id: &str) -> ClientMessage {
    reply_with(req_id, serde_json::json!({}))
}

fn presence() -> ClientMessage {
    ClientMessage::Presence {
        focused: true,
        locked: false,
        idle_ms: 0,
    }
}

fn devices() -> ServerMessage {
    ServerMessage::Devices { devices: vec![] }
}

async fn connected(link: &mut FleetLink) -> (String, u64, BTreeMap<String, u64>) {
    match next(link).await {
        FleetInbound::Connected {
            device_id,
            generation,
            resume,
        } => (device_id, generation, resume),
        other => panic!("expected Connected, got {other:?}"),
    }
}

async fn disconnected(link: &mut FleetLink) -> String {
    match next(link).await {
        FleetInbound::Disconnected { reason, .. } => reason,
        other => panic!("expected Disconnected, got {other:?}"),
    }
}

async fn fatal(link: &mut FleetLink) -> String {
    match next(link).await {
        FleetInbound::Fatal { code, .. } => code,
        other => panic!("expected Fatal, got {other:?}"),
    }
}

// ── tests ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn handshake_signs_the_nonce_and_reports_resume() {
    let cloud = Cloud::new().await;
    let (mut link, key) = start(&cloud, timing());
    let mut conn = cloud.accept().await;
    assert_eq!(conn.path, "/v1/fleet/ws");
    assert_eq!(conn.auth.as_deref(), Some("Bearer tok1"));
    assert_eq!(conn.user_agent.as_deref(), Some("theodore"));

    let resume = BTreeMap::from([("rs_1".to_string(), 2)]);
    let hello = conn.handshake("dev_1", 1, resume.clone()).await;
    assert_eq!(hello.device_id, None);
    assert_eq!(hello.info, info("mac1"));
    assert_eq!(
        hello.spaces,
        vec![SpaceCursor {
            space: "rs_1".into(),
            seq: 3
        }]
    );
    assert_eq!(connected(&mut link).await, ("dev_1".into(), 1, resume));

    conn.send(&devices()).await;
    assert!(matches!(
        next(&mut link).await,
        FleetInbound::Message(ServerMessage::Devices { .. })
    ));

    send(&link, presence());
    assert_eq!(conn.recv().await, presence());
    drop(key);
}

/// The cloud gets nothing signed but a 32-byte nonce: anything else (say,
/// a request body passed off as a challenge) drops the socket unsigned.
#[tokio::test]
async fn a_challenge_that_isnt_a_32_byte_nonce_is_never_signed() {
    let cloud = Cloud::new().await;
    let (mut link, _key) = start(&cloud, timing());
    for nonce in [
        b64(br#"{"req_id":"r1","origin_device":"dev_1"}"#),
        b64(&[7; 31]),
        b64(&[7; 33]),
        "not base64!".to_string(),
    ] {
        let mut conn = cloud.accept().await;
        conn.send(&ServerMessage::Challenge { nonce }).await;
        assert!(conn.dropped().await, "no hello for a bad nonce");
        assert!(disconnected(&mut link).await.contains("32-byte"));
    }
    // A good nonce on the next dial still connects.
    let mut conn = cloud.accept().await;
    conn.handshake("dev_1", 1, BTreeMap::new()).await;
    connected(&mut link).await;
}

/// One challenge per connection: a second one, before or after the
/// welcome, drops the socket without signing it.
#[tokio::test]
async fn a_second_challenge_drops_the_socket() {
    let cloud = Cloud::new().await;
    let (mut link, _key) = start(&cloud, timing());

    // Before the welcome.
    let mut conn = cloud.accept().await;
    conn.send(&ServerMessage::Challenge { nonce: b64(&NONCE) })
        .await;
    assert!(matches!(conn.recv().await, ClientMessage::Hello { .. }));
    conn.send(&ServerMessage::Challenge {
        nonce: b64(&[9; 32]),
    })
    .await;
    assert!(conn.dropped().await, "no second hello");
    assert!(disconnected(&mut link).await.contains("second challenge"));

    // After the welcome.
    let mut conn = cloud.accept().await;
    conn.handshake("dev_1", 1, BTreeMap::new()).await;
    connected(&mut link).await;
    conn.send(&ServerMessage::Challenge {
        nonce: b64(&[9; 32]),
    })
    .await;
    assert!(conn.dropped().await, "no second hello");
    assert!(disconnected(&mut link).await.contains("second challenge"));
    assert!(cloud.redials(WAIT).await, "and redials");
}

#[tokio::test]
async fn redial_reuses_the_device_id() {
    let cloud = Cloud::new().await;
    let (mut link, _key) = start(&cloud, timing());
    let mut conn = cloud.accept().await;
    conn.handshake("dev_1", 1, BTreeMap::new()).await;
    connected(&mut link).await;

    conn.drop_socket().await;
    disconnected(&mut link).await;

    let mut conn = cloud.accept().await;
    let hello = conn.handshake("dev_1", 2, BTreeMap::new()).await;
    assert_eq!(hello.device_id.as_deref(), Some("dev_1"));
    assert_eq!(connected(&mut link).await.1, 2);
}

#[tokio::test]
async fn outbox_keeps_replies_and_drops_the_rest() {
    let cloud = Cloud::new().await;
    let (mut link, _key) = start(&cloud, timing());
    let mut conn = cloud.accept().await;
    conn.handshake("dev_1", 1, BTreeMap::new()).await;
    connected(&mut link).await;
    conn.drop_socket().await;
    disconnected(&mut link).await;

    // Offline: the claim and the presence belong to a connection.
    send(
        &link,
        ClientMessage::Claim {
            req_id: "r0".into(),
            generation: 1,
        },
    );
    send(&link, reply("r1"));
    send(&link, presence());
    send(
        &link,
        ClientMessage::AskResolved {
            ask_id: "a1".into(),
        },
    );

    let mut conn = cloud.accept().await;
    conn.handshake("dev_1", 2, BTreeMap::new()).await;
    connected(&mut link).await;
    send(&link, presence());
    assert_eq!(conn.recv().await, reply("r1"));
    assert_eq!(
        conn.recv().await,
        ClientMessage::AskResolved {
            ask_id: "a1".into()
        }
    );
    assert_eq!(conn.recv().await, presence());
}

#[tokio::test]
async fn outbox_drops_the_oldest_past_its_limit() {
    let cloud = Cloud::new().await;
    let (mut link, _key) = start(&cloud, timing());
    // Never dialed through: everything waits in the outbox.
    for i in 0..=OUTBOX_LIMIT {
        send(&link, reply(&i.to_string()));
    }
    let mut conn = cloud.accept().await;
    conn.handshake("dev_1", 1, BTreeMap::new()).await;
    connected(&mut link).await;
    assert_eq!(conn.recv().await, reply("1"));
    for i in 2..=OUTBOX_LIMIT {
        assert_eq!(conn.recv().await, reply(&i.to_string()));
    }
}

#[tokio::test]
async fn reauth_is_sent_and_used_for_the_next_dial() {
    let cloud = Cloud::new().await;
    let (mut link, _key) = start(&cloud, timing());
    let mut conn = cloud.accept().await;
    conn.handshake("dev_1", 1, BTreeMap::new()).await;
    connected(&mut link).await;

    link.commands
        .send(FleetCommand::Reauth("tok2".into()))
        .unwrap();
    assert_eq!(
        conn.recv().await,
        ClientMessage::Reauth {
            access_token: "tok2".into()
        }
    );
    conn.drop_socket().await;
    disconnected(&mut link).await;
    let conn = cloud.accept().await;
    assert_eq!(conn.auth.as_deref(), Some("Bearer tok2"));
}

#[tokio::test]
async fn reauth_during_the_handshake_follows_the_welcome() {
    let cloud = Cloud::new().await;
    let (mut link, _key) = start(&cloud, timing());
    let mut conn = cloud.accept().await;
    assert_eq!(conn.auth.as_deref(), Some("Bearer tok1"));
    link.commands
        .send(FleetCommand::Reauth("tok2".into()))
        .unwrap();
    // Queued before the challenge, so taken before the welcome.
    conn.handshake("dev_1", 1, BTreeMap::new()).await;
    connected(&mut link).await;
    assert_eq!(
        conn.recv().await,
        ClientMessage::Reauth {
            access_token: "tok2".into()
        }
    );
}

#[tokio::test]
async fn update_is_announced_and_used_in_the_next_hello() {
    let cloud = Cloud::new().await;
    let (mut link, _key) = start(&cloud, timing());
    let mut conn = cloud.accept().await;
    conn.handshake("dev_1", 1, BTreeMap::new()).await;
    connected(&mut link).await;

    let spaces = vec![SpaceCursor {
        space: "rs_2".into(),
        seq: 9,
    }];
    link.commands
        .send(FleetCommand::Update {
            info: info("mac1 renamed"),
            spaces: spaces.clone(),
        })
        .unwrap();
    assert_eq!(
        conn.recv().await,
        ClientMessage::Announce {
            info: info("mac1 renamed")
        }
    );
    conn.drop_socket().await;
    disconnected(&mut link).await;
    let mut conn = cloud.accept().await;
    let hello = conn.handshake("dev_1", 2, BTreeMap::new()).await;
    assert_eq!(hello.info, info("mac1 renamed"));
    assert_eq!(hello.spaces, spaces);
}

#[tokio::test]
async fn fatal_error_stops_redialing() {
    let cloud = Cloud::new().await;
    let (mut link, _key) = start(&cloud, timing());
    let mut conn = cloud.accept().await;
    conn.send(&ServerMessage::Challenge { nonce: b64(&NONCE) })
        .await;
    conn.recv().await;
    conn.send(&ServerMessage::Error {
        code: codes::KEY_MISMATCH.into(),
        message: "not your key".into(),
    })
    .await;
    assert_eq!(fatal(&mut link).await, codes::KEY_MISMATCH);
    ended(&mut link).await;
    assert!(!cloud.redials(Duration::from_millis(300)).await);
}

#[tokio::test]
async fn non_fatal_error_after_welcome_is_a_message() {
    let cloud = Cloud::new().await;
    let (mut link, _key) = start(&cloud, timing());
    let mut conn = cloud.accept().await;
    conn.handshake("dev_1", 1, BTreeMap::new()).await;
    connected(&mut link).await;
    conn.send(&ServerMessage::Error {
        code: codes::RATE_LIMITED.into(),
        message: "slow down".into(),
    })
    .await;
    assert!(matches!(
        next(&mut link).await,
        FleetInbound::Message(ServerMessage::Error { code, .. }) if code == codes::RATE_LIMITED
    ));
}

#[tokio::test]
async fn close_4001_is_fatal() {
    let cloud = Cloud::new().await;
    let (mut link, _key) = start(&cloud, timing());
    let mut conn = cloud.accept().await;
    conn.handshake("dev_1", 1, BTreeMap::new()).await;
    connected(&mut link).await;
    conn.ws
        .close(Some(CloseFrame {
            code: CloseCode::from(4001),
            reason: "token expired".into(),
        }))
        .await
        .unwrap();
    assert_eq!(fatal(&mut link).await, codes::UNAUTHORIZED);
    ended(&mut link).await;
    assert!(!cloud.redials(Duration::from_millis(300)).await);
}

/// Removed by another of the user's devices: fatal, with its own code.
#[tokio::test]
async fn close_4003_removed_is_fatal_as_removed() {
    let cloud = Cloud::new().await;
    let (mut link, _key) = start(&cloud, timing());
    let mut conn = cloud.accept().await;
    conn.handshake("dev_1", 1, BTreeMap::new()).await;
    connected(&mut link).await;
    conn.ws
        .close(Some(CloseFrame {
            code: CloseCode::from(4003),
            reason: codes::REMOVED.into(),
        }))
        .await
        .unwrap();
    assert_eq!(fatal(&mut link).await, codes::REMOVED);
    ended(&mut link).await;
    assert!(!cloud.redials(Duration::from_millis(300)).await);
}

/// Too many connections or spaces: a policy close, not the end.
#[tokio::test]
async fn too_many_connections_redials() {
    let cloud = Cloud::new().await;
    let (mut link, _key) = start(&cloud, timing());
    for code in [codes::TOO_MANY_CONNECTIONS, codes::TOO_MANY_SPACES] {
        let mut conn = cloud.accept().await;
        conn.handshake("dev_1", 1, BTreeMap::new()).await;
        connected(&mut link).await;
        conn.ws
            .close(Some(CloseFrame {
                code: CloseCode::Policy,
                reason: code.into(),
            }))
            .await
            .unwrap();
        assert!(disconnected(&mut link).await.contains(code));
    }
    assert!(cloud.redials(WAIT).await);
}

/// The cloud couldn't check a token (JWKS down): error + close 1011
/// `fleet.unavailable`, never the end of the link.
#[tokio::test]
async fn close_1011_unavailable_redials() {
    let cloud = Cloud::new().await;
    let (mut link, _key) = start(&cloud, timing());
    let mut conn = cloud.accept().await;
    conn.handshake("dev_1", 1, BTreeMap::new()).await;
    connected(&mut link).await;
    conn.send(&ServerMessage::Error {
        code: codes::UNAVAILABLE.into(),
        message: "signing keys unavailable".into(),
    })
    .await;
    conn.ws
        .close(Some(CloseFrame {
            code: CloseCode::Error,
            reason: codes::UNAVAILABLE.into(),
        }))
        .await
        .unwrap();
    assert!(matches!(
        next(&mut link).await,
        FleetInbound::Message(ServerMessage::Error { code, .. }) if code == codes::UNAVAILABLE
    ));
    assert!(disconnected(&mut link).await.contains(codes::UNAVAILABLE));
    let mut again = cloud.accept().await;
    again.handshake("dev_1", 2, BTreeMap::new()).await;
    assert_eq!(connected(&mut link).await.1, 2);
}

#[tokio::test]
async fn http_401_on_upgrade_is_fatal() {
    let cloud = Cloud::new().await;
    let (mut link, _key) = start(&cloud, timing());
    cloud.refuse(StatusCode::UNAUTHORIZED).await;
    assert_eq!(fatal(&mut link).await, codes::UNAUTHORIZED);
    ended(&mut link).await;
}

#[tokio::test]
async fn http_503_on_upgrade_redials() {
    let cloud = Cloud::new().await;
    let (mut link, _key) = start(&cloud, timing());
    cloud.refuse(StatusCode::SERVICE_UNAVAILABLE).await;
    assert!(disconnected(&mut link).await.contains("503"));
    let mut conn = cloud.accept().await;
    conn.handshake("dev_1", 1, BTreeMap::new()).await;
    connected(&mut link).await;
}

#[tokio::test]
async fn silence_drops_the_socket_and_redials() {
    let cloud = Cloud::new().await;
    let (mut link, _key) = start(
        &cloud,
        FleetTiming {
            silence: Duration::from_millis(300),
            ..timing()
        },
    );
    let mut conn = cloud.accept().await;
    conn.handshake("dev_1", 1, BTreeMap::new()).await;
    connected(&mut link).await;
    // The cloud goes quiet and keeps the socket open.
    let reason = disconnected(&mut link).await;
    assert!(reason.contains("no traffic"), "{reason}");
    let mut again = cloud.accept().await;
    again.handshake("dev_1", 2, BTreeMap::new()).await;
    assert_eq!(connected(&mut link).await.1, 2);
    drop(conn);
}

#[tokio::test]
async fn pings_the_cloud_and_answers_its_pings() {
    let cloud = Cloud::new().await;
    let (mut link, _key) = start(
        &cloud,
        FleetTiming {
            ping_every: Duration::from_millis(50),
            ..timing()
        },
    );
    let mut conn = cloud.accept().await;
    conn.handshake("dev_1", 1, BTreeMap::new()).await;
    connected(&mut link).await;
    conn.ws.send(Message::Ping("hi".into())).await.unwrap();
    let (mut ping, mut pong) = (false, false);
    while !(ping && pong) {
        match conn.frame().await.unwrap() {
            Message::Ping(_) => ping = true,
            Message::Pong(p) => pong = &p[..] == b"hi",
            _ => {}
        }
    }
}

#[tokio::test]
async fn close_ends_the_link() {
    let cloud = Cloud::new().await;
    let (mut link, _key) = start(&cloud, timing());
    let mut conn = cloud.accept().await;
    conn.handshake("dev_1", 1, BTreeMap::new()).await;
    connected(&mut link).await;
    link.commands.send(FleetCommand::Close).unwrap();
    ended(&mut link).await;
    assert!(matches!(conn.frame().await, Some(Message::Close(_)) | None));
    assert!(!cloud.redials(Duration::from_millis(300)).await);
}

#[tokio::test]
async fn dropping_the_commands_ends_the_link() {
    let cloud = Cloud::new().await;
    let (link, _key) = start(&cloud, timing());
    let mut conn = cloud.accept().await;
    conn.handshake("dev_1", 1, BTreeMap::new()).await;
    let FleetLink {
        commands,
        mut inbound,
    } = link;
    drop(commands);
    let mut link_events = vec![];
    while let Some(e) = timeout(WAIT, inbound.recv()).await.unwrap() {
        link_events.push(e);
    }
    assert!(link_events.len() <= 1, "{link_events:?}");
}

#[tokio::test]
async fn oversize_frames_are_not_sent_or_read() {
    let cloud = Cloud::new().await;
    let (mut link, _key) = start(&cloud, timing());
    let mut conn = cloud.accept().await;
    conn.handshake("dev_1", 1, BTreeMap::new()).await;
    connected(&mut link).await;

    let big = "x".repeat(MAX_FRAME_BYTES);
    send(&link, reply_with("big", serde_json::json!(big)));
    send(&link, presence());
    assert_eq!(conn.recv().await, presence());

    conn.send(&ServerMessage::Error {
        code: codes::INTERNAL.into(),
        message: big,
    })
    .await;
    conn.send(&devices()).await;
    assert!(matches!(
        next(&mut link).await,
        FleetInbound::Message(ServerMessage::Devices { .. })
    ));
}

/// The cloud's own refusal is a message for the core like any other, and
/// no reason to drop the socket.
#[tokio::test]
async fn a_refused_request_reaches_the_core_and_the_link_stays() {
    let cloud = Cloud::new().await;
    let (mut link, _key) = start(&cloud, timing());
    let mut conn = cloud.accept().await;
    conn.handshake("dev_1", 1, BTreeMap::new()).await;
    connected(&mut link).await;

    let refused = ServerMessage::Refused {
        req_id: "r9".into(),
        code: codes::OFFLINE.into(),
        message: "the target isn't connected".into(),
    };
    conn.send(&refused).await;
    match next(&mut link).await {
        FleetInbound::Message(m) => assert_eq!(m, refused),
        other => panic!("{other:?}"),
    }
    send(&link, presence());
    assert_eq!(conn.recv().await, presence());
}

#[tokio::test]
async fn http_off_loopback_is_refused() {
    let key = Arc::new(DeviceKey::generate().unwrap());
    let mut link = WsFleet::new().start(FleetConnect {
        cloud_url: "http://example.com".into(),
        access_token: "tok".into(),
        device_id: None,
        key,
        info: info("mac1"),
        spaces: vec![],
    });
    assert_eq!(fatal(&mut link).await, theodore_fleet::BAD_URL);
    ended(&mut link).await;
}
