//! Prompt builder (plan §5.1–§5.2): PR title/body/commits, file list, and
//! every hunk as id + path + header + a compact excerpt, within a token
//! budget. Large PRs split by top-level directory with a merge pass over
//! group summaries.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use serde::Deserialize;
use theodore_domain::{Group, GroupId, Hunk, HunkId, LineKind, Revision};

use crate::PrMeta;
use crate::prepass::PrePass;

#[derive(Debug, Clone)]
pub struct PromptBudget {
    /// Soft cap on the user prompt size, in characters. Token counts aren't
    /// available without calling the model, so this is a ~4-chars-per-token
    /// estimate — good enough to decide "split or not", not an exact budget.
    pub max_chars: usize,
    /// Lines shown from the start and end of a hunk's body.
    pub excerpt_lines: usize,
    /// Hard cap on one hunk's excerpt, in characters.
    pub excerpt_max_chars: usize,
}

impl Default for PromptBudget {
    fn default() -> Self {
        Self {
            max_chars: 48_000,
            excerpt_lines: 4,
            excerpt_max_chars: 320,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PromptPart {
    pub system: String,
    pub user: String,
}

#[derive(Debug, Clone)]
pub struct PromptChunk {
    /// Empty for a single whole-PR prompt; the top-level directory otherwise.
    pub label: String,
    pub prompt: PromptPart,
    /// Hunk ids covered by this chunk (everything not hidden).
    pub hunk_ids: Vec<HunkId>,
}

fn system_prompt() -> String {
    "You are reviewing a pull request. Split its diff into small, focused \
groups that each explain one intent, so a reviewer can read the PR as a \
sequence of logical steps instead of an alphabetical file list.\n\n\
Order groups in reading order: foundations first (schema, models, types), \
then the code that uses them, then tests, then anything mechanical or \
generated last. Prefer several small groups over one big one.\n\n\
Respond with JSON only — no prose, no markdown fence — matching exactly:\n\
{\n  \"groups\": [\n    {\n      \"id\": \"kebab-case-slug, unique\",\n      \
\"title\": \"short title\",\n      \"why\": \"1-3 sentences: what changed and why\",\n      \
\"kind\": \"normal\" | \"skim\" | \"hidden\",\n      \"risk\": \"one sentence on what could go wrong, or omit\",\n      \
\"check\": [\"short, concrete things a reviewer should verify\"],\n      \
\"hunks\": [\"hunk id\", \"...\"],\n      \"outliers\": [\"hunk ids in this group that break its own pattern\"]\n    }\n  ]\n}\n\n\
Rules: every hunk id listed below must appear in exactly one group's \"hunks\"; \
do not invent hunk ids; \"outliers\" must be a subset of that same group's \"hunks\"; \
use \"skim\" for mechanical changes (pure renames, formatting, import-only) and \
\"hidden\" only for lockfiles/generated/vendored content you were not shown in full."
        .to_string()
}

fn excerpt(hunk: &Hunk, budget: &PromptBudget) -> String {
    let n = hunk.lines.len();
    let show_all = n <= budget.excerpt_lines * 2;
    let mut out = String::new();
    let push_line = |out: &mut String, idx: usize| {
        let l = &hunk.lines[idx];
        let sign = match l.kind {
            LineKind::Add => '+',
            LineKind::Del => '-',
            LineKind::Ctx => ' ',
        };
        let _ = writeln!(out, "{sign}{}", l.text);
    };
    if show_all {
        for i in 0..n {
            push_line(&mut out, i);
        }
    } else {
        for i in 0..budget.excerpt_lines {
            push_line(&mut out, i);
        }
        out.push_str("…\n");
        for i in (n - budget.excerpt_lines)..n {
            push_line(&mut out, i);
        }
    }
    if out.len() > budget.excerpt_max_chars {
        // Byte budget, cut on a char boundary: diffs carry any UTF-8.
        let mut cut = budget.excerpt_max_chars;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        out.push('…');
    }
    out
}

fn write_pr_meta(out: &mut String, pr: &PrMeta) {
    let _ = writeln!(out, "# PR");
    let _ = writeln!(out, "Title: {}", pr.title);
    if !pr.body.is_empty() {
        let _ = writeln!(out, "Body:\n{}", pr.body);
    }
    if !pr.commits.is_empty() {
        let _ = writeln!(out, "Commits:");
        for c in &pr.commits {
            let _ = writeln!(out, "- {c}");
        }
    }
}

fn write_hidden_summary(out: &mut String, prepass: &PrePass) {
    if prepass.hidden.is_empty() {
        return;
    }
    let _ = writeln!(
        out,
        "\n# Not shown (collapsed into a hidden group, already handled)"
    );
    for (path, reason) in &prepass.hidden {
        let _ = writeln!(out, "- {path} ({})", reason.label());
    }
}

fn write_files_and_hunks(
    out: &mut String,
    files: &[&theodore_domain::FileDiff],
    prepass: &PrePass,
    budget: &PromptBudget,
) {
    let _ = writeln!(out, "\n# Files and hunks");
    for file in files {
        let _ = writeln!(out, "\n## {} ({:?})", file.path, file.status);
        for hunk in &file.hunks {
            let hint = prepass
                .skim
                .get(&hunk.id)
                .map(|c| format!(" [skim candidate: {}]", c.label()))
                .unwrap_or_default();
            let _ = writeln!(out, "\n### hunk {} — {}{hint}", hunk.id, hunk.header);
            out.push_str(&excerpt(hunk, budget));
        }
    }
}

fn user_prompt(
    pr: &PrMeta,
    files: &[&theodore_domain::FileDiff],
    prepass: &PrePass,
    budget: &PromptBudget,
) -> String {
    let mut out = String::new();
    write_pr_meta(&mut out, pr);
    write_hidden_summary(&mut out, prepass);
    write_files_and_hunks(&mut out, files, prepass, budget);
    out
}

fn top_level_dir(path: &str) -> String {
    path.split('/').next().unwrap_or(path).to_string()
}

/// Build one prompt per chunk. A single chunk covers the whole PR unless the
/// estimated prompt size is over budget, in which case files are split by
/// top-level directory (plan §5.2).
pub fn build_prompts(
    pr: &PrMeta,
    rev: &Revision,
    prepass: &PrePass,
    budget: &PromptBudget,
) -> Vec<PromptChunk> {
    let visible_files: Vec<&theodore_domain::FileDiff> = rev
        .files
        .iter()
        .filter(|f| !prepass.is_hidden(&f.path))
        .collect();

    let whole = user_prompt(pr, &visible_files, prepass, budget);
    if whole.len() <= budget.max_chars || visible_files.len() <= 1 {
        let hunk_ids = visible_files
            .iter()
            .flat_map(|f| f.hunks.iter().map(|h| h.id.clone()))
            .collect();
        return vec![PromptChunk {
            label: String::new(),
            prompt: PromptPart {
                system: system_prompt(),
                user: whole,
            },
            hunk_ids,
        }];
    }

    let mut by_dir: BTreeMap<String, Vec<&theodore_domain::FileDiff>> = BTreeMap::new();
    for f in &visible_files {
        by_dir.entry(top_level_dir(&f.path)).or_default().push(f);
    }

    by_dir
        .into_iter()
        .map(|(dir, files)| {
            let user = user_prompt(pr, &files, prepass, budget);
            let hunk_ids = files
                .iter()
                .flat_map(|f| f.hunks.iter().map(|h| h.id.clone()))
                .collect();
            PromptChunk {
                label: dir,
                prompt: PromptPart {
                    system: system_prompt(),
                    user,
                },
                hunk_ids,
            }
        })
        .collect()
}

/// Repair prompt: same system message, user message carries the previous
/// answer and the exact validation errors to fix.
pub fn repair_prompt(known_ids: &[HunkId], previous_text: &str, errors: &[String]) -> PromptPart {
    let mut user = String::new();
    let _ = writeln!(
        user,
        "Your previous answer was not a valid grouping. Problems found:"
    );
    for e in errors {
        let _ = writeln!(user, "- {e}");
    }
    let _ = writeln!(
        user,
        "\nKnown hunk ids (every one must appear exactly once across all groups):"
    );
    for id in known_ids {
        let _ = writeln!(user, "- {id}");
    }
    let _ = writeln!(user, "\nYour previous answer:\n{previous_text}");
    let _ = writeln!(
        user,
        "\nReturn corrected JSON only, same schema as before, fixing exactly these problems."
    );
    PromptPart {
        system: system_prompt(),
        user,
    }
}

fn group_summary(g: &Group) -> String {
    format!(
        "{} — \"{}\" ({:?}, {} hunks): {}",
        g.id,
        g.title,
        g.kind,
        g.hunks.len(),
        g.why
    )
}

/// Merge-pass prompt for multi-chunk grouping: asks only for the final
/// reading order across every chunk's groups (membership is already fixed —
/// each hunk was sent to exactly one chunk, so there is nothing left to
/// reassign, only to order and, optionally, retitle for the combined PR).
pub fn merge_prompt(pr: &PrMeta, groups: &[Group]) -> PromptPart {
    let mut user = String::new();
    write_pr_meta(&mut user, pr);
    let _ = writeln!(
        user,
        "\nThis PR was large enough to be grouped in parts. Below are the \
groups produced for each part. Decide the final reading order across all of \
them (foundations → usage → tests → mechanical/hidden last).\n"
    );
    for g in groups {
        let _ = writeln!(user, "- {}", group_summary(g));
    }
    let _ = writeln!(
        user,
        "\nRespond with JSON only: {{\"order\": [\"group id\", \"...\"]}} listing every \
group id above exactly once, in the reading order you recommend."
    );
    PromptPart {
        system: "You decide only the reading order of already-formed review groups. \
Do not change, merge, split, rename, or drop any group."
            .to_string(),
        user,
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct RawOrder {
    #[serde(default)]
    pub order: Vec<String>,
}

impl RawOrder {
    pub fn into_ids(self) -> Vec<GroupId> {
        self.order.into_iter().map(GroupId::new).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use theodore_domain::{DiffLine, FileDiff, FileStatus, Hunk, HunkId, LineKind, Sha};

    fn line(kind: LineKind, text: &str) -> DiffLine {
        DiffLine {
            kind,
            text: text.into(),
            old_no: None,
            new_no: None,
        }
    }

    fn mk_hunk(id: &str, n: usize) -> Hunk {
        Hunk {
            id: HunkId::new(id),
            path: String::new(),
            old_start: 1,
            old_lines: n as u32,
            new_start: 1,
            new_lines: n as u32,
            header: "fn foo()".into(),
            lines: (0..n)
                .map(|i| line(LineKind::Add, &format!("line {i}")))
                .collect(),
        }
    }

    fn mk_file(path: &str, hunks: Vec<Hunk>) -> FileDiff {
        FileDiff {
            path: path.into(),
            old_path: None,
            status: FileStatus::Modified,
            similarity: None,
            old_mode: None,
            new_mode: None,
            flags: vec![],
            additions: 0,
            deletions: 0,
            hunks,
        }
    }

    #[test]
    fn single_chunk_for_small_pr() {
        let rev = Revision {
            base: Sha::new("b"),
            head: Sha::new("h"),
            files: vec![mk_file("src/a.ts", vec![mk_hunk("h1", 3)])],
        };
        let prepass = PrePass::default();
        let chunks = build_prompts(&PrMeta::default(), &rev, &prepass, &PromptBudget::default());
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].prompt.user.contains("hunk h1"));
    }

    #[test]
    fn splits_by_top_level_dir_over_budget() {
        let rev = Revision {
            base: Sha::new("b"),
            head: Sha::new("h"),
            files: vec![
                mk_file("a/one.ts", vec![mk_hunk("h1", 50)]),
                mk_file("b/two.ts", vec![mk_hunk("h2", 50)]),
            ],
        };
        let prepass = PrePass::default();
        let tiny_budget = PromptBudget {
            max_chars: 10,
            ..PromptBudget::default()
        };
        let chunks = build_prompts(&PrMeta::default(), &rev, &prepass, &tiny_budget);
        assert_eq!(chunks.len(), 2);
        let labels: Vec<&str> = chunks.iter().map(|c| c.label.as_str()).collect();
        assert!(labels.contains(&"a"));
        assert!(labels.contains(&"b"));
    }

    #[test]
    fn excerpt_cuts_on_a_char_boundary() {
        let budget = PromptBudget {
            excerpt_max_chars: 7,
            ..PromptBudget::default()
        };
        let hunk = Hunk {
            id: theodore_domain::HunkId::new("h"),
            path: "a.md".into(),
            old_start: 1,
            old_lines: 0,
            new_start: 1,
            new_lines: 1,
            header: String::new(),
            lines: vec![theodore_domain::DiffLine {
                kind: theodore_domain::LineKind::Add,
                text: "привет мир".into(),
                old_no: None,
                new_no: Some(1),
            }],
        };
        let out = excerpt(&hunk, &budget);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn excerpt_caps_long_hunks() {
        let h = mk_hunk("h1", 100);
        let budget = PromptBudget::default();
        let e = excerpt(&h, &budget);
        assert!(e.len() <= budget.excerpt_max_chars + 1);
        assert!(e.contains('…'));
    }

    #[test]
    fn hidden_files_are_summarized_not_dumped() {
        let rev = Revision {
            base: Sha::new("b"),
            head: Sha::new("h"),
            files: vec![mk_file("pnpm-lock.yaml", vec![mk_hunk("h1", 5)])],
        };
        let mut prepass = PrePass::default();
        prepass.hidden.insert(
            "pnpm-lock.yaml".into(),
            crate::prepass::HiddenReason::Lockfile,
        );
        let chunks = build_prompts(&PrMeta::default(), &rev, &prepass, &PromptBudget::default());
        assert_eq!(chunks.len(), 1);
        assert!(!chunks[0].prompt.user.contains("hunk h1"));
        assert!(chunks[0].prompt.user.contains("pnpm-lock.yaml"));
    }
}
