mod support;

use theodore_ports::HostAdapter;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn lists_every_page_of_projects_and_splits_the_namespace_path() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/projects"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("x-next-page", "2")
                .set_body_json(serde_json::json!([
                    { "path_with_namespace": "acme/widgets" }
                ])),
        )
        .up_to_n_times(1)
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/projects"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
            { "path_with_namespace": "acme/team/gizmos" }
        ])))
        .mount(&s.api)
        .await;

    let repos = s.adapter.list_repos().await.unwrap();
    assert_eq!(repos.len(), 2);
    assert_eq!(repos[0].owner, "acme");
    assert_eq!(repos[0].name, "widgets");
    assert_eq!(repos[1].owner, "acme/team");
    assert_eq!(repos[1].name, "gizmos");
}

#[tokio::test]
async fn viewer_validates_the_token_against_the_user_endpoint() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/user"))
        .and(header("authorization", "Bearer test-token"))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("user.json")))
        .mount(&s.api)
        .await;

    let person = s.adapter.viewer().await.unwrap();
    assert_eq!(person.login, "alice");
    assert_eq!(person.name, Some("Alice".to_string()));
}
