//! Git port (plan §7). Implemented over the git CLI.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use theodore_domain::{PrRef, RepoRef, Revision, Sha};

#[derive(Debug, thiserror::Error)]
pub enum GitError {
    #[error("git not found")]
    NotInstalled,
    #[error("git {args}: exit {code}: {stderr}")]
    Command {
        args: String,
        code: i32,
        stderr: String,
    },
    #[error("auth failed for {0}")]
    Auth(String),
    #[error("parse: {0}")]
    Parse(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("not supported: {0}")]
    Unsupported(&'static str),
}

pub type GitResult<T> = Result<T, GitError>;

#[derive(Debug, Clone)]
pub struct DiffOptions {
    pub context: u32,
    pub find_renames: bool,
    /// Files over this many changed lines get `FileFlag::Oversize` and no hunks.
    pub max_file_lines: u32,
}

impl Default for DiffOptions {
    fn default() -> Self {
        Self {
            context: 3,
            find_renames: true,
            max_file_lines: 5_000,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Worktree {
    pub path: PathBuf,
    pub head: Sha,
}

/// Provides an HTTPS token for a remote at call time (never written to disk).
pub trait CredentialSource: Send + Sync {
    fn token_for(&self, repo: &RepoRef) -> Option<String>;
}

#[async_trait]
pub trait GitPort: Send + Sync {
    /// Bare clone under `~/.theodore/repos/…`, or fetch if present. Returns its path.
    async fn ensure_repo(&self, repo: &RepoRef) -> GitResult<PathBuf>;
    /// Fetch `pull/<n>/head` (or the host's equivalent) and return its sha.
    async fn fetch_pr(&self, pr: &PrRef) -> GitResult<Sha>;
    /// Worktree for the PR at `head`, created or moved. Locked while `lock` is held.
    async fn worktree(&self, pr: &PrRef, head: &Sha) -> GitResult<Worktree>;
    async fn remove_worktree(&self, pr: &PrRef) -> GitResult<()>;
    /// Drop worktrees of PRs not in `keep`.
    async fn gc_worktrees(&self, keep: &[PrRef]) -> GitResult<u32>;
    async fn merge_base(&self, repo: &Path, a: &Sha, b: &Sha) -> GitResult<Sha>;
    /// `base...head` parsed into files and hunks (with stable hunk ids).
    async fn diff(
        &self,
        repo: &Path,
        base: &Sha,
        head: &Sha,
        opts: &DiffOptions,
    ) -> GitResult<Revision>;
    /// File contents at `rev`, `None` if absent.
    async fn show(&self, repo: &Path, rev: &Sha, path: &str) -> GitResult<Option<Vec<u8>>>;

    /// Stages every change in `worktree`, commits it, and pushes to
    /// `branch` on `repo`'s remote (plan §4 "Fix target": own or local PR).
    /// Returns the new head sha. `Unsupported` by default; only a `GitPort`
    /// backed by a real remote (the git CLI) can push.
    async fn commit_and_push(
        &self,
        worktree: &Path,
        repo: &RepoRef,
        branch: &str,
        message: &str,
    ) -> GitResult<Sha> {
        let _ = (worktree, repo, branch, message);
        Err(GitError::Unsupported("commit_and_push"))
    }
}
