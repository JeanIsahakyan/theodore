//! Per-model validation of transaction ops (plan §3): hunk reads must stay
//! inside the current revision, task transitions follow the lifecycle,
//! drafts need a commentable anchor. Everything else is a plain write.

use theodore_contract::{HunkRead, MutationOp, models};
use theodore_domain::{Draft, Task, TaskStatus};

use crate::core::Core;
use theodore_domain::tasks::{TaskEvent, transition};

pub(super) async fn validate_op(core: &Core, op: &MutationOp) -> Result<(), String> {
    let model = match op {
        MutationOp::Create { model, .. }
        | MutationOp::Update { model, .. }
        | MutationOp::Archive { model, .. }
        | MutationOp::Delete { model, .. } => model.as_str(),
    };
    if !models::ALL.contains(&model) {
        return Err(format!("unknown model {model}"));
    }
    match (model, op) {
        (m, MutationOp::Create { data, .. }) if m == models::HUNK_READ => {
            validate_hunk_read(core, data).await
        }
        (m, MutationOp::Create { data, .. }) if m == models::DRAFT => {
            validate_draft(core, data).await
        }
        (m, MutationOp::Update { id, data, .. }) if m == models::TASK => {
            validate_task_update(core, id, data).await
        }
        _ => Ok(()),
    }
}

async fn validate_hunk_read(core: &Core, data: &serde_json::Value) -> Result<(), String> {
    let hr: HunkRead =
        serde_json::from_value(data.clone()).map_err(|e| format!("bad hunk_read: {e}"))?;
    let head = core.0.current_head.read().await.get(&hr.pr).cloned();
    let Some(head) = head else {
        return Err("hunk_read: pr is not open".into());
    };
    let revisions = core.0.revisions.read().await;
    let Some(entry) = revisions.get(&(hr.pr.clone(), head)) else {
        return Err("hunk_read: revision not cached".into());
    };
    if entry.revision.hunks().any(|h| h.id == hr.hunk) {
        Ok(())
    } else {
        Err(format!(
            "hunk_read: {} is not a hunk of the current revision",
            hr.hunk
        ))
    }
}

async fn validate_draft(core: &Core, data: &serde_json::Value) -> Result<(), String> {
    let draft: Draft =
        serde_json::from_value(data.clone()).map_err(|e| format!("bad draft: {e}"))?;
    let head = core.0.current_head.read().await.get(&draft.pr).cloned();
    let Some(head) = head else {
        return Err("draft: pr is not open".into());
    };
    let revisions = core.0.revisions.read().await;
    let Some(entry) = revisions.get(&(draft.pr.clone(), head)) else {
        return Err("draft: revision not cached".into());
    };
    if theodore_domain::anchors::is_commentable(&draft.anchor, &entry.revision) {
        Ok(())
    } else {
        Err("draft: anchor is not inside the current diff".into())
    }
}

async fn validate_task_update(
    core: &Core,
    id: &str,
    data: &serde_json::Value,
) -> Result<(), String> {
    let Some(status_val) = data.get("status") else {
        return Ok(());
    };
    let requested: TaskStatus =
        serde_json::from_value(status_val.clone()).map_err(|e| format!("bad status: {e}"))?;
    let store = core.0.deps.store.clone();
    let id_owned = id.to_string();
    let row = tokio::task::spawn_blocking(move || store.get(models::TASK, &id_owned))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let Some(row) = row else {
        return Err("task: not found".into());
    };
    let task: Task = serde_json::from_value(row.data).map_err(|e| format!("bad task row: {e}"))?;
    let event = match requested {
        TaskStatus::Progress => TaskEvent::Start,
        TaskStatus::Review => TaskEvent::FixReady,
        TaskStatus::Done => TaskEvent::Accept,
        TaskStatus::Todo if task.status == TaskStatus::Review => TaskEvent::Reject,
        TaskStatus::Todo => TaskEvent::Reopen,
    };
    transition(&task, event)
        .map(|_| ())
        .map_err(|e| e.to_string())
}
