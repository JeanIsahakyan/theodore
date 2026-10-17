//! Findings from several agents merge into one (plan §4).

use crate::model::Finding;

/// Same file + overlapping lines (±2) + similar title → one finding with the
/// union of `agents`. Keeps the higher severity.
pub fn merge(existing: &[Finding], incoming: Finding) -> MergeOutcome {
    let _ = (existing, incoming);
    todo!("domain slice")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeOutcome {
    New(Finding),
    MergedInto(Finding),
}

/// Title similarity 0.0..=1.0 (normalized token overlap).
pub fn title_similarity(a: &str, b: &str) -> f32 {
    let _ = (a, b);
    todo!("domain slice")
}
