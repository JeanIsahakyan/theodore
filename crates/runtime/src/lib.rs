//! Composition root (plan §2.1): the only place that knows every adapter.
//! The desktop shell and the CLI both start the core through here.

mod grouper;
mod hosts;
mod local_host;
mod sandbox;
mod token;
mod tools;
mod worktree_gc;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use theodore_app::{Core, Deps, Receivers};
use theodore_ports::{
    AgentPort, Clock, DeviceLoginPort, GitPort, HostAdapter, Secrets, Store, SystemClock,
};

pub use grouper::GroupingGrouper;
pub use hosts::Hosts;
pub use local_host::LocalHostAdapter;
pub use token::HostToken;
pub use tools::{CoreTools, McpRunTools};
pub use worktree_gc::{WorktreeGuard, WorktreeLocks};

/// How often the worktree GC sweep runs (`worktree_gc::spawn_periodic`).
/// Worktrees are cheap to keep around for a while and expensive to GC too
/// eagerly (a PR that flips closed→reopened would otherwise reclone), so
/// this errs slow.
const WORKTREE_GC_INTERVAL: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    /// `~/.theodore` by default.
    pub data_dir: PathBuf,
    /// Run on fixture adapters from this directory instead of GitHub, git
    /// and real agents (dev and e2e, plan §12.1).
    pub fixtures: Option<PathBuf>,
    /// Run against the sandbox host built from this scenario directory
    /// (docs/sandbox.md): real git and agents, a simulated host.
    pub sandbox: Option<PathBuf>,
}

impl RuntimeConfig {
    pub fn from_env() -> Self {
        if let Some(dir) = std::env::var_os("THEODORE_SANDBOX") {
            return Self::sandbox(PathBuf::from(dir));
        }
        let data_dir = std::env::var_os("THEODORE_DATA_DIR")
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|h| h.join(".theodore")))
            .unwrap_or_else(|| PathBuf::from(".theodore"));
        let fixtures = std::env::var_os("THEODORE_FIXTURES").map(PathBuf::from);
        Self {
            data_dir,
            fixtures,
            sandbox: None,
        }
    }

    /// Sandbox mode on `scenario`: `THEODORE_DATA_DIR` or
    /// `~/.theodore-sandbox`, never `~/.theodore` (`start` refuses it).
    pub fn sandbox(scenario: PathBuf) -> Self {
        let data_dir = std::env::var_os("THEODORE_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(sandbox::default_data_dir);
        Self {
            data_dir,
            fixtures: None,
            sandbox: Some(scenario),
        }
    }
}

pub use sandbox::default_data_dir as sandbox_data_dir;

pub struct Runtime {
    pub core: Core,
    pub receivers: Receivers,
    pub mcp: Arc<McpRunTools>,
    /// Fixture triggers (author push, checks green, agent crash) in fixture mode.
    pub triggers: Option<theodore_fixtures::Triggers>,
    /// The controlled clock in fixture mode, so tests can advance it past the
    /// poller's due time deterministically (`None` on the real clock).
    pub fixture_clock: Option<theodore_fixtures::ManualClock>,
    /// The fixture host adapter in fixture mode, so tests can assert on the
    /// calls it received (`None` on the real host).
    pub fixture_host: Option<Arc<theodore_fixtures::FixtureHost>>,
    /// Holds a worktree open against the periodic GC sweep
    /// (`worktree_gc::spawn_periodic`, started here) for as long as an
    /// agent run or similar needs it alive, even past its PR closing.
    pub worktree_locks: Arc<WorktreeLocks>,
    /// The sandbox in sandbox mode (status, faults, events); its ticker is
    /// already running.
    pub sandbox: Option<theodore_sandbox::Sandbox>,
}

struct Adapters {
    host: Arc<dyn HostAdapter>,
    git: Arc<dyn GitPort>,
    agents: Arc<dyn AgentPort>,
    store: Arc<dyn Store>,
    secrets: Arc<dyn Secrets>,
    clock: Arc<dyn Clock>,
    triggers: Option<theodore_fixtures::Triggers>,
    fixture_clock: Option<theodore_fixtures::ManualClock>,
    fixture_host: Option<Arc<theodore_fixtures::FixtureHost>>,
    /// `None` in fixture mode: there's no keychain/`gh`/env token story to
    /// report (plan §6.8).
    token_status: Option<Arc<dyn theodore_app::TokenStatus>>,
    device_login: Arc<dyn DeviceLoginPort>,
    account: Arc<dyn theodore_ports::AccountPort>,
}

fn real_adapters(cfg: &RuntimeConfig) -> anyhow::Result<Adapters> {
    std::fs::create_dir_all(&cfg.data_dir)
        .with_context(|| format!("creating {}", cfg.data_dir.display()))?;
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let secrets: Arc<dyn Secrets> = Arc::new(theodore_secrets::KeychainSecrets::new());
    let token = Arc::new(HostToken::new(secrets.clone()));
    let github = Arc::new(theodore_host_github::GithubAdapter::new(
        token.clone(),
        clock.clone(),
    ));
    let gitlab = Arc::new(theodore_host_gitlab::GitlabAdapter::new(
        Arc::new(token::GitlabToken::new(secrets.clone())),
        clock.clone(),
    ));
    let bitbucket = Arc::new(theodore_host_bitbucket::BitbucketAdapter::new(
        Arc::new(token::BitbucketToken::new(secrets.clone())),
        clock.clone(),
    ));
    let git: Arc<dyn GitPort> = Arc::new(theodore_git::GitCli::new(
        cfg.data_dir.clone(),
        token.clone(),
    ));
    let store: Arc<dyn Store> = Arc::new(
        theodore_store::SqliteStore::open(cfg.data_dir.join("theodore.db"))
            .context("opening the database")?,
    );
    let local = Arc::new(local_host::LocalHostAdapter::new(
        store.clone(),
        git.clone(),
    ));
    let host = Arc::new(Hosts::new(github, Some(gitlab), Some(bitbucket), local));
    Ok(Adapters {
        host,
        git,
        agents: Arc::new(
            theodore_agents::AgentCli::new().with_pid_dir(cfg.data_dir.join("agents")),
        ),
        store,
        secrets,
        clock,
        triggers: None,
        fixture_clock: None,
        fixture_host: None,
        token_status: Some(token as Arc<dyn theodore_app::TokenStatus>),
        device_login: Arc::new(theodore_host_github::GithubDeviceLogin::new()),
        account: workos_account(),
    })
}

fn fixture_adapters(dir: &std::path::Path) -> anyhow::Result<Adapters> {
    let (host, git, agents, clock, triggers) = theodore_fixtures::FixtureSet::load(dir)
        .with_context(|| format!("loading fixtures from {}", dir.display()))?;
    let host = Arc::new(host);
    Ok(Adapters {
        host: host.clone(),
        git: Arc::new(git),
        agents: Arc::new(agents),
        store: Arc::new(theodore_store::SqliteStore::open_in_memory()?),
        secrets: Arc::new(theodore_secrets::MemorySecrets::new()),
        clock: Arc::new(clock.clone()),
        triggers: Some(triggers),
        fixture_clock: Some(clock),
        fixture_host: Some(host),
        token_status: None,
        device_login: Arc::new(theodore_ports::NoDeviceLogin),
        account: Arc::new(theodore_ports::LocalAccount),
    })
}

/// The Theodore account over WorkOS (plan "Theodore account"). Without a
/// client id configured the app hides the feature, so this is always
/// wired. `THEODORE_WORKOS_API_BASE` points it elsewhere (a staging proxy,
/// a mock); `THEODORE_WORKOS_ISSUER` accepts a custom auth domain's `iss`.
fn workos_account() -> Arc<dyn theodore_ports::AccountPort> {
    let base = std::env::var("THEODORE_WORKOS_API_BASE")
        .ok()
        .filter(|b| !b.trim().is_empty())
        .and_then(|b| {
            let b = if b.ends_with('/') { b } else { format!("{b}/") };
            url::Url::parse(&b).ok()
        });
    let mut account = match base {
        Some(b) => theodore_account_workos::WorkosAccount::with_api_base(b),
        None => theodore_account_workos::WorkosAccount::new(),
    };
    if let Ok(iss) = std::env::var("THEODORE_WORKOS_ISSUER")
        && !iss.trim().is_empty()
    {
        account = account.with_issuer(iss.trim());
    }
    Arc::new(account)
}

/// Build every adapter, start the MCP server and the core.
pub async fn start(cfg: &RuntimeConfig) -> anyhow::Result<Runtime> {
    let (a, sandbox) = match (&cfg.sandbox, &cfg.fixtures) {
        (Some(_), Some(_)) => {
            anyhow::bail!("THEODORE_SANDBOX and THEODORE_FIXTURES can't be combined")
        }
        (Some(scenario), None) => {
            let (a, sb) = sandbox::adapters(&cfg.data_dir, scenario)?;
            (a, Some(sb))
        }
        (None, Some(dir)) => (fixture_adapters(dir)?, None),
        (None, None) => (real_adapters(cfg)?, None),
    };
    let backend = Arc::new(CoreTools::default());
    let mcp = Arc::new(McpRunTools::start(backend.clone(), backend.clone()).await?);
    let claude_home = dirs::home_dir()
        .map(|h| h.join(".claude/skills"))
        .unwrap_or_else(|| PathBuf::from(".claude/skills"));

    let worktree_locks = WorktreeLocks::new();
    let deps = Deps {
        host: a.host,
        git: a.git.clone(),
        grouper: Arc::new(GroupingGrouper::new(a.agents.clone())),
        agents: a.agents,
        store: a.store.clone(),
        secrets: a.secrets,
        clock: a.clock,
        tools: Some(mcp.clone()),
        token_status: a.token_status,
        device_login: a.device_login,
        account: a.account,
        claude_home,
        commands: Arc::new(theodore_agents::ShellRunner::new()),
        data_dir: cfg.data_dir.clone(),
        worktree_lease: Arc::new(worktree_gc::WorktreeLeaseAdapter::new(
            worktree_locks.clone(),
        )),
    };
    let (core, receivers) = Core::start(deps);
    backend.attach(core.clone());
    core.ensure_default_settings().await?;

    // Detached on purpose: there's no runtime-wide shutdown signal to tie
    // this to yet (the mcp server above is the same), and a 30-minute
    // interval harmlessly outlives a short-lived process (tests, `theodore
    // group`) before ever firing.
    worktree_gc::spawn_periodic(
        a.git,
        a.store,
        worktree_locks.clone(),
        core.clone(),
        WORKTREE_GC_INTERVAL,
    );

    if let Some(sb) = &sandbox {
        sb.spawn();
        sandbox::seed_projects(&core, sb).await;
    }

    Ok(Runtime {
        core,
        receivers,
        mcp,
        triggers: a.triggers,
        fixture_clock: a.fixture_clock,
        fixture_host: a.fixture_host,
        worktree_locks,
        sandbox,
    })
}
