//! Theodore domain: pure review logic. No I/O, no async, no clocks.
//!
//! `model` holds the shared vocabulary every other crate speaks. The other
//! modules hold the rules (see docs/plan.md §4).

pub mod anchors;
pub mod findings;
pub mod grouping;
pub mod interdiff;
pub mod model;
pub mod reading;
pub mod snooze;
pub mod stack;
pub mod tasks;

pub use model::*;
