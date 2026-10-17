#![forbid(unsafe_code)]

//! Fixture adapters for dev and e2e runs without network access (plan §12.1).
//!
//! Implements every port trait over recorded data: PRs and threads from
//! JSON, git revisions and file blobs from JSON + plain files, agent runs
//! from recorded event streams. [`FixtureSet::load`] builds all five
//! sharing one mutable state, so a [`Triggers`] call is visible through
//! `FixtureHost` and `FixtureGit` immediately.

pub mod agent;
pub mod clock;
pub mod error;
pub mod git;
pub mod host;
mod state;
pub mod triggers;

pub use agent::ReplayAgents;
pub use clock::ManualClock;
pub use error::FixtureError;
pub use git::FixtureGit;
pub use host::FixtureHost;
pub use triggers::Triggers;

use std::path::Path;
use std::sync::{Arc, Mutex};

use state::SharedState;

/// Builds the five fixture adapters over one shared state loaded from
/// `dir` (see `data/demo` for the layout).
pub struct FixtureSet;

impl FixtureSet {
    pub fn load(
        dir: impl AsRef<Path>,
    ) -> Result<(FixtureHost, FixtureGit, ReplayAgents, ManualClock, Triggers), FixtureError> {
        let dir = dir.as_ref();
        let state = Arc::new(Mutex::new(SharedState::load(dir)?));

        let host = FixtureHost::new(state.clone());
        let git = FixtureGit::new(state.clone());
        let agents = ReplayAgents::new(dir, state.clone());
        let clock = ManualClock::new(0);
        let triggers = Triggers::new(state);

        Ok((host, git, agents, clock, triggers))
    }
}

#[cfg(test)]
mod tests;
