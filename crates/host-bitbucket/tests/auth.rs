//! End-to-end check that the two credential shapes land on the wire the way
//! Bitbucket expects: `username:app_password` as Basic, a bare token as
//! Bearer.

mod support;

use theodore_ports::HostAdapter;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, ResponseTemplate};

#[tokio::test]
async fn username_colon_app_password_sends_basic_auth() {
    let s = support::servers_with_token(Some("jsmith:app-password-1")).await;
    // base64("jsmith:app-password-1")
    Mock::given(method("GET"))
        .and(path("/user"))
        .and(header(
            "authorization",
            "Basic anNtaXRoOmFwcC1wYXNzd29yZC0x",
        ))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("user.json")))
        .mount(&s.api)
        .await;

    s.adapter.viewer().await.unwrap();
}

#[tokio::test]
async fn bare_token_sends_bearer_auth() {
    let s = support::servers_with_token(Some("ATCTxxxaccesstoken")).await;
    Mock::given(method("GET"))
        .and(path("/user"))
        .and(header("authorization", "Bearer ATCTxxxaccesstoken"))
        .respond_with(ResponseTemplate::new(200).set_body_json(support::fixture("user.json")))
        .mount(&s.api)
        .await;

    s.adapter.viewer().await.unwrap();
}
