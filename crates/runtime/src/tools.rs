//! MCP `review-tools` and `space-tools` (plan §8.3): the backends over
//! `Core`, and the per-run token registry `app` uses when it spawns agents.

use std::sync::{Arc, Mutex, OnceLock};

use async_trait::async_trait;
use theodore_app::{Core, RunTools};
use theodore_contract::FileRequest;
use theodore_domain::{
    AgentId, Anchor, Finding, FindingId, FindingState, Fix, FixStatus, Patch, PrId, RunId, Side,
    SkillId,
};
use theodore_mcp::{
    AppStatus, BackendError, CheckOutcome, FileSummary, GroupSummary, GroupWithHunks, LogTail,
    McpHandle, McpServer, NewFinding, NewPatch, PrContext, ReviewToolsBackend, RunContext,
    SpaceCommandName, SpaceInfo, SpaceToolError, SpaceToolsBackend, ToolSet,
};
use theodore_ports::McpEndpoint;

/// Backend over the core. Created before the core exists (the core needs the
/// MCP endpoint registry), then `attach`ed once it is started.
#[derive(Default)]
pub struct CoreTools {
    core: OnceLock<Core>,
}

impl CoreTools {
    pub fn attach(&self, core: Core) {
        let _ = self.core.set(core);
    }

    fn space_core(&self) -> Result<&Core, SpaceToolError> {
        self.core
            .get()
            .ok_or_else(|| SpaceToolError::Unavailable("core not started".into()))
    }

    fn core(&self) -> Result<&Core, BackendError> {
        self.core
            .get()
            .ok_or_else(|| BackendError::Internal("core not started".into()))
    }

    async fn snapshot(&self, pr: &PrId) -> Result<theodore_app::PrSnapshot, BackendError> {
        self.core()?
            .snapshot(pr)
            .await
            .map_err(|e| BackendError::NotFound(e.to_string()))
    }
}

#[async_trait]
impl ReviewToolsBackend for CoreTools {
    async fn get_pr_context(&self, run: &RunContext) -> Result<PrContext, BackendError> {
        let s = self.snapshot(&run.pr).await?;
        Ok(PrContext {
            title: s.detail.summary.title.clone(),
            body: s.detail.body.clone(),
            commits: s.detail.commits.clone(),
            files: s
                .revision
                .files
                .iter()
                .map(|f| FileSummary {
                    path: f.path.clone(),
                    status: f.status,
                    additions: f.additions,
                    deletions: f.deletions,
                })
                .collect(),
            groups: s
                .grouping
                .iter()
                .flat_map(|g| g.groups.iter())
                .map(|g| GroupSummary {
                    id: g.id.0.clone(),
                    title: g.title.clone(),
                    why: g.why.clone(),
                    hunk_count: g.hunks.len(),
                })
                .collect(),
        })
    }

    async fn get_group(
        &self,
        run: &RunContext,
        group_id: &str,
    ) -> Result<GroupWithHunks, BackendError> {
        let s = self.snapshot(&run.pr).await?;
        let group = s
            .grouping
            .as_ref()
            .and_then(|g| g.groups.iter().find(|g| g.id.0 == group_id))
            .cloned()
            .ok_or_else(|| BackendError::NotFound(format!("group {group_id}")))?;
        let hunks = group
            .hunks
            .iter()
            .filter_map(|id| s.revision.hunks().find(|h| &h.id == id).cloned())
            .collect();
        Ok(GroupWithHunks { group, hunks })
    }

    async fn get_base_file(
        &self,
        run: &RunContext,
        path: &str,
    ) -> Result<Option<String>, BackendError> {
        let core = self.core()?;
        let s = self.snapshot(&run.pr).await?;
        core.get_file(FileRequest {
            pr: run.pr.clone(),
            rev: s.revision.base.clone(),
            path: path.into(),
        })
        .await
        .map_err(|e| BackendError::Internal(e.to_string()))
    }

    async fn add_finding(
        &self,
        run: &RunContext,
        f: NewFinding,
    ) -> Result<FindingId, BackendError> {
        let core = self.core()?;
        let s = self.snapshot(&run.pr).await?;
        let finding = Finding {
            id: FindingId(uuid::Uuid::new_v4().to_string()),
            pr: run.pr.clone(),
            skill: SkillId(run.run_id.0.clone()),
            agents: vec![run.agent],
            anchor: Anchor {
                rev: s.revision.head.clone(),
                path: f.file,
                side: Side::New,
                line: f.line,
                start_line: None,
                start_side: None,
            },
            severity: f.severity,
            title: f.title,
            body: f.body,
            state: FindingState::Open,
            fix: None,
            outdated: false,
        };
        core.add_finding(run.pr.clone(), finding)
            .await
            .map_err(|e| BackendError::Invalid(e.to_string()))
    }

    async fn propose_patch(&self, run: &RunContext, p: NewPatch) -> Result<(), BackendError> {
        let core = self.core()?;
        core.attach_fix(
            &run.pr,
            &p.finding_id,
            Fix {
                status: FixStatus::Ready,
                patch: Some(Patch {
                    path: p.file,
                    before: p.before,
                    after: p.after,
                    note: p.note,
                    by: run.agent,
                }),
                commit: None,
            },
        )
        .await
        .map_err(|e| BackendError::Invalid(e.to_string()))
    }
}

/// The space tools over the core: the space is the one the run's token
/// was registered for (`theodore_mcp::RunContext::space`).
#[async_trait]
impl SpaceToolsBackend for CoreTools {
    async fn run_check(&self, space: &str, run_id: &RunId) -> Result<CheckOutcome, SpaceToolError> {
        self.space_core()?.space_tool_check(space, &run_id.0).await
    }

    async fn start_app(&self, space: &str) -> Result<AppStatus, SpaceToolError> {
        self.space_core()?.space_tool_start(space).await
    }

    async fn stop_app(&self, space: &str) -> Result<AppStatus, SpaceToolError> {
        self.space_core()?.space_tool_stop(space).await
    }

    async fn app_status(&self, space: &str) -> Result<AppStatus, SpaceToolError> {
        self.space_core()?.space_tool_status(space).await
    }

    async fn read_logs(
        &self,
        space: &str,
        kind: SpaceCommandName,
        tail: usize,
    ) -> Result<LogTail, SpaceToolError> {
        self.space_core()?.space_tool_logs(space, kind, tail).await
    }

    async fn space_info(&self, space: &str) -> Result<SpaceInfo, SpaceToolError> {
        self.space_core()?.space_tool_info(space).await
    }
}

/// The running MCP server plus `RunTools` for `app`.
pub struct McpRunTools {
    handle: Mutex<Option<McpHandle>>,
}

impl McpRunTools {
    pub async fn start(
        review: Arc<dyn ReviewToolsBackend>,
        spaces: Arc<dyn SpaceToolsBackend>,
    ) -> anyhow::Result<Self> {
        let handle = McpServer::start_with_spaces(review, spaces).await?;
        Ok(Self {
            handle: Mutex::new(Some(handle)),
        })
    }

    pub async fn shutdown(&self) {
        let h = self.handle.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(h) = h {
            h.shutdown().await;
        }
    }

    fn register_ctx(&self, ctx: RunContext) -> McpEndpoint {
        let guard = self.handle.lock().unwrap_or_else(|p| p.into_inner());
        let name = ctx.server_name().to_string();
        match guard.as_ref() {
            Some(h) => h.register_run(ctx),
            None => McpEndpoint {
                url: String::new(),
                token: String::new(),
                name,
            },
        }
    }
}

impl RunTools for McpRunTools {
    fn register(
        &self,
        run_id: &str,
        pr: &PrId,
        agent: AgentId,
        space: Option<&str>,
    ) -> McpEndpoint {
        let mut ctx = RunContext::review(RunId(run_id.into()), pr.clone(), agent);
        ctx.space = space.map(str::to_string);
        self.register_ctx(ctx)
    }

    fn register_space(&self, run_id: &str, space: &str, agent: AgentId) -> McpEndpoint {
        self.register_ctx(RunContext {
            run_id: RunId(run_id.into()),
            pr: theodore_app::space_chat_key(space),
            agent,
            space: Some(space.to_string()),
            tools: ToolSet::Space,
        })
    }

    fn unregister(&self, endpoint: &McpEndpoint) {
        let guard = self.handle.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(h) = guard.as_ref() {
            h.unregister_run(&endpoint.token);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The server name the agent registers follows the run: a space turn's
    /// endpoint is `space-tools`, a PR run's (on a space's PR or not)
    /// `review-tools`.
    #[tokio::test]
    async fn space_turns_and_pr_runs_get_their_own_server() {
        let backend = Arc::new(CoreTools::default());
        let tools = McpRunTools::start(backend.clone(), backend).await.unwrap();
        let pr = PrId("github:o/r#1".into());
        let space = tools.register_space("space:s1:m1", "s1", AgentId::Claude);
        let on_space_pr = tools.register("r1", &pr, AgentId::Claude, Some("s1"));
        let plain = tools.register("r2", &pr, AgentId::Claude, None);
        assert_eq!(space.name, "space-tools");
        assert_eq!(on_space_pr.name, "review-tools");
        assert_eq!(plain.name, "review-tools");
        assert_ne!(space.token, plain.token);
        assert_eq!(
            space.url, plain.url,
            "one server, the token picks the tools"
        );
        tools.shutdown().await;
    }
}
