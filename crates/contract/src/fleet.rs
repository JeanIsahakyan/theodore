//! Fleet (docs/fleet.md) as the UI sees it: this device's settings, the
//! user's other devices, spaces running on another device for this one (or
//! here for another), and questions routed here. Wire types live in
//! `theodore-fleet-protocol`; these are the UI's.
//!
//! Commands: `fleet_status`, `fleet_set_settings`, `fleet_trust_device`,
//! `fleet_remove_device`, `fleet_start_space`, `fleet_send`, `fleet_stop`, `fleet_answer`,
//! `fleet_spaces`, `fleet_space_lines`, `fleet_presence`.
//! Ephemerals: `fleet_status`, `fleet_space`, `fleet_space_line`,
//! `fleet_ask`, `fleet_ask_dismissed`, `fleet_trust_needed`.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::SpaceMode;

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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FleetDevice {
    pub device_id: String,
    pub name: String,
    pub os: FleetOs,
    /// `desktop` or `daemon`.
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FleetSendRequest {
    pub space: String,
    pub text: String,
    #[serde(default)]
    pub mode: Option<SpaceMode>,
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
}
