//! Theodore account (plan "Theodore account"): `account_status`,
//! `account_sign_in_start` / `_poll` / `_cancel`, `account_sign_out`. An
//! identity with Theodore itself, separate from the host tokens; the
//! provider protocol lives behind `AccountPort`.
//!
//! Wherever it's configured, signing in is required (plan §6.12 "Sign-in
//! required"): until then `require_account` turns away the commands that
//! do work and the background loops hold (`account_hold`).
//!
//! ```text
//! gate   no provider (fixtures, sandbox, CLI) ─▶ Exempt        ─┐
//!        no client id (plain dev build)       ─▶ NotConfigured ├─▶ open
//!        session stored                       ─▶ SignedIn      ─┘
//!        none                                 ─▶ SignedOut     ─▶ closed
//! ```
//!
//! ```text
//! browser  start ─▶ port builds URL (binds loopback if http) ─▶ UI opens it
//!            └─ task: callback ─▶ state check ─▶ exchange ─▶ keychain ─▶ emit
//!                       ▲
//!          loopback listener, or the shell's `account_sign_in_callback`
//!          (theodore[-<env>]://callback handed to the app by the OS)
//! device   start ─▶ user_code ─▶ UI polls ─▶ exchange ─▶ keychain ─▶ emit
//! session  refresher wakes 60 s before `exp` ─▶ rotate ─▶ keychain
//!            └─ rejected ─▶ signed out ─▶ emit
//! ```

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use theodore_contract::{
    AccountSignInMethod, AccountSignInRequest, AccountSignInStart, AccountSignInState,
    AccountStatus, AccountUser, Ephemeral,
};
use theodore_ports::{
    AccountConfig, AccountError, AccountResult, AccountSession, BrowserSignIn, CallbackListener,
    CallbackPage, CallbackParams, DeviceSignInPoll, IncomingCallback,
};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::core::Core;
use crate::error::{AppError, AppResult};

/// Checked before the settings: lets a packaged build or a developer
/// configure the account without touching the store. A release build may
/// also carry one baked in (`Deps::account_client_id`), checked last; no
/// client id is ever committed, the owner creates the WorkOS application.
pub const CLIENT_ID_ENV: &str = "THEODORE_WORKOS_CLIENT_ID";
pub const CLIENT_ID_SETTING: &str = "account.workos.client_id";
pub const REDIRECT_ENV: &str = "THEODORE_WORKOS_REDIRECT_URI";
pub const REDIRECT_SETTING: &str = "account.workos.redirect_uri";
/// Loopback redirect, for when the app can't receive its URL scheme (a dev
/// run, a bare binary). Must be registered as a redirect URI on the WorkOS
/// application.
pub const DEFAULT_REDIRECT_URI: &str = "http://127.0.0.1:47823/callback";

/// Refresh this long before the access token's `exp`.
pub(crate) const REFRESH_SKEW_MS: i64 = 60_000;
const MIN_REFRESH_WAIT_MS: i64 = 5_000;
const RETRY_AFTER: Duration = Duration::from_secs(30);
/// A browser sign-in nobody finishes stops listening after this.
const BROWSER_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// A held background loop re-checks the gate this often besides being woken
/// by a sign-in (a client id setting removed, say).
const GATE_RECHECK: Duration = Duration::from_secs(1);

/// Whether the app may do work now (plan §6.12 "Sign-in required").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountGate {
    /// No account provider in this mode (fixtures, sandbox, the CLI).
    Exempt,
    /// A provider, but no client id from the env, the setting or the
    /// build: a plain dev build runs without an account.
    NotConfigured,
    SignedIn,
    /// Sign-in required and missing: only the sign-in works.
    SignedOut,
}

impl AccountGate {
    pub fn is_open(self) -> bool {
        !matches!(self, AccountGate::SignedOut)
    }
}

/// The client id: the env var, else the setting, else the one baked into
/// the build. Blank values don't count. `None`: no account in this build.
pub fn resolve_client_id(
    env: Option<&str>,
    setting: Option<&str>,
    built_in: Option<&str>,
) -> Option<String> {
    [env, setting, built_in]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|v| !v.is_empty())
        .map(str::to_string)
}

enum Pending {
    Browser {
        id: u64,
        cancel: CancellationToken,
        outcome: Option<AccountSignInState>,
        /// Set when the redirect is an app URL scheme: where the shell's
        /// `account_sign_in_callback` feeds the redirect in.
        app_callbacks: Option<AppCallbacks>,
    },
    Device {
        id: u64,
        device_code: String,
        interval: u32,
    },
}

/// One browser sign-in, as its flow task sees it.
struct BrowserAttempt {
    id: u64,
    state: String,
    code_verifier: String,
    callbacks: Box<dyn CallbackListener>,
    cancel: CancellationToken,
}

/// Whether the gate is open from the configuration alone, worked out
/// without waiting at start-up: no provider, or no client id anywhere.
/// Otherwise it starts closed until `Core::account_gate` has read the
/// stored session, so no host call slips out before that.
pub(crate) fn gate_open_at_start(deps: &crate::Deps) -> bool {
    if !deps.account.enabled() {
        return true;
    }
    let env = std::env::var(CLIENT_ID_ENV).ok();
    let setting = deps
        .store
        .query(theodore_contract::models::SETTING, "key", CLIENT_ID_SETTING)
        .ok()
        .and_then(|rows| crate::settings::pick_setting(rows, None))
        .and_then(|v| v.as_str().map(str::to_string));
    resolve_client_id(
        env.as_deref(),
        setting.as_deref(),
        deps.account_client_id.as_deref(),
    )
    .is_none()
}

/// In-memory account state, one per `Core`.
#[derive(Default)]
pub(crate) struct AccountState {
    loaded: tokio::sync::OnceCell<()>,
    session: std::sync::Mutex<Option<AccountSession>>,
    pending: std::sync::Mutex<Option<Pending>>,
    refresher: std::sync::Mutex<Option<CancellationToken>>,
    /// Refresh tokens are single-use: one refresh at a time.
    refresh_lock: tokio::sync::Mutex<()>,
    /// Bumped on every sign-in and sign-out, so a refresh that raced one
    /// never writes a stale session back.
    generation: AtomicU64,
    next_id: AtomicU64,
    /// The app URL scheme redirect the shell can receive, if any
    /// (`Core::set_account_app_redirect`).
    app_redirect: std::sync::Mutex<Option<String>>,
    /// The last gate `Core::account_gate` worked out, open or not: what the
    /// background loops check on every tick. Seeded by
    /// `gate_open_at_start`.
    open: std::sync::atomic::AtomicBool,
    /// Wakes held loops when the gate changes.
    gate_changed: tokio::sync::Notify,
    /// The provider ended the last session (a rejected refresh); cleared by
    /// the next sign-in or sign-out.
    session_ended: std::sync::atomic::AtomicBool,
}

impl AccountState {
    pub(crate) fn new(open: bool) -> Self {
        Self {
            open: std::sync::atomic::AtomicBool::new(open),
            ..Self::default()
        }
    }

    /// The gate as last worked out.
    pub(crate) fn is_open(&self) -> bool {
        self.open.load(Ordering::SeqCst)
    }

    fn note_gate(&self, open: bool) {
        if self.open.swap(open, Ordering::SeqCst) != open {
            self.gate_changed.notify_waiters();
        }
    }
}

/// The receiving end of an app URL scheme redirect for one sign-in.
struct AppCallbacks {
    redirect: String,
    tx: mpsc::Sender<IncomingCallback>,
}

/// Stands in for the loopback listener when the OS delivers the redirect.
struct AppSchemeCallbacks(mpsc::Receiver<IncomingCallback>);

#[async_trait]
impl CallbackListener for AppSchemeCallbacks {
    async fn next(&mut self) -> AccountResult<IncomingCallback> {
        self.0
            .recv()
            .await
            .ok_or_else(|| AccountError::Protocol("the sign-in stopped waiting".into()))
    }
}

/// Configured redirect (env or setting) wins; else the app URL scheme when
/// the shell can receive it; else the loopback.
pub(crate) fn choose_redirect(configured: Option<String>, app: Option<&str>) -> String {
    configured
        .or_else(|| app.map(str::to_string))
        .unwrap_or_else(|| DEFAULT_REDIRECT_URI.to_string())
}

/// The query of `url` if it is `redirect` (same scheme, host and path; a
/// trailing `/` doesn't matter). Unknown keys are ignored; a repeated key
/// keeps its first value.
pub(crate) fn app_callback_params(url: &str, redirect: &str) -> Option<CallbackParams> {
    let (url, redirect) = (Url::parse(url).ok()?, Url::parse(redirect).ok()?);
    let same = url.scheme() == redirect.scheme()
        && url.host_str() == redirect.host_str()
        && url.path().trim_end_matches('/') == redirect.path().trim_end_matches('/');
    if !same {
        return None;
    }
    let mut params = CallbackParams::default();
    for (k, v) in url.query_pairs() {
        let slot = match k.as_ref() {
            "code" => &mut params.code,
            "state" => &mut params.state,
            "error" => &mut params.error,
            "error_description" => &mut params.error_description,
            _ => continue,
        };
        if slot.is_none() {
            *slot = Some(v.into_owned());
        }
    }
    Some(params)
}

/// What a redirect means for the sign-in waiting on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CallbackCheck {
    Code(String),
    Denied(String),
    Error(String),
    /// Wrong or missing `state`: not this sign-in's redirect (a stale tab,
    /// or a forged request). Has no effect; the sign-in keeps waiting.
    Ignore,
}

pub(crate) fn check_callback(p: &CallbackParams, expected_state: &str) -> CallbackCheck {
    if expected_state.is_empty() || p.state.as_deref() != Some(expected_state) {
        return CallbackCheck::Ignore;
    }
    if let Some(err) = &p.error {
        let desc = p.error_description.clone().unwrap_or_default();
        return if err == "access_denied" {
            CallbackCheck::Denied(if desc.is_empty() {
                "Sign-in was cancelled.".into()
            } else {
                desc
            })
        } else if desc.is_empty() {
            CallbackCheck::Error(err.clone())
        } else {
            CallbackCheck::Error(format!("{err}: {desc}"))
        };
    }
    match &p.code {
        Some(code) if !code.is_empty() => CallbackCheck::Code(code.clone()),
        _ => CallbackCheck::Error("the sign-in redirect carried no code".into()),
    }
}

pub(crate) fn user_of(s: &AccountSession) -> AccountUser {
    let name = [s.user.first_name.as_deref(), s.user.last_name.as_deref()]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    AccountUser {
        id: s.user.id.clone(),
        email: s.user.email.clone(),
        name: (!name.is_empty()).then_some(name),
        avatar_url: s.user.avatar_url.clone(),
    }
}

fn unavailable() -> AccountStatus {
    AccountStatus {
        available: false,
        required: false,
        user: None,
        session_ended: false,
    }
}

fn not_configured() -> AppError {
    AppError::Invalid("Theodore accounts aren't configured (no WorkOS client id)".into())
}

impl Core {
    /// `THEODORE_WORKOS_*` env, else the `account.workos.*` settings (the
    /// client id last falls back to the build's own, `resolve_client_id`).
    /// `None` hides the feature: no provider in this mode, or no client id.
    /// The redirect: see `choose_redirect`.
    pub(crate) async fn account_config(&self) -> Option<AccountConfig> {
        if !self.0.deps.account.enabled() {
            return None;
        }
        let env = std::env::var(CLIENT_ID_ENV).ok();
        let setting = self.setting_string(CLIENT_ID_SETTING, "").await;
        let client_id = resolve_client_id(
            env.as_deref(),
            Some(&setting),
            self.0.deps.account_client_id.as_deref(),
        )?;
        let configured = self.env_or_setting(REDIRECT_ENV, REDIRECT_SETTING).await;
        let app = self
            .0
            .account
            .app_redirect
            .lock()
            .expect("account lock")
            .clone();
        let redirect_uri = choose_redirect(configured, app.as_deref());
        Some(AccountConfig {
            client_id,
            redirect_uri,
        })
    }

    /// Called by the shell when it receives its URL scheme (an installed app
    /// bundle): browser sign-ins then return to `uri` (the build's own,
    /// `theodore://callback` or `theodore-<env>://callback`; each must be
    /// registered as a redirect URI on the WorkOS application) instead of
    /// the loopback, unless a redirect is configured. `None` goes back to
    /// the loopback.
    pub fn set_account_app_redirect(&self, uri: Option<&str>) {
        *self.0.account.app_redirect.lock().expect("account lock") = uri.map(str::to_string);
    }

    async fn env_or_setting(&self, env: &str, key: &str) -> Option<String> {
        if let Ok(v) = std::env::var(env)
            && !v.trim().is_empty()
        {
            return Some(v.trim().to_string());
        }
        let v = self.setting_string(key, "").await;
        (!v.trim().is_empty()).then(|| v.trim().to_string())
    }

    pub async fn account_status(&self) -> AppResult<AccountStatus> {
        Ok(match self.account_gate().await {
            AccountGate::Exempt | AccountGate::NotConfigured => unavailable(),
            AccountGate::SignedIn | AccountGate::SignedOut => self.account_status_now(),
        })
    }

    fn account_status_now(&self) -> AccountStatus {
        AccountStatus {
            available: true,
            required: true,
            user: self.account_session().as_ref().map(user_of),
            session_ended: self.0.account.session_ended.load(Ordering::SeqCst),
        }
    }

    /// Works out whether the app may do work now, and records it for the
    /// background loops (`account_hold`).
    pub async fn account_gate(&self) -> AccountGate {
        let gate = if !self.0.deps.account.enabled() {
            AccountGate::Exempt
        } else if self.account_config().await.is_none() {
            AccountGate::NotConfigured
        } else {
            self.account_load().await;
            if self.account_session().is_some() {
                AccountGate::SignedIn
            } else {
                AccountGate::SignedOut
            }
        };
        self.0.account.note_gate(gate.is_open());
        gate
    }

    /// `Err(AccountRequired)` while signed out where sign-in is required.
    /// The shell calls it before every command that does work.
    pub async fn require_account(&self) -> AppResult<()> {
        if self.account_gate().await.is_open() {
            Ok(())
        } else {
            Err(AppError::AccountRequired)
        }
    }

    /// Holds a background loop (poller, outbox) while the gate is closed,
    /// so no host traffic starts before sign-in or after the session
    /// ended. Free when the gate is open. `false` once the core shuts down.
    pub(crate) async fn account_hold(&self) -> bool {
        if self.0.account.is_open() {
            return !self.0.shutdown.is_cancelled();
        }
        loop {
            // Registered before the check, so a sign-in in between still
            // wakes it.
            let changed = self.0.account.gate_changed.notified();
            if self.account_gate().await.is_open() {
                return !self.0.shutdown.is_cancelled();
            }
            tokio::select! {
                _ = self.0.shutdown.cancelled() => return false,
                _ = changed => {}
                _ = tokio::time::sleep(GATE_RECHECK) => {}
            }
        }
    }

    fn account_session(&self) -> Option<AccountSession> {
        self.0.account.session.lock().expect("account lock").clone()
    }

    /// Reads the stored session once per process.
    async fn account_load(&self) {
        self.0
            .account
            .loaded
            .get_or_init(|| async {
                let secrets = self.0.deps.secrets.clone();
                let raw = tokio::task::spawn_blocking(move || {
                    secrets.get(theodore_secrets::THEODORE_ACCOUNT)
                })
                .await
                .ok()
                .and_then(Result::ok)
                .flatten();
                let session = raw.and_then(|s| serde_json::from_str::<AccountSession>(&s).ok());
                *self.0.account.session.lock().expect("account lock") = session;
            })
            .await;
    }

    async fn account_persist(&self, session: Option<&AccountSession>) -> AppResult<()> {
        let secrets = self.0.deps.secrets.clone();
        let json = session
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| AppError::Invalid(format!("encode account session: {e}")))?;
        tokio::task::spawn_blocking(move || match json {
            Some(j) => secrets.set(theodore_secrets::THEODORE_ACCOUNT, &j),
            None => secrets.delete(theodore_secrets::THEODORE_ACCOUNT),
        })
        .await
        .map_err(AppError::join)?
        .map_err(|e| AppError::Invalid(e.to_string()))
    }

    /// Spawned by `Core::start`: loads the stored session and keeps it
    /// fresh, so it doesn't lapse while the app runs.
    pub(crate) async fn account_resume(&self) {
        if self.account_config().await.is_none() {
            return;
        }
        self.account_load().await;
        if self.account_session().is_some() {
            self.account_schedule_refresh();
        }
    }

    pub async fn account_sign_in_start(
        &self,
        req: AccountSignInRequest,
    ) -> AppResult<AccountSignInStart> {
        let cfg = self.account_config().await.ok_or_else(not_configured)?;
        self.account_sign_in_cancel();
        let id = self.0.account.next_id.fetch_add(1, Ordering::SeqCst);
        match req.method {
            AccountSignInMethod::Browser => {
                let BrowserSignIn {
                    url,
                    state,
                    code_verifier,
                    callbacks,
                } = self
                    .0
                    .deps
                    .account
                    .start_browser(&cfg, req.email.as_deref())
                    .await?;
                // No loopback listener: the redirect is an app URL scheme,
                // delivered through `account_sign_in_callback`.
                let (callbacks, app_callbacks) = match callbacks {
                    Some(listener) => (listener, None),
                    None => {
                        let (tx, rx) = mpsc::channel(4);
                        let listener: Box<dyn CallbackListener> = Box::new(AppSchemeCallbacks(rx));
                        let app = AppCallbacks {
                            redirect: cfg.redirect_uri.clone(),
                            tx,
                        };
                        (listener, Some(app))
                    }
                };
                let cancel = CancellationToken::new();
                *self.0.account.pending.lock().expect("account lock") = Some(Pending::Browser {
                    id,
                    cancel: cancel.clone(),
                    outcome: None,
                    app_callbacks,
                });
                let core = self.clone();
                let attempt = BrowserAttempt {
                    id,
                    state,
                    code_verifier,
                    callbacks,
                    cancel,
                };
                tokio::spawn(async move { core.account_browser_flow(cfg, attempt).await });
                Ok(AccountSignInStart::Browser { url })
            }
            AccountSignInMethod::DeviceCode => {
                let d = self.0.deps.account.start_device(&cfg).await?;
                *self.0.account.pending.lock().expect("account lock") = Some(Pending::Device {
                    id,
                    device_code: d.device_code,
                    interval: d.interval,
                });
                Ok(AccountSignInStart::DeviceCode {
                    user_code: d.user_code,
                    verification_uri: d.verification_uri,
                    verification_uri_complete: d.verification_uri_complete,
                    expires_in: d.expires_in,
                    interval: d.interval,
                })
            }
        }
    }

    /// A sign-in redirect the OS handed to the app through its URL scheme
    /// (`theodore://callback?code=…&state=…`) instead of the loopback
    /// listener. Same `state` check and code exchange as a loopback
    /// callback, and it settles the outcome `account_sign_in_poll` reports.
    /// `Ignored` when no browser sign-in is waiting on this redirect, or the
    /// `state` isn't this sign-in's (it then keeps waiting).
    pub async fn account_sign_in_callback(&self, url: &str) -> CallbackPage {
        let found = {
            let pending = self.0.account.pending.lock().expect("account lock");
            match pending.as_ref() {
                Some(Pending::Browser {
                    outcome: None,
                    app_callbacks: Some(app),
                    ..
                }) => app_callback_params(url, &app.redirect).map(|p| (p, app.tx.clone())),
                _ => None,
            }
        };
        let Some((params, tx)) = found else {
            return CallbackPage::Ignored;
        };
        let (reply, page) = oneshot::channel();
        if tx.send(IncomingCallback { params, reply }).await.is_err() {
            return CallbackPage::Ignored;
        }
        page.await.unwrap_or(CallbackPage::Ignored)
    }

    async fn account_browser_flow(&self, cfg: AccountConfig, attempt: BrowserAttempt) {
        let BrowserAttempt {
            id,
            state,
            code_verifier,
            mut callbacks,
            cancel,
        } = attempt;
        let deadline = tokio::time::sleep(BROWSER_TIMEOUT);
        tokio::pin!(deadline);
        let outcome = loop {
            let incoming = tokio::select! {
                _ = cancel.cancelled() => return,
                _ = self.0.shutdown.cancelled() => return,
                _ = &mut deadline => break AccountSignInState::Expired,
                r = callbacks.next() => r,
            };
            let incoming = match incoming {
                Ok(i) => i,
                Err(e) => {
                    break AccountSignInState::Failed {
                        message: e.to_string(),
                    };
                }
            };
            match check_callback(&incoming.params, &state) {
                CallbackCheck::Ignore => {
                    let _ = incoming.reply.send(CallbackPage::Ignored);
                }
                CallbackCheck::Denied(message) => {
                    let _ = incoming.reply.send(CallbackPage::Failed { message });
                    break AccountSignInState::Denied;
                }
                CallbackCheck::Error(message) => {
                    let _ = incoming.reply.send(CallbackPage::Failed {
                        message: message.clone(),
                    });
                    break AccountSignInState::Failed { message };
                }
                CallbackCheck::Code(code) => {
                    let exchanged = self
                        .0
                        .deps
                        .account
                        .exchange_code(&cfg, &code, &code_verifier)
                        .await
                        .map_err(AppError::from);
                    let result = match exchanged {
                        Ok(_) if cancel.is_cancelled() => return,
                        Ok(session) => self.account_signed_in(session).await,
                        Err(e) => Err(e),
                    };
                    match result {
                        Ok(status) => {
                            let email = status.user.as_ref().map(|u| u.email.clone());
                            let _ = incoming.reply.send(CallbackPage::SignedIn {
                                email: email.unwrap_or_default(),
                            });
                            break AccountSignInState::Done { status };
                        }
                        Err(e) => {
                            let message = e.to_string();
                            let _ = incoming.reply.send(CallbackPage::Failed {
                                message: message.clone(),
                            });
                            break AccountSignInState::Failed { message };
                        }
                    }
                }
            }
        };
        let mut pending = self.0.account.pending.lock().expect("account lock");
        if let Some(Pending::Browser {
            id: current,
            outcome: slot,
            ..
        }) = pending.as_mut()
            && *current == id
        {
            *slot = Some(outcome);
        }
    }

    /// Stores a fresh session, starts its refresher, tells the UI.
    async fn account_signed_in(&self, session: AccountSession) -> AppResult<AccountStatus> {
        self.account_load().await;
        self.account_persist(Some(&session)).await?;
        self.0.account.generation.fetch_add(1, Ordering::SeqCst);
        *self.0.account.session.lock().expect("account lock") = Some(session);
        self.0.account.session_ended.store(false, Ordering::SeqCst);
        self.account_gate().await;
        self.account_schedule_refresh();
        let status = self.account_status_now();
        self.emit(Ephemeral::AccountStatus {
            status: status.clone(),
        });
        // No account id, email or name: the event only says it happened.
        tracing::info!("signed in to the Theodore account");
        theodore_telemetry::product(theodore_telemetry::ProductEvent::SignedIn);
        Ok(status)
    }

    /// The outcome of the sign-in `account_sign_in_start` began: the
    /// browser flow's result once its redirect arrived, or one device-code
    /// poll.
    pub async fn account_sign_in_poll(&self) -> AppResult<AccountSignInState> {
        enum Next {
            Browser(Option<AccountSignInState>),
            Device(u64, String, u32),
        }
        let next = {
            let mut pending = self.0.account.pending.lock().expect("account lock");
            match pending.as_ref() {
                None => return Err(AppError::Invalid("no sign-in in progress".into())),
                Some(Pending::Browser { outcome: None, .. }) => Next::Browser(None),
                Some(Pending::Browser { .. }) => match pending.take() {
                    Some(Pending::Browser { outcome, .. }) => Next::Browser(outcome),
                    _ => unreachable!("checked above"),
                },
                Some(Pending::Device {
                    id,
                    device_code,
                    interval,
                }) => Next::Device(*id, device_code.clone(), *interval),
            }
        };
        let (id, device_code, interval) = match next {
            Next::Browser(outcome) => return Ok(outcome.unwrap_or(AccountSignInState::Pending)),
            Next::Device(id, code, interval) => (id, code, interval),
        };
        let cfg = self.account_config().await.ok_or_else(not_configured)?;
        let polled = self
            .0
            .deps
            .account
            .poll_device(&cfg, &device_code, interval)
            .await?;
        let finish = |core: &Core| {
            let mut pending = core.0.account.pending.lock().expect("account lock");
            if matches!(pending.as_ref(), Some(Pending::Device { id: current, .. }) if *current == id)
            {
                *pending = None;
            }
        };
        match polled {
            DeviceSignInPoll::Pending => Ok(AccountSignInState::Pending),
            DeviceSignInPoll::SlowDown { interval: next } => {
                if let Some(Pending::Device {
                    id: current,
                    interval,
                    ..
                }) = self
                    .0
                    .account
                    .pending
                    .lock()
                    .expect("account lock")
                    .as_mut()
                    && *current == id
                {
                    *interval = next;
                }
                Ok(AccountSignInState::SlowDown { interval: next })
            }
            DeviceSignInPoll::Denied => {
                finish(self);
                Ok(AccountSignInState::Denied)
            }
            DeviceSignInPoll::Expired => {
                finish(self);
                Ok(AccountSignInState::Expired)
            }
            DeviceSignInPoll::Done(session) => {
                finish(self);
                let status = self.account_signed_in(*session).await?;
                Ok(AccountSignInState::Done { status })
            }
        }
    }

    /// Drops the sign-in in progress, if any (frees the loopback port; an
    /// app URL scheme redirect arriving later is ignored).
    pub fn account_sign_in_cancel(&self) {
        let pending = self.0.account.pending.lock().expect("account lock").take();
        if let Some(Pending::Browser { cancel, .. }) = pending {
            cancel.cancel();
        }
    }

    /// Forgets the session locally (keychain included) and ends it at the
    /// provider in the background, best effort. Only the session goes: the
    /// store, projects, drafts and worktrees stay, for the next sign-in.
    pub async fn account_sign_out(&self) -> AppResult<AccountStatus> {
        self.account_sign_in_cancel();
        self.account_load().await;
        self.0.account.session_ended.store(false, Ordering::SeqCst);
        let old = self.account_forget().await?;
        if let (Some(old), Some(cfg)) = (old, self.account_config().await) {
            let port = self.0.deps.account.clone();
            tokio::spawn(async move {
                let _ = port.sign_out(&cfg, &old).await;
            });
        }
        let status = if self.account_config().await.is_some() {
            self.account_status_now()
        } else {
            unavailable()
        };
        self.emit(Ephemeral::AccountStatus {
            status: status.clone(),
        });
        Ok(status)
    }

    /// Clears the session in memory and in the keychain; returns it.
    async fn account_forget(&self) -> AppResult<Option<AccountSession>> {
        if let Some(t) = self
            .0
            .account
            .refresher
            .lock()
            .expect("account lock")
            .take()
        {
            t.cancel();
        }
        self.0.account.generation.fetch_add(1, Ordering::SeqCst);
        let old = self.0.account.session.lock().expect("account lock").take();
        let persisted = self.account_persist(None).await;
        self.account_gate().await;
        persisted?;
        Ok(old)
    }

    /// A valid access token for Theodore's own services, refreshed first
    /// when it's about to expire. `None` when signed out.
    pub async fn account_access_token(&self) -> AppResult<Option<String>> {
        if self.account_config().await.is_none() {
            return Ok(None);
        }
        self.account_load().await;
        let Some(session) = self.account_session() else {
            return Ok(None);
        };
        if session.expires_at - REFRESH_SKEW_MS > self.0.deps.clock.now() {
            return Ok(Some(session.access_token));
        }
        Ok(self.account_refresh_now().await?.map(|s| s.access_token))
    }

    /// Rotates the session unless another caller just did. A rejected
    /// refresh token means the session is over: signed out, UI told, the
    /// gate closes. Any other failure (offline, a 5xx) keeps the session:
    /// the app stays usable and the refresher retries. `Ok(None)` when
    /// there's no session (anymore).
    pub(crate) async fn account_refresh_now(&self) -> AppResult<Option<AccountSession>> {
        let _one_at_a_time = self.0.account.refresh_lock.lock().await;
        let generation = self.0.account.generation.load(Ordering::SeqCst);
        let Some(current) = self.account_session() else {
            return Ok(None);
        };
        if current.expires_at - REFRESH_SKEW_MS > self.0.deps.clock.now() {
            return Ok(Some(current));
        }
        let cfg = self.account_config().await.ok_or_else(not_configured)?;
        match self
            .0
            .deps
            .account
            .refresh(&cfg, &current.refresh_token)
            .await
        {
            Ok(next) => {
                if self.0.account.generation.load(Ordering::SeqCst) != generation {
                    return Ok(self.account_session());
                }
                self.account_persist(Some(&next)).await?;
                let changed = user_of(&next) != user_of(&current);
                *self.0.account.session.lock().expect("account lock") = Some(next.clone());
                if changed {
                    self.emit(Ephemeral::AccountStatus {
                        status: self.account_status_now(),
                    });
                }
                Ok(Some(next))
            }
            Err(e @ (AccountError::Rejected(_) | AccountError::InvalidToken(_))) => {
                tracing::warn!(
                    error.code = "account.refresh_rejected",
                    error = %e,
                    "the account session couldn't be refreshed; signed out"
                );
                if self.0.account.generation.load(Ordering::SeqCst) == generation {
                    self.0.account.session_ended.store(true, Ordering::SeqCst);
                    self.account_forget().await?;
                    self.emit(Ephemeral::AccountStatus {
                        status: self.account_status_now(),
                    });
                }
                Err(e.into())
            }
            Err(e) => {
                tracing::warn!(error.code = e.code(), error = %e, "account refresh failed");
                Err(e.into())
            }
        }
    }

    /// One refresher per session: sleeps until shortly before `exp`,
    /// refreshes, repeats; backs off on network errors; stops on sign-out.
    fn account_schedule_refresh(&self) {
        let token = CancellationToken::new();
        if let Some(old) = self
            .0
            .account
            .refresher
            .lock()
            .expect("account lock")
            .replace(token.clone())
        {
            old.cancel();
        }
        let core = self.clone();
        tokio::spawn(async move {
            loop {
                let Some(session) = core.account_session() else {
                    return;
                };
                let wait = (session.expires_at - REFRESH_SKEW_MS - core.0.deps.clock.now())
                    .max(MIN_REFRESH_WAIT_MS);
                tokio::select! {
                    _ = token.cancelled() => return,
                    _ = core.0.shutdown.cancelled() => return,
                    _ = tokio::time::sleep(Duration::from_millis(wait as u64)) => {}
                }
                match core.account_refresh_now().await {
                    Ok(Some(_)) => {}
                    Ok(None) => return,
                    Err(AppError::Account(AccountError::Rejected(_)))
                    | Err(AppError::Account(AccountError::InvalidToken(_))) => return,
                    Err(_) => tokio::select! {
                        _ = token.cancelled() => return,
                        _ = core.0.shutdown.cancelled() => return,
                        _ = tokio::time::sleep(RETRY_AFTER) => {}
                    },
                }
            }
        });
    }
}
