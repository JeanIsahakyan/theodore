//! Use cases, sync engine, outbox, scheduler (plan §2.1, §3).
//!
//! `app` depends only on `domain` and `ports`; every adapter is injected
//! through `Deps`. The same `Core` runs inside Tauri and inside the CLI.

mod core;
mod deps;
mod error;
mod outbox;
mod poller;
mod reading;
mod settings;
mod snapshot;
mod sync;
mod usecases;
mod wire;

#[cfg(any(test, feature = "testkit"))]
pub mod testkit;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod git_integration_tests;

#[cfg(test)]
mod interdiff_tests;

#[cfg(test)]
mod diff_media_integration_tests;

pub use core::{Core, Receivers};
pub use deps::{Deps, Grouper, RunTools, TokenStatus};
pub use error::{AppError, AppResult, GrouperError};
pub use snapshot::PrSnapshot;
pub use usecases::open_pr::parse_pr_ref;
