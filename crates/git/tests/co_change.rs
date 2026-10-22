//! `GitCli::co_change_commits` against a real temp repo: history before a
//! revision, reduced to the paths asked about, bulk commits left out.

use std::path::Path;
use std::process::Command;

use tempfile::TempDir;
use theodore_domain::{RepoRef, Sha};
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

fn commit(dir: &Path, files: &[&str], msg: &str) {
    for f in files {
        let p = dir.join(f);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let prev = std::fs::read_to_string(&p).unwrap_or_default();
        std::fs::write(&p, format!("{prev}{msg}\n")).unwrap();
        git(dir, &["add", f]);
    }
    git(dir, &["commit", "-q", "-m", msg]);
}

#[tokio::test]
async fn reports_commits_touching_the_paths_and_skips_bulk_ones() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    git(dir, &["init", "-q", "-b", "main"]);
    git(dir, &["config", "user.email", "a@b.com"]);
    git(dir, &["config", "user.name", "test"]);
    commit(dir, &["src/lexer.c", "docs/grammar.md"], "one");
    commit(dir, &["src/lexer.c", "docs/grammar.md", "README"], "two");
    commit(dir, &["src/net.c"], "three");
    let bulk: Vec<String> = (0..15).map(|i| format!("gen/f{i}.c")).collect();
    let mut bulk_refs: Vec<&str> = bulk.iter().map(String::as_str).collect();
    bulk_refs.push("src/lexer.c");
    commit(dir, &bulk_refs, "bulk");
    let head = Sha::new(git(dir, &["rev-parse", "HEAD"]));

    let cli = GitCli::new(dir.join(".theodore-root"), std::sync::Arc::new(NoAuth));
    let paths = vec!["src/lexer.c".to_string(), "docs/grammar.md".to_string()];
    let mut got = cli
        .co_change_commits(dir, &head, &paths, 100, 12)
        .await
        .expect("co-change");
    for c in &mut got {
        c.sort();
    }
    assert_eq!(
        got,
        vec![
            vec!["docs/grammar.md".to_string(), "src/lexer.c".to_string()],
            vec!["docs/grammar.md".to_string(), "src/lexer.c".to_string()],
        ],
        "the bulk commit (16 files) and the unrelated one are left out"
    );
    let one = cli
        .co_change_commits(dir, &head, &paths, 3, 12)
        .await
        .expect("co-change");
    assert_eq!(
        one.len(),
        1,
        "max_commits bounds the scan (bulk, three, two), not the result"
    );
}
