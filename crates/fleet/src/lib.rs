//! The fleet link over a WebSocket (docs/fleet.md "Connect"): [`WsFleet`]
//! implements the [`FleetPort`]. One tokio task per link owns the socket;
//! the core only sees commands in and events out.
//!
//! ```text
//! start ─▶ task ─dial─▶ GET wss://<cloud>/v1/fleet/ws  (Bearer token, UA theodore)
//!             │           401/403 ─▶ Fatal fleet.unauthorized
//!             ◀── challenge{nonce}
//!             ──▶ hello{protocol, device_id?, public_key, sign_hello(nonce), info, spaces}
//!                 (only a 32-byte nonce, one challenge per socket: else drop, redial)
//!             ◀── welcome ─▶ Connected{device_id, generation, resume}
//!             ──▶ reauth / announce if they changed during the handshake
//!             ──▶ outbox (reply, ask_resolved)
//!             ◀─▶ Message ⇄ Send, ping every 15 s
//!             │
//!   lost ─────┤ socket error | close | 45 s without a frame
//!             └─▶ Disconnected{reason, retry_in_ms} ─▶ wait ─▶ dial
//!                 (0.5 s doubling to 30 s, ±25 %, reset by a welcome)
//!   fatal ────▶ error{fleet.unauthorized|no_org|key_mismatch|version|too_many_devices|removed}
//!               | close 4001/4003 ─▶ Fatal, the task ends
//!   Close, or the core drops the command sender ─▶ the task ends
//! ```
//!
//! Logs carry message types only: never tokens, signatures or bodies.

mod link;

use std::net::IpAddr;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use theodore_fleet_protocol::codes;
use theodore_ports::fleet::{FleetConnect, FleetInbound, FleetLink, FleetPort};
use tokio::sync::mpsc;
use url::{Host, Url};

/// The `Fatal` code for a cloud URL the link can't dial (not https, or http
/// off loopback).
pub const BAD_URL: &str = codes::BAD_URL;
/// The `Fatal` code when no TLS client could be built.
pub const NO_TLS: &str = codes::TLS;
/// Replies and resolved asks kept while offline; the oldest goes first.
pub const OUTBOX_LIMIT: usize = 1000;

/// The link's clocks; [`FleetTiming::default`] is the spec's.
#[derive(Debug, Clone)]
pub struct FleetTiming {
    /// First redial delay; doubles per failed attempt.
    pub backoff_min: Duration,
    pub backoff_max: Duration,
    /// How often the device pings the cloud.
    pub ping_every: Duration,
    /// No frame at all for this long ─▶ drop the socket and redial. Also
    /// bounds the dial and every send.
    pub silence: Duration,
}

impl Default for FleetTiming {
    fn default() -> Self {
        FleetTiming {
            backoff_min: Duration::from_millis(500),
            backoff_max: Duration::from_secs(30),
            ping_every: Duration::from_secs(15),
            silence: Duration::from_secs(45),
        }
    }
}

impl FleetTiming {
    /// The delay before redial number `attempt` (0-based): `backoff_min ·
    /// 2^attempt`, capped at `backoff_max`, then ±25 % jitter.
    pub fn backoff(&self, attempt: u32) -> Duration {
        let base = self
            .backoff_min
            .saturating_mul(2u32.saturating_pow(attempt.min(31)))
            .min(self.backoff_max);
        base.mul_f64(0.75 + fastrand::f64() * 0.5)
    }
}

/// The fleet over a WebSocket to the Theodore cloud.
pub struct WsFleet {
    timing: FleetTiming,
    tls: OnceLock<Result<Arc<rustls::ClientConfig>, String>>,
}

impl Default for WsFleet {
    fn default() -> Self {
        Self::new()
    }
}

impl WsFleet {
    pub fn new() -> Self {
        Self::with_timing(FleetTiming::default())
    }

    pub fn with_timing(timing: FleetTiming) -> Self {
        WsFleet {
            timing,
            tls: OnceLock::new(),
        }
    }

    /// rustls on aws-lc-rs with the OS verifier, as reqwest builds it; once
    /// per adapter.
    fn tls(&self) -> Result<Arc<rustls::ClientConfig>, String> {
        self.tls
            .get_or_init(|| {
                use rustls_platform_verifier::BuilderVerifierExt;
                let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
                rustls::ClientConfig::builder_with_provider(provider)
                    .with_safe_default_protocol_versions()
                    .and_then(|b| b.with_platform_verifier())
                    .map(|b| Arc::new(b.with_no_client_auth()))
                    .map_err(|e| e.to_string())
            })
            .clone()
    }
}

impl FleetPort for WsFleet {
    /// Must be called inside a tokio runtime: the link is a spawned task.
    fn start(&self, cfg: FleetConnect) -> FleetLink {
        let (commands, commands_rx) = mpsc::unbounded_channel();
        let (events, inbound) = mpsc::unbounded_channel();
        let fatal = |code: &str, message: String| {
            let _ = events.send(FleetInbound::Fatal {
                code: code.into(),
                message,
            });
        };
        match ws_url(&cfg.cloud_url) {
            Err(message) => fatal(BAD_URL, message),
            Ok(url) => {
                let tls = if url.scheme() == "wss" {
                    match self.tls() {
                        Ok(tls) => Some(tls),
                        Err(e) => {
                            fatal(NO_TLS, format!("no TLS client: {e}"));
                            return FleetLink { commands, inbound };
                        }
                    }
                } else {
                    None
                };
                let task = link::Link::new(
                    self.timing.clone(),
                    url,
                    tls,
                    cfg,
                    commands_rx,
                    events.clone(),
                );
                tokio::spawn(task.run());
            }
        }
        FleetLink { commands, inbound }
    }
}

/// `https://…` ─▶ `wss://…/v1/fleet/ws`; `http://` only on loopback ─▶ `ws://`.
/// A base path on the cloud URL is kept.
pub fn ws_url(cloud_url: &str) -> Result<Url, String> {
    let mut url =
        Url::parse(cloud_url.trim()).map_err(|e| format!("cloud URL isn't a URL: {e}"))?;
    let scheme = match url.scheme() {
        "https" => "wss",
        "http" if is_loopback(url.host()) => "ws",
        "http" => return Err("cloud URL must be https off loopback".into()),
        other => return Err(format!("cloud URL scheme {other} isn't http(s)")),
    };
    url.set_scheme(scheme)
        .map_err(|()| "cloud URL scheme can't change".to_string())?;
    let base = url.path().trim_end_matches('/').to_string();
    url.set_path(&format!("{base}/v1/fleet/ws"));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn is_loopback(host: Option<Host<&str>>) -> bool {
    match host {
        Some(Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => IpAddr::V4(ip).is_loopback(),
        Some(Host::Ipv6(ip)) => IpAddr::V6(ip).is_loopback(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_becomes_wss_with_the_path() {
        let u = ws_url("https://cloud.theodore.dev").unwrap();
        assert_eq!(u.as_str(), "wss://cloud.theodore.dev/v1/fleet/ws");
        let u = ws_url("https://example.com/base/?x=1").unwrap();
        assert_eq!(u.as_str(), "wss://example.com/base/v1/fleet/ws");
    }

    #[test]
    fn http_only_on_loopback() {
        for ok in [
            "http://127.0.0.1:8787",
            "http://localhost:8787/",
            "http://[::1]:1",
        ] {
            assert_eq!(ws_url(ok).unwrap().scheme(), "ws", "{ok}");
        }
        for bad in ["http://example.com", "ftp://127.0.0.1", "not a url"] {
            assert!(ws_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn tls_client_builds_without_a_process_provider() {
        assert!(WsFleet::new().tls().is_ok());
    }

    #[test]
    fn backoff_doubles_to_the_cap_with_jitter() {
        let t = FleetTiming::default();
        for (attempt, base_ms) in [(0, 500.0), (1, 1000.0), (2, 2000.0), (6, 30000.0)] {
            for _ in 0..50 {
                let ms = t.backoff(attempt).as_secs_f64() * 1000.0;
                assert!(
                    ms >= base_ms * 0.75 - 1.0 && ms <= base_ms * 1.25 + 1.0,
                    "attempt {attempt}: {ms}"
                );
            }
        }
        assert!(t.backoff(u32::MAX) <= Duration::from_millis(37_501));
    }
}
