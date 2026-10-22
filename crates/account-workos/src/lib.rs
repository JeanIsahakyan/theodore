//! Theodore account over WorkOS AuthKit, as a public client: no client
//! secret or API key ever ships in the app (plan "Theodore account").
//!
//! ```text
//! browser  /user_management/authorize (PKCE S256, state, login_hint)
//!            └─▶ hosted AuthKit page ─▶ http://127.0.0.1:<port>/callback
//!                  └─▶ POST /user_management/authenticate  code + code_verifier
//! device   POST /user_management/authorize/device ─▶ user_code
//!            └─▶ poll /user_management/authenticate  device_code grant
//! refresh  POST /user_management/authenticate  refresh_token grant (rotates)
//! validate GET  /sso/jwks/<client_id> ─▶ RS256, iss, exp, sub
//! ```

pub mod jwt;
pub mod loopback;
pub mod pkce;

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::Deserialize;
use theodore_ports::{
    AccountConfig, AccountError, AccountPort, AccountProfile, AccountResult, AccountSession,
    BrowserSignIn, DeviceSignIn, DeviceSignInPoll,
};
use url::Url;

pub const DEFAULT_API_BASE: &str = "https://api.workos.com/";

const GRANT_CODE: &str = "authorization_code";
const GRANT_REFRESH: &str = "refresh_token";
const GRANT_DEVICE: &str = "urn:ietf:params:oauth:grant-type:device_code";

pub struct WorkosAccount {
    http: reqwest::Client,
    /// Logout answers with a redirect to the hosted page; it's the 302
    /// itself that matters, so this client never follows it.
    no_redirect: reqwest::Client,
    api_base: Url,
    issuers: Vec<String>,
    /// JWKS per client id, refetched when a token names an unknown `kid`.
    jwks: tokio::sync::Mutex<HashMap<String, jwt::Jwks>>,
}

impl Default for WorkosAccount {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkosAccount {
    pub fn new() -> Self {
        Self::with_api_base(Url::parse(DEFAULT_API_BASE).expect("valid url"))
    }

    /// `api_base` must end with `/` (a wiremock server's `uri() + "/"` in
    /// tests). Tokens are expected to be issued by the same origin.
    pub fn with_api_base(api_base: Url) -> Self {
        let issuer = api_base.as_str().trim_end_matches('/').to_string();
        Self {
            http: reqwest::Client::new(),
            no_redirect: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap_or_default(),
            api_base,
            issuers: vec![issuer],
            jwks: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Accepts one more `iss` (a custom authentication domain issues tokens
    /// under its own origin).
    pub fn with_issuer(mut self, issuer: impl Into<String>) -> Self {
        self.issuers.push(issuer.into());
        self
    }

    fn url(&self, path: &str) -> AccountResult<Url> {
        self.api_base
            .join(path)
            .map_err(|e| AccountError::Protocol(format!("bad path {path:?}: {e}")))
    }

    /// The hosted sign-in page for one attempt.
    pub fn authorize_url(
        &self,
        client_id: &str,
        redirect_uri: &str,
        state: &str,
        code_challenge: &str,
        login_hint: Option<&str>,
    ) -> AccountResult<Url> {
        let mut url = self.url("user_management/authorize")?;
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("response_type", "code")
                .append_pair("client_id", client_id)
                .append_pair("redirect_uri", redirect_uri)
                .append_pair("provider", "authkit")
                .append_pair("state", state)
                .append_pair("code_challenge", code_challenge)
                .append_pair("code_challenge_method", "S256");
            if let Some(hint) = login_hint.map(str::trim).filter(|h| !h.is_empty()) {
                q.append_pair("login_hint", hint);
            }
        }
        Ok(url)
    }

    async fn post_form(&self, path: &str, form: &[(&str, &str)]) -> AccountResult<Reply> {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(form)
            .finish();
        let resp = self
            .http
            .post(self.url(path)?)
            .header("accept", "application/json")
            .header("user-agent", "theodore")
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .map_err(|e| AccountError::Network(e.to_string()))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| AccountError::Network(e.to_string()))?;
        if status.is_server_error() || status.as_u16() == 429 {
            return Err(AccountError::Network(format!("{path} failed ({status})")));
        }
        if status.is_success() {
            return Ok(Reply::Ok(text));
        }
        let err: ErrorBody = serde_json::from_str(&text).unwrap_or_default();
        Ok(Reply::Err {
            code: err.error.or(err.code).unwrap_or_else(|| status.to_string()),
            message: err
                .error_description
                .or(err.message)
                .unwrap_or_else(|| text.chars().take(200).collect()),
        })
    }

    async fn authenticate(
        &self,
        cfg: &AccountConfig,
        form: &[(&str, &str)],
    ) -> AccountResult<AccountSession> {
        match self.post_form("user_management/authenticate", form).await? {
            Reply::Ok(body) => self.session_from(cfg, &body).await,
            Reply::Err { code, message } => {
                Err(AccountError::Rejected(format!("{code}: {message}")))
            }
        }
    }

    async fn session_from(&self, cfg: &AccountConfig, body: &str) -> AccountResult<AccountSession> {
        let resp: AuthResponse = serde_json::from_str(body)
            .map_err(|e| AccountError::Protocol(format!("decode authenticate response: {e}")))?;
        let claims = self
            .validate(cfg, &resp.access_token, &resp.user.id)
            .await?;
        Ok(AccountSession {
            user: AccountProfile {
                id: resp.user.id,
                email: resp.user.email,
                first_name: resp.user.first_name.filter(|s| !s.is_empty()),
                last_name: resp.user.last_name.filter(|s| !s.is_empty()),
                avatar_url: resp.user.profile_picture_url.filter(|s| !s.is_empty()),
            },
            access_token: resp.access_token,
            refresh_token: resp.refresh_token,
            expires_at: claims.exp.saturating_mul(1000),
            session_id: claims.sid,
            organization_id: resp.organization_id.or(claims.org_id),
        })
    }

    /// Verifies `token` against the JWKS and checks its claims. If the JWKS
    /// can't be reached at all, the claims are still checked: the token was
    /// just received from the provider itself over TLS, so the signature is
    /// defense in depth there, not the only guard.
    pub async fn validate(
        &self,
        cfg: &AccountConfig,
        token: &str,
        user_id: &str,
    ) -> AccountResult<jwt::Claims> {
        let parsed = jwt::parse(token)?;
        match self.key_for(&cfg.client_id, parsed.kid.as_deref()).await {
            Ok(key) => jwt::verify_signature(&parsed, &key)?,
            Err(AccountError::Network(e)) => {
                tracing::warn!("JWKS unreachable, access token signature not checked: {e}");
            }
            Err(e) => return Err(e),
        }
        jwt::check_claims(
            &parsed.claims,
            &self.issuers,
            &cfg.client_id,
            user_id,
            now_secs(),
        )?;
        Ok(parsed.claims)
    }

    async fn key_for(&self, client_id: &str, kid: Option<&str>) -> AccountResult<jwt::Jwk> {
        let mut cache = self.jwks.lock().await;
        if let Some(key) = cache.get(client_id).and_then(|j| jwt::find_key(j, kid)) {
            return Ok(key.clone());
        }
        let url = self.url(&format!("sso/jwks/{client_id}"))?;
        let resp = self
            .http
            .get(url)
            .header("accept", "application/json")
            .header("user-agent", "theodore")
            .send()
            .await
            .map_err(|e| AccountError::Network(e.to_string()))?;
        let status = resp.status();
        if status.is_server_error() {
            return Err(AccountError::Network(format!(
                "JWKS fetch failed ({status})"
            )));
        }
        if !status.is_success() {
            return Err(AccountError::InvalidToken(format!(
                "JWKS fetch failed ({status})"
            )));
        }
        let jwks: jwt::Jwks = resp
            .json()
            .await
            .map_err(|e| AccountError::Protocol(format!("decode JWKS: {e}")))?;
        let key = jwt::find_key(&jwks, kid).cloned();
        cache.insert(client_id.to_string(), jwks);
        key.ok_or_else(|| AccountError::InvalidToken("token signed with an unknown key".into()))
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

enum Reply {
    Ok(String),
    Err { code: String, message: String },
}

#[derive(Debug, Default, Deserialize)]
struct ErrorBody {
    error: Option<String>,
    error_description: Option<String>,
    code: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WorkosUser {
    id: String,
    email: String,
    first_name: Option<String>,
    last_name: Option<String>,
    profile_picture_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AuthResponse {
    user: WorkosUser,
    organization_id: Option<String>,
    access_token: String,
    refresh_token: String,
}

#[derive(Debug, Deserialize)]
struct DeviceResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: Option<String>,
    expires_in: u32,
    interval: Option<u32>,
}

#[async_trait]
impl AccountPort for WorkosAccount {
    async fn start_browser(
        &self,
        cfg: &AccountConfig,
        login_hint: Option<&str>,
    ) -> AccountResult<BrowserSignIn> {
        let redirect = loopback::parse_redirect(&cfg.redirect_uri)?;
        let (redirect_url, listener) = loopback::listen(&redirect).await?;
        let pkce = pkce::generate()?;
        let state = pkce::random_token()?;
        let url = self.authorize_url(
            &cfg.client_id,
            redirect_url.as_str(),
            &state,
            &pkce.challenge,
            login_hint,
        )?;
        Ok(BrowserSignIn {
            url: url.to_string(),
            state,
            code_verifier: pkce.verifier,
            callbacks: Box::new(listener),
        })
    }

    async fn exchange_code(
        &self,
        cfg: &AccountConfig,
        code: &str,
        code_verifier: &str,
    ) -> AccountResult<AccountSession> {
        self.authenticate(
            cfg,
            &[
                ("grant_type", GRANT_CODE),
                ("client_id", &cfg.client_id),
                ("code", code),
                ("code_verifier", code_verifier),
            ],
        )
        .await
    }

    async fn start_device(&self, cfg: &AccountConfig) -> AccountResult<DeviceSignIn> {
        match self
            .post_form(
                "user_management/authorize/device",
                &[("client_id", &cfg.client_id)],
            )
            .await?
        {
            Reply::Ok(body) => {
                let d: DeviceResponse = serde_json::from_str(&body).map_err(|e| {
                    AccountError::Protocol(format!("decode device authorization: {e}"))
                })?;
                Ok(DeviceSignIn {
                    device_code: d.device_code,
                    user_code: d.user_code,
                    verification_uri: d.verification_uri,
                    verification_uri_complete: d.verification_uri_complete,
                    expires_in: d.expires_in,
                    interval: d.interval.unwrap_or(5).max(1),
                })
            }
            Reply::Err { code, message } => {
                Err(AccountError::Rejected(format!("{code}: {message}")))
            }
        }
    }

    async fn poll_device(
        &self,
        cfg: &AccountConfig,
        device_code: &str,
        current_interval: u32,
    ) -> AccountResult<DeviceSignInPoll> {
        let form = [
            ("grant_type", GRANT_DEVICE),
            ("device_code", device_code),
            ("client_id", cfg.client_id.as_str()),
        ];
        match self
            .post_form("user_management/authenticate", &form)
            .await?
        {
            Reply::Ok(body) => Ok(DeviceSignInPoll::Done(Box::new(
                self.session_from(cfg, &body).await?,
            ))),
            Reply::Err { code, message } => match code.as_str() {
                "authorization_pending" => Ok(DeviceSignInPoll::Pending),
                // RFC 8628 §3.5: every slow_down adds 5 seconds.
                "slow_down" => Ok(DeviceSignInPoll::SlowDown {
                    interval: current_interval + 5,
                }),
                "access_denied" => Ok(DeviceSignInPoll::Denied),
                "expired_token" => Ok(DeviceSignInPoll::Expired),
                _ => Err(AccountError::Rejected(format!("{code}: {message}"))),
            },
        }
    }

    async fn refresh(
        &self,
        cfg: &AccountConfig,
        refresh_token: &str,
    ) -> AccountResult<AccountSession> {
        self.authenticate(
            cfg,
            &[
                ("grant_type", GRANT_REFRESH),
                ("client_id", &cfg.client_id),
                ("refresh_token", refresh_token),
            ],
        )
        .await
    }

    async fn sign_out(&self, _cfg: &AccountConfig, session: &AccountSession) -> AccountResult<()> {
        let Some(sid) = &session.session_id else {
            return Ok(());
        };
        let mut url = self.url("user_management/sessions/logout")?;
        url.query_pairs_mut().append_pair("session_id", sid);
        let resp = self
            .no_redirect
            .get(url)
            .header("user-agent", "theodore")
            .send()
            .await
            .map_err(|e| AccountError::Network(e.to_string()))?;
        let status = resp.status();
        if status.is_success() || status.is_redirection() {
            Ok(())
        } else if status.is_server_error() {
            Err(AccountError::Network(format!("logout failed ({status})")))
        } else {
            Err(AccountError::Rejected(format!("logout failed ({status})")))
        }
    }
}

#[cfg(test)]
mod tests;
