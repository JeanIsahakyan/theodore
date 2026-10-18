//! Exercises `theodore_host_github::testkit` — the reusable contract
//! assertions other adapters are meant to run too (plan §6.9).

mod support;

use theodore_domain::{HostKind, PrRef, RepoRef};
use theodore_host_github::testkit;
use wiremock::matchers::{body_string_contains, header, method, path};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn github_adapter_satisfies_the_shared_contract() {
    let s = support::servers().await;
    testkit::assert_capabilities_contract(&s.adapter);

    let pr = PrRef {
        repo: RepoRef {
            host: HostKind::Github,
            owner: "acme".into(),
            name: "widgets".into(),
        },
        number: 42,
        host_id: None,
    };

    Mock::given(method("GET"))
        .and(path("/repos/acme/widgets/pulls/42"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("etag", "\"e1\"")
                .set_body_json(serde_json::json!({})),
        )
        .up_to_n_times(1)
        .mount(&s.rest)
        .await;
    Mock::given(method("GET"))
        .and(path("/repos/acme/widgets/pulls/42"))
        .and(header("if-none-match", "\"e1\""))
        .respond_with(ResponseTemplate::new(304))
        .mount(&s.rest)
        .await;

    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("statusCheckRollup"))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("pr_core.json")))
        .mount(&s.graphql)
        .await;
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("viewerViewedState"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("pr_files_page2.json")),
        )
        .mount(&s.graphql)
        .await;
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("reviewThreads"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("pr_threads_page2.json")),
        )
        .mount(&s.graphql)
        .await;

    testkit::assert_get_pr_contract(&s.adapter, &pr)
        .await
        .unwrap();
}
