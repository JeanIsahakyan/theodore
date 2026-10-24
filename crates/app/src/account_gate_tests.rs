//! The account gate (plan §6.12 "Sign-in required") against `Core` +
//! `testkit` fakes: when it applies, what holds behind it, and how a
//! session ending or a sign-out closes it again without losing data.

use std::time::Duration;

use serde_json::json;
use theodore_contract::{
    AccountSignInMethod, AccountSignInRequest, AccountSignInState, Ephemeral, models,
};
use theodore_ports::{
    AccountError, AccountSession, Changes, Clock, DeviceSignInPoll, NewAction, Secrets, Store,
    SyncActionCode,
};

use crate::testkit::{Fixtures, fixtures, sample_account_session};
use crate::usecases::account::{AccountGate, CLIENT_ID_ENV, resolve_client_id};
use crate::{AppError, Core, Deps, Receivers};

/// A build with a client id baked in: the gate applies from the first
/// instant, no setting written after start.
fn built_in(f: &Fixtures) -> Deps {
    Deps {
        account_client_id: Some("client_01BUILTIN".into()),
        ..f.deps()
    }
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

async fn sign_in_by_device(core: &Core, f: &Fixtures) {
    core.account_sign_in_start(AccountSignInRequest {
        method: AccountSignInMethod::DeviceCode,
        email: None,
    })
    .await
    .unwrap();
    f.account
        .push_device_poll(Ok(DeviceSignInPoll::Done(Box::new(fresh(f, "rt_in")))));
    assert!(matches!(
        core.account_sign_in_poll().await.unwrap(),
        AccountSignInState::Done { .. }
    ));
}

async fn wait_until(mut cond: impl FnMut() -> bool) {
    for _ in 0..400 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("condition not met in time");
}

async fn expect_account_event(recv: &mut Receivers) -> theodore_contract::AccountStatus {
    for _ in 0..200 {
        if let Ok(Ok(Ephemeral::AccountStatus { status })) =
            tokio::time::timeout(Duration::from_millis(50), recv.ephemeral.recv()).await
        {
            return status;
        }
    }
    panic!("no account_status event");
}

/// One row of local data that must survive the session ending.
async fn seed_project(core: &Core) {
    core.apply(vec![NewAction {
        model: models::PROJECT.into(),
        model_id: "p1".into(),
        action: SyncActionCode::I,
        data: Some(json!({ "id": "p1", "name": "kept" })),
    }])
    .await
    .unwrap();
}

fn env_configured() -> bool {
    std::env::var(CLIENT_ID_ENV).is_ok_and(|v| !v.trim().is_empty())
}

// ── client id ────────────────────────────────────────────────────────────

#[test]
fn the_client_id_is_the_env_else_the_setting_else_the_built_in_one() {
    let r = resolve_client_id;
    assert_eq!(
        r(Some("env"), Some("set"), Some("baked")).as_deref(),
        Some("env")
    );
    assert_eq!(r(None, Some("set"), Some("baked")).as_deref(), Some("set"));
    assert_eq!(r(None, None, Some("baked")).as_deref(), Some("baked"));
    // Blank doesn't count, and values are trimmed.
    assert_eq!(
        r(Some("  "), Some(""), Some(" baked ")).as_deref(),
        Some("baked")
    );
    assert_eq!(r(None, Some(" set "), None).as_deref(), Some("set"));
    assert_eq!(r(None, None, None), None);
    assert_eq!(r(Some(""), Some(" "), Some("")), None);
}

#[tokio::test]
async fn a_built_in_client_id_configures_the_account() {
    let f = fixtures();
    let (core, _recv) = Core::start(built_in(&f));
    let status = core.account_status().await.unwrap();
    assert!(status.available);
    assert!(status.required);
    assert!(status.user.is_none());
}

// ── when the gate applies ────────────────────────────────────────────────

#[tokio::test]
async fn no_client_id_leaves_the_gate_open() {
    if env_configured() {
        return; // configured from the environment on this machine
    }
    let f = fixtures();
    let (core, _recv) = Core::start(f.deps());
    assert_eq!(core.account_gate().await, AccountGate::NotConfigured);
    core.require_account().await.unwrap();
    let status = core.account_status().await.unwrap();
    assert!(!status.available && !status.required);
}

#[tokio::test]
async fn fixture_and_sandbox_modes_are_exempt_even_with_a_client_id() {
    // Both run on `LocalAccount`: a provider that isn't enabled.
    let f = fixtures();
    f.account.set_enabled(false);
    let (core, _recv) = Core::start(built_in(&f));
    assert_eq!(core.account_gate().await, AccountGate::Exempt);
    core.require_account().await.unwrap();
    assert!(!core.account_status().await.unwrap().required);
}

#[tokio::test]
async fn configured_and_signed_out_closes_the_gate() {
    let f = fixtures();
    let (core, _recv) = Core::start(built_in(&f));
    assert_eq!(core.account_gate().await, AccountGate::SignedOut);
    assert!(matches!(
        core.require_account().await,
        Err(AppError::AccountRequired)
    ));
}

#[tokio::test]
async fn a_stored_session_opens_the_gate() {
    let f = fixtures();
    store_session(&f, &fresh(&f, "rt"));
    let (core, _recv) = Core::start(built_in(&f));
    assert_eq!(core.account_gate().await, AccountGate::SignedIn);
    core.require_account().await.unwrap();
}

#[tokio::test]
async fn signing_in_opens_the_gate() {
    let f = fixtures();
    let (core, _recv) = Core::start(built_in(&f));
    assert!(core.require_account().await.is_err());
    sign_in_by_device(&core, &f).await;
    assert_eq!(core.account_gate().await, AccountGate::SignedIn);
    core.require_account().await.unwrap();
}

// ── background host traffic ──────────────────────────────────────────────

#[tokio::test]
async fn the_poller_and_outbox_wait_for_sign_in() {
    let f = fixtures();
    f.host.push_search(Ok(vec![]));
    f.host.push_changed_since(Ok(Changes {
        prs: vec![],
        cursor: "1".into(),
        poll_after_ms: Some(60_000),
    }));
    f.store.outbox_push("not_a_real_op", json!({})).unwrap();
    let (core, _recv) = Core::start(built_in(&f));

    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(
        f.host.search_responses.lock().unwrap().len(),
        1,
        "no inbox refresh"
    );
    assert_eq!(
        f.host.changed_since_responses.lock().unwrap().len(),
        1,
        "no inbox poll"
    );
    assert_eq!(f.store.outbox_pending_count().unwrap(), 1, "no host write");

    sign_in_by_device(&core, &f).await;
    wait_until(|| {
        f.host.search_responses.lock().unwrap().is_empty()
            && f.host.changed_since_responses.lock().unwrap().is_empty()
            && f.store.outbox_pending_count().unwrap() == 0
    })
    .await;
}

#[tokio::test]
async fn without_a_required_sign_in_the_poller_starts_at_once() {
    if env_configured() {
        return;
    }
    let f = fixtures();
    f.host.push_changed_since(Ok(Changes {
        prs: vec![],
        cursor: "1".into(),
        poll_after_ms: Some(60_000),
    }));
    let (_core, _recv) = Core::start(f.deps());
    wait_until(|| f.host.changed_since_responses.lock().unwrap().is_empty()).await;
}

// ── offline, a session that ended, sign-out ──────────────────────────────

#[tokio::test]
async fn an_offline_refresh_keeps_the_app_usable() {
    let f = fixtures();
    store_session(&f, &sample_account_session("rt_old", f.clock.now() - 1));
    let (core, _recv) = Core::start(built_in(&f));
    f.account
        .push_refresh(Err(AccountError::Network("offline".into())));
    assert!(core.account_access_token().await.is_err());
    assert_eq!(core.account_gate().await, AccountGate::SignedIn);
    core.require_account().await.unwrap();
    let status = core.account_status().await.unwrap();
    assert!(status.user.is_some());
    assert!(!status.session_ended);
}

#[tokio::test]
async fn a_rejected_refresh_ends_the_session_and_closes_the_gate() {
    let f = fixtures();
    store_session(&f, &sample_account_session("rt_old", f.clock.now() - 1));
    let (core, mut recv) = Core::start(built_in(&f));
    core.require_account().await.unwrap();
    seed_project(&core).await;

    f.account
        .push_refresh(Err(AccountError::Rejected("invalid_grant".into())));
    assert!(core.account_access_token().await.is_err());

    let event = expect_account_event(&mut recv).await;
    assert!(event.user.is_none() && event.session_ended);
    assert!(matches!(
        core.require_account().await,
        Err(AppError::AccountRequired)
    ));
    let status = core.account_status().await.unwrap();
    assert!(status.required && status.session_ended);
    // Nothing local is deleted.
    assert!(f.store.get(models::PROJECT, "p1").unwrap().is_some());

    // Signing back in clears the notice and opens the gate.
    sign_in_by_device(&core, &f).await;
    let status = core.account_status().await.unwrap();
    assert!(status.user.is_some() && !status.session_ended);
    core.require_account().await.unwrap();
}

#[tokio::test]
async fn host_writes_queued_while_the_session_is_over_wait_for_sign_in() {
    let f = fixtures();
    store_session(&f, &sample_account_session("rt_old", f.clock.now() - 1));
    let (core, _recv) = Core::start(built_in(&f));
    f.account
        .push_refresh(Err(AccountError::Rejected("invalid_grant".into())));
    assert!(core.account_access_token().await.is_err());
    assert!(core.require_account().await.is_err());

    f.store.outbox_push("not_a_real_op", json!({})).unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(f.store.outbox_pending_count().unwrap(), 1);

    sign_in_by_device(&core, &f).await;
    wait_until(|| f.store.outbox_pending_count().unwrap() == 0).await;
}

#[tokio::test]
async fn sign_out_closes_the_gate_and_keeps_local_data() {
    let f = fixtures();
    store_session(&f, &fresh(&f, "rt"));
    let (core, _recv) = Core::start(built_in(&f));
    seed_project(&core).await;
    core.require_account().await.unwrap();

    let status = core.account_sign_out().await.unwrap();
    assert!(status.required && status.user.is_none());
    // A sign-out by the user isn't a session that ended.
    assert!(!status.session_ended);
    assert!(matches!(
        core.require_account().await,
        Err(AppError::AccountRequired)
    ));
    assert!(f.store.get(models::PROJECT, "p1").unwrap().is_some());
}
