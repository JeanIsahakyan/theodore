//! Projects page behaviour against `Core` + `testkit` fakes: a local
//! folder's working state, the poller's background project refresh, and
//! closing a branch review.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::json;
use theodore_contract::{AddProjectRequest, OpenBranchRequest, Project, ProjectStatus, models};
use theodore_domain::{PrId, PrRef, Sha};
use theodore_ports::{Clock, CommitLog, HostError, NewAction, Store, SyncActionCode, WorkingState};

use crate::testkit::{self, Fixtures, fixtures};
use crate::{AppError, Core, Receivers};

/// Up to 10 s: a loaded CI runner (clippy beside the tests) took over 2 s
/// for the poller's first offline round.
async fn wait_until(mut cond: impl FnMut() -> bool) {
    for _ in 0..2000 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("condition not met in time");
}

async fn started_core(f: &Fixtures) -> (Core, Receivers) {
    let (core, recv) = Core::start(f.deps());
    // Let the startup inbox refresh drain: it shares `FakeHost`'s search
    // queue with a project's own refresh.
    tokio::time::sleep(Duration::from_millis(30)).await;
    (core, recv)
}

async fn ready_project(core: &Core, f: &Fixtures, req: AddProjectRequest) -> Project {
    let project = core.add_project(req).await.expect("add_project");
    wait_until(|| {
        f.store
            .get(models::PROJECT, &project.id)
            .unwrap()
            .is_some_and(|r| r.data["status"] == json!("ready"))
    })
    .await;
    project
}

async fn local_project(core: &Core, f: &Fixtures, path: &str) -> Project {
    ready_project(
        core,
        f,
        AddProjectRequest {
            repo: None,
            path: Some(path.into()),
        },
    )
    .await
}

#[tokio::test]
async fn working_state_reads_the_folder_itself() {
    let f = fixtures();
    let (core, _recv) = started_core(&f).await;
    let project = local_project(&core, &f, "/tmp/my-folder").await;
    f.git.set_working_state(WorkingState {
        current_branch: Some("feature".into()),
        dirty_files: 3,
    });

    let state = core
        .project_working_state(&project.id)
        .await
        .expect("project_working_state");

    assert_eq!(state.path, "/tmp/my-folder");
    assert_eq!(state.current_branch.as_deref(), Some("feature"));
    assert_eq!(state.dirty_files, 3);
    // The folder, not the bare mirror (which has no working tree).
    assert_eq!(
        f.git.working_state_calls(),
        vec![PathBuf::from("/tmp/my-folder")]
    );
}

#[tokio::test]
async fn working_state_rejects_a_host_project() {
    let f = fixtures();
    let (core, _recv) = started_core(&f).await;
    let project = ready_project(
        &core,
        &f,
        AddProjectRequest {
            repo: Some(theodore_domain::RepoRef {
                host: theodore_domain::HostKind::Github,
                owner: "acme".into(),
                name: "widgets".into(),
            }),
            path: None,
        },
    )
    .await;

    let err = core.project_working_state(&project.id).await.unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)), "{err:?}");
    assert!(f.git.working_state_calls().is_empty());
}

// ── background refresh (poller) ───────────────────────────────────────────

/// A ready host project written straight to the store (no clone spawned),
/// last fetched at `last_fetched_at`.
async fn seed_host_project(core: &Core, name: &str, last_fetched_at: Option<i64>) -> String {
    let id = format!("github:acme/{name}");
    let project = Project {
        id: id.clone(),
        repo: theodore_domain::RepoRef {
            host: theodore_domain::HostKind::Github,
            owner: "acme".into(),
            name: name.into(),
        },
        path: None,
        status: ProjectStatus::Ready,
        error: None,
        default_branch: Some("main".into()),
        added_at: 0,
        description: None,
        private: false,
        pushed_at: None,
        last_fetched_at,
    };
    core.apply(vec![NewAction {
        model: models::PROJECT.into(),
        model_id: id.clone(),
        action: SyncActionCode::I,
        data: Some(serde_json::to_value(&project).unwrap()),
    }])
    .await
    .expect("seed project");
    id
}

fn last_fetched(f: &Fixtures, id: &str) -> Option<i64> {
    f.store.get(models::PROJECT, id).unwrap().unwrap().data["last_fetched_at"].as_i64()
}

const TEN_MINUTES: i64 = 10 * 60_000;

#[tokio::test]
async fn poller_refreshes_a_stale_host_project_in_the_background() {
    let f = fixtures();
    let (core, _recv) = started_core(&f).await;
    let start = f.clock.now();
    let stale = seed_host_project(&core, "stale", Some(start - TEN_MINUTES - 1)).await;

    f.clock.advance(30_000);

    wait_until(|| last_fetched(&f, &stale) == Some(start + 30_000)).await;
}

#[tokio::test]
async fn poller_staggers_stale_projects_and_skips_fresh_ones() {
    let f = fixtures();
    let (core, _recv) = started_core(&f).await;
    let start = f.clock.now();
    let never = seed_host_project(&core, "never", None).await;
    let old = seed_host_project(&core, "old", Some(start - TEN_MINUTES - 1)).await;
    let fresh = seed_host_project(&core, "fresh", Some(start - 60_000)).await;

    // One per stagger slot, never-fetched first.
    f.clock.advance(30_000);
    wait_until(|| last_fetched(&f, &never).is_some()).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(last_fetched(&f, &old), Some(start - TEN_MINUTES - 1));

    f.clock.advance(30_000);
    wait_until(|| last_fetched(&f, &old) == Some(start + 60_000)).await;

    f.clock.advance(30_000);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(last_fetched(&f, &fresh), Some(start - 60_000));
}

#[tokio::test]
async fn poller_does_not_refresh_local_folders() {
    let f = fixtures();
    let (core, _recv) = started_core(&f).await;
    let project = local_project(&core, &f, "/tmp/my-folder").await;
    let before = last_fetched(&f, &project.id);

    f.clock.advance(TEN_MINUTES + 30_000);
    tokio::time::sleep(Duration::from_millis(150)).await;

    assert_eq!(last_fetched(&f, &project.id), before);
}

#[tokio::test]
async fn poller_skips_project_refresh_while_offline() {
    let f = fixtures();
    for _ in 0..5 {
        f.host
            .push_changed_since(Err(HostError::Network("offline".into())));
    }
    let (core, _recv) = started_core(&f).await;
    wait_until(|| !core.0.host_health.lock().unwrap().0).await;
    let start = f.clock.now();
    let stale = seed_host_project(&core, "stale", Some(start - TEN_MINUTES - 1)).await;

    f.clock.advance(30_000);
    tokio::time::sleep(Duration::from_millis(150)).await;

    assert_eq!(last_fetched(&f, &stale), Some(start - TEN_MINUTES - 1));
}

// ── close_branch_review ───────────────────────────────────────────────────

async fn open_feature_review(core: &Core, f: &Fixtures) -> PrId {
    let project = local_project(core, f, "/tmp/my-folder").await;
    let commit = CommitLog {
        sha: Sha::new("feat-head"),
        title: "feature work".into(),
        author_name: "Ada".into(),
        author_email: "ada@example.com".into(),
        at: 42_000,
    };
    f.git.set_resolve("feature", Sha::new("feat-head"));
    f.git.set_resolve("main", Sha::new("main-base"));
    f.git.set_commit(Sha::new("feat-head"), commit.clone());
    f.git.set_commit_log(vec![commit]);
    core.open_branch(OpenBranchRequest {
        project: project.id,
        branch: "feature".into(),
        base: None,
    })
    .await
    .expect("open_branch")
    .pr
}

fn has_row(f: &Fixtures, model: &str, id: &PrId) -> bool {
    f.store.get(model, &id.0).unwrap().is_some()
}

#[tokio::test]
async fn close_branch_review_drops_its_rows_and_worktree() {
    let f = fixtures();
    let (core, _recv) = started_core(&f).await;
    let pr = open_feature_review(&core, &f).await;
    wait_until(|| has_row(&f, models::GROUPING, &pr)).await;
    assert!(has_row(&f, models::PR, &pr) && has_row(&f, models::PR_DETAIL, &pr));

    core.close_branch_review(&pr)
        .await
        .expect("close_branch_review");

    for model in [models::PR, models::PR_DETAIL, models::GROUPING] {
        assert!(!has_row(&f, model, &pr), "{model} row left behind");
    }
    let removed = f.git.removed_worktrees();
    assert_eq!(removed.len(), 1);
    assert_eq!(removed[0].id(), pr);
    // Nothing left for the poller to keep polling.
    assert!(!core.0.current_head.read().await.contains_key(&pr));
    assert!(
        core.0
            .revisions
            .read()
            .await
            .keys()
            .all(|(id, _)| id != &pr)
    );
}

#[tokio::test]
async fn close_branch_review_rejects_a_host_pr() {
    let f = fixtures();
    let (core, _recv) = started_core(&f).await;
    let pr_ref = PrRef {
        repo: theodore_domain::RepoRef {
            host: theodore_domain::HostKind::Github,
            owner: "acme".into(),
            name: "widgets".into(),
        },
        number: 7,
        host_id: Some("node-7".into()),
    };
    let summary = testkit::sample_pr_summary(&pr_ref, &Sha::new("h7"));
    assert!(!summary.url.is_empty());
    core.apply(vec![NewAction {
        model: models::PR.into(),
        model_id: pr_ref.id().0,
        action: SyncActionCode::I,
        data: Some(serde_json::to_value(&summary).unwrap()),
    }])
    .await
    .unwrap();

    let err = core.close_branch_review(&pr_ref.id()).await.unwrap_err();

    assert!(matches!(err, AppError::Invalid(_)), "{err:?}");
    assert!(has_row(&f, models::PR, &pr_ref.id()));
    assert!(f.git.removed_worktrees().is_empty());
}

#[tokio::test]
async fn close_branch_review_of_an_unknown_id_is_not_found() {
    let f = fixtures();
    let (core, _recv) = started_core(&f).await;
    let err = core
        .close_branch_review(&PrId("local:local/x#1".into()))
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "{err:?}");
}

#[tokio::test]
async fn closing_a_review_while_it_groups_leaves_no_grouping_row() {
    let f = fixtures();
    f.grouper.set_delay_ms(300);
    let (core, _recv) = started_core(&f).await;
    let pr = open_feature_review(&core, &f).await;
    core.close_branch_review(&pr)
        .await
        .expect("close_branch_review");
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    assert!(!has_row(&f, models::GROUPING, &pr));
}
