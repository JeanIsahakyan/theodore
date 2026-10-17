//! Port traits. `app` depends only on these and on `domain`; adapters
//! implement them and are injected (plan §2.1).
//!
//! Changing a trait here is a cross-slice change: adapters, `app` and the
//! fixture adapters all follow.

pub mod agent;
pub mod clock;
pub mod git;
pub mod host;
pub mod secrets;
pub mod store;

pub use agent::*;
pub use clock::*;
pub use git::*;
pub use host::*;
pub use secrets::*;
pub use store::*;
