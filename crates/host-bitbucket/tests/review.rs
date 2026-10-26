mod support;

use theodore_domain::{Anchor, HostKind, PrRef, RepoRef, ReviewEvent, Sha, Side, ThreadId};
use theodore_ports::{HostAdapter, ReviewComment, ReviewSubmission};
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
async fn submit_review_posts_inline_comments_then_approves() {
    let s = support::servers().await;
    Mock::given(method("POST"))
        .and(path("/repositories/acme/widgets/pullrequests/42/comments"))
        .and(body_json(serde_json::json!({
            "content": { "raw": "nitpick\n\n<!-- theodore:marker-1 -->" },
            "inline": { "path": "src/lib.rs", "to": 30 }
        })))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("created_comment.json")),
        )
        .mount(&s.api)
        .await;
    Mock::given(method("POST"))
        .and(path("/repositories/acme/widgets/pullrequests/42/approve"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&s.api)
        .await;

    let review = ReviewSubmission {
        event: theodore_domain::ReviewEvent::Approve,
        body: String::new(),
        comments: vec![ReviewComment {
            anchor: Anchor {
                rev: Sha::new("bbbbbbbbbbbb"),
                path: "src/lib.rs".into(),
                side: Side::New,
                line: 30,
                start_line: None,
                start_side: None,
            },
            body: "nitpick".into(),
            marker: "marker-1".into(),
        }],
        commit: Sha::new("bbbbbbbbbbbb"),
    };

    let submitted = s.adapter.submit_review(&pr(), &review).await.unwrap();
    assert_eq!(
        submitted.threads,
        vec![("marker-1".to_string(), ThreadId::new("6001"))]
    );
}

#[tokio::test]
async fn submit_review_request_changes_hits_the_request_changes_endpoint() {
    let s = support::servers().await;
    Mock::given(method("POST"))
        .and(path(
            "/repositories/acme/widgets/pullrequests/42/request-changes",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&s.api)
        .await;

    let review = ReviewSubmission {
        event: ReviewEvent::RequestChanges,
        body: "please fix".into(),
        comments: vec![],
        commit: Sha::new("bbbbbbbbbbbb"),
    };
    Mock::given(method("POST"))
        .and(path("/repositories/acme/widgets/pullrequests/42/comments"))
        .and(body_json(serde_json::json!({
            "content": { "raw": "please fix" }
        })))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("created_comment.json")),
        )
        .mount(&s.api)
        .await;

    s.adapter.submit_review(&pr(), &review).await.unwrap();
}

#[tokio::test]
async fn submit_review_comment_event_posts_no_approval_call() {
    let s = support::servers().await;
    // No approve/request-changes mock mounted: a stray call would 404
    // inside wiremock and the adapter would surface that as an error,
    // failing the `unwrap()` below.
    let review = ReviewSubmission {
        event: ReviewEvent::Comment,
        body: String::new(),
        comments: vec![],
        commit: Sha::new("bbbbbbbbbbbb"),
    };
    let submitted = s.adapter.submit_review(&pr(), &review).await.unwrap();
    assert!(submitted.threads.is_empty());
}
