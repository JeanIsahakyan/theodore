//! `space_apply` on real git: another space's change lands in a space's
//! worktree as uncommitted edits, three-way against the worktree as it is
//! (its own uncommitted edits kept), conflicts left as labelled markers;
//! `HEAD`, the index and the checkpoint ref stay put.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use tempfile::TempDir;
use theodore_domain::{HostKind, RepoRef, Sha};
use theodore_git::GitCli;
use theodore_ports::{CredentialSource, GitPort, space_ref};

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

const A: &str = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";

struct Host {
    _tmp: TempDir,
    cli: GitCli,
    base: Sha,
    parent: PathBuf,
    child: PathBuf,
}

impl Host {
    async fn new() -> Self {
        let tmp = TempDir::new().unwrap();
        let work = tmp.path().join("work");
        std::fs::create_dir_all(&work).unwrap();
        git(&work, &["init", "-q", "-b", "main"]);
        git(&work, &["config", "user.email", "a@b.com"]);
        git(&work, &["config", "user.name", "test"]);
        std::fs::write(work.join("a.txt"), A).unwrap();
        std::fs::write(work.join("b.txt"), "bee\n").unwrap();
        git(&work, &["add", "-A"]);
        git(
            &work,
            &["-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"],
        );
        let bare = tmp.path().join("remote.git");
        git(
            tmp.path(),
            &["clone", "-q", "--bare", "work", bare.to_str().unwrap()],
        );
        let url = format!("file://{}", bare.display());
        let cli = GitCli::new(tmp.path().join("root"), Arc::new(NoAuth))
            .with_remote_urls(Arc::new(move |_r: &RepoRef| Some(url.clone())));
        let repo = RepoRef {
            host: HostKind::Github,
            owner: "acme".into(),
            name: "widget".into(),
        };
        let cache = cli.ensure_repo(&repo).await.unwrap();
        let base = cli.resolve_ref(&cache, "main").await.unwrap();
        let parent = cli.space_worktree(&cache, "p1", &base).await.unwrap().path;
        let child = cli.space_worktree(&cache, "c1", &base).await.unwrap().path;
        Self {
            _tmp: tmp,
            cli,
            base,
            parent,
            child,
        }
    }

    /// The child's turn: `edit`, then its checkpoint.
    async fn child_turn(&self, edit: impl FnOnce(&Path)) -> Sha {
        edit(&self.child);
        self.cli
            .space_checkpoint(&self.child, "c1", "turn")
            .await
            .unwrap()
            .sha
    }

    async fn apply(&self, from: &Sha, to: &Sha) -> theodore_ports::SpaceApply {
        self.cli
            .space_apply(&self.parent, from, to, "this space", "sub-space c1")
            .await
            .unwrap()
    }

    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.parent.join(rel)).unwrap()
    }

    /// `HEAD`, the index and the checkpoint ref, to show they never move.
    fn state(&self) -> (String, String, String) {
        (
            git(&self.parent, &["rev-parse", "HEAD"]),
            git(&self.parent, &["ls-files", "-s"]),
            git(&self.parent, &["rev-parse", &space_ref("p1")]),
        )
    }
}

#[tokio::test]
async fn a_clean_change_lands_as_uncommitted_edits() {
    let h = Host::new().await;
    let to = h
        .child_turn(|wt| {
            std::fs::write(wt.join("a.txt"), A.replace("two", "TWO")).unwrap();
            std::fs::create_dir_all(wt.join("docs")).unwrap();
            std::fs::write(wt.join("docs/new.md"), "# new\n").unwrap();
            std::fs::remove_file(wt.join("b.txt")).unwrap();
        })
        .await;
    let before = h.state();

    let got = h.apply(&h.base, &to).await;

    assert!(got.conflicts.is_empty(), "{got:?}");
    assert_eq!(h.read("a.txt"), A.replace("two", "TWO"));
    assert_eq!(h.read("docs/new.md"), "# new\n");
    assert!(!h.parent.join("b.txt").exists());
    let mut stat: Vec<_> = got
        .files
        .iter()
        .map(|f| (f.path.as_str(), f.additions, f.deletions))
        .collect();
    stat.sort();
    assert_eq!(
        stat,
        [("a.txt", 1, 1), ("b.txt", 0, 1), ("docs/new.md", 1, 0)]
    );
    assert_eq!(h.state(), before, "HEAD, index and ref stay");
    // The child's own worktree is untouched.
    assert_eq!(
        std::fs::read_to_string(h.child.join("a.txt")).unwrap(),
        A.replace("two", "TWO")
    );
}

#[tokio::test]
async fn the_parents_own_edits_in_a_touched_file_are_kept() {
    let h = Host::new().await;
    let to = h
        .child_turn(|wt| std::fs::write(wt.join("a.txt"), A.replace("two", "TWO")).unwrap())
        .await;
    // The parent moved on: a committed change of the agent's own, and an
    // uncommitted one in the same file the child touched.
    std::fs::write(h.parent.join("b.txt"), "bee\nhive\n").unwrap();
    git(&h.parent, &["add", "b.txt"]);
    git(
        &h.parent,
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-q",
            "-m",
            "agent",
        ],
    );
    std::fs::write(h.parent.join("a.txt"), A.replace("six", "SIX")).unwrap();

    let got = h.apply(&h.base, &to).await;

    assert!(got.conflicts.is_empty(), "{got:?}");
    assert_eq!(
        h.read("a.txt"),
        A.replace("two", "TWO").replace("six", "SIX")
    );
    assert_eq!(h.read("b.txt"), "bee\nhive\n");
    let paths: Vec<_> = got.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["a.txt"], "only what the change brought");
}

#[tokio::test]
async fn a_conflict_leaves_labelled_markers_with_both_sides() {
    let h = Host::new().await;
    let to = h
        .child_turn(|wt| {
            std::fs::write(wt.join("a.txt"), A.replace("four", "child four")).unwrap();
            std::fs::write(wt.join("c.txt"), "clean\n").unwrap();
        })
        .await;
    std::fs::write(h.parent.join("a.txt"), A.replace("four", "parent four")).unwrap();
    let before = h.state();

    let got = h.apply(&h.base, &to).await;

    assert_eq!(got.conflicts, ["a.txt"]);
    let a = h.read("a.txt");
    assert!(a.contains("<<<<<<< this space\nparent four\n"), "{a}");
    assert!(a.contains("child four\n>>>>>>> sub-space c1\n"), "{a}");
    assert!(a.contains("=======\n"), "{a}");
    // The rest of the change still lands.
    assert_eq!(h.read("c.txt"), "clean\n");
    // No unmerged index entries: the next checkpoint isn't refused.
    assert_eq!(h.state(), before);
    assert_eq!(h.cli.worktree_busy(&h.parent).await.unwrap(), None);
}

#[tokio::test]
async fn a_file_the_parent_removed_but_the_child_changed_is_kept() {
    let h = Host::new().await;
    let to = h
        .child_turn(|wt| std::fs::write(wt.join("b.txt"), "bee\nchanged\n").unwrap())
        .await;
    std::fs::remove_file(h.parent.join("b.txt")).unwrap();

    let got = h.apply(&h.base, &to).await;

    assert_eq!(got.conflicts, ["b.txt"]);
    assert_eq!(h.read("b.txt"), "bee\nchanged\n");
}

#[tokio::test]
async fn a_second_apply_brings_only_what_is_new() {
    let h = Host::new().await;
    let first = h
        .child_turn(|wt| std::fs::write(wt.join("a.txt"), A.replace("two", "TWO")).unwrap())
        .await;
    h.apply(&h.base, &first).await;
    // The parent reworks the merged line; the child adds another change.
    std::fs::write(h.parent.join("a.txt"), A.replace("two", "Two (reworked)")).unwrap();
    let second = h
        .child_turn(|wt| std::fs::write(wt.join("d.txt"), "dee\n").unwrap())
        .await;

    let got = h.apply(&first, &second).await;

    assert!(got.conflicts.is_empty(), "{got:?}");
    assert_eq!(h.read("a.txt"), A.replace("two", "Two (reworked)"));
    assert_eq!(h.read("d.txt"), "dee\n");
    let paths: Vec<_> = got.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["d.txt"]);
}

#[tokio::test]
async fn nothing_new_changes_nothing() {
    let h = Host::new().await;
    let got = h.apply(&h.base, &h.base).await;
    assert_eq!(got, theodore_ports::SpaceApply::default());
}
