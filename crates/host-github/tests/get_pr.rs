mod support;

use serde_json::json;
use theodore_domain::{
    CheckRollup, CheckStatus, HostKind, PrRef, PrState, RepoRef, ReviewerState, ViewedState,
};
use theodore_ports::{Fetched, HostAdapter};
use wiremock::matchers::{body_string_contains, header, method, path};
use wiremock::{Mock, ResponseTemplate};

fn pr() -> PrRef {
    PrRef {
        repo: RepoRef {
            host: HostKind::Github,
            owner: "acme".into(),
            name: "widgets".into(),
        },
        number: 42,
        host_id: None,
    }
}

#[tokio::test]
async fn get_pr_probes_etag_then_builds_full_detail_from_graphql() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/repos/acme/widgets/pulls/42"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("etag", "\"rest-etag-1\"")
                .set_body_json(serde_json::json!({})),
        )
        .mount(&s.rest)
        .await;

    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("statusCheckRollup"))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("pr_core.json")))
        .mount(&s.graphql)
        .await;
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("viewerViewedState"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("pr_files_page2.json")),
        )
        .mount(&s.graphql)
        .await;
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("reviewThreads"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("pr_threads_page2.json")),
        )
        .mount(&s.graphql)
        .await;

    let Fetched::Modified {
        etag,
        value: detail,
    } = s.adapter.get_pr(&pr(), None).await.unwrap()
    else {
        panic!("expected Modified on first fetch");
    };
    // Opaque, but it carries the PR's own ETag for the next conditional GET.
    assert!(etag.unwrap().contains("rest-etag-1"));

    assert_eq!(detail.summary.title, "Add feature X");
    assert_eq!(detail.summary.state, PrState::Open);
    assert_eq!(
        detail.summary.head_sha.as_str(),
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );
    assert_eq!(detail.summary.approvals, 1);
    assert_eq!(detail.summary.checks, CheckRollup::Pass);
    assert_eq!(
        detail.summary.review_decision,
        Some(theodore_domain::ReviewDecision::Approved)
    );
    assert!(!detail.summary.conflicts);
    // Fixture's `createdAt` (2024-01-01) is before `updatedAt` (2024-01-02).
    assert!(detail.summary.created_at.is_some());
    assert!(detail.summary.created_at.unwrap() < detail.summary.updated_at);
    assert_eq!(
        detail.base_sha.as_str(),
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    assert_eq!(detail.labels, vec!["bug".to_string()]);
    assert_eq!(detail.assignees.len(), 1);
    assert_eq!(detail.assignees[0].login, "bob");

    assert_eq!(detail.commits.len(), 1);
    assert_eq!(detail.commits[0].title, "feat: add feature X");
    assert_eq!(detail.commits[0].author.login, "alice");
    // The fixture's viewer (carol) last reviewed at 02:00, this commit
    // landed at 03:00: new since that review.
    assert!(detail.commits[0].after_my_review);

    assert_eq!(detail.checks.len(), 2);
    assert_eq!(detail.checks[0].status, CheckStatus::Pass);
    assert_eq!(detail.checks[0].duration_ms, Some(60_000));
    // The REST numeric id (`databaseId`), not the opaque GraphQL node id:
    // `rerun_check` needs it for `check-runs/{id}/rerequest`.
    assert_eq!(detail.checks[0].id, "900001");
    assert_eq!(detail.checks[1].name, "ci/legacy");

    // One requested-review (User), one requested-review (Team), one latest review.
    assert_eq!(detail.reviewers.len(), 3);
    assert!(detail.reviewers.iter().any(
        |r| r.state == ReviewerState::Requested && r.team.as_deref() == Some("reviewers-team")
    ));
    assert!(
        detail
            .reviewers
            .iter()
            .any(|r| r.state == ReviewerState::Approved && r.person.login == "carol")
    );

    assert_eq!(
        detail.viewed,
        vec![theodore_domain::FileViewed {
            path: "src/main.rs".into(),
            state: ViewedState::Unviewed
        }]
    );

    assert_eq!(detail.threads.len(), 1);
    let thread = &detail.threads[0];
    assert!(thread.outdated);
    assert!(thread.resolved);
    assert!(
        thread.anchor.is_none(),
        "file-level thread (no line) has no anchor"
    );
    assert_eq!(thread.comments.len(), 1);
    assert_eq!(thread.comments[0].id.as_str(), "1002");
    assert!(thread.comments[0].edited);

    // Two reaction groups with a nonzero count, mapped to the REST content
    // naming convention; the zero-count ROCKET group is dropped.
    let reactions = &thread.comments[0].reactions;
    assert_eq!(reactions.len(), 2);
    let thumbs_up = reactions.iter().find(|r| r.emoji == "+1").unwrap();
    assert_eq!(thumbs_up.count, 2);
    assert!(thumbs_up.viewer_reacted);
    let heart = reactions.iter().find(|r| r.emoji == "heart").unwrap();
    assert_eq!(heart.count, 1);
    assert!(!heart.viewer_reacted);
    assert!(!reactions.iter().any(|r| r.emoji == "rocket"));
}

// ── Conditional fetches: the PR and its head's checks ─────────────────────

const HEAD: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PULL: &str = "/repos/acme/widgets/pulls/42";
const RUNS: &str =
    "/repos/acme/widgets/commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/check-runs";
const STATUS: &str = "/repos/acme/widgets/commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/status";

async fn mount_detail(s: &support::Servers) {
    for (needle, file) in [
        ("statusCheckRollup", "pr_core.json"),
        ("viewerViewedState", "pr_files_page2.json"),
        ("reviewThreads", "pr_threads_page2.json"),
    ] {
        Mock::given(method("POST"))
            .and(path("/"))
            .and(body_string_contains(needle))
            .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture(file)))
            .mount(&s.graphql)
            .await;
    }
}

/// `GET at` without a matching `If-None-Match` answers 200 with `etag`.
async fn mount_fresh(s: &support::Servers, at: &str, etag: &str, body: serde_json::Value) {
    Mock::given(method("GET"))
        .and(path(at))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("etag", etag)
                .set_body_json(body),
        )
        .with_priority(5)
        .mount(&s.rest)
        .await;
}

/// `GET at` with `If-None-Match: sent` answers `status` (with `etag`).
async fn mount_cond(s: &support::Servers, at: &str, sent: &str, status: u16, etag: Option<&str>) {
    let mut resp = ResponseTemplate::new(status);
    if let Some(e) = etag {
        resp = resp
            .insert_header("etag", e)
            .set_body_json(serde_json::json!({}));
    }
    Mock::given(method("GET"))
        .and(path(at))
        .and(header("if-none-match", sent))
        .respond_with(resp)
        .with_priority(1)
        .mount(&s.rest)
        .await;
}

async fn requests_to(server: &wiremock::MockServer, at: &str) -> usize {
    let all = server.received_requests().await.unwrap();
    all.iter().filter(|r| r.url.path() == at).count()
}

async fn graphql_calls(s: &support::Servers) -> usize {
    s.graphql.received_requests().await.unwrap().len()
}

fn modified(f: Fetched<theodore_domain::PrDetail>) -> String {
    match f {
        Fetched::Modified { etag, .. } => etag.expect("get_pr always hands back an etag"),
        Fetched::NotModified => panic!("expected Modified"),
    }
}

/// The QA report: CI finished, GitHub showed `test` passing, the Checks tab
/// stayed empty — the PR resource doesn't change when a check does, so its
/// 304 hid it. The head's check runs are asked too, and their change alone
/// refetches the detail; once nothing moved it's 304s and no GraphQL.
#[tokio::test]
async fn a_check_finishing_refetches_though_the_pr_is_unchanged() {
    let s = support::servers().await;
    mount_detail(&s).await;
    mount_fresh(&s, PULL, "\"p1\"", json!({ "head": { "sha": HEAD } })).await;
    mount_cond(&s, PULL, "\"p1\"", 304, None).await;
    mount_fresh(&s, RUNS, "\"r1\"", json!({ "check_runs": [] })).await;
    mount_cond(&s, RUNS, "\"r1\"", 200, Some("\"r2\"")).await;
    mount_cond(&s, RUNS, "\"r2\"", 304, None).await;
    mount_fresh(&s, STATUS, "\"s1\"", json!({ "statuses": [] })).await;
    mount_cond(&s, STATUS, "\"s1\"", 304, None).await;

    let first = modified(s.adapter.get_pr(&pr(), None).await.unwrap());
    let fetched_once = graphql_calls(&s).await;
    assert!(fetched_once > 0);

    // Only the check runs moved (`r1` → `r2`): a fresh detail.
    let second = modified(s.adapter.get_pr(&pr(), Some(&first)).await.unwrap());
    assert!(
        graphql_calls(&s).await > fetched_once,
        "the detail is refetched"
    );
    assert_ne!(first, second);

    // Nothing moved: three 304s, no GraphQL.
    let fetched_twice = graphql_calls(&s).await;
    let third = s.adapter.get_pr(&pr(), Some(&second)).await.unwrap();
    assert!(matches!(third, Fetched::NotModified));
    assert_eq!(graphql_calls(&s).await, fetched_twice);
    assert_eq!(requests_to(&s.rest, PULL).await, 3);
    assert_eq!(requests_to(&s.rest, RUNS).await, 3);
    assert_eq!(requests_to(&s.rest, STATUS).await, 3);
}

/// A plain commit status (a CI reporting through the statuses API, not
/// check runs) moving is a change too.
#[tokio::test]
async fn a_commit_status_moving_refetches_too() {
    let s = support::servers().await;
    mount_detail(&s).await;
    mount_fresh(&s, PULL, "\"p1\"", json!({ "head": { "sha": HEAD } })).await;
    mount_cond(&s, PULL, "\"p1\"", 304, None).await;
    mount_fresh(&s, RUNS, "\"r1\"", json!({ "check_runs": [] })).await;
    mount_cond(&s, RUNS, "\"r1\"", 304, None).await;
    mount_fresh(&s, STATUS, "\"s1\"", json!({ "statuses": [] })).await;
    mount_cond(&s, STATUS, "\"s1\"", 200, Some("\"s2\"")).await;

    let first = modified(s.adapter.get_pr(&pr(), None).await.unwrap());
    let before = graphql_calls(&s).await;
    modified(s.adapter.get_pr(&pr(), Some(&first)).await.unwrap());
    assert!(graphql_calls(&s).await > before);
}

/// A token that may not read checks (fine-grained, no "Checks: read") still
/// gets the PR, and isn't refused again every poll: the PR's own ETag
/// decides until the head moves.
#[tokio::test]
async fn a_token_refused_the_checks_falls_back_to_the_prs_etag() {
    let s = support::servers().await;
    mount_detail(&s).await;
    mount_fresh(&s, PULL, "\"p1\"", json!({ "head": { "sha": HEAD } })).await;
    mount_cond(&s, PULL, "\"p1\"", 304, None).await;
    Mock::given(method("GET"))
        .and(path(RUNS))
        .respond_with(ResponseTemplate::new(403).set_body_json(json!({
            "message": "Resource not accessible by personal access token"
        })))
        .mount(&s.rest)
        .await;

    let first = modified(s.adapter.get_pr(&pr(), None).await.unwrap());
    let before = graphql_calls(&s).await;
    for _ in 0..2 {
        let again = s.adapter.get_pr(&pr(), Some(&first)).await.unwrap();
        assert!(matches!(again, Fetched::NotModified));
    }
    assert_eq!(graphql_calls(&s).await, before);
    assert_eq!(requests_to(&s.rest, RUNS).await, 1, "asked once per head");
    assert_eq!(requests_to(&s.rest, STATUS).await, 0);
}

/// An ETag from before the checks were part of it (a bare one) is
/// "nothing known": a full fetch, never a stale 304.
#[tokio::test]
async fn a_bare_etag_is_a_full_fetch() {
    let s = support::servers().await;
    mount_detail(&s).await;
    mount_fresh(&s, PULL, "\"p1\"", json!({ "head": { "sha": HEAD } })).await;
    mount_cond(&s, PULL, "\"p1\"", 304, None).await;

    let got = s.adapter.get_pr(&pr(), Some("\"p1\"")).await.unwrap();
    assert!(matches!(got, Fetched::Modified { .. }));
}
