mod support;

use theodore_domain::{Check, CheckStatus, HostKind, PrRef, RepoRef};
use theodore_ports::HostAdapter;
use wiremock::matchers::{method, path};
use wiremock::{Mock, ResponseTemplate};

fn pr() -> PrRef {
    PrRef {
        repo: RepoRef {
            host: HostKind::Gitlab,
            owner: "acme".into(),
            name: "widgets".into(),
        },
        number: 42,
        host_id: Some("7".into()),
    }
}

#[tokio::test]
async fn rerun_check_retries_the_pipeline_by_id() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/projects/7/pipelines/555/retry"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({})))
        .mount(&s.api)
        .await;

    let check = Check {
        id: "555".into(),
        name: "pipeline".into(),
        status: CheckStatus::Fail,
        url: Some("https://gitlab.com/acme/widgets/-/pipelines/555".into()),
        duration_ms: None,
    };
    s.adapter.rerun_check(&pr(), &check).await.unwrap();
}
