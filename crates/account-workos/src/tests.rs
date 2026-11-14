//! The WorkOS client against a wiremock server: token exchange, refresh,
//! device code, logout, JWKS validation and every error path.

use pretty_assertions::assert_eq;
use serde_json::json;
use theodore_ports::{
    AccountConfig, AccountError, AccountOrganization, AccountPort, DeviceSignInPoll,
    OrganizationChoice,
};
use wiremock::matchers::{body_json, body_string_contains, header, method, path, query_param};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

use super::*;
use crate::jwt::testing;

const CLIENT: &str = "client_01TEST";

fn cfg() -> AccountConfig {
    AccountConfig {
        client_id: CLIENT.into(),
        redirect_uri: "http://127.0.0.1:0/callback".into(),
        cloud_url: None,
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
    a.refresh(&cfg(), "rt", None).await.unwrap();
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
    let s = account(&server)
        .refresh(&cfg(), "rt_old", None)
        .await
        .unwrap();
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
    match account(&server).refresh(&cfg(), "rt", None).await {
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
        match a.refresh(&cfg(), rt, None).await {
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
        role: None,
        permissions: Vec::new(),
    };
    a.sign_out(&cfg(), &session).await.unwrap();
    // No session id: nothing to end remotely.
    session.session_id = None;
    a.sign_out(&cfg(), &session).await.unwrap();
}

fn org_token(server: &MockServer, org: &str) -> String {
    testing::token(&json!({
        "iss": server.uri(),
        "sub": "user_01",
        "sid": "session_01",
        "org_id": org,
        "role": "admin",
        "permissions": ["widgets:create", "widgets:read"],
        "exp": now_secs() + 300,
        "iat": now_secs(),
    }))
}

fn auth_body_in_org(server: &MockServer, refresh: &str, org: &str) -> serde_json::Value {
    let mut body = auth_body(server, refresh);
    body["organization_id"] = json!(org);
    body["access_token"] = json!(org_token(server, org));
    body
}

#[tokio::test]
async fn refresh_with_an_organization_sends_it() {
    let server = MockServer::start().await;
    mount_jwks(&server, 1).await;
    Mock::given(method("POST"))
        .and(path("/user_management/authenticate"))
        .and(body_string_contains("grant_type=refresh_token"))
        .and(body_string_contains("refresh_token=rt_old"))
        .and(body_string_contains("organization_id=org_02"))
        .and(no_secret)
        .respond_with(
            ResponseTemplate::new(200).set_body_json(auth_body_in_org(&server, "rt_new", "org_02")),
        )
        .expect(1)
        .mount(&server)
        .await;
    let s = account(&server)
        .refresh(&cfg(), "rt_old", Some("org_02"))
        .await
        .unwrap();
    assert_eq!(s.organization_id.as_deref(), Some("org_02"));
}

#[tokio::test]
async fn refresh_without_an_organization_does_not_send_the_field() {
    let server = MockServer::start().await;
    mount_jwks(&server, 1).await;
    Mock::given(method("POST"))
        .and(path("/user_management/authenticate"))
        .and(|req: &Request| !String::from_utf8_lossy(&req.body).contains("organization_id"))
        .respond_with(ResponseTemplate::new(200).set_body_json(auth_body(&server, "rt_new")))
        .expect(1)
        .mount(&server)
        .await;
    account(&server)
        .refresh(&cfg(), "rt_old", None)
        .await
        .unwrap();
}

fn selection_required(token: &str) -> ResponseTemplate {
    ResponseTemplate::new(400).set_body_json(json!({
        "code": "organization_selection_required",
        "message": "The user must choose an organization to continue signing in.",
        "pending_authentication_token": token,
        "organizations": [
            {"id": "org_01", "name": "Acme"},
            {"id": "org_02", "name": "Globex"},
        ],
        "user": {"id": "user_01", "email": "ada@example.com"},
    }))
}

#[tokio::test]
async fn organization_selection_required_carries_the_choices() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/user_management/authenticate"))
        .respond_with(selection_required("pending_secret_1"))
        .mount(&server)
        .await;
    let err = account(&server)
        .exchange_code(&cfg(), "code_1", "verifier_1")
        .await
        .unwrap_err();
    assert_eq!(err.code(), "account.org_selection_required");
    assert!(!err.to_string().contains("pending_secret_1"));
    assert!(!format!("{err:?}").contains("pending_secret_1"));
    let AccountError::OrganizationSelectionRequired(sel) = err else {
        panic!("expected OrganizationSelectionRequired, got {err:?}");
    };
    assert_eq!(sel.pending_authentication_token, "pending_secret_1");
    assert_eq!(
        sel.organizations,
        vec![
            OrganizationChoice {
                id: "org_01".into(),
                name: "Acme".into()
            },
            OrganizationChoice {
                id: "org_02".into(),
                name: "Globex".into()
            },
        ]
    );
}

#[tokio::test]
async fn organization_selection_without_a_pending_token_is_a_protocol_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/user_management/authenticate"))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({
            "code": "organization_selection_required",
            "message": "pick one",
        })))
        .mount(&server)
        .await;
    assert!(matches!(
        account(&server).exchange_code(&cfg(), "c", "v").await,
        Err(AccountError::Protocol(_))
    ));
}

// ── the Theodore cloud ───────────────────────────────────────────────────

/// The cloud on the same mock server, under a path prefix (a trailing `/`
/// in the configured URL doesn't matter).
fn cloud_cfg(server: &MockServer) -> AccountConfig {
    AccountConfig {
        cloud_url: Some(format!("{}/cloud/", server.uri())),
        ..cfg()
    }
}

fn cloud_error(status: u16, code: &str, message: &str) -> ResponseTemplate {
    ResponseTemplate::new(status).set_body_json(json!({
        "error": {"code": code, "message": message},
    }))
}

#[tokio::test]
async fn select_organization_goes_through_the_cloud_and_validates_the_session() {
    let server = MockServer::start().await;
    mount_jwks(&server, 1).await;
    Mock::given(method("POST"))
        .and(path("/cloud/v1/auth/select-organization"))
        .and(header("content-type", "application/json"))
        .and(body_json(json!({
            "pending_authentication_token": "pending_1",
            "organization_id": "org_02",
        })))
        .and(no_secret)
        .respond_with(
            ResponseTemplate::new(200).set_body_json(auth_body_in_org(&server, "rt_1", "org_02")),
        )
        .expect(1)
        .mount(&server)
        .await;
    // Never the provider's grant itself: it needs the secret.
    Mock::given(method("POST"))
        .and(path("/user_management/authenticate"))
        .respond_with(ResponseTemplate::new(500))
        .expect(0)
        .mount(&server)
        .await;
    let s = account(&server)
        .select_organization(&cloud_cfg(&server), "pending_1", "org_02")
        .await
        .unwrap();
    assert_eq!(s.organization_id.as_deref(), Some("org_02"));
    assert_eq!(s.role.as_deref(), Some("admin"));
    assert_eq!(s.refresh_token, "rt_1");
}

#[tokio::test]
async fn a_selected_session_for_another_user_is_refused() {
    let server = MockServer::start().await;
    mount_jwks(&server, 1).await;
    let mut body = auth_body_in_org(&server, "rt_1", "org_02");
    body["access_token"] = json!(access_token(&server, "user_other", now_secs() + 300));
    Mock::given(method("POST"))
        .and(path("/cloud/v1/auth/select-organization"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(&server)
        .await;
    assert!(matches!(
        account(&server)
            .select_organization(&cloud_cfg(&server), "pending_1", "org_02")
            .await,
        Err(AccountError::InvalidToken(_))
    ));
}

#[tokio::test]
async fn a_selected_session_in_another_organization_is_refused() {
    // The body says org_02 but the token is for org_01, then both say org_01.
    let server = MockServer::start().await;
    mount_jwks(&server, 1).await;
    let mut mixed = auth_body_in_org(&server, "rt_1", "org_02");
    mixed["access_token"] = json!(org_token(&server, "org_01"));
    Mock::given(method("POST"))
        .and(path("/cloud/v1/auth/select-organization"))
        .respond_with(ResponseTemplate::new(200).set_body_json(mixed))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/cloud/v1/auth/select-organization"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(auth_body_in_org(&server, "rt_2", "org_01")),
        )
        .mount(&server)
        .await;
    let a = account(&server);
    for _ in 0..2 {
        let e = a
            .select_organization(&cloud_cfg(&server), "pending_1", "org_02")
            .await
            .unwrap_err();
        assert!(matches!(e, AccountError::InvalidToken(_)), "{e:?}");
    }
}

#[tokio::test]
async fn a_selected_session_without_an_org_claim_is_refused() {
    let server = MockServer::start().await;
    mount_jwks(&server, 1).await;
    // The body names the org; the token (no org_id) doesn't.
    let mut body = testing_no_org_body(&server);
    body["organization_id"] = json!("org_02");
    Mock::given(method("POST"))
        .and(path("/cloud/v1/auth/select-organization"))
        .respond_with(ResponseTemplate::new(200).set_body_json(body))
        .mount(&server)
        .await;
    let e = account(&server)
        .select_organization(&cloud_cfg(&server), "pending_1", "org_02")
        .await
        .unwrap_err();
    assert!(matches!(e, AccountError::InvalidToken(_)), "{e:?}");
}

/// A token the cloud handed over is never taken unsigned: no JWKS, no
/// session (a network error, so the sign-in can be tried again).
#[tokio::test]
async fn a_selected_session_is_refused_when_the_jwks_is_unreachable() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path(format!("/sso/jwks/{CLIENT}")))
        .respond_with(ResponseTemplate::new(502))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/cloud/v1/auth/select-organization"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(auth_body_in_org(&server, "rt_1", "org_02")),
        )
        .mount(&server)
        .await;
    let e = account(&server)
        .select_organization(&cloud_cfg(&server), "pending_1", "org_02")
        .await
        .unwrap_err();
    assert!(matches!(e, AccountError::Network(_)), "{e:?}");
}

#[tokio::test]
async fn a_used_pending_token_is_rejected_and_never_echoed() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/cloud/v1/auth/select-organization"))
        .respond_with(cloud_error(
            400,
            "cloud.rejected",
            "invalid_grant: the pending authentication token was already used",
        ))
        .mount(&server)
        .await;
    let err = account(&server)
        .select_organization(&cloud_cfg(&server), "pending_secret_9", "org_02")
        .await
        .unwrap_err();
    assert!(matches!(err, AccountError::Rejected(_)), "{err:?}");
    assert!(err.to_string().contains("cloud.rejected"));
    assert!(!err.to_string().contains("pending_secret_9"));
    assert!(!format!("{err:?}").contains("pending_secret_9"));
}

#[tokio::test]
async fn ensure_personal_organization_sends_the_bearer_and_returns_the_id() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/cloud/v1/orgs/personal"))
        .and(header("authorization", "Bearer at_secret_1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "organization_id": "org_personal",
            "created": true,
        })))
        .expect(1)
        .mount(&server)
        .await;
    let id = account(&server)
        .ensure_personal_organization(&cloud_cfg(&server), "at_secret_1")
        .await
        .unwrap();
    assert_eq!(id, "org_personal");
}

#[tokio::test]
async fn organizations_are_listed_with_role_and_personal() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/cloud/v1/orgs"))
        .and(header("authorization", "Bearer at_1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "organizations": [
                {"id": "org_p", "name": "Personal (ada@example.com)", "role": "admin", "personal": true},
                {"id": "org_a", "name": "Acme", "role": null, "personal": false},
            ],
        })))
        .expect(1)
        .mount(&server)
        .await;
    let orgs = account(&server)
        .organizations(&cloud_cfg(&server), "at_1")
        .await
        .unwrap();
    assert_eq!(
        orgs,
        vec![
            AccountOrganization {
                id: "org_p".into(),
                name: "Personal (ada@example.com)".into(),
                role: Some("admin".into()),
                personal: true,
            },
            AccountOrganization {
                id: "org_a".into(),
                name: "Acme".into(),
                role: None,
                personal: false,
            },
        ]
    );
}

#[tokio::test]
async fn cloud_errors_map_to_network_rejected_or_protocol() {
    let server = MockServer::start().await;
    let cases: [(&str, ResponseTemplate); 6] = [
        (
            "t_unauthorized",
            cloud_error(401, "cloud.unauthorized", "bad token"),
        ),
        (
            "t_inactive",
            cloud_error(409, "cloud.membership_inactive", "inactive"),
        ),
        ("t_rejected", cloud_error(400, "cloud.rejected", "no")),
        (
            "t_down",
            cloud_error(503, "cloud.jwks_unavailable", "later"),
        ),
        ("t_busy", ResponseTemplate::new(429)),
        (
            "t_portal",
            ResponseTemplate::new(403).set_body_string("<html>"),
        ),
    ];
    for (token, reply) in cases {
        Mock::given(method("POST"))
            .and(path("/cloud/v1/orgs/personal"))
            .and(header("authorization", format!("Bearer {token}")))
            .respond_with(reply)
            .mount(&server)
            .await;
    }
    let a = account(&server);
    let c = cloud_cfg(&server);
    let err = |t: &'static str| {
        let (a, c) = (&a, &c);
        async move { a.ensure_personal_organization(c, t).await.unwrap_err() }
    };
    let e = err("t_unauthorized").await;
    assert_eq!(
        e,
        AccountError::Protocol("cloud.unauthorized: bad token".into())
    );
    assert!(matches!(err("t_inactive").await, AccountError::Protocol(_)));
    assert!(matches!(err("t_rejected").await, AccountError::Rejected(_)));
    for t in ["t_down", "t_busy", "t_portal"] {
        let e = err(t).await;
        assert!(matches!(e, AccountError::Network(_)), "{t}: {e:?}");
        assert!(!e.to_string().contains(t), "the token stays out: {e}");
    }
}

#[tokio::test]
async fn an_unreachable_cloud_is_a_network_failure() {
    let c = AccountConfig {
        // Nothing listens on port 9 (discard) on loopback.
        cloud_url: Some("http://127.0.0.1:9".into()),
        ..cfg()
    };
    let e = WorkosAccount::new()
        .ensure_personal_organization(&c, "at_secret")
        .await
        .unwrap_err();
    assert!(matches!(e, AccountError::Network(_)), "{e:?}");
    assert!(!e.to_string().contains("at_secret"));
}

#[tokio::test]
async fn no_cloud_is_a_config_error_and_calls_nothing() {
    let server = MockServer::start().await;
    Mock::given(wiremock::matchers::any())
        .respond_with(ResponseTemplate::new(500))
        .expect(0)
        .mount(&server)
        .await;
    let a = account(&server);
    let no_cloud = AccountError::Config("no Theodore cloud configured".into());
    assert_eq!(
        a.ensure_personal_organization(&cfg(), "at").await,
        Err(no_cloud.clone())
    );
    assert_eq!(a.organizations(&cfg(), "at").await, Err(no_cloud.clone()));
    assert_eq!(
        a.select_organization(&cfg(), "p", "org").await,
        Err(no_cloud)
    );
}

#[tokio::test]
async fn a_device_poll_needing_an_organization_carries_the_choices() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/user_management/authenticate"))
        .and(body_string_contains("device_code=dc_orgs"))
        .respond_with(selection_required("pending_dev"))
        .mount(&server)
        .await;
    match account(&server).poll_device(&cfg(), "dc_orgs", 5).await {
        Err(AccountError::OrganizationSelectionRequired(sel)) => {
            assert_eq!(sel.pending_authentication_token, "pending_dev");
            assert_eq!(sel.organizations.len(), 2);
        }
        other => panic!("expected OrganizationSelectionRequired, got {other:?}"),
    }
}

#[tokio::test]
async fn role_and_permissions_land_in_the_session() {
    let server = MockServer::start().await;
    mount_jwks(&server, 1).await;
    Mock::given(method("POST"))
        .and(path("/user_management/authenticate"))
        .and(body_string_contains("code=in_org"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(auth_body_in_org(&server, "rt_1", "org_01")),
        )
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/user_management/authenticate"))
        .and(body_string_contains("code=no_org"))
        .respond_with(ResponseTemplate::new(200).set_body_json(testing_no_org_body(&server)))
        .mount(&server)
        .await;
    let a = account(&server);
    let s = a.exchange_code(&cfg(), "in_org", "v").await.unwrap();
    assert_eq!(s.role.as_deref(), Some("admin"));
    assert_eq!(s.permissions, vec!["widgets:create", "widgets:read"]);

    // A token without those claims (no organization selected) leaves them empty.
    let s = a.exchange_code(&cfg(), "no_org", "v").await.unwrap();
    assert_eq!(s.role, None);
    assert!(s.permissions.is_empty());
}

fn testing_no_org_body(server: &MockServer) -> serde_json::Value {
    let mut body = auth_body(server, "rt_2");
    body["access_token"] = json!(testing::token(&json!({
        "iss": server.uri(),
        "sub": "user_01",
        "sid": "session_01",
        "exp": now_secs() + 300,
        "iat": now_secs(),
    })));
    body
}
