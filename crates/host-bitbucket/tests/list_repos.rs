mod support;

use theodore_ports::HostAdapter;
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn list_repos_follows_next_links_across_pages() {
    let s = support::servers().await;

    // `next` is a full absolute URL (Bitbucket's own pagination style, see
    // `crate::pagination`); point it at this test's own server so following
    // it doesn't leave the mock.
    let mut page1 = support::fixture("repositories_page1.json");
    page1["next"] = serde_json::Value::String(format!(
        "{}/repositories?role=member&pagelen=50&page=2",
        s.api.uri()
    ));

    Mock::given(method("GET"))
        .and(path("/repositories"))
        .and(query_param("role", "member"))
        .and(query_param("page", "2"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("repositories_page2.json")),
        )
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/repositories"))
        .and(query_param("role", "member"))
        .respond_with(ResponseTemplate::new(200).set_body_json(page1))
        .mount(&s.api)
        .await;

    let repos = s.adapter.list_repos().await.unwrap();
    assert_eq!(repos.len(), 3);
    assert_eq!(repos[0].repo.owner, "acme");
    assert_eq!(repos[0].repo.name, "widgets");
    assert_eq!(repos[0].description, Some("Widgets for Acme".to_string()));
    assert!(repos[0].private);
    assert_eq!(repos[2].repo.owner, "other-ws");
    assert_eq!(repos[2].repo.name, "thing");
    assert!(!repos[2].private);
}
