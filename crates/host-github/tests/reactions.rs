mod support;

use theodore_domain::{CommentId, HostKind, PrRef, RepoRef};
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
async fn add_reaction_posts_the_content() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/repos/acme/widgets/pulls/comments/1001/reactions"))
        .and(body_json(serde_json::json!({ "content": "+1" })))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "id": 5001, "content": "+1", "user": { "login": "octocat" }
        })))
        .mount(&s.rest)
        .await;

    s.adapter
        .add_reaction(&pr(), &CommentId::new("1001"), "+1")
        .await
        .unwrap();
}

#[tokio::test]
async fn remove_reaction_finds_the_viewers_reaction_then_deletes_it() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": { "viewer": { "login": "octocat", "name": null, "avatarUrl": null } }
        })))
        .mount(&s.graphql)
        .await;

    Mock::given(method("GET"))
        .and(path("/repos/acme/widgets/pulls/comments/1001/reactions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
            { "id": 5001, "content": "+1", "user": { "login": "someone-else" } },
            { "id": 5002, "content": "+1", "user": { "login": "octocat" } },
        ])))
        .mount(&s.rest)
        .await;

    Mock::given(method("DELETE"))
        .and(path(
            "/repos/acme/widgets/pulls/comments/1001/reactions/5002",
        ))
        .respond_with(ResponseTemplate::new(204))
        .mount(&s.rest)
        .await;

    s.adapter
        .remove_reaction(&pr(), &CommentId::new("1001"), "+1")
        .await
        .unwrap();
}

#[tokio::test]
async fn remove_reaction_is_a_noop_when_the_viewer_never_reacted() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": { "viewer": { "login": "octocat", "name": null, "avatarUrl": null } }
        })))
        .mount(&s.graphql)
        .await;

    Mock::given(method("GET"))
        .and(path("/repos/acme/widgets/pulls/comments/1001/reactions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
            { "id": 5001, "content": "+1", "user": { "login": "someone-else" } },
        ])))
        .mount(&s.rest)
        .await;

    s.adapter
        .remove_reaction(&pr(), &CommentId::new("1001"), "+1")
        .await
        .unwrap();
}
