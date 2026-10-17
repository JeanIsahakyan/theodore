//! Task lifecycle: todo → progress → review → done (plan §4).

use crate::model::{Task, TaskStatus};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskEvent {
    Start,
    FixReady,
    Accept,
    Reject,
    Reopen,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("cannot {event:?} a task in {from:?}")]
pub struct InvalidTransition {
    pub from: TaskStatus,
    pub event: TaskEvent,
}

pub fn transition(task: &Task, event: TaskEvent) -> Result<TaskStatus, InvalidTransition> {
    let _ = (task, event);
    todo!("domain slice")
}
