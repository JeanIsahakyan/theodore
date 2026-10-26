//! Hunk-level read state → file-level Viewed (plan §4).

use std::collections::{BTreeMap, BTreeSet};

use crate::model::{HunkId, Revision, ViewedState};

/// Read hunks of one PR for the current user.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ReadSet(pub BTreeSet<HunkId>);

/// Group `rev`'s hunk ids by path. A path with zero hunks (e.g. a pure rename)
/// never appears: it has nothing to read and so never transitions.
fn hunks_by_path(rev: &Revision) -> BTreeMap<&str, Vec<&HunkId>> {
    let mut by_path: BTreeMap<&str, Vec<&HunkId>> = BTreeMap::new();
    for h in rev.hunks() {
        by_path.entry(h.path.as_str()).or_default().push(&h.id);
    }
    by_path
}

/// Paths whose hunks are now all read (they should become Viewed on the host).
/// Only paths that *changed* from "not all read" to "all read" are returned;
/// a path already fully read in `before` is not reported again.
pub fn newly_viewed(rev: &Revision, before: &ReadSet, after: &ReadSet) -> Vec<String> {
    hunks_by_path(rev)
        .into_iter()
        .filter(|(_, ids)| {
            let was_all = ids.iter().all(|id| before.0.contains(*id));
            let is_all = ids.iter().all(|id| after.0.contains(*id));
            !was_all && is_all
        })
        .map(|(path, _)| path.to_string())
        .collect()
}

/// Viewed state of `path` from reads alone: Viewed only when every hunk of
/// the path, across every group, is read (vacuously Viewed if it has none).
/// This never returns `Dismissed` — that requires push history this pure
/// function doesn't have.
pub fn file_state(rev: &Revision, read: &ReadSet, path: &str) -> ViewedState {
    let all_read = rev
        .hunks()
        .filter(|h| h.path == path)
        .all(|h| read.0.contains(&h.id));
    if all_read {
        ViewedState::Viewed
    } else {
        ViewedState::Unviewed
    }
}

/// Share of non-hidden hunks read, 0.0..=1.0. 0.0 when there are no visible
/// hunks at all.
pub fn progress(rev: &Revision, read: &ReadSet, hidden: &BTreeSet<HunkId>) -> f32 {
    let visible: Vec<&HunkId> = rev
        .hunks()
        .map(|h| &h.id)
        .filter(|id| !hidden.contains(*id))
        .collect();
    if visible.is_empty() {
        return 0.0;
    }
    let read_count = visible.iter().filter(|id| read.0.contains(**id)).count();
    read_count as f32 / visible.len() as f32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{DiffLine, FileDiff, FileStatus, Hunk, LineKind, Sha};

    fn hunk(id: &str, path: &str) -> Hunk {
        Hunk {
            id: HunkId::new(id),
            path: path.into(),
            old_start: 1,
            old_lines: 1,
            new_start: 1,
            new_lines: 1,
            header: String::new(),
            lines: vec![DiffLine {
                kind: LineKind::Add,
                text: "x".into(),
                old_no: None,
                new_no: Some(1),
            }],
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
            additions: 1,
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

    #[test]
    fn file_with_no_hunks_is_vacuously_viewed() {
        let r = rev(vec![file("renamed.rs", vec![])]);
        let read = ReadSet::default();
        assert_eq!(file_state(&r, &read, "renamed.rs"), ViewedState::Viewed);
    }

    #[test]
    fn file_viewed_only_when_every_hunk_across_groups_is_read() {
        let r = rev(vec![file(
            "a.rs",
            vec![hunk("h1", "a.rs"), hunk("h2", "a.rs")],
        )]);
        let mut read = ReadSet::default();
        read.0.insert(HunkId::new("h1"));
        assert_eq!(file_state(&r, &read, "a.rs"), ViewedState::Unviewed);
        read.0.insert(HunkId::new("h2"));
        assert_eq!(file_state(&r, &read, "a.rs"), ViewedState::Viewed);
    }

    #[test]
    fn newly_viewed_reports_only_the_transition() {
        let r = rev(vec![
            file("a.rs", vec![hunk("h1", "a.rs"), hunk("h2", "a.rs")]),
            file("b.rs", vec![hunk("h3", "b.rs")]),
        ]);
        let mut before = ReadSet::default();
        before.0.insert(HunkId::new("h1"));
        before.0.insert(HunkId::new("h3")); // b.rs already fully read before
        let mut after = before.clone();
        after.0.insert(HunkId::new("h2")); // a.rs becomes fully read now

        assert_eq!(newly_viewed(&r, &before, &after), vec!["a.rs".to_string()]);
    }

    #[test]
    fn newly_viewed_is_empty_on_empty_revision() {
        let r = rev(vec![]);
        let read = ReadSet::default();
        assert!(newly_viewed(&r, &read, &read).is_empty());
    }

    #[test]
    fn progress_excludes_hidden_hunks() {
        let r = rev(vec![file(
            "a.rs",
            vec![hunk("h1", "a.rs"), hunk("h2", "a.rs"), hunk("h3", "a.rs")],
        )]);
        let mut hidden = BTreeSet::new();
        hidden.insert(HunkId::new("h3"));
        let mut read = ReadSet::default();
        read.0.insert(HunkId::new("h1"));
        // 1 of 2 visible hunks read.
        assert_eq!(progress(&r, &read, &hidden), 0.5);
    }

    #[test]
    fn progress_is_zero_for_empty_revision() {
        let r = rev(vec![]);
        let read = ReadSet::default();
        assert_eq!(progress(&r, &read, &BTreeSet::new()), 0.0);
    }

    #[test]
    fn progress_is_zero_when_all_hunks_hidden() {
        let r = rev(vec![file("a.rs", vec![hunk("h1", "a.rs")])]);
        let mut hidden = BTreeSet::new();
        hidden.insert(HunkId::new("h1"));
        assert_eq!(progress(&r, &ReadSet::default(), &hidden), 0.0);
    }
}
