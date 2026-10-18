mod support;

use theodore_domain::{CommentId, HostKind, PrRef, RepoRef};
use theodore_ports::{HostAdapter, HostError};
use wiremock::matchers::{body_json_string, method, path};
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
async fn edit_comment_hits_the_flat_notes_endpoint_by_note_id_alone() {
    let s = support::servers().await;

    Mock::given(method("PUT"))
        .and(path("/projects/7/merge_requests/42/notes/1001"))
        .and(body_json_string(r#"{"body":"updated body"}"#))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&s.api)
        .await;

    s.adapter
        .edit_comment(&pr(), &CommentId::new("1001"), "updated body")
        .await
        .unwrap();
}

#[tokio::test]
async fn delete_comment_hits_the_flat_notes_endpoint() {
    let s = support::servers().await;

    Mock::given(method("DELETE"))
        .and(path("/projects/7/merge_requests/42/notes/1001"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&s.api)
        .await;

    s.adapter
        .delete_comment(&pr(), &CommentId::new("1001"))
        .await
        .unwrap();
}

#[tokio::test]
async fn set_viewed_is_unsupported() {
    let s = support::servers().await;

    let err = s
        .adapter
        .set_viewed(&pr(), "src/lib.rs", true)
        .await
        .unwrap_err();
    assert!(matches!(err, HostError::Unsupported(_)), "got {err:?}");
}
