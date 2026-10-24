//! Opening a PR while the host can't be reached: a PR opened in an earlier
//! session reopens from its stored detail and the commits already in the
//! clone; one never downloaded says so plainly.

use std::time::Duration;

use theodore_contract::{OpenPrRequest, RevisionRequest};
use theodore_domain::{HostKind, PrId, PrRef, RepoRef, Revision, Sha};
use theodore_ports::{Fetched, HostError};

use crate::testkit::{self, Fixtures, fixtures};
use crate::{AppError, Core};

fn pr_ref() -> PrRef {
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

fn base() -> Sha {
    Sha::new("base000")
}

fn head() -> Sha {
    Sha::new("head111")
}

fn offline() -> HostError {
    HostError::Network("error sending request: connection refused".into())
}

async fn wait_until(mut cond: impl FnMut() -> bool) {
    for _ in 0..400 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("condition not met in time");
}

/// Opens the PR online in one session, then ends it: the store keeps its
/// rows, the clone keeps its commits — what an app restart leaves.
async fn opened_in_an_earlier_session(f: &Fixtures) -> PrId {
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("etag-1".into()),
        value: testkit::sample_pr_detail(&pr_ref(), &base(), &head()),
    }));
    let (core, _recv) = Core::start(f.deps());
    let resp = core
        .open_pr(OpenPrRequest {
            url: "https://github.com/acme/widgets/pull/7".into(),
        })
        .await
        .expect("online open");
    core.shutdown();
    // Let its poller wind down before the next session queues responses.
    tokio::time::sleep(Duration::from_millis(50)).await;
    resp.pr
}

/// A new session with the host unreachable for every read.
fn start_offline(f: &Fixtures) -> Core {
    f.host.push_get_pr(Err(offline()));
    for _ in 0..8 {
        f.host.push_search(Err(offline()));
    }
    Core::start(f.deps()).0
}

#[tokio::test]
async fn online_open_fetches_the_pr() {
    let f = fixtures();
    opened_in_an_earlier_session(&f).await;
    assert!(f.git.network_calls().contains(&"fetch_pr"));
}

#[tokio::test]
async fn a_pr_opened_before_reopens_offline_from_its_local_copy() {
    let f = fixtures();
    let pr = opened_in_an_earlier_session(&f).await;
    let fetched = f.git.network_calls().len();

    let core = start_offline(&f);
    let revision = core
        .get_revision(RevisionRequest {
            pr: pr.clone(),
            head: head(),
        })
        .await
        .expect("the diff opens offline");

    assert_eq!(revision.files.len(), 1);
    assert_eq!(revision.files[0].path, "src/lib.rs");
    assert!(f.host.get_pr_responses.lock().unwrap().is_empty());
    assert_eq!(f.git.network_calls().len(), fetched, "no clone, no fetch");
    assert_eq!(core.0.current_head.read().await.get(&pr), Some(&head()));
    assert!(!core.host_online());
}

#[tokio::test]
async fn offline_with_the_commits_missing_says_so_plainly() {
    let f = fixtures();
    let pr = opened_in_an_earlier_session(&f).await;
    f.git.set_missing_commit(&head());

    let core = start_offline(&f);
    let err = core
        .get_revision(RevisionRequest {
            pr: pr.clone(),
            head: head(),
        })
        .await
        .unwrap_err();

    assert!(matches!(err, AppError::OfflineNotCached), "{err}");
    assert_eq!(err.code(), "app.offline_not_cached");
    let text = err.to_string();
    assert_eq!(
        text,
        "You're offline and this PR's code hasn't been downloaded yet"
    );
    assert!(!core.0.current_head.read().await.contains_key(&pr));
}

#[tokio::test]
async fn offline_a_pr_never_opened_says_so_plainly() {
    let f = fixtures();
    let core = start_offline(&f);
    let err = core
        .ensure_open(&PrId("github:acme/widgets#7".into()))
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::OfflineNotCached), "{err}");
}

#[tokio::test]
async fn a_rejected_token_with_nothing_cached_keeps_the_host_error() {
    let f = fixtures();
    f.host.push_get_pr(Err(HostError::Auth));
    let core = Core::start(f.deps()).0;
    let err = core
        .ensure_open(&PrId("github:acme/widgets#7".into()))
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Host(HostError::Auth)), "{err}");
}

#[tokio::test]
async fn offline_an_earlier_head_with_its_commits_opens_without_fetching() {
    let f = fixtures();
    let pr = opened_in_an_earlier_session(&f).await;
    let core = start_offline(&f);
    core.ensure_open(&pr).await.unwrap();
    let fetched = f.git.network_calls().len();

    let earlier = Sha::new("head000");
    core.get_revision(RevisionRequest {
        pr: pr.clone(),
        head: earlier.clone(),
    })
    .await
    .expect("an earlier head opens from the clone");
    assert_eq!(f.git.network_calls().len(), fetched);

    let gone = Sha::new("head-gone");
    f.git.set_missing_commit(&gone);
    let err = core
        .get_revision(RevisionRequest { pr, head: gone })
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::OfflineNotCached), "{err}");
}

#[tokio::test]
async fn after_reconnecting_a_moved_head_is_picked_up() {
    let f = fixtures();
    let pr = opened_in_an_earlier_session(&f).await;
    let core = start_offline(&f);
    core.ensure_open(&pr).await.unwrap();
    let fetched = f.git.network_calls().len();

    // The host is back, and the author pushed while it was away.
    let new_head = Sha::new("head222");
    f.git.set_head(new_head.clone());
    f.git
        .set_revision(testkit::two_hunk_revision(&base(), &new_head, "src/lib.rs"));
    f.host.push_get_pr(Ok(Fetched::Modified {
        etag: Some("etag-2".into()),
        value: testkit::sample_pr_detail(&pr_ref(), &base(), &new_head),
    }));
    f.clock.advance(15_000);

    let mut moved = false;
    for _ in 0..400 {
        if core.0.current_head.read().await.get(&pr) == Some(&new_head) {
            moved = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(moved, "the poller moves the PR to the pushed head");
    // The push pipeline fetched the new head into the clone.
    wait_until(|| f.git.network_calls()[fetched..].contains(&"fetch_pr")).await;

    // Reopening now is the cached new head, not the offline copy.
    core.ensure_open(&pr).await.unwrap();
    let revision: Revision = core
        .get_revision(RevisionRequest {
            pr: pr.clone(),
            head: new_head.clone(),
        })
        .await
        .unwrap();
    assert_eq!(revision.head, new_head);
}
