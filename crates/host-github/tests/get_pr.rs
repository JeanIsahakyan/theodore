mod support;

use theodore_domain::{
    CheckRollup, CheckStatus, HostKind, PrRef, PrState, RepoRef, ReviewerState, ViewedState,
};
use theodore_ports::{Fetched, HostAdapter};
use wiremock::matchers::{body_string_contains, method, path};
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
    assert_eq!(etag, Some("\"rest-etag-1\"".to_string()));

    assert_eq!(detail.summary.title, "Add feature X");
    assert_eq!(detail.summary.state, PrState::Open);
    assert_eq!(
        detail.summary.head_sha.as_str(),
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );
    assert_eq!(detail.summary.approvals, 1);
    assert_eq!(detail.summary.checks, CheckRollup::Pass);
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

    assert_eq!(detail.checks.len(), 2);
    assert_eq!(detail.checks[0].status, CheckStatus::Pass);
    assert_eq!(detail.checks[0].duration_ms, Some(60_000));
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
}

#[tokio::test]
async fn get_pr_returns_not_modified_without_touching_graphql() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/repos/acme/widgets/pulls/42"))
        .and(wiremock::matchers::header(
            "if-none-match",
            "\"rest-etag-1\"",
        ))
        .respond_with(ResponseTemplate::new(304))
        .mount(&s.rest)
        .await;

    let result = s
        .adapter
        .get_pr(&pr(), Some("\"rest-etag-1\""))
        .await
        .unwrap();
    assert!(matches!(result, Fetched::NotModified));
    // No GraphQL mock mounted at all: a stray call would 404 inside wiremock
    // and the adapter would surface that as an error, failing the `unwrap()`.
    assert!(s.graphql.received_requests().await.unwrap().is_empty());
}
