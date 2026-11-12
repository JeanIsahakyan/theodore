//! Organizations on the Theodore account (plan §6.12 "Organizations")
//! against `Core` + `testkit::FakeAccount`: the personal-org step after a
//! sign-in and at start, the organization choice during sign-in, switching,
//! and the rule that none of it ever signs the user out.

use std::time::Duration;

use pretty_assertions::assert_eq;
use serde_json::json;
use theodore_contract::{
    AccountOrganization, AccountOrganizationChoice, AccountOrganizationRef, AccountSignInMethod,
    AccountSignInRequest, AccountSignInState, Ephemeral, MutationOp, Setting, Transaction,
    TransactionResult, models,
};
use theodore_ports::{
    AccountError, AccountSession, CallbackPage, CallbackParams, Clock, DeviceSignInPoll,
    OrganizationChoice, OrganizationSelection, Secrets,
};

use crate::testkit::{FAKE_ACCOUNT_STATE, Fixtures, fixtures, sample_account_session};
use crate::usecases::account::{CLOUD_URL_ENV, resolve_cloud_url, valid_cloud_url};
use crate::{AppError, Core, Deps, Receivers};

const CLOUD: &str = "https://cloud.example";

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

/// A client id, and a cloud unless `cloud` is false.
async fn start(f: &Fixtures, cloud: bool) -> (Core, Receivers) {
    let (core, recv) = Core::start(f.deps());
    set_setting(&core, "account.workos.client_id", "client_01TEST").await;
    if cloud {
        set_setting(&core, "account.cloud_url", CLOUD).await;
    }
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

fn in_org(f: &Fixtures, refresh: &str, org: &str) -> AccountSession {
    AccountSession {
        organization_id: Some(org.into()),
        role: Some("admin".into()),
        permissions: vec!["widgets:read".into()],
        ..fresh(f, refresh)
    }
}

fn org_ref(id: &str) -> Option<AccountOrganizationRef> {
    Some(AccountOrganizationRef {
        id: id.into(),
        role: Some("admin".into()),
    })
}

fn selection_required(token: &str) -> AccountError {
    AccountError::OrganizationSelectionRequired(OrganizationSelection {
        pending_authentication_token: token.into(),
        organizations: vec![
            OrganizationChoice {
                id: "org_a".into(),
                name: "Acme".into(),
            },
            OrganizationChoice {
                id: "org_b".into(),
                name: "Globex".into(),
            },
        ],
    })
}

fn offered() -> AccountSignInState {
    AccountSignInState::ChooseOrganization {
        organizations: vec![
            AccountOrganizationChoice {
                id: "org_a".into(),
                name: "Acme".into(),
            },
            AccountOrganizationChoice {
                id: "org_b".into(),
                name: "Globex".into(),
            },
        ],
    }
}

fn device() -> AccountSignInRequest {
    AccountSignInRequest {
        method: AccountSignInMethod::DeviceCode,
        email: None,
    }
}

async fn sign_in_by_device(core: &Core, f: &Fixtures, session: AccountSession) {
    core.account_sign_in_start(device()).await.unwrap();
    f.account
        .push_device_poll(Ok(DeviceSignInPoll::Done(Box::new(session))));
    assert!(matches!(
        core.account_sign_in_poll().await.unwrap(),
        AccountSignInState::Done { .. }
    ));
}

async fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
    for _ in 0..400 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("timed out waiting for {what}");
}

fn called(f: &Fixtures, call: &str) -> bool {
    f.account.calls().iter().any(|c| c == call)
}

fn calls_starting(f: &Fixtures, prefix: &str) -> Vec<String> {
    f.account
        .calls()
        .into_iter()
        .filter(|c| c.starts_with(prefix))
        .collect()
}

/// Time for a background step to run if it was going to.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(50)).await;
}

// ── the cloud URL ────────────────────────────────────────────────────────

#[test]
fn only_https_or_a_local_http_cloud_is_accepted() {
    assert_eq!(
        valid_cloud_url(" https://cloud.example/ ").as_deref(),
        Some("https://cloud.example")
    );
    assert_eq!(
        valid_cloud_url("https://x.workers.dev/base").as_deref(),
        Some("https://x.workers.dev/base")
    );
    assert_eq!(
        valid_cloud_url("http://127.0.0.1:8787").as_deref(),
        Some("http://127.0.0.1:8787")
    );
    assert_eq!(
        valid_cloud_url("http://localhost:8787").as_deref(),
        Some("http://localhost:8787")
    );
    for bad in [
        "http://cloud.example",
        "http://10.0.0.1:8787",
        "ftp://cloud.example",
        "https://user:pw@cloud.example",
        "cloud.example",
        "",
    ] {
        assert_eq!(valid_cloud_url(bad), None, "{bad}");
    }
}

#[test]
fn the_cloud_url_is_env_then_setting_then_built_in_skipping_invalid_ones() {
    let mut warned = Vec::new();
    let pick = |env, setting, built_in, warned: &mut Vec<String>| {
        resolve_cloud_url(env, setting, built_in, |raw| warned.push(raw.to_string()))
    };
    assert_eq!(
        pick(
            Some("https://env.example"),
            Some("https://setting.example"),
            Some("https://built.example"),
            &mut warned
        )
        .as_deref(),
        Some("https://env.example")
    );
    assert_eq!(
        pick(
            Some("  "),
            Some("https://setting.example"),
            None,
            &mut warned
        )
        .as_deref(),
        Some("https://setting.example")
    );
    assert!(warned.is_empty());
    assert_eq!(
        pick(
            Some("http://evil.example"),
            Some(""),
            Some("https://built.example"),
            &mut warned
        )
        .as_deref(),
        Some("https://built.example")
    );
    assert_eq!(warned, vec!["http://evil.example".to_string()]);
    assert_eq!(pick(None, None, None, &mut warned), None);
}

// ── the personal organization after sign-in ──────────────────────────────

#[tokio::test]
async fn a_sign_in_without_an_org_joins_the_personal_one() {
    let f = fixtures();
    let (core, mut recv) = start(&f, true).await;
    f.account.push_ensure(Ok("org_p".into()));
    f.account.push_refresh(Ok(in_org(&f, "rt_2", "org_p")));

    sign_in_by_device(&core, &f, fresh(&f, "rt_1")).await;
    wait_until("the org-scoped session stored", || {
        stored(&f).and_then(|s| s.organization_id).as_deref() == Some("org_p")
    })
    .await;

    assert!(called(&f, "ensure_personal_organization:at-rt_1"));
    assert!(called(&f, "refresh:rt_1:org_p"));
    let s = stored(&f).unwrap();
    assert_eq!(s.refresh_token, "rt_2");
    assert_eq!(s.role.as_deref(), Some("admin"));
    let status = core.account_status().await.unwrap();
    assert_eq!(status.organization, org_ref("org_p"));
    assert!(status.user.is_some());
    // The UI hears it.
    let mut saw_org = false;
    while let Ok(Ok(e)) =
        tokio::time::timeout(Duration::from_millis(50), recv.ephemeral.recv()).await
    {
        if let Ephemeral::AccountStatus { status } = e
            && status.organization == org_ref("org_p")
        {
            saw_org = true;
            break;
        }
    }
    assert!(saw_org, "an account_status event with the organization");
}

#[tokio::test]
async fn a_cloud_failure_keeps_the_session_without_an_org() {
    let f = fixtures();
    let (core, _recv) = start(&f, true).await;
    f.account
        .push_ensure(Err(AccountError::Protocol("cloud.unauthorized: no".into())));

    sign_in_by_device(&core, &f, fresh(&f, "rt_1")).await;
    wait_until("the ensure call", || {
        called(&f, "ensure_personal_organization:at-rt_1")
    })
    .await;
    settle().await;

    assert!(calls_starting(&f, "refresh").is_empty());
    let status = core.account_status().await.unwrap();
    assert!(status.user.is_some(), "still signed in");
    assert!(!status.session_ended);
    assert_eq!(status.organization, None);
    assert_eq!(stored(&f).unwrap().refresh_token, "rt_1");
    assert!(core.require_account().await.is_ok());
}

#[tokio::test]
async fn a_rejected_org_scoped_refresh_never_signs_out() {
    let f = fixtures();
    let (core, _recv) = start(&f, true).await;
    f.account.push_ensure(Ok("org_p".into()));
    f.account
        .push_refresh(Err(AccountError::Rejected("invalid_grant: no".into())));

    sign_in_by_device(&core, &f, fresh(&f, "rt_1")).await;
    wait_until("the org-scoped refresh", || {
        called(&f, "refresh:rt_1:org_p")
    })
    .await;
    settle().await;

    let status = core.account_status().await.unwrap();
    assert!(status.user.is_some(), "still signed in");
    assert!(!status.session_ended);
    assert_eq!(status.organization, None);
    assert_eq!(stored(&f).unwrap().refresh_token, "rt_1");
}

#[tokio::test]
async fn no_cloud_configured_calls_nothing() {
    if std::env::var(CLOUD_URL_ENV).is_ok() {
        return; // a cloud from this machine's environment
    }
    let f = fixtures();
    let (core, _recv) = start(&f, false).await;
    sign_in_by_device(&core, &f, fresh(&f, "rt_1")).await;
    settle().await;
    assert!(calls_starting(&f, "ensure").is_empty());
    assert!(calls_starting(&f, "refresh").is_empty());
    assert_eq!(core.account_status().await.unwrap().organization, None);
}

#[tokio::test]
async fn an_invalid_cloud_url_counts_as_none() {
    if std::env::var(CLOUD_URL_ENV).is_ok() {
        return;
    }
    let f = fixtures();
    let (core, _recv) = start(&f, false).await;
    set_setting(&core, "account.cloud_url", "http://cloud.example").await;
    sign_in_by_device(&core, &f, fresh(&f, "rt_1")).await;
    settle().await;
    assert!(calls_starting(&f, "ensure").is_empty());
}

#[tokio::test]
async fn a_session_with_an_org_skips_the_step() {
    let f = fixtures();
    let (core, _recv) = start(&f, true).await;
    sign_in_by_device(&core, &f, in_org(&f, "rt_1", "org_a")).await;
    settle().await;
    assert!(calls_starting(&f, "ensure").is_empty());
    assert_eq!(
        core.account_status().await.unwrap().organization,
        org_ref("org_a")
    );
}

#[tokio::test]
async fn a_stored_session_without_an_org_joins_it_at_start() {
    let f = fixtures();
    store_session(&f, &fresh(&f, "rt_s"));
    f.account.push_ensure(Ok("org_p".into()));
    f.account.push_refresh(Ok(in_org(&f, "rt_2", "org_p")));
    // Built in, so it's there from the first instant.
    let deps = Deps {
        account_client_id: Some("client_01BUILTIN".into()),
        account_cloud_url: Some(CLOUD.into()),
        ..f.deps()
    };
    let (core, _recv) = Core::start(deps);
    wait_until("the org-scoped session stored", || {
        stored(&f).and_then(|s| s.organization_id).as_deref() == Some("org_p")
    })
    .await;
    assert!(called(&f, "ensure_personal_organization:at-rt_s"));
    assert!(called(&f, "refresh:rt_s:org_p"));
    assert_eq!(
        core.account_status().await.unwrap().organization,
        org_ref("org_p")
    );
}

#[tokio::test]
async fn a_sign_out_during_the_org_step_drops_its_result() {
    let f = fixtures();
    let (core, _recv) = start(&f, true).await;
    f.account.push_ensure(Ok("org_p".into()));
    f.account.push_refresh(Ok(in_org(&f, "rt_2", "org_p")));
    let release = f.account.hold("refresh:rt_1:org_p");

    sign_in_by_device(&core, &f, fresh(&f, "rt_1")).await;
    wait_until("the org-scoped refresh", || {
        called(&f, "refresh:rt_1:org_p")
    })
    .await;
    core.account_sign_out().await.unwrap();
    release.send(()).unwrap();
    settle().await;

    assert!(
        stored(&f).is_none(),
        "the dropped session isn't written back"
    );
    let status = core.account_status().await.unwrap();
    assert!(status.user.is_none());
    assert_eq!(status.organization, None);
}

// ── choosing an organization during sign-in ──────────────────────────────

#[tokio::test]
async fn a_browser_sign_in_needing_an_org_finishes_with_the_choice() {
    let f = fixtures();
    let (core, _recv) = start(&f, true).await;
    f.account
        .push_exchange(Err(selection_required("pending_1")));
    core.account_sign_in_start(AccountSignInRequest {
        method: AccountSignInMethod::Browser,
        email: None,
    })
    .await
    .unwrap();
    let page = f
        .account
        .callback(CallbackParams {
            code: Some("code_1".into()),
            state: Some(FAKE_ACCOUNT_STATE.into()),
            ..Default::default()
        })
        .await;
    assert_eq!(page.await.unwrap(), CallbackPage::ChooseOrganization);

    let mut state = AccountSignInState::Pending;
    for _ in 0..200 {
        state = core.account_sign_in_poll().await.unwrap();
        if state != AccountSignInState::Pending {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(state, offered());
    // Reported again until chosen: nothing stored yet.
    assert_eq!(core.account_sign_in_poll().await.unwrap(), offered());
    assert!(stored(&f).is_none());

    // Not one of the offered ones: refused, and the choice still waits.
    assert!(matches!(
        core.account_sign_in_choose_organization("org_x").await,
        Err(AppError::Invalid(_))
    ));
    assert!(calls_starting(&f, "select_organization").is_empty());
    assert_eq!(core.account_sign_in_poll().await.unwrap(), offered());

    f.account
        .push_org_selection(Ok(in_org(&f, "rt_o", "org_b")));
    match core
        .account_sign_in_choose_organization("org_b")
        .await
        .unwrap()
    {
        AccountSignInState::Done { status } => {
            assert!(status.user.is_some());
            assert_eq!(status.organization, org_ref("org_b"));
        }
        other => panic!("expected Done, got {other:?}"),
    }
    assert!(called(&f, "select_organization:pending_1:org_b"));
    assert_eq!(
        stored(&f).unwrap().organization_id.as_deref(),
        Some("org_b")
    );
    // Over: nothing left to poll or choose.
    assert!(core.account_sign_in_poll().await.is_err());
    assert!(
        core.account_sign_in_choose_organization("org_b")
            .await
            .is_err()
    );
    settle().await;
    assert!(calls_starting(&f, "ensure").is_empty(), "already in an org");
}

#[tokio::test]
async fn a_device_sign_in_needing_an_org_reports_the_choice_and_a_failed_select_ends_it() {
    let f = fixtures();
    let (core, _recv) = start(&f, true).await;
    core.account_sign_in_start(device()).await.unwrap();
    f.account
        .push_device_poll(Err(selection_required("pending_d")));
    assert_eq!(core.account_sign_in_poll().await.unwrap(), offered());
    // No more device polls: the choice is in memory.
    assert_eq!(core.account_sign_in_poll().await.unwrap(), offered());
    assert_eq!(calls_starting(&f, "poll").len(), 1);

    f.account
        .push_org_selection(Err(AccountError::Rejected("cloud.rejected: used".into())));
    match core
        .account_sign_in_choose_organization("org_a")
        .await
        .unwrap()
    {
        AccountSignInState::Failed { message } => assert!(message.contains("rejected")),
        other => panic!("expected Failed, got {other:?}"),
    }
    assert!(called(&f, "select_organization:pending_d:org_a"));
    assert!(stored(&f).is_none());
    assert!(core.account_sign_in_poll().await.is_err());
}

#[tokio::test]
async fn cancel_forgets_the_pending_choice() {
    let f = fixtures();
    let (core, _recv) = start(&f, true).await;
    core.account_sign_in_start(device()).await.unwrap();
    f.account
        .push_device_poll(Err(selection_required("pending_c")));
    assert_eq!(core.account_sign_in_poll().await.unwrap(), offered());

    core.account_sign_in_cancel();
    assert!(core.account_sign_in_poll().await.is_err());
    assert!(matches!(
        core.account_sign_in_choose_organization("org_a").await,
        Err(AppError::Invalid(_))
    ));
    assert!(calls_starting(&f, "select_organization").is_empty());
}

// ── switching and listing ────────────────────────────────────────────────

#[tokio::test]
async fn switching_moves_the_session_to_the_other_org() {
    let f = fixtures();
    store_session(&f, &in_org(&f, "rt_s", "org_a"));
    let (core, mut recv) = start(&f, true).await;
    f.account.push_refresh(Ok(in_org(&f, "rt_2", "org_b")));

    let status = core.account_switch_organization("org_b").await.unwrap();
    assert_eq!(status.organization, org_ref("org_b"));
    assert!(called(&f, "refresh:rt_s:org_b"));
    assert_eq!(stored(&f).unwrap().refresh_token, "rt_2");
    let mut heard = false;
    while let Ok(Ok(e)) =
        tokio::time::timeout(Duration::from_millis(50), recv.ephemeral.recv()).await
    {
        if let Ephemeral::AccountStatus { status } = e
            && status.organization == org_ref("org_b")
        {
            heard = true;
            break;
        }
    }
    assert!(heard);
}

#[tokio::test]
async fn a_rejected_switch_returns_the_error_and_keeps_the_session() {
    let f = fixtures();
    store_session(&f, &in_org(&f, "rt_s", "org_a"));
    let (core, _recv) = start(&f, true).await;
    f.account.push_refresh(Err(AccountError::Rejected(
        "invalid_grant: not a member".into(),
    )));

    assert!(matches!(
        core.account_switch_organization("org_z").await,
        Err(AppError::Account(AccountError::Rejected(_)))
    ));
    let s = stored(&f).unwrap();
    assert_eq!(s.refresh_token, "rt_s");
    assert_eq!(s.organization_id.as_deref(), Some("org_a"));
    let status = core.account_status().await.unwrap();
    assert!(status.user.is_some());
    assert!(!status.session_ended);
    assert_eq!(status.organization, org_ref("org_a"));
    assert!(core.require_account().await.is_ok());
}

#[tokio::test]
async fn switching_while_signed_out_needs_an_account() {
    let f = fixtures();
    let (core, _recv) = start(&f, true).await;
    assert!(matches!(
        core.account_switch_organization("org_b").await,
        Err(AppError::AccountRequired)
    ));
    assert!(calls_starting(&f, "refresh").is_empty());
}

#[tokio::test]
async fn organizations_come_from_the_cloud_with_the_current_token() {
    let f = fixtures();
    store_session(&f, &in_org(&f, "rt_s", "org_a"));
    let (core, _recv) = start(&f, true).await;
    f.account
        .push_organizations(Ok(vec![theodore_ports::AccountOrganization {
            id: "org_p".into(),
            name: "Personal (ada@example.com)".into(),
            role: Some("admin".into()),
            personal: true,
        }]));
    assert_eq!(
        core.account_organizations().await.unwrap(),
        vec![AccountOrganization {
            id: "org_p".into(),
            name: "Personal (ada@example.com)".into(),
            role: Some("admin".into()),
            personal: true,
        }]
    );
    assert!(called(&f, "organizations:at-rt_s"));
}

#[tokio::test]
async fn listing_organizations_while_signed_out_needs_an_account() {
    let f = fixtures();
    let (core, _recv) = start(&f, true).await;
    assert!(matches!(
        core.account_organizations().await,
        Err(AppError::AccountRequired)
    ));
}
