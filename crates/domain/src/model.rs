//! Shared models. Field names are the wire names (serde, specta → TS).
//! Timestamps are unix milliseconds (`Millis`).

use serde::{Deserialize, Serialize};

pub type Millis = i64;

macro_rules! id_type {
    ($($name:ident),* $(,)?) => {$(
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[cfg_attr(feature = "specta", derive(specta::Type))]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub fn new(s: impl Into<String>) -> Self { Self(s.into()) }
            pub fn as_str(&self) -> &str { &self.0 }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.0) }
        }
    )*};
}

id_type!(
    PrId, HunkId, GroupId, ThreadId, CommentId, DraftId, FindingId, TaskId, RunId, MessageId,
    SkillId, Sha
);

// ── hosts and PRs ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "lowercase")]
pub enum HostKind {
    Github,
    Gitlab,
    Bitbucket,
    /// A local branch reviewed without a host.
    Local,
}

/// Host-neutral repository reference.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct RepoRef {
    pub host: HostKind,
    pub owner: String,
    pub name: String,
}

impl RepoRef {
    pub fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }
}

/// Host-neutral PR reference. `host_id` is opaque (GitHub node id, GitLab
/// project id + iid, …); the domain never looks inside it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct PrRef {
    pub repo: RepoRef,
    pub number: u64,
    pub host_id: Option<String>,
}

impl PrRef {
    /// Stable local id: `github:owner/repo#12`.
    pub fn id(&self) -> PrId {
        let host = match self.repo.host {
            HostKind::Github => "github",
            HostKind::Gitlab => "gitlab",
            HostKind::Bitbucket => "bitbucket",
            HostKind::Local => "local",
        };
        PrId(format!("{host}:{}#{}", self.repo.slug(), self.number))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum PrState {
    Draft,
    Open,
    Merged,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum InboxReason {
    ReviewRequested,
    TeamReviewRequested,
    Assigned,
    Authored,
    Mentioned,
    UpdatedAfterReview,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum ReviewerState {
    Requested,
    Approved,
    ChangesRequested,
    Commented,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Person {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Reviewer {
    pub person: Person,
    pub state: ReviewerState,
    pub team: Option<String>,
}

/// One row in the inbox / PR lists.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct PrSummary {
    pub pr: PrRef,
    pub title: String,
    pub author: Person,
    pub state: PrState,
    pub base_ref: String,
    pub head_ref: String,
    pub head_sha: Sha,
    pub additions: u32,
    pub deletions: u32,
    pub changed_files: u32,
    pub reasons: Vec<InboxReason>,
    pub checks: CheckRollup,
    pub approvals: u32,
    pub required_approvals: Option<u32>,
    pub updated_at: Millis,
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Pending,
    Pass,
    Fail,
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum CheckRollup {
    None,
    Pending,
    Pass,
    Fail,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Check {
    pub id: String,
    pub name: String,
    pub status: CheckStatus,
    pub url: Option<String>,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Commit {
    pub sha: Sha,
    pub title: String,
    pub author: Person,
    pub at: Millis,
}

/// Everything loaded when a PR is opened (host side; diff comes from git).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct PrDetail {
    pub summary: PrSummary,
    pub body: String,
    pub base_sha: Sha,
    pub commits: Vec<Commit>,
    pub checks: Vec<Check>,
    pub reviewers: Vec<Reviewer>,
    pub assignees: Vec<Person>,
    pub labels: Vec<String>,
    pub threads: Vec<Thread>,
    /// Host-side Viewed per file path (empty if the host has no such feature).
    pub viewed: Vec<FileViewed>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct FileViewed {
    pub path: String,
    pub state: ViewedState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum ViewedState {
    Unviewed,
    Viewed,
    /// Was viewed, then the file changed.
    Dismissed,
}

// ── diff ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Old,
    New,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "lowercase")]
pub enum LineKind {
    Ctx,
    Add,
    Del,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct DiffLine {
    pub kind: LineKind,
    pub text: String,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
}

/// Unit of grouping. Belongs to exactly one group.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Hunk {
    pub id: HunkId,
    pub path: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// Text after the second `@@`, e.g. the enclosing function.
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FileFlag {
    Binary {
        old_size: Option<u64>,
        new_size: Option<u64>,
    },
    Lfs,
    Submodule,
    /// Generated or vendored: lockfiles, linguist-generated, snapshots.
    Generated {
        reason: String,
    },
    /// Over the size limit; hunks omitted.
    Oversize {
        lines: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub similarity: Option<u8>,
    pub old_mode: Option<String>,
    pub new_mode: Option<String>,
    pub flags: Vec<FileFlag>,
    pub additions: u32,
    pub deletions: u32,
    pub hunks: Vec<Hunk>,
}

/// One revision of a PR's diff: `base...head`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Revision {
    pub base: Sha,
    pub head: Sha,
    pub files: Vec<FileDiff>,
}

impl Revision {
    pub fn hunks(&self) -> impl Iterator<Item = &Hunk> {
        self.files.iter().flat_map(|f| f.hunks.iter())
    }
}

// ── anchors and conversation ────────────────────────────────────────────────

/// Host-neutral point in a diff. Adapters map it to host positions.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Anchor {
    /// Head sha the anchor was made against.
    pub rev: Sha,
    pub path: String,
    pub side: Side,
    pub line: u32,
    /// Multi-line range start (same side unless `start_side` is set).
    pub start_line: Option<u32>,
    pub start_side: Option<Side>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Comment {
    pub id: CommentId,
    pub author: Person,
    pub body: String,
    pub created_at: Millis,
    pub edited: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Thread {
    pub id: ThreadId,
    pub anchor: Option<Anchor>,
    pub resolved: bool,
    pub outdated: bool,
    pub comments: Vec<Comment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "lowercase")]
pub enum AgentId {
    Claude,
    Codex,
    Gemini,
}

impl AgentId {
    pub const ALL: [AgentId; 3] = [AgentId::Claude, AgentId::Codex, AgentId::Gemini];
    pub fn as_str(self) -> &'static str {
        match self {
            AgentId::Claude => "claude",
            AgentId::Codex => "codex",
            AgentId::Gemini => "gemini",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "kind", content = "agent", rename_all = "lowercase")]
pub enum Author {
    Me,
    Agent(AgentId),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Draft {
    pub id: DraftId,
    pub pr: PrId,
    pub anchor: Anchor,
    pub body: String,
    pub source: Author,
    /// A push moved the diff out from under this anchor (plan §4):
    /// `domain::anchors::remap` returned `Outdated`. An outdated draft must
    /// not be submitted — the caller has to re-anchor or drop it.
    #[serde(default)]
    pub outdated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewEvent {
    Comment,
    Approve,
    RequestChanges,
}

// ── groups ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "lowercase")]
pub enum GroupKind {
    Normal,
    /// Mechanical: renames, formatting, imports.
    Skim,
    /// Lockfiles, generated code; collapsed.
    Hidden,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Group {
    pub id: GroupId,
    pub title: String,
    pub why: String,
    pub kind: GroupKind,
    pub risk: Option<String>,
    pub check: Vec<String>,
    pub hunks: Vec<HunkId>,
    /// Hunks that break a mechanical group's pattern; shown first.
    pub outliers: Vec<HunkId>,
}

/// A full grouping of one revision. `groups` are in reading order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Grouping {
    pub rev: Sha,
    pub groups: Vec<Group>,
}

// ── findings, fixes, tasks ──────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Warn,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum FindingState {
    Open,
    Drafted,
    Ignored,
    MaybeFixed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Patch {
    pub path: String,
    pub before: Vec<String>,
    pub after: Vec<String>,
    pub note: String,
    pub by: AgentId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum FixStatus {
    Generating,
    Ready,
    Applied,
    Suggested,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Fix {
    pub status: FixStatus,
    pub patch: Option<Patch>,
    /// Commit that applied it (own PR) — `None` for suggestions.
    pub commit: Option<Sha>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Finding {
    pub id: FindingId,
    pub pr: PrId,
    pub skill: SkillId,
    /// Every agent that reported it.
    pub agents: Vec<AgentId>,
    pub anchor: Anchor,
    pub severity: Severity,
    pub title: String,
    pub body: String,
    pub state: FindingState,
    pub fix: Option<Fix>,
    /// A push moved the diff out from under this anchor (plan §4).
    #[serde(default)]
    pub outdated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Todo,
    Progress,
    /// Agent fix waiting for a human ("To verify").
    Review,
    Done,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "kind", content = "id", rename_all = "lowercase")]
pub enum Assignee {
    Human(String),
    Agent(AgentId),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Task {
    pub id: TaskId,
    pub pr: PrId,
    pub title: String,
    pub body: String,
    pub anchor: Option<Anchor>,
    pub thread: Option<ThreadId>,
    pub status: TaskStatus,
    pub assignee: Assignee,
    pub fix: Option<Fix>,
    pub created_at: Millis,
    /// A push moved the diff out from under this task's anchor (plan §4);
    /// `None` anchor tasks are never affected.
    #[serde(default)]
    pub outdated: bool,
}

// ── reading, snooze, usage ──────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SnoozeUntil {
    Time { at: Millis },
    NextPush,
    ChecksGreen,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub usd: f64,
}

impl std::ops::AddAssign for Usage {
    fn add_assign(&mut self, o: Self) {
        self.input_tokens += o.input_tokens;
        self.output_tokens += o.output_tokens;
        self.usd += o.usd;
    }
}
