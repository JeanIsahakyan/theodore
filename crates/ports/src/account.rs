//! Theodore account (plan "Theodore account"): who the user is to Theodore
//! itself — a second, optional identity next to the host tokens, for the
//! cloud features to come. The app owns the session (storage, refresh,
//! status); an adapter owns the identity provider's protocol: the browser
//! sign-in with PKCE (redirect to a loopback listener or to the app's own
//! URL scheme), the device-code sign-in, token refresh and access-token
//! validation.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

pub type AccountResult<T> = Result<T, AccountError>;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AccountError {
    /// This build or mode has no account provider (fixtures, sandbox).
    #[error("Theodore accounts are not available here")]
    Unavailable,
    #[error("network: {0}")]
    Network(String),
    /// The provider refused the grant: a used or expired code, a revoked
    /// session, a refresh token that is no longer valid.
    #[error("rejected: {0}")]
    Rejected(String),
    /// An access token failed validation (signature, issuer, expiry).
    #[error("invalid token: {0}")]
    InvalidToken(String),
    /// Bad configuration: an `http` redirect URI that isn't loopback, a
    /// port taken.
    #[error("{0}")]
    Config(String),
    #[error("protocol: {0}")]
    Protocol(String),
    /// The user belongs to several organizations and the provider wants
    /// one picked before it issues a session. Finish it with
    /// [`AccountPort::select_organization`]. The message never carries the
    /// pending token.
    #[error("organization selection required ({} organizations)", .0.organizations.len())]
    OrganizationSelectionRequired(OrganizationSelection),
}

/// One organization the user can sign in to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrganizationChoice {
    pub id: String,
    pub name: String,
}

/// One of the signed-in user's organizations, as the Theodore cloud lists
/// them (`GET /v1/orgs`): active memberships, the personal one first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountOrganization {
    pub id: String,
    pub name: String,
    /// The user's role slug in it, when the membership has one.
    pub role: Option<String>,
    /// The user's own personal organization (created by the cloud).
    pub personal: bool,
}

/// What the provider hands back when a sign-in needs an organization.
#[derive(Clone, PartialEq, Eq)]
pub struct OrganizationSelection {
    /// Short-lived, single-use credential for the pending sign-in; a secret,
    /// so [`Debug`](std::fmt::Debug) redacts it.
    pub pending_authentication_token: String,
    pub organizations: Vec<OrganizationChoice>,
}

impl std::fmt::Debug for OrganizationSelection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OrganizationSelection")
            .field("pending_authentication_token", &"<redacted>")
            .field("organizations", &self.organizations)
            .finish()
    }
}

impl AccountError {
    /// The stable error code logged as `error.code` (docs/telemetry.md).
    pub fn code(&self) -> &'static str {
        match self {
            AccountError::Unavailable => "account.unavailable",
            AccountError::Network(_) => "account.network",
            AccountError::Rejected(_) => "account.rejected",
            AccountError::InvalidToken(_) => "account.invalid_token",
            AccountError::Config(_) => "account.config",
            AccountError::Protocol(_) => "account.protocol",
            AccountError::OrganizationSelectionRequired(_) => "account.org_selection_required",
        }
    }
}

/// Resolved by the app from env and settings; never hardcoded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountConfig {
    pub client_id: String,
    /// Where the browser comes back to. Either a loopback URL, e.g.
    /// `http://127.0.0.1:47823/callback` (port `0` picks a free port, only
    /// valid when the provider has a wildcard-port redirect registered), or
    /// an app URL scheme, e.g. `theodore://callback`, which the OS hands to
    /// the app (see [`is_loopback_redirect`]).
    pub redirect_uri: String,
    /// The Theodore cloud (docs/cloud.md), without a trailing `/`, e.g.
    /// `https://theodore-cloud.example.workers.dev`. `None`: this build has
    /// no cloud, so no organizations; signing in works without it.
    pub cloud_url: Option<String>,
}

/// `http`/`https` redirects are caught by a loopback listener the adapter
/// binds; any other scheme is an app URL scheme the OS delivers to the
/// app, which feeds the callback in itself.
pub fn is_loopback_redirect(redirect_uri: &str) -> bool {
    let scheme = redirect_uri.split_once(':').map_or("", |(s, _)| s);
    scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountProfile {
    pub id: String,
    pub email: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub avatar_url: Option<String>,
}

/// A signed-in session, as stored in the keychain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountSession {
    pub user: AccountProfile,
    pub access_token: String,
    /// Single-use: every refresh returns a new one that replaces it.
    pub refresh_token: String,
    /// The access token's `exp`, unix ms.
    pub expires_at: i64,
    /// The access token's `sid`, used to end the session on sign-out.
    pub session_id: Option<String>,
    pub organization_id: Option<String>,
    /// The access token's `role` slug; present only with an organization.
    /// Stored sessions from before organizations lack it.
    #[serde(default)]
    pub role: Option<String>,
    /// The access token's `permissions`; empty when it carries none.
    #[serde(default)]
    pub permissions: Vec<String>,
}

/// Query of the redirect the browser lands on.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CallbackParams {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

/// What the browser tab shows once the app has handled its callback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallbackPage {
    SignedIn {
        email: String,
    },
    Failed {
        message: String,
    },
    /// Not this sign-in's callback (stale tab, wrong `state`): the listener
    /// keeps waiting for the real one.
    Ignored,
    /// The sign-in went through but needs an organization picked: the tab
    /// sends the user back to the app, where the picker is.
    ChooseOrganization,
}

/// One request that reached the loopback redirect path. `reply` picks the
/// page the browser gets; dropping it sends a generic failure.
pub struct IncomingCallback {
    pub params: CallbackParams,
    pub reply: tokio::sync::oneshot::Sender<CallbackPage>,
}

/// The loopback listener of one browser sign-in. Dropping it frees the port.
#[async_trait]
pub trait CallbackListener: Send {
    async fn next(&mut self) -> AccountResult<IncomingCallback>;
}

/// A browser sign-in, ready to open.
pub struct BrowserSignIn {
    /// The provider's hosted sign-in page.
    pub url: String,
    /// CSRF guard: the callback must carry this back unchanged.
    pub state: String,
    /// PKCE verifier for the code exchange.
    pub code_verifier: String,
    /// The loopback listener; `None` for an app URL scheme redirect (the
    /// app receives that callback from the OS, no port is bound).
    pub callbacks: Option<Box<dyn CallbackListener>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceSignIn {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    /// `verification_uri` with the code pre-filled.
    pub verification_uri_complete: Option<String>,
    pub expires_in: u32,
    pub interval: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceSignInPoll {
    Pending,
    /// Wait at least `interval` seconds before polling again.
    SlowDown {
        interval: u32,
    },
    Denied,
    Expired,
    Done(Box<AccountSession>),
}

#[async_trait]
pub trait AccountPort: Send + Sync {
    /// `false` hides the feature (no provider wired in this mode).
    fn enabled(&self) -> bool {
        true
    }

    /// Builds the hosted sign-in URL with a fresh PKCE pair and `state`, and
    /// binds the loopback listener when `cfg.redirect_uri` is loopback (see
    /// [`is_loopback_redirect`]). `login_hint` pre-fills the email.
    async fn start_browser(
        &self,
        cfg: &AccountConfig,
        login_hint: Option<&str>,
    ) -> AccountResult<BrowserSignIn>;

    /// Exchanges an authorization code with the PKCE verifier (no secret).
    async fn exchange_code(
        &self,
        cfg: &AccountConfig,
        code: &str,
        code_verifier: &str,
    ) -> AccountResult<AccountSession>;

    async fn start_device(&self, cfg: &AccountConfig) -> AccountResult<DeviceSignIn>;

    async fn poll_device(
        &self,
        cfg: &AccountConfig,
        device_code: &str,
        current_interval: u32,
    ) -> AccountResult<DeviceSignInPoll>;

    /// Trades the refresh token for a new session (rotated refresh token).
    /// `organization_id: Some(..)` asks for the new access token to be
    /// authorized in that organization; `None` keeps the session's current
    /// one.
    async fn refresh(
        &self,
        cfg: &AccountConfig,
        refresh_token: &str,
        organization_id: Option<&str>,
    ) -> AccountResult<AccountSession>;

    /// Finishes a sign-in that failed with
    /// [`AccountError::OrganizationSelectionRequired`]. Needs the client
    /// secret, so it goes through the Theodore cloud
    /// (`POST /v1/auth/select-organization`); the session it returns is
    /// validated like a code exchange's. No cloud: `Config`.
    async fn select_organization(
        &self,
        cfg: &AccountConfig,
        pending_authentication_token: &str,
        organization_id: &str,
    ) -> AccountResult<AccountSession>;

    /// The caller's personal organization, created by the cloud on first
    /// use (`POST /v1/orgs/personal`); returns its id. Idempotent. No
    /// cloud: `Config`.
    async fn ensure_personal_organization(
        &self,
        cfg: &AccountConfig,
        access_token: &str,
    ) -> AccountResult<String>;

    /// The caller's organizations (`GET /v1/orgs`). No cloud: `Config`.
    async fn organizations(
        &self,
        cfg: &AccountConfig,
        access_token: &str,
    ) -> AccountResult<Vec<AccountOrganization>>;

    /// Ends the session at the provider. Best effort: the local sign-out
    /// happens whatever this returns.
    async fn sign_out(&self, cfg: &AccountConfig, session: &AccountSession) -> AccountResult<()>;
}

/// No provider: always signed out, the UI hides the account card. Used by
/// fixtures, the sandbox and the CLI.
pub struct LocalAccount;

#[async_trait]
impl AccountPort for LocalAccount {
    fn enabled(&self) -> bool {
        false
    }
    async fn start_browser(
        &self,
        _cfg: &AccountConfig,
        _login_hint: Option<&str>,
    ) -> AccountResult<BrowserSignIn> {
        Err(AccountError::Unavailable)
    }
    async fn exchange_code(
        &self,
        _cfg: &AccountConfig,
        _code: &str,
        _code_verifier: &str,
    ) -> AccountResult<AccountSession> {
        Err(AccountError::Unavailable)
    }
    async fn start_device(&self, _cfg: &AccountConfig) -> AccountResult<DeviceSignIn> {
        Err(AccountError::Unavailable)
    }
    async fn poll_device(
        &self,
        _cfg: &AccountConfig,
        _device_code: &str,
        _current_interval: u32,
    ) -> AccountResult<DeviceSignInPoll> {
        Err(AccountError::Unavailable)
    }
    async fn refresh(
        &self,
        _cfg: &AccountConfig,
        _refresh_token: &str,
        _organization_id: Option<&str>,
    ) -> AccountResult<AccountSession> {
        Err(AccountError::Unavailable)
    }
    async fn select_organization(
        &self,
        _cfg: &AccountConfig,
        _pending_authentication_token: &str,
        _organization_id: &str,
    ) -> AccountResult<AccountSession> {
        Err(AccountError::Unavailable)
    }
    async fn ensure_personal_organization(
        &self,
        _cfg: &AccountConfig,
        _access_token: &str,
    ) -> AccountResult<String> {
        Err(AccountError::Unavailable)
    }
    async fn organizations(
        &self,
        _cfg: &AccountConfig,
        _access_token: &str,
    ) -> AccountResult<Vec<AccountOrganization>> {
        Err(AccountError::Unavailable)
    }
    async fn sign_out(&self, _cfg: &AccountConfig, _session: &AccountSession) -> AccountResult<()> {
        Err(AccountError::Unavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_redirects_are_loopback_and_app_schemes_are_not() {
        assert!(is_loopback_redirect("http://127.0.0.1:47823/callback"));
        assert!(is_loopback_redirect("HTTPS://example.com/cb"));
        assert!(!is_loopback_redirect("theodore://callback"));
        assert!(!is_loopback_redirect("not a url"));
    }

    #[test]
    fn a_session_stored_before_organizations_still_loads() {
        let old = r#"{
            "user": {"id": "u", "email": "a@b.c", "first_name": null,
                     "last_name": null, "avatar_url": null},
            "access_token": "at", "refresh_token": "rt", "expires_at": 1,
            "session_id": "s", "organization_id": "org_1"
        }"#;
        let s: AccountSession = serde_json::from_str(old).unwrap();
        assert_eq!(s.organization_id.as_deref(), Some("org_1"));
        assert_eq!(s.role, None);
        assert!(s.permissions.is_empty());
    }

    #[test]
    fn the_pending_token_stays_out_of_display_and_debug() {
        let e = AccountError::OrganizationSelectionRequired(OrganizationSelection {
            pending_authentication_token: "pending-secret".into(),
            organizations: vec![OrganizationChoice {
                id: "org_1".into(),
                name: "Acme".into(),
            }],
        });
        assert_eq!(e.code(), "account.org_selection_required");
        assert!(!e.to_string().contains("pending-secret"));
        assert!(!format!("{e:?}").contains("pending-secret"));
    }
}
