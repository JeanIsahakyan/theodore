//! Runs host-github's shared adapter contract (plan §6.9: "one contract
//! test suite, run against every adapter") against the Bitbucket adapter.

mod support;

use theodore_domain::{HostKind, PrRef, RepoRef};
use theodore_host_github::testkit;
use wiremock::matchers::{method, path};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn bitbucket_adapter_satisfies_the_shared_contract() {
    let s = support::servers().await;
    testkit::assert_capabilities_contract(&s.adapter);

    let pr = PrRef {
        repo: RepoRef {
            host: HostKind::Bitbucket,
            owner: "acme".into(),
            name: "widgets".into(),
        },
        number: 42,
        host_id: None,
    };

    Mock::given(method("GET"))
        .and(path("/repositories/acme/widgets/pullrequests/42"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(support::fixture("pull_request.json")),
        )
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/repositories/acme/widgets/pullrequests/42/diffstat"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "values": [] })))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/repositories/acme/widgets/pullrequests/42/commits"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "values": [] })))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/repositories/acme/widgets/pullrequests/42/statuses"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "values": [] })))
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/repositories/acme/widgets/pullrequests/42/comments"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({ "values": [] })))
        .mount(&s.api)
        .await;

    testkit::assert_get_pr_contract(&s.adapter, &pr)
        .await
        .unwrap();
}
