mod support;

use theodore_domain::InboxReason;
use theodore_ports::{HostAdapter, InboxSection};
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn review_requested_resolves_the_viewer_then_filters_by_reviewer_username() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/user"))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("user.json")))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/merge_requests"))
        .and(query_param("reviewer_username", "alice"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("search_mrs_page1.json")),
        )
        .mount(&s.api)
        .await;

    let results = s
        .adapter
        .search(&InboxSection::ReviewRequested)
        .await
        .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].pr.number, 99);
    assert_eq!(results[0].reasons, vec![InboxReason::ReviewRequested]);
    assert_eq!(results[0].pr.repo.owner, "acme");
    assert_eq!(results[0].pr.repo.name, "widgets");
    assert_eq!(results[0].changed_files, 3);
}

#[tokio::test]
async fn assigned_section_uses_the_assigned_to_me_scope() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/merge_requests"))
        .and(query_param("scope", "assigned_to_me"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("search_mrs_page1.json")),
        )
        .mount(&s.api)
        .await;

    let results = s.adapter.search(&InboxSection::Assigned).await.unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].reasons, vec![InboxReason::Assigned]);
}

#[tokio::test]
async fn mentioned_section_reads_pending_todos_instead_of_merge_requests() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/todos"))
        .and(query_param("action", "mentioned"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("todos_page1.json")),
        )
        .mount(&s.api)
        .await;

    let results = s.adapter.search(&InboxSection::Mentioned).await.unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].pr.number, 55);
    assert_eq!(results[0].reasons, vec![InboxReason::Mentioned]);
}

#[tokio::test]
async fn raw_query_section_is_appended_verbatim() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/merge_requests"))
        .and(query_param("labels", "urgent"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("search_mrs_page1.json")),
        )
        .mount(&s.api)
        .await;

    let results = s
        .adapter
        .search(&InboxSection::Query("labels=urgent".to_string()))
        .await
        .unwrap();
    assert_eq!(results.len(), 1);
    assert!(results[0].reasons.is_empty());
}
