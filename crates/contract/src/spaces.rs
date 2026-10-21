//! Spaces (docs/spaces.md): the stage before a pull request — an agent
//! writes the change in its own worktree, you review it, then it becomes a
//! PR. Hidden behind the UI's `FEATURES.buildMode` / `labs.build_mode`.

use serde::{Deserialize, Serialize};
use specta::Type;
use theodore_domain::{AgentId, Millis, PrId, Sha, Usage};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SpaceStatus {
    /// No turn running.
    Idle,
    Running,
    /// The last turn errored, was interrupted, or the worktree is gone.
    Failed,
    Archived,
}

/// What the agent may do in a turn (docs/spaces.md §5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SpaceMode {
    /// Read, grep, MCP; no writes.
    Ask,
    /// Edit files inside the space.
    Edit,
}

/// Synced row `space`, id = `Space::id`. Core-owned: written only by the
/// space commands, never by a client transaction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Space {
    pub id: String,
    /// `Project::id` the space belongs to.
    pub project: String,
    pub name: String,
    /// What the space is for; sent as the first turn.
    pub goal: String,
    /// Branch name the work is pushed to once shipped (`theo/<slug>`).
    pub branch: String,
    /// Base branch name, and the commit the space forked from.
    pub base: String,
    pub base_sha: Sha,
    /// Last checkpoint (`refs/theodore/spaces/<id>`).
    pub head_sha: Sha,
    /// Absolute path of the space's worktree.
    pub worktree: String,
    pub status: SpaceStatus,
    pub agent: AgentId,
    #[serde(default)]
    pub model: Option<String>,
    pub mode: SpaceMode,
    /// The branch review (`open_branch` plumbing) the live diff and Review use.
    #[serde(default)]
    pub review_pr: Option<PrId>,
    /// The host PR, once opened: the link from drafting to review.
    #[serde(default)]
    pub pr: Option<PrId>,
    /// Sum of every finished turn's usage (the per-space budget reads it).
    pub usage: Usage,
    pub turns: u32,
    /// Run id of the turn in flight (`space:<id>:<message>`); its streaming
    /// text arrives as `Ephemeral::AgentDelta` under this id.
    #[serde(default)]
    pub run: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    pub created_at: Millis,
    pub updated_at: Millis,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct CreateSpaceRequest {
    pub project: String,
    /// What should change. Sent as the first turn unless empty.
    pub goal: String,
    /// Defaults to a slug of the goal.
    #[serde(default)]
    pub name: Option<String>,
    /// Defaults to `theo/<name>`.
    #[serde(default)]
    pub branch: Option<String>,
    /// Defaults to the project's default branch.
    #[serde(default)]
    pub base: Option<String>,
    /// Defaults to the `agents.chat` setting.
    #[serde(default)]
    pub agent: Option<AgentId>,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SpaceSendRequest {
    pub space: String,
    pub text: String,
    /// Switches the space's agent from this turn on.
    #[serde(default)]
    pub agent: Option<AgentId>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub mode: Option<SpaceMode>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SpaceReviewRequest {
    pub space: String,
    /// Also group the diff by meaning (Review); `false` for the live diff.
    pub group: bool,
}
