//! Background tasks (docs/spaces.md "Background tasks"): a process kept past
//! its turn, the CLI's own follow-up turns, Stop, and every way the process
//! goes — against `Core` + testkit fakes. The stream is `FakeLive`'s; the real
//! CLI's is covered in `crates/agents` (the recorded fixture and a fake CLI).

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use theodore_contract::{
    AddProjectRequest, BackgroundTaskStatus, ChatMessage, CreateSpaceRequest, Project,
    QueuedAction, Space, SpaceQueuedRequest, SpaceSendRequest, SpaceStatus, TurnStep, models,
};
use theodore_domain::{Sha, Usage};
use theodore_ports::{AgentEvent, AgentMode, BackgroundTaskInfo, BackgroundTaskKind, Store};

use crate::space_commands_tests::start_env;
use crate::testkit::{FakeLive, FakeScript, Fixtures, fixtures};
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
    let (core, recv) = Core::start(f.deps_with_tools());
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
    let mut rows: Vec<ChatMessage> = f
        .store
        .query(models::CHAT_MESSAGE, "pr", &space_chat_key(id).0)
        .unwrap()
        .into_iter()
        .map(|r| serde_json::from_value(r.data).unwrap())
        .collect();
    rows.sort_by_key(|m| m.at);
    rows
}

/// The reply of the space's `n`th turn, from its turn log.
fn reply(f: &Fixtures, id: &str, n: usize) -> ChatMessage {
    let reply = space(f, id).turn_log[n].reply.clone();
    serde_json::from_value(
        f.store
            .get(models::CHAT_MESSAGE, &reply)
            .unwrap()
            .unwrap()
            .data,
    )
    .unwrap()
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
    }
}

fn done_event(text: &str) -> AgentEvent {
    AgentEvent::Done {
        final_text: text.into(),
        usage: Usage::default(),
    }
}

fn set(ids: &[&str]) -> AgentEvent {
    AgentEvent::BackgroundTasks {
        tasks: ids
            .iter()
            .map(|id| BackgroundTaskInfo {
                id: id.to_string(),
                kind: BackgroundTaskKind::Command,
                description: format!("sleep {id}"),
            })
            .collect(),
    }
}

fn task_started(id: &str, call: &str) -> AgentEvent {
    AgentEvent::TaskStarted {
        id: id.into(),
        tool_use_id: Some(call.into()),
        description: format!("sleep {id}"),
        kind: BackgroundTaskKind::Command,
        backgrounded: true,
    }
}

fn task_ended(id: &str, call: &str, status: &str, output: &str) -> AgentEvent {
    AgentEvent::TaskEnded {
        id: id.into(),
        tool_use_id: Some(call.into()),
        status: status.into(),
        summary: Some(format!("{id} {status}")),
        output_file: Some(output.into()),
    }
}

fn task_status(f: &Fixtures, id: &str, task: &str) -> Option<BackgroundTaskStatus> {
    space(f, id)
        .background_tasks
        .iter()
        .find(|t| t.id == task)
        .map(|t| t.status)
}

/// The launch of a background command: the row that keeps its call id.
fn launch_call() -> Vec<AgentEvent> {
    vec![
        AgentEvent::ToolCall {
            id: "call1".into(),
            name: "Bash".into(),
            input: json!({ "command": "sleep 300", "run_in_background": true }),
        },
        AgentEvent::ToolResult {
            id: "call1".into(),
            ok: true,
            output: "running in background".into(),
        },
    ]
}

/// A space whose goal turn left its process kept for task `t1`.
async fn parked(f: &Fixtures, core: &Core, project: &Project) -> (Space, Arc<FakeLive>) {
    let mut script = launch_call();
    script.extend([
        set(&["t1"]),
        task_started("t1", "call1"),
        AgentEvent::Lingering,
        done_event("STARTED"),
    ]);
    let live = f.agents.push_live_run(script);
    let s = core.create_space(request(project, "Go")).await.unwrap();
    wait_until(|| core.has_parked(&s.id)).await;
    (s, live)
}

#[tokio::test]
async fn a_turn_with_a_task_ends_for_you_and_keeps_its_process() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, live) = parked(&f, &core, &project).await;

    let row = space(&f, &s.id);
    assert_eq!(row.status, SpaceStatus::Idle, "the reply is done");
    assert_eq!(row.run, None);
    assert_eq!(
        task_status(&f, &s.id, "t1"),
        Some(BackgroundTaskStatus::Running)
    );
    let task = &row.background_tasks[0];
    assert_eq!(task.call.as_deref(), Some("call1"));
    assert!(task.run.is_some());
    // The process is the space's now: open, not killed.
    assert!(live.is_open());
    assert!(!live.was_killed());
    assert_eq!(reply(&f, &s.id, 0).text, "STARTED");
    assert!(
        f.tools.unregistered().is_empty(),
        "its MCP endpoint stays with the process"
    );
}

#[tokio::test]
async fn a_task_ending_by_itself_lands_as_a_follow_up_turn_on_the_same_process() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, live) = parked(&f, &core, &project).await;
    let requests = f.agents.requests().len();

    // The last task ended and the CLI took the turn up: a real turn.
    live.emit(AgentEvent::TaskStatus {
        id: "t1".into(),
        status: Some("completed".into()),
        end_time: Some(2),
        backgrounded: None,
    })
    .await;
    live.emit(task_ended("t1", "call1", "completed", "/nope/t1.output"))
        .await;
    live.emit(set(&[])).await;
    live.emit(AgentEvent::FollowUp).await;
    live.emit(AgentEvent::Text {
        text: "t1 is done".into(),
    })
    .await;
    live.emit(done_event("t1 is done")).await;
    live.close();

    wait_until(|| space(&f, &s.id).turns == 2).await;
    wait_until(|| !core.has_parked(&s.id)).await;
    let row = space(&f, &s.id);
    assert_eq!(row.status, SpaceStatus::Idle);
    assert_eq!(f.agents.requests().len(), requests, "no second process");
    let answer = reply(&f, &s.id, 1);
    assert_eq!(answer.text, "t1 is done");
    assert_eq!(answer.from_tasks, vec!["sleep t1".to_string()]);
    // The turn log has it, as a turn of its own.
    let turn = row.turn_log.last().unwrap();
    assert_eq!(turn.reply, answer.id);
    assert_eq!(turn.message, answer.id, "no message of yours opened it");
    // The first reply's row: the task's end landed on it, under its run.
    let first = reply(&f, &s.id, 0);
    let TurnStep::Tool { summary, .. } = first
        .activity
        .iter()
        .find(|s| matches!(s, TurnStep::Tool { .. }))
        .unwrap()
    else {
        unreachable!()
    };
    assert_eq!(summary.as_deref(), Some("t1 completed"));
    assert_eq!(
        task_status(&f, &s.id, "t1"),
        Some(BackgroundTaskStatus::Completed)
    );
}

#[tokio::test]
async fn a_send_on_a_kept_process_goes_down_its_stdin() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, live) = parked(&f, &core, &project).await;

    core.space_send(send(&s.id, "and another")).await.unwrap();
    wait_until(|| !live.steered().is_empty()).await;
    assert_eq!(f.agents.requests().len(), 1, "no second CLI on one session");
    assert!(
        live.steered()[0].ends_with("and another"),
        "{:?}",
        live.steered()
    );
    assert_eq!(space(&f, &s.id).status, SpaceStatus::Running);

    live.emit(AgentEvent::Lingering).await;
    live.emit(done_event("second answer")).await;
    wait_until(|| space(&f, &s.id).turns == 2).await;
    wait_until(|| core.has_parked(&s.id)).await;
    assert!(!live.was_killed());
    let row = space(&f, &s.id);
    assert_eq!(row.status, SpaceStatus::Idle);
    assert_eq!(reply(&f, &s.id, 1).text, "second answer");
    // Its tools now answer to this turn's run.
    let rebound = f.tools.rebound();
    assert_eq!(rebound.len(), 1);
    assert!(rebound[0].1.contains(&s.id), "{rebound:?}");
    assert!(
        rebound[0].1.contains(&row.turn_log[1].message),
        "{rebound:?}"
    );
}

#[tokio::test]
async fn a_send_while_the_follow_up_runs_waits_then_runs_on_the_same_process() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, live) = parked(&f, &core, &project).await;

    live.emit(AgentEvent::FollowUp).await;
    wait_until(|| space(&f, &s.id).status == SpaceStatus::Running).await;
    let id = core.space_send(send(&s.id, "after it")).await.unwrap();
    assert!(
        transcript(&f, &s.id)
            .iter()
            .any(|m| m.id == id && m.queued.is_some()),
        "queued, as for any running turn"
    );
    live.emit(AgentEvent::Lingering).await;
    live.emit(done_event("reacted")).await;
    wait_until(|| !live.steered().is_empty()).await;
    assert!(live.steered()[0].ends_with("after it"));
    assert_eq!(f.agents.requests().len(), 1);
}

#[tokio::test]
async fn send_now_during_a_follow_up_steers_into_it() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, live) = parked(&f, &core, &project).await;
    live.emit(AgentEvent::FollowUp).await;
    // Its turn has the process's stdin (until then Send now queues, as for any
    // turn that hasn't started taking input).
    wait_until(|| {
        space(&f, &s.id)
            .run
            .is_some_and(|run| core.steer_of(&run).is_some())
    })
    .await;
    core.space_send_now(send(&s.id, "also this")).await.unwrap();
    wait_until(|| !live.steered().is_empty()).await;
    assert_eq!(live.steered(), vec!["also this".to_string()]);
    live.emit(AgentEvent::Lingering).await;
    live.emit(done_event("done")).await;
    wait_until(|| space(&f, &s.id).turns == 2).await;
    assert_eq!(space(&f, &s.id).turn_log[1].steered.len(), 1);
}

#[tokio::test]
async fn stop_during_a_follow_up_interrupts_it_and_leaves_the_tasks() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, live) = parked(&f, &core, &project).await;
    live.on_interrupt(vec![AgentEvent::Lingering, done_event("partial")]);

    live.emit(AgentEvent::FollowUp).await;
    wait_until(|| space(&f, &s.id).status == SpaceStatus::Running).await;
    let queued = core.space_send(send(&s.id, "wait")).await.unwrap();
    core.space_stop(&s.id).await.unwrap();

    wait_until(|| live.interrupts() == 1).await;
    wait_until(|| space(&f, &s.id).turns == 2).await;
    wait_until(|| core.has_parked(&s.id)).await;
    assert!(!live.was_killed(), "Stop never kills the tasks");
    assert_eq!(
        task_status(&f, &s.id, "t1"),
        Some(BackgroundTaskStatus::Running)
    );
    assert_eq!(reply(&f, &s.id, 1).failed.as_deref(), Some("stopped"));
    // Stop holds the queue, the follow-up or not.
    let held = transcript(&f, &s.id)
        .into_iter()
        .find(|m| m.id == queued)
        .unwrap();
    assert!(held.queued.as_ref().unwrap().held);
    assert!(live.steered().is_empty(), "nothing was sent");
}

#[tokio::test]
async fn an_interrupted_turns_error_result_reads_as_stopped() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, live) = parked(&f, &core, &project).await;
    // What the real CLI answers an interrupt with mid-reply.
    live.on_interrupt(vec![
        AgentEvent::Lingering,
        AgentEvent::Error {
            message: "[ede_diagnostic] result_type=user".into(),
            stderr_tail: String::new(),
        },
    ]);

    live.emit(AgentEvent::FollowUp).await;
    wait_until(|| space(&f, &s.id).status == SpaceStatus::Running).await;
    core.space_stop(&s.id).await.unwrap();

    wait_until(|| live.interrupts() == 1).await;
    wait_until(|| space(&f, &s.id).turns == 2).await;
    assert_eq!(reply(&f, &s.id, 1).failed.as_deref(), Some("stopped"));
    assert_eq!(space(&f, &s.id).error, None);
    assert_eq!(
        task_status(&f, &s.id, "t1"),
        Some(BackgroundTaskStatus::Running)
    );
}

#[tokio::test]
async fn stop_during_a_follow_up_with_no_tasks_left_ends_the_process() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, live) = parked(&f, &core, &project).await;
    live.emit(task_ended("t1", "call1", "completed", "/nope"))
        .await;
    live.emit(set(&[])).await;
    live.emit(AgentEvent::FollowUp).await;
    wait_until(|| space(&f, &s.id).status == SpaceStatus::Running).await;

    core.space_stop(&s.id).await.unwrap();
    wait_until(|| live.was_killed()).await;
    wait_until(|| space(&f, &s.id).turns == 2).await;
    assert!(!core.has_parked(&s.id));
    assert_eq!(live.interrupts(), 0);
}

#[tokio::test]
async fn a_follow_up_while_the_queue_is_held_leaves_it_held() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, live) = parked(&f, &core, &project).await;

    // Held by a stopped turn: nothing goes by itself.
    live.on_interrupt(vec![AgentEvent::Lingering, done_event("stopped")]);
    core.space_send(send(&s.id, "first")).await.unwrap();
    wait_until(|| live.steered().len() == 1).await;
    let q = core.space_send(send(&s.id, "held")).await.unwrap();
    core.space_stop(&s.id).await.unwrap();
    wait_until(|| space(&f, &s.id).status != SpaceStatus::Running).await;
    wait_until(|| core.has_parked(&s.id)).await;
    let held = |f: &Fixtures| {
        transcript(f, &s.id)
            .into_iter()
            .find(|m| m.id == q)
            .and_then(|m| m.queued)
            .is_some_and(|q| q.held)
    };
    assert!(held(&f));

    // The CLI's own turn arrives; it runs, and the queue stays held.
    live.emit(AgentEvent::FollowUp).await;
    wait_until(|| space(&f, &s.id).status == SpaceStatus::Running).await;
    live.emit(AgentEvent::Lingering).await;
    live.emit(done_event("reacted")).await;
    wait_until(|| {
        let row = space(&f, &s.id);
        row.status != SpaceStatus::Running && row.turns == 3
    })
    .await;
    wait_until(|| core.has_parked(&s.id)).await;
    assert!(held(&f), "a follow-up never sends a held message");
    assert_eq!(live.steered().len(), 1, "nothing else was written");
}

/// The CLI starts its turn while the last turn's `check` still runs: the
/// space is busy, so the reply waits for the check's end.
#[tokio::test]
async fn a_follow_up_during_a_check_waits_for_it() {
    let e = start_env(true).await;
    e.global("spaces: {check: make check}");
    e.f.commands.on(
        "make check",
        FakeScript::Hang {
            lines: vec!["still checking".into()],
        },
    );
    let mut script = launch_call();
    script.extend([
        set(&["t1"]),
        task_started("t1", "call1"),
        AgentEvent::Lingering,
        done_event("edited"),
    ]);
    let live = e.f.agents.push_live_run(script);
    e.f.git.push_checkpoint(Sha::new("turn111"));
    let s = e.create("Fix it").await;
    wait_until(|| e.core.has_parked(&s.id)).await;
    assert_eq!(e.space(&s.id).status, SpaceStatus::Running, "checking");

    live.emit(AgentEvent::FollowUp).await;
    live.emit(AgentEvent::Text {
        text: "reacted".into(),
    })
    .await;
    live.emit(AgentEvent::Lingering).await;
    live.emit(done_event("reacted")).await;
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(e.space(&s.id).turns, 1, "still waiting for the space");

    e.core.space_stop(&s.id).await.unwrap(); // ends the check
    wait_until(|| e.space(&s.id).turns == 2).await;
    wait_until(|| e.core.has_parked(&s.id)).await;
    assert!(!live.was_killed());
    assert!(e.space(&s.id).status != SpaceStatus::Running);
}

#[tokio::test]
async fn stop_task_writes_the_request_and_waits_for_the_answer() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, live) = parked(&f, &core, &project).await;

    core.space_stop_task(&s.id, "t1").await.unwrap();
    assert_eq!(live.stopped_tasks(), vec!["t1".to_string()]);

    live.refuse_next_stop("no such task");
    let err = core.space_stop_task(&s.id, "t1").await.unwrap_err();
    assert!(format!("{err}").contains("no such task"), "{err}");

    // An unknown task, and one that already ended.
    assert!(core.space_stop_task(&s.id, "nope").await.is_err());
    live.emit(task_ended("t1", "call1", "stopped", "/nope"))
        .await;
    live.emit(set(&[])).await;
    wait_until(|| task_status(&f, &s.id, "t1") == Some(BackgroundTaskStatus::Stopped)).await;
    core.space_stop_task(&s.id, "t1").await.unwrap();
}

#[tokio::test]
async fn the_process_exits_with_its_last_task_and_lets_go_of_its_endpoint() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, live) = parked(&f, &core, &project).await;
    live.emit(task_ended("t1", "call1", "stopped", "/nope"))
        .await;
    live.emit(set(&[])).await;
    live.close();
    wait_until(|| !core.has_parked(&s.id)).await;
    assert_eq!(
        task_status(&f, &s.id, "t1"),
        Some(BackgroundTaskStatus::Stopped)
    );
    wait_until(|| !f.tools.unregistered().is_empty()).await;
}

#[tokio::test]
async fn a_crash_while_kept_makes_tasks_lost() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, live) = parked(&f, &core, &project).await;
    live.close();
    wait_until(|| !core.has_parked(&s.id)).await;
    assert_eq!(
        task_status(&f, &s.id, "t1"),
        Some(BackgroundTaskStatus::Lost)
    );
}

#[tokio::test]
async fn the_cap_cuts_the_tasks_and_says_so() {
    let f = fixtures();
    let (core, mut recv, project) = started(&f).await;
    let (s, live) = parked(&f, &core, &project).await;
    live.emit(AgentEvent::TasksCapped).await;
    live.close();
    wait_until(|| !core.has_parked(&s.id)).await;
    let row = space(&f, &s.id);
    assert_eq!(row.background_tasks[0].status, BackgroundTaskStatus::Cut);
    assert!(row.background_tasks[0].note.is_some());
    let toast = async {
        while let Ok(e) = recv.ephemeral.recv().await {
            if let theodore_contract::Ephemeral::Toast { text, .. } = e
                && text.contains("limit")
            {
                return text;
            }
        }
        panic!("no toast");
    };
    let text = tokio::time::timeout(Duration::from_secs(5), toast)
        .await
        .expect("the toast says so");
    assert!(text.contains("stopped"), "{text}");
}

#[tokio::test]
async fn a_restart_makes_running_tasks_lost() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, _live) = parked(&f, &core, &project).await;
    core.shutdown();

    let (core2, _recv) = Core::start(f.deps());
    wait_until(|| task_status(&f, &s.id, "t1") == Some(BackgroundTaskStatus::Lost)).await;
    let note = space(&f, &s.id).background_tasks[0].note.clone().unwrap();
    assert!(note.contains("restarted"), "{note}");
    drop(core2);
}

#[tokio::test]
async fn a_message_needing_another_process_ends_this_one_first() {
    let f = fixtures();
    let (core, mut recv, project) = started(&f).await;
    let (s, live) = parked(&f, &core, &project).await;

    f.agents.push_script(vec![done_event("on the new model")]);
    core.space_send(SpaceSendRequest {
        model: Some("another-model".into()),
        ..send(&s.id, "with another model")
    })
    .await
    .unwrap();
    assert!(live.was_killed(), "the old process ends first");
    wait_until(|| f.agents.requests().len() == 2).await;
    wait_until(|| space(&f, &s.id).turns == 2).await;
    let toast = async {
        while let Ok(e) = recv.ephemeral.recv().await {
            if let theodore_contract::Ephemeral::Toast { text, .. } = e
                && text.contains("background tasks stopped")
            {
                return;
            }
        }
        panic!("no toast");
    };
    tokio::time::timeout(Duration::from_secs(5), toast)
        .await
        .expect("says so");
}

#[tokio::test]
async fn archive_ends_a_kept_process() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, live) = parked(&f, &core, &project).await;
    core.archive_space(&s.id).await.unwrap();
    assert!(live.was_killed());
    assert!(!core.has_parked(&s.id));
    assert_eq!(
        task_status(&f, &s.id, "t1"),
        Some(BackgroundTaskStatus::Stopped)
    );
}

#[tokio::test]
async fn undo_ends_a_kept_process() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, live) = parked(&f, &core, &project).await;
    core.undo_space_turn(&s.id).await.unwrap();
    assert!(live.was_killed());
    assert!(!core.has_parked(&s.id));
    assert_eq!(
        task_status(&f, &s.id, "t1"),
        Some(BackgroundTaskStatus::Stopped)
    );
    assert!(
        space(&f, &s.id).background_tasks[0]
            .note
            .as_deref()
            .unwrap()
            .contains("Undo")
    );
}

#[tokio::test]
async fn quitting_ends_every_kept_process() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (_s, live) = parked(&f, &core, &project).await;
    core.stop_all_running_spaces().await;
    assert!(live.was_killed());
}

/// An unknown mode change can't reuse the process either.
#[tokio::test]
async fn a_mode_change_ends_the_process() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, live) = parked(&f, &core, &project).await;
    f.agents.push_script(vec![done_event("ok")]);
    core.space_send(SpaceSendRequest {
        mode: Some(theodore_contract::SpaceMode::Ask),
        ..send(&s.id, "just look")
    })
    .await
    .unwrap();
    assert!(live.was_killed());
    wait_until(|| f.agents.requests().len() == 2).await;
    assert_eq!(f.agents.last_request().unwrap().mode, AgentMode::ReadOnly);
}

#[tokio::test]
async fn held_queue_send_still_works_after_the_follow_up() {
    // A message that waited out a kept process's follow-up runs by its Send.
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, live) = parked(&f, &core, &project).await;
    live.emit(AgentEvent::FollowUp).await;
    wait_until(|| space(&f, &s.id).status == SpaceStatus::Running).await;
    let q = core.space_send(send(&s.id, "later")).await.unwrap();
    live.emit(AgentEvent::Lingering).await;
    live.emit(done_event("done")).await;
    wait_until(|| space(&f, &s.id).turns == 2).await;
    wait_until(|| !live.steered().is_empty()).await;
    assert!(live.steered()[0].ends_with("later"));
    // It ran as a normal message: no longer queued.
    let m = transcript(&f, &s.id)
        .into_iter()
        .find(|m| m.id == q)
        .unwrap();
    assert!(m.queued.is_none());
    core.space_queued(SpaceQueuedRequest {
        space: s.id.clone(),
        message: "unknown".into(),
        action: QueuedAction::Cancel,
    })
    .await
    .expect_err("gone");
}
