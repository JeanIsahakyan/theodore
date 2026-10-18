//! Fixture agent adapter (`AgentPort`): replays recorded event streams
//! instead of spawning a CLI.
//!
//! Which script plays is a small rule list: the first rule whose `contains`
//! is a substring of the prompt wins, otherwise the agent's default script
//! plays. `Triggers::agent_crash` makes the *next* `run()` for that agent
//! fail outright, regardless of which script would have played.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rmcp::RoleClient;
use rmcp::ServiceExt;
use rmcp::model::CallToolRequestParams;
use rmcp::service::RunningService;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use serde::{Deserialize, Serialize};
use theodore_domain::{AgentId, Usage};
use theodore_ports::{
    AgentError, AgentEvent, AgentInfo, AgentPort, AgentRequest, AgentRun, McpEndpoint,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::state::SharedState;

/// Connects to a `review-tools` MCP endpoint registered for this run
/// (plan §8.3). Mirrors `theodore_mcp::bridge::connect_upstream`.
async fn connect_mcp(endpoint: &McpEndpoint) -> Result<RunningService<RoleClient, ()>, String> {
    let config = StreamableHttpClientTransportConfig::with_uri(endpoint.url.clone())
        .auth_header(endpoint.token.clone());
    let transport = StreamableHttpClientTransport::from_config(config);
    ().serve(transport)
        .await
        .map_err(|e| format!("connecting to {}: {e}", endpoint.url))
}

/// Calls MCP tool `name` with `input` (a JSON object becomes the tool's
/// arguments) and returns `(ok, output)`, the shape a recorded `ToolResult`
/// carries.
async fn call_tool(
    client: &RunningService<RoleClient, ()>,
    name: &str,
    input: &serde_json::Value,
) -> (bool, String) {
    let mut request = CallToolRequestParams::new(name.to_string());
    if let serde_json::Value::Object(map) = input.clone() {
        request = request.with_arguments(map);
    }
    match client.call_tool(request).await {
        Ok(result) => {
            let ok = result.is_error != Some(true);
            let output = result
                .content
                .first()
                .and_then(|c| c.as_text())
                .map(|t| t.text.clone())
                .unwrap_or_default();
            (ok, output)
        }
        Err(e) => (false, e.to_string()),
    }
}

/// One recorded event, with the delay to wait before sending it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordedEvent {
    #[serde(flatten)]
    pub event: AgentEvent,
    #[serde(default)]
    pub delay_ms: u64,
}

/// `prompt.contains(contains)` → play `<agent>/<script>.jsonl`.
#[derive(Debug, Clone)]
pub struct ScriptRule {
    pub contains: String,
    pub script: String,
}

impl ScriptRule {
    pub fn new(contains: impl Into<String>, script: impl Into<String>) -> Self {
        Self {
            contains: contains.into(),
            script: script.into(),
        }
    }
}

/// Fixture agent: replays `<data_dir>/agents/<agent>/<script>.jsonl`.
#[derive(Debug)]
pub struct ReplayAgents {
    data_dir: std::path::PathBuf,
    state: Arc<Mutex<SharedState>>,
    rules: Vec<ScriptRule>,
    defaults: HashMap<AgentId, String>,
}

impl ReplayAgents {
    pub(crate) fn new(data_dir: impl AsRef<Path>, state: Arc<Mutex<SharedState>>) -> Self {
        let mut defaults = HashMap::new();
        for id in AgentId::ALL {
            defaults.insert(id, "chat".to_string());
        }
        Self {
            data_dir: data_dir.as_ref().to_path_buf(),
            state,
            rules: vec![
                ScriptRule::new("grouping", "grouping"),
                // The real grouping pipeline's initial-call prompt
                // (`theodore_grouping::prompt::build_prompts`) never spells
                // out the word "grouping"; it's recognized by its own
                // section header instead.
                ScriptRule::new("# Files and hunks", "grouping"),
                // The incremental regroup prompt after a push
                // (`theodore_grouping::incremental::build_prompt`).
                ScriptRule::new("# Existing groups", "regroup"),
                // Deliberately ahead of the generic "skill" rule below: lets
                // a test ask for a slow-running skill run (to cancel) by
                // name, e.g. `RunSkillRequest { skill: "slow-skill", .. }`.
                ScriptRule::new("`slow-skill`", "slow"),
                ScriptRule::new("skill", "skill"),
            ],
            defaults,
        }
    }

    /// Replace the rule list (first match wins).
    pub fn with_rules(mut self, rules: Vec<ScriptRule>) -> Self {
        self.rules = rules;
        self
    }

    /// Set the script an agent plays when no rule matches its prompt.
    pub fn with_default(mut self, agent: AgentId, script: impl Into<String>) -> Self {
        self.defaults.insert(agent, script.into());
        self
    }

    fn pick_script(&self, agent: AgentId, prompt: &str) -> String {
        for rule in &self.rules {
            if prompt.contains(rule.contains.as_str()) {
                return rule.script.clone();
            }
        }
        self.defaults
            .get(&agent)
            .cloned()
            .unwrap_or_else(|| "chat".to_string())
    }

    async fn load_script(
        &self,
        agent: AgentId,
        script: &str,
    ) -> Result<Vec<RecordedEvent>, String> {
        let path = self
            .data_dir
            .join("agents")
            .join(agent.as_str())
            .join(format!("{script}.jsonl"));

        if !path.exists() {
            return Err(format!("no script {script} for {}", agent.as_str()));
        }

        let content = tokio::fs::read_to_string(&path)
            .await
            .map_err(|e| e.to_string())?;

        let mut events = Vec::new();
        for line in content.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let event: RecordedEvent = serde_json::from_str(line)
                .map_err(|e| format!("parse error in {}: {e}", path.display()))?;
            events.push(event);
        }
        Ok(events)
    }
}

#[async_trait::async_trait]
impl AgentPort for ReplayAgents {
    async fn detect(&self) -> Vec<AgentInfo> {
        AgentId::ALL
            .into_iter()
            .map(|id| AgentInfo {
                id,
                path: None,
                version: Some("fixture".to_string()),
                installed: true,
            })
            .collect()
    }

    async fn run(&self, req: AgentRequest) -> Result<AgentRun, AgentError> {
        let script = self.pick_script(req.agent, &req.prompt);
        let events = self
            .load_script(req.agent, &script)
            .await
            .map_err(AgentError::Spawn)?;

        let crash = self.state.lock().unwrap().crash_next.remove(&req.agent);
        let mcp = req.mcp.clone();

        let (tx, rx) = mpsc::channel(16);
        let cancel = CancellationToken::new();
        let cancel_task = cancel.clone();

        tokio::spawn(async move {
            if crash {
                let _ = tx
                    .send(AgentEvent::Error {
                        message: "agent crashed".to_string(),
                        stderr_tail: "fixture: Triggers::agent_crash".to_string(),
                    })
                    .await;
                return;
            }

            // Connected lazily on the first `ToolCall`, so scripts with no
            // tool calls never pay for it.
            let mut mcp_client: Option<RunningService<RoleClient, ()>> = None;
            let mut i = 0;
            while i < events.len() {
                let recorded = events[i].clone();
                if recorded.delay_ms > 0 {
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(recorded.delay_ms)) => {}
                        _ = cancel_task.cancelled() => {
                            let _ = tx.send(AgentEvent::Error {
                                message: "cancelled".to_string(),
                                stderr_tail: String::new(),
                            }).await;
                            return;
                        }
                    }
                }
                if cancel_task.is_cancelled() {
                    let _ = tx
                        .send(AgentEvent::Error {
                            message: "cancelled".to_string(),
                            stderr_tail: String::new(),
                        })
                        .await;
                    return;
                }

                // A recorded tool call against a real MCP endpoint is
                // actually placed over MCP (an `rmcp` client), not just
                // echoed from the recording — the whole point being that a
                // run through `app::Core::run_skill` ends in a real
                // `finding` row, not a canned one (plan §8.3, §8.4).
                if let AgentEvent::ToolCall { id, name, input } = &recorded.event
                    && let Some(endpoint) = &mcp
                {
                    if tx.send(recorded.event.clone()).await.is_err() {
                        return;
                    }
                    if mcp_client.is_none() {
                        mcp_client = connect_mcp(endpoint).await.ok();
                    }
                    let (ok, output) = match &mcp_client {
                        Some(client) => call_tool(client, name, input).await,
                        None => (
                            false,
                            "fixture: could not connect to the MCP endpoint".to_string(),
                        ),
                    };
                    if tx
                        .send(AgentEvent::ToolResult {
                            id: id.clone(),
                            ok,
                            output,
                        })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    // The recording's own `ToolResult` for this call is a
                    // placeholder for when there's no MCP endpoint to call
                    // (see `load_script`'s callers); skip it so the real
                    // result isn't followed by a stale canned one.
                    if let Some(next) = events.get(i + 1)
                        && matches!(&next.event, AgentEvent::ToolResult { id: next_id, .. } if next_id == id)
                    {
                        i += 1;
                    }
                    i += 1;
                    continue;
                }

                let terminal = matches!(
                    recorded.event,
                    AgentEvent::Done { .. } | AgentEvent::Error { .. }
                );
                if tx.send(recorded.event).await.is_err() {
                    return;
                }
                if terminal {
                    return;
                }
                i += 1;
            }

            // Every script ends in exactly one terminal event; if the
            // recording did not have one, supply it.
            let _ = tx
                .send(AgentEvent::Done {
                    final_text: String::new(),
                    usage: Usage::default(),
                })
                .await;
        });

        Ok(AgentRun { events: rx, cancel })
    }
}
