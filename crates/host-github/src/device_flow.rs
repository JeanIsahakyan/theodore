//! GitHub's OAuth device flow (plan §6.8 "Auth", "login"): `POST
//! /login/device/code` then polling `POST /login/oauth/access_token`.
//! Neither endpoint takes a bearer token — this is how one is obtained in
//! the first place — so this client is deliberately separate from the
//! authenticated [`crate::adapter::GithubAdapter`] and its `HttpClient`s.

use serde::Deserialize;
use theodore_ports::{DeviceCodeStart, DeviceLoginPort, DevicePoll, HostError, HostResult};

/// `github.com`, not `api.github.com` — these two endpoints live on the
/// main site.
const DEFAULT_BASE: &str = "https://github.com/";

pub struct GithubDeviceLogin {
    client: reqwest::Client,
    base_url: url::Url,
}

impl GithubDeviceLogin {
    pub fn new() -> Self {
        Self::with_base_url(url::Url::parse(DEFAULT_BASE).expect("valid url"))
    }

    /// `base_url` must end with `/` (a wiremock server's `uri() + "/"` in tests).
    pub fn with_base_url(base_url: url::Url) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url,
        }
    }

    fn url(&self, path: &str) -> HostResult<url::Url> {
        self.base_url
            .join(path)
            .map_err(|e| HostError::Protocol(format!("bad path {path:?}: {e}")))
    }
}

impl Default for GithubDeviceLogin {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Deserialize)]
struct StartResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u32,
    interval: u32,
}

#[derive(Debug, Deserialize)]
struct PollResponse {
    access_token: Option<String>,
    error: Option<String>,
    /// Present on some `slow_down` responses; absent ones mean "+5s from
    /// whatever interval the caller was already using".
    interval: Option<u32>,
}

async fn post_form(
    client: &reqwest::Client,
    url: url::Url,
    form: &[(&str, &str)],
) -> HostResult<String> {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(form)
        .finish();
    let resp = client
        .post(url)
        .header("accept", "application/json")
        .header("user-agent", "theodore")
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| HostError::Network(e.to_string()))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| HostError::Network(e.to_string()))?;
    if status.is_server_error() {
        return Err(HostError::Network(format!(
            "device flow request failed ({status})"
        )));
    }
    if !status.is_success() {
        return Err(HostError::Protocol(format!(
            "device flow request failed ({status}): {body}"
        )));
    }
    Ok(body)
}

#[async_trait::async_trait]
impl DeviceLoginPort for GithubDeviceLogin {
    async fn start(&self, client_id: &str, scope: &str) -> HostResult<DeviceCodeStart> {
        let url = self.url("login/device/code")?;
        let body = post_form(
            &self.client,
            url,
            &[("client_id", client_id), ("scope", scope)],
        )
        .await?;
        let parsed: StartResponse = serde_json::from_str(&body).map_err(|e| {
            HostError::Protocol(format!("decode device code response: {e}: {body}"))
        })?;
        Ok(DeviceCodeStart {
            device_code: parsed.device_code,
            user_code: parsed.user_code,
            verification_uri: parsed.verification_uri,
            expires_in: parsed.expires_in,
            interval: parsed.interval,
        })
    }

    async fn poll(
        &self,
        client_id: &str,
        device_code: &str,
        current_interval: u32,
    ) -> HostResult<DevicePoll> {
        let url = self.url("login/oauth/access_token")?;
        let body = post_form(
            &self.client,
            url,
            &[
                ("client_id", client_id),
                ("device_code", device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ],
        )
        .await?;
        let parsed: PollResponse = serde_json::from_str(&body)
            .map_err(|e| HostError::Protocol(format!("decode token poll response: {e}: {body}")))?;

        if let Some(access_token) = parsed.access_token {
            return Ok(DevicePoll::Success { access_token });
        }
        match parsed.error.as_deref() {
            Some("authorization_pending") => Ok(DevicePoll::Pending),
            Some("slow_down") => Ok(DevicePoll::SlowDown {
                interval: parsed.interval.unwrap_or(current_interval + 5),
            }),
            Some("access_denied") => Ok(DevicePoll::AccessDenied),
            Some("expired_token") => Ok(DevicePoll::ExpiredToken),
            Some(other) => Err(HostError::Protocol(format!("device flow error: {other}"))),
            None => Err(HostError::Protocol(format!(
                "unexpected token poll response: {body}"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn client(server: &MockServer) -> GithubDeviceLogin {
        let base = url::Url::parse(&format!("{}/", server.uri())).expect("base url");
        GithubDeviceLogin::with_base_url(base)
    }

    #[tokio::test]
    async fn start_parses_the_device_code_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/login/device/code"))
            .and(body_string_contains("client_id=cid"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "device_code": "dc-1",
                "user_code": "ABCD-1234",
                "verification_uri": "https://github.com/login/device",
                "expires_in": 900,
                "interval": 5,
            })))
            .mount(&server)
            .await;

        let c = client(&server).await;
        let start = c.start("cid", "repo read:org").await.unwrap();
        assert_eq!(start.device_code, "dc-1");
        assert_eq!(start.user_code, "ABCD-1234");
        assert_eq!(start.verification_uri, "https://github.com/login/device");
        assert_eq!(start.expires_in, 900);
        assert_eq!(start.interval, 5);
    }

    #[tokio::test]
    async fn poll_reports_authorization_pending() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/login/oauth/access_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "error": "authorization_pending",
            })))
            .mount(&server)
            .await;

        let c = client(&server).await;
        let outcome = c.poll("cid", "dc-1", 5).await.unwrap();
        assert!(matches!(outcome, DevicePoll::Pending));
    }

    #[tokio::test]
    async fn poll_slow_down_adds_five_seconds_when_the_host_gives_no_interval() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/login/oauth/access_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "error": "slow_down",
            })))
            .mount(&server)
            .await;

        let c = client(&server).await;
        let outcome = c.poll("cid", "dc-1", 5).await.unwrap();
        assert!(matches!(outcome, DevicePoll::SlowDown { interval: 10 }));
    }

    #[tokio::test]
    async fn poll_slow_down_honours_an_explicit_interval() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/login/oauth/access_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "error": "slow_down",
                "interval": 20,
            })))
            .mount(&server)
            .await;

        let c = client(&server).await;
        let outcome = c.poll("cid", "dc-1", 5).await.unwrap();
        assert!(matches!(outcome, DevicePoll::SlowDown { interval: 20 }));
    }

    #[tokio::test]
    async fn poll_reports_access_denied() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/login/oauth/access_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "error": "access_denied",
            })))
            .mount(&server)
            .await;

        let c = client(&server).await;
        let outcome = c.poll("cid", "dc-1", 5).await.unwrap();
        assert!(matches!(outcome, DevicePoll::AccessDenied));
    }

    #[tokio::test]
    async fn poll_reports_expired_token() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/login/oauth/access_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "error": "expired_token",
            })))
            .mount(&server)
            .await;

        let c = client(&server).await;
        let outcome = c.poll("cid", "dc-1", 5).await.unwrap();
        assert!(matches!(outcome, DevicePoll::ExpiredToken));
    }

    #[tokio::test]
    async fn poll_reports_success_with_the_access_token() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/login/oauth/access_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "ghu_abc123",
                "token_type": "bearer",
                "scope": "repo,read:org",
            })))
            .mount(&server)
            .await;

        let c = client(&server).await;
        let outcome = c.poll("cid", "dc-1", 5).await.unwrap();
        match outcome {
            DevicePoll::Success { access_token } => assert_eq!(access_token, "ghu_abc123"),
            other => panic!("expected Success, got {other:?}"),
        }
    }
}
