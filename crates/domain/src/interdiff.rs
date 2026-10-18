//! Revisions across pushes: hunk identity, what changed since a baseline.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use crate::model::{Hunk, HunkId, Revision};

/// Stable hunk id: `(path, normalized content hash)` (plan §4).
///
/// Only added/deleted lines count, with trailing whitespace trimmed, so the id
/// survives context shifts and pure line-number moves. 16 hex chars.
pub fn hunk_id(path: &str, lines: &[crate::model::DiffLine]) -> HunkId {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(path.as_bytes());
    h.update([0]);
    for l in lines {
        let tag = match l.kind {
            crate::model::LineKind::Add => b'+',
            crate::model::LineKind::Del => b'-',
            crate::model::LineKind::Ctx => continue,
        };
        h.update([tag]);
        h.update(l.text.trim_end().as_bytes());
        h.update(b"\n");
    }
    HunkId(hex::encode(&h.finalize()[..8]))
}

/// Make hunk ids unique within a revision: a repeated identical edit (same
/// path, same changed lines) gets `-2`, `-3`, … in file order.
pub fn dedupe_hunk_ids(files: &mut [crate::model::FileDiff]) {
    let mut seen: std::collections::BTreeMap<String, u32> = std::collections::BTreeMap::new();
    for h in files.iter_mut().flat_map(|f| f.hunks.iter_mut()) {
        let n = seen.entry(h.id.0.clone()).or_insert(0);
        *n += 1;
        if *n > 1 {
            h.id = HunkId(format!("{}-{}", h.id.0, n));
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HunkChange {
    Unchanged,
    /// Matched to an old hunk by overlapping range, content differs.
    Changed {
        previous: HunkId,
    },
    New,
}

/// A hunk's new-side range as a half-open window. A pure deletion (no new
/// lines) is widened to a one-line point at its mark so it still
/// participates in overlap checks against adjacent hunks.
fn new_range(h: &Hunk) -> Range<u32> {
    if h.new_lines == 0 {
        h.new_start..h.new_start + 1
    } else {
        h.new_start..h.new_start + h.new_lines
    }
}

fn overlaps(a: &Range<u32>, b: &Range<u32>) -> bool {
    a.start < b.end && b.start < a.end
}

/// Classify every hunk of `new` against `old`.
///
/// `old` and `new` are revisions of the same PR at successive heads. A hunk
/// is `Unchanged` when its id (path + normalized content hash) already
/// existed in `old` — the id survives pure context shifts. Otherwise it is
/// matched to an old hunk of the same path whose new-side range overlaps
/// this hunk's new-side range (the plan §4 fallback match); that old hunk's
/// id becomes `previous`. With no match at all, the hunk is `New`.
///
/// This range match is a heuristic: it compares each revision's own
/// new-side coordinates, which only line up cleanly when `old` and `new`
/// are consecutive revisions against the same base.
pub fn classify(old: &Revision, new: &Revision) -> BTreeMap<HunkId, HunkChange> {
    let old_ids: BTreeSet<&HunkId> = old.hunks().map(|h| &h.id).collect();
    let mut old_by_path: BTreeMap<&str, Vec<&Hunk>> = BTreeMap::new();
    for h in old.hunks() {
        old_by_path.entry(h.path.as_str()).or_default().push(h);
    }

    let mut out = BTreeMap::new();
    for h in new.hunks() {
        if old_ids.contains(&h.id) {
            out.insert(h.id.clone(), HunkChange::Unchanged);
            continue;
        }
        let range = new_range(h);
        let matched = old_by_path.get(h.path.as_str()).and_then(|olds| {
            olds.iter()
                .find(|o| overlaps(&new_range(o), &range))
                .copied()
        });
        let change = match matched {
            Some(o) => HunkChange::Changed {
                previous: o.id.clone(),
            },
            None => HunkChange::New,
        };
        out.insert(h.id.clone(), change);
    }
    out
}

/// Word-level diff of the resulting code between two hunk versions, for the
/// interdiff view. Compares the "surviving" text of each side — context and
/// added lines, joined with newlines — and diffs it word by word with
/// `similar`. Adjacent spans of the same kind are coalesced.
pub fn word_diff(old: &Hunk, new: &Hunk) -> Vec<WordSpan> {
    use crate::model::LineKind;
    use similar::{ChangeTag, TextDiff};

    fn surviving_text(h: &Hunk) -> String {
        h.lines
            .iter()
            .filter(|l| l.kind != LineKind::Del)
            .map(|l| l.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }

    let old_text = surviving_text(old);
    let new_text = surviving_text(new);
    let diff = TextDiff::from_unicode_words(old_text.as_str(), new_text.as_str());

    let mut out: Vec<WordSpan> = Vec::new();
    for change in diff.iter_all_changes() {
        let kind = match change.tag() {
            ChangeTag::Equal => LineKind::Ctx,
            ChangeTag::Delete => LineKind::Del,
            ChangeTag::Insert => LineKind::Add,
        };
        match out.last_mut() {
            Some(last) if last.kind == kind => last.text.push_str(change.value()),
            _ => out.push(WordSpan {
                kind,
                text: change.value().to_string(),
            }),
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WordSpan {
    pub kind: crate::model::LineKind,
    pub text: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{DiffLine, FileDiff, FileStatus, LineKind, Sha};

    fn line(kind: LineKind, text: &str, old_no: Option<u32>, new_no: Option<u32>) -> DiffLine {
        DiffLine {
            kind,
            text: text.into(),
            old_no,
            new_no,
        }
    }

    fn hunk(
        id: &str,
        path: &str,
        old_start: u32,
        old_lines: u32,
        new_start: u32,
        new_lines: u32,
        lines: Vec<DiffLine>,
    ) -> Hunk {
        Hunk {
            id: HunkId::new(id),
            path: path.into(),
            old_start,
            old_lines,
            new_start,
            new_lines,
            header: String::new(),
            lines,
        }
    }

    fn rev(files: Vec<FileDiff>) -> Revision {
        Revision {
            base: Sha::new("base"),
            head: Sha::new("head"),
            files,
        }
    }

    fn file(path: &str, hunks: Vec<Hunk>) -> FileDiff {
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
    fn classify_empty_revisions() {
        assert!(classify(&rev(vec![]), &rev(vec![])).is_empty());
    }

    #[test]
    fn classify_unchanged_by_id() {
        let lines = vec![line(LineKind::Add, "x", None, Some(1))];
        let h = hunk("h1", "a.rs", 1, 0, 1, 1, lines);
        let old = rev(vec![file("a.rs", vec![h.clone()])]);
        let new = rev(vec![file("a.rs", vec![h])]);
        let out = classify(&old, &new);
        assert_eq!(out[&HunkId::new("h1")], HunkChange::Unchanged);
    }

    #[test]
    fn classify_changed_by_overlapping_new_range() {
        let old_h = hunk(
            "old1",
            "a.rs",
            1,
            1,
            1,
            1,
            vec![line(LineKind::Add, "old text", None, Some(1))],
        );
        let new_h = hunk(
            "new1",
            "a.rs",
            1,
            1,
            1,
            1,
            vec![line(LineKind::Add, "new text", None, Some(1))],
        );
        let old = rev(vec![file("a.rs", vec![old_h])]);
        let new = rev(vec![file("a.rs", vec![new_h])]);
        let out = classify(&old, &new);
        assert_eq!(
            out[&HunkId::new("new1")],
            HunkChange::Changed {
                previous: HunkId::new("old1")
            }
        );
    }

    #[test]
    fn classify_new_hunk_no_match() {
        let new_h = hunk(
            "new1",
            "b.rs",
            1,
            0,
            5,
            2,
            vec![line(LineKind::Add, "x", None, Some(5))],
        );
        let old = rev(vec![]);
        let new = rev(vec![file("b.rs", vec![new_h])]);
        let out = classify(&old, &new);
        assert_eq!(out[&HunkId::new("new1")], HunkChange::New);
    }

    #[test]
    fn classify_renamed_file_has_no_path_match_so_is_new() {
        // Hunk identity is path + content hash; a rename changes the path,
        // so without a matching old path the hunk is New even if nearly
        // identical content exists under the old name.
        let old_h = hunk(
            "old1",
            "old_name.rs",
            1,
            1,
            1,
            1,
            vec![line(LineKind::Add, "same", None, Some(1))],
        );
        let new_h = hunk(
            "new1",
            "new_name.rs",
            1,
            1,
            1,
            1,
            vec![line(LineKind::Add, "same", None, Some(1))],
        );
        let old = rev(vec![file("old_name.rs", vec![old_h])]);
        let new = rev(vec![file("new_name.rs", vec![new_h])]);
        let out = classify(&old, &new);
        assert_eq!(out[&HunkId::new("new1")], HunkChange::New);
    }

    #[test]
    fn word_diff_highlights_changed_word_only() {
        let old_h = hunk(
            "h1",
            "a.rs",
            1,
            1,
            1,
            1,
            vec![line(LineKind::Ctx, "let x = 1;", Some(1), Some(1))],
        );
        let new_h = hunk(
            "h1",
            "a.rs",
            1,
            1,
            1,
            1,
            vec![line(LineKind::Ctx, "let x = 2;", Some(1), Some(1))],
        );
        let spans = word_diff(&old_h, &new_h);
        let deleted: String = spans
            .iter()
            .filter(|s| s.kind == LineKind::Del)
            .map(|s| s.text.as_str())
            .collect();
        let added: String = spans
            .iter()
            .filter(|s| s.kind == LineKind::Add)
            .map(|s| s.text.as_str())
            .collect();
        assert_eq!(deleted, "1");
        assert_eq!(added, "2");
    }

    #[test]
    fn word_diff_ignores_deleted_lines_on_both_sides() {
        let old_h = hunk(
            "h1",
            "a.rs",
            1,
            2,
            1,
            1,
            vec![
                line(LineKind::Del, "removed", Some(1), None),
                line(LineKind::Ctx, "kept", Some(2), Some(1)),
            ],
        );
        let new_h = hunk(
            "h1",
            "a.rs",
            1,
            1,
            1,
            1,
            vec![line(LineKind::Ctx, "kept", Some(1), Some(1))],
        );
        let spans = word_diff(&old_h, &new_h);
        assert!(spans.iter().all(|s| s.kind == LineKind::Ctx));
    }

    #[test]
    fn hunk_id_ignores_context_and_trailing_whitespace() {
        let a = hunk_id(
            "a.rs",
            &[
                line(LineKind::Ctx, "ctx", None, None),
                line(LineKind::Add, "added  ", None, None),
            ],
        );
        let b = hunk_id(
            "a.rs",
            &[
                line(LineKind::Ctx, "different ctx", None, None),
                line(LineKind::Add, "added", None, None),
            ],
        );
        assert_eq!(a, b);
    }
}

#[cfg(test)]
mod dedupe_tests {
    use super::*;
    use crate::model::{DiffLine, FileDiff, FileStatus, LineKind};

    fn hunk(text: &str) -> Hunk {
        let lines = vec![DiffLine {
            kind: LineKind::Add,
            text: text.into(),
            old_no: None,
            new_no: Some(1),
        }];
        Hunk {
            id: hunk_id("a.rs", &lines),
            path: "a.rs".into(),
            old_start: 1,
            old_lines: 0,
            new_start: 1,
            new_lines: 1,
            header: String::new(),
            lines,
        }
    }

    #[test]
    fn repeated_identical_edits_get_distinct_ids() {
        let mut files = vec![FileDiff {
            path: "a.rs".into(),
            old_path: None,
            status: FileStatus::Modified,
            similarity: None,
            old_mode: None,
            new_mode: None,
            flags: vec![],
            additions: 3,
            deletions: 0,
            hunks: vec![hunk("x"), hunk("y"), hunk("x"), hunk("x")],
        }];
        dedupe_hunk_ids(&mut files);
        let ids: Vec<_> = files[0].hunks.iter().map(|h| h.id.0.clone()).collect();
        let unique: std::collections::BTreeSet<_> = ids.iter().collect();
        assert_eq!(unique.len(), 4);
        assert_eq!(ids[2], format!("{}-2", ids[0]));
        assert_eq!(ids[3], format!("{}-3", ids[0]));
    }
}
