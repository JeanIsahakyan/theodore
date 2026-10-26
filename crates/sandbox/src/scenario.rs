//! `scenario.json`: the whole simulated world — people, repos (branches and
//! commits with real file contents), PRs with their review state, faults,
//! and a timeline of events. Loaded once; after the first run the sandbox's
//! persisted state is the source of truth (docs/sandbox.md).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use theodore_domain::{CheckStatus, Millis};

use crate::error::{SandboxError, SandboxResult};

pub const SCENARIO_FILE: &str = "scenario.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scenario {
    pub name: String,
    /// Login of the user Theodore is signed in as.
    pub viewer: String,
    #[serde(default)]
    pub users: Vec<UserSpec>,
    #[serde(default)]
    pub teams: Vec<TeamSpec>,
    #[serde(default)]
    pub repos: Vec<RepoSpec>,
    #[serde(default)]
    pub prs: Vec<PrSpec>,
    /// Projects added on first start (host repos and local folders).
    #[serde(default)]
    pub projects: Vec<ProjectSpec>,
    /// `real` (installed agent CLIs) or `replay` (deterministic, no tokens).
    #[serde(default)]
    pub agents: AgentsMode,
    /// With `replay` agents, a project config's `review.auto_skills` runs
    /// only when this is on (docs/config.md §1).
    #[serde(default)]
    pub auto_skills: bool,
    #[serde(default)]
    pub faults: FaultConfig,
    #[serde(default)]
    pub ci: CiConfig,
    #[serde(default)]
    pub timeline: Vec<EventSpec>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentsMode {
    #[default]
    Real,
    Replay,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSpec {
    pub login: String,
    #[serde(default)]
    pub name: Option<String>,
    /// A `data:` URL, or `null` for no avatar.
    #[serde(default)]
    pub avatar: Option<String>,
    #[serde(default)]
    pub bot: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamSpec {
    pub slug: String,
    #[serde(default)]
    pub members: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoSpec {
    pub owner: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub private: bool,
    #[serde(default = "default_branch")]
    pub default_branch: String,
    /// `false`: not served by the sandbox host — only materialised for a
    /// local folder project.
    #[serde(default = "yes")]
    pub hosted: bool,
    /// Branch protection: a PR behind its base reports `Behind`.
    #[serde(default)]
    pub require_up_to_date: bool,
    /// Branches in creation order; a branch's `from` must come before it.
    #[serde(default)]
    pub branches: Vec<BranchSpec>,
}

impl RepoSpec {
    pub fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }
}

fn default_branch() -> String {
    "main".into()
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchSpec {
    pub name: String,
    /// Branch this one starts from; `None` for the root branch.
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub commits: Vec<CommitSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitSpec {
    pub message: String,
    pub author: String,
    /// How long before the first start this commit was made: `90s`, `15m`,
    /// `2h`, `3d`, `1w`.
    #[serde(default)]
    pub ago: Option<String>,
    #[serde(default)]
    pub files: Vec<FileSpec>,
}

/// One file change. Exactly one content source (`text`, `base64`, `asset`)
/// unless the change is a `delete` or a pure rename.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FileSpec {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
    /// Path relative to the scenario directory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub delete: bool,
    /// Move `rename_from` to `path` (keeping its content unless one is given).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rename_from: Option<String>,
}

impl FileSpec {
    pub fn text(path: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            text: Some(text.into()),
            ..Self::default()
        }
    }

    /// The new content, `None` when the change carries none (delete, or a
    /// rename that keeps the old bytes).
    pub fn content(&self, scenario_dir: &Path) -> SandboxResult<Option<Vec<u8>>> {
        if let Some(t) = &self.text {
            return Ok(Some(t.clone().into_bytes()));
        }
        if let Some(b) = &self.base64 {
            return base64::engine::general_purpose::STANDARD
                .decode(b.trim())
                .map(Some)
                .map_err(|e| SandboxError::Scenario(format!("{}: bad base64: {e}", self.path)));
        }
        if let Some(a) = &self.asset {
            let p = scenario_dir.join(a);
            return std::fs::read(&p)
                .map(Some)
                .map_err(|e| SandboxError::Io(p, e));
        }
        Ok(None)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrStateSpec {
    #[default]
    Open,
    Draft,
    Merged,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrSpec {
    /// `owner/name`.
    pub repo: String,
    pub number: u64,
    pub title: String,
    #[serde(default)]
    pub body: String,
    pub author: String,
    /// Head branch.
    pub head: String,
    /// Base branch; the repo's default branch when omitted.
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub state: PrStateSpec,
    #[serde(default)]
    pub created_ago: Option<String>,
    #[serde(default)]
    pub updated_ago: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub assignees: Vec<String>,
    #[serde(default)]
    pub reviewers: Vec<ReviewerSpec>,
    #[serde(default)]
    pub checks: Vec<CheckSpec>,
    #[serde(default)]
    pub threads: Vec<ThreadSpec>,
    #[serde(default)]
    pub required_approvals: Option<u32>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewerStateSpec {
    #[default]
    Requested,
    Approved,
    ChangesRequested,
    Commented,
}

/// A requested reviewer (`state: requested`, user or team) or a submitted
/// review (any other state, user only).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewerSpec {
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub team: Option<String>,
    #[serde(default)]
    pub state: ReviewerStateSpec,
    #[serde(default)]
    pub ago: Option<String>,
    #[serde(default)]
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckSpec {
    pub name: String,
    pub status: CheckStatus,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub url: Option<String>,
    /// Scripted transition: becomes `then` this long after the first start.
    #[serde(default)]
    pub after: Option<String>,
    #[serde(default)]
    pub then: Option<CheckStatus>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SideSpec {
    Old,
    #[default]
    New,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadSpec {
    pub path: String,
    pub line: u32,
    #[serde(default)]
    pub side: SideSpec,
    #[serde(default)]
    pub start_line: Option<u32>,
    #[serde(default)]
    pub resolved: bool,
    #[serde(default)]
    pub outdated: bool,
    pub comments: Vec<CommentSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentSpec {
    pub author: String,
    pub body: String,
    #[serde(default)]
    pub ago: Option<String>,
    /// emoji (`+1`, `heart`, …) → logins who reacted.
    #[serde(default)]
    pub reactions: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ProjectSpec {
    /// A host project: `{"repo": "owner/name"}`.
    Host { repo: String },
    /// A local folder project, checked out from a scenario repo:
    /// `{"local": "name", "from": "owner/name"}`.
    Local { local: String, from: String },
}

/// Starting values of every fault; all toggleable at runtime.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FaultConfig {
    #[serde(default)]
    pub latency: bool,
    #[serde(default = "default_latency_ms")]
    pub latency_ms: u64,
    /// Per-call latency on top of `latency_ms`, keyed by host call name
    /// (`get_pr`, `search`, `merge_status`, …). Always applied.
    #[serde(default)]
    pub latency_by_call: BTreeMap<String, u64>,
    #[serde(default)]
    pub offline: bool,
    #[serde(default)]
    pub auth: bool,
    #[serde(default)]
    pub rate_limit: bool,
    #[serde(default = "default_reset_ms")]
    pub rate_limit_reset_ms: u64,
    #[serde(default)]
    pub server_errors: bool,
    #[serde(default = "default_error_rate")]
    pub server_error_rate: f64,
    #[serde(default)]
    pub not_found: bool,
    #[serde(default)]
    pub not_found_prs: Vec<u64>,
    #[serde(default)]
    pub slow_merge_status: bool,
    #[serde(default = "default_slow_ms")]
    pub slow_merge_status_ms: u64,
    #[serde(default)]
    pub merge_queue: bool,
    #[serde(default)]
    pub required_approvals: bool,
    #[serde(default = "default_required")]
    pub required_approvals_count: u32,
}

fn default_latency_ms() -> u64 {
    400
}
fn default_reset_ms() -> u64 {
    60_000
}
fn default_error_rate() -> f64 {
    0.3
}
fn default_slow_ms() -> u64 {
    4_000
}
fn default_required() -> u32 {
    2
}

impl Default for FaultConfig {
    fn default() -> Self {
        Self {
            latency: false,
            latency_ms: default_latency_ms(),
            latency_by_call: BTreeMap::new(),
            offline: false,
            auth: false,
            rate_limit: false,
            rate_limit_reset_ms: default_reset_ms(),
            server_errors: false,
            server_error_rate: default_error_rate(),
            not_found: false,
            not_found_prs: Vec::new(),
            slow_merge_status: false,
            slow_merge_status_ms: default_slow_ms(),
            merge_queue: false,
            required_approvals: false,
            required_approvals_count: default_required(),
        }
    }
}

/// How simulated CI behaves after a push, a re-run, a queue or auto-merge.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CiConfig {
    /// After a push every check goes pending, then `push_result` this long later.
    #[serde(default = "default_ci_after")]
    pub push_after: String,
    #[serde(default = "default_pass")]
    pub push_result: CheckStatus,
    #[serde(default = "default_ci_after")]
    pub rerun_after: String,
    #[serde(default = "default_pass")]
    pub rerun_result: CheckStatus,
    /// A queued PR merges this long after it joined the queue.
    #[serde(default = "default_ci_after")]
    pub queue_after: String,
}

fn default_ci_after() -> String {
    "8s".into()
}
fn default_pass() -> CheckStatus {
    CheckStatus::Pass
}

impl Default for CiConfig {
    fn default() -> Self {
        Self {
            push_after: default_ci_after(),
            push_result: CheckStatus::Pass,
            rerun_after: default_ci_after(),
            rerun_result: CheckStatus::Pass,
            queue_after: default_ci_after(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventSpec {
    pub id: String,
    /// Due this long after the sandbox starts; omitted = fire by hand only.
    #[serde(default)]
    pub at: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    pub action: Action,
}

/// PR selector: a number (unique across the scenario) or `owner/name#n`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PrSel {
    Number(u64),
    Ref(String),
}

impl std::fmt::Display for PrSel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PrSel::Number(n) => write!(f, "#{n}"),
            PrSel::Ref(r) => f.write_str(r),
        }
    }
}

/// Something that happens on the simulated host: a timeline event, or a
/// command from `theodore sandbox …`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "do", rename_all = "snake_case")]
pub enum Action {
    /// A new commit on the PR's head branch. No `files`: a generated edit
    /// of the PR's first changed text file.
    Push {
        pr: PrSel,
        #[serde(default)]
        files: Vec<FileSpec>,
        #[serde(default)]
        message: Option<String>,
        #[serde(default)]
        author: Option<String>,
    },
    /// A new review thread on `path:line`.
    Comment {
        pr: PrSel,
        path: String,
        line: u32,
        #[serde(default)]
        side: SideSpec,
        body: String,
        #[serde(default)]
        author: Option<String>,
    },
    /// A reply on an existing thread (the latest one when `thread` is omitted).
    Reply {
        pr: PrSel,
        #[serde(default)]
        thread: Option<String>,
        body: String,
        #[serde(default)]
        author: Option<String>,
    },
    Review {
        pr: PrSel,
        author: String,
        state: ReviewerStateSpec,
        #[serde(default)]
        body: String,
    },
    /// Requests a review from `user` / `team`; the viewer when both are omitted.
    RequestReview {
        pr: PrSel,
        #[serde(default)]
        user: Option<String>,
        #[serde(default)]
        team: Option<String>,
    },
    /// Merged by someone else (`author`, default the PR author).
    Merge {
        pr: PrSel,
        #[serde(default)]
        author: Option<String>,
    },
    Close {
        pr: PrSel,
    },
    Check {
        pr: PrSel,
        name: String,
        status: CheckStatus,
    },
    Fault {
        name: String,
        on: bool,
        #[serde(default)]
        value: Option<f64>,
    },
    /// Fires a timeline event now (control only).
    Fire {
        event: String,
    },
    /// No-op; answers with the current status (control only).
    Status,
}

impl Action {
    pub fn label(&self) -> String {
        match self {
            Action::Push { pr, .. } => format!("push to {pr}"),
            Action::Comment {
                pr,
                path,
                line,
                author,
                ..
            } => format!(
                "{} comments on {pr} {path}:{line}",
                author.as_deref().unwrap_or("a teammate")
            ),
            Action::Reply { pr, author, .. } => format!(
                "{} replies on {pr}",
                author.as_deref().unwrap_or("a teammate")
            ),
            Action::Review {
                pr, author, state, ..
            } => {
                format!("{author} reviews {pr} ({state:?})")
            }
            Action::RequestReview { pr, user, team } => match (user, team) {
                (_, Some(t)) => format!("review of {pr} requested from team {t}"),
                (Some(u), None) => format!("review of {pr} requested from {u}"),
                (None, None) => format!("review of {pr} requested from you"),
            },
            Action::Merge { pr, author } => format!(
                "{pr} merged by {}",
                author.as_deref().unwrap_or("its author")
            ),
            Action::Close { pr } => format!("{pr} closed"),
            Action::Check { pr, name, status } => format!("{name} on {pr} → {status:?}"),
            Action::Fault { name, on, .. } => {
                format!("fault {name} {}", if *on { "on" } else { "off" })
            }
            Action::Fire { event } => format!("fire {event}"),
            Action::Status => "status".into(),
        }
    }
}

impl Scenario {
    pub fn load(dir: &Path) -> SandboxResult<Scenario> {
        let path = dir.join(SCENARIO_FILE);
        let text = std::fs::read_to_string(&path).map_err(|e| SandboxError::Io(path.clone(), e))?;
        let scenario: Scenario = serde_json::from_str(&text)
            .map_err(|e| SandboxError::Scenario(format!("{}: {e}", path.display())))?;
        scenario.validate()?;
        Ok(scenario)
    }

    pub fn save(&self, dir: &Path) -> SandboxResult<PathBuf> {
        std::fs::create_dir_all(dir).map_err(|e| SandboxError::Io(dir.to_path_buf(), e))?;
        let path = dir.join(SCENARIO_FILE);
        let mut text = serde_json::to_string_pretty(self)
            .map_err(|e| SandboxError::Scenario(e.to_string()))?;
        text.push('\n');
        std::fs::write(&path, text).map_err(|e| SandboxError::Io(path.clone(), e))?;
        Ok(path)
    }

    /// Cheap structural checks so a typo fails at load, not mid-run.
    pub fn validate(&self) -> SandboxResult<()> {
        let bad = |m: String| Err(SandboxError::Scenario(m));
        if !self.users.iter().any(|u| u.login == self.viewer) {
            return bad(format!("viewer {} is not in users", self.viewer));
        }
        for repo in &self.repos {
            let mut seen: Vec<&str> = Vec::new();
            for b in &repo.branches {
                if let Some(from) = &b.from
                    && !seen.contains(&from.as_str())
                {
                    return bad(format!(
                        "{}: branch {} starts from {from}, which isn't defined before it",
                        repo.slug(),
                        b.name
                    ));
                }
                seen.push(&b.name);
            }
            if !seen.contains(&repo.default_branch.as_str()) {
                return bad(format!(
                    "{}: default branch {} has no definition",
                    repo.slug(),
                    repo.default_branch
                ));
            }
        }
        for pr in &self.prs {
            let Some(repo) = self.repos.iter().find(|r| r.slug() == pr.repo) else {
                return bad(format!("PR #{}: unknown repo {}", pr.number, pr.repo));
            };
            for b in [Some(&pr.head), pr.base.as_ref()].into_iter().flatten() {
                if !repo.branches.iter().any(|x| &x.name == b) {
                    return bad(format!("PR #{}: unknown branch {b}", pr.number));
                }
            }
        }
        for e in &self.timeline {
            if let Some(at) = &e.at {
                parse_duration(at)?;
            }
        }
        Ok(())
    }

    pub fn repo(&self, slug: &str) -> Option<&RepoSpec> {
        self.repos.iter().find(|r| r.slug() == slug)
    }
}

/// `90s`, `15m`, `2h`, `3d`, `1w`, `250ms` → milliseconds.
pub fn parse_duration(s: &str) -> SandboxResult<Millis> {
    let s = s.trim();
    let split = s
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(s.len());
    let (num, unit) = s.split_at(split);
    let n: f64 = num
        .parse()
        .map_err(|_| SandboxError::Scenario(format!("bad duration {s:?}")))?;
    let mult = match unit.trim() {
        "ms" => 1.0,
        "" | "s" => 1_000.0,
        "m" => 60_000.0,
        "h" => 3_600_000.0,
        "d" => 86_400_000.0,
        "w" => 7.0 * 86_400_000.0,
        other => {
            return Err(SandboxError::Scenario(format!(
                "bad duration unit {other:?} in {s:?}"
            )));
        }
    };
    Ok((n * mult) as Millis)
}

pub fn ago(s: &Option<String>) -> SandboxResult<Millis> {
    s.as_deref()
        .map(parse_duration)
        .transpose()
        .map(|v| v.unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_parse_every_unit() {
        assert_eq!(parse_duration("250ms").unwrap(), 250);
        assert_eq!(parse_duration("30s").unwrap(), 30_000);
        assert_eq!(parse_duration("30").unwrap(), 30_000);
        assert_eq!(parse_duration("15m").unwrap(), 900_000);
        assert_eq!(parse_duration("2h").unwrap(), 7_200_000);
        assert_eq!(parse_duration("1.5d").unwrap(), 129_600_000);
        assert_eq!(parse_duration("1w").unwrap(), 604_800_000);
        assert!(parse_duration("soon").is_err());
        assert!(parse_duration("3y").is_err());
    }

    #[test]
    fn actions_round_trip_with_a_flat_tag() {
        let a: Action = serde_json::from_str(r#"{"do":"push","pr":12}"#).unwrap();
        assert!(matches!(
            a,
            Action::Push {
                pr: PrSel::Number(12),
                ..
            }
        ));
        let a: Action =
            serde_json::from_str(r#"{"do":"check","pr":"acme/web#3","name":"ci","status":"fail"}"#)
                .unwrap();
        assert!(matches!(
            a,
            Action::Check {
                status: CheckStatus::Fail,
                ..
            }
        ));
    }
}
