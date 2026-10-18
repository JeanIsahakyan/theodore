mod support;

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use theodore_host_http::{HttpClient, StaticToken};
use theodore_ports::{Clock, Fetched, HostError};
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

use support::FakeClock;

#[derive(Debug, Deserialize, Serialize, PartialEq)]
struct Pr {
    number: u64,
    title: String,
}

fn client(server: &MockServer, token: Option<&str>, clock: Arc<FakeClock>) -> HttpClient {
    let base = url::Url::parse(&format!("{}/", server.uri())).unwrap();
    let token: Arc<dyn theodore_host_http::TokenSource> =
        Arc::new(StaticToken(token.map(str::to_string)));
    HttpClient::new(base, token, clock)
}

#[tokio::test]
async fn etag_cache_turns_second_get_into_not_modified() {
    let server = MockServer::start().await;
    let clock = FakeClock::new(0);

    Mock::given(method("GET"))
        .and(path("/repos/o/r/pulls/1"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("etag", "\"abc\"")
                .set_body_json(Pr {
                    number: 1,
                    title: "first".into(),
                }),
        )
        .up_to_n_times(1)
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/repos/o/r/pulls/1"))
        .and(header("if-none-match", "\"abc\""))
        .respond_with(ResponseTemplate::new(304))
        .mount(&server)
        .await;

    let http = client(&server, Some("secret-token"), clock);

    let first = http
        .get_conditional::<Pr>("repos/o/r/pulls/1", None)
        .await
        .unwrap();
    match first {
        Fetched::Modified { etag, value } => {
            assert_eq!(etag, Some("\"abc\"".to_string()));
            assert_eq!(
                value.value,
                Pr {
                    number: 1,
                    title: "first".into()
                }
            );
        }
        Fetched::NotModified => panic!("expected Modified on first fetch"),
    }

    // No explicit etag passed: the client must have cached it per-URL.
    let second = http
        .get_conditional::<Pr>("repos/o/r/pulls/1", None)
        .await
        .unwrap();
    assert!(matches!(second, Fetched::NotModified));
}

#[tokio::test]
async fn explicit_etag_overrides_cache() {
    let server = MockServer::start().await;
    let clock = FakeClock::new(0);

    Mock::given(method("GET"))
        .and(path("/repos/o/r/pulls/1"))
        .and(header("if-none-match", "\"caller\""))
        .respond_with(ResponseTemplate::new(304))
        .mount(&server)
        .await;

    let http = client(&server, None, clock);
    let res = http
        .get_conditional::<Pr>("repos/o/r/pulls/1", Some("\"caller\""))
        .await
        .unwrap();
    assert!(matches!(res, Fetched::NotModified));
}

#[tokio::test]
async fn rate_limited_429_maps_to_host_error_with_reset_at() {
    let server = MockServer::start().await;
    let clock = FakeClock::new(1_000);

    Mock::given(method("GET"))
        .and(path("/notifications"))
        .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "30"))
        .mount(&server)
        .await;

    let http = client(&server, None, clock);
    let err = http
        .get::<serde_json::Value>("notifications")
        .await
        .unwrap_err();
    match err {
        HostError::RateLimited { reset_at } => assert_eq!(reset_at, 1_000 + 30_000),
        other => panic!("expected RateLimited, got {other:?}"),
    }
}

#[tokio::test]
async fn preemptive_rate_limit_skips_the_network_call() {
    let server = MockServer::start().await;
    let clock = FakeClock::new(1_000);

    Mock::given(method("GET"))
        .and(path("/x"))
        .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "30"))
        .up_to_n_times(1)
        .mount(&server)
        .await;

    let http = client(&server, None, clock);
    let _ = http.get::<serde_json::Value>("x").await.unwrap_err();

    // Second call must fail fast (no second request hits the mock, which
    // would panic since it's limited to one match).
    let err = http.get::<serde_json::Value>("x").await.unwrap_err();
    assert!(matches!(err, HostError::RateLimited { .. }));
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
}

#[tokio::test]
async fn preemptive_block_clears_once_the_clock_passes_reset_at() {
    let server = MockServer::start().await;
    let clock = FakeClock::new(1_000);

    Mock::given(method("GET"))
        .and(path("/x"))
        .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "1"))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/x"))
        .respond_with(ResponseTemplate::new(200).set_body_json(Pr {
            number: 1,
            title: "ok".into(),
        }))
        .mount(&server)
        .await;

    let http = client(&server, None, clock.clone());
    let _ = http.get::<serde_json::Value>("x").await.unwrap_err();

    clock.set(1_000 + 1_000);
    let got = http.get::<Pr>("x").await.unwrap();
    assert_eq!(
        got.value,
        Pr {
            number: 1,
            title: "ok".into()
        }
    );
}

#[tokio::test]
async fn forbidden_without_rate_limit_headers_is_auth_not_rate_limited() {
    let server = MockServer::start().await;
    let clock = FakeClock::new(0);

    Mock::given(method("GET"))
        .and(path("/notifications"))
        .respond_with(ResponseTemplate::new(403).set_body_string("Resource not accessible"))
        .mount(&server)
        .await;

    let http = client(&server, None, clock);
    let err = http
        .get::<serde_json::Value>("notifications")
        .await
        .unwrap_err();
    assert!(matches!(err, HostError::Auth), "expected Auth, got {err:?}");
}

#[tokio::test]
async fn retries_5xx_then_succeeds() {
    let server = MockServer::start().await;
    let clock = FakeClock::new(0);

    Mock::given(method("GET"))
        .and(path("/flaky"))
        .respond_with(ResponseTemplate::new(503))
        .up_to_n_times(2)
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/flaky"))
        .respond_with(ResponseTemplate::new(200).set_body_json(Pr {
            number: 9,
            title: "ok".into(),
        }))
        .mount(&server)
        .await;

    let http = client(&server, None, clock.clone());
    let got = http.get::<Pr>("flaky").await.unwrap();
    assert_eq!(
        got.value,
        Pr {
            number: 9,
            title: "ok".into()
        }
    );
    assert_eq!(server.received_requests().await.unwrap().len(), 3);
    // Backoff slept (on the fake clock) between attempts.
    assert!(clock.now() > 0);
}

#[tokio::test]
async fn does_not_retry_4xx() {
    let server = MockServer::start().await;
    let clock = FakeClock::new(0);

    Mock::given(method("GET"))
        .and(path("/missing"))
        .respond_with(ResponseTemplate::new(404).set_body_string("not here"))
        .up_to_n_times(1)
        .mount(&server)
        .await;

    let http = client(&server, None, clock);
    let err = http.get::<serde_json::Value>("missing").await.unwrap_err();
    assert!(matches!(err, HostError::NotFound(_)));
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
}

#[tokio::test]
async fn gives_up_after_max_retries_on_persistent_5xx() {
    let server = MockServer::start().await;
    let clock = FakeClock::new(0);

    Mock::given(method("GET"))
        .and(path("/down"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;

    let http = client(&server, None, clock);
    let err = http.get::<serde_json::Value>("down").await.unwrap_err();
    assert!(matches!(err, HostError::Network(_)));
    // Default retry config: 1 initial try + 3 retries.
    assert_eq!(server.received_requests().await.unwrap().len(), 4);
}

#[tokio::test]
async fn token_is_redacted_from_error_bodies() {
    let server = MockServer::start().await;
    let clock = FakeClock::new(0);
    let secret = "ghp_super_secret_value";

    // A server that (mis-)echoes the bearer token into an error body. Real
    // GitHub never does this; the test proves host-http scrubs it anyway.
    Mock::given(method("GET"))
        .and(path("/echo"))
        .respond_with(
            ResponseTemplate::new(404).set_body_string(format!("not found, saw token {secret}")),
        )
        .mount(&server)
        .await;

    let http = client(&server, Some(secret), clock);
    let err = http.get::<serde_json::Value>("echo").await.unwrap_err();
    let msg = err.to_string();
    assert!(!msg.contains(secret), "error leaked the token: {msg}");

    let HostError::NotFound(body) = &err else {
        panic!("expected NotFound, got {err:?}")
    };
    assert!(!body.contains(secret));
    assert!(body.contains("<redacted>"));
}

#[tokio::test]
async fn get_raw_exposes_headers_on_not_modified_for_if_modified_since() {
    let server = MockServer::start().await;
    let clock = FakeClock::new(0);

    // wiremock's header matcher treats a comma-bearing value (an HTTP-date,
    // e.g.) as multiple header values and won't match it as one string, so
    // the test uses a comma-free stand-in; get_raw itself is header-agnostic.
    Mock::given(method("GET"))
        .and(path("/notifications"))
        .and(header("if-modified-since", "last-poll-cursor"))
        .respond_with(ResponseTemplate::new(304).insert_header("x-poll-interval", "60"))
        .mount(&server)
        .await;

    let http = client(&server, None, clock);
    let raw = http
        .get_raw(
            "notifications",
            &[("if-modified-since", "last-poll-cursor".to_string())],
        )
        .await
        .unwrap();

    assert!(raw.not_modified);
    assert_eq!(
        raw.headers
            .get("x-poll-interval")
            .and_then(|v| v.to_str().ok()),
        Some("60")
    );
}
