//! Fleet (docs/fleet.md) as the UI sees it: this device's settings, the
//! user's other devices, spaces running on another device for this one (or
//! here for another), and questions routed here. Wire types live in
//! `theodore-fleet-protocol`; these are the UI's.
//!
//! Commands: `fleet_status`, `fleet_set_settings`, `fleet_trust_device`,
//! `fleet_remove_device`, `fleet_delegate`, `fleet_start_space`, `fleet_send`, `fleet_stop`, `fleet_answer`,
//! `fleet_spaces`, `fleet_space_lines`, `fleet_presence`, `fleet_confirms`,
//! `fleet_confirm`, `fleet_set_auto`.
//! Ephemerals: `fleet_status`, `fleet_space`, `fleet_space_line`,
//! `fleet_ask`, `fleet_ask_dismissed`, `fleet_trust_needed`,
//! `fleet_confirm`, `fleet_confirm_done`.

use serde::{Deserialize, Serialize};
use specta::Type;

use theodore_domain::AgentId;

use crate::{AgentModel, SpaceMode};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FleetProject {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum FleetOs {
    Macos,
    Linux,
    Windows,
    Ios,
    Android,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FleetDevice {
    pub device_id: String,
    pub name: String,
    pub os: FleetOs,
    /// `desktop` or `daemon` (computers: they run spaces), `mobile` or `web`
    /// (the phone and web app: clients only, never a space's target), `mcp`
    /// (Claude via the cloud: a client whose key the cloud holds; an Edit or
    /// Run from it waits for a person here).
    pub kind: String,
    pub online: bool,
    /// Unix ms; 0 if never.
    pub last_seen_ms: u64,
    /// Projects it lets trusted devices start spaces in (empty unless it
    /// accepts remote requests).
    pub projects: Vec<FleetProject>,
    pub accepts_remote: bool,
    pub max_mode: SpaceMode,
    /// 8 groups of 4 hex ("a1b2 c3d4 … 0718"): compare with what that device
    /// shows for itself.
    pub fingerprint: String,
    /// The key the fingerprint is of; trusting sends it back so exactly this
    /// key is pinned, whatever the cloud lists by then.
    pub public_key: String,
    /// This device trusts it (its key is pinned here).
    pub trusted: bool,
    pub this_device: bool,
    /// This device sends its spaces' questions there (docs/mobile.md
    /// "Following a computer's spaces"): asked for here, and still trusted.
    pub delegated: bool,
    /// The cloud holds that delegation, as this device signed it.
    pub delegation_live: bool,
    /// Agents a space started or steered there may pick, as it lists them
    /// (installed and enabled there, its default first). Empty: a host too
    /// old to list them, or not taking remote spaces; then nothing is
    /// picked and its own defaults run.
    #[serde(default)]
    pub agents: Vec<FleetAgent>,
    /// `mcp` devices pinned here: this computer's auto mode for it
    /// (docs/fleet.md "Auto mode"); `off` for every other device, and when
    /// `auto_until_ms` has passed.
    #[serde(default)]
    pub auto: FleetAuto,
    /// Unix ms the auto mode ends; `None`: until turned off (or off).
    #[serde(default)]
    pub auto_until_ms: Option<u64>,
    /// Another computer: its auto mode for each Claude via cloud device it
    /// pins, as it lists it (empty for others, and for older computers).
    /// Changed with `fleet_set_auto { host_device }`.
    #[serde(default)]
    pub mcp_auto: Vec<FleetMcpAuto>,
}

/// Whether this computer lets Claude via cloud (an `mcp` device) edit or
/// run without your yes. It never lifts `max_mode`; it only skips the
/// prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum FleetAuto {
    /// Every Edit or Run waits for your yes.
    #[default]
    Off,
    /// Edit (a plan's approval into Edit too) goes through; Run waits.
    Edit,
    /// Edit and Run go through, plan approvals too.
    Full,
}

/// A computer's auto mode for one Claude via cloud device, as it lists it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FleetMcpAuto {
    /// The `mcp` device.
    pub device_id: String,
    /// Its name as the cloud lists it ("Claude (MCP)"), or its id.
    pub name: String,
    pub auto: FleetAuto,
    pub until_ms: Option<u64>,
}

/// An auto mode on now on this computer: the notice that stays while it
/// lasts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FleetAutoOn {
    pub device_id: String,
    /// The name pinned here.
    pub device_name: String,
    pub auto: FleetAuto,
    pub until_ms: Option<u64>,
}

/// `fleet_set_auto`: the auto mode for `mcp` device `device_id`, on this
/// computer (`host_device` none) or on another one you trust (sent there as
/// a signed request; it applies it if it trusts this device).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FleetAutoRequest {
    pub device_id: String,
    pub auto: FleetAuto,
    /// Unix ms it ends; `None`: until turned off. Ignored for `off`.
    #[serde(default)]
    pub until_ms: Option<u64>,
    #[serde(default)]
    pub host_device: Option<String>,
}

/// An agent another device runs, with its models (`description` none,
/// `older` false: the host lists current models first).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FleetAgent {
    pub id: AgentId,
    pub label: String,
    /// What runs there when none is picked.
    pub default_model: Option<String>,
    pub default_effort: Option<String>,
    pub models: Vec<AgentModel>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FleetStatus {
    /// A cloud and an account are configured; `false` hides the feature.
    pub available: bool,
    /// `fleet.enabled`: connect at all.
    pub enabled: bool,
    pub connected: bool,
    /// Set once the cloud has registered this device.
    pub device_id: Option<String>,
    /// This device's name as others see it.
    pub name: String,
    /// This device's key fingerprint.
    pub fingerprint: String,
    /// `fleet.accept_remote`.
    pub accept_remote: bool,
    /// `fleet.max_mode`.
    pub max_mode: SpaceMode,
    /// The user's devices in the current organization, this one included.
    pub devices: Vec<FleetDevice>,
    /// Why it isn't connected, when enabled and not connected.
    pub error: Option<String>,
    /// Auto modes on now on this computer (docs/fleet.md "Auto mode").
    #[serde(default)]
    pub autos: Vec<FleetAutoOn>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FleetSettingsRequest {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub accept_remote: Option<bool>,
    #[serde(default)]
    pub max_mode: Option<SpaceMode>,
    #[serde(default)]
    pub name: Option<String>,
}

/// Trust or distrust a device: its current public key (as the cloud lists
/// it) is pinned here, or unpinned.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FleetTrustRequest {
    pub device_id: String,
    pub trusted: bool,
    /// Required to trust: the key the user compared (`FleetDevice::public_key`
    /// or `FleetTrustNeeded::public_key`). Refused if the cloud now lists
    /// another key for the device.
    #[serde(default)]
    pub public_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FleetStartRequest {
    pub device_id: String,
    pub project_id: String,
    pub goal: String,
    pub mode: SpaceMode,
    /// One the host lists (`FleetDevice::agents`); `None`: its default.
    #[serde(default)]
    pub agent: Option<AgentId>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FleetSendRequest {
    pub space: String,
    pub text: String,
    #[serde(default)]
    pub mode: Option<SpaceMode>,
    /// From this turn on, as a local send; `None` keeps the space's.
    #[serde(default)]
    pub agent: Option<AgentId>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FleetAnswerRequest {
    pub space: String,
    pub ask_id: String,
    /// One entry per question: the chosen options, or one free text.
    pub answers: Vec<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FleetPresenceRequest {
    pub focused: bool,
    /// Ms since the last input in the app.
    pub idle_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum FleetSpaceStatus {
    /// Asked for, no reply from the host yet.
    Starting,
    Running,
    Idle,
    Waiting,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FleetQuestionItem {
    pub question: String,
    pub options: Vec<String>,
    pub multi: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FleetQuestion {
    pub ask_id: String,
    pub space: String,
    /// "<device> · <space name>".
    pub from: String,
    pub questions: Vec<FleetQuestionItem>,
    /// `active`, `origin`, `escalated`, `moved`; `None` on the host itself.
    pub via: Option<String>,
}

/// A space in the fleet: hosted on another device and started from here,
/// or hosted here for another device.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FleetRemoteSpace {
    /// The fleet id (`rs_…`).
    pub space: String,
    pub host_device: String,
    pub host_name: String,
    pub origin_device: String,
    pub project_name: String,
    pub name: String,
    pub branch: String,
    pub status: FleetSpaceStatus,
    pub mode: SpaceMode,
    pub depth: u32,
    pub parent: Option<String>,
    pub last_reply: Option<String>,
    pub question: Option<FleetQuestion>,
    /// Hosted on this device (then `local_space` is its local id).
    pub hosted_here: bool,
    pub local_space: Option<String>,
    /// Why it failed to start, if it did.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum FleetLineKind {
    Started,
    Status,
    Turn,
    Tool,
    Reply,
    Ended,
    Question,
    Gap,
    /// A sub-space the space started on its host: `<id> · <title> · <status>`.
    SubSpace,
}

/// Where a followed space's sub-space stands, as its host words it
/// (`spaces_list`'s words).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RemoteSubSpaceStatus {
    SettingUp,
    Running,
    /// Its agent waits on an answer.
    Question,
    /// Its setup waits.
    Waiting,
    Idle,
    Failed,
    Archived,
}

impl RemoteSubSpaceStatus {
    /// The host's word; one this build doesn't know reads as `idle`.
    pub fn from_word(w: &str) -> Self {
        match w {
            "setting_up" => Self::SettingUp,
            "running" => Self::Running,
            "question" => Self::Question,
            "waiting" => Self::Waiting,
            "failed" => Self::Failed,
            "archived" => Self::Archived,
            _ => Self::Idle,
        }
    }
}

/// A sub-space a followed space started on its host (docs/fleet.md "What a
/// hosted space's agent may do"): the latest of its `sub_space` mirror, kept as a
/// `remote_sub_space` row keyed `<root>:<space>`. Shown in its root's tree;
/// never a space here (no worktree, no chat, no commands).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct RemoteSubSpace {
    /// The followed space at the top of its tree (`rs_…`), a `space` row
    /// here with `remote` set.
    pub root: String,
    /// Its local id on the host.
    pub space: String,
    /// `root`, or another sub-space's `space`.
    pub parent: String,
    pub title: String,
    pub status: RemoteSubSpaceStatus,
    pub mode: SpaceMode,
    /// Merged into its parent, or shipped.
    pub done: bool,
    /// The event it last changed at: newer is more recently active.
    pub seq: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FleetSpaceLine {
    pub seq: u64,
    pub kind: FleetLineKind,
    pub text: String,
}

/// A request from `device_id` was refused because it isn't trusted here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FleetTrustNeeded {
    pub device_id: String,
    pub device_name: String,
    pub fingerprint: String,
    pub public_key: String,
    /// `FleetDevice::kind` as the cloud lists it; empty when it doesn't
    /// list the device.
    #[serde(default)]
    pub kind: String,
}

/// What a request waiting for a person here would do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum FleetConfirmAction {
    /// Start a space in `project_name`.
    Start,
    /// Send a message to `space_name`, as its next turn.
    Send,
    /// Approve the plan in `space_name` (its next turn edits).
    ApprovePlan,
    /// Merge a sub-space (`text`: its title) into `space_name`.
    Merge,
}

/// A request from a device whose key the cloud holds (kind `mcp`: Claude
/// via the cloud) that would edit or run here: it waits for a person on
/// this device (docs/fleet.md "Trust"). Allow runs it; Deny, or no answer
/// by `expires_at_ms`, refuses it with `fleet.denied`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FleetConfirm {
    /// The request's id: what `fleet_confirm` answers.
    pub id: String,
    pub device_id: String,
    /// The name pinned here for the device.
    pub device_name: String,
    pub action: FleetConfirmAction,
    pub mode: SpaceMode,
    /// `start`: the project it starts in.
    pub project_name: Option<String>,
    /// `send` / `approve_plan`: the space, as people know it here.
    pub space_name: Option<String>,
    /// `send` / `approve_plan`: its local id, to open it.
    pub local_space: Option<String>,
    /// The goal or the message, cut to 500 characters.
    pub text: String,
    /// Unix ms: refused unless answered before.
    pub expires_at_ms: u64,
    /// Waiting on another computer, which sends its approvals here
    /// (`None`: on this one). Allow or Deny goes there as a signed request.
    #[serde(default)]
    pub host_device: Option<String>,
    /// That computer's name as pinned here.
    #[serde(default)]
    pub host_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FleetConfirmAnswer {
    pub id: String,
    pub allow: bool,
}
