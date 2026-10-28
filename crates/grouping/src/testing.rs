//! A scriptable fake `AgentPort`, for this crate's own tests and for other
//! crates (the CLI) that need one without spawning a real CLI.

use std::collections::VecDeque;
use std::sync::Mutex;

use async_trait::async_trait;
use theodore_domain::Usage;
use theodore_ports::{AgentError, AgentEvent, AgentInfo, AgentPort, AgentRequest, AgentRun};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Chars per `TextDelta` when a request streams its text.
const STREAM_PIECE: usize = 7;

/// A scripted response starting with this ends the run with an `Error`
/// event (the rest is its message): for a run whose agent fails.
pub const FAIL: &str = "!fail:";

/// Each call to `run` pops the next scripted final-text response, wrapped in
/// a single `Done` event. Panics if more calls are made than were scripted —
/// a test should know exactly how many agent calls its pipeline makes.
pub struct FakeAgentPort {
    responses: Mutex<VecDeque<String>>,
    /// `(needle, response)`: a request containing `needle` (in its prompt
    /// or system prompt) takes the first such response, before the queue.
    routes: Mutex<Vec<(String, String)>>,
    requests: Mutex<Vec<AgentRequest>>,
}

impl FakeAgentPort {
    pub fn new(responses: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            responses: Mutex::new(responses.into_iter().map(Into::into).collect()),
            routes: Mutex::new(Vec::new()),
            requests: Mutex::new(Vec::new()),
        }
    }

    /// Answers by content rather than call order, for pipelines whose
    /// calls run concurrently: each request takes the first unused
    /// response whose needle its prompt or system prompt contains.
    pub fn routed(
        routes: impl IntoIterator<Item = (impl Into<String>, impl Into<String>)>,
    ) -> Self {
        let fake = Self::new(Vec::<String>::new());
        *fake.routes.lock().unwrap() = routes
            .into_iter()
            .map(|(n, r)| (n.into(), r.into()))
            .collect();
        fake
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
        let routed = {
            let mut routes = self.routes.lock().unwrap();
            let system = req.system.as_deref().unwrap_or_default();
            routes
                .iter()
                .position(|(n, _)| req.prompt.contains(n.as_str()) || system.contains(n.as_str()))
                .map(|i| routes.remove(i).1)
        };
        let text = routed
            .or_else(|| self.responses.lock().unwrap().pop_front())
            .unwrap_or_else(|| panic!("FakeAgentPort: no scripted response left for {req:?}"));
        // `stream_text`: the answer first comes as deltas of a few chars,
        // like Claude Code's partial messages.
        let deltas: Vec<String> = if req.stream_text {
            let chars: Vec<char> = text.chars().collect();
            chars
                .chunks(STREAM_PIECE)
                .map(|c| c.iter().collect())
                .collect()
        } else {
            vec![]
        };
        let (tx, rx) = mpsc::channel(deltas.len() + 1);
        if let Some(message) = text.strip_prefix(FAIL) {
            let _ = tx
                .send(AgentEvent::Error {
                    message: message.to_string(),
                    stderr_tail: String::new(),
                })
                .await;
            return Ok(AgentRun {
                events: rx,
                cancel: CancellationToken::new(),
            });
        }
        for text in deltas {
            let _ = tx.send(AgentEvent::TextDelta { text }).await;
        }
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
