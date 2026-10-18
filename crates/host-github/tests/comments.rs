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
async fn edit_comment_patches_the_rest_endpoint() {
    let s = support::servers().await;

    Mock::given(method("PATCH"))
        .and(path("/repos/acme/widgets/pulls/comments/1001"))
        .and(body_json(serde_json::json!({ "body": "updated body" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&s.rest)
        .await;

    s.adapter
        .edit_comment(&pr(), &CommentId::new("1001"), "updated body")
        .await
        .unwrap();
}

#[tokio::test]
async fn delete_comment_deletes_the_rest_endpoint() {
    let s = support::servers().await;

    Mock::given(method("DELETE"))
        .and(path("/repos/acme/widgets/pulls/comments/1001"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&s.rest)
        .await;

    s.adapter
        .delete_comment(&pr(), &CommentId::new("1001"))
        .await
        .unwrap();
}
