//! Sending while a space's agent works (docs/spaces.md §8): a message sent
//! during a turn waits as a queued `chat_message` and runs as its own turn
//! once the turn ends; "Send now" steers it into the running turn instead.

use serde::{Deserialize, Serialize};
use specta::Type;
use theodore_domain::AgentId;

use crate::SpaceMode;

/// On a `ChatMessage` of yours that hasn't run yet: what it was sent with
/// and where it stands. Cleared when its turn starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct QueuedSend {
    /// Queue position: the queue sends lowest first.
    pub seq: u32,
    /// The picks it was sent with; `None` = the space's when it runs.
    #[serde(default)]
    pub agent: Option<AgentId>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub mode: Option<SpaceMode>,
    #[serde(default)]
    pub effort: Option<String>,
    /// Waits for your "Send" instead of running when its turn comes: its
    /// own turn couldn't start, or a usage limit left the space without an
    /// account and you chose not to continue by itself. A turn that was
    /// stopped or failed, or a restart, doesn't hold the queue: the next
    /// message runs all the same.
    #[serde(default)]
    pub held: bool,
}

/// What to do with one queued message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum QueuedAction {
    /// Run it now if the space is free; otherwise release it to the queue.
    Send,
    /// Drop it from the transcript.
    Cancel,
    /// Replace its text.
    Edit { text: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SpaceQueuedRequest {
    pub space: String,
    /// The queued `chat_message` id.
    pub message: String,
    pub action: QueuedAction,
}
