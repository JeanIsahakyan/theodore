//! `get_blob` and `conflicts` against a real temp git repo and the real
//! `git` binary (`theodore_git::GitCli`), not `testkit::FakeGit` — the
//! base64 round-trip and the `merge-tree` exit-code handling are exactly
//! what a fake can't verify.

use std::path::Path;
use std::process::Command;

use base64::Engine;
use theodore_contract::{DiffSide, GetBlobRequest, OpenPrRequest};
use theodore_domain::{HostKind, RepoRef, Sha};
use theodore_ports::{CredentialSource, Fetched};

use crate::Core;
use crate::testkit::{self, fixtures};

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
    assert!(out.status.success(), "git {args:?} failed");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

struct Fixture {
    _tmp: tempfile::TempDir,
    root: std::path::PathBuf,
    repo: RepoRef,
    base_sha: String,
    head_sha: String,
}

/// A local "origin" with `main` at `base_sha` and a `feature` branch one
/// commit ahead at `head_sha`, plus `refs/pull/1/head` pointing at that
/// same commit and the bare clone `GitCli` expects at its exact path.
fn setup(prepare: impl FnOnce(&Path)) -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let origin = tmp.path().join("origin");
    std::fs::create_dir_all(&origin).unwrap();
    git(&origin, &["init", "-q", "-b", "main"]);
    git(&origin, &["config", "user.email", "a@b.com"]);
    git(&origin, &["config", "user.name", "test"]);
    std::fs::write(origin.join("note.txt"), "one\ntwo\nthree\n").unwrap();
    git(&origin, &["add", "-A"]);
    git(&origin, &["commit", "-q", "-m", "base"]);
    let base_sha = git_out(&origin, &["rev-parse", "HEAD"]);

    git(&origin, &["checkout", "-q", "-b", "feature"]);
    prepare(&origin);
    git(&origin, &["add", "-A"]);
    git(&origin, &["commit", "-q", "-m", "pr change"]);
    let head_sha = git_out(&origin, &["rev-parse", "HEAD"]);
    git(&origin, &["update-ref", "refs/pull/1/head", &head_sha]);
    git(&origin, &["checkout", "-q", "main"]);

    let root = tmp.path().join("theodore-root");
    std::fs::create_dir_all(&root).unwrap();
    let repo = RepoRef {
        host: HostKind::Github,
        owner: "acme".to_string(),
        name: "widget".to_string(),
    };
    let repo_dir = root
        .join("repos")
        .join("github")
        .join("acme")
        .join("widget.git");
    std::fs::create_dir_all(repo_dir.parent().unwrap()).unwrap();
    git(
        tmp.path(),
        &[
            "clone",
            "-q",
            "--bare",
            origin.to_str().unwrap(),
            repo_dir.to_str().unwrap(),
        ],
    );

    Fixture {
        _tmp: tmp,
        root,
        repo,
        base_sha,
        head_sha,
    }
}

async fn open_fixture(fx: &Fixture) -> Core {
    let f = fixtures();
    let git_cli = theodore_git::GitCli::new(fx.root.clone(), std::sync::Arc::new(NoAuth));
    let deps = crate::Deps {
        git: std::sync::Arc::new(git_cli),
        ..f.deps()
    };

    let pr_ref = testkit::sample_pr_ref("acme", "widget", 1);
    assert_eq!(pr_ref.repo, fx.repo);
    let base = Sha::new(fx.base_sha.clone());
    let head = Sha::new(fx.head_sha.clone());
    let detail = testkit::sample_pr_detail(&pr_ref, &base, &head);
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("etag-1".into()),
        value: detail,
    }));

    let (core, _recv) = Core::start(deps);
    core.open_pr(OpenPrRequest {
        url: "https://github.com/acme/widget/pull/1".into(),
    })
    .await
    .expect("open_pr");
    core
}

#[tokio::test]
async fn get_blob_reads_an_image_committed_at_head() {
    let png: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
    let fx = setup(|origin| {
        std::fs::write(origin.join("logo.png"), png).unwrap();
    });
    let core = open_fixture(&fx).await;
    let pr_ref = testkit::sample_pr_ref("acme", "widget", 1);

    let resp = core
        .get_blob(GetBlobRequest {
            pr: pr_ref.id(),
            path: "logo.png".into(),
            side: DiffSide::Head,
        })
        .await
        .expect("get_blob");
    assert_eq!(resp.mime, "image/png");
    assert_eq!(resp.bytes, png.len() as u64);
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(resp.base64)
        .unwrap();
    assert_eq!(decoded, png);
}

#[tokio::test]
async fn get_blob_base_side_reads_the_pre_change_content() {
    let fx = setup(|origin| {
        std::fs::write(origin.join("note.txt"), "one\ntwo CHANGED\nthree\n").unwrap();
    });
    let core = open_fixture(&fx).await;
    let pr_ref = testkit::sample_pr_ref("acme", "widget", 1);

    let base_resp = core
        .get_blob(GetBlobRequest {
            pr: pr_ref.id(),
            path: "note.txt".into(),
            side: DiffSide::Base,
        })
        .await
        .expect("get_blob base");
    let decoded = String::from_utf8(
        base64::engine::general_purpose::STANDARD
            .decode(base_resp.base64)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(decoded, "one\ntwo\nthree\n");
}

#[tokio::test]
async fn conflicts_finds_a_real_content_conflict_between_base_and_head() {
    // `feature` changes `note.txt`; after opening the PR, `main` is mutated
    // to also change the same line — `conflicts` must still see this
    // because it reads the base commit straight off `git`, not off
    // whatever `main` pointed to when the PR was opened.
    let fx = setup(|origin| {
        std::fs::write(origin.join("note.txt"), "one\ntwo FEATURE\nthree\n").unwrap();
    });
    git(&fx._tmp.path().join("origin"), &["checkout", "-q", "main"]);
    std::fs::write(
        fx._tmp.path().join("origin").join("note.txt"),
        "one\ntwo BASE\nthree\n",
    )
    .unwrap();
    git(
        &fx._tmp.path().join("origin"),
        &["commit", "-q", "-am", "base change"],
    );
    let new_base = git_out(
        &fx._tmp.path().join("origin"),
        &["rev-parse", "refs/heads/main"],
    );
    let fx = Fixture {
        base_sha: new_base,
        ..fx
    };

    let core = open_fixture(&fx).await;
    let pr_ref = testkit::sample_pr_ref("acme", "widget", 1);

    let files = core.conflicts(pr_ref.id()).await.expect("conflicts");
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].path, "note.txt");
    assert_eq!(files[0].kind, theodore_contract::ConflictKind::Content);
}

#[tokio::test]
async fn conflicts_is_empty_for_a_clean_merge() {
    let fx = setup(|origin| {
        std::fs::write(origin.join("other.txt"), "unrelated\n").unwrap();
    });
    let core = open_fixture(&fx).await;
    let pr_ref = testkit::sample_pr_ref("acme", "widget", 1);

    let files = core.conflicts(pr_ref.id()).await.expect("conflicts");
    assert!(files.is_empty());
}
