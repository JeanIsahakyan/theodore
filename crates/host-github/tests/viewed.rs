mod support;

use theodore_domain::{HostKind, PrRef, RepoRef};
use theodore_ports::HostAdapter;
use wiremock::matchers::{body_string_contains, method, path};
use wiremock::{Mock, ResponseTemplate};

fn pr_with_node_id() -> PrRef {
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

#[tokio::test]
async fn set_viewed_true_calls_mark_file_as_viewed() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("markFileAsViewed"))
        .and(body_string_contains("PR_node_42"))
        .and(body_string_contains("src/lib.rs"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": { "markFileAsViewed": { "clientMutationId": null } }
        })))
        .mount(&s.graphql)
        .await;

    s.adapter
        .set_viewed(&pr_with_node_id(), "src/lib.rs", true)
        .await
        .unwrap();
}

#[tokio::test]
async fn set_viewed_false_calls_unmark_file_as_viewed() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("unmarkFileAsViewed"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": { "unmarkFileAsViewed": { "clientMutationId": null } }
        })))
        .mount(&s.graphql)
        .await;

    s.adapter
        .set_viewed(&pr_with_node_id(), "src/lib.rs", false)
        .await
        .unwrap();
}

#[tokio::test]
async fn set_viewed_resolves_node_id_when_pr_ref_lacks_one() {
    let s = support::servers().await;
    let pr = PrRef {
        repo: RepoRef {
            host: HostKind::Github,
            owner: "acme".into(),
            name: "widgets".into(),
        },
        number: 42,
        host_id: None,
    };

    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("pullRequest(number"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": { "repository": { "pullRequest": { "id": "PR_node_42" } } }
        })))
        .mount(&s.graphql)
        .await;
    Mock::given(method("POST"))
        .and(path("/"))
        .and(body_string_contains("markFileAsViewed"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": { "markFileAsViewed": { "clientMutationId": null } }
        })))
        .mount(&s.graphql)
        .await;

    s.adapter.set_viewed(&pr, "src/lib.rs", true).await.unwrap();
}
