#![forbid(unsafe_code)]

//! Fixture adapters for testing and development without network access.
//!
//! Provides mock implementations of all port traits to enable running the core
//! in isolation with recorded data: PRs, git repos, and agent streams.

pub mod agent;
pub mod clock;
pub mod git;
pub mod host;
pub mod triggers;

pub use agent::ReplayAgents;
pub use clock::ManualClock;
pub use git::FixtureGit;
pub use host::FixtureHost;
pub use triggers::Triggers;

#[cfg(test)]
mod tests;
