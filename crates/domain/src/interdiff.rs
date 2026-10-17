//! Revisions across pushes: hunk identity, what changed since a baseline.

use std::collections::BTreeMap;

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
        h.update([b'\n']);
    }
    HunkId(hex::encode(&h.finalize()[..8]))
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

/// Classify every hunk of `new` against `old`.
pub fn classify(old: &Revision, new: &Revision) -> BTreeMap<HunkId, HunkChange> {
    let _ = (old, new);
    todo!("domain slice")
}

/// Word-level diff of two versions of a hunk, for the interdiff view.
pub fn word_diff(old: &Hunk, new: &Hunk) -> Vec<WordSpan> {
    let _ = (old, new);
    todo!("domain slice")
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WordSpan {
    pub kind: crate::model::LineKind,
    pub text: String,
}
