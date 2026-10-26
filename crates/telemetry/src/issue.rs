//! "Report a problem" as a GitHub issue (docs/telemetry.md): the body is
//! the user's comment, an app-info table and, when asked, the newest log
//! lines from `report::log_tail` (redacted like the zip, never more).
//!
//! ```text
//! <comment>
//!
//! | App info | |              version, channel, commit, build, built,
//! |---|---|                    OS, arch: no ids, no paths
//! | Version | 0.4.0 |
//!
//! <details><summary>Logs (last N lines; M older lines cut)</summary>
//!
//! ```jsonl                     the newest lines that fit, oldest first
//! …
//! ```
//!
//! </details>
//! ```
//!
//! GitHub caps a body at 65,536 characters: the logs get what the comment
//! and the table leave, and the summary says how many older lines were cut.

use std::fmt;

use crate::report::LogTail;

/// GitHub's cap on an issue body, in characters. Bytes are counted here:
/// never fewer than characters, so a body that fits in bytes fits.
pub const MAX_BODY: usize = 65_536;
/// GitHub's cap on an issue title.
pub const MAX_TITLE: usize = 256;
/// Room for the logs block's own lines (summary, fences, tags).
const LOGS_FRAME: usize = 256;
/// The label asked for; dropped when the repo refuses it.
pub const LABEL: &str = "from-app";

/// Where issues go: `THEODORE_FEEDBACK_REPO` at build time, else
/// Theodore's own repository. The `report.github_repo` setting overrides
/// both (for testing against a scratch repo).
pub const BUILT_IN_REPO: Option<&str> = option_env!("THEODORE_FEEDBACK_REPO");
pub const DEFAULT_REPO: &str = "JeanIsahakyan/theodore";

/// `owner/name`, if `s` is one (also `https://github.com/owner/name`).
pub fn parse_repo(s: &str) -> Option<(String, String)> {
    let s = s.trim().trim_end_matches('/').trim_end_matches(".git");
    let s = s
        .strip_prefix("https://github.com/")
        .or_else(|| s.strip_prefix("github.com/"))
        .unwrap_or(s);
    let (owner, name) = s.split_once('/')?;
    let ok = |p: &str| {
        !p.is_empty()
            && p.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    (ok(owner) && ok(name)).then(|| (owner.to_string(), name.to_string()))
}

/// The target repo: the setting, the build's, the default; the first that
/// parses wins.
pub fn target_repo(setting: Option<&str>) -> (String, String) {
    [setting, BUILT_IN_REPO]
        .into_iter()
        .flatten()
        .find_map(parse_repo)
        .or_else(|| parse_repo(DEFAULT_REPO))
        .expect("the default repo parses")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueError {
    NoTitle,
    TitleTooLong,
    NoComment,
    /// The comment alone leaves no room under GitHub's cap.
    CommentTooLong,
}

impl fmt::Display for IssueError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            IssueError::NoTitle => "a title is required",
            IssueError::TitleTooLong => "the title is longer than GitHub allows (256 characters)",
            IssueError::NoComment => "a comment is required",
            IssueError::CommentTooLong => "the comment is too long for a GitHub issue",
        })
    }
}

impl std::error::Error for IssueError {}

/// The title as posted: trimmed, required, within GitHub's cap.
pub fn title(raw: &str) -> Result<String, IssueError> {
    let t = raw.trim();
    if t.is_empty() {
        return Err(IssueError::NoTitle);
    }
    if t.chars().count() > MAX_TITLE {
        return Err(IssueError::TitleTooLong);
    }
    Ok(t.to_string())
}

pub struct IssueInput<'a> {
    pub comment: &'a str,
    /// `(label, value)` rows of the app-info table, in order.
    pub info: &'a [(String, String)],
    pub logs: Option<&'a LogTail>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueBody {
    /// Exactly what is posted.
    pub body: String,
    /// The logs block `body` ends with, so a preview can fold it.
    pub logs: Option<String>,
    pub log_lines: usize,
    /// Older lines left out: the tail's own plus those cut to fit here.
    pub cut_lines: usize,
}

fn cell(v: &str) -> String {
    v.replace(['\r', '\n'], " ").replace('|', "\\|")
}

/// A fence longer than any backtick run in `lines`, so a log line can't
/// close it early.
fn fence(lines: &[String]) -> String {
    let longest = lines
        .iter()
        .flat_map(|l| l.split(|c| c != '`'))
        .map(str::len)
        .max()
        .unwrap_or(0);
    "`".repeat(longest.max(2) + 1)
}

fn logs_block(lines: &[String], cut: usize) -> String {
    let summary = match (lines.len(), cut) {
        (0, 0) => "Logs (empty)".to_string(),
        (n, 0) => format!("Logs (last {n} lines)"),
        (n, c) => format!("Logs (last {n} lines; {c} older lines cut)"),
    };
    let mut out = format!("\n\n<details><summary>{summary}</summary>\n\n");
    if !lines.is_empty() {
        let f = fence(lines);
        out.push_str(&format!("{f}jsonl\n{}\n{f}\n\n", lines.join("\n")));
    }
    out.push_str("</details>\n");
    out
}

pub fn build(input: IssueInput<'_>) -> Result<IssueBody, IssueError> {
    let comment = input.comment.trim();
    if comment.is_empty() {
        return Err(IssueError::NoComment);
    }
    let mut head = format!("{comment}\n\n| App info | |\n|---|---|\n");
    for (k, v) in input.info {
        head.push_str(&format!("| {} | {} |\n", cell(k), cell(v)));
    }
    let head = head.trim_end().to_string();
    let frame = if input.logs.is_some() { LOGS_FRAME } else { 0 };
    if head.len() + frame > MAX_BODY {
        return Err(IssueError::CommentTooLong);
    }
    let Some(tail) = input.logs else {
        return Ok(IssueBody {
            body: format!("{head}\n"),
            logs: None,
            log_lines: 0,
            cut_lines: 0,
        });
    };

    // The newest lines that fit what the head leaves.
    let room = MAX_BODY - head.len() - LOGS_FRAME;
    let mut used = 0;
    let keep = tail
        .lines
        .iter()
        .rev()
        .take_while(|l| {
            used += l.len() + 1;
            used <= room
        })
        .count();
    let mut start = tail.lines.len() - keep;
    loop {
        let lines = &tail.lines[start..];
        let cut = tail.older + start;
        let block = logs_block(lines, cut);
        // A long backtick run can outgrow the frame: drop one more line.
        if head.len() + block.len() > MAX_BODY && start < tail.lines.len() {
            start += 1;
            continue;
        }
        return Ok(IssueBody {
            body: format!("{head}{block}"),
            logs: Some(block),
            log_lines: lines.len(),
            cut_lines: cut,
        });
    }
}

/// `2026-10-24 09:30 UTC`, for the table's "Built" row.
pub fn built_at(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| d.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_else(|| "unknown".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn info() -> Vec<(String, String)> {
        vec![
            ("Version".into(), "0.4.0".into()),
            ("Commit".into(), "a1b2c3d".into()),
        ]
    }

    #[test]
    fn the_body_is_the_comment_then_the_app_info() {
        let info = info();
        let b = build(IssueInput {
            comment: "  The diff pane is blank.  ",
            info: &info,
            logs: None,
        })
        .unwrap();
        assert_eq!(
            b.body,
            "The diff pane is blank.\n\n| App info | |\n|---|---|\n\
             | Version | 0.4.0 |\n| Commit | a1b2c3d |\n"
        );
        assert_eq!((b.logs, b.log_lines, b.cut_lines), (None, 0, 0));
    }

    #[test]
    fn logs_fold_into_a_details_block_at_the_end() {
        let info = info();
        let tail = LogTail {
            lines: vec![r#"{"msg":"a"}"#.into(), r#"{"msg":"b"}"#.into()],
            older: 0,
        };
        let b = build(IssueInput {
            comment: "Blank.",
            info: &info,
            logs: Some(&tail),
        })
        .unwrap();
        let logs = b.logs.clone().unwrap();
        assert!(b.body.ends_with(&logs));
        assert_eq!(
            logs,
            "\n\n<details><summary>Logs (last 2 lines)</summary>\n\n\
             ```jsonl\n{\"msg\":\"a\"}\n{\"msg\":\"b\"}\n```\n\n</details>\n"
        );
        assert_eq!((b.log_lines, b.cut_lines), (2, 0));
    }

    #[test]
    fn long_logs_keep_the_newest_lines_under_githubs_cap() {
        let info = info();
        let lines: Vec<String> = (0..5000)
            .map(|i| format!(r#"{{"n":{i},"msg":"{}"}}"#, "x".repeat(40)))
            .collect();
        let tail = LogTail { lines, older: 7 };
        let b = build(IssueInput {
            comment: "Blank.",
            info: &info,
            logs: Some(&tail),
        })
        .unwrap();
        assert!(b.body.len() <= MAX_BODY, "{}", b.body.len());
        assert!(b.body.len() > MAX_BODY - 1024, "the room is used");
        assert!(b.body.contains(r#"{"n":4999,"#), "the newest line is kept");
        assert!(!b.body.contains(r#"{"n":0,"#), "the oldest are cut");
        assert_eq!(b.log_lines + b.cut_lines, 5000 + 7);
        assert!(b.body.contains(&format!(
            "Logs (last {} lines; {} older lines cut)",
            b.log_lines, b.cut_lines
        )));
    }

    #[test]
    fn a_backtick_run_in_the_logs_cannot_close_the_fence() {
        let info = info();
        let tail = LogTail {
            lines: vec![r#"{"msg":"see ```` here"}"#.into()],
            older: 0,
        };
        let b = build(IssueInput {
            comment: "c",
            info: &info,
            logs: Some(&tail),
        })
        .unwrap();
        assert!(b.body.contains("\n`````jsonl\n"), "{}", b.body);
    }

    #[test]
    fn table_cells_cannot_break_the_table() {
        let info = vec![("OS".to_string(), "mac|OS\n15".to_string())];
        let b = build(IssueInput {
            comment: "c",
            info: &info,
            logs: None,
        })
        .unwrap();
        assert!(b.body.contains("| OS | mac\\|OS 15 |"));
    }

    #[test]
    fn title_and_comment_are_required_and_bounded() {
        assert_eq!(title("  "), Err(IssueError::NoTitle));
        assert_eq!(title(&"t".repeat(257)), Err(IssueError::TitleTooLong));
        assert_eq!(title(" Blank pane ").unwrap(), "Blank pane");
        let info = info();
        let empty = build(IssueInput {
            comment: " \n",
            info: &info,
            logs: None,
        });
        assert_eq!(empty, Err(IssueError::NoComment));
        let huge = "c".repeat(MAX_BODY);
        let long = build(IssueInput {
            comment: &huge,
            info: &info,
            logs: None,
        });
        assert_eq!(long, Err(IssueError::CommentTooLong));
    }

    #[test]
    fn the_target_repo_is_the_setting_then_the_build_then_the_default() {
        assert_eq!(
            target_repo(Some("me/scratch")),
            ("me".to_string(), "scratch".to_string())
        );
        assert_eq!(
            target_repo(Some("https://github.com/me/scratch.git")),
            ("me".to_string(), "scratch".to_string())
        );
        let fallback = target_repo(Some("not a repo"));
        assert_eq!(
            fallback,
            parse_repo(BUILT_IN_REPO.unwrap_or(DEFAULT_REPO)).unwrap()
        );
        assert_eq!(parse_repo("a/b/c"), None);
        assert_eq!(parse_repo("/b"), None);
    }

    #[test]
    fn built_at_reads_as_a_utc_minute() {
        assert_eq!(built_at(1_761_298_200_000), "2025-10-24 09:30 UTC");
    }
}
