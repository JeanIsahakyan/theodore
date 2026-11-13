//! What the fleet tools of `space-tools` (docs/fleet.md "Agents use it
//! too") return to an agent: plain, short JSON. The core fills them; the
//! MCP server only serializes them.

use serde::Serialize;

/// Most a `fleet_wait` may wait.
pub const FLEET_WAIT_MAX_MS: u64 = 600_000;

/// Another of the user's devices that takes remote spaces right now. No
/// unsigned free text: the name is the one pinned on this device, the
/// projects are ids in a strict shape (`local:app`, `github.com/acme/app`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FleetToolDevice {
    pub device_id: String,
    pub name: String,
    pub projects: Vec<String>,
    /// The highest mode it allows: `ask`, `plan`, `edit` or `run`.
    pub max_mode: String,
}

/// A space on another device, as this device last heard of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FleetToolSpace {
    /// The fleet id (`rs_…`): what the other fleet tools take.
    pub space: String,
    pub device: String,
    pub name: String,
    pub branch: String,
    /// `starting`, `running`, `idle`, `waiting` (a question waits for the
    /// user), `stopped` or `failed`.
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_reply: Option<String>,
    /// The question waiting for the user, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FleetToolLine {
    pub seq: u64,
    pub kind: String,
    pub text: String,
}

/// `fleet_read`: the space and its history after `since`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FleetToolRead {
    pub space: FleetToolSpace,
    pub lines: Vec<FleetToolLine>,
}

/// `fleet_wait`: every space asked about, and whether all of them settled
/// before the timeout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FleetToolWait {
    pub settled: bool,
    pub spaces: Vec<FleetToolSpace>,
}
