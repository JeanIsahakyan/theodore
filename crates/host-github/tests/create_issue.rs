mod support;

use theodore_ports::{HostError, IssueTracker, NewIssue};
use wiremock::matchers::{body_json, method, path};
use wiremock::{Mock, ResponseTemplate};

fn issue(labels: &[&str]) -> NewIssue {
    NewIssue {
        title: "Diff pane is blank".into(),
        body: "It shows nothing.".into(),
        labels: labels.iter().map(|l| l.to_string()).collect(),
    }
}

fn created() -> ResponseTemplate {
    ResponseTemplate::new(201).set_body_json(serde_json::json!({
        "number": 42,
        "html_url": "https://github.com/acme/theodore/issues/42",
        "title": "Diff pane is blank"
    }))
}

#[tokio::test]
async fn create_issue_posts_title_body_and_labels() {
    let s = support::servers().await;
    Mock::given(method("POST"))
        .and(path("/repos/acme/theodore/issues"))
        .and(body_json(serde_json::json!({
            "title": "Diff pane is blank",
            "body": "It shows nothing.",
            "labels": ["from-app"]
        })))
        .respond_with(created())
        .expect(1)
        .mount(&s.rest)
        .await;

    let got = s
        .adapter
        .create_issue("acme", "theodore", &issue(&["from-app"]))
        .await
        .unwrap();
    assert_eq!(got.number, 42);
    assert_eq!(got.url, "https://github.com/acme/theodore/issues/42");
}

#[tokio::test]
async fn refused_labels_are_retried_once_without_them() {
    let s = support::servers().await;
    Mock::given(method("POST"))
        .and(path("/repos/acme/theodore/issues"))
        .and(body_json(serde_json::json!({
            "title": "Diff pane is blank",
            "body": "It shows nothing.",
            "labels": ["from-app"]
        })))
        .respond_with(ResponseTemplate::new(422).set_body_json(serde_json::json!({
            "message": "Validation Failed",
            "errors": [{ "resource": "Label", "code": "invalid", "field": "labels" }]
        })))
        .expect(1)
        .mount(&s.rest)
        .await;
    Mock::given(method("POST"))
        .and(path("/repos/acme/theodore/issues"))
        .and(body_json(serde_json::json!({
            "title": "Diff pane is blank",
            "body": "It shows nothing."
        })))
        .respond_with(created())
        .expect(1)
        .mount(&s.rest)
        .await;

    let got = s
        .adapter
        .create_issue("acme", "theodore", &issue(&["from-app"]))
        .await
        .unwrap();
    assert_eq!(got.number, 42);
}

#[tokio::test]
async fn without_labels_a_refusal_is_not_retried() {
    let s = support::servers().await;
    Mock::given(method("POST"))
        .and(path("/repos/acme/theodore/issues"))
        .respond_with(ResponseTemplate::new(422).set_body_json(serde_json::json!({
            "message": "Validation Failed"
        })))
        .expect(1)
        .mount(&s.rest)
        .await;

    let err = s
        .adapter
        .create_issue("acme", "theodore", &issue(&[]))
        .await
        .unwrap_err();
    assert!(matches!(err, HostError::Validation(_)), "{err:?}");
}

#[tokio::test]
async fn a_rejected_token_stays_an_auth_error_after_the_retry() {
    let s = support::servers().await;
    Mock::given(method("POST"))
        .and(path("/repos/acme/theodore/issues"))
        .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
            "message": "Bad credentials"
        })))
        .expect(2)
        .mount(&s.rest)
        .await;

    let err = s
        .adapter
        .create_issue("acme", "theodore", &issue(&["from-app"]))
        .await
        .unwrap_err();
    assert!(matches!(err, HostError::Auth), "{err:?}");
}

#[tokio::test]
async fn has_token_reads_the_token_source_without_a_request() {
    assert!(support::servers().await.adapter.has_token());
    assert!(!support::servers_with_token(None).await.adapter.has_token());
}

#[tokio::test]
async fn login_is_the_viewer() {
    let s = support::servers().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": { "viewer": { "login": "octocat", "name": null, "avatarUrl": null } }
        })))
        .mount(&s.graphql)
        .await;
    assert_eq!(s.adapter.login().await.unwrap(), "octocat");
}
