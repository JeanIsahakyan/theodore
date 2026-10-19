//! Interdiff (plan §4, "Re-review"): what changed in a hunk since an
//! earlier revision the user already looked at — word-level highlights
//! between the hunk as it stood at that head and as it stands now.

use serde::{Deserialize, Serialize};
use specta::Type;
use theodore_domain::{HunkId, LineKind, PrId, Sha};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct InterdiffRequest {
    pub pr: PrId,
    /// The head you last reviewed/visited — the comparison baseline.
    pub base_sha: Sha,
    /// Limit to one file; omitted compares every file in the revision.
    pub file: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum InterdiffClass {
    New,
    Changed,
    Unchanged,
    /// Present at the baseline, no counterpart now — reverted, or no
    /// longer differs from base.
    Vanished,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct InterdiffWordSpan {
    pub kind: LineKind,
    pub text: String,
}

/// One hunk's state since `base_sha`. `hunk` identifies the *current*
/// revision's hunk for `new` / `changed` / `unchanged`, and the
/// *baseline* revision's hunk for `vanished`, which has no current-side
/// hunk to use instead.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct InterdiffEntry {
    pub hunk: HunkId,
    pub path: String,
    pub class: InterdiffClass,
    /// Set when `class` is `Changed`: the baseline hunk's id, to label
    /// the "previously" side.
    pub previous: Option<HunkId>,
    /// Word-level diff between the baseline hunk and this one ("previously"
    /// vs. "now"); empty outside `Changed`.
    pub words: Vec<InterdiffWordSpan>,
}
