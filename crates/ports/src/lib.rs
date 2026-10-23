//! Port traits. `app` depends only on these and on `domain`; adapters
//! implement them and are injected (plan §2.1).
//!
//! Changing a trait here is a cross-slice change: adapters, `app` and the
//! fixture adapters all follow.

pub mod account;
pub mod agent;
pub mod clock;
pub mod command;
pub mod device_login;
pub mod git;
pub mod host;
pub mod secrets;
pub mod space_tools;
pub mod store;
pub mod worktree_lease;

pub use account::*;
pub use agent::*;
pub use clock::*;
pub use command::*;
pub use device_login::*;
pub use git::*;
pub use host::*;
pub use secrets::*;
pub use space_tools::*;
pub use store::*;
pub use worktree_lease::*;
