//! Theodore account use cases against `Core` + `testkit::FakeAccount`:
//! configuration, the browser and device-code sign-ins, the CSRF `state`
//! check, sign-out, and refresh.

use std::time::Duration;

use pretty_assertions::assert_eq;
use serde_json::json;
use theodore_contract::{
    AccountSignInMethod, AccountSignInRequest, AccountSignInStart, AccountSignInState,
    AccountStatus, Ephemeral, MutationOp, Setting, Transaction, TransactionResult, models,
};
use theodore_ports::{
    AccountError, AccountSession, CallbackPage, CallbackParams, Clock, DeviceSignInPoll, Secrets,
};

use crate::testkit::{FAKE_ACCOUNT_STATE, Fixtures, fixtures, sample_account_session};
use crate::usecases::account::{
    CLIENT_ID_ENV, CallbackCheck, DEFAULT_REDIRECT_URI, REDIRECT_ENV, app_callback_params,
    check_callback, choose_redirect,
};
use crate::{AppError, Core, Receivers};

/// A production bundle's redirect (the shell derives it per build,
/// `theodore_runtime::identity::app_redirect_uri`).
const APP_REDIRECT_URI: &str = "theodore://callback";

async fn set_setting(core: &Core, key: &str, value: &str) {
    let setting = Setting {
        key: key.into(),
        scope: "user".into(),
        value: json!(value),
    };
    let tx = Transaction {
        id: format!("set-{key}"),
        ops: vec![MutationOp::Create {
            model: models::SETTING.into(),
            id: setting.key.clone(),
            data: serde_json::to_value(&setting).unwrap(),
        }],
    };
    assert!(matches!(
        core.transact(tx).await,
        TransactionResult::Ok { .. }
    ));
}

async fn configured(f: &Fixtures) -> (Core, Receivers) {
    let (core, recv) = Core::start(f.deps());
    set_setting(&core, "account.workos.client_id", "client_01TEST").await;
    (core, recv)
}

fn stored(f: &Fixtures) -> Option<AccountSession> {
    f.secrets
        .get(theodore_secrets::THEODORE_ACCOUNT)
        .unwrap()
        .map(|s| serde_json::from_str(&s).unwrap())
}

fn store_session(f: &Fixtures, s: &AccountSession) {
    f.secrets
        .set(
            theodore_secrets::THEODORE_ACCOUNT,
            &serde_json::to_string(s).unwrap(),
        )
        .unwrap();
}

fn fresh(f: &Fixtures, refresh: &str) -> AccountSession {
    sample_account_session(refresh, f.clock.now() + 300_000)
}

fn browser(email: Option<&str>) -> AccountSignInRequest {
    AccountSignInRequest {
        method: AccountSignInMethod::Browser,
        email: email.map(Into::into),
    }
}

fn device() -> AccountSignInRequest {
    AccountSignInRequest {
        method: AccountSignInMethod::DeviceCode,
        email: None,
    }
}

fn params(code: Option<&str>, state: Option<&str>) -> CallbackParams {
    CallbackParams {
        code: code.map(Into::into),
        state: state.map(Into::into),
        ..Default::default()
    }
}

async fn poll_until_done(core: &Core) -> AccountSignInState {
    for _ in 0..200 {
        match core.account_sign_in_poll().await.unwrap() {
            AccountSignInState::Pending => tokio::time::sleep(Duration::from_millis(5)).await,
            other => return other,
        }
    }
    panic!("sign-in never finished");
}

async fn expect_account_event(recv: &mut Receivers) -> AccountStatus {
    for _ in 0..200 {
        if let Ok(Ok(Ephemeral::AccountStatus { status })) =
            tokio::time::timeout(Duration::from_millis(50), recv.ephemeral.recv()).await
        {
            return status;
        }
    }
    panic!("no account_status event");
}

// ── callback check (CSRF) ─────────────────────────────────────────────────

#[test]
fn the_callback_must_carry_this_sign_ins_state() {
    assert_eq!(
        check_callback(&params(Some("c"), Some("s")), "s"),
        CallbackCheck::Code("c".into())
    );
    assert_eq!(
        check_callback(&params(Some("c"), Some("other")), "s"),
        CallbackCheck::Ignore
    );
    assert_eq!(
        check_callback(&params(Some("c"), None), "s"),
        CallbackCheck::Ignore
    );
    // An empty expected state never matches anything.
    assert_eq!(
        check_callback(&params(Some("c"), Some("")), ""),
        CallbackCheck::Ignore
    );
}

#[test]
fn provider_errors_count_only_with_the_right_state() {
    let denied = CallbackParams {
        error: Some("access_denied".into()),
        state: Some("s".into()),
        ..Default::default()
    };
    assert!(matches!(
        check_callback(&denied, "s"),
        CallbackCheck::Denied(_)
    ));
    assert_eq!(check_callback(&denied, "t"), CallbackCheck::Ignore);

    let other = CallbackParams {
        error: Some("server_error".into()),
        error_description: Some("boom".into()),
        state: Some("s".into()),
        ..Default::default()
    };
    assert_eq!(
        check_callback(&other, "s"),
        CallbackCheck::Error("server_error: boom".into())
    );
    assert!(matches!(
        check_callback(&params(None, Some("s")), "s"),
        CallbackCheck::Error(_)
    ));
}

// ── configuration ────────────────────────────────────────────────────────

#[tokio::test]
async fn no_client_id_hides_the_feature() {
    if std::env::var(CLIENT_ID_ENV).is_ok() {
        return; // configured from the environment on this machine
    }
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());
    let status = core.account_status().await.unwrap();
    assert!(!status.available);
    assert!(matches!(
        core.account_sign_in_start(browser(None)).await,
        Err(AppError::Invalid(_))
    ));
}

#[tokio::test]
async fn a_disabled_provider_hides_the_feature_even_with_a_client_id() {
    let f = fixtures();
    f.account.set_enabled(false);
    let (core, _recv) = configured(&f).await;
    assert!(!core.account_status().await.unwrap().available);
}

#[tokio::test]
async fn signed_out_until_a_session_exists() {
    let f = fixtures();
    let (core, _recv) = configured(&f).await;
    let status = core.account_status().await.unwrap();
    assert_eq!(
        status,
        AccountStatus {
            available: true,
            required: true,
            user: None,
            session_ended: false,
        }
    );
}

#[tokio::test]
async fn a_stored_session_is_signed_in() {
    let f = fixtures();
    store_session(&f, &fresh(&f, "rt"));
    let (core, _recv) = configured(&f).await;
    let user = core.account_status().await.unwrap().user.unwrap();
    assert_eq!(user.email, "ada@example.com");
    assert_eq!(user.name.as_deref(), Some("Ada Lovelace"));
    assert_eq!(
        user.avatar_url.as_deref(),
        Some("https://img.example/ada.png")
    );
}

#[tokio::test]
async fn the_redirect_uri_setting_reaches_the_provider() {
    let f = fixtures();
    let (core, _recv) = configured(&f).await;
    if std::env::var(crate::usecases::account::REDIRECT_ENV).is_ok() {
        return;
    }
    let url = match core.account_sign_in_start(browser(None)).await.unwrap() {
        AccountSignInStart::Browser { url } => url,
        other => panic!("{other:?}"),
    };
    assert!(url.contains(crate::usecases::account::DEFAULT_REDIRECT_URI));
    set_setting(
        &core,
        "account.workos.redirect_uri",
        "http://127.0.0.1:5555/cb",
    )
    .await;
    let url = match core.account_sign_in_start(browser(None)).await.unwrap() {
        AccountSignInStart::Browser { url } => url,
        other => panic!("{other:?}"),
    };
    assert!(url.contains("http://127.0.0.1:5555/cb"));
}

// ── browser sign-in ──────────────────────────────────────────────────────

#[tokio::test]
async fn browser_sign_in_completes_through_the_callback() {
    let f = fixtures();
    let (core, mut recv) = configured(&f).await;
    f.account.push_exchange(Ok(fresh(&f, "rt_1")));

    let start = core
        .account_sign_in_start(browser(Some("ada@example.com")))
        .await
        .unwrap();
    assert!(matches!(start, AccountSignInStart::Browser { .. }));
    assert_eq!(
        core.account_sign_in_poll().await.unwrap(),
        AccountSignInState::Pending
    );

    let page = f
        .account
        .callback(params(Some("code_1"), Some(FAKE_ACCOUNT_STATE)))
        .await;
    assert_eq!(
        page.await.unwrap(),
        CallbackPage::SignedIn {
            email: "ada@example.com".into()
        }
    );
    match poll_until_done(&core).await {
        AccountSignInState::Done { status } => {
            assert_eq!(status.user.unwrap().email, "ada@example.com")
        }
        other => panic!("expected Done, got {other:?}"),
    }
    assert_eq!(
        f.account.calls(),
        vec![
            "start_browser:ada@example.com".to_string(),
            "exchange:code_1:verifier-1".to_string(),
        ]
    );
    assert_eq!(stored(&f).unwrap().refresh_token, "rt_1");
    assert!(expect_account_event(&mut recv).await.user.is_some());
    assert!(core.account_status().await.unwrap().user.is_some());
    // The outcome is reported once; the sign-in is then over.
    assert!(core.account_sign_in_poll().await.is_err());
}

#[tokio::test]
async fn a_callback_with_the_wrong_state_is_ignored() {
    let f = fixtures();
    let (core, _recv) = configured(&f).await;
    f.account.push_exchange(Ok(fresh(&f, "rt_1")));
    core.account_sign_in_start(browser(None)).await.unwrap();

    let forged = f
        .account
        .callback(params(Some("attacker_code"), Some("forged")))
        .await;
    assert_eq!(forged.await.unwrap(), CallbackPage::Ignored);
    let missing = f
        .account
        .callback(params(Some("attacker_code"), None))
        .await;
    assert_eq!(missing.await.unwrap(), CallbackPage::Ignored);
    assert_eq!(
        core.account_sign_in_poll().await.unwrap(),
        AccountSignInState::Pending
    );
    assert!(stored(&f).is_none());
    assert!(
        !f.account.calls().iter().any(|c| c.starts_with("exchange")),
        "a forged callback must never reach the token exchange"
    );

    // The real redirect still completes the sign-in.
    let page = f
        .account
        .callback(params(Some("code_1"), Some(FAKE_ACCOUNT_STATE)))
        .await;
    assert!(matches!(page.await.unwrap(), CallbackPage::SignedIn { .. }));
    assert!(matches!(
        poll_until_done(&core).await,
        AccountSignInState::Done { .. }
    ));
}

#[tokio::test]
async fn a_denied_sign_in_reports_denied() {
    let f = fixtures();
    let (core, _recv) = configured(&f).await;
    core.account_sign_in_start(browser(None)).await.unwrap();
    let page = f
        .account
        .callback(CallbackParams {
            error: Some("access_denied".into()),
            state: Some(FAKE_ACCOUNT_STATE.into()),
            ..Default::default()
        })
        .await;
    assert!(matches!(page.await.unwrap(), CallbackPage::Failed { .. }));
    assert_eq!(poll_until_done(&core).await, AccountSignInState::Denied);
    assert!(stored(&f).is_none());
}

#[tokio::test]
async fn a_failed_exchange_reports_failed_and_stores_nothing() {
    let f = fixtures();
    let (core, _recv) = configured(&f).await;
    f.account
        .push_exchange(Err(AccountError::Rejected("invalid_grant: used".into())));
    core.account_sign_in_start(browser(None)).await.unwrap();
    let page = f
        .account
        .callback(params(Some("used"), Some(FAKE_ACCOUNT_STATE)))
        .await;
    assert!(matches!(page.await.unwrap(), CallbackPage::Failed { .. }));
    match poll_until_done(&core).await {
        AccountSignInState::Failed { message } => assert!(message.contains("invalid_grant")),
        other => panic!("expected Failed, got {other:?}"),
    }
    assert!(stored(&f).is_none());
    assert!(core.account_status().await.unwrap().user.is_none());
}

#[tokio::test]
async fn cancel_stops_listening() {
    let f = fixtures();
    let (core, _recv) = configured(&f).await;
    core.account_sign_in_start(browser(None)).await.unwrap();
    assert!(f.account.listening());
    core.account_sign_in_cancel();
    for _ in 0..200 {
        if !f.account.listening() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(!f.account.listening(), "the loopback listener is dropped");
    assert!(core.account_sign_in_poll().await.is_err());
}

#[tokio::test]
async fn starting_again_replaces_the_previous_sign_in() {
    let f = fixtures();
    let (core, _recv) = configured(&f).await;
    core.account_sign_in_start(browser(None)).await.unwrap();
    core.account_sign_in_start(device()).await.unwrap();
    assert_eq!(
        core.account_sign_in_poll().await.unwrap(),
        AccountSignInState::Pending
    );
    assert!(f.account.calls().iter().any(|c| c == "poll:dc-1:5"));
}

// ── app URL scheme redirect ──────────────────────────────────────────────

#[test]
fn the_redirect_is_configured_else_the_app_scheme_else_loopback() {
    assert_eq!(
        choose_redirect(
            Some("http://127.0.0.1:5555/cb".into()),
            Some(APP_REDIRECT_URI)
        ),
        "http://127.0.0.1:5555/cb"
    );
    assert_eq!(
        choose_redirect(None, Some(APP_REDIRECT_URI)),
        APP_REDIRECT_URI
    );
    assert_eq!(choose_redirect(None, None), DEFAULT_REDIRECT_URI);
}

#[test]
fn an_app_callback_must_be_the_redirect_itself() {
    let p = app_callback_params(
        "theodore://callback?code=c&state=s%2B1&extra=x",
        APP_REDIRECT_URI,
    )
    .unwrap();
    assert_eq!(p, params(Some("c"), Some("s+1")));
    assert!(app_callback_params("theodore://callback/?code=c", APP_REDIRECT_URI).is_some());
    for other in [
        "theodore://other?code=c&state=s",
        "theodore://callback/x?code=c&state=s",
        "evil://callback?code=c&state=s",
        "http://127.0.0.1:47823/callback?code=c&state=s",
        "not a url",
    ] {
        assert_eq!(
            app_callback_params(other, APP_REDIRECT_URI),
            None,
            "{other}"
        );
    }
}

fn app_url(query: &str) -> String {
    format!("{APP_REDIRECT_URI}?{query}")
}

/// A configured core whose shell receives `theodore://` (an app bundle).
/// `None` when this machine configures the redirect through the env.
async fn bundled(f: &Fixtures) -> Option<(Core, Receivers)> {
    if std::env::var(REDIRECT_ENV).is_ok() {
        return None;
    }
    let (core, recv) = configured(f).await;
    core.set_account_app_redirect(Some(APP_REDIRECT_URI));
    Some((core, recv))
}

#[tokio::test]
async fn a_bundled_app_signs_in_through_its_url_scheme_without_a_loopback() {
    let f = fixtures();
    let Some((core, mut recv)) = bundled(&f).await else {
        return;
    };
    f.account.push_exchange(Ok(fresh(&f, "rt_1")));
    let url = match core.account_sign_in_start(browser(None)).await.unwrap() {
        AccountSignInStart::Browser { url } => url,
        other => panic!("{other:?}"),
    };
    assert!(url.contains(&format!("redirect_uri={APP_REDIRECT_URI}")));
    assert!(
        !f.account.listening(),
        "no loopback listener for the app-scheme redirect"
    );
    assert_eq!(
        core.account_sign_in_poll().await.unwrap(),
        AccountSignInState::Pending
    );

    let page = core
        .account_sign_in_callback(&app_url(&format!("code=code_1&state={FAKE_ACCOUNT_STATE}")))
        .await;
    assert_eq!(
        page,
        CallbackPage::SignedIn {
            email: "ada@example.com".into()
        }
    );
    assert!(matches!(
        poll_until_done(&core).await,
        AccountSignInState::Done { .. }
    ));
    assert!(
        f.account
            .calls()
            .contains(&"exchange:code_1:verifier-1".to_string()),
        "the code is exchanged with this attempt's PKCE verifier"
    );
    assert_eq!(stored(&f).unwrap().refresh_token, "rt_1");
    assert!(expect_account_event(&mut recv).await.user.is_some());
    // Delivered again (a second "Open Theodore?"): the sign-in is over.
    let again = core
        .account_sign_in_callback(&app_url(&format!("code=code_1&state={FAKE_ACCOUNT_STATE}")))
        .await;
    assert_eq!(again, CallbackPage::Ignored);
}

#[tokio::test]
async fn an_app_callback_with_the_wrong_state_is_ignored_and_keeps_waiting() {
    let f = fixtures();
    let Some((core, _recv)) = bundled(&f).await else {
        return;
    };
    f.account.push_exchange(Ok(fresh(&f, "rt_1")));
    core.account_sign_in_start(browser(None)).await.unwrap();

    for forged in [
        app_url("code=attacker&state=forged"),
        app_url("code=attacker"),
        format!("theodore://elsewhere?code=attacker&state={FAKE_ACCOUNT_STATE}"),
    ] {
        assert_eq!(
            core.account_sign_in_callback(&forged).await,
            CallbackPage::Ignored,
            "{forged}"
        );
    }
    assert_eq!(
        core.account_sign_in_poll().await.unwrap(),
        AccountSignInState::Pending
    );
    assert!(
        !f.account.calls().iter().any(|c| c.starts_with("exchange")),
        "a forged callback must never reach the token exchange"
    );

    let page = core
        .account_sign_in_callback(&app_url(&format!("code=code_1&state={FAKE_ACCOUNT_STATE}")))
        .await;
    assert!(matches!(page, CallbackPage::SignedIn { .. }));
    assert!(matches!(
        poll_until_done(&core).await,
        AccountSignInState::Done { .. }
    ));
}

#[tokio::test]
async fn an_app_callback_with_no_sign_in_waiting_is_ignored() {
    let f = fixtures();
    let Some((core, _recv)) = bundled(&f).await else {
        return;
    };
    f.account.push_exchange(Ok(fresh(&f, "rt_1")));
    let good = app_url(&format!("code=code_1&state={FAKE_ACCOUNT_STATE}"));

    // Nothing started (e.g. the app was launched by the link itself).
    assert_eq!(
        core.account_sign_in_callback(&good).await,
        CallbackPage::Ignored
    );
    // A device-code sign-in doesn't take redirects.
    core.account_sign_in_start(device()).await.unwrap();
    assert_eq!(
        core.account_sign_in_callback(&good).await,
        CallbackPage::Ignored
    );
    // Cancelled.
    core.account_sign_in_start(browser(None)).await.unwrap();
    core.account_sign_in_cancel();
    assert_eq!(
        core.account_sign_in_callback(&good).await,
        CallbackPage::Ignored
    );
    // A loopback sign-in only listens on its port.
    core.set_account_app_redirect(None);
    core.account_sign_in_start(browser(None)).await.unwrap();
    assert!(f.account.listening());
    assert_eq!(
        core.account_sign_in_callback(&good).await,
        CallbackPage::Ignored
    );
    assert!(!f.account.calls().iter().any(|c| c.starts_with("exchange")));
    assert!(stored(&f).is_none());
}

#[tokio::test]
async fn an_app_callback_carrying_an_error_ends_the_sign_in() {
    let f = fixtures();
    let Some((core, _recv)) = bundled(&f).await else {
        return;
    };
    core.account_sign_in_start(browser(None)).await.unwrap();
    let page = core
        .account_sign_in_callback(&app_url(&format!(
            "error=access_denied&state={FAKE_ACCOUNT_STATE}"
        )))
        .await;
    assert!(matches!(page, CallbackPage::Failed { .. }));
    assert_eq!(poll_until_done(&core).await, AccountSignInState::Denied);

    core.account_sign_in_start(browser(None)).await.unwrap();
    let page = core
        .account_sign_in_callback(&app_url(&format!(
            "error=server_error&error_description=boom&state={FAKE_ACCOUNT_STATE}"
        )))
        .await;
    assert!(matches!(page, CallbackPage::Failed { .. }));
    assert_eq!(
        poll_until_done(&core).await,
        AccountSignInState::Failed {
            message: "server_error: boom".into()
        }
    );
    assert!(!f.account.calls().iter().any(|c| c.starts_with("exchange")));
    assert!(stored(&f).is_none());
}

#[tokio::test]
async fn a_configured_redirect_wins_over_the_app_scheme() {
    let f = fixtures();
    let Some((core, _recv)) = bundled(&f).await else {
        return;
    };
    set_setting(
        &core,
        "account.workos.redirect_uri",
        "http://127.0.0.1:5555/cb",
    )
    .await;
    let url = match core.account_sign_in_start(browser(None)).await.unwrap() {
        AccountSignInStart::Browser { url } => url,
        other => panic!("{other:?}"),
    };
    assert!(url.contains("http://127.0.0.1:5555/cb"));
    assert!(f.account.listening(), "the loopback listener is bound");
}

// ── device code ──────────────────────────────────────────────────────────

#[tokio::test]
async fn device_sign_in_polls_until_done() {
    let f = fixtures();
    let (core, mut recv) = configured(&f).await;
    match core.account_sign_in_start(device()).await.unwrap() {
        AccountSignInStart::DeviceCode {
            user_code,
            verification_uri_complete,
            interval,
            ..
        } => {
            assert_eq!(user_code, "BCDF-GHJK");
            assert!(verification_uri_complete.unwrap().contains("BCDF-GHJK"));
            assert_eq!(interval, 5);
        }
        other => panic!("{other:?}"),
    }
    f.account.push_device_poll(Ok(DeviceSignInPoll::Pending));
    f.account
        .push_device_poll(Ok(DeviceSignInPoll::SlowDown { interval: 10 }));
    f.account
        .push_device_poll(Ok(DeviceSignInPoll::Done(Box::new(fresh(&f, "rt_d")))));

    assert_eq!(
        core.account_sign_in_poll().await.unwrap(),
        AccountSignInState::Pending
    );
    assert_eq!(
        core.account_sign_in_poll().await.unwrap(),
        AccountSignInState::SlowDown { interval: 10 }
    );
    assert!(matches!(
        core.account_sign_in_poll().await.unwrap(),
        AccountSignInState::Done { .. }
    ));
    assert_eq!(
        f.account
            .calls()
            .into_iter()
            .filter(|c| c.starts_with("poll"))
            .collect::<Vec<_>>(),
        vec!["poll:dc-1:5", "poll:dc-1:5", "poll:dc-1:10"]
    );
    assert_eq!(stored(&f).unwrap().refresh_token, "rt_d");
    assert!(expect_account_event(&mut recv).await.user.is_some());
    assert!(core.account_sign_in_poll().await.is_err());
}

#[tokio::test]
async fn device_denied_and_expired_end_the_sign_in() {
    let f = fixtures();
    let (core, _recv) = configured(&f).await;
    for (poll, state) in [
        (DeviceSignInPoll::Denied, AccountSignInState::Denied),
        (DeviceSignInPoll::Expired, AccountSignInState::Expired),
    ] {
        core.account_sign_in_start(device()).await.unwrap();
        f.account.push_device_poll(Ok(poll));
        assert_eq!(core.account_sign_in_poll().await.unwrap(), state);
        assert!(core.account_sign_in_poll().await.is_err());
    }
    assert!(stored(&f).is_none());
}

#[tokio::test]
async fn a_device_poll_error_surfaces() {
    let f = fixtures();
    let (core, _recv) = configured(&f).await;
    core.account_sign_in_start(device()).await.unwrap();
    f.account
        .push_device_poll(Err(AccountError::Network("offline".into())));
    assert!(matches!(
        core.account_sign_in_poll().await,
        Err(AppError::Account(AccountError::Network(_)))
    ));
    // Still in progress: the next poll can succeed.
    assert_eq!(
        core.account_sign_in_poll().await.unwrap(),
        AccountSignInState::Pending
    );
}

// ── sign-out and refresh ─────────────────────────────────────────────────

#[tokio::test]
async fn sign_out_forgets_the_session_and_ends_it_remotely() {
    let f = fixtures();
    store_session(&f, &fresh(&f, "rt"));
    let (core, mut recv) = configured(&f).await;
    assert!(core.account_status().await.unwrap().user.is_some());

    let status = core.account_sign_out().await.unwrap();
    assert!(status.available);
    assert!(status.user.is_none());
    assert!(stored(&f).is_none());
    assert!(expect_account_event(&mut recv).await.user.is_none());
    for _ in 0..200 {
        if f.account.calls().iter().any(|c| c == "sign_out:session_01") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(f.account.calls().iter().any(|c| c == "sign_out:session_01"));
}

#[tokio::test]
async fn a_fresh_access_token_is_used_as_is() {
    let f = fixtures();
    store_session(&f, &fresh(&f, "rt"));
    let (core, _recv) = configured(&f).await;
    assert_eq!(
        core.account_access_token().await.unwrap().as_deref(),
        Some("at-rt")
    );
    assert!(!f.account.calls().iter().any(|c| c.starts_with("refresh")));
}

#[tokio::test]
async fn a_token_near_expiry_is_refreshed_and_rotated() {
    let f = fixtures();
    store_session(
        &f,
        &sample_account_session("rt_old", f.clock.now() + 10_000),
    );
    let (core, _recv) = configured(&f).await;
    f.account.push_refresh(Ok(fresh(&f, "rt_new")));
    assert_eq!(
        core.account_access_token().await.unwrap().as_deref(),
        Some("at-rt_new")
    );
    assert!(f.account.calls().iter().any(|c| c == "refresh:rt_old"));
    assert_eq!(stored(&f).unwrap().refresh_token, "rt_new");
    // Rotated: the next call doesn't refresh again.
    core.account_access_token().await.unwrap();
    assert_eq!(
        f.account
            .calls()
            .iter()
            .filter(|c| c.starts_with("refresh"))
            .count(),
        1
    );
}

#[tokio::test]
async fn a_rejected_refresh_signs_out() {
    let f = fixtures();
    store_session(&f, &sample_account_session("rt_old", f.clock.now() - 1));
    let (core, mut recv) = configured(&f).await;
    f.account
        .push_refresh(Err(AccountError::Rejected("invalid_grant".into())));
    assert!(core.account_access_token().await.is_err());
    assert!(stored(&f).is_none());
    assert!(core.account_status().await.unwrap().user.is_none());
    assert!(expect_account_event(&mut recv).await.user.is_none());
}

#[tokio::test]
async fn a_network_failure_keeps_the_session() {
    let f = fixtures();
    store_session(&f, &sample_account_session("rt_old", f.clock.now() - 1));
    let (core, _recv) = configured(&f).await;
    f.account
        .push_refresh(Err(AccountError::Network("offline".into())));
    assert!(matches!(
        core.account_access_token().await,
        Err(AppError::Account(AccountError::Network(_)))
    ));
    assert_eq!(stored(&f).unwrap().refresh_token, "rt_old");
    assert!(core.account_status().await.unwrap().user.is_some());
}

#[tokio::test]
async fn signed_out_has_no_access_token() {
    let f = fixtures();
    let (core, _recv) = configured(&f).await;
    assert_eq!(core.account_access_token().await.unwrap(), None);
}
