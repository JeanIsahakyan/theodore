//! Fleet connection (docs/fleet.md): the core hands an adapter what it needs
//! to dial the cloud and gets a link back — commands in, events out. The
//! adapter owns the socket: challenge/hello, reconnect with backoff,
//! heartbeat, reauth, and a small outbox; the core owns everything the
//! messages mean (trust, claims, spaces, journals).
//!
//! ```text
//! core ─FleetPort::start(FleetConnect)─▶ adapter ─WSS─▶ cloud
//!   │◀── FleetInbound: Connected{device_id, generation, resume} | Message | Disconnected | Fatal
//!   └──▶ FleetCommand: Send(msg) | Reauth(token) | Update{info, spaces} | Close
//! ```

use std::collections::BTreeMap;
use std::sync::Arc;

use theodore_fleet_protocol::{ClientMessage, DeviceInfo, DeviceKey, ServerMessage, SpaceCursor};
use tokio::sync::mpsc;

/// Everything the adapter needs to connect, and to reconnect without asking.
pub struct FleetConnect {
    /// The cloud's base URL (`https://…`); the adapter dials
    /// `wss://…/v1/fleet/ws` (`ws://` for an `http://` loopback cloud).
    pub cloud_url: String,
    /// The account's current access token (it must carry `org_id`).
    /// Replaced with [`FleetCommand::Reauth`] after every refresh.
    pub access_token: String,
    /// The cloud-assigned id from an earlier welcome; `None` on first use.
    pub device_id: Option<String>,
    /// Signs the cloud's challenge nonce.
    pub key: Arc<DeviceKey>,
    pub info: DeviceInfo,
    /// Spaces this device hosts, with their last journaled seq.
    pub spaces: Vec<SpaceCursor>,
}

pub enum FleetCommand {
    /// Sent now if connected. While disconnected, `reply` and `ask_resolved`
    /// wait in the outbox (sent after the next welcome); anything else is
    /// dropped — claims belong to a connection, events replay from the
    /// core's journal, and requests are refused by the core itself while
    /// offline.
    Send(ClientMessage),
    /// A fresh access token: sent as `reauth` now, and used for the next dial.
    Reauth(String),
    /// New info / hosted spaces: sent as `announce` now, and used in the next
    /// `hello`.
    Update {
        info: DeviceInfo,
        spaces: Vec<SpaceCursor>,
    },
    /// Close the socket and stop redialing; the link ends.
    Close,
}

#[derive(Debug)]
pub enum FleetInbound {
    /// A hello was accepted. `resume`: space → last seq the cloud has.
    Connected {
        device_id: String,
        generation: u64,
        resume: BTreeMap<String, u64>,
    },
    /// Any server message after the welcome (the challenge and the welcome
    /// themselves are the adapter's).
    Message(ServerMessage),
    /// The socket went away; the adapter redials after `retry_in_ms`.
    Disconnected { reason: String, retry_in_ms: u64 },
    /// The cloud refused this device for good (`fleet.unauthorized`,
    /// `fleet.no_org`, `fleet.key_mismatch`, `fleet.version`): no redial
    /// until the core starts a new link (e.g. after the next sign-in).
    Fatal { code: String, message: String },
}

pub struct FleetLink {
    pub commands: mpsc::UnboundedSender<FleetCommand>,
    pub inbound: mpsc::UnboundedReceiver<FleetInbound>,
}

pub trait FleetPort: Send + Sync {
    /// `false`: no fleet in this mode (fixtures, sandbox, tests by default).
    fn enabled(&self) -> bool {
        true
    }

    /// Starts connecting in the background and returns at once.
    fn start(&self, cfg: FleetConnect) -> FleetLink;
}

/// No fleet: every link ends at once with `Fatal { code: "fleet.unavailable" }`.
pub struct NoFleet;

impl FleetPort for NoFleet {
    fn enabled(&self) -> bool {
        false
    }

    fn start(&self, _cfg: FleetConnect) -> FleetLink {
        let (commands, _rx) = mpsc::unbounded_channel();
        let (tx, inbound) = mpsc::unbounded_channel();
        let _ = tx.send(FleetInbound::Fatal {
            code: "fleet.unavailable".into(),
            message: "no fleet in this mode".into(),
        });
        FleetLink { commands, inbound }
    }
}
