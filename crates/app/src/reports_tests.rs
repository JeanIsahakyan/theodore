//! "My reports" against `Core` + a scripted `IssueTracker`
//! (`usecases/reports.rs`).

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use theodore_contract::{BootstrapScope, Ephemeral, ReportStatus, TrackedReport, models};
use theodore_ports::{
    CreatedIssue, HostError, HostResult, IssueCloser, IssueStatus, IssueTracker, NewIssue,
};
use tokio::sync::broadcast;

use crate::Core;
use crate::testkit::fixtures;

#[derive(Default)]
struct Tracker {
    /// `Err`: GitHub out of reach with this message.
    status: Mutex<Option<Result<IssueStatus, String>>>,
    release: Mutex<Option<String>>,
    status_calls: Mutex<u32>,
}

impl Tracker {
    fn set(&self, s: IssueStatus) {
        *self.status.lock().unwrap() = Some(Ok(s));
    }
}

#[async_trait]
impl IssueTracker for Tracker {
    fn has_token(&self) -> bool {
        true
    }
    async fn login(&self) -> HostResult<String> {
        Ok("ada".into())
    }
    async fn create_issue(&self, _: &str, _: &str, _: &NewIssue) -> HostResult<CreatedIssue> {
        Err(HostError::Unsupported("create_issue"))
    }
    async fn issue_status(&self, owner: &str, name: &str, number: u64) -> HostResult<IssueStatus> {
        assert_eq!((owner, name, number), ("acme", "theodore", 42));
        *self.status_calls.lock().unwrap() += 1;
        self.status
            .lock()
            .unwrap()
            .clone()
            .map(|r| r.map_err(HostError::Network))
            .unwrap_or(Err(HostError::NotFound("#42".into())))
    }
    async fn first_release_with(&self, _: &str, _: &str, sha: &str) -> HostResult<Option<String>> {
        assert_eq!(sha, "abc123");
        Ok(self.release.lock().unwrap().clone())
    }
}

fn open() -> IssueStatus {
    IssueStatus {
        number: 42,
        title: "Diff pane is blank".into(),
        url: "https://github.com/acme/theodore/issues/42".into(),
        open: true,
        close_reason: None,
        author: Some("ada".into()),
        comments: 0,
        last_commenter: None,
        updated_at: 1_000,
        closed_at: None,
        closed_by: None,
    }
}

fn fixed_by_pr() -> IssueStatus {
    IssueStatus {
        open: false,
        close_reason: Some("completed".into()),
        closed_at: Some(2_000),
        updated_at: 2_000,
        closed_by: Some(IssueCloser {
            pr: Some(57),
            pr_url: Some("https://github.com/acme/theodore/pull/57".into()),
            sha: Some("abc123".into()),
        }),
        ..open()
    }
}

async fn row(core: &Core) -> TrackedReport {
    let boot = core.bootstrap(BootstrapScope::Global).await.unwrap();
    let r = boot
        .rows
        .into_iter()
        .find(|r| r.model == models::REPORT)
        .expect("a report row");
    assert_eq!(r.id, "acme/theodore#42");
    serde_json::from_value(r.data).unwrap()
}

/// The report updates emitted so far.
fn updates(rx: &mut broadcast::Receiver<Ephemeral>) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(e) = rx.try_recv() {
        if let Ephemeral::ReportUpdate { number, text, .. } = e {
            assert_eq!(number, 42);
            out.push(text);
        }
    }
    out
}

async fn started(version: &str) -> (Core, Arc<Tracker>, broadcast::Receiver<Ephemeral>) {
    let f = fixtures();
    let (core, recv) = Core::start(f.deps());
    let tracker = Arc::new(Tracker::default());
    core.follow_reports(Some(tracker.clone() as Arc<dyn IssueTracker>), version);
    core.track_report(
        "acme/theodore",
        42,
        "https://github.com/acme/theodore/issues/42",
        "Diff pane is blank",
    )
    .await
    .unwrap();
    (core, tracker, recv.ephemeral)
}

#[tokio::test]
async fn a_filed_report_is_listed_as_open() {
    let (core, _, _) = started("0.1.14").await;
    let r = row(&core).await;
    assert_eq!(r.status, ReportStatus::Open);
    assert_eq!(r.number, 42);
    assert_eq!(r.title, "Diff pane is blank");
}

#[tokio::test]
async fn fixed_then_released_in_the_running_version_is_said_once() {
    let (core, tracker, mut rx) = started("0.1.14").await;
    tracker.set(open());
    core.check_reports().await;
    assert!(updates(&mut rx).is_empty(), "nothing changed yet");

    tracker.set(fixed_by_pr());
    core.check_reports().await;
    assert_eq!(updates(&mut rx), ["Your report #42 is fixed in #57"]);
    let r = row(&core).await;
    assert_eq!(r.status, ReportStatus::Fixed);
    assert_eq!(r.fixed_by, Some(57));

    *tracker.release.lock().unwrap() = Some("v0.1.14".into());
    core.check_reports().await;
    assert_eq!(
        updates(&mut rx),
        ["Your report #42 is fixed in this version"]
    );
    let r = row(&core).await;
    assert_eq!(r.status, ReportStatus::Released);
    assert_eq!(r.released_in.as_deref(), Some("0.1.14"));

    core.check_reports().await;
    assert!(updates(&mut rx).is_empty(), "said once");
}

#[tokio::test]
async fn a_release_newer_than_this_build_says_update_then_after_the_update_this_version() {
    let (core, tracker, mut rx) = started("0.1.13").await;
    tracker.set(fixed_by_pr());
    *tracker.release.lock().unwrap() = Some("v0.1.14".into());
    core.check_reports().await;
    assert_eq!(
        updates(&mut rx),
        ["Your report #42 is fixed in 0.1.14: update to get it"]
    );

    // Restarted into 0.1.14: said once, even with GitHub out of reach.
    core.follow_reports(Some(tracker.clone() as Arc<dyn IssueTracker>), "0.1.14");
    *tracker.status.lock().unwrap() = Some(Err("down".into()));
    core.check_reports().await;
    assert_eq!(
        updates(&mut rx),
        ["Your report #42 is fixed in this version"]
    );
    core.check_reports().await;
    assert!(updates(&mut rx).is_empty());
}

#[tokio::test]
async fn a_reply_by_someone_else_is_news_your_own_comment_is_not() {
    let (core, tracker, mut rx) = started("0.1.14").await;
    tracker.set(IssueStatus {
        comments: 1,
        last_commenter: Some("ada".into()),
        ..open()
    });
    core.check_reports().await;
    assert!(updates(&mut rx).is_empty());

    tracker.set(IssueStatus {
        comments: 2,
        last_commenter: Some("maintainer".into()),
        ..open()
    });
    core.check_reports().await;
    assert_eq!(updates(&mut rx), ["New reply on your report #42"]);
    assert_eq!(row(&core).await.comments, 2);
}

#[tokio::test]
async fn closed_as_not_planned_says_so() {
    let (core, tracker, mut rx) = started("0.1.14").await;
    tracker.set(IssueStatus {
        open: false,
        close_reason: Some("not_planned".into()),
        closed_at: Some(2_000),
        ..open()
    });
    core.check_reports().await;
    assert_eq!(
        updates(&mut rx),
        ["Your report #42 was closed as not planned"]
    );
    assert_eq!(row(&core).await.status, ReportStatus::NotPlanned);
}

#[tokio::test]
async fn without_a_tracker_nothing_is_asked() {
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());
    let tracker = Arc::new(Tracker::default());
    core.track_report("acme/theodore", 42, "u", "t")
        .await
        .unwrap();
    core.follow_reports(None, "0.1.14");
    core.check_reports().await;
    assert_eq!(*tracker.status_calls.lock().unwrap(), 0);
}
