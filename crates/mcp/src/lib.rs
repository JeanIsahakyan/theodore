//! MCP tools servers over localhost HTTP, plus the stdio bridge.
//!
//! `backend` defines [`backend::ReviewToolsBackend`] (a PR's state) and
//! [`backend::SpaceToolsBackend`] (a space's commands), the traits `app`
//! implements, and [`backend::CodeToolsBackend`] (code intelligence) in
//! either. `server` serves both as one MCP Streamable HTTP endpoint, one
//! bearer token per agent run: the token decides whether the run sees
//! `review-tools` or `space-tools`. `bridge` proxies a stdio MCP server to
//! that endpoint, for agent CLIs without HTTP MCP (docs/plan.md §8.3).

pub mod backend;
pub mod bridge;
pub mod server;
pub mod tools;

pub use backend::{
    AppStatus, BackendError, CODE_EDIT_TOOL_NAMES, CODE_TOOL_NAMES, CheckOutcome, CodeEditOutcome,
    CodeTools, CodeToolsBackend, FileSummary, GroupSummary, GroupWithHunks, LogTail, NewFinding,
    NewPatch, NoCodeTools, NoSpaceTools, PrContext, REVIEW_SPACE_TOOL_NAMES, REVIEW_TOOL_NAMES,
    ReviewToolsBackend, RunContext, SPACE_TOOL_NAMES, SpaceCommandName, SpaceInfo, SpaceToolError,
    SpaceToolsBackend, ToolSet,
};
pub use bridge::{BridgeError, run_stdio_bridge};
pub use server::{McpHandle, McpServer};
