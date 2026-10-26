//! Saving a project's config on real git: one file committed onto a branch
//! tip in the bare cache (no worktree), and a single-file commit in a local
//! folder that leaves everything else alone.

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use tempfile::TempDir;
use theodore_domain::{HostKind, RepoRef};
use theodore_git::GitCli;
use theodore_ports::{CredentialSource, GitPort, Identity};

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

/// A repo with `a.txt`, `docs/b.md` and an existing `.theodore/other.yaml`.
/// Its own hooks dir, so a personal global hook never runs here.
fn init_repo(dir: &Path) {
    std::fs::create_dir_all(dir.join("docs")).unwrap();
    std::fs::create_dir_all(dir.join(".theodore")).unwrap();
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.email", "a@b.com"]);
    git(dir, &["config", "user.name", "Folder Owner"]);
    git(dir, &["config", "commit.gpgsign", "false"]);
    let hooks = dir.join(".git/test-hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    git(dir, &["config", "core.hooksPath", hooks.to_str().unwrap()]);
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    std::fs::write(dir.join("docs/b.md"), "bee\n").unwrap();
    std::fs::write(dir.join(".theodore/other.yaml"), "x: 1\n").unwrap();
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-q", "-m", "base"]);
}

fn repo() -> RepoRef {
    RepoRef {
        host: HostKind::Github,
        owner: "acme".into(),
        name: "widget".into(),
    }
}

fn me() -> Identity {
    Identity {
        name: "Ada Lovelace".into(),
        email: "ada@example.com".into(),
    }
}

#[tokio::test]
async fn a_file_is_committed_onto_a_tip_without_a_worktree() {
    let tmp = TempDir::new().unwrap();
    let work = tmp.path().join("work");
    init_repo(&work);
    let bare = tmp.path().join("remote.git");
    git(
        tmp.path(),
        &["clone", "-q", "--bare", "work", bare.to_str().unwrap()],
    );
    let url = format!("file://{}", bare.display());
    let cli = GitCli::new(tmp.path().join("root"), Arc::new(NoAuth))
        .with_remote_urls(Arc::new(move |_r: &RepoRef| Some(url.clone())));
    let cache = cli.ensure_repo(&repo()).await.expect("clone");
    let base = cli.resolve_ref(&cache, "main").await.unwrap();

    let first = cli
        .commit_file(
            &cache,
            &base,
            ".theodore/config.yaml",
            b"review:\n  hide: [\"gen/**\"]\n",
            "Add Theodore config",
            &me(),
        )
        .await
        .unwrap();
    assert_eq!(git(&cache, &["rev-parse", &format!("{first}^")]), base.0);
    assert_eq!(
        git(&cache, &["show", &format!("{first}:.theodore/config.yaml")]),
        "review:\n  hide: [\"gen/**\"]"
    );
    // Everything else is the parent's, the sibling in `.theodore/` included.
    assert_eq!(
        git(
            &cache,
            &["diff", "--name-only", base.as_str(), first.as_str()]
        ),
        ".theodore/config.yaml"
    );
    assert_eq!(
        git(&cache, &["show", &format!("{first}:.theodore/other.yaml")]),
        "x: 1"
    );
    assert_eq!(
        git(
            &cache,
            &["log", "-1", "--format=%an <%ae>|%cn|%s", first.as_str()]
        ),
        "Ada Lovelace <ada@example.com>|Ada Lovelace|Add Theodore config"
    );
    // No ref moved, no worktree made.
    assert_eq!(cli.resolve_ref(&cache, "main").await.unwrap(), base);
    assert!(!tmp.path().join("root/wt").exists());

    // A second save edits the same file on top of the first.
    let second = cli
        .commit_file(
            &cache,
            &first,
            ".theodore/config.yaml",
            b"review: {}\n",
            "Update Theodore config",
            &me(),
        )
        .await
        .unwrap();
    assert_eq!(git(&cache, &["rev-parse", &format!("{second}^")]), first.0);
    assert_eq!(
        git(
            &cache,
            &["show", &format!("{second}:.theodore/config.yaml")]
        ),
        "review: {}"
    );

    // A brand-new directory is created on the way.
    let deep = cli
        .commit_file(&cache, &base, "x/y/z.yaml", b"z\n", "deep", &me())
        .await
        .unwrap();
    assert_eq!(git(&cache, &["show", &format!("{deep}:x/y/z.yaml")]), "z");
}

#[tokio::test]
async fn a_folder_commit_takes_only_the_named_path() {
    let tmp = TempDir::new().unwrap();
    let folder = tmp.path().join("app");
    init_repo(&folder);
    let cli = GitCli::new(tmp.path().join("root"), Arc::new(NoAuth));
    assert!(cli.dirty_paths(&folder).await.unwrap().is_empty());

    std::fs::write(folder.join(".theodore/config.yaml"), "review: {}\n").unwrap();
    std::fs::write(folder.join("a.txt"), "edited\n").unwrap();
    let mut dirty = cli.dirty_paths(&folder).await.unwrap();
    dirty.sort();
    assert_eq!(dirty, vec![".theodore/config.yaml", "a.txt"]);

    let head = cli
        .commit_paths(
            &folder,
            &[".theodore/config.yaml".to_string()],
            "Add Theodore config",
        )
        .await
        .unwrap();
    assert_eq!(git(&folder, &["rev-parse", "HEAD"]), head.0);
    assert_eq!(
        git(&folder, &["show", "--name-only", "--format=%an|%s", "HEAD"]),
        "Folder Owner|Add Theodore config\n\n.theodore/config.yaml"
    );
    // The other edit is still there, uncommitted.
    assert_eq!(cli.dirty_paths(&folder).await.unwrap(), vec!["a.txt"]);
}

#[tokio::test]
async fn a_failing_hook_refuses_the_folder_commit() {
    let tmp = TempDir::new().unwrap();
    let folder = tmp.path().join("app");
    init_repo(&folder);
    let hook = folder.join(".git/test-hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\necho 'lint says no' >&2\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::fs::write(folder.join(".theodore/config.yaml"), "review: {}\n").unwrap();
    let cli = GitCli::new(tmp.path().join("root"), Arc::new(NoAuth));
    let err = cli
        .commit_paths(&folder, &[".theodore/config.yaml".to_string()], "Add")
        .await
        .unwrap_err();
    assert!(err.to_string().contains("lint says no"), "{err}");
}
