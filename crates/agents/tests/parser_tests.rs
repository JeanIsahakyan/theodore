//! Fixture-driven parser tests: feed each CLI's normalizer every line of a
//! recorded (or, where noted, documented-schema) transcript and check the
//! fold ends in exactly one terminal event with the expected payload.

use theodore_agents::{claude, codex, gemini};
use theodore_domain::{AgentLimit, LimitStatus, Usage};
use theodore_ports::agent::AgentEvent;

fn terminals(events: &[AgentEvent]) -> Vec<&AgentEvent> {
    events
        .iter()
        .filter(|e| matches!(e, AgentEvent::Done { .. } | AgentEvent::Error { .. }))
        .collect()
}

#[test]
fn claude_real_text_run_fixture() {
    let fixture = include_str!("fixtures/claude_result.jsonl");
    let events: Vec<AgentEvent> = fixture.lines().flat_map(claude::parse_line).collect();
    let terms = terminals(&events);
    assert_eq!(terms.len(), 1, "exactly one terminal event, got {terms:?}");
    assert!(events.contains(&AgentEvent::Text { text: "ok".into() }));
    assert_eq!(
        terms[0],
        &AgentEvent::Done {
            final_text: "ok".into(),
            usage: Usage {
                input_tokens: 2 + 11543 + 10122,
                output_tokens: 82,
                usd: 0.0969684
            },
        }
    );
}

#[test]
fn claude_documented_tool_call_fixture() {
    let fixture = include_str!("fixtures/claude_tool_call.jsonl");
    let events: Vec<AgentEvent> = fixture.lines().flat_map(claude::parse_line).collect();
    let terms = terminals(&events);
    assert_eq!(terms.len(), 1);
    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolCall { name, .. } if name == "Bash"))
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolResult { ok: true, .. }))
    );
}

#[test]
fn codex_real_auth_error_fixture() {
    let fixture = include_str!("fixtures/codex_auth_error.jsonl");
    let mut last = String::new();
    let events: Vec<AgentEvent> = fixture
        .lines()
        .flat_map(|l| codex::parse_line(l, &mut last))
        .collect();
    let terms = terminals(&events);
    assert_eq!(terms.len(), 1, "exactly one terminal event, got {terms:?}");
    assert!(matches!(terms[0], AgentEvent::Error { .. }));
}

#[test]
fn codex_documented_success_fixture() {
    let fixture = include_str!("fixtures/codex_success.jsonl");
    let mut last = String::new();
    let events: Vec<AgentEvent> = fixture
        .lines()
        .flat_map(|l| codex::parse_line(l, &mut last))
        .collect();
    let terms = terminals(&events);
    assert_eq!(terms.len(), 1);
    assert_eq!(
        terms[0],
        &AgentEvent::Done {
            final_text: "ok".into(),
            usage: Usage {
                input_tokens: 120,
                output_tokens: 8,
                usd: 0.0
            },
        }
    );
}

/// gemini-cli v0.66.0's own stream-json snapshot
/// (`packages/cli/src/__snapshots__/nonInteractiveCli.test.ts.snap`),
/// timestamps filled in — not a recorded run.
#[test]
fn gemini_documented_stream_fixture() {
    let fixture = include_str!("fixtures/gemini_stream.jsonl");
    let mut parser = gemini::GeminiParser::new(false);
    let events: Vec<AgentEvent> = fixture.lines().flat_map(|l| parser.parse_line(l)).collect();
    let terms = terminals(&events);
    assert_eq!(terms.len(), 1);
    assert!(
        matches!(terms[0], AgentEvent::Done { final_text, .. } if final_text == "Final answer"),
        "{terms:?}"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, AgentEvent::ToolCall { name, .. } if name == "testTool"))
    );
}

/// Recorded from `claude -p … --permission-mode plan` (2.1.312, redacted):
/// `-p` has no `ExitPlanMode`, the plan is the file it writes under
/// `~/.claude/plans/`. The parser reports it as `Plan`, before `Done`.
#[test]
fn claude_plan_mode_fixture_reports_the_plan_file() {
    use theodore_agents::process::LineParser;
    let fixture = include_str!("fixtures/claude_plan_mode.jsonl");
    let mut parser = claude::ClaudeParser::new();
    let events: Vec<AgentEvent> = fixture.lines().flat_map(|l| parser.on_line(l)).collect();
    let plans: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::Plan { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(plans.len(), 1, "{events:?}");
    assert!(plans[0].starts_with("# Plan: make main.rs print"));
    assert!(plans[0].contains("## Verification"));
    let at = |f: fn(&AgentEvent) -> bool| events.iter().position(f).unwrap();
    assert!(
        at(|e| matches!(e, AgentEvent::Plan { .. })) < at(|e| matches!(e, AgentEvent::Done { .. }))
    );
    assert_eq!(terminals(&events).len(), 1);
}

#[test]
fn claude_exit_plan_mode_input_is_the_plan() {
    use theodore_agents::process::LineParser;
    let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"ExitPlanMode","input":{"plan":"1. Do it"}}]}}"#;
    let events = claude::ClaudeParser::new().on_line(line);
    assert!(events.contains(&AgentEvent::Plan {
        text: "1. Do it".into()
    }));
    // A write anywhere else is not a plan.
    let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Write","input":{"file_path":"/repo/notes.md","content":"x"}}]}}"#;
    let events = claude::ClaudeParser::new().on_line(line);
    assert!(!events.iter().any(|e| matches!(e, AgentEvent::Plan { .. })));
}

fn limits(events: &[AgentEvent]) -> Vec<&AgentLimit> {
    events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::Limit { limit } => Some(limit),
            _ => None,
        })
        .collect()
}

/// Shaped like a 2.1.329 run that hits its five-hour limit (built from the
/// binary's schema, not recorded): a warning, the refusal with its reset,
/// then the error result.
#[test]
fn claude_rate_limited_fixture_reports_each_limit_before_the_error() {
    use theodore_agents::process::LineParser;
    let fixture = include_str!("fixtures/claude_rate_limited.jsonl");
    let mut parser = claude::ClaudeParser::new();
    let events: Vec<AgentEvent> = fixture.lines().flat_map(|l| parser.on_line(l)).collect();
    let found = limits(&events);
    assert_eq!(found.len(), 2, "{events:?}");
    assert_eq!(found[0].status, LimitStatus::Warning);
    assert_eq!(found[0].window.as_deref(), Some("five_hour"));
    assert!((found[0].used_pct.unwrap() - 91.0).abs() < 1e-9);
    assert_eq!(found[0].resets_at, Some(1_795_000_000_000));
    assert_eq!(found[1].status, LimitStatus::Limited);
    assert_eq!(found[1].resets_at, Some(1_795_003_600_000));
    assert_eq!(found[1].used_pct, Some(100.0));
    assert_eq!(
        terminals(&events),
        vec![&AgentEvent::Error {
            message: "You've hit your session limit · resets 6pm".into(),
            stderr_tail: String::new(),
        }]
    );
    let at = |f: fn(&AgentEvent) -> bool| events.iter().position(f).unwrap();
    assert!(
        at(|e| matches!(e, AgentEvent::Limit { .. }))
            < at(|e| matches!(e, AgentEvent::Error { .. }))
    );
}

#[test]
fn claude_recorded_allowed_event_is_an_ok_limit() {
    let fixture = include_str!("fixtures/claude_result.jsonl");
    let events: Vec<AgentEvent> = fixture.lines().flat_map(claude::parse_line).collect();
    assert_eq!(
        limits(&events),
        vec![&AgentLimit {
            status: LimitStatus::Ok,
            resets_at: None,
            window: None,
            used_pct: None,
        }]
    );
}

#[test]
fn codex_usage_limit_turn_failed_is_a_limit_then_the_error() {
    let message = "You\u{2019}ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Nov 20, 2026 6:05 PM.";
    let line =
        serde_json::json!({"type": "turn.failed", "error": {"message": message}}).to_string();
    let mut last = String::new();
    let events = codex::parse_line(&line, &mut last);
    let [
        AgentEvent::Limit { limit },
        AgentEvent::Error { message: m, .. },
    ] = &events[..]
    else {
        panic!("{events:?}");
    };
    assert_eq!(limit.status, LimitStatus::Limited);
    assert!(limit.resets_at.is_some());
    assert_eq!(m, message);
}

#[test]
fn codex_limit_code_next_to_the_message_is_a_limit() {
    let line = r#"{"type":"turn.failed","error":{"message":"Request failed","code":"workspace_member_usage_limit_reached"}}"#;
    let mut last = String::new();
    let events = codex::parse_line(line, &mut last);
    assert_eq!(
        events[0],
        AgentEvent::Limit {
            limit: AgentLimit::limited(None)
        }
    );
    assert!(matches!(events[1], AgentEvent::Error { .. }));
    // Any other failure: just the error.
    let line = r#"{"type":"turn.failed","error":{"message":"stream disconnected"}}"#;
    assert!(limits(&codex::parse_line(line, &mut last)).is_empty());
}

#[test]
fn codex_rate_limit_snapshot_is_a_limit() {
    let line = r#"{"msg":{"type":"token_count","rate_limits":{"primary":{"used_percent":97.0,"window_minutes":300,"resets_at":1795000000},"secondary":{"used_percent":12.0,"window_minutes":10080}}}}"#;
    let mut last = String::new();
    assert_eq!(
        codex::parse_line(line, &mut last),
        vec![AgentEvent::Limit {
            limit: AgentLimit {
                status: LimitStatus::Warning,
                resets_at: Some(1_795_000_000_000),
                window: Some("five_hour".into()),
                used_pct: Some(97.0),
            }
        }]
    );
}

#[test]
fn gemini_resource_exhausted_is_a_limit_then_the_error() {
    let line = r#"{"type":"result","status":"error","error":{"type":"Error","message":"[API Error: You exceeded your current quota. Please retry in 23.5s.]","code":429}}"#;
    let events = gemini::GeminiParser::new(false).parse_line(line);
    let [AgentEvent::Limit { limit }, AgentEvent::Error { .. }] = &events[..] else {
        panic!("{events:?}");
    };
    assert_eq!(limit.status, LimitStatus::Limited);
    assert!(limit.resets_at.is_some());
    let line = r#"{"type":"result","status":"error","error":{"message":"RESOURCE_EXHAUSTED"}}"#;
    let events = gemini::GeminiParser::new(false).parse_line(line);
    assert_eq!(
        events[0],
        AgentEvent::Limit {
            limit: AgentLimit::limited(None)
        }
    );
    let line = r#"{"type":"result","error":{"message":"boom"}}"#;
    assert!(limits(&gemini::GeminiParser::new(false).parse_line(line)).is_empty());
}
