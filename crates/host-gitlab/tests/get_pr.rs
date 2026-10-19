mod support;

use theodore_domain::{CheckRollup, CheckStatus, HostKind, PrRef, PrState, RepoRef, ReviewerState};
use theodore_ports::{Fetched, HostAdapter};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, ResponseTemplate};

fn pr() -> PrRef {
    PrRef {
        repo: RepoRef {
            host: HostKind::Gitlab,
            owner: "acme".into(),
            name: "widgets".into(),
        },
        number: 42,
        host_id: Some("7".into()),
    }
}

async fn mount_detail_endpoints(s: &support::Servers) {
    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42/changes"))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("changes.json")))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42/discussions"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("discussions_page1.json")),
        )
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42/pipelines"))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("pipelines.json")))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42/approvals"))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("approvals.json")))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42/commits"))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("commits.json")))
        .mount(&s.api)
        .await;
}

#[tokio::test]
async fn get_pr_probes_etag_then_builds_full_detail() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("etag", "\"mr-etag-1\"")
                .set_body_json(support::fixture("merge_request.json")),
        )
        .mount(&s.api)
        .await;
    mount_detail_endpoints(&s).await;

    let Fetched::Modified {
        etag,
        value: detail,
    } = s.adapter.get_pr(&pr(), None).await.unwrap()
    else {
        panic!("expected Modified on first fetch");
    };
    assert_eq!(etag, Some("\"mr-etag-1\"".to_string()));

    assert_eq!(detail.summary.title, "Add feature X");
    assert_eq!(detail.summary.state, PrState::Open);
    assert_eq!(
        detail.summary.head_sha.as_str(),
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );
    assert_eq!(detail.summary.checks, CheckRollup::Pass);
    assert_eq!(detail.summary.approvals, 1);
    assert_eq!(detail.summary.required_approvals, Some(1));
    assert_eq!(
        detail.summary.review_decision,
        Some(theodore_domain::ReviewDecision::Approved)
    );
    assert!(!detail.summary.conflicts);
    assert_eq!(detail.summary.additions, 2);
    assert_eq!(detail.summary.deletions, 1);
    assert_eq!(detail.summary.changed_files, 1);

    assert_eq!(
        detail.base_sha.as_str(),
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    assert_eq!(detail.labels, vec!["bug".to_string()]);
    assert_eq!(detail.assignees.len(), 1);
    assert_eq!(detail.assignees[0].login, "bob");

    assert_eq!(detail.commits.len(), 1);
    assert_eq!(detail.commits[0].title, "feat: add feature X");

    assert_eq!(detail.checks.len(), 2);
    assert_eq!(detail.checks[0].status, CheckStatus::Pass);
    assert_eq!(detail.checks[1].status, CheckStatus::Fail);

    assert_eq!(detail.reviewers.len(), 1);
    assert_eq!(detail.reviewers[0].person.login, "carol");
    assert_eq!(detail.reviewers[0].state, ReviewerState::Approved);

    // The system note's discussion is dropped entirely; the other two
    // (one with a diff position, one a general comment) survive.
    assert_eq!(detail.threads.len(), 2);
    let diff_thread = detail
        .threads
        .iter()
        .find(|t| t.anchor.is_some())
        .expect("one thread carries a diff position");
    assert!(diff_thread.resolved);
    assert_eq!(diff_thread.anchor.as_ref().unwrap().line, 20);
    assert_eq!(diff_thread.comments.len(), 1);
    assert_eq!(diff_thread.comments[0].id.as_str(), "5001");
    assert!(diff_thread.comments[0].edited);

    let general_thread = detail
        .threads
        .iter()
        .find(|t| t.anchor.is_none())
        .expect("the general comment has no anchor");
    assert!(!general_thread.resolved);

    // GitLab has no server-side per-file Viewed.
    assert!(detail.viewed.is_empty());
}

#[tokio::test]
async fn get_pr_returns_not_modified_without_touching_the_rest_of_the_endpoints() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42"))
        .and(header("if-none-match", "\"mr-etag-1\""))
        .respond_with(ResponseTemplate::new(304))
        .mount(&s.api)
        .await;

    let result = s
        .adapter
        .get_pr(&pr(), Some("\"mr-etag-1\""))
        .await
        .unwrap();
    assert!(matches!(result, Fetched::NotModified));
    // No other mock mounted: a stray call would 404 inside wiremock and the
    // adapter would surface that as an error, failing the `unwrap()`.
}

#[tokio::test]
async fn get_pr_without_a_host_id_encodes_the_namespace_path() {
    let s = support::servers().await;
    let pr = PrRef {
        repo: RepoRef {
            host: HostKind::Gitlab,
            owner: "acme".into(),
            name: "widgets".into(),
        },
        number: 42,
        host_id: None,
    };

    Mock::given(method("GET"))
        .and(path("/projects/acme%2Fwidgets/merge_requests/42"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("merge_request.json")),
        )
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/projects/acme%2Fwidgets/merge_requests/42/changes"))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("changes.json")))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path(
            "/projects/acme%2Fwidgets/merge_requests/42/discussions",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/projects/acme%2Fwidgets/merge_requests/42/pipelines"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/projects/acme%2Fwidgets/merge_requests/42/approvals"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "approved_by": [], "approvals_required": null
        })))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/projects/acme%2Fwidgets/merge_requests/42/commits"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
        .mount(&s.api)
        .await;

    let Fetched::Modified { value: detail, .. } = s.adapter.get_pr(&pr, None).await.unwrap() else {
        panic!("expected Modified");
    };
    assert_eq!(detail.summary.title, "Add feature X");
}
