//! Core end-to-end tests (plan §12, §12.1): the real `app` + `domain`
//! driven through `theodore_runtime::start` on the fixture adapters, the
//! same way the UI drives it over IPC. No test reaches into `Core`'s
//! internals — everything goes through `bootstrap`, `transact` and the
//! command methods.
//!
//! Every wait on a condition below first drains the sync stream through
//! [`SyncWatcher`], which asserts that `(from_sync_id, last_sync_id]` never
//! has a gap: every frame picks up exactly where the previous one left off.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::Duration;

use theodore_app::Receivers;
use theodore_contract::{
    BootstrapScope, FileViewedRow, HunkRead, MutationOp, OpenPrRequest, RevisionRequest,
    RunSkillRequest, RunStatus, SubmitReviewRequest, Transaction, TransactionResult, models,
};
use theodore_domain::{
    AgentId, Anchor, Author, Draft, DraftId, FindingState, Grouping, HostKind, HunkId, PrId, PrRef,
    RepoRef, ReviewEvent, Sha, Side, ViewedState,
};
use theodore_runtime::{Runtime, RuntimeConfig};
use tokio::sync::broadcast::error::TryRecvError;

fn demo_dir() -> PathBuf {
    // `crates/fixtures` is a sibling of `crates/runtime`, not a dependency
    // this crate's `CARGO_MANIFEST_DIR` points inside.
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures/data/demo")
}

/// PR #101 from the demo set (`crates/fixtures/examples/gen.rs`): a webhook
/// retry-with-backoff change, pushed once from `head-479-1` to `head-479-2`.
const PR_URL: &str = "https://github.com/octo/webhooks/pull/101";

fn demo_pr_ref() -> PrRef {
    PrRef {
        repo: RepoRef {
            host: HostKind::Github,
            owner: "octo".into(),
            name: "webhooks".into(),
        },
        number: 101,
        host_id: Some("gh_101".into()),
    }
}

// Hunk ids baked into `crates/fixtures/data/demo/git/octo_webhooks_101/*.json`
// (content hashes, stable across regenerations as long as the diff text in
// `gen.rs` doesn't change).
const DELIVER_HUNK: &str = "1443083b5def4ff9";
const BACKOFF_HUNK_V1: &str = "d54b711f20787c68";
const BACKOFF_HUNK_V2: &str = "299c547d8e70c961";
const TEST_HUNK: &str = "aca3d6e37ea345d7";

const HEAD_1: &str = "head-479-1";
const HEAD_2: &str = "head-479-2";

async fn start_demo() -> (Runtime, tempfile::TempDir) {
    let data_dir = tempfile::tempdir().expect("tempdir");
    let cfg = RuntimeConfig {
        data_dir: data_dir.path().to_path_buf(),
        fixtures: Some(demo_dir()),
        sandbox: None,
        build_env: theodore_runtime::BuildEnv::Dev,
    };
    let runtime = theodore_runtime::start(&cfg).await.expect("runtime starts");
    (runtime, data_dir)
}

/// Asserts the sync stream is gap-free: every drained frame's
/// `from_sync_id` must equal the previous frame's `last_sync_id`.
struct SyncWatcher {
    next_from: u64,
    frames_seen: u64,
}

impl SyncWatcher {
    fn new() -> Self {
        Self {
            next_from: 0,
            frames_seen: 0,
        }
    }

    fn drain(&mut self, recv: &mut Receivers) {
        loop {
            match recv.sync.try_recv() {
                Ok(frame) => {
                    assert_eq!(
                        frame.from_sync_id, self.next_from,
                        "sync frame gap: frame {}..{} does not continue from {}",
                        frame.from_sync_id, frame.last_sync_id, self.next_from
                    );
                    self.next_from = frame.last_sync_id;
                    self.frames_seen += 1;
                }
                Err(TryRecvError::Empty) | Err(TryRecvError::Closed) => return,
                Err(TryRecvError::Lagged(n)) => {
                    panic!("sync receiver lagged by {n} frames; drain more often")
                }
            }
        }
    }
}

/// Polls `probe` every 10ms (draining the sync stream on every attempt)
/// until it returns `Some`, or panics after ~5s.
async fn wait_for<T, F, Fut>(recv: &mut Receivers, watcher: &mut SyncWatcher, mut probe: F) -> T
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Option<T>>,
{
    for _ in 0..500 {
        watcher.drain(recv);
        if let Some(v) = probe().await {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("condition not met within the timeout");
}

async fn pr_row<T: serde::de::DeserializeOwned>(
    core: &theodore_app::Core,
    pr: &PrId,
    model: &str,
) -> Option<T> {
    let bootstrap = core.bootstrap(BootstrapScope::Pr(pr.clone())).await.ok()?;
    bootstrap
        .rows
        .into_iter()
        .find(|r| r.model == model)
        .and_then(|r| serde_json::from_value(r.data).ok())
}

async fn pr_rows<T: serde::de::DeserializeOwned>(
    core: &theodore_app::Core,
    pr: &PrId,
    model: &str,
) -> Vec<T> {
    let Ok(bootstrap) = core.bootstrap(BootstrapScope::Pr(pr.clone())).await else {
        return Vec::new();
    };
    bootstrap
        .rows
        .into_iter()
        .filter(|r| r.model == model)
        .filter_map(|r| serde_json::from_value(r.data).ok())
        .collect()
}

fn hunk_read_tx(n: &str, pr: &PrId, hunk: &HunkId) -> Transaction {
    Transaction {
        id: n.into(),
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

/// Opens PR #101, reads `backoff.ts`'s one hunk (so it goes Viewed and a
/// `set_viewed` outbox item is sent), comments on `deliver.ts` and submits
/// the review — the state every later step in this file builds on.
async fn open_and_review(
    core: &theodore_app::Core,
    recv: &mut Receivers,
    watcher: &mut SyncWatcher,
    host: &theodore_fixtures::FixtureHost,
) -> PrId {
    let resp = core
        .open_pr(OpenPrRequest { url: PR_URL.into() })
        .await
        .expect("open_pr");
    let pr = resp.pr.clone();
    assert_eq!(resp.head, Sha::new(HEAD_1));
    watcher.drain(recv);

    // The grouping arrives as a background sync row and must be a valid
    // partition of the revision's hunks (plan §5.1), matching the recorded
    // `grouping.jsonl` script exactly since the real grouping pipeline's
    // prompt is now recognized by `ReplayAgents`.
    let grouping: Grouping = wait_for(recv, watcher, || {
        let core = core.clone();
        let pr = pr.clone();
        async move { pr_row(&core, &pr, models::GROUPING).await }
    })
    .await;
    let revision = core
        .get_revision(RevisionRequest {
            pr: pr.clone(),
            head: Sha::new(HEAD_1),
        })
        .await
        .expect("get_revision");
    theodore_domain::grouping::validate(&revision, &grouping)
        .expect("fixture grouping must validate against the revision");
    let g1 = grouping
        .groups
        .iter()
        .find(|g| g.id.as_str() == "g1")
        .expect("g1 present");
    assert!(g1.hunks.contains(&HunkId::new(DELIVER_HUNK)));
    assert!(g1.hunks.contains(&HunkId::new(BACKOFF_HUNK_V1)));
    let g2 = grouping
        .groups
        .iter()
        .find(|g| g.id.as_str() == "g2")
        .expect("g2 present");
    assert_eq!(g2.hunks, vec![HunkId::new(TEST_HUNK)]);

    // Read `backoff.ts`'s only hunk: the file has exactly one, so this
    // single transaction must flip it to Viewed and enqueue `set_viewed`.
    let backoff_hunk = HunkId::new(BACKOFF_HUNK_V1);
    let result = core
        .transact(hunk_read_tx("read-backoff", &pr, &backoff_hunk))
        .await;
    assert!(
        matches!(result, TransactionResult::Ok { .. }),
        "expected Ok, got {result:?}"
    );

    let viewed: FileViewedRow = wait_for(recv, watcher, || {
        let core = core.clone();
        let pr = pr.clone();
        async move {
            pr_rows::<FileViewedRow>(&core, &pr, models::FILE_VIEWED)
                .await
                .into_iter()
                .find(|r| r.path == "src/webhooks/backoff.ts" && r.state == ViewedState::Viewed)
        }
    })
    .await;
    assert_eq!(viewed.state, ViewedState::Viewed);
    wait_for(recv, watcher, || {
        let ok = host
            .calls()
            .iter()
            .any(|c| c.method == "set_viewed" && c.details.contains("backoff.ts"));
        async move { ok.then_some(()) }
    })
    .await;

    // Comment on a commentable line of `deliver.ts` and submit the review.
    let anchor = Anchor {
        rev: Sha::new(HEAD_1),
        path: "src/webhooks/deliver.ts".into(),
        side: Side::New,
        line: 5,
        start_line: None,
        start_side: None,
    };
    let draft = Draft {
        id: DraftId::new(format!("{}:d1", pr.0)),
        pr: pr.clone(),
        anchor,
        body: "Consider logging which branch this retry takes.".into(),
        source: Author::Me,
        outdated: false,
    };
    let draft_tx = Transaction {
        id: "draft-1".into(),
        ops: vec![MutationOp::Create {
            model: models::DRAFT.into(),
            id: draft.id.0.clone(),
            data: serde_json::to_value(&draft).unwrap(),
        }],
    };
    let result = core.transact(draft_tx).await;
    assert!(
        matches!(result, TransactionResult::Ok { .. }),
        "expected the draft to be accepted (commentable anchor), got {result:?}"
    );

    core.submit_review(SubmitReviewRequest {
        pr: pr.clone(),
        event: ReviewEvent::Comment,
        body: "LGTM with one note.".into(),
    })
    .await
    .expect("submit_review");

    wait_for(recv, watcher, || {
        let ok = host
            .calls()
            .iter()
            .any(|c| c.method == "submit_review" && c.details.contains("comments=1"));
        async move { ok.then_some(()) }
    })
    .await;

    let threads: Vec<theodore_domain::Thread> = wait_for(recv, watcher, || {
        let core = core.clone();
        let pr = pr.clone();
        async move {
            let rows = pr_rows::<theodore_domain::Thread>(&core, &pr, models::THREAD).await;
            (!rows.is_empty()).then_some(rows)
        }
    })
    .await;
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].comments.len(), 1);

    let drafts: Vec<serde_json::Value> = {
        let bootstrap = core
            .bootstrap(BootstrapScope::Pr(pr.clone()))
            .await
            .unwrap();
        bootstrap
            .rows
            .into_iter()
            .filter(|r| r.model == models::DRAFT)
            .map(|r| serde_json::json!({"id": r.id, "archived": r.archived}))
            .collect()
    };
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0]["archived"], serde_json::json!(true));

    pr
}

#[tokio::test]
async fn core_review_round_trip_through_a_push_and_a_skill_run() {
    let (runtime, _data_dir) = start_demo().await;
    let Runtime {
        core,
        mut receivers,
        triggers,
        fixture_clock,
        fixture_host,
        ..
    } = runtime;
    let triggers = triggers.expect("fixture triggers");
    let clock = fixture_clock.expect("fixture clock");
    let host = fixture_host.expect("fixture host");
    let mut watcher = SyncWatcher::new();

    let pr = open_and_review(&core, &mut receivers, &mut watcher, &host).await;

    // ── author push: head-479-1 -> head-479-2 (backoff.ts changes) ─────
    let pr_ref = demo_pr_ref();
    triggers
        .author_push(&pr_ref, Sha::new(HEAD_2))
        .expect("author_push");
    // Wakes the poller's next real-time tick past its `Clock`-measured due
    // time (plan §6.6's `OPEN_PR_POLL_MS`), without a real 15s wait.
    clock.advance(15_000);

    // The pushed-to-dismissed file lost its read (its hunk's content, and
    // so its id, changed) and the file drops out of Viewed.
    let dismissed: FileViewedRow = wait_for(&mut receivers, &mut watcher, || {
        let core = core.clone();
        let pr = pr.clone();
        async move {
            pr_rows::<FileViewedRow>(&core, &pr, models::FILE_VIEWED)
                .await
                .into_iter()
                .find(|r| r.path == "src/webhooks/backoff.ts" && r.state == ViewedState::Dismissed)
        }
    })
    .await;
    assert_eq!(dismissed.state, ViewedState::Dismissed);

    let reads = pr_rows::<HunkRead>(&core, &pr, models::HUNK_READ).await;
    assert!(
        reads.is_empty(),
        "the only read was of the changed hunk; it must be cleared, got {reads:?}"
    );

    // Regroup: the unchanged groups (and their unchanged hunks) survive;
    // the changed hunk is placed back into g1 by the regroup script.
    let grouping: Grouping = wait_for(&mut receivers, &mut watcher, || {
        let core = core.clone();
        let pr = pr.clone();
        async move {
            pr_row::<Grouping>(&core, &pr, models::GROUPING)
                .await
                .filter(|g| g.rev == Sha::new(HEAD_2))
        }
    })
    .await;
    let new_revision = core
        .get_revision(RevisionRequest {
            pr: pr.clone(),
            head: Sha::new(HEAD_2),
        })
        .await
        .expect("get_revision (head 2)");
    theodore_domain::grouping::validate(&new_revision, &grouping)
        .expect("regrouping must still validate");
    let g1 = grouping
        .groups
        .iter()
        .find(|g| g.id.as_str() == "g1")
        .expect("g1 survives the push");
    assert!(
        g1.hunks.contains(&HunkId::new(DELIVER_HUNK)),
        "g1 keeps its unchanged hunk"
    );
    assert!(
        g1.hunks.contains(&HunkId::new(BACKOFF_HUNK_V2)),
        "the changed hunk is placed back into g1 by the regroup script, got {:?}",
        g1.hunks
    );
    let g2 = grouping
        .groups
        .iter()
        .find(|g| g.id.as_str() == "g2")
        .expect("g2 survives the push untouched");
    assert_eq!(g2.hunks, vec![HunkId::new(TEST_HUNK)]);

    // ── run_skill → a real MCP `add_finding` call → a `finding` row ─────
    let run_id = core
        .run_skill(RunSkillRequest {
            pr: pr.clone(),
            skill: "security".into(),
            agents: vec![AgentId::Claude],
        })
        .await
        .expect("run_skill");

    let run: theodore_contract::SkillRun = wait_for(&mut receivers, &mut watcher, || {
        let core = core.clone();
        let pr = pr.clone();
        let run_id = run_id.clone();
        async move {
            pr_row::<theodore_contract::SkillRun>(&core, &pr, models::SKILL_RUN)
                .await
                .filter(|r| r.id == run_id && r.status == RunStatus::Done)
        }
    })
    .await;
    assert_eq!(run.status, RunStatus::Done);

    let finding: theodore_domain::Finding = wait_for(&mut receivers, &mut watcher, || {
        let core = core.clone();
        let pr = pr.clone();
        async move {
            pr_rows::<theodore_domain::Finding>(&core, &pr, models::FINDING)
                .await
                .into_iter()
                .find(|f| f.title == "Backoff has no upper bound")
        }
    })
    .await;
    assert_eq!(finding.state, FindingState::Open);
    assert_eq!(finding.anchor.path, "src/webhooks/deliver.ts");
    assert_eq!(finding.agents, vec![AgentId::Claude]);

    watcher.drain(&mut receivers);
    assert!(
        watcher.frames_seen > 0,
        "expected at least one contiguous sync frame over the whole run"
    );
}

#[tokio::test]
async fn cancel_run_stops_a_skill_run_before_it_finishes() {
    let (runtime, _data_dir) = start_demo().await;
    let Runtime {
        core,
        mut receivers,
        fixture_host,
        ..
    } = runtime;
    let host = fixture_host.expect("fixture host");
    let mut watcher = SyncWatcher::new();
    let pr = open_and_review(&core, &mut receivers, &mut watcher, &host).await;

    // `slow-skill` plays a script whose first event has a multi-second
    // delay (see `ReplayAgents`'s rule list and `agents/<id>/slow.jsonl`),
    // so cancelling right away is guaranteed to land before any `Done`.
    let run_id = core
        .run_skill(RunSkillRequest {
            pr: pr.clone(),
            skill: "slow-skill".into(),
            agents: vec![AgentId::Claude],
        })
        .await
        .expect("run_skill");
    core.cancel_run(run_id.clone()).await.expect("cancel_run");

    let run: theodore_contract::SkillRun = wait_for(&mut receivers, &mut watcher, || {
        let core = core.clone();
        let pr = pr.clone();
        let run_id = run_id.clone();
        async move {
            pr_row::<theodore_contract::SkillRun>(&core, &pr, models::SKILL_RUN)
                .await
                .filter(|r| r.id == run_id && r.status == RunStatus::Cancelled)
        }
    })
    .await;
    assert_eq!(run.status, RunStatus::Cancelled);
}

#[tokio::test]
async fn agent_crash_trigger_fails_the_skill_run() {
    let (runtime, _data_dir) = start_demo().await;
    let Runtime {
        core,
        mut receivers,
        triggers,
        fixture_host,
        ..
    } = runtime;
    let triggers = triggers.expect("fixture triggers");
    let host = fixture_host.expect("fixture host");
    let mut watcher = SyncWatcher::new();
    let pr = open_and_review(&core, &mut receivers, &mut watcher, &host).await;

    triggers.agent_crash(AgentId::Claude);
    let run_id = core
        .run_skill(RunSkillRequest {
            pr: pr.clone(),
            skill: "security".into(),
            agents: vec![AgentId::Claude],
        })
        .await
        .expect("run_skill");

    let run: theodore_contract::SkillRun = wait_for(&mut receivers, &mut watcher, || {
        let core = core.clone();
        let pr = pr.clone();
        let run_id = run_id.clone();
        async move {
            pr_row::<theodore_contract::SkillRun>(&core, &pr, models::SKILL_RUN)
                .await
                .filter(|r| r.id == run_id && r.status == RunStatus::Failed)
        }
    })
    .await;
    assert_eq!(run.status, RunStatus::Failed);
    assert!(run.error.is_some());
}
