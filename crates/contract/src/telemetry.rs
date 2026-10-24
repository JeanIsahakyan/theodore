//! Telemetry (docs/telemetry.md): what the UI forwards to the core's log
//! (`log_client`), the two sharing choices (`telemetry_status`,
//! `set_telemetry`) and "Report a problem" (`report_problem`,
//! `reveal_report`).

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ClientLogLevel {
    Error,
    Warn,
    Info,
}

/// One UI error or event, forwarded to the core's log. The core rate-limits
/// and dedupes these, then redacts them like every other record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ClientLog {
    pub level: ClientLogLevel,
    /// Where it came from: `onerror`, `unhandledrejection`, `boundary`.
    pub source: String,
    pub message: String,
    #[serde(default)]
    pub stack: Option<String>,
    /// React's component stack (error boundary only).
    #[serde(default)]
    pub component_stack: Option<String>,
    /// The operation the error belongs to, when a command failed.
    #[serde(default)]
    pub op_id: Option<String>,
    /// The route name only (`review`, `inbox`), never ids or titles.
    #[serde(default)]
    pub route: Option<String>,
}

/// A product event the UI reports (`track_ui`). Typed like the core's own:
/// the core accepts only known values and drops anything else.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum UiEvent {
    /// An onboarding step was shown: `account`, `telemetry`, `github`,
    /// `agents`, `projects`, `done`.
    OnboardingStep { step: String },
}

/// One product event the app may send, with its field names (for "What's
/// collected"). Generated from the core's typed event list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct TelemetryEventInfo {
    pub name: String,
    pub fields: Vec<String>,
}

/// The two sharing choices. `None` until the user chose (onboarding or
/// Settings); nothing leaves the machine before that.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct TelemetryStatus {
    /// A usage-data sink (product events) is configured in this build.
    pub usage_available: bool,
    /// An error-report sink (warnings, errors, traces) is configured.
    pub errors_available: bool,
    /// "Share anonymous usage data".
    pub usage: Option<bool>,
    /// "Send error reports".
    pub errors: Option<bool>,
    /// Every product event and its fields.
    pub events: Vec<TelemetryEventInfo>,
    /// What is never sent, one line each.
    pub never_sent: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct TelemetryChoice {
    pub usage: bool,
    pub errors: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ReportFile {
    pub name: String,
    pub bytes: u64,
}

/// A problem report built on disk for the user to review: nothing is
/// uploaded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ProblemReport {
    /// The zip.
    pub path: String,
    /// The folder the zip was built from (same files, unzipped).
    pub dir: String,
    pub files: Vec<ReportFile>,
    /// Version, OS, agent CLIs: for "Copy summary".
    pub summary: String,
}
