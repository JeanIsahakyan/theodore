//! Several Theodore accounts at once (docs/cloud.md "Several accounts")
//! against `Core` + `testkit::FakeAccount`: the upgrade from one session,
//! adding, switching (account and organization), signing one out, each
//! account's refresh under its own lock, a rejected refresh, and the
//! telemetry identity following the active account.

use std::time::Duration;

use pretty_assertions::assert_eq;
use theodore_contract::{
    AccountSignInMethod, AccountSignInRequest, AccountSignInState, AccountSwitchRequest,
};
use theodore_ports::{
    AccountError, AccountOrganization, AccountProfile, AccountSession, Clock, DeviceSignInPoll,
    Secrets, Store,
};

use crate::testkit::{Fixtures, fixtures, sample_account_session};
use crate::usecases::account::ACCOUNTS_INDEX_KEY;
use crate::{AppError, Core, Deps, Receivers};

const CLOUD: &str = "https://cloud.example";
const ADA: &str = "user_01";
const BOB: &str = "user_02";

/// A client id and a cloud, compiled in.
fn start(f: &Fixtures) -> (Core, Receivers) {
    Core::start(Deps {
        account_client_id: Some("client_01TEST".into()),
        account_cloud_url: Some(CLOUD.into()),
        ..f.deps()
    })
}

fn ada(f: &Fixtures, refresh: &str, org: &str) -> AccountSession {
    AccountSession {
        organization_id: Some(org.into()),
        role: Some("admin".into()),
        ..sample_account_session(refresh, f.clock.now() + 300_000)
    }
}

fn bob(f: &Fixtures, refresh: &str, org: &str) -> AccountSession {
    AccountSession {
        user: AccountProfile {
            id: BOB.into(),
            email: "bob@acme.example".into(),
            first_name: Some("Bob".into()),
            last_name: None,
            avatar_url: None,
        },
        session_id: Some("session_02".into()),
        ..ada(f, refresh, org)
    }
}

fn stored(f: &Fixtures, user: &str) -> Option<AccountSession> {
    f.secrets
        .get(&theodore_secrets::account_key(user))
        .unwrap()
        .map(|s| serde_json::from_str(&s).unwrap())
}

fn store_legacy(f: &Fixtures, s: &AccountSession) {
    f.secrets
        .set(
            theodore_secrets::THEODORE_ACCOUNT,
            &serde_json::to_string(s).unwrap(),
        )
        .unwrap();
}

fn index(f: &Fixtures) -> serde_json::Value {
    f.store
        .kv_get(ACCOUNTS_INDEX_KEY)
        .unwrap()
        .unwrap_or(serde_json::Value::Null)
}

fn org(id: &str, personal: bool) -> AccountOrganization {
    AccountOrganization {
        id: id.into(),
        name: id.to_uppercase(),
        role: Some("admin".into()),
        personal,
    }
}

async fn sign_in(core: &Core, f: &Fixtures, session: AccountSession) {
    core.account_sign_in_start(AccountSignInRequest {
        method: AccountSignInMethod::DeviceCode,
        email: None,
    })
    .await
    .unwrap();
    f.account
        .push_device_poll(Ok(DeviceSignInPoll::Done(Box::new(session))));
    assert!(matches!(
        core.account_sign_in_poll().await.unwrap(),
        AccountSignInState::Done { .. }
    ));
}

async fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
    // Up to 30 s of wall time, counted by the clock: sleeps stretch on a
    // loaded runner, and a condition met during the last stretch still counts.
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while std::time::Instant::now() < deadline {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    if cond() {
        return;
    }
    panic!("timed out waiting for {what}");
}

fn called(f: &Fixtures, call: &str) -> bool {
    f.account.calls().iter().any(|c| c == call)
}

/// Time for a background step to run if it was going to.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(50)).await;
}

fn identities(core: &Core) -> Vec<Option<String>> {
    core.0.account.identity_log.lock().unwrap().clone()
}

/// Ada signed in (as an upgrade would leave her), then Bob signs in.
async fn two(f: &Fixtures) -> (Core, Receivers) {
    store_legacy(f, &ada(f, "rt_a", "org_a"));
    let (core, recv) = start(f);
    core.account_status().await.unwrap();
    sign_in(&core, f, bob(f, "rt_b", "org_b")).await;
    (core, recv)
}

// ── upgrade ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_single_session_of_an_older_build_becomes_the_first_account() {
    let f = fixtures();
    store_legacy(&f, &ada(&f, "rt_a", "org_a"));
    let (core, _recv) = start(&f);

    let status = core.account_status().await.unwrap();
    assert_eq!(status.user.as_ref().map(|u| u.id.as_str()), Some(ADA));
    assert_eq!(status.accounts.len(), 1);
    assert!(status.accounts[0].active);
    assert!(!status.accounts[0].sign_in_required);
    assert_eq!(
        status.accounts[0]
            .organization
            .as_ref()
            .map(|o| o.id.as_str()),
        Some("org_a")
    );

    // Moved to its own entry; the index names it and the active one.
    assert_eq!(stored(&f, ADA).unwrap().refresh_token, "rt_a");
    assert_eq!(
        f.secrets.get(theodore_secrets::THEODORE_ACCOUNT).unwrap(),
        None
    );
    let ix = index(&f);
    assert_eq!(ix["active"], ADA);
    assert_eq!(ix["accounts"][0]["user"]["id"], ADA);
    assert_eq!(ix["accounts"][0]["organization_id"], "org_a");
    assert_eq!(ix["accounts"][0]["ended"], false);
    assert!(
        ix["accounts"][0].get("access_token").is_none()
            && ix["accounts"][0].get("refresh_token").is_none(),
        "the index carries no token: {ix}"
    );
}

#[tokio::test]
async fn nothing_stored_means_signed_out_of_every_account() {
    let f = fixtures();
    let (core, _recv) = start(&f);
    let status = core.account_status().await.unwrap();
    assert!(status.user.is_none());
    assert!(status.accounts.is_empty());
    assert_eq!(
        index(&f),
        serde_json::Value::Null,
        "no index written for nobody"
    );
}

// ── add ──────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_second_sign_in_adds_an_account_and_makes_it_active() {
    let f = fixtures();
    let (core, _recv) = two(&f).await;

    let status = core.account_status().await.unwrap();
    assert_eq!(status.user.as_ref().map(|u| u.id.as_str()), Some(BOB));
    assert_eq!(
        status.organization.as_ref().map(|o| o.id.as_str()),
        Some("org_b")
    );
    let ids: Vec<(&str, bool)> = status
        .accounts
        .iter()
        .map(|a| (a.user.id.as_str(), a.active))
        .collect();
    assert_eq!(
        ids,
        vec![(ADA, false), (BOB, true)],
        "sign-in order, Bob active"
    );

    // Both sessions kept, each in its own entry.
    assert_eq!(stored(&f, ADA).unwrap().refresh_token, "rt_a");
    assert_eq!(stored(&f, BOB).unwrap().refresh_token, "rt_b");
    assert_eq!(index(&f)["active"], BOB);
    assert_eq!(index(&f)["accounts"].as_array().unwrap().len(), 2);
    assert_eq!(
        core.account_access_token().await.unwrap().as_deref(),
        Some("at-rt_b"),
        "the token is the active account's"
    );
}

#[tokio::test]
async fn signing_in_as_a_listed_user_replaces_that_account() {
    let f = fixtures();
    let (core, _recv) = two(&f).await;
    sign_in(&core, &f, ada(&f, "rt_a2", "org_a")).await;

    let status = core.account_status().await.unwrap();
    assert_eq!(status.user.as_ref().map(|u| u.id.as_str()), Some(ADA));
    assert_eq!(status.accounts.len(), 2, "not a third account");
    assert_eq!(stored(&f, ADA).unwrap().refresh_token, "rt_a2");
    assert_eq!(stored(&f, BOB).unwrap().refresh_token, "rt_b");
}

#[tokio::test]
async fn a_new_space_remembers_the_active_account() {
    let f = fixtures();
    let (core, _recv) = two(&f).await;
    let project = core
        .add_project(theodore_contract::AddProjectRequest {
            repo: None,
            path: Some("/tmp/multi-account-app".into()),
        })
        .await
        .unwrap();
    wait_until("the project is ready", || {
        f.store
            .get(theodore_contract::models::PROJECT, &project.id)
            .unwrap()
            .is_some_and(|r| r.data["status"] == serde_json::json!("ready"))
    })
    .await;
    f.git
        .set_resolve("main", theodore_domain::Sha::new("base000"));
    let space = core
        .create_space(theodore_contract::CreateSpaceRequest {
            project: project.id.clone(),
            goal: "x".into(),
            name: None,
            branch: None,
            base: None,
            agent: None,
            model: None,
            start_from: None,
            effort: None,
            mode: None,
        })
        .await
        .unwrap();
    assert_eq!(space.account.as_deref(), Some(BOB));
}

// ── switch ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn switching_changes_the_active_account_and_its_token_and_identity() {
    let f = fixtures();
    let (core, _recv) = two(&f).await;

    let status = core
        .account_switch(AccountSwitchRequest {
            user_id: ADA.into(),
            organization_id: None,
        })
        .await
        .unwrap();
    assert_eq!(status.user.as_ref().map(|u| u.id.as_str()), Some(ADA));
    assert!(status.accounts[0].active && !status.accounts[1].active);
    assert_eq!(
        core.account_access_token().await.unwrap().as_deref(),
        Some("at-rt_a")
    );
    assert_eq!(index(&f)["active"], ADA);
    assert_eq!(
        identities(&core),
        vec![Some(ADA.into()), Some(BOB.into()), Some(ADA.into())],
        "telemetry follows the active account (docs/telemetry.md)"
    );
    assert!(
        !f.account.calls().iter().any(|c| c.starts_with("refresh:")),
        "switching accounts needs no refresh: {:?}",
        f.account.calls()
    );
}

#[tokio::test]
async fn switching_with_an_organization_refreshes_that_account_into_it() {
    let f = fixtures();
    let (core, _recv) = two(&f).await;
    f.account.push_refresh(Ok(ada(&f, "rt_a2", "org_c")));

    let status = core
        .account_switch(AccountSwitchRequest {
            user_id: ADA.into(),
            organization_id: Some("org_c".into()),
        })
        .await
        .unwrap();
    assert!(called(&f, "refresh:rt_a:org_c"), "{:?}", f.account.calls());
    assert_eq!(status.user.as_ref().map(|u| u.id.as_str()), Some(ADA));
    assert_eq!(
        status.organization.as_ref().map(|o| o.id.as_str()),
        Some("org_c")
    );
    assert_eq!(
        stored(&f, ADA).unwrap().organization_id.as_deref(),
        Some("org_c")
    );
    assert_eq!(index(&f)["accounts"][0]["organization_id"], "org_c");
    // Bob's session is untouched.
    assert_eq!(stored(&f, BOB).unwrap().refresh_token, "rt_b");
}

#[tokio::test]
async fn a_rejected_organization_switch_keeps_the_account_switched_and_signed_in() {
    let f = fixtures();
    let (core, _recv) = two(&f).await;
    f.account.push_refresh(Err(AccountError::Rejected(
        "organization_membership_not_found".into(),
    )));

    let err = core
        .account_switch(AccountSwitchRequest {
            user_id: ADA.into(),
            organization_id: Some("org_x".into()),
        })
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Account(AccountError::Rejected(_))));
    let status = core.account_status().await.unwrap();
    assert_eq!(status.user.as_ref().map(|u| u.id.as_str()), Some(ADA));
    assert_eq!(
        status.organization.as_ref().map(|o| o.id.as_str()),
        Some("org_a")
    );
    assert_eq!(stored(&f, ADA).unwrap().refresh_token, "rt_a");
}

#[tokio::test]
async fn switching_organization_moves_only_the_active_account() {
    let f = fixtures();
    let (core, _recv) = two(&f).await;
    f.account.push_refresh(Ok(bob(&f, "rt_b2", "org_d")));
    let status = core.account_switch_organization("org_d").await.unwrap();
    assert!(called(&f, "refresh:rt_b:org_d"));
    assert_eq!(
        status.organization.as_ref().map(|o| o.id.as_str()),
        Some("org_d")
    );
    assert_eq!(
        stored(&f, ADA).unwrap().organization_id.as_deref(),
        Some("org_a")
    );
}

#[tokio::test]
async fn an_unknown_account_cant_be_switched_to() {
    let f = fixtures();
    let (core, _recv) = two(&f).await;
    assert!(matches!(
        core.account_switch(AccountSwitchRequest {
            user_id: "user_99".into(),
            organization_id: None,
        })
        .await,
        Err(AppError::Invalid(_))
    ));
    assert_eq!(
        core.account_status()
            .await
            .unwrap()
            .user
            .map(|u| u.id)
            .as_deref(),
        Some(BOB)
    );
}

// ── sign out of one ──────────────────────────────────────────────────────

#[tokio::test]
async fn signing_out_of_another_account_leaves_the_active_one() {
    let f = fixtures();
    let (core, _recv) = two(&f).await;

    let status = core.account_sign_out_of(ADA).await.unwrap();
    assert_eq!(status.user.as_ref().map(|u| u.id.as_str()), Some(BOB));
    assert_eq!(status.accounts.len(), 1);
    assert_eq!(stored(&f, ADA), None);
    assert_eq!(stored(&f, BOB).unwrap().refresh_token, "rt_b");
    assert_eq!(index(&f)["accounts"].as_array().unwrap().len(), 1);
    wait_until("Ada's session ended at the provider", || {
        called(&f, "sign_out:session_01")
    })
    .await;
    assert!(!called(&f, "sign_out:session_02"));
    assert_eq!(
        identities(&core).last(),
        Some(&Some(BOB.into())),
        "nobody else was told to telemetry"
    );
    assert_eq!(identities(&core).len(), 2);
}

#[tokio::test]
async fn signing_out_of_the_active_account_makes_the_next_one_active() {
    let f = fixtures();
    let (core, _recv) = two(&f).await;

    let status = core.account_sign_out().await.unwrap();
    assert_eq!(status.user.as_ref().map(|u| u.id.as_str()), Some(ADA));
    assert!(!status.session_ended);
    assert_eq!(status.accounts.len(), 1);
    assert!(status.accounts[0].active);
    assert_eq!(index(&f)["active"], ADA);
    assert_eq!(stored(&f, BOB), None);
    assert_eq!(
        core.account_access_token().await.unwrap().as_deref(),
        Some("at-rt_a")
    );
    assert_eq!(
        identities(&core),
        vec![Some(ADA.into()), Some(BOB.into()), Some(ADA.into())]
    );

    // The last one out closes the gate.
    let status = core.account_sign_out().await.unwrap();
    assert!(status.user.is_none());
    assert!(status.accounts.is_empty());
    assert!(matches!(
        core.require_account().await,
        Err(AppError::AccountRequired)
    ));
    assert_eq!(identities(&core).last(), Some(&None));
}

// ── refresh, per account ─────────────────────────────────────────────────

#[tokio::test]
async fn each_account_refreshes_with_its_own_token_under_its_own_lock() {
    let f = fixtures();
    let (core, _recv) = two(&f).await;
    settle().await;

    // Both about to expire. Ada's refresh hangs; Bob's must not wait on it.
    f.clock.advance(290_000);
    let release = f.account.hold("refresh:rt_a");
    f.account.push_refresh(Ok(bob(&f, "rt_b2", "org_b")));
    let lists_core = core.clone();
    let lists = tokio::spawn(async move { lists_core.account_accounts().await });
    wait_until("Ada's refresh to start", || called(&f, "refresh:rt_a")).await;

    // Bob (active) gets his token while Ada's refresh still hangs.
    let token = tokio::time::timeout(Duration::from_secs(5), core.account_access_token())
        .await
        .expect("Bob's refresh waited on Ada's lock")
        .unwrap();
    assert_eq!(token.as_deref(), Some("at-rt_b2"));
    assert!(called(&f, "refresh:rt_b"));
    assert_eq!(stored(&f, BOB).unwrap().refresh_token, "rt_b2");
    assert_eq!(
        stored(&f, ADA).unwrap().refresh_token,
        "rt_a",
        "still in flight"
    );

    f.account.push_refresh(Ok(ada(&f, "rt_a2", "org_a")));
    release.send(()).unwrap();
    lists.await.unwrap().unwrap();
    assert_eq!(stored(&f, ADA).unwrap().refresh_token, "rt_a2");
    assert_eq!(
        f.account
            .calls()
            .iter()
            .filter(|c| c.starts_with("refresh:rt_a"))
            .count(),
        1,
        "one refresh per account: {:?}",
        f.account.calls()
    );
}

#[tokio::test]
async fn a_sign_out_of_another_account_doesnt_drop_a_refresh_in_flight() {
    let f = fixtures();
    let (core, _recv) = two(&f).await;
    settle().await;
    f.clock.advance(290_000);
    let release = f.account.hold("refresh:rt_b");
    let bob_core = core.clone();
    let bob_refresh = tokio::spawn(async move { bob_core.account_access_token().await });
    wait_until("Bob's refresh to start", || called(&f, "refresh:rt_b")).await;

    core.account_sign_out_of(ADA).await.unwrap();
    f.account.push_refresh(Ok(bob(&f, "rt_b2", "org_b")));
    release.send(()).unwrap();

    assert_eq!(
        bob_refresh.await.unwrap().unwrap().as_deref(),
        Some("at-rt_b2"),
        "Ada's sign-out is not Bob's: his rotated session is kept"
    );
    assert_eq!(stored(&f, BOB).unwrap().refresh_token, "rt_b2");
}

#[tokio::test]
async fn a_sign_out_of_the_same_account_drops_its_refresh_in_flight() {
    let f = fixtures();
    let (core, _recv) = two(&f).await;
    settle().await;
    f.clock.advance(290_000);
    let release = f.account.hold("refresh:rt_b");
    let bob_core = core.clone();
    let bob_refresh = tokio::spawn(async move { bob_core.account_access_token().await });
    wait_until("Bob's refresh to start", || called(&f, "refresh:rt_b")).await;

    core.account_sign_out_of(BOB).await.unwrap();
    f.account.push_refresh(Ok(bob(&f, "rt_b2", "org_b")));
    release.send(()).unwrap();
    let _ = bob_refresh.await.unwrap();

    assert_eq!(
        stored(&f, BOB),
        None,
        "nothing written back after the sign-out"
    );
    let status = core.account_status().await.unwrap();
    assert_eq!(status.accounts.len(), 1);
    assert_eq!(status.user.as_ref().map(|u| u.id.as_str()), Some(ADA));
}

#[tokio::test]
async fn a_rejected_refresh_of_the_active_account_hands_over_to_the_next_one() {
    let f = fixtures();
    let (core, _recv) = two(&f).await;
    settle().await;
    f.clock.advance(290_000);
    f.account
        .push_refresh(Err(AccountError::Rejected("invalid_grant".into())));

    assert!(core.account_access_token().await.is_err());
    let status = core.account_status().await.unwrap();
    assert_eq!(status.user.as_ref().map(|u| u.id.as_str()), Some(ADA));
    assert!(!status.session_ended, "someone is still signed in");
    assert_eq!(status.accounts.len(), 2, "Bob stays listed");
    let bob_row = status.accounts.iter().find(|a| a.user.id == BOB).unwrap();
    assert!(bob_row.sign_in_required && !bob_row.active);
    assert_eq!(
        bob_row.organization.as_ref().map(|o| o.id.as_str()),
        Some("org_b"),
        "the last organization is kept for the row"
    );
    assert_eq!(stored(&f, BOB), None);
    assert_eq!(index(&f)["accounts"][1]["ended"], true);
    assert_eq!(identities(&core).last(), Some(&Some(ADA.into())));

    // Bob's row can't be switched to until he signs in again…
    assert!(matches!(
        core.account_switch(AccountSwitchRequest {
            user_id: BOB.into(),
            organization_id: None,
        })
        .await,
        Err(AppError::Invalid(_))
    ));
    // …which replaces the ended row.
    sign_in(&core, &f, bob(&f, "rt_b3", "org_b")).await;
    let status = core.account_status().await.unwrap();
    assert_eq!(status.user.as_ref().map(|u| u.id.as_str()), Some(BOB));
    assert_eq!(status.accounts.len(), 2);
    assert!(status.accounts.iter().all(|a| !a.sign_in_required));
}

#[tokio::test]
async fn an_ended_account_survives_a_restart_as_sign_in_required() {
    let f = fixtures();
    {
        let (core, _recv) = two(&f).await;
        settle().await;
        f.clock.advance(290_000);
        f.account
            .push_refresh(Err(AccountError::Rejected("invalid_grant".into())));
        assert!(core.account_access_token().await.is_err());
    }
    let (core, _recv) = start(&f);
    let status = core.account_status().await.unwrap();
    assert_eq!(status.user.as_ref().map(|u| u.id.as_str()), Some(ADA));
    let bob_row = status.accounts.iter().find(|a| a.user.id == BOB).unwrap();
    assert!(bob_row.sign_in_required);
    assert_eq!(bob_row.user.email, "bob@acme.example");
}

// ── organizations per account ────────────────────────────────────────────

#[tokio::test]
async fn account_accounts_lists_every_accounts_organizations_with_its_own_token() {
    let f = fixtures();
    let (core, _recv) = two(&f).await;
    // The background steps after sign-in and start list too; let them pass.
    wait_until("the background lists", || {
        called(&f, "organizations:at-rt_a") && called(&f, "organizations:at-rt_b")
    })
    .await;
    f.account
        .push_organizations(Ok(vec![org("org_a", true), org("org_c", false)]));
    f.account.push_organizations(Ok(vec![org("org_b", true)]));

    let calls_before = f.account.calls().len();
    let status = core.account_accounts().await.unwrap();
    let lists_called: Vec<String> = f.account.calls()[calls_before..]
        .iter()
        .filter(|c| c.starts_with("organizations:"))
        .cloned()
        .collect();
    assert_eq!(lists_called.len(), 2);
    assert!(lists_called.contains(&"organizations:at-rt_a".to_string()));
    assert!(lists_called.contains(&"organizations:at-rt_b".to_string()));
    // Listed side by side, so which answer which account got isn't fixed:
    // each got one of the two, and every account has its list.
    let mut lists: Vec<Vec<String>> = status
        .accounts
        .iter()
        .map(|a| a.organizations.iter().map(|o| o.id.clone()).collect())
        .collect();
    lists.sort();
    assert_eq!(
        lists,
        vec![
            vec!["org_a".to_string(), "org_c".to_string()],
            vec!["org_b".to_string()]
        ]
    );
    // The lists stay for the next status.
    assert!(
        core.account_status()
            .await
            .unwrap()
            .accounts
            .iter()
            .all(|a| !a.organizations.is_empty())
    );
}

// ── delete the account ───────────────────────────────────────────────────

#[tokio::test]
async fn deleting_the_active_account_asks_the_cloud_then_forgets_it_here() {
    let f = fixtures();
    let (core, _recv) = two(&f).await;

    let status = core.account_delete().await.unwrap();
    assert!(called(&f, "delete_account:at-rt_b"), "with Bob's own token");
    assert_eq!(status.user.as_ref().map(|u| u.id.as_str()), Some(ADA));
    assert!(!status.session_ended);
    assert_eq!(status.accounts.len(), 1);
    assert_eq!(stored(&f, BOB), None);
    assert_eq!(stored(&f, ADA).unwrap().refresh_token, "rt_a");
    assert_eq!(index(&f)["active"], ADA);
    // The sessions went with the account: no provider sign-out for it.
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!called(&f, "sign_out:session_02"));
    assert!(!called(&f, "delete_account:at-rt_a"), "Ada's untouched");
}

#[tokio::test]
async fn deleting_the_only_account_closes_the_gate() {
    let f = fixtures();
    store_legacy(&f, &ada(&f, "rt_a", "org_a"));
    let (core, _recv) = start(&f);
    core.account_status().await.unwrap();

    let status = core.account_delete().await.unwrap();
    assert!(status.user.is_none() && status.required);
    assert!(!status.session_ended);
    assert!(status.accounts.is_empty());
    assert_eq!(stored(&f, ADA), None);
    assert_eq!(
        core.account_gate().await,
        crate::usecases::account::AccountGate::SignedOut
    );
}

#[tokio::test]
async fn a_failed_deletion_keeps_the_account_signed_in() {
    let f = fixtures();
    let (core, _recv) = two(&f).await;
    f.account
        .push_delete(Err(AccountError::Network("cloud down".into())));

    let e = core.account_delete().await.unwrap_err();
    assert_eq!(e.code(), "account.network");
    let status = core.account_status().await.unwrap();
    assert_eq!(status.user.as_ref().map(|u| u.id.as_str()), Some(BOB));
    assert_eq!(status.accounts.len(), 2);
    assert_eq!(stored(&f, BOB).unwrap().refresh_token, "rt_b");

    // A retry finishes it.
    core.account_delete().await.unwrap();
    assert_eq!(stored(&f, BOB), None);
}
