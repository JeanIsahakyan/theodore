//! Mirrors a local folder project into Theodore's own cache (plan
//! "projects"): a bare, hardlink-free clone, refreshed by fetching straight
//! from the folder's path. The folder's own `.git` is only ever read
//! (`clone`/`fetch` never write to the source) — never cloned with
//! hardlinks into it, never given a worktree, never touched by push.

use std::path::{Path, PathBuf};

use theodore_domain::RepoRef;
use theodore_ports::{GitError, GitResult};

use crate::GitCli;
use crate::process::GitProc;

impl GitCli {
    pub(crate) async fn ensure_local_mirror_op(
        &self,
        source: &Path,
        repo: &RepoRef,
    ) -> GitResult<PathBuf> {
        let askpass = self.ensure_askpass()?;
        let dir = self.repo_dir(repo);
        let source_str = source
            .to_str()
            .ok_or_else(|| GitError::Parse("non-utf8 source path".to_string()))?;

        if dir.join("HEAD").exists() {
            let args = ["fetch", source_str, "+refs/heads/*:refs/heads/*"];
            GitProc {
                cwd: &dir,
                askpass: &askpass,
                args: &args,
                token: None,
                stdin: None,
            }
            .run()
            .await?;
            return Ok(dir);
        }

        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let dir_str = dir
            .to_str()
            .ok_or_else(|| GitError::Parse("non-utf8 repo path".to_string()))?;
        let args = ["clone", "--bare", "--no-hardlinks", source_str, dir_str];
        GitProc {
            cwd: self.root(),
            askpass: &askpass,
            args: &args,
            token: None,
            stdin: None,
        }
        .run()
        .await?;
        Ok(dir)
    }

    pub(crate) async fn is_repo_op(&self, path: &Path) -> GitResult<bool> {
        let askpass = self.ensure_askpass()?;
        let out = GitProc {
            cwd: path,
            askpass: &askpass,
            args: &["rev-parse", "--git-dir"],
            token: None,
            stdin: None,
        }
        .run()
        .await;
        Ok(out.is_ok())
    }

    pub(crate) async fn remove_repo_op(&self, repo: &RepoRef) -> GitResult<()> {
        let askpass = self.ensure_askpass()?;
        let repo_dir = self.repo_dir(repo);
        for (dirname, meta) in crate::meta::list(&self.meta_root()) {
            if meta.repo == *repo {
                self.drop_worktree_dir(&askpass, &repo_dir, &dirname).await;
                crate::meta::remove(&self.meta_root(), &dirname);
            }
        }
        if repo_dir.exists() {
            std::fs::remove_dir_all(&repo_dir)?;
        }
        Ok(())
    }
}
