//! Programmatic triggers for fixture demo events.

use std::sync::Mutex;
use theodore_domain::{PrRef, Sha};

/// Triggers for demo events: author push, checks green, agent crash.
pub struct Triggers {
    pending: Mutex<Vec<TriggerEvent>>,
}

#[derive(Debug, Clone)]
pub enum TriggerEvent {
    /// Author pushed a new commit to the PR.
    AuthorPush { pr: PrRef, new_head: Sha },
    /// Checks turned green for a PR.
    ChecksGreen { pr: PrRef },
    /// Agent crashed on the next run.
    AgentCrash { agent_name: String },
}

impl Triggers {
    /// Create a new trigger manager.
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(Vec::new()),
        }
    }

    /// Register an author push event.
    pub fn author_push(&self, pr: PrRef, new_head: Sha) {
        self.pending
            .lock()
            .unwrap()
            .push(TriggerEvent::AuthorPush { pr, new_head });
    }

    /// Register a checks-green event.
    pub fn checks_green(&self, pr: PrRef) {
        self.pending
            .lock()
            .unwrap()
            .push(TriggerEvent::ChecksGreen { pr });
    }

    /// Register an agent crash event for the next run of that agent.
    pub fn agent_crash(&self, agent_name: String) {
        self.pending
            .lock()
            .unwrap()
            .push(TriggerEvent::AgentCrash { agent_name });
    }

    /// Pop the next pending trigger event.
    pub fn pop(&self) -> Option<TriggerEvent> {
        let mut pending = self.pending.lock().unwrap();
        if pending.is_empty() {
            None
        } else {
            Some(pending.remove(0))
        }
    }

    /// Get all pending triggers without removing them.
    pub fn pending(&self) -> Vec<TriggerEvent> {
        self.pending.lock().unwrap().clone()
    }

    /// Clear all pending triggers.
    pub fn clear(&self) {
        self.pending.lock().unwrap().clear();
    }
}

impl Default for Triggers {
    fn default() -> Self {
        Self::new()
    }
}
