//! Sending while a space's agent works (docs/spaces.md §8): the queue,
//! its drain after every kind of turn end (done, Stop, a failure, a
//! restart), held messages (one that couldn't start, a usage limit left to
//! you), the queue lock staying free while a turn prepares, and "Send now"
//! steering — against `Core` + `testkit` fakes.

use std::time::Duration;

use serde_json::json;
use theodore_contract::{
    AddProjectRequest, ChatMessage, CreateSpaceRequest, Project, QueuedAction, Space, SpaceMode,
    SpaceQueuedRequest, SpaceSendRequest, SpaceStatus, models,
};
use theodore_domain::{AgentId, Author, Sha, Usage};
use theodore_ports::{AgentEvent, AgentMode, GitError, Store, WorktreeBusy};

use crate::testkit::{Fixtures, fixtures};
use crate::usecases::spaces::space_chat_key;
use crate::{AppError, Core, Receivers};

/// Waits on wall time, not a count of polls: on a loaded runner a 5 ms
/// sleep can take far longer, and a turn hands over through spawned tasks.
async fn wait_until(mut cond: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while std::time::Instant::now() < deadline {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    // One last look: the condition may have been met during the final sleep,
    // which a loaded runner stretches past the deadline.
    if cond() {
        return;
    }
    panic!("condition not met in time");
}

async fn started(f: &Fixtures) -> (Core, Receivers, Project) {
    let (core, recv) = Core::start(f.deps());
    f.startup_refresh_done().await;
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

fn message(f: &Fixtures, id: &str) -> Option<ChatMessage> {
    f.store
        .get(models::CHAT_MESSAGE, id)
        .unwrap()
        .map(|r| serde_json::from_value(r.data).unwrap())
}

fn transcript(f: &Fixtures, id: &str) -> Vec<ChatMessage> {
    f.store
        .query(models::CHAT_MESSAGE, "pr", &space_chat_key(id).0)
        .unwrap()
        .into_iter()
        .map(|r| serde_json::from_value(r.data).unwrap())
        .collect()
}

fn held(f: &Fixtures, id: &str) -> bool {
    message(f, id)
        .and_then(|m| m.queued)
        .is_some_and(|q| q.held)
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

fn send(id: &str, text: &str) -> SpaceSendRequest {
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

fn queued(id: &str, message: &str, action: QueuedAction) -> SpaceQueuedRequest {
    SpaceQueuedRequest {
        space: id.into(),
        message: message.into(),
        action,
    }
}

fn done(text: &str) -> Vec<AgentEvent> {
    vec![AgentEvent::Done {
        final_text: text.into(),
        usage: Usage::default(),
    }]
}

async fn idle(f: &Fixtures, id: &str) -> Space {
    wait_until(|| space(f, id).status != SpaceStatus::Running).await;
    space(f, id)
}

/// A space whose goal turn is running until the returned sender fires.
async fn running(f: &Fixtures, core: &Core, project: &Project) -> (Space, impl FnOnce()) {
    let go = f.agents.pause_next_run();
    let runs = f.agents.requests().len();
    let s = core
        .create_space(request(project, "Long job"))
        .await
        .unwrap();
    assert_eq!(space(f, &s.id).status, SpaceStatus::Running);
    // The space reads Running as soon as `create_space` returns, but its
    // agent is called from the spawned `drive_turn`, after a few awaits: on
    // a loaded runner a test counting `requests()` raced that task.
    wait_until(|| f.agents.requests().len() == runs + 1).await;
    (s, move || go.send(()).unwrap())
}

fn invalid(err: AppError) -> String {
    match err {
        AppError::Invalid(m) => m,
        other => panic!("expected Invalid, got {other:?}"),
    }
}

// ── the queue ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn sends_while_running_queue_and_run_in_order_after_the_turn() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, release) = running(&f, &core, &project).await;

    let a = core.space_send(send(&s.id, "first after")).await.unwrap();
    let b = core.space_send(send(&s.id, "second after")).await.unwrap();
    assert_eq!(f.agents.requests().len(), 1, "both wait");
    let (qa, qb) = (
        message(&f, &a).unwrap().queued.unwrap(),
        message(&f, &b).unwrap().queued.unwrap(),
    );
    assert!(qa.seq < qb.seq && !qa.held && !qb.held);

    release();
    wait_until(|| f.agents.requests().len() == 3 && space(&f, &s.id).turns == 3).await;
    let s = idle(&f, &s.id).await;
    let prompts: Vec<String> = f.agents.requests().into_iter().map(|r| r.prompt).collect();
    assert!(prompts[1].ends_with("first after"), "{}", prompts[1]);
    assert!(prompts[2].ends_with("second after"), "{}", prompts[2]);
    assert!(
        !prompts[1].contains("second after"),
        "a queued message isn't history yet"
    );
    let order: Vec<&str> = s.turn_log.iter().map(|t| t.message.as_str()).collect();
    assert_eq!(&order[1..], [a.as_str(), b.as_str()]);
    assert!(message(&f, &a).unwrap().queued.is_none());
    assert!(message(&f, &b).unwrap().queued.is_none());
}

#[tokio::test]
async fn a_queued_message_keeps_its_agent_mode_and_attachments() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, release) = running(&f, &core, &project).await;
    let att = core
        .save_attachment(theodore_contract::SaveAttachmentRequest {
            name: "shot.png".into(),
            mime: "image/png".into(),
            data: "iVBORw==".into(),
        })
        .await
        .unwrap();
    let id = core
        .space_send(SpaceSendRequest {
            agent: Some(AgentId::Codex),
            mode: Some(SpaceMode::Ask),
            attachments: Some(vec![att.id.clone()]),
            effort: None,
            ..send(&s.id, "look at this")
        })
        .await
        .unwrap();
    assert_eq!(message(&f, &id).unwrap().attachments, vec![att.clone()]);

    release();
    wait_until(|| f.agents.requests().len() == 2).await;
    let s = idle(&f, &s.id).await;
    let req = f.agents.last_request().unwrap();
    assert_eq!(req.agent, AgentId::Codex);
    assert_eq!(req.mode, AgentMode::ReadOnly);
    assert_eq!(req.attachments.len(), 1);
    assert!(req.prompt.contains("shot.png"));
    assert_eq!((s.agent, s.mode), (AgentId::Codex, SpaceMode::Ask));
}

#[tokio::test]
async fn a_queued_message_can_be_edited_or_cancelled_before_it_runs() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, release) = running(&f, &core, &project).await;
    let a = core.space_send(send(&s.id, "typo")).await.unwrap();
    let b = core.space_send(send(&s.id, "never mind")).await.unwrap();

    core.space_queued(queued(
        &s.id,
        &a,
        QueuedAction::Edit {
            text: " fixed ".into(),
        },
    ))
    .await
    .unwrap();
    let err = core
        .space_queued(queued(&s.id, &a, QueuedAction::Edit { text: " ".into() }))
        .await
        .unwrap_err();
    assert!(invalid(err).contains("empty"));
    core.space_queued(queued(&s.id, &b, QueuedAction::Cancel))
        .await
        .unwrap();
    assert!(message(&f, &b).is_none(), "gone from the transcript");

    release();
    wait_until(|| f.agents.requests().len() == 2).await;
    idle(&f, &s.id).await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(f.agents.requests().len(), 2, "the cancelled one never ran");
    assert!(f.agents.last_request().unwrap().prompt.ends_with("fixed"));
    // Only queued messages: one that ran is history.
    let err = core
        .space_queued(queued(&s.id, &a, QueuedAction::Cancel))
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)), "{err:?}");
}

/// The queued messages ran, in order, each as its own turn.
async fn ran_in_order(f: &Fixtures, id: &str, ids: &[&str], turns: usize) {
    wait_until(|| {
        f.agents.requests().len() == turns && space(f, id).status != SpaceStatus::Running
    })
    .await;
    let s = space(f, id);
    let order: Vec<&str> = s.turn_log.iter().map(|t| t.message.as_str()).collect();
    assert!(order.ends_with(ids), "{order:?} should end with {ids:?}");
    for m in ids {
        assert!(message(f, m).unwrap().queued.is_none(), "{m} ran");
    }
}

/// Stop ends the running turn only: what you queued behind it still runs.
#[tokio::test]
async fn stop_lets_the_queue_go_on() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    f.agents.hang_next_run();
    let s = core.create_space(request(&project, "Long")).await.unwrap();
    let a = core.space_send(send(&s.id, "next")).await.unwrap();
    let b = core.space_send(send(&s.id, "after that")).await.unwrap();
    f.agents.push_script(done("did next"));
    f.agents.push_script(done("did after that"));

    core.space_stop(&s.id).await.unwrap();
    ran_in_order(&f, &s.id, &[&a, &b], 3).await;
    let s = space(&f, &s.id);
    assert_eq!(s.status, SpaceStatus::Idle);
    assert!(s.turn_log[0].stopped, "the first turn was the stopped one");
    assert!(f.agents.requests()[1].prompt.ends_with("next"));
    assert!(f.agents.requests()[2].prompt.ends_with("after that"));
}

/// A held message (its own turn couldn't start, a usage limit left to
/// you) waits for your Send; while a turn runs, Send puts it back in line.
#[tokio::test]
async fn send_on_a_held_message_while_running_puts_it_back_in_line() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, release) = running(&f, &core, &project).await;
    let a = core.space_send(send(&s.id, "next")).await.unwrap();
    core.hold_queue(&s.id, "test").await;
    assert!(held(&f, &a));
    release();
    idle(&f, &s.id).await;
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(f.agents.requests().len(), 1, "held: nothing ran on its own");

    // A new message while one is held runs at once…
    let go = f.agents.pause_next_run();
    core.space_send(send(&s.id, "first")).await.unwrap();
    wait_until(|| f.agents.requests().len() == 2).await;
    // …and Send on the held one, while that runs, releases it to the queue.
    core.space_queued(queued(&s.id, &a, QueuedAction::Send))
        .await
        .unwrap();
    assert!(!held(&f, &a), "released, still queued");
    go.send(()).unwrap();
    wait_until(|| f.agents.requests().len() == 3).await;
    assert!(f.agents.last_request().unwrap().prompt.ends_with("next"));
}

/// Send on a held message while the space is idle runs it now.
#[tokio::test]
async fn send_on_a_held_message_runs_it_now() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, release) = running(&f, &core, &project).await;
    let a = core.space_send(send(&s.id, "next")).await.unwrap();
    core.hold_queue(&s.id, "test").await;
    release();
    idle(&f, &s.id).await;
    f.agents.push_script(done("did next"));
    core.space_queued(queued(&s.id, &a, QueuedAction::Send))
        .await
        .unwrap();
    assert!(message(&f, &a).unwrap().queued.is_none());
    wait_until(|| f.agents.requests().len() == 2).await;
    assert!(f.agents.last_request().unwrap().prompt.ends_with("next"));
}

/// A failed turn doesn't hold what you queued: the next message runs, and
/// its turn clears the failure.
#[tokio::test]
async fn a_failed_turn_lets_the_queue_go_on() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    f.agents.push_script(vec![AgentEvent::Error {
        message: "boom".into(),
        stderr_tail: String::new(),
    }]);
    let (s, release) = running(&f, &core, &project).await;
    let a = core.space_send(send(&s.id, "next")).await.unwrap();
    f.agents.push_script(done("recovered"));
    release();
    ran_in_order(&f, &s.id, &[&a], 2).await;
    let s = space(&f, &s.id);
    assert_eq!(s.status, SpaceStatus::Idle);
    assert_eq!(s.error, None);
    let first = replies(&f, &s.id)
        .into_iter()
        .find(|m| m.failed.is_some())
        .expect("the failed reply");
    assert_eq!(
        first.failed.as_deref(),
        Some("boom"),
        "the failure stays in the chat"
    );
}

/// `failed` with no agent error: the reason lives in `skipped`; the queue
/// still goes on, and the next turn's start clears it.
#[tokio::test]
async fn a_skipped_checkpoint_lets_the_queue_go_on() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    f.agents.push_script(done("ok"));
    f.git
        .push_checkpoint_error(GitError::Busy(WorktreeBusy::Rebase));
    let (s, release) = running(&f, &core, &project).await;
    let a = core.space_send(send(&s.id, "next")).await.unwrap();
    f.agents.push_script(done("next done"));
    release();
    ran_in_order(&f, &s.id, &[&a], 2).await;
    assert_eq!(space(&f, &s.id).status, SpaceStatus::Idle);
}

/// A queued message whose turn can't start (its worktree can't be made)
/// is a failed turn of its own, and the one behind it runs.
#[tokio::test]
async fn a_queued_message_whose_turn_cant_start_fails_and_the_next_one_runs() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, release) = running(&f, &core, &project).await;
    let a = core.space_send(send(&s.id, "doomed")).await.unwrap();
    let b = core.space_send(send(&s.id, "fine")).await.unwrap();
    f.git.push_worktree_error(GitError::Command {
        args: "worktree add".into(),
        code: 128,
        stderr: "disk full".into(),
    });
    f.agents.push_script(done("fine done"));
    release();
    // "doomed" never reached the agent; "fine" did.
    wait_until(|| {
        f.agents.requests().len() == 2 && space(&f, &s.id).status != SpaceStatus::Running
    })
    .await;
    assert!(f.agents.last_request().unwrap().prompt.ends_with("fine"));
    assert!(message(&f, &a).unwrap().queued.is_none(), "it was sent");
    assert!(message(&f, &b).unwrap().queued.is_none());
    let failed: Vec<ChatMessage> = replies(&f, &s.id)
        .into_iter()
        .filter(|m| m.failed.is_some())
        .collect();
    assert_eq!(failed.len(), 1);
    assert!(
        failed[0]
            .failed
            .as_deref()
            .unwrap()
            .contains("couldn't start"),
        "{:?}",
        failed[0].failed
    );
    assert!(failed[0].failed.as_deref().unwrap().contains("disk full"));
    assert_eq!(space(&f, &s.id).status, SpaceStatus::Idle);
}

/// The queue lock covers the claim of a turn, not its preparation: a send
/// to the space (another device's, say) is answered while the worktree is
/// still being made.
#[tokio::test]
async fn the_queue_lock_is_free_while_a_turn_prepares() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    f.agents.push_script(done("one"));
    let s = core.create_space(request(&project, "First")).await.unwrap();
    idle(&f, &s.id).await;

    let go = f.git.pause_next_worktree();
    let a = core.space_send(send(&s.id, "slow start")).await.unwrap();
    assert_eq!(
        space(&f, &s.id).status,
        SpaceStatus::Running,
        "claimed at once"
    );
    assert_eq!(
        f.agents.requests().len(),
        1,
        "the agent waits for the worktree"
    );
    // Another send doesn't wait for the worktree: queued behind the turn.
    let queued = tokio::time::timeout(
        Duration::from_secs(5),
        core.space_send(send(&s.id, "meanwhile")),
    )
    .await
    .expect("the send answers while the turn prepares")
    .unwrap();
    assert!(message(&f, &queued).unwrap().queued.is_some());
    f.agents.push_script(done("two"));
    f.agents.push_script(done("three"));
    go.send(()).unwrap();
    ran_in_order(&f, &s.id, &[&a, &queued], 3).await;
}

/// The agent's replies in the space, oldest first.
fn replies(f: &Fixtures, id: &str) -> Vec<ChatMessage> {
    let mut r: Vec<ChatMessage> = transcript(f, id)
        .into_iter()
        .filter(|m| matches!(m.author, Author::Agent(_)))
        .collect();
    r.sort_by_key(|m| m.at);
    r
}

/// A Stop that lands once the agent is done (its checkpoint being written,
/// or the run just about let go) doesn't make the reply a stopped one:
/// it's whole, and says so.
fn assert_first_reply_whole(f: &Fixtures, id: &str) {
    // Replies may share a clock tick in the fakes: by text, not by time.
    let reply = replies(f, id)
        .into_iter()
        .find(|m| m.text == "ok")
        .expect("everything the agent wrote");
    assert_eq!(reply.failed, None, "the agent had finished: not stopped");
}

/// Stop lands after the agent finished, while its checkpoint is written:
/// the reply is whole, and the queue goes on.
#[tokio::test]
async fn stop_during_the_checkpoint_lets_the_queue_go_on() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    f.agents.push_script(done("ok"));
    let (s, release) = running(&f, &core, &project).await;
    let a = core.space_send(send(&s.id, "next")).await.unwrap();
    let go = f.git.pause_next_checkpoint();
    release();
    wait_until(|| !f.git.checkpoints.lock().unwrap().is_empty()).await;
    core.space_stop(&s.id).await.unwrap();
    f.agents.push_script(done("next done"));
    go.send(()).unwrap();
    ran_in_order(&f, &s.id, &[&a], 2).await;
    assert_first_reply_whole(&f, &s.id);
    assert_eq!(space(&f, &s.id).error, None);
}

/// Stop takes the run after the turn last looked for a stop, just before
/// the turn lets go of it: a stop all the same, and the queue goes on.
#[tokio::test]
async fn stop_as_the_turn_ends_on_its_own_lets_the_queue_go_on() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    f.agents.push_script(done("ok"));
    let (s, release) = running(&f, &core, &project).await;
    let a = core.space_send(send(&s.id, "next")).await.unwrap();
    let go = f.git.pause_next_checkpoint();
    release();
    wait_until(|| !f.git.checkpoints.lock().unwrap().is_empty()).await;
    // Stop's first step, its cancel not landed yet.
    let run = space(&f, &s.id).run.unwrap();
    assert!(core.0.runs.write().await.remove(&run).is_some());
    f.agents.push_script(done("next done"));
    go.send(()).unwrap();
    ran_in_order(&f, &s.id, &[&a], 2).await;
    assert_first_reply_whole(&f, &s.id);
    assert_eq!(space(&f, &s.id).error, None);
}

/// Stop lands once the turn let go of its run, before the next queued
/// message starts: that next one is what it stops, and the one behind it
/// runs.
#[tokio::test]
async fn stop_while_the_turn_hands_over_stops_the_next_one() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    f.agents.push_script(done("ok"));
    let (s, release) = running(&f, &core, &project).await;
    let a = core.space_send(send(&s.id, "next")).await.unwrap();
    let b = core.space_send(send(&s.id, "after that")).await.unwrap();
    let run = space(&f, &s.id).run.unwrap();
    // The turn's end waits here, its run let go.
    let queue = core.space_queue_lock(&s.id).await;
    release();
    wait_until(|| core.0.runs.try_read().is_ok_and(|r| !r.contains_key(&run))).await;
    let stop = tokio::spawn({
        let (core, id) = (core.clone(), s.id.clone());
        async move { core.space_stop(&id).await }
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!stop.is_finished(), "Stop waits for the handover");
    f.agents.hang_next_run();
    f.agents.push_script(done("after that done"));
    drop(queue);
    stop.await.unwrap().unwrap();
    ran_in_order(&f, &s.id, &[&a, &b], 3).await;
    assert!(f.agents.requests()[1].prompt.ends_with("next"));
    assert!(f.agents.requests()[2].prompt.ends_with("after that"));
    let s = space(&f, &s.id);
    assert_eq!(s.error, None, "stopped, not failed");
    assert!(s.turn_log[1].stopped, "the next one was what Stop stopped");
    assert!(!s.turn_log[2].stopped);
}

/// A restart fails the turn that was running (docs/spaces.md §7); what
/// waited behind it runs on start, as after any turn.
#[tokio::test]
async fn queued_messages_run_after_a_restart() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, _release) = running(&f, &core, &project).await;
    let a = core.space_send(send(&s.id, "after restart")).await.unwrap();
    let b = core.space_send(send(&s.id, "and then")).await.unwrap();
    core.shutdown();
    let runs = f.agents.requests().len();

    f.agents.push_script(done("done"));
    f.agents.push_script(done("done too"));
    let (_core, _recv) = Core::start(f.deps());
    wait_until(|| f.agents.requests().len() == runs + 2).await;
    let prompts: Vec<String> = f.agents.requests().into_iter().map(|r| r.prompt).collect();
    assert!(
        prompts[runs].ends_with("after restart"),
        "{}",
        prompts[runs]
    );
    assert!(prompts[runs + 1].ends_with("and then"));
    idle(&f, &s.id).await;
    assert!(message(&f, &a).unwrap().queued.is_none());
    assert!(message(&f, &b).unwrap().queued.is_none());
    let s = space(&f, &s.id);
    assert_eq!(s.status, SpaceStatus::Idle);
    assert!(
        s.turn_log.len() >= 2,
        "both ran as turns: {:?}",
        s.turn_log.len()
    );
}

/// A held message stays held across a restart: it waits for your Send.
#[tokio::test]
async fn a_held_message_stays_held_across_a_restart() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, _release) = running(&f, &core, &project).await;
    let a = core.space_send(send(&s.id, "later")).await.unwrap();
    core.hold_queue(&s.id, "test").await;
    core.shutdown();
    let runs = f.agents.requests().len();

    let (core, _recv) = Core::start(f.deps());
    wait_until(|| space(&f, &s.id).status == SpaceStatus::Failed).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(f.agents.requests().len(), runs, "held: nothing ran");
    assert!(held(&f, &a));
    f.agents.push_script(done("done"));
    core.space_queued(queued(&s.id, &a, QueuedAction::Send))
        .await
        .unwrap();
    wait_until(|| f.agents.requests().len() == runs + 1).await;
    assert!(f.agents.last_request().unwrap().prompt.ends_with("later"));
}

#[tokio::test]
async fn undo_and_archive_keep_a_held_queue() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    f.agents.push_script(done("one"));
    f.git.push_checkpoint(Sha::new("turn1"));
    let s = core.create_space(request(&project, "First")).await.unwrap();
    idle(&f, &s.id).await;
    f.agents.hang_next_run();
    core.space_send(send(&s.id, "long")).await.unwrap();
    let a = core.space_send(send(&s.id, "queued")).await.unwrap();
    core.hold_queue(&s.id, "test").await;
    core.space_stop(&s.id).await.unwrap();
    idle(&f, &s.id).await;
    assert!(held(&f, &a));

    // Undo walks the checkpoints back; the queue is untouched.
    core.undo_space_turn(&s.id).await.unwrap();
    assert!(held(&f, &a));

    // Archive keeps it too, but an archived space sends nothing.
    core.archive_space(&s.id).await.unwrap();
    assert!(held(&f, &a));
    let err = core
        .space_queued(queued(&s.id, &a, QueuedAction::Send))
        .await
        .unwrap_err();
    assert!(invalid(err).contains("archived"));

    core.unarchive_space(&s.id).await.unwrap();
    let runs = f.agents.requests().len();
    core.space_queued(queued(&s.id, &a, QueuedAction::Send))
        .await
        .unwrap();
    wait_until(|| f.agents.requests().len() == runs + 1).await;
    assert!(f.agents.last_request().unwrap().prompt.contains("queued"));
}

#[tokio::test]
async fn the_running_turns_reply_still_comes_before_a_queued_message() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    f.agents.push_script(done("goal done"));
    let (s, release) = running(&f, &core, &project).await;
    let a = core.space_send(send(&s.id, "next")).await.unwrap();
    release();
    wait_until(|| f.agents.requests().len() == 2).await;
    idle(&f, &s.id).await;
    let chat = transcript(&f, &s.id);
    let reply = chat
        .iter()
        .find(|m| m.author == Author::Agent(AgentId::Claude) && m.text == "goal done")
        .unwrap();
    let sent = chat.iter().find(|m| m.id == a).unwrap();
    assert!(sent.at >= reply.at, "sent after the turn it waited for");
}

// ── send now (steering) ────────────────────────────────────────────────────

#[tokio::test]
async fn send_now_goes_into_a_running_turn_that_takes_it() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    f.agents.take_steering();
    f.git.push_checkpoint(Sha::new("turn1"));
    let (s, release) = running(&f, &core, &project).await;
    // The agent is up: its run takes messages from here on. Its steer
    // handle is registered just after the agent call returns, so wait for
    // that rather than a fixed sleep.
    let run = space(&f, &s.id).run.unwrap();
    wait_until(|| core.steer_of(&run).is_some()).await;
    let id = core
        .space_send_now(send(&s.id, "also handle 404s"))
        .await
        .unwrap();
    assert_eq!(f.agents.steered(), ["also handle 404s"]);
    let m = message(&f, &id).unwrap();
    assert!(m.queued.is_none(), "in the turn, not queued");
    assert_eq!(f.agents.requests().len(), 1, "no new run");

    release();
    let s = idle(&f, &s.id).await;
    assert_eq!(s.turn_log[0].steered, std::slice::from_ref(&id));

    // Undone with its turn: the next turn's replay leaves it out.
    core.undo_space_turn(&s.id).await.unwrap();
    f.agents.push_script(done("ok"));
    core.space_send(send(&s.id, "again")).await.unwrap();
    wait_until(|| f.agents.requests().len() == 2).await;
    let prompt = f.agents.last_request().unwrap().prompt;
    assert!(!prompt.contains("also handle 404s"), "{prompt}");
}

#[tokio::test]
async fn send_now_queues_when_the_run_cant_take_it() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    // An agent without steering (Codex, Gemini): queued.
    let (s, release) = running(&f, &core, &project).await;
    let a = core.space_send_now(send(&s.id, "plain")).await.unwrap();
    assert!(message(&f, &a).unwrap().queued.is_some());
    release();
    // "plain" gets its own turn: past it, or it could take the pause below.
    wait_until(|| f.agents.requests().len() == 2).await;
    idle(&f, &s.id).await;

    // A steerable run, but the message switches the mode: it waits too.
    f.agents.take_steering();
    let (s, _release) = running(&f, &core, &project).await;
    let b = core
        .space_send_now(SpaceSendRequest {
            mode: Some(SpaceMode::Run),
            ..send(&s.id, "with Run")
        })
        .await
        .unwrap();
    assert!(message(&f, &b).unwrap().queued.is_some());
    assert!(f.agents.steered().is_empty());

    // Idle: "Send now" is just a send.
    let f2 = fixtures();
    let (core2, _r, project2) = started(&f2).await;
    let s2 = core2.create_space(request(&project2, "")).await.unwrap();
    let c = core2.space_send_now(send(&s2.id, "go")).await.unwrap();
    assert!(message(&f2, &c).unwrap().queued.is_none());
    wait_until(|| f2.agents.requests().len() == 1).await;
}
