//! `Core` end to end against the sandbox host (docs/sandbox.md): the real
//! app, store and `GitCli` over local bare repos, deterministic agents. No
//! network, no tokens.

use std::future::Future;
use std::time::Duration;

use theodore_app::{Core, Receivers};
use theodore_contract::{
    BootstrapScope, DelegateRequest, Ephemeral, InterdiffClass, InterdiffRequest, MergeMethod,
    MergeRequest, MutationOp, OpenPrRequest, ReplyRequest, SubmitReviewRequest, TaskDecision,
    Transaction, TransactionResult, models,
};
use theodore_domain::{
    Anchor, Assignee, Author, Draft, DraftId, Grouping, PrDetail, PrId, PrState, ReviewEvent, Sha,
    Side, Task, TaskId, TaskStatus,
};
use theodore_ports::HostAdapter;
use theodore_runtime::{Runtime, RuntimeConfig};
use theodore_sandbox::{AgentsMode, Sandbox, Scenario, default_scenario, state::ReviewState};

async fn start() -> (Runtime, tempfile::TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    let scenario_dir = tmp.path().join("scenario");
    default_scenario::write(&scenario_dir).unwrap();
    let mut scenario = Scenario::load(&scenario_dir).unwrap();
    scenario.agents = AgentsMode::Replay;
    scenario.save(&scenario_dir).unwrap();
    let cfg = RuntimeConfig {
        data_dir: tmp.path().join("data"),
        fixtures: None,
        sandbox: Some(scenario_dir),
        build_env: theodore_runtime::BuildEnv::Dev,
    };
    let rt = theodore_runtime::start(&cfg)
        .await
        .expect("sandbox runtime starts");
    (rt, tmp)
}

fn sandbox(rt: &Runtime) -> &Sandbox {
    rt.sandbox.as_ref().expect("sandbox mode")
}

/// Polls `probe` every 50ms until it returns `Some`, or panics after `secs`.
async fn wait_for<T, F, Fut>(secs: u64, what: &str, mut probe: F) -> T
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Option<T>>,
{
    let deadline = std::time::Instant::now() + Duration::from_secs(secs);
    while std::time::Instant::now() < deadline {
        if let Some(v) = probe().await {
            return v;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting for {what}");
}

/// Up to 40 s: the open-PR poller ticks every 15 s of wall time.
async fn expect_ephemeral(recv: &mut Receivers, what: &str, f: impl Fn(&Ephemeral) -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(40);
    while std::time::Instant::now() < deadline {
        while let Ok(e) = recv.ephemeral.try_recv() {
            if f(&e) {
                return;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("no ephemeral event: {what}");
}

async fn row<T: serde::de::DeserializeOwned>(core: &Core, pr: &PrId, model: &str) -> Option<T> {
    core.bootstrap(BootstrapScope::Pr(pr.clone()))
        .await
        .ok()?
        .rows
        .into_iter()
        .find(|r| r.model == model)
        .and_then(|r| serde_json::from_value(r.data).ok())
}

/// `pr`, `task`, `project`… rows live in the global scope.
async fn global_row<T: serde::de::DeserializeOwned>(
    core: &Core,
    model: &str,
    id: &str,
) -> Option<T> {
    core.bootstrap(BootstrapScope::Global)
        .await
        .ok()?
        .rows
        .into_iter()
        .find(|r| r.model == model && r.id == id)
        .and_then(|r| serde_json::from_value(r.data).ok())
}

async fn open(core: &Core, url: &str) -> (PrId, Sha) {
    let resp = core
        .open_pr(OpenPrRequest { url: url.into() })
        .await
        .expect("open_pr");
    (resp.pr, resp.head)
}

fn ok(result: TransactionResult) {
    assert!(matches!(result, TransactionResult::Ok { .. }), "{result:?}");
}

fn sandbox_pr(st: &theodore_sandbox::state::State, number: u64) -> &theodore_sandbox::state::PrRec {
    st.prs.iter().find(|p| p.number == number).unwrap()
}

#[tokio::test]
async fn review_reply_and_merge_land_on_the_host_and_move_git() {
    let (rt, _tmp) = start().await;
    let core = rt.core.clone();
    let sb = sandbox(&rt);

    // Open + group (deterministic agents).
    let (pr, head) = open(&core, "acme/storefront#101").await;
    let grouping: Grouping = wait_for(20, "grouping", || {
        let core = core.clone();
        let pr = pr.clone();
        async move { row(&core, &pr, models::GROUPING).await }
    })
    .await;
    let revision = core
        .get_revision(theodore_contract::RevisionRequest {
            pr: pr.clone(),
            head: head.clone(),
        })
        .await
        .unwrap();
    theodore_domain::grouping::validate(&revision, &grouping).expect("a valid grouping");

    // Draft + submit review.
    let draft = Draft {
        id: DraftId::new(format!("{}:d1", pr.0)),
        pr: pr.clone(),
        anchor: Anchor {
            rev: head.clone(),
            path: "src/lib/cart.ts".into(),
            side: Side::New,
            line: 13,
            start_line: None,
            start_side: None,
        },
        body: "Name this `raw` something clearer?".into(),
        source: Author::Me,
        outdated: false,
    };
    ok(core
        .transact(Transaction {
            id: "d1".into(),
            ops: vec![MutationOp::Create {
                model: models::DRAFT.into(),
                id: draft.id.0.clone(),
                data: serde_json::to_value(&draft).unwrap(),
            }],
        })
        .await);
    core.submit_review(SubmitReviewRequest {
        pr: pr.clone(),
        event: ReviewEvent::Approve,
        body: "Ship it.".into(),
    })
    .await
    .unwrap();
    wait_for(20, "the review on the host", || {
        let st = sb.world().snapshot();
        let p = sandbox_pr(&st, 101);
        let ok = p
            .reviews
            .iter()
            .any(|r| r.user == "sam" && r.state == ReviewState::Approved)
            && p.threads.iter().any(|t| {
                t.comments
                    .iter()
                    .any(|c| c.body.contains("<!-- theodore:") && c.body.contains("clearer"))
            });
        async move { ok.then_some(()) }
    })
    .await;

    // Reply on lee's thread.
    let detail: PrDetail = row(&core, &pr, models::PR_DETAIL).await.unwrap();
    let thread = detail
        .threads
        .iter()
        .find(|t| t.comments[0].author.login == "lee")
        .unwrap()
        .id
        .clone();
    core.reply_thread(ReplyRequest {
        pr: pr.clone(),
        thread: thread.clone(),
        body: "Half-even it is.".into(),
    })
    .await
    .unwrap();
    wait_for(20, "the reply on the host", || {
        let st = sb.world().snapshot();
        let ok = sandbox_pr(&st, 101)
            .threads
            .iter()
            .any(|t| t.id == thread.0 && t.comments.iter().any(|c| c.body.contains("Half-even")));
        async move { ok.then_some(()) }
    })
    .await;

    // Merge the viewer's approved PR: the base branch moves in git.
    let bare = sb.world().bare("acme", "storefront");
    let main_before = bare.branch_tip("main").unwrap();
    let (own, own_head) = open(&core, "acme/storefront#110").await;
    let info = core.merge_info(own.clone()).await.unwrap();
    assert_eq!(info.mergeable, Some(true));
    core.merge_pr(MergeRequest {
        pr: own.clone(),
        method: MergeMethod::Merge,
        title: None,
        body: None,
        auto: false,
        queue: false,
    })
    .await
    .unwrap();
    // On the host, not the `pr` row: a project or inbox refresh that
    // searched before the merge can land after it and write the PR back as
    // open (a stale-write race in the app, not the host).
    wait_for(20, "the merge on the host", || {
        let st = sb.world().snapshot();
        let ok = sandbox_pr(&st, 110).state == PrState::Merged;
        async move { ok.then_some(()) }
    })
    .await;
    let main_after = bare.branch_tip("main").unwrap();
    assert_ne!(main_after, main_before, "the base branch moved");
    assert!(
        bare.is_ancestor(&own_head.0, &main_after),
        "head is merged into main"
    );
    assert!(bare.is_ancestor(&main_before, &main_after));
}

#[tokio::test]
async fn auth_and_rate_limit_faults_reach_the_ui_status() {
    let (mut rt, _tmp) = start().await;
    let core = rt.core.clone();
    let (pr, _) = open(&core, "acme/storefront#101").await;
    let detail: PrDetail = row(&core, &pr, models::PR_DETAIL).await.unwrap();
    let thread = detail.threads[0].id.clone();
    assert!(core.host_status().await.unwrap().connected);

    let sb = sandbox(&rt).clone();
    sb.set_fault("auth", true, None).unwrap();
    assert!(!core.host_status().await.unwrap().connected);
    core.reply_thread(ReplyRequest {
        pr: pr.clone(),
        thread: thread.clone(),
        body: "while signed out".into(),
    })
    .await
    .unwrap();
    expect_ephemeral(&mut rt.receivers, "auth_ok false", |e| {
        matches!(e, Ephemeral::HostStatus { auth_ok: false, .. })
    })
    .await;
    sb.set_fault("auth", false, None).unwrap();

    sb.set_fault("rate_limit", true, Some(120.0)).unwrap();
    core.reply_thread(ReplyRequest {
        pr: pr.clone(),
        thread,
        body: "while rate limited".into(),
    })
    .await
    .unwrap();
    expect_ephemeral(
        &mut rt.receivers,
        "rate_limited_until",
        |e| matches!(e, Ephemeral::HostStatus { rate_limited_until: Some(t), .. } if *t > 0),
    )
    .await;
}

#[tokio::test]
async fn a_timeline_push_is_polled_and_interdiff_sees_the_changed_hunk() {
    let (mut rt, _tmp) = start().await;
    let core = rt.core.clone();
    let (pr, first_head) = open(&core, "acme/storefront#101").await;
    let msg = sandbox(&rt).fire("push-101").unwrap();
    assert!(msg.starts_with("pushed"), "{msg}");

    // The open-PR poller notices within one 15 s tick and runs the push
    // pipeline (fetch, diff, regroup), which ends in a "pushed" toast.
    expect_ephemeral(
        &mut rt.receivers,
        "the push toast",
        |e| matches!(e, Ephemeral::Toast { text, .. } if text.contains("pushed")),
    )
    .await;
    let entries = core
        .interdiff(InterdiffRequest {
            pr: pr.clone(),
            base_sha: first_head,
            file: None,
        })
        .await
        .unwrap();
    assert!(
        entries
            .iter()
            .any(|e| e.path == "src/lib/cart.ts" && e.class == InterdiffClass::Changed),
        "{entries:?}"
    );
}

#[tokio::test]
async fn an_accepted_agent_fix_is_committed_pushed_and_seen_by_the_host() {
    let (rt, _tmp) = start().await;
    let core = rt.core.clone();
    let sb = sandbox(&rt);
    let (pr, head) = open(&core, "acme/storefront#111").await;

    let task = Task {
        id: TaskId::new(format!("{}:t1", pr.0)),
        pr: pr.clone(),
        title: "Trim coupon codes".into(),
        body: "Whitespace-only codes pass validation in src/lib/coupons.ts.".into(),
        anchor: Some(Anchor {
            rev: head.clone(),
            path: "src/lib/coupons.ts".into(),
            side: Side::New,
            line: 7,
            start_line: None,
            start_side: None,
        }),
        thread: None,
        status: TaskStatus::Todo,
        assignee: Assignee::Human("sam".into()),
        fix: None,
        created_at: 0,
        outdated: false,
    };
    ok(core
        .transact(Transaction {
            id: "t1".into(),
            ops: vec![MutationOp::Create {
                model: models::TASK.into(),
                id: task.id.0.clone(),
                data: serde_json::to_value(&task).unwrap(),
            }],
        })
        .await);
    core.delegate_task(DelegateRequest {
        task: task.id.clone(),
        agent: None,
    })
    .await
    .unwrap();
    wait_for(20, "the agent's fix", || {
        let core = core.clone();
        let id = task.id.0.clone();
        async move {
            global_row::<Task>(&core, models::TASK, &id)
                .await
                .filter(|t| {
                    t.status == TaskStatus::Review
                        && t.fix.as_ref().is_some_and(|f| f.patch.is_some())
                })
        }
    })
    .await;
    core.decide_task(TaskDecision {
        task: task.id.clone(),
        accept: true,
        reason: None,
    })
    .await
    .unwrap();

    let bare = sb.world().bare("acme", "storefront");
    let tip = bare.branch_tip("sam/ABC-180-coupons").unwrap();
    assert_ne!(tip, head.0, "the fix was pushed to the head branch");
    let done: Task = global_row(&core, models::TASK, &task.id.0).await.unwrap();
    assert_eq!(done.status, TaskStatus::Done);
    assert_eq!(done.fix.unwrap().commit.unwrap().0, tip);

    let fetched = sb
        .host()
        .get_pr(
            &theodore_domain::PrRef {
                repo: theodore_domain::RepoRef {
                    host: theodore_domain::HostKind::Github,
                    owner: "acme".into(),
                    name: "storefront".into(),
                },
                number: 111,
                host_id: None,
            },
            None,
        )
        .await
        .unwrap();
    let theodore_ports::Fetched::Modified { value, .. } = fetched else {
        panic!("expected a detail")
    };
    assert_eq!(value.summary.head_sha.0, tip, "the host sees the new head");
    assert_eq!(bare.rev_parse("refs/pull/111/head").unwrap(), tip);
}

#[tokio::test]
async fn projects_are_seeded_once_and_the_app_info_marks_the_sandbox() {
    let (rt, _tmp) = start().await;
    let projects = wait_for(20, "seeded projects", || {
        let core = rt.core.clone();
        async move {
            let b = core.bootstrap(BootstrapScope::Global).await.ok()?;
            let n = b.rows.iter().filter(|r| r.model == models::PROJECT).count();
            (n == 3).then_some(n)
        }
    })
    .await;
    assert_eq!(projects, 3);
    assert!(sandbox(&rt).projects_to_seed().is_empty());
    assert_eq!(sandbox(&rt).info().scenario, "default");
}
