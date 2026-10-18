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
