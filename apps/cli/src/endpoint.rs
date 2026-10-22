//! `AgentPort` over an OpenAI-compatible `/v1/chat/completions` endpoint
//! (e.g. a local `llama-server`), for evaluating small local models on the
//! same prompts, chunking, validation and repair as the agent CLIs. Each
//! request carries a JSON schema as `response_format`, so a server that
//! supports grammar-constrained decoding always returns schema-valid JSON.

use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use theodore_domain::Usage;
use theodore_ports::{AgentError, AgentEvent, AgentInfo, AgentPort, AgentRequest, AgentRun};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Prefix of the merge-pass system prompt (`prompt::merge_prompt`); its
/// answer is `{"order": [...]}`, every other call answers a grouping.
const MERGE_SYSTEM_PREFIX: &str = "You decide only the reading order";

#[derive(Debug, Clone)]
pub struct EndpointConfig {
    /// Base url, e.g. `http://127.0.0.1:8080`.
    pub base_url: String,
    pub model: String,
    pub max_tokens: u32,
    /// Restrict hunk / group ids in the schema to the ids the prompt lists.
    pub constrain_ids: bool,
}

pub struct EndpointAgent {
    cfg: EndpointConfig,
    http: reqwest::Client,
}

impl EndpointAgent {
    pub fn new(cfg: EndpointConfig) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30 * 60))
            .build()?;
        Ok(Self { cfg, http })
    }

    async fn complete(&self, req: &AgentRequest) -> Result<(String, Usage), String> {
        let system = req.system.clone().unwrap_or_default();
        let schema = if system.starts_with(MERGE_SYSTEM_PREFIX) {
            order_schema(self.cfg.constrain_ids.then(|| group_ids(&req.prompt)))
        } else {
            grouping_schema(self.cfg.constrain_ids.then(|| hunk_ids(&req.prompt)))
        };
        let rest = json!({
            "model": self.cfg.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": req.prompt},
            ],
            "temperature": 0.2,
            "seed": 42,
            "max_tokens": self.cfg.max_tokens,
            "chat_template_kwargs": {"enable_thinking": false},
        })
        .to_string();
        // Spliced in as text: `serde_json::Value` sorts object keys, and a
        // grammar-constrained decoder emits properties in schema order — the
        // model should write title and why before it picks hunks.
        let body = format!(
            r#"{{"response_format":{{"type":"json_schema","json_schema":{{"name":"answer","strict":true,"schema":{schema}}}}},{}"#,
            &rest[1..]
        );
        let url = format!(
            "{}/v1/chat/completions",
            self.cfg.base_url.trim_end_matches('/')
        );
        let resp = self
            .http
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let value: Value = resp.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("HTTP {status}: {value}"));
        }
        let text = value["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let usage = Usage {
            input_tokens: value["usage"]["prompt_tokens"].as_u64().unwrap_or(0),
            output_tokens: value["usage"]["completion_tokens"].as_u64().unwrap_or(0),
            usd: 0.0,
        };
        Ok((text, usage))
    }
}

#[async_trait]
impl AgentPort for EndpointAgent {
    async fn detect(&self) -> Vec<AgentInfo> {
        vec![]
    }

    async fn run(&self, req: AgentRequest) -> Result<AgentRun, AgentError> {
        let event = match self.complete(&req).await {
            Ok((final_text, usage)) => AgentEvent::Done { final_text, usage },
            Err(message) => AgentEvent::Error {
                message,
                stderr_tail: String::new(),
            },
        };
        let (tx, rx) = mpsc::channel(1);
        let _ = tx.send(event).await;
        Ok(AgentRun {
            events: rx,
            cancel: CancellationToken::new(),
        })
    }
}

fn id_items(ids: Option<Vec<String>>) -> String {
    match ids {
        Some(ids) if !ids.is_empty() => {
            format!(r#"{{"type":"string","enum":{}}}"#, json!(ids))
        }
        _ => r#"{"type":"string"}"#.to_string(),
    }
}

/// Grouping schema as JSON text, properties in the order the prompt lists
/// them (`id`, `title`, `why`, `kind`, `risk`, `check`, `hunks`, `outliers`).
pub fn grouping_schema(ids: Option<Vec<String>>) -> String {
    let items = id_items(ids);
    let text = |max: u32| format!(r#"{{"type":"string","maxLength":{max}}}"#);
    format!(
        r#"{{"type":"object","properties":{{"groups":{{"type":"array","minItems":1,"items":{{"type":"object","properties":{{"id":{id},"title":{title},"why":{why},"kind":{{"type":"string","enum":["normal","skim","hidden"]}},"risk":{risk},"check":{{"type":"array","maxItems":5,"items":{check}}},"hunks":{{"type":"array","minItems":1,"items":{items}}},"outliers":{{"type":"array","items":{items}}}}},"required":["id","title","why","kind","check","hunks","outliers"]}}}}}},"required":["groups"]}}"#,
        id = text(60),
        title = text(100),
        why = text(400),
        risk = text(300),
        check = text(200),
    )
}

pub fn order_schema(ids: Option<Vec<String>>) -> String {
    format!(
        r#"{{"type":"object","properties":{{"order":{{"type":"array","items":{}}}}},"required":["order"]}}"#,
        id_items(ids)
    )
}

/// Hunk ids a grouping or repair prompt asks to cover: `### hunk <id> — `
/// headings, or the `- <id>` list under "Known hunk ids".
pub fn hunk_ids(prompt: &str) -> Vec<String> {
    let mut ids: Vec<String> = prompt
        .lines()
        .filter_map(|l| l.strip_prefix("### hunk "))
        .filter_map(|rest| rest.split_whitespace().next())
        .map(str::to_string)
        .collect();
    if ids.is_empty()
        && let Some(start) = prompt.find("Known hunk ids")
    {
        ids = prompt[start..]
            .lines()
            .skip(1)
            .take_while(|l| !l.trim().is_empty())
            .filter_map(|l| l.strip_prefix("- "))
            .map(|s| s.trim().to_string())
            .collect();
    }
    ids
}

/// Group ids listed by the merge prompt: `- <id> — "<title>" ...`.
pub fn group_ids(prompt: &str) -> Vec<String> {
    prompt
        .lines()
        .filter_map(|l| l.strip_prefix("- "))
        .filter(|rest| rest.contains(" — \""))
        .filter_map(|rest| rest.split(" — ").next())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hunk_ids_from_a_grouping_prompt() {
        let p = "# Files and hunks\n\n## a.rs (Modified)\n\n### hunk abc123 — fn x\n+y\n\n### hunk def456 — \n-z\n";
        assert_eq!(hunk_ids(p), vec!["abc123", "def456"]);
    }

    #[test]
    fn hunk_ids_from_a_repair_prompt() {
        let p = "Problems found:\n- missing h2\n\nKnown hunk ids (every one must appear exactly once across all groups):\n- h1\n- h2\n\nYour previous answer:\n{}";
        assert_eq!(hunk_ids(p), vec!["h1", "h2"]);
    }

    #[test]
    fn group_ids_from_a_merge_prompt() {
        let p = "# PR\nTitle: t\n- Body line\n\n- g-one — \"One\" (Normal, 2 hunks): why\n- g-two — \"Two\" (Skim, 1 hunks): why\n";
        assert_eq!(group_ids(p), vec!["g-one", "g-two"]);
    }

    #[test]
    fn constrained_schema_enumerates_ids() {
        let s: Value = serde_json::from_str(&grouping_schema(Some(vec!["h1".into()]))).unwrap();
        let items = &s["properties"]["groups"]["items"]["properties"]["hunks"]["items"];
        assert_eq!(items["enum"], json!(["h1"]));
        let o: Value = serde_json::from_str(&order_schema(None)).unwrap();
        assert_eq!(o["properties"]["order"]["items"]["type"], "string");
    }

    #[test]
    fn schema_keeps_title_and_why_before_hunks() {
        let s = grouping_schema(None);
        let pos = |k: &str| s.find(&format!("\"{k}\":")).unwrap();
        assert!(pos("id") < pos("title") && pos("why") < pos("hunks"));
    }
}
