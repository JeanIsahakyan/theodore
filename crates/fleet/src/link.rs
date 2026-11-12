//! One link: the task that dials, handshakes, pumps frames and redials.

use std::collections::VecDeque;
use std::sync::Arc;

use futures::{SinkExt, StreamExt};
use theodore_fleet_protocol::{
    ClientMessage, DeviceInfo, DeviceKey, MAX_FRAME_BYTES, PROTOCOL_VERSION, ServerMessage,
    SpaceCursor, codes, unb64,
};
use theodore_ports::fleet::{FleetCommand, FleetConnect, FleetInbound};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::{Instant, MissedTickBehavior, sleep_until, timeout};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode, header};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};
use tracing::{debug, warn};
use url::Url;

use crate::{FleetTiming, OUTBOX_LIMIT};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Cloud error codes that end the link for good.
const FATAL_CODES: [&str; 4] = [
    codes::UNAUTHORIZED,
    codes::NO_ORG,
    codes::KEY_MISMATCH,
    codes::VERSION,
];
/// Close codes that end the link for good (unauthorized, forbidden).
const FATAL_CLOSE: [u16; 2] = [4001, 4003];
/// The socket refuses frames past this; anything over [`MAX_FRAME_BYTES`]
/// but under it is read and ignored, so one oversize frame doesn't cost the
/// connection.
const READ_LIMIT: usize = MAX_FRAME_BYTES * 4;

/// How a session (one socket) ended.
enum End {
    /// Close, or the core is gone: the task ends quietly.
    Stop,
    Fatal {
        code: String,
        message: String,
    },
    Lost(String),
}

pub(crate) struct Link {
    timing: FleetTiming,
    url: Url,
    tls: Option<Arc<rustls::ClientConfig>>,
    token: String,
    device_id: Option<String>,
    key: Arc<DeviceKey>,
    info: DeviceInfo,
    spaces: Vec<SpaceCursor>,
    outbox: VecDeque<ClientMessage>,
    /// Failed dials since the last welcome.
    attempt: u32,
    commands: mpsc::UnboundedReceiver<FleetCommand>,
    events: mpsc::UnboundedSender<FleetInbound>,
}

/// What a session tracks that the link doesn't.
struct Session {
    welcomed: bool,
    /// The token the cloud has (the dial's, then the last reauth).
    token: String,
    /// The info the cloud has (the hello's, then the last announce).
    info: Option<DeviceInfo>,
}

impl Link {
    pub(crate) fn new(
        timing: FleetTiming,
        url: Url,
        tls: Option<Arc<rustls::ClientConfig>>,
        cfg: FleetConnect,
        commands: mpsc::UnboundedReceiver<FleetCommand>,
        events: mpsc::UnboundedSender<FleetInbound>,
    ) -> Self {
        Link {
            timing,
            url,
            tls,
            token: cfg.access_token,
            device_id: cfg.device_id,
            key: cfg.key,
            info: cfg.info,
            spaces: cfg.spaces,
            outbox: VecDeque::new(),
            attempt: 0,
            commands,
            events,
        }
    }

    pub(crate) async fn run(mut self) {
        loop {
            match self.session().await {
                End::Stop => return,
                End::Fatal { code, message } => {
                    debug!(%code, "fleet: refused for good");
                    let _ = self.events.send(FleetInbound::Fatal { code, message });
                    return;
                }
                End::Lost(reason) => {
                    let delay = self.timing.backoff(self.attempt);
                    self.attempt = self.attempt.saturating_add(1);
                    debug!(%reason, retry_in_ms = delay.as_millis() as u64, "fleet: lost");
                    let gone = self
                        .events
                        .send(FleetInbound::Disconnected {
                            reason,
                            retry_in_ms: delay.as_millis() as u64,
                        })
                        .is_err();
                    if gone || self.wait(delay).await.is_err() {
                        return;
                    }
                }
            }
        }
    }

    /// Sleeps out the backoff, taking commands as an offline link does.
    async fn wait(&mut self, delay: std::time::Duration) -> Result<(), Stopped> {
        let until = Instant::now() + delay;
        loop {
            tokio::select! {
                biased;
                cmd = self.commands.recv() => self.offline(cmd)?,
                _ = sleep_until(until) => return Ok(()),
            }
        }
    }

    /// A command while there's no welcomed socket.
    fn offline(&mut self, cmd: Option<FleetCommand>) -> Result<(), Stopped> {
        match cmd {
            None | Some(FleetCommand::Close) => return Err(Stopped),
            Some(FleetCommand::Send(msg)) => self.queue(msg),
            Some(FleetCommand::Reauth(token)) => self.token = token,
            Some(FleetCommand::Update { info, spaces }) => {
                self.info = info;
                self.spaces = spaces;
            }
        }
        Ok(())
    }

    /// The outbox rule: only `reply` and `ask_resolved` wait for the next
    /// welcome; everything else belongs to a connection.
    fn queue(&mut self, msg: ClientMessage) {
        if !outboxed(&msg) {
            debug!(kind = kind(&msg), "fleet: offline, dropped");
            return;
        }
        if self.outbox.len() >= OUTBOX_LIMIT {
            let old = self.outbox.pop_front().map(|m| kind(&m));
            warn!(dropped = old, "fleet: outbox full, oldest dropped");
        }
        debug!(kind = kind(&msg), "fleet: offline, queued");
        self.outbox.push_back(msg);
    }

    async fn session(&mut self) -> End {
        // Before the dial: a reauth while it's under way changes self.token.
        let mut s = Session {
            welcomed: false,
            token: self.token.clone(),
            info: None,
        };
        let ws = match self.dial().await {
            Ok(ws) => ws,
            Err(end) => return end,
        };
        let end = self.pump(ws, &mut s).await;
        if let End::Lost(_) = end
            && s.welcomed
        {
            self.attempt = 0;
        }
        end
    }

    /// The upgrade, taking commands meanwhile so Close stays prompt.
    async fn dial(&mut self) -> Result<Ws, End> {
        let mut request = self
            .url
            .as_str()
            .into_client_request()
            .map_err(|e| End::Fatal {
                code: crate::BAD_URL.into(),
                message: e.to_string(),
            })?;
        let mut bearer =
            HeaderValue::from_str(&format!("Bearer {}", self.token)).map_err(|_| End::Fatal {
                code: codes::UNAUTHORIZED.into(),
                message: "the access token isn't a valid header".into(),
            })?;
        bearer.set_sensitive(true);
        let headers = request.headers_mut();
        headers.insert(header::AUTHORIZATION, bearer);
        // Cloudflare turns some default agents away.
        headers.insert(header::USER_AGENT, HeaderValue::from_static("theodore"));

        let config = WebSocketConfig::default()
            .max_message_size(Some(READ_LIMIT))
            .max_frame_size(Some(READ_LIMIT));
        let connector = match &self.tls {
            Some(tls) => Connector::Rustls(tls.clone()),
            None => Connector::Plain,
        };
        let connect = timeout(
            self.timing.silence,
            tokio_tungstenite::connect_async_tls_with_config(
                request,
                Some(config),
                false,
                Some(connector),
            ),
        );
        tokio::pin!(connect);
        let result = loop {
            tokio::select! {
                biased;
                cmd = self.commands.recv() => {
                    if self.offline(cmd).is_err() {
                        return Err(End::Stop);
                    }
                }
                r = &mut connect => break r,
            }
        };
        match result {
            Err(_) => Err(End::Lost("connect timed out".into())),
            Ok(Ok((ws, _))) => Ok(ws),
            Ok(Err(WsError::Http(resp))) => {
                let status = resp.status();
                if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
                    Err(End::Fatal {
                        code: codes::UNAUTHORIZED.into(),
                        message: format!("the cloud refused the connection ({status})"),
                    })
                } else {
                    Err(End::Lost(format!("the cloud answered {status}")))
                }
            }
            Ok(Err(e)) => Err(End::Lost(format!("connect failed: {e}"))),
        }
    }

    /// One socket from the first frame to its end.
    async fn pump(&mut self, mut ws: Ws, s: &mut Session) -> End {
        let mut last_frame = Instant::now();
        let mut ping = tokio::time::interval_at(
            Instant::now() + self.timing.ping_every,
            self.timing.ping_every,
        );
        ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut hello_sent = false;
        loop {
            let deadline = last_frame + self.timing.silence;
            tokio::select! {
                biased;
                cmd = self.commands.recv() => {
                    let Some(cmd) = cmd else { return close(ws).await };
                    if !s.welcomed {
                        if self.offline(Some(cmd)).is_err() {
                            return close(ws).await;
                        }
                        continue;
                    }
                    let msg = match cmd {
                        FleetCommand::Close => return close(ws).await,
                        FleetCommand::Send(msg) => msg,
                        FleetCommand::Reauth(token) => {
                            self.token = token.clone();
                            s.token = token.clone();
                            ClientMessage::Reauth { access_token: token }
                        }
                        FleetCommand::Update { info, spaces } => {
                            self.info = info.clone();
                            self.spaces = spaces;
                            s.info = Some(info.clone());
                            ClientMessage::Announce { info }
                        }
                    };
                    if let Err(end) = self.send(&mut ws, msg).await {
                        return end;
                    }
                }
                frame = ws.next() => {
                    last_frame = Instant::now();
                    let text = match frame {
                        None => return End::Lost("the socket closed".into()),
                        Some(Err(e)) => return End::Lost(format!("socket error: {e}")),
                        Some(Ok(Message::Text(text))) => text,
                        Some(Ok(Message::Ping(_))) => {
                            // tungstenite queued the pong; push it out now.
                            if let Err(e) = ws.flush().await {
                                return End::Lost(format!("socket error: {e}"));
                            }
                            continue;
                        }
                        Some(Ok(Message::Close(frame))) => return closed(frame),
                        Some(Ok(_)) => continue,
                    };
                    if text.len() > MAX_FRAME_BYTES {
                        warn!(bytes = text.len(), "fleet: oversize frame ignored");
                        continue;
                    }
                    let msg = match serde_json::from_str::<ServerMessage>(&text) {
                        Ok(msg) => msg,
                        Err(_) => {
                            debug!("fleet: unreadable frame ignored");
                            continue;
                        }
                    };
                    debug!(kind = server_kind(&msg), "fleet: received");
                    match msg {
                        ServerMessage::Error { code, message }
                            if FATAL_CODES.contains(&code.as_str()) =>
                        {
                            return End::Fatal { code, message };
                        }
                        ServerMessage::Error { code, message } if !s.welcomed => {
                            return End::Lost(format!("{code}: {message}"));
                        }
                        ServerMessage::Challenge { nonce } if !s.welcomed => {
                            let Some(bytes) = unb64(&nonce) else {
                                return End::Lost("the challenge isn't base64".into());
                            };
                            let hello = ClientMessage::Hello {
                                protocol: PROTOCOL_VERSION,
                                device_id: self.device_id.clone(),
                                public_key: self.key.public_key(),
                                signature: self.key.sign(&bytes),
                                info: self.info.clone(),
                                spaces: self.spaces.clone(),
                            };
                            s.info = Some(self.info.clone());
                            if let Err(end) = self.send(&mut ws, hello).await {
                                return end;
                            }
                            hello_sent = true;
                        }
                        ServerMessage::Welcome { device_id, generation, resume } if !s.welcomed => {
                            if !hello_sent {
                                return End::Lost("welcome before hello".into());
                            }
                            s.welcomed = true;
                            self.device_id = Some(device_id.clone());
                            let connected = FleetInbound::Connected { device_id, generation, resume };
                            if self.events.send(connected).is_err() {
                                return close(ws).await;
                            }
                            if let Err(end) = self.catch_up(&mut ws, s).await {
                                return end;
                            }
                        }
                        // Anything else before the welcome isn't for the core.
                        _ if !s.welcomed => {}
                        ServerMessage::Challenge { .. } | ServerMessage::Welcome { .. } => {
                            debug!("fleet: second handshake frame ignored");
                        }
                        msg => {
                            if self.events.send(FleetInbound::Message(msg)).is_err() {
                                return close(ws).await;
                            }
                        }
                    }
                }
                _ = ping.tick() => {
                    if let Err(e) = timeout(self.timing.silence, ws.send(Message::Ping(Default::default()))).await
                        .unwrap_or(Err(WsError::ConnectionClosed))
                    {
                        return End::Lost(format!("ping failed: {e}"));
                    }
                }
                _ = sleep_until(deadline) => {
                    return End::Lost(format!(
                        "no traffic for {} s",
                        self.timing.silence.as_secs_f64()
                    ));
                }
            }
        }
    }

    /// Right after the welcome: what changed during the handshake, then the
    /// outbox.
    async fn catch_up(&mut self, ws: &mut Ws, s: &mut Session) -> Result<(), End> {
        if s.token != self.token {
            s.token = self.token.clone();
            let reauth = ClientMessage::Reauth {
                access_token: self.token.clone(),
            };
            self.send(ws, reauth).await?;
        }
        if s.info.as_ref() != Some(&self.info) {
            s.info = Some(self.info.clone());
            let announce = ClientMessage::Announce {
                info: self.info.clone(),
            };
            self.send(ws, announce).await?;
        }
        while let Some(msg) = self.outbox.pop_front() {
            self.send(ws, msg).await?;
        }
        Ok(())
    }

    /// Sends one message. Oversize ─▶ dropped with a warning. A failed send
    /// ends the session; a reply or resolved ask goes back to the outbox.
    async fn send(&mut self, ws: &mut Ws, msg: ClientMessage) -> Result<(), End> {
        let kind = kind(&msg);
        let text = serde_json::to_string(&msg).expect("ClientMessage serializes");
        if text.len() > MAX_FRAME_BYTES {
            warn!(
                kind,
                bytes = text.len(),
                "fleet: frame over the limit, dropped"
            );
            return Ok(());
        }
        let sent = timeout(self.timing.silence, ws.send(Message::text(text)))
            .await
            .unwrap_or(Err(WsError::ConnectionClosed));
        match sent {
            Ok(()) => {
                debug!(kind, "fleet: sent");
                Ok(())
            }
            Err(e) => {
                if outboxed(&msg) {
                    self.outbox.push_front(msg);
                }
                Err(End::Lost(format!("send failed: {e}")))
            }
        }
    }
}

/// The core asked to stop (or is gone).
struct Stopped;

async fn close(mut ws: Ws) -> End {
    let _ = timeout(std::time::Duration::from_secs(1), ws.close(None)).await;
    End::Stop
}

fn closed(frame: Option<tokio_tungstenite::tungstenite::protocol::CloseFrame>) -> End {
    let Some(frame) = frame else {
        return End::Lost("closed by the cloud".into());
    };
    let code = u16::from(frame.code);
    let reason = frame.reason.to_string();
    if FATAL_CLOSE.contains(&code) {
        let code = if FATAL_CODES.contains(&reason.as_str()) {
            reason.clone()
        } else {
            codes::UNAUTHORIZED.to_string()
        };
        return End::Fatal {
            code,
            message: format!("closed by the cloud: {reason}"),
        };
    }
    if frame.code == CloseCode::Normal {
        return End::Lost("closed by the cloud".into());
    }
    End::Lost(format!("closed by the cloud ({code} {reason})"))
}

/// What waits for the next welcome instead of being dropped (FleetCommand::Send).
fn outboxed(msg: &ClientMessage) -> bool {
    matches!(
        msg,
        ClientMessage::Reply { .. } | ClientMessage::AskResolved { .. }
    )
}

fn kind(msg: &ClientMessage) -> &'static str {
    match msg {
        ClientMessage::Hello { .. } => "hello",
        ClientMessage::Reauth { .. } => "reauth",
        ClientMessage::Presence { .. } => "presence",
        ClientMessage::Announce { .. } => "announce",
        ClientMessage::Request { .. } => "request",
        ClientMessage::Claim { .. } => "claim",
        ClientMessage::Reply { .. } => "reply",
        ClientMessage::SpaceEvent { .. } => "space_event",
        ClientMessage::Ask { .. } => "ask",
        ClientMessage::AskResolved { .. } => "ask_resolved",
        ClientMessage::Subscribe { .. } => "subscribe",
        ClientMessage::Unsubscribe { .. } => "unsubscribe",
    }
}

fn server_kind(msg: &ServerMessage) -> &'static str {
    match msg {
        ServerMessage::Challenge { .. } => "challenge",
        ServerMessage::Welcome { .. } => "welcome",
        ServerMessage::Devices { .. } => "devices",
        ServerMessage::Request { .. } => "request",
        ServerMessage::ClaimResult { .. } => "claim_result",
        ServerMessage::Reply { .. } => "reply",
        ServerMessage::SpaceEvent { .. } => "space_event",
        ServerMessage::Ask { .. } => "ask",
        ServerMessage::Dismiss { .. } => "dismiss",
        ServerMessage::Error { .. } => "error",
    }
}
