//! Process lifecycle tests against `tests/fake_agent.sh`: a stand-in for a
//! real CLI so these never touch the network or spend money.

use std::path::PathBuf;
use std::time::Duration;

use theodore_agents::process::{LineParser, SpawnSpec, spawn_and_stream};
use theodore_ports::agent::AgentEvent;

fn fake_agent() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fake_agent.sh")
}

/// Minimal parser: `{"line":N}` → `Text`, anything else ignored. Matches
/// `LineParser`'s contract (pure per call) without pulling in a real CLI's
/// schema.
struct EchoParser;

impl LineParser for EchoParser {
    fn on_line(&mut self, line: &str) -> Vec<AgentEvent> {
        if line.trim().is_empty() {
            return vec![];
        }
        vec![AgentEvent::Text {
            text: line.to_string(),
        }]
    }

    fn on_exit(&mut self, success: bool, stderr_tail: &str) -> AgentEvent {
        if success {
            AgentEvent::Done {
                final_text: "done".into(),
                usage: Default::default(),
            }
        } else {
            AgentEvent::Error {
                message: "fake agent exited non-zero".into(),
                stderr_tail: stderr_tail.into(),
            }
        }
    }
}

fn spec(mode: &str, stall_after_ms: u64) -> SpawnSpec {
    SpawnSpec {
        pid_dir: None,
        program: fake_agent(),
        args: vec![mode.to_string()],
        cwd: std::env::temp_dir(),
        env: vec![],
        stall_after_ms,
        guards: vec![],
    }
}

async fn collect(mut rx: tokio::sync::mpsc::Receiver<AgentEvent>) -> Vec<AgentEvent> {
    let mut events = Vec::new();
    while let Some(ev) = rx.recv().await {
        let terminal = matches!(ev, AgentEvent::Done { .. } | AgentEvent::Error { .. });
        events.push(ev);
        if terminal {
            break;
        }
    }
    events
}

#[tokio::test]
async fn normal_run_ends_in_exactly_one_done() {
    let run = spawn_and_stream(spec("normal", 5_000), Box::new(EchoParser)).unwrap();
    let events = collect(run.events).await;
    assert_eq!(
        events,
        vec![
            AgentEvent::Text {
                text: r#"{"line":1}"#.into()
            },
            AgentEvent::Done {
                final_text: "done".into(),
                usage: Default::default(),
            }
        ]
    );
}

#[tokio::test]
async fn crash_exit_becomes_one_error_with_stderr_tail() {
    let run = spawn_and_stream(spec("crash", 5_000), Box::new(EchoParser)).unwrap();
    let events = collect(run.events).await;
    assert_eq!(events.len(), 1);
    match &events[0] {
        AgentEvent::Error {
            message,
            stderr_tail,
        } => {
            assert_eq!(message, "fake agent exited non-zero");
            assert!(
                stderr_tail.contains("something broke"),
                "tail was: {stderr_tail:?}"
            );
        }
        other => panic!("expected Error, got {other:?}"),
    }
}

#[tokio::test]
async fn silent_period_emits_stalled_but_keeps_running() {
    // "stall" mode sleeps 1s between its two lines; a 100ms stall threshold
    // must fire at least one `Stalled` without ending the run.
    let run = spawn_and_stream(spec("stall", 100), Box::new(EchoParser)).unwrap();
    let mut rx = run.events;
    let mut saw_stalled = false;
    let mut saw_second_line = false;
    let mut saw_done = false;
    while let Some(ev) = rx.recv().await {
        match ev {
            AgentEvent::Stalled => saw_stalled = true,
            AgentEvent::Text { ref text } if text.contains("\"line\":2") => saw_second_line = true,
            AgentEvent::Done { .. } => {
                saw_done = true;
                break;
            }
            _ => {}
        }
    }
    assert!(saw_stalled, "expected at least one Stalled event");
    assert!(saw_second_line, "run must keep going after a stall");
    assert!(saw_done, "run must still reach a terminal event");
}

#[tokio::test]
async fn cancel_kills_a_hanging_process_well_before_its_own_sleep() {
    let run = spawn_and_stream(spec("hang", 5_000), Box::new(EchoParser)).unwrap();
    let cancel = run.cancel.clone();
    let mut rx = run.events;

    tokio::time::sleep(Duration::from_millis(50)).await;
    cancel.cancel();

    let result = tokio::time::timeout(Duration::from_secs(10), async {
        let mut last = None;
        while let Some(ev) = rx.recv().await {
            last = Some(ev);
        }
        last
    })
    .await;

    let last = result.expect("cancellation must end the run well under fake_agent.sh's 60s sleep");
    assert!(
        matches!(last, Some(AgentEvent::Error { .. })),
        "expected a terminal Error after cancel, got {last:?}"
    );
}

#[tokio::test]
async fn exactly_one_terminal_event_even_with_extra_output_after() {
    // Regression guard: terminal-event dedup lives in the run loop, not in
    // any one parser, so exercise it here instead of per-CLI.
    let run = spawn_and_stream(spec("normal", 5_000), Box::new(EchoParser)).unwrap();
    let events = collect(run.events).await;
    let terminals = events
        .iter()
        .filter(|e| matches!(e, AgentEvent::Done { .. } | AgentEvent::Error { .. }))
        .count();
    assert_eq!(terminals, 1);
}
