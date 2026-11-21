//! Reaching any space on this computer (docs/spaces.md "Sub-spaces"):
//! `space_ask` answers from the other space's own agent context — a
//! read-only fork of its Claude session, or a fresh read-only agent —
//! and leaves that space as it was; `space_send` and `space_answer` reach
//! any local space, marked as from the caller in its chat and its agent's
//! prompt.

use theodore_contract::{
    AskedBy, ChatMessage, FromSpace, Space, SpaceMode, SpaceNote, SpaceRemote, SpaceStatus, models,
};
use theodore_domain::{AgentId, Author, Usage};
use theodore_ports::{
    AgentEvent, AgentMode, AgentRequest, LocalAnswer, NewAction, OTHER_SPACE_NOTE, Store,
    SyncActionCode, UserQuestion,
};

use crate::space_children_tests::{code, parent, put_setting, send};
use crate::space_commands_tests::{Env, done, start_env, wait_until};
use crate::usecases::spaces::space_chat_key;

/// A `space_ask` run (never a turn, a name or a summary).
fn is_ask(r: &AgentRequest) -> bool {
    r.prompt.contains("Question from the agent of space")
}

fn asks(e: &Env) -> Vec<AgentRequest> {
    e.f.agents
        .utility_requests()
        .into_iter()
        .filter(is_ask)
        .collect()
}

fn session(id: &str, text: &str) -> Vec<AgentEvent> {
    vec![
        AgentEvent::Session { id: id.into() },
        AgentEvent::Done {
            final_text: text.into(),
            usage: Usage::default(),
        },
    ]
}

fn patch(e: &Env, id: &str, data: serde_json::Value) {
    e.f.store
        .apply(vec![NewAction {
            model: models::SPACE.into(),
            model_id: id.into(),
            action: SyncActionCode::C,
            data: Some(data),
        }])
        .unwrap();
}

/// Another top-level space whose first turn is over; its Claude session
/// is `session_id` when set.
async fn other(e: &Env, goal: &str, session_id: Option<&str>) -> Space {
    match session_id {
        Some(id) => e.f.agents.push_script(session(id, "Built it on SQLite.")),
        None => e.f.agents.push_script(done("Built it on SQLite.")),
    }
    let s = e.create(goal).await;
    e.until(&s.id, |s| s.turns == 1 && s.run.is_none()).await
}

async fn history(e: &Env, id: &str) -> Vec<ChatMessage> {
    e.core.space_history(&e.space(id)).await.unwrap()
}

// ── space_ask ───────────────────────────────────────────────────────────

#[tokio::test]
async fn ask_forks_the_spaces_claude_session_read_only_and_leaves_it_as_it_was() {
    let e = start_env(true).await;
    let a = parent(&e).await;
    let b = other(&e, "Pick a store", Some("sess-b")).await;
    assert_eq!(b.agent, AgentId::Claude);
    assert_eq!(b.agent_session.as_ref().unwrap().id, "sess-b");
    let b_messages = history(&e, &b.id).await.len();
    let a_messages = history(&e, &a.id).await.len();
    e.f.agents.push_tagged(
        |r| is_ask(r) && r.fork_session,
        session("fork-1", "SQLite, in store.rs."),
    );

    let answer = e
        .core
        .sub_space_ask(&a.id, &b.id, "Which store did you pick?")
        .await
        .unwrap();
    assert_eq!(answer.answer, "SQLite, in store.rs.");
    assert_eq!(answer.how, "fork");
    assert_eq!(answer.agent, "claude");
    assert_eq!(answer.note, OTHER_SPACE_NOTE);
    assert_eq!(answer.space.space, b.id);

    let reqs = asks(&e);
    assert_eq!(reqs.len(), 1, "the fork answered: no fresh read");
    let r = &reqs[0];
    assert_eq!(r.agent, AgentId::Claude);
    assert_eq!(r.resume.as_deref(), Some("sess-b"));
    assert!(r.fork_session);
    assert_eq!(r.mode, AgentMode::ReadOnly);
    assert!(r.mcp.is_none(), "no space-tools: no asking further");
    assert!(!r.user_mcp);
    assert!(!r.stream_text);
    assert_eq!(r.cwd.display().to_string(), b.worktree);
    assert!(
        r.prompt.contains("Which store did you pick?"),
        "{}",
        r.prompt
    );
    assert!(r.prompt.contains("not from the user"), "{}", r.prompt);
    assert!(r.system.as_deref().unwrap().contains("Read only"));

    // Nothing in either space changed: no message, no turn, same session.
    let after = e.space(&b.id);
    assert_eq!(after.agent_session.as_ref().unwrap().id, "sess-b");
    assert_eq!((after.turns, &after.head_sha), (b.turns, &b.head_sha));
    assert_eq!(history(&e, &b.id).await.len(), b_messages);
    assert_eq!(history(&e, &a.id).await.len(), a_messages);

    // B's next real turn continues its own session, not the fork.
    e.f.agents.push_script(done("ok"));
    e.core.space_send(send(&b.id, "Go on")).await.unwrap();
    e.until(&b.id, |s| s.turns == 2 && s.run.is_none()).await;
    let next = e.f.agents.last_request().unwrap();
    assert_eq!(next.resume.as_deref(), Some("sess-b"));
    assert!(!next.fork_session);
    assert_eq!(
        e.space(&b.id).agent_session.unwrap().id,
        "sess-b",
        "the fork's id never reached the space"
    );
}

#[tokio::test]
async fn a_failed_fork_falls_back_to_a_fresh_read() {
    let e = start_env(true).await;
    let a = parent(&e).await;
    let b = other(&e, "Pick a store", Some("sess-b")).await;
    e.f.agents.push_tagged(
        |r| is_ask(r) && r.fork_session,
        vec![AgentEvent::Error {
            message: "No conversation found".into(),
            stderr_tail: String::new(),
        }],
    );
    e.f.agents
        .push_tagged(|r| is_ask(r) && !r.fork_session, done("SQLite."));
    let answer = e
        .core
        .sub_space_ask(&a.id, &b.id, "Which store?")
        .await
        .unwrap();
    assert_eq!((answer.how, answer.answer.as_str()), ("fresh", "SQLite."));
    let reqs = asks(&e);
    assert_eq!(reqs.len(), 2);
    let fresh = &reqs[1];
    assert_eq!(fresh.resume, None);
    assert!(!fresh.fork_session);
    assert_eq!(fresh.mode, AgentMode::ReadOnly);
    assert!(fresh.mcp.is_none());
    assert_eq!(fresh.cwd.display().to_string(), b.worktree);
    assert!(fresh.prompt.contains("Pick a store"), "its goal");
    assert!(fresh.prompt.contains("Built it on SQLite."), "its turns");
    assert!(fresh.prompt.contains("against the base"), "its diff");
    assert!(fresh.prompt.ends_with("Which store?"), "{}", fresh.prompt);
    assert_eq!(e.space(&b.id).agent_session.unwrap().id, "sess-b");
}

#[tokio::test]
async fn without_a_claude_session_a_fresh_agent_of_the_space_answers() {
    let e = start_env(true).await;
    let a = parent(&e).await;
    let b = other(&e, "Pick a store", None).await;
    assert!(b.agent_session.is_none());
    let answer = e.core.sub_space_ask(&a.id, &b.id, "Which?").await.unwrap();
    assert_eq!((answer.how, answer.agent.as_str()), ("fresh", "claude"));
    assert_eq!(asks(&e).len(), 1);

    // A Codex session can't be forked: a fresh Codex agent answers.
    let c = other(&e, "Port it", None).await;
    patch(
        &e,
        &c.id,
        serde_json::json!({
            "agent": "codex",
            "agent_session": { "agent": "codex", "id": "thread-1", "cwd": c.worktree },
        }),
    );
    let answer = e.core.sub_space_ask(&a.id, &c.id, "Done?").await.unwrap();
    assert_eq!((answer.how, answer.agent.as_str()), ("fresh", "codex"));
    let r = asks(&e).pop().unwrap();
    assert_eq!(r.agent, AgentId::Codex);
    assert_eq!(r.resume, None);
    assert!(!r.fork_session);
}

#[tokio::test]
async fn ask_refuses_itself_mirrors_hosted_and_archived_spaces() {
    let e = start_env(true).await;
    let a = parent(&e).await;
    let r = e.core.sub_space_ask(&a.id, &a.id, "Who am I?").await;
    assert_eq!(code(r), "sub_spaces.self");
    let r = e.core.sub_space_ask(&a.id, "nope", "?").await;
    assert_eq!(code(r), "sub_spaces.unknown");

    let mirror = other(&e, "Mirrored", None).await;
    let remote = SpaceRemote {
        space: "rs_1".into(),
        host_device: "dev_2".into(),
        host_name: "Studio".into(),
        project_name: "widget".into(),
        started_here: true,
    };
    patch(&e, &mirror.id, serde_json::json!({ "remote": remote }));
    let r = e.core.sub_space_ask(&a.id, &mirror.id, "?").await;
    assert_eq!(code(r), "sub_spaces.remote");

    let hosted = other(&e, "Hosted", None).await;
    e.core
        .fleet()
        .hosting
        .insert(hosted.id.clone(), "dev_x".into());
    let r = e.core.sub_space_ask(&a.id, &hosted.id, "?").await;
    assert_eq!(code(r), "sub_spaces.hosted");
    // A hosted space reads and asks this computer's own spaces, but not
    // one hosted for another device.
    let elsewhere = other(&e, "Hosted elsewhere", None).await;
    e.core
        .fleet()
        .hosting
        .insert(elsewhere.id.clone(), "dev_y".into());
    let r = e.core.sub_space_ask(&hosted.id, &elsewhere.id, "?").await;
    assert_eq!(code(r), "sub_spaces.hosted");

    let gone = other(&e, "Archived", None).await;
    e.core.archive_space(&gone.id).await.unwrap();
    let r = e.core.sub_space_ask(&a.id, &gone.id, "?").await;
    assert_eq!(code(r), "sub_spaces.archived");

    let b = other(&e, "Fine", None).await;
    let r = e.core.sub_space_ask(&a.id, &b.id, "  ").await;
    assert_eq!(code(r), "sub_spaces.invalid");
    assert!(asks(&e).is_empty(), "no agent ran for a refusal");

    // `spaces.sub_spaces` off: asking stays, like reading.
    put_setting(&e, "spaces.sub_spaces", serde_json::json!(false));
    e.core.sub_space_ask(&a.id, &b.id, "Still?").await.unwrap();
}

#[tokio::test]
async fn at_most_two_asks_run_at_once_per_asking_space() {
    let e = start_env(true).await;
    let a = parent(&e).await;
    let b = other(&e, "Pick a store", None).await;
    let spawn = || {
        let (core, a, b) = (e.core.clone(), a.id.clone(), b.id.clone());
        tokio::spawn(async move { core.sub_space_ask(&a, &b, "Slow?").await })
    };
    e.f.agents.hang_matching(is_ask);
    e.f.agents.hang_matching(is_ask);
    let first = spawn();
    let _second = spawn();
    wait_until(|| asks(&e).len() == 2).await;
    let third = e.core.sub_space_ask(&a.id, &b.id, "One more?").await;
    assert_eq!(code(third), "sub_spaces.asks");

    // Per asking space: another one still may.
    let c = other(&e, "Third", None).await;
    e.core.sub_space_ask(&c.id, &b.id, "Me?").await.unwrap();

    // One gone (its caller dropped it): a slot frees.
    first.abort();
    let _ = first.await;
    e.core.sub_space_ask(&a.id, &b.id, "Now?").await.unwrap();
}

#[tokio::test]
async fn an_ask_without_an_answer_in_time_times_out() {
    let e = start_env(true).await;
    put_setting(&e, "spaces.ask_timeout_secs", serde_json::json!(1));
    let a = parent(&e).await;
    let b = other(&e, "Pick a store", None).await;
    e.f.agents.hang_matching(is_ask);
    let r = e.core.sub_space_ask(&a.id, &b.id, "Slow?").await;
    assert_eq!(code(r), "sub_spaces.timeout");
    // B's owner still sees it was asked, and that no answer came.
    let n = notes(&e, &b.id);
    assert_eq!(n.len(), 1);
    assert_eq!(n[0].ask.question, "Slow?");
    assert_eq!(n[0].ask.answer, None);
    let failed = n[0].ask.failed.as_deref().unwrap();
    assert!(failed.contains("no answer within 1 s"), "{failed}");
    assert!(!failed.contains("sub_spaces."), "{failed}");
    assert_eq!(n[0].ask.how.as_deref(), Some("fresh"));
    // Its slot is back.
    e.core.sub_space_ask(&a.id, &b.id, "Now?").await.unwrap();
    assert_eq!(notes(&e, &b.id).len(), 2);
}

/// `space_note` rows of `space`, by time.
pub(crate) fn notes(e: &Env, space: &str) -> Vec<SpaceNote> {
    let mut n: Vec<SpaceNote> =
        e.f.store
            .query(models::SPACE_NOTE, "pr", &space_chat_key(space).0)
            .unwrap()
            .into_iter()
            .map(|r| serde_json::from_value(r.data).unwrap())
            .collect();
    n.sort_by_key(|n| n.at);
    n
}

#[tokio::test]
async fn an_ask_leaves_one_note_in_the_space_its_agent_never_sees() {
    let e = start_env(true).await;
    let a = parent(&e).await;
    let b = other(&e, "Pick a store", None).await;
    e.f.agents.push_tagged(is_ask, done("ANSWER-7731: SQLite."));
    e.core
        .sub_space_ask(&a.id, &b.id, "QUESTION-7731: which store?")
        .await
        .unwrap();

    // Exactly one note, in B only: who asked, what, the answer, by whom.
    let n = notes(&e, &b.id);
    assert_eq!(n.len(), 1);
    assert!(notes(&e, &a.id).is_empty());
    let ask = &n[0].ask;
    assert_eq!(
        ask.from,
        AskedBy::Space {
            space: a.id.clone(),
            title: crate::usecases::space_children::title_of(&e.space(&a.id)),
        }
    );
    assert_eq!(ask.question, "QUESTION-7731: which store?");
    assert_eq!(ask.answer.as_deref(), Some("ANSWER-7731: SQLite."));
    assert_eq!(ask.failed, None);
    assert_eq!(ask.agent, Some(AgentId::Claude));
    assert_eq!(ask.how.as_deref(), Some("fresh"));
    // Loaded with B's chat, for its timeline.
    let boot = e
        .core
        .bootstrap(theodore_contract::BootstrapScope::Pr(space_chat_key(&b.id)))
        .await
        .unwrap();
    let noted = boot.rows.iter().filter(|r| r.model == models::SPACE_NOTE);
    assert_eq!(noted.count(), 1);

    // Not in B's transcript, nor what another space reads of it.
    let leaked = |s: &str| s.contains("7731");
    assert!(!history(&e, &b.id).await.iter().any(|m| leaked(&m.text)));
    let read = e.core.sub_space_read(&a.id, &b.id, 50).await.unwrap();
    assert!(!read.messages.iter().any(|m| leaked(&m.text)));
    assert!(
        !leaked(&serde_json::to_string(&read).unwrap()),
        "space_read lists no note"
    );

    // B's next turn replays its history (no session to resume): no note.
    e.f.agents.push_script(done("ok"));
    e.core.space_send(send(&b.id, "Go on")).await.unwrap();
    e.until(&b.id, |s| s.turns == 2 && s.run.is_none()).await;
    let next = e.f.agents.last_request().unwrap();
    assert!(next.resume.is_none());
    assert!(next.prompt.contains("Go on"), "{}", next.prompt);
    assert!(next.prompt.contains("Built it on SQLite."), "replayed");
    assert!(!leaked(&next.prompt), "{}", next.prompt);
    assert_eq!(e.space(&b.id).turns, 2, "the ask was never a turn");
}

#[tokio::test]
async fn a_running_space_is_asked_from_its_last_saved_session() {
    let e = start_env(true).await;
    let a = parent(&e).await;
    let b = other(&e, "Pick a store", Some("sess-b")).await;
    e.f.agents.hang_next_run();
    e.core.space_send(send(&b.id, "Go on")).await.unwrap();
    e.until(&b.id, |s| s.status == SpaceStatus::Running).await;
    let answer = e.core.sub_space_ask(&a.id, &b.id, "Which?").await.unwrap();
    assert_eq!(answer.how, "fork");
    assert_eq!(asks(&e)[0].resume.as_deref(), Some("sess-b"));
    e.core.space_stop(&b.id).await.unwrap();
    e.until(&b.id, |s| s.status != SpaceStatus::Running).await;
}

#[tokio::test]
async fn every_turn_is_told_it_may_ask_another_space() {
    let e = start_env(true).await;
    let _a = parent(&e).await;
    let system = e.f.agents.last_request().unwrap().system.unwrap();
    assert!(system.contains("space_ask"), "{system}");
}

// ── space_send / space_answer to any space ──────────────────────────────

#[tokio::test]
async fn a_space_messages_any_other_marked_as_from_it() {
    let e = start_env(true).await;
    let a = parent(&e).await;
    let o = other(&e, "Someone else's", None).await;
    assert!(o.parent.is_none(), "not a child");
    e.f.agents.push_script(done("Switched."));
    e.core
        .sub_space_send(&a.id, SpaceMode::Edit, &o.id, "Use SQLite", None)
        .await
        .unwrap();
    e.until(&o.id, |s| s.turns == 2 && s.run.is_none()).await;
    let sent = history(&e, &o.id)
        .await
        .into_iter()
        .find(|m| m.text == "Use SQLite")
        .unwrap();
    assert_eq!(sent.author, Author::Me);
    let from = sent.from_space.unwrap();
    assert_eq!(from.space, a.id);
    assert_eq!(from.title, "Split the work");
    // Its agent hears who sent it.
    let prompt = e.f.agents.last_request().unwrap().prompt;
    assert!(
        prompt.contains("from the agent of another space") && prompt.contains("Use SQLite"),
        "{prompt}"
    );
    assert!(prompt.contains(&a.id), "{prompt}");
    // And so does a reader.
    let read = e.core.sub_space_read(&a.id, &o.id, 10).await.unwrap();
    let m = read
        .messages
        .iter()
        .find(|m| m.text == "Use SQLite")
        .unwrap();
    assert_eq!(m.from, format!("space:{}", a.id));
}

#[tokio::test]
async fn a_message_to_a_running_space_is_queued_and_keeps_its_sender() {
    let e = start_env(true).await;
    let a = parent(&e).await;
    let o = other(&e, "Someone else's", None).await;
    let go = e.f.agents.pause_next_run();
    e.core.space_send(send(&o.id, "Go on")).await.unwrap();
    e.until(&o.id, |s| s.status == SpaceStatus::Running).await;
    e.core
        .sub_space_send(&a.id, SpaceMode::Edit, &o.id, "Also add tests", None)
        .await
        .unwrap();
    let queued = history(&e, &o.id).await;
    let queued = e
        .core
        .queued_messages(&o.id)
        .await
        .unwrap()
        .into_iter()
        .chain(queued)
        .find(|m| m.text == "Also add tests")
        .unwrap();
    assert!(queued.queued.is_some(), "waits for the running turn");
    assert_eq!(queued.from_space.unwrap().space, a.id);

    e.f.agents.push_script(done("tests added"));
    go.send(()).unwrap();
    e.until(&o.id, |s| s.turns == 3 && s.run.is_none()).await;
    let prompt = e.f.agents.last_request().unwrap().prompt;
    assert!(
        prompt.contains("from the agent of another space") && prompt.contains("Also add tests"),
        "{prompt}"
    );
}

#[tokio::test]
async fn a_send_to_another_space_is_capped_by_the_turn_and_its_mode() {
    let e = start_env(true).await;
    let a = parent(&e).await;
    let o = other(&e, "Someone else's", None).await;
    for turn in [SpaceMode::Ask, SpaceMode::Plan] {
        let r = e.core.sub_space_send(&a.id, turn, &o.id, "x", None).await;
        assert_eq!(code(r), "sub_spaces.mode", "{turn:?}");
    }
    let r = e
        .core
        .sub_space_send(&a.id, SpaceMode::Edit, &o.id, "x", Some("run"))
        .await;
    assert_eq!(code(r), "sub_spaces.mode", "above the turn");
    patch(&e, &o.id, serde_json::json!({ "mode": "plan" }));
    let r = e
        .core
        .sub_space_send(&a.id, SpaceMode::Run, &o.id, "x", Some("edit"))
        .await;
    assert_eq!(code(r), "sub_spaces.mode", "above the space's own");
    let r = e
        .core
        .sub_space_send(&a.id, SpaceMode::Run, &o.id, "x", Some("ask"))
        .await;
    assert_eq!(code(r), "sub_spaces.mode", "never lowers another's mode");
    e.f.agents.push_script(done("planned"));
    e.core
        .sub_space_send(&a.id, SpaceMode::Run, &o.id, "Plan it", None)
        .await
        .unwrap();
    e.until(&o.id, |s| s.turns == 2 && s.run.is_none()).await;
    assert_eq!(e.f.agents.last_request().unwrap().mode, AgentMode::Plan);
    let row = e.core.space_row(&o.id).await.unwrap();
    assert_eq!(row.mode, SpaceMode::Plan, "its mode is its own");
}

#[tokio::test]
async fn a_send_never_changes_another_spaces_mode() {
    let e = start_env(true).await;
    let a = parent(&e).await;
    let o = other(&e, "Someone else's", None).await;
    patch(&e, &o.id, serde_json::json!({ "mode": "run" }));
    let r = e
        .core
        .sub_space_send(&a.id, SpaceMode::Edit, &o.id, "x", None)
        .await;
    assert_eq!(
        code(r),
        "sub_spaces.mode",
        "its Run is above this Edit turn"
    );
    let row = e.core.space_row(&o.id).await.unwrap();
    assert_eq!(row.mode, SpaceMode::Run);
}

#[tokio::test]
async fn send_and_answer_refuse_itself_mirrors_and_hosted_spaces() {
    let e = start_env(true).await;
    let a = parent(&e).await;
    let turn = SpaceMode::Edit;
    let r = e.core.sub_space_send(&a.id, turn, &a.id, "x", None).await;
    assert_eq!(code(r), "sub_spaces.self");
    let mirror = other(&e, "Mirrored", None).await;
    let remote = SpaceRemote {
        space: "rs_1".into(),
        host_device: "dev_2".into(),
        host_name: "Studio".into(),
        project_name: "widget".into(),
        started_here: true,
    };
    patch(&e, &mirror.id, serde_json::json!({ "remote": remote }));
    let r = e
        .core
        .sub_space_send(&a.id, turn, &mirror.id, "x", None)
        .await;
    assert_eq!(code(r), "sub_spaces.remote");
    let r = e
        .core
        .sub_space_answer(&a.id, turn, &mirror.id, "q", vec![])
        .await;
    assert_eq!(code(r), "sub_spaces.remote");
    let hosted = other(&e, "Hosted", None).await;
    e.core
        .fleet()
        .hosting
        .insert(hosted.id.clone(), "dev_x".into());
    let r = e
        .core
        .sub_space_send(&a.id, turn, &hosted.id, "x", None)
        .await;
    assert_eq!(code(r), "sub_spaces.hosted");
    let r = e
        .core
        .sub_space_answer(&a.id, turn, &hosted.id, "q", vec![])
        .await;
    assert_eq!(code(r), "sub_spaces.hosted");
    // Nor does a hosted space steer this computer's own spaces.
    let r = e
        .core
        .sub_space_send(&hosted.id, turn, &a.id, "x", None)
        .await;
    assert_eq!(code(r), "sub_spaces.hosted");
    let r = e
        .core
        .sub_space_answer(&hosted.id, turn, &a.id, "q", vec![])
        .await;
    assert_eq!(code(r), "sub_spaces.hosted");
}

#[tokio::test]
async fn a_space_answers_another_ones_question_and_is_named() {
    let e = start_env(true).await;
    let a = parent(&e).await;
    let o = other(&e, "Pick a store", None).await;
    e.f.agents.hang_next_run();
    e.core.space_send(send(&o.id, "Go on")).await.unwrap();
    let run = e
        .until(&o.id, |s| s.status == SpaceStatus::Running)
        .await
        .run
        .unwrap();
    let asking = tokio::spawn({
        let (core, id) = (e.core.clone(), o.id.clone());
        async move {
            core.space_tool_ask(
                &id,
                &run,
                vec![UserQuestion {
                    question: "Which store?".into(),
                    options: vec!["SQLite".into(), "Postgres".into()],
                    multi: false,
                }],
            )
            .await
        }
    });
    wait_until(|| e.space(&o.id).question.is_some()).await;
    let ask = e.space(&o.id).question.unwrap().id;
    e.core
        .sub_space_answer(
            &a.id,
            SpaceMode::Edit,
            &o.id,
            &ask,
            vec![LocalAnswer {
                selected: vec!["SQLite".into()],
                other: None,
            }],
        )
        .await
        .unwrap();
    let answers = asking.await.unwrap().unwrap();
    assert_eq!(answers[0].selected, ["SQLite"]);
    let by = answers[0].answered_by.as_deref().unwrap();
    assert!(by.contains("Split the work") && by.contains(&a.id), "{by}");
    assert!(by.contains("not the user"), "{by}");
    e.core.space_stop(&o.id).await.unwrap();
    e.until(&o.id, |s| s.status != SpaceStatus::Running).await;
}

#[tokio::test]
async fn your_own_answer_names_no_one() {
    let e = start_env(true).await;
    let o = other(&e, "Pick a store", None).await;
    e.f.agents.hang_next_run();
    e.core.space_send(send(&o.id, "Go on")).await.unwrap();
    let run = e
        .until(&o.id, |s| s.status == SpaceStatus::Running)
        .await
        .run
        .unwrap();
    let asking = tokio::spawn({
        let (core, id) = (e.core.clone(), o.id.clone());
        async move {
            core.space_tool_ask(
                &id,
                &run,
                vec![UserQuestion {
                    question: "Which store?".into(),
                    options: vec!["SQLite".into(), "Postgres".into()],
                    multi: false,
                }],
            )
            .await
        }
    });
    wait_until(|| e.space(&o.id).question.is_some()).await;
    let ask = e.space(&o.id).question.unwrap().id;
    e.core
        .answer_space_question(theodore_contract::SpaceAnswerRequest {
            space: o.id.clone(),
            question: ask,
            answers: vec![theodore_contract::SpaceAnswerItem {
                selected: vec!["SQLite".into()],
                other: None,
            }],
        })
        .await
        .unwrap();
    let answers = asking.await.unwrap().unwrap();
    assert_eq!(answers[0].answered_by, None);
    e.core.space_stop(&o.id).await.unwrap();
    e.until(&o.id, |s| s.status != SpaceStatus::Running).await;
}

#[test]
fn a_replayed_transcript_names_the_sending_space() {
    let m = |from: Option<FromSpace>| ChatMessage {
        id: "m".into(),
        pr: theodore_domain::PrId("space:o".into()),
        author: Author::Me,
        text: "Use SQLite".into(),
        refs: vec![],
        at: 1,
        failed: None,
        attachments: vec![],
        queued: None,
        from_tasks: vec![],
        activity: vec![],
        duration_ms: None,
        changed_files: vec![],
        model: None,
        model_resolved: false,
        text_in_steps: false,
        run: None,
        vote: None,
        effort: None,
        effort_resolved: false,
        mode: None,
        from_space: from,
        notice: None,
        mentions: vec![],
    };
    let from = FromSpace {
        space: "a1".into(),
        title: "Split the work".into(),
    };
    let out = crate::usecases::spaces::turn_prompt(&[m(Some(from)), m(None)], "next");
    assert!(
        out.contains("[agent of space \"Split the work\"]\nUse SQLite"),
        "{out}"
    );
    assert!(out.contains("[user]\nUse SQLite"), "{out}");
}
