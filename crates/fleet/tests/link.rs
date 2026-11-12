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
    PROTOCOL_VERSION, ReplyOutcome, ServerMessage, SpaceCursor, b64, codes, verify,
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
            verify(&public_key, &NONCE, &signature),
            "hello signs the nonce"
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

fn reply(req_id: &str) -> ClientMessage {
    ClientMessage::Reply {
        req_id: req_id.into(),
        outcome: ReplyOutcome::Ok {
            value: serde_json::json!({}),
        },
    }
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
    send(
        &link,
        ClientMessage::Reply {
            req_id: "big".into(),
            outcome: ReplyOutcome::Ok {
                value: serde_json::json!(big),
            },
        },
    );
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
