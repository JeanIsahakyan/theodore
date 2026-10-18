//! UI ⇄ core contract (plan §3). Rust is the source of truth; TS is generated
//! into `ui/src/gen/contract.ts` by `cargo run -p theodore-contract --bin export-ts`.

use serde::{Deserialize, Serialize};
use specta::Type;
use theodore_domain::{
    AgentId, Anchor, Author, Draft, Finding, Group, Grouping, HostKind, HunkId, Millis, Person,
    PrDetail, PrId, PrSummary, ReviewEvent, Revision, Sha, SnoozeUntil, Task, TaskId, Thread,
    ThreadId, Usage, ViewedState,
};

/// Model names used in transactions and sync frames.
pub mod models {
    pub const PR: &str = "pr";
    pub const PR_DETAIL: &str = "pr_detail";
    pub const GROUPING: &str = "grouping";
    pub const HUNK_READ: &str = "hunk_read";
    pub const FILE_VIEWED: &str = "file_viewed";
    pub const THREAD: &str = "thread";
    pub const DRAFT: &str = "draft";
    pub const FINDING: &str = "finding";
    pub const TASK: &str = "task";
    pub const SKILL_RUN: &str = "skill_run";
    pub const CHAT_MESSAGE: &str = "chat_message";
    pub const INBOX_STATE: &str = "inbox_state";
    pub const SETTING: &str = "setting";
    pub const ALL: &[&str] = &[
        PR,
        PR_DETAIL,
        GROUPING,
        HUNK_READ,
        FILE_VIEWED,
        THREAD,
        DRAFT,
        FINDING,
        TASK,
        SKILL_RUN,
        CHAT_MESSAGE,
        INBOX_STATE,
        SETTING,
    ];
}

// ── sync (core → UI) ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum SyncCode {
    I,
    U,
    C,
    A,
    D,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct WireAction {
    pub id: u64,
    pub model: String,
    pub model_id: String,
    pub action: SyncCode,
    #[specta(type = Option<specta_typescript::Unknown>)]
    pub data: Option<serde_json::Value>,
}

/// Event `sync`: covers `(from_sync_id, last_sync_id]`. A UI whose own
/// `lastSyncId < from_sync_id` missed a frame and calls `catch_up`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SyncFrame {
    pub from_sync_id: u64,
    pub last_sync_id: u64,
    pub actions: Vec<WireAction>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct WireRow {
    pub model: String,
    pub id: String,
    #[specta(type = specta_typescript::Unknown)]
    pub data: serde_json::Value,
    pub archived: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Bootstrap {
    pub last_sync_id: u64,
    pub rows: Vec<WireRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "scope", content = "pr", rename_all = "snake_case")]
pub enum BootstrapScope {
    /// Inbox rows, settings, tasks — everything not tied to an open PR.
    Global,
    /// Models of one open PR (lazy load).
    Pr(PrId),
}

// ── transactions (UI → core) ────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum MutationOp {
    Create {
        model: String,
        id: String,
        #[specta(type = specta_typescript::Unknown)]
        data: serde_json::Value,
    },
    /// `data` holds changed fields only.
    Update {
        model: String,
        id: String,
        #[specta(type = specta_typescript::Unknown)]
        data: serde_json::Value,
    },
    Archive {
        model: String,
        id: String,
    },
    Delete {
        model: String,
        id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Transaction {
    /// Client-generated, for de-duplication on retry.
    pub id: String,
    pub ops: Vec<MutationOp>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum TransactionResult {
    Ok {
        last_sync_id: u64,
    },
    /// Rejected by domain validation; the UI rolls back.
    Rejected {
        reason: String,
    },
}

// ── commands (request/response) ─────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct OpenPrRequest {
    /// Host URL (`https://github.com/o/r/pull/12`) or local id.
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct OpenPrResponse {
    pub pr: PrId,
    pub head: Sha,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct RevisionRequest {
    pub pr: PrId,
    pub head: Sha,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FileRequest {
    pub pr: PrId,
    pub rev: Sha,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct RunSkillRequest {
    pub pr: PrId,
    pub skill: String,
    /// Empty = use the `agents.skills` setting.
    pub agents: Vec<AgentId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct AskRequest {
    pub pr: PrId,
    pub question: String,
    pub about: Option<Anchor>,
    pub group: Option<String>,
    pub agent: Option<AgentId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SubmitReviewRequest {
    pub pr: PrId,
    pub event: ReviewEvent,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct AgentStatus {
    pub id: AgentId,
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct AppInfo {
    pub version: String,
    pub channel: String,
    pub update: Option<UpdateInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct UpdateInfo {
    pub version: String,
    pub notes: String,
    pub downloaded: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TokenSource {
    Keychain,
    Gh,
    Env,
    None,
}

/// Host connection state for onboarding and Settings → Account.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct HostAuthStatus {
    pub host: HostKind,
    pub connected: bool,
    pub login: Option<String>,
    pub source: TokenSource,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SetTokenRequest {
    pub host: HostKind,
    /// `None` removes the stored token.
    pub token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ReplyRequest {
    pub pr: PrId,
    pub thread: ThreadId,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ResolveRequest {
    pub pr: PrId,
    pub thread: ThreadId,
    pub resolved: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SkillInfo {
    pub id: String,
    pub title: String,
    pub description: String,
    /// `built-in`, `~/.claude/skills` or `<owner>/<repo> · .claude/skills`
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct DelegateRequest {
    pub task: TaskId,
    /// Empty = use the `agents.fix` setting.
    pub agent: Option<AgentId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct TaskDecision {
    pub task: TaskId,
    pub accept: bool,
    /// Why a fix was rejected (sent back to the agent on the next attempt).
    pub reason: Option<String>,
}

// ── ephemeral events (core → UI, not persisted) ─────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Ephemeral {
    AgentDelta {
        run: String,
        agent: AgentId,
        text: String,
    },
    RunLog {
        run: String,
        agent: AgentId,
        line: String,
    },
    Toast {
        level: ToastLevel,
        text: String,
    },
    HostStatus {
        online: bool,
        rate_limited_until: Option<Millis>,
        auth_ok: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ToastLevel {
    Info,
    Warn,
    Error,
}

// ── synced model payloads (data of WireRow / WireAction) ────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct InboxState {
    pub pr: PrId,
    pub done: bool,
    pub snooze: Option<SnoozeUntil>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct HunkRead {
    pub pr: PrId,
    pub hunk: HunkId,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct FileViewedRow {
    pub pr: PrId,
    pub path: String,
    pub state: ViewedState,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    Done,
    Cancelled,
    Failed,
    Stalled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SkillRun {
    pub id: String,
    pub pr: PrId,
    pub skill: String,
    pub agents: Vec<AgentId>,
    pub status: RunStatus,
    pub usage: Usage,
    pub error: Option<String>,
    pub started_at: Millis,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct ChatMessage {
    pub id: String,
    pub pr: PrId,
    pub author: Author,
    pub text: String,
    pub refs: Vec<Anchor>,
    pub usage: Option<Usage>,
    pub at: Millis,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Setting {
    /// e.g. `agents.grouping`, `updates.channel`
    pub key: String,
    /// `user` or `repo:<owner>/<name>`
    pub scope: String,
    #[specta(type = specta_typescript::Unknown)]
    pub value: serde_json::Value,
}

/// Registers every type exported to TS.
pub fn types() -> specta::Types {
    let t = specta::Types::default()
        .register::<SyncFrame>()
        .register::<Bootstrap>()
        .register::<BootstrapScope>()
        .register::<Transaction>()
        .register::<TransactionResult>()
        .register::<OpenPrRequest>()
        .register::<OpenPrResponse>()
        .register::<RevisionRequest>()
        .register::<FileRequest>()
        .register::<RunSkillRequest>()
        .register::<AskRequest>()
        .register::<SubmitReviewRequest>()
        .register::<AgentStatus>()
        .register::<AppInfo>()
        .register::<CommandError>()
        .register::<Ephemeral>()
        .register::<InboxState>()
        .register::<HunkRead>()
        .register::<FileViewedRow>()
        .register::<SkillRun>()
        .register::<ChatMessage>()
        .register::<Setting>()
        .register::<PrSummary>()
        .register::<PrDetail>()
        .register::<Revision>()
        .register::<Grouping>()
        .register::<Group>()
        .register::<Thread>()
        .register::<Draft>()
        .register::<Finding>()
        .register::<Task>()
        .register::<Person>()
        .register::<HostAuthStatus>()
        .register::<SetTokenRequest>()
        .register::<ReplyRequest>()
        .register::<ResolveRequest>()
        .register::<SkillInfo>()
        .register::<DelegateRequest>()
        .register::<TaskDecision>();
    // JS numbers: ids, counts and unix-ms timestamps stay far below 2^53.
    use specta::datatype::Primitive as P;
    specta_util::Remapper::new()
        .rule(P::i64.into(), P::i32.into())
        .rule(P::u64.into(), P::u32.into())
        .rule(P::usize.into(), P::u32.into())
        .remap_types(t)
}
