//! Fleet wire protocol (docs/fleet.md): what a device and the cloud's
//! `OrgHub` say to each other over one WebSocket, as JSON text frames tagged
//! by `type`. The Rust types are the source of truth; the Worker's TS comes
//! from `cargo run -p theodore-fleet-protocol --bin export-ts`.
//!
//! ```text
//! device ─▶ cloud   ClientMessage   hello, reauth, presence, announce, request,
//!                                   claim, reply, space_event, ask, ask_resolved,
//!                                   subscribe, unsubscribe, confirm,
//!                                   confirm_resolved
//! cloud  ─▶ device  ServerMessage   challenge, welcome, devices, request,
//!                                   claim_result, reply, space_event, ask,
//!                                   dismiss, error, confirm, confirm_dismissed
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
pub const PROTOCOL_VERSION: u32 = 7;
/// The oldest protocol the cloud still accepts (it hides `mobile` / `web`
/// devices from protocol-3 connections and `mcp` ones from protocol < 5,
/// whose `DeviceKind` can't read them; `confirm` / `confirm_dismissed` and
/// the `confirm` / `set_mcp_auto` ops need protocol 6; the ops on any
/// space of a computer ([`RemoteOp::on_any_space`]) need protocol 7).
pub const MIN_PROTOCOL_VERSION: u32 = 3;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DeviceOs {
    Macos,
    Linux,
    Windows,
    Ios,
    Android,
    /// An OS this build doesn't know (a newer client's): shown as such,
    /// never a reason to drop the device list (see `Deserialize`).
    Other,
}

impl<'de> Deserialize<'de> for DeviceOs {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(match String::deserialize(d)?.as_str() {
            "macos" => DeviceOs::Macos,
            "linux" => DeviceOs::Linux,
            "windows" => DeviceOs::Windows,
            "ios" => DeviceOs::Ios,
            "android" => DeviceOs::Android,
            _ => DeviceOs::Other,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKind {
    /// The desktop app: runs spaces and is where a person sits.
    Desktop,
    /// `theodore daemon`: runs spaces, nobody sits there.
    Daemon,
    /// The phone app (docs/mobile.md): a client only, never a target.
    Mobile,
    /// The web app: a client only, never a target.
    Web,
    /// The cloud's MCP endpoint (docs/fleet.md "MCP over the cloud"): a
    /// client only, never a target. Its key lives in the cloud, so a host
    /// caps what it may do without a person (`FleetMode::Plan`); an Edit or
    /// Run from it waits for a yes on the host.
    Mcp,
}

impl DeviceKind {
    /// Whether requests may be addressed to it.
    pub fn hosts(self) -> bool {
        matches!(self, DeviceKind::Desktop | DeviceKind::Daemon)
    }
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
    /// Agents a remote start or send may pick: installed and enabled here,
    /// the default (`agents.chat`) first. Empty unless `accepts_remote`,
    /// and from a host older than this field (then a request naming an
    /// agent, model or effort is ignored there, so the origin offers none).
    /// Kept within [`MAX_INFO_BYTES`] by [`DeviceInfo::fit_agents`].
    #[serde(default)]
    pub agents: Vec<FleetAgentInfo>,
    /// A host's auto mode for each Claude via the cloud (`mcp`) device it
    /// pins (docs/fleet.md "Auto mode"), so another of the user's devices
    /// can show it and change it (`RemoteOp::SetMcpAuto`). Empty on other
    /// kinds and on hosts older than this field.
    #[serde(default)]
    pub mcp_auto: Vec<McpAutoState>,
}

/// Whether a host lets Claude via the cloud (`DeviceKind::Mcp`) edit or run
/// without a person's yes (docs/fleet.md "Auto mode"). It never lifts the
/// host's `max_mode`; it only skips the prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum McpAuto {
    /// Every Edit or Run waits for a person (the default).
    #[default]
    Off,
    /// Edit starts and sends (a plan's approval into Edit too) run at once;
    /// Run still waits.
    Edit,
    /// Edit and Run run at once, a plan's approval too.
    Full,
}

impl McpAuto {
    /// Whether a request in `mode` runs without a person under this auto.
    pub fn covers(self, mode: FleetMode) -> bool {
        match self {
            McpAuto::Off => false,
            McpAuto::Edit => mode <= FleetMode::Edit,
            McpAuto::Full => true,
        }
    }
}

/// A host's auto mode for one `mcp` device it pins.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct McpAutoState {
    pub device_id: DeviceId,
    pub auto: McpAuto,
    /// Unix ms it ends; `None`: until turned off.
    #[serde(default)]
    pub until_ms: Option<u64>,
}

/// One agent a host runs for remote spaces (docs/fleet.md "Agent, model
/// and effort").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct FleetAgentInfo {
    /// `claude`, `codex`, `gemini`.
    pub id: String,
    pub label: String,
    /// What runs when a request names no model (`agents.<id>.model`, else
    /// the first current model); `None`: the CLI's own.
    #[serde(default)]
    pub default_model: Option<String>,
    /// What runs when a request names no effort (`agents.<id>.effort` when
    /// the default model takes it, else that model's own).
    #[serde(default)]
    pub default_effort: Option<String>,
    /// Current models first, earlier versions after (dropped first when
    /// the info runs over its size).
    #[serde(default)]
    pub models: Vec<FleetModelInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct FleetModelInfo {
    /// What the CLI's model flag takes; what a request's `model` names.
    pub id: String,
    pub label: String,
    /// Levels a request's `effort` may name with this model; empty: none.
    #[serde(default)]
    pub efforts: Vec<String>,
    #[serde(default)]
    pub default_effort: Option<String>,
}

/// The largest `DeviceInfo` (its JSON) the cloud takes.
pub const MAX_INFO_BYTES: usize = 8 * 1024;
/// Agents a device lists at most.
pub const MAX_AGENTS: usize = 4;
/// Models listed per agent at most.
pub const MAX_AGENT_MODELS: usize = 12;
/// Effort levels listed per model at most.
pub const MAX_MODEL_EFFORTS: usize = 8;
/// An agent id, at most.
pub const MAX_AGENT_ID_CHARS: usize = 32;
/// A model id, at most (a longer one isn't listed: it can't be cut).
pub const MAX_MODEL_ID_CHARS: usize = 64;
/// An agent's or model's label, at most (cut).
pub const MAX_AGENT_LABEL_CHARS: usize = 64;
/// An effort level, at most (a longer one isn't listed).
pub const MAX_EFFORT_CHARS: usize = 16;

fn cut(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn fits(s: &str, max: usize) -> bool {
    !s.is_empty() && s.chars().count() <= max
}

impl DeviceInfo {
    /// Keeps `agents` within the caps above and the whole info within
    /// [`MAX_INFO_BYTES`]: overlong ids and levels are dropped, labels cut,
    /// then the last model of the agent listing the most goes (earlier
    /// versions sit last), then the last agent, until it fits.
    pub fn fit_agents(&mut self) {
        let effort_ok = |e: &Option<String>| e.as_deref().is_none_or(|e| fits(e, MAX_EFFORT_CHARS));
        self.agents.retain(|a| fits(&a.id, MAX_AGENT_ID_CHARS));
        self.agents.truncate(MAX_AGENTS);
        for a in &mut self.agents {
            a.label = cut(&a.label, MAX_AGENT_LABEL_CHARS);
            if a.default_model
                .as_deref()
                .is_some_and(|m| !fits(m, MAX_MODEL_ID_CHARS))
            {
                a.default_model = None;
            }
            if !effort_ok(&a.default_effort) {
                a.default_effort = None;
            }
            a.models.retain(|m| fits(&m.id, MAX_MODEL_ID_CHARS));
            a.models.truncate(MAX_AGENT_MODELS);
            for m in &mut a.models {
                m.label = cut(&m.label, MAX_AGENT_LABEL_CHARS);
                m.efforts.retain(|e| fits(e, MAX_EFFORT_CHARS));
                m.efforts.truncate(MAX_MODEL_EFFORTS);
                if !effort_ok(&m.default_effort) {
                    m.default_effort = None;
                }
            }
        }
        let size = |i: &DeviceInfo| serde_json::to_string(i).map_or(usize::MAX, |t| t.len());
        while !self.agents.is_empty() && size(self) > MAX_INFO_BYTES {
            let most = self
                .agents
                .iter_mut()
                .filter(|a| !a.models.is_empty())
                .max_by_key(|a| a.models.len());
            match most {
                Some(a) => {
                    a.models.pop();
                }
                None => {
                    self.agents.pop();
                }
            }
        }
    }
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
        /// One of the model's efforts (the host's default model's when no
        /// model is named); `None`: the host's default.
        #[serde(default)]
        effort: Option<String>,
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
        /// From this turn on, as a local send's: the space's agent, model
        /// and effort, each checked against what the host lists
        /// (`DeviceInfo::agents`). `None` keeps the space's.
        #[serde(default)]
        agent: Option<String>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        effort: Option<String>,
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
    /// A person's Allow or Deny, on a device the target delegates to, of a
    /// request from Claude via the cloud waiting on the target
    /// ([`RemoteConfirm::confirm_id`]). Never taken from an `mcp` device.
    Confirm {
        confirm_id: String,
        allow: bool,
    },
    /// Sets the target's auto mode for an `mcp` device it pins
    /// (docs/fleet.md "Auto mode"). Never taken from an `mcp` device.
    SetMcpAuto {
        mcp_device: DeviceId,
        auto: McpAuto,
        /// Unix ms it ends; `None`: until turned off.
        #[serde(default)]
        until_ms: Option<u64>,
    },
    // ── protocol 7: any space on the target (docs/fleet.md "Any space on a
    // computer"). `space`, `parent` and `child` name the target's own local
    // space ids, or an `rs_` id the target hosts for this origin. Results
    // are the target's local tool results (docs/spaces.md "Sub-spaces"),
    // kept within `REPLY_VALUE_MAX_BYTES`.
    /// Every space on the target that isn't archived, newest activity
    /// first (`spaces_list`).
    ListSpaces {
        #[serde(default)]
        project: Option<String>,
    },
    /// One space: goal, status, its last `messages` (default 10, at most
    /// 50), the running turn's text, a question, progress, diff stat
    /// (`space_read`).
    ReadSpace {
        space: String,
        #[serde(default)]
        messages: Option<u32>,
    },
    /// Its own agent answers `question` from a read-only fork of its
    /// session; the space is left as it was (`space_ask`).
    AskSpace {
        space: String,
        question: String,
    },
    /// A message as the space's next turn, in the space's own mode (never
    /// changed); refused while it runs (`fleet.busy`).
    SendTo {
        space: String,
        message: String,
    },
    /// Answers question set `ask` waiting in `space`, as `Answer` does.
    AnswerSpace {
        space: String,
        ask: String,
        answers: Vec<Vec<String>>,
    },
    /// Merges sub-space `child` into its parent `parent`'s worktree
    /// (`space_merge`); counts as Edit.
    MergeChild {
        parent: String,
        child: String,
    },
}

impl RemoteOp {
    /// The cloud space (`rs_` id) it acts on; empty for an op on no space
    /// (`confirm`, `set_mcp_auto`) and for one on any of the target's own
    /// spaces ([`RemoteOp::on_any_space`]), which the cloud doesn't track.
    pub fn space(&self) -> &str {
        match self {
            RemoteOp::StartSpace { space, .. }
            | RemoteOp::Send { space, .. }
            | RemoteOp::Stop { space }
            | RemoteOp::Answer { space, .. } => space,
            RemoteOp::Confirm { .. }
            | RemoteOp::SetMcpAuto { .. }
            | RemoteOp::ListSpaces { .. }
            | RemoteOp::ReadSpace { .. }
            | RemoteOp::AskSpace { .. }
            | RemoteOp::SendTo { .. }
            | RemoteOp::AnswerSpace { .. }
            | RemoteOp::MergeChild { .. } => "",
        }
    }

    /// An op on any space of the target, by its local id (protocol 7).
    pub fn on_any_space(&self) -> bool {
        matches!(
            self,
            RemoteOp::ListSpaces { .. }
                | RemoteOp::ReadSpace { .. }
                | RemoteOp::AskSpace { .. }
                | RemoteOp::SendTo { .. }
                | RemoteOp::AnswerSpace { .. }
                | RemoteOp::MergeChild { .. }
        )
    }
}

/// The largest `reply.value` a target sends for an op on any space, as its
/// JSON sits in the signed reply (escaped once more): well within
/// [`MAX_FRAME_BYTES`]. A longer result drops its oldest items and cuts its
/// longest texts first.
pub const REPLY_VALUE_MAX_BYTES: usize = 128 * 1024;

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
    /// A [`Delegation`] from the origin device.
    Delegate,
    /// A [`RemoteConfirm`] from the host the request waits on.
    Confirm,
}

impl Domain {
    pub fn tag(self) -> &'static [u8] {
        match self {
            Domain::Hello => b"theodore-fleet-hello-v3\0",
            Domain::Request => b"theodore-fleet-request-v3\0",
            Domain::Event => b"theodore-fleet-event-v3\0",
            Domain::Ask => b"theodore-fleet-ask-v3\0",
            Domain::Reply => b"theodore-fleet-reply-v3\0",
            Domain::Delegate => b"theodore-fleet-delegate-v3\0",
            Domain::Confirm => b"theodore-fleet-confirm-v3\0",
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

impl Signer for Delegation {
    fn signer(&self) -> &str {
        &self.origin_device
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

impl Signer for RemoteConfirm {
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

/// An origin lets another of its user's devices follow the spaces it
/// started: subscribe to them and get their questions (docs/mobile.md
/// "Following a computer's spaces"). Signed by the origin
/// ([`Domain::Delegate`]); it grants no power on hosts, whose own trust still
/// decides what the delegate's requests may do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Delegation {
    pub origin_device: DeviceId,
    pub delegate_device: DeviceId,
    pub issued_at_ms: u64,
    /// Unix ms; the cloud drops it after. 0: no expiry.
    pub expires_at_ms: u64,
    /// `true` withdraws an earlier delegation to the same device.
    pub revoke: bool,
}

/// Push providers the cloud can send through.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PushProvider {
    /// Expo Push (APNs / FCM behind it).
    Expo,
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
    /// The agent, model or effort asked for isn't one the target lists
    /// (`DeviceInfo::agents`): not installed, turned off, or unknown.
    pub const AGENT_UNAVAILABLE: &str = "fleet.agent_unavailable";
    pub const OFFLINE: &str = "fleet.offline";
    pub const BUSY: &str = "fleet.busy";
    pub const INTERNAL: &str = "fleet.internal";
    /// A request from a device whose key the cloud holds (`DeviceKind::Mcp`)
    /// that needs a person on the target: denied there, not answered within
    /// the request window, or refused outright by a daemon (nobody there).
    pub const DENIED: &str = "fleet.denied";
    /// A slow op (`ask_space`'s answer) didn't finish on the target in
    /// time.
    pub const TIMEOUT: &str = "fleet.timeout";
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

    /// Every code by its name here, for the generated TS (`FLEET_CODES`).
    pub const ALL: &[(&str, &str)] = &[
        ("REMOTE_OFF", REMOTE_OFF),
        ("UNTRUSTED_DEVICE", UNTRUSTED_DEVICE),
        ("BAD_SIGNATURE", BAD_SIGNATURE),
        ("STALE_REQUEST", STALE_REQUEST),
        ("MODE_NOT_ALLOWED", MODE_NOT_ALLOWED),
        ("UNKNOWN_PROJECT", UNKNOWN_PROJECT),
        ("UNKNOWN_SPACE", UNKNOWN_SPACE),
        ("DEPTH", DEPTH),
        ("INVALID", INVALID),
        ("AGENT_UNAVAILABLE", AGENT_UNAVAILABLE),
        ("OFFLINE", OFFLINE),
        ("BUSY", BUSY),
        ("INTERNAL", INTERNAL),
        ("DENIED", DENIED),
        ("TIMEOUT", TIMEOUT),
        ("UNAUTHORIZED", UNAUTHORIZED),
        ("NO_ORG", NO_ORG),
        ("VERSION", VERSION),
        ("KEY_MISMATCH", KEY_MISMATCH),
        ("TOO_LARGE", TOO_LARGE),
        ("RATE_LIMITED", RATE_LIMITED),
        ("NOT_YOURS", NOT_YOURS),
        ("BAD_MESSAGE", BAD_MESSAGE),
        ("TOO_MANY_DEVICES", TOO_MANY_DEVICES),
        ("REMOVED", REMOVED),
        ("TOO_MANY_SPACES", TOO_MANY_SPACES),
        ("TOO_MANY_CONNECTIONS", TOO_MANY_CONNECTIONS),
        ("UPGRADE_REQUIRED", UPGRADE_REQUIRED),
        ("UNAVAILABLE", UNAVAILABLE),
        ("BAD_URL", BAD_URL),
        ("TLS", TLS),
    ];
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
    /// One row of the space as the host's own UI sees it (docs/spaces.md
    /// models): `model` is `space` (the space row, local-only fields
    /// blanked), `chat_message` (its chat), or `turn_step` (a step of a run;
    /// `id` = `<run>:<n>`). `data` is the contract JSON; `None` deletes it.
    /// The origin mirrors these so a remote space renders exactly like a
    /// local one. Each event's JSON stays under [`MIRROR_ROW_MAX_BYTES`].
    Mirror {
        model: String,
        id: String,
        #[serde(default)]
        #[specta(type = Option<specta_typescript::Unknown>)]
        data: Option<serde_json::Value>,
    },
}

/// The largest mirrored row a host sends (its JSON); longer texts are cut
/// with a note, the host's copy stays whole.
pub const MIRROR_ROW_MAX_BYTES: usize = 48 * 1024;
/// Models a host mirrors to the origin and its delegates. A follower drops
/// a model it doesn't know (`sub_space` is protocol 7's).
pub const MIRROR_MODELS: &[&str] = &["space", "chat_message", "turn_step", SUB_SPACE_MODEL];
/// The `mirror` model of a sub-space of a hosted space: `id` is the
/// child's local id on the host, `data` a [`MirroredSubSpace`] (`None`:
/// gone). Sent on the hosted space at the top of the tree, for every
/// sub-space under it.
pub const SUB_SPACE_MODEL: &str = "sub_space";

/// `mirror{sub_space}`'s `data`: a sub-space of a hosted space, as that
/// space's followers see it in its tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct MirroredSubSpace {
    /// Its local id on the host (what `send_to` and `read_space` take).
    pub space: String,
    /// Its parent: the hosted space's `rs_` id, or another sub-space's
    /// local id.
    pub parent: String,
    /// At most 120 characters.
    pub title: String,
    /// `setting_up`, `running`, `question`, `waiting`, `idle`, `failed` or
    /// `archived`, as `spaces_list` says it.
    pub status: String,
    pub mode: FleetMode,
    /// Merged into its parent, or shipped.
    pub done: bool,
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

/// What a request waiting for a person would do (`RemoteConfirm::action`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ConfirmAction {
    /// Start a space in `project_name`.
    Start,
    /// Send a message to `space_name`, as its next turn.
    Send,
    /// Approve the plan in `space_name` (its next turn edits).
    ApprovePlan,
    /// Merge sub-space `text` (its title) into `space_name`'s worktree
    /// (protocol 7; an older delegate drops the prompt).
    Merge,
}

/// A request from Claude via the cloud (`DeviceKind::Mcp`) waiting on its
/// host for a person's yes, as the host shows it to the devices it
/// delegates to, signed by the host ([`Domain::Confirm`]). They answer with
/// a signed [`RemoteOp::Confirm`] to the host; the first answer wins.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct RemoteConfirm {
    /// The waiting request's `req_id`.
    pub confirm_id: String,
    pub host_device: DeviceId,
    /// The `mcp` device that asked.
    pub mcp_device: DeviceId,
    pub action: ConfirmAction,
    pub mode: FleetMode,
    /// `start`: the project it starts in, as the host names it.
    #[serde(default)]
    pub project_name: Option<String>,
    /// `send` / `approve_plan`: the space, as the host names it.
    #[serde(default)]
    pub space_name: Option<String>,
    /// The goal or the message, at most [`CONFIRM_TEXT_MAX`] characters.
    pub text: String,
    /// Unix ms: refused on the host unless answered before.
    pub expires_at_ms: u64,
}

/// Most characters of a [`RemoteConfirm`]'s text.
pub const CONFIRM_TEXT_MAX: usize = 500;

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
    /// This device's push token (phone app); an empty token removes it.
    RegisterPush {
        provider: PushProvider,
        token: String,
    },
    /// A [`Delegation`] signed by this device as its origin.
    Delegate {
        envelope: SignedEnvelope,
    },
    /// A [`RemoteConfirm`] signed by this device as its host: shown on the
    /// devices it delegates to (protocol 6).
    Confirm {
        envelope: SignedEnvelope,
    },
    /// The confirm was answered (here or elsewhere) or ran out of time.
    ConfirmResolved {
        confirm_id: String,
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
    /// The live delegations naming this device (as origin or delegate), each
    /// as the origin signed it; sent after welcome and on change.
    Delegations {
        list: Vec<SignedEnvelope>,
    },
    /// A host's signed [`RemoteConfirm`], forwarded unchanged to the
    /// devices it delegates to (protocol 6), again after their welcome
    /// while it waits.
    Confirm {
        envelope: SignedEnvelope,
    },
    /// The confirm is no longer waiting on its host.
    ConfirmDismissed {
        confirm_id: String,
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
        .register::<Delegation>()
        .register::<RemoteAsk>()
        .register::<RemoteConfirm>()
        .register::<StartedSpace>()
        .register::<MirroredSubSpace>();
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
