//! Per-model validation of transaction ops (plan §3): hunk reads must stay
//! inside the current revision, task transitions follow the lifecycle,
//! drafts need a commentable anchor. Every model not covered below is
//! core-owned (written only by the sync engine, the poller or a usecase) and
//! is rejected outright — a client transaction never reaches it.

use theodore_contract::{HunkRead, MutationOp, models};
use theodore_domain::{Anchor, Draft, FindingState, PrId, Task, TaskStatus};

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
    // Threads are host truth (inside `pr_detail`); they change only through
    // reply/resolve commands, never through a client transaction.
    if model == models::THREAD {
        return Err("threads are changed through reply_thread / resolve_thread".into());
    }
    match (model, op) {
        // ── hunk_read: marks one hunk of the current revision read ────────
        (m, MutationOp::Create { data, .. }) if m == models::HUNK_READ => {
            validate_hunk_read(core, data).await
        }

        // ── file_viewed: local mirror of a Viewed toggle; the host write
        // itself goes through the `set_viewed` outbox op, not here.
        (m, MutationOp::Create { .. } | MutationOp::Update { .. }) if m == models::FILE_VIEWED => {
            Ok(())
        }

        // ── draft: a comment being composed, not yet submitted ────────────
        (m, MutationOp::Create { data, .. }) if m == models::DRAFT => {
            validate_draft_create(core, data).await
        }
        (m, MutationOp::Update { id, .. }) if m == models::DRAFT => {
            validate_draft_update(core, id).await
        }
        (m, MutationOp::Delete { .. } | MutationOp::Archive { .. }) if m == models::DRAFT => Ok(()),

        // ── finding: agent-authored; the client may only move `state`
        // (ignore it, or mark it drafted/maybe-fixed) ──────────────────────
        (m, MutationOp::Update { data, .. }) if m == models::FINDING => {
            validate_finding_state(data)
        }

        // ── task: client creates one from a finding, then only ever moves
        // `status` and/or reassigns it; title/body/anchor/fix are core's ──
        (m, MutationOp::Create { data, .. }) if m == models::TASK => validate_task_create(data),
        (m, MutationOp::Update { id, data, .. }) if m == models::TASK => {
            validate_task_update(core, id, data).await
        }

        // ── skill_run: the client may only dismiss (archive) a run; the
        // run itself, its output and its usage are written by the agent
        // pipeline ──────────────────────────────────────────────────────────
        (m, MutationOp::Archive { .. }) if m == models::SKILL_RUN => Ok(()),

        // ── setting / inbox_state: plain client-owned local state ─────────
        (m, _) if m == models::SETTING || m == models::INBOX_STATE => Ok(()),

        // ── everything else (pr, pr_detail, grouping, project,
        // chat_message, thread, and any op on hunk_read / draft / finding /
        // task / skill_run not matched above) is core-owned ────────────────
        (m, op) => Err(format!(
            "{m} cannot be changed by a client transaction ({})",
            op_kind(op)
        )),
    }
}

fn op_kind(op: &MutationOp) -> &'static str {
    match op {
        MutationOp::Create { .. } => "create",
        MutationOp::Update { .. } => "update",
        MutationOp::Archive { .. } => "archive",
        MutationOp::Delete { .. } => "delete",
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

/// An anchor must stay inside the current diff. Shared by `draft` create
/// (the submitted anchor) and `draft` update (the anchor already on file —
/// an edit doesn't move it, but the diff may have since outrun it).
async fn check_anchor_commentable(core: &Core, pr: &PrId, anchor: &Anchor) -> Result<(), String> {
    let head = core.0.current_head.read().await.get(pr).cloned();
    let Some(head) = head else {
        return Err("draft: pr is not open".into());
    };
    let revisions = core.0.revisions.read().await;
    let Some(entry) = revisions.get(&(pr.clone(), head)) else {
        return Err("draft: revision not cached".into());
    };
    if theodore_domain::anchors::is_commentable(anchor, &entry.revision) {
        Ok(())
    } else {
        Err("draft: anchor is not inside the current diff".into())
    }
}

async fn validate_draft_create(core: &Core, data: &serde_json::Value) -> Result<(), String> {
    let draft: Draft =
        serde_json::from_value(data.clone()).map_err(|e| format!("bad draft: {e}"))?;
    check_anchor_commentable(core, &draft.pr, &draft.anchor).await
}

async fn validate_draft_update(core: &Core, id: &str) -> Result<(), String> {
    let store = core.0.deps.store.clone();
    let id_owned = id.to_string();
    let row = tokio::task::spawn_blocking(move || store.get(models::DRAFT, &id_owned))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let Some(row) = row else {
        return Err("draft: not found".into());
    };
    let draft: Draft =
        serde_json::from_value(row.data).map_err(|e| format!("bad draft row: {e}"))?;
    check_anchor_commentable(core, &draft.pr, &draft.anchor).await
}

fn validate_finding_state(data: &serde_json::Value) -> Result<(), String> {
    let Some(obj) = data.as_object() else {
        return Err("finding update: expected an object".into());
    };
    if obj.keys().any(|k| k != "state") {
        return Err("finding: only `state` can be changed by a client transaction".into());
    }
    let Some(state_val) = obj.get("state") else {
        return Err("finding update: missing `state`".into());
    };
    serde_json::from_value::<FindingState>(state_val.clone())
        .map(|_| ())
        .map_err(|e| format!("bad finding state: {e}"))
}

fn validate_task_create(data: &serde_json::Value) -> Result<(), String> {
    let task: Task = serde_json::from_value(data.clone()).map_err(|e| format!("bad task: {e}"))?;
    if task.status != TaskStatus::Todo {
        return Err("task: a new task must start in todo".into());
    }
    if task.fix.is_some() {
        return Err("task: a new task cannot already carry a fix".into());
    }
    Ok(())
}

const TASK_UPDATE_FIELDS: &[&str] = &["status", "assignee"];

async fn validate_task_update(
    core: &Core,
    id: &str,
    data: &serde_json::Value,
) -> Result<(), String> {
    let Some(obj) = data.as_object() else {
        return Err("task update: expected an object".into());
    };
    if let Some(bad) = obj
        .keys()
        .find(|k| !TASK_UPDATE_FIELDS.contains(&k.as_str()))
    {
        return Err(format!(
            "task: field '{bad}' cannot be changed by a client transaction"
        ));
    }
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
