//! Projects page behaviour against `Core` + `testkit` fakes: a local
//! folder's working state.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::json;
use theodore_contract::{AddProjectRequest, Project, models};
use theodore_ports::{Store, WorkingState};

use crate::testkit::{Fixtures, fixtures};
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
