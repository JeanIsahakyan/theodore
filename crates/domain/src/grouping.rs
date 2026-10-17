//! Grouping invariants (plan §5.1): a grouping is valid only if it is a
//! partition of the revision's hunk ids.

use crate::model::{GroupId, Grouping, HunkId, Revision};

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
    let _ = (rev, grouping);
    todo!("domain slice")
}

/// Put every hunk not in any group into a trailing "Other" group and drop
/// unknown / duplicate assignments (first wins). Result always validates.
pub fn repair_with_other(rev: &Revision, grouping: Grouping) -> Grouping {
    let _ = rev;
    let _ = grouping;
    todo!("domain slice")
}
