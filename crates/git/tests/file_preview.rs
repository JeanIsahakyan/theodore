//! What the chat's file preview reads, on real git: one file's change between
//! two commits, a file's size without reading it, and only the start of a big
//! file.

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use tempfile::TempDir;
use theodore_domain::{FileFlag, FileStatus, RepoRef, Sha};
use theodore_git::GitCli;
use theodore_ports::{CredentialSource, DiffOptions, GitPort};

struct NoAuth;
impl CredentialSource for NoAuth {
    fn token_for(&self, _repo: &RepoRef) -> Option<String> {
        None
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
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
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn commit(work: &Path, msg: &str) -> Sha {
    git(work, &["add", "-A"]);
    git(work, &["-c", "commit.gpgsign=false", "commit", "-qm", msg]);
    Sha::new(git(work, &["rev-parse", "HEAD"]))
}

struct Repo {
    tmp: TempDir,
    cli: GitCli,
}

fn repo() -> Repo {
    let tmp = TempDir::new().unwrap();
    git(tmp.path(), &["init", "-q", "-b", "main"]);
    git(tmp.path(), &["config", "user.email", "a@b.com"]);
    git(tmp.path(), &["config", "user.name", "test"]);
    let cli = GitCli::new(tmp.path().join(".root"), Arc::new(NoAuth));
    Repo { tmp, cli }
}

#[tokio::test]
async fn diff_file_is_that_one_file_between_two_commits() {
    let r = repo();
    let work = r.tmp.path();
    std::fs::write(work.join("a.txt"), "one\ntwo\n").unwrap();
    std::fs::write(work.join("b.txt"), "x\n").unwrap();
    let before = commit(work, "1");
    std::fs::write(work.join("a.txt"), "one\nTWO\n").unwrap();
    std::fs::write(work.join("b.txt"), "y\n").unwrap();
    let after = commit(work, "2");

    let file = r
        .cli
        .diff_file(work, &before, &after, "a.txt", &DiffOptions::default())
        .await
        .unwrap()
        .expect("a.txt changed");
    assert_eq!(file.path, "a.txt");
    assert_eq!(file.status, FileStatus::Modified);
    assert_eq!((file.additions, file.deletions), (1, 1));
    assert!(!file.hunks.is_empty());

    let same = r
        .cli
        .diff_file(work, &before, &before, "a.txt", &DiffOptions::default())
        .await
        .unwrap();
    assert!(same.is_none(), "no change between a commit and itself");
}

/// `*` and `:` in a name are no pattern, and a file that didn't change
/// answers nothing.
#[tokio::test]
async fn diff_file_takes_a_path_literally() {
    let r = repo();
    let work = r.tmp.path();
    std::fs::write(work.join("a*.txt"), "1\n").unwrap();
    std::fs::write(work.join("ab.txt"), "1\n").unwrap();
    let before = commit(work, "1");
    std::fs::write(work.join("ab.txt"), "2\n").unwrap();
    let after = commit(work, "2");

    let file = r
        .cli
        .diff_file(work, &before, &after, "a*.txt", &DiffOptions::default())
        .await
        .unwrap();
    assert!(file.is_none(), "a pattern would have matched ab.txt");
}

#[tokio::test]
async fn diff_file_says_a_binary_file_is_binary() {
    let r = repo();
    let work = r.tmp.path();
    std::fs::write(work.join("pic.bin"), [0u8, 1, 2]).unwrap();
    let before = commit(work, "1");
    std::fs::write(work.join("pic.bin"), [0u8, 3, 4, 5]).unwrap();
    let after = commit(work, "2");

    let file = r
        .cli
        .diff_file(work, &before, &after, "pic.bin", &DiffOptions::default())
        .await
        .unwrap()
        .expect("changed");
    assert!(file.hunks.is_empty());
    assert!(
        file.flags.iter().any(|f| matches!(
            f,
            FileFlag::Binary {
                new_size: Some(4),
                ..
            }
        )),
        "{:?}",
        file.flags
    );
}

#[tokio::test]
async fn blob_size_finds_only_a_file() {
    let r = repo();
    let work = r.tmp.path();
    std::fs::create_dir(work.join("dir")).unwrap();
    std::fs::write(work.join("dir/a b.txt"), "hello").unwrap();
    let head = commit(work, "1");

    assert_eq!(
        r.cli.blob_size(work, &head, "dir/a b.txt").await.unwrap(),
        Some(5)
    );
    assert_eq!(r.cli.blob_size(work, &head, "nope").await.unwrap(), None);
    assert_eq!(r.cli.blob_size(work, &head, "dir").await.unwrap(), None);
}

#[tokio::test]
async fn blob_head_stops_at_the_limit() {
    let r = repo();
    let work = r.tmp.path();
    std::fs::write(work.join("big.txt"), "x".repeat(1024 * 1024)).unwrap();
    let head = commit(work, "1");

    let got = r.cli.blob_head(work, &head, "big.txt", 100).await.unwrap();
    assert_eq!(got.len(), 100);
    let whole = r
        .cli
        .blob_head(work, &head, "big.txt", 10 * 1024 * 1024)
        .await
        .unwrap();
    assert_eq!(
        whole.len(),
        1024 * 1024,
        "shorter than the limit: all of it"
    );
}
