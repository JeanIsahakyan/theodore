//! Sandbox mode (docs/sandbox.md): Theodore running against a simulated,
//! fully local host. Only ever present when the app was started with
//! `THEODORE_SANDBOX` / `--sandbox`.

use serde::{Deserialize, Serialize};
use specta::Type;

/// `AppInfo.sandbox`: which scenario this window runs, so the UI can show
/// a badge that can't be mistaken for the real app.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SandboxInfo {
    /// Scenario name from `scenario.json`.
    pub scenario: String,
    /// Scenario directory the sandbox was started from.
    pub scenario_dir: String,
    /// Data dir in use (never `~/.theodore`).
    pub data_dir: String,
}

/// One injectable fault (offline, auth, rate limit, …).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SandboxFault {
    /// Stable name, as used by `theodore sandbox fault <name> on|off`.
    pub name: String,
    pub on: bool,
    /// Human description, including the active parameter (e.g. `250 ms`).
    pub detail: String,
}

/// One scripted timeline event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SandboxEvent {
    pub id: String,
    /// Due this long after the sandbox started; `None` = manual only.
    pub at_ms: Option<i64>,
    pub label: String,
    pub fired: bool,
}

/// Settings → Sandbox panel state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SandboxStatus {
    pub info: SandboxInfo,
    pub faults: Vec<SandboxFault>,
    pub events: Vec<SandboxEvent>,
    /// Viewer login the sandbox host authenticates as.
    pub viewer: String,
    /// Number of simulated PRs.
    pub prs: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SandboxFaultRequest {
    pub name: String,
    pub on: bool,
}
