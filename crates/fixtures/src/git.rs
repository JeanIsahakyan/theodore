//! Fixture git adapter (`GitPort`).
//!
//! `diff` and `show` read revisions and file blobs the shared state loaded
//! from `git/<sanitized-pr-id>/<head>.json` and
//! `git/<sanitized-pr-id>/files/<rev>/<path>`. `fetch_pr` returns the PR's
//! current head, which only `Triggers::author_push` moves. `worktree`
//! materializes the head's files into a temp directory.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use theodore_domain::{FileStatus, PrRef, RepoRef, Revision, Sha};
use theodore_ports::{DiffOptions, GitError, GitPort, GitResult, Worktree};

use crate::state::SharedState;

#[derive(Debug)]
pub struct FixtureGit {
    state: Arc<Mutex<SharedState>>,
    worktrees: Mutex<Vec<((String, Sha), Worktree)>>,
}

impl FixtureGit {
    pub(crate) fn new(state: Arc<Mutex<SharedState>>) -> Self {
        Self {
            state,
            worktrees: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl GitPort for FixtureGit {
    async fn ensure_repo(&self, repo: &RepoRef) -> GitResult<PathBuf> {
        let state = self.state.lock().unwrap();
        Ok(state
            .data_dir
            .join("git")
            .join(format!("{}_{}", repo.owner, repo.name)))
    }

    async fn fetch_pr(&self, pr: &PrRef) -> GitResult<Sha> {
        let state = self.state.lock().unwrap();
        state
            .heads
            .get(&pr.id())
            .cloned()
            .ok_or_else(|| GitError::Parse(format!("fixture: no head recorded for pr {}", pr.id())))
    }

    async fn worktree(&self, pr: &PrRef, head: &Sha) -> GitResult<Worktree> {
        let key = (pr.id().to_string(), head.clone());
        if let Some((_, wt)) = self
            .worktrees
            .lock()
            .unwrap()
            .iter()
            .find(|(k, _)| k == &key)
        {
            return Ok(wt.clone());
        }

        let revision =
            {
                let state = self.state.lock().unwrap();
                state.revisions_by_head.get(head).cloned().ok_or_else(|| {
                    GitError::Parse(format!("fixture: no revision for head {head}"))
                })?
            };

        let dir = tempfile::tempdir().map_err(GitError::Io)?;
        for file in &revision.files {
            if file.status == FileStatus::Deleted {
                continue;
            }
            let content = {
                let state = self.state.lock().unwrap();
                state.files.get(&(head.clone(), file.path.clone())).cloned()
            };
            let Some(content) = content else { continue };
            let dest = dir.path().join(&file.path);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(GitError::Io)?;
            }
            std::fs::write(&dest, content).map_err(GitError::Io)?;
        }

        let worktree = Worktree {
            path: dir.keep(),
            head: head.clone(),
        };
        self.worktrees.lock().unwrap().push((key, worktree.clone()));
        Ok(worktree)
    }

    async fn remove_worktree(&self, pr: &PrRef) -> GitResult<()> {
        let pr_id = pr.id().to_string();
        self.worktrees
            .lock()
            .unwrap()
            .retain(|((id, _), _)| id != &pr_id);
        Ok(())
    }

    async fn gc_worktrees(&self, keep: &[PrRef]) -> GitResult<u32> {
        let keep_ids: HashSet<String> = keep.iter().map(|p| p.id().to_string()).collect();
        let mut worktrees = self.worktrees.lock().unwrap();
        let before = worktrees.len();
        worktrees.retain(|((id, _), _)| keep_ids.contains(id));
        Ok((before - worktrees.len()) as u32)
    }

    async fn merge_base(&self, _repo: &Path, a: &Sha, _b: &Sha) -> GitResult<Sha> {
        Ok(a.clone())
    }

    async fn diff(
        &self,
        _repo: &Path,
        _base: &Sha,
        head: &Sha,
        _opts: &DiffOptions,
    ) -> GitResult<Revision> {
        let state = self.state.lock().unwrap();
        state
            .revisions_by_head
            .get(head)
            .cloned()
            .ok_or_else(|| GitError::Parse(format!("fixture: no revision for head {head}")))
    }

    async fn show(&self, _repo: &Path, rev: &Sha, path: &str) -> GitResult<Option<Vec<u8>>> {
        let state = self.state.lock().unwrap();
        Ok(state.files.get(&(rev.clone(), path.to_string())).cloned())
    }
}
