//! Read-only git inspection for the "projects" feature: default branch,
//! branch listing with ahead/behind, and commit metadata for reviewing a
//! local branch that has no host PR behind it.

use std::path::Path;

use theodore_domain::Sha;
use theodore_ports::{BranchInfo, CommitLog, GitError, GitResult};

use crate::GitCli;
use crate::process::GitProc;

/// Record/field separators that never show up in a ref name, sha or commit
/// subject in practice, unlike `\t`/`\n`.
const FS: char = '\u{1}';

impl GitCli {
    pub(crate) async fn default_branch_op(&self, repo: &Path) -> GitResult<Option<String>> {
        let askpass = self.ensure_askpass()?;
        let out = GitProc {
            cwd: repo,
            askpass: &askpass,
            args: &["symbolic-ref", "--short", "HEAD"],
            token: None,
            stdin: None,
        }
        .run_text()
        .await;
        Ok(out
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()))
    }

    pub(crate) async fn resolve_ref_op(&self, repo: &Path, refname: &str) -> GitResult<Sha> {
        let askpass = self.ensure_askpass()?;
        let out = GitProc {
            cwd: repo,
            askpass: &askpass,
            args: &["rev-parse", refname],
            token: None,
            stdin: None,
        }
        .run_text()
        .await?;
        Ok(Sha::new(out.trim().to_string()))
    }

    pub(crate) async fn commit_op(&self, repo: &Path, sha: &Sha) -> GitResult<CommitLog> {
        let format = commit_format();
        let askpass = self.ensure_askpass()?;
        let out = GitProc {
            cwd: repo,
            askpass: &askpass,
            args: &["show", "-s", &format!("--format={format}"), sha.as_str()],
            token: None,
            stdin: None,
        }
        .run_text()
        .await?;
        parse_commit_line(out.trim())
    }

    pub(crate) async fn commit_log_op(
        &self,
        repo: &Path,
        base: &Sha,
        head: &Sha,
    ) -> GitResult<Vec<CommitLog>> {
        let format = commit_format();
        let range = format!("{}..{}", base.as_str(), head.as_str());
        let askpass = self.ensure_askpass()?;
        let out = GitProc {
            cwd: repo,
            askpass: &askpass,
            args: &["log", &format!("--format={format}"), &range],
            token: None,
            stdin: None,
        }
        .run_text()
        .await?;
        out.lines()
            .filter(|l| !l.is_empty())
            .map(parse_commit_line)
            .collect()
    }

    pub(crate) async fn list_branches_op(
        &self,
        repo: &Path,
        default_branch: &str,
    ) -> GitResult<Vec<BranchInfo>> {
        let format = format!(
            "%(refname:short){FS}%(objectname){FS}%(contents:subject){FS}%(committerdate:unix)"
        );
        let askpass = self.ensure_askpass()?;
        let out = GitProc {
            cwd: repo,
            askpass: &askpass,
            args: &["for-each-ref", "refs/heads", &format!("--format={format}")],
            token: None,
            stdin: None,
        }
        .run_text()
        .await?;

        let mut branches = Vec::new();
        for line in out.lines().filter(|l| !l.is_empty()) {
            let mut parts = line.splitn(4, FS);
            let (Some(name), Some(sha), Some(subject), Some(at)) =
                (parts.next(), parts.next(), parts.next(), parts.next())
            else {
                continue;
            };
            let (ahead, behind) = if name == default_branch {
                (0, 0)
            } else {
                self.ahead_behind(repo, &askpass, default_branch, name)
                    .await
                    .unwrap_or((0, 0))
            };
            branches.push(BranchInfo {
                name: name.to_string(),
                head: Sha::new(sha.to_string()),
                subject: subject.to_string(),
                ahead,
                behind,
                updated_at: at.trim().parse::<i64>().unwrap_or(0) * 1000,
            });
        }
        Ok(branches)
    }

    /// `(ahead, behind)` of `branch` against `base`: commits only reachable
    /// from `branch` (ahead) and only from `base` (behind).
    async fn ahead_behind(
        &self,
        repo: &Path,
        askpass: &Path,
        base: &str,
        branch: &str,
    ) -> GitResult<(u32, u32)> {
        let range = format!("{base}...{branch}");
        let out = GitProc {
            cwd: repo,
            askpass,
            args: &["rev-list", "--left-right", "--count", &range],
            token: None,
            stdin: None,
        }
        .run_text()
        .await?;
        let mut parts = out.split_whitespace();
        let behind = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        let ahead = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        Ok((ahead, behind))
    }
}

fn commit_format() -> String {
    format!("%H{FS}%s{FS}%an{FS}%ae{FS}%at")
}

fn parse_commit_line(line: &str) -> GitResult<CommitLog> {
    let mut parts = line.splitn(5, FS);
    let (Some(sha), Some(title), Some(name), Some(email), Some(at)) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return Err(GitError::Parse(format!("bad commit line: {line}")));
    };
    Ok(CommitLog {
        sha: Sha::new(sha.to_string()),
        title: title.to_string(),
        author_name: name.to_string(),
        author_email: email.to_string(),
        at: at.trim().parse::<i64>().unwrap_or(0) * 1000,
    })
}
