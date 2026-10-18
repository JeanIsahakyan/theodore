mod support;

use theodore_domain::{HostKind, PrRef, RepoRef};
use theodore_ports::HostAdapter;
use wiremock::matchers::{body_json, method, path};
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
async fn request_reviewers_posts_users_and_teams() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/repos/acme/widgets/pulls/42/requested_reviewers"))
        .and(body_json(serde_json::json!({
            "reviewers": ["alice", "bob"],
            "team_reviewers": ["platform"]
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({})))
        .mount(&s.rest)
        .await;

    s.adapter
        .request_reviewers(
            &pr(),
            &["alice".to_string(), "bob".to_string()],
            &["platform".to_string()],
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn remove_reviewer_deletes_with_a_body() {
    let s = support::servers().await;

    Mock::given(method("DELETE"))
        .and(path("/repos/acme/widgets/pulls/42/requested_reviewers"))
        .and(body_json(serde_json::json!({ "reviewers": ["alice"] })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&s.rest)
        .await;

    s.adapter.remove_reviewer(&pr(), "alice").await.unwrap();
}
