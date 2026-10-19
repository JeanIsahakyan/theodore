mod support;

use theodore_domain::{CommentId, HostKind, PrRef, RepoRef, ThreadId};
use theodore_ports::HostAdapter;
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
async fn find_marker_locates_the_comment_carrying_the_tag() {
    let s = support::servers().await;
    Mock::given(method("GET"))
        .and(path("/repositories/acme/widgets/pullrequests/42/comments"))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("comments.json")))
        .mount(&s.api)
        .await;

    // None of the fixture's comments carry the marker.
    let found = s.adapter.find_marker(&pr(), "marker-1").await.unwrap();
    assert_eq!(found, None);
}

#[tokio::test]
async fn find_marker_returns_the_comment_id_when_present() {
    let s = support::servers().await;
    let mut comments = support::fixture("comments.json");
    comments["values"][0]["content"]["raw"] =
        serde_json::Value::String("hello\n\n<!-- theodore:marker-1 -->".into());
    Mock::given(method("GET"))
        .and(path("/repositories/acme/widgets/pullrequests/42/comments"))
        .respond_with(ResponseTemplate::new(200).set_body_json(comments))
        .mount(&s.api)
        .await;

    let found = s.adapter.find_marker(&pr(), "marker-1").await.unwrap();
    assert_eq!(found, Some(CommentId::new("5001")));
}

#[tokio::test]
async fn reply_posts_a_comment_with_the_thread_as_parent() {
    let s = support::servers().await;
    Mock::given(method("POST"))
        .and(path("/repositories/acme/widgets/pullrequests/42/comments"))
        .and(body_json(serde_json::json!({
            "content": { "raw": "thanks!" },
            "parent": { "id": 5001 }
        })))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("created_comment.json")),
        )
        .mount(&s.api)
        .await;

    let id = s
        .adapter
        .reply(&pr(), &ThreadId::new("5001"), "thanks!")
        .await
        .unwrap();
    assert_eq!(id, CommentId::new("6001"));
}

#[tokio::test]
async fn resolve_true_posts_to_the_resolve_endpoint() {
    let s = support::servers().await;
    Mock::given(method("POST"))
        .and(path(
            "/repositories/acme/widgets/pullrequests/42/comments/5001/resolve",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&s.api)
        .await;

    s.adapter
        .resolve(&pr(), &ThreadId::new("5001"), true)
        .await
        .unwrap();
}

#[tokio::test]
async fn resolve_false_deletes_the_resolve_endpoint() {
    let s = support::servers().await;
    Mock::given(method("DELETE"))
        .and(path(
            "/repositories/acme/widgets/pullrequests/42/comments/5001/resolve",
        ))
        .respond_with(ResponseTemplate::new(204))
        .mount(&s.api)
        .await;

    s.adapter
        .resolve(&pr(), &ThreadId::new("5001"), false)
        .await
        .unwrap();
}

#[tokio::test]
async fn edit_comment_puts_the_new_body() {
    let s = support::servers().await;
    Mock::given(method("PUT"))
        .and(path(
            "/repositories/acme/widgets/pullrequests/42/comments/5001",
        ))
        .and(body_json(serde_json::json!({
            "content": { "raw": "edited body" }
        })))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("created_comment.json")),
        )
        .mount(&s.api)
        .await;

    s.adapter
        .edit_comment(&pr(), &CommentId::new("5001"), "edited body")
        .await
        .unwrap();
}

#[tokio::test]
async fn delete_comment_deletes_by_id() {
    let s = support::servers().await;
    Mock::given(method("DELETE"))
        .and(path(
            "/repositories/acme/widgets/pullrequests/42/comments/5001",
        ))
        .respond_with(ResponseTemplate::new(204))
        .mount(&s.api)
        .await;

    s.adapter
        .delete_comment(&pr(), &CommentId::new("5001"))
        .await
        .unwrap();
}
