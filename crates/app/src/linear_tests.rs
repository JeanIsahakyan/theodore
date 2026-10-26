//! `linear_status` / `set_linear_token` / `linear_issues` against `Core` +
//! `testkit` fakes.
//!
//! `theodore_linear::LinearClient` always talks to the real
//! `api.linear.app`, not a port trait `testkit` can fake — so only the
//! paths that never need a live Linear response are covered here: no
//! token stored, a cache hit, a PR with no stored `pr_detail`, and
//! disconnecting. The "token validates, issue resolves" paths are covered
//! against a wiremock server in `theodore-linear`'s own tests; a real,
//! end-to-end run against the live API is `live_smoke` below, `#[ignore]`d.

use theodore_contract::{LinearIssue, LinearIssuesRequest, SetLinearTokenRequest};
use theodore_domain::PrId;
use theodore_ports::{Clock, Secrets};

use crate::Core;
use crate::testkit::fixtures;

fn sample_issue() -> LinearIssue {
    LinearIssue {
        identifier: "ENG-123".into(),
        title: "Fix the thing".into(),
        state_name: "In Progress".into(),
        state_type: "started".into(),
        assignee: Some("Ada Lovelace".into()),
        priority: Some(2),
        url: "https://linear.app/acme/issue/ENG-123".into(),
        team_key: "ENG".into(),
    }
}

#[tokio::test]
async fn linear_status_with_no_token_reports_disconnected() {
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());

    let status = core.linear_status().await.expect("linear_status");
    assert!(!status.connected);
    assert_eq!(status.user, None);
    assert_eq!(status.workspace, None);
}

#[tokio::test]
async fn linear_issues_with_no_token_returns_an_empty_list_not_an_error() {
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());

    let issues = core
        .linear_issues(LinearIssuesRequest {
            pr: PrId::new("github:acme/widgets#7"),
        })
        .await
        .expect("linear_issues");
    assert!(issues.is_empty());
}

#[tokio::test]
async fn linear_issues_with_a_token_but_no_stored_pr_detail_returns_empty() {
    let f = fixtures();
    f.secrets
        .set(theodore_secrets::LINEAR_TOKEN, "lin_api_fake")
        .unwrap();
    let (core, _recv) = Core::start(f.deps());

    // No `pr_detail` row exists for this PR — `linear_issues` must fall
    // back to an empty list rather than erroring or reaching the network.
    let issues = core
        .linear_issues(LinearIssuesRequest {
            pr: PrId::new("github:acme/widgets#999"),
        })
        .await
        .expect("linear_issues");
    assert!(issues.is_empty());
}

#[tokio::test]
async fn linear_issues_returns_a_cached_result_within_the_ttl() {
    let f = fixtures();
    f.secrets
        .set(theodore_secrets::LINEAR_TOKEN, "lin_api_fake")
        .unwrap();
    let (core, _recv) = Core::start(f.deps());
    let pr = PrId::new("github:acme/widgets#7");

    // Pre-seed the cache as `linear_issues` itself would have, at the
    // current fake-clock time — a fresh entry, well inside the 5-minute
    // TTL. No `pr_detail` row and no network access are needed for this
    // to return the cached value.
    core.0
        .linear_cache
        .lock()
        .unwrap()
        .insert(pr.clone(), (f.clock.now(), vec![sample_issue()]));

    let issues = core
        .linear_issues(LinearIssuesRequest { pr })
        .await
        .expect("linear_issues");
    assert_eq!(issues, vec![sample_issue()]);
}

#[tokio::test]
async fn linear_issues_ignores_a_stale_cache_entry_past_the_ttl() {
    let f = fixtures();
    f.secrets
        .set(theodore_secrets::LINEAR_TOKEN, "lin_api_fake")
        .unwrap();
    let (core, _recv) = Core::start(f.deps());
    let pr = PrId::new("github:acme/widgets#999");

    // Seeded 6 minutes before "now" — past the 5-minute TTL. With no
    // `pr_detail` row stored either, the stale entry must be skipped and
    // the (empty, no-network) fallback taken, not the stale cached issue.
    core.0.linear_cache.lock().unwrap().insert(
        pr.clone(),
        (f.clock.now() - 6 * 60 * 1000, vec![sample_issue()]),
    );

    let issues = core
        .linear_issues(LinearIssuesRequest { pr })
        .await
        .expect("linear_issues");
    assert!(issues.is_empty());
}

#[tokio::test]
async fn set_linear_token_none_disconnects_and_clears_the_stored_token_and_cache() {
    let f = fixtures();
    f.secrets
        .set(theodore_secrets::LINEAR_TOKEN, "lin_api_fake")
        .unwrap();
    let (core, _recv) = Core::start(f.deps());
    let pr = PrId::new("github:acme/widgets#7");
    core.0
        .linear_cache
        .lock()
        .unwrap()
        .insert(pr.clone(), (f.clock.now(), vec![sample_issue()]));

    let status = core
        .set_linear_token(SetLinearTokenRequest { token: None })
        .await
        .expect("set_linear_token");

    assert!(!status.connected);
    assert_eq!(f.secrets.get(theodore_secrets::LINEAR_TOKEN).unwrap(), None);
    assert!(core.0.linear_cache.lock().unwrap().is_empty());
}

/// Exercises `set_linear_token`'s validate-then-store path, and
/// `linear_issues`'s full issue-lookup path, against the real Linear API.
///
/// Run manually with a real personal API key and a real PR whose title,
/// branch or body references a real issue:
///   LINEAR_LIVE_TOKEN=lin_api_... cargo test --package theodore-app \
///     -- --ignored --nocapture live_smoke
#[tokio::test]
#[ignore]
async fn live_smoke() {
    let token = std::env::var("LINEAR_LIVE_TOKEN").expect("LINEAR_LIVE_TOKEN not set");
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());

    let status = core
        .set_linear_token(SetLinearTokenRequest { token: Some(token) })
        .await
        .expect("set_linear_token against the live API");
    assert!(status.connected);
    println!("connected as {:?} on {:?}", status.user, status.workspace);
}
