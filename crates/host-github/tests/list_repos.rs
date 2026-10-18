mod support;

use theodore_ports::HostAdapter;
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn lists_every_page_of_the_viewers_repositories() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("\"after\":null"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": {
                "viewer": {
                    "repositories": {
                        "pageInfo": { "hasNextPage": true, "endCursor": "repos-cursor-1" },
                        "nodes": [{ "name": "widgets", "owner": { "login": "acme" } }]
                    }
                }
            }
        })))
        .mount(&s.graphql)
        .await;
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("repos-cursor-1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": {
                "viewer": {
                    "repositories": {
                        "pageInfo": { "hasNextPage": false, "endCursor": null },
                        "nodes": [{ "name": "gizmos", "owner": { "login": "acme" } }]
                    }
                }
            }
        })))
        .mount(&s.graphql)
        .await;

    let repos = s.adapter.list_repos().await.unwrap();
    let names: Vec<_> = repos.iter().map(|r| r.name.clone()).collect();
    assert_eq!(names, vec!["widgets".to_string(), "gizmos".to_string()]);
}
