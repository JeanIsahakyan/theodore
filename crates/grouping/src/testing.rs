//! A scriptable fake `AgentPort`, for this crate's own tests and for other
//! crates (the CLI) that need one without spawning a real CLI.

use std::collections::VecDeque;
use std::sync::Mutex;

use async_trait::async_trait;
use theodore_domain::Usage;
use theodore_ports::{AgentError, AgentEvent, AgentInfo, AgentPort, AgentRequest, AgentRun};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Each call to `run` pops the next scripted final-text response, wrapped in
/// a single `Done` event. Panics if more calls are made than were scripted —
/// a test should know exactly how many agent calls its pipeline makes.
pub struct FakeAgentPort {
    responses: Mutex<VecDeque<String>>,
    requests: Mutex<Vec<AgentRequest>>,
}

impl FakeAgentPort {
    pub fn new(responses: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            responses: Mutex::new(responses.into_iter().map(Into::into).collect()),
            requests: Mutex::new(Vec::new()),
        }
    }

    /// Every request made so far, in order (for asserting on prompt content).
    pub fn requests(&self) -> Vec<AgentRequest> {
        self.requests.lock().unwrap().clone()
    }

    pub fn calls_made(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

#[async_trait]
impl AgentPort for FakeAgentPort {
    async fn detect(&self) -> Vec<AgentInfo> {
        vec![]
    }

    async fn run(&self, req: AgentRequest) -> Result<AgentRun, AgentError> {
        self.requests.lock().unwrap().push(req.clone());
        let text = self
            .responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| panic!("FakeAgentPort: no scripted response left for {req:?}"));
        let (tx, rx) = mpsc::channel(4);
        let _ = tx
            .send(AgentEvent::Done {
                final_text: text,
                usage: Usage::default(),
            })
            .await;
        Ok(AgentRun {
            events: rx,
            cancel: CancellationToken::new(),
        })
    }
}
