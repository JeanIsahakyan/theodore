//! `git grep` over a worktree (plan "symbols"): go-to-definition and
//! find-references without a full LSP.

use std::path::Path;

use theodore_ports::{GitError, GitResult, GrepHit};

use crate::GitCli;
use crate::process::GitProc;

impl GitCli {
    /// Whole-word, extended-regex grep of `worktree`'s tracked files.
    /// `-I` skips binary files; `-w` matches `pattern` only as a whole word,
    /// which lets definition patterns end in a bare identifier without a
    /// `\b` (not portable across the regex engines `git grep -E` ends up
    /// using on different platforms).
    pub(crate) async fn grep_op(&self, worktree: &Path, pattern: &str) -> GitResult<Vec<GrepHit>> {
        let askpass = self.ensure_askpass()?;
        let args = ["grep", "-n", "-I", "-w", "-E", pattern];
        let result = GitProc {
            cwd: worktree,
            askpass: &askpass,
            args: &args,
            token: None,
            stdin: None,
        }
        .run_text()
        .await;
        match result {
            Ok(text) => Ok(parse_grep(&text)),
            // `git grep` exits 1 with no stderr when nothing matched.
            Err(GitError::Command {
                code: 1, stderr, ..
            }) if stderr.trim().is_empty() => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }
}

/// Parses `path:line:content` output. `path` never contains `:` (it's a
/// repo-relative file path); `content` may, so only the first two
/// separators are significant.
fn parse_grep(text: &str) -> Vec<GrepHit> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, ':');
            let path = parts.next()?.to_string();
            let line_no = parts.next()?.parse::<u32>().ok()?;
            let content = parts.next().unwrap_or("").to_string();
            Some(GrepHit {
                path,
                line: line_no,
                text: content,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_path_line_content_keeping_colons_in_the_text() {
        let out = "src/a.rs:12:    let x: u32 = 1;\nsrc/b.rs:3:fn b() {}";
        let hits = parse_grep(out);
        assert_eq!(
            hits,
            vec![
                GrepHit {
                    path: "src/a.rs".into(),
                    line: 12,
                    text: "    let x: u32 = 1;".into(),
                },
                GrepHit {
                    path: "src/b.rs".into(),
                    line: 3,
                    text: "fn b() {}".into(),
                },
            ]
        );
    }

    #[test]
    fn ignores_lines_that_do_not_parse() {
        assert_eq!(parse_grep("garbage\nalso:not-a-number:x"), Vec::new());
    }
}
