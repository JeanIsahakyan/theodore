//! Fixture agent adapter: replays recorded agent event streams.

use serde::{Deserialize, Serialize};
use std::path::Path;
use theodore_domain::AgentId;
use theodore_ports::{AgentError, AgentEvent, AgentInfo, AgentPort, AgentRequest, AgentRun};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Recorded agent event for replay.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordedEvent {
    #[serde(flatten)]
    pub event: AgentEvent,
    #[serde(default)]
    pub delay_ms: u64,
}

/// Fixture agent: replays pre-recorded event streams from JSON files.
pub struct ReplayAgents {
    data_dir: std::path::PathBuf,
}

impl ReplayAgents {
    /// Create a new replay agent, loading scripts from the data directory.
    pub fn new(data_dir: impl AsRef<Path>) -> Self {
        Self {
            data_dir: data_dir.as_ref().to_path_buf(),
        }
    }

    /// Load a script from a JSONL file (one event per line).
    async fn load_script(&self, agent_id: AgentId) -> Result<Vec<RecordedEvent>, String> {
        let script_file = self
            .data_dir
            .join("agents")
            .join(format!("{}.jsonl", agent_id.as_str()));

        if !script_file.exists() {
            return Ok(Vec::new());
        }

        let content = tokio::fs::read_to_string(&script_file)
            .await
            .map_err(|e| e.to_string())?;

        let mut events = Vec::new();
        for line in content.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let event: RecordedEvent = serde_json::from_str(line)
                .map_err(|e| format!("Parse error in {}: {}", agent_id.as_str(), e))?;
            events.push(event);
        }

        Ok(events)
    }
}

#[async_trait::async_trait]
impl AgentPort for ReplayAgents {
    async fn detect(&self) -> Vec<AgentInfo> {
        vec![
            AgentInfo {
                id: AgentId::Claude,
                path: None,
                version: Some("fixture".to_string()),
                installed: true,
            },
            AgentInfo {
                id: AgentId::Codex,
                path: None,
                version: Some("fixture".to_string()),
                installed: true,
            },
            AgentInfo {
                id: AgentId::Gemini,
                path: None,
                version: Some("fixture".to_string()),
                installed: true,
            },
        ]
    }

    async fn run(&self, req: AgentRequest) -> Result<AgentRun, AgentError> {
        // Load the appropriate script based on agent ID
        let events = self
            .load_script(req.agent)
            .await
            .map_err(AgentError::Spawn)?;

        if events.is_empty() {
            // Return an error if no script found
            return Err(AgentError::NotInstalled(req.agent));
        }

        let (tx, rx) = mpsc::channel(1);
        let cancel = CancellationToken::new();

        // Spawn task to replay events
        {
            let events = events.clone();
            tokio::spawn(async move {
                for recorded in events {
                    // Apply delay if specified
                    if recorded.delay_ms > 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(recorded.delay_ms))
                            .await;
                    }

                    // Send the event
                    let _ = tx.send(recorded.event.clone()).await;
                }
            });
        }

        Ok(AgentRun { events: rx, cancel })
    }
}
