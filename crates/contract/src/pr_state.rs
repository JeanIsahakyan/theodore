//! Richer PR state, re-running checks, and triage (slice `pr_state`).

use serde::{Deserialize, Serialize};
use specta::Type;
use theodore_domain::PrId;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct RerunCheckRequest {
    pub pr: PrId,
    /// `Check::id`, as reported in `PrDetail::checks`.
    pub check: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum TriageAction {
    /// The viewer takes the review themselves.
    Take,
    /// The viewer declines; the inbox row is marked done.
    Decline,
    /// Hand the review to someone else (logins).
    Reassign { to: Vec<String> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct TriageRequest {
    pub pr: PrId,
    pub action: TriageAction,
}
