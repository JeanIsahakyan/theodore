//! `theodore` CLI internals, split out as a library so integration tests can
//! drive each command's testable core directly (with a fake `AgentPort`)
//! instead of going through `main`.

pub mod deps;
pub mod difffile;
pub mod eval;
pub mod group;
pub mod mcp_bridge;
