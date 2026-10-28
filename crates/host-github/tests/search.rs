mod support;

use theodore_domain::InboxReason;
use theodore_ports::{HostAdapter, InboxSection};
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn review_requested_section_tags_every_result_with_the_reason() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("review-requested:@me"))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("search_prs.json")))
        .mount(&s.graphql)
        .await;

    let results = s
        .adapter
        .search(&InboxSection::ReviewRequested)
        .await
        .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].pr.number, 99);
    assert_eq!(results[0].reasons, vec![InboxReason::ReviewRequested]);
    // Fixture's `createdAt` (2024-01-28) is before `updatedAt` (2024-02-01).
    assert!(results[0].created_at.is_some());
    assert!(results[0].created_at.unwrap() < results[0].updated_at);
}

#[tokio::test]
async fn raw_query_section_sends_it_verbatim_and_tags_no_reason() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("is:pr is:open label:urgent"))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("search_prs.json")))
        .mount(&s.graphql)
        .await;

    let results = s
        .adapter
        .search(&InboxSection::Query(
            "is:pr is:open label:urgent".to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(results.len(), 1);
    assert!(results[0].reasons.is_empty());
}

#[tokio::test]
async fn a_query_with_partial_errors_still_returns_its_data() {
    let s = support::servers().await;

    let mut body = support::fixture("search_prs.json");
    body["errors"] = serde_json::json!([{
        "type": "FORBIDDEN",
        "message": "Resource protected by organization SAML enforcement.",
        "path": ["search", "nodes", 1]
    }]);
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("review-requested:@me"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(&s.graphql)
        .await;

    let results = s
        .adapter
        .search(&InboxSection::ReviewRequested)
        .await
        .unwrap();
    assert_eq!(results.len(), 1);
}
