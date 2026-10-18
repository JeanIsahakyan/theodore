//! `run_skill`, `ask`, `cancel_run`, `add_finding` (plan §8.4): agents are
//! spawned per the `AgentPort`, their stream becomes ephemeral events, and
//! only the final result is synced.

use std::path::PathBuf;

use theodore_contract::{
    AskRequest, ChatMessage, Ephemeral, RunSkillRequest, RunStatus, SkillRun, models,
};
use theodore_domain::{AgentId, Author, Finding, FindingId, Fix, PrId, Usage};
use theodore_ports::{AgentEvent, AgentMode, AgentRequest, NewAction, SyncActionCode};
use tokio_util::sync::CancellationToken;

use crate::core::{Core, RunHandle};
use crate::error::{AppError, AppResult};

impl Core {
    pub async fn run_skill(&self, req: RunSkillRequest) -> AppResult<String> {
        let agents = if req.agents.is_empty() {
            self.setting_agents("agents.skills", vec![AgentId::Claude])
                .await
        } else {
            req.agents.clone()
        };
        let run_id = uuid::Uuid::new_v4().to_string();
        let started_at = self.0.deps.clock.now();
        let row = SkillRun {
            id: run_id.clone(),
            pr: req.pr.clone(),
            skill: req.skill.clone(),
            agents: agents.clone(),
            status: RunStatus::Running,
            usage: Usage::default(),
            error: None,
            started_at,
        };
        let data = serde_json::to_value(&row).map_err(|e| AppError::Invalid(e.to_string()))?;
        self.apply(vec![NewAction {
            model: models::SKILL_RUN.into(),
            model_id: run_id.clone(),
            action: SyncActionCode::I,
            data: Some(data),
        }])
        .await?;

        let cancel = CancellationToken::new();
        self.0.runs.write().await.insert(
            run_id.clone(),
            RunHandle {
                cancel: cancel.clone(),
            },
        );

        let core = self.clone();
        let pr = req.pr.clone();
        let skill = req.skill.clone();
        let run_id2 = run_id.clone();
        tokio::spawn(async move {
            drive_skill_run(&core, run_id2, pr, skill, agents, cancel).await;
        });
        Ok(run_id)
    }

    pub async fn ask(&self, req: AskRequest) -> AppResult<String> {
        let message_id = uuid::Uuid::new_v4().to_string();
        let now = self.0.deps.clock.now();
        let question = ChatMessage {
            id: message_id.clone(),
            pr: req.pr.clone(),
            author: Author::Me,
            text: req.question.clone(),
            refs: req.about.clone().into_iter().collect(),
            usage: None,
            at: now,
        };
        let data = serde_json::to_value(&question).map_err(|e| AppError::Invalid(e.to_string()))?;
        self.apply(vec![NewAction {
            model: models::CHAT_MESSAGE.into(),
            model_id: message_id.clone(),
            action: SyncActionCode::I,
            data: Some(data),
        }])
        .await?;

        let agent = match req.agent {
            Some(a) => a,
            None => self.setting_agent("agents.chat", AgentId::Claude).await,
        };
        let cwd = {
            let head = self.0.current_head.read().await.get(&req.pr).cloned();
            let Some(head) = head else {
                return Ok(message_id);
            };
            let revisions = self.0.revisions.read().await;
            match revisions.get(&(req.pr.clone(), head)) {
                Some(e) => e.worktree_path.clone(),
                None => return Ok(message_id),
            }
        };

        let run_id = format!("ask:{message_id}");
        let cancel = CancellationToken::new();
        self.0.runs.write().await.insert(
            run_id.clone(),
            RunHandle {
                cancel: cancel.clone(),
            },
        );

        let core = self.clone();
        let pr = req.pr.clone();
        let question_text = req.question.clone();
        tokio::spawn(async move {
            drive_ask(&core, run_id, pr, agent, question_text, cwd, cancel).await;
        });
        Ok(message_id)
    }

    pub async fn cancel_run(&self, run: String) -> AppResult<()> {
        if let Some(handle) = self.0.runs.write().await.remove(&run) {
            handle.cancel.cancel();
        }
        if !run.starts_with("ask:") {
            let data = serde_json::json!({ "status": RunStatus::Cancelled });
            let _ = self
                .apply(vec![NewAction {
                    model: models::SKILL_RUN.into(),
                    model_id: run,
                    action: SyncActionCode::C,
                    data: Some(data),
                }])
                .await;
        }
        Ok(())
    }

    /// Findings from several agents merge into one (plan §4, §8.4). Called
    /// once the MCP `add_finding` tool hands a result back.
    /// Returns the id of the stored finding (an existing one when merged).
    pub async fn add_finding(&self, pr: PrId, mut finding: Finding) -> AppResult<FindingId> {
        finding.pr = pr.clone();
        let pr_s = pr.0.clone();
        let store = self.0.deps.store.clone();
        let rows = tokio::task::spawn_blocking(move || store.query(models::FINDING, "pr", &pr_s))
            .await
            .map_err(AppError::join)??;
        let existing: Vec<Finding> = rows
            .iter()
            .filter_map(|r| serde_json::from_value(r.data.clone()).ok())
            .collect();

        let (action, merged) = match theodore_domain::findings::merge(&existing, finding) {
            theodore_domain::findings::MergeOutcome::New(f) => (SyncActionCode::I, f),
            theodore_domain::findings::MergeOutcome::MergedInto(f) => (SyncActionCode::U, f),
        };
        let data = serde_json::to_value(&merged).map_err(|e| AppError::Invalid(e.to_string()))?;
        self.apply(vec![NewAction {
            model: models::FINDING.into(),
            model_id: merged.id.0.clone(),
            action,
            data: Some(data),
        }])
        .await?;
        Ok(merged.id)
    }

    /// Attach an agent-proposed fix to a finding of `pr` (MCP `propose_patch`).
    pub async fn attach_fix(&self, pr: &PrId, finding: &FindingId, fix: Fix) -> AppResult<()> {
        let store = self.0.deps.store.clone();
        let id = finding.0.clone();
        let row = tokio::task::spawn_blocking(move || store.get(models::FINDING, &id))
            .await
            .map_err(AppError::join)??
            .ok_or_else(|| AppError::NotFound(format!("finding {finding}")))?;
        let existing: Finding =
            serde_json::from_value(row.data).map_err(|e| AppError::Invalid(e.to_string()))?;
        if &existing.pr != pr {
            return Err(AppError::Invalid(format!(
                "finding {finding} belongs to another PR"
            )));
        }
        let data = serde_json::json!({ "fix": fix });
        self.apply(vec![NewAction {
            model: models::FINDING.into(),
            model_id: finding.0.clone(),
            action: SyncActionCode::C,
            data: Some(data),
        }])
        .await?;
        Ok(())
    }
}

async fn drive_skill_run(
    core: &Core,
    run_id: String,
    pr: PrId,
    skill: String,
    agents: Vec<AgentId>,
    cancel: CancellationToken,
) {
    let cwd = {
        let head = core.0.current_head.read().await.get(&pr).cloned();
        let Some(head) = head else {
            fail_run(core, &run_id, "pr is not open").await;
            return;
        };
        let revisions = core.0.revisions.read().await;
        match revisions.get(&(pr.clone(), head)) {
            Some(e) => e.worktree_path.clone(),
            None => {
                fail_run(core, &run_id, "revision not cached").await;
                return;
            }
        }
    };

    let mut total_usage = Usage::default();
    let mut error: Option<String> = None;
    for agent in agents {
        if cancel.is_cancelled() {
            break;
        }
        let mcp = core
            .0
            .deps
            .tools
            .as_ref()
            .map(|t| t.register(&run_id, &pr, agent));
        let req = AgentRequest {
            agent,
            prompt: skill_prompt(&skill),
            system: None,
            cwd: cwd.clone(),
            mode: AgentMode::ReadOnly,
            mcp: mcp.clone(),
            model: None,
            stall_after_ms: 90_000,
        };
        let _guard = ToolsGuard { core, mcp };
        match core.0.deps.agents.run(req).await {
            Ok(mut run) => loop {
                tokio::select! {
                    _ = cancel.cancelled() => { run.cancel.cancel(); break; }
                    event = run.events.recv() => {
                        let Some(event) = event else { break };
                        match event {
                            AgentEvent::Text { text } | AgentEvent::Thinking { text } => {
                                core.emit(Ephemeral::AgentDelta { run: run_id.clone(), agent, text });
                            }
                            AgentEvent::ToolCall { name, .. } => {
                                core.emit(Ephemeral::RunLog { run: run_id.clone(), agent, line: format!("tool: {name}") });
                            }
                            AgentEvent::ToolResult { ok, .. } => {
                                core.emit(Ephemeral::RunLog { run: run_id.clone(), agent, line: format!("tool result ok={ok}") });
                            }
                            AgentEvent::Usage { usage } => total_usage += usage,
                            AgentEvent::Stalled => {
                                core.emit(Ephemeral::RunLog { run: run_id.clone(), agent, line: "stalled".into() });
                            }
                            AgentEvent::Done { usage, .. } => {
                                total_usage += usage;
                                break;
                            }
                            AgentEvent::Error { message, .. } => {
                                error = Some(message);
                                break;
                            }
                        }
                    }
                }
            },
            Err(e) => error = Some(e.to_string()),
        }
    }

    let status = if cancel.is_cancelled() {
        RunStatus::Cancelled
    } else if error.is_some() {
        RunStatus::Failed
    } else {
        RunStatus::Done
    };
    let data = serde_json::json!({ "status": status, "usage": total_usage, "error": error });
    let _ = core
        .apply(vec![NewAction {
            model: models::SKILL_RUN.into(),
            model_id: run_id.clone(),
            action: SyncActionCode::C,
            data: Some(data),
        }])
        .await;
    core.0.runs.write().await.remove(&run_id);
}

/// Revokes a run's MCP token when the run's driver returns.
struct ToolsGuard<'a> {
    core: &'a Core,
    mcp: Option<theodore_ports::McpEndpoint>,
}

impl Drop for ToolsGuard<'_> {
    fn drop(&mut self) {
        if let (Some(tools), Some(mcp)) = (&self.core.0.deps.tools, &self.mcp) {
            tools.unregister(mcp);
        }
    }
}

fn skill_prompt(skill: &str) -> String {
    format!(
        "Review this pull request with the `{skill}` skill. Start with the review-tools \
         `get_pr_context` tool. Report every issue you find with `add_finding` \
         (file path, line on the new side, severity info|warn|high, short title, body). \
         Do not edit files. Finish with a one-paragraph summary."
    )
}

async fn fail_run(core: &Core, run_id: &str, message: &str) {
    let data = serde_json::json!({ "status": RunStatus::Failed, "error": message });
    let _ = core
        .apply(vec![NewAction {
            model: models::SKILL_RUN.into(),
            model_id: run_id.to_string(),
            action: SyncActionCode::C,
            data: Some(data),
        }])
        .await;
    core.0.runs.write().await.remove(run_id);
}

async fn drive_ask(
    core: &Core,
    run_id: String,
    pr: PrId,
    agent: AgentId,
    question: String,
    cwd: PathBuf,
    cancel: CancellationToken,
) {
    let mcp = core
        .0
        .deps
        .tools
        .as_ref()
        .map(|t| t.register(&run_id, &pr, agent));
    let req = AgentRequest {
        agent,
        prompt: question,
        system: None,
        cwd,
        mode: AgentMode::ReadOnly,
        mcp: mcp.clone(),
        model: None,
        stall_after_ms: 90_000,
    };
    let _guard = ToolsGuard { core, mcp };
    let mut text = String::new();
    let mut usage = Usage::default();
    let mut error = None;
    match core.0.deps.agents.run(req).await {
        Ok(mut run) => loop {
            tokio::select! {
                _ = cancel.cancelled() => { run.cancel.cancel(); break; }
                event = run.events.recv() => {
                    let Some(event) = event else { break };
                    match event {
                        AgentEvent::Text { text: t } => {
                            text.push_str(&t);
                            core.emit(Ephemeral::AgentDelta { run: run_id.clone(), agent, text: t });
                        }
                        AgentEvent::Done { final_text, usage: u } => {
                            text = final_text;
                            usage = u;
                            break;
                        }
                        AgentEvent::Error { message, .. } => {
                            error = Some(message);
                            break;
                        }
                        _ => {}
                    }
                }
            }
        },
        Err(e) => error = Some(e.to_string()),
    }
    core.0.runs.write().await.remove(&run_id);
    if cancel.is_cancelled() {
        return;
    }
    let message_id = uuid::Uuid::new_v4().to_string();
    let now = core.0.deps.clock.now();
    let body = error.unwrap_or(text);
    let reply = ChatMessage {
        id: message_id.clone(),
        pr,
        author: Author::Agent(agent),
        text: body,
        refs: vec![],
        usage: Some(usage),
        at: now,
    };
    if let Ok(data) = serde_json::to_value(&reply) {
        let _ = core
            .apply(vec![NewAction {
                model: models::CHAT_MESSAGE.into(),
                model_id: message_id,
                action: SyncActionCode::I,
                data: Some(data),
            }])
            .await;
    }
}
