//! AgentPort (plan §8): runs the `claude` / `codex` / `gemini` CLIs and
//! normalizes their JSON streams into `AgentEvent`.
//!
//! `AgentCli` owns per-agent binary configs (path override, extra args,
//! model) and dispatches `AgentRequest` to the matching builder + parser in
//! `claude` / `codex` / `gemini`. Process lifecycle (spawn, stdin, stall
//! detection, cancellation) is shared in `process`; it is CLI-agnostic.
//!
//! Neither CLI needed the `theodore mcp-bridge` stdio→HTTP proxy the plan
//! sketches as a fallback: Claude Code takes an inline HTTP MCP server via
//! `--mcp-config`, and Codex's `-c mcp_servers.<name>.url=...` override also
//! speaks HTTP directly (confirmed against installed `codex exec --help` /
//! `codex mcp add --help`). Gemini is settings-file only but that's still
//! native HTTP (`httpUrl`), not stdio. If a future CLI only speaks stdio MCP,
//! the bridge becomes necessary and is a separate slice.

pub mod claude;
pub mod codex;
pub mod config;
pub mod detect;
pub mod env;
pub mod gemini;
pub mod process;
pub mod shell;

use async_trait::async_trait;
use theodore_domain::AgentId;
use theodore_ports::agent::{AgentError, AgentInfo, AgentPort, AgentRequest, AgentRun};

pub use config::{AgentBinaryConfig, AgentCliConfig};
pub use shell::ShellRunner;

/// `AgentPort` over local CLI processes.
#[derive(Debug, Clone, Default)]
pub struct AgentCli {
    configs: AgentCliConfig,
    pid_dir: Option<std::path::PathBuf>,
}

impl AgentCli {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record running agents' pids under `dir` and kill any left behind by a
    /// previous run (see `process::reap_orphans`). The reap itself runs in a
    /// spawned task — `ps`/`kill` are still a process spawn + wait each, and
    /// this must not block whatever runtime is starting Theodore up.
    pub fn with_pid_dir(mut self, dir: std::path::PathBuf) -> Self {
        let reap_dir = dir.clone();
        tokio::spawn(async move {
            let n = process::reap_orphans(&reap_dir).await;
            if n > 0 {
                tracing::warn!(n, "killed agent processes left over from a previous run");
            }
        });
        self.pid_dir = Some(dir);
        self
    }

    pub fn with_config(mut self, id: AgentId, cfg: AgentBinaryConfig) -> Self {
        self.configs.set(id, cfg);
        self
    }
}

#[async_trait]
impl AgentPort for AgentCli {
    async fn detect(&self) -> Vec<AgentInfo> {
        let mut out = Vec::with_capacity(AgentId::ALL.len());
        for id in AgentId::ALL {
            let cfg = self.configs.get(id);
            out.push(detect::detect_one(id, &cfg).await);
        }
        out
    }

    async fn run(&self, req: AgentRequest) -> Result<AgentRun, AgentError> {
        let cfg = self.configs.get(req.agent);
        let program =
            detect::locate_binary(req.agent, &cfg).ok_or(AgentError::NotInstalled(req.agent))?;
        let mut child_env = env::filtered_env();
        child_env.extend(req.env.iter().cloned());
        let mut guards: Vec<Box<dyn std::any::Any + Send>> = Vec::new();

        let args = match req.agent {
            AgentId::Claude => {
                // Written to a 0600 temp file, not argv: `--mcp-config`'s
                // JSON carries the review-tools bearer token, and argv is
                // visible to any process on the host via `ps`/`/proc`.
                let mcp_guard =
                    claude::write_mcp_config(&req).map_err(|e| AgentError::Spawn(e.to_string()))?;
                let mcp_path = mcp_guard.as_ref().map(|f| f.path().to_path_buf());
                if let Some(g) = mcp_guard {
                    guards.push(Box::new(g));
                }
                claude::build_args(&req, &cfg, mcp_path.as_deref())
            }
            AgentId::Codex => {
                if let Some(mcp) = &req.mcp {
                    child_env.push((codex::MCP_TOKEN_ENV_VAR.to_string(), mcp.token.clone()));
                }
                codex::build_args(&req, &cfg)
            }
            AgentId::Gemini => {
                let (extra_env, guard) =
                    gemini::settings_env(&req).map_err(|e| AgentError::Spawn(e.to_string()))?;
                child_env.extend(extra_env);
                guards.push(Box::new(guard));
                gemini::build_args(&req, &cfg)
            }
        };

        let parser: Box<dyn process::LineParser> = match req.agent {
            AgentId::Claude => Box::new(claude::ClaudeParser::new()),
            AgentId::Codex => Box::new(codex::CodexParser::new()),
            AgentId::Gemini => Box::new(gemini::GeminiParser::new()),
        };

        let spec = process::SpawnSpec {
            program,
            args,
            cwd: req.cwd.clone(),
            env: child_env,
            stall_after_ms: req.stall_after_ms,
            max_runtime_ms: process::DEFAULT_MAX_RUNTIME_MS,
            guards,
            pid_dir: self.pid_dir.clone(),
        };
        process::spawn_and_stream(spec, parser)
    }
}
