//! Theodore's own errors for a space, kept for its agent (docs/spaces.md
//! "Theodore's errors reach the agent"): a checkpoint that failed, a ship
//! refused, the agent's process crashing, a file another device sent that
//! couldn't be written… Logged as before; also recorded here, per space.
//!
//! ```text
//! note_space_error(space, code, text) ─▶ redacted, one line ─┬─ same code + text ─▶ ×N, newer
//!                                                             └─ else ─▶ appended (≤ MAX_ENTRIES)
//! the next turn starts ─▶ take_space_error_notes ─▶ ≤ NOTES_PER_TURN lines, oldest first,
//!                          each told once (told again only if it recurs after a later turn)
//! read_logs {kind: theodore} ─▶ space_error_lines ─▶ the last N entries, newest last
//! ```
//!
//! In memory only, like the commands' log lines: gone on restart. Redacted
//! as the issue reports are (secrets, emails, the home directory), and
//! paths outside the worktree replaced by `<path>`; the worktree itself
//! reads as `.`.

use std::collections::{HashMap, VecDeque};
use std::sync::{LazyLock, Mutex};

use regex::Regex;
use theodore_contract::Space;
use theodore_domain::Millis;

use crate::core::Core;

/// Entries kept per space; the oldest go first.
pub(crate) const MAX_ENTRIES: usize = 100;
/// Notes one turn's prompt opens with, at most.
pub(crate) const NOTES_PER_TURN: usize = 3;
/// Characters of one entry's text.
pub(crate) const TEXT_CHARS: usize = 300;

/// One recorded error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SpaceErrorEntry {
    /// When it last happened.
    pub at: Millis,
    /// `warn` or `error`.
    pub level: &'static str,
    /// The stable code (docs/telemetry.md "Error codes").
    pub code: String,
    /// One redacted line.
    pub text: String,
    /// How many times, folded.
    pub count: u32,
    /// The turn window (`SpaceErrors::turns`) it was told to the agent in.
    told: Option<u64>,
}

#[derive(Debug, Default)]
struct SpaceErrors {
    entries: VecDeque<SpaceErrorEntry>,
    /// Turn windows so far: bumped each time notes are taken.
    turns: u64,
}

/// Every space's errors, by space id.
#[derive(Default)]
pub(crate) struct SpaceErrorBook(Mutex<HashMap<String, SpaceErrors>>);

impl SpaceErrorBook {
    fn with<T>(&self, space: &str, f: impl FnOnce(&mut SpaceErrors) -> T) -> T {
        let mut all = self.0.lock().unwrap_or_else(|p| p.into_inner());
        f(all.entry(space.to_string()).or_default())
    }

    /// Records `text` under `code`: folded into the same entry when the
    /// space already has it, else appended; the oldest entry goes when
    /// there are more than [`MAX_ENTRIES`].
    pub(crate) fn note(
        &self,
        space: &str,
        at: Millis,
        level: &'static str,
        code: &str,
        text: &str,
    ) {
        self.with(space, |errors| {
            let turn = errors.turns;
            if let Some(e) = errors
                .entries
                .iter_mut()
                .find(|e| e.code == code && e.text == text)
            {
                e.at = at;
                e.count = e.count.saturating_add(1);
                // Told in an earlier window and back again: new to the
                // agent; told in this one: not repeated.
                if e.told.is_some_and(|t| t != turn) {
                    e.told = None;
                }
                return;
            }
            errors.entries.push_back(SpaceErrorEntry {
                at,
                level,
                code: code.to_string(),
                text: text.to_string(),
                count: 1,
                told: None,
            });
            while errors.entries.len() > MAX_ENTRIES {
                errors.entries.pop_front();
            }
        })
    }

    /// The notes a turn opens with: the entries not told yet, oldest
    /// first, at most [`NOTES_PER_TURN`]; every untold one counts as told
    /// from here (the rest are in `read_logs`).
    pub(crate) fn take_notes(&self, space: &str) -> Vec<String> {
        self.with(space, |errors| {
            errors.turns += 1;
            let turn = errors.turns;
            let untold: Vec<&mut SpaceErrorEntry> = errors
                .entries
                .iter_mut()
                .filter(|e| e.told.is_none())
                .collect();
            let more = untold.len().saturating_sub(NOTES_PER_TURN);
            let mut notes = Vec::new();
            for e in untold {
                e.told = Some(turn);
                if notes.len() < NOTES_PER_TURN {
                    notes.push(note_line(e));
                }
            }
            if more > 0
                && let Some(last) = notes.last_mut()
            {
                last.push_str(&format!(" ({more} more: read_logs with kind \"theodore\")"));
            }
            notes
        })
    }

    /// The last `tail` entries, newest last, and how many there are.
    pub(crate) fn lines(&self, space: &str, tail: usize) -> (Vec<String>, usize) {
        self.with(space, |errors| {
            let available = errors.entries.len();
            let lines = errors
                .entries
                .iter()
                .skip(available.saturating_sub(tail))
                .map(log_line)
                .collect();
            (lines, available)
        })
    }

    #[cfg(test)]
    pub(crate) fn entries(&self, space: &str) -> Vec<SpaceErrorEntry> {
        self.with(space, |e| e.entries.iter().cloned().collect())
    }
}

/// "Theodore: the last checkpoint failed: …" — what the prompt says.
fn note_line(e: &SpaceErrorEntry) -> String {
    let times = if e.count > 1 {
        format!(" (×{})", e.count)
    } else {
        String::new()
    };
    format!("Theodore: {}{times}", e.text)
}

/// `2026-11-23T10:00:00.000Z warn space.checkpoint_failed ×2: …` — a
/// `read_logs` line.
fn log_line(e: &SpaceErrorEntry) -> String {
    let times = if e.count > 1 {
        format!(" ×{}", e.count)
    } else {
        String::new()
    };
    format!("{} {} {}{times}: {}", iso(e.at), e.level, e.code, e.text)
}

fn iso(ms: Millis) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/// An absolute path, or one under `~`, up to whitespace or a quote.
static PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?:^|[\s"'`(=:,])((?:/|~/)[^\s"'`)]+)"#).expect("path regex"));

/// `text` as one redacted line: the worktree reads as `.`, other paths as
/// `<path>`; secrets, emails and the home directory as the issue reports
/// redact them; whitespace folded; cut at [`TEXT_CHARS`].
pub(crate) fn redact(worktree: Option<&str>, text: &str) -> String {
    let mut out = text.to_string();
    if let Some(wt) = worktree
        .map(|w| w.trim_end_matches('/'))
        .filter(|w| !w.is_empty())
    {
        out = out.replace(&format!("{wt}/"), "./").replace(wt, ".");
    }
    let out = theodore_telemetry::issue::redactor().text(&out);
    let out = PATH.replace_all(&out, |c: &regex::Captures| {
        let whole = &c[0];
        let path = &c[1];
        format!("{}<path>", &whole[..whole.len() - path.len()])
    });
    let folded: String = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = folded.chars();
    let cut: String = chars.by_ref().take(TEXT_CHARS).collect();
    if chars.next().is_some() {
        format!("{cut}…")
    } else {
        cut
    }
}

/// `prompt` opening with the notes, one line each.
pub(crate) fn with_error_notes(notes: &[String], prompt: String) -> String {
    if notes.is_empty() {
        prompt
    } else {
        format!("{}\n\n{prompt}", notes.join("\n"))
    }
}

impl Core {
    /// Records an error Theodore hit for `space` (a warning), redacted for
    /// its agent.
    pub(crate) fn note_space_error(&self, space: &Space, code: &str, text: &str) {
        self.note_space_error_in(&space.id, Some(&space.worktree), "warn", code, text);
    }

    /// `note_space_error` with the space's id alone (its worktree is read
    /// for the redaction; none when the row is gone).
    pub(crate) async fn note_space_error_by_id(&self, space: &str, code: &str, text: &str) {
        let worktree = self.space_row(space).await.ok().map(|s| s.worktree);
        self.note_space_error_in(space, worktree.as_deref(), "warn", code, text);
    }

    pub(crate) fn note_space_error_in(
        &self,
        space: &str,
        worktree: Option<&str>,
        level: &'static str,
        code: &str,
        text: &str,
    ) {
        let text = redact(worktree, text);
        if text.is_empty() {
            return;
        }
        self.0
            .space_errors
            .note(space, self.0.deps.clock.now(), level, code, &text);
    }

    /// The notes the next turn's prompt opens with (each told once).
    pub(crate) fn take_space_error_notes(&self, space: &str) -> Vec<String> {
        self.0.space_errors.take_notes(space)
    }

    /// `read_logs {kind: theodore}`: the last `tail` entries, newest last.
    pub(crate) fn space_error_lines(&self, space: &str, tail: usize) -> (Vec<String>, usize) {
        self.0.space_errors.lines(space, tail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_error_folds_and_is_told_once_per_window() {
        let book = SpaceErrorBook::default();
        book.note("s1", 1, "warn", "space.checkpoint_failed", "git add failed");
        book.note("s1", 2, "warn", "space.checkpoint_failed", "git add failed");
        book.note("s1", 3, "warn", "ship.refused", "push first");
        assert_eq!(book.entries("s1").len(), 2);
        assert_eq!(book.entries("s1")[0].count, 2);

        let notes = book.take_notes("s1");
        assert_eq!(
            notes,
            ["Theodore: git add failed (×2)", "Theodore: push first"]
        );
        // Again before the next turn: not repeated.
        book.note("s1", 4, "warn", "ship.refused", "push first");
        assert!(book.take_notes("s1").is_empty(), "told once");
        // Back after a later turn: new to the agent again.
        book.note("s1", 5, "warn", "ship.refused", "push first");
        assert_eq!(book.take_notes("s1"), ["Theodore: push first (×3)"]);
        // Another space's book is its own.
        assert!(book.take_notes("s2").is_empty());
        assert_eq!(book.lines("s2", 50).1, 0);
    }

    #[test]
    fn at_most_three_notes_per_turn_the_rest_pointed_at_read_logs() {
        let book = SpaceErrorBook::default();
        for i in 0..5 {
            book.note("s1", i, "warn", "x", &format!("e{i}"));
        }
        let notes = book.take_notes("s1");
        assert_eq!(notes.len(), 3);
        assert_eq!(notes[0], "Theodore: e0");
        assert!(
            notes[2].ends_with("(2 more: read_logs with kind \"theodore\")"),
            "{}",
            notes[2]
        );
        assert!(book.take_notes("s1").is_empty(), "the rest count as told");
        let (lines, available) = book.lines("s1", 2);
        assert_eq!(available, 5);
        assert_eq!(lines.len(), 2);
        assert!(lines[1].ends_with("warn x: e4"), "{}", lines[1]);
        assert!(
            lines[1].starts_with("1970-01-01T00:00:00.004Z"),
            "{}",
            lines[1]
        );
    }

    #[test]
    fn the_book_is_bounded() {
        let book = SpaceErrorBook::default();
        for i in 0..(MAX_ENTRIES + 10) {
            book.note("s1", i as i64, "warn", "x", &format!("e{i}"));
        }
        let entries = book.entries("s1");
        assert_eq!(entries.len(), MAX_ENTRIES);
        assert_eq!(entries[0].text, "e10", "the oldest went first");
    }

    #[test]
    fn redaction_keeps_the_worktree_relative_and_hides_other_paths() {
        let wt = "/Users/ada/.theodore/spaces/abc";
        let text = format!(
            "git add {wt}/src/a.rs exit 1:\n  ignored by /Users/ada/.gitignore\n token=ghp_abcdefghijklmnopqrstuvwxyz0123456789"
        );
        let out = redact(Some(wt), &text);
        assert!(
            out.contains("git add ./src/a.rs exit 1: ignored by <path>"),
            "{out}"
        );
        assert!(!out.contains("ghp_"), "{out}");
        assert!(!out.contains('\n'));
        let long = "x".repeat(TEXT_CHARS + 5);
        assert_eq!(redact(None, &long).chars().count(), TEXT_CHARS + 1);
        assert_eq!(redact(None, "  a   b  "), "a b");
    }

    #[test]
    fn notes_open_the_prompt() {
        assert_eq!(with_error_notes(&[], "go".into()), "go");
        assert_eq!(
            with_error_notes(&["Theodore: a".into(), "Theodore: b".into()], "go".into()),
            "Theodore: a\nTheodore: b\n\ngo"
        );
    }
}
