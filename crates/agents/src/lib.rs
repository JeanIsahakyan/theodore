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

pub mod accounts;
pub mod claude;
pub mod codex;
pub mod config;
pub mod detect;
pub mod edit_guard;
pub mod env;
pub mod exit_output;
pub mod gemini;
pub mod limits;
pub mod models;
pub mod process;
pub mod pty;
pub mod shell;
pub mod sign_in;
pub mod signals;

use async_trait::async_trait;
use theodore_domain::AgentId;
use theodore_ports::agent::{
    AgentAccountRef, AgentError, AgentInfo, AgentPort, AgentRequest, AgentRun, ModelInfo, Steer,
};

pub use config::{AgentBinaryConfig, AgentCliConfig};
pub use pty::PtyRunner;
pub use shell::ShellRunner;

/// A space turn's `space-tools` has `ask_user`, which waits for you (up
/// to `ASK_USER_TIMEOUT_MS`): each CLI's MCP call timeout is raised past
/// it, and so is the run's runtime cap.
pub(crate) fn waits_on_user(req: &AgentRequest) -> bool {
    req.mcp
        .as_ref()
        .is_some_and(|m| m.name == theodore_ports::SPACE_TOOLS)
}

/// The MCP tool-call timeout of a run that may wait on you: the question's
/// own timeout plus a margin, so Theodore's answer (or its timeout) always
/// comes before the CLI gives up on the call.
pub(crate) const USER_TOOL_TIMEOUT_MS: u64 = theodore_ports::ASK_USER_TIMEOUT_MS + 5 * 60 * 1000;

/// `AgentPort` over local CLI processes.
#[derive(Debug, Clone, Default)]
pub struct AgentCli {
    configs: AgentCliConfig,
    pid_dir: Option<std::path::PathBuf>,
    /// Each CLI's `--version` from the last `detect`, for the log.
    versions: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<AgentId, String>>>,
    /// `codex debug models`: a success for the process, a failure (not
    /// installed, or the listing broke) for `CODEX_RETRY_AFTER`.
    /// Per account: the default one and each extra `CODEX_HOME`.
    codex_models:
        std::sync::Arc<tokio::sync::Mutex<std::collections::HashMap<String, CodexModels>>>,
    /// Each CLI's sign-in, as last checked or as a run found it.
    sign_in: std::sync::Arc<std::sync::Mutex<SignInCache>>,
}

/// How long a sign-in check's answer stands: as long as the fleet's
/// catalog of agents (`fleet_agents.rs`).
const SIGN_IN_TTL: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// How long "couldn't tell" stands before asking again.
const SIGN_IN_UNKNOWN_TTL: std::time::Duration = std::time::Duration::from_secs(60);

/// One account of one agent: the default one, or an extra account's id.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SignInKey(AgentId, String);

impl From<AgentId> for SignInKey {
    fn from(id: AgentId) -> Self {
        SignInKey(id, theodore_ports::DEFAULT_ACCOUNT.to_string())
    }
}

impl SignInKey {
    fn of(id: AgentId, account: Option<&AgentAccountRef>) -> Self {
        match account {
            Some(a) if !a.is_default() => SignInKey(id, a.id.clone()),
            _ => id.into(),
        }
    }
}

/// Each account's sign-in and when it was learned.
#[derive(Debug, Default)]
struct SignInCache(std::collections::HashMap<SignInKey, (std::time::Instant, Option<bool>)>);

impl SignInCache {
    /// The known answer for `id` if it still stands at `now`.
    fn fresh(&self, id: impl Into<SignInKey>, now: std::time::Instant) -> Option<Option<bool>> {
        let (at, known) = self.0.get(&id.into())?;
        let ttl = if known.is_some() {
            SIGN_IN_TTL
        } else {
            SIGN_IN_UNKNOWN_TTL
        };
        (now.duration_since(*at) < ttl).then_some(*known)
    }

    fn known(&self, id: impl Into<SignInKey>) -> Option<bool> {
        self.0.get(&id.into()).and_then(|(_, k)| *k)
    }

    fn set(&mut self, id: impl Into<SignInKey>, now: std::time::Instant, known: Option<bool>) {
        self.0.insert(id.into(), (now, known));
    }

    fn forget(&mut self, id: impl Into<SignInKey>) {
        self.0.remove(&id.into());
    }
}

/// How long a failed codex model listing stands before it's tried again:
/// the picker asks on every open, and a missing CLI stays missing.
const CODEX_RETRY_AFTER: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Why there's no codex model list.
#[derive(Debug, Clone, PartialEq, Eq)]
enum CodexListError {
    /// No `codex` binary: an expected state, logged at debug.
    NotInstalled,
    /// Installed, but `codex debug models` failed.
    Failed(String),
}

/// The cached outcome of listing codex's models.
#[derive(Debug, Default)]
struct CodexModels {
    listed: Option<Vec<ModelInfo>>,
    /// The last failure and when it happened.
    failed: Option<(std::time::Instant, CodexListError)>,
    /// A real failure was already warned about (once per process).
    warned: bool,
}

/// The level a failed listing is logged at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ListLog {
    Debug,
    Warn,
}

impl CodexModels {
    /// The cached answer, if one still stands at `now`.
    fn cached(&self, now: std::time::Instant) -> Option<Vec<ModelInfo>> {
        if let Some(list) = &self.listed {
            return Some(list.clone());
        }
        match &self.failed {
            Some((at, _)) if now.duration_since(*at) < CODEX_RETRY_AFTER => Some(Vec::new()),
            _ => None,
        }
    }

    /// Keeps a fresh outcome; a failure also says how to log it.
    fn record(
        &mut self,
        now: std::time::Instant,
        outcome: Result<Vec<ModelInfo>, CodexListError>,
    ) -> (Vec<ModelInfo>, Option<ListLog>) {
        match outcome {
            Ok(list) => {
                self.listed = Some(list.clone());
                self.failed = None;
                (list, None)
            }
            Err(e) => {
                let level = match &e {
                    CodexListError::NotInstalled => ListLog::Debug,
                    CodexListError::Failed(_) if self.warned => ListLog::Debug,
                    CodexListError::Failed(_) => {
                        self.warned = true;
                        ListLog::Warn
                    }
                };
                self.failed = Some((now, e));
                (Vec::new(), Some(level))
            }
        }
    }
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

impl AgentCli {
    /// One agent's `detect`: its binary, version and sign-in.
    async fn detect_agent(&self, id: AgentId) -> AgentInfo {
        let cfg = self.configs.get(id);
        let Some(path) = detect::locate_binary(id, &cfg) else {
            return AgentInfo {
                id,
                path: None,
                version: None,
                installed: false,
                signed_in: None,
            };
        };
        let (version, signed_in) =
            tokio::join!(detect::read_version(&path), self.signed_in(id, &path));
        if let Some(v) = &version {
            self.versions
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(id, v.clone());
        }
        AgentInfo {
            id,
            path: Some(path),
            version,
            installed: true,
            signed_in,
        }
    }

    /// `id`'s sign-in: the cached answer while it stands, else checked now
    /// (`sign_in::check`, with a run's env).
    async fn signed_in(&self, id: AgentId, program: &std::path::Path) -> Option<bool> {
        self.account_signed_in(id, None, program).await
    }

    /// `signed_in` for one account: checked with the env its runs get.
    /// Gemini's extra accounts are a key file, so that file says.
    async fn account_signed_in(
        &self,
        id: AgentId,
        account: Option<&AgentAccountRef>,
        program: &std::path::Path,
    ) -> Option<bool> {
        let key = SignInKey::of(id, account);
        let now = std::time::Instant::now();
        if let Some(known) = self
            .sign_in
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .fresh(key.clone(), now)
        {
            return known;
        }
        let known = match accounts::extra_dir(account) {
            Some(dir) if id == AgentId::Gemini => Some(!accounts::gemini_keys(dir).is_empty()),
            _ => {
                let mut run_env = env::filtered_env();
                accounts::apply_env(id, account, &mut run_env);
                let home = dirs::home_dir();
                sign_in::check(id, program, &run_env, home.as_deref()).await
            }
        };
        if known == Some(false) {
            tracing::info!(agent = id.as_str(), account = %key.1, "agent isn't signed in");
        }
        self.sign_in.lock().unwrap_or_else(|p| p.into_inner()).set(
            key,
            std::time::Instant::now(),
            known,
        );
        known
    }

    /// What a run that fails signed out calls: its account is known signed
    /// out until it's checked again.
    fn signed_out_hook(
        &self,
        id: AgentId,
        account: Option<&AgentAccountRef>,
    ) -> process::SignedOutHook {
        let cache = self.sign_in.clone();
        let key = SignInKey::of(id, account);
        std::sync::Arc::new(move || {
            cache.lock().unwrap_or_else(|p| p.into_inner()).set(
                key.clone(),
                std::time::Instant::now(),
                Some(false),
            );
        })
    }
}

impl AgentCli {
    /// One CLI process for `req`; `steerable` (Claude only) keeps its stdin
    /// open for steered messages.
    async fn spawn(
        &self,
        req: AgentRequest,
        steerable: bool,
    ) -> Result<(AgentRun, Option<Steer>), AgentError> {
        let cfg = self.configs.get(req.agent);
        let program =
            detect::locate_binary(req.agent, &cfg).ok_or(AgentError::NotInstalled(req.agent))?;
        let mut child_env = env::filtered_env();
        child_env.extend(req.env.iter().cloned());
        // Last: the account decides, whatever the space's env says.
        accounts::apply_env(req.agent, req.account.as_ref(), &mut child_env);
        let mut guards: Vec<Box<dyn std::any::Any + Send>> = Vec::new();

        let args = match req.agent {
            AgentId::Claude => {
                if waits_on_user(&req) && !child_env.iter().any(|(k, _)| k == "MCP_TOOL_TIMEOUT") {
                    child_env.push((
                        "MCP_TOOL_TIMEOUT".to_string(),
                        USER_TOOL_TIMEOUT_MS.to_string(),
                    ));
                }
                // Written to a 0600 temp file, not argv: `--mcp-config`'s
                // JSON carries the review-tools bearer token, and argv is
                // visible to any process on the host via `ps`/`/proc`.
                let mcp_guard =
                    claude::write_mcp_config(&req).map_err(|e| AgentError::Spawn(e.to_string()))?;
                let mcp_path = mcp_guard.as_ref().map(|f| f.path().to_path_buf());
                if let Some(g) = mcp_guard {
                    guards.push(Box::new(g));
                }
                if steerable {
                    claude::build_steerable_args(&req, &cfg, mcp_path.as_deref())
                } else {
                    claude::build_args(&req, &cfg, mcp_path.as_deref())
                }
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
            AgentId::Claude if steerable => Box::new(claude::ClaudeParser::with_stdin_input()),
            AgentId::Claude => Box::new(claude::ClaudeParser::new()),
            AgentId::Codex => Box::new(codex::CodexParser::new()),
            AgentId::Gemini => Box::new(gemini::GeminiParser::new(req.stream_text)),
        };

        let spec = process::SpawnSpec {
            program,
            args,
            cwd: req.cwd.clone(),
            env: child_env,
            stall_after_ms: req.stall_after_ms,
            // Time spent waiting on your answer doesn't count as a hang.
            max_runtime_ms: if waits_on_user(&req) {
                process::DEFAULT_MAX_RUNTIME_MS + theodore_ports::ASK_USER_TIMEOUT_MS
            } else {
                process::DEFAULT_MAX_RUNTIME_MS
            },
            max_linger_ms: if steerable { process::LINGER_MAX_MS } else { 0 },
            guards,
            pid_dir: self.pid_dir.clone(),
            agent: req.agent.as_str().to_string(),
            version: self
                .versions
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(&req.agent)
                .cloned(),
            on_signed_out: Some(self.signed_out_hook(req.agent, req.account.as_ref())),
        };
        if !steerable {
            return process::spawn_and_stream(spec, parser).map(|run| (run, None));
        }
        let (steer, messages) = Steer::channel();
        let input = process::Input {
            first: claude::user_message_line(&req.prompt),
            messages,
            encode: claude::user_message_line,
            encode_control: claude::control_request_line,
        };
        process::spawn_with_input(spec, parser, input).map(|run| (run, Some(steer)))
    }
}

#[async_trait]
impl AgentPort for AgentCli {
    /// Every agent at once: each finds its CLI, reads `--version` and
    /// checks its sign-in (cached, `SIGN_IN_TTL`) side by side.
    async fn detect(&self) -> Vec<AgentInfo> {
        let tasks: Vec<_> = AgentId::ALL
            .into_iter()
            .map(|id| {
                let cli = self.clone();
                tokio::spawn(async move { cli.detect_agent(id).await })
            })
            .collect();
        let mut out = Vec::with_capacity(tasks.len());
        for (id, task) in AgentId::ALL.into_iter().zip(tasks) {
            out.push(task.await.unwrap_or(AgentInfo {
                id,
                path: None,
                version: None,
                installed: false,
                signed_in: None,
            }));
        }
        out
    }

    async fn recheck_sign_in(&self) {
        self.sign_in
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .0
            .clear();
    }

    fn known_sign_in(&self, agent: AgentId) -> Option<bool> {
        self.sign_in
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .known(agent)
    }

    async fn run(&self, req: AgentRequest) -> Result<AgentRun, AgentError> {
        self.spawn(req, false).await.map(|(run, _)| run)
    }

    /// Claude Code reads its messages from stdin while it runs; Codex and
    /// Gemini take one prompt per process, so theirs is a plain run.
    async fn run_steerable(
        &self,
        req: AgentRequest,
    ) -> Result<(AgentRun, Option<Steer>), AgentError> {
        let steerable = req.agent == AgentId::Claude;
        self.spawn(req, steerable).await
    }

    async fn models(&self, agent: AgentId) -> Vec<ModelInfo> {
        self.models_in(agent, None).await
    }

    async fn models_in(&self, agent: AgentId, account: Option<&AgentAccountRef>) -> Vec<ModelInfo> {
        match agent {
            AgentId::Claude => match accounts::extra_dir(account) {
                Some(dir) => models::claude_models_in(dir),
                None => models::claude_models(),
            },
            AgentId::Codex => {
                let key = SignInKey::of(agent, account).1;
                let mut caches = self.codex_models.lock().await;
                let cache = caches.entry(key).or_default();
                let now = std::time::Instant::now();
                if let Some(list) = cache.cached(now) {
                    return list;
                }
                let cfg = self.configs.get(AgentId::Codex);
                let mut run_env = env::filtered_env();
                accounts::apply_env(agent, account, &mut run_env);
                let outcome = match detect::locate_binary(AgentId::Codex, &cfg) {
                    None => Err(CodexListError::NotInstalled),
                    Some(program) => models::codex_models(&program, &run_env)
                        .await
                        .map_err(CodexListError::Failed),
                };
                let (list, log) = cache.record(now, outcome);
                if let (Some(level), Some((_, e))) = (log, &cache.failed) {
                    match (level, e) {
                        (ListLog::Warn, CodexListError::Failed(reason)) => {
                            tracing::warn!(reason = %reason, "couldn't list codex models");
                        }
                        (_, e) => tracing::debug!(reason = ?e, "no codex models"),
                    }
                }
                list
            }
            AgentId::Gemini => Vec::new(),
        }
    }

    async fn account_sign_in(
        &self,
        agent: AgentId,
        account: &AgentAccountRef,
        recheck: bool,
    ) -> Option<bool> {
        if recheck {
            self.sign_in
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .forget(SignInKey::of(agent, Some(account)));
        }
        let cfg = self.configs.get(agent);
        let program = detect::locate_binary(agent, &cfg)?;
        self.account_signed_in(agent, Some(account), &program).await
    }

    fn known_account_sign_in(&self, agent: AgentId, account: &AgentAccountRef) -> Option<bool> {
        self.sign_in
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .known(SignInKey::of(agent, Some(account)))
    }

    /// Claude Code only: its session file moves between the two config dirs
    /// (`accounts::copy_claude_session`). Codex keeps a thread index next to
    /// its rollouts, so a copied rollout isn't known to be resumable: it
    /// replays instead.
    async fn carry_session(
        &self,
        agent: AgentId,
        session: &str,
        cwd: &std::path::Path,
        from: &AgentAccountRef,
        to: &AgentAccountRef,
    ) -> bool {
        if agent != AgentId::Claude || from == to {
            return from == to;
        }
        let (Some(src), Some(dest)) = (
            accounts::dir_of(agent, Some(from)),
            accounts::dir_of(agent, Some(to)),
        ) else {
            return false;
        };
        let (cwd, session) = (cwd.to_path_buf(), session.to_string());
        let copied = tokio::task::spawn_blocking(move || {
            accounts::copy_claude_session(&src, &dest, &cwd, &session)
        })
        .await;
        match copied {
            Ok(Ok(copied)) => copied,
            Ok(Err(e)) => {
                tracing::warn!(error = %e, "couldn't copy the claude session to the other account");
                false
            }
            Err(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn model(id: &str) -> ModelInfo {
        ModelInfo {
            id: id.into(),
            label: id.into(),
            description: None,
            efforts: vec![],
            default_effort: None,
            older: false,
        }
    }

    #[test]
    fn not_installed_is_debug_and_stands_for_a_while() {
        let mut cache = CodexModels::default();
        let t0 = Instant::now();
        assert_eq!(cache.cached(t0), None);
        let (list, log) = cache.record(t0, Err(CodexListError::NotInstalled));
        assert!(list.is_empty());
        assert_eq!(log, Some(ListLog::Debug));
        assert_eq!(cache.cached(t0 + Duration::from_secs(60)), Some(vec![]));
        assert_eq!(cache.cached(t0 + CODEX_RETRY_AFTER), None, "tried again");
    }

    #[test]
    fn a_real_failure_warns_once_per_process() {
        let mut cache = CodexModels::default();
        let t0 = Instant::now();
        let fail = || Err(CodexListError::Failed("exited with 1".into()));
        assert_eq!(cache.record(t0, fail()).1, Some(ListLog::Warn));
        let later = t0 + CODEX_RETRY_AFTER;
        assert_eq!(cache.cached(later), None);
        assert_eq!(cache.record(later, fail()).1, Some(ListLog::Debug));
    }

    #[test]
    fn a_listing_is_kept_for_the_process() {
        let mut cache = CodexModels::default();
        let t0 = Instant::now();
        cache.record(t0, Err(CodexListError::NotInstalled));
        let (list, log) = cache.record(t0 + CODEX_RETRY_AFTER, Ok(vec![model("m")]));
        assert_eq!((list.len(), log), (1, None));
        let much_later = t0 + CODEX_RETRY_AFTER * 10;
        assert_eq!(cache.cached(much_later), Some(vec![model("m")]));
    }

    #[test]
    fn a_sign_in_stands_for_a_while_and_unknown_for_less() {
        let mut cache = SignInCache::default();
        let t0 = Instant::now();
        assert_eq!(cache.fresh(AgentId::Codex, t0), None, "never checked");
        cache.set(AgentId::Codex, t0, Some(false));
        cache.set(AgentId::Claude, t0, None);
        let later = t0 + SIGN_IN_UNKNOWN_TTL;
        assert_eq!(cache.fresh(AgentId::Codex, later), Some(Some(false)));
        assert_eq!(cache.fresh(AgentId::Claude, later), None, "asked again");
        assert_eq!(cache.fresh(AgentId::Codex, t0 + SIGN_IN_TTL), None);
        assert_eq!(cache.known(AgentId::Codex), Some(false));
    }

    /// A fake CLI at `<dir>/<name>` that prints `out` for any arguments.
    fn fake_cli(dir: &std::path::Path, name: &str, out: &str, code: i32) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\necho '{out}'\nexit {code}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[tokio::test]
    async fn detect_checks_sign_in_once_and_a_signed_out_run_marks_it() {
        let dir = tempfile::tempdir().unwrap();
        let claude = fake_cli(dir.path(), "claude", r#"{"loggedIn": true}"#, 0);
        let cli = AgentCli::new()
            .with_config(
                AgentId::Claude,
                AgentBinaryConfig {
                    path: Some(claude.clone()),
                    ..Default::default()
                },
            )
            .with_config(
                AgentId::Codex,
                AgentBinaryConfig {
                    path: Some(dir.path().join("no-codex")),
                    ..Default::default()
                },
            )
            .with_config(
                AgentId::Gemini,
                AgentBinaryConfig {
                    path: Some(dir.path().join("no-gemini")),
                    ..Default::default()
                },
            );
        let by_id = |list: Vec<AgentInfo>, id| list.into_iter().find(|a| a.id == id).unwrap();
        let info = by_id(cli.detect().await, AgentId::Claude);
        // The fake says so (or a key in this process's env does first).
        assert_eq!(info.signed_in, Some(true));
        assert_eq!(by_id(cli.detect().await, AgentId::Codex).signed_in, None);

        // A run found it signed out: known without checking, until asked.
        (cli.signed_out_hook(AgentId::Claude, None))();
        assert_eq!(cli.known_sign_in(AgentId::Claude), Some(false));
        assert_eq!(
            by_id(cli.detect().await, AgentId::Claude).signed_in,
            Some(false)
        );
        cli.recheck_sign_in().await;
        assert_eq!(cli.known_sign_in(AgentId::Claude), None);
        let again = by_id(cli.detect().await, AgentId::Claude);
        assert_ne!(again.signed_in, Some(false), "checked again");
    }

    #[tokio::test]
    async fn a_run_on_an_extra_account_gets_its_config_dir_and_no_key() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("claude");
        std::fs::write(
            &path,
            "#!/bin/sh\nprintf '{\"type\":\"result\",\"is_error\":false,\"result\":\"%s|%s\"}\\n' \"$CLAUDE_CONFIG_DIR\" \"$ANTHROPIC_API_KEY\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cli = AgentCli::new().with_config(
            AgentId::Claude,
            AgentBinaryConfig {
                path: Some(path),
                ..Default::default()
            },
        );
        let run_on = |account: Option<AgentAccountRef>| {
            let cli = cli.clone();
            let cwd = dir.path().to_path_buf();
            async move {
                let req = AgentRequest {
                    agent: AgentId::Claude,
                    prompt: "p".into(),
                    system: None,
                    cwd,
                    mode: theodore_ports::AgentMode::ReadOnly,
                    mcp: None,
                    model: None,
                    effort: None,
                    stall_after_ms: 30_000,
                    env: vec![("ANTHROPIC_API_KEY".into(), "space-key".into())],
                    user_mcp: false,
                    attachments: vec![],
                    resume: None,
                    fork_session: false,
                    stream_text: false,
                    account,
                };
                let mut run = cli.run(req).await.unwrap();
                let mut last = None;
                while let Some(e) = run.events.recv().await {
                    last = Some(e);
                }
                match last {
                    Some(theodore_ports::AgentEvent::Done { final_text, .. }) => final_text,
                    other => panic!("{other:?}"),
                }
            }
        };
        let work = AgentAccountRef {
            id: "work".into(),
            dir: Some("/accounts/work".into()),
        };
        assert_eq!(run_on(Some(work)).await, "/accounts/work|");
        // The default account overrides nothing.
        let own = run_on(None).await;
        assert!(own.ends_with("|space-key"), "{own}");
        assert!(!own.starts_with("/accounts/"), "{own}");
    }

    #[tokio::test]
    async fn a_missing_codex_is_not_looked_for_again_on_every_call() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("codex");
        let cli = AgentCli::new().with_config(
            AgentId::Codex,
            AgentBinaryConfig {
                path: Some(path.clone()),
                ..Default::default()
            },
        );
        assert!(cli.models(AgentId::Codex).await.is_empty());

        // Installed now, but the "not installed" answer still stands.
        std::fs::write(
            &path,
            "#!/bin/sh\necho '{\"models\":[{\"slug\":\"m\",\"visibility\":\"list\"}]}'\n",
        )
        .unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(cli.models(AgentId::Codex).await.is_empty());
        let caches = cli.codex_models.lock().await;
        let cache = &caches[theodore_ports::DEFAULT_ACCOUNT];
        assert!(matches!(
            cache.failed,
            Some((_, CodexListError::NotInstalled))
        ));
    }
}
