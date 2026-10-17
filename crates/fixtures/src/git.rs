//! Fixture git adapter: loads git data from fixture files.

use async_trait::async_trait;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use theodore_domain::{PrRef, RepoRef, Revision, Sha};
use theodore_ports::{DiffOptions, GitError, GitPort, GitResult, Worktree};

/// Fixture git: reads revisions and files from fixture JSON data.
pub struct FixtureGit {
    data_dir: PathBuf,
    state: Mutex<FixtureGitState>,
}

struct FixtureGitState {
    worktrees: HashMap<String, Worktree>,
}

impl FixtureGit {
    /// Create a new fixture git adapter pointing to a data directory.
    pub fn new(data_dir: impl AsRef<Path>) -> Self {
        Self {
            data_dir: data_dir.as_ref().to_path_buf(),
            state: Mutex::new(FixtureGitState {
                worktrees: HashMap::new(),
            }),
        }
    }

    /// Sanitize a PR ID for use in a filesystem path.
    fn sanitize_pr_id(pr: &PrRef) -> String {
        format!("{}_{}_{}", pr.repo.owner, pr.repo.name, pr.number)
    }
}

#[async_trait]
impl GitPort for FixtureGit {
    async fn ensure_repo(&self, _repo: &RepoRef) -> GitResult<PathBuf> {
        // Fixtures don't need a real repo clone; we have pre-recorded data.
        Ok(self.data_dir.join("repos"))
    }

    async fn fetch_pr(&self, _pr: &PrRef) -> GitResult<Sha> {
        // Return a fixed SHA for the fixture PR's head.
        // In real usage, this would be read from the fixture metadata.
        Ok(Sha::new("fixture-head-sha"))
    }

    async fn worktree(&self, pr: &PrRef, head: &Sha) -> GitResult<Worktree> {
        let pr_id = Self::sanitize_pr_id(pr);
        let mut state = self.state.lock().unwrap();

        // Check if worktree already exists
        if let Some(wt) = state.worktrees.get(&pr_id) {
            return Ok(wt.clone());
        }

        // Create a temporary directory for the worktree
        let temp_dir = tempfile::tempdir().map_err(GitError::Io)?;
        let temp_path = temp_dir.path().to_path_buf();

        let worktree = Worktree {
            path: temp_path,
            head: head.clone(),
        };

        state.worktrees.insert(pr_id, worktree.clone());
        // Keep the directory around
        std::mem::forget(temp_dir);
        Ok(worktree)
    }

    async fn remove_worktree(&self, pr: &PrRef) -> GitResult<()> {
        let pr_id = Self::sanitize_pr_id(pr);
        let mut state = self.state.lock().unwrap();
        state.worktrees.remove(&pr_id);
        Ok(())
    }

    async fn gc_worktrees(&self, keep: &[PrRef]) -> GitResult<u32> {
        let keep_ids: std::collections::HashSet<_> =
            keep.iter().map(Self::sanitize_pr_id).collect();

        let mut state = self.state.lock().unwrap();
        let removed_count = state.worktrees.len() as u32
            - keep_ids
                .iter()
                .filter(|id| state.worktrees.contains_key(*id))
                .count() as u32;

        state.worktrees.retain(|id, _| keep_ids.contains(id));
        Ok(removed_count)
    }

    async fn merge_base(&self, _repo: &Path, a: &Sha, _b: &Sha) -> GitResult<Sha> {
        // For fixtures, assume 'a' is the merge base.
        Ok(a.clone())
    }

    async fn diff(
        &self,
        _repo: &Path,
        base: &Sha,
        head: &Sha,
        _opts: &DiffOptions,
    ) -> GitResult<Revision> {
        // Load revision from fixture file if available.
        // For now, return an empty revision.
        Ok(Revision {
            base: base.clone(),
            head: head.clone(),
            files: Vec::new(),
        })
    }

    async fn show(&self, _repo: &Path, _rev: &Sha, _path: &str) -> GitResult<Option<Vec<u8>>> {
        // Load file content from fixture if available.
        Ok(None)
    }
}
