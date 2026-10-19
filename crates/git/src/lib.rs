//! GitPort over the git CLI: bare clones, worktrees, diff parsing.
//!
//! Layout under `root` (normally `~/.theodore`):
//! ```text
//! repos/<host>/<owner>/<repo>.git   bare clone
//! wt/<host>-<owner>-<repo>-<n>/     one worktree per PR, at its head
//! wt/.meta/<dirname>.json           sidecar: which RepoRef/PR a worktree is
//! .askpass.sh                       GIT_ASKPASS helper (holds no secret)
//! ```
//! Auth never touches argv, a clone URL, or `.git/config` (see `auth.rs`).

mod auth;
mod branches;
mod diff;
mod generated;
mod local;
mod meta;
mod parse;
mod process;
mod safety;
mod worktree;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use theodore_domain::{PrRef, RepoRef, Revision, Sha};
use theodore_ports::{
    BranchInfo, CommitLog, CredentialSource, DiffOptions, GitError, GitPort, GitResult, Worktree,
};

use process::GitProc;

/// GitPort over the system `git` binary. Bare clones under `<root>/repos`,
/// one worktree per PR under `<root>/wt`.
pub struct GitCli {
    root: PathBuf,
    creds: Arc<dyn CredentialSource>,
}

impl GitCli {
    pub fn new(root: PathBuf, creds: Arc<dyn CredentialSource>) -> Self {
        Self { root, creds }
    }

    pub(crate) fn ensure_askpass(&self) -> GitResult<PathBuf> {
        auth::ensure_askpass(&self.root)
    }

    pub(crate) fn token_for(&self, repo: &RepoRef) -> Option<String> {
        self.creds.token_for(repo)
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn repos_root(&self) -> PathBuf {
        self.root.join("repos")
    }

    pub(crate) fn wt_root(&self) -> PathBuf {
        self.root.join("wt")
    }

    pub(crate) fn meta_root(&self) -> PathBuf {
        self.wt_root().join(".meta")
    }

    /// `owner`/`name` become path components here, so both are validated
    /// first (`safety::validate_repo_ref`): a malicious owner/name (e.g.
    /// `..` or a leading `-`) must never reach the filesystem or a `git`
    /// argv unchecked.
    pub(crate) fn repo_dir(&self, repo: &RepoRef) -> GitResult<PathBuf> {
        safety::validate_repo_ref(repo)?;
        Ok(self
            .repos_root()
            .join(auth::host_dir(repo.host))
            .join(&repo.owner)
            .join(format!("{}.git", repo.name)))
    }

    pub(crate) fn wt_dirname(repo: &RepoRef, number: u64) -> GitResult<String> {
        safety::validate_repo_ref(repo)?;
        Ok(format!(
            "{}-{}-{}-{}",
            auth::host_dir(repo.host),
            repo.owner,
            repo.name,
            number
        ))
    }

    pub(crate) fn wt_path(&self, pr: &PrRef) -> GitResult<PathBuf> {
        Ok(self.wt_root().join(Self::wt_dirname(&pr.repo, pr.number)?))
    }

    /// Bare clone under `repos/...`, or an in-place ref refresh if present.
    pub(crate) async fn ensure_repo_op(&self, repo: &RepoRef) -> GitResult<PathBuf> {
        let askpass = self.ensure_askpass()?;
        let dir = self.repo_dir(repo)?;
        let token = self.token_for(repo);

        if dir.join("HEAD").exists() {
            let args = [
                "fetch",
                "origin",
                "+refs/heads/*:refs/heads/*",
                "--prune",
                "--tags",
            ];
            GitProc {
                cwd: &dir,
                askpass: &askpass,
                args: &args,
                token: token.as_deref(),
                stdin: None,
            }
            .run()
            .await?;
            return Ok(dir);
        }

        let url = auth::clone_url(repo.host, &repo.owner, &repo.name).ok_or_else(|| {
            GitError::Parse(format!("{:?} repos have no remote to clone", repo.host))
        })?;
        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let dir_str = dir
            .to_str()
            .ok_or_else(|| GitError::Parse("non-utf8 repo path".to_string()))?;
        let args = ["clone", "--bare", url.as_str(), dir_str];
        GitProc {
            cwd: &self.root,
            askpass: &askpass,
            args: &args,
            token: token.as_deref(),
            stdin: None,
        }
        .run()
        .await?;
        Ok(dir)
    }

    /// Fetches the PR/MR head into `refs/theodore/pr/<n>` and returns its sha.
    pub(crate) async fn fetch_pr_op(&self, pr: &PrRef) -> GitResult<Sha> {
        let dir = self.ensure_repo_op(&pr.repo).await?;
        let askpass = self.ensure_askpass()?;
        let token = self.token_for(&pr.repo);
        let remote_ref = auth::remote_pr_ref(pr.repo.host, pr.number);
        let local_ref = auth::local_pr_ref(pr.number);
        let refspec = format!("+{remote_ref}:{local_ref}");
        let fetch_args = ["fetch", "origin", refspec.as_str()];
        GitProc {
            cwd: &dir,
            askpass: &askpass,
            args: &fetch_args,
            token: token.as_deref(),
            stdin: None,
        }
        .run()
        .await?;
        let rev_args = ["rev-parse", local_ref.as_str()];
        let out = GitProc {
            cwd: &dir,
            askpass: &askpass,
            args: &rev_args,
            token: None,
            stdin: None,
        }
        .run_text()
        .await?;
        Ok(Sha::new(out.trim().to_string()))
    }
}

#[async_trait]
impl GitPort for GitCli {
    async fn ensure_repo(&self, repo: &RepoRef) -> GitResult<PathBuf> {
        self.ensure_repo_op(repo).await
    }

    async fn fetch_pr(&self, pr: &PrRef) -> GitResult<Sha> {
        self.fetch_pr_op(pr).await
    }

    async fn worktree(&self, pr: &PrRef, head: &Sha) -> GitResult<Worktree> {
        self.worktree_op(pr, head).await
    }

    async fn remove_worktree(&self, pr: &PrRef) -> GitResult<()> {
        self.remove_worktree_op(pr).await
    }

    async fn gc_worktrees(&self, keep: &[PrRef]) -> GitResult<u32> {
        self.gc_worktrees_op(keep).await
    }

    async fn merge_base(&self, repo: &Path, a: &Sha, b: &Sha) -> GitResult<Sha> {
        let askpass = self.ensure_askpass()?;
        let args = ["merge-base", a.as_str(), b.as_str()];
        let out = GitProc {
            cwd: repo,
            askpass: &askpass,
            args: &args,
            token: None,
            stdin: None,
        }
        .run_text()
        .await?;
        Ok(Sha::new(out.trim().to_string()))
    }

    async fn diff(
        &self,
        repo: &Path,
        base: &Sha,
        head: &Sha,
        opts: &DiffOptions,
    ) -> GitResult<Revision> {
        self.diff_op(repo, base, head, opts).await
    }

    async fn show(&self, repo: &Path, rev: &Sha, path: &str) -> GitResult<Option<Vec<u8>>> {
        self.show_op(repo, rev, path).await
    }

    async fn commit_and_push(
        &self,
        worktree: &Path,
        repo: &RepoRef,
        branch: &str,
        message: &str,
    ) -> GitResult<Sha> {
        self.commit_and_push_op(worktree, repo, branch, message)
            .await
    }

    async fn ensure_local_mirror(&self, source: &Path, repo: &RepoRef) -> GitResult<PathBuf> {
        self.ensure_local_mirror_op(source, repo).await
    }

    async fn is_repo(&self, path: &Path) -> GitResult<bool> {
        self.is_repo_op(path).await
    }

    async fn remove_repo(&self, repo: &RepoRef) -> GitResult<()> {
        self.remove_repo_op(repo).await
    }

    async fn default_branch(&self, repo: &Path) -> GitResult<Option<String>> {
        self.default_branch_op(repo).await
    }

    async fn resolve_ref(&self, repo: &Path, refname: &str) -> GitResult<Sha> {
        self.resolve_ref_op(repo, refname).await
    }

    async fn commit(&self, repo: &Path, sha: &Sha) -> GitResult<CommitLog> {
        self.commit_op(repo, sha).await
    }

    async fn commit_log(&self, repo: &Path, base: &Sha, head: &Sha) -> GitResult<Vec<CommitLog>> {
        self.commit_log_op(repo, base, head).await
    }

    async fn list_branches(&self, repo: &Path, default_branch: &str) -> GitResult<Vec<BranchInfo>> {
        self.list_branches_op(repo, default_branch).await
    }
}

/// Parse a standalone patch (e.g. `git diff > f.patch`) without a repository:
/// counts come from the hunks and no `.gitattributes` apply.
pub fn parse_patch(
    text: &str,
    base: &theodore_domain::Sha,
    head: &theodore_domain::Sha,
    max_file_lines: u32,
) -> theodore_domain::Revision {
    let attrs = generated::GitAttributes::parse("");
    let mut files: Vec<_> = parse::parse_unified_diff(text, &[], &attrs, max_file_lines)
        .into_iter()
        .map(|p| p.file)
        .collect();
    theodore_domain::interdiff::dedupe_hunk_ids(&mut files);
    theodore_domain::Revision {
        base: base.clone(),
        head: head.clone(),
        files,
    }
}
