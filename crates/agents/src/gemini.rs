//! Gemini CLI runner — **untested**: `gemini` is not installed in this
//! environment, so nothing here ran against a real binary. Built from the
//! CLI's public docs (`--output-format stream-json` shipped per
//! google-gemini/gemini-cli#8203; `-p`, `-m`, `--approval-mode`; MCP servers
//! are settings-file only, no `--mcp-config` flag). Flags and the event
//! schema (`init` / `message` / `tool_use` / `tool_result` / `error` /
//! `result`) need re-verification against `gemini --help` and a real run
//! before this runner ships.
//!
//! MCP and the allow/deny tool list are settings-file only; we write a throwaway
//! settings file and point `GEMINI_CLI_SYSTEM_SETTINGS_PATH` at it for just
//! this child process, rather than touching the user's or the repo's real
//! `.gemini/settings.json`.

use std::path::PathBuf;

use serde_json::Value;
use theodore_domain::Usage;
use theodore_ports::agent::{AgentEvent, AgentMode, AgentRequest};

use crate::config::AgentBinaryConfig;
use crate::process::LineParser;

pub const SETTINGS_PATH_ENV_VAR: &str = "GEMINI_CLI_SYSTEM_SETTINGS_PATH";

/// Core tool allowlist per mode (`tools.core` in settings.json). Names beyond
/// `ReadFileTool` / `GlobTool` / `ShellTool` are a best guess pending `--help`.
fn core_tools(mode: AgentMode) -> Vec<&'static str> {
    match mode {
        AgentMode::ReadOnly => vec!["ReadFileTool", "GlobTool", "SearchTextTool"],
        AgentMode::Edit | AgentMode::Run => {
            vec![
                "ReadFileTool",
                "GlobTool",
                "SearchTextTool",
                "WriteFileTool",
                "EditTool",
                "ShellTool",
            ]
        }
    }
}

/// Settings-file JSON for this run: tool allowlist + the `review-tools` MCP
/// server over HTTP, if requested.
pub fn settings_json(req: &AgentRequest) -> Value {
    let mut settings = serde_json::json!({ "tools": { "core": core_tools(req.mode) } });
    if let Some(mcp) = &req.mcp {
        settings["mcpServers"] = serde_json::json!({
            "review-tools": {
                "httpUrl": mcp.url,
                "headers": { "Authorization": format!("Bearer {}", mcp.token) },
            }
        });
    }
    settings
}

/// Write the settings file; the caller keeps the returned handle alive for
/// the lifetime of the child process (its path goes into `SpawnSpec::env`).
pub fn write_settings_file(req: &AgentRequest) -> std::io::Result<tempfile::NamedTempFile> {
    use std::io::Write;
    let mut file = tempfile::Builder::new()
        .prefix("theodore-gemini-settings-")
        .suffix(".json")
        .tempfile()?;
    file.write_all(settings_json(req).to_string().as_bytes())?;
    file.flush()?;
    Ok(file)
}

pub fn build_args(req: &AgentRequest, cfg: &AgentBinaryConfig) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        req.prompt.clone(),
        "--output-format".to_string(),
        "stream-json".to_string(),
    ];
    args.push("--approval-mode".to_string());
    args.push(
        match req.mode {
            AgentMode::ReadOnly => "default",
            AgentMode::Edit => "auto_edit",
            // Shell commands too, without asking.
            AgentMode::Run => "yolo",
        }
        .to_string(),
    );
    if let Some(model) = req.model.as_ref().or(cfg.model.as_ref()) {
        args.push("-m".to_string());
        args.push(model.clone());
    }
    // No documented --append-system-prompt; fold it into the prompt, as for Codex.
    if let Some(system) = &req.system {
        args[1] = format!("{system}\n\n{}", args[1]);
    }
    args.extend(cfg.extra_args.iter().cloned());
    args
}

#[derive(Debug, Default)]
pub struct GeminiParser {
    last_text: String,
}

impl GeminiParser {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Pure: one `stream-json` line in, zero or more normalized events out. Field
/// names for `message` / `tool_use` / `tool_result` / `result` are assumptions
/// documented at the module level — adjust once a real run confirms them.
pub fn parse_line(line: &str, last_text: &mut String) -> Vec<AgentEvent> {
    let line = line.trim();
    if line.is_empty() {
        return vec![];
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return vec![];
    };
    match v.get("type").and_then(Value::as_str) {
        Some("message") => message_event(&v, last_text),
        Some("tool_use") => vec![AgentEvent::ToolCall {
            id: v
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            name: v
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            input: v.get("input").cloned().unwrap_or(Value::Null),
        }],
        Some("tool_result") => vec![AgentEvent::ToolResult {
            id: v
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            ok: !v.get("error").and_then(Value::as_bool).unwrap_or(false),
            output: v
                .get("output")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        }],
        Some("result") => vec![result_event(&v, last_text)],
        // `init` and non-terminal `error` (Gemini's docs call these "non-fatal
        // warnings and system errors", same ambiguity as Codex's top-level
        // `error`): no reliable terminal signal here, so treated as
        // informational; the real terminal comes from `result` or process exit.
        _ => vec![],
    }
}

fn message_event(v: &Value, last_text: &mut String) -> Vec<AgentEvent> {
    if v.get("role").and_then(Value::as_str) != Some("assistant") {
        return vec![];
    }
    let text = v.get("content").and_then(Value::as_str).unwrap_or_default();
    if text.is_empty() {
        return vec![];
    }
    last_text.push_str(text);
    if v.get("thought").and_then(Value::as_bool).unwrap_or(false) {
        vec![AgentEvent::Thinking {
            text: text.to_string(),
        }]
    } else {
        vec![AgentEvent::Text {
            text: text.to_string(),
        }]
    }
}

fn result_event(v: &Value, last_text: &str) -> AgentEvent {
    if let Some(error) = v.get("error").filter(|e| !e.is_null()) {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("gemini reported an error");
        return AgentEvent::Error {
            message: message.to_string(),
            stderr_tail: String::new(),
        };
    }
    let final_text = v
        .get("response")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| last_text.to_string());
    let usage = v.get("stats").map(gemini_usage).unwrap_or_default();
    AgentEvent::Done { final_text, usage }
}

fn gemini_usage(stats: &Value) -> Usage {
    let field = |name: &str| stats.get(name).and_then(Value::as_u64).unwrap_or(0);
    Usage {
        input_tokens: field("input_tokens"),
        output_tokens: field("output_tokens"),
        usd: 0.0,
    }
}

impl LineParser for GeminiParser {
    fn on_line(&mut self, line: &str) -> Vec<AgentEvent> {
        parse_line(line, &mut self.last_text)
    }

    fn on_exit(&mut self, success: bool, stderr_tail: &str) -> AgentEvent {
        AgentEvent::Error {
            message: if success {
                "gemini exited without a final result event".to_string()
            } else {
                "gemini exited with a non-zero status".to_string()
            },
            stderr_tail: stderr_tail.to_string(),
        }
    }
}

/// `(path, extra env for `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, guard to keep the
/// temp file alive)`, or `None` if nothing needs injecting (no MCP, default
/// tool set — still written, since `tools.core` always applies).
pub fn settings_env(
    req: &AgentRequest,
) -> std::io::Result<(Vec<(String, String)>, tempfile::NamedTempFile)> {
    let file = write_settings_file(req)?;
    let path: PathBuf = file.path().to_path_buf();
    Ok((
        vec![(
            SETTINGS_PATH_ENV_VAR.to_string(),
            path.display().to_string(),
        )],
        file,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(s: &str) -> Vec<AgentEvent> {
        let mut last = String::new();
        parse_line(s, &mut last)
    }

    #[test]
    fn init_is_ignored() {
        assert_eq!(
            line(r#"{"type":"init","session_id":"x","model":"gemini-pro"}"#),
            vec![]
        );
    }

    #[test]
    fn assistant_message_becomes_text() {
        assert_eq!(
            line(r#"{"type":"message","role":"assistant","content":"ok"}"#),
            vec![AgentEvent::Text { text: "ok".into() }]
        );
    }

    #[test]
    fn user_message_is_ignored() {
        assert_eq!(
            line(r#"{"type":"message","role":"user","content":"hi"}"#),
            vec![]
        );
    }

    #[test]
    fn tool_use_and_result_round_trip() {
        assert_eq!(
            line(r#"{"type":"tool_use","id":"t1","name":"read_file","input":{"path":"a.rs"}}"#),
            vec![AgentEvent::ToolCall {
                id: "t1".into(),
                name: "read_file".into(),
                input: serde_json::json!({"path": "a.rs"}),
            }]
        );
        assert_eq!(
            line(r#"{"type":"tool_result","id":"t1","output":"contents"}"#),
            vec![AgentEvent::ToolResult {
                id: "t1".into(),
                ok: true,
                output: "contents".into()
            }]
        );
    }

    #[test]
    fn result_becomes_done() {
        let mut last = "built up".to_string();
        let events = parse_line(
            r#"{"type":"result","response":"ok","stats":{"input_tokens":10,"output_tokens":2}}"#,
            &mut last,
        );
        assert_eq!(
            events,
            vec![AgentEvent::Done {
                final_text: "ok".into(),
                usage: Usage {
                    input_tokens: 10,
                    output_tokens: 2,
                    usd: 0.0
                }
            }]
        );
    }

    #[test]
    fn result_with_error_becomes_error() {
        assert_eq!(
            line(r#"{"type":"result","error":{"message":"boom"}}"#),
            vec![AgentEvent::Error {
                message: "boom".into(),
                stderr_tail: String::new()
            }]
        );
    }

    #[test]
    fn settings_json_has_mcp_server_when_requested() {
        let req = sample_request_with_mcp();
        let settings = settings_json(&req);
        assert_eq!(
            settings["mcpServers"]["review-tools"]["httpUrl"],
            "https://example.invalid/mcp"
        );
    }

    fn sample_request_with_mcp() -> AgentRequest {
        use theodore_domain::AgentId;
        use theodore_ports::agent::McpEndpoint;
        AgentRequest {
            agent: AgentId::Gemini,
            prompt: "hi".into(),
            system: None,
            cwd: PathBuf::from("/tmp"),
            mode: AgentMode::ReadOnly,
            mcp: Some(McpEndpoint {
                url: "https://example.invalid/mcp".into(),
                token: "t".into(),
            }),
            model: None,
            stall_after_ms: 1000,
            env: Vec::new(),
        }
    }
}

#[cfg(test)]
mod run_mode_tests {
    use super::*;

    #[test]
    fn run_mode_may_edit_and_run_commands() {
        let req = AgentRequest {
            agent: theodore_domain::AgentId::Gemini,
            prompt: "p".into(),
            system: None,
            cwd: "/tmp".into(),
            mode: AgentMode::Run,
            mcp: None,
            model: None,
            stall_after_ms: 1000,
            env: Vec::new(),
        };
        let args = build_args(&req, &Default::default());
        assert!(args.windows(2).any(|w| w == ["--approval-mode", "yolo"]));
        assert!(core_tools(AgentMode::Run).contains(&"ShellTool"));
    }
}
