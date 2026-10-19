//! `GitCli::merge_tree_conflicts` against real temp repos and the real
//! `git` binary — the exit-code/stdout parsing is the part a unit test
//! (`crates/git/src/conflicts.rs`) can't exercise.

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use tempfile::TempDir;
use theodore_domain::{RepoRef, Sha};
use theodore_git::GitCli;
use theodore_ports::{ConflictKind, CredentialSource, GitPort};

struct NoAuth;
impl CredentialSource for NoAuth {
    fn token_for(&self, _repo: &RepoRef) -> Option<String> {
        None
    }
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("git installed");
    assert!(
        out.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
}

fn git_out(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .current_dir(dir)
        .args(args)
        .output()
        .expect("git installed");
    assert!(out.status.success());
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn cli(tmp: &TempDir) -> GitCli {
    GitCli::new(tmp.path().join("theodore-root"), Arc::new(NoAuth))
}

fn repo() -> (TempDir, std::path::PathBuf) {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path().join("repo");
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.email", "a@b.com"]);
    git(&dir, &["config", "user.name", "test"]);
    (tmp, dir)
}

#[tokio::test]
async fn a_clean_merge_has_no_conflicts() {
    let (tmp, dir) = repo();
    std::fs::write(dir.join("common.txt"), "base\n").unwrap();
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "base"]);
    let base = git_out(&dir, &["rev-parse", "HEAD"]);

    git(&dir, &["checkout", "-q", "-b", "c1"]);
    std::fs::write(dir.join("other.txt"), "unrelated\n").unwrap();
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "c1"]);
    let head = git_out(&dir, &["rev-parse", "HEAD"]);

    let cli = cli(&tmp);
    let entries = cli
        .merge_tree_conflicts(&dir, &Sha::new(base), &Sha::new(head))
        .await
        .expect("merge-tree");
    assert!(entries.is_empty());
}

#[tokio::test]
async fn a_content_conflict_is_reported_with_its_path() {
    let (tmp, dir) = repo();
    std::fs::write(dir.join("f.txt"), "line1\nline2\n").unwrap();
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "base"]);

    git(&dir, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(dir.join("f.txt"), "line1\nline2\nfeature change\n").unwrap();
    git(&dir, &["commit", "-q", "-am", "feature"]);
    let head = git_out(&dir, &["rev-parse", "HEAD"]);

    git(&dir, &["checkout", "-q", "main"]);
    std::fs::write(dir.join("f.txt"), "line1\nline2\nbase change\n").unwrap();
    git(&dir, &["commit", "-q", "-am", "base change"]);
    let base = git_out(&dir, &["rev-parse", "HEAD"]);

    let cli = cli(&tmp);
    let entries = cli
        .merge_tree_conflicts(&dir, &Sha::new(base), &Sha::new(head))
        .await
        .expect("merge-tree");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].path, "f.txt");
    assert_eq!(entries[0].kind, ConflictKind::Content);
}

#[tokio::test]
async fn an_unresolvable_base_is_a_real_error_not_unsupported() {
    let (tmp, dir) = repo();
    std::fs::write(dir.join("f.txt"), "x\n").unwrap();
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "base"]);
    let head = git_out(&dir, &["rev-parse", "HEAD"]);

    let cli = cli(&tmp);
    let err = cli
        .merge_tree_conflicts(&dir, &Sha::new("0".repeat(40)), &Sha::new(head))
        .await
        .expect_err("a nonexistent base must fail");
    assert!(matches!(err, theodore_ports::GitError::Command { .. }));
}
