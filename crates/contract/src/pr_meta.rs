//! PR metadata the UI reads straight off `PrSummary`/`Comment` (slice
//! `pr_meta`): PR age, reaction counts, and the stack indicator.
//!
//! `StackInfo` and `ReactionCount` are embedded fields of `domain::PrSummary`
//! and `domain::Comment` respectively, so — unlike this crate's other
//! per-slice modules — they're defined in `theodore_domain` (contract depends
//! on domain, never the reverse) and only re-exported and TS-registered
//! here.

pub use theodore_domain::{ReactionCount, StackInfo};
