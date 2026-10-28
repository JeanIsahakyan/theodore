//! Concurrent `GitCli` calls into one bare repo / one worktree, against the
//! real `git` binary and a local bare "remote": the poller's push handler
//! and the UI's `get_revision` both fetch, and the review mounts the head
//! and the "since last visit" baseline at once.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use tempfile::TempDir;
use theodore_domain::{HostKind, PrRef, RepoRef, Sha};
use theodore_git::GitCli;
use theodore_ports::{CredentialSource, GitPort};

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

fn repo() -> RepoRef {
    RepoRef {
        host: HostKind::Github,
        owner: "acme".into(),
        name: "widget".into(),
    }
}

const BRANCHES: usize = 40;

/// A working repo with `main` + `BRANCHES` branches, pushed to a bare
/// "remote" that also has `refs/pull/1/head`.
struct Remote {
    _tmp: TempDir,
    work: PathBuf,
    bare: PathBuf,
    root: PathBuf,
}

impl Remote {
    fn new() -> Self {
        let tmp = TempDir::new().unwrap();
        let work = tmp.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        git(&work, &["init", "-q", "-b", "main"]);
        git(&work, &["config", "user.email", "a@b.com"]);
        git(&work, &["config", "user.name", "test"]);
        std::fs::write(work.join("a.txt"), "one\n").unwrap();
        git(&work, &["add", "-A"]);
        git(&work, &["commit", "-q", "-m", "base"]);
        for i in 0..BRANCHES {
            git(&work, &["branch", &format!("b{i}")]);
        }
        let bare = tmp.path().join("remote.git");
        git(
            tmp.path(),
            &["clone", "-q", "--bare", "work", bare.to_str().unwrap()],
        );
        let root = tmp.path().join("root");
        let remote = Self {
            _tmp: tmp,
            work,
            bare,
            root,
        };
        remote.set_pr_head();
        remote
    }

    fn cli(&self) -> GitCli {
        let url = format!("file://{}", self.bare.display());
        GitCli::new(self.root.clone(), Arc::new(NoAuth))
            .with_remote_urls(Arc::new(move |_r: &RepoRef| Some(url.clone())))
    }

    /// A new commit on every branch, pushed: every ref the clone has is
    /// now behind.
    fn advance_all(&self, n: usize) -> String {
        std::fs::write(self.work.join("a.txt"), format!("{n}\n")).unwrap();
        git(&self.work, &["commit", "-qam", &format!("c{n}")]);
        let tip = git(&self.work, &["rev-parse", "HEAD"]);
        git(
            &self.work,
            &["push", "-q", self.bare.to_str().unwrap(), "main"],
        );
        for i in 0..BRANCHES {
            git(
                &self.bare,
                &["update-ref", &format!("refs/heads/b{i}"), &tip],
            );
        }
        self.set_pr_head();
        tip
    }

    fn set_pr_head(&self) {
        let head = git(&self.work, &["rev-parse", "HEAD"]);
        git(&self.bare, &["update-ref", "refs/pull/1/head", &head]);
    }
}

fn pr() -> PrRef {
    PrRef {
        repo: repo(),
        number: 1,
        host_id: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_fetches_into_one_bare_repo_all_succeed() {
    let remote = Remote::new();
    let cli = Arc::new(remote.cli());
    let dir = cli.ensure_repo(&repo()).await.expect("clone");

    for round in 1..=3 {
        let tip = remote.advance_all(round);
        // The poller's `handle_push` (ensure_repo + fetch_pr) and the UI's
        // `get_revision` (ensure_repo), all at once.
        let mut tasks = Vec::new();
        for i in 0..6 {
            let cli = cli.clone();
            tasks.push(tokio::spawn(async move {
                if i % 2 == 0 {
                    cli.ensure_repo(&repo()).await.map(|_| ())
                } else {
                    cli.fetch_pr(&pr()).await.map(|_| ())
                }
            }));
        }
        for t in tasks {
            t.await.unwrap().expect("every concurrent fetch succeeds");
        }
        assert_eq!(git(&dir, &["rev-parse", "refs/heads/b7"]), tip);
        assert_eq!(git(&dir, &["rev-parse", "refs/theodore/pr/1"]), tip);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_checkouts_into_one_worktree_all_succeed() {
    let remote = Remote::new();
    let cli = Arc::new(remote.cli());
    cli.ensure_repo(&repo()).await.expect("clone");
    let base = Sha::new(git(&remote.bare, &["rev-parse", "refs/heads/main"]));
    let head = Sha::new(remote.advance_all(1));
    cli.fetch_pr(&pr()).await.expect("fetch pr");
    let first = cli.worktree(&pr(), &head).await.expect("first checkout");

    // The review's head and baseline revisions, mounted together.
    let mut tasks = Vec::new();
    for i in 0..8 {
        let cli = cli.clone();
        let sha = if i % 2 == 0 {
            head.clone()
        } else {
            base.clone()
        };
        tasks.push(tokio::spawn(async move { cli.worktree(&pr(), &sha).await }));
    }
    for t in tasks {
        let wt = t
            .await
            .unwrap()
            .expect("every concurrent checkout succeeds");
        assert_eq!(wt.path, first.path);
    }

    let wt = cli.worktree(&pr(), &head).await.expect("back to head");
    assert_eq!(git(&wt.path, &["rev-parse", "HEAD"]), head.as_str());
    assert_eq!(
        std::fs::read_to_string(wt.path.join("a.txt")).unwrap(),
        "1\n"
    );
}
