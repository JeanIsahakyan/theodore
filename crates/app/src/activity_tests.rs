//! Votes and activity events (docs/telemetry.md "Product events") against
//! `Core` + `testkit` fakes: a vote is kept on its reply, each event fires
//! once, and none carries text.

use std::collections::BTreeSet;
use std::time::Duration;

use serde_json::json;
use theodore_contract::{
    AddProjectRequest, ChatMessage, CreateSpaceRequest, MessageVote, Project, RewindSpaceRequest,
    SetMessageVoteRequest, Space, SpaceMode, SpaceSendRequest, SpaceStatus, models,
};
use theodore_domain::{AgentId, Author, PrId, Sha, Usage};
use theodore_ports::{AgentEvent, NewAction, Store, SyncActionCode};

use crate::testkit::{Fixtures, capture_product, fixtures};
use crate::usecases::spaces::space_chat_key;
use crate::{AppError, Core, Receivers};

const PROMPT: &str = "SECRET-PROMPT in src/secret/path.rs";
const REPLY: &str = "SECRET-REPLY about acme/secret-repo";

async fn wait_until(mut cond: impl FnMut() -> bool) {
    for _ in 0..400 {
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

async fn idle(f: &Fixtures, id: &str) -> Space {
    wait_until(|| space(f, id).status != SpaceStatus::Running).await;
    space(f, id)
}

fn request(project: &Project, goal: &str) -> CreateSpaceRequest {
    CreateSpaceRequest {
        project: project.id.clone(),
        goal: goal.into(),
        name: Some("fix-login".into()),
        branch: None,
        base: None,
        agent: None,
        model: None,
        start_from: None,
    }
}

fn send(id: &str, text: &str, mode: Option<SpaceMode>) -> SpaceSendRequest {
    SpaceSendRequest {
        space: id.into(),
        text: text.into(),
        agent: None,
        model: None,
        mode,
        attachments: None,
    }
}

fn done(text: &str) -> Vec<AgentEvent> {
    vec![AgentEvent::Done {
        final_text: text.into(),
        usage: Usage::default(),
    }]
}

fn messages(f: &Fixtures, id: &str) -> Vec<ChatMessage> {
    f.store
        .query(models::CHAT_MESSAGE, "pr", &space_chat_key(id).0)
        .unwrap()
        .into_iter()
        .map(|r| serde_json::from_value(r.data).unwrap())
        .collect()
}

fn reply(f: &Fixtures, id: &str) -> ChatMessage {
    messages(f, id)
        .into_iter()
        .rfind(|m| matches!(m.author, Author::Agent(_)))
        .expect("a reply")
}

fn stored_vote(f: &Fixtures, message: &str) -> Option<MessageVote> {
    let row = f.store.get(models::CHAT_MESSAGE, message).unwrap().unwrap();
    serde_json::from_value::<ChatMessage>(row.data)
        .unwrap()
        .vote
}

async fn vote(core: &Core, message: &str, vote: Option<MessageVote>) {
    core.set_message_vote(SetMessageVoteRequest {
        message: message.into(),
        vote,
    })
    .await
    .unwrap();
}

/// A finished one-turn space.
async fn one_turn(f: &Fixtures, core: &Core, project: &Project) -> Space {
    f.agents.push_script(done(REPLY));
    f.git.push_checkpoint(Sha::new("turn1"));
    let s = core.create_space(request(project, PROMPT)).await.unwrap();
    idle(f, &s.id).await
}

#[tokio::test]
async fn a_vote_is_kept_on_the_reply_and_taking_it_back_clears_it() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let s = one_turn(&f, &core, &project).await;
    let id = reply(&f, &s.id).id;
    assert_eq!(stored_vote(&f, &id), None);

    let (log, _guard) = capture_product();
    vote(&core, &id, Some(MessageVote::Up)).await;
    assert_eq!(stored_vote(&f, &id), Some(MessageVote::Up));
    vote(&core, &id, Some(MessageVote::Up)).await;
    assert_eq!(log.named("message_voted").len(), 1, "the same vote twice");

    vote(&core, &id, Some(MessageVote::Down)).await;
    assert_eq!(stored_vote(&f, &id), Some(MessageVote::Down));
    vote(&core, &id, None).await;
    assert_eq!(stored_vote(&f, &id), None);
    vote(&core, &id, None).await;

    let votes: Vec<_> = log
        .named("message_voted")
        .iter()
        .map(|p| p["vote"].clone())
        .collect();
    assert_eq!(votes, [json!("up"), json!("down"), json!("cleared")]);
}

#[tokio::test]
async fn a_vote_survives_a_restart() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let s = one_turn(&f, &core, &project).await;
    let id = reply(&f, &s.id).id;
    vote(&core, &id, Some(MessageVote::Down)).await;
    drop(core);

    let (again, _recv) = Core::start(f.deps());
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(stored_vote(&f, &id), Some(MessageVote::Down));
    vote(&again, &id, None).await;
    assert_eq!(stored_vote(&f, &id), None);
}

#[tokio::test]
async fn a_votes_properties_are_labels_and_counts_never_text() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let s = one_turn(&f, &core, &project).await;
    let id = reply(&f, &s.id).id;

    let (log, _guard) = capture_product();
    vote(&core, &id, Some(MessageVote::Up)).await;
    let props = log.named("message_voted").remove(0);
    let keys: BTreeSet<&str> = props.as_object().unwrap().keys().map(|k| &**k).collect();
    assert_eq!(
        keys,
        BTreeSet::from([
            "vote", "surface", "mode", "agent", "model", "effort", "outcome", "duration", "tools",
            "files",
        ])
    );
    assert_eq!(props["surface"], "space");
    assert_eq!(props["agent"], "claude");
    assert_eq!(props["outcome"], "ok");
    let text = props.to_string();
    for secret in ["SECRET", "acme", "src/", "fix-login", &id] {
        assert!(!text.contains(secret), "{secret} in {text}");
    }
}

#[tokio::test]
async fn only_an_agents_reply_takes_a_vote() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let s = one_turn(&f, &core, &project).await;
    let mine = messages(&f, &s.id)
        .into_iter()
        .find(|m| m.author == Author::Me)
        .unwrap();
    let (log, _guard) = capture_product();
    let err = core
        .set_message_vote(SetMessageVoteRequest {
            message: mine.id,
            vote: Some(MessageVote::Up),
        })
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)), "{err:?}");
    assert_eq!(log.named("message_voted").len(), 0);
}

fn chat_message(pr: &str, id: &str, author: Author, at: i64, run: Option<&str>) -> NewAction {
    let m = ChatMessage {
        id: id.into(),
        pr: PrId(pr.into()),
        author,
        text: "text".into(),
        refs: vec![],
        at,
        failed: None,
        attachments: vec![],
        queued: None,
        activity: vec![],
        duration_ms: None,
        changed_files: vec![],
        model: Some("acme-private-model".into()),
        model_resolved: true,
        text_in_steps: false,
        run: run.map(str::to_string),
        vote: None,
        effort: Some("high".into()),
        mode: None,
    };
    NewAction {
        model: models::CHAT_MESSAGE.into(),
        model_id: id.into(),
        action: SyncActionCode::I,
        data: Some(serde_json::to_value(m).unwrap()),
    }
}

#[tokio::test]
async fn an_ai_panel_vote_says_so_and_times_the_reply_from_its_question() {
    let f = fixtures();
    let (core, _recv, _project) = started(&f).await;
    f.store
        .apply(vec![
            chat_message("gh:o/n#1", "q1", Author::Me, 1_000, None),
            chat_message(
                "gh:o/n#1",
                "r1",
                Author::Agent(AgentId::Codex),
                43_000,
                Some("ask:q1"),
            ),
        ])
        .unwrap();
    let (log, _guard) = capture_product();
    vote(&core, "r1", Some(MessageVote::Down)).await;
    let props = log.named("message_voted").remove(0);
    assert_eq!(props["surface"], "ai_panel");
    assert_eq!(props["mode"], "none");
    assert_eq!(props["agent"], "codex");
    assert_eq!(props["model"], "custom", "a name of the user's own");
    assert_eq!(props["effort"], "high");
    assert_eq!(props["duration"], "10s_1m");
}

#[tokio::test]
async fn a_turn_reports_how_it_ended_once() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (log, _guard) = capture_product();
    let s = one_turn(&f, &core, &project).await;

    let created = log.named("space_created");
    assert_eq!(created.len(), 1);
    assert_eq!(created[0]["from"], "blank");
    let turns = log.named("space_turn");
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0]["outcome"], "ok");
    assert_eq!(turns[0]["ok"], true);
    assert_eq!(turns[0]["agent"], "claude");
    assert_eq!(turns[0]["model"], "default");

    // Its reply remembers what a later vote needs.
    assert_eq!(reply(&f, &s.id).mode, Some(s.mode));

    f.agents.push_script(vec![AgentEvent::Error {
        message: "boom".into(),
        stderr_tail: String::new(),
    }]);
    core.space_send(send(&s.id, "again", None)).await.unwrap();
    idle(&f, &s.id).await;
    let turns = log.named("space_turn");
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[1]["outcome"], "failed");
    assert_eq!(turns[1]["ok"], false);
}

#[tokio::test]
async fn stop_counts_once_and_holds_the_queue_with_its_reason() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (log, _guard) = capture_product();
    f.agents.hang_next_run();
    let s = core.create_space(request(&project, "Long")).await.unwrap();
    core.space_send(send(&s.id, "next", None)).await.unwrap();
    core.space_send(send(&s.id, "after", None)).await.unwrap();

    core.space_stop(&s.id).await.unwrap();
    idle(&f, &s.id).await;
    wait_until(|| !log.named("queue_held").is_empty()).await;

    let actions = log.named("space_action");
    assert_eq!(actions, [json!({ "action": "stop" })]);
    let held = log.named("queue_held");
    assert_eq!(held, [json!({ "reason": "stopped", "messages": 2 })]);
    let turns = log.named("space_turn");
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0]["outcome"], "stopped");
}

#[tokio::test]
async fn stopping_nothing_is_not_a_stop() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let s = one_turn(&f, &core, &project).await;
    let (log, _guard) = capture_product();
    core.space_stop(&s.id).await.unwrap();
    assert_eq!(log.named("space_action").len(), 0);
}

#[tokio::test]
async fn send_now_counts_only_when_it_reaches_the_running_turn() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (log, _guard) = capture_product();
    f.agents.take_steering();
    f.git.push_checkpoint(Sha::new("turn1"));
    let go = f.agents.pause_next_run();
    let s = core.create_space(request(&project, "Long")).await.unwrap();
    wait_until(|| f.agents.requests().len() == 1).await;
    tokio::time::sleep(Duration::from_millis(20)).await;

    core.space_send_now(send(&s.id, "also 404s", None))
        .await
        .unwrap();
    assert_eq!(log.named("space_action"), [json!({ "action": "send_now" })]);

    // Another mode can't go into the run: queued, so not a "send now".
    core.space_send_now(send(&s.id, "plan it", Some(SpaceMode::Plan)))
        .await
        .unwrap();
    assert_eq!(log.named("space_action").len(), 1);
    go.send(()).unwrap();
    idle(&f, &s.id).await;
}

#[tokio::test]
async fn undo_back_to_here_and_approve_each_count_once() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (log, _guard) = capture_product();
    let s = one_turn(&f, &core, &project).await;
    let first = reply(&f, &s.id).id;

    for sha in ["turn2", "turn3"] {
        f.agents.push_script(done("more"));
        f.git.push_checkpoint(Sha::new(sha));
        core.space_send(send(&s.id, "more", None)).await.unwrap();
        wait_until(|| space(&f, &s.id).head_sha == Sha::new(sha)).await;
        idle(&f, &s.id).await;
    }

    core.undo_space_turn(&s.id).await.unwrap();
    assert_eq!(log.named("space_action"), [json!({ "action": "undo" })]);

    core.rewind_space(RewindSpaceRequest {
        space: s.id.clone(),
        reply: first,
    })
    .await
    .unwrap();
    assert_eq!(
        log.named("space_action").last().unwrap(),
        &json!({ "action": "back_to_here" })
    );

    f.agents.push_script(vec![
        AgentEvent::Plan {
            text: "1. do it".into(),
        },
        done("planned").remove(0),
    ]);
    f.git.push_checkpoint(Sha::new("turn4"));
    core.space_send(send(&s.id, "plan", Some(SpaceMode::Plan)))
        .await
        .unwrap();
    wait_until(|| space(&f, &s.id).head_sha == Sha::new("turn4")).await;
    idle(&f, &s.id).await;
    f.agents.push_script(done("built"));
    core.approve_space_plan(&s.id).await.unwrap();
    assert_eq!(
        log.named("space_action").last().unwrap(),
        &json!({ "action": "plan_approved" })
    );
    assert_eq!(log.named("space_action").len(), 3);
    idle(&f, &s.id).await;
}
