//! Theodore account (plan "Theodore account"): `account_status`,
//! `account_sign_in_start` / `_poll` / `_cancel`, `account_sign_out`. An
//! optional identity with Theodore itself, separate from the host tokens;
//! the provider protocol lives behind `AccountPort`.
//!
//! ```text
//! browser  start ─▶ port binds loopback, builds URL ─▶ UI opens it
//!            └─ task: callback ─▶ state check ─▶ exchange ─▶ keychain ─▶ emit
//! device   start ─▶ user_code ─▶ UI polls ─▶ exchange ─▶ keychain ─▶ emit
//! session  refresher wakes 60 s before `exp` ─▶ rotate ─▶ keychain
//!            └─ rejected ─▶ signed out ─▶ emit
//! ```

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use theodore_contract::{
    AccountSignInMethod, AccountSignInRequest, AccountSignInStart, AccountSignInState,
    AccountStatus, AccountUser, Ephemeral,
};
use theodore_ports::{
    AccountConfig, AccountError, AccountSession, BrowserSignIn, CallbackPage, CallbackParams,
    DeviceSignInPoll,
};
use tokio_util::sync::CancellationToken;

use crate::core::Core;
use crate::error::{AppError, AppResult};

/// Checked before the settings: lets a packaged build or a developer
/// configure the account without touching the store. Theodore never ships
/// a client id; the owner creates the WorkOS application.
pub const CLIENT_ID_ENV: &str = "THEODORE_WORKOS_CLIENT_ID";
pub const CLIENT_ID_SETTING: &str = "account.workos.client_id";
pub const REDIRECT_ENV: &str = "THEODORE_WORKOS_REDIRECT_URI";
pub const REDIRECT_SETTING: &str = "account.workos.redirect_uri";
/// Must be registered as a redirect URI on the WorkOS application.
pub const DEFAULT_REDIRECT_URI: &str = "http://127.0.0.1:47823/callback";

/// Refresh this long before the access token's `exp`.
pub(crate) const REFRESH_SKEW_MS: i64 = 60_000;
const MIN_REFRESH_WAIT_MS: i64 = 5_000;
const RETRY_AFTER: Duration = Duration::from_secs(30);
/// A browser sign-in nobody finishes stops listening after this.
const BROWSER_TIMEOUT: Duration = Duration::from_secs(10 * 60);

enum Pending {
    Browser {
        id: u64,
        cancel: CancellationToken,
        outcome: Option<AccountSignInState>,
    },
    Device {
        id: u64,
        device_code: String,
        interval: u32,
    },
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
        user: None,
    }
}

fn not_configured() -> AppError {
    AppError::Invalid("Theodore accounts aren't configured (no WorkOS client id)".into())
}

impl Core {
    /// `THEODORE_WORKOS_*` env, else the `account.workos.*` settings. `None`
    /// hides the feature: no provider in this mode, or no client id.
    pub(crate) async fn account_config(&self) -> Option<AccountConfig> {
        if !self.0.deps.account.enabled() {
            return None;
        }
        let client_id = self
            .env_or_setting(CLIENT_ID_ENV, CLIENT_ID_SETTING)
            .await?;
        let redirect_uri = self
            .env_or_setting(REDIRECT_ENV, REDIRECT_SETTING)
            .await
            .unwrap_or_else(|| DEFAULT_REDIRECT_URI.to_string());
        Some(AccountConfig {
            client_id,
            redirect_uri,
        })
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
        if self.account_config().await.is_none() {
            return Ok(unavailable());
        }
        self.account_load().await;
        Ok(self.account_status_now())
    }

    fn account_status_now(&self) -> AccountStatus {
        AccountStatus {
            available: true,
            user: self.account_session().as_ref().map(user_of),
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
                let sign_in = self
                    .0
                    .deps
                    .account
                    .start_browser(&cfg, req.email.as_deref())
                    .await?;
                let cancel = CancellationToken::new();
                *self.0.account.pending.lock().expect("account lock") = Some(Pending::Browser {
                    id,
                    cancel: cancel.clone(),
                    outcome: None,
                });
                let url = sign_in.url.clone();
                let core = self.clone();
                tokio::spawn(
                    async move { core.account_browser_flow(cfg, id, sign_in, cancel).await },
                );
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

    async fn account_browser_flow(
        &self,
        cfg: AccountConfig,
        id: u64,
        mut sign_in: BrowserSignIn,
        cancel: CancellationToken,
    ) {
        let deadline = tokio::time::sleep(BROWSER_TIMEOUT);
        tokio::pin!(deadline);
        let outcome = loop {
            let incoming = tokio::select! {
                _ = cancel.cancelled() => return,
                _ = self.0.shutdown.cancelled() => return,
                _ = &mut deadline => break AccountSignInState::Expired,
                r = sign_in.callbacks.next() => r,
            };
            let incoming = match incoming {
                Ok(i) => i,
                Err(e) => {
                    break AccountSignInState::Failed {
                        message: e.to_string(),
                    };
                }
            };
            match check_callback(&incoming.params, &sign_in.state) {
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
                        .exchange_code(&cfg, &code, &sign_in.code_verifier)
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
        self.account_schedule_refresh();
        let status = self.account_status_now();
        self.emit(Ephemeral::AccountStatus {
            status: status.clone(),
        });
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

    /// Drops the sign-in in progress, if any (frees the loopback port).
    pub fn account_sign_in_cancel(&self) {
        let pending = self.0.account.pending.lock().expect("account lock").take();
        if let Some(Pending::Browser { cancel, .. }) = pending {
            cancel.cancel();
        }
    }

    /// Forgets the session locally (keychain included) and ends it at the
    /// provider in the background, best effort.
    pub async fn account_sign_out(&self) -> AppResult<AccountStatus> {
        self.account_sign_in_cancel();
        self.account_load().await;
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
        self.account_persist(None).await?;
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
    /// refresh token means the session is over: signed out, UI told.
    /// `Ok(None)` when there's no session (anymore).
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
                if self.0.account.generation.load(Ordering::SeqCst) == generation {
                    self.account_forget().await?;
                    self.emit(Ephemeral::AccountStatus {
                        status: self.account_status_now(),
                    });
                }
                Err(e.into())
            }
            Err(e) => Err(e.into()),
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
