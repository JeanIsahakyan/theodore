//! The WorkOS client against a wiremock server: token exchange, refresh,
//! device code, logout, JWKS validation and every error path.

use pretty_assertions::assert_eq;
use serde_json::json;
use theodore_ports::{AccountConfig, AccountError, AccountPort, DeviceSignInPoll};
use wiremock::matchers::{body_string_contains, method, path, query_param};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

use super::*;
use crate::jwt::testing;

const CLIENT: &str = "client_01TEST";

fn cfg() -> AccountConfig {
    AccountConfig {
        client_id: CLIENT.into(),
        redirect_uri: "http://127.0.0.1:0/callback".into(),
    }
}

fn account(server: &MockServer) -> WorkosAccount {
    WorkosAccount::with_api_base(Url::parse(&format!("{}/", server.uri())).unwrap())
}

fn access_token(server: &MockServer, sub: &str, exp: i64) -> String {
    testing::token(&json!({
        "iss": server.uri(),
        "sub": sub,
        "sid": "session_01",
        "org_id": "org_01",
        "exp": exp,
        "iat": now_secs(),
    }))
}

fn auth_body(server: &MockServer, refresh: &str) -> serde_json::Value {
    json!({
        "user": {
            "object": "user",
            "id": "user_01",
            "email": "ada@example.com",
            "email_verified": true,
            "first_name": "Ada",
            "last_name": "Lovelace",
            "profile_picture_url": "https://img.example/ada.png",
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z",
        },
        "organization_id": null,
        "access_token": access_token(server, "user_01", now_secs() + 300),
        "refresh_token": refresh,
        "authentication_method": "MagicAuth",
    })
}

async fn mount_jwks(server: &MockServer, times: u64) {
    Mock::given(method("GET"))
        .and(path(format!("/sso/jwks/{CLIENT}")))
        .respond_with(ResponseTemplate::new(200).set_body_string(testing::JWKS))
        .expect(times)
        .mount(server)
        .await;
}

fn no_secret(req: &Request) -> bool {
    let body = String::from_utf8_lossy(&req.body);
    !body.contains("client_secret") && !req.headers.contains_key("authorization")
}

#[test]
fn authorize_url_carries_pkce_state_and_hint() {
    let a = WorkosAccount::new();
    let url = a
        .authorize_url(
            CLIENT,
            "http://127.0.0.1:47823/callback",
            "st",
            "ch",
            Some(" ada@example.com "),
        )
        .unwrap();
    assert_eq!(url.host_str(), Some("api.workos.com"));
    assert_eq!(url.path(), "/user_management/authorize");
    let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
    assert_eq!(q["response_type"], "code");
    assert_eq!(q["client_id"], CLIENT);
    assert_eq!(q["redirect_uri"], "http://127.0.0.1:47823/callback");
    assert_eq!(q["provider"], "authkit");
    assert_eq!(q["state"], "st");
    assert_eq!(q["code_challenge"], "ch");
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(q["login_hint"], "ada@example.com");

    let url = a
        .authorize_url(CLIENT, "http://127.0.0.1:1/cb", "s", "c", Some("  "))
        .unwrap();
    assert!(!url.query().unwrap().contains("login_hint"));
}

#[tokio::test]
async fn start_browser_binds_the_redirect_and_links_challenge_to_verifier() {
    let a = WorkosAccount::new();
    let sign_in = a.start_browser(&cfg(), None).await.unwrap();
    let url = Url::parse(&sign_in.url).unwrap();
    let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
    let redirect = Url::parse(&q["redirect_uri"]).unwrap();
    assert_eq!(redirect.host_str(), Some("127.0.0.1"));
    assert_ne!(
        redirect.port(),
        Some(0),
        "port 0 is replaced by the bound port"
    );
    assert_eq!(q["state"], sign_in.state);
    assert_eq!(
        q["code_challenge"],
        pkce::challenge_for(&sign_in.code_verifier)
    );
    // The port is really held.
    assert!(
        tokio::net::TcpListener::bind(("127.0.0.1", redirect.port().unwrap()))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn start_browser_rejects_a_non_loopback_redirect() {
    let a = WorkosAccount::new();
    let cfg = AccountConfig {
        redirect_uri: "https://theodore.example/callback".into(),
        ..cfg()
    };
    assert!(matches!(
        a.start_browser(&cfg, None).await,
        Err(AccountError::Config(_))
    ));
}

#[tokio::test]
async fn start_browser_with_an_app_scheme_binds_no_listener() {
    let a = WorkosAccount::new();
    let cfg = AccountConfig {
        redirect_uri: "theodore://callback".into(),
        ..cfg()
    };
    let sign_in = a.start_browser(&cfg, None).await.unwrap();
    assert!(
        sign_in.callbacks.is_none(),
        "the OS delivers an app-scheme redirect; no loopback port is bound"
    );
    let url = Url::parse(&sign_in.url).unwrap();
    let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
    assert_eq!(q["redirect_uri"], "theodore://callback");
    assert_eq!(q["state"], sign_in.state);
    assert_eq!(
        q["code_challenge"],
        pkce::challenge_for(&sign_in.code_verifier)
    );
}

#[tokio::test]
async fn exchange_code_uses_the_verifier_and_no_secret() {
    let server = MockServer::start().await;
    mount_jwks(&server, 1).await;
    Mock::given(method("POST"))
        .and(path("/user_management/authenticate"))
        .and(body_string_contains("grant_type=authorization_code"))
        .and(body_string_contains(format!("client_id={CLIENT}")))
        .and(body_string_contains("code=code_1"))
        .and(body_string_contains("code_verifier=verifier_1"))
        .and(no_secret)
        .respond_with(ResponseTemplate::new(200).set_body_json(auth_body(&server, "rt_1")))
        .expect(1)
        .mount(&server)
        .await;

    let s = account(&server)
        .exchange_code(&cfg(), "code_1", "verifier_1")
        .await
        .unwrap();
    assert_eq!(s.user.id, "user_01");
    assert_eq!(s.user.email, "ada@example.com");
    assert_eq!(s.user.first_name.as_deref(), Some("Ada"));
    assert_eq!(
        s.user.avatar_url.as_deref(),
        Some("https://img.example/ada.png")
    );
    assert_eq!(s.refresh_token, "rt_1");
    assert_eq!(s.session_id.as_deref(), Some("session_01"));
    assert_eq!(s.organization_id.as_deref(), Some("org_01"));
    assert!(s.expires_at > now_secs() * 1000);
}

#[tokio::test]
async fn exchange_code_errors() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/user_management/authenticate"))
        .and(body_string_contains("code=used"))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({
            "error": "invalid_grant",
            "error_description": "The code has expired or was already used.",
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/user_management/authenticate"))
        .and(body_string_contains("code=down"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/user_management/authenticate"))
        .and(body_string_contains("code=garbled"))
        .respond_with(ResponseTemplate::new(200).set_body_string("{}"))
        .mount(&server)
        .await;

    let a = account(&server);
    match a.exchange_code(&cfg(), "used", "v").await {
        Err(AccountError::Rejected(m)) => assert!(m.contains("invalid_grant"), "{m}"),
        other => panic!("expected Rejected, got {other:?}"),
    }
    assert!(matches!(
        a.exchange_code(&cfg(), "down", "v").await,
        Err(AccountError::Network(_))
    ));
    assert!(matches!(
        a.exchange_code(&cfg(), "garbled", "v").await,
        Err(AccountError::Protocol(_))
    ));
}

#[tokio::test]
async fn a_token_for_another_user_or_key_is_refused() {
    let server = MockServer::start().await;
    mount_jwks(&server, 2).await;
    let mut body = auth_body(&server, "rt");
    body["access_token"] = json!(access_token(&server, "user_99", now_secs() + 300));
    Mock::given(method("POST"))
        .and(path("/user_management/authenticate"))
        .and(body_string_contains("code=other_user"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(&server)
        .await;
    let mut body = auth_body(&server, "rt");
    body["access_token"] = json!(testing::sign(
        &json!({"alg": "RS256", "kid": "rotated-away"}),
        &json!({"iss": server.uri(), "sub": "user_01", "exp": now_secs() + 300}),
    ));
    Mock::given(method("POST"))
        .and(path("/user_management/authenticate"))
        .and(body_string_contains("code=unknown_kid"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(&server)
        .await;

    let a = account(&server);
    assert!(matches!(
        a.exchange_code(&cfg(), "other_user", "v").await,
        Err(AccountError::InvalidToken(_))
    ));
    // Unknown kid: the cached JWKS misses, it's refetched once, then the
    // token is refused.
    assert!(matches!(
        a.exchange_code(&cfg(), "unknown_kid", "v").await,
        Err(AccountError::InvalidToken(_))
    ));
}

#[tokio::test]
async fn a_wrong_issuer_is_refused() {
    let server = MockServer::start().await;
    // Two clients, two caches.
    mount_jwks(&server, 2).await;
    let mut body = auth_body(&server, "rt");
    body["access_token"] = json!(testing::token(&json!({
        "iss": "https://evil.example",
        "sub": "user_01",
        "exp": now_secs() + 300,
    })));
    Mock::given(method("POST"))
        .and(path("/user_management/authenticate"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(&server)
        .await;
    assert!(matches!(
        account(&server).exchange_code(&cfg(), "c", "v").await,
        Err(AccountError::InvalidToken(_))
    ));
    // A custom authentication domain is accepted once configured.
    let a = account(&server).with_issuer("https://evil.example");
    assert!(a.exchange_code(&cfg(), "c", "v").await.is_ok());
}

#[tokio::test]
async fn the_jwks_is_fetched_once_and_cached() {
    let server = MockServer::start().await;
    mount_jwks(&server, 1).await;
    Mock::given(method("POST"))
        .and(path("/user_management/authenticate"))
        .respond_with(ResponseTemplate::new(200).set_body_json(auth_body(&server, "rt")))
        .mount(&server)
        .await;
    let a = account(&server);
    a.exchange_code(&cfg(), "c1", "v").await.unwrap();
    a.refresh(&cfg(), "rt").await.unwrap();
}

#[tokio::test]
async fn an_unreachable_jwks_still_checks_the_claims() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!("/sso/jwks/{CLIENT}")))
        .respond_with(ResponseTemplate::new(502))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/user_management/authenticate"))
        .respond_with(ResponseTemplate::new(200).set_body_json(auth_body(&server, "rt")))
        .mount(&server)
        .await;
    let s = account(&server)
        .exchange_code(&cfg(), "c", "v")
        .await
        .unwrap();
    assert_eq!(s.user.id, "user_01");
}

#[tokio::test]
async fn refresh_rotates_the_refresh_token_without_a_secret() {
    let server = MockServer::start().await;
    mount_jwks(&server, 1).await;
    Mock::given(method("POST"))
        .and(path("/user_management/authenticate"))
        .and(body_string_contains("grant_type=refresh_token"))
        .and(body_string_contains("refresh_token=rt_old"))
        .and(body_string_contains(format!("client_id={CLIENT}")))
        .and(no_secret)
        .respond_with(ResponseTemplate::new(200).set_body_json(auth_body(&server, "rt_new")))
        .expect(1)
        .mount(&server)
        .await;
    let s = account(&server).refresh(&cfg(), "rt_old").await.unwrap();
    assert_eq!(s.refresh_token, "rt_new");
}

#[tokio::test]
async fn a_revoked_refresh_token_is_rejected() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/user_management/authenticate"))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({
            "code": "invalid_grant",
            "message": "Session has already ended.",
        })))
        .mount(&server)
        .await;
    match account(&server).refresh(&cfg(), "rt").await {
        Err(AccountError::Rejected(m)) => assert!(m.contains("Session has already ended")),
        other => panic!("expected Rejected, got {other:?}"),
    }
}

#[tokio::test]
async fn a_4xx_that_is_not_the_providers_error_is_a_network_failure() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/user_management/authenticate"))
        .and(body_string_contains("refresh_token=portal"))
        .respond_with(
            ResponseTemplate::new(403)
                .set_body_string("<html><body>Sign in to the Wi-Fi</body></html>"),
        )
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/user_management/authenticate"))
        .and(body_string_contains("refresh_token=proxy"))
        .respond_with(ResponseTemplate::new(407).set_body_json(json!({ "detail": "auth" })))
        .mount(&server)
        .await;
    let a = account(&server);
    for rt in ["portal", "proxy"] {
        match a.refresh(&cfg(), rt).await {
            Err(AccountError::Network(m)) => assert!(m.contains("without a provider error"), "{m}"),
            other => panic!("{rt}: expected Network, got {other:?}"),
        }
    }
}

#[tokio::test]
async fn device_start_returns_the_code_to_show() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/user_management/authorize/device"))
        .and(body_string_contains(format!("client_id={CLIENT}")))
        .and(no_secret)
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "device_code": "dc_1",
            "user_code": "BCDF-GHJK",
            "verification_uri": "https://acme.authkit.app/device",
            "verification_uri_complete": "https://acme.authkit.app/device?user_code=BCDF-GHJK",
            "expires_in": 300,
            "interval": 5,
        })))
        .mount(&server)
        .await;
    let d = account(&server).start_device(&cfg()).await.unwrap();
    assert_eq!(d.device_code, "dc_1");
    assert_eq!(d.user_code, "BCDF-GHJK");
    assert_eq!(d.verification_uri, "https://acme.authkit.app/device");
    assert_eq!(
        d.verification_uri_complete.as_deref(),
        Some("https://acme.authkit.app/device?user_code=BCDF-GHJK")
    );
    assert_eq!((d.expires_in, d.interval), (300, 5));
}

#[tokio::test]
async fn device_poll_maps_every_rfc_8628_outcome() {
    let server = MockServer::start().await;
    mount_jwks(&server, 1).await;
    for (code, error) in [
        ("dc_pending", "authorization_pending"),
        ("dc_slow", "slow_down"),
        ("dc_denied", "access_denied"),
        ("dc_expired", "expired_token"),
        ("dc_weird", "invalid_client"),
    ] {
        Mock::given(method("POST"))
            .and(path("/user_management/authenticate"))
            .and(body_string_contains(format!("device_code={code}")))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({
                "error": error,
                "error_description": "…",
            })))
            .mount(&server)
            .await;
    }
    Mock::given(method("POST"))
        .and(path("/user_management/authenticate"))
        .and(body_string_contains("device_code=dc_ok"))
        .and(body_string_contains(
            "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code",
        ))
        .and(no_secret)
        .respond_with(ResponseTemplate::new(200).set_body_json(auth_body(&server, "rt")))
        .mount(&server)
        .await;

    let a = account(&server);
    let c = cfg();
    assert_eq!(
        a.poll_device(&c, "dc_pending", 5).await.unwrap(),
        DeviceSignInPoll::Pending
    );
    assert_eq!(
        a.poll_device(&c, "dc_slow", 5).await.unwrap(),
        DeviceSignInPoll::SlowDown { interval: 10 }
    );
    assert_eq!(
        a.poll_device(&c, "dc_denied", 5).await.unwrap(),
        DeviceSignInPoll::Denied
    );
    assert_eq!(
        a.poll_device(&c, "dc_expired", 5).await.unwrap(),
        DeviceSignInPoll::Expired
    );
    assert!(matches!(
        a.poll_device(&c, "dc_weird", 5).await,
        Err(AccountError::Rejected(_))
    ));
    match a.poll_device(&c, "dc_ok", 5).await.unwrap() {
        DeviceSignInPoll::Done(s) => assert_eq!(s.user.email, "ada@example.com"),
        other => panic!("expected Done, got {other:?}"),
    }
}

#[tokio::test]
async fn sign_out_ends_the_session_by_id() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/user_management/sessions/logout"))
        .and(query_param("session_id", "session_01"))
        .respond_with(
            ResponseTemplate::new(302).insert_header("location", "https://acme.authkit.app/x"),
        )
        .expect(1)
        .mount(&server)
        .await;
    let a = account(&server);
    let mut session = AccountSession {
        user: AccountProfile {
            id: "user_01".into(),
            email: "ada@example.com".into(),
            first_name: None,
            last_name: None,
            avatar_url: None,
        },
        access_token: "at".into(),
        refresh_token: "rt".into(),
        expires_at: 0,
        session_id: Some("session_01".into()),
        organization_id: None,
    };
    a.sign_out(&cfg(), &session).await.unwrap();
    // No session id: nothing to end remotely.
    session.session_id = None;
    a.sign_out(&cfg(), &session).await.unwrap();
}
