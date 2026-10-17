//! Integration-style tests against `Core` + `testkit` fakes, per the
//! coverage list in the agent brief for this slice.

use std::time::Duration;

use serde_json::json;
use theodore_contract::{
    BootstrapScope, Ephemeral, FileViewedRow, HunkRead, MutationOp, OpenPrRequest, RevisionRequest,
    RunSkillRequest, ToastLevel, Transaction, TransactionResult, models,
};
use theodore_domain::{
    AgentId, FileDiff, HostKind, HunkId, PrId, PrRef, RepoRef, Revision, Sha, Usage, ViewedState,
};
use theodore_ports::{AgentEvent, Fetched, HostError, OutboxStatus, Store};

use crate::testkit::{self, Fixtures, fixtures};
use crate::{Core, Receivers};

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
