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
mod sync;
mod usecases;
mod wire;

#[cfg(any(test, feature = "testkit"))]
pub mod testkit;

#[cfg(test)]
mod tests;

pub use core::{Core, Receivers};
pub use deps::{Deps, Grouper};
pub use error::{AppError, AppResult, GrouperError};
