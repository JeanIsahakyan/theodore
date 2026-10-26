//! The second slice of spaces (docs/spaces.md): undo last turn, unarchive,
//! "Send to agent" from a review, and names from non-Latin goals — against
//! `Core` + `testkit` fakes.

use std::time::Duration;

use serde_json::json;
use theodore_contract::{
    AddProjectRequest, ChatMessage, CreateSpaceRequest, Project, ShipAction, ShipSpaceRequest,
    Space, SpaceFeedback, SpaceFeedbackRequest, SpaceSendRequest, SpaceStatus, models,
};
use theodore_domain::{Author, PrId, Sha, Usage};
use theodore_ports::{AgentEvent, NewAction, Store, SyncActionCode};

use crate::testkit::{Fixtures, fixtures};
use crate::usecases::spaces::space_chat_key;
use crate::{AppError, Core, Receivers};

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

fn transcript(f: &Fixtures, id: &str) -> Vec<ChatMessage> {
    let mut out: Vec<ChatMessage> = f
        .store
        .query(models::CHAT_MESSAGE, "pr", &space_chat_key(id).0)
        .unwrap()
        .into_iter()
        .map(|r| serde_json::from_value(r.data).unwrap())
        .collect();
    out.sort_by_key(|m| (m.at, matches!(m.author, Author::Agent(_))));
    out
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

/// One more turn that moves the space to `head`.
async fn turn(f: &Fixtures, core: &Core, id: &str, text: &str, reply: &str, head: &str) -> Space {
    f.agents.push_script(done(reply));
    f.git.push_checkpoint(Sha::new(head));
    core.space_send(SpaceSendRequest {
        space: id.into(),
        text: text.into(),
        agent: None,
        model: None,
        mode: None,
        attachments: None,
    })
    .await
    .unwrap();
    idle(f, id).await
}

fn put(f: &Fixtures, model: &str, id: &str, data: serde_json::Value) {
    f.store
        .apply(vec![NewAction {
            model: model.into(),
            model_id: id.into(),
            action: SyncActionCode::I,
            data: Some(data),
        }])
        .unwrap();
}

fn patch_space(f: &Fixtures, id: &str, data: serde_json::Value) {
    f.store
        .apply(vec![NewAction {
            model: models::SPACE.into(),
            model_id: id.into(),
            action: SyncActionCode::C,
            data: Some(data),
        }])
        .unwrap();
}

fn invalid(err: AppError) -> String {
    match err {
        AppError::Invalid(m) => m,
        other => panic!("expected Invalid, got {other:?}"),
    }
}

// ── undo last turn ──────────────────────────────────────────────────────────

#[tokio::test]
async fn each_turn_records_its_checkpoints() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    f.agents.push_script(done("one"));
    f.git.push_checkpoint(Sha::new("turn1"));
    let s = core.create_space(request(&project, "First")).await.unwrap();
    let s = idle(&f, &s.id).await;
    let s = turn(&f, &core, &s.id, "second", "two", "turn2").await;

    let chat = transcript(&f, &s.id);
    assert_eq!(s.turn_log.len(), 2);
    assert_eq!(s.turn_log[0].before, Sha::new("base000"));
    assert_eq!(s.turn_log[0].after, Sha::new("turn1"));
    assert_eq!(s.turn_log[1].before, Sha::new("turn1"));
    assert_eq!(s.turn_log[1].after, Sha::new("turn2"));
    let id_of = |text: &str| chat.iter().find(|m| m.text == text).unwrap().id.clone();
    assert_eq!(s.turn_log[1].message, id_of("second"));
    assert_eq!(s.turn_log[1].reply, id_of("two"));
    assert!(s.turn_log.iter().all(|t| !t.undone));
}

#[tokio::test]
async fn undo_moves_back_one_checkpoint_at_a_time_and_keeps_the_transcript() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    f.agents.push_script(done("Added the guard."));
    f.git.push_checkpoint(Sha::new("turn1"));
    let s = core.create_space(request(&project, "Guard")).await.unwrap();
    idle(&f, &s.id).await;
    turn(&f, &core, &s.id, "Also log it", "Logged it.", "turn2").await;

    let s = core.undo_space_turn(&s.id).await.expect("undo turn 2");
    assert_eq!(s.head_sha, Sha::new("turn1"));
    assert_eq!(s.status, SpaceStatus::Idle);
    assert!(s.turn_log[1].undone && !s.turn_log[0].undone);
    assert_eq!(
        f.git.resets.lock().unwrap().clone(),
        vec![(s.id.clone(), Sha::new("turn1"))]
    );
    assert_eq!(transcript(&f, &s.id).len(), 4, "the turn stays in the chat");

    // The next turn doesn't hear about the undone one.
    let s = turn(&f, &core, &s.id, "Log differently", "ok", "turn3").await;
    let prompt = f.agents.last_request().unwrap().prompt;
    assert!(prompt.contains("Added the guard."));
    assert!(!prompt.contains("Also log it") && !prompt.contains("Logged it."));
    assert_eq!(s.turn_log[2].before, Sha::new("turn1"));

    // Undo walks back over undone turns to the last live one.
    let s = core.undo_space_turn(&s.id).await.unwrap();
    assert_eq!(s.head_sha, Sha::new("turn1"));
    let s = core.undo_space_turn(&s.id).await.unwrap();
    assert_eq!(s.head_sha, Sha::new("base000"));
    let err = core.undo_space_turn(&s.id).await.unwrap_err();
    assert!(invalid(err).contains("no turn"));
}

#[tokio::test]
async fn undo_clears_a_failed_turn() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    f.agents.push_script(vec![AgentEvent::Error {
        message: "boom".into(),
        stderr_tail: String::new(),
    }]);
    f.git.push_checkpoint(Sha::new("half"));
    let s = core.create_space(request(&project, "Try")).await.unwrap();
    let s = idle(&f, &s.id).await;
    assert_eq!(s.status, SpaceStatus::Failed);

    let s = core.undo_space_turn(&s.id).await.unwrap();
    assert_eq!(s.status, SpaceStatus::Idle);
    assert_eq!(s.error, None);
    assert_eq!(s.head_sha, Sha::new("base000"));
}

#[tokio::test]
async fn undo_is_refused_while_running_and_when_archived() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    f.agents.push_script(done("one"));
    f.git.push_checkpoint(Sha::new("turn1"));
    let s = core.create_space(request(&project, "First")).await.unwrap();
    idle(&f, &s.id).await;

    f.agents.hang_next_run();
    core.space_send(SpaceSendRequest {
        space: s.id.clone(),
        text: "long".into(),
        agent: None,
        model: None,
        mode: None,
        attachments: None,
    })
    .await
    .unwrap();
    let err = core.undo_space_turn(&s.id).await.unwrap_err();
    assert!(invalid(err).contains("still working"));
    core.space_stop(&s.id).await.unwrap();
    idle(&f, &s.id).await;

    core.archive_space(&s.id).await.unwrap();
    let err = core.undo_space_turn(&s.id).await.unwrap_err();
    assert!(invalid(err).contains("archived"));
    assert!(f.git.resets.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_shipped_turn_cannot_be_undone_but_later_ones_can() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    f.agents.push_script(done("one"));
    f.git.push_checkpoint(Sha::new("turn1"));
    let s = core
        .create_space(request(&project, "Ship me"))
        .await
        .unwrap();
    idle(&f, &s.id).await;
    core.ship_space(ShipSpaceRequest {
        space: s.id.clone(),
        action: ShipAction::KeepBranch,
        title: None,
    })
    .await
    .expect("keep branch");

    let err = core.undo_space_turn(&s.id).await.unwrap_err();
    assert!(invalid(err).contains("already written as a branch"));

    turn(&f, &core, &s.id, "more", "two", "turn2").await;
    let s = core
        .undo_space_turn(&s.id)
        .await
        .expect("an unshipped turn");
    assert_eq!(s.head_sha, Sha::new("turn1"));
    let err = core.undo_space_turn(&s.id).await.unwrap_err();
    assert!(invalid(err).contains("already"));
}

#[tokio::test]
async fn a_pushed_turn_cannot_be_undone() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    f.agents.push_script(done("one"));
    f.git.push_checkpoint(Sha::new("turn1"));
    let s = core
        .create_space(request(&project, "Push me"))
        .await
        .unwrap();
    idle(&f, &s.id).await;
    // As Open PR leaves it: the squashed commit came from turn 1.
    patch_space(
        &f,
        &s.id,
        json!({ "shipped": {
            "how": "pr", "branch": "space/push-me", "sha": "squash1",
            "head": "turn1", "pushes": 1, "at": 0
        } }),
    );
    let err = core.undo_space_turn(&s.id).await.unwrap_err();
    assert!(invalid(err).contains("already pushed"));
}

#[tokio::test]
async fn a_space_without_a_turn_log_has_nothing_to_undo() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let s = core.create_space(request(&project, "")).await.unwrap();
    let err = core.undo_space_turn(&s.id).await.unwrap_err();
    assert!(invalid(err).contains("no turn"));
}

// ── unarchive ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn unarchive_recreates_the_worktree_and_reopens_the_diff() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    f.agents.push_script(done("one"));
    f.git.push_checkpoint(Sha::new("turn1"));
    let s = core
        .create_space(request(&project, "Come back"))
        .await
        .unwrap();
    idle(&f, &s.id).await;
    patch_space(&f, &s.id, json!({ "done_at": 5 }));
    core.archive_space(&s.id).await.unwrap();
    assert_eq!(space(&f, &s.id).review_pr, None);

    f.clock.advance(60_000);
    let s = core.unarchive_space(&s.id).await.expect("unarchive");
    assert_eq!(s.status, SpaceStatus::Idle);
    assert_eq!(s.head_sha, Sha::new("turn1"));
    assert!(s.review_pr.is_some(), "the live diff is back");
    assert!(
        s.done_at.unwrap() > 5,
        "auto-archive counts from the unarchive, not the merge"
    );
    assert_eq!(s.error, None);

    // It takes turns again; a second unarchive is a no-op.
    turn(&f, &core, &s.id, "more", "two", "turn2").await;
    let again = core.unarchive_space(&s.id).await.unwrap();
    assert_eq!(again.head_sha, Sha::new("turn2"));
}

#[tokio::test]
async fn unarchive_without_its_checkpoint_says_it_restarted_from_base() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    f.agents.push_script(done("one"));
    f.git.push_checkpoint(Sha::new("turn1"));
    let s = core.create_space(request(&project, "Lost")).await.unwrap();
    idle(&f, &s.id).await;
    core.archive_space(&s.id).await.unwrap();
    // The ref went missing while archived; the fake now restarts at base.
    f.git.set_resolve(
        &format!("refs/theodore/spaces/{}", s.id),
        Sha::new("base000"),
    );

    let s = core.unarchive_space(&s.id).await.unwrap();
    assert_eq!(s.status, SpaceStatus::Failed);
    assert_eq!(s.head_sha, Sha::new("base000"));
    assert!(s.error.unwrap().contains("restarted from main"));
}

// ── send to agent ───────────────────────────────────────────────────────────

fn anchor(path: &str, line: u32) -> serde_json::Value {
    json!({ "rev": "turn1", "path": path, "side": "new", "line": line,
            "start_line": null, "start_side": null })
}

#[tokio::test]
async fn a_draft_on_the_space_review_becomes_the_next_turn() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    f.agents.push_script(done("one"));
    f.git.push_checkpoint(Sha::new("turn1"));
    let s = core
        .create_space(request(&project, "Redirect"))
        .await
        .unwrap();
    let s = idle(&f, &s.id).await;
    let review = s.review_pr.clone().unwrap();
    put(
        &f,
        models::DRAFT,
        "d1",
        json!({ "id": "d1", "pr": review, "anchor": anchor("src/redirect.ts", 12),
                "body": "also handle //evil.com", "source": { "kind": "me" },
                "outdated": false }),
    );

    f.agents.push_script(done("Handled it."));
    core.space_send_feedback(SpaceFeedbackRequest {
        space: s.id.clone(),
        items: vec![SpaceFeedback::Draft("d1".into())],
    })
    .await
    .expect("send to agent");
    let s = idle(&f, &s.id).await;
    assert_eq!(s.turns, 2);

    let prompt = f.agents.last_request().unwrap().prompt;
    assert!(
        prompt.contains("Review comment on src/redirect.ts:12:\n> also handle //evil.com\n"),
        "{prompt}"
    );
    assert!(
        transcript(&f, &s.id)
            .iter()
            .any(|m| m.author == Author::Me && m.text.starts_with("Address this review feedback"))
    );
}

#[tokio::test]
async fn a_thread_and_a_finding_on_the_space_pr_go_as_one_turn() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let s = core.create_space(request(&project, "")).await.unwrap();
    let pr = PrId("github:acme/widget#7".into());
    patch_space(&f, &s.id, json!({ "pr": pr }));
    put(
        &f,
        models::THREAD,
        "t1",
        json!({ "pr": pr, "id": "t1", "anchor": anchor("src/limiter.ts", 41),
                "resolved": false, "outdated": false,
                "comments": [{ "id": "c1", "author": { "login": "anna", "name": null, "avatar_url": null },
                               "body": "Per-token, not global?", "created_at": 0, "edited": false }] }),
    );
    put(
        &f,
        models::FINDING,
        "f1",
        json!({ "id": "f1", "pr": pr, "skill": "security", "agents": ["claude"],
                "anchor": anchor("src/db.ts", 3), "severity": "high",
                "title": "SQL injection", "body": "The query concatenates input.",
                "state": "open", "fix": null, "outdated": false }),
    );

    f.agents.push_script(done("Fixed both."));
    core.space_send_feedback(SpaceFeedbackRequest {
        space: s.id.clone(),
        items: vec![
            SpaceFeedback::Thread("t1".into()),
            SpaceFeedback::Finding("f1".into()),
        ],
    })
    .await
    .unwrap();
    idle(&f, &s.id).await;
    let prompt = f.agents.last_request().unwrap().prompt;
    assert!(prompt.contains(
        "1. Review thread on src/limiter.ts:41:\nanna wrote:\n> Per-token, not global?\n"
    ));
    assert!(prompt.contains(
        "2. Finding (high) on src/db.ts:3: SQL injection:\n> The query concatenates input.\n"
    ));
}

#[tokio::test]
async fn feedback_from_another_pr_is_refused() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let s = core.create_space(request(&project, "")).await.unwrap();
    put(
        &f,
        models::DRAFT,
        "d9",
        json!({ "id": "d9", "pr": "github:acme/other#1", "anchor": anchor("a.ts", 1),
                "body": "x", "source": { "kind": "me" }, "outdated": false }),
    );
    let err = core
        .space_send_feedback(SpaceFeedbackRequest {
            space: s.id.clone(),
            items: vec![SpaceFeedback::Draft("d9".into())],
        })
        .await
        .unwrap_err();
    assert!(invalid(err).contains("not on this space"));
    let err = core
        .space_send_feedback(SpaceFeedbackRequest {
            space: s.id.clone(),
            items: vec![SpaceFeedback::Thread("nope".into())],
        })
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::NotFound(_)));
    let err = core
        .space_send_feedback(SpaceFeedbackRequest {
            space: s.id.clone(),
            items: vec![],
        })
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Invalid(_)));
    assert_eq!(space(&f, &s.id).turns, 0);
}

// ── names ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_cyrillic_goal_names_the_space_and_repeats_get_a_number() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let a = core.create_space(request(&project, "")).await.unwrap();
    assert_eq!(a.name, "space");
    let mut req = request(&project, "");
    req.goal = String::new();
    let b = core.create_space(req).await.unwrap();
    assert_eq!(b.name, "space-2");
    assert_eq!(b.branch, "space/space-2");

    f.agents.push_script(done("ok"));
    let c = core
        .create_space(request(&project, "исправить логин"))
        .await
        .unwrap();
    assert_eq!(c.name, "ispravit-login");
    assert_eq!(c.branch, "space/ispravit-login");
    idle(&f, &c.id).await;
    f.agents.push_script(done("ok"));
    let d = core
        .create_space(request(&project, "Исправить логин!"))
        .await
        .unwrap();
    assert_eq!(d.name, "ispravit-login-2");
}
