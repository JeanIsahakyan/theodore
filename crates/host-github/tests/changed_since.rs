mod support;

use theodore_ports::HostAdapter;
use wiremock::matchers::{body_string_contains, header, method, path};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn polls_notifications_and_maps_pr_subjects() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/notifications"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("x-poll-interval", "45")
                .insert_header("last-modified", "Thu, 01 Jan 2026 00:00:00 GMT")
                .set_body_json(serde_json::json!([
                    {
                        "subject": { "type": "PullRequest", "url": "https://api.github.com/repos/acme/widgets/pulls/42" },
                        "repository": { "name": "widgets", "owner": { "login": "acme" } }
                    },
                    {
                        "subject": { "type": "Issue", "url": "https://api.github.com/repos/acme/widgets/issues/7" },
                        "repository": { "name": "widgets", "owner": { "login": "acme" } }
                    }
                ])),
        )
        .mount(&s.rest)
        .await;

    let changes = s.adapter.changed_since(None).await.unwrap();
    assert_eq!(
        changes.prs.len(),
        1,
        "only the PullRequest subject should map to a PrRef"
    );
    assert_eq!(changes.prs[0].number, 42);
    assert_eq!(changes.prs[0].repo.owner, "acme");
    assert_eq!(changes.poll_after_ms, Some(45_000));
    assert_eq!(changes.cursor, "Thu, 01 Jan 2026 00:00:00 GMT");
}

#[tokio::test]
async fn sends_if_modified_since_from_the_previous_cursor() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/notifications"))
        .and(header("if-modified-since", "cursor-xyz"))
        .respond_with(ResponseTemplate::new(304))
        .mount(&s.rest)
        .await;

    let changes = s.adapter.changed_since(Some("cursor-xyz")).await.unwrap();
    assert!(changes.prs.is_empty());
    assert_eq!(changes.cursor, "cursor-xyz");
}

#[tokio::test]
async fn falls_back_to_graphql_search_when_notifications_scope_is_missing() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/notifications"))
        .respond_with(
            ResponseTemplate::new(403).set_body_string("Resource not accessible by integration"),
        )
        .mount(&s.rest)
        .await;

    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("involves:@me"))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("search_prs.json")))
        .mount(&s.graphql)
        .await;

    let changes = s.adapter.changed_since(None).await.unwrap();
    assert_eq!(changes.prs.len(), 1);
    assert_eq!(changes.prs[0].number, 99);
    assert_eq!(changes.poll_after_ms, Some(60_000));
}
