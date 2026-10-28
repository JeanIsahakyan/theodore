//! Space worktrees (docs/spaces.md §6): one detached worktree per space
//! under `<root>/spaces/<id>`, with its checkpoints on a private ref
//! `refs/theodore/spaces/<id>` in the bare cache.
//!
//! Detached, not a branch: the cache force-fetches `refs/heads/*` with
//! `--prune`, which would refuse to touch a branch checked out in a worktree
//! and would delete one that was never pushed. Lives outside `<root>/wt`, so
//! the PR worktree sweep (`gc_worktrees`) never sees it.

use std::path::{Path, PathBuf};

use theodore_domain::Sha;
use theodore_ports::{GitError, GitResult, Worktree, space_ref};

use crate::GitCli;
use crate::process::GitProc;
use crate::safety::END_OF_OPTIONS;

/// A space id becomes a path component and part of a ref name: lowercase
/// ascii letters, digits and `-` only, never leading with `-`.
fn validate_space_id(id: &str) -> GitResult<()> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('-')
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(GitError::Parse(format!("bad space id {id:?}")))
    }
}

impl GitCli {
    pub(crate) fn spaces_root(&self) -> PathBuf {
        self.root().join("spaces")
    }

    fn space_path(&self, id: &str) -> GitResult<PathBuf> {
        validate_space_id(id)?;
        Ok(self.spaces_root().join(id))
    }

    pub(crate) async fn space_worktree_op(
        &self,
        repo: &Path,
        id: &str,
        base: &Sha,
    ) -> GitResult<Worktree> {
        let askpass = self.ensure_askpass()?;
        let path = self.space_path(id)?;
        let refname = space_ref(id);
        std::fs::create_dir_all(self.spaces_root())?;
        // Worktree before repo, as everywhere (`locks`).
        let _wt = crate::locks::lock(&path).await;

        if path.join(".git").exists() {
            let head = GitProc {
                cwd: &path,
                askpass: &askpass,
                args: &["rev-parse", "--verify", "HEAD"],
                token: None,
                stdin: None,
            }
            .run_text()
            .await?;
            return Ok(Worktree {
                path,
                head: Sha::new(head.trim().to_string()),
            });
        }

        let _repo = crate::locks::lock(repo).await;
        // Resume from the last checkpoint when the space already has one
        // (its worktree was archived or deleted by hand), else start at base.
        let existing = GitProc {
            cwd: repo,
            askpass: &askpass,
            args: &["rev-parse", "--verify", "--quiet", END_OF_OPTIONS, &refname],
            token: None,
            stdin: None,
        }
        .run_raw()
        .await?;
        let start = if existing.status == 0 {
            String::from_utf8_lossy(&existing.stdout).trim().to_string()
        } else {
            base.as_str().to_string()
        };

        let path_str = path
            .to_str()
            .ok_or_else(|| GitError::Parse("non-utf8 space path".into()))?
            .to_string();
        let add = ["worktree", "add", "--detach", path_str.as_str(), &start];
        let first = GitProc {
            cwd: repo,
            askpass: &askpass,
            args: &add,
            token: None,
            stdin: None,
        }
        .run()
        .await;
        if first.is_err() {
            // A stale administrative entry for a directory removed by hand.
            let _ = GitProc {
                cwd: repo,
                askpass: &askpass,
                args: &["worktree", "prune"],
                token: None,
                stdin: None,
            }
            .run()
            .await;
            GitProc {
                cwd: repo,
                askpass: &askpass,
                args: &add,
                token: None,
                stdin: None,
            }
            .run()
            .await?;
        }
        GitProc {
            cwd: repo,
            askpass: &askpass,
            args: &["update-ref", &refname, &start],
            token: None,
            stdin: None,
        }
        .run()
        .await?;
        Ok(Worktree {
            path,
            head: Sha::new(start),
        })
    }

    pub(crate) async fn space_checkpoint_op(
        &self,
        worktree: &Path,
        id: &str,
        message: &str,
    ) -> GitResult<Sha> {
        validate_space_id(id)?;
        let askpass = self.ensure_askpass()?;
        let _wt = crate::locks::lock(worktree).await;
        let run = |args: &'static [&'static str]| GitProc {
            cwd: worktree,
            askpass: &askpass,
            args,
            token: None,
            stdin: None,
        };
        run(&["add", "-A"]).run().await?;
        // Exit 1 = something is staged.
        let staged = run(&["diff", "--cached", "--quiet"]).run_raw().await?;
        if staged.status == 1 {
            // Theodore's own snapshot: no user hooks or signing prompts on
            // every agent turn, a fixed identity like other Theodore commits.
            GitProc {
                cwd: worktree,
                askpass: &askpass,
                args: &[
                    "-c",
                    "user.name=Theodore",
                    "-c",
                    "user.email=theodore@localhost",
                    "-c",
                    "commit.gpgsign=false",
                    "-c",
                    "core.hooksPath=/dev/null",
                    "commit",
                    "-q",
                    "-m",
                    message,
                ],
                token: None,
                stdin: None,
            }
            .run()
            .await?;
        } else if staged.status != 0 {
            return Err(GitError::Command {
                args: "diff --cached --quiet".into(),
                code: staged.status,
                stderr: String::from_utf8_lossy(&staged.stderr).into_owned(),
            });
        }
        let head = run(&["rev-parse", "--verify", "HEAD"]).run_text().await?;
        let head = head.trim().to_string();
        // Refs outside `refs/heads` and `refs/worktree` are shared by every
        // worktree, so this lands in the bare cache.
        GitProc {
            cwd: worktree,
            askpass: &askpass,
            args: &["update-ref", &space_ref(id), &head],
            token: None,
            stdin: None,
        }
        .run()
        .await?;
        Ok(Sha::new(head))
    }

    pub(crate) async fn space_reset_op(
        &self,
        worktree: &Path,
        id: &str,
        to: &Sha,
    ) -> GitResult<()> {
        validate_space_id(id)?;
        let askpass = self.ensure_askpass()?;
        let refname = space_ref(id);
        let _wt = crate::locks::lock(worktree).await;
        let steps: [&[&str]; 3] = [
            &["reset", "-q", "--hard", to.as_str()],
            // Untracked files the turn left behind; ignored ones (deps,
            // build output) stay, so the next turn needn't reinstall.
            &["clean", "-q", "-fd"],
            &["update-ref", &refname, to.as_str()],
        ];
        for args in steps {
            GitProc {
                cwd: worktree,
                askpass: &askpass,
                args,
                token: None,
                stdin: None,
            }
            .run()
            .await?;
        }
        Ok(())
    }

    pub(crate) async fn remove_space_worktree_op(&self, repo: &Path, id: &str) -> GitResult<()> {
        let askpass = self.ensure_askpass()?;
        let path = self.space_path(id)?;
        if !path.exists() {
            return Ok(());
        }
        let _wt = crate::locks::lock(&path).await;
        let _repo = crate::locks::lock(repo).await;
        if let Some(path_str) = path.to_str() {
            let _ = GitProc {
                cwd: repo,
                askpass: &askpass,
                args: &["worktree", "remove", "--force", path_str],
                token: None,
                stdin: None,
            }
            .run()
            .await;
        }
        if path.exists() {
            std::fs::remove_dir_all(&path)?;
        }
        let _ = GitProc {
            cwd: repo,
            askpass: &askpass,
            args: &["worktree", "prune"],
            token: None,
            stdin: None,
        }
        .run()
        .await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn space_ids_are_safe_path_and_ref_components() {
        assert!(validate_space_id("a1b2c3d4e5f6").is_ok());
        assert!(validate_space_id("fix-login").is_ok());
        for bad in ["", "-x", "../x", "a/b", "A", "a b", "a.lock"] {
            assert!(validate_space_id(bad).is_err(), "{bad:?}");
        }
    }
}
