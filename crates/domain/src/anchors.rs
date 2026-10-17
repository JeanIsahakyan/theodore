//! Anchor remapping after a push (plan §4).

use crate::model::{Anchor, Revision};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Remapped {
    Moved(Anchor),
    /// The anchored line no longer exists.
    Outdated,
}

/// Map an anchor made against `old` onto `new`, using both diffs against the
/// same base. `between` is the diff `old.head..new.head` (as a Revision).
pub fn remap(anchor: &Anchor, between: &Revision, new_head: &crate::model::Sha) -> Remapped {
    let _ = (anchor, between, new_head);
    todo!("domain slice")
}

/// Is the anchor inside one of the revision's hunks (commentable on the host)?
pub fn is_commentable(anchor: &Anchor, rev: &Revision) -> bool {
    let _ = (anchor, rev);
    todo!("domain slice")
}
