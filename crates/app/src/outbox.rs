//! Outbox worker (plan §6.7): resumable host writes. One item at a time,
//! retried with backoff that depends on the error kind.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use theodore_contract::{Ephemeral, ToastLevel, models};
use theodore_domain::{
    Anchor, Comment, CommentId, Person, PrId, PrRef, ReviewEvent, Sha, ThreadId, ViewedState,
};
use theodore_ports::{
    Fetched, HostError, NewAction, OutboxItem, ReviewComment, ReviewSubmission, SubmittedReview,
    SyncActionCode,
};

use crate::core::{Core, Inner};
use crate::wire::ThreadRow;

const POLL_IDLE_MS: u64 = 50;
const BASE_BACKOFF_MS: i64 = 2_000;
const MAX_BACKOFF_MS: i64 = 5 * 60_000;
const AUTH_RETRY_MS: i64 = 30_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetViewedPayload {
    pub pr: PrId,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DraftComment {
    pub draft_id: String,
    pub marker: String,
    pub anchor: Anchor,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmitReviewPayload {
    pub pr: PrId,
    pub head: Sha,
    pub event: ReviewEvent,
    pub body: String,
    pub comments: Vec<DraftComment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplyPayload {
    pub pr: PrId,
    pub thread: ThreadId,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvePayload {
    pub pr: PrId,
    pub thread: ThreadId,
    pub resolved: bool,
}

enum Outcome {
    RetryAt(i64),
    AuthPaused(i64),
    Fail(String),
}

pub(crate) async fn run(inner: Arc<Inner>) {
    let core = Core(inner.clone());
    loop {
        if inner.shutdown.is_cancelled() {
            return;
        }
        let now = inner.deps.clock.now();
        let store = inner.deps.store.clone();
        let item = tokio::task::spawn_blocking(move || store.outbox_take(now))
            .await
            .ok()
            .and_then(|r| r.ok())
            .flatten();

        match item {
            Some(item) => process_item(&core, item).await,
            None => {
                // `not_before` is measured on the injected `Clock` (so tests
                // control backoff deterministically), but this idle tick is
                // real wall time: a fake clock only moves on an explicit
                // `advance()`, and tying the tick to it too would mean a
                // tick armed before that call can wait on a target that's
                // already unreachable once the jump lands.
                tokio::select! {
                    _ = inner.shutdown.cancelled() => return,
                    _ = inner.outbox_notify.notified() => {},
                    _ = tokio::time::sleep(Duration::from_millis(POLL_IDLE_MS)) => {},
                }
            }
        }
    }
}

async fn process_item(core: &Core, item: OutboxItem) {
    let result = match item.op.as_str() {
        "set_viewed" => do_set_viewed(core, &item).await,
        "submit_review" => do_submit_review(core, &item).await,
        "reply_thread" => do_reply_thread(core, &item).await,
        "resolve_thread" => do_resolve_thread(core, &item).await,
        other => Err(Outcome::Fail(format!("unknown outbox op {other}"))),
    };
    let store = core.0.deps.store.clone();
    match result {
        Ok(()) => {
            let id = item.id;
            let _ = tokio::task::spawn_blocking(move || store.outbox_done(id)).await;
        }
        Err(Outcome::RetryAt(not_before)) => {
            let id = item.id;
            let _ = tokio::task::spawn_blocking(move || store.outbox_retry(id, not_before)).await;
        }
        Err(Outcome::AuthPaused(not_before)) => {
            let id = item.id;
            let _ = tokio::task::spawn_blocking(move || store.outbox_retry(id, not_before)).await;
            core.emit(Ephemeral::HostStatus {
                online: true,
                rate_limited_until: None,
                auth_ok: false,
            });
        }
        Err(Outcome::Fail(message)) => {
            let id = item.id;
            let _ = tokio::task::spawn_blocking(move || store.outbox_fail(id)).await;
            core.emit(Ephemeral::Toast {
                level: ToastLevel::Error,
                text: message,
            });
        }
    }
}

fn backoff_ms(attempts: u32) -> i64 {
    let scale = 1i64 << attempts.min(10);
    (BASE_BACKOFF_MS.saturating_mul(scale)).min(MAX_BACKOFF_MS)
}

async fn classify_host_error(core: &Core, item: &OutboxItem, err: HostError) -> Outcome {
    match err {
        HostError::RateLimited { reset_at } => Outcome::RetryAt(reset_at),
        HostError::Network(_) | HostError::Protocol(_) => {
            let now = core.0.deps.clock.now();
            Outcome::RetryAt(now + backoff_ms(item.attempts))
        }
        HostError::Auth => {
            let now = core.0.deps.clock.now();
            Outcome::AuthPaused(now + AUTH_RETRY_MS)
        }
        HostError::Validation(msg) | HostError::Conflict(msg) | HostError::NotFound(msg) => {
            Outcome::Fail(msg)
        }
        HostError::Unsupported(msg) => Outcome::Fail(msg.to_string()),
    }
}

async fn do_set_viewed(core: &Core, item: &OutboxItem) -> Result<(), Outcome> {
    let payload: SetViewedPayload =
        serde_json::from_value(item.payload.clone()).map_err(|e| Outcome::Fail(e.to_string()))?;
    let pr_ref = core
        .pr_ref(&payload.pr)
        .await
        .ok_or_else(|| Outcome::Fail("pr not found".into()))?;
    match core
        .0
        .deps
        .host
        .set_viewed(&pr_ref, &payload.path, true)
        .await
    {
        Ok(()) => Ok(()),
        Err(e) => {
            let outcome = classify_host_error(core, item, e).await;
            if matches!(outcome, Outcome::Fail(_)) {
                compensate_set_viewed(core, &payload).await;
            }
            Err(outcome)
        }
    }
}

async fn compensate_set_viewed(core: &Core, payload: &SetViewedPayload) {
    let row_id = format!("{}:{}", payload.pr.0, payload.path);
    let data = serde_json::to_value(theodore_contract::FileViewedRow {
        pr: payload.pr.clone(),
        path: payload.path.clone(),
        state: ViewedState::Unviewed,
    })
    .expect("serializable");
    let action = NewAction {
        model: models::FILE_VIEWED.into(),
        model_id: row_id,
        action: SyncActionCode::U,
        data: Some(data),
    };
    let _ = core.apply(vec![action]).await;
}

async fn do_submit_review(core: &Core, item: &OutboxItem) -> Result<(), Outcome> {
    let payload: SubmitReviewPayload =
        serde_json::from_value(item.payload.clone()).map_err(|e| Outcome::Fail(e.to_string()))?;
    let pr_ref = core
        .pr_ref(&payload.pr)
        .await
        .ok_or_else(|| Outcome::Fail("pr not found".into()))?;

    // After a timeout, a comment may already have been posted: look it up
    // by its marker before posting it again (plan §6.7).
    let mut comments = Vec::with_capacity(payload.comments.len());
    for c in &payload.comments {
        if item.attempts > 0 {
            match core.0.deps.host.find_marker(&pr_ref, &c.marker).await {
                Ok(Some(_)) => continue,
                Ok(None) => {}
                Err(e) => return Err(classify_host_error(core, item, e).await),
            }
        }
        comments.push(ReviewComment {
            anchor: c.anchor.clone(),
            body: c.body.clone(),
            marker: c.marker.clone(),
        });
    }

    let submission = ReviewSubmission {
        event: payload.event,
        body: payload.body.clone(),
        comments,
        commit: payload.head.clone(),
    };
    match core.0.deps.host.submit_review(&pr_ref, &submission).await {
        Ok(submitted) => {
            apply_submitted_review(core, &payload, &submitted).await;
            Ok(())
        }
        Err(e) => Err(classify_host_error(core, item, e).await),
    }
}

async fn do_reply_thread(core: &Core, item: &OutboxItem) -> Result<(), Outcome> {
    let payload: ReplyPayload =
        serde_json::from_value(item.payload.clone()).map_err(|e| Outcome::Fail(e.to_string()))?;
    let pr_ref = core
        .pr_ref(&payload.pr)
        .await
        .ok_or_else(|| Outcome::Fail("pr not found".into()))?;
    match core
        .0
        .deps
        .host
        .reply(&pr_ref, &payload.thread, &payload.body)
        .await
    {
        Ok(_) => {
            refresh_pr_detail(core, &payload.pr, &pr_ref).await;
            Ok(())
        }
        Err(e) => Err(classify_host_error(core, item, e).await),
    }
}

async fn do_resolve_thread(core: &Core, item: &OutboxItem) -> Result<(), Outcome> {
    let payload: ResolvePayload =
        serde_json::from_value(item.payload.clone()).map_err(|e| Outcome::Fail(e.to_string()))?;
    let pr_ref = core
        .pr_ref(&payload.pr)
        .await
        .ok_or_else(|| Outcome::Fail("pr not found".into()))?;
    match core
        .0
        .deps
        .host
        .resolve(&pr_ref, &payload.thread, payload.resolved)
        .await
    {
        Ok(()) => {
            refresh_pr_detail(core, &payload.pr, &pr_ref).await;
            Ok(())
        }
        Err(e) => Err(classify_host_error(core, item, e).await),
    }
}

/// Re-fetches `pr_detail` so a thread write (reply, resolve) is reflected
/// without waiting for the next poll tick.
async fn refresh_pr_detail(core: &Core, pr: &PrId, pr_ref: &PrRef) {
    let etag = core.0.etags.read().await.get(pr).cloned();
    let Ok(Fetched::Modified { etag, value }) =
        core.0.deps.host.get_pr(pr_ref, etag.as_deref()).await
    else {
        return;
    };
    if let Some(etag) = etag {
        core.0.etags.write().await.insert(pr.clone(), etag);
    }
    let pr_s = pr.0.clone();
    let Ok(detail_data) = serde_json::to_value(&value) else {
        return;
    };
    let Ok(summary_data) = serde_json::to_value(&value.summary) else {
        return;
    };
    let actions = vec![
        NewAction {
            model: models::PR_DETAIL.into(),
            model_id: pr_s.clone(),
            action: SyncActionCode::U,
            data: Some(detail_data),
        },
        NewAction {
            model: models::PR.into(),
            model_id: pr_s,
            action: SyncActionCode::U,
            data: Some(summary_data),
        },
    ];
    let _ = core.apply(actions).await;
}

async fn apply_submitted_review(
    core: &Core,
    payload: &SubmitReviewPayload,
    submitted: &SubmittedReview,
) {
    let mut actions = Vec::new();
    for (marker, thread_id) in &submitted.threads {
        let Some(c) = payload.comments.iter().find(|c| &c.marker == marker) else {
            continue;
        };
        actions.push(NewAction {
            model: models::DRAFT.into(),
            model_id: c.draft_id.clone(),
            action: SyncActionCode::A,
            data: None,
        });
        let row = ThreadRow {
            pr: payload.pr.clone(),
            thread: theodore_domain::Thread {
                id: thread_id.clone(),
                anchor: Some(c.anchor.clone()),
                resolved: false,
                outdated: false,
                comments: vec![Comment {
                    id: CommentId::new(marker.clone()),
                    author: Person {
                        login: "me".into(),
                        name: None,
                        avatar_url: None,
                    },
                    body: c.body.clone(),
                    created_at: core.0.deps.clock.now(),
                    edited: false,
                }],
            },
        };
        let data = serde_json::to_value(&row).expect("serializable");
        actions.push(NewAction {
            model: models::THREAD.into(),
            model_id: thread_id.0.clone(),
            action: SyncActionCode::I,
            data: Some(data),
        });
    }
    let _ = core.apply(actions).await;
}
