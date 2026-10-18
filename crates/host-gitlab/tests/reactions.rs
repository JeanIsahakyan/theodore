mod support;

use theodore_domain::{CommentId, HostKind, PrRef, RepoRef};
use theodore_ports::HostAdapter;
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

#[tokio::test]
async fn add_reaction_posts_the_emoji_name() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/projects/7/merge_requests/42/notes/1001/award_emoji"))
        .and(body_json(serde_json::json!({ "name": "thumbsup" })))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "id": 1, "name": "thumbsup", "user": { "id": 1, "username": "me" }
        })))
        .mount(&s.api)
        .await;

    s.adapter
        .add_reaction(&pr(), &CommentId::new("1001"), "thumbsup")
        .await
        .unwrap();
}

#[tokio::test]
async fn remove_reaction_finds_the_viewers_award_then_deletes_it() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/user"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": 1, "username": "me"
        })))
        .mount(&s.api)
        .await;

    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42/notes/1001/award_emoji"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
            { "id": 9, "name": "thumbsup", "user": { "id": 2, "username": "someone-else" } },
            { "id": 10, "name": "thumbsup", "user": { "id": 1, "username": "me" } },
        ])))
        .mount(&s.api)
        .await;

    Mock::given(method("DELETE"))
        .and(path(
            "/projects/7/merge_requests/42/notes/1001/award_emoji/10",
        ))
        .respond_with(ResponseTemplate::new(204))
        .mount(&s.api)
        .await;

    s.adapter
        .remove_reaction(&pr(), &CommentId::new("1001"), "thumbsup")
        .await
        .unwrap();
}
