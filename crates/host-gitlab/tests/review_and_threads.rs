mod support;

use theodore_domain::{
    Anchor, CommentId, HostKind, PrRef, RepoRef, ReviewEvent, Sha, Side, ThreadId,
};
use theodore_ports::{HostAdapter, ReviewComment, ReviewSubmission};
use wiremock::matchers::{body_json_string, body_partial_json, method, path};
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

fn comment(marker: &str, line: u32) -> ReviewComment {
    ReviewComment {
        anchor: Anchor {
            rev: Sha::new("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
            path: "src/lib.rs".into(),
            side: Side::New,
            line,
            start_line: None,
            start_side: None,
        },
        body: "Please fix this.".into(),
        marker: marker.into(),
    }
}

#[tokio::test]
async fn submit_review_posts_draft_notes_then_bulk_publishes_and_approves() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("merge_request.json")),
        )
        .mount(&s.api)
        .await;

    Mock::given(method("POST"))
        .and(path("/projects/7/merge_requests/42/draft_notes"))
        .and(body_partial_json(
            serde_json::json!({ "note": "Please fix this.\n\n<!-- theodore:m1 -->" }),
        ))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({ "id": 1 })))
        .mount(&s.api)
        .await;
    Mock::given(method("POST"))
        .and(path(
            "/projects/7/merge_requests/42/draft_notes/bulk_publish",
        ))
        .respond_with(ResponseTemplate::new(204))
        .mount(&s.api)
        .await;
    Mock::given(method("POST"))
        .and(path("/projects/7/merge_requests/42/approve"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({})))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42/discussions"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(support::fixture("discussions_with_marker.json")),
        )
        .mount(&s.api)
        .await;

    let submission = ReviewSubmission {
        event: ReviewEvent::Approve,
        body: String::new(),
        comments: vec![comment("m1", 10)],
        commit: Sha::new("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    };

    let submitted = s.adapter.submit_review(&pr(), &submission).await.unwrap();
    assert_eq!(
        submitted.threads,
        vec![("m1".to_string(), ThreadId::new("disc_marked"))]
    );
    assert!(
        submitted
            .review_id
            .contains("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    );
}

#[tokio::test]
async fn request_changes_posts_comments_but_never_calls_approve() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("merge_request.json")),
        )
        .mount(&s.api)
        .await;
    Mock::given(method("POST"))
        .and(path("/projects/7/merge_requests/42/draft_notes"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({ "id": 1 })))
        .mount(&s.api)
        .await;
    Mock::given(method("POST"))
        .and(path(
            "/projects/7/merge_requests/42/draft_notes/bulk_publish",
        ))
        .respond_with(ResponseTemplate::new(204))
        .mount(&s.api)
        .await;
    // No /approve mock mounted: a stray call would 404 inside wiremock and
    // fail the `unwrap()` below.
    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42/discussions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
        .mount(&s.api)
        .await;

    let submission = ReviewSubmission {
        event: ReviewEvent::RequestChanges,
        body: "Needs work.".into(),
        comments: vec![comment("m1", 10)],
        commit: Sha::new("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    };
    s.adapter.submit_review(&pr(), &submission).await.unwrap();
}

#[tokio::test]
async fn find_marker_scans_discussions_for_the_tagged_note() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42/discussions"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(support::fixture("discussions_with_marker.json")),
        )
        .mount(&s.api)
        .await;

    let found = s.adapter.find_marker(&pr(), "m1").await.unwrap();
    assert_eq!(found, Some(CommentId::new("6001")));

    let missing = s
        .adapter
        .find_marker(&pr(), "no-such-marker")
        .await
        .unwrap();
    assert_eq!(missing, None);
}

#[tokio::test]
async fn reply_posts_a_note_on_the_discussion_and_returns_its_id() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path(
            "/projects/7/merge_requests/42/discussions/disc_1/notes",
        ))
        .and(body_json_string(r#"{"body":"Sounds good."}"#))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
            "id": 7001,
            "body": "Sounds good.",
            "author": { "id": 1, "username": "alice", "name": "Alice", "avatar_url": null },
            "created_at": "2024-01-02T03:06:00.000Z",
            "updated_at": "2024-01-02T03:06:00.000Z",
            "system": false,
            "resolvable": true,
            "resolved": false,
            "position": null
        })))
        .mount(&s.api)
        .await;

    let id = s
        .adapter
        .reply(&pr(), &ThreadId::new("disc_1"), "Sounds good.")
        .await
        .unwrap();
    assert_eq!(id, CommentId::new("7001"));
}

#[tokio::test]
async fn resolve_and_unresolve_set_the_resolved_query_param() {
    let s = support::servers().await;

    Mock::given(method("PUT"))
        .and(path("/projects/7/merge_requests/42/discussions/disc_1"))
        .and(wiremock::matchers::query_param("resolved", "true"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&s.api)
        .await;
    Mock::given(method("PUT"))
        .and(path("/projects/7/merge_requests/42/discussions/disc_1"))
        .and(wiremock::matchers::query_param("resolved", "false"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
        .mount(&s.api)
        .await;

    s.adapter
        .resolve(&pr(), &ThreadId::new("disc_1"), true)
        .await
        .unwrap();
    s.adapter
        .resolve(&pr(), &ThreadId::new("disc_1"), false)
        .await
        .unwrap();
}
