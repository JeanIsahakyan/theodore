//! Exercises `x-next-page` pagination end to end through a list endpoint
//! (plan §6.9: "pagination for threads/comments/files").

mod support;

use theodore_ports::{HostAdapter, InboxSection};
use wiremock::matchers::{method, path};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn search_follows_x_next_page_across_every_page() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/merge_requests"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("x-next-page", "2")
                .set_body_json(serde_json::json!([
                    {
                        "iid": 1, "project_id": 7, "title": "One", "state": "opened",
                        "draft": false, "web_url": "https://gitlab.example.com/acme/widgets/-/merge_requests/1",
                        "source_branch": "a", "target_branch": "main", "sha": "s1",
                        "author": { "id": 1, "username": "alice" },
                        "created_at": "2023-12-31T00:00:00.000Z", "updated_at": "2024-01-01T00:00:00.000Z"
                    }
                ])),
        )
        .up_to_n_times(1)
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/merge_requests"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
            {
                "iid": 2, "project_id": 7, "title": "Two", "state": "opened",
                "draft": false, "web_url": "https://gitlab.example.com/acme/widgets/-/merge_requests/2",
                "source_branch": "b", "target_branch": "main", "sha": "s2",
                "author": { "id": 1, "username": "alice" },
                "created_at": "2023-12-31T00:00:00.000Z", "updated_at": "2024-01-01T00:00:00.000Z"
            }
        ])))
        .mount(&s.api)
        .await;

    let results = s.adapter.search(&InboxSection::Authored).await.unwrap();
    let numbers: Vec<_> = results.iter().map(|r| r.pr.number).collect();
    assert_eq!(numbers, vec![1, 2]);
}

#[tokio::test]
async fn a_single_page_without_x_next_page_stops_immediately() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/merge_requests"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
        .expect(1)
        .mount(&s.api)
        .await;

    let results = s.adapter.search(&InboxSection::Authored).await.unwrap();
    assert!(results.is_empty());
}
