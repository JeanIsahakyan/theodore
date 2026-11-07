//! `commit_suggestions` against a real temp git repo and the real `git`
//! binary (`theodore_git::GitCli`), not `testkit::FakeGit` — staging,
//! committing and pushing a suggestion edit is exactly the part a fake
//! can't verify. Everything else (store, host, clock) stays faked.

use std::path::Path;
use std::process::Command;

use theodore_contract::{
    AddProjectRequest, CommitSuggestionsRequest, CreateSpaceRequest, OpenPrRequest, ShipAction,
    ShipSpaceRequest, Space, SpaceSendRequest, SpaceStatus, models,
};
use theodore_domain::{
    Anchor, Comment, CommentId, HostKind, Person, RepoRef, Sha, Side, Thread, ThreadId,
};
use theodore_ports::{AgentPort, CredentialSource, Fetched, Store};

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
    origin: std::path::PathBuf,
    repo: RepoRef,
    base_sha: String,
    head_sha: String,
}

/// A local "origin" with `main` at `base_sha` and a `feature` branch one
/// commit ahead, plus `refs/pull/1/head` pointing at that same commit (a
/// hand-placed stand-in for GitHub's PR head ref) and the bare clone
/// `GitCli` expects at its exact computed path.
fn setup() -> Fixture {
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
    std::fs::write(origin.join("note.txt"), "one\ntwo CHANGED\nthree\n").unwrap();
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
        origin,
        repo,
        base_sha,
        head_sha,
    }
}

fn anchor(head_sha: &str, path: &str, line: u32) -> Anchor {
    Anchor {
        rev: Sha::new(head_sha.to_string()),
        path: path.into(),
        side: Side::New,
        line,
        start_line: None,
        start_side: None,
    }
}

#[tokio::test]
async fn commit_suggestions_pushes_a_real_commit_to_the_real_remote() {
    let fx = setup();
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
    let mut detail = testkit::sample_pr_detail(&pr_ref, &base, &head);
    assert_eq!(detail.summary.head_ref, "feature");
    assert_eq!(detail.summary.base_ref, "main");
    detail.threads = vec![Thread {
        id: ThreadId::new("t1"),
        anchor: Some(anchor(&fx.head_sha, "note.txt", 2)),
        resolved: false,
        outdated: false,
        comments: vec![Comment {
            id: CommentId::new("c1"),
            author: testkit::sample_person("author"),
            body: "```suggestion\nTWO FIXED\n```".into(),
            created_at: 0,
            edited: false,
            reactions: Vec::new(),
        }],
    }];
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("etag-1".into()),
        value: detail,
    }));
    f.host.push_viewer(Ok(Person {
        login: "author".into(),
        name: None,
        avatar_url: None,
    }));

    let (core, _recv) = Core::start(deps);
    let resp = core
        .open_pr(OpenPrRequest {
            url: "https://github.com/acme/widget/pull/1".into(),
        })
        .await
        .expect("open_pr");

    core.commit_suggestions(CommitSuggestionsRequest {
        pr: resp.pr,
        comments: vec![CommentId::new("c1")],
        message: "apply suggestion".into(),
    })
    .await
    .expect("commit_suggestions");

    let new_head = git_out(&fx.origin, &["rev-parse", "refs/heads/feature"]);
    assert_ne!(
        new_head, fx.head_sha,
        "the real remote must have a new commit"
    );
    let subject = git_out(
        &fx.origin,
        &["log", "-1", "--format=%s", "refs/heads/feature"],
    );
    assert_eq!(subject, "apply suggestion");
    let content = git_out(&fx.origin, &["show", &format!("{new_head}:note.txt")]);
    assert_eq!(content, "one\nTWO FIXED\nthree");
}

// ── spaces against real git ───────────────────────────────────────────────

/// `git ls-tree -r --name-only <rev>` in `dir`.
fn tree_files(dir: &Path, rev: &str) -> Vec<String> {
    git_out(dir, &["ls-tree", "-r", "--name-only", rev])
        .lines()
        .map(str::to_string)
        .collect()
}

async fn wait_for(what: &str, mut cond: impl FnMut() -> bool) {
    for _ in 0..3000 {
        if cond() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!("{what}: not in time");
}

fn space_row(f: &testkit::Fixtures, id: &str) -> Space {
    serde_json::from_value(f.store.get(models::SPACE, id).unwrap().unwrap().data).unwrap()
}

fn no_goal(project: &str) -> CreateSpaceRequest {
    CreateSpaceRequest {
        project: project.to_string(),
        goal: String::new(),
        name: None,
        branch: None,
        base: None,
        agent: None,
        model: None,
        start_from: None,
    }
}

/// A local-folder project on real git: `folder` with one commit, `core`
/// with its cache under a temp root.
struct LocalFolder {
    _tmp: tempfile::TempDir,
    folder: std::path::PathBuf,
    f: testkit::Fixtures,
    core: Core,
    _recv: crate::Receivers,
    project: String,
}

async fn local_folder(prepare: impl FnOnce(&Path)) -> LocalFolder {
    local_folder_with(prepare, None).await
}

/// `local_folder`, with `agents` instead of the fake.
async fn local_folder_with(
    prepare: impl FnOnce(&Path),
    agents: Option<std::sync::Arc<dyn AgentPort>>,
) -> LocalFolder {
    let tmp = tempfile::tempdir().unwrap();
    let folder = tmp.path().join("folder");
    std::fs::create_dir_all(&folder).unwrap();
    git(&folder, &["init", "-q", "-b", "main"]);
    git(&folder, &["config", "user.email", "a@b.com"]);
    git(&folder, &["config", "user.name", "test"]);
    std::fs::write(folder.join("a.txt"), "one\n").unwrap();
    std::fs::write(folder.join(".env.example"), "KEY=\n").unwrap();
    git(&folder, &["add", "-A"]);
    git(&folder, &["commit", "-q", "-m", "base"]);
    prepare(&folder);
    let f = fixtures();
    let cli = theodore_git::GitCli::new(tmp.path().join("root"), std::sync::Arc::new(NoAuth));
    let base = f.deps();
    let deps = crate::Deps {
        git: std::sync::Arc::new(cli),
        agents: agents.unwrap_or(base.agents.clone()),
        ..base
    };
    let (core, recv) = Core::start(deps);
    let project = core
        .add_project(AddProjectRequest {
            repo: None,
            path: Some(folder.display().to_string()),
        })
        .await
        .expect("add_project");
    wait_for("the project is ready", || {
        f.store
            .get(models::PROJECT, &project.id)
            .unwrap()
            .is_some_and(|r| r.data["status"] == serde_json::json!("ready"))
    })
    .await;
    LocalFolder {
        _tmp: tmp,
        folder,
        f,
        core,
        _recv: recv,
        project: project.id,
    }
}

/// The default `.env*` copy holds secrets git can't see are ignored: the
/// folder's own `.git/info/exclude` isn't the cache's, and a file ignored
/// nowhere is just untracked. Neither may reach a checkpoint or a commit.
#[tokio::test]
async fn copied_env_files_stay_out_of_checkpoints_and_commits() {
    let lf = local_folder(|folder| {
        std::fs::write(folder.join(".env"), "SECRET=excluded\n").unwrap();
        std::fs::write(folder.join(".env.local"), "SECRET=not-ignored\n").unwrap();
        std::fs::write(folder.join(".env.example"), "KEY=\n").unwrap();
        let exclude = folder.join(".git/info/exclude");
        std::fs::write(exclude, ".env\n.env.local\n").unwrap();
    })
    .await;
    let s = lf
        .core
        .create_space(no_goal(&lf.project))
        .await
        .expect("create_space");
    let wt = Path::new(&s.worktree);
    assert_eq!(
        std::fs::read_to_string(wt.join(".env")).unwrap(),
        "SECRET=excluded\n",
        "the space still gets its copy"
    );
    assert_eq!(git_out(wt, &["status", "--porcelain"]), "");

    std::fs::write(wt.join("a.txt"), "one\ntwo\n").unwrap();
    lf.f.agents
        .push_script(vec![theodore_ports::AgentEvent::Done {
            final_text: "done".into(),
            usage: Default::default(),
        }]);
    lf.core
        .space_send(SpaceSendRequest {
            space: s.id.clone(),
            text: "go".into(),
            agent: None,
            model: None,
            mode: None,
            attachments: None,
        })
        .await
        .unwrap();
    wait_for("the turn ends", || {
        space_row(&lf.f, &s.id).status != SpaceStatus::Running
    })
    .await;
    let s = space_row(&lf.f, &s.id);
    let files = tree_files(wt, s.head_sha.as_str());
    assert!(files.contains(&"a.txt".to_string()), "{files:?}");
    assert!(files.contains(&".env.example".to_string()), "{files:?}");
    assert!(!files.iter().any(|p| p == ".env"), "{files:?}");
    assert!(!files.iter().any(|p| p == ".env.local"), "{files:?}");

    lf.core
        .ship_space(ShipSpaceRequest {
            space: s.id.clone(),
            action: ShipAction::KeepBranch,
            title: None,
        })
        .await
        .expect("keep as branch");
    let kept = tree_files(&lf.folder, &s.branch);
    assert!(kept.contains(&"a.txt".to_string()), "{kept:?}");
    assert!(!kept.iter().any(|p| p == ".env"), "{kept:?}");
    assert!(!kept.iter().any(|p| p == ".env.local"), "{kept:?}");
}
