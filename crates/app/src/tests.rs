//! Integration-style tests against `Core` + `testkit` fakes, per the
//! coverage list in the agent brief for this slice.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use theodore_contract::{
    AddProjectRequest, BootstrapScope, CommitSuggestionsRequest, DelegateRequest,
    DraftStateRequest, EditCommentRequest, Ephemeral, FileViewedRow, HostAuthStatus, HunkRead,
    InboxState, MergeMethod as WireMergeMethod, MergeRequest, MutationOp, OpenBranchRequest,
    OpenPrRequest, ProjectStatus, ReactRequest, ReplyRequest, RerunCheckRequest, ResolveRequest,
    ReviewersRequest, RevisionRequest, RunSkillRequest, SaveSkillRequest, SetTokenRequest, Setting,
    SubmitReviewRequest, TaskDecision, ToastLevel, TokenSource, Transaction, TransactionResult,
    TriageAction, TriageRequest, models,
};
use theodore_domain::{
    AgentId, Anchor, Assignee, Check, CheckStatus, Comment, CommentId, FileDiff, FileStatus, Fix,
    FixStatus, HostKind, HunkId, Patch, PrId, PrRef, RepoRef, ReviewEvent, Revision, Sha, Side,
    Task, TaskId, TaskStatus, Thread, ThreadId, Usage, ViewedState,
};
use theodore_ports::{
    AgentEvent, BranchInfo, Clock, CommitLog, Fetched, HostError, MergeMethod as PortMergeMethod,
    MergeState, MergeStatus, NewAction, OutboxStatus, Secrets, Store, SyncActionCode,
};

use crate::testkit::{self, Fixtures, fixtures};
use crate::{AppError, Core, Receivers};

async fn wait_until(mut cond: impl FnMut() -> bool) {
    for _ in 0..400 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("condition not met in time");
}

/// Waits for an `Ephemeral` matching `pred`, skipping any that don't.
async fn expect_ephemeral(
    recv: &mut Receivers,
    mut pred: impl FnMut(&Ephemeral) -> bool,
) -> Ephemeral {
    for _ in 0..200 {
        match tokio::time::timeout(Duration::from_millis(50), recv.ephemeral.recv()).await {
            Ok(Ok(event)) if pred(&event) => return event,
            _ => continue,
        }
    }
    panic!("expected ephemeral event not observed in time");
}

fn fixture_pr_ref() -> PrRef {
    PrRef {
        repo: RepoRef {
            host: HostKind::Github,
            owner: "acme".into(),
            name: "widgets".into(),
        },
        number: 7,
        host_id: Some("node-7".into()),
    }
}

/// Opens the fixture PR and returns everything a test typically needs.
async fn open_fixture_pr(f: &Fixtures) -> (Core, Receivers, PrId, Sha) {
    let pr_ref = fixture_pr_ref();
    let head = Sha::new("head111");
    let base = Sha::new("base000");
    let detail = testkit::sample_pr_detail(&pr_ref, &base, &head);
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("etag-1".into()),
        value: detail,
    }));

    let (core, recv) = Core::start(f.deps());
    let resp = core
        .open_pr(OpenPrRequest {
            url: "https://github.com/acme/widgets/pull/7".into(),
        })
        .await
        .expect("open_pr");
    (core, recv, resp.pr, resp.head)
}

fn hunk_read_tx(id: &str, pr: &PrId, hunk: &HunkId) -> Transaction {
    Transaction {
        id: id.into(),
        ops: vec![MutationOp::Create {
            model: models::HUNK_READ.into(),
            id: format!("{}:{}", pr.0, hunk),
            data: serde_json::to_value(HunkRead {
                pr: pr.clone(),
                hunk: hunk.clone(),
            })
            .unwrap(),
        }],
    }
}

fn file_viewed_row(f: &Fixtures, pr: &PrId, path: &str) -> Option<FileViewedRow> {
    f.store
        .get(models::FILE_VIEWED, &format!("{}:{path}", pr.0))
        .ok()
        .flatten()
        .and_then(|r| serde_json::from_value(r.data).ok())
}

fn sample_task(
    id: &str,
    pr: &PrId,
    anchor: Option<theodore_domain::Anchor>,
    thread: Option<ThreadId>,
    now: i64,
) -> Task {
    Task {
        id: TaskId::new(id),
        pr: pr.clone(),
        title: "Fix the thing".into(),
        body: "Do the fix, please.".into(),
        anchor,
        thread,
        status: TaskStatus::Todo,
        assignee: Assignee::Human("author".into()),
        fix: None,
        created_at: now,
        outdated: false,
    }
}

fn put_task(f: &Fixtures, task: &Task) {
    f.store
        .apply(vec![NewAction {
            model: models::TASK.into(),
            model_id: task.id.0.clone(),
            action: SyncActionCode::I,
            data: Some(serde_json::to_value(task).unwrap()),
        }])
        .unwrap();
}

fn task_row(f: &Fixtures, id: &TaskId) -> Task {
    let row = f.store.get(models::TASK, &id.0).unwrap().unwrap();
    serde_json::from_value(row.data).unwrap()
}

fn worktree_dir(head: &Sha) -> PathBuf {
    PathBuf::from(format!("/tmp/theodore-fake-wt-{}", head.0))
}

/// `worktree_dir` is a fixed real path shared by every test using the
/// default fixture head — removes `path` (recursively) even if the test
/// panics, so a file one test plants there (e.g. `.review/config.yaml`)
/// never leaks into a test that runs after it in the same process.
struct RemoveOnDrop(PathBuf);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ── transact / sync frame / de-dup / rejection ──────────────────────────────

#[tokio::test]
async fn transact_produces_a_contiguous_sync_frame() {
    let f = fixtures();
    let (core, mut recv) = Core::start(f.deps());

    let tx = Transaction {
        id: "tx-1".into(),
        ops: vec![MutationOp::Create {
            model: models::SETTING.into(),
            id: "custom.key".into(),
            data: json!({"key": "custom.key", "scope": "user", "value": 1}),
        }],
    };
    let result = core.transact(tx).await;
    let TransactionResult::Ok { last_sync_id } = result else {
        panic!("expected Ok, got {result:?}")
    };
    assert!(last_sync_id >= 1);

    let frame = recv.sync.try_recv().expect("a sync frame was broadcast");
    assert_eq!(frame.last_sync_id, last_sync_id);
    assert_eq!(frame.actions.len(), 1);
    assert_eq!(frame.actions[0].model, models::SETTING);
}

#[tokio::test]
async fn transact_is_deduped_by_transaction_id() {
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());

    let tx = Transaction {
        id: "same-tx".into(),
        ops: vec![MutationOp::Create {
            model: models::SETTING.into(),
            id: "custom.key".into(),
            data: json!({"key": "custom.key", "scope": "user", "value": 1}),
        }],
    };
    let first = core.transact(tx.clone()).await;
    let second = core.transact(tx).await;
    assert_eq!(first, second);

    let frame = core.catch_up(0).await.expect("catch_up");
    assert_eq!(
        frame.actions.len(),
        1,
        "a retried transaction must not double-apply"
    );
}

#[tokio::test]
async fn transact_rejects_a_hunk_read_outside_the_current_revision() {
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());

    // No PR is open, so any hunk_read must be rejected.
    let tx = hunk_read_tx(
        "tx-reject",
        &PrId::new("github:acme/widgets#7"),
        &HunkId::new("deadbeef"),
    );
    let result = core.transact(tx).await;
    assert!(
        matches!(result, TransactionResult::Rejected { .. }),
        "expected Rejected, got {result:?}"
    );
}

fn single_op_tx(id: &str, op: MutationOp) -> Transaction {
    Transaction {
        id: id.into(),
        ops: vec![op],
    }
}

fn put_model_row(f: &Fixtures, model: &str, id: &str, data: serde_json::Value) {
    f.store
        .apply(vec![NewAction {
            model: model.into(),
            model_id: id.into(),
            action: SyncActionCode::I,
            data: Some(data),
        }])
        .unwrap();
}

#[tokio::test]
async fn transact_rejects_client_writes_to_core_owned_models() {
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());

    for model in [
        models::PR,
        models::PR_DETAIL,
        models::GROUPING,
        models::PROJECT,
        models::CHAT_MESSAGE,
    ] {
        let tx = single_op_tx(
            &format!("tx-core-owned-{model}"),
            MutationOp::Create {
                model: model.into(),
                id: "x".into(),
                data: json!({}),
            },
        );
        let result = core.transact(tx).await;
        assert!(
            matches!(result, TransactionResult::Rejected { .. }),
            "{model} create must be rejected, got {result:?}"
        );
    }
}

#[tokio::test]
async fn transact_allows_only_the_state_field_on_finding_updates() {
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());
    put_model_row(
        &f,
        models::FINDING,
        "f1",
        json!({
            "id": "f1", "pr": "github:acme/widgets#7", "skill": "s1",
            "agents": [], "anchor": {"path": "src/lib.rs", "side": "right", "line": 2},
            "severity": "warn", "title": "orig", "body": "orig",
            "state": "open", "fix": null,
        }),
    );

    let bad = core
        .transact(single_op_tx(
            "tx-finding-bad",
            MutationOp::Update {
                model: models::FINDING.into(),
                id: "f1".into(),
                data: json!({"title": "hacked"}),
            },
        ))
        .await;
    assert!(
        matches!(bad, TransactionResult::Rejected { .. }),
        "finding title must not be client-writable, got {bad:?}"
    );

    let good = core
        .transact(single_op_tx(
            "tx-finding-good",
            MutationOp::Update {
                model: models::FINDING.into(),
                id: "f1".into(),
                data: json!({"state": "ignored"}),
            },
        ))
        .await;
    assert!(
        matches!(good, TransactionResult::Ok { .. }),
        "finding state must stay client-writable, got {good:?}"
    );
}

#[tokio::test]
async fn transact_restricts_task_updates_to_status_and_assignee() {
    let f = fixtures();
    let (core, _recv, pr, _head) = open_fixture_pr(&f).await;
    let task = sample_task("t-allowlist", &pr, None, None, f.clock.now());
    put_task(&f, &task);

    let result = core
        .transact(single_op_tx(
            "tx-task-bad",
            MutationOp::Update {
                model: models::TASK.into(),
                id: task.id.0.clone(),
                data: json!({"title": "retitled"}),
            },
        ))
        .await;
    assert!(
        matches!(result, TransactionResult::Rejected { .. }),
        "task title must not be client-writable, got {result:?}"
    );
}

#[tokio::test]
async fn transact_rejects_a_new_task_that_does_not_start_in_todo() {
    let f = fixtures();
    let (core, _recv, pr, _head) = open_fixture_pr(&f).await;
    let mut task = sample_task("t-skip-todo", &pr, None, None, f.clock.now());
    task.status = TaskStatus::Done;

    let result = core
        .transact(single_op_tx(
            "tx-task-create-bad",
            MutationOp::Create {
                model: models::TASK.into(),
                id: task.id.0.clone(),
                data: serde_json::to_value(&task).unwrap(),
            },
        ))
        .await;
    assert!(
        matches!(result, TransactionResult::Rejected { .. }),
        "a client-created task must start in todo, got {result:?}"
    );
}

#[tokio::test]
async fn transact_allows_only_archiving_a_skill_run() {
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());
    put_model_row(
        &f,
        models::SKILL_RUN,
        "r1",
        json!({"id": "r1", "pr": "github:acme/widgets#7"}),
    );

    let update = core
        .transact(single_op_tx(
            "tx-skillrun-update",
            MutationOp::Update {
                model: models::SKILL_RUN.into(),
                id: "r1".into(),
                data: json!({"id": "r1"}),
            },
        ))
        .await;
    assert!(
        matches!(update, TransactionResult::Rejected { .. }),
        "skill_run must only be archivable by the client, got {update:?}"
    );

    let archive = core
        .transact(single_op_tx(
            "tx-skillrun-archive",
            MutationOp::Archive {
                model: models::SKILL_RUN.into(),
                id: "r1".into(),
            },
        ))
        .await;
    assert!(
        matches!(archive, TransactionResult::Ok { .. }),
        "archiving a skill_run must stay client-writable, got {archive:?}"
    );
}

#[tokio::test]
async fn transact_validates_draft_update_anchors_like_create() {
    let f = fixtures();
    let (core, _recv, pr, _head) = open_fixture_pr(&f).await;
    // Planted directly (bypassing the validated `create` path) to simulate a
    // draft whose anchor the diff has since outrun.
    put_model_row(
        &f,
        models::DRAFT,
        "d1",
        json!({
            "id": "d1", "pr": pr.0, "body": "orig",
            "anchor": {"path": "no/such/file.rs", "side": "right", "line": 1},
            "source": {"kind": "me"},
        }),
    );

    let result = core
        .transact(single_op_tx(
            "tx-draft-update-stale",
            MutationOp::Update {
                model: models::DRAFT.into(),
                id: "d1".into(),
                data: json!({"body": "edited"}),
            },
        ))
        .await;
    assert!(
        matches!(result, TransactionResult::Rejected { .. }),
        "a draft update must re-validate the anchor like create, got {result:?}"
    );
}

/// The UI's undo queue (`ui/src/sync/UndoQueue.ts`) never rolls back
/// locally: it resends the inverse of a committed op as a brand new
/// transaction (plan "sync" §UndoQueue doc comment) — same model and id,
/// same changed keys for an `update`, the old value in place of the new
/// one. The allowlist must accept that inverse exactly as readily as the
/// forward op, for every op shape `ui/src/actions.ts` actually sends.
#[tokio::test]
async fn transact_accepts_the_undo_inverse_of_every_client_op() {
    let f = fixtures();
    let (core, _recv, pr, _head) = open_fixture_pr(&f).await;

    // task: assignTask's `{assignee, status: "progress"}`, then undo's
    // `{assignee: <old>, status: "todo"}` — not a legal forward lifecycle
    // transition, but a legal undo.
    let mut task = sample_task("t-undo", &pr, None, None, f.clock.now());
    task.assignee = Assignee::Human("someone".into());
    put_task(&f, &task);

    let forward = core
        .transact(single_op_tx(
            "tx-assign-forward",
            MutationOp::Update {
                model: models::TASK.into(),
                id: task.id.0.clone(),
                data: json!({
                    "assignee": Assignee::Agent(AgentId::Claude),
                    "status": "progress",
                }),
            },
        ))
        .await;
    assert!(
        matches!(forward, TransactionResult::Ok { .. }),
        "assignTask's forward update must be accepted, got {forward:?}"
    );

    let inverse = core
        .transact(single_op_tx(
            "tx-assign-undo",
            MutationOp::Update {
                model: models::TASK.into(),
                id: task.id.0.clone(),
                data: json!({
                    "assignee": Assignee::Human("someone".to_string()),
                    "status": "todo",
                }),
            },
        ))
        .await;
    assert!(
        matches!(inverse, TransactionResult::Ok { .. }),
        "undoing assignTask must be accepted even though it isn't a forward transition, got {inverse:?}"
    );

    // inbox_state: markDone's `create`, then undo's `delete`.
    let create_inbox = core
        .transact(single_op_tx(
            "tx-inbox-create",
            MutationOp::Create {
                model: models::INBOX_STATE.into(),
                id: pr.0.clone(),
                data: json!({"pr": pr.0, "done": true, "snooze": null}),
            },
        ))
        .await;
    assert!(matches!(create_inbox, TransactionResult::Ok { .. }));
    let delete_inbox = core
        .transact(single_op_tx(
            "tx-inbox-undo",
            MutationOp::Delete {
                model: models::INBOX_STATE.into(),
                id: pr.0.clone(),
            },
        ))
        .await;
    assert!(
        matches!(delete_inbox, TransactionResult::Ok { .. }),
        "undoing markDone's create must be accepted, got {delete_inbox:?}"
    );

    // inbox_state: unsnooze's `update` with the old value restored.
    put_model_row(
        &f,
        models::INBOX_STATE,
        &pr.0,
        json!({"pr": pr.0, "done": false, "snooze": {"kind": "next_push"}}),
    );
    let snooze_forward = core
        .transact(single_op_tx(
            "tx-unsnooze-forward",
            MutationOp::Update {
                model: models::INBOX_STATE.into(),
                id: pr.0.clone(),
                data: json!({"snooze": null}),
            },
        ))
        .await;
    assert!(matches!(snooze_forward, TransactionResult::Ok { .. }));
    let snooze_undo = core
        .transact(single_op_tx(
            "tx-unsnooze-undo",
            MutationOp::Update {
                model: models::INBOX_STATE.into(),
                id: pr.0.clone(),
                data: json!({"snooze": {"kind": "next_push"}}),
            },
        ))
        .await;
    assert!(
        matches!(snooze_undo, TransactionResult::Ok { .. }),
        "undoing unsnooze must restore the old snooze value, got {snooze_undo:?}"
    );

    // draft: addDraft's `create`, then undo's `delete`.
    let anchor = testkit::sample_anchor("src/lib.rs", 2);
    let create_draft = core
        .transact(single_op_tx(
            "tx-draft-create",
            MutationOp::Create {
                model: models::DRAFT.into(),
                id: "d-undo".into(),
                data: json!({
                    "id": "d-undo", "pr": pr.0, "anchor": anchor, "body": "x",
                    "source": {"kind": "me"},
                }),
            },
        ))
        .await;
    assert!(matches!(create_draft, TransactionResult::Ok { .. }));
    let delete_draft = core
        .transact(single_op_tx(
            "tx-draft-create-undo",
            MutationOp::Delete {
                model: models::DRAFT.into(),
                id: "d-undo".into(),
            },
        ))
        .await;
    assert!(
        matches!(delete_draft, TransactionResult::Ok { .. }),
        "undoing addDraft's create must be accepted, got {delete_draft:?}"
    );

    // draft: editDraft's `update` body, then undo's `update` with the old body.
    put_model_row(
        &f,
        models::DRAFT,
        "d-edit",
        json!({
            "id": "d-edit", "pr": pr.0, "anchor": anchor, "body": "before",
            "source": {"kind": "me"}, "outdated": false,
        }),
    );
    let edit_forward = core
        .transact(single_op_tx(
            "tx-draft-edit-forward",
            MutationOp::Update {
                model: models::DRAFT.into(),
                id: "d-edit".into(),
                data: json!({"body": "after"}),
            },
        ))
        .await;
    assert!(matches!(edit_forward, TransactionResult::Ok { .. }));
    let edit_undo = core
        .transact(single_op_tx(
            "tx-draft-edit-undo",
            MutationOp::Update {
                model: models::DRAFT.into(),
                id: "d-edit".into(),
                data: json!({"body": "before"}),
            },
        ))
        .await;
    assert!(
        matches!(edit_undo, TransactionResult::Ok { .. }),
        "undoing editDraft must restore the old body, got {edit_undo:?}"
    );
}

#[tokio::test]
async fn catch_up_replays_the_requested_gap() {
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());

    for i in 0..3 {
        let tx = Transaction {
            id: format!("tx-{i}"),
            ops: vec![MutationOp::Create {
                model: models::SETTING.into(),
                id: format!("k{i}"),
                data: json!({"key": format!("k{i}"), "scope": "user", "value": i}),
            }],
        };
        core.transact(tx).await;
    }

    let frame = core.catch_up(0).await.expect("catch_up");
    assert_eq!(frame.from_sync_id, 0);
    assert_eq!(frame.actions.len(), 3);
    assert_eq!(frame.last_sync_id, frame.actions.last().unwrap().id);

    let mid = frame.actions[0].id;
    let tail = core.catch_up(mid).await.expect("catch_up");
    assert_eq!(tail.actions.len(), 2);
}

// ── open_pr ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn open_pr_happy_path_stores_rows_and_groups_in_background() {
    let f = fixtures();
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;
    assert_eq!(head, Sha::new("head111"));

    let bootstrap = core
        .bootstrap(BootstrapScope::Pr(pr.clone()))
        .await
        .expect("bootstrap");
    assert!(bootstrap.rows.iter().any(|r| r.model == models::PR_DETAIL));

    wait_until(|| {
        f.store
            .get(models::GROUPING, &pr.0)
            .ok()
            .flatten()
            .is_some()
    })
    .await;
}

// ── read -> viewed -> outbox ─────────────────────────────────────────────

#[tokio::test]
async fn reading_every_hunk_of_a_file_marks_it_viewed_and_enqueues_set_viewed() {
    let f = fixtures();
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;
    let revision = core
        .get_revision(RevisionRequest {
            pr: pr.clone(),
            head,
        })
        .await
        .unwrap();
    let hunks = testkit::hunk_ids(&revision);
    assert_eq!(hunks.len(), 2);

    let r1 = core.transact(hunk_read_tx("read-1", &pr, &hunks[0])).await;
    assert!(matches!(r1, TransactionResult::Ok { .. }));
    // Only one of two hunks read: not viewed yet, nothing queued.
    assert!(f.store.outbox_snapshot().is_empty());

    let r2 = core.transact(hunk_read_tx("read-2", &pr, &hunks[1])).await;
    assert!(matches!(r2, TransactionResult::Ok { .. }));

    wait_until(|| !f.store.outbox_snapshot().is_empty()).await;
    assert_eq!(f.store.outbox_snapshot()[0].op, "set_viewed");

    wait_until(|| {
        f.store
            .outbox_snapshot()
            .iter()
            .all(|i| i.status == OutboxStatus::Done)
    })
    .await;
    let fv = file_viewed_row(&f, &pr, "src/lib.rs").expect("file_viewed row");
    assert_eq!(fv.state, ViewedState::Viewed);
}

// ── outbox retry / backoff / auth pause / compensation ──────────────────

#[tokio::test]
async fn outbox_backs_off_on_network_errors_then_succeeds() {
    let f = fixtures();
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;
    let revision = core
        .get_revision(RevisionRequest {
            pr: pr.clone(),
            head,
        })
        .await
        .unwrap();
    let hunks = testkit::hunk_ids(&revision);

    f.host
        .push_set_viewed(Err(HostError::Network("timeout".into())));
    f.host.push_set_viewed(Ok(()));

    for (i, h) in hunks.iter().enumerate() {
        core.transact(hunk_read_tx(&format!("read-{i}"), &pr, h))
            .await;
    }

    wait_until(|| {
        f.store
            .outbox_snapshot()
            .first()
            .is_some_and(|i| i.attempts >= 1)
    })
    .await;
    assert_eq!(f.store.outbox_snapshot()[0].attempts, 1);
    assert_eq!(f.store.outbox_snapshot()[0].status, OutboxStatus::Pending);

    // Advance past the backoff window so the retry becomes due and succeeds.
    f.clock.advance(10_000);
    wait_until(|| f.store.outbox_snapshot()[0].status == OutboxStatus::Done).await;
}

#[tokio::test]
async fn outbox_pauses_on_auth_error_and_reports_host_status() {
    let f = fixtures();
    let (core, mut recv, pr, head) = open_fixture_pr(&f).await;
    let revision = core
        .get_revision(RevisionRequest {
            pr: pr.clone(),
            head,
        })
        .await
        .unwrap();
    let hunks = testkit::hunk_ids(&revision);

    f.host.push_set_viewed(Err(HostError::Auth));
    f.host.push_set_viewed(Ok(()));

    for (i, h) in hunks.iter().enumerate() {
        core.transact(hunk_read_tx(&format!("read-{i}"), &pr, h))
            .await;
    }

    let event = expect_ephemeral(&mut recv, |e| matches!(e, Ephemeral::HostStatus { .. })).await;
    assert!(matches!(
        event,
        Ephemeral::HostStatus { auth_ok: false, .. }
    ));

    f.clock.advance(60_000);
    wait_until(|| f.store.outbox_snapshot()[0].status == OutboxStatus::Done).await;
}

#[tokio::test]
async fn outbox_compensates_on_a_permanent_failure() {
    let f = fixtures();
    let (core, mut recv, pr, head) = open_fixture_pr(&f).await;
    let revision = core
        .get_revision(RevisionRequest {
            pr: pr.clone(),
            head,
        })
        .await
        .unwrap();
    let hunks = testkit::hunk_ids(&revision);

    f.host
        .push_set_viewed(Err(HostError::Validation("file too large".into())));

    for (i, h) in hunks.iter().enumerate() {
        core.transact(hunk_read_tx(&format!("read-{i}"), &pr, h))
            .await;
    }

    let event = expect_ephemeral(&mut recv, |e| {
        matches!(
            e,
            Ephemeral::Toast {
                level: ToastLevel::Error,
                ..
            }
        )
    })
    .await;
    assert!(matches!(
        event,
        Ephemeral::Toast {
            level: ToastLevel::Error,
            ..
        }
    ));

    wait_until(|| {
        f.store
            .outbox_snapshot()
            .first()
            .is_some_and(|i| i.status == OutboxStatus::Failed)
    })
    .await;
    let fv = file_viewed_row(&f, &pr, "src/lib.rs").expect("file_viewed row");
    assert_eq!(
        fv.state,
        ViewedState::Unviewed,
        "a permanent failure must revert the optimistic Viewed state"
    );
}

// ── push handling ─────────────────────────────────────────────────────────

#[tokio::test]
async fn a_push_clears_reads_of_changed_hunks_and_dismisses_their_file() {
    let f = fixtures();
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;
    let revision = core
        .get_revision(RevisionRequest {
            pr: pr.clone(),
            head: head.clone(),
        })
        .await
        .unwrap();
    let hunks = testkit::hunk_ids(&revision);

    for (i, h) in hunks.iter().enumerate() {
        core.transact(hunk_read_tx(&format!("read-{i}"), &pr, h))
            .await;
    }
    wait_until(|| file_viewed_row(&f, &pr, "src/lib.rs").is_some()).await;

    // The author pushes: hunk 1's content changes (new id), hunk 2 is untouched.
    let new_head = Sha::new("head222");
    let changed = testkit::make_hunk(
        "src/lib.rs",
        1,
        1,
        1,
        2,
        vec![
            testkit::line_ctx(1, 1, "a"),
            testkit::line_add(2, "b1-changed"),
        ],
    );
    let unchanged = revision.files[0].hunks[1].clone();
    let new_revision = Revision {
        base: revision.base.clone(),
        head: new_head.clone(),
        files: vec![FileDiff {
            hunks: vec![changed, unchanged],
            ..revision.files[0].clone()
        }],
    };
    f.git.set_head(new_head.clone());
    f.git.set_revision(new_revision);

    let detail = testkit::sample_pr_detail(&fixture_pr_ref(), &revision.base, &new_head);
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("etag-2".into()),
        value: detail,
    }));

    f.clock.advance(15_000);

    wait_until(|| {
        file_viewed_row(&f, &pr, "src/lib.rs")
            .map(|fv| fv.state == ViewedState::Dismissed)
            .unwrap_or(false)
    })
    .await;

    let remaining_reads = f.store.query(models::HUNK_READ, "pr", &pr.0).unwrap();
    assert_eq!(
        remaining_reads.len(),
        1,
        "only the unchanged hunk's read should survive the push"
    );
}

#[tokio::test]
async fn a_push_clears_reads_and_dismisses_a_file_whose_hunk_vanished_with_no_replacement() {
    let f = fixtures();
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;
    let revision = core
        .get_revision(RevisionRequest {
            pr: pr.clone(),
            head: head.clone(),
        })
        .await
        .unwrap();
    let hunks = testkit::hunk_ids(&revision);

    for (i, h) in hunks.iter().enumerate() {
        core.transact(hunk_read_tx(&format!("read-{i}"), &pr, h))
            .await;
    }
    wait_until(|| file_viewed_row(&f, &pr, "src/lib.rs").is_some()).await;

    // The author pushes: hunk 1 is reverted outright — dropped, with
    // nothing landing in its place — while hunk 2 survives untouched.
    // `interdiff::classify` only walks the *new* revision's hunks, so it
    // never sees hunk 1 at all; it must still be caught as vanished.
    let new_head = Sha::new("head222");
    let unchanged = revision.files[0].hunks[1].clone();
    let new_revision = Revision {
        base: revision.base.clone(),
        head: new_head.clone(),
        files: vec![FileDiff {
            hunks: vec![unchanged],
            ..revision.files[0].clone()
        }],
    };
    f.git.set_head(new_head.clone());
    f.git.set_revision(new_revision);

    let detail = testkit::sample_pr_detail(&fixture_pr_ref(), &revision.base, &new_head);
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("etag-vanish".into()),
        value: detail,
    }));

    f.clock.advance(15_000);

    wait_until(|| {
        file_viewed_row(&f, &pr, "src/lib.rs")
            .map(|fv| fv.state == ViewedState::Dismissed)
            .unwrap_or(false)
    })
    .await;

    let remaining_reads = f.store.query(models::HUNK_READ, "pr", &pr.0).unwrap();
    assert_eq!(
        remaining_reads.len(),
        1,
        "the vanished hunk's read must be cleared, the survivor's must not"
    );
    let remaining: HunkRead = serde_json::from_value(remaining_reads[0].data.clone()).unwrap();
    assert_eq!(
        remaining.hunk, hunks[1],
        "the surviving hunk's read must stay"
    );
}

#[tokio::test]
async fn poller_applies_pr_detail_updates_even_when_the_head_is_unchanged() {
    let f = fixtures();
    let (_core, _recv, pr, head) = open_fixture_pr(&f).await;

    // Same head — not a push — but the host reports a change: a label was
    // added. There's no new revision to diff, just an updated pr_detail
    // that must not be dropped just because the head didn't move.
    let mut detail = testkit::sample_pr_detail(&fixture_pr_ref(), &Sha::new("base000"), &head);
    detail.labels = vec!["needs-review".into()];
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("etag-labels".into()),
        value: detail,
    }));

    f.clock.advance(15_000);

    wait_until(|| {
        f.store
            .get(models::PR_DETAIL, &pr.0)
            .unwrap()
            .is_some_and(|r| r.data["labels"] == json!(["needs-review"]))
    })
    .await;
}

#[tokio::test]
async fn a_push_remaps_moved_anchors_and_marks_rewritten_ones_outdated() {
    let f = fixtures();
    let (_core, _recv, pr, head) = open_fixture_pr(&f).await;

    // Anchored well after the push's insertion point: must only shift.
    let moving_anchor = Anchor {
        rev: head.clone(),
        path: "src/lib.rs".into(),
        side: Side::New,
        line: 20,
        start_line: None,
        start_side: None,
    };
    put_model_row(
        &f,
        models::DRAFT,
        "d-move",
        json!({
            "id": "d-move", "pr": pr.0, "anchor": moving_anchor, "body": "x",
            "source": {"kind": "me"}, "outdated": false,
        }),
    );

    // Anchored exactly on the line the push rewrites: must come back
    // outdated, not moved.
    let doomed_anchor = Anchor {
        rev: head.clone(),
        path: "src/lib.rs".into(),
        side: Side::New,
        line: 50,
        start_line: None,
        start_side: None,
    };
    put_model_row(
        &f,
        models::FINDING,
        "f-outdated",
        json!({
            "id": "f-outdated", "pr": pr.0, "skill": "s1", "agents": [],
            "anchor": doomed_anchor, "severity": "warn", "title": "t", "body": "b",
            "state": "open", "fix": null, "outdated": false,
        }),
    );

    // The push, described as the diff *between the two heads* (old_head ->
    // new_head): 3 lines inserted at the top shift everything after them by
    // +3; the line at old line 50 is rewritten in place.
    let new_head = Sha::new("head222");
    let insert = testkit::make_hunk(
        "src/lib.rs",
        1,
        0,
        1,
        3,
        vec![
            testkit::line_add(1, "x"),
            testkit::line_add(2, "y"),
            testkit::line_add(3, "z"),
        ],
    );
    let rewrite = testkit::make_hunk(
        "src/lib.rs",
        50,
        1,
        50,
        1,
        vec![testkit::line_add(50, "rewritten")],
    );
    let between = Revision {
        base: Sha::new("base000"),
        head: new_head.clone(),
        files: vec![FileDiff {
            path: "src/lib.rs".into(),
            old_path: None,
            status: FileStatus::Modified,
            similarity: None,
            old_mode: None,
            new_mode: None,
            flags: vec![],
            additions: 4,
            deletions: 1,
            hunks: vec![insert, rewrite],
        }],
    };
    f.git.set_head(new_head.clone());
    f.git.set_revision(between);

    let detail = testkit::sample_pr_detail(&fixture_pr_ref(), &Sha::new("base000"), &new_head);
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("etag-anchor-remap".into()),
        value: detail,
    }));
    f.clock.advance(15_000);

    wait_until(|| {
        f.store
            .get(models::DRAFT, "d-move")
            .unwrap()
            .is_some_and(|r| r.data["anchor"]["line"] == json!(23))
    })
    .await;
    let moved = f.store.get(models::DRAFT, "d-move").unwrap().unwrap();
    assert_eq!(moved.data["anchor"]["rev"], json!(new_head.0));
    assert_eq!(moved.data["outdated"], json!(false));

    wait_until(|| {
        f.store
            .get(models::FINDING, "f-outdated")
            .unwrap()
            .is_some_and(|r| r.data["outdated"] == json!(true))
    })
    .await;
}

// ── run cancel ────────────────────────────────────────────────────────────

#[tokio::test]
async fn cancel_run_stops_a_skill_run_before_it_finishes() {
    let f = fixtures();
    let (core, _recv, pr, _head) = open_fixture_pr(&f).await;
    f.agents.hang_next_run();

    let run_id = core
        .run_skill(RunSkillRequest {
            pr: pr.clone(),
            skill: "security".into(),
            agents: vec![AgentId::Claude],
        })
        .await
        .expect("run_skill");
    core.cancel_run(run_id.clone()).await.expect("cancel_run");

    wait_until(|| {
        f.store
            .get(models::SKILL_RUN, &run_id)
            .ok()
            .flatten()
            .and_then(|r| r.data.get("status").cloned())
            .map(|s| s == json!("cancelled"))
            .unwrap_or(false)
    })
    .await;
}

#[tokio::test]
async fn a_skill_run_without_cancellation_completes() {
    let f = fixtures();
    let (core, _recv, pr, _head) = open_fixture_pr(&f).await;
    f.agents.push_script(vec![
        AgentEvent::Text {
            text: "looking...".into(),
        },
        AgentEvent::Done {
            final_text: "done".into(),
            usage: Usage::default(),
        },
    ]);

    let run_id = core
        .run_skill(RunSkillRequest {
            pr: pr.clone(),
            skill: "security".into(),
            agents: vec![AgentId::Claude],
        })
        .await
        .expect("run_skill");

    wait_until(|| {
        f.store
            .get(models::SKILL_RUN, &run_id)
            .ok()
            .flatten()
            .and_then(|r| r.data.get("status").cloned())
            .map(|s| s == json!("done"))
            .unwrap_or(false)
    })
    .await;
}

// ── refresh_inbox ───────────────────────────────────────────────────────────

#[tokio::test]
async fn refresh_inbox_writes_pr_rows_and_seeds_inbox_state_once() {
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());
    // Let the one-shot startup refresh (empty fixtures) drain first.
    tokio::time::sleep(Duration::from_millis(30)).await;

    let pr_ref = fixture_pr_ref();
    let head = Sha::new("head111");
    let summary = testkit::sample_pr_summary(&pr_ref, &head);
    let pr_id = pr_ref.id();
    for _ in 0..4 {
        f.host.push_search(Ok(vec![summary.clone()]));
    }

    core.refresh_inbox().await.expect("refresh_inbox");

    let pr_row = f.store.get(models::PR, &pr_id.0).unwrap();
    assert!(pr_row.is_some(), "pr row written");
    let state_row = f.store.get(models::INBOX_STATE, &pr_id.0).unwrap();
    assert!(state_row.is_some(), "inbox_state row created");

    // Mark it done, then refresh again: a second pass must not clobber it.
    f.store
        .apply(vec![NewAction {
            model: models::INBOX_STATE.into(),
            model_id: pr_id.0.clone(),
            action: SyncActionCode::U,
            data: Some(json!({"pr": pr_id, "done": true, "snooze": null})),
        }])
        .unwrap();
    for _ in 0..4 {
        f.host.push_search(Ok(vec![summary.clone()]));
    }
    core.refresh_inbox().await.expect("refresh_inbox again");
    let state_row = f.store.get(models::INBOX_STATE, &pr_id.0).unwrap().unwrap();
    assert_eq!(state_row.data["done"], json!(true));
}

// ── viewer / host_status / set_host_token ───────────────────────────────────

#[tokio::test]
async fn viewer_returns_the_authenticated_person() {
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());
    f.host.push_viewer(Ok(testkit::sample_person("octocat")));

    let me = core.viewer().await.expect("viewer");
    assert_eq!(me.login, "octocat");
}

#[tokio::test]
async fn host_status_reports_source_and_connection() {
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());

    f.host.push_viewer(Ok(testkit::sample_person("me")));
    let status = core.host_status().await.expect("host_status");
    assert!(status.connected);
    assert_eq!(status.login, Some("me".into()));
    assert_eq!(status.source, TokenSource::Keychain);

    f.token_status.set(TokenSource::None);
    let status = core.host_status().await.expect("host_status");
    assert!(!status.connected);
    assert_eq!(status.source, TokenSource::None);
}

#[tokio::test]
async fn set_host_token_validates_before_storing_and_rolls_back_on_failure() {
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());
    f.secrets
        .set(theodore_secrets::GITHUB_TOKEN, "old-token")
        .unwrap();

    f.host.push_viewer(Ok(testkit::sample_person("me")));
    let status = core
        .set_host_token(SetTokenRequest {
            host: HostKind::Github,
            token: Some("new-token".into()),
        })
        .await
        .expect("set_host_token");
    assert!(status.connected);
    assert_eq!(
        f.secrets.get(theodore_secrets::GITHUB_TOKEN).unwrap(),
        Some("new-token".into())
    );
    assert!(f.token_status.invalidations() >= 1);

    f.host.push_viewer(Err(HostError::Auth));
    let err = core
        .set_host_token(SetTokenRequest {
            host: HostKind::Github,
            token: Some("bad-token".into()),
        })
        .await;
    assert!(err.is_err(), "a rejected token must not be stored");
    assert_eq!(
        f.secrets.get(theodore_secrets::GITHUB_TOKEN).unwrap(),
        Some("new-token".into()),
        "rolled back to the last good token"
    );

    core.set_host_token(SetTokenRequest {
        host: HostKind::Github,
        token: None,
    })
    .await
    .expect("remove token");
    assert_eq!(f.secrets.get(theodore_secrets::GITHUB_TOKEN).unwrap(), None);
}

#[tokio::test]
async fn set_host_token_keys_by_host_and_leaves_other_hosts_token_alone() {
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());
    f.secrets
        .set(theodore_secrets::GITHUB_TOKEN, "old-gh")
        .unwrap();
    f.secrets
        .set(theodore_secrets::GITLAB_TOKEN, "old-gl")
        .unwrap();

    f.host.push_viewer(Ok(testkit::sample_person("me")));
    let status = core
        .set_host_token(SetTokenRequest {
            host: HostKind::Github,
            token: Some("new-gh".into()),
        })
        .await
        .expect("set_host_token");
    assert!(status.connected);
    assert_eq!(
        f.secrets.get(theodore_secrets::GITHUB_TOKEN).unwrap(),
        Some("new-gh".into())
    );
    assert_eq!(
        f.secrets.get(theodore_secrets::GITLAB_TOKEN).unwrap(),
        Some("old-gl".into()),
        "setting github's token must not touch gitlab's"
    );
}

#[tokio::test]
async fn set_host_token_for_a_non_primary_host_never_touches_the_primarys_token() {
    // `FakeHost::kind()` is `Github`; setting a `Gitlab` token used to be
    // rejected outright before it ever reached the secrets vault (a flat
    // `req.host != deps.host.kind()` gate). It must now actually attempt
    // that host's own validation (surfacing as `AppError::Host`, not the
    // old `AppError::Invalid("... is not configured")`), and never read,
    // write or delete another host's token while doing so.
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());
    f.secrets
        .set(theodore_secrets::GITHUB_TOKEN, "keep-me")
        .unwrap();

    let err = core
        .set_host_token(SetTokenRequest {
            host: HostKind::Gitlab,
            token: Some("gl-new".into()),
        })
        .await
        .unwrap_err();
    assert!(
        matches!(err, AppError::Host(_)),
        "expected the gitlab-specific validation to run and fail, got {err:?}"
    );
    assert_eq!(
        f.secrets.get(theodore_secrets::GITHUB_TOKEN).unwrap(),
        Some("keep-me".into()),
        "github's token must survive a gitlab token attempt"
    );
    assert_eq!(f.secrets.get(theodore_secrets::GITLAB_TOKEN).unwrap(), None);
}

// ── submit_review ────────────────────────────────────────────────────────

#[tokio::test]
async fn submit_review_skips_outdated_drafts_with_a_toast() {
    let f = fixtures();
    let (core, mut recv, pr, _head) = open_fixture_pr(&f).await;

    put_model_row(
        &f,
        models::DRAFT,
        "d-ok",
        json!({
            "id": "d-ok", "pr": pr.0, "anchor": testkit::sample_anchor("src/lib.rs", 2),
            "body": "fine", "source": {"kind": "me"}, "outdated": false,
        }),
    );
    put_model_row(
        &f,
        models::DRAFT,
        "d-stale",
        json!({
            "id": "d-stale", "pr": pr.0, "anchor": testkit::sample_anchor("src/lib.rs", 2),
            "body": "stale", "source": {"kind": "me"}, "outdated": true,
        }),
    );

    core.submit_review(SubmitReviewRequest {
        pr: pr.clone(),
        event: ReviewEvent::Comment,
        body: "lgtm".into(),
    })
    .await
    .expect("submit_review");

    expect_ephemeral(
        &mut recv,
        |e| matches!(e, Ephemeral::Toast { text, .. } if text.contains("skipped")),
    )
    .await;

    wait_until(|| {
        f.store
            .outbox_snapshot()
            .iter()
            .any(|i| i.op == "submit_review")
    })
    .await;
    let item = f
        .store
        .outbox_snapshot()
        .into_iter()
        .find(|i| i.op == "submit_review")
        .unwrap();
    let comments = item.payload["comments"].as_array().unwrap();
    assert_eq!(
        comments.len(),
        1,
        "the outdated draft must not reach the host write"
    );
    assert_eq!(comments[0]["draft_id"], json!("d-ok"));
}

// ── reply_thread / resolve_thread ────────────────────────────────────────────

#[tokio::test]
async fn reply_thread_enqueues_outbox_and_refreshes_pr_detail_on_success() {
    let f = fixtures();
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;
    let detail = testkit::sample_pr_detail(&fixture_pr_ref(), &Sha::new("base000"), &head);
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("etag-reply".into()),
        value: detail,
    }));

    core.reply_thread(ReplyRequest {
        pr: pr.clone(),
        thread: ThreadId::new("thread-1"),
        body: "thanks, fixed".into(),
    })
    .await
    .expect("reply_thread");

    wait_until(|| {
        f.store
            .outbox_snapshot()
            .iter()
            .any(|i| i.op == "reply_thread" && i.status == OutboxStatus::Done)
    })
    .await;
}

#[tokio::test]
async fn reply_thread_does_not_repost_after_a_timeout_retry() {
    // The first `reply` call "succeeds" host-side but the client sees a
    // network error (as if the response was lost after the write landed).
    // The retry must find the marker and skip reposting, not create a
    // second reply.
    let f = fixtures();
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;
    let detail = testkit::sample_pr_detail(&fixture_pr_ref(), &Sha::new("base000"), &head);
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("etag-reply-retry".into()),
        value: detail,
    }));

    f.host.push_reply(Err(HostError::Network("timeout".into())));
    f.host
        .push_find_marker(Ok(Some(theodore_domain::CommentId::new("already-posted"))));

    core.reply_thread(ReplyRequest {
        pr: pr.clone(),
        thread: ThreadId::new("thread-1"),
        body: "thanks, fixed".into(),
    })
    .await
    .expect("reply_thread");

    wait_until(|| {
        f.store
            .outbox_snapshot()
            .first()
            .is_some_and(|i| i.attempts >= 1)
    })
    .await;

    f.clock.advance(10_000);
    wait_until(|| {
        f.store
            .outbox_snapshot()
            .iter()
            .any(|i| i.op == "reply_thread" && i.status == OutboxStatus::Done)
    })
    .await;

    assert_eq!(
        f.host.reply_calls().len(),
        1,
        "the retry must not post a second reply once the marker is found"
    );
}

#[tokio::test]
async fn resolve_thread_enqueues_outbox() {
    let f = fixtures();
    let (core, _recv, pr, _head) = open_fixture_pr(&f).await;

    core.resolve_thread(ResolveRequest {
        pr,
        thread: ThreadId::new("thread-1"),
        resolved: true,
    })
    .await
    .expect("resolve_thread");

    wait_until(|| {
        f.store
            .outbox_snapshot()
            .iter()
            .any(|i| i.op == "resolve_thread" && i.status == OutboxStatus::Done)
    })
    .await;
}

// ── list_skills / run_skill content ─────────────────────────────────────────

#[tokio::test]
async fn list_skills_includes_builtins_and_the_prs_own_claude_skills() {
    let f = fixtures();
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;

    let skill_dir = worktree_dir(&head).join(".claude/skills/demo");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: demo\ndescription: a demo skill\n---\n\nBody.\n",
    )
    .unwrap();

    let skills = core.list_skills(Some(pr)).await.expect("list_skills");
    assert!(
        skills
            .iter()
            .any(|s| s.id == "bugs" && s.source == "built-in")
    );
    assert!(skills.iter().any(|s| s.id == "security"));
    assert!(skills.iter().any(|s| s.id == "tests"));
    assert!(
        skills
            .iter()
            .any(|s| s.id == "demo" && s.title == "demo" && s.description == "a demo skill")
    );
}

#[tokio::test]
async fn run_skill_inlines_skill_text_for_non_claude_agents_only() {
    let f = fixtures();
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;
    let skill_dir = worktree_dir(&head).join(".claude/skills/demo");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: demo\ndescription: a demo skill\n---\n\nUnique skill body marker.\n",
    )
    .unwrap();

    f.agents.push_script(vec![AgentEvent::Done {
        final_text: "ok".into(),
        usage: Usage::default(),
    }]);
    core.run_skill(RunSkillRequest {
        pr: pr.clone(),
        skill: "demo".into(),
        agents: vec![AgentId::Codex],
    })
    .await
    .expect("run_skill codex");
    wait_until(|| f.agents.last_request().is_some()).await;
    let codex_prompt = f.agents.last_request().unwrap().prompt;
    assert!(
        codex_prompt.contains("Unique skill body marker."),
        "non-Claude agents get the SKILL.md text inlined"
    );

    f.agents.push_script(vec![AgentEvent::Done {
        final_text: "ok".into(),
        usage: Usage::default(),
    }]);
    core.run_skill(RunSkillRequest {
        pr,
        skill: "demo".into(),
        agents: vec![AgentId::Claude],
    })
    .await
    .expect("run_skill claude");
    wait_until(|| {
        f.agents
            .last_request()
            .is_some_and(|r| r.agent == AgentId::Claude)
    })
    .await;
    let claude_prompt = f.agents.last_request().unwrap().prompt;
    assert!(
        !claude_prompt.contains("Unique skill body marker."),
        "Claude references the skill by name instead of inlining it"
    );
    assert!(claude_prompt.contains("`demo` skill"));
}

// ── delegate_task / decide_task ──────────────────────────────────────────────

#[tokio::test]
async fn delegate_task_runs_the_agent_in_edit_mode_and_captures_a_patch() {
    let f = fixtures();
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;
    f.git.put_file(&head, "src/lib.rs", b"before\n");
    let dir = worktree_dir(&head);
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("src/lib.rs"), b"after\n").unwrap();

    let task = sample_task(
        "t1",
        &pr,
        Some(testkit::sample_anchor("src/lib.rs", 2)),
        Some(ThreadId::new("thread-1")),
        f.clock.now(),
    );
    put_task(&f, &task);
    f.agents.push_script(vec![AgentEvent::Done {
        final_text: "ok".into(),
        usage: Usage::default(),
    }]);

    let run_id = core
        .delegate_task(DelegateRequest {
            task: task.id.clone(),
            agent: Some(AgentId::Codex),
        })
        .await
        .expect("delegate_task");
    assert!(run_id.starts_with("fix:"));

    wait_until(|| task_row(&f, &task.id).status == TaskStatus::Review).await;
    let updated = task_row(&f, &task.id);
    let patch = updated.fix.expect("fix").patch.expect("patch");
    assert_eq!(patch.path, "src/lib.rs");
    assert_eq!(patch.after, vec!["after".to_string()]);

    let req = f.agents.last_request().expect("agent was run");
    assert_eq!(req.mode, theodore_ports::AgentMode::Edit);
    assert!(req.prompt.contains("Fix the thing"));
}

#[tokio::test]
async fn decide_task_accept_on_own_pr_commits_pushes_and_resolves_thread() {
    let f = fixtures();
    let (core, _recv, pr, _head) = open_fixture_pr(&f).await;
    // `sample_pr_detail`'s author is "author" (plan §4: own PR == viewer == author).
    f.host.push_viewer(Ok(testkit::sample_person("author")));

    let mut task = sample_task(
        "t-own",
        &pr,
        Some(testkit::sample_anchor("src/lib.rs", 2)),
        Some(ThreadId::new("thread-1")),
        f.clock.now(),
    );
    task.status = TaskStatus::Review;
    task.fix = Some(Fix {
        status: FixStatus::Ready,
        patch: Some(Patch {
            path: "src/lib.rs".into(),
            before: vec!["before".into()],
            after: vec!["after".into()],
            note: "agent fix".into(),
            by: AgentId::Codex,
        }),
        commit: None,
    });
    put_task(&f, &task);

    core.decide_task(TaskDecision {
        task: task.id.clone(),
        accept: true,
        reason: None,
    })
    .await
    .expect("decide_task accept");

    let (branch, message) = f.git.last_push.lock().unwrap().clone().expect("pushed");
    assert_eq!(branch, "feature");
    assert!(message.contains("Fix the thing"));

    wait_until(|| {
        f.store
            .outbox_snapshot()
            .iter()
            .any(|i| i.op == "resolve_thread" && i.status == OutboxStatus::Done)
    })
    .await;

    let updated = task_row(&f, &task.id);
    assert_eq!(updated.status, TaskStatus::Done);
    let fix = updated.fix.expect("fix");
    assert_eq!(fix.status, FixStatus::Applied);
    assert!(fix.commit.is_some());
}

#[tokio::test]
async fn decide_task_accept_on_someone_elses_pr_drafts_a_suggestion() {
    let f = fixtures();
    let (core, _recv, pr, _head) = open_fixture_pr(&f).await;
    // Author is "author"; a different viewer makes this not-mine.
    f.host.push_viewer(Ok(testkit::sample_person("reviewer")));

    let mut task = sample_task(
        "t-other",
        &pr,
        Some(testkit::sample_anchor("src/lib.rs", 2)),
        Some(ThreadId::new("thread-1")),
        f.clock.now(),
    );
    task.status = TaskStatus::Review;
    task.fix = Some(Fix {
        status: FixStatus::Ready,
        patch: Some(Patch {
            path: "src/lib.rs".into(),
            before: vec!["before".into()],
            after: vec!["after".into()],
            note: "agent fix".into(),
            by: AgentId::Codex,
        }),
        commit: None,
    });
    put_task(&f, &task);

    core.decide_task(TaskDecision {
        task: task.id.clone(),
        accept: true,
        reason: None,
    })
    .await
    .expect("decide_task accept (suggestion)");

    assert!(
        f.git.last_push.lock().unwrap().is_none(),
        "someone else's PR must not be pushed to"
    );
    let drafts = f.store.query(models::DRAFT, "pr", &pr.0).unwrap();
    assert_eq!(drafts.len(), 1);
    assert!(
        drafts[0].data["body"]
            .as_str()
            .unwrap()
            .contains("```suggestion")
    );

    let updated = task_row(&f, &task.id);
    assert_eq!(updated.status, TaskStatus::Done);
    assert_eq!(updated.fix.unwrap().status, FixStatus::Suggested);
}

#[tokio::test]
async fn decide_task_reject_resets_to_todo_with_a_reason() {
    let f = fixtures();
    let (core, _recv, pr, _head) = open_fixture_pr(&f).await;

    let mut task = sample_task("t-reject", &pr, None, None, f.clock.now());
    task.status = TaskStatus::Review;
    task.fix = Some(Fix {
        status: FixStatus::Ready,
        patch: None,
        commit: None,
    });
    put_task(&f, &task);

    core.decide_task(TaskDecision {
        task: task.id.clone(),
        accept: false,
        reason: Some("doesn't fix the root cause".into()),
    })
    .await
    .expect("decide_task reject");

    let updated = task_row(&f, &task.id);
    assert_eq!(updated.status, TaskStatus::Todo);
    assert!(updated.fix.is_none());

    let reason = f
        .store
        .kv_get(&format!("task:{}:reject_reason", task.id))
        .unwrap();
    assert_eq!(reason, Some(json!("doesn't fix the root cause")));
}

/// Wraps a `Store` whose `apply` fails for any action on the `task` model —
/// standing in for a crash or a disk error partway through accepting a
/// task, so the test can see whether the *other* half of the accept
/// (enqueuing `resolve_thread`) landed anyway.
struct FailingTaskApplyStore(Arc<testkit::FakeStore>);

impl Store for FailingTaskApplyStore {
    fn apply(
        &self,
        actions: Vec<NewAction>,
    ) -> theodore_ports::StoreResult<Vec<theodore_ports::SyncAction>> {
        if actions.iter().any(|a| a.model == models::TASK) {
            return Err(theodore_ports::StoreError::Db("simulated failure".into()));
        }
        self.0.apply(actions)
    }
    fn last_sync_id(&self) -> theodore_ports::StoreResult<u64> {
        self.0.last_sync_id()
    }
    fn since(
        &self,
        sync_id: u64,
        limit: u32,
    ) -> theodore_ports::StoreResult<Vec<theodore_ports::SyncAction>> {
        self.0.since(sync_id, limit)
    }
    fn get(
        &self,
        model: &str,
        id: &str,
    ) -> theodore_ports::StoreResult<Option<theodore_ports::ModelRow>> {
        self.0.get(model, id)
    }
    fn query(
        &self,
        model: &str,
        field: &str,
        value: &str,
    ) -> theodore_ports::StoreResult<Vec<theodore_ports::ModelRow>> {
        self.0.query(model, field, value)
    }
    fn all(&self, model: &str) -> theodore_ports::StoreResult<Vec<theodore_ports::ModelRow>> {
        self.0.all(model)
    }
    fn outbox_push(
        &self,
        op: &str,
        payload: serde_json::Value,
    ) -> theodore_ports::StoreResult<u64> {
        self.0.outbox_push(op, payload)
    }
    fn outbox_take(
        &self,
        now: i64,
    ) -> theodore_ports::StoreResult<Option<theodore_ports::OutboxItem>> {
        self.0.outbox_take(now)
    }
    fn outbox_done(&self, id: u64) -> theodore_ports::StoreResult<()> {
        self.0.outbox_done(id)
    }
    fn outbox_retry(&self, id: u64, not_before: i64) -> theodore_ports::StoreResult<()> {
        self.0.outbox_retry(id, not_before)
    }
    fn outbox_fail(&self, id: u64) -> theodore_ports::StoreResult<()> {
        self.0.outbox_fail(id)
    }
    fn kv_get(&self, key: &str) -> theodore_ports::StoreResult<Option<serde_json::Value>> {
        self.0.kv_get(key)
    }
    fn kv_set(&self, key: &str, value: &serde_json::Value) -> theodore_ports::StoreResult<()> {
        self.0.kv_set(key, value)
    }
}

#[tokio::test]
async fn accept_task_does_not_leave_an_orphaned_resolve_thread_outbox_item() {
    let f = fixtures();
    let pr_ref = fixture_pr_ref();
    let head = Sha::new("head111");
    let base = Sha::new("base000");
    let detail = testkit::sample_pr_detail(&pr_ref, &base, &head);
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("etag-1".into()),
        value: detail,
    }));
    let mut deps = f.deps();
    deps.store = Arc::new(FailingTaskApplyStore(f.store.clone()));
    let (core, _recv) = Core::start(deps);
    let resp = core
        .open_pr(OpenPrRequest {
            url: "https://github.com/acme/widgets/pull/7".into(),
        })
        .await
        .expect("open_pr");
    let pr = resp.pr;

    let mut task = sample_task(
        "t-atomic",
        &pr,
        None,
        Some(ThreadId::new("thread-1")),
        f.clock.now(),
    );
    task.status = TaskStatus::Review;
    task.fix = Some(Fix {
        status: FixStatus::Ready,
        patch: None,
        commit: None,
    });
    put_task(&f, &task);

    let result = core
        .decide_task(TaskDecision {
            task: task.id.clone(),
            accept: true,
            reason: None,
        })
        .await;
    assert!(
        result.is_err(),
        "expected the simulated task write failure to surface, got {result:?}"
    );

    assert!(
        f.store
            .outbox_snapshot()
            .iter()
            .all(|i| i.op != "resolve_thread"),
        "a failed task write must not leave a resolve_thread outbox item behind"
    );
}

// ── agents.grouping setting ──────────────────────────────────────────────────

#[tokio::test]
async fn regroup_honours_the_agents_grouping_setting() {
    let f = fixtures();
    let (core, _recv, pr, _head) = open_fixture_pr(&f).await;

    let tx = Transaction {
        id: "set-grouping-agent".into(),
        ops: vec![MutationOp::Create {
            model: models::SETTING.into(),
            id: "agents.grouping".into(),
            data: json!({"key": "agents.grouping", "scope": "user", "value": "codex"}),
        }],
    };
    assert!(matches!(
        core.transact(tx).await,
        TransactionResult::Ok { .. }
    ));

    core.regroup(pr).await.expect("regroup");
    assert_eq!(f.grouper.last_agent(), Some(AgentId::Codex));
}

// ── is_idle ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn is_idle_is_false_while_the_outbox_has_pending_items() {
    let f = fixtures();
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;
    let revision = core
        .get_revision(RevisionRequest {
            pr: pr.clone(),
            head,
        })
        .await
        .unwrap();
    let hunks = testkit::hunk_ids(&revision);

    // Block the outbox on a network error so the item stays pending.
    f.host
        .push_set_viewed(Err(HostError::Network("down".into())));
    for (i, h) in hunks.iter().enumerate() {
        core.transact(hunk_read_tx(&format!("read-{i}"), &pr, h))
            .await;
    }
    // Wait for the failed first attempt to land (back to `Pending`, armed
    // with a backoff `not_before`) before advancing the clock — advancing
    // too early would compute the backoff from the already-advanced time.
    wait_until(|| {
        f.store
            .outbox_snapshot()
            .first()
            .is_some_and(|i| i.attempts >= 1)
    })
    .await;

    assert!(
        !core.is_idle().await,
        "a pending outbox item must not be idle"
    );

    f.host.push_set_viewed(Ok(()));
    f.clock.advance(10_000);
    wait_until(|| f.store.outbox_snapshot()[0].status == OutboxStatus::Done).await;
    assert!(core.is_idle().await);
}

// Hand-written host authentication status smoke check: `HostAuthStatus`'s
// shape, not behavior, to catch an accidental contract drift at the type
// level (the rest is covered by `host_status_reports_source_and_connection`).
#[test]
fn host_auth_status_is_constructible() {
    let _ = HostAuthStatus {
        host: HostKind::Github,
        connected: true,
        login: Some("me".into()),
        source: TokenSource::Gh,
    };
}

// ── projects ──────────────────────────────────────────────────────────────

async fn started_core(f: &Fixtures) -> (Core, Receivers) {
    let (core, recv) = Core::start(f.deps());
    // Let the one-shot startup inbox refresh (empty fixtures) drain first —
    // it shares `FakeHost`'s search queue with a project's own refresh.
    tokio::time::sleep(Duration::from_millis(30)).await;
    (core, recv)
}

async fn add_ready_local_project(
    core: &Core,
    f: &Fixtures,
    path: &str,
) -> theodore_contract::Project {
    let project = core
        .add_project(AddProjectRequest {
            repo: None,
            path: Some(path.into()),
        })
        .await
        .expect("add_project");
    wait_until(|| {
        f.store
            .get(models::PROJECT, &project.id)
            .unwrap()
            .is_some_and(|r| r.data["status"] == json!("ready"))
    })
    .await;
    project
}

fn feature_branch_commit() -> CommitLog {
    CommitLog {
        sha: Sha::new("feat-head"),
        title: "feature work".into(),
        author_name: "Ada".into(),
        author_email: "ada@example.com".into(),
        at: 42_000,
    }
}

#[tokio::test]
async fn add_project_clones_a_host_repo_then_becomes_ready_and_refreshes_its_prs() {
    let f = fixtures();
    let (core, _recv) = started_core(&f).await;

    let repo = RepoRef {
        host: HostKind::Github,
        owner: "acme".into(),
        name: "widgets".into(),
    };
    let pr_ref = PrRef {
        repo: repo.clone(),
        number: 9,
        host_id: Some("node-9".into()),
    };
    f.host.push_search(Ok(vec![testkit::sample_pr_summary(
        &pr_ref,
        &Sha::new("head9"),
    )]));

    let project = core
        .add_project(AddProjectRequest {
            repo: Some(repo.clone()),
            path: None,
        })
        .await
        .expect("add_project");
    assert_eq!(project.id, "github:acme/widgets");
    assert_eq!(project.status, ProjectStatus::Cloning);

    wait_until(|| {
        f.store
            .get(models::PROJECT, "github:acme/widgets")
            .unwrap()
            .is_some_and(|r| r.data["status"] == json!("ready"))
    })
    .await;
    let row = f
        .store
        .get(models::PROJECT, "github:acme/widgets")
        .unwrap()
        .unwrap();
    assert_eq!(row.data["default_branch"], json!("main"));

    // The initial refresh after the clone wrote the repo's open PRs.
    wait_until(|| f.store.get(models::PR, &pr_ref.id().0).unwrap().is_some()).await;
}

#[tokio::test]
async fn add_project_rejects_a_folder_that_is_not_a_git_repository() {
    let f = fixtures();
    let (core, _recv) = started_core(&f).await;
    f.git.set_is_repo(false);

    let err = core
        .add_project(AddProjectRequest {
            repo: None,
            path: Some("/tmp/not-a-repo".into()),
        })
        .await
        .unwrap_err();
    assert!(err.to_string().contains("not a git repository"));
}

#[tokio::test]
async fn add_project_local_folder_dedupes_a_colliding_name() {
    let f = fixtures();
    let (core, _recv) = started_core(&f).await;

    let first = core
        .add_project(AddProjectRequest {
            repo: None,
            path: Some("/tmp/widgets".into()),
        })
        .await
        .expect("first add_project");
    assert_eq!(first.id, "local:widgets");
    assert_eq!(first.repo.owner, "local");
    assert_eq!(first.repo.name, "widgets");
    assert_eq!(first.path.as_deref(), Some("/tmp/widgets"));

    // A different folder that happens to share a basename gets a
    // de-duplicated id instead of colliding with the first.
    let second = core
        .add_project(AddProjectRequest {
            repo: None,
            path: Some("/elsewhere/widgets".into()),
        })
        .await
        .expect("second add_project");
    assert_eq!(second.id, "local:widgets-2");

    wait_until(|| {
        f.store
            .get(models::PROJECT, "local:widgets")
            .unwrap()
            .is_some_and(|r| r.data["status"] == json!("ready"))
    })
    .await;
    wait_until(|| {
        f.store
            .get(models::PROJECT, "local:widgets-2")
            .unwrap()
            .is_some_and(|r| r.data["status"] == json!("ready"))
    })
    .await;
}

#[tokio::test]
async fn remove_project_deletes_the_cache_but_never_the_local_folder() {
    let f = fixtures();
    let (core, _recv) = started_core(&f).await;
    let project = add_ready_local_project(&core, &f, "/tmp/my-folder").await;

    core.remove_project(&project.id)
        .await
        .expect("remove_project");

    assert!(f.store.get(models::PROJECT, &project.id).unwrap().is_none());
    assert_eq!(f.git.removed_repos(), vec![project.repo.clone()]);
}

#[tokio::test]
async fn list_branches_reads_the_mirror_for_a_local_project() {
    let f = fixtures();
    let (core, _recv) = started_core(&f).await;
    let project = add_ready_local_project(&core, &f, "/tmp/my-folder").await;

    f.git.set_branches(vec![
        BranchInfo {
            name: "main".into(),
            head: Sha::new("m1"),
            subject: "base".into(),
            ahead: 0,
            behind: 0,
            updated_at: 1,
        },
        BranchInfo {
            name: "feature".into(),
            head: Sha::new("f1"),
            subject: "feature work".into(),
            ahead: 2,
            behind: 1,
            updated_at: 2,
        },
    ]);

    let branches = core
        .list_branches(&project.id)
        .await
        .expect("list_branches");
    assert_eq!(branches.len(), 2);
    let feature = branches.iter().find(|b| b.name == "feature").unwrap();
    assert_eq!((feature.ahead, feature.behind), (2, 1));
    assert_eq!(feature.subject, "feature work");
}

#[tokio::test]
async fn open_branch_opens_a_review_with_no_host_pr() {
    let f = fixtures();
    let (core, _recv) = started_core(&f).await;
    let project = add_ready_local_project(&core, &f, "/tmp/my-folder").await;

    f.git.set_resolve("feature", Sha::new("feat-head"));
    f.git.set_resolve("main", Sha::new("main-base"));
    f.git
        .set_commit(Sha::new("feat-head"), feature_branch_commit());
    f.git.set_commit_log(vec![feature_branch_commit()]);

    let resp = core
        .open_branch(OpenBranchRequest {
            project: project.id.clone(),
            branch: "feature".into(),
            base: None,
        })
        .await
        .expect("open_branch");
    assert_eq!(resp.head.as_str(), "feat-head");

    let pr_row = f
        .store
        .get(models::PR, &resp.pr.0)
        .unwrap()
        .expect("pr row");
    assert_eq!(pr_row.data["head_ref"], json!("feature"));
    assert_eq!(pr_row.data["base_ref"], json!("main"));
    assert_eq!(pr_row.data["state"], json!("open"));
    assert_eq!(pr_row.data["url"], json!(""));

    let detail_row = f
        .store
        .get(models::PR_DETAIL, &resp.pr.0)
        .unwrap()
        .expect("pr_detail row");
    assert_eq!(detail_row.data["body"], json!(""));
    assert_eq!(detail_row.data["commits"].as_array().unwrap().len(), 1);

    // Reopening the same branch is idempotent — keyed by the stable hash
    // of its name, it returns the same PR without re-running the flow.
    let again = core
        .open_branch(OpenBranchRequest {
            project: project.id.clone(),
            branch: "feature".into(),
            base: None,
        })
        .await
        .expect("open_branch again");
    assert_eq!(again.pr, resp.pr);
}

#[tokio::test]
async fn ensure_open_recovers_a_local_pr_after_a_restart() {
    let f = fixtures();
    let (core, _recv) = started_core(&f).await;
    let project = add_ready_local_project(&core, &f, "/tmp/my-folder").await;

    f.git.set_resolve("feature", Sha::new("feat-head"));
    f.git.set_resolve("main", Sha::new("main-base"));
    f.git
        .set_commit(Sha::new("feat-head"), feature_branch_commit());
    f.git.set_commit_log(vec![feature_branch_commit()]);

    let resp = core
        .open_branch(OpenBranchRequest {
            project: project.id.clone(),
            branch: "feature".into(),
            base: None,
        })
        .await
        .expect("open_branch");

    // A fresh `Core` over the same store/git has nothing cached in memory;
    // `ensure_open` must recover the branch from the stored `pr` row.
    let before = f.git.mirror_calls().len();
    let (core2, _recv2) = started_core(&f).await;
    core2.ensure_open(&resp.pr).await.expect("ensure_open");
    assert!(f.git.mirror_calls().len() > before);

    let revision = core2
        .get_revision(RevisionRequest {
            pr: resp.pr.clone(),
            head: resp.head.clone(),
        })
        .await
        .expect("get_revision after recovery");
    assert!(!revision.files.is_empty());
}

// ── merge / reviewers / draft / update_branch / react / edit_comment ───────

#[tokio::test]
async fn merge_pr_merges_now_by_default() {
    let f = fixtures();
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("e".into()),
        value: testkit::sample_pr_detail(&fixture_pr_ref(), &Sha::new("base000"), &head),
    }));

    core.merge_pr(MergeRequest {
        pr: pr.clone(),
        method: WireMergeMethod::Squash,
        title: Some("t".into()),
        body: None,
        auto: false,
        queue: false,
    })
    .await
    .expect("merge_pr");

    wait_until(|| {
        f.store
            .outbox_snapshot()
            .iter()
            .any(|i| i.op == "merge_pr" && i.status == OutboxStatus::Done)
    })
    .await;
    let calls = f.host.merge_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, PortMergeMethod::Squash);
    assert_eq!(calls[0].1, Some("t".to_string()));
}

#[tokio::test]
async fn merge_pr_auto_enables_auto_merge_instead_of_merging() {
    let f = fixtures();
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("e".into()),
        value: testkit::sample_pr_detail(&fixture_pr_ref(), &Sha::new("base000"), &head),
    }));

    core.merge_pr(MergeRequest {
        pr,
        method: WireMergeMethod::Merge,
        title: None,
        body: None,
        auto: true,
        queue: false,
    })
    .await
    .expect("merge_pr");

    wait_until(|| {
        f.store
            .outbox_snapshot()
            .iter()
            .any(|i| i.op == "merge_pr" && i.status == OutboxStatus::Done)
    })
    .await;
    assert!(
        f.host.merge_calls().is_empty(),
        "must not call merge directly"
    );
}

#[tokio::test]
async fn merge_pr_on_a_local_pr_rejects_synchronously() {
    let f = fixtures();
    let (core, _recv) = started_core(&f).await;
    let project = add_ready_local_project(&core, &f, "/tmp/my-folder").await;
    f.git.set_resolve("feature", Sha::new("feat-head"));
    f.git.set_resolve("main", Sha::new("main-base"));
    f.git
        .set_commit(Sha::new("feat-head"), feature_branch_commit());
    f.git.set_commit_log(vec![feature_branch_commit()]);
    let resp = core
        .open_branch(OpenBranchRequest {
            project: project.id.clone(),
            branch: "feature".into(),
            base: None,
        })
        .await
        .expect("open_branch");

    let err = core
        .merge_pr(MergeRequest {
            pr: resp.pr,
            method: WireMergeMethod::Merge,
            title: None,
            body: None,
            auto: false,
            queue: false,
        })
        .await
        .unwrap_err();
    assert!(err.to_string().contains("local branch review"));
    assert!(f.store.outbox_snapshot().is_empty());
}

#[tokio::test]
async fn merge_info_maps_the_hosts_status() {
    let f = fixtures();
    let (core, _recv, pr, _head) = open_fixture_pr(&f).await;
    f.host.push_merge_status(Ok(MergeStatus {
        mergeable: Some(true),
        state: MergeState::Clean,
        allowed_methods: vec![PortMergeMethod::Squash],
        auto_merge_enabled: false,
        in_queue: false,
        required_approvals: Some(2),
    }));

    let info = core.merge_info(pr).await.expect("merge_info");
    assert_eq!(info.mergeable, Some(true));
    assert_eq!(info.required_approvals, Some(2));
    assert_eq!(info.allowed_methods, vec![WireMergeMethod::Squash]);
}

#[tokio::test]
async fn assignable_users_reads_through_to_the_host() {
    let f = fixtures();
    let (core, _recv, pr, _head) = open_fixture_pr(&f).await;
    f.host
        .push_assignable_users(Ok(vec![testkit::sample_person("bob")]));

    let users = core.assignable_users(pr).await.expect("assignable_users");
    assert_eq!(users.len(), 1);
    assert_eq!(users[0].login, "bob");
}

#[tokio::test]
async fn set_reviewers_enqueues_adds_and_removes_in_one_outbox_item() {
    let f = fixtures();
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("e".into()),
        value: testkit::sample_pr_detail(&fixture_pr_ref(), &Sha::new("base000"), &head),
    }));

    core.set_reviewers(ReviewersRequest {
        pr,
        add: vec!["carol".into()],
        add_teams: vec!["core".into()],
        remove: vec!["dave".into()],
    })
    .await
    .expect("set_reviewers");

    wait_until(|| {
        f.store
            .outbox_snapshot()
            .iter()
            .any(|i| i.op == "set_reviewers" && i.status == OutboxStatus::Done)
    })
    .await;
    assert_eq!(
        f.host.reviewer_calls(),
        vec![(vec!["carol".to_string()], vec!["core".to_string()])]
    );
    assert_eq!(f.host.remove_reviewer_calls(), vec!["dave".to_string()]);
}

// ── rerun_check / triage ────────────────────────────────────────────────

#[tokio::test]
async fn rerun_check_resolves_the_check_from_pr_detail_and_calls_the_host() {
    let f = fixtures();
    let head = Sha::new("head111");
    let mut detail = testkit::sample_pr_detail(&fixture_pr_ref(), &Sha::new("base000"), &head);
    detail.checks = vec![Check {
        id: "900001".into(),
        name: "build".into(),
        status: CheckStatus::Fail,
        url: None,
        duration_ms: None,
    }];
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("etag-1".into()),
        value: detail,
    }));
    let (core, _recv) = Core::start(f.deps());
    let resp = core
        .open_pr(OpenPrRequest {
            url: "https://github.com/acme/widgets/pull/7".into(),
        })
        .await
        .expect("open_pr");
    let pr = resp.pr;
    // `rerun_check` itself refreshes `pr_detail` on success too.
    f.host.push_get_pr(Ok(Fetched::NotModified));

    core.rerun_check(RerunCheckRequest {
        pr: pr.clone(),
        check: "900001".into(),
    })
    .await
    .expect("rerun_check");

    wait_until(|| {
        f.store
            .outbox_snapshot()
            .iter()
            .any(|i| i.op == "rerun_check" && i.status == OutboxStatus::Done)
    })
    .await;
    assert_eq!(f.host.rerun_check_calls(), vec!["900001".to_string()]);
}

#[tokio::test]
async fn rerun_check_fails_when_the_check_id_is_unknown() {
    let f = fixtures();
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("e".into()),
        value: testkit::sample_pr_detail(&fixture_pr_ref(), &Sha::new("base000"), &head),
    }));

    core.rerun_check(RerunCheckRequest {
        pr: pr.clone(),
        check: "missing".into(),
    })
    .await
    .expect("enqueues even though the check doesn't resolve until it runs");

    wait_until(|| {
        f.store
            .outbox_snapshot()
            .iter()
            .any(|i| i.op == "rerun_check" && i.status == OutboxStatus::Failed)
    })
    .await;
    assert!(f.host.rerun_check_calls().is_empty());
}

#[tokio::test]
async fn triage_take_requests_review_from_the_viewer_and_drops_team_requests() {
    let f = fixtures();
    let head = Sha::new("head111");
    let mut detail = testkit::sample_pr_detail(&fixture_pr_ref(), &Sha::new("base000"), &head);
    detail.reviewers = vec![theodore_domain::Reviewer {
        person: testkit::sample_person("core-team"),
        state: theodore_domain::ReviewerState::Requested,
        team: Some("core-team".into()),
    }];
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("etag-1".into()),
        value: detail,
    }));
    let (core, _recv) = Core::start(f.deps());
    let resp = core
        .open_pr(OpenPrRequest {
            url: "https://github.com/acme/widgets/pull/7".into(),
        })
        .await
        .expect("open_pr");
    let pr = resp.pr;
    f.host.push_viewer(Ok(testkit::sample_person("me")));
    f.host.push_get_pr(Ok(Fetched::NotModified));

    core.triage(TriageRequest {
        pr: pr.clone(),
        action: TriageAction::Take,
    })
    .await
    .expect("triage take");

    wait_until(|| {
        f.store
            .outbox_snapshot()
            .iter()
            .any(|i| i.op == "triage" && i.status == OutboxStatus::Done)
    })
    .await;
    assert_eq!(
        f.host.reviewer_calls(),
        vec![(vec!["me".to_string()], vec![])]
    );
    assert_eq!(
        f.host.remove_reviewer_calls(),
        vec!["core-team".to_string()]
    );
}

#[tokio::test]
async fn triage_decline_removes_the_viewer_and_marks_the_inbox_row_done() {
    let f = fixtures();
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("e".into()),
        value: testkit::sample_pr_detail(&fixture_pr_ref(), &Sha::new("base000"), &head),
    }));
    f.host.push_viewer(Ok(testkit::sample_person("me")));
    f.host.push_get_pr(Ok(Fetched::NotModified));
    core.apply(vec![NewAction {
        model: models::INBOX_STATE.into(),
        model_id: pr.0.clone(),
        action: SyncActionCode::I,
        data: Some(
            serde_json::to_value(InboxState {
                pr: pr.clone(),
                done: false,
                snooze: None,
            })
            .unwrap(),
        ),
    }])
    .await
    .expect("seed inbox_state");

    core.triage(TriageRequest {
        pr: pr.clone(),
        action: TriageAction::Decline,
    })
    .await
    .expect("triage decline");

    wait_until(|| {
        f.store
            .outbox_snapshot()
            .iter()
            .any(|i| i.op == "triage" && i.status == OutboxStatus::Done)
    })
    .await;
    assert_eq!(f.host.remove_reviewer_calls(), vec!["me".to_string()]);
    let row = f
        .store
        .get(models::INBOX_STATE, &pr.0)
        .unwrap()
        .expect("inbox_state row");
    assert_eq!(row.data.get("done"), Some(&json!(true)));
}

#[tokio::test]
async fn triage_reassign_requests_the_given_users_and_drops_the_viewer() {
    let f = fixtures();
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("e".into()),
        value: testkit::sample_pr_detail(&fixture_pr_ref(), &Sha::new("base000"), &head),
    }));
    f.host.push_viewer(Ok(testkit::sample_person("me")));
    f.host.push_get_pr(Ok(Fetched::NotModified));

    core.triage(TriageRequest {
        pr: pr.clone(),
        action: TriageAction::Reassign {
            to: vec!["carol".into()],
        },
    })
    .await
    .expect("triage reassign");

    wait_until(|| {
        f.store
            .outbox_snapshot()
            .iter()
            .any(|i| i.op == "triage" && i.status == OutboxStatus::Done)
    })
    .await;
    assert_eq!(
        f.host.reviewer_calls(),
        vec![(vec!["carol".to_string()], vec![])]
    );
    assert_eq!(f.host.remove_reviewer_calls(), vec!["me".to_string()]);
}

#[tokio::test]
async fn triage_on_a_local_pr_rejects_synchronously() {
    let f = fixtures();
    let (core, _recv) = started_core(&f).await;
    let project = add_ready_local_project(&core, &f, "/tmp/my-folder").await;
    f.git.set_resolve("feature", Sha::new("feat-head"));
    f.git.set_resolve("main", Sha::new("main-base"));
    f.git
        .set_commit(Sha::new("feat-head"), feature_branch_commit());
    f.git.set_commit_log(vec![feature_branch_commit()]);
    let resp = core
        .open_branch(OpenBranchRequest {
            project: project.id.clone(),
            branch: "feature".into(),
            base: None,
        })
        .await
        .expect("open_branch");

    let err = core
        .triage(TriageRequest {
            pr: resp.pr,
            action: TriageAction::Decline,
        })
        .await
        .unwrap_err();
    assert!(err.to_string().contains("local branch review"));
    assert!(f.store.outbox_snapshot().is_empty());
}

#[tokio::test]
async fn set_draft_converts_to_draft_and_back_to_ready() {
    let f = fixtures();
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;
    for _ in 0..2 {
        f.host.push_get_pr(Ok(Fetched::Modified {
            etag: Some("e".into()),
            value: testkit::sample_pr_detail(&fixture_pr_ref(), &Sha::new("base000"), &head),
        }));
    }

    core.set_draft(DraftStateRequest {
        pr: pr.clone(),
        draft: true,
    })
    .await
    .expect("set_draft true");
    wait_until(|| {
        f.store
            .outbox_snapshot()
            .iter()
            .filter(|i| i.op == "set_draft" && i.status == OutboxStatus::Done)
            .count()
            == 1
    })
    .await;

    core.set_draft(DraftStateRequest { pr, draft: false })
        .await
        .expect("set_draft false");
    wait_until(|| {
        f.store
            .outbox_snapshot()
            .iter()
            .filter(|i| i.op == "set_draft" && i.status == OutboxStatus::Done)
            .count()
            == 2
    })
    .await;
}

#[tokio::test]
async fn update_branch_enqueues_and_refreshes() {
    let f = fixtures();
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("e".into()),
        value: testkit::sample_pr_detail(&fixture_pr_ref(), &Sha::new("base000"), &head),
    }));

    core.update_branch(pr).await.expect("update_branch");
    wait_until(|| {
        f.store
            .outbox_snapshot()
            .iter()
            .any(|i| i.op == "update_branch" && i.status == OutboxStatus::Done)
    })
    .await;
}

#[tokio::test]
async fn react_adds_and_removes_a_reaction() {
    let f = fixtures();
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;
    for _ in 0..2 {
        f.host.push_get_pr(Ok(Fetched::Modified {
            etag: Some("e".into()),
            value: testkit::sample_pr_detail(&fixture_pr_ref(), &Sha::new("base000"), &head),
        }));
    }

    core.react(ReactRequest {
        pr: pr.clone(),
        comment: CommentId::new("c1"),
        emoji: "+1".into(),
        on: true,
    })
    .await
    .expect("react on");
    core.react(ReactRequest {
        pr,
        comment: CommentId::new("c1"),
        emoji: "+1".into(),
        on: false,
    })
    .await
    .expect("react off");

    wait_until(|| {
        f.store
            .outbox_snapshot()
            .iter()
            .filter(|i| i.op == "react" && i.status == OutboxStatus::Done)
            .count()
            == 2
    })
    .await;
}

#[tokio::test]
async fn edit_comment_edits_or_deletes_depending_on_body() {
    let f = fixtures();
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;
    for _ in 0..2 {
        f.host.push_get_pr(Ok(Fetched::Modified {
            etag: Some("e".into()),
            value: testkit::sample_pr_detail(&fixture_pr_ref(), &Sha::new("base000"), &head),
        }));
    }

    core.edit_comment(EditCommentRequest {
        pr: pr.clone(),
        comment: CommentId::new("c1"),
        body: Some("edited".into()),
    })
    .await
    .expect("edit");
    core.edit_comment(EditCommentRequest {
        pr,
        comment: CommentId::new("c1"),
        body: None,
    })
    .await
    .expect("delete");

    wait_until(|| {
        f.store
            .outbox_snapshot()
            .iter()
            .filter(|i| i.op == "edit_comment" && i.status == OutboxStatus::Done)
            .count()
            == 2
    })
    .await;
}

// ── commit_suggestions ───────────────────────────────────────────────────────

fn suggestion_comment(id: &str, body: &str) -> Comment {
    Comment {
        id: CommentId::new(id),
        author: testkit::sample_person("author"),
        body: body.into(),
        created_at: 0,
        edited: false,
    }
}

fn suggestion_anchor(path: &str, line: u32, start_line: Option<u32>) -> Anchor {
    Anchor {
        rev: Sha::new("head111"),
        path: path.into(),
        side: Side::New,
        line,
        start_line,
        start_side: None,
    }
}

#[tokio::test]
async fn commit_suggestions_applies_and_pushes_one_commit_on_the_authors_own_pr() {
    let f = fixtures();
    // The viewer is the PR's own author, so suggestions may be committed
    // directly instead of drafted.
    f.host.push_viewer(Ok(testkit::sample_person("author")));
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;

    std::fs::create_dir_all(worktree_dir(&head)).unwrap();
    let note_path = worktree_dir(&head).join("note.txt");
    std::fs::write(&note_path, "one\ntwo\nthree\n").unwrap();

    let thread = Thread {
        id: ThreadId::new("t1"),
        anchor: Some(suggestion_anchor("note.txt", 2, None)),
        resolved: false,
        outdated: false,
        comments: vec![suggestion_comment("c1", "```suggestion\nTWO FIXED\n```")],
    };
    let mut detail = testkit::sample_pr_detail(&fixture_pr_ref(), &Sha::new("base000"), &head);
    detail.threads = vec![thread];
    f.store
        .apply(vec![NewAction {
            model: models::PR_DETAIL.into(),
            model_id: pr.0.clone(),
            action: SyncActionCode::U,
            data: Some(serde_json::to_value(&detail).unwrap()),
        }])
        .unwrap();

    core.commit_suggestions(CommitSuggestionsRequest {
        pr,
        comments: vec![CommentId::new("c1")],
        message: "apply suggestion".into(),
    })
    .await
    .expect("commit_suggestions");

    let content = std::fs::read_to_string(&note_path).unwrap();
    assert_eq!(content, "one\nTWO FIXED\nthree\n");
    let push = f.git.last_push.lock().unwrap().clone().expect("pushed");
    assert_eq!(push.0, "feature");
    assert_eq!(push.1, "apply suggestion");
}

#[tokio::test]
async fn commit_suggestions_rejects_on_someone_elses_pr() {
    let f = fixtures();
    // Default viewer is "me"; the fixture PR's author is "author" — not own.
    let (core, _recv, pr, _head) = open_fixture_pr(&f).await;

    let err = core
        .commit_suggestions(CommitSuggestionsRequest {
            pr,
            comments: vec![CommentId::new("c1")],
            message: "m".into(),
        })
        .await
        .unwrap_err();
    assert!(err.to_string().contains("own PR"));
}

#[tokio::test]
async fn commit_suggestions_rejects_overlapping_ranges() {
    let f = fixtures();
    f.host.push_viewer(Ok(testkit::sample_person("author")));
    let (core, _recv, pr, head) = open_fixture_pr(&f).await;

    // The overlap check runs before any file is touched, so this test
    // never needs `note.txt` to exist on disk.
    let thread1 = Thread {
        id: ThreadId::new("t1"),
        anchor: Some(suggestion_anchor("note.txt", 3, Some(1))),
        resolved: false,
        outdated: false,
        comments: vec![suggestion_comment("c1", "```suggestion\nX\n```")],
    };
    let thread2 = Thread {
        id: ThreadId::new("t2"),
        anchor: Some(suggestion_anchor("note.txt", 2, None)),
        resolved: false,
        outdated: false,
        comments: vec![suggestion_comment("c2", "```suggestion\nY\n```")],
    };
    let mut detail = testkit::sample_pr_detail(&fixture_pr_ref(), &Sha::new("base000"), &head);
    detail.threads = vec![thread1, thread2];
    f.store
        .apply(vec![NewAction {
            model: models::PR_DETAIL.into(),
            model_id: pr.0.clone(),
            action: SyncActionCode::U,
            data: Some(serde_json::to_value(&detail).unwrap()),
        }])
        .unwrap();

    let err = core
        .commit_suggestions(CommitSuggestionsRequest {
            pr,
            comments: vec![CommentId::new("c1"), CommentId::new("c2")],
            message: "m".into(),
        })
        .await
        .unwrap_err();
    assert!(err.to_string().contains("overlapping"));
}

// ── get_skill / save_skill ───────────────────────────────────────────────────

#[tokio::test]
async fn get_skill_returns_builtins_read_only() {
    let f = fixtures();
    let (core, _recv) = started_core(&f).await;
    let body = core.get_skill("bugs", None).await.expect("get_skill");
    assert!(!body.editable);
    assert_eq!(body.info.source, "built-in");
    assert!(!body.body.is_empty());
}

#[tokio::test]
async fn get_skill_errors_for_an_unknown_id_with_no_pr() {
    let f = fixtures();
    let (core, _recv) = started_core(&f).await;
    assert!(core.get_skill("no-such-skill", None).await.is_err());
}

#[tokio::test]
async fn save_skill_user_scope_writes_to_the_home_skills_dir() {
    let f = fixtures();
    let (core, _recv) = started_core(&f).await;

    let info = core
        .save_skill(SaveSkillRequest {
            id: "my-skill".into(),
            scope: "user".into(),
            pr: None,
            body: "---\nname: my-skill\ndescription: d\n---\nbody".into(),
        })
        .await
        .expect("save_skill");
    assert_eq!(info.source, "~/.claude/skills");

    let saved = core
        .get_skill("my-skill", None)
        .await
        .expect("get_skill after save");
    assert!(saved.editable);
    assert_eq!(saved.info.description, "d");
}

#[tokio::test]
async fn save_skill_repo_scope_writes_into_the_worktree_and_toasts() {
    let f = fixtures();
    let (core, mut recv, pr, _head) = open_fixture_pr(&f).await;

    let info = core
        .save_skill(SaveSkillRequest {
            id: "repo-skill".into(),
            scope: "repo".into(),
            pr: Some(pr.clone()),
            body: "---\nname: repo-skill\ndescription: d\n---\nbody".into(),
        })
        .await
        .expect("save_skill");
    assert!(info.source.contains(".claude/skills"));

    let event = expect_ephemeral(&mut recv, |e| matches!(e, Ephemeral::Toast { .. })).await;
    assert!(matches!(
        event,
        Ephemeral::Toast {
            level: ToastLevel::Info,
            ..
        }
    ));

    let saved = core
        .get_skill("repo-skill", Some(pr))
        .await
        .expect("get_skill after repo save");
    assert!(saved.editable);
}

// ── budget / pr_spend ─────────────────────────────────────────────────────────

fn skill_run_row(id: &str, pr: &PrId, usd: f64) -> theodore_contract::SkillRun {
    theodore_contract::SkillRun {
        id: id.into(),
        pr: pr.clone(),
        skill: "bugs".into(),
        agents: vec![AgentId::Claude],
        status: theodore_contract::RunStatus::Done,
        usage: Usage {
            input_tokens: 0,
            output_tokens: 0,
            usd,
        },
        error: None,
        started_at: 0,
    }
}

fn put_setting(f: &Fixtures, key: &str, scope: &str, value: serde_json::Value) {
    let setting = Setting {
        key: key.into(),
        scope: scope.into(),
        value,
    };
    f.store
        .apply(vec![NewAction {
            model: models::SETTING.into(),
            model_id: format!("{scope}:{key}"),
            action: SyncActionCode::I,
            data: Some(serde_json::to_value(&setting).unwrap()),
        }])
        .unwrap();
}

#[tokio::test]
async fn pr_spend_sums_skill_run_and_chat_usage() {
    let f = fixtures();
    let (core, _recv, pr, _head) = open_fixture_pr(&f).await;

    f.store
        .apply(vec![NewAction {
            model: models::SKILL_RUN.into(),
            model_id: "run-1".into(),
            action: SyncActionCode::I,
            data: Some(serde_json::to_value(skill_run_row("run-1", &pr, 2.0)).unwrap()),
        }])
        .unwrap();
    let chat = theodore_contract::ChatMessage {
        id: "m1".into(),
        pr: pr.clone(),
        author: theodore_domain::Author::Agent(AgentId::Claude),
        text: "reply".into(),
        refs: vec![],
        usage: Some(Usage {
            input_tokens: 0,
            output_tokens: 0,
            usd: 1.5,
        }),
        at: 0,
    };
    f.store
        .apply(vec![NewAction {
            model: models::CHAT_MESSAGE.into(),
            model_id: "m1".into(),
            action: SyncActionCode::I,
            data: Some(serde_json::to_value(&chat).unwrap()),
        }])
        .unwrap();

    let spend = core.pr_spend(pr).await.expect("pr_spend");
    assert!((spend.usage.usd - 3.5).abs() < 1e-9);
    assert_eq!(spend.budget_usd, None);
}

#[tokio::test]
async fn run_skill_refuses_once_the_per_pr_budget_is_reached() {
    let f = fixtures();
    let (core, mut recv, pr, _head) = open_fixture_pr(&f).await;
    put_setting(&f, "budget.per_pr_usd", "user", json!(1.0));
    f.store
        .apply(vec![NewAction {
            model: models::SKILL_RUN.into(),
            model_id: "run-1".into(),
            action: SyncActionCode::I,
            data: Some(serde_json::to_value(skill_run_row("run-1", &pr, 2.0)).unwrap()),
        }])
        .unwrap();

    let err = core
        .run_skill(RunSkillRequest {
            pr,
            skill: "bugs".into(),
            agents: vec![],
        })
        .await
        .unwrap_err();
    assert!(err.to_string().contains("budget"));
    let event = expect_ephemeral(&mut recv, |e| {
        matches!(
            e,
            Ephemeral::Toast {
                level: ToastLevel::Error,
                ..
            }
        )
    })
    .await;
    assert!(matches!(event, Ephemeral::Toast { .. }));
}

// ── repo settings (.review/config.yaml) ──────────────────────────────────────

#[tokio::test]
async fn repo_settings_yaml_overrides_the_user_scoped_agent_setting() {
    let f = fixtures();
    // A head unique to this test (not the shared `head111` every other test
    // in this file uses): its worktree directory is therefore private, so
    // the `.review/config.yaml` planted here can never leak into — or be
    // raced by — another test running concurrently in the same process.
    let head = Sha::new("repo-settings-head");
    let base = Sha::new("repo-settings-base");
    f.git.set_head(head.clone());
    let pr_ref = fixture_pr_ref();
    let detail = testkit::sample_pr_detail(&pr_ref, &base, &head);
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("etag-repo-settings".into()),
        value: detail,
    }));

    let config_dir = worktree_dir(&head).join(".review");
    std::fs::create_dir_all(&config_dir).unwrap();
    let _cleanup = RemoveOnDrop(worktree_dir(&head));
    std::fs::write(
        config_dir.join("config.yaml"),
        "agents:\n  grouping: codex\nbudget:\n  per_pr_usd: 3.5\n",
    )
    .unwrap();

    let (core, _recv) = Core::start(f.deps());
    core.open_pr(OpenPrRequest {
        url: "https://github.com/acme/widgets/pull/7".into(),
    })
    .await
    .expect("open_pr");

    let rows = f
        .store
        .query(models::SETTING, "key", "agents.grouping")
        .unwrap();
    let repo_row = rows
        .iter()
        .find(|r| r.data["scope"] == json!("repo:acme/widgets"))
        .expect("repo-scoped agents.grouping row");
    assert_eq!(repo_row.data["value"], json!("codex"));

    let budget_rows = f
        .store
        .query(models::SETTING, "key", "budget.per_pr_usd")
        .unwrap();
    assert!(
        budget_rows
            .iter()
            .any(|r| r.data["scope"] == json!("repo:acme/widgets") && r.data["value"] == json!(3.5))
    );

    wait_until(|| f.grouper.last_agent() == Some(AgentId::Codex)).await;
}

// ── bootstrap must not block the async executor ──────────────────────────

/// Wraps a `Store` whose `last_sync_id` blocks the calling thread for a
/// while, standing in for a slow disk. If `bootstrap` ever calls it without
/// `spawn_blocking`, that block lands on the async executor thread itself.
struct SlowLastSyncId(Arc<testkit::FakeStore>);

/// How long `SlowLastSyncId::last_sync_id` blocks its calling thread for —
/// comfortably longer than the measurement window below so a stolen async
/// worker thread shows up unmistakably.
const SLOW_STORE_BLOCK: Duration = Duration::from_millis(300);

impl Store for SlowLastSyncId {
    fn apply(
        &self,
        actions: Vec<NewAction>,
    ) -> theodore_ports::StoreResult<Vec<theodore_ports::SyncAction>> {
        self.0.apply(actions)
    }
    fn last_sync_id(&self) -> theodore_ports::StoreResult<u64> {
        std::thread::sleep(SLOW_STORE_BLOCK);
        self.0.last_sync_id()
    }
    fn since(
        &self,
        sync_id: u64,
        limit: u32,
    ) -> theodore_ports::StoreResult<Vec<theodore_ports::SyncAction>> {
        self.0.since(sync_id, limit)
    }
    fn get(
        &self,
        model: &str,
        id: &str,
    ) -> theodore_ports::StoreResult<Option<theodore_ports::ModelRow>> {
        self.0.get(model, id)
    }
    fn query(
        &self,
        model: &str,
        field: &str,
        value: &str,
    ) -> theodore_ports::StoreResult<Vec<theodore_ports::ModelRow>> {
        self.0.query(model, field, value)
    }
    fn all(&self, model: &str) -> theodore_ports::StoreResult<Vec<theodore_ports::ModelRow>> {
        self.0.all(model)
    }
    fn outbox_push(
        &self,
        op: &str,
        payload: serde_json::Value,
    ) -> theodore_ports::StoreResult<u64> {
        self.0.outbox_push(op, payload)
    }
    fn outbox_take(
        &self,
        now: i64,
    ) -> theodore_ports::StoreResult<Option<theodore_ports::OutboxItem>> {
        self.0.outbox_take(now)
    }
    fn outbox_done(&self, id: u64) -> theodore_ports::StoreResult<()> {
        self.0.outbox_done(id)
    }
    fn outbox_retry(&self, id: u64, not_before: i64) -> theodore_ports::StoreResult<()> {
        self.0.outbox_retry(id, not_before)
    }
    fn outbox_fail(&self, id: u64) -> theodore_ports::StoreResult<()> {
        self.0.outbox_fail(id)
    }
    fn kv_get(&self, key: &str) -> theodore_ports::StoreResult<Option<serde_json::Value>> {
        self.0.kv_get(key)
    }
    fn kv_set(&self, key: &str, value: &serde_json::Value) -> theodore_ports::StoreResult<()> {
        self.0.kv_set(key, value)
    }
}

#[tokio::test(flavor = "current_thread")]
async fn bootstrap_does_not_block_the_executor_on_a_slow_store() {
    // `current_thread`: the whole runtime (task polling + the timer that
    // drives `tokio::time::sleep`) runs on exactly one OS thread. If
    // `bootstrap` ever calls a blocking `Store` method inline instead of
    // through `spawn_blocking`, that call captures the only thread for its
    // whole duration and even an unrelated 5ms timer can't fire until it's
    // done.
    let f = fixtures();
    let mut deps = f.deps();
    deps.store = Arc::new(SlowLastSyncId(f.store.clone()));
    let (core, _recv) = Core::start(deps);

    let core2 = core.clone();
    let bootstrap = tokio::spawn(async move { core2.bootstrap(BootstrapScope::Global).await });

    // 20 x 5ms = 100ms nominal. If the executor's single thread is ever
    // stolen for `SLOW_STORE_BLOCK` (300ms) by an un-`spawn_blocking`ed
    // call, this loop's total wall time jumps well past that, regardless
    // of exactly when the stolen call lands relative to this loop.
    let start = std::time::Instant::now();
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let elapsed = start.elapsed();
    assert!(
        elapsed < Duration::from_millis(200),
        "20x5ms timers took {elapsed:?}: bootstrap blocked the executor"
    );

    bootstrap.await.unwrap().expect("bootstrap");
}
