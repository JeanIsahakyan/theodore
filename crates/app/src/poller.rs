//! Poller (plan §6.6): ETag polling of open PRs, cursor polling of the
//! inbox. A new head runs the push pipeline: diff, classify, clear reads of
//! changed hunks, dismiss their files, regroup, wake `NextPush` snoozes.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use theodore_contract::{Ephemeral, HunkRead, InboxState, ToastLevel, models};
use theodore_domain::anchors::Remapped;
use theodore_domain::snooze::PrEvent;
use theodore_domain::{
    AgentId, Anchor, Grouping, HunkId, PrDetail, PrId, PrRef, Revision, Sha, ViewedState,
};
use theodore_ports::{DiffOptions, NewAction, SyncActionCode};

use crate::core::{Core, Inner, RevisionEntry};

const OPEN_PR_POLL_MS: i64 = 15_000;
const INBOX_ERROR_RETRY_MS: i64 = 30_000;
const DEFAULT_INBOX_POLL_MS: i64 = 15_000;
/// Real-time tick for noticing a `Clock`-measured deadline is due. Kept
/// short and wall-clock-based (not through `Clock`) so a test's single
/// `advance()` jump is never missed while this task is busy elsewhere —
/// unlike a freshly armed `Clock::sleep`, a recurring real timer doesn't
/// need to be re-armed exactly before the jump lands.
const REAL_TICK_MS: u64 = 20;

pub(crate) async fn run(inner: Arc<Inner>) {
    tokio::join!(poll_open_prs(inner.clone()), poll_inbox(inner));
}

async fn poll_open_prs(inner: Arc<Inner>) {
    let core = Core(inner.clone());
    let mut next_due = inner.deps.clock.now();
    loop {
        if inner.shutdown.is_cancelled() {
            return;
        }
        if inner.deps.clock.now() >= next_due {
            let prs: Vec<PrId> = { inner.current_head.read().await.keys().cloned().collect() };
            for pr in prs {
                poll_one_pr(&core, &pr).await;
            }
            next_due = inner.deps.clock.now() + OPEN_PR_POLL_MS;
        }
        tokio::select! {
            _ = inner.shutdown.cancelled() => return,
            _ = tokio::time::sleep(Duration::from_millis(REAL_TICK_MS)) => {},
        }
    }
}

async fn poll_one_pr(core: &Core, pr: &PrId) {
    let Some(pr_ref) = core.pr_ref(pr).await else {
        return;
    };
    // `refresh_pr` applies `pr`/`pr_detail` whenever the host reports a
    // change, head moved or not — comments, threads, checks and labels can
    // all change between pushes, and must not be dropped just because this
    // tick isn't a push.
    let Some(value) = core.refresh_pr(pr, &pr_ref).await else {
        return;
    };
    let new_head = value.summary.head_sha.clone();
    let old_head = core.0.current_head.read().await.get(pr).cloned();
    if old_head.as_ref() == Some(&new_head) {
        return;
    }
    handle_push(core, pr, &pr_ref, old_head, new_head, value).await;
}

async fn handle_push(
    core: &Core,
    pr: &PrId,
    pr_ref: &PrRef,
    old_head: Option<Sha>,
    new_head: Sha,
    detail: PrDetail,
) {
    let repo_path = {
        let revisions = core.0.revisions.read().await;
        old_head.as_ref().and_then(|h| {
            revisions
                .get(&(pr.clone(), h.clone()))
                .map(|e| e.repo_path.clone())
        })
    };
    let repo_path = match repo_path {
        Some(p) => p,
        None => {
            let fallback = if pr_ref.repo.host == theodore_domain::HostKind::Local {
                core.ensure_local_project_cache(&pr_ref.repo).await
            } else {
                core.0.deps.git.ensure_repo(&pr_ref.repo).await
            };
            match fallback {
                Ok(p) => p,
                Err(_) => return,
            }
        }
    };
    // The new head isn't in the local clone yet: fetch it before checking
    // it out (a local branch review has no host to fetch from).
    if pr_ref.repo.host != theodore_domain::HostKind::Local {
        let _ = core.0.deps.git.fetch_pr(pr_ref).await;
    }
    let worktree = match core.0.deps.git.worktree(pr_ref, &new_head).await {
        Ok(w) => w,
        Err(_) => return,
    };
    core.load_repo_settings(&worktree.path, &pr_ref.repo).await;
    let new_rev = match core
        .0
        .deps
        .git
        .diff(
            &repo_path,
            &detail.base_sha,
            &new_head,
            &DiffOptions::default(),
        )
        .await
    {
        Ok(r) => r,
        Err(_) => return,
    };

    let old_rev = {
        let revisions = core.0.revisions.read().await;
        old_head.as_ref().and_then(|h| {
            revisions
                .get(&(pr.clone(), h.clone()))
                .map(|e| e.revision.clone())
        })
    };

    if let Some(old_rev) = &old_rev {
        let classes = theodore_domain::interdiff::classify(old_rev, &new_rev);
        // Reads are recorded against the *old* hunk id; only a `Changed`
        // hunk has one (a `New` hunk never had a prior read to clear).
        let mut changed_new_ids: BTreeSet<HunkId> = BTreeSet::new();
        let mut stale_old_ids: BTreeSet<HunkId> = BTreeSet::new();
        for (new_id, change) in &classes {
            match change {
                theodore_domain::interdiff::HunkChange::Unchanged => {}
                theodore_domain::interdiff::HunkChange::New => {
                    changed_new_ids.insert(new_id.clone());
                }
                theodore_domain::interdiff::HunkChange::Changed { previous } => {
                    changed_new_ids.insert(new_id.clone());
                    stale_old_ids.insert(previous.clone());
                }
            }
        }
        // `classify` only classifies *new*-side hunks, so an old hunk with
        // no counterpart at all in the new revision — the push dropped it
        // outright, with nothing landing to match it against — never shows
        // up as anyone's `previous` and would otherwise keep its stale
        // `hunk_read` forever. Catch those directly: any old hunk id gone
        // from the new revision, whether or not `classify` ever saw it.
        let new_ids: BTreeSet<&HunkId> = new_rev.hunks().map(|h| &h.id).collect();
        let mut vanished_paths: BTreeSet<&str> = BTreeSet::new();
        for h in old_rev.hunks() {
            if !new_ids.contains(&h.id) {
                stale_old_ids.insert(h.id.clone());
                vanished_paths.insert(h.path.as_str());
            }
        }
        clear_reads(core, pr, &stale_old_ids).await;
        dismiss_files(core, pr, &new_rev, &changed_new_ids, &vanished_paths).await;
    }

    if let Some(old_head) = &old_head {
        remap_anchors_after_push(core, pr, &repo_path, old_head, &new_head).await;
    }

    regroup_after_push(core, pr, &new_rev, &detail, &worktree.path).await;
    wake_next_push(core, pr).await;

    {
        core.0
            .current_head
            .write()
            .await
            .insert(pr.clone(), new_head.clone());
    }
    {
        core.0.revisions.write().await.insert(
            (pr.clone(), new_head.clone()),
            Arc::new(RevisionEntry {
                revision: Arc::new(new_rev),
                repo_path,
                worktree_path: worktree.path,
                pr_ref: pr_ref.clone(),
            }),
        );
    }

    // `pr`/`pr_detail` were already written by `poll_one_pr`'s `refresh_pr`
    // call, from this same fetch — nothing left to apply here.

    core.emit(Ephemeral::Toast {
        level: ToastLevel::Info,
        text: format!("{} pushed {new_head}", pr_ref.repo.slug()),
    });
}

/// Moves (or outdates) every open `draft`/`finding`/`task` anchor of `pr`
/// across the push (plan §4): diffs `old_head..new_head` and runs
/// `domain::anchors::remap` over each anchor still on file. A draft whose
/// anchor comes back `Outdated` is marked so (never anchor-less: an
/// outdated draft is still shown, just not submittable — `submit_review`
/// skips it).
async fn remap_anchors_after_push(
    core: &Core,
    pr: &PrId,
    repo_path: &Path,
    old_head: &Sha,
    new_head: &Sha,
) {
    let between = match core
        .0
        .deps
        .git
        .diff(repo_path, old_head, new_head, &DiffOptions::default())
        .await
    {
        Ok(r) => r,
        Err(_) => return,
    };
    for model in [models::DRAFT, models::FINDING, models::TASK] {
        remap_model_anchors(core, pr, model, &between, new_head).await;
    }
}

async fn remap_model_anchors(
    core: &Core,
    pr: &PrId,
    model: &str,
    between: &Revision,
    new_head: &Sha,
) {
    let store = core.0.deps.store.clone();
    let pr_s = pr.0.clone();
    let model_owned = model.to_string();
    let rows =
        match tokio::task::spawn_blocking(move || store.query(&model_owned, "pr", &pr_s)).await {
            Ok(Ok(r)) => r,
            _ => return,
        };
    let mut actions = Vec::new();
    for row in rows {
        if row
            .data
            .get("outdated")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            continue; // already outdated; nothing more to remap
        }
        let Some(anchor_val) = row.data.get("anchor").filter(|v| !v.is_null()) else {
            continue; // task with no anchor
        };
        let Ok(anchor) = serde_json::from_value::<Anchor>(anchor_val.clone()) else {
            continue;
        };
        match theodore_domain::anchors::remap(&anchor, between, new_head) {
            Remapped::Moved(new_anchor) if new_anchor != anchor => {
                actions.push(NewAction {
                    model: model.into(),
                    model_id: row.id,
                    action: SyncActionCode::C,
                    data: Some(serde_json::json!({ "anchor": new_anchor })),
                });
            }
            Remapped::Moved(_) => {}
            Remapped::Outdated => {
                actions.push(NewAction {
                    model: model.into(),
                    model_id: row.id,
                    action: SyncActionCode::C,
                    data: Some(serde_json::json!({ "outdated": true })),
                });
            }
        }
    }
    let _ = core.apply(actions).await;
}

async fn clear_reads(core: &Core, pr: &PrId, changed: &BTreeSet<HunkId>) {
    if changed.is_empty() {
        return;
    }
    let store = core.0.deps.store.clone();
    let pr_s = pr.0.clone();
    let rows = match tokio::task::spawn_blocking(move || {
        store.query(models::HUNK_READ, "pr", &pr_s)
    })
    .await
    {
        Ok(Ok(r)) => r,
        _ => return,
    };
    let mut actions = Vec::new();
    for row in rows {
        if let Ok(hr) = serde_json::from_value::<HunkRead>(row.data.clone())
            && changed.contains(&hr.hunk)
        {
            actions.push(NewAction {
                model: models::HUNK_READ.into(),
                model_id: row.id,
                action: SyncActionCode::D,
                data: None,
            });
        }
    }
    let _ = core.apply(actions).await;
}

async fn dismiss_files(
    core: &Core,
    pr: &PrId,
    new_rev: &Revision,
    changed: &BTreeSet<HunkId>,
    extra_changed_paths: &BTreeSet<&str>,
) {
    let mut changed_paths: BTreeSet<&str> = new_rev
        .files
        .iter()
        .filter(|f| f.hunks.iter().any(|h| changed.contains(&h.id)))
        .map(|f| f.path.as_str())
        .collect();
    changed_paths.extend(extra_changed_paths.iter().copied());
    if changed_paths.is_empty() {
        return;
    }
    let store = core.0.deps.store.clone();
    let pr_s = pr.0.clone();
    let rows =
        match tokio::task::spawn_blocking(move || store.query(models::FILE_VIEWED, "pr", &pr_s))
            .await
        {
            Ok(Ok(r)) => r,
            _ => return,
        };
    let mut actions = Vec::new();
    for row in rows {
        if let Ok(fv) = serde_json::from_value::<theodore_contract::FileViewedRow>(row.data.clone())
            && changed_paths.contains(fv.path.as_str())
            && fv.state == ViewedState::Viewed
        {
            let data = serde_json::to_value(theodore_contract::FileViewedRow {
                pr: pr.clone(),
                path: fv.path.clone(),
                state: ViewedState::Dismissed,
            })
            .expect("serializable");
            actions.push(NewAction {
                model: models::FILE_VIEWED.into(),
                model_id: row.id,
                action: SyncActionCode::U,
                data: Some(data),
            });
        }
    }
    let _ = core.apply(actions).await;
}

async fn regroup_after_push(
    core: &Core,
    pr: &PrId,
    new_rev: &Revision,
    detail: &PrDetail,
    worktree: &Path,
) {
    let store = core.0.deps.store.clone();
    let pr_s = pr.0.clone();
    let prev_row = tokio::task::spawn_blocking(move || store.get(models::GROUPING, &pr_s))
        .await
        .ok()
        .and_then(|r| r.ok())
        .flatten();
    let prev: Option<Grouping> = prev_row.and_then(|r| serde_json::from_value(r.data).ok());
    let repo_scope = detail.summary.pr.repo.slug();
    let agent = core
        .setting_agent_scoped("agents.grouping", Some(&repo_scope), AgentId::Claude)
        .await;
    let result = match &prev {
        Some(p) => {
            core.0
                .deps
                .grouper
                .regroup(p, new_rev, detail, worktree, agent)
                .await
        }
        None => {
            core.0
                .deps
                .grouper
                .group(new_rev, detail, worktree, agent)
                .await
        }
    };
    if let Ok(grouping) = result {
        let data = serde_json::to_value(&grouping).expect("serializable");
        let action = NewAction {
            model: models::GROUPING.into(),
            model_id: pr.0.clone(),
            action: SyncActionCode::U,
            data: Some(data),
        };
        let _ = core.apply(vec![action]).await;
    } else {
        core.emit(Ephemeral::Toast {
            level: ToastLevel::Warn,
            text: "regrouping after push failed".into(),
        });
    }
}

async fn wake_next_push(core: &Core, pr: &PrId) {
    let store = core.0.deps.store.clone();
    let pr_s = pr.0.clone();
    let row = tokio::task::spawn_blocking(move || store.get(models::INBOX_STATE, &pr_s))
        .await
        .ok()
        .and_then(|r| r.ok())
        .flatten();
    let Some(row) = row else { return };
    let Ok(state) = serde_json::from_value::<InboxState>(row.data.clone()) else {
        return;
    };
    let Some(snooze) = &state.snooze else { return };
    if theodore_domain::snooze::wakes(snooze, &PrEvent::Pushed) {
        let data = serde_json::to_value(InboxState {
            pr: pr.clone(),
            done: state.done,
            snooze: None,
        })
        .expect("serializable");
        let action = NewAction {
            model: models::INBOX_STATE.into(),
            model_id: pr.0.clone(),
            action: SyncActionCode::U,
            data: Some(data),
        };
        let _ = core.apply(vec![action]).await;
    }
}

async fn poll_inbox(inner: Arc<Inner>) {
    let core = Core(inner.clone());
    let store = inner.deps.store.clone();
    let mut cursor: Option<String> =
        tokio::task::spawn_blocking(move || store.kv_get("inbox:cursor"))
            .await
            .ok()
            .and_then(|r| r.ok())
            .flatten()
            .and_then(|v| v.as_str().map(str::to_string));
    let mut next_due = inner.deps.clock.now();

    loop {
        if inner.shutdown.is_cancelled() {
            return;
        }
        if inner.deps.clock.now() >= next_due {
            let result = inner.deps.host.changed_since(cursor.as_deref()).await;
            core.note_host(&result);
            match result {
                Ok(changes) => {
                    cursor = Some(changes.cursor.clone());
                    let store = inner.deps.store.clone();
                    let value = serde_json::json!(changes.cursor);
                    let _ =
                        tokio::task::spawn_blocking(move || store.kv_set("inbox:cursor", &value))
                            .await;
                    if !changes.prs.is_empty() {
                        core.emit(Ephemeral::Toast {
                            level: ToastLevel::Info,
                            text: match changes.prs.len() {
                                1 => "1 PR updated".to_string(),
                                n => format!("{n} PRs updated"),
                            },
                        });
                        let _ = core.refresh_inbox().await;
                    }
                    let wait = changes
                        .poll_after_ms
                        .unwrap_or(DEFAULT_INBOX_POLL_MS)
                        .max(1_000);
                    next_due = inner.deps.clock.now() + wait;
                }
                Err(_) => {
                    next_due = inner.deps.clock.now() + INBOX_ERROR_RETRY_MS;
                }
            }
        }
        tokio::select! {
            _ = inner.shutdown.cancelled() => return,
            _ = tokio::time::sleep(Duration::from_millis(REAL_TICK_MS)) => {},
        }
    }
}
