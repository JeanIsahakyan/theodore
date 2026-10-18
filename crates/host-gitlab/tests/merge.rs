mod support;

use theodore_domain::{HostKind, PrRef, RepoRef};
use theodore_ports::{HostAdapter, HostError, MergeMethod};
use wiremock::matchers::{body_json, method, path};
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

fn mr_json(extra: serde_json::Value) -> serde_json::Value {
    let mut base = serde_json::json!({
        "iid": 42,
        "project_id": 7,
        "title": "Add feature X",
        "state": "opened",
        "web_url": "https://gitlab.com/acme/widgets/-/merge_requests/42",
        "source_branch": "feature-x",
        "target_branch": "main",
        "sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "author": { "id": 1, "username": "alice" },
        "updated_at": "2024-01-01T00:00:00.000Z"
    });
    for (k, v) in extra.as_object().unwrap() {
        base[k] = v.clone();
    }
    base
}

#[tokio::test]
async fn merge_squashes_with_a_custom_message_and_returns_the_sha() {
    let s = support::servers().await;

    Mock::given(method("PUT"))
        .and(path("/projects/7/merge_requests/42/merge"))
        .and(body_json(serde_json::json!({
            "squash": true,
            "squash_commit_message": "final title\n\nfinal body"
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(mr_json(
            serde_json::json!({ "squash_commit_sha": "deadbeef" }),
        )))
        .mount(&s.api)
        .await;

    let sha = s
        .adapter
        .merge(
            &pr(),
            MergeMethod::Squash,
            Some("final title".into()),
            Some("final body".into()),
        )
        .await
        .unwrap();
    assert_eq!(sha.as_str(), "deadbeef");
}

#[tokio::test]
async fn merge_rejects_rebase_as_unsupported() {
    let s = support::servers().await;

    let err = s
        .adapter
        .merge(&pr(), MergeMethod::Rebase, None, None)
        .await
        .unwrap_err();
    assert!(matches!(err, HostError::Unsupported(_)), "got {err:?}");
}

#[tokio::test]
async fn merge_maps_a_405_to_conflict() {
    let s = support::servers().await;

    Mock::given(method("PUT"))
        .and(path("/projects/7/merge_requests/42/merge"))
        .respond_with(ResponseTemplate::new(405).set_body_json(serde_json::json!({
            "message": "405 Method Not Allowed"
        })))
        .mount(&s.api)
        .await;

    let err = s
        .adapter
        .merge(&pr(), MergeMethod::Merge, None, None)
        .await
        .unwrap_err();
    assert!(matches!(err, HostError::Conflict(_)), "got {err:?}");
}

#[tokio::test]
async fn enable_auto_merge_sets_merge_when_pipeline_succeeds() {
    let s = support::servers().await;

    Mock::given(method("PUT"))
        .and(path("/projects/7/merge_requests/42/merge"))
        .and(body_json(serde_json::json!({
            "merge_when_pipeline_succeeds": true
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(mr_json(serde_json::json!({}))))
        .mount(&s.api)
        .await;

    s.adapter
        .enable_auto_merge(&pr(), MergeMethod::Merge)
        .await
        .unwrap();
}

#[tokio::test]
async fn disable_auto_merge_cancels_it() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path(
            "/projects/7/merge_requests/42/cancel_merge_when_pipeline_succeeds",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&s.api)
        .await;

    s.adapter.disable_auto_merge(&pr()).await.unwrap();
}

#[tokio::test]
async fn update_branch_hits_the_rebase_endpoint() {
    let s = support::servers().await;

    Mock::given(method("PUT"))
        .and(path("/projects/7/merge_requests/42/rebase"))
        .respond_with(ResponseTemplate::new(202).set_body_json(serde_json::json!({
            "rebase_in_progress": true
        })))
        .mount(&s.api)
        .await;

    s.adapter.update_branch(&pr()).await.unwrap();
}

#[tokio::test]
async fn update_branch_maps_a_409_to_conflict() {
    let s = support::servers().await;

    Mock::given(method("PUT"))
        .and(path("/projects/7/merge_requests/42/rebase"))
        .respond_with(ResponseTemplate::new(409).set_body_json(serde_json::json!({
            "message": "merge request has not been rebased"
        })))
        .mount(&s.api)
        .await;

    let err = s.adapter.update_branch(&pr()).await.unwrap_err();
    assert!(matches!(err, HostError::Conflict(_)), "got {err:?}");
}

#[tokio::test]
async fn enqueue_is_unsupported_on_gitlab() {
    let s = support::servers().await;
    let err = s.adapter.enqueue(&pr()).await.unwrap_err();
    assert!(matches!(err, HostError::Unsupported(_)), "got {err:?}");
}
