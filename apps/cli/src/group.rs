//! `theodore group`: run the grouping pipeline on a diff file (or, once the
//! git/GitHub adapters exist, a PR url) and print or save the result.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use clap::ValueEnum;
use theodore_domain::{AgentId, Revision};
use theodore_grouping::{GroupingOptions, GroupingReport, PrMeta, group_revision};
use theodore_ports::AgentPort;

use crate::difffile;

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum AgentChoice {
    Claude,
    Codex,
    Gemini,
}

impl From<AgentChoice> for AgentId {
    fn from(c: AgentChoice) -> AgentId {
        match c {
            AgentChoice::Claude => AgentId::Claude,
            AgentChoice::Codex => AgentId::Codex,
            AgentChoice::Gemini => AgentId::Gemini,
        }
    }
}

#[derive(Debug, Clone, clap::Args)]
pub struct GroupArgs {
    /// PR URL, e.g. https://github.com/owner/repo/pull/123. Needs the git +
    /// GitHub adapters (not wired yet, see `deps::real_deps`) — use
    /// `--diff-file` until then.
    pub pr_url: Option<String>,
    /// A unified diff file: `git diff --no-color --find-renames -U3 base...head > f.patch`.
    #[arg(long)]
    pub diff_file: Option<PathBuf>,
    #[arg(long, value_enum, default_value = "claude")]
    pub agent: AgentChoice,
    #[arg(long)]
    pub json: bool,
    /// Save the resulting grouping as JSON under this directory.
    #[arg(long)]
    pub save: Option<PathBuf>,
}

/// Load the revision and PR metadata for `args`, with no `AgentPort` needed.
pub fn load_input(args: &GroupArgs) -> Result<(Revision, PrMeta, PathBuf)> {
    if let Some(path) = &args.diff_file {
        let rev = difffile::read_file(path)?;
        let cwd = path
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        Ok((rev, PrMeta::default(), cwd))
    } else if args.pr_url.is_some() {
        anyhow::bail!(
            "grouping from a PR url needs the git/GitHub adapters, which are \
             not wired yet (apps/cli/src/deps.rs); use --diff-file for now"
        )
    } else {
        anyhow::bail!("provide a PR url or --diff-file <path>")
    }
}

/// Run the grouping pipeline against already-loaded input. This is the
/// testable core: callers inject any `AgentPort`, fake or real, so it never
/// needs `deps::real_deps`.
pub async fn run(
    agent: &dyn AgentPort,
    agent_id: AgentId,
    pr: &PrMeta,
    rev: &Revision,
    cwd: &Path,
) -> Result<GroupingReport> {
    let opts = GroupingOptions {
        agent: agent_id,
        ..Default::default()
    };
    group_revision(agent, pr, rev, cwd, &opts)
        .await
        .context("grouping pipeline")
}

/// Print the result (JSON or a short human summary) and, if `save` is set,
/// write the grouping JSON into that directory.
pub fn emit(
    report: &GroupingReport,
    rev: &Revision,
    json: bool,
    save: Option<&Path>,
) -> Result<()> {
    if let Some(dir) = save {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(format!("{}.json", rev.head));
        std::fs::write(&path, serde_json::to_vec_pretty(&report.grouping)?)?;
        eprintln!("saved grouping to {}", path.display());
    }
    if json {
        println!("{}", serde_json::to_string_pretty(&report.grouping)?);
    } else {
        print_summary(report);
    }
    Ok(())
}

fn print_summary(report: &GroupingReport) {
    println!(
        "{} groups · attempts {} · {} · {:.3}s · ${:.4}",
        report.grouping.groups.len(),
        report.attempts,
        if report.valid_first_try {
            "valid first try"
        } else {
            "needed repair"
        },
        report.duration_ms as f64 / 1000.0,
        report.usage.usd,
    );
    for (i, g) in report.grouping.groups.iter().enumerate() {
        println!(
            "{:>2}. [{:?}] {} ({} hunks)",
            i + 1,
            g.kind,
            g.title,
            g.hunks.len()
        );
        if !g.why.is_empty() {
            println!("    {}", g.why);
        }
        if let Some(risk) = &g.risk {
            println!("    risk: {risk}");
        }
    }
}
