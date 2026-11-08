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
//! <details><summary>Conversation: Space turn 3 of 5</summary>   a chat report only
//!   | Context | |  …           where, agent, CLI, model, effort, mode, status, timings
//!   **Prompt** / **Reply** / **Error**   fenced, capped, secrets redacted
//!   <details>Tool calls (N)</details>
//! </details>
//!
//! <details><summary>Logs (last N lines; M older lines cut)</summary>
//!
//! ```jsonl                     the newest lines that fit, oldest first
//! …                            (a chat report: that run's lines only)
//! ```
//!
//! </details>
//! ```
//!
//! GitHub caps a body at 65,536 characters: the logs get what the comment,
//! the table and the conversation leave, and the summary says how many
//! older lines were cut.

use std::fmt;

use crate::redact::{Redactor, truncate};
use crate::report::LogTail;

/// A chat report's conversation (docs/telemetry.md "Report from a chat"):
/// gathered by the core, redacted and capped by [`context_block`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChatContext {
    /// One line: `Space turn 3 of 5`, `AI panel reply 2 of 4`.
    pub about: String,
    /// `(label, value)` rows: where, agent, CLI, model, effort, mode…
    pub rows: Vec<(String, String)>,
    /// Your message as sent (skill and attached files expanded).
    pub prompt: Option<String>,
    pub reply: Option<String>,
    /// One line per tool call, in order.
    pub tools: Vec<String>,
    pub error: Option<String>,
}

/// Caps on a conversation's parts, so the logs keep room under GitHub's.
pub const MAX_PROMPT: usize = 4_000;
pub const MAX_REPLY: usize = 8_000;
pub const MAX_ERROR: usize = 2_000;
pub const MAX_TOOLS: usize = 40;
pub const MAX_TOOL_LINE: usize = 200;

/// A fenced block: the text can't close it, and nothing in it renders
/// (no @mention notifies anyone, no image loads).
fn fenced(lang: &str, text: &str) -> String {
    let lines: Vec<String> = text.lines().map(str::to_string).collect();
    let f = fence(&lines);
    format!("{f}{lang}\n{}\n{f}\n", text.trim_end())
}

/// The conversation as posted: folded, every text fenced, each part capped
/// and redacted (secrets, emails, the home directory) — paths and names
/// stay readable, as in the conversation itself.
pub fn context_block(c: &ChatContext, redactor: &Redactor) -> String {
    let clean = |s: &str, max: usize, tail: bool| truncate(&redactor.text(s), max, tail);
    let mut out = format!(
        "\n\n<details><summary>Conversation: {}</summary>\n\n| Context | |\n|---|---|\n",
        cell(&redactor.text(&c.about))
    );
    for (k, v) in &c.rows {
        out.push_str(&format!(
            "| {} | {} |\n",
            cell(k),
            cell(&clean(v, MAX_TOOL_LINE, false))
        ));
    }
    for (label, text, max, tail) in [
        ("Prompt", &c.prompt, MAX_PROMPT, false),
        ("Reply", &c.reply, MAX_REPLY, false),
        ("Error", &c.error, MAX_ERROR, true),
    ] {
        if let Some(t) = text.as_deref().filter(|t| !t.trim().is_empty()) {
            out.push_str(&format!(
                "\n**{label}**\n\n{}",
                fenced("text", &clean(t, max, tail))
            ));
        }
    }
    if !c.tools.is_empty() {
        let shown: Vec<String> = c
            .tools
            .iter()
            .take(MAX_TOOLS)
            .map(|t| clean(&t.replace(['\r', '\n'], " "), MAX_TOOL_LINE, false))
            .collect();
        let more = c.tools.len().saturating_sub(MAX_TOOLS);
        let mut list = shown.join("\n");
        if more > 0 {
            list.push_str(&format!("\n… {more} more"));
        }
        out.push_str(&format!(
            "\n<details><summary>Tool calls ({})</summary>\n\n{}\n</details>\n",
            c.tools.len(),
            fenced("text", &list)
        ));
    }
    out.push_str("\n</details>");
    out
}

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
    /// A chat report's [`context_block`], after the table.
    pub context: Option<&'a str>,
    pub logs: Option<&'a LogTail>,
    /// The logs are one run's (a chat report's): their summary says so.
    pub run_logs: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueBody {
    /// Exactly what is posted.
    pub body: String,
    /// The conversation block in `body`, so a preview can fold it.
    pub context: Option<String>,
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

fn logs_block(lines: &[String], cut: usize, run: bool) -> String {
    let what = if run { "Logs of this run" } else { "Logs" };
    let summary = match (lines.len(), cut) {
        (0, 0) => format!("{what} (empty)"),
        (n, 0) => format!("{what} (last {n} lines)"),
        (n, c) => format!("{what} (last {n} lines; {c} older lines cut)"),
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
    let mut head = head.trim_end().to_string();
    let context = input.context.map(str::to_string);
    if let Some(c) = &context {
        head.push_str(c);
    }
    let frame = if input.logs.is_some() { LOGS_FRAME } else { 0 };
    if head.len() + frame > MAX_BODY {
        return Err(IssueError::CommentTooLong);
    }
    let Some(tail) = input.logs else {
        return Ok(IssueBody {
            body: format!("{head}\n"),
            context,
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
        let block = logs_block(lines, cut, input.run_logs);
        // A long backtick run can outgrow the frame: drop one more line.
        if head.len() + block.len() > MAX_BODY && start < tail.lines.len() {
            start += 1;
            continue;
        }
        return Ok(IssueBody {
            body: format!("{head}{block}"),
            context,
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
            context: None,
            logs: None,
            run_logs: false,
        })
        .unwrap();
        assert_eq!(
            b.body,
            "The diff pane is blank.\n\n| App info | |\n|---|---|\n\
             | Version | 0.4.0 |\n| Commit | a1b2c3d |\n"
        );
        assert_eq!((b.logs, b.log_lines, b.cut_lines), (None, 0, 0));
    }

    fn chat() -> ChatContext {
        ChatContext {
            about: "Space turn 2 of 3".into(),
            rows: vec![
                ("Agent".into(), "claude 2.1.0".into()),
                ("Mode".into(), "Edit".into()),
            ],
            prompt: Some("fix the login, token ghp_abcdefghijklmnopqrstuvwxyz0123456789".into()),
            reply: Some("Done, see @octocat\n```rust\nfn x() {}\n```".into()),
            tools: vec!["✓ Bash · cargo test — 12 lines".into()],
            error: None,
        }
    }

    #[test]
    fn a_chat_report_folds_the_conversation_between_the_table_and_the_logs() {
        let info = info();
        let redactor = Redactor::new(None, "s");
        let ctx = context_block(&chat(), &redactor);
        let tail = LogTail {
            lines: vec![r#"{"run_id":"r1"}"#.into()],
            older: 0,
        };
        let b = build(IssueInput {
            comment: "It ignored me.",
            info: &info,
            context: Some(&ctx),
            logs: Some(&tail),
            run_logs: true,
        })
        .unwrap();
        let table = b.body.find("| App info |").unwrap();
        let conv = b
            .body
            .find("<summary>Conversation: Space turn 2 of 3")
            .unwrap();
        let logs = b
            .body
            .find("<summary>Logs of this run (last 1 lines)")
            .unwrap();
        assert!(table < conv && conv < logs, "{}", b.body);
        assert_eq!(b.context.as_deref(), Some(ctx.as_str()));
        assert!(b.body.contains("| Agent | claude 2.1.0 |"));
        assert!(!b.body.contains("ghp_"), "secrets redacted: {}", b.body);
        // The reply's own fence can't close the block it's quoted in.
        assert!(b.body.contains("\n````text\nDone, see @octocat\n```rust"));
        assert!(b.body.contains("<summary>Tool calls (1)</summary>"));
        assert!(!b.body.contains("**Error**"), "no error: no section");
    }

    #[test]
    fn a_conversation_is_capped() {
        let redactor = Redactor::new(None, "s");
        let mut c = chat();
        c.reply = Some("r".repeat(MAX_REPLY * 3));
        c.tools = (0..MAX_TOOLS + 5).map(|i| format!("tool {i}")).collect();
        let block = context_block(&c, &redactor);
        assert!(
            block.len() < MAX_REPLY + MAX_PROMPT + 10_000,
            "{}",
            block.len()
        );
        assert!(block.contains("[truncated"));
        assert!(block.contains("… 5 more"));
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
            context: None,
            logs: Some(&tail),
            run_logs: false,
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
            context: None,
            logs: Some(&tail),
            run_logs: false,
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
            context: None,
            logs: Some(&tail),
            run_logs: false,
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
            context: None,
            logs: None,
            run_logs: false,
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
            context: None,
            logs: None,
            run_logs: false,
        });
        assert_eq!(empty, Err(IssueError::NoComment));
        let huge = "c".repeat(MAX_BODY);
        let long = build(IssueInput {
            comment: &huge,
            info: &info,
            context: None,
            logs: None,
            run_logs: false,
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
