//! Restarting with turns running (docs/spaces.md §7 "Restart with turns
//! running"): the pause interrupts each running agent at a safe point,
//! marks the space and checkpoints the turn (an agent that ignores the
//! interrupt is killed, still marked); the next start resumes each marked
//! turn once with the continuation message; queued messages wait for it.
//! And the agent's view of the updater, `theodore_version` /
//! `theodore_update`, per updater state — against `Core` + testkit fakes.

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use theodore_contract::{
    AddProjectRequest, ChatMessage, CreateSpaceRequest, Project, RestartReason, Space,
    SpaceSendRequest, SpaceStatus, models,
};
use theodore_domain::{Author, Sha, Usage};
use theodore_fleet_protocol::McpAuto;
use theodore_ports::{
    AgentEvent, NO_UPDATER, NewAction, SpaceToolError, Store, SyncActionCode, UpdateStart,
    UpdaterState,
};

use crate::testkit::{FakeLive, FakeUpdater, Fixtures, fixtures};
use crate::usecases::fleet::TrustedDevice;
use crate::usecases::space_restart::{PAUSED_FOR_RESTART, continuation_text};
use crate::usecases::spaces::space_chat_key;
use crate::{Core, Receivers};

async fn wait_until(mut cond: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while std::time::Instant::now() < deadline {
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

fn done(text: &str) -> AgentEvent {
    AgentEvent::Done {
        final_text: text.into(),
        usage: Usage::default(),
    }
}

/// A space whose goal turn is running on a fake CLI that stays open,
/// reporting session `session`.
async fn running(
    f: &Fixtures,
    core: &Core,
    project: &Project,
    session: &str,
) -> (Space, Arc<FakeLive>) {
    let live = f.agents.push_live_run(vec![
        AgentEvent::Session { id: session.into() },
        AgentEvent::Text {
            text: "working on it".into(),
        },
    ]);
    let s = core.create_space(request(project, "Go")).await.unwrap();
    wait_until(|| space(f, &s.id).status == SpaceStatus::Running).await;
    // The script is read by the turn before anything else happens to it.
    wait_until(|| {
        core.steer_of(space(f, &s.id).run.as_deref().unwrap_or(""))
            .is_some()
    })
    .await;
    (s, live)
}

fn update(version: &str) -> RestartReason {
    RestartReason::Update {
        version: version.into(),
    }
}

#[tokio::test]
async fn pausing_interrupts_each_turn_marks_it_and_checkpoints_it() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    core.set_pause_wait(Duration::from_millis(300));
    // Honors the interrupt: ends its turn like the real CLI, mid-reply.
    let (polite, live1) = running(&f, &core, &project, "sess-1").await;
    live1.on_interrupt(vec![AgentEvent::Error {
        message: "[ede_diagnostic] result_type=user".into(),
        stderr_tail: String::new(),
    }]);
    // Ignores it: nothing comes back until it is killed.
    let polite_run = space(&f, &polite.id).run.clone().expect("running");
    let (stubborn, live2) = running(&f, &core, &project, "sess-2").await;
    let idle = core.create_space(request(&project, "Idle")).await.unwrap();
    f.agents.push_script(vec![done("idle done")]);
    wait_until(|| space(&f, &idle.id).status != SpaceStatus::Running).await;
    f.git.push_checkpoint(Sha::new("ckpt-polite"));
    f.git.push_checkpoint(Sha::new("ckpt-stubborn"));

    let report = core.pause_for_restart(update("0.2.0")).await;
    assert_eq!(report.paused, 2);
    assert_eq!(report.killed, 1);
    assert!(core.restart_pending());

    // The polite one: interrupted, never killed, its turn ended.
    assert_eq!(live1.interrupts(), 1);
    assert!(!live1.was_killed());
    let s = space(&f, &polite.id);
    assert_eq!(s.status, SpaceStatus::Idle);
    assert_eq!(s.run, None);
    let marker = s.restart_pause.clone().expect("marked");
    assert_eq!(marker.run, polite_run);
    assert_eq!(marker.message, polite_run.rsplit(':').next().unwrap());
    assert_eq!(marker.agent, s.agent);
    assert_eq!(marker.mode, s.mode);
    assert!(!marker.killed);
    assert_eq!(marker.reason, update("0.2.0"));
    assert_eq!(
        marker.session.as_ref().map(|s| s.id.as_str()),
        Some("sess-1"),
        "the session to resume"
    );
    assert_eq!(
        s.agent_session.as_ref().map(|s| s.id.as_str()),
        Some("sess-1")
    );
    let reply = transcript(&f, &polite.id)
        .into_iter()
        .find(|m| m.author != Author::Me)
        .expect("a reply");
    assert_eq!(reply.failed.as_deref(), Some(PAUSED_FOR_RESTART));
    assert_eq!(reply.text, "working on it");
    assert!(s.turn_log.last().unwrap().stopped);
    assert_eq!(s.error, None, "a pause is no failure");

    // The stubborn one: interrupted, then killed, still marked to resume.
    assert_eq!(live2.interrupts(), 1);
    assert!(live2.was_killed());
    let s = space(&f, &stubborn.id);
    assert_eq!(s.status, SpaceStatus::Idle);
    let marker = s.restart_pause.expect("marked");
    assert!(marker.killed);
    assert_eq!(marker.reason, update("0.2.0"));

    // Both turns were checkpointed as paused.
    let checkpoints = f.git.checkpoints.lock().unwrap().clone();
    let paused: Vec<&(String, String)> = checkpoints
        .iter()
        .filter(|(_, m)| m.ends_with("(paused for the restart)"))
        .collect();
    assert_eq!(paused.len(), 2, "{checkpoints:?}");

    // Nothing starts while restarting: a send waits in the queue.
    let queued = core.space_send(send(&idle.id, "later")).await.unwrap();
    let m = transcript(&f, &idle.id)
        .into_iter()
        .find(|m| m.id == queued)
        .unwrap();
    assert!(m.queued.is_some(), "queued, not started");
    assert!(!m.queued.unwrap().held);
    assert_eq!(space(&f, &idle.id).status, SpaceStatus::Idle);
    assert_eq!(space(&f, &idle.id).restart_pause, None, "it wasn't running");
}

#[tokio::test]
async fn the_next_start_resumes_each_marked_turn_once_and_runs_the_queue_after() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    core.set_pause_wait(Duration::from_millis(300));
    let (s, live) = running(&f, &core, &project, "sess-1").await;
    live.on_interrupt(vec![done("partial")]);
    // Sent while the turn ran: it waits for the resumed turn.
    let queued = core.space_send(send(&s.id, "and then this")).await.unwrap();
    let before = f.agents.requests().len();
    core.pause_for_restart(update("0.2.0")).await;
    assert!(space(&f, &s.id).restart_pause.is_some());
    assert_eq!(f.agents.requests().len(), before, "nothing started");
    drop(core);

    // The next launch: the resumed turn, then the queued message.
    f.agents.push_script(vec![
        AgentEvent::Session {
            id: "sess-1".into(),
        },
        done("resumed and finished"),
    ]);
    f.agents.push_script(vec![done("queued done")]);
    let (core2, _recv2) = Core::start(f.deps());
    wait_until(|| space(&f, &s.id).turns == 3).await;
    let row = space(&f, &s.id);
    assert_eq!(row.restart_pause, None, "the marker goes with the resume");
    assert_eq!(row.status, SpaceStatus::Idle);
    let requests = f.agents.requests();
    let resumed = &requests[before];
    assert_eq!(
        resumed.resume.as_deref(),
        Some("sess-1"),
        "the same session"
    );
    assert_eq!(resumed.prompt, continuation_text(&update("0.2.0")));
    assert!(resumed.prompt.contains("updated to 0.2.0"));
    let after = &requests[before + 1];
    assert_eq!(
        after.prompt, "and then this",
        "the queued message ran after"
    );
    let chat = transcript(&f, &s.id);
    let q = chat.iter().find(|m| m.id == queued).unwrap();
    assert_eq!(q.queued, None);
    assert!(
        chat.iter()
            .any(|m| m.author == Author::Me && m.text == continuation_text(&update("0.2.0")))
    );
    // Only the continuation and the queued message ran: two turns.
    assert_eq!(requests.len(), before + 2);
    drop(core2);

    // A further start resumes nothing: the marker is gone.
    let (_core3, _recv3) = Core::start(f.deps());
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(f.agents.requests().len(), before + 2);
    assert_eq!(space(&f, &s.id).restart_pause, None);
}

#[tokio::test]
async fn a_pause_that_died_before_the_turn_ended_is_still_resumed() {
    // The marker was written, then Theodore died: the space reads as
    // interrupted on start, and the marker still resumes it.
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let (s, _live) = running(&f, &core, &project, "sess-1").await;
    let run = space(&f, &s.id).run.clone().unwrap();
    core.apply(vec![NewAction {
        model: models::SPACE.into(),
        model_id: s.id.clone(),
        action: SyncActionCode::C,
        data: Some(json!({
            "restart_pause": {
                "run": run,
                "message": "m1",
                "agent": "claude",
                "mode": "edit",
                "reason": { "kind": "quit" },
                "at": 1,
            },
            "agent_session": { "agent": "claude", "id": "sess-1", "cwd": s.worktree },
        })),
    }])
    .await
    .unwrap();
    let before = f.agents.requests().len();
    drop(core);

    f.agents.push_script(vec![done("back")]);
    let (_core2, _recv2) = Core::start(f.deps());
    wait_until(|| f.agents.requests().len() == before + 1).await;
    let req = f.agents.last_request().unwrap();
    assert_eq!(req.prompt, continuation_text(&RestartReason::Quit));
    assert_eq!(req.resume.as_deref(), Some("sess-1"));
    wait_until(|| space(&f, &s.id).status == SpaceStatus::Idle).await;
    assert_eq!(space(&f, &s.id).restart_pause, None);
}

#[tokio::test]
async fn the_version_and_update_tools_follow_the_updater() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    f.agents.push_script(vec![done("ok")]);
    let s = core.create_space(request(&project, "Go")).await.unwrap();
    wait_until(|| space(&f, &s.id).status != SpaceStatus::Running).await;

    // No updater (the CLI, tests): says so, never fails.
    let v = core.space_tool_theodore_version(&s.id).await.unwrap();
    assert_eq!(
        v.updater,
        UpdaterState::Unavailable {
            reason: NO_UPDATER.into()
        }
    );
    let updater = FakeUpdater::new();
    core.set_updater(updater.clone());
    let v = core.space_tool_theodore_version(&s.id).await.unwrap();
    assert_eq!(v.version, "0.1.0");
    assert_eq!(v.channel, "stable");
    assert_eq!(v.updater, UpdaterState::UpToDate);
    updater.set_state(UpdaterState::Downloading {
        version: "0.2.0".into(),
        percent: Some(40),
    });
    assert_eq!(
        core.space_tool_theodore_version(&s.id)
            .await
            .unwrap()
            .updater,
        UpdaterState::Downloading {
            version: "0.2.0".into(),
            percent: Some(40)
        }
    );

    // Update: only from the running turn.
    let refused = core.space_tool_theodore_update(&s.id, "nope").await;
    assert_eq!(
        refused,
        Err(SpaceToolError::Unavailable("this turn is over".into()))
    );
    assert_eq!(updater.updates(), 0);
    core.apply(vec![NewAction {
        model: models::SPACE.into(),
        model_id: s.id.clone(),
        action: SyncActionCode::C,
        data: Some(json!({ "status": "running", "run": "r1" })),
    }])
    .await
    .unwrap();
    assert_eq!(
        core.space_tool_theodore_update(&s.id, "r1").await.unwrap(),
        UpdateStart::Downloading {
            version: "0.2.0".into()
        }
    );
    updater.set_state(UpdaterState::UpToDate);
    assert_eq!(
        core.space_tool_theodore_update(&s.id, "r1").await.unwrap(),
        UpdateStart::UpToDate
    );
    updater.set_state(UpdaterState::Available {
        version: "0.2.0".into(),
    });
    assert_eq!(
        core.space_tool_theodore_update(&s.id, "r1").await.unwrap(),
        UpdateStart::Downloading {
            version: "0.2.0".into()
        }
    );
    updater.set_state(UpdaterState::Ready {
        version: "0.2.0".into(),
    });
    assert_eq!(
        core.space_tool_theodore_update(&s.id, "r1").await.unwrap(),
        UpdateStart::Restarting {
            version: "0.2.0".into()
        }
    );
    assert_eq!(updater.updates(), 4);

    // Hosted here for a device not trusted here: never.
    core.fleet().hosting.insert(s.id.clone(), "dev-2".into());
    let hosted = core.space_tool_theodore_update(&s.id, "r1").await;
    assert!(
        matches!(&hosted, Err(SpaceToolError::Unavailable(m)) if m.contains("another device")),
        "{hosted:?}"
    );
    assert_eq!(updater.updates(), 4, "nothing was asked");
    // Reading the version is fine from anywhere.
    assert!(core.space_tool_theodore_version(&s.id).await.is_ok());

    // Hosted for the user's own trusted phone (someone drives this
    // computer from it): allowed, the same way. For a trusted `mcp` origin
    // (Claude via cloud): still never.
    let pin = |id: &str, kind: &str| TrustedDevice {
        device_id: id.into(),
        public_key: "k".into(),
        name: id.into(),
        kind: Some(kind.into()),
        auto: McpAuto::Off,
        auto_until_ms: None,
    };
    let mut settings = core.fleet_settings().await;
    settings.trusted_devices = vec![pin("phone-1", "mobile"), pin("mcp-1", "mcp")];
    core.fleet_save_settings(&settings).await.unwrap();
    core.fleet().hosting.insert(s.id.clone(), "phone-1".into());
    assert_eq!(
        core.space_tool_theodore_update(&s.id, "r1").await.unwrap(),
        UpdateStart::Restarting {
            version: "0.2.0".into()
        }
    );
    assert_eq!(updater.updates(), 5);
    core.fleet().hosting.insert(s.id.clone(), "mcp-1".into());
    let mcp = core.space_tool_theodore_update(&s.id, "r1").await;
    assert!(
        matches!(&mcp, Err(SpaceToolError::Unavailable(m)) if m.contains("another device")),
        "{mcp:?}"
    );
    assert_eq!(updater.updates(), 5, "nothing was asked");
}
