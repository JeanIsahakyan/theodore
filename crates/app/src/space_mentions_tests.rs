//! `@` mentions of other spaces (docs/spaces.md "Mentions") against `Core`
//! and the testkit fakes: the message keeps the chips, the turn's prompt
//! carries each space's context as data, bounded, for local, mirrored,
//! archived and missing spaces, now or when it leaves the queue.

use theodore_contract::{ChatMessage, Space, SpaceRemote, SpaceSendRequest, SpaceStatus, models};
use theodore_ports::{NewAction, OTHER_SPACE_NOTE, Store, SyncActionCode};

use crate::space_children_tests::{parent, send};
use crate::space_commands_tests::{Env, done, start_env, wait_until};
use crate::usecases::space_mentions::{MENTION_CONTEXT_CHARS, MENTIONS_MAX};

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

/// Another space whose first turn replied `reply`.
async fn other(e: &Env, goal: &str, reply: &str) -> Space {
    e.f.agents.push_script(done(reply));
    let s = e.create(goal).await;
    e.until(&s.id, |s| s.turns == 1 && s.run.is_none()).await
}

fn mentioning(space: &str, text: &str, ids: &[&str]) -> SpaceSendRequest {
    SpaceSendRequest {
        mentions: Some(ids.iter().map(|s| s.to_string()).collect()),
        ..send(space, text)
    }
}

fn message(e: &Env, id: &str) -> ChatMessage {
    serde_json::from_value(
        e.f.store
            .get(models::CHAT_MESSAGE, id)
            .unwrap()
            .unwrap()
            .data,
    )
    .unwrap()
}

/// Sends `req` in `space` and returns the turn's prompt and the message.
async fn turn(e: &Env, space: &str, req: SpaceSendRequest) -> (String, ChatMessage) {
    let before = e.space(space).turns;
    e.f.agents.push_script(done("ok"));
    let id = e.core.space_send(req).await.unwrap();
    e.until(space, |s| s.turns > before && s.run.is_none())
        .await;
    let prompt = e.f.agents.last_request().unwrap().prompt;
    (prompt, message(e, &id))
}

#[tokio::test]
async fn a_mention_is_a_chip_and_the_turn_hears_that_space_as_data() {
    let e = start_env(true).await;
    let me = parent(&e).await;
    let b = other(
        &e,
        "Pick a store\nSQLite or Postgres",
        "Built it on SQLite.",
    )
    .await;
    turn(&e, &b.id, send(&b.id, "Why SQLite?")).await;
    let (prompt, sent) = turn(
        &e,
        &me.id,
        mentioning(&me.id, "Use what this one chose", &[&b.id, &b.id, &me.id]),
    )
    .await;

    assert_eq!(sent.text, "Use what this one chose", "stored as typed");
    assert_eq!(sent.mentions.len(), 1, "once, never this space");
    assert_eq!(sent.mentions[0].space, b.id);
    assert_eq!(sent.mentions[0].title, "Pick a store");
    assert_eq!(sent.mentions[0].host, None);

    let at = prompt.find("Use what this one chose").unwrap();
    let block = &prompt[at..];
    for want in [
        OTHER_SPACE_NOTE,
        &format!("### \"Pick a store\" (space {})", b.id),
        "status: idle",
        &format!("branch: {}", b.branch),
        "Goal: Pick a store\nSQLite or Postgres",
        "Diff: ",
        // The fake clock stamps every row alike: which one is last isn't
        // fixed here, only that the last reply and the ones before it come.
        "Last reply (claude):\n",
        "Other recent messages, oldest first:\n",
        "Built it on SQLite.",
        "Why SQLite?",
    ] {
        assert!(block.contains(want), "{want:?} in {block}");
    }
    assert!(!block.contains(&format!("(space {})", me.id)));

    // The next turn's replayed history names it, without its context again.
    e.f.agents.push_script(done("ok"));
    let next = crate::usecases::spaces::turn_prompt(
        &e.core.space_history(&e.space(&me.id)).await.unwrap(),
        "next",
    );
    assert!(next.contains("(mentioned spaces: Pick a store)"), "{next}");
}

#[tokio::test]
async fn mentions_alone_make_a_message_and_too_many_are_refused() {
    let e = start_env(true).await;
    let me = parent(&e).await;
    let b = other(&e, "Notes", "Wrote them.").await;
    let (prompt, sent) = turn(&e, &me.id, mentioning(&me.id, "", &[&b.id])).await;
    assert_eq!(sent.mentions.len(), 1);
    assert!(prompt.contains("Wrote them."), "{prompt}");

    let ids: Vec<String> = (0..=MENTIONS_MAX).map(|i| format!("s{i}")).collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let r = e.core.space_send(mentioning(&me.id, "x", &refs)).await;
    assert!(r.unwrap_err().to_string().contains("at most"), "refused");
}

#[tokio::test]
async fn the_context_stays_bounded_whatever_the_spaces_hold() {
    let e = start_env(true).await;
    let me = parent(&e).await;
    let big = "word ".repeat(4_000);
    let mut ids = Vec::new();
    for i in 0..3 {
        ids.push(other(&e, &format!("Space {i}\n{big}"), &big).await.id);
    }
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let (prompt, _) = turn(&e, &me.id, mentioning(&me.id, "Compare these", &refs)).await;
    let at = prompt.find("Spaces the user mentioned").unwrap();
    let block = &prompt[at..];
    assert!(
        block.chars().count() <= MENTION_CONTEXT_CHARS,
        "{}",
        block.chars().count()
    );
    for i in 0..3 {
        assert!(block.contains(&format!("\"Space {i}\"")), "space {i} named");
    }
}

#[tokio::test]
async fn mirrored_archived_and_missing_spaces_say_what_is_known() {
    let e = start_env(true).await;
    let me = parent(&e).await;
    let mirror = other(&e, "Remote work", "Shipped the API.").await;
    patch(
        &e,
        &mirror.id,
        serde_json::json!({
            "remote": SpaceRemote {
                space: "rs_1".into(),
                host_device: "dev_2".into(),
                host_name: "Studio".into(),
                project_name: "widget".into(),
                started_here: true,
            }
        }),
    );
    let gone = other(&e, "Old work", "Done long ago.").await;
    e.core.archive_space(&gone.id).await.unwrap();
    assert_eq!(e.space(&gone.id).status, SpaceStatus::Archived);

    let (prompt, sent) = turn(
        &e,
        &me.id,
        mentioning(&me.id, "Catch up", &[&mirror.id, &gone.id, "s_nope"]),
    )
    .await;
    let host: Vec<_> = sent.mentions.iter().map(|m| m.host.as_deref()).collect();
    assert_eq!(host, vec![Some("Studio"), None, None]);
    assert_eq!(sent.mentions[2].title, "s_nope", "named by its id");

    for want in [
        "Project: widget",
        "Runs on Studio, which is offline: this is what its mirror here last synced",
        "Shipped the API.",
        "status: archived",
        "Archived: it no longer runs",
        "Done long ago.",
        "### \"s_nope\" (space s_nope)\nNot on this device any more",
    ] {
        assert!(prompt.contains(want), "{want:?} in {prompt}");
    }
}

#[tokio::test]
async fn a_queued_message_keeps_its_mentions_and_expands_when_it_runs() {
    let e = start_env(true).await;
    let me = parent(&e).await;
    let b = other(&e, "Pick a store", "SQLite.").await;
    let go = e.f.agents.pause_next_run();
    e.f.agents.push_script(done("first"));
    e.core.space_send(send(&me.id, "first")).await.unwrap();
    e.until(&me.id, |s| s.status == SpaceStatus::Running).await;
    // Mentions can't go into the running turn: "Send now" queues it.
    let queued = e
        .core
        .space_send_now(mentioning(&me.id, "then this", &[&b.id]))
        .await
        .unwrap();
    assert!(message(&e, &queued).queued.is_some());
    assert_eq!(message(&e, &queued).mentions[0].space, b.id);

    e.f.agents.push_script(done("second"));
    go.send(()).unwrap();
    wait_until(|| {
        e.f.agents
            .requests()
            .iter()
            .any(|r| r.prompt.contains("then this"))
    })
    .await;
    let prompt =
        e.f.agents
            .requests()
            .into_iter()
            .find(|r| r.prompt.contains("then this"))
            .unwrap()
            .prompt;
    assert!(prompt.contains("Last reply (claude):\nSQLite."), "{prompt}");
    assert_eq!(message(&e, &queued).mentions.len(), 1, "kept once sent");
}

#[tokio::test]
async fn a_remote_space_takes_no_mentions() {
    let e = start_env(true).await;
    let me = parent(&e).await;
    let b = other(&e, "Elsewhere", "ok").await;
    patch(
        &e,
        &me.id,
        serde_json::json!({
            "remote": SpaceRemote {
                space: "rs_2".into(),
                host_device: "dev_2".into(),
                host_name: "Studio".into(),
                project_name: "widget".into(),
                started_here: true,
            }
        }),
    );
    let r = e.core.space_send(mentioning(&me.id, "x", &[&b.id])).await;
    assert!(r.unwrap_err().to_string().contains("Studio"));
}
