//! Theodore account over WorkOS AuthKit, as a public client: no client
//! secret or API key ever ships in the app (plan "Theodore account").
//!
//! ```text
//! browser  /user_management/authorize (PKCE S256, state, login_hint)
//!            └─▶ hosted AuthKit page ─▶ http://127.0.0.1:<port>/callback
//!                                       or theodore://callback (OS ─▶ app)
//!                  └─▶ POST /user_management/authenticate  code + code_verifier
//! device   POST /user_management/authorize/device ─▶ user_code
//!            └─▶ poll /user_management/authenticate  device_code grant
//! refresh  POST /user_management/authenticate  refresh_token grant (rotates)
//!            └─▶ + organization_id: the new token is authorized in that org
//! orgs     authenticate ─▶ 4xx organization_selection_required
//!            (pending_authentication_token, organizations[])
//!            └─▶ cloud POST /v1/auth/select-organization (the grant needs
//!                the client secret, which only the cloud holds)
//!                ─▶ session, validated like a code exchange
//! cloud    POST /v1/orgs/personal  (Bearer access token) ─▶ organization_id
//!          GET  /v1/orgs           (Bearer access token) ─▶ organizations[]
//! validate GET  /sso/jwks/<client_id> ─▶ RS256, iss, exp, sub
//!            claims carried into the session: sid, org_id, role, permissions
//!            JWKS unreachable: a token straight from WorkOS keeps its claim
//!            checks; one the cloud handed over fails (`Network`)
//! select   the session's organization_id and the token's org_id must both
//!            be the organization chosen
//! ```
//!
//! Cloud errors: transport, 5xx, 429 or a 4xx without the cloud's JSON error
//! ─▶ `Network`; `400 cloud.rejected` ─▶ `Rejected`; any other 4xx ─▶
//! `Protocol("code: message")`. No token ever lands in an error.

pub mod jwt;
pub mod loopback;
pub mod pkce;

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::Deserialize;
use theodore_ports::{
    AccountConfig, AccountError, AccountOrganization, AccountPort, AccountProfile, AccountResult,
    AccountSession, BrowserSignIn, CallbackListener, DeviceSignIn, DeviceSignInPoll,
    OrganizationChoice, OrganizationSelection, is_loopback_redirect,
};
use url::Url;

pub const DEFAULT_API_BASE: &str = "https://api.workos.com/";

const GRANT_CODE: &str = "authorization_code";
const GRANT_REFRESH: &str = "refresh_token";
const GRANT_DEVICE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const ORG_SELECTION_REQUIRED: &str = "organization_selection_required";
/// The cloud's code for "WorkOS refused" (a used pending token, an org the
/// user isn't in): the grant's answer, like a provider rejection.
const CLOUD_REJECTED: &str = "cloud.rejected";
const NO_CLOUD: &str = "no Theodore cloud configured";

/// Where a session's tokens came from: decides what an unreachable JWKS
/// may skip, and what else must hold.
#[derive(Debug, Clone, Copy)]
enum Source<'a> {
    /// Straight from WorkOS over TLS: an unreachable JWKS skips only the
    /// signature (the claims are still checked).
    Provider,
    /// Handed over by the Theodore cloud for the organization chosen: the
    /// signature is always checked (an unreachable JWKS is a `Network`
    /// error), and the session must be in exactly that organization.
    CloudSelected { organization_id: &'a str },
}

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
        // Only the provider's own JSON error (`invalid_grant`, …) is an
        // answer. A 4xx without one came from something in between — a
        // captive portal, a proxy's HTML page — and says nothing about the
        // grant: a connection problem, so a session survives it.
        let err: ErrorBody = serde_json::from_str(&text).unwrap_or_default();
        let Some(code) = err.error.or(err.code) else {
            return Err(AccountError::Network(format!(
                "{path} failed ({status}) without a provider error"
            )));
        };
        let message = match (err.error_description, err.message) {
            (Some(m), _) | (None, Some(m)) => m,
            // The raw body of an org-selection answer holds the pending
            // token: never echo it.
            (None, None) if code == ORG_SELECTION_REQUIRED => String::new(),
            (None, None) => text.chars().take(200).collect(),
        };
        Ok(Reply::Err {
            code,
            message,
            pending_authentication_token: err.pending_authentication_token,
            organizations: err.organizations,
        })
    }

    /// One call to the Theodore cloud (`cfg.cloud_url`). `bearer` is the
    /// access token and the JSON `body` may hold a pending token: neither is
    /// ever put in an error or a log.
    async fn cloud(
        &self,
        cfg: &AccountConfig,
        method: reqwest::Method,
        path: &str,
        bearer: Option<&str>,
        body: Option<serde_json::Value>,
    ) -> AccountResult<String> {
        let base = cfg
            .cloud_url
            .as_deref()
            .map(|b| b.trim().trim_end_matches('/'))
            .filter(|b| !b.is_empty())
            .ok_or_else(|| AccountError::Config(NO_CLOUD.into()))?;
        let url = Url::parse(&format!("{base}/{path}"))
            .map_err(|e| AccountError::Config(format!("bad Theodore cloud URL: {e}")))?;
        let mut req = self
            .http
            .request(method, url)
            .header("accept", "application/json")
            .header("user-agent", "theodore");
        if let Some(token) = bearer {
            req = req.bearer_auth(token);
        }
        if let Some(body) = body {
            req = req.json(&body);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| AccountError::Network(format!("cloud {path}: {e}")))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| AccountError::Network(format!("cloud {path}: {e}")))?;
        if status.is_server_error() || status.as_u16() == 429 {
            return Err(AccountError::Network(format!(
                "cloud {path} failed ({status})"
            )));
        }
        if status.is_success() {
            return Ok(text);
        }
        // As with the provider: only the cloud's own JSON error is an
        // answer; a 4xx without one came from something in between.
        let Some(CloudErrorDetail { code, message }) =
            serde_json::from_str::<CloudErrorBody>(&text)
                .unwrap_or_default()
                .error
        else {
            return Err(AccountError::Network(format!(
                "cloud {path} failed ({status}) without a cloud error"
            )));
        };
        let message: String = message.chars().take(200).collect();
        Err(if status.as_u16() == 400 && code == CLOUD_REJECTED {
            AccountError::Rejected(format!("{code}: {message}"))
        } else {
            AccountError::Protocol(format!("{code}: {message}"))
        })
    }

    async fn authenticate(
        &self,
        cfg: &AccountConfig,
        form: &[(&str, &str)],
    ) -> AccountResult<AccountSession> {
        match self.post_form("user_management/authenticate", form).await? {
            Reply::Ok(body) => self.session_from(cfg, &body, Source::Provider).await,
            Reply::Err {
                code,
                message,
                pending_authentication_token,
                organizations,
            } => Err(if code == ORG_SELECTION_REQUIRED {
                org_selection_error(pending_authentication_token, organizations)
            } else {
                AccountError::Rejected(format!("{code}: {message}"))
            }),
        }
    }

    async fn session_from(
        &self,
        cfg: &AccountConfig,
        body: &str,
        source: Source<'_>,
    ) -> AccountResult<AccountSession> {
        let resp: AuthResponse = serde_json::from_str(body)
            .map_err(|e| AccountError::Protocol(format!("decode authenticate response: {e}")))?;
        let claims = self
            .check_token(cfg, &resp.access_token, &resp.user.id, source)
            .await?;
        if let Source::CloudSelected { organization_id } = source {
            let session_org = resp.organization_id.as_deref().or(claims.org_id.as_deref());
            if session_org != Some(organization_id)
                || claims.org_id.as_deref() != Some(organization_id)
            {
                return Err(AccountError::InvalidToken(
                    "the session isn't in the organization chosen".into(),
                ));
            }
        }
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
            role: claims.role.filter(|s| !s.is_empty()),
            permissions: claims.permissions,
        })
    }

    /// Verifies `token`, received straight from WorkOS, against the JWKS
    /// and checks its claims. If the JWKS can't be reached at all, the
    /// claims are still checked: the token was just received from the
    /// provider itself over TLS, so the signature is defense in depth there,
    /// not the only guard. Never for a token from anywhere else.
    pub async fn validate(
        &self,
        cfg: &AccountConfig,
        token: &str,
        user_id: &str,
    ) -> AccountResult<jwt::Claims> {
        self.check_token(cfg, token, user_id, Source::Provider)
            .await
    }

    async fn check_token(
        &self,
        cfg: &AccountConfig,
        token: &str,
        user_id: &str,
        source: Source<'_>,
    ) -> AccountResult<jwt::Claims> {
        let parsed = jwt::parse(token)?;
        match self.key_for(&cfg.client_id, parsed.kid.as_deref()).await {
            Ok(key) => jwt::verify_signature(&parsed, &key)?,
            Err(AccountError::Network(e)) if matches!(source, Source::Provider) => {
                tracing::warn!("JWKS unreachable, access token signature not checked: {e}");
            }
            // A token the cloud handed over is only as good as its
            // signature: no keys, no session (a connection problem, so it
            // can be tried again).
            Err(AccountError::Network(e)) => {
                return Err(AccountError::Network(format!(
                    "can't check the session's signature: {e}"
                )));
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

/// `organization_selection_required` without a usable pending token or
/// organization list is a protocol problem, not something to pick from.
fn org_selection_error(
    pending_authentication_token: Option<String>,
    organizations: Vec<OrganizationBody>,
) -> AccountError {
    match pending_authentication_token.filter(|t| !t.is_empty()) {
        Some(pending_authentication_token) if !organizations.is_empty() => {
            AccountError::OrganizationSelectionRequired(OrganizationSelection {
                pending_authentication_token,
                organizations: organizations
                    .into_iter()
                    .map(|o| OrganizationChoice {
                        id: o.id,
                        name: o.name,
                    })
                    .collect(),
            })
        }
        _ => AccountError::Protocol(
            "organization selection required without a pending token or organizations".into(),
        ),
    }
}

enum Reply {
    Ok(String),
    Err {
        code: String,
        message: String,
        pending_authentication_token: Option<String>,
        organizations: Vec<OrganizationBody>,
    },
}

#[derive(Debug, Default, Deserialize)]
struct ErrorBody {
    error: Option<String>,
    error_description: Option<String>,
    code: Option<String>,
    message: Option<String>,
    pending_authentication_token: Option<String>,
    #[serde(default)]
    organizations: Vec<OrganizationBody>,
}

/// The cloud's error shape: `{ "error": { "code", "message" } }`.
#[derive(Debug, Default, Deserialize)]
struct CloudErrorBody {
    error: Option<CloudErrorDetail>,
}

#[derive(Debug, Deserialize)]
struct CloudErrorDetail {
    code: String,
    #[serde(default)]
    message: String,
}

#[derive(Debug, Deserialize)]
struct EnsuredOrganization {
    organization_id: String,
}

#[derive(Debug, Deserialize)]
struct OrganizationsResponse {
    organizations: Vec<OrganizationEntry>,
}

#[derive(Debug, Deserialize)]
struct OrganizationEntry {
    id: String,
    #[serde(default)]
    name: String,
    role: Option<String>,
    #[serde(default)]
    personal: bool,
}

#[derive(Debug, Deserialize)]
struct OrganizationBody {
    id: String,
    #[serde(default)]
    name: String,
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
        let (redirect_url, callbacks) = if is_loopback_redirect(&cfg.redirect_uri) {
            let redirect = loopback::parse_redirect(&cfg.redirect_uri)?;
            let (url, listener) = loopback::listen(&redirect).await?;
            (url, Some(Box::new(listener) as Box<dyn CallbackListener>))
        } else {
            // An app URL scheme: the OS hands the redirect to the app.
            let url = Url::parse(&cfg.redirect_uri).map_err(|e| {
                AccountError::Config(format!(
                    "redirect URI {:?} is not a URL: {e}",
                    cfg.redirect_uri
                ))
            })?;
            (url, None)
        };
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
            callbacks,
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
            Reply::Err { code, message, .. } => {
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
                self.session_from(cfg, &body, Source::Provider).await?,
            ))),
            Reply::Err {
                code,
                pending_authentication_token,
                organizations,
                ..
            } if code == ORG_SELECTION_REQUIRED => Err(org_selection_error(
                pending_authentication_token,
                organizations,
            )),
            Reply::Err { code, message, .. } => match code.as_str() {
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
        organization_id: Option<&str>,
    ) -> AccountResult<AccountSession> {
        let mut form = vec![
            ("grant_type", GRANT_REFRESH),
            ("client_id", cfg.client_id.as_str()),
            ("refresh_token", refresh_token),
        ];
        if let Some(org) = organization_id {
            form.push(("organization_id", org));
        }
        self.authenticate(cfg, &form).await
    }

    async fn select_organization(
        &self,
        cfg: &AccountConfig,
        pending_authentication_token: &str,
        organization_id: &str,
    ) -> AccountResult<AccountSession> {
        let body = self
            .cloud(
                cfg,
                reqwest::Method::POST,
                "v1/auth/select-organization",
                None,
                Some(serde_json::json!({
                    "pending_authentication_token": pending_authentication_token,
                    "organization_id": organization_id,
                })),
            )
            .await?;
        self.session_from(cfg, &body, Source::CloudSelected { organization_id })
            .await
    }

    async fn ensure_personal_organization(
        &self,
        cfg: &AccountConfig,
        access_token: &str,
    ) -> AccountResult<String> {
        let body = self
            .cloud(
                cfg,
                reqwest::Method::POST,
                "v1/orgs/personal",
                Some(access_token),
                Some(serde_json::json!({})),
            )
            .await?;
        let ensured: EnsuredOrganization = serde_json::from_str(&body)
            .map_err(|e| AccountError::Protocol(format!("decode personal organization: {e}")))?;
        if ensured.organization_id.is_empty() {
            return Err(AccountError::Protocol(
                "the cloud returned an empty organization id".into(),
            ));
        }
        Ok(ensured.organization_id)
    }

    async fn organizations(
        &self,
        cfg: &AccountConfig,
        access_token: &str,
    ) -> AccountResult<Vec<AccountOrganization>> {
        let body = self
            .cloud(
                cfg,
                reqwest::Method::GET,
                "v1/orgs",
                Some(access_token),
                None,
            )
            .await?;
        let list: OrganizationsResponse = serde_json::from_str(&body)
            .map_err(|e| AccountError::Protocol(format!("decode organizations: {e}")))?;
        Ok(list
            .organizations
            .into_iter()
            .map(|o| AccountOrganization {
                id: o.id,
                name: o.name,
                role: o.role.filter(|r| !r.is_empty()),
                personal: o.personal,
            })
            .collect())
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
