mod support;

use theodore_domain::{HostKind, PrRef, RepoRef};
use theodore_ports::{HostAdapter, MergeMethod, MergeState};
use wiremock::matchers::{method, path};
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

async fn mount(s: &support::Servers, merge_status: &str, detailed: &str, mwps: bool) {
    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "iid": 42, "project_id": 7, "title": "Add feature X", "state": "opened",
            "web_url": "https://gitlab.com/acme/widgets/-/merge_requests/42",
            "source_branch": "feature-x", "target_branch": "main",
            "sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "author": { "id": 1, "username": "alice" },
            "created_at": "2023-12-31T00:00:00.000Z", "updated_at": "2024-01-01T00:00:00.000Z",
            "merge_status": merge_status,
            "detailed_merge_status": detailed,
            "merge_when_pipeline_succeeds": mwps
        })))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42/approvals"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "approved_by": [],
            "approvals_required": 2
        })))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/projects/7"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "squash_option": "default_on",
            "merge_method": "merge"
        })))
        .mount(&s.api)
        .await;
}

#[tokio::test]
async fn merge_status_maps_a_clean_mergeable_mr() {
    let s = support::servers().await;
    mount(&s, "can_be_merged", "mergeable", false).await;

    let status = s.adapter.merge_status(&pr()).await.unwrap();
    assert_eq!(status.mergeable, Some(true));
    assert_eq!(status.state, MergeState::Clean);
    assert_eq!(
        status.allowed_methods,
        vec![MergeMethod::Merge, MergeMethod::Squash]
    );
    assert!(!status.auto_merge_enabled);
    assert!(!status.in_queue);
    assert_eq!(status.required_approvals, Some(2));
}

#[tokio::test]
async fn merge_status_maps_a_conflict() {
    let s = support::servers().await;
    mount(&s, "cannot_be_merged", "conflict", true).await;

    let status = s.adapter.merge_status(&pr()).await.unwrap();
    assert_eq!(status.mergeable, Some(false));
    assert_eq!(status.state, MergeState::Dirty);
    assert!(status.auto_merge_enabled);
}

#[tokio::test]
async fn merge_status_excludes_squash_when_the_project_forbids_it() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "iid": 42, "project_id": 7, "title": "Add feature X", "state": "opened",
            "web_url": "https://gitlab.com/acme/widgets/-/merge_requests/42",
            "source_branch": "feature-x", "target_branch": "main",
            "sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "author": { "id": 1, "username": "alice" },
            "created_at": "2023-12-31T00:00:00.000Z", "updated_at": "2024-01-01T00:00:00.000Z",
            "merge_status": "can_be_merged",
            "detailed_merge_status": "mergeable"
        })))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42/approvals"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "approved_by": []
        })))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/projects/7"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "squash_option": "never",
            "merge_method": "ff"
        })))
        .mount(&s.api)
        .await;

    let status = s.adapter.merge_status(&pr()).await.unwrap();
    assert_eq!(status.allowed_methods, vec![]);
}
