mod support;

use theodore_ports::HostAdapter;
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn lists_every_page_of_the_viewers_repositories_with_metadata() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("\"after\":null"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": {
                "viewer": {
                    "repositories": {
                        "pageInfo": { "hasNextPage": true, "endCursor": "repos-cursor-1" },
                        "nodes": [{
                            "name": "widgets",
                            "owner": { "login": "acme" },
                            "description": "Widgets for acme",
                            "isPrivate": false,
                            "pushedAt": "2024-01-02T03:04:05Z"
                        }]
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
                        "nodes": [{
                            "name": "gizmos",
                            "owner": { "login": "acme" },
                            "description": null,
                            "isPrivate": true,
                            "pushedAt": null
                        }]
                    }
                }
            }
        })))
        .mount(&s.graphql)
        .await;

    let repos = s.adapter.list_repos().await.unwrap();
    let names: Vec<_> = repos.iter().map(|r| r.repo.name.clone()).collect();
    assert_eq!(names, vec!["widgets".to_string(), "gizmos".to_string()]);

    assert_eq!(repos[0].description, Some("Widgets for acme".to_string()));
    assert!(!repos[0].private);
    assert!(repos[0].pushed_at.is_some());

    assert_eq!(repos[1].description, None);
    assert!(repos[1].private);
    assert_eq!(repos[1].pushed_at, None);
}
