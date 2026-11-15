//! Fleet wire protocol (docs/fleet.md): what a device and the cloud's
//! `OrgHub` say to each other over one WebSocket, as JSON text frames tagged
//! by `type`. The Rust types are the source of truth; the Worker's TS comes
//! from `cargo run -p theodore-fleet-protocol --bin export-ts`.
//!
//! ```text
//! device ─▶ cloud   ClientMessage   hello, reauth, presence, announce, request,
//!                                   claim, reply, space_event, ask, ask_resolved,
//!                                   subscribe, unsubscribe
//! cloud  ─▶ device  ServerMessage   challenge, welcome, devices, request,
//!                                   claim_result, reply, space_event, ask,
//!                                   dismiss, error
//! ```
//!
//! Requests are signed by the origin device ([`SignedEnvelope`]); the cloud
//! routes them but can't forge or alter one (docs/fleet.md "Trust").

use std::collections::BTreeMap;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde::{Deserialize, Serialize};
use specta::Type;

pub mod keys;

pub use keys::{DeviceKey, KeyError, fingerprint, verify};

/// Protocol version sent in `hello`; the cloud refuses others with
/// `fleet.version`.
pub const PROTOCOL_VERSION: u32 = 3;
/// A signed request older or newer than this is refused (`fleet.stale_request`).
pub const REQUEST_WINDOW_MS: u64 = 5 * 60 * 1000;
/// How long a target remembers `req_id`s to refuse replays.
pub const REPLAY_MEMORY_MS: u64 = 10 * 60 * 1000;
/// Deepest a space started by another space may sit (root = 0).
pub const MAX_DEPTH: u32 = 2;
/// Most spaces one space may start.
pub const MAX_CHILDREN: u32 = 5;
/// Events a hosting device keeps per space for replay.
pub const DEVICE_JOURNAL: usize = 2000;
/// Events the cloud keeps per space for late subscribers.
pub const CLOUD_RING: usize = 500;
/// Largest frame either side accepts.
pub const MAX_FRAME_BYTES: usize = 256 * 1024;

// ── identities ───────────────────────────────────────────────────────────────

/// Assigned by the cloud on first hello (`dev_<uuid>`).
pub type DeviceId = String;
/// Assigned by the origin core when it asks to start a space (`rs_<uuid>`),
/// so it can track the space before the reply. The hosting device maps it to
/// its local space id.
pub type RemoteSpaceId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DeviceOs {
    Macos,
    Linux,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKind {
    /// The desktop app: runs spaces and is where a person sits.
    Desktop,
    /// `theodore daemon`: runs spaces, nobody sits there.
    Daemon,
}

/// A space mode as the fleet speaks it; ordered from least to most power,
/// so a cap is a comparison (`mode <= max_mode`). Plan sits between Ask and
/// Edit: it explores and edits nothing, but its approval leads to an Edit
/// turn.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Type,
)]
#[serde(rename_all = "snake_case")]
pub enum FleetMode {
    Ask,
    Plan,
    Edit,
    Run,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ProjectRef {
    /// The project's id on that device.
    pub id: String,
    pub name: String,
}

/// What a device says about itself (in `hello` and `announce`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DeviceInfo {
    pub name: String,
    pub os: DeviceOs,
    pub kind: DeviceKind,
    pub app_version: String,
    /// Projects a remote request may start a space in. Empty unless
    /// `accepts_remote`.
    pub projects: Vec<ProjectRef>,
    pub accepts_remote: bool,
    pub max_mode: FleetMode,
}

/// A device as the cloud lists it to the user's other devices.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DeviceSummary {
    pub device_id: DeviceId,
    pub info: DeviceInfo,
    pub online: bool,
    /// Unix ms; 0 if never.
    pub last_seen_ms: u64,
    /// Base64 ed25519 public key, for trust pinning (show its
    /// [`fingerprint`]).
    pub public_key: String,
}

/// The last event a device has journaled for a space it hosts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SpaceCursor {
    pub space: RemoteSpaceId,
    pub seq: u64,
}

// ── signed requests ─────────────────────────────────────────────────────────

/// A request body signed by its origin device. `body` is the JSON text of a
/// [`RemoteRequest`], kept as text so the bytes signed are the bytes
/// verified: the cloud reads it to route, never re-serializes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SignedEnvelope {
    pub device_id: DeviceId,
    pub body: String,
    /// Base64 ed25519 signature over `body`'s UTF-8 bytes.
    pub signature: String,
}

/// What one device asks of another. Every field the target acts on is in
/// here, under the signature.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RemoteRequest {
    /// Unique per request (uuid); the target refuses one it has seen.
    pub req_id: String,
    pub origin_device: DeviceId,
    pub target_device: DeviceId,
    /// The target's public key as pinned on the origin. The target runs a
    /// request only if this is its own key: the cloud assigns device ids,
    /// so an id alone can't say which machine a request was signed for.
    pub target_key: String,
    /// Unix ms at the origin.
    pub issued_at_ms: u64,
    pub op: RemoteOp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum RemoteOp {
    StartSpace {
        space: RemoteSpaceId,
        project_id: String,
        goal: String,
        mode: FleetMode,
        #[serde(default)]
        agent: Option<String>,
        #[serde(default)]
        model: Option<String>,
        /// The remote space whose agent asked for this one, if any.
        #[serde(default)]
        parent: Option<RemoteSpaceId>,
        /// 0 for a space a person started.
        depth: u32,
    },
    Send {
        space: RemoteSpaceId,
        text: String,
        #[serde(default)]
        mode: Option<FleetMode>,
    },
    Stop {
        space: RemoteSpaceId,
    },
    /// Answers the question set `ask_id` of `space`: one entry per question,
    /// the chosen options (several when the question allows), or a free
    /// text as the single entry for "Other".
    Answer {
        space: RemoteSpaceId,
        ask_id: String,
        answers: Vec<Vec<String>>,
    },
}

impl RemoteOp {
    pub fn space(&self) -> &str {
        match self {
            RemoteOp::StartSpace { space, .. }
            | RemoteOp::Send { space, .. }
            | RemoteOp::Stop { space }
            | RemoteOp::Answer { space, .. } => space,
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum EnvelopeError {
    #[error("bad signature")]
    BadSignature,
    #[error("malformed body: {0}")]
    Malformed(String),
    #[error("envelope device {envelope} doesn't match the body's signer {body}")]
    OriginMismatch { envelope: String, body: String },
}

/// What a signature is for. Each kind signs `"theodore-fleet-<kind>-v3\0" ‖
/// bytes`, so a signature made for one purpose never verifies as another
/// (a hello nonce can't be turned into a request).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Domain {
    /// The cloud's challenge nonce, in `hello`.
    Hello,
    /// A [`RemoteRequest`].
    Request,
    /// A [`SpaceEventBody`] from the space's host.
    Event,
    /// A [`RemoteAsk`] from the space's host.
    Ask,
    /// A [`ReplyBody`] from a request's target.
    Reply,
}

impl Domain {
    pub fn tag(self) -> &'static [u8] {
        match self {
            Domain::Hello => b"theodore-fleet-hello-v3\0",
            Domain::Request => b"theodore-fleet-request-v3\0",
            Domain::Event => b"theodore-fleet-event-v3\0",
            Domain::Ask => b"theodore-fleet-ask-v3\0",
            Domain::Reply => b"theodore-fleet-reply-v3\0",
        }
    }

    /// The exact bytes signed for `msg` in this domain.
    pub fn message(self, msg: &[u8]) -> Vec<u8> {
        let mut m = Vec::with_capacity(self.tag().len() + msg.len());
        m.extend_from_slice(self.tag());
        m.extend_from_slice(msg);
        m
    }
}

/// Length of the cloud's challenge nonce; a hello signs nothing else.
pub const NONCE_BYTES: usize = 32;

/// Signs a challenge nonce for `hello`: `None` unless it is exactly
/// [`NONCE_BYTES`] of base64, so the cloud can't get anything else signed.
pub fn sign_hello(key: &DeviceKey, nonce_b64: &str) -> Option<String> {
    let nonce = unb64(nonce_b64)?;
    (nonce.len() == NONCE_BYTES).then(|| key.sign(&Domain::Hello.message(&nonce)))
}

pub fn verify_hello(public_key: &str, nonce: &[u8], signature: &str) -> bool {
    nonce.len() == NONCE_BYTES && verify(public_key, &Domain::Hello.message(nonce), signature)
}

/// A body type that names the device that signed it.
pub trait Signer {
    fn signer(&self) -> &str;
}

impl Signer for RemoteRequest {
    fn signer(&self) -> &str {
        &self.origin_device
    }
}

impl Signer for SpaceEventBody {
    fn signer(&self) -> &str {
        &self.host_device
    }
}

impl Signer for ReplyBody {
    fn signer(&self) -> &str {
        &self.target_device
    }
}

impl Signer for RemoteAsk {
    fn signer(&self) -> &str {
        &self.host_device
    }
}

impl SignedEnvelope {
    /// Serializes `body` and signs it for `domain` with its signer's key.
    pub fn seal_as<T: Serialize + Signer>(body: &T, key: &DeviceKey, domain: Domain) -> Self {
        let text = serde_json::to_string(body).expect("fleet bodies serialize");
        let signature = key.sign(&domain.message(text.as_bytes()));
        SignedEnvelope {
            device_id: body.signer().to_string(),
            body: text,
            signature,
        }
    }

    /// Reads the body without checking the signature: for routing only.
    pub fn peek_as<T: for<'de> Deserialize<'de>>(&self) -> Result<T, EnvelopeError> {
        serde_json::from_str(&self.body).map_err(|e| EnvelopeError::Malformed(e.to_string()))
    }

    /// Checks the signature for `domain` against `public_key` (the signer's,
    /// as pinned by the verifier) and that the body names the same signer.
    pub fn open_as<T: for<'de> Deserialize<'de> + Signer>(
        &self,
        public_key: &str,
        domain: Domain,
    ) -> Result<T, EnvelopeError> {
        if !verify(
            public_key,
            &domain.message(self.body.as_bytes()),
            &self.signature,
        ) {
            return Err(EnvelopeError::BadSignature);
        }
        let body: T = self.peek_as()?;
        if body.signer() != self.device_id {
            return Err(EnvelopeError::OriginMismatch {
                envelope: self.device_id.clone(),
                body: body.signer().to_string(),
            });
        }
        Ok(body)
    }

    /// A request, signed by its origin.
    pub fn seal(req: &RemoteRequest, key: &DeviceKey) -> Self {
        Self::seal_as(req, key, Domain::Request)
    }

    pub fn peek(&self) -> Result<RemoteRequest, EnvelopeError> {
        self.peek_as()
    }

    pub fn open(&self, public_key: &str) -> Result<RemoteRequest, EnvelopeError> {
        self.open_as(public_key, Domain::Request)
    }
}

/// Whether `issued_at_ms` is within [`REQUEST_WINDOW_MS`] of `now_ms`.
pub fn fresh(issued_at_ms: u64, now_ms: u64) -> bool {
    issued_at_ms.abs_diff(now_ms) <= REQUEST_WINDOW_MS
}

// ── replies ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ReplyOutcome {
    Ok {
        #[specta(type = specta_typescript::Unknown)]
        value: serde_json::Value,
    },
    Err {
        code: String,
        message: String,
    },
}

/// A target's answer to a request, signed by the target
/// ([`Domain::Reply`]). Only a verified one may change what the origin shows
/// or tells an agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ReplyBody {
    pub req_id: String,
    pub origin_device: DeviceId,
    pub target_device: DeviceId,
    pub outcome: ReplyOutcome,
}

/// `reply.value` for a `start_space`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct StartedSpace {
    pub space: RemoteSpaceId,
    /// The space's name on the hosting device.
    pub name: String,
    pub branch: String,
}

/// Refusal codes (docs/fleet.md).
pub mod codes {
    pub const REMOTE_OFF: &str = "fleet.remote_off";
    pub const UNTRUSTED_DEVICE: &str = "fleet.untrusted_device";
    pub const BAD_SIGNATURE: &str = "fleet.bad_signature";
    pub const STALE_REQUEST: &str = "fleet.stale_request";
    pub const MODE_NOT_ALLOWED: &str = "fleet.mode_not_allowed";
    pub const UNKNOWN_PROJECT: &str = "fleet.unknown_project";
    pub const UNKNOWN_SPACE: &str = "fleet.unknown_space";
    pub const DEPTH: &str = "fleet.depth";
    /// The request doesn't fit what it acts on (answers that don't answer
    /// the question set, an empty message).
    pub const INVALID: &str = "fleet.invalid";
    pub const OFFLINE: &str = "fleet.offline";
    pub const BUSY: &str = "fleet.busy";
    pub const INTERNAL: &str = "fleet.internal";
    // the cloud's own
    pub const UNAUTHORIZED: &str = "fleet.unauthorized";
    pub const NO_ORG: &str = "fleet.no_org";
    pub const VERSION: &str = "fleet.version";
    pub const KEY_MISMATCH: &str = "fleet.key_mismatch";
    pub const TOO_LARGE: &str = "fleet.too_large";
    pub const RATE_LIMITED: &str = "fleet.rate_limited";
    pub const NOT_YOURS: &str = "fleet.not_yours";
    pub const BAD_MESSAGE: &str = "fleet.bad_message";
    pub const TOO_MANY_DEVICES: &str = "fleet.too_many_devices";
    /// Another of the user's devices removed this one (close 4003): it
    /// joins again only as a new device.
    pub const REMOVED: &str = "fleet.removed";
    /// Too many spaces for this user (close 1008, redial).
    pub const TOO_MANY_SPACES: &str = "fleet.too_many_spaces";
    /// Too many open connections for this user (close 1008, redial).
    pub const TOO_MANY_CONNECTIONS: &str = "fleet.too_many_connections";
    pub const UPGRADE_REQUIRED: &str = "fleet.upgrade_required";
    /// The cloud couldn't check the token (its signing keys unreachable):
    /// close 1011, redial with backoff. Never fatal.
    pub const UNAVAILABLE: &str = "fleet.unavailable";
    // the device adapter's own
    pub const BAD_URL: &str = "fleet.bad_url";
    pub const TLS: &str = "fleet.tls";
}

// ── space events ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RemoteSpaceStatus {
    Running,
    /// Settled, waiting for the next message.
    Idle,
    /// A question waits for an answer.
    Waiting,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TurnOutcome {
    Done,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RemoteQuestion {
    pub question: String,
    pub options: Vec<String>,
    pub multi: bool,
}

/// What a hosting device reports about a space it runs for the fleet. Short
/// by design: the full transcript stays on the host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RemoteSpaceEvent {
    Started {
        host_device: DeviceId,
        origin_device: DeviceId,
        project_id: String,
        project_name: String,
        name: String,
        branch: String,
        mode: FleetMode,
        #[serde(default)]
        parent: Option<RemoteSpaceId>,
        depth: u32,
    },
    Status {
        status: RemoteSpaceStatus,
    },
    TurnStarted {
        turn: u32,
        /// The message that started it, truncated to 2000 chars.
        text: String,
    },
    Tool {
        turn: u32,
        name: String,
        /// One line, ≤ 200 chars.
        summary: String,
    },
    Reply {
        turn: u32,
        /// The agent's reply for the turn, truncated to 8000 chars.
        text: String,
    },
    TurnEnded {
        turn: u32,
        outcome: TurnOutcome,
        #[serde(default)]
        message: Option<String>,
    },
    Question {
        ask_id: String,
        questions: Vec<RemoteQuestion>,
    },
    QuestionCleared {
        ask_id: String,
    },
}

/// One event of a hosted space, as its host signs it ([`Domain::Event`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SpaceEventBody {
    pub space: RemoteSpaceId,
    pub seq: u64,
    pub host_device: DeviceId,
    pub event: RemoteSpaceEvent,
}

// ── questions routed to the user ────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RemoteAsk {
    pub ask_id: String,
    pub space: RemoteSpaceId,
    pub host_device: DeviceId,
    /// Where the question comes from, for people: "<device> · <space name>".
    pub from: String,
    pub questions: Vec<RemoteQuestion>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AskVia {
    /// The device you're at (focused, recent input).
    Active,
    /// Nobody active: where the space was started from.
    Origin,
    /// Unanswered for a while, or nowhere to send: every device.
    Escalated,
    /// You moved to another device; it followed you.
    Moved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DismissReason {
    AnsweredElsewhere,
    Moved,
    Resolved,
}

// ── messages ────────────────────────────────────────────────────────────────

/// Device ⇄ cloud, device side.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Hello {
        protocol: u32,
        #[serde(default)]
        device_id: Option<DeviceId>,
        /// Base64 ed25519 public key.
        public_key: String,
        /// Base64 signature over the challenge nonce's raw bytes.
        signature: String,
        info: DeviceInfo,
        /// Spaces this device hosts, with their last journaled seq.
        spaces: Vec<SpaceCursor>,
    },
    /// A fresh access token after the account refreshed.
    Reauth {
        access_token: String,
    },
    Presence {
        focused: bool,
        locked: bool,
        /// Ms since the last input in this app.
        idle_ms: u64,
    },
    /// The device's info changed (projects, settings).
    Announce {
        info: DeviceInfo,
    },
    Request {
        envelope: SignedEnvelope,
    },
    Claim {
        req_id: String,
        generation: u64,
    },
    /// A [`ReplyBody`] signed by this device as the request's target.
    Reply {
        envelope: SignedEnvelope,
    },
    /// A [`SpaceEventBody`] signed by this device as the space's host.
    SpaceEvent {
        envelope: SignedEnvelope,
    },
    /// A [`RemoteAsk`] signed by this device as the space's host.
    Ask {
        envelope: SignedEnvelope,
    },
    /// The question was answered on the host or the turn moved on.
    AskResolved {
        ask_id: String,
    },
    Subscribe {
        space: RemoteSpaceId,
        since: u64,
    },
    Unsubscribe {
        space: RemoteSpaceId,
    },
    /// Forget one of this user's other devices (lost, replaced). The cloud
    /// drops its row and closes its socket; it can register again only as
    /// a new device.
    RemoveDevice {
        device_id: DeviceId,
    },
}

/// Device ⇄ cloud, cloud side.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    /// First frame after the upgrade: sign `nonce` (base64 of 32 random bytes).
    Challenge {
        nonce: String,
    },
    Welcome {
        device_id: DeviceId,
        /// Bumps on every accepted hello; fences claims of old connections.
        generation: u64,
        /// Space → last seq the cloud has; replay what's after it.
        resume: BTreeMap<RemoteSpaceId, u64>,
    },
    /// The user's devices in this org (this one included), sent on welcome
    /// and whenever one changes.
    Devices {
        devices: Vec<DeviceSummary>,
    },
    /// A request for this device to verify, claim and run.
    Request {
        envelope: SignedEnvelope,
        generation: u64,
    },
    ClaimResult {
        req_id: String,
        claimed: bool,
        #[serde(default)]
        rejection: Option<String>,
    },
    /// The target's signed [`ReplyBody`] to a request this device sent,
    /// forwarded unchanged.
    Reply {
        envelope: SignedEnvelope,
    },
    /// The cloud couldn't deliver or route a request (`fleet.offline`,
    /// `fleet.not_yours`, `fleet.depth`, …). Unsigned: the origin shows the
    /// code, never hands `message` to an agent.
    Refused {
        req_id: String,
        code: String,
        message: String,
    },
    /// A host's signed [`SpaceEventBody`], forwarded unchanged.
    SpaceEvent {
        envelope: SignedEnvelope,
    },
    /// The cloud no longer has events `from..=to` of `space` (unsigned,
    /// informational: never trusted for content).
    SpaceGap {
        space: RemoteSpaceId,
        from: u64,
        to: u64,
    },
    /// A host's signed [`RemoteAsk`], forwarded unchanged.
    Ask {
        envelope: SignedEnvelope,
        via: AskVia,
    },
    Dismiss {
        ask_id: String,
        reason: DismissReason,
    },
    Error {
        code: String,
        message: String,
    },
}

/// Every type the Worker needs, for the TS export.
pub fn types() -> specta::Types {
    let t = specta::Types::default()
        .register::<ClientMessage>()
        .register::<ServerMessage>()
        .register::<RemoteRequest>()
        .register::<SpaceEventBody>()
        .register::<ReplyBody>()
        .register::<RemoteAsk>()
        .register::<StartedSpace>();
    // JS numbers: seqs, generations and unix-ms timestamps stay far below
    // 2^53 (same call as the contract crate).
    use specta::datatype::Primitive as P;
    specta_util::Remapper::new()
        .rule(P::i64.into(), P::i32.into())
        .rule(P::u64.into(), P::u32.into())
        .rule(P::usize.into(), P::u32.into())
        .remap_types(t)
}

/// Base64 (standard, padded): how keys and signatures travel.
pub fn b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

pub fn unb64(s: &str) -> Option<Vec<u8>> {
    B64.decode(s).ok()
}

#[cfg(test)]
mod tests;
