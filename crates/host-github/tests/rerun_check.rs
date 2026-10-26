mod support;

use theodore_domain::{Check, CheckStatus, HostKind, PrRef, RepoRef};
use theodore_ports::HostAdapter;
use wiremock::matchers::{method, path};
use wiremock::{Mock, ResponseTemplate};

fn pr() -> PrRef {
    PrRef {
        repo: RepoRef {
            host: HostKind::Github,
            owner: "acme".into(),
            name: "widgets".into(),
        },
        number: 42,
        host_id: Some("PR_node_42".into()),
    }
}

fn check(id: &str, url: Option<&str>) -> Check {
    Check {
        id: id.into(),
        name: "build".into(),
        status: CheckStatus::Fail,
        url: url.map(str::to_string),
        duration_ms: None,
    }
}

#[tokio::test]
async fn rerun_check_rerequests_a_plain_check_run_by_its_numeric_id() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/repos/acme/widgets/check-runs/900001/rerequest"))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({})))
        .mount(&s.rest)
        .await;

    s.adapter
        .rerun_check(&pr(), &check("900001", Some("https://ci.example/1")))
        .await
        .unwrap();
}

#[tokio::test]
async fn rerun_check_reruns_failed_jobs_for_an_actions_check_run() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path(
            "/repos/acme/widgets/actions/runs/555/rerun-failed-jobs",
        ))
        .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({})))
        .mount(&s.rest)
        .await;

    let url = "https://github.com/acme/widgets/actions/runs/555/job/999";
    s.adapter
        .rerun_check(&pr(), &check("900002", Some(url)))
        .await
        .unwrap();

    // No /check-runs/.../rerequest call should have been made.
    let requests = s.rest.received_requests().await.unwrap();
    assert_eq!(requests.len(), 1);
}

#[tokio::test]
async fn rerun_check_rejects_a_non_numeric_id_with_no_url() {
    let s = support::servers().await;
    let err = s
        .adapter
        .rerun_check(&pr(), &check("sc1", None))
        .await
        .unwrap_err();
    assert!(matches!(err, theodore_ports::HostError::Unsupported(_)));
}
