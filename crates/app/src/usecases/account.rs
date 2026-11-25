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
//!        the active account has a session     ─▶ SignedIn      ─┘
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
//! session  refresher (one per account) wakes 60 s before `exp` ─▶ rotate ─▶ keychain
//!            └─ rejected ─▶ that account needs a sign-in again ─▶ emit
//! ```
//!
//! Several accounts (docs/cloud.md "Several accounts"): every sign-in adds
//! a session (or replaces that user's), one keychain entry each
//! (`theodore.account.<user id>`), and the store's index (`account.accounts`)
//! says which exist and which is active. Everything account-scoped — the
//! gate, the access token, the fleet link, telemetry's identity — follows
//! the active one; the others keep their sessions fresh in the background.
//!
//! ```text
//! sign-in ─▶ slot (new, or the user's replaced) ─▶ active ─▶ emit
//! switch(user, org?) ─▶ active = user ─▶ [refresh(Some(org))] ─▶ emit
//! sign out of user ─▶ slot gone ─▶ active: the next with a session
//! refresh rejected ─▶ slot kept, session gone ("Sign in again")
//!                     ─▶ active: the next with a session, else the gate closes
//! upgrade ─▶ the one `theodore.account` entry becomes the first slot
//! ```
//!
//! Organizations (plan §6.12 "Organizations", docs/cloud.md "App side"),
//! only with a Theodore cloud configured:
//!
//! ```text
//! signed in, no org ─▶ background: cloud ensure personal ─▶ refresh(Some(org))
//!   (sign-in, start)     ─▶ keychain ─▶ emit; any failure: warn, session kept
//! sign-in ─▶ OrganizationSelectionRequired ─▶ Pending::Organization (memory)
//!   ─▶ poll: ChooseOrganization ─▶ account_sign_in_choose_organization(id)
//!   ─▶ cloud select ─▶ signed in
//! switch ─▶ refresh(Some(id)) ─▶ keychain ─▶ emit; an error leaves the session
//! ```
//!
//! Only the background refresher (`refresh(.., None)`) ever ends a session.
//! No cloud error and no org-scoped refresh does.

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use theodore_contract::{
    AccountEntry, AccountOrganization, AccountOrganizationChoice, AccountOrganizationRef,
    AccountSignInMethod, AccountSignInRequest, AccountSignInStart, AccountSignInState,
    AccountStatus, AccountSwitchRequest, AccountUser, Ephemeral,
};
use theodore_ports::{
    AccountConfig, AccountError, AccountProfile, AccountResult, AccountSession, BrowserSignIn,
    CallbackListener, CallbackPage, CallbackParams, DeviceSignInPoll, IncomingCallback,
    OrganizationSelection,
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
/// The Theodore cloud (docs/cloud.md): env, else setting, else the build's
/// own (`Deps::account_cloud_url`). None anywhere: no organizations.
pub const CLOUD_URL_ENV: &str = "THEODORE_CLOUD_URL";
pub const CLOUD_URL_SETTING: &str = "account.cloud_url";
/// The store's kv key of the accounts index: which users have a session in
/// the keychain, their profiles for display, and the active one.
pub const ACCOUNTS_INDEX_KEY: &str = "account.accounts";

/// Refresh this long before the access token's `exp`.
pub(crate) const REFRESH_SKEW_MS: i64 = 60_000;
const MIN_REFRESH_WAIT_MS: i64 = 5_000;
/// A refresh that failed without ending the session (offline, a 5xx) is
/// retried after this, doubling with every failure in a row up to
/// `RETRY_MAX`.
const RETRY_AFTER: Duration = Duration::from_secs(30);
const RETRY_MAX: Duration = Duration::from_secs(10 * 60);

/// How long the refresher waits after `failures` failed refreshes in a row.
pub(crate) fn refresh_retry_delay(failures: u32) -> Duration {
    let doublings = failures.saturating_sub(1).min(16);
    RETRY_AFTER.saturating_mul(1 << doublings).min(RETRY_MAX)
}

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

/// `raw` as a usable cloud URL, without a trailing `/`: `https://`, or
/// `http://` on `127.0.0.1` / `localhost` (`wrangler dev`). No credentials
/// in it. `None` for anything else.
pub fn valid_cloud_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    let url = Url::parse(trimmed).ok()?;
    let host = url.host_str()?;
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let ok = match url.scheme() {
        "https" => !host.is_empty(),
        "http" => host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost"),
        _ => false,
    };
    ok.then(|| trimmed.to_string())
}

/// The cloud URL: the first of env, setting, built-in that is set and
/// valid. A set but invalid one is skipped and handed to `invalid` (for a
/// warning). Blank values don't count.
pub fn resolve_cloud_url(
    env: Option<&str>,
    setting: Option<&str>,
    built_in: Option<&str>,
    mut invalid: impl FnMut(&str),
) -> Option<String> {
    for raw in [env, setting, built_in]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        match valid_cloud_url(raw) {
            Some(url) => return Some(url),
            None => invalid(raw),
        }
    }
    None
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
    /// Either method ended in `OrganizationSelectionRequired`: waits for
    /// `account_sign_in_choose_organization`. The pending token lives only
    /// here, in memory, never in the keychain or a log.
    Organization { selection: OrganizationSelection },
}

fn choices(selection: &OrganizationSelection) -> AccountSignInState {
    AccountSignInState::ChooseOrganization {
        organizations: selection
            .organizations
            .iter()
            .map(|o| AccountOrganizationChoice {
                id: o.id.clone(),
                name: o.name.clone(),
            })
            .collect(),
    }
}

/// The session's organization for the status, if it has one.
pub(crate) fn organization_of(s: &AccountSession) -> Option<AccountOrganizationRef> {
    s.organization_id.as_ref().map(|id| AccountOrganizationRef {
        id: id.clone(),
        role: s.role.clone(),
    })
}

fn to_contract_org(o: theodore_ports::AccountOrganization) -> AccountOrganization {
    AccountOrganization {
        id: o.id,
        name: o.name,
        role: o.role,
        personal: o.personal,
    }
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
/// stored sessions, so no host call slips out before that.
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

/// One account signed in on this computer.
pub(crate) struct Slot {
    /// `None`: the provider ended the session (a rejected refresh), so the
    /// row says "Sign in again"; the profile stays for display.
    pub session: Option<AccountSession>,
    pub profile: AccountProfile,
    /// The organization the session is (or last was) in.
    pub organization_id: Option<String>,
    /// Bumped whenever this slot's session is replaced wholesale (signed
    /// in again) or dropped, so a refresh that raced that never writes a
    /// stale session back (plan §6.12 "Races").
    pub generation: u64,
    /// Refresh tokens are single-use: one refresh of this session at a
    /// time. Per account: one account's refresh never waits on another's.
    pub refresh_lock: Arc<tokio::sync::Mutex<()>>,
    pub refresher: Option<CancellationToken>,
    /// Refreshes failed in a row without ending the session: paces the
    /// refresher's retries, and only the first one is a warning.
    pub refresh_failures: Arc<AtomicU32>,
    /// Its organizations as the cloud last listed them.
    pub organizations: Vec<AccountOrganization>,
}

impl Slot {
    fn new(profile: AccountProfile, session: Option<AccountSession>, generation: u64) -> Self {
        let organization_id = session.as_ref().and_then(|s| s.organization_id.clone());
        Slot {
            session,
            profile,
            organization_id,
            generation,
            refresh_lock: Arc::new(tokio::sync::Mutex::new(())),
            refresher: None,
            refresh_failures: Arc::new(AtomicU32::new(0)),
            organizations: Vec::new(),
        }
    }

    fn user(&self) -> AccountUser {
        profile_user(&self.profile)
    }

    fn entry(&self, active: bool) -> AccountEntry {
        AccountEntry {
            user: self.user(),
            organization: match &self.session {
                Some(s) => organization_of(s),
                None => self
                    .organization_id
                    .as_ref()
                    .map(|id| AccountOrganizationRef {
                        id: id.clone(),
                        role: None,
                    }),
            },
            organizations: self.organizations.clone(),
            active,
            sign_in_required: self.session.is_none(),
        }
    }

    fn stop_refresher(&mut self) {
        if let Some(t) = self.refresher.take() {
            t.cancel();
        }
    }

    fn view(&self) -> Option<SlotView> {
        Some(SlotView {
            session: self.session.clone()?,
            generation: self.generation,
            refresh_lock: self.refresh_lock.clone(),
            refresh_failures: self.refresh_failures.clone(),
        })
    }
}

/// Every account, in sign-in order, and the active one.
#[derive(Default)]
pub(crate) struct Accounts {
    pub slots: Vec<Slot>,
    pub active: Option<String>,
}

impl Accounts {
    fn slot(&self, user_id: &str) -> Option<&Slot> {
        self.slots.iter().find(|s| s.profile.id == user_id)
    }

    fn slot_mut(&mut self, user_id: &str) -> Option<&mut Slot> {
        self.slots.iter_mut().find(|s| s.profile.id == user_id)
    }

    fn active_slot(&self) -> Option<&Slot> {
        self.active.as_deref().and_then(|id| self.slot(id))
    }

    /// The active account's session, if it has one.
    fn active_session(&self) -> Option<&AccountSession> {
        self.active_slot().and_then(|s| s.session.as_ref())
    }

    /// Makes the first account with a session active (sign-in order), when
    /// the active one has none. `true` when that changed the active one.
    fn settle_active(&mut self) -> bool {
        if self.active_session().is_some() {
            return false;
        }
        let next = self
            .slots
            .iter()
            .find(|s| s.session.is_some())
            .map(|s| s.profile.id.clone());
        if next == self.active {
            return false;
        }
        self.active = next;
        true
    }

    fn index(&self) -> Index {
        Index {
            active: self.active.clone(),
            accounts: self
                .slots
                .iter()
                .map(|s| IndexEntry {
                    user: s.profile.clone(),
                    organization_id: s.organization_id.clone(),
                    ended: s.session.is_none(),
                })
                .collect(),
        }
    }
}

/// The stored index (`ACCOUNTS_INDEX_KEY`): display data and bookkeeping
/// only, never a token.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Index {
    #[serde(default)]
    active: Option<String>,
    #[serde(default)]
    accounts: Vec<IndexEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct IndexEntry {
    user: AccountProfile,
    #[serde(default)]
    organization_id: Option<String>,
    /// The provider ended its session: no keychain entry, "Sign in again".
    #[serde(default)]
    ended: bool,
}

/// A snapshot of one slot for a refresh: what it needs outside the lock.
#[derive(Clone)]
struct SlotView {
    session: AccountSession,
    generation: u64,
    refresh_lock: Arc<tokio::sync::Mutex<()>>,
    refresh_failures: Arc<AtomicU32>,
}

/// In-memory account state, one per `Core`.
#[derive(Default)]
pub(crate) struct AccountState {
    loaded: tokio::sync::OnceCell<()>,
    accounts: std::sync::Mutex<Accounts>,
    pending: std::sync::Mutex<Option<Pending>>,
    /// Bumped on every sign-in, sign-out and switch (account or
    /// organization): the fleet keys its fatal mark by it.
    generation: AtomicU64,
    /// Source of `Slot::generation`s, unique across slots.
    slot_generations: AtomicU64,
    /// Held around every "check a slot's generation, write keychain +
    /// memory + index": a sign-out can't land between a refresh's check
    /// and its write.
    write_lock: tokio::sync::Mutex<()>,
    /// The last invalid cloud URL warned about, so it's said once.
    cloud_url_warned: std::sync::Mutex<Option<String>>,
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
    /// The provider ended the active session and no other account could
    /// take over (a rejected refresh); cleared by the next sign-in or
    /// sign-out.
    session_ended: std::sync::atomic::AtomicBool,
    /// Every identity handed to telemetry, in order (tests).
    #[cfg(test)]
    pub(crate) identity_log: std::sync::Mutex<Vec<Option<String>>>,
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

    fn next_slot_generation(&self) -> u64 {
        self.slot_generations.fetch_add(1, Ordering::SeqCst) + 1
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

fn profile_user(p: &AccountProfile) -> AccountUser {
    let name = [p.first_name.as_deref(), p.last_name.as_deref()]
        .into_iter()
        .flatten()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    AccountUser {
        id: p.id.clone(),
        email: p.email.clone(),
        name: (!name.is_empty()).then_some(name),
        avatar_url: p.avatar_url.clone(),
    }
}

pub(crate) fn user_of(s: &AccountSession) -> AccountUser {
    profile_user(&s.user)
}

fn unavailable() -> AccountStatus {
    AccountStatus {
        available: false,
        required: false,
        user: None,
        session_ended: false,
        organization: None,
        accounts: Vec::new(),
    }
}

fn not_configured() -> AppError {
    AppError::Invalid("Theodore accounts aren't configured (no WorkOS client id)".into())
}

fn no_such_account() -> AppError {
    AppError::Invalid("no such account is signed in here".into())
}

/// What `account_load` found in the keychain and the store.
struct Loaded {
    index: Index,
    sessions: Vec<Option<AccountSession>>,
}

/// Reads the index and every session it names; with no index yet, moves
/// the single pre-multi-account entry (`theodore.account`) into its own
/// entry and writes the index: the existing session becomes the first
/// account, silently.
fn load_blocking(
    store: &dyn theodore_ports::Store,
    secrets: &dyn theodore_ports::Secrets,
) -> Loaded {
    let index = store
        .kv_get(ACCOUNTS_INDEX_KEY)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value::<Index>(v).ok());
    let parse =
        |raw: Option<String>| raw.and_then(|s| serde_json::from_str::<AccountSession>(&s).ok());
    match index {
        Some(index) => {
            let sessions = index
                .accounts
                .iter()
                .map(|e| {
                    if e.ended {
                        None
                    } else {
                        parse(
                            secrets
                                .get(&theodore_secrets::account_key(&e.user.id))
                                .ok()
                                .flatten(),
                        )
                    }
                })
                .collect();
            Loaded { index, sessions }
        }
        None => {
            let legacy = parse(
                secrets
                    .get(theodore_secrets::THEODORE_ACCOUNT)
                    .ok()
                    .flatten(),
            );
            let Some(session) = legacy else {
                return Loaded {
                    index: Index::default(),
                    sessions: Vec::new(),
                };
            };
            let key = theodore_secrets::account_key(&session.user.id);
            match serde_json::to_string(&session) {
                Ok(json) => match secrets.set(&key, &json) {
                    Ok(()) => {
                        let _ = secrets.delete(theodore_secrets::THEODORE_ACCOUNT);
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "couldn't move the account session to its own entry")
                    }
                },
                Err(e) => tracing::warn!(error = %e, "couldn't encode the account session"),
            }
            let index = Index {
                active: Some(session.user.id.clone()),
                accounts: vec![IndexEntry {
                    user: session.user.clone(),
                    organization_id: session.organization_id.clone(),
                    ended: false,
                }],
            };
            if let Ok(v) = serde_json::to_value(&index)
                && let Err(e) = store.kv_set(ACCOUNTS_INDEX_KEY, &v)
            {
                tracing::warn!(error = %e, "couldn't write the accounts index");
            }
            tracing::info!("the account session is now the first of the accounts list");
            Loaded {
                index,
                sessions: vec![Some(session)],
            }
        }
    }
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
        let cloud_url = self.account_cloud_url().await;
        Some(AccountConfig {
            client_id,
            redirect_uri,
            cloud_url,
        })
    }

    /// `resolve_cloud_url` over `THEODORE_CLOUD_URL`, `account.cloud_url`
    /// and the build's own; an invalid one is warned about once.
    pub(crate) async fn account_cloud_url(&self) -> Option<String> {
        let env = std::env::var(CLOUD_URL_ENV).ok();
        let setting = self.setting_string(CLOUD_URL_SETTING, "").await;
        resolve_cloud_url(
            env.as_deref(),
            Some(&setting),
            self.0.deps.account_cloud_url.as_deref(),
            |raw| {
                let mut warned = self
                    .0
                    .account
                    .cloud_url_warned
                    .lock()
                    .expect("account lock");
                if warned.as_deref() != Some(raw) {
                    tracing::warn!(
                        error.code = "account.config",
                        "ignored the Theodore cloud URL {raw:?}: it must be https://, or http:// on 127.0.0.1 or localhost"
                    );
                    *warned = Some(raw.to_string());
                }
            },
        )
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
        let a = self.accounts();
        let session = a.active_session();
        AccountStatus {
            available: true,
            required: true,
            user: session.map(user_of),
            session_ended: self.0.account.session_ended.load(Ordering::SeqCst),
            organization: session.and_then(organization_of),
            accounts: a
                .slots
                .iter()
                .map(|s| s.entry(a.active.as_deref() == Some(s.profile.id.as_str())))
                .collect(),
        }
    }

    fn emit_account_status(&self) {
        self.emit(Ephemeral::AccountStatus {
            status: self.account_status_now(),
        });
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
            // Registered (enabled) before the check, so a sign-in in between
            // still wakes it: `notify_waiters` skips a `Notified` that was
            // never polled.
            let changed = self.0.account.gate_changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
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

    fn accounts(&self) -> std::sync::MutexGuard<'_, Accounts> {
        self.0.account.accounts.lock().expect("account lock")
    }

    /// The active account's session, if it has one.
    pub(crate) fn account_session(&self) -> Option<AccountSession> {
        self.accounts().active_session().cloned()
    }

    /// The active account's user id (`Space::account`). `None` signed
    /// out, or without an account provider.
    pub(crate) fn account_active_user_id(&self) -> Option<String> {
        let a = self.accounts();
        a.active_session().map(|s| s.user.id.clone())
    }

    fn slot_view(&self, user_id: &str) -> Option<SlotView> {
        self.accounts().slot(user_id)?.view()
    }

    /// Bumped on every sign-in, sign-out and switch (the fleet restarts its
    /// link on a change).
    pub(crate) fn account_generation(&self) -> u64 {
        self.0.account.generation.load(Ordering::SeqCst)
    }

    /// Tells telemetry who is signed in (docs/telemetry.md "Who a record
    /// is from"): the active account, or nobody.
    fn account_identity(&self, user_id: Option<&str>) {
        #[cfg(test)]
        self.0
            .account
            .identity_log
            .lock()
            .expect("account lock")
            .push(user_id.map(str::to_string));
        theodore_telemetry::set_account(user_id);
    }

    /// Reads the stored sessions once per process.
    async fn account_load(&self) {
        self.0
            .account
            .loaded
            .get_or_init(|| async {
                let secrets = self.0.deps.secrets.clone();
                let store = self.0.deps.store.clone();
                let loaded = tokio::task::spawn_blocking(move || load_blocking(&*store, &*secrets))
                    .await
                    .ok();
                let Some(loaded) = loaded else {
                    return;
                };
                let active = {
                    let mut a = self.accounts();
                    for (entry, session) in loaded.index.accounts.into_iter().zip(loaded.sessions) {
                        if a.slot(&entry.user.id).is_some() {
                            continue;
                        }
                        let generation = self.0.account.next_slot_generation();
                        let mut slot = Slot::new(entry.user, session, generation);
                        if slot.organization_id.is_none() {
                            slot.organization_id = entry.organization_id;
                        }
                        a.slots.push(slot);
                    }
                    a.active = loaded.index.active;
                    a.settle_active();
                    a.active_session().map(|s| s.user.id.clone())
                };
                self.account_identity(active.as_deref());
            })
            .await;
    }

    /// Writes one account's session to the keychain (or deletes it).
    async fn account_persist(
        &self,
        user_id: &str,
        session: Option<&AccountSession>,
    ) -> AppResult<()> {
        let secrets = self.0.deps.secrets.clone();
        let key = theodore_secrets::account_key(user_id);
        let json = session
            .map(serde_json::to_string)
            .transpose()
            .map_err(|e| AppError::Invalid(format!("encode account session: {e}")))?;
        tokio::task::spawn_blocking(move || match json {
            Some(j) => secrets.set(&key, &j),
            None => secrets.delete(&key),
        })
        .await
        .map_err(AppError::join)?
        .map_err(|e| AppError::Invalid(e.to_string()))
    }

    /// Writes the index as the accounts are now.
    async fn account_persist_index(&self) -> AppResult<()> {
        let index = self.accounts().index();
        let value = serde_json::to_value(&index)
            .map_err(|e| AppError::Invalid(format!("encode accounts index: {e}")))?;
        let store = self.0.deps.store.clone();
        tokio::task::spawn_blocking(move || store.kv_set(ACCOUNTS_INDEX_KEY, &value))
            .await
            .map_err(AppError::join)?
            .map_err(|e| AppError::Invalid(e.to_string()))
    }

    /// Spawned by `Core::start`: loads the stored sessions and keeps every
    /// one fresh, so none lapses while the app runs. A session still
    /// without an organization (the org step failed last time, or it's
    /// from before organizations) gets another go.
    pub(crate) async fn account_resume(&self) {
        if self.account_config().await.is_none() {
            return;
        }
        self.account_load().await;
        // The fleet may have looked before the stored sessions were loaded
        // and found nobody signed in: look again now that they are.
        self.fleet_account_changed();
        let slots: Vec<(String, u64)> = self
            .accounts()
            .slots
            .iter()
            .filter(|s| s.session.is_some())
            .map(|s| (s.profile.id.clone(), s.generation))
            .collect();
        for (user_id, generation) in slots {
            self.account_schedule_refresh(&user_id);
            let core = self.clone();
            tokio::spawn(async move { core.account_org_step(&user_id, generation).await });
        }
    }

    /// Best effort: puts `user_id`'s session without an organization into
    /// the user's personal one (cloud `ensure`, then an org-scoped
    /// refresh), then lists its organizations. Needs a cloud. Never signs
    /// out: any failure is a warning, the session stays as it is, and the
    /// next start tries again. Dropped when the slot was signed in again
    /// or removed since `since`.
    pub(crate) async fn account_org_step(&self, user_id: &str, since: u64) {
        let Some(cfg) = self.account_config().await else {
            return;
        };
        if cfg.cloud_url.is_none() {
            return;
        }
        let Some(view) = self.slot_view(user_id) else {
            return;
        };
        if view.session.organization_id.is_none() {
            match self.account_join_personal(&cfg, user_id, since).await {
                Ok(Some(org)) => {
                    tracing::info!(organization = %org, "the account session is in its personal organization");
                }
                Ok(None) => return,
                Err(e) => {
                    tracing::warn!(
                        error.code = e.code(),
                        error = %e,
                        "couldn't put the account in its personal organization; trying again at the next start"
                    );
                    return;
                }
            }
        }
        if self.account_organizations_for(user_id).await.is_ok() {
            self.emit_account_status();
        }
    }

    async fn account_join_personal(
        &self,
        cfg: &AccountConfig,
        user_id: &str,
        since: u64,
    ) -> AppResult<Option<String>> {
        // A plain token read: refreshes (without an org) only when it's
        // about to expire, like any other caller.
        let Some(token) = self.account_access_token_for(user_id).await? else {
            return Ok(None);
        };
        if self
            .slot_view(user_id)
            .is_none_or(|v| v.generation != since)
        {
            return Ok(None);
        }
        let org = self
            .0
            .deps
            .account
            .ensure_personal_organization(cfg, &token)
            .await?;
        Ok(self
            .account_refresh_in_org(cfg, user_id, &org, since)
            .await?
            .map(|_| org))
    }

    /// Refreshes `user_id`'s session into `organization_id` and stores it,
    /// under that account's refresh lock (refresh tokens are single-use).
    /// An error leaves the session exactly as it was: never signs out.
    /// `Ok(None)`: no session, or the slot changed since `since`; the
    /// result is dropped.
    async fn account_refresh_in_org(
        &self,
        cfg: &AccountConfig,
        user_id: &str,
        organization_id: &str,
        since: u64,
    ) -> AppResult<Option<AccountSession>> {
        let Some(view) = self.slot_view(user_id) else {
            return Ok(None);
        };
        let _one_at_a_time = view.refresh_lock.lock().await;
        // Read under the lock: a refresh just before may have rotated it.
        let Some(current) = self.slot_view(user_id) else {
            return Ok(None);
        };
        if current.generation != since {
            return Ok(None);
        }
        let next = self
            .0
            .deps
            .account
            .refresh(cfg, &current.session.refresh_token, Some(organization_id))
            .await?;
        if !self.account_commit(user_id, since, &next).await? {
            return Ok(None);
        }
        self.emit_account_status();
        Ok(Some(next))
    }

    /// Stores `next` as `user_id`'s session (keychain, then memory, then
    /// the index) unless that slot was signed in again or removed since
    /// `since`. `false`: dropped.
    async fn account_commit(
        &self,
        user_id: &str,
        since: u64,
        next: &AccountSession,
    ) -> AppResult<bool> {
        let _write = self.0.account.write_lock.lock().await;
        if self
            .accounts()
            .slot(user_id)
            .is_none_or(|s| s.generation != since)
        {
            return Ok(false);
        }
        self.account_persist(user_id, Some(next)).await?;
        let (active, token_changed, org_changed) = {
            let mut a = self.accounts();
            let active = a.active.as_deref() == Some(user_id);
            let Some(slot) = a.slot_mut(user_id) else {
                return Ok(false);
            };
            let previous = slot.session.replace(next.clone());
            let token_changed = previous
                .as_ref()
                .is_none_or(|p| p.access_token != next.access_token);
            let org_changed = slot.organization_id != next.organization_id;
            slot.organization_id = next.organization_id.clone();
            (active, token_changed, org_changed)
        };
        if org_changed {
            self.account_persist_index().await?;
        }
        if active {
            if org_changed {
                self.0.account.generation.fetch_add(1, Ordering::SeqCst);
            }
            // A new access token: a fleet link that failed for good (a
            // token the cloud refused, or a cloud that judged a JWKS
            // outage fatal) gets one more try with it (docs/fleet.md "App
            // side").
            if token_changed {
                self.fleet().fatal_at = None;
            }
            // A fresh token (reauth) or another organization (a new link).
            self.fleet_account_changed();
        }
        Ok(true)
    }

    /// Moves the active account's session to another of its organizations
    /// (an org-scoped refresh). On any error the session is untouched and
    /// still signed in; the error is returned.
    pub async fn account_switch_organization(
        &self,
        organization_id: &str,
    ) -> AppResult<AccountStatus> {
        self.account_config().await.ok_or_else(not_configured)?;
        self.account_load().await;
        let user_id = self
            .account_active_user_id()
            .ok_or(AppError::AccountRequired)?;
        self.account_switch(AccountSwitchRequest {
            user_id,
            organization_id: Some(organization_id.to_string()),
        })
        .await
    }

    /// Makes `user_id` the active account — the one the gate, the fleet,
    /// the views and telemetry follow — and, with an `organization_id`,
    /// moves its session there (an org-scoped refresh). A failed
    /// organization switch returns its error with the account switched
    /// and its session untouched. An account that needs a sign-in again
    /// can't be switched to.
    pub async fn account_switch(&self, req: AccountSwitchRequest) -> AppResult<AccountStatus> {
        let cfg = self.account_config().await.ok_or_else(not_configured)?;
        self.account_load().await;
        let user_id = req.user_id.trim();
        let view = {
            let a = self.accounts();
            let slot = a.slot(user_id).ok_or_else(no_such_account)?;
            slot.view().ok_or_else(|| {
                AppError::Invalid("that account's session ended: sign in to it again".into())
            })?
        };
        let switched = {
            let _write = self.0.account.write_lock.lock().await;
            let mut a = self.accounts();
            if a.active.as_deref() == Some(user_id) {
                false
            } else {
                a.active = Some(user_id.to_string());
                self.0.account.generation.fetch_add(1, Ordering::SeqCst);
                true
            }
        };
        if switched {
            self.0.account.session_ended.store(false, Ordering::SeqCst);
            self.account_persist_index().await?;
            self.account_identity(Some(user_id));
            self.fleet_account_changed();
            self.account_gate().await;
            tracing::info!("switched the active Theodore account");
            self.emit_account_status();
        }
        let organization_id = req
            .organization_id
            .as_deref()
            .map(str::trim)
            .filter(|o| !o.is_empty());
        if let Some(org) = organization_id
            && view.session.organization_id.as_deref() != Some(org)
        {
            match self
                .account_refresh_in_org(&cfg, user_id, org, view.generation)
                .await
            {
                Ok(Some(_)) => {}
                Ok(None) => {
                    return Err(AppError::Invalid(
                        "the account changed while switching organizations".into(),
                    ));
                }
                Err(e) => {
                    tracing::warn!(error.code = e.code(), error = %e, "couldn't switch organization");
                    return Err(e);
                }
            }
        }
        Ok(self.account_status_now())
    }

    /// The active account's organizations, from the cloud.
    pub async fn account_organizations(&self) -> AppResult<Vec<AccountOrganization>> {
        self.account_config().await.ok_or_else(not_configured)?;
        self.account_load().await;
        let user_id = self
            .account_active_user_id()
            .ok_or(AppError::AccountRequired)?;
        self.account_organizations_for(&user_id).await
    }

    /// `user_id`'s organizations from the cloud, with its own token; the
    /// list is kept on its slot for `AccountStatus::accounts`.
    async fn account_organizations_for(
        &self,
        user_id: &str,
    ) -> AppResult<Vec<AccountOrganization>> {
        let cfg = self.account_config().await.ok_or_else(not_configured)?;
        let token = self
            .account_access_token_for(user_id)
            .await?
            .ok_or(AppError::AccountRequired)?;
        let orgs: Vec<AccountOrganization> = self
            .0
            .deps
            .account
            .organizations(&cfg, &token)
            .await?
            .into_iter()
            .map(to_contract_org)
            .collect();
        if let Some(slot) = self.accounts().slot_mut(user_id) {
            slot.organizations = orgs.clone();
        }
        Ok(orgs)
    }

    /// Every account signed in here, with its organizations listed again
    /// from the cloud (each with its own token; one that fails keeps its
    /// last list). The status, as `account_status`.
    pub async fn account_accounts(&self) -> AppResult<AccountStatus> {
        if self.account_config().await.is_none() {
            return Ok(unavailable());
        }
        self.account_load().await;
        let users: Vec<String> = self
            .accounts()
            .slots
            .iter()
            .filter(|s| s.session.is_some())
            .map(|s| s.profile.id.clone())
            .collect();
        // Each with its own token, side by side: one account's slow or
        // hung refresh doesn't hold up another's list. One that fails
        // keeps its last list.
        let mut lists = tokio::task::JoinSet::new();
        for user_id in users {
            let core = self.clone();
            lists.spawn(async move { core.account_organizations_for(&user_id).await });
        }
        while lists.join_next().await.is_some() {}
        Ok(self.account_status_now())
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
        let mut selection = None;
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
                        .await;
                    let result = match exchanged {
                        Ok(_) | Err(AccountError::OrganizationSelectionRequired(_))
                            if cancel.is_cancelled() =>
                        {
                            return;
                        }
                        Ok(session) => self.account_signed_in(session).await,
                        Err(AccountError::OrganizationSelectionRequired(s)) => {
                            let _ = incoming.reply.send(CallbackPage::ChooseOrganization);
                            let outcome = choices(&s);
                            selection = Some(s);
                            break outcome;
                        }
                        Err(e) => Err(e.into()),
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
            match selection {
                Some(selection) => *pending = Some(Pending::Organization { selection }),
                None => *slot = Some(outcome),
            }
        }
    }

    /// Stores a fresh session as its user's account (a new one, or that
    /// user's signed in again), makes it the active one, starts its
    /// refresher, tells the UI. Without an organization, the org step
    /// follows in the background.
    async fn account_signed_in(&self, session: AccountSession) -> AppResult<AccountStatus> {
        self.account_load().await;
        let user_id = session.user.id.clone();
        let generation = {
            let _write = self.0.account.write_lock.lock().await;
            self.account_persist(&user_id, Some(&session)).await?;
            let generation = self.0.account.next_slot_generation();
            {
                let mut a = self.accounts();
                match a.slot_mut(&user_id) {
                    Some(slot) => {
                        slot.stop_refresher();
                        slot.profile = session.user.clone();
                        slot.organization_id = session.organization_id.clone();
                        slot.session = Some(session);
                        slot.generation = generation;
                        slot.refresh_failures.store(0, Ordering::SeqCst);
                    }
                    None => {
                        a.slots
                            .push(Slot::new(session.user.clone(), Some(session), generation))
                    }
                }
                a.active = Some(user_id.clone());
            }
            self.0.account.generation.fetch_add(1, Ordering::SeqCst);
            self.account_persist_index().await?;
            self.account_identity(Some(&user_id));
            generation
        };
        self.fleet_account_changed();
        let core = self.clone();
        let step_user = user_id.clone();
        tokio::spawn(async move { core.account_org_step(&step_user, generation).await });
        self.0.account.session_ended.store(false, Ordering::SeqCst);
        self.account_gate().await;
        self.account_schedule_refresh(&user_id);
        let status = self.account_status_now();
        self.emit(Ephemeral::AccountStatus {
            status: status.clone(),
        });
        // No email or name; the sinks add the account's id on their own.
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
                // Reported until an organization is chosen or it's cancelled.
                Some(Pending::Organization { selection }) => return Ok(choices(selection)),
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
        let polled = match self
            .0
            .deps
            .account
            .poll_device(&cfg, &device_code, interval)
            .await
        {
            Ok(polled) => polled,
            Err(AccountError::OrganizationSelectionRequired(selection)) => {
                let state = choices(&selection);
                let mut pending = self.0.account.pending.lock().expect("account lock");
                if matches!(pending.as_ref(), Some(Pending::Device { id: current, .. }) if *current == id)
                {
                    *pending = Some(Pending::Organization { selection });
                    return Ok(state);
                }
                // Cancelled or replaced meanwhile.
                return Ok(AccountSignInState::Failed {
                    message: "this sign-in was cancelled".into(),
                });
            }
            Err(e) => return Err(e.into()),
        };
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

    /// Finishes a sign-in that reported `ChooseOrganization`, in
    /// `organization_id` (one of the offered ones). The pending token is
    /// single-use: whatever the outcome, this sign-in is then over.
    pub async fn account_sign_in_choose_organization(
        &self,
        organization_id: &str,
    ) -> AppResult<AccountSignInState> {
        let cfg = self.account_config().await.ok_or_else(not_configured)?;
        let selection = {
            let mut pending = self.0.account.pending.lock().expect("account lock");
            match pending.as_ref() {
                Some(Pending::Organization { selection })
                    if selection
                        .organizations
                        .iter()
                        .any(|o| o.id == organization_id) => {}
                Some(Pending::Organization { .. }) => {
                    return Err(AppError::Invalid(
                        "that organization isn't one this sign-in offered".into(),
                    ));
                }
                _ => {
                    return Err(AppError::Invalid(
                        "no sign-in is waiting for an organization".into(),
                    ));
                }
            }
            match pending.take() {
                Some(Pending::Organization { selection }) => selection,
                _ => unreachable!("checked above"),
            }
        };
        let selected = self
            .0
            .deps
            .account
            .select_organization(
                &cfg,
                &selection.pending_authentication_token,
                organization_id,
            )
            .await
            .map_err(AppError::from);
        // The session must be the one chosen: the cloud hands it over, so
        // a session in any other organization is refused, never stored.
        let signed_in = match selected {
            Ok(session) if session.organization_id.as_deref() == Some(organization_id) => {
                self.account_signed_in(session).await
            }
            Ok(_) => Err(AppError::Invalid(
                "the sign-in came back in another organization than the one chosen".into(),
            )),
            Err(e) => Err(e),
        };
        Ok(match signed_in {
            Ok(status) => AccountSignInState::Done { status },
            Err(e) => {
                tracing::warn!(error.code = e.code(), error = %e, "the organization sign-in failed");
                AccountSignInState::Failed {
                    message: e.to_string(),
                }
            }
        })
    }

    /// Drops the sign-in in progress, if any (frees the loopback port; an
    /// app URL scheme redirect arriving later is ignored; a pending
    /// organization choice is forgotten).
    pub fn account_sign_in_cancel(&self) {
        let pending = self.0.account.pending.lock().expect("account lock").take();
        if let Some(Pending::Browser { cancel, .. }) = pending {
            cancel.cancel();
        }
    }

    /// Signs out of the active account (`account_sign_out_of`); the next
    /// account with a session becomes active. Signed out of every account
    /// already: nothing changes.
    pub async fn account_sign_out(&self) -> AppResult<AccountStatus> {
        self.account_load().await;
        let active = self.accounts().active.clone();
        match active {
            Some(user_id) => self.account_sign_out_of(&user_id).await,
            None => {
                self.account_sign_in_cancel();
                self.0.account.session_ended.store(false, Ordering::SeqCst);
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
        }
    }

    /// Forgets `user_id`'s account locally (keychain included) and ends
    /// its session at the provider in the background, best effort. Was it
    /// the active one, the next account with a session takes over; with
    /// none left the gate closes. Only the session goes: the store,
    /// projects, drafts and worktrees stay, for the next sign-in.
    pub async fn account_sign_out_of(&self, user_id: &str) -> AppResult<AccountStatus> {
        self.account_sign_in_cancel();
        self.account_load().await;
        self.0.account.session_ended.store(false, Ordering::SeqCst);
        let old = self.account_forget(user_id.trim()).await?;
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

    /// Removes `user_id`'s slot, in memory and in the keychain; returns its
    /// session (if it still had one). An unknown user: nothing to do.
    async fn account_forget(&self, user_id: &str) -> AppResult<Option<AccountSession>> {
        let (old, was_active, next) = {
            let _write = self.0.account.write_lock.lock().await;
            let (old, was_active, next) = {
                let mut a = self.accounts();
                let Some(at) = a.slots.iter().position(|s| s.profile.id == user_id) else {
                    return Ok(None);
                };
                let mut slot = a.slots.remove(at);
                slot.stop_refresher();
                let was_active = a.active.as_deref() == Some(user_id);
                if was_active {
                    a.active = None;
                    a.settle_active();
                }
                (slot.session.take(), was_active, a.active.clone())
            };
            self.0.account.generation.fetch_add(1, Ordering::SeqCst);
            let persisted = self.account_persist(user_id, None).await;
            let indexed = self.account_persist_index().await;
            persisted?;
            indexed?;
            (old, was_active, next)
        };
        if was_active {
            self.account_identity(next.as_deref());
            self.fleet_account_changed();
        }
        tracing::info!(
            switched = next.is_some(),
            "signed out of a Theodore account"
        );
        self.account_gate().await;
        Ok(old)
    }

    /// The provider ended `user_id`'s session (a rejected refresh): the
    /// slot stays, without a session, so its row says "Sign in again".
    /// Was it the active one, the next account with a session takes over;
    /// with none, the gate closes and the sign-in screen says why.
    async fn account_session_ended(&self, user_id: &str, since: u64) -> AppResult<()> {
        let (was_active, next) = {
            let _write = self.0.account.write_lock.lock().await;
            let (was_active, next) = {
                let mut a = self.accounts();
                let Some(slot) = a.slot_mut(user_id) else {
                    return Ok(());
                };
                if slot.generation != since {
                    return Ok(());
                }
                slot.stop_refresher();
                slot.session = None;
                slot.generation = self.0.account.next_slot_generation();
                let was_active = a.active.as_deref() == Some(user_id);
                if was_active {
                    a.settle_active();
                }
                (was_active, a.active_session().map(|s| s.user.id.clone()))
            };
            let persisted = self.account_persist(user_id, None).await;
            let indexed = self.account_persist_index().await;
            persisted?;
            indexed?;
            (was_active, next)
        };
        if was_active {
            self.0.account.generation.fetch_add(1, Ordering::SeqCst);
            if next.is_none() {
                self.0.account.session_ended.store(true, Ordering::SeqCst);
            }
            self.account_identity(next.as_deref());
            self.fleet_account_changed();
            self.account_gate().await;
        }
        Ok(())
    }

    /// A valid access token for Theodore's own services, of the active
    /// account, refreshed first when it's about to expire. `None` when
    /// signed out.
    pub async fn account_access_token(&self) -> AppResult<Option<String>> {
        if self.account_config().await.is_none() {
            return Ok(None);
        }
        self.account_load().await;
        let Some(user_id) = self.account_active_user_id() else {
            return Ok(None);
        };
        self.account_access_token_for(&user_id).await
    }

    /// `account_access_token` for one account.
    async fn account_access_token_for(&self, user_id: &str) -> AppResult<Option<String>> {
        let Some(view) = self.slot_view(user_id) else {
            return Ok(None);
        };
        if view.session.expires_at - REFRESH_SKEW_MS > self.0.deps.clock.now() {
            return Ok(Some(view.session.access_token));
        }
        Ok(self
            .account_refresh_slot(user_id)
            .await?
            .map(|s| s.access_token))
    }

    /// Rotates `user_id`'s session unless another caller just did. A
    /// rejected refresh token means the session is over: that account
    /// needs a sign-in again (`account_session_ended`), the UI is told.
    /// Any other failure (offline, a 5xx) keeps the session: the app stays
    /// usable and the refresher retries. `Ok(None)` when there's no
    /// session (anymore).
    async fn account_refresh_slot(&self, user_id: &str) -> AppResult<Option<AccountSession>> {
        let Some(view) = self.slot_view(user_id) else {
            return Ok(None);
        };
        let _one_at_a_time = view.refresh_lock.lock().await;
        // Read under the lock: a refresh just before may have rotated it.
        let Some(view) = self.slot_view(user_id) else {
            return Ok(None);
        };
        let current = view.session;
        if current.expires_at - REFRESH_SKEW_MS > self.0.deps.clock.now() {
            return Ok(Some(current));
        }
        let cfg = self.account_config().await.ok_or_else(not_configured)?;
        match self
            .0
            .deps
            .account
            // No organization: the provider keeps the session's current
            // one. Asking for a specific org belongs to an explicit switch,
            // whose rejection must not end the session.
            .refresh(&cfg, &current.refresh_token, None)
            .await
        {
            Ok(next) => {
                view.refresh_failures.store(0, Ordering::SeqCst);
                if !self.account_commit(user_id, view.generation, &next).await? {
                    return Ok(self.slot_view(user_id).map(|v| v.session));
                }
                let changed = user_of(&next) != user_of(&current)
                    || organization_of(&next) != organization_of(&current);
                if changed {
                    self.emit_account_status();
                }
                Ok(Some(next))
            }
            Err(e @ (AccountError::Rejected(_) | AccountError::InvalidToken(_))) => {
                view.refresh_failures.store(0, Ordering::SeqCst);
                tracing::warn!(
                    error.code = "account.refresh_rejected",
                    error = %e,
                    "the account session couldn't be refreshed; it needs a sign-in again"
                );
                self.account_session_ended(user_id, view.generation).await?;
                self.emit_account_status();
                Err(e.into())
            }
            Err(e) => {
                // Offline, this repeats until the network is back: one
                // warning when it starts, then quiet.
                let failures = view.refresh_failures.fetch_add(1, Ordering::SeqCst) + 1;
                if failures == 1 {
                    tracing::warn!(error.code = e.code(), error = %e, "account refresh failed");
                } else {
                    tracing::debug!(
                        error.code = e.code(),
                        error = %e,
                        failures,
                        "account refresh still failing"
                    );
                }
                Err(e.into())
            }
        }
    }

    /// The active account's refreshes failed in a row (tests).
    #[cfg(test)]
    pub(crate) fn account_refresh_failures(&self) -> u32 {
        self.accounts()
            .active_slot()
            .map_or(0, |s| s.refresh_failures.load(Ordering::SeqCst))
    }

    /// One refresher per account: sleeps until shortly before its `exp`,
    /// refreshes, repeats; backs off on network errors; stops when the
    /// account is signed out or its session ended.
    fn account_schedule_refresh(&self, user_id: &str) {
        let token = CancellationToken::new();
        {
            let mut a = self.accounts();
            let Some(slot) = a.slot_mut(user_id) else {
                return;
            };
            if let Some(old) = slot.refresher.replace(token.clone()) {
                old.cancel();
            }
        }
        let core = self.clone();
        let user_id = user_id.to_string();
        tokio::spawn(async move {
            loop {
                let Some(view) = core.slot_view(&user_id) else {
                    return;
                };
                let wait = (view.session.expires_at - REFRESH_SKEW_MS - core.0.deps.clock.now())
                    .max(MIN_REFRESH_WAIT_MS);
                tokio::select! {
                    _ = token.cancelled() => return,
                    _ = core.0.shutdown.cancelled() => return,
                    _ = tokio::time::sleep(Duration::from_millis(wait as u64)) => {}
                }
                match core.account_refresh_slot(&user_id).await {
                    Ok(Some(_)) => {}
                    Ok(None) => return,
                    Err(AppError::Account(AccountError::Rejected(_)))
                    | Err(AppError::Account(AccountError::InvalidToken(_))) => return,
                    Err(_) => {
                        let failures = view.refresh_failures.load(Ordering::SeqCst);
                        tokio::select! {
                            _ = token.cancelled() => return,
                            _ = core.0.shutdown.cancelled() => return,
                            _ = tokio::time::sleep(refresh_retry_delay(failures)) => {}
                        }
                    }
                }
            }
        });
    }
}
