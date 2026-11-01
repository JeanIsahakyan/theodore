//! MCP tools servers over localhost HTTP, plus the stdio bridge.
//!
//! `backend` defines [`backend::ReviewToolsBackend`] (a PR's state) and
//! [`backend::SpaceToolsBackend`] (a space's commands), the traits `app`
//! implements. `server` serves both as one MCP Streamable HTTP endpoint, one
//! bearer token per agent run: the token decides whether the run sees
//! `review-tools` or `space-tools`. `bridge` proxies a stdio MCP server to
//! that endpoint, for agent CLIs without HTTP MCP (docs/plan.md §8.3).

pub mod backend;
pub mod bridge;
pub mod server;
pub mod space_agent;
pub mod tools;

pub use backend::{
    AppStatus, BackendError, BaseChange, CheckOutcome, FileSummary, GroupSummary, GroupWithHunks,
    LogTail, NewFinding, NewPatch, NewReviewComment, NoSpaceTools, PrContext, ProgressStep,
    ProgressStepState, REVIEW_SPACE_TOOL_NAMES, REVIEW_TOOL_NAMES, ReviewItem, ReviewToolsBackend,
    RunContext, SPACE_TOOL_NAMES, ShipOutcome, ShipToolAction, SpaceCommandName, SpaceDiff,
    SpaceInfo, SpaceToolError, SpaceToolsBackend, ToolSet,
};
pub use bridge::{BridgeError, run_stdio_bridge};
pub use server::{McpHandle, McpServer};
