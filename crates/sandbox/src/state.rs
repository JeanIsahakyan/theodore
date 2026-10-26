//! The sandbox host's mutable state: PRs with reviews, threads, reactions,
//! reviewers, checks and merge state. Seeded from the scenario on the first
//! run, persisted to `<sandbox>/state.json` after every change, and the
//! source of truth from then on. Git (heads, bases, commits) is never
//! duplicated here: it's read from the bare repos.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use theodore_domain::{CheckStatus, Millis, PrState, Side, ViewedState};
use theodore_ports::MergeMethod;

use crate::error::{SandboxError, SandboxResult};
use crate::scenario::FaultConfig;

pub const STATE_FILE: &str = "state.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct State {
    /// When the sandbox was first materialised; every scenario `ago` is
    /// relative to it.
    pub epoch: Millis,
    /// Bumped on every change; `changed_since` cursors are this number.
    pub version: u64,
    pub next_id: u64,
    pub prs: Vec<PrRec>,
    /// Timeline events already fired (never fired twice).
    #[serde(default)]
    pub fired: BTreeSet<String>,
    pub faults: FaultConfig,
    /// When the active rate limit lifts (`faults.rate_limit`).
    #[serde(default)]
    pub rate_limit_reset_at: Option<Millis>,
    /// Projects already added to Theodore on a first start.
    #[serde(default)]
    pub projects_seeded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrRec {
    pub owner: String,
    pub repo: String,
    pub number: u64,
    pub node_id: String,
    pub title: String,
    pub body: String,
    pub author: String,
    pub head_ref: String,
    pub base_ref: String,
    pub state: PrState,
    pub created_at: Millis,
    pub updated_at: Millis,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub assignees: Vec<String>,
    #[serde(default)]
    pub requested_users: Vec<String>,
    #[serde(default)]
    pub requested_teams: Vec<String>,
    #[serde(default)]
    pub reviews: Vec<ReviewRec>,
    #[serde(default)]
    pub checks: Vec<CheckRec>,
    #[serde(default)]
    pub threads: Vec<ThreadRec>,
    /// The viewer's per-file Viewed state.
    #[serde(default)]
    pub viewed: BTreeMap<String, ViewedState>,
    /// Last head seen; a different `refs/heads/<head_ref>` tip is a push.
    pub head_sha: String,
    /// Base and head frozen at merge/close time.
    #[serde(default)]
    pub frozen: Option<(String, String)>,
    #[serde(default)]
    pub merged_by: Option<String>,
    #[serde(default)]
    pub merge_commit: Option<String>,
    #[serde(default)]
    pub auto_merge: Option<MergeMethod>,
    #[serde(default)]
    pub queued_at: Option<Millis>,
    #[serde(default)]
    pub required_approvals: Option<u32>,
    /// Bumped on every change to this PR; part of its ETag.
    pub version: u64,
}

impl PrRec {
    pub fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }

    pub fn key(&self) -> String {
        format!("{}#{}", self.slug(), self.number)
    }

    pub fn is_open(&self) -> bool {
        matches!(self.state, PrState::Open | PrState::Draft)
    }

    /// Latest review per user (a later one supersedes an earlier one,
    /// except that a plain comment never clears an approval).
    pub fn latest_reviews(&self) -> Vec<&ReviewRec> {
        let mut by_user: BTreeMap<&str, &ReviewRec> = BTreeMap::new();
        for r in &self.reviews {
            match by_user.get(r.user.as_str()) {
                Some(prev)
                    if r.state == ReviewState::Commented
                        && prev.state != ReviewState::Commented => {}
                _ => {
                    by_user.insert(&r.user, r);
                }
            }
        }
        let mut out: Vec<&ReviewRec> = by_user.into_values().collect();
        out.sort_by_key(|r| r.at);
        out
    }

    pub fn approvals(&self) -> u32 {
        self.latest_reviews()
            .iter()
            .filter(|r| r.state == ReviewState::Approved)
            .count() as u32
    }

    pub fn changes_requested(&self) -> bool {
        self.latest_reviews()
            .iter()
            .any(|r| r.state == ReviewState::ChangesRequested)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewState {
    Approved,
    ChangesRequested,
    Commented,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewRec {
    pub id: String,
    pub user: String,
    pub state: ReviewState,
    #[serde(default)]
    pub body: String,
    pub at: Millis,
    #[serde(default)]
    pub commit: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckRec {
    pub id: String,
    pub name: String,
    pub status: CheckStatus,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    /// Becomes `.1` at `.0`.
    #[serde(default)]
    pub transition: Option<(Millis, CheckStatus)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadRec {
    pub id: String,
    pub path: String,
    pub line: u32,
    pub side: Side,
    #[serde(default)]
    pub start_line: Option<u32>,
    pub resolved: bool,
    pub outdated: bool,
    pub comments: Vec<CommentRec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommentRec {
    pub id: String,
    pub author: String,
    pub body: String,
    pub at: Millis,
    #[serde(default)]
    pub edited: bool,
    /// emoji → logins.
    #[serde(default)]
    pub reactions: BTreeMap<String, BTreeSet<String>>,
}

impl State {
    pub fn path(root: &Path) -> PathBuf {
        root.join(STATE_FILE)
    }

    pub fn load(root: &Path) -> SandboxResult<Option<State>> {
        let path = Self::path(root);
        match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text)
                .map(Some)
                .map_err(|e| SandboxError::State(format!("{}: {e}", path.display()))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(SandboxError::Io(path, e)),
        }
    }

    /// Atomic: written to a temp file, then renamed over the old one.
    pub fn save(&self, root: &Path) -> SandboxResult<()> {
        let path = Self::path(root);
        let tmp = root.join(format!("{STATE_FILE}.tmp"));
        let text =
            serde_json::to_string_pretty(self).map_err(|e| SandboxError::State(e.to_string()))?;
        std::fs::write(&tmp, text).map_err(|e| SandboxError::Io(tmp.clone(), e))?;
        std::fs::rename(&tmp, &path).map_err(|e| SandboxError::Io(path, e))
    }

    pub fn next_id(&mut self, prefix: &str) -> String {
        self.next_id += 1;
        format!("{prefix}{}", self.next_id)
    }

    /// Marks `pr` changed: a new ETag and a `changed_since` hit.
    pub fn touch(&mut self, idx: usize, now: Millis) {
        self.version += 1;
        let v = self.version;
        let pr = &mut self.prs[idx];
        pr.version = v;
        pr.updated_at = pr.updated_at.max(now);
    }

    /// Like `touch`, without moving `updated_at` (CI transitions).
    pub fn bump(&mut self, idx: usize) {
        self.version += 1;
        self.prs[idx].version = self.version;
    }
}
