//! Reports from a chat (docs/telemetry.md "Report from a chat"): drafts
//! name a chat and a message (or the agent's run); the conversation is read
//! when the report window asks — against `Core` + `testkit` fakes.

use std::time::Duration;

use serde_json::json;
use theodore_contract::{
    AddProjectRequest, ChatMessage, CreateSpaceRequest, DraftReportRequest, Ephemeral, Project,
    ReportScope, Space, SpaceSendRequest, SpaceStatus, models,
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

async fn idle(f: &Fixtures, id: &str) -> Space {
    wait_until(|| space(f, id).status != SpaceStatus::Running).await;
    space(f, id)
}

fn tool_then_done(text: &str) -> Vec<AgentEvent> {
    vec![
        AgentEvent::ToolCall {
            id: "t1".into(),
            name: "Bash".into(),
            input: json!({"command": "cargo test"}),
        },
        AgentEvent::ToolResult {
            id: "t1".into(),
            ok: true,
            output: "ok".into(),
        },
        AgentEvent::Done {
            final_text: text.into(),
            usage: Usage::default(),
        },
    ]
}

/// A space with two turns: "First" → "one", "second" → "two".
async fn two_turns(f: &Fixtures) -> (Core, Receivers, Space) {
    let (core, recv, project) = started(f).await;
    f.agents.push_script(tool_then_done("one"));
    f.git.push_checkpoint(Sha::new("turn1"));
    let s = core
        .create_space(CreateSpaceRequest {
            project: project.id.clone(),
            goal: "First".into(),
            name: None,
            branch: None,
            base: None,
            agent: None,
            model: None,
            start_from: None,
        })
        .await
        .unwrap();
    idle(f, &s.id).await;
    f.agents.push_script(tool_then_done("two"));
    f.git.push_checkpoint(Sha::new("turn2"));
    core.space_send(SpaceSendRequest {
        space: s.id.clone(),
        text: "second".into(),
        agent: None,
        model: None,
        mode: None,
        attachments: None,
    })
    .await
    .unwrap();
    let s = idle(f, &s.id).await;
    (core, recv, s)
}

fn about(chat: PrId, message: Option<String>) -> DraftReportRequest {
    DraftReportRequest {
        chat,
        message,
        title: None,
        description: Some("It ignored me".into()),
        scope: None,
        include_logs: None,
    }
}

fn row<'a>(rows: &'a [(String, String)], k: &str) -> Option<&'a str> {
    rows.iter().find(|(l, _)| l == k).map(|(_, v)| v.as_str())
}

/// A tool call's stored input and output open in its row, and never reach a
/// report: that stays one line per call.
#[tokio::test]
async fn a_report_stays_one_line_per_call_however_much_a_call_stored() {
    let f = fixtures();
    let (core, _recv, project) = started(&f).await;
    let marker = "PAYLOAD-MARKER";
    f.agents.push_script(vec![
        AgentEvent::ToolCall {
            id: "t1".into(),
            name: "Bash".into(),
            input: json!({"command": format!("cargo test\necho {marker}")}),
        },
        AgentEvent::ToolResult {
            id: "t1".into(),
            ok: true,
            output: format!("output {marker}"),
        },
        AgentEvent::Done {
            final_text: "done".into(),
            usage: Usage::default(),
        },
    ]);
    f.git.push_checkpoint(Sha::new("turn1"));
    let s = core
        .create_space(CreateSpaceRequest {
            project: project.id.clone(),
            goal: "First".into(),
            name: None,
            branch: None,
            base: None,
            agent: None,
            model: None,
            start_from: None,
        })
        .await
        .unwrap();
    idle(&f, &s.id).await;

    let chat = transcript(&f, &s.id);
    let reply = chat.iter().find(|m| m.text == "done").unwrap();
    let run = reply.run.clone().unwrap();
    let stored = core
        .tool_payload(run, "t1".into())
        .await
        .unwrap()
        .expect("the call's payload is stored");
    assert!(
        stored.result.unwrap().output.unwrap().text.contains(marker),
        "the row has it"
    );
    assert!(
        !format!("{:?}", reply.activity).contains(marker),
        "and the synced steps don't: {:?}",
        reply.activity
    );

    let draft = core
        .draft_report(about(space_chat_key(&s.id), Some(reply.id.clone())), None)
        .await
        .unwrap();
    let context = core.report_context(&draft.id).await.unwrap().context;
    assert_eq!(context.tools.len(), 1, "{:?}", context.tools);
    assert!(
        !format!("{context:?}").contains(marker),
        "the report doesn't: {context:?}"
    );
}

#[tokio::test]
async fn report_this_on_a_reply_brings_its_turn_and_run() {
    let f = fixtures();
    let (core, mut recv, s) = two_turns(&f).await;
    let chat = transcript(&f, &s.id);
    let reply = chat.iter().find(|m| m.text == "two").unwrap();
    let asked = chat.iter().find(|m| m.text == "second").unwrap();
    let run = format!("space:{}:{}", s.id, asked.id);
    assert_eq!(
        reply.run.as_deref(),
        Some(run.as_str()),
        "the reply keeps its run"
    );

    let draft = core
        .draft_report(about(space_chat_key(&s.id), Some(reply.id.clone())), None)
        .await
        .unwrap();
    assert_eq!(draft.scope, ReportScope::Turn);
    assert!(draft.include_logs && !draft.by_agent);
    assert_eq!(draft.description, "It ignored me");
    assert!(
        draft.about.starts_with("Space turn 2 of 2"),
        "{}",
        draft.about
    );
    // The window opens on it.
    let opened = loop {
        match recv.ephemeral.try_recv() {
            Ok(Ephemeral::ReportDraft { draft }) => break draft,
            Ok(_) => continue,
            Err(e) => panic!("no report_draft event: {e:?}"),
        }
    };
    assert_eq!(opened, draft);

    let r = core.report_context(&draft.id).await.unwrap();
    assert_eq!(r.run.as_deref(), Some(run.as_str()));
    let c = r.context;
    assert_eq!(c.prompt.as_deref(), Some("second"));
    assert_eq!(c.reply.as_deref(), Some("two"));
    assert_eq!(c.tools.len(), 1, "{:?}", c.tools);
    assert!(c.tools[0].starts_with("✓ Bash"), "{:?}", c.tools);
    assert_eq!(c.error, None);
    assert_eq!(row(&c.rows, "Where"), Some("Space turn 2 of 2"));
    assert_eq!(row(&c.rows, "Status"), Some("answered"));
    assert_eq!(row(&c.rows, "Drafted by"), Some("you"));
    assert_eq!(row(&c.rows, "Run"), Some(run.as_str()));
    assert!(row(&c.rows, "Mode").unwrap().contains("(the space's now)"));
    assert!(row(&c.rows, "Agent CLI").is_some());
    // Nothing names the space, the project or its folder.
    let all = format!("{c:?}");
    assert!(!all.contains(&s.name) || s.name.is_empty(), "{all}");
    assert!(!all.contains("my-folder"), "{all}");
}

#[tokio::test]
async fn the_agents_draft_follows_its_run_to_the_reply() {
    let f = fixtures();
    let (core, _recv, s) = two_turns(&f).await;
    let chat = transcript(&f, &s.id);
    let asked = chat.iter().find(|m| m.text == "second").unwrap();
    let run = format!("space:{}:{}", s.id, asked.id);

    let draft = core
        .draft_report(
            DraftReportRequest {
                title: Some("  Agent ignored the instruction  ".into()),
                ..about(space_chat_key(&s.id), None)
            },
            Some(run.clone()),
        )
        .await
        .unwrap();
    assert!(draft.by_agent);
    assert_eq!(draft.title, "Agent ignored the instruction");
    let c = core.report_context(&draft.id).await.unwrap().context;
    assert_eq!(c.reply.as_deref(), Some("two"));
    assert_eq!(
        row(&c.rows, "Drafted by"),
        Some("the agent (report_problem)")
    );
}

/// A prompt-injected agent: its prefill is redacted and pings no one, and
/// calling the tool again in the same turn opens no second window.
#[tokio::test]
async fn an_agent_drafts_once_per_turn_and_quietly() {
    let f = fixtures();
    let (core, mut recv, s) = two_turns(&f).await;
    let chat = transcript(&f, &s.id);
    let asked = chat.iter().find(|m| m.text == "second").unwrap();
    let run = format!("space:{}:{}", s.id, asked.id);
    let req = DraftReportRequest {
        title: Some("leak ghp_abcdefghijklmnopqrstuvwxyz0123456789\nnow".into()),
        description: Some("cc @octocat, see #1 and sk-ant-api03-AbCdEfGhIjKlMnOpQrSt".into()),
        ..about(space_chat_key(&s.id), None)
    };
    while recv.ephemeral.try_recv().is_ok() {}

    let draft = core
        .draft_report(req.clone(), Some(run.clone()))
        .await
        .unwrap();
    assert_eq!(draft.title, "leak [redacted:github] now");
    assert_eq!(
        draft.description,
        "cc `@octocat`, see `#1` and [redacted:key]"
    );

    let again = core
        .draft_report(req.clone(), Some(run.clone()))
        .await
        .unwrap_err();
    assert!(matches!(again, AppError::Invalid(_)), "{again:?}");
    let mut windows = 0;
    while let Ok(e) = recv.ephemeral.try_recv() {
        if matches!(e, Ephemeral::ReportDraft { .. }) {
            windows += 1;
        }
    }
    assert_eq!(windows, 1, "one window for the turn");

    // You can still report it yourself, as often as you like, as typed.
    for _ in 0..2 {
        let mine = core.draft_report(req.clone(), None).await.unwrap();
        assert!(mine.description.contains("@octocat, see #1"));
    }
}

#[tokio::test]
async fn a_turn_still_running_reports_its_message_and_no_reply_yet() {
    let f = fixtures();
    let (core, _recv, s) = two_turns(&f).await;
    // A message whose turn hasn't answered yet.
    f.store
        .apply(vec![NewAction {
            model: models::CHAT_MESSAGE.into(),
            model_id: "m-live".into(),
            action: SyncActionCode::I,
            data: Some(json!({
                "id": "m-live", "pr": space_chat_key(&s.id).0, "author": {"kind": "me"},
                "text": "third", "refs": [], "at": 9_999_999_999_999i64,
            })),
        }])
        .unwrap();
    let run = format!("space:{}:m-live", s.id);
    let draft = core
        .draft_report(about(space_chat_key(&s.id), None), Some(run.clone()))
        .await
        .unwrap();
    let r = core.report_context(&draft.id).await.unwrap();
    assert_eq!(r.run.as_deref(), Some(run.as_str()));
    assert_eq!(r.context.prompt.as_deref(), Some("third"));
    assert_eq!(r.context.reply, None);
    assert_eq!(
        row(&r.context.rows, "Status"),
        Some("no reply yet (running)")
    );
    assert_eq!(
        row(&r.context.rows, "Where"),
        Some("Space turn 3 (running)")
    );
}

#[tokio::test]
async fn scopes_decide_how_much_of_the_conversation_goes() {
    let f = fixtures();
    let (core, _recv, s) = two_turns(&f).await;
    let reply = transcript(&f, &s.id)
        .into_iter()
        .find(|m| m.text == "two")
        .unwrap();
    let with = |scope| DraftReportRequest {
        scope: Some(scope),
        ..about(space_chat_key(&s.id), Some(reply.id.clone()))
    };

    let one = core
        .draft_report(with(ReportScope::Message), None)
        .await
        .unwrap();
    let c = core.report_context(&one.id).await.unwrap().context;
    assert_eq!((c.prompt, c.reply.as_deref()), (None, Some("two")));

    // A space's whole is `space`, whichever whole was asked for.
    let whole = core
        .draft_report(with(ReportScope::Review), None)
        .await
        .unwrap();
    assert_eq!(whole.scope, ReportScope::Space);
    let r = core.report_context(&whole.id).await.unwrap();
    assert_eq!((r.context.prompt, r.context.reply), (None, None));
    assert!(r.context.tools.is_empty());
    assert!(r.run.is_some(), "the latest run's logs still go");
    assert_eq!(row(&r.context.rows, "Space status"), Some("idle"));
}

#[tokio::test]
async fn an_ai_panel_reply_brings_its_question() {
    let f = fixtures();
    let (core, _recv, _project) = started(&f).await;
    let pr = PrId::new("github:acme/app#7");
    let put = |id: &str, data: serde_json::Value| {
        f.store
            .apply(vec![NewAction {
                model: models::CHAT_MESSAGE.into(),
                model_id: id.into(),
                action: SyncActionCode::I,
                data: Some(data),
            }])
            .unwrap();
    };
    put(
        "q1",
        json!({"id": "q1", "pr": pr.0, "author": {"kind": "me"}, "text": "why?", "refs": [], "at": 1000}),
    );
    put(
        "r1",
        json!({"id": "r1", "pr": pr.0, "author": {"kind": "agent", "agent": "codex"},
               "text": "", "refs": [], "at": 4000, "failed": "agent crashed: exit 1", "run": "ask:q1"}),
    );
    let draft = core
        .draft_report(about(pr.clone(), Some("r1".into())), None)
        .await
        .unwrap();
    assert_eq!(draft.about, "AI panel reply 1 of 1 · codex");
    let r = core.report_context(&draft.id).await.unwrap();
    assert_eq!(r.run.as_deref(), Some("ask:q1"));
    let c = r.context;
    assert_eq!(c.prompt.as_deref(), Some("why?"));
    assert_eq!(c.error.as_deref(), Some("agent crashed: exit 1"));
    assert_eq!(row(&c.rows, "Status"), Some("failed"));
    assert_eq!(row(&c.rows, "Mode"), Some("ask (read-only)"));
    assert_eq!(row(&c.rows, "Took"), Some("3.0 s"));
    assert_eq!(row(&c.rows, "Space status"), None);
    // A reply from before the model was recorded: no guess from settings.
    assert_eq!(
        row(&c.rows, "Model"),
        Some("unknown (not recorded on this reply)")
    );
}

#[tokio::test]
async fn unknown_messages_and_expired_drafts_are_refused() {
    let f = fixtures();
    let (core, _recv, s) = two_turns(&f).await;
    let e = core
        .draft_report(about(space_chat_key(&s.id), Some("nope".into())), None)
        .await
        .unwrap_err();
    assert!(matches!(e, AppError::NotFound(_)), "{e:?}");
    let e = core
        .draft_report(about(PrId::new("github:acme/app#9"), None), None)
        .await
        .unwrap_err();
    assert!(matches!(e, AppError::Invalid(_)), "an empty chat: {e:?}");
    let e = core.report_context("expired").await.unwrap_err();
    assert!(matches!(e, AppError::NotFound(_)), "{e:?}");
}

fn set_model(f: &Fixtures, value: serde_json::Value) {
    f.store
        .apply(vec![NewAction {
            model: models::SETTING.into(),
            model_id: "user:agents.claude.model".into(),
            action: SyncActionCode::I,
            data: Some(json!({ "key": "agents.claude.model", "scope": "user", "value": value })),
        }])
        .unwrap();
}

/// New space with a model picked in the menu: the space asks for none, the
/// `agents.claude.model` setting decides — the reply records the model the
/// run was sent, and a later change to the setting doesn't rewrite it.
#[tokio::test]
async fn the_model_row_is_the_one_the_run_used_from_the_setting() {
    let f = fixtures();
    set_model(&f, json!("claude-haiku-5-5"));
    let (core, _recv, s) = two_turns(&f).await;
    assert_eq!(s.model, None, "the space pins no model");
    assert_eq!(
        f.agents.last_request().unwrap().model.as_deref(),
        Some("claude-haiku-5-5"),
        "the run got the setting's model"
    );
    let chat = transcript(&f, &s.id);
    let first = chat.iter().find(|m| m.text == "one").unwrap();
    assert_eq!(first.model.as_deref(), Some("claude-haiku-5-5"));
    assert!(first.model_resolved);

    set_model(&f, json!("claude-opus-5-5"));
    let draft = core
        .draft_report(about(space_chat_key(&s.id), Some(first.id.clone())), None)
        .await
        .unwrap();
    let r = core.report_context(&draft.id).await.unwrap();
    assert_eq!(row(&r.context.rows, "Model"), Some("claude-haiku-5-5"));
}

#[tokio::test]
async fn the_model_row_says_the_cli_default_only_when_it_was() {
    let f = fixtures();
    let (core, _recv, s) = two_turns(&f).await;
    let chat = transcript(&f, &s.id);
    let reply = chat.iter().find(|m| m.text == "two").unwrap();
    assert_eq!(reply.model, None);
    assert!(reply.model_resolved);
    // Set after the run: not what it used.
    set_model(&f, json!("claude-opus-5-5"));
    let draft = core
        .draft_report(about(space_chat_key(&s.id), Some(reply.id.clone())), None)
        .await
        .unwrap();
    let r = core.report_context(&draft.id).await.unwrap();
    assert_eq!(row(&r.context.rows, "Model"), Some("the CLI's default"));
}
