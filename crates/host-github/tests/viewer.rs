mod support;

use theodore_ports::HostAdapter;
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn viewer_returns_the_authenticated_person() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("viewer"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": {
                "viewer": {
                    "login": "octocat",
                    "name": "The Octocat",
                    "avatarUrl": "https://example.com/octocat.png"
                }
            }
        })))
        .mount(&s.graphql)
        .await;

    let me = s.adapter.viewer().await.unwrap();
    assert_eq!(me.login, "octocat");
    assert_eq!(me.name, Some("The Octocat".into()));
    assert_eq!(
        me.avatar_url,
        Some("https://example.com/octocat.png".into())
    );
}

#[tokio::test]
async fn viewer_surfaces_auth_errors_from_a_rejected_token() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("viewer"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "errors": [{ "message": "Bad credentials", "type": "FORBIDDEN" }]
        })))
        .mount(&s.graphql)
        .await;

    let err = s.adapter.viewer().await.unwrap_err();
    assert!(matches!(err, theodore_ports::HostError::Auth));
}
