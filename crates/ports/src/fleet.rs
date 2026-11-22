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

/// The cloud blob store (docs/fleet.md "Files (blobs)"): ciphertext chunks
/// under `/v1/fleet/blobs/{blob_id}/{i}`, Bearer = the account's access
/// token. The cloud never reads them; the core seals and opens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobAccess {
    /// The cloud's base URL (`https://…`), as the link dials it.
    pub cloud_url: String,
    pub access_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BlobStoreError {
    /// No blob store in this mode (fixtures, sandbox, tests by default).
    #[error("the blob store isn't available here")]
    Unavailable,
    /// `fleet.blob_not_found`: the chunk isn't there (fetched already, or
    /// expired).
    #[error("blob not found")]
    NotFound,
    /// `fleet.too_large`: the cloud refused the chunk's size.
    #[error("blob too large")]
    TooLarge,
    /// `fleet.quota`: the cloud's storage budget for this user.
    #[error("blob quota")]
    Quota,
    /// `fleet.unauthorized`: the token was refused.
    #[error("unauthorized")]
    Unauthorized,
    /// Anything else: a network error, a 5xx, an unreadable answer.
    #[error("blob store: {0}")]
    Other(String),
}

impl BlobStoreError {
    /// The stable code logged as `error.code` (docs/telemetry.md).
    pub fn code(&self) -> &'static str {
        match self {
            BlobStoreError::Unavailable => "fleet.unavailable",
            BlobStoreError::NotFound => "fleet.blob_not_found",
            BlobStoreError::TooLarge => "fleet.too_large",
            BlobStoreError::Quota => "fleet.quota",
            BlobStoreError::Unauthorized => "fleet.unauthorized",
            BlobStoreError::Other(_) => "fleet.blob_store",
        }
    }
}

#[async_trait::async_trait]
pub trait FleetPort: Send + Sync {
    /// `false`: no fleet in this mode (fixtures, sandbox, tests by default).
    fn enabled(&self) -> bool {
        true
    }

    /// Starts connecting in the background and returns at once.
    fn start(&self, cfg: FleetConnect) -> FleetLink;

    /// `PUT /v1/fleet/blobs/{blob_id}/{i}` with `chunk` as the body and
    /// `x-theodore-chunks: chunks`. `Unavailable` by default (fakes).
    async fn put_chunk(
        &self,
        access: &BlobAccess,
        blob_id: &str,
        i: u32,
        chunks: u32,
        chunk: Vec<u8>,
    ) -> Result<(), BlobStoreError> {
        let _ = (access, blob_id, i, chunks, chunk);
        Err(BlobStoreError::Unavailable)
    }

    /// `GET /v1/fleet/blobs/{blob_id}/{i}`: the chunk's bytes.
    async fn get_chunk(
        &self,
        access: &BlobAccess,
        blob_id: &str,
        i: u32,
    ) -> Result<Vec<u8>, BlobStoreError> {
        let _ = (access, blob_id, i);
        Err(BlobStoreError::Unavailable)
    }

    /// `DELETE /v1/fleet/blobs/{blob_id}`: every chunk of the blob.
    async fn delete_blob(&self, access: &BlobAccess, blob_id: &str) -> Result<(), BlobStoreError> {
        let _ = (access, blob_id);
        Err(BlobStoreError::Unavailable)
    }
}

/// No fleet: every link ends at once with `Fatal { code: "fleet.unavailable" }`.
pub struct NoFleet;

#[async_trait::async_trait]
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
