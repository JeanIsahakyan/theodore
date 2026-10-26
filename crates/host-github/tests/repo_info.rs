mod support;

use theodore_domain::{HostKind, RepoRef};
use theodore_ports::HostAdapter;
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn fetches_description_visibility_and_last_push_for_one_repo() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("\"owner\":\"acme\""))
        .and(body_string_contains("\"repo\":\"widgets\""))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": {
                "repository": {
                    "description": "Widgets for acme",
                    "isPrivate": true,
                    "pushedAt": "2024-01-02T03:04:05Z"
                }
            }
        })))
        .mount(&s.graphql)
        .await;

    let repo = RepoRef {
        host: HostKind::Github,
        owner: "acme".into(),
        name: "widgets".into(),
    };
    let info = s.adapter.repo_info(&repo).await.unwrap();

    assert_eq!(info.repo, repo);
    assert_eq!(info.description, Some("Widgets for acme".to_string()));
    assert!(info.private);
    assert!(info.pushed_at.is_some());
}

#[tokio::test]
async fn missing_repo_is_not_found() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": { "repository": null }
        })))
        .mount(&s.graphql)
        .await;

    let repo = RepoRef {
        host: HostKind::Github,
        owner: "acme".into(),
        name: "gone".into(),
    };
    let err = s.adapter.repo_info(&repo).await.unwrap_err();
    assert!(matches!(err, theodore_ports::HostError::NotFound(_)));
}
