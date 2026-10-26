//! Real adapters for the CLI: GitHub (token from the keychain, `gh` or
//! `GITHUB_TOKEN`), the git CLI under `~/.theodore`, and the agent CLIs.

use std::sync::Arc;

use anyhow::Context;
use theodore_domain::{PrRef, Revision};
use theodore_grouping::PrMeta;
use theodore_ports::{AgentPort, DiffOptions, Fetched, GitPort, HostAdapter, SystemClock};
use theodore_runtime::{BuildEnv, HostToken, RuntimeConfig};

pub struct Deps {
    pub git: Arc<dyn GitPort>,
    pub host: Arc<dyn HostAdapter>,
    pub agent: Arc<dyn AgentPort>,
}

pub fn real_deps() -> Deps {
    // The CLI carries no build env: it works on the production app's data
    // dir and keychain item, as it always has (`THEODORE_DATA_DIR` wins).
    let cfg = RuntimeConfig::from_env(BuildEnv::Production);
    let secrets = Arc::new(theodore_secrets::KeychainSecrets::with_service(
        theodore_runtime::identity::keychain_service(cfg.build_env),
    ));
    let token = Arc::new(HostToken::new(secrets));
    Deps {
        git: Arc::new(theodore_git::GitCli::new(cfg.data_dir, token.clone())),
        host: Arc::new(theodore_host_github::GithubAdapter::new(
            token,
            Arc::new(SystemClock),
        )),
        agent: Arc::new(theodore_agents::AgentCli::new()),
    }
}

/// Fetch a PR into its worktree and diff `merge-base...head`.
pub async fn load_pr(
    deps: &Deps,
    url: &str,
) -> anyhow::Result<(Revision, PrMeta, std::path::PathBuf)> {
    let pr: PrRef = theodore_app::parse_pr_ref(url)?;
    let detail = match deps
        .host
        .get_pr(&pr, None)
        .await
        .context("fetching the PR")?
    {
        Fetched::Modified { value, .. } => value,
        Fetched::NotModified => anyhow::bail!("host returned 304 without an ETag"),
    };
    let repo = deps.git.ensure_repo(&pr.repo).await.context("cloning")?;
    let head = deps
        .git
        .fetch_pr(&pr)
        .await
        .context("fetching the PR head")?;
    let wt = deps
        .git
        .worktree(&pr, &head)
        .await
        .context("creating the worktree")?;
    let base = deps.git.merge_base(&repo, &detail.base_sha, &head).await?;
    let rev = deps
        .git
        .diff(&repo, &base, &head, &DiffOptions::default())
        .await?;
    let meta = PrMeta {
        title: detail.summary.title.clone(),
        body: detail.body.clone(),
        commits: detail.commits.iter().map(|c| c.title.clone()).collect(),
    };
    Ok((rev, meta, wt.path))
}
