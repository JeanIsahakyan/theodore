//! Runs host-github's shared adapter contract (plan §6.9: "one contract
//! test suite, run against every adapter") against the GitLab adapter too.

mod support;

use theodore_domain::{HostKind, PrRef, RepoRef};
use theodore_host_github::testkit;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn gitlab_adapter_satisfies_the_shared_contract() {
    let s = support::servers().await;
    testkit::assert_capabilities_contract(&s.adapter);

    let pr = PrRef {
        repo: RepoRef {
            host: HostKind::Gitlab,
            owner: "acme".into(),
            name: "widgets".into(),
        },
        number: 42,
        host_id: Some("7".into()),
    };

    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("etag", "\"e1\"")
                .set_body_json(support::fixture("merge_request.json")),
        )
        .up_to_n_times(1)
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42"))
        .and(header("if-none-match", "\"e1\""))
        .respond_with(ResponseTemplate::new(304))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42/changes"))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("changes.json")))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42/discussions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42/pipelines"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42/approvals"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "approved_by": [], "approvals_required": null
        })))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42/commits"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
        .mount(&s.api)
        .await;

    testkit::assert_get_pr_contract(&s.adapter, &pr)
        .await
        .unwrap();
}
