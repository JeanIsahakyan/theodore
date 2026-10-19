//! Read-only Linear integration (plan "Linear"): connect a personal API
//! key, and link a PR to the Linear issues named in its title, branch or
//! body.

use serde::{Deserialize, Serialize};
use specta::Type;
use theodore_domain::PrId;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SetLinearTokenRequest {
    /// `None` disconnects (clears the stored token). Validated against
    /// Linear's `viewer` query before being stored.
    pub token: Option<String>,
}

/// Connection state for Settings → Integrations → Linear.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct LinearStatus {
    pub connected: bool,
    pub user: Option<String>,
    pub workspace: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct LinearIssuesRequest {
    pub pr: PrId,
}

/// One Linear issue linked to a PR — found by matching an issue key
/// (`ABC-123`) in the PR's title, head branch or body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct LinearIssue {
    pub identifier: String,
    pub title: String,
    pub state_name: String,
    /// Linear's `WorkflowState.type`: `triage`, `backlog`, `unstarted`,
    /// `started`, `completed` or `canceled` — kept as the raw string so an
    /// unrecognized future value never fails to deserialize.
    pub state_type: String,
    pub assignee: Option<String>,
    pub priority: Option<u8>,
    pub url: String,
    pub team_key: String,
}
