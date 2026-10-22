//! Co-change history for grouping: which of a PR's files tended to change
//! together before it.

use std::collections::BTreeSet;
use std::path::Path;

use theodore_domain::Sha;
use theodore_ports::GitResult;

use crate::GitCli;
use crate::process::GitProc;
use crate::safety::END_OF_OPTIONS;

/// Starts each commit's record in `git log` output; never in a path.
const RS: char = '\u{1e}';

impl GitCli {
    pub(crate) async fn co_change_commits_op(
        &self,
        repo: &Path,
        rev: &Sha,
        paths: &[String],
        max_commits: usize,
        max_files: usize,
    ) -> GitResult<Vec<Vec<String>>> {
        if paths.is_empty() || max_commits == 0 {
            return Ok(Vec::new());
        }
        let askpass = self.ensure_askpass()?;
        let limit = format!("--max-count={max_commits}");
        let out = GitProc {
            cwd: repo,
            askpass: &askpass,
            args: &[
                "log",
                "--no-merges",
                "--no-renames",
                "--name-only",
                "--format=%x1e",
                &limit,
                END_OF_OPTIONS,
                rev.as_str(),
            ],
            token: None,
            stdin: None,
        }
        .run_text()
        .await?;
        Ok(parse_co_change(&out, paths, max_files))
    }
}

fn parse_co_change(out: &str, paths: &[String], max_files: usize) -> Vec<Vec<String>> {
    let wanted: BTreeSet<&str> = paths.iter().map(String::as_str).collect();
    out.split(RS)
        .filter_map(|record| {
            let touched: Vec<&str> = record
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .collect();
            if touched.is_empty() || touched.len() > max_files {
                return None;
            }
            let hits: Vec<String> = touched
                .into_iter()
                .filter(|p| wanted.contains(p))
                .map(str::to_string)
                .collect();
            (!hits.is_empty()).then_some(hits)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_wanted_paths_and_drops_bulk_commits() {
        let out = "\u{1e}\n\na.rs\nb.rs\nc.rs\n\u{1e}\n\na.rs\nx.rs\n\u{1e}\n\nx.rs\n\u{1e}\n\na.rs\nb.rs\nx1\nx2\nx3\n";
        let paths = vec!["a.rs".to_string(), "b.rs".to_string()];
        let got = parse_co_change(out, &paths, 4);
        assert_eq!(
            got,
            vec![
                vec!["a.rs".to_string(), "b.rs".to_string()],
                vec!["a.rs".to_string()]
            ]
        );
    }
}
