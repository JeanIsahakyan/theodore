mod support;

use theodore_domain::{CheckRollup, CheckStatus, HostKind, PrRef, PrState, RepoRef, ReviewerState};
use theodore_ports::{Fetched, HostAdapter};
use wiremock::matchers::{method, path};
use wiremock::{Mock, ResponseTemplate};

fn pr() -> PrRef {
    PrRef {
        repo: RepoRef {
            host: HostKind::Bitbucket,
            owner: "acme".into(),
            name: "widgets".into(),
        },
        number: 42,
        host_id: None,
    }
}

async fn mount_detail_endpoints(s: &support::Servers) {
    Mock::given(method("GET"))
        .and(path("/repositories/acme/widgets/pullrequests/42"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("pull_request.json")),
        )
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/repositories/acme/widgets/pullrequests/42/diffstat"))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("diffstat.json")))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/repositories/acme/widgets/pullrequests/42/commits"))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("commits.json")))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/repositories/acme/widgets/pullrequests/42/statuses"))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("statuses.json")))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/repositories/acme/widgets/pullrequests/42/comments"))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("comments.json")))
        .mount(&s.api)
        .await;
}

#[tokio::test]
async fn get_pr_builds_full_detail_from_the_bitbucket_shape() {
    let s = support::servers().await;
    mount_detail_endpoints(&s).await;

    let Fetched::Modified {
        etag,
        value: detail,
    } = s.adapter.get_pr(&pr(), None).await.unwrap()
    else {
        panic!("expected Modified");
    };
    // No conditional-fetch story over this API.
    assert_eq!(etag, None);

    assert_eq!(detail.summary.title, "Add feature X");
    assert_eq!(detail.summary.state, PrState::Open);
    assert_eq!(detail.summary.head_sha.as_str(), "bbbbbbbbbbbb");
    assert_eq!(detail.summary.base_ref, "main");
    assert_eq!(detail.summary.head_ref, "feature-x");
    assert_eq!(detail.summary.checks, CheckRollup::Fail);
    assert_eq!(detail.summary.approvals, 1);
    assert_eq!(
        detail.summary.review_decision,
        Some(theodore_domain::ReviewDecision::Approved)
    );
    assert!(!detail.summary.conflicts);
    assert_eq!(detail.summary.additions, 17);
    assert_eq!(detail.summary.deletions, 3);
    assert_eq!(detail.summary.changed_files, 2);
    assert_eq!(
        detail.summary.url,
        "https://bitbucket.org/acme/widgets/pull-requests/42"
    );

    assert_eq!(detail.base_sha.as_str(), "aaaaaaaaaaaa");
    assert!(detail.labels.is_empty());
    assert!(detail.assignees.is_empty());

    assert_eq!(detail.commits.len(), 1);
    assert_eq!(detail.commits[0].title, "feat: add feature X");
    assert_eq!(detail.commits[0].sha.as_str(), "bbbbbbbbbbbb");

    assert_eq!(detail.checks.len(), 2);
    assert_eq!(detail.checks[0].status, CheckStatus::Pass);
    assert_eq!(detail.checks[1].status, CheckStatus::Fail);

    assert_eq!(detail.reviewers.len(), 1);
    assert_eq!(detail.reviewers[0].person.login, "carol");
    assert_eq!(detail.reviewers[0].state, ReviewerState::Approved);

    // Comment 5001 (root, inline, resolved) + its reply 5002 group into one
    // thread; the general comment 5003 forms its own.
    assert_eq!(detail.threads.len(), 2);
    let diff_thread = detail
        .threads
        .iter()
        .find(|t| t.anchor.is_some())
        .expect("one thread carries an inline position");
    assert!(diff_thread.resolved);
    assert_eq!(diff_thread.anchor.as_ref().unwrap().line, 20);
    assert_eq!(diff_thread.comments.len(), 2);
    assert_eq!(diff_thread.comments[0].id.as_str(), "5001");
    assert!(diff_thread.comments[0].edited);
    assert!(!diff_thread.comments[1].edited);

    let general_thread = detail
        .threads
        .iter()
        .find(|t| t.anchor.is_none())
        .expect("the general comment has no inline position");
    assert!(!general_thread.resolved);
    assert_eq!(general_thread.comments.len(), 1);

    // No server-side per-file Viewed over this API.
    assert!(detail.viewed.is_empty());
}

#[tokio::test]
async fn get_pr_uses_the_owner_and_name_directly_as_workspace_and_repo_slug() {
    let s = support::servers().await;
    Mock::given(method("GET"))
        .and(path("/repositories/acme/widgets/pullrequests/42"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("pull_request.json")),
        )
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/repositories/acme/widgets/pullrequests/42/diffstat"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "values": [] })))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/repositories/acme/widgets/pullrequests/42/commits"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "values": [] })))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/repositories/acme/widgets/pullrequests/42/statuses"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "values": [] })))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/repositories/acme/widgets/pullrequests/42/comments"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "values": [] })))
        .mount(&s.api)
        .await;

    let Fetched::Modified { value: detail, .. } = s.adapter.get_pr(&pr(), None).await.unwrap()
    else {
        panic!("expected Modified");
    };
    assert_eq!(detail.summary.title, "Add feature X");
}
