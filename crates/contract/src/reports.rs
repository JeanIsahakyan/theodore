//! "My reports" (docs/telemetry.md): the issues "Report a problem" opened
//! from this install, followed until the fix ships. Synced as model
//! `report`, keyed `owner/name#number`; core-owned (no client writes).

use serde::{Deserialize, Serialize};
use specta::Type;
use theodore_domain::Millis;

/// Where a report stands, as "My reports" shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ReportStatus {
    Open,
    /// Closed as completed; not in a release yet (or none could be found).
    Fixed,
    /// The fix is in `TrackedReport::released_in`.
    Released,
    /// Closed as not planned or as a duplicate (`close_reason`).
    NotPlanned,
}

/// One followed report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct TrackedReport {
    /// `owner/name`.
    pub repo: String,
    pub number: u64,
    pub url: String,
    pub title: String,
    pub status: ReportStatus,
    pub filed_at: Millis,
    /// The issue's last activity on GitHub; `filed_at` until first checked.
    pub updated_at: Millis,
    pub comments: u32,
    /// GitHub's reason when closed: `completed`, `not_planned`, `duplicate`.
    #[serde(default)]
    pub close_reason: Option<String>,
    #[serde(default)]
    pub closed_at: Option<Millis>,
    /// The PR that closed it.
    #[serde(default)]
    pub fixed_by: Option<u64>,
    #[serde(default)]
    pub fixed_by_url: Option<String>,
    /// The commit that landed the fix: what a release must contain.
    #[serde(default)]
    pub fix_sha: Option<String>,
    /// The first release with the fix, without the `v` (`0.1.7`).
    #[serde(default)]
    pub released_in: Option<String>,
    /// Who opened the issue: a comment by anyone else is a reply.
    #[serde(default)]
    pub author: Option<String>,
    /// The version "fixed in this version" was said in, so it's said once.
    #[serde(default)]
    pub told_in: Option<String>,
}
