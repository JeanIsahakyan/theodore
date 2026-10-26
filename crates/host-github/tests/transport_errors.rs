//! Proves the adapter surfaces `host-http`'s error mapping unchanged:
//! rate limit, retry, and auth-vs-rate-limit-403 all flow through.

mod support;

use theodore_domain::{HostKind, PrRef, RepoRef};
use theodore_ports::{HostAdapter, HostError};
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
        host_id: None,
    }
}

#[tokio::test]
async fn rate_limited_rest_call_surfaces_as_host_error() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/repos/acme/widgets/pulls/42"))
        .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "20"))
        .mount(&s.rest)
        .await;

    let err = s.adapter.get_pr(&pr(), None).await.unwrap_err();
    assert!(
        matches!(err, HostError::RateLimited { .. }),
        "expected RateLimited, got {err:?}"
    );
}

#[tokio::test]
async fn retries_a_flaky_graphql_5xx_then_succeeds() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(502))
        .up_to_n_times(1)
        .mount(&s.graphql)
        .await;
    Mock::given(method("POST"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "data": { "viewer": { "repositories": { "pageInfo": { "hasNextPage": false, "endCursor": null }, "nodes": [] } } }
        })))
        .mount(&s.graphql)
        .await;

    let repos = s.adapter.list_repos().await.unwrap();
    assert!(repos.is_empty());
    assert_eq!(s.graphql.received_requests().await.unwrap().len(), 2);
}

#[tokio::test]
async fn graphql_rate_limited_error_gets_a_future_reset_at_not_zero() {
    let s = support::servers().await;

    Mock::given(method("POST"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "errors": [{ "message": "API rate limit exceeded", "type": "RATE_LIMITED" }]
        })))
        .mount(&s.graphql)
        .await;

    let err = s.adapter.list_repos().await.unwrap_err();
    match err {
        HostError::RateLimited { reset_at } => {
            // The fixed clock in `support::servers()` starts at
            // 1_700_000_000_000; a body-level `RATE_LIMITED` carries no
            // reset header, so this must fall back to `now + 60s`, never
            // the epoch (`0`), which would cause a tight retry loop.
            assert_eq!(reset_at, 1_700_000_000_000 + 60_000);
        }
        other => panic!("expected RateLimited, got {other:?}"),
    }
}

#[tokio::test]
async fn a_403_without_rate_limit_headers_is_auth_not_rate_limited() {
    let s = support::servers().await;

    Mock::given(method("PATCH"))
        .and(path("/repos/acme/widgets/pulls/comments/1001"))
        .respond_with(ResponseTemplate::new(403).set_body_string("no scope"))
        .mount(&s.rest)
        .await;

    let err = s
        .adapter
        .edit_comment(&pr(), &theodore_domain::CommentId::new("1001"), "x")
        .await
        .unwrap_err();
    assert!(matches!(err, HostError::Auth), "expected Auth, got {err:?}");
}
