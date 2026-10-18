//! End-to-end exercise of the "projects" additions to `GitCli` (local
//! folder mirroring, branch listing, branch review) against real temp
//! repos and the real `git` binary. The one invariant every test here
//! ultimately protects: the source folder's own `.git` is never written to.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use tempfile::TempDir;
use theodore_domain::{HostKind, RepoRef};
use theodore_git::GitCli;
use theodore_ports::{CredentialSource, GitPort};

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

/// A full byte-for-byte snapshot of every regular file under `dir`, keyed
/// by its path relative to `dir`. Comparing two snapshots is a stronger
/// check than comparing a hash: it also pinpoints which file, if any,
/// Theodore touched.
fn snapshot(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut out = BTreeMap::new();
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in std::fs::read_dir(dir).expect("read_dir") {
            let entry = entry.expect("dir entry");
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                let rel = path.strip_prefix(root).unwrap().to_path_buf();
                out.insert(rel, std::fs::read(&path).expect("read file"));
            }
        }
    }
    walk(dir, dir, &mut out);
    out
}

/// A local folder project: a real git working copy with a `main` branch
/// and a `feature` branch one commit ahead, one commit behind.
struct Fixture {
    _tmp: TempDir,
    root: PathBuf,
    source: PathBuf,
    repo: RepoRef,
}

fn setup() -> Fixture {
    let tmp = TempDir::new().unwrap();
    let source = tmp.path().join("my-project");
    std::fs::create_dir_all(&source).unwrap();
    git(&source, &["init", "-q", "-b", "main"]);
    git(&source, &["config", "user.email", "a@b.com"]);
    git(&source, &["config", "user.name", "test"]);
    std::fs::write(source.join("a.txt"), "line1\n").unwrap();
    git(&source, &["add", "-A"]);
    git(&source, &["commit", "-q", "-m", "base"]);

    git(&source, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(source.join("a.txt"), "line1\nline2\n").unwrap();
    git(&source, &["add", "-A"]);
    git(&source, &["commit", "-q", "-m", "feature work"]);
    git(&source, &["checkout", "-q", "main"]);
    std::fs::write(source.join("b.txt"), "only on main\n").unwrap();
    git(&source, &["add", "-A"]);
    git(&source, &["commit", "-q", "-m", "main-only work"]);

    let root = tmp.path().join("theodore-root");
    std::fs::create_dir_all(&root).unwrap();
    let repo = RepoRef {
        host: HostKind::Local,
        owner: "local".to_string(),
        name: "my-project".to_string(),
    };

    Fixture {
        _tmp: tmp,
        root,
        source,
        repo,
    }
}

impl Fixture {
    fn cli(&self) -> GitCli {
        GitCli::new(self.root.clone(), Arc::new(NoAuth))
    }
}

#[tokio::test]
async fn ensure_local_mirror_clones_without_touching_the_source() {
    let fx = setup();
    let cli = fx.cli();
    let before = snapshot(&fx.source.join(".git"));

    let mirror = cli.ensure_local_mirror(&fx.source, &fx.repo).await.unwrap();
    assert!(mirror.join("HEAD").exists(), "mirror is a bare repo");
    assert_eq!(
        git_out(&mirror, &["rev-parse", "main"]),
        git_out(&fx.source, &["rev-parse", "main"]),
    );

    assert_eq!(
        before,
        snapshot(&fx.source.join(".git")),
        "cloning the mirror must not touch the source's .git"
    );
}

#[tokio::test]
async fn ensure_local_mirror_refresh_picks_up_new_commits_without_touching_the_source() {
    let fx = setup();
    let cli = fx.cli();
    cli.ensure_local_mirror(&fx.source, &fx.repo).await.unwrap();

    std::fs::write(fx.source.join("c.txt"), "new file\n").unwrap();
    git(&fx.source, &["add", "-A"]);
    git(&fx.source, &["commit", "-q", "-m", "after first mirror"]);
    let before = snapshot(&fx.source.join(".git"));

    let mirror = cli.ensure_local_mirror(&fx.source, &fx.repo).await.unwrap();
    assert_eq!(
        git_out(&mirror, &["rev-parse", "main"]),
        git_out(&fx.source, &["rev-parse", "main"]),
        "a refresh must see the new commit"
    );

    assert_eq!(
        before,
        snapshot(&fx.source.join(".git")),
        "refreshing the mirror must not touch the source's .git"
    );
}

#[tokio::test]
async fn is_repo_distinguishes_a_git_repo_from_a_plain_folder() {
    let fx = setup();
    let cli = fx.cli();
    assert!(cli.is_repo(&fx.source).await.unwrap());

    let plain = fx._tmp.path().join("not-a-repo");
    std::fs::create_dir_all(&plain).unwrap();
    assert!(!cli.is_repo(&plain).await.unwrap());
}

#[tokio::test]
async fn default_branch_reads_the_mirrors_head() {
    let fx = setup();
    let cli = fx.cli();
    let mirror = cli.ensure_local_mirror(&fx.source, &fx.repo).await.unwrap();
    assert_eq!(
        cli.default_branch(&mirror).await.unwrap(),
        Some("main".to_string())
    );
}

#[tokio::test]
async fn list_branches_reports_ahead_and_behind_against_the_default_branch() {
    let fx = setup();
    let cli = fx.cli();
    let mirror = cli.ensure_local_mirror(&fx.source, &fx.repo).await.unwrap();

    let branches = cli.list_branches(&mirror, "main").await.unwrap();
    let main = branches.iter().find(|b| b.name == "main").unwrap();
    assert_eq!((main.ahead, main.behind), (0, 0));

    let feature = branches.iter().find(|b| b.name == "feature").unwrap();
    // `feature` has one commit main doesn't (ahead) and is missing
    // `main`'s one extra commit (behind).
    assert_eq!((feature.ahead, feature.behind), (1, 1));
    assert_eq!(feature.subject, "feature work");
}

#[tokio::test]
async fn resolve_ref_and_commit_read_real_git_metadata() {
    let fx = setup();
    let cli = fx.cli();
    let mirror = cli.ensure_local_mirror(&fx.source, &fx.repo).await.unwrap();

    let head = cli.resolve_ref(&mirror, "feature").await.unwrap();
    assert_eq!(
        head.as_str(),
        git_out(&fx.source, &["rev-parse", "feature"])
    );

    let commit = cli.commit(&mirror, &head).await.unwrap();
    assert_eq!(commit.title, "feature work");
    assert_eq!(commit.author_email, "a@b.com");
}

#[tokio::test]
async fn commit_log_lists_commits_reachable_from_head_but_not_base() {
    let fx = setup();
    let cli = fx.cli();
    let mirror = cli.ensure_local_mirror(&fx.source, &fx.repo).await.unwrap();
    let main = cli.resolve_ref(&mirror, "main").await.unwrap();
    let feature = cli.resolve_ref(&mirror, "feature").await.unwrap();
    let merge_base = cli.merge_base(&mirror, &main, &feature).await.unwrap();

    let commits = cli
        .commit_log(&mirror, &merge_base, &feature)
        .await
        .unwrap();
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].title, "feature work");
}

#[tokio::test]
async fn describe_branch_builds_a_pr_detail_and_diff_from_git_alone() {
    let fx = setup();
    let cli = fx.cli();
    let mirror = cli.ensure_local_mirror(&fx.source, &fx.repo).await.unwrap();

    let (detail, revision) = cli
        .describe_branch(&mirror, &fx.repo, 42, "feature", "main")
        .await
        .unwrap();
    assert_eq!(detail.summary.head_ref, "feature");
    assert_eq!(detail.summary.base_ref, "main");
    assert_eq!(detail.summary.pr.number, 42);
    assert_eq!(detail.summary.pr.host_id.as_deref(), Some("feature"));
    assert_eq!(detail.summary.title, "feature work");
    assert!(revision.files.iter().any(|f| f.path == "a.txt"));
}

#[tokio::test]
async fn remove_repo_deletes_the_mirror_but_never_the_source() {
    let fx = setup();
    let cli = fx.cli();
    let mirror = cli.ensure_local_mirror(&fx.source, &fx.repo).await.unwrap();
    assert!(mirror.exists());

    cli.remove_repo(&fx.repo).await.unwrap();
    assert!(!mirror.exists());
    assert!(fx.source.join(".git").exists(), "the source is untouched");
}
