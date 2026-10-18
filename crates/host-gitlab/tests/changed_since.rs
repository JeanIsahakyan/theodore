mod support;

use theodore_ports::HostAdapter;
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn first_probe_has_no_updated_after_and_mints_a_fresh_cursor() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/merge_requests"))
        .and(query_param("scope", "all"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("search_mrs_page1.json")),
        )
        .mount(&s.api)
        .await;

    let changes = s.adapter.changed_since(None).await.unwrap();
    assert_eq!(changes.prs.len(), 1);
    assert_eq!(changes.prs[0].number, 99);
    // The fake clock starts at 1_700_000_000_000 ms.
    assert_eq!(changes.cursor, "2023-11-14T22:13:20.000Z");
    assert_eq!(changes.poll_after_ms, Some(60_000));
}

#[tokio::test]
async fn later_probe_sends_updated_after_from_the_previous_cursor() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/merge_requests"))
        .and(query_param("updated_after", "2024-01-01T00:00:00.000Z"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
        .mount(&s.api)
        .await;

    let changes = s
        .adapter
        .changed_since(Some("2024-01-01T00:00:00.000Z"))
        .await
        .unwrap();
    assert!(changes.prs.is_empty());
}
