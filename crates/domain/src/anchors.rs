//! Anchor remapping after a push (plan §4).

use crate::model::{Anchor, Hunk, Revision, Side};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Remapped {
    Moved(Anchor),
    /// The anchored line no longer exists.
    Outdated,
}

/// Map an anchor made against `old` onto `new`, using both diffs against the
/// same base. `between` is the diff `old.head..new.head` (as a Revision).
///
/// Assumptions, documented because this function only sees `between`:
/// - **Old-side anchors are unchanged.** `between` is the diff of the two
///   *heads*; it says nothing about the base. An anchor's `side` (not
///   `start_side`, for simplicity on cross-side ranges) decides this: a
///   `Side::Old` anchor is assumed to still point at the same base content
///   and is returned with only `rev` advanced. If the base itself moved
///   (rebase), that is out of scope here — the caller must detect it
///   separately and treat the anchor as outdated.
/// - **New-side anchors move by the hunks of `between`.** A hunk fully
///   before the anchor's old-side line(s) shifts it by its line-count delta.
///   A hunk whose old-side range overlaps the anchor's old-side line(s) with
///   real content (not a pure insertion) means that content was deleted or
///   rewritten: `Outdated`. A pure insertion landing inside a multi-line
///   anchor's range doesn't move or outdate it (the anchor's endpoints are
///   left as-is) — a deliberate simplification for the rare cross-insertion
///   case.
/// - A renamed file is followed via `old_path`/`path` on `between`'s file
///   entry; a file `between` doesn't mention at all is assumed untouched.
pub fn remap(anchor: &Anchor, between: &Revision, new_head: &crate::model::Sha) -> Remapped {
    if anchor.side != Side::New {
        return Remapped::Moved(Anchor {
            rev: new_head.clone(),
            ..anchor.clone()
        });
    }

    let file = between
        .files
        .iter()
        .find(|f| f.path == anchor.path || f.old_path.as_deref() == Some(anchor.path.as_str()));
    let Some(file) = file else {
        // This push didn't touch the file at all.
        return Remapped::Moved(Anchor {
            rev: new_head.clone(),
            ..anchor.clone()
        });
    };

    let lo = anchor.line.min(anchor.start_line.unwrap_or(anchor.line));
    let hi = anchor.line.max(anchor.start_line.unwrap_or(anchor.line));

    let mut hunks: Vec<&Hunk> = file.hunks.iter().collect();
    hunks.sort_by_key(|h| h.old_start);

    let mut shift: i64 = 0;
    for h in hunks {
        let h_lo = h.old_start;
        let h_hi = if h.old_lines == 0 {
            h.old_start
        } else {
            h.old_start + h.old_lines - 1
        };
        let delta = h.new_lines as i64 - h.old_lines as i64;

        if h.old_lines > 0 && h_hi >= lo && h_lo <= hi {
            return Remapped::Outdated;
        } else if h_hi < lo {
            shift += delta;
        }
        // Hunks at/after `hi`, and pure insertions landing inside the range,
        // leave the anchor's endpoints unmoved (see doc comment).
    }

    let new_line = (anchor.line as i64 + shift) as u32;
    let new_start_line = anchor.start_line.map(|s| (s as i64 + shift) as u32);
    Remapped::Moved(Anchor {
        rev: new_head.clone(),
        path: file.path.clone(),
        side: Side::New,
        line: new_line,
        start_line: new_start_line,
        start_side: anchor.start_side,
    })
}

/// Is the anchor inside one of the revision's hunks (commentable on the
/// host)? A line is commentable when it appears, on the anchor's side, in
/// some hunk of the file; a multi-line range needs both endpoints inside
/// the *same* hunk, matching GitHub's own restriction.
pub fn is_commentable(anchor: &Anchor, rev: &Revision) -> bool {
    let Some(file) = rev.files.iter().find(|f| f.path == anchor.path) else {
        return false;
    };

    let line_in_hunk = |h: &Hunk, side: Side, line: u32| {
        h.lines.iter().any(|l| match side {
            Side::Old => l.old_no == Some(line),
            Side::New => l.new_no == Some(line),
        })
    };

    file.hunks.iter().any(|h| {
        let end_ok = line_in_hunk(h, anchor.side, anchor.line);
        let start_ok = match (anchor.start_line, anchor.start_side) {
            (Some(sl), Some(ss)) => line_in_hunk(h, ss, sl),
            (Some(sl), None) => line_in_hunk(h, anchor.side, sl),
            (None, _) => true,
        };
        end_ok && start_ok
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{DiffLine, FileDiff, FileStatus, HunkId, LineKind, Sha};

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
        old_start: u32,
        old_lines: u32,
        new_start: u32,
        new_lines: u32,
        lines: Vec<DiffLine>,
    ) -> Hunk {
        Hunk {
            id: HunkId::new(id),
            path: "a.rs".into(),
            old_start,
            old_lines,
            new_start,
            new_lines,
            header: String::new(),
            lines,
        }
    }

    fn file(path: &str, old_path: Option<&str>, hunks: Vec<Hunk>) -> FileDiff {
        FileDiff {
            path: path.into(),
            old_path: old_path.map(|s| s.into()),
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

    fn rev(files: Vec<FileDiff>) -> Revision {
        Revision {
            base: Sha::new("base"),
            head: Sha::new("head"),
            files,
        }
    }

    fn anchor(path: &str, side: Side, line: u32) -> Anchor {
        Anchor {
            rev: Sha::new("old-head"),
            path: path.into(),
            side,
            line,
            start_line: None,
            start_side: None,
        }
    }

    #[test]
    fn old_side_anchor_passes_through_unchanged() {
        let a = anchor("a.rs", Side::Old, 10);
        let between = rev(vec![file(
            "a.rs",
            None,
            vec![hunk(
                "h1",
                1,
                5,
                1,
                5,
                vec![line(LineKind::Add, "x", None, Some(1))],
            )],
        )]);
        let out = remap(&a, &between, &Sha::new("new-head"));
        assert_eq!(
            out,
            Remapped::Moved(Anchor {
                rev: Sha::new("new-head"),
                ..a
            })
        );
    }

    #[test]
    fn untouched_file_is_unchanged() {
        let a = anchor("untouched.rs", Side::New, 10);
        let between = rev(vec![]);
        let out = remap(&a, &between, &Sha::new("new-head"));
        assert_eq!(
            out,
            Remapped::Moved(Anchor {
                rev: Sha::new("new-head"),
                ..a
            })
        );
    }

    #[test]
    fn empty_revision_leaves_new_side_anchor_line_untouched() {
        let a = anchor("a.rs", Side::New, 42);
        let between = rev(vec![]);
        let out = remap(&a, &between, &Sha::new("new-head"));
        assert_eq!(
            out,
            Remapped::Moved(Anchor {
                rev: Sha::new("new-head"),
                ..a
            })
        );
    }

    #[test]
    fn new_side_anchor_shifts_by_preceding_insert() {
        // 3 lines inserted at old line 5, before the anchor at old line 20.
        let a = anchor("a.rs", Side::New, 20);
        let insert = hunk(
            "h1",
            5,
            0,
            5,
            3,
            vec![
                line(LineKind::Add, "a", None, Some(5)),
                line(LineKind::Add, "b", None, Some(6)),
                line(LineKind::Add, "c", None, Some(7)),
            ],
        );
        let between = rev(vec![file("a.rs", None, vec![insert])]);
        let out = remap(&a, &between, &Sha::new("new-head"));
        match out {
            Remapped::Moved(anchor) => assert_eq!(anchor.line, 23),
            Remapped::Outdated => panic!("expected a move"),
        }
    }

    #[test]
    fn new_side_anchor_shifts_by_preceding_delete() {
        // 2 lines deleted at old lines 5-6, anchor at old line 20 moves to 18.
        let del = hunk(
            "h1",
            5,
            2,
            5,
            0,
            vec![
                line(LineKind::Del, "a", Some(5), None),
                line(LineKind::Del, "b", Some(6), None),
            ],
        );
        let a = anchor("a.rs", Side::New, 20);
        let between = rev(vec![file("a.rs", None, vec![del])]);
        let out = remap(&a, &between, &Sha::new("new-head"));
        match out {
            Remapped::Moved(anchor) => assert_eq!(anchor.line, 18),
            Remapped::Outdated => panic!("expected a move"),
        }
    }

    #[test]
    fn new_side_anchor_outdated_when_its_line_is_rewritten() {
        let changed = hunk(
            "h1",
            20,
            1,
            20,
            1,
            vec![line(LineKind::Add, "new", None, Some(20))],
        );
        let a = anchor("a.rs", Side::New, 20);
        let between = rev(vec![file("a.rs", None, vec![changed])]);
        let out = remap(&a, &between, &Sha::new("new-head"));
        assert_eq!(out, Remapped::Outdated);
    }

    #[test]
    fn new_side_anchor_untouched_by_hunk_strictly_after() {
        let after = hunk(
            "h1",
            30,
            1,
            30,
            1,
            vec![line(LineKind::Add, "x", None, Some(30))],
        );
        let a = anchor("a.rs", Side::New, 20);
        let between = rev(vec![file("a.rs", None, vec![after])]);
        let out = remap(&a, &between, &Sha::new("new-head"));
        match out {
            Remapped::Moved(anchor) => assert_eq!(anchor.line, 20),
            Remapped::Outdated => panic!("expected a move"),
        }
    }

    #[test]
    fn multi_line_anchor_shifts_both_endpoints() {
        let insert = hunk(
            "h1",
            1,
            0,
            1,
            2,
            vec![
                line(LineKind::Add, "x", None, Some(1)),
                line(LineKind::Add, "y", None, Some(2)),
            ],
        );
        let a = Anchor {
            rev: Sha::new("old-head"),
            path: "a.rs".into(),
            side: Side::New,
            line: 20,
            start_line: Some(18),
            start_side: None,
        };
        let between = rev(vec![file("a.rs", None, vec![insert])]);
        let out = remap(&a, &between, &Sha::new("new-head"));
        match out {
            Remapped::Moved(anchor) => {
                assert_eq!(anchor.line, 22);
                assert_eq!(anchor.start_line, Some(20));
            }
            Remapped::Outdated => panic!("expected a move"),
        }
    }

    #[test]
    fn multi_line_anchor_outdated_when_hunk_overlaps_range() {
        let changed = hunk(
            "h1",
            19,
            1,
            19,
            1,
            vec![line(LineKind::Add, "x", None, Some(19))],
        );
        let a = Anchor {
            rev: Sha::new("old-head"),
            path: "a.rs".into(),
            side: Side::New,
            line: 20,
            start_line: Some(18),
            start_side: None,
        };
        let between = rev(vec![file("a.rs", None, vec![changed])]);
        let out = remap(&a, &between, &Sha::new("new-head"));
        assert_eq!(out, Remapped::Outdated);
    }

    #[test]
    fn renamed_file_is_followed_by_old_path() {
        let a = anchor("old_name.rs", Side::New, 10);
        let between = rev(vec![file("new_name.rs", Some("old_name.rs"), vec![])]);
        let out = remap(&a, &between, &Sha::new("new-head"));
        match out {
            Remapped::Moved(anchor) => assert_eq!(anchor.path, "new_name.rs"),
            Remapped::Outdated => panic!("expected a move"),
        }
    }

    #[test]
    fn is_commentable_true_for_context_line_in_hunk() {
        let h = hunk(
            "h1",
            1,
            1,
            1,
            1,
            vec![line(LineKind::Ctx, "x", Some(1), Some(1))],
        );
        let r = rev(vec![file("a.rs", None, vec![h])]);
        assert!(is_commentable(&anchor("a.rs", Side::New, 1), &r));
        assert!(is_commentable(&anchor("a.rs", Side::Old, 1), &r));
    }

    #[test]
    fn is_commentable_false_outside_any_hunk() {
        let h = hunk(
            "h1",
            1,
            1,
            1,
            1,
            vec![line(LineKind::Ctx, "x", Some(1), Some(1))],
        );
        let r = rev(vec![file("a.rs", None, vec![h])]);
        assert!(!is_commentable(&anchor("a.rs", Side::New, 99), &r));
    }

    #[test]
    fn is_commentable_false_for_unknown_file() {
        let r = rev(vec![]);
        assert!(!is_commentable(&anchor("missing.rs", Side::New, 1), &r));
    }

    #[test]
    fn is_commentable_multiline_requires_same_hunk() {
        let h1 = hunk(
            "h1",
            1,
            1,
            1,
            1,
            vec![line(LineKind::Ctx, "x", Some(1), Some(1))],
        );
        let h2 = hunk(
            "h2",
            10,
            1,
            10,
            1,
            vec![line(LineKind::Ctx, "y", Some(10), Some(10))],
        );
        let r = rev(vec![file("a.rs", None, vec![h1, h2])]);
        let a = Anchor {
            rev: Sha::new("head"),
            path: "a.rs".into(),
            side: Side::New,
            line: 10,
            start_line: Some(1),
            start_side: None,
        };
        // Endpoints are in different hunks: not commentable as one range.
        assert!(!is_commentable(&a, &r));
    }
}
