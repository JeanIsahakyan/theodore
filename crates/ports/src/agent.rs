//! Agent port (plan §8): runs a local agent CLI and streams normalized events.

use std::path::PathBuf;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use theodore_domain::{AgentId, Usage};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: AgentId,
    pub path: Option<PathBuf>,
    pub version: Option<String>,
    pub installed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentMode {
    /// read / grep / MCP only
    ReadOnly,
    /// may edit files inside `cwd`
    Edit,
    /// may edit files and run any shell command without asking (a space's
    /// Run mode, docs/spaces.md §5). Theodore adds no sandbox of its own:
    /// the CLI's own configuration is what limits it.
    Run,
    /// read and explore, never edit; the turn ends with a plan (a space's
    /// Plan mode, docs/spaces.md §5). Claude Code's own plan mode; the
    /// others run read-only and are told to answer with a numbered plan.
    Plan,
}

/// The MCP server name a PR run's tools go under (`mcp__review-tools__*`).
pub const REVIEW_TOOLS: &str = "review-tools";
/// The MCP server name a space turn's tools go under (`mcp__space-tools__*`).
pub const SPACE_TOOLS: &str = "space-tools";
/// The MCP server name of the code tools alone (`mcp__code-tools__*`):
/// `theodore code-tools-mcp` and the agent-tools eval, outside the app.
pub const CODE_TOOLS: &str = "code-tools";
/// The tool every Theodore MCP server has for Claude Code's permission
/// prompts (`--permission-prompt-tool mcp__<server>__approve_tool`).
pub const APPROVE_TOOL: &str = "approve_tool";
/// An AI panel question's run id starts with this (`ask:<message id>`):
/// a chat run, unlike a skill or fix run on the same PR.
pub const CHAT_RUN_PREFIX: &str = "ask:";

fn review_tools() -> String {
    REVIEW_TOOLS.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpEndpoint {
    pub url: String,
    pub token: String,
    /// The server name the agent CLI registers it under: [`REVIEW_TOOLS`]
    /// or [`SPACE_TOOLS`]. Decides the tool names the agent sees.
    #[serde(default = "review_tools")]
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRequest {
    pub agent: AgentId,
    pub prompt: String,
    pub system: Option<String>,
    pub cwd: PathBuf,
    pub mode: AgentMode,
    pub mcp: Option<McpEndpoint>,
    pub model: Option<String>,
    /// How hard the agent thinks (`low` … `max`). Claude Code takes it as
    /// `--effort`, Codex as `-c model_reasoning_effort=…`; Gemini ignores it.
    #[serde(default)]
    pub effort: Option<String>,
    /// No output for this long → `AgentEvent::Stalled`.
    pub stall_after_ms: u64,
    /// Added to the child's environment after Theodore's own `THEODORE_*`
    /// secrets are stripped from the inherited one: a space's `env` and
    /// variables (docs/config.md).
    #[serde(default)]
    pub env: Vec<(String, String)>,
    /// The CLI may also load the user's own MCP servers (Claude Code's
    /// `~/.claude.json`, the repo's `.mcp.json`, claude.ai connectors) next
    /// to `mcp`: the `agents.user_mcp` setting. `false` = only `mcp`.
    #[serde(default)]
    pub user_mcp: bool,
    /// Files sent with this turn (chat attachments). The prompt already
    /// lists their paths; each runner adds what its CLI needs to open them
    /// (Claude Code: `--add-dir`, Codex: `-i` for images).
    #[serde(default)]
    pub attachments: Vec<AgentAttachment>,
    /// Continue this CLI session — an id an earlier run reported as
    /// [`AgentEvent::Session`] — instead of starting a new one, so the agent
    /// keeps what it read, ran and planned. `prompt` is then only the new
    /// turn. Claude Code: `--resume`; Codex: `exec resume`; Gemini has no
    /// resume and ignores it.
    #[serde(default)]
    pub resume: Option<String>,
    /// Also report the answer's text as it is generated
    /// ([`AgentEvent::TextDelta`]), not only per finished message. Claude
    /// Code: `--include-partial-messages`; a CLI that can't ignores it. On
    /// for every run the window shows live (chat, skills, space turns,
    /// fixes) and for grouping runs that stream groups.
    #[serde(default)]
    pub stream_text: bool,
}

/// One file the agent should read, outside `cwd`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentAttachment {
    pub path: PathBuf,
    pub mime: String,
}

/// [`AgentEvent::ToolDetail`]: what a CLI's stream says of a result, where it
/// says it. Every field empty on one that doesn't.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolResultDetail {
    pub stdout: Option<String>,
    pub stderr: Option<String>,
    pub exit_code: Option<i32>,
    pub interrupted: bool,
    /// It keeps running in the background: this result only says it started.
    pub background: bool,
    /// A call that went to the background has ended.
    pub end: Option<TaskEnd>,
    /// Output too long for the stream: where the CLI kept all of it.
    pub persisted_output: Option<PersistedOutput>,
    /// The concrete model a subagent ran on.
    pub resolved_model: Option<String>,
}

/// A command's output the CLI kept in a file (`persistedOutputPath`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedOutput {
    pub path: String,
    /// Its whole size, when the CLI says.
    pub bytes: Option<u64>,
}

/// How a background call ended (Claude Code's `task_notification`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskEnd {
    /// `completed`, `failed` or `stopped`.
    pub status: String,
    pub summary: Option<String>,
    /// Where the CLI kept its output, when it says.
    pub output_file: Option<String>,
    pub duration_ms: Option<u64>,
}

/// What a background task is (Claude Code's `task_type`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundTaskKind {
    /// `local_bash`
    Command,
    /// `local_agent`
    Subagent,
}

/// One background task, as the CLI's running set lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackgroundTaskInfo {
    pub id: String,
    pub kind: BackgroundTaskKind,
    pub description: String,
}

/// A request written to a running CLI's stdin that it answers
/// ([`AgentEvent::ControlResponse`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlRequest {
    /// End one background task (`stop_task`).
    StopTask { task_id: String },
    /// End the running turn; background tasks go on (`interrupt`).
    Interrupt,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    /// The background tasks running now (Claude Code's
    /// `background_tasks_changed`): the whole set, each time it changes.
    BackgroundTasks {
        tasks: Vec<BackgroundTaskInfo>,
    },
    /// A task started (`task_started`), foreground or background: `tool_use_id`
    /// is the call it's the running end of.
    TaskStarted {
        id: String,
        tool_use_id: Option<String>,
        description: String,
        kind: BackgroundTaskKind,
        backgrounded: bool,
    },
    /// A task's status changed (`task_updated`): `end_time` once it is over,
    /// `backgrounded` when a foreground call moved to the background.
    TaskStatus {
        id: String,
        status: Option<String>,
        end_time: Option<u64>,
        backgrounded: Option<bool>,
    },
    /// A task ended (`task_notification`): how, and the file it wrote.
    TaskEnded {
        id: String,
        tool_use_id: Option<String>,
        status: String,
        summary: Option<String>,
        output_file: Option<String>,
    },
    /// Comes just before a `Done`/`Error` that does not end the run: the
    /// process stays open for its background tasks (docs/spaces.md "Background
    /// tasks"), and the events go on.
    Lingering,
    /// The CLI started a turn by itself (a background task's end): no message
    /// of ours opens it. Only while no turn is open.
    FollowUp,
    /// The process was stopped by its linger cap with tasks still running.
    TasksCapped,
    /// The CLI's answer to a [`ControlRequest`]: `error` if it refused.
    ControlResponse {
        request_id: String,
        error: Option<String>,
    },
    Text {
        text: String,
    },
    /// A piece of the answer's text as it is generated (only with
    /// [`AgentRequest::stream_text`]). The finished message still comes as
    /// `Text`: deltas are extra, never a replacement.
    TextDelta {
        text: String,
    },
    /// A new text block starts: the deltas after this aren't the same
    /// paragraph as the ones before, even with no tool between them. Only a
    /// streaming CLI that marks its blocks sends it.
    TextStart,
    /// Something a subagent did (Claude Code's `parent_tool_use_id`), under
    /// the `Task`/`Agent` call `parent` that started it. `event` is its text,
    /// thinking, tool call or result; never part of the run's own answer.
    Nested {
        parent: String,
        event: Box<AgentEvent>,
    },
    Thinking {
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    ToolResult {
        id: String,
        ok: bool,
        output: String,
    },
    /// What a call's stream says beyond its result's text: separate stdout and
    /// stderr, the exit code, that it went to the background or ended there.
    /// Comes just before that `ToolResult`; a stream without it still works.
    ToolDetail {
        id: String,
        detail: ToolResultDetail,
    },
    Usage {
        usage: Usage,
    },
    Stalled,
    /// The plan a plan-mode run handed in (Claude Code's `ExitPlanMode`
    /// input, or the plan file it wrote), next to the run's own events.
    /// The last one counts; a run that reports none planned in its text.
    Plan {
        text: String,
    },
    /// The CLI's session id for this run (Claude Code's `session_id`,
    /// Codex's `thread_id`): what [`AgentRequest::resume`] takes to continue
    /// it. May come more than once; the last one counts.
    Session {
        id: String,
    },
    Done {
        final_text: String,
        usage: Usage,
    },
    Error {
        message: String,
        stderr_tail: String,
    },
}

/// The `error.code` of a run that failed because the agent's own servers
/// couldn't be reached (docs/telemetry.md): an expected state, not a crash.
pub const AGENT_OFFLINE_CODE: &str = "agent.offline";

/// What a CLI says when it can't reach its API: Node's (Claude Code,
/// Gemini) socket errors, Claude Code's own wording, and Codex's (Rust
/// `reqwest`/`hyper`). Matched case-insensitively against the error
/// message and stderr, never against the agent's own text.
const CONNECTION_FAILURE_MARKERS: &[&str] = &[
    "enotfound",
    "getaddrinfo",
    "econnrefused",
    "econnreset",
    "etimedout",
    "enetunreach",
    "ehostunreach",
    "connection error",
    "unable to connect to api",
    "fetch failed",
    "network error",
    "network is unreachable",
    "error sending request",
    "stream disconnected",
    "dns error",
    "failed to lookup address",
    "tcp connect error",
    "connection refused",
];

/// Whether an agent CLI's error output says it couldn't reach its servers.
pub fn is_connection_failure(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    CONNECTION_FAILURE_MARKERS.iter().any(|m| text.contains(m))
}

const OFFLINE_SUFFIX: &str = "'s servers — check your connection";

/// The message a run ends with when the agent couldn't reach its servers.
/// `agent` is the CLI name (`claude`, `codex`, `gemini`).
pub fn offline_message(agent: &str) -> String {
    let mut chars = agent.chars();
    let label: String = match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => "the agent".into(),
    };
    format!("Couldn't reach {label}{OFFLINE_SUFFIX}")
}

/// The `offline_message` inside `text`, if there is one: how a caller that
/// only gets the run's error text (grouping) tells offline from a crash.
pub fn offline_message_in(text: &str) -> Option<&str> {
    let start = text.find("Couldn't reach ")?;
    let end = start + text[start..].find(OFFLINE_SUFFIX)? + OFFLINE_SUFFIX.len();
    Some(&text[start..end])
}

/// The `error.code` of a run that failed because the agent CLI isn't
/// signed in (or its key was refused): an expected state, fixed by the
/// user in a terminal, not a crash.
pub const AGENT_SIGNED_OUT_CODE: &str = "agent.signed_out";

/// What the CLIs say when they have no valid credentials: Codex's HTTP
/// status line and its missing-header body, Claude Code's `/login`
/// prompts and 401 wording, Gemini's auth-method and API-key errors.
/// Matched case-insensitively against the error message and stderr, never
/// against the agent's own text.
const AUTH_FAILURE_MARKERS: &[&str] = &[
    "unexpected status 401",
    "401 unauthorized",
    "missing bearer or basic authentication",
    "api error: 401",
    "not logged in",
    "please run /login",
    "invalid api key",
    "invalid bearer token",
    "oauth token has expired",
    "authentication_error",
    "failed to authenticate",
    "unauthenticated",
    "api key not valid",
    "please set an auth method",
];

/// Whether an agent CLI's error output says it has no valid credentials.
pub fn is_auth_failure(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    AUTH_FAILURE_MARKERS.iter().any(|m| text.contains(m))
}

/// The CLIs a run can fail to sign in to, as `(name, label, fix)`. The fix
/// is the command to run in a terminal, from each CLI's own help (`claude
/// auth login`, `codex login`). Gemini CLI has no login command: it asks
/// for a sign-in method the first time it starts.
const SIGN_IN: &[(&str, &str, &str)] = &[
    ("claude", "Claude", "Run `claude auth login` in a terminal."),
    ("codex", "Codex", "Run `codex login` in a terminal."),
    (
        "gemini",
        "Gemini",
        "Run `gemini` in a terminal and pick a sign-in method, or set GEMINI_API_KEY.",
    ),
];

fn signed_out_text(label: &str, fix: &str) -> String {
    format!("{label} isn't signed in. {fix}")
}

/// The message a run ends with when the agent has no valid credentials.
/// `agent` is the CLI name (`claude`, `codex`, `gemini`).
pub fn signed_out_message(agent: &str) -> String {
    match SIGN_IN.iter().find(|(name, ..)| *name == agent) {
        Some((_, label, fix)) => signed_out_text(label, fix),
        None => "The agent isn't signed in. Sign in from its CLI in a terminal.".into(),
    }
}

/// The `signed_out_message` inside `text`, if there is one: how a caller
/// that only gets the run's error text (grouping) tells signed out from a
/// crash.
pub fn signed_out_message_in(text: &str) -> Option<String> {
    SIGN_IN.iter().find_map(|(_, label, fix)| {
        let m = signed_out_text(label, fix);
        text.contains(&m).then_some(m)
    })
}

#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("{0:?} CLI not installed")]
    NotInstalled(AgentId),
    #[error("spawn failed: {0}")]
    Spawn(String),
}

impl AgentError {
    /// The stable error code logged as `error.code` (docs/telemetry.md).
    pub fn code(&self) -> &'static str {
        match self {
            AgentError::NotInstalled(_) => "agent.not_installed",
            AgentError::Spawn(_) => "agent.spawn_failed",
        }
    }
}

/// A running agent. Events end with exactly one `Done` or `Error`, except a
/// run that keeps its process for background tasks, where one `Lingering`
/// precedes each `Done`/`Error` that isn't the last and the events go on.
pub struct AgentRun {
    pub events: mpsc::Receiver<AgentEvent>,
    pub cancel: CancellationToken,
}

/// Sends more of your messages into a run while it works ("Send now",
/// docs/spaces.md §8): the CLI takes each at its next step, in the same
/// turn. Only CLIs that read messages while running give one
/// ([`AgentPort::run_steerable`]); a closed run refuses.
#[derive(Debug, Clone)]
pub struct Steer(mpsc::Sender<SteerMessage>);

/// One message for a running agent, and who to tell once the CLI has it.
#[derive(Debug)]
pub enum SteerMessage {
    /// Your words, as a user message.
    Text {
        text: String,
        delivered: tokio::sync::oneshot::Sender<()>,
    },
    /// A request the CLI answers; `reply` carries its error if it refused.
    Control {
        request: ControlRequest,
        reply: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
}

impl Steer {
    /// The handle, and the end the runner reads.
    pub fn channel() -> (Steer, mpsc::Receiver<SteerMessage>) {
        let (tx, rx) = mpsc::channel(16);
        (Steer(tx), rx)
    }

    /// `true` once the message is written to the CLI; `false` when the run
    /// already finished (or is finishing) and can't take it.
    pub async fn send(&self, text: String) -> bool {
        let (delivered, ack) = tokio::sync::oneshot::channel();
        if self
            .0
            .send(SteerMessage::Text { text, delivered })
            .await
            .is_err()
        {
            return false;
        }
        ack.await.is_ok()
    }

    /// Writes `request` and waits for the CLI's answer: `Ok` when it did it,
    /// `Err` with its reason when it refused or the run is gone.
    pub async fn control(&self, request: ControlRequest) -> Result<(), String> {
        let (reply, answer) = tokio::sync::oneshot::channel();
        if self
            .0
            .send(SteerMessage::Control { request, reply })
            .await
            .is_err()
        {
            return Err(RUN_GONE.to_string());
        }
        answer.await.unwrap_or_else(|_| Err(RUN_GONE.to_string()))
    }

    /// Stops one background task; see [`Steer::control`].
    pub async fn stop_task(&self, task_id: &str) -> Result<(), String> {
        self.control(ControlRequest::StopTask {
            task_id: task_id.to_string(),
        })
        .await
    }

    /// Ends the running turn without ending the process; see
    /// [`Steer::control`].
    pub async fn interrupt(&self) -> Result<(), String> {
        self.control(ControlRequest::Interrupt).await
    }
}

/// What a control request fails with when the run has ended.
pub const RUN_GONE: &str = "the agent's process is gone";

/// One model an agent CLI can run, and the effort levels it takes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelInfo {
    /// What the CLI's model flag takes (`opus`, `gpt-5.5`).
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    /// Effort levels the model takes, in the CLI's order; empty = none.
    pub efforts: Vec<String>,
    /// The effort the CLI uses when none is passed, when it says.
    pub default_effort: Option<String>,
    /// An earlier version the CLI still runs: listed under "More models".
    #[serde(default)]
    pub older: bool,
}

#[async_trait]
pub trait AgentPort: Send + Sync {
    async fn detect(&self) -> Vec<AgentInfo>;
    async fn run(&self, req: AgentRequest) -> Result<AgentRun, AgentError>;
    /// [`run`](Self::run), plus a [`Steer`] when this agent's CLI takes
    /// messages while it runs (Claude Code). `None`: the caller queues
    /// them for the next run instead (Codex, Gemini).
    async fn run_steerable(
        &self,
        req: AgentRequest,
    ) -> Result<(AgentRun, Option<Steer>), AgentError> {
        self.run(req).await.map(|run| (run, None))
    }
    /// The models `agent` can run, for the model picker. Never fails: an
    /// agent that can't list them (not installed, no listing) gives `[]`.
    async fn models(&self, _agent: AgentId) -> Vec<ModelInfo> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_failures_are_told_from_other_errors() {
        for offline in [
            "Error: getaddrinfo ENOTFOUND api.anthropic.com",
            "connect ECONNREFUSED 127.0.0.1:443",
            "API Error: Connection error.",
            "Unable to connect to API due to poor internet connection",
            "TypeError: fetch failed",
            "stream disconnected before completion: error sending request for url (https://api.openai.com/v1/responses)",
            "dns error: failed to lookup address information: nodename nor servname provided",
        ] {
            assert!(is_connection_failure(offline), "{offline}");
        }
        for other in [
            "claude exited with a non-zero status",
            "unexpected status 401 Unauthorized",
            "No conversation found with session ID: 0000",
        ] {
            assert!(!is_connection_failure(other), "{other}");
        }
    }

    #[test]
    fn auth_failures_are_told_from_other_errors() {
        for signed_out in [
            "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, cf-ray: 9a1",
            "Invalid API key · Please run /login",
            "Not logged in · Please run /login",
            "API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"}}",
            "OAuth token has expired. Please obtain a new token",
            "Please set an Auth method in your settings.json",
            "API key not valid. Please pass a valid API key.",
        ] {
            assert!(is_auth_failure(signed_out), "{signed_out}");
        }
        for other in [
            "claude exited with a non-zero status",
            "Error: getaddrinfo ENOTFOUND api.anthropic.com",
            "No conversation found with session ID: 0000",
            "unexpected status 500 Internal Server Error",
        ] {
            assert!(!is_auth_failure(other), "{other}");
        }
    }

    #[test]
    fn the_signed_out_message_names_the_agent_and_its_own_command() {
        assert_eq!(
            signed_out_message("codex"),
            "Codex isn't signed in. Run `codex login` in a terminal."
        );
        assert_eq!(
            signed_out_message("claude"),
            "Claude isn't signed in. Run `claude auth login` in a terminal."
        );
        assert!(signed_out_message("gemini").starts_with("Gemini isn't signed in. Run `gemini`"));
        for agent in ["claude", "codex", "gemini"] {
            let m = signed_out_message(agent);
            let wrapped = format!("agent run failed: {m}: unexpected status 401");
            assert_eq!(signed_out_message_in(&wrapped), Some(m), "{agent}");
        }
        assert_eq!(signed_out_message_in("agent run failed: boom"), None);
    }

    #[test]
    fn the_offline_message_names_the_agent_and_is_found_again() {
        let m = offline_message("claude");
        assert_eq!(m, "Couldn't reach Claude's servers — check your connection");
        let wrapped = format!("agent run failed: {m}: getaddrinfo ENOTFOUND");
        assert_eq!(offline_message_in(&wrapped), Some(m.as_str()));
        assert_eq!(offline_message_in("agent run failed: boom"), None);
    }
}
