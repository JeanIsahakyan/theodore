//! Telemetry (docs/telemetry.md): what the UI forwards to the core's log
//! (`log_client`), the two sharing choices (`telemetry_status`,
//! `set_telemetry`) and "Report a problem" (`report_problem`,
//! `reveal_report`; as a GitHub issue: `issue_target`, `preview_issue`,
//! `submit_issue`; from a chat: `draft_report`; attached files:
//! `stage_report_files`).

use serde::{Deserialize, Serialize};
use specta::Type;
use theodore_domain::PrId;

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
    /// Revise on a plan card. The revision itself is an ordinary send.
    PlanRevised,
    /// The report window opened: `app`, `chat`, `agent`.
    ReportOpened { from: String },
    /// Uses counted since the last flush, never one event per use.
    UiCounts { tool_rows: u32, file_hovers: u32 },
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
    /// "Share usage data".
    pub usage: Option<bool>,
    /// "Send error reports".
    pub errors: Option<bool>,
    /// "Share usage data" is on under the old terms ("not linked to your
    /// account"): it stays anonymous until the user answers the prompt.
    pub usage_needs_consent: bool,
    /// The same for "Send error reports".
    pub errors_needs_consent: bool,
    /// Every product event and its fields.
    pub events: Vec<TelemetryEventInfo>,
    /// What is never sent, one line each.
    pub never_sent: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct TelemetryChoice {
    pub usage: bool,
    pub errors: bool,
    /// This choice was made reading the current terms (the account id is
    /// attached), so a switch left on counts as agreeing to them. Turning a
    /// switch on always does; leaving one on otherwise doesn't.
    #[serde(default)]
    pub usage_consent: bool,
    /// The same for `errors`.
    #[serde(default)]
    pub errors_consent: bool,
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

/// How "Report a problem" shares the report (docs/telemetry.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ReportMode {
    /// A public GitHub issue: title, comment, app info.
    Issue,
    /// The same, plus the newest redacted log lines.
    IssueWithLogs,
    /// A local zip; nothing is uploaded.
    LogsOnly,
}

/// Where a report issue would go and whether it can be posted now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct IssueTarget {
    /// `owner/name`.
    pub repo: String,
    /// `https://github.com/owner/name`.
    pub url: String,
    /// The GitHub login it would be posted as.
    pub login: Option<String>,
    /// Why issues can't be posted (signed out, sandbox); `None`: they can.
    pub unavailable: Option<String>,
    /// Asking again may change the answer (a rate limit, the network, a
    /// sign-in): the window offers Retry. False when it never can (sandbox,
    /// fixtures) or nothing is wrong.
    #[serde(default)]
    pub retry: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct IssueRequest {
    pub title: String,
    pub comment: String,
    pub with_logs: bool,
    /// The draft a preview came from: its app info and log lines are the
    /// ones posted, so the preview is exactly what's sent. `None` (or one
    /// that expired) collects them afresh.
    #[serde(default)]
    pub draft: Option<String>,
    /// A chat report's id (`ReportDraft::id`): the body gets that
    /// conversation, and `with_logs` means that run's log lines only.
    #[serde(default)]
    pub context: Option<String>,
}

/// Exactly what `submit_issue` would post for the same request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct IssuePreview {
    /// Pass back in `IssueRequest::draft`.
    pub draft: String,
    pub title: String,
    pub body: String,
    /// The conversation block in `body` (a chat report; folded in the
    /// preview).
    #[serde(default)]
    pub context: Option<String>,
    /// The logs block `body` ends with (folded in the preview).
    pub logs: Option<String>,
    pub log_lines: u32,
    /// Older log lines left out to stay under GitHub's size limit.
    pub cut_lines: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ReportedIssue {
    pub number: u64,
    pub url: String,
}

/// What a chat report is about (docs/telemetry.md "Report from a chat").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ReportScope {
    /// One message: its own text (and a reply's tool calls).
    Message,
    /// Your message and the reply to it, tool calls, error, timings.
    Turn,
    /// A space as a whole: where, agent, status; no message text.
    Space,
    /// A PR's AI panel as a whole: the same.
    Review,
}

/// `draft_report`: a problem report about a chat, prefilled from it.
/// "Report this", `/report` and the agents' `report_problem` tool all
/// end here; nothing is sent until you submit the report window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct DraftReportRequest {
    /// The chat: a PR's id (its AI panel) or a space's chat key
    /// (`space:<id>`).
    pub chat: PrId,
    /// The message it is about; none: the chat's latest reply.
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Default: `turn`.
    #[serde(default)]
    pub scope: Option<ReportScope>,
    /// Default: on.
    #[serde(default)]
    pub include_logs: Option<bool>,
}

/// A drafted chat report, waiting in the report window. Its conversation
/// is read when the window previews or posts it, so a turn still running
/// when it was drafted shows how it ended.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ReportDraft {
    /// Pass in `IssueRequest::context`.
    pub id: String,
    pub chat: PrId,
    pub scope: ReportScope,
    pub title: String,
    pub description: String,
    pub include_logs: bool,
    /// One line for the window: `Space turn 3 of 5 · claude`.
    pub about: String,
    /// Drafted by the agent (`report_problem`), not by you.
    pub by_agent: bool,
}

/// `stage_report_files`: a report's attached files, copied into one
/// folder under the reports folder for you to add on GitHub yourself
/// (docs/telemetry.md "Attachments"). Nothing is uploaded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct StagedReportFiles {
    pub dir: String,
    /// Absolute paths, in the order given.
    pub paths: Vec<String>,
}
