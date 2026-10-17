//! MCP review-tools server over localhost HTTP, plus the stdio bridge.
//!
//! `backend` defines [`backend::ReviewToolsBackend`], the trait `app`
//! implements with the real PR state. `server` serves it as an MCP
//! Streamable HTTP endpoint, one bearer token per agent run. `bridge` proxies
//! a stdio MCP server to that endpoint, for agent CLIs without HTTP MCP
//! (docs/plan.md §8.3).

pub mod backend;
pub mod bridge;
pub mod server;
pub mod tools;

pub use backend::{
    BackendError, FileSummary, GroupSummary, GroupWithHunks, NewFinding, NewPatch, PrContext,
    ReviewToolsBackend, RunContext,
};
pub use bridge::{BridgeError, run_stdio_bridge};
pub use server::{McpHandle, McpServer};
