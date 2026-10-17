//! Hunk-level read state → file-level Viewed (plan §4).

use std::collections::BTreeSet;

use crate::model::{HunkId, Revision, ViewedState};

/// Read hunks of one PR for the current user.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ReadSet(pub BTreeSet<HunkId>);

/// Paths whose hunks are now all read (they should become Viewed on the host).
pub fn newly_viewed(rev: &Revision, before: &ReadSet, after: &ReadSet) -> Vec<String> {
    let _ = (rev, before, after);
    todo!("domain slice")
}

/// Viewed state of `path` from reads alone.
pub fn file_state(rev: &Revision, read: &ReadSet, path: &str) -> ViewedState {
    let _ = (rev, read, path);
    todo!("domain slice")
}

/// Share of non-hidden hunks read, 0.0..=1.0.
pub fn progress(rev: &Revision, read: &ReadSet, hidden: &BTreeSet<HunkId>) -> f32 {
    let _ = (rev, read, hidden);
    todo!("domain slice")
}
