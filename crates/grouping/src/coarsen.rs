//! Deterministic post-pass: once a grouping has more groups than the PR's
//! size-scaled target (`target::target_group_count`) allows, merge groups
//! with exactly one hunk into a neighbour that shares a top-level area and
//! `GroupKind`, until the target is met or no more such merges exist.
//!
//! No agent call involved, so it is both free and exact: it only ever moves
//! a hunk from one group to another, never drops, duplicates or invents
//! one — if the input was a valid partition of the revision's hunks, so is
//! the output (`domain::grouping::validate` is unaffected by this pass).
//! `Hidden` groups are never touched, either as donor or recipient — they
//! are not reviewed in detail and merging a real change into one, or a real
//! change out of one, would misrepresent it.

use std::collections::BTreeMap;

use theodore_domain::{Group, GroupKind, HunkId, Revision};

use crate::area::top_level_dir;

/// Merge tiny (<= 1 hunk) groups into a same-kind, same-area neighbour until
/// `groups.len() <= target_max` or no further merge is possible. Order of
/// the surviving groups is otherwise preserved.
pub(crate) fn merge_tiny_groups(
    rev: &Revision,
    mut groups: Vec<Group>,
    target_max: usize,
) -> Vec<Group> {
    if groups.len() <= target_max {
        return groups;
    }
    let area = hunk_areas(rev);

    loop {
        if groups.len() <= target_max {
            break;
        }
        let Some((victim, target)) = tiny_group_indices(&groups)
            .into_iter()
            .find_map(|v| pick_merge_target(&groups, &area, v).map(|t| (v, t)))
        else {
            break; // no remaining tiny group has anywhere compatible to go.
        };
        let absorbed = groups.remove(victim);
        let target = if victim < target { target - 1 } else { target };
        merge_into(&mut groups[target], absorbed);
    }
    groups
}

/// hunk id -> its file's top-level directory.
fn hunk_areas(rev: &Revision) -> BTreeMap<HunkId, &str> {
    rev.files
        .iter()
        .flat_map(|f| {
            let dir = top_level_dir(&f.path);
            f.hunks.iter().map(move |h| (h.id.clone(), dir))
        })
        .collect()
}

/// Indices of groups with at most one hunk, excluding `Hidden`, smallest
/// first (so a merge chain prefers absorbing the very smallest groups).
fn tiny_group_indices(groups: &[Group]) -> Vec<usize> {
    let mut idx: Vec<usize> = groups
        .iter()
        .enumerate()
        .filter(|(_, g)| g.kind != GroupKind::Hidden && g.hunks.len() <= 1)
        .map(|(i, _)| i)
        .collect();
    idx.sort_by_key(|&i| groups[i].hunks.len());
    idx
}

/// The nearest (by reading-order distance) group that shares `victim`'s
/// kind and touches the same top-level area, or `None` if there isn't one.
fn pick_merge_target(
    groups: &[Group],
    area: &BTreeMap<HunkId, &str>,
    victim: usize,
) -> Option<usize> {
    let kind = groups[victim].kind;
    let victim_area = groups[victim]
        .hunks
        .first()
        .and_then(|h| area.get(h))
        .copied()?;
    groups
        .iter()
        .enumerate()
        .filter(|(i, g)| {
            *i != victim
                && g.kind == kind
                && g.kind != GroupKind::Hidden
                && g.hunks.iter().any(|h| area.get(h) == Some(&victim_area))
        })
        .min_by_key(|(i, _)| i.abs_diff(victim))
        .map(|(i, _)| i)
}

fn merge_into(target: &mut Group, absorbed: Group) {
    if !absorbed.title.is_empty() && absorbed.title != target.title {
        target
            .why
            .push_str(&format!(" Also includes: {}.", absorbed.title));
    }
    target.check.extend(absorbed.check);
    target.hunks.extend(absorbed.hunks);
    target.outliers.extend(absorbed.outliers);
}

#[cfg(test)]
mod tests {
    use super::*;
    use theodore_domain::grouping;
    use theodore_domain::{DiffLine, FileDiff, FileStatus, GroupId, Grouping, Hunk, LineKind, Sha};

    fn line() -> DiffLine {
        DiffLine {
            kind: LineKind::Add,
            text: "x".into(),
            old_no: None,
            new_no: None,
        }
    }

    fn mk_hunk(id: &str) -> Hunk {
        Hunk {
            id: HunkId::new(id),
            path: String::new(),
            old_start: 1,
            old_lines: 1,
            new_start: 1,
            new_lines: 1,
            header: String::new(),
            lines: vec![line()],
        }
    }

    fn mk_file(path: &str, hunk_ids: &[&str]) -> FileDiff {
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
            hunks: hunk_ids.iter().map(|id| mk_hunk(id)).collect(),
        }
    }

    fn mk_group(id: &str, kind: GroupKind, hunks: &[&str]) -> Group {
        Group {
            id: GroupId::new(id),
            title: id.into(),
            why: "w".into(),
            kind,
            risk: None,
            check: vec![],
            hunks: hunks.iter().map(|h| HunkId::new(*h)).collect(),
            outliers: vec![],
        }
    }

    /// Revision backing the groups below: two areas ("a" and "b"), each
    /// with one real group plus a couple of one-hunk stragglers.
    fn rev() -> Revision {
        Revision {
            base: Sha::new("b"),
            head: Sha::new("h"),
            files: vec![
                mk_file("a/core.rs", &["a1", "a2"]),
                mk_file("a/env.rs", &["a3"]),
                mk_file("a/ci.yml", &["a4"]),
                mk_file("b/core.rs", &["b1", "b2"]),
                mk_file("b/docs.md", &["b3"]),
            ],
        }
    }

    fn groups_for(rev: &Revision, groups: Vec<Group>) -> Grouping {
        Grouping {
            rev: rev.head.clone(),
            groups,
        }
    }

    #[test]
    fn below_target_is_a_no_op() {
        let r = rev();
        let groups = vec![
            mk_group("a-core", GroupKind::Normal, &["a1", "a2"]),
            mk_group("a-env", GroupKind::Normal, &["a3"]),
        ];
        let before = groups.clone();
        let after = merge_tiny_groups(&r, groups, 5);
        assert_eq!(after, before);
    }

    #[test]
    fn merges_tiny_same_area_groups_into_their_neighbour() {
        let r = rev();
        let groups = vec![
            mk_group("a-core", GroupKind::Normal, &["a1", "a2"]),
            mk_group("a-env", GroupKind::Normal, &["a3"]),
            mk_group("a-ci", GroupKind::Normal, &["a4"]),
            mk_group("b-core", GroupKind::Normal, &["b1", "b2"]),
            mk_group("b-docs", GroupKind::Normal, &["b3"]),
        ];
        let after = merge_tiny_groups(&r, groups, 2);
        assert_eq!(after.len(), 2, "should coarsen down to the target");
        // every hunk still placed in exactly one group, nothing lost.
        let g = groups_for(&r, after.clone());
        assert!(grouping::validate(&r, &g).is_ok());
        let a = after
            .iter()
            .find(|g| g.id == GroupId::new("a-core"))
            .unwrap();
        assert!(a.hunks.contains(&HunkId::new("a3")));
        assert!(a.hunks.contains(&HunkId::new("a4")));
        let b = after
            .iter()
            .find(|g| g.id == GroupId::new("b-core"))
            .unwrap();
        assert!(b.hunks.contains(&HunkId::new("b3")));
    }

    #[test]
    fn never_merges_a_hidden_group_as_donor_or_recipient() {
        let r = Revision {
            base: Sha::new("b"),
            head: Sha::new("h"),
            files: vec![mk_file("a/lock.json", &["h1"]), mk_file("a/x.rs", &["h2"])],
        };
        let groups = vec![
            mk_group("hidden", GroupKind::Hidden, &["h1"]),
            mk_group("solo", GroupKind::Normal, &["h2"]),
        ];
        let before = groups.clone();
        // target_max 1 would normally force a merge, but there is no
        // same-kind neighbour for either group (hidden is excluded, and
        // "solo" has no other candidate), so nothing should change.
        let after = merge_tiny_groups(&r, groups, 1);
        assert_eq!(after, before);
    }

    #[test]
    fn does_not_merge_across_incompatible_kinds() {
        let r = Revision {
            base: Sha::new("b"),
            head: Sha::new("h"),
            files: vec![mk_file("a/x.rs", &["h1", "h2"]), mk_file("a/y.rs", &["h3"])],
        };
        let groups = vec![
            mk_group("normal", GroupKind::Normal, &["h1", "h2"]),
            mk_group("skim", GroupKind::Skim, &["h3"]),
        ];
        let before = groups.clone();
        let after = merge_tiny_groups(&r, groups, 1);
        // "skim" is tiny and same-area, but not same-kind as "normal", so
        // there is no compatible target; the pass must leave it alone
        // rather than force an incorrect merge.
        assert_eq!(after, before);
    }

    #[test]
    fn preserves_the_partition_invariant_on_a_larger_mixed_input() {
        let r = rev();
        let groups = vec![
            mk_group("a-core", GroupKind::Normal, &["a1", "a2"]),
            mk_group("a-env", GroupKind::Normal, &["a3"]),
            mk_group("a-ci", GroupKind::Skim, &["a4"]),
            mk_group("b-core", GroupKind::Normal, &["b1", "b2"]),
            mk_group("b-docs", GroupKind::Skim, &["b3"]),
        ];
        let after = merge_tiny_groups(&r, groups, 1);
        let g = groups_for(&r, after);
        assert!(grouping::validate(&r, &g).is_ok());
    }
}
