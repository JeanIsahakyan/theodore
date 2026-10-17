//! Grouping invariants (plan §5.1): a grouping is valid only if it is a
//! partition of the revision's hunk ids.

use std::collections::{BTreeMap, BTreeSet};

use crate::model::{Group, GroupId, GroupKind, Grouping, HunkId, Revision};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GroupingError {
    #[error("hunk {0} is in no group")]
    Missing(HunkId),
    #[error("hunk {hunk} is in several groups: {groups:?}")]
    Duplicate { hunk: HunkId, groups: Vec<GroupId> },
    #[error("unknown hunk id {0}")]
    Unknown(HunkId),
    #[error("duplicate group id {0}")]
    DuplicateGroup(GroupId),
    #[error("group {0} has no hunks")]
    EmptyGroup(GroupId),
    #[error("group {group}: outlier {hunk} is not one of its hunks")]
    OutlierNotInGroup { group: GroupId, hunk: HunkId },
    #[error("group {0}: empty title")]
    EmptyTitle(GroupId),
}

/// Every error found, not only the first — the list is fed back to the agent
/// in the repair call.
pub fn validate(rev: &Revision, grouping: &Grouping) -> Result<(), Vec<GroupingError>> {
    let known: BTreeSet<&HunkId> = rev.hunks().map(|h| &h.id).collect();
    let mut errors = Vec::new();
    let mut seen_groups = BTreeSet::new();
    let mut owners: BTreeMap<&HunkId, Vec<GroupId>> = BTreeMap::new();

    for g in &grouping.groups {
        if !seen_groups.insert(&g.id) {
            errors.push(GroupingError::DuplicateGroup(g.id.clone()));
        }
        if g.title.trim().is_empty() {
            errors.push(GroupingError::EmptyTitle(g.id.clone()));
        }
        if g.hunks.is_empty() {
            errors.push(GroupingError::EmptyGroup(g.id.clone()));
        }
        for h in &g.hunks {
            if !known.contains(h) {
                errors.push(GroupingError::Unknown(h.clone()));
            }
            owners.entry(h).or_default().push(g.id.clone());
        }
        let own: BTreeSet<&HunkId> = g.hunks.iter().collect();
        for o in &g.outliers {
            if !own.contains(o) {
                errors.push(GroupingError::OutlierNotInGroup {
                    group: g.id.clone(),
                    hunk: o.clone(),
                });
            }
        }
    }
    for (hunk, groups) in &owners {
        if groups.len() > 1 && known.contains(hunk) {
            errors.push(GroupingError::Duplicate {
                hunk: (*hunk).clone(),
                groups: groups.clone(),
            });
        }
    }
    for h in rev.hunks() {
        if !owners.contains_key(&h.id) {
            errors.push(GroupingError::Missing(h.id.clone()));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

/// Put every hunk not in any group into a trailing "Other" group and drop
/// unknown / duplicate assignments (first wins). Result always validates.
pub fn repair_with_other(rev: &Revision, grouping: Grouping) -> Grouping {
    let known: BTreeSet<HunkId> = rev.hunks().map(|h| h.id.clone()).collect();
    let mut taken: BTreeSet<HunkId> = BTreeSet::new();
    let mut ids: BTreeSet<GroupId> = BTreeSet::new();
    let mut groups = Vec::new();

    for mut g in grouping.groups {
        if !ids.insert(g.id.clone()) {
            continue;
        }
        g.hunks
            .retain(|h| known.contains(h) && taken.insert(h.clone()));
        let own: BTreeSet<HunkId> = g.hunks.iter().cloned().collect();
        g.outliers.retain(|o| own.contains(o));
        if g.title.trim().is_empty() {
            g.title = g.id.0.clone();
        }
        if !g.hunks.is_empty() {
            groups.push(g);
        }
    }
    let rest: Vec<HunkId> = rev
        .hunks()
        .map(|h| h.id.clone())
        .filter(|h| !taken.contains(h))
        .collect();
    if !rest.is_empty() {
        let mut id = GroupId::new("other");
        let mut n = 2;
        while ids.contains(&id) {
            id = GroupId(format!("other-{n}"));
            n += 1;
        }
        groups.push(Group {
            id,
            title: "Other".into(),
            why: "Changes the grouping did not place.".into(),
            kind: GroupKind::Normal,
            risk: None,
            check: vec![],
            hunks: rest,
            outliers: vec![],
        });
    }
    Grouping {
        rev: grouping.rev,
        groups,
    }
}
