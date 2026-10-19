//! `GitCli::grep` against a real temp repo with a few languages (plan
//! "symbols").

use std::path::Path;
use std::process::Command;

use tempfile::TempDir;
use theodore_domain::RepoRef;
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

/// A tracked tree with a Rust file, a TS file and an untracked file —
/// `git grep` only ever sees the two tracked ones.
fn setup() -> TempDir {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.email", "a@b.com"]);
    git(dir, &["config", "user.name", "test"]);
    std::fs::write(
        dir.join("lib.rs"),
        "pub fn widget_count() -> u32 {\n    0\n}\n\nfn call_site() {\n    widget_count();\n}\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("app.ts"),
        "export function widgetCount(): number {\n  return 0;\n}\n\nwidgetCount();\n",
    )
    .unwrap();
    std::fs::write(dir.join("untracked.rs"), "fn widget_count() {}\n").unwrap();
    git(dir, &["add", "lib.rs", "app.ts"]);
    git(dir, &["commit", "-q", "-m", "seed"]);
    tmp
}

#[tokio::test]
async fn finds_every_whole_word_match_in_tracked_files_only() {
    let tmp = setup();
    let git_cli = GitCli::new(
        tmp.path().join(".theodore-root"),
        std::sync::Arc::new(NoAuth),
    );

    let hits = git_cli
        .grep(tmp.path(), r"widget_count")
        .await
        .expect("grep");
    let paths: Vec<&str> = hits.iter().map(|h| h.path.as_str()).collect();
    assert!(paths.contains(&"lib.rs"));
    // Whole-word (`-w`): `widgetCount` (camelCase) in app.ts must not match
    // the snake_case pattern.
    assert!(!paths.contains(&"app.ts"));
    // Untracked files are invisible to `git grep`.
    assert!(!paths.contains(&"untracked.rs"));
    assert_eq!(hits.iter().filter(|h| h.path == "lib.rs").count(), 2);
}

#[tokio::test]
async fn whole_word_match_excludes_substrings() {
    let tmp = setup();
    let git_cli = GitCli::new(
        tmp.path().join(".theodore-root"),
        std::sync::Arc::new(NoAuth),
    );

    // `widget` is a substring of `widget_count`, not a whole-word match.
    let hits = git_cli.grep(tmp.path(), r"widget").await.expect("grep");
    assert!(hits.is_empty());
}

#[tokio::test]
async fn no_match_is_an_empty_list_not_an_error() {
    let tmp = setup();
    let git_cli = GitCli::new(
        tmp.path().join(".theodore-root"),
        std::sync::Arc::new(NoAuth),
    );

    let hits = git_cli
        .grep(tmp.path(), r"totally_absent_identifier")
        .await
        .expect("grep");
    assert!(hits.is_empty());
}

#[tokio::test]
async fn definition_pattern_distinguishes_declaration_from_call_site() {
    let tmp = setup();
    let git_cli = GitCli::new(
        tmp.path().join(".theodore-root"),
        std::sync::Arc::new(NoAuth),
    );

    let hits = git_cli
        .grep(tmp.path(), r"(pub[[:space:]]+)?fn[[:space:]]+widget_count")
        .await
        .expect("grep");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "lib.rs");
    assert_eq!(hits[0].line, 1);
}
