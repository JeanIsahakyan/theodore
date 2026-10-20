//! Sandbox mode (docs/sandbox.md): the real core, store and `GitCli`, but
//! the host is `theodore_sandbox::SandboxHost` and every git remote is one
//! of its local bare repos. No `GithubAdapter`, no keychain, no `gh`, no
//! token anywhere: secrets live in memory and git gets no credentials.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Context;
use theodore_contract::AddProjectRequest;
use theodore_domain::RepoRef;
use theodore_ports::{CredentialSource, GitPort, Store, SystemClock};
use theodore_sandbox::{AgentsMode, Sandbox, SeedProject};

use crate::{Adapters, Hosts, local_host};

/// `~/.theodore-sandbox`: the sandbox's own default data dir.
pub fn default_data_dir() -> PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".theodore-sandbox"))
        .unwrap_or_else(|| PathBuf::from(".theodore-sandbox"))
}

/// Refuses the real app's data dir (`~/.theodore`), however it's spelled.
pub(crate) fn guard_data_dir(data_dir: &Path) -> anyhow::Result<()> {
    match dirs::home_dir() {
        Some(home) => guard_against(data_dir, &home.join(".theodore")),
        None => Ok(()),
    }
}

fn guard_against(data_dir: &Path, real: &Path) -> anyhow::Result<()> {
    let canon = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    // Also refuse a dir *inside* it: the sandbox would still write there.
    if canon(data_dir).starts_with(canon(real)) {
        anyhow::bail!(
            "sandbox mode never uses {}; point THEODORE_DATA_DIR somewhere else",
            real.display()
        );
    }
    Ok(())
}

struct NoCredentials;

impl CredentialSource for NoCredentials {
    fn token_for(&self, _repo: &RepoRef) -> Option<String> {
        None
    }
}

struct SandboxToken;

impl theodore_app::TokenStatus for SandboxToken {
    fn source(&self) -> theodore_contract::TokenSource {
        theodore_contract::TokenSource::Sandbox
    }
    fn invalidate(&self) {}
}

pub(crate) fn adapters(data_dir: &Path, scenario: &Path) -> anyhow::Result<(Adapters, Sandbox)> {
    guard_data_dir(data_dir)?;
    std::fs::create_dir_all(data_dir)
        .with_context(|| format!("creating {}", data_dir.display()))?;
    let sandbox = Sandbox::open(scenario, data_dir)
        .with_context(|| format!("opening the sandbox scenario {}", scenario.display()))?;
    // The sandbox's repos are synthetic: the user's own commit hooks,
    // signing and aliases (~/.gitconfig) must not run against them.
    theodore_git::isolate_from_user_config();
    let git: Arc<dyn GitPort> = Arc::new(
        theodore_git::GitCli::new(data_dir.to_path_buf(), Arc::new(NoCredentials))
            .with_remote_urls(sandbox.remote_urls()),
    );
    let store: Arc<dyn Store> = Arc::new(
        theodore_store::SqliteStore::open(data_dir.join("theodore.db"))
            .context("opening the sandbox database")?,
    );
    let local = Arc::new(local_host::LocalHostAdapter::new(
        store.clone(),
        git.clone(),
    ));
    let host = Arc::new(Hosts::new(sandbox.host(), None, None, local));
    let agents: Arc<dyn theodore_ports::AgentPort> = match sandbox.agents() {
        AgentsMode::Real => {
            Arc::new(theodore_agents::AgentCli::new().with_pid_dir(data_dir.join("agents")))
        }
        AgentsMode::Replay => Arc::new(theodore_fixtures::SynthAgents::new()),
    };
    let adapters = Adapters {
        host,
        git,
        agents,
        store,
        secrets: Arc::new(theodore_secrets::MemorySecrets::new()),
        clock: Arc::new(SystemClock),
        triggers: None,
        fixture_clock: None,
        fixture_host: None,
        token_status: Some(Arc::new(SandboxToken)),
        device_login: Arc::new(theodore_ports::NoDeviceLogin),
    };
    Ok((adapters, sandbox))
}

/// Adds the scenario's projects on the sandbox's first start.
pub(crate) async fn seed_projects(core: &theodore_app::Core, sandbox: &Sandbox) {
    let seeds = sandbox.projects_to_seed();
    if seeds.is_empty() {
        return;
    }
    for seed in seeds {
        let req = match seed {
            SeedProject::Host(repo) => AddProjectRequest {
                repo: Some(repo),
                path: None,
            },
            SeedProject::Local(path) => AddProjectRequest {
                repo: None,
                path: Some(path.display().to_string()),
            },
        };
        if let Err(e) = core.add_project(req).await {
            tracing::warn!("sandbox: adding a project failed: {e}");
        }
    }
    sandbox.mark_projects_seeded();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_real_data_dir_is_refused_however_it_is_spelled() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join(".theodore");
        std::fs::create_dir_all(real.join("sub")).unwrap();
        assert!(guard_against(&real, &real).is_err());
        assert!(guard_against(&real.join("sub/.."), &real).is_err());
        assert!(guard_against(&real.join("sub"), &real).is_err());
        assert!(guard_against(&tmp.path().join(".theodore-sandbox"), &real).is_ok());
    }
}
