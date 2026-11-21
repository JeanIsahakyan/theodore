//! Notes in a space's timeline that are not part of its conversation
//! (docs/spaces.md "Sub-spaces, and asking other spaces"): who asked the
//! space something, and what it answered. A model of their own, never a
//! `chat_message`: every path that feeds an agent, a mirror or shipping
//! reads chat rows only, so a note can't reach any of them.

use serde::{Deserialize, Serialize};
use specta::Type;
use theodore_domain::{AgentId, Millis, PrId};

/// A `space_note` row, keyed by its own id.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SpaceNote {
    pub id: String,
    /// The space's chat key, `space:<id>`: loaded with its transcript.
    pub pr: PrId,
    pub at: Millis,
    pub ask: SpaceAskNote,
}

/// Someone asked the space a question (`space_ask`, or the fleet's
/// `ask_space`); a read-only copy of its agent answered or failed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct SpaceAskNote {
    pub from: AskedBy,
    pub question: String,
    /// None when it failed.
    #[serde(default)]
    pub answer: Option<String>,
    /// Why there is no answer (timed out, the agent failed).
    #[serde(default)]
    pub failed: Option<String>,
    /// The agent that answered (or last tried), and its model; none: the
    /// CLI's default.
    #[serde(default)]
    pub agent: Option<AgentId>,
    #[serde(default)]
    pub model: Option<String>,
    /// `fork`: a copy of the space's own session; `fresh`: a new agent
    /// told what the space holds.
    #[serde(default)]
    pub how: Option<String>,
}

/// Who asked, as they were named then.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AskedBy {
    /// Another space's agent, on this computer.
    Space { space: String, title: String },
    /// One of the user's devices (or an MCP client) through the fleet.
    Device { name: String },
}
