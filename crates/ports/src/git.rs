//! Git port (plan §7). Implemented over the git CLI.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use theodore_domain::{
    CheckRollup, Commit, Millis, Person, PrDetail, PrRef, PrState, PrSummary, RepoRef, Revision,
    Sha,
};

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

/// One local branch of a project (plan "projects"): host projects list
/// remote branches of the bare clone, local folder projects list the
/// folder's own branches, both read off the same `refs/heads/*` namespace.
#[derive(Debug, Clone)]
pub struct BranchInfo {
    pub name: String,
    pub head: Sha,
    /// Last commit subject.
    pub subject: String,
    /// Commits ahead of / behind the project's default branch.
    pub ahead: u32,
    pub behind: u32,
    pub updated_at: Millis,
}

/// One commit's metadata, used to describe a local branch review that has
/// no host PR behind it.
#[derive(Debug, Clone)]
pub struct CommitLog {
    pub sha: Sha,
    pub title: String,
    pub author_name: String,
    pub author_email: String,
    pub at: Millis,
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

    // ── projects (plan "projects") ───────────────────────────────────────

    /// Bare, hardlink-free mirror of a local folder under the cache,
    /// refreshed by fetching straight from `source`. Never opens `source`'s
    /// own `.git` for writing. `Unsupported` by default; only a `GitPort`
    /// backed by the real git CLI can mirror a folder.
    async fn ensure_local_mirror(&self, source: &Path, repo: &RepoRef) -> GitResult<PathBuf> {
        let _ = (source, repo);
        Err(GitError::Unsupported("ensure_local_mirror"))
    }

    /// Whether `path` is (inside) a git working copy or bare repository.
    async fn is_repo(&self, path: &Path) -> GitResult<bool> {
        let _ = path;
        Err(GitError::Unsupported("is_repo"))
    }

    /// The repository's default branch (`git symbolic-ref HEAD`), `None` on
    /// a detached or empty repository.
    async fn default_branch(&self, repo: &Path) -> GitResult<Option<String>> {
        let _ = repo;
        Ok(None)
    }

    /// Every local branch of `repo` (its own `refs/heads/*`; for a bare
    /// clone of a host repo this already is "remote" branches, since
    /// `git clone --bare` places them directly under `refs/heads/*`).
    async fn list_branches(&self, repo: &Path, default_branch: &str) -> GitResult<Vec<BranchInfo>> {
        let _ = (repo, default_branch);
        Ok(Vec::new())
    }

    /// Resolves a ref (branch name, tag, sha, …) to its commit sha.
    async fn resolve_ref(&self, repo: &Path, refname: &str) -> GitResult<Sha> {
        let _ = (repo, refname);
        Err(GitError::Unsupported("resolve_ref"))
    }

    /// One commit's metadata.
    async fn commit(&self, repo: &Path, sha: &Sha) -> GitResult<CommitLog> {
        let _ = (repo, sha);
        Err(GitError::Unsupported("commit"))
    }

    /// Commits reachable from `head` but not `base` (`git log base..head`).
    async fn commit_log(&self, repo: &Path, base: &Sha, head: &Sha) -> GitResult<Vec<CommitLog>> {
        let _ = (repo, base, head);
        Ok(Vec::new())
    }

    /// Deletes the cached clone/mirror of `repo` and any worktrees under it.
    /// Never touches a local folder project's own checkout.
    async fn remove_repo(&self, repo: &RepoRef) -> GitResult<()> {
        let _ = repo;
        Ok(())
    }

    /// Builds a synthetic PR's detail + diff for reviewing `branch` against
    /// `base` with no host PR behind it (plan "projects" `open_branch`).
    /// The default composes the primitives above; a `GitPort` only needs to
    /// override those, not this.
    async fn describe_branch(
        &self,
        repo: &Path,
        repo_ref: &RepoRef,
        number: u64,
        branch: &str,
        base: &str,
    ) -> GitResult<(PrDetail, Revision)> {
        let head = self.resolve_ref(repo, branch).await?;
        let base_sha = self.resolve_ref(repo, base).await?;
        let head_commit = self.commit(repo, &head).await?;
        let commits = self.commit_log(repo, &base_sha, &head).await?;
        let revision = self
            .diff(repo, &base_sha, &head, &DiffOptions::default())
            .await?;
        let additions = revision.files.iter().map(|f| f.additions).sum();
        let deletions = revision.files.iter().map(|f| f.deletions).sum();
        let changed_files = revision.files.len() as u32;
        let pr = PrRef {
            repo: repo_ref.clone(),
            number,
            host_id: Some(branch.to_string()),
        };
        let summary = PrSummary {
            pr,
            title: head_commit.title.clone(),
            author: person_of(&head_commit),
            state: PrState::Open,
            base_ref: base.to_string(),
            head_ref: branch.to_string(),
            head_sha: head,
            additions,
            deletions,
            changed_files,
            reasons: Vec::new(),
            checks: CheckRollup::None,
            approvals: 0,
            required_approvals: None,
            updated_at: head_commit.at,
            url: String::new(),
            review_decision: None,
            conflicts: false,
        };
        let detail = PrDetail {
            summary,
            body: String::new(),
            base_sha,
            commits: commits
                .into_iter()
                .map(|c| Commit {
                    sha: c.sha.clone(),
                    title: c.title.clone(),
                    author: person_of(&c),
                    at: c.at,
                    // A local branch review has no host-side reviews to
                    // measure freshness against.
                    after_my_review: false,
                })
                .collect(),
            checks: Vec::new(),
            reviewers: Vec::new(),
            assignees: Vec::new(),
            labels: Vec::new(),
            threads: Vec::new(),
            viewed: Vec::new(),
        };
        Ok((detail, revision))
    }
}

fn person_of(c: &CommitLog) -> Person {
    Person {
        login: c.author_email.clone(),
        name: Some(c.author_name.clone()),
        avatar_url: None,
    }
}
