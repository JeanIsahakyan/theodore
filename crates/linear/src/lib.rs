//! Read-only GraphQL client for Linear (`https://api.linear.app/graphql`):
//! the authenticated viewer/workspace (for Settings' connect card) and
//! issue lookup by identifier (for linking a PR to the Linear issue it
//! references).
//!
//! Linear's personal API keys go in a bare `Authorization: <key>` header —
//! no `Bearer` prefix, unlike every other host this app talks to. That
//! mismatch is why this crate calls `reqwest` directly instead of building
//! on `theodore-host-http`'s `HttpClient`, which always adds one.

#![forbid(unsafe_code)]

mod client;
mod keys;

pub use client::{LinearClient, LinearError, LinearIssueData, LinearViewer};
pub use keys::find_issue_keys;
