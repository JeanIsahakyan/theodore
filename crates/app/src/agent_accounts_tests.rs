//! Agent accounts and usage limits (docs/plan.md "Agent accounts and
//! limits", docs/spaces.md "Usage limits"): which account a turn runs on,
//! the switch when one hits its limit, the agent fallback, the pause and
//! its scheduled continue — against `Core` + `testkit` fakes.

use std::time::Duration;

use serde_json::json;
use theodore_contract::{
    AddAgentAccountRequest, AddProjectRequest, AgentAccountRequest, ChatMessage, ChatNotice,
    CreateSpaceRequest, Project, Space, SpaceSendRequest, SpaceStatus, models,
};
use theodore_domain::{AgentId, AgentLimit, Author, LimitStatus, Sha, Usage};
use theodore_ports::{AgentEvent, Clock, NewAction, Store, SyncActionCode};

use crate::testkit::{Fixtures, fixtures};
use crate::usecases::space_limits::CONTINUE_TEXT;
use crate::usecases::spaces::space_chat_key;
use crate::{Core, Receivers};

async fn wait_until(mut cond: impl FnMut() -> bool) {
    for _ in 0..600 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("condition not met in time");
}

async fn started(f: &Fixtures) -> (Core, Receivers, Project) {
    let (core, recv) = Core::start(f.deps());
    tokio::time::sleep(Duration::from_millis(30)).await;
    let project = core
        .add_project(AddProjectRequest {
            repo: None,
            path: Some("/tmp/my-folder".into()),
        })
        .await
        .expect("add_project");
    wait_until(|| {
        f.store
            .get(models::PROJECT, &project.id)
            .unwrap()
            .is_some_and(|r| r.data["status"] == json!("ready"))
    })
    .await;
    f.git.set_resolve("main", Sha::new("base000"));
    (core, recv, project)
}

fn space(f: &Fixtures, id: &str) -> Space {
    serde_json::from_value(f.store.get(models::SPACE, id).unwrap().unwrap().data).unwrap()
}

fn transcript(f: &Fixtures, id: &str) -> Vec<ChatMessage> {
    let mut out: Vec<ChatMessage> = f
        .store
        .query(models::CHAT_MESSAGE, "pr", &space_chat_key(id).0)
        .unwrap()
        .into_iter()
        .map(|r| serde_json::from_value(r.data).unwrap())
        .collect();
    out.sort_by_key(|m| m.at);
    out
}

fn notices(f: &Fixtures, id: &str) -> Vec<ChatNotice> {
    transcript(f, id)
        .into_iter()
        .filter_map(|m| m.notice)
        .collect()
}

fn set_user(f: &Fixtures, key: &str, value: serde_json::Value) {
    f.store
        .apply(vec![NewAction {
            model: models::SETTING.into(),
            model_id: format!("user:{key}"),
            action: SyncActionCode::I,
            data: Some(json!({ "key": key, "scope": "user", "value": value })),
        }])
        .unwrap();
}

fn done(text: &str) -> Vec<AgentEvent> {
    vec![AgentEvent::Done {
        final_text: text.into(),
        usage: Usage::default(),
    }]
}

fn in_session(id: &str, reply: &str) -> Vec<AgentEvent> {
    let mut events = vec![AgentEvent::Session { id: id.into() }];
    events.extend(done(reply));
    events
}

/// A run cut off by its account's usage limit, as Claude Code ends one:
/// `rate_limit_event` rejected, then the error result.
fn limited(resets_at: i64) -> Vec<AgentEvent> {
    vec![
        AgentEvent::Text {
            text: "Half done.".into(),
        },
        AgentEvent::Limit {
            limit: AgentLimit {
                status: LimitStatus::Limited,
                resets_at: Some(resets_at),
                window: Some("five_hour".into()),
                used_pct: Some(100.0),
            },
        },
        AgentEvent::Error {
            message: "You've hit your session limit · resets 6pm".into(),
            stderr_tail: String::new(),
        },
    ]
}

fn request(project: &Project, goal: &str) -> CreateSpaceRequest {
    CreateSpaceRequest {
        project: project.id.clone(),
        goal: goal.into(),
        name: None,
        branch: None,
        base: None,
        agent: None,
        model: None,
        start_from: None,
        effort: None,
        mode: None,
    }
}

fn send_req(id: &str, text: &str) -> SpaceSendRequest {
    SpaceSendRequest {
        space: id.into(),
        text: text.into(),
        agent: None,
        model: None,
        mode: None,
        attachments: None,
        effort: None,
        mentions: None,
    }
}

/// A space whose first turn ran in Claude Code session `s1`.
async fn space_in_session(f: &Fixtures, core: &Core, project: &Project) -> Space {
    f.agents.push_script(in_session("s1", "Added the guard."));
    let s = core
        .create_space(request(project, "Add a guard"))
        .await
        .unwrap();
    wait_until(|| space(f, &s.id).status != SpaceStatus::Running).await;
    space(f, &s.id)
}

async fn add_account(core: &Core, agent: AgentId, label: &str) -> String {
    core.add_agent_account(AddAgentAccountRequest {
        agent,
        label: label.into(),
    })
    .await
    .unwrap()
    .account
    .id
}

/// Waits for the `n`th turn request, then for the space to settle.
async fn settled_after(f: &Fixtures, id: &str, n: usize) -> Space {
    wait_until(|| f.agents.requests().len() >= n).await;
    wait_until(|| space(f, id).status != SpaceStatus::Running).await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    wait_until(|| space(f, id).status != SpaceStatus::Running).await;
    space(f, id)
}

#[tokio::test]
async fn an_extra_account_has_its_own_dir_and_runs_with_it() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let work = add_account(&core, AgentId::Claude, "work").await;
    let dir = f.data_dir.path().join("agent-accounts").join(&work);
    assert!(dir.is_dir(), "its config dir is made");
    set_user(&f, "agents.claude.account", json!(work));

    let s = space_in_session(&f, &core, &project).await;
    let req = f.agents.last_request().unwrap();
    let account = req.account.expect("a turn always names its account");
    assert_eq!(account.id, work);
    assert_eq!(account.dir.as_deref(), Some(dir.as_path()));
    assert_eq!(
        s.agent_session.unwrap().account.as_deref(),
        Some(work.as_str())
    );

    // Listed with the command that signs it in, in that dir.
    let rows = core.agent_accounts().await.unwrap();
    let row = rows.iter().find(|r| r.account.id == work).unwrap();
    assert!(row.preferred);
    let cmd = row.sign_in_command.as_deref().unwrap();
    assert!(cmd.starts_with("CLAUDE_CONFIG_DIR="), "{cmd}");
    assert!(cmd.ends_with(" claude auth login"), "{cmd}");
    assert!(
        rows.iter()
            .any(|r| r.account.default && r.account.agent == AgentId::Codex)
    );

    // Removing it falls back to the default account.
    core.remove_agent_account(AgentAccountRequest {
        id: work.clone(),
        agent: AgentId::Claude,
        recheck: false,
    })
    .await
    .unwrap();
    assert!(
        core.agent_accounts()
            .await
            .unwrap()
            .iter()
            .all(|r| r.account.id != work)
    );
}

#[tokio::test]
async fn a_turn_skips_limited_and_signed_out_accounts() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let out = add_account(&core, AgentId::Claude, "out").await;
    let free = add_account(&core, AgentId::Claude, "free").await;
    f.agents
        .set_account_signed_in(AgentId::Claude, &out, Some(false));
    f.agents
        .set_account_signed_in(AgentId::Claude, &free, Some(true));
    let now = f.clock.now();
    core.note_agent_limit(
        AgentId::Claude,
        "default",
        AgentLimit::limited(Some(now + 3_600_000)),
    )
    .await;

    space_in_session(&f, &core, &project).await;
    assert_eq!(f.agents.last_request().unwrap().account.unwrap().id, free);

    // Its reset passed: the default (preferred) account is back.
    f.clock.advance(3_600_001);
    let s = core.create_space(request(&project, "Again")).await.unwrap();
    settled_after(&f, &s.id, 2).await;
    assert_eq!(
        f.agents.last_request().unwrap().account.unwrap().id,
        "default"
    );
}

#[tokio::test]
async fn a_limit_mid_turn_moves_the_session_to_the_next_account_and_continues() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let work = add_account(&core, AgentId::Claude, "work").await;
    f.agents
        .set_account_signed_in(AgentId::Claude, &work, Some(true));
    f.agents.set_carry(true);
    let s = space_in_session(&f, &core, &project).await;
    let before = f.agents.requests().len();
    let resets = f.clock.now() + 2 * 3_600_000;

    f.agents.push_script(limited(resets));
    f.agents.push_script(in_session("s1", "Finished it."));
    core.space_send(send_req(&s.id, "Add the tests"))
        .await
        .unwrap();
    let s = settled_after(&f, &s.id, before + 2).await;

    let reqs = f.agents.requests();
    let (cut, cont) = (&reqs[before], &reqs[before + 1]);
    assert_eq!(cut.account.as_ref().unwrap().id, "default");
    assert_eq!(cut.resume.as_deref(), Some("s1"));
    assert_eq!(cont.account.as_ref().unwrap().id, work);
    assert_eq!(cont.resume.as_deref(), Some("s1"), "the same conversation");
    assert_eq!(cont.prompt, CONTINUE_TEXT);
    assert_eq!(
        f.agents.carried(),
        vec![("s1".to_string(), "default".to_string(), work.clone())]
    );

    // The account is known limited, here and in the store.
    let row = core.account_limit(AgentId::Claude, "default").unwrap();
    assert_eq!(row.limit.status, LimitStatus::Limited);
    assert!(
        f.store
            .get(models::AGENT_LIMIT, "claude:default")
            .unwrap()
            .is_some()
    );

    // The chat says so, then goes on.
    assert_eq!(
        notices(&f, &s.id),
        vec![ChatNotice::AccountSwitch {
            from: "Claude · default".into(),
            to: "Claude · work".into(),
            resets_at: Some(resets),
            continued: true,
        }]
    );
    let t = transcript(&f, &s.id);
    let notice = t.iter().find(|m| m.notice.is_some()).unwrap();
    assert!(
        notice
            .text
            .starts_with("Claude · default hit its limit (resets ")
    );
    assert!(notice.text.ends_with("): continuing on Claude · work"));
    assert!(
        t.iter()
            .any(|m| m.author == Author::Me && m.text == CONTINUE_TEXT)
    );
    assert!(t.iter().any(|m| m.text == "Finished it."));
    assert_eq!(s.status, SpaceStatus::Idle);
    let session = s.agent_session.unwrap();
    assert_eq!((session.id.as_str(), session.account), ("s1", Some(work)));
}

#[tokio::test]
async fn a_session_that_cant_move_is_replayed_on_the_next_account() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let work = add_account(&core, AgentId::Claude, "work").await;
    f.agents
        .set_account_signed_in(AgentId::Claude, &work, Some(true));
    let s = space_in_session(&f, &core, &project).await;
    let before = f.agents.requests().len();

    f.agents.push_script(limited(f.clock.now() + 60_000));
    f.agents.push_script(in_session("s9", "Finished it."));
    core.space_send(send_req(&s.id, "Add the tests"))
        .await
        .unwrap();
    let s = settled_after(&f, &s.id, before + 2).await;

    let cont = &f.agents.requests()[before + 1];
    assert_eq!(cont.account.as_ref().unwrap().id, work);
    assert_eq!(cont.resume, None, "a new session that hears the transcript");
    assert!(
        cont.prompt.contains("Conversation so far:"),
        "{}",
        cont.prompt
    );
    assert!(cont.prompt.ends_with(CONTINUE_TEXT));
    assert_eq!(s.agent_session.unwrap().id, "s9");
}

#[tokio::test]
async fn with_every_account_limited_it_falls_back_to_the_next_agent_in_order() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    set_user(&f, "agents.fallback_agents", json!(["gemini", "codex"]));
    f.agents.set_signed_in(AgentId::Gemini, Some(false));
    let s = space_in_session(&f, &core, &project).await;
    let before = f.agents.requests().len();

    f.agents.push_script(limited(f.clock.now() + 60_000));
    f.agents.push_script(in_session("t1", "Codex finished it."));
    core.space_send(send_req(&s.id, "Add the tests"))
        .await
        .unwrap();
    let s = settled_after(&f, &s.id, before + 2).await;

    let cont = &f.agents.requests()[before + 1];
    assert_eq!(cont.agent, AgentId::Codex, "gemini is signed out");
    assert_eq!(cont.resume, None);
    assert_eq!(s.agent, AgentId::Codex);
    assert!(matches!(
        &notices(&f, &s.id)[..],
        [ChatNotice::AccountSwitch { to, .. }] if to == "Codex · default"
    ));
}

#[tokio::test]
async fn with_nothing_left_the_space_waits_for_the_reset_and_then_continues() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let s = space_in_session(&f, &core, &project).await;
    let before = f.agents.requests().len();
    let resets = f.clock.now() + 3_600_000;

    f.agents.push_script(limited(resets));
    core.space_send(send_req(&s.id, "Add the tests"))
        .await
        .unwrap();
    wait_until(|| space(&f, &s.id).paused.is_some()).await;
    let s = space(&f, &s.id);
    let pause = s.paused.clone().unwrap();
    assert_eq!(pause.until, Some(resets));
    assert_eq!(pause.agent, AgentId::Claude);
    assert_eq!(s.status, SpaceStatus::Failed);
    assert!(matches!(
        &notices(&f, &s.id)[..],
        [ChatNotice::LimitHit { .. }]
    ));
    assert_eq!(
        f.agents.requests().len(),
        before + 1,
        "nothing continued yet"
    );

    // Not yet.
    assert_eq!(core.continue_due_pauses().await, 0);
    // The reset comes: it continues on its own, on the account that reset.
    f.clock.advance(3_600_000);
    f.agents.push_script(in_session("s1", "Finished it."));
    assert_eq!(core.continue_due_pauses().await, 1);
    let s = settled_after(&f, &s.id, before + 2).await;
    let cont = &f.agents.requests()[before + 1];
    assert_eq!(cont.prompt, CONTINUE_TEXT);
    assert_eq!(cont.resume.as_deref(), Some("s1"));
    assert_eq!(s.paused, None);
    assert_eq!(s.status, SpaceStatus::Idle);
}

#[tokio::test]
async fn a_pause_can_be_cancelled_or_continued_at_once() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let s = space_in_session(&f, &core, &project).await;
    let before = f.agents.requests().len();
    f.agents.push_script(limited(f.clock.now() + 3_600_000));
    core.space_send(send_req(&s.id, "Add the tests"))
        .await
        .unwrap();
    wait_until(|| space(&f, &s.id).paused.is_some()).await;

    core.space_pause_cancel(&s.id).await.unwrap();
    assert_eq!(space(&f, &s.id).paused, None);
    f.clock.advance(4 * 3_600_000);
    assert_eq!(core.continue_due_pauses().await, 0, "cancelled for good");

    // Paused again; "Continue now" goes at once, whatever the reset says.
    f.agents.push_script(limited(f.clock.now() + 3_600_000));
    core.space_send(send_req(&s.id, "Again")).await.unwrap();
    wait_until(|| space(&f, &s.id).paused.is_some()).await;
    f.agents.push_script(done("ok then"));
    core.space_pause_continue(&s.id).await.unwrap();
    settled_after(&f, &s.id, before + 3).await;
    assert_eq!(f.agents.requests()[before + 2].prompt, CONTINUE_TEXT);
    assert_eq!(space(&f, &s.id).paused, None);
}

#[tokio::test]
async fn with_auto_continue_off_it_only_says_so() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    set_user(&f, "agents.auto_continue", json!(false));
    let work = add_account(&core, AgentId::Claude, "work").await;
    let s = space_in_session(&f, &core, &project).await;
    let before = f.agents.requests().len();

    f.agents.push_script(limited(f.clock.now() + 60_000));
    core.space_send(send_req(&s.id, "Add the tests"))
        .await
        .unwrap();
    wait_until(|| !notices(&f, &s.id).is_empty()).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        f.agents.requests().len(),
        before + 1,
        "nothing sent on its own"
    );
    assert!(matches!(
        &notices(&f, &s.id)[..],
        [ChatNotice::AccountSwitch {
            continued: false,
            ..
        }]
    ));
    assert_eq!(space(&f, &s.id).paused, None);

    // The next turn starts on the account that isn't limited.
    f.agents.push_script(done("ok"));
    core.space_send(send_req(&s.id, "go on")).await.unwrap();
    settled_after(&f, &s.id, before + 2).await;
    assert_eq!(f.agents.last_request().unwrap().account.unwrap().id, work);
}

#[tokio::test]
async fn limits_and_pauses_survive_a_restart() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let s = space_in_session(&f, &core, &project).await;
    let resets = f.clock.now() + 3_600_000;
    f.agents.push_script(limited(resets));
    core.space_send(send_req(&s.id, "Add the tests"))
        .await
        .unwrap();
    wait_until(|| space(&f, &s.id).paused.is_some()).await;
    core.shutdown();
    drop(core);

    // A new process on the same store: the limit and the pause are there.
    let (core, _recv) = Core::start(f.deps());
    let row = core.account_limit(AgentId::Claude, "default").unwrap();
    assert_eq!(row.limit.resets_at, Some(resets));
    assert_eq!(space(&f, &s.id).paused.unwrap().until, Some(resets));
    let before = f.agents.requests().len();
    f.clock.advance(3_600_000);
    f.agents.push_script(done("back"));
    assert_eq!(core.continue_due_pauses().await, 1);
    settled_after(&f, &s.id, before + 1).await;
    assert_eq!(f.agents.last_request().unwrap().prompt, CONTINUE_TEXT);
}
