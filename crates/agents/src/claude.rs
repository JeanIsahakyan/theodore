//! Claude Code runner (`claude` 2.1.x): `-p --output-format stream-json --verbose`.
//!
//! Flags verified against `claude --help` on the installed 2.1.280 binary and a
//! couple of tiny real `-p "reply with the word ok"` runs (see
//! `tests/fixtures/claude_result.jsonl`, redacted). `tool_use`/`tool_result`
//! shapes are long-documented Claude Code stream-json content blocks but were
//! not exercised live here (sandboxed shell denied a tool-using prompt); see
//! `tests/fixtures/claude_tool_call.jsonl`, built from that documented shape.

use std::path::Path;

use serde_json::Value;
use theodore_domain::Usage;
use theodore_ports::agent::{AgentEvent, AgentMode, AgentRequest};

use crate::config::AgentBinaryConfig;
use crate::process::LineParser;

/// The `--mcp-config` JSON, including the bearer token in its `headers`.
/// Written to a 0600 temp file instead of argv (see `write_mcp_config`):
/// `ps`/`/proc/<pid>/cmdline` on this host, or any other process running as
/// the same user, can read another process's argv but not an 0600 file
/// owned by that process's own user.
fn mcp_config_json(mcp: &theodore_ports::agent::McpEndpoint) -> Value {
    serde_json::json!({
        "mcpServers": {
            "review-tools": {
                "type": "http",
                "url": mcp.url,
                "headers": { "Authorization": format!("Bearer {}", mcp.token) },
            }
        }
    })
}

/// Writes `req.mcp`'s config (bearer token included) to a 0600 temp file,
/// `None` if there's no MCP endpoint for this run. The caller keeps the
/// returned handle alive for the run (`SpawnSpec::guards`) and passes its
/// path to `build_args`.
pub fn write_mcp_config(req: &AgentRequest) -> std::io::Result<Option<tempfile::NamedTempFile>> {
    let Some(mcp) = &req.mcp else { return Ok(None) };
    use std::io::Write;
    let mut file = tempfile::Builder::new()
        .prefix("theodore-claude-mcp-")
        .suffix(".json")
        .tempfile()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(mcp_config_json(mcp).to_string().as_bytes())?;
    file.flush()?;
    Ok(Some(file))
}

/// `AgentRequest` + binary config → argv (binary path is handled by the
/// caller). `mcp_config_path` must be `Some` whenever `req.mcp` is —
/// `write_mcp_config`'s output path, never the config itself.
pub fn build_args(
    req: &AgentRequest,
    cfg: &AgentBinaryConfig,
    mcp_config_path: Option<&Path>,
) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        req.prompt.clone(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--permission-prompts".to_string(),
        "none".to_string(),
    ];
    if let Some(system) = &req.system {
        args.push("--append-system-prompt".to_string());
        args.push(system.clone());
    }
    if let Some(path) = mcp_config_path {
        args.push("--mcp-config".to_string());
        args.push(path.display().to_string());
        args.push("--strict-mcp-config".to_string());
    }
    match req.mode {
        AgentMode::ReadOnly => {
            args.push("--allowedTools".to_string());
            args.push("Read,Grep,Glob,mcp__review-tools__*".to_string());
            // `--allowedTools` only pre-approves; anything that writes or runs
            // commands must be denied outright for a review run.
            args.push("--disallowedTools".to_string());
            args.push("Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task".to_string());
        }
        AgentMode::Edit => {
            args.push("--allowedTools".to_string());
            args.push("Read,Grep,Glob,Edit,Write,MultiEdit,Bash,mcp__review-tools__*".to_string());
            args.push("--permission-mode".to_string());
            args.push("acceptEdits".to_string());
        }
        AgentMode::Run => {
            // Every tool, no prompts: the CLI's own settings are the limit.
            args.push("--permission-mode".to_string());
            args.push("bypassPermissions".to_string());
        }
    }
    if let Some(model) = req.model.as_ref().or(cfg.model.as_ref()) {
        args.push("--model".to_string());
        args.push(model.clone());
    }
    args.extend(cfg.extra_args.iter().cloned());
    args
}

#[derive(Debug, Default)]
pub struct ClaudeParser;

impl ClaudeParser {
    pub fn new() -> Self {
        Self
    }
}

/// Pure: one stream-json line in, zero or more normalized events out.
pub fn parse_line(line: &str) -> Vec<AgentEvent> {
    let line = line.trim();
    if line.is_empty() {
        return vec![];
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return vec![];
    };
    match v.get("type").and_then(Value::as_str) {
        Some("assistant") => content_blocks(&v),
        Some("user") => tool_results(&v),
        Some("result") => vec![result_event(&v)],
        _ => vec![], // system/rate_limit_event/init/etc: not user-visible stream content
    }
}

fn content_blocks(v: &Value) -> Vec<AgentEvent> {
    let Some(blocks) = v.pointer("/message/content").and_then(Value::as_array) else {
        return vec![];
    };
    blocks
        .iter()
        .filter_map(|b| match b.get("type").and_then(Value::as_str) {
            Some("text") => {
                let text = b.get("text").and_then(Value::as_str).unwrap_or_default();
                (!text.is_empty()).then(|| AgentEvent::Text {
                    text: text.to_string(),
                })
            }
            Some("thinking") => {
                let text = b
                    .get("thinking")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                (!text.is_empty()).then(|| AgentEvent::Thinking {
                    text: text.to_string(),
                })
            }
            Some("tool_use") => Some(AgentEvent::ToolCall {
                id: b
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                name: b
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                input: b.get("input").cloned().unwrap_or(Value::Null),
            }),
            _ => None,
        })
        .collect()
}

fn tool_results(v: &Value) -> Vec<AgentEvent> {
    let Some(blocks) = v.pointer("/message/content").and_then(Value::as_array) else {
        return vec![];
    };
    blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
        .map(|b| {
            let is_error = b.get("is_error").and_then(Value::as_bool).unwrap_or(false);
            AgentEvent::ToolResult {
                id: b
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                ok: !is_error,
                output: stringify_tool_content(b.get("content")),
            }
        })
        .collect()
}

fn stringify_tool_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn result_event(v: &Value) -> AgentEvent {
    let is_error = v.get("is_error").and_then(Value::as_bool).unwrap_or(false);
    if is_error {
        let message = v
            .get("result")
            .and_then(Value::as_str)
            .unwrap_or("claude reported an error")
            .to_string();
        return AgentEvent::Error {
            message,
            stderr_tail: String::new(),
        };
    }
    let final_text = v
        .get("result")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    // `total_cost_usd` sits next to `usage`, not inside it.
    let usd = v
        .get("total_cost_usd")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let usage = v
        .get("usage")
        .map(|u| claude_usage(u, usd))
        .unwrap_or_default();
    AgentEvent::Done { final_text, usage }
}

fn claude_usage(u: &Value, usd: f64) -> Usage {
    let field = |name: &str| u.get(name).and_then(Value::as_u64).unwrap_or(0);
    let input_tokens = field("input_tokens")
        + field("cache_creation_input_tokens")
        + field("cache_read_input_tokens");
    Usage {
        input_tokens,
        output_tokens: field("output_tokens"),
        usd,
    }
}

impl LineParser for ClaudeParser {
    fn on_line(&mut self, line: &str) -> Vec<AgentEvent> {
        parse_line(line)
    }

    fn on_exit(&mut self, success: bool, stderr_tail: &str) -> AgentEvent {
        AgentEvent::Error {
            message: if success {
                "claude exited without a final result event".to_string()
            } else {
                "claude exited with a non-zero status".to_string()
            },
            stderr_tail: stderr_tail.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_block_becomes_text_event() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}"#;
        assert_eq!(
            parse_line(line),
            vec![AgentEvent::Text { text: "ok".into() }]
        );
    }

    #[test]
    fn thinking_block_becomes_thinking_event() {
        let line =
            r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hm"}]}}"#;
        assert_eq!(
            parse_line(line),
            vec![AgentEvent::Thinking { text: "hm".into() }]
        );
    }

    #[test]
    fn empty_thinking_block_is_dropped() {
        let line =
            r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""}]}}"#;
        assert_eq!(parse_line(line), vec![]);
    }

    #[test]
    fn tool_use_becomes_tool_call() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.rs"}}]}}"#;
        assert_eq!(
            parse_line(line),
            vec![AgentEvent::ToolCall {
                id: "t1".into(),
                name: "Read".into(),
                input: serde_json::json!({"file_path": "a.rs"}),
            }]
        );
    }

    #[test]
    fn tool_result_becomes_tool_result_event() {
        let line = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":false,"content":"file contents"}]}}"#;
        assert_eq!(
            parse_line(line),
            vec![AgentEvent::ToolResult {
                id: "t1".into(),
                ok: true,
                output: "file contents".into()
            }]
        );
    }

    #[test]
    fn success_result_becomes_done() {
        let line = r#"{"type":"result","is_error":false,"result":"ok","total_cost_usd":0.097,"usage":{"input_tokens":2,"output_tokens":82}}"#;
        let events = parse_line(line);
        assert_eq!(
            events,
            vec![AgentEvent::Done {
                final_text: "ok".into(),
                usage: Usage {
                    input_tokens: 2,
                    output_tokens: 82,
                    usd: 0.097
                },
            }]
        );
    }

    #[test]
    fn error_result_becomes_error() {
        let line = r#"{"type":"result","is_error":true,"result":"boom"}"#;
        assert_eq!(
            parse_line(line),
            vec![AgentEvent::Error {
                message: "boom".into(),
                stderr_tail: String::new()
            }]
        );
    }

    #[test]
    fn system_lines_are_ignored() {
        let line = r#"{"type":"system","subtype":"init","cwd":"/tmp"}"#;
        assert_eq!(parse_line(line), vec![]);
    }

    #[test]
    fn garbage_line_is_ignored() {
        assert_eq!(parse_line("not json"), vec![]);
        assert_eq!(parse_line(""), vec![]);
    }

    #[test]
    fn exit_without_result_is_the_one_terminal_event() {
        let mut parser = ClaudeParser::new();
        let ev = parser.on_exit(false, "panic: x");
        assert_eq!(
            ev,
            AgentEvent::Error {
                message: "claude exited with a non-zero status".into(),
                stderr_tail: "panic: x".into(),
            }
        );
    }
}

#[cfg(test)]
mod read_only_tests {
    use super::*;

    #[test]
    fn read_only_runs_deny_shell_and_writes() {
        let req = theodore_ports::AgentRequest {
            agent: theodore_domain::AgentId::Claude,
            prompt: "p".into(),
            system: None,
            cwd: "/tmp".into(),
            mode: AgentMode::ReadOnly,
            mcp: None,
            model: None,
            stall_after_ms: 1000,
        };
        let args = build_args(&req, &Default::default(), None);
        let i = args
            .iter()
            .position(|a| a == "--disallowedTools")
            .expect("denylist");
        assert!(args[i + 1].contains("Bash") && args[i + 1].contains("Edit"));
    }
}

#[cfg(test)]
mod mcp_config_tests {
    use super::*;
    use theodore_ports::agent::McpEndpoint;

    fn req_with_mcp(token: &str) -> AgentRequest {
        AgentRequest {
            agent: theodore_domain::AgentId::Claude,
            prompt: "p".into(),
            system: None,
            cwd: "/tmp".into(),
            mode: AgentMode::ReadOnly,
            mcp: Some(McpEndpoint {
                url: "http://127.0.0.1:1/mcp".into(),
                token: token.into(),
            }),
            model: None,
            stall_after_ms: 1000,
        }
    }

    /// The whole point of writing the config to a file: `ps`/`/proc` must
    /// never see the token. Argv only ever carries the file's path.
    #[test]
    fn mcp_config_token_never_reaches_argv() {
        let req = req_with_mcp("super-secret-token");
        let guard = write_mcp_config(&req).unwrap().expect("mcp config file");
        let args = build_args(&req, &Default::default(), Some(guard.path()));

        for arg in &args {
            assert!(
                !arg.contains("super-secret-token"),
                "token leaked into argv: {arg:?}"
            );
        }
        let i = args
            .iter()
            .position(|a| a == "--mcp-config")
            .expect("--mcp-config flag");
        assert_eq!(args[i + 1], guard.path().display().to_string());

        // The token does land in the file `--mcp-config` points at.
        let contents = std::fs::read_to_string(guard.path()).unwrap();
        assert!(contents.contains("super-secret-token"));
        assert!(contents.contains("Bearer"));
    }

    #[test]
    fn no_mcp_means_no_config_file_and_no_flag() {
        let mut req = req_with_mcp("unused");
        req.mcp = None;
        assert!(write_mcp_config(&req).unwrap().is_none());
        let args = build_args(&req, &Default::default(), None);
        assert!(!args.iter().any(|a| a == "--mcp-config"));
    }

    #[cfg(unix)]
    #[test]
    fn mcp_config_file_is_readable_only_by_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let req = req_with_mcp("t");
        let guard = write_mcp_config(&req).unwrap().expect("mcp config file");
        let mode = std::fs::metadata(guard.path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}

#[cfg(test)]
mod run_mode_tests {
    use super::*;

    #[test]
    fn run_mode_may_edit_and_run_commands() {
        let req = AgentRequest {
            agent: theodore_domain::AgentId::Claude,
            prompt: "p".into(),
            system: None,
            cwd: "/tmp".into(),
            mode: AgentMode::Run,
            mcp: None,
            model: None,
            stall_after_ms: 1000,
        };
        let args = build_args(&req, &Default::default(), None);
        assert!(
            args.windows(2)
                .any(|w| w == ["--permission-mode", "bypassPermissions"])
        );
        assert!(!args.iter().any(|a| a == "--disallowedTools"));
    }
}
