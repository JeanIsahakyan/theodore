//! `run_skill`, `ask`, `cancel_run`, `add_finding` (plan §8.4): agents are
//! spawned per the `AgentPort`, their stream becomes ephemeral events, and
//! only the final result is synced.

use std::path::{Path, PathBuf};

use theodore_contract::{
    AskRequest, ChatMessage, Ephemeral, RunSkillRequest, RunStatus, SkillRun, models,
};
use theodore_domain::{AgentId, Author, Finding, FindingId, Fix, PrId};
use theodore_ports::{AgentEvent, AgentMode, AgentRequest, NewAction, SyncActionCode};
use tokio_util::sync::CancellationToken;

use crate::core::{Core, RunHandle};
use crate::error::{AppError, AppResult};

impl Core {
    pub async fn run_skill(&self, req: RunSkillRequest) -> AppResult<String> {
        self.ensure_open(&req.pr).await?;
        let repo_scope = self.repo_scope_of(&req.pr).await;
        let agents = if req.agents.is_empty() {
            self.setting_agents_scoped(
                "agents.skills",
                repo_scope.as_deref(),
                vec![AgentId::Claude],
            )
            .await
        } else {
            req.agents.clone()
        };
        // Skip agents that aren't installed instead of failing the whole run
        // after the installed ones already spent tokens.
        let installed: Vec<AgentId> = self
            .0
            .deps
            .agents
            .detect()
            .await
            .into_iter()
            .filter(|a| a.installed)
            .map(|a| a.id)
            .collect();
        let mut agents_filtered = Vec::new();
        for a in agents {
            if installed.contains(&a) && self.agent_enabled(a).await {
                agents_filtered.push(a);
            }
        }
        let agents = agents_filtered;
        if agents.is_empty() {
            return Err(AppError::Invalid(
                "none of the selected agents is installed and enabled".into(),
            ));
        }
        let run_id = uuid::Uuid::new_v4().to_string();
        let started_at = self.0.deps.clock.now();
        let row = SkillRun {
            id: run_id.clone(),
            pr: req.pr.clone(),
            skill: req.skill.clone(),
            agents: agents.clone(),
            status: RunStatus::Running,
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

        // Held for the whole run (plan "worktree locks"): the GC sweep must
        // never remove this worktree out from under a skill run in flight.
        let lease = self
            .pr_ref(&req.pr)
            .await
            .map(|r| self.0.deps.worktree_lease.acquire(r));

        let core = self.clone();
        let pr = req.pr.clone();
        let skill = req.skill.clone();
        let run_id2 = run_id.clone();
        tokio::spawn(async move {
            let _lease = lease;
            drive_skill_run(&core, run_id2, pr, skill, agents, cancel).await;
        });
        Ok(run_id)
    }

    pub async fn ask(&self, req: AskRequest) -> AppResult<String> {
        self.ensure_open(&req.pr).await?;
        let message_id = uuid::Uuid::new_v4().to_string();
        let now = self.0.deps.clock.now();
        let question = ChatMessage {
            id: message_id.clone(),
            pr: req.pr.clone(),
            author: Author::Me,
            text: req.question.clone(),
            refs: req.about.clone().into_iter().collect(),
            at: now,
            failed: None,
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
            None => {
                let repo_scope = self.repo_scope_of(&req.pr).await;
                let configured = self
                    .setting_agent_scoped("agents.chat", repo_scope.as_deref(), AgentId::Claude)
                    .await;
                self.effective_agent(configured).await
            }
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

        // Held for the whole run (plan "worktree locks"): see `run_skill`.
        let lease = self
            .pr_ref(&req.pr)
            .await
            .map(|r| self.0.deps.worktree_lease.acquire(r));

        let core = self.clone();
        let pr = req.pr.clone();
        tokio::spawn(async move {
            let _lease = lease;
            drive_ask(&core, run_id, pr, agent, req.question, cwd, cancel).await;
        });
        Ok(message_id)
    }

    /// `configured` unless it's disabled, in which case the first enabled
    /// installed agent (plan "enable/disable agents"): falls back instead
    /// of silently running a CLI the user turned off. Returns `configured`
    /// unchanged if every installed agent is disabled — a hard failure
    /// here would be worse than running the one the setting already named.
    pub(crate) async fn effective_agent(&self, configured: AgentId) -> AgentId {
        if self.agent_enabled(configured).await {
            return configured;
        }
        let installed: Vec<AgentId> = self
            .0
            .deps
            .agents
            .detect()
            .await
            .into_iter()
            .filter(|a| a.installed)
            .map(|a| a.id)
            .collect();
        self.first_enabled(&installed).await.unwrap_or(configured)
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
        // The MCP tools only know the run they serve: a finding reported
        // from a skill run names that run, and belongs to its skill (the
        // panel lists a run's findings by skill, and merges duplicates
        // across agents by skill).
        let run_id = finding.skill.0.clone();
        let store = self.0.deps.store.clone();
        if let Some(skill) =
            tokio::task::spawn_blocking(move || store.get(models::SKILL_RUN, &run_id))
                .await
                .map_err(AppError::join)??
                .and_then(|r| {
                    r.data
                        .get("skill")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                })
        {
            finding.skill = theodore_domain::SkillId(skill);
        }
        let pr_s = pr.0.clone();
        let store = self.0.deps.store.clone();
        let rows = tokio::task::spawn_blocking(move || store.query(models::FINDING, "pr", &pr_s))
            .await
            .map_err(AppError::join)??;
        let existing: Vec<Finding> = rows
            .iter()
            .filter_map(|r| serde_json::from_value(r.data.clone()).ok())
            .collect();

        let (action, mut merged) = match theodore_domain::findings::merge(&existing, finding) {
            theodore_domain::findings::MergeOutcome::New(f) => (SyncActionCode::I, f),
            theodore_domain::findings::MergeOutcome::MergedInto(f) => (SyncActionCode::U, f),
        };
        // A finding stored before skills were resolved names its run; fix
        // it up when a new report merges into it.
        let stored_skill = merged.skill.0.clone();
        let store = self.0.deps.store.clone();
        if let Some(skill) =
            tokio::task::spawn_blocking(move || store.get(models::SKILL_RUN, &stored_skill))
                .await
                .map_err(AppError::join)??
                .and_then(|r| {
                    r.data
                        .get("skill")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                })
        {
            merged.skill = theodore_domain::SkillId(skill);
        }
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
    // `agents` is never empty (checked by `run_skill` before spawning this
    // task) — used to attribute a setup failure that happens before any
    // agent actually starts.
    let first_agent = agents[0];
    let cwd = {
        let head = core.0.current_head.read().await.get(&pr).cloned();
        let Some(head) = head else {
            fail_run(core, &run_id, &pr, first_agent, "pr is not open").await;
            return;
        };
        let revisions = core.0.revisions.read().await;
        match revisions.get(&(pr.clone(), head)) {
            Some(e) => e.worktree_path.clone(),
            None => {
                fail_run(core, &run_id, &pr, first_agent, "revision not cached").await;
                return;
            }
        }
    };
    let stall_after_ms = core.stall_after_ms().await;

    let mut error: Option<String> = None;
    let mut last_agent = first_agent;
    for agent in agents {
        last_agent = agent;
        if cancel.is_cancelled() {
            break;
        }
        let mcp = core.pr_tools(&run_id, &pr, agent).await;
        let req = AgentRequest {
            agent,
            prompt: skill_prompt(&skill, agent, &cwd, &core.0.deps.claude_home),
            system: None,
            cwd: cwd.clone(),
            mode: AgentMode::ReadOnly,
            mcp: mcp.clone(),
            model: None,
            stall_after_ms,
            env: Vec::new(),
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
                            AgentEvent::Stalled => {
                                core.emit(Ephemeral::RunLog { run: run_id.clone(), agent, line: "stalled".into() });
                                core.emit(Ephemeral::RunStalled { run: run_id.clone(), agent });
                            }
                            AgentEvent::Usage { .. } => {}
                            AgentEvent::Done { .. } => break,
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

    let cancelled = cancel.is_cancelled();
    let status = if cancelled {
        RunStatus::Cancelled
    } else if error.is_some() {
        RunStatus::Failed
    } else {
        RunStatus::Done
    };
    let data = serde_json::json!({ "status": status, "error": error });
    let _ = core
        .apply(vec![NewAction {
            model: models::SKILL_RUN.into(),
            model_id: run_id.clone(),
            action: SyncActionCode::C,
            data: Some(data),
        }])
        .await;
    if cancelled || error.is_some() {
        let text = error.unwrap_or_else(|| "cancelled".into());
        persist_failed_message(core, &pr, last_agent, &text).await;
    }
    core.0.runs.write().await.remove(&run_id);
}

/// Persists a `ChatMessage` with `failed` set and `agent` as author instead
/// of only toasting (plan "failed agent runs"), so a run that errored,
/// crashed, hit its runtime cap, or was cancelled leaves a durable, visible,
/// retryable record even after the app restarts. `pub(crate)`: also used by
/// `usecases::tasks` for fix runs.
pub(crate) async fn persist_failed_message(core: &Core, pr: &PrId, agent: AgentId, text: &str) {
    let message_id = uuid::Uuid::new_v4().to_string();
    let message = ChatMessage {
        id: message_id.clone(),
        pr: pr.clone(),
        author: Author::Agent(agent),
        text: String::new(),
        refs: vec![],
        at: core.0.deps.clock.now(),
        failed: Some(text.to_string()),
    };
    if let Ok(data) = serde_json::to_value(&message) {
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

/// Revokes a run's MCP token when the run's driver returns. `pub(crate)`:
/// also used by `usecases::tasks` for fix runs.
pub(crate) struct ToolsGuard<'a> {
    pub(crate) core: &'a Core,
    pub(crate) mcp: Option<theodore_ports::McpEndpoint>,
}

impl Drop for ToolsGuard<'_> {
    fn drop(&mut self) {
        if let (Some(tools), Some(mcp)) = (&self.core.0.deps.tools, &self.mcp) {
            tools.unregister(mcp);
        }
    }
}

/// Claude discovers `SKILL.md` files under `~/.claude/skills` and the
/// worktree's `.claude/skills` on its own (plan §8.4), so it only needs the
/// skill referenced by name. Every other agent gets the full text inlined.
fn skill_prompt(skill: &str, agent: AgentId, worktree: &Path, claude_home: &Path) -> String {
    let instructions = "Start with the review-tools `get_pr_context` tool. Report every issue \
         you find with `add_finding` (file path, line on the new side, severity \
         info|warn|high, short title, body). Do not edit files. Finish with a \
         one-paragraph summary.";
    if agent == AgentId::Claude {
        return format!("Review this pull request with the `{skill}` skill. {instructions}");
    }
    match crate::usecases::skills::resolve_skill_content(skill, worktree, claude_home) {
        Some(content) => format!(
            "{content}\n\n---\n\nReview this pull request using the skill above. {instructions}"
        ),
        None => format!("Review this pull request with the `{skill}` skill. {instructions}"),
    }
}

async fn fail_run(core: &Core, run_id: &str, pr: &PrId, agent: AgentId, message: &str) {
    let data = serde_json::json!({ "status": RunStatus::Failed, "error": message });
    let _ = core
        .apply(vec![NewAction {
            model: models::SKILL_RUN.into(),
            model_id: run_id.to_string(),
            action: SyncActionCode::C,
            data: Some(data),
        }])
        .await;
    persist_failed_message(core, pr, agent, message).await;
    core.0.runs.write().await.remove(run_id);
}

/// Chat questions get the same footing as skills: the worktree holds only
/// the head, so without this the agent can't tell what the PR changed and
/// says so instead of answering.
const ASK_SYSTEM: &str = "You are answering a question about the pull request checked out \
     in the current directory. The directory has only the PR's head; what the PR changes \
     comes from the review-tools MCP server: `get_pr_context` (title, body, commits, \
     files, groups), `get_group` (a group's hunks as a unified diff) and `get_base_file` \
     (a file before the change). Look at the change through those tools before \
     answering. Do not edit files. Answer briefly and point at file:line where it helps.";

async fn drive_ask(
    core: &Core,
    run_id: String,
    pr: PrId,
    agent: AgentId,
    question: String,
    cwd: PathBuf,
    cancel: CancellationToken,
) {
    let mcp = core.pr_tools(&run_id, &pr, agent).await;
    let req = AgentRequest {
        agent,
        prompt: question,
        system: Some(ASK_SYSTEM.into()),
        cwd,
        mode: AgentMode::ReadOnly,
        mcp: mcp.clone(),
        model: None,
        stall_after_ms: core.stall_after_ms().await,
        env: Vec::new(),
    };
    let _guard = ToolsGuard { core, mcp };
    let mut text = String::new();
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
                        AgentEvent::Stalled => {
                            core.emit(Ephemeral::RunStalled { run: run_id.clone(), agent });
                        }
                        AgentEvent::Done { final_text, .. } => {
                            text = final_text;
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

    // A crash, the runtime cap, or a cancel all leave a durable, retryable
    // record instead of silently dropping the exchange (plan "failed agent
    // runs") — cancelling mid-answer must not look, after a restart, as if
    // nothing was ever asked.
    if cancel.is_cancelled() || error.is_some() {
        let text = error.unwrap_or_else(|| "cancelled".into());
        persist_failed_message(core, &pr, agent, &text).await;
        return;
    }

    let message_id = uuid::Uuid::new_v4().to_string();
    let now = core.0.deps.clock.now();
    let reply = ChatMessage {
        id: message_id.clone(),
        pr,
        author: Author::Agent(agent),
        text,
        refs: vec![],
        at: now,
        failed: None,
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
