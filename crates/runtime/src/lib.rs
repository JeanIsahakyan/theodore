//! Composition root (plan §2.1): the only place that knows every adapter.
//! The desktop shell and the CLI both start the core through here.

mod grouper;
mod token;
mod tools;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use theodore_app::{Core, Deps, Receivers};
use theodore_ports::{AgentPort, Clock, GitPort, HostAdapter, Secrets, Store, SystemClock};

pub use grouper::GroupingGrouper;
pub use token::HostToken;
pub use tools::{CoreTools, McpRunTools};

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    /// `~/.theodore` by default.
    pub data_dir: PathBuf,
    /// Run on fixture adapters from this directory instead of GitHub, git
    /// and real agents (dev and e2e, plan §12.1).
    pub fixtures: Option<PathBuf>,
}

impl RuntimeConfig {
    pub fn from_env() -> Self {
        let data_dir = std::env::var_os("THEODORE_DATA_DIR")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|h| h.join(".theodore")))
            .unwrap_or_else(|| PathBuf::from(".theodore"));
        let fixtures = std::env::var_os("THEODORE_FIXTURES").map(PathBuf::from);
        Self { data_dir, fixtures }
    }
}

pub struct Runtime {
    pub core: Core,
    pub receivers: Receivers,
    pub mcp: Arc<McpRunTools>,
    /// Fixture triggers (author push, checks green, agent crash) in fixture mode.
    pub triggers: Option<theodore_fixtures::Triggers>,
}

struct Adapters {
    host: Arc<dyn HostAdapter>,
    git: Arc<dyn GitPort>,
    agents: Arc<dyn AgentPort>,
    store: Arc<dyn Store>,
    secrets: Arc<dyn Secrets>,
    clock: Arc<dyn Clock>,
    triggers: Option<theodore_fixtures::Triggers>,
    /// `None` in fixture mode: there's no keychain/`gh`/env token story to
    /// report (plan §6.8).
    token_status: Option<Arc<dyn theodore_app::TokenStatus>>,
}

fn real_adapters(cfg: &RuntimeConfig) -> anyhow::Result<Adapters> {
    std::fs::create_dir_all(&cfg.data_dir)
        .with_context(|| format!("creating {}", cfg.data_dir.display()))?;
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let secrets: Arc<dyn Secrets> = Arc::new(theodore_secrets::KeychainSecrets::new());
    let token = Arc::new(HostToken::new(secrets.clone()));
    let host = Arc::new(theodore_host_github::GithubAdapter::new(
        token.clone(),
        clock.clone(),
    ));
    let git = Arc::new(theodore_git::GitCli::new(
        cfg.data_dir.clone(),
        token.clone(),
    ));
    let store = Arc::new(
        theodore_store::SqliteStore::open(cfg.data_dir.join("theodore.db"))
            .context("opening the database")?,
    );
    Ok(Adapters {
        host,
        git,
        agents: Arc::new(theodore_agents::AgentCli::new()),
        store,
        secrets,
        clock,
        triggers: None,
        token_status: Some(token as Arc<dyn theodore_app::TokenStatus>),
    })
}

fn fixture_adapters(dir: &std::path::Path) -> anyhow::Result<Adapters> {
    let (host, git, agents, clock, triggers) = theodore_fixtures::FixtureSet::load(dir)
        .with_context(|| format!("loading fixtures from {}", dir.display()))?;
    Ok(Adapters {
        host: Arc::new(host),
        git: Arc::new(git),
        agents: Arc::new(agents),
        store: Arc::new(theodore_store::SqliteStore::open_in_memory()?),
        secrets: Arc::new(theodore_secrets::MemorySecrets::new()),
        clock: Arc::new(clock),
        triggers: Some(triggers),
        token_status: None,
    })
}

/// Build every adapter, start the MCP server and the core.
pub async fn start(cfg: &RuntimeConfig) -> anyhow::Result<Runtime> {
    let a = match &cfg.fixtures {
        Some(dir) => fixture_adapters(dir)?,
        None => real_adapters(cfg)?,
    };
    let backend = Arc::new(CoreTools::default());
    let mcp = Arc::new(McpRunTools::start(backend.clone()).await?);
    let deps = Deps {
        host: a.host,
        git: a.git,
        grouper: Arc::new(GroupingGrouper::new(a.agents.clone())),
        agents: a.agents,
        store: a.store,
        secrets: a.secrets,
        clock: a.clock,
        tools: Some(mcp.clone()),
        token_status: a.token_status,
    };
    let (core, receivers) = Core::start(deps);
    backend.attach(core.clone());
    core.ensure_default_settings().await?;
    Ok(Runtime {
        core,
        receivers,
        mcp,
        triggers: a.triggers,
    })
}
