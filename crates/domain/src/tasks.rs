//! Task lifecycle: todo → progress → review → done (plan §4).

use crate::model::{Assignee, Task, TaskStatus};

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

/// `todo -> progress` (Start), `progress -> review` (FixReady),
/// `review -> done` (Accept, resolves the linked thread),
/// `review -> todo` (Reject), `done -> todo` (Reopen). A human task (no
/// agent fix to review) may also go straight `todo -> done` via Accept —
/// e.g. a review comment the author just resolves. Every other
/// (status, event) pair is an `InvalidTransition`.
pub fn transition(task: &Task, event: TaskEvent) -> Result<TaskStatus, InvalidTransition> {
    use TaskEvent::*;
    use TaskStatus::*;

    let to = match (task.status, event) {
        (Todo, Start) => Some(Progress),
        (Progress, FixReady) => Some(Review),
        (Review, Accept) => Some(Done),
        (Review, Reject) => Some(Todo),
        (Done, Reopen) => Some(Todo),
        (Todo, Accept) if matches!(task.assignee, Assignee::Human(_)) => Some(Done),
        _ => None,
    };

    to.ok_or(InvalidTransition {
        from: task.status,
        event,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AgentId, PrId, TaskId};

    fn task(status: TaskStatus, assignee: Assignee) -> Task {
        Task {
            id: TaskId::new("t1"),
            pr: PrId::new("pr"),
            title: "fix it".into(),
            body: String::new(),
            anchor: None,
            thread: None,
            status,
            assignee,
            fix: None,
            created_at: 0,
            outdated: false,
        }
    }

    #[test]
    fn start_moves_todo_to_progress() {
        let t = task(TaskStatus::Todo, Assignee::Agent(AgentId::Claude));
        assert_eq!(transition(&t, TaskEvent::Start), Ok(TaskStatus::Progress));
    }

    #[test]
    fn fix_ready_moves_progress_to_review() {
        let t = task(TaskStatus::Progress, Assignee::Agent(AgentId::Claude));
        assert_eq!(transition(&t, TaskEvent::FixReady), Ok(TaskStatus::Review));
    }

    #[test]
    fn accept_moves_review_to_done() {
        let t = task(TaskStatus::Review, Assignee::Agent(AgentId::Claude));
        assert_eq!(transition(&t, TaskEvent::Accept), Ok(TaskStatus::Done));
    }

    #[test]
    fn reject_moves_review_to_todo() {
        let t = task(TaskStatus::Review, Assignee::Agent(AgentId::Claude));
        assert_eq!(transition(&t, TaskEvent::Reject), Ok(TaskStatus::Todo));
    }

    #[test]
    fn reopen_moves_done_to_todo() {
        let t = task(TaskStatus::Done, Assignee::Human("me".into()));
        assert_eq!(transition(&t, TaskEvent::Reopen), Ok(TaskStatus::Todo));
    }

    #[test]
    fn human_task_accepts_directly_from_todo() {
        let t = task(TaskStatus::Todo, Assignee::Human("me".into()));
        assert_eq!(transition(&t, TaskEvent::Accept), Ok(TaskStatus::Done));
    }

    #[test]
    fn agent_task_cannot_accept_directly_from_todo() {
        let t = task(TaskStatus::Todo, Assignee::Agent(AgentId::Claude));
        assert_eq!(
            transition(&t, TaskEvent::Accept),
            Err(InvalidTransition {
                from: TaskStatus::Todo,
                event: TaskEvent::Accept,
            })
        );
    }

    #[test]
    fn start_from_progress_is_invalid() {
        let t = task(TaskStatus::Progress, Assignee::Agent(AgentId::Claude));
        assert!(transition(&t, TaskEvent::Start).is_err());
    }

    #[test]
    fn reject_from_todo_is_invalid() {
        let t = task(TaskStatus::Todo, Assignee::Agent(AgentId::Claude));
        assert!(transition(&t, TaskEvent::Reject).is_err());
    }

    #[test]
    fn reopen_from_review_is_invalid() {
        let t = task(TaskStatus::Review, Assignee::Agent(AgentId::Claude));
        assert!(transition(&t, TaskEvent::Reopen).is_err());
    }

    #[test]
    fn fix_ready_from_done_is_invalid() {
        let t = task(TaskStatus::Done, Assignee::Agent(AgentId::Claude));
        assert!(transition(&t, TaskEvent::FixReady).is_err());
    }
}
