mod support;

use theodore_domain::{HostKind, PrRef, RepoRef};
use theodore_ports::{HostAdapter, HostError, MergeMethod};
use wiremock::matchers::{body_json, method, path};
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

#[tokio::test]
async fn merge_sends_merge_commit_strategy_and_returns_the_sha() {
    let s = support::servers().await;
    Mock::given(method("POST"))
        .and(path("/repositories/acme/widgets/pullrequests/42/merge"))
        .and(body_json(serde_json::json!({
            "merge_strategy": "merge_commit",
            "message": "Add feature X",
            "close_source_branch": false
        })))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("merge_response.json")),
        )
        .mount(&s.api)
        .await;

    let sha = s
        .adapter
        .merge(
            &pr(),
            MergeMethod::Merge,
            Some("Add feature X".to_string()),
            None,
        )
        .await
        .unwrap();
    assert_eq!(sha.as_str(), "dddddddddddd");
}

#[tokio::test]
async fn merge_squash_sends_the_squash_strategy() {
    let s = support::servers().await;
    Mock::given(method("POST"))
        .and(path("/repositories/acme/widgets/pullrequests/42/merge"))
        .and(body_json(serde_json::json!({
            "merge_strategy": "squash",
            "close_source_branch": false
        })))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("merge_response.json")),
        )
        .mount(&s.api)
        .await;

    s.adapter
        .merge(&pr(), MergeMethod::Squash, None, None)
        .await
        .unwrap();
}

#[tokio::test]
async fn merge_rebase_maps_to_fast_forward() {
    let s = support::servers().await;
    Mock::given(method("POST"))
        .and(path("/repositories/acme/widgets/pullrequests/42/merge"))
        .and(body_json(serde_json::json!({
            "merge_strategy": "fast_forward",
            "close_source_branch": false
        })))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("merge_response.json")),
        )
        .mount(&s.api)
        .await;

    s.adapter
        .merge(&pr(), MergeMethod::Rebase, None, None)
        .await
        .unwrap();
}

#[tokio::test]
async fn merge_conflict_maps_to_host_error_conflict() {
    let s = support::servers().await;
    Mock::given(method("POST"))
        .and(path("/repositories/acme/widgets/pullrequests/42/merge"))
        .respond_with(ResponseTemplate::new(409).set_body_string("conflict"))
        .mount(&s.api)
        .await;

    let err = s
        .adapter
        .merge(&pr(), MergeMethod::Merge, None, None)
        .await
        .unwrap_err();
    assert!(matches!(err, HostError::Conflict(_)));
}
