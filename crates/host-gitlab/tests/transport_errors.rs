//! Proves the adapter surfaces `host-http`'s error mapping unchanged, using
//! GitLab's own header names (`Retry-After`, `RateLimit-*`) rather than
//! GitHub's `x-ratelimit-*` (plan §6.9).

mod support;

use theodore_domain::{CommentId, HostKind, PrRef, RepoRef};
use theodore_ports::{HostAdapter, HostError};
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
async fn rate_limited_response_carries_gitlabs_own_headers() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42"))
        .respond_with(
            ResponseTemplate::new(429)
                .insert_header("retry-after", "30")
                .insert_header("ratelimit-remaining", "0")
                .insert_header("ratelimit-reset", "1700000100"),
        )
        .mount(&s.api)
        .await;

    let err = s.adapter.get_pr(&pr(), None).await.unwrap_err();
    assert!(
        matches!(err, HostError::RateLimited { .. }),
        "expected RateLimited, got {err:?}"
    );
    if let HostError::RateLimited { reset_at } = err {
        // retry-after (30s) wins over the fake clock's start (1_700_000_000_000 ms).
        assert_eq!(reset_at, 1_700_000_030_000);
    }
}

#[tokio::test]
async fn retries_a_flaky_5xx_then_succeeds() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/user"))
        .respond_with(ResponseTemplate::new(502))
        .up_to_n_times(1)
        .mount(&s.api)
        .await;
    Mock::given(method("GET"))
        .and(path("/user"))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("user.json")))
        .mount(&s.api)
        .await;

    let person = s.adapter.viewer().await.unwrap();
    assert_eq!(person.login, "alice");
}

#[tokio::test]
async fn unauthorized_is_auth_not_rate_limited() {
    let s = support::servers().await;

    Mock::given(method("DELETE"))
        .and(path("/projects/7/merge_requests/42/notes/1001"))
        .respond_with(ResponseTemplate::new(401).set_body_string("Unauthorized"))
        .mount(&s.api)
        .await;

    let err = s
        .adapter
        .delete_comment(&pr(), &CommentId::new("1001"))
        .await
        .unwrap_err();
    assert!(matches!(err, HostError::Auth), "expected Auth, got {err:?}");
}

#[tokio::test]
async fn not_found_maps_through() {
    let s = support::servers().await;

    Mock::given(method("GET"))
        .and(path("/projects/7/merge_requests/42"))
        .respond_with(ResponseTemplate::new(404).set_body_string("404 Not found"))
        .mount(&s.api)
        .await;

    let err = s.adapter.get_pr(&pr(), None).await.unwrap_err();
    assert!(
        matches!(err, HostError::NotFound(_)),
        "expected NotFound, got {err:?}"
    );
}
