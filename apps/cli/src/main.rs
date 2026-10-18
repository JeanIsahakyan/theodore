//! `theodore` CLI: grouping eval and debugging (docs/plan.md §5.4).

use clap::{Parser, Subcommand};
use theodore_cli::{deps, eval, group, mcp_bridge};
use theodore_domain::AgentId;

#[derive(Parser)]
#[command(name = "theodore", version, about = "Theodore: AI-grouped PR review")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Group a PR's diff into reviewable steps.
    Group(group::GroupArgs),
    /// Replay saved PR fixtures through the grouping pipeline.
    Eval(eval::EvalArgs),
    /// stdio↔HTTP bridge for agent CLIs without HTTP MCP.
    McpBridge(mcp_bridge::McpBridgeArgs),
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Group(args) => run_group(args).await,
        Command::Eval(args) => run_eval(args).await,
        Command::McpBridge(args) => mcp_bridge::run(&args).await,
    }
}

async fn run_group(args: group::GroupArgs) -> anyhow::Result<()> {
    let deps = deps::real_deps();
    let (rev, pr, cwd) = match &args.pr_url {
        Some(url) if args.diff_file.is_none() => deps::load_pr(&deps, url).await?,
        _ => group::load_input(&args)?,
    };
    let agent_id: AgentId = args.agent.into();
    let report = group::run_with_model(
        deps.agent.as_ref(),
        agent_id,
        args.model.clone(),
        &pr,
        &rev,
        &cwd,
    )
    .await?;
    if let Some(path) = &args.save_fixture {
        let meta = group::FixtureMeta {
            title: pr.title.clone(),
            body: pr.body.clone(),
            commits: pr.commits.clone(),
        };
        group::save_fixture(path, &meta, &rev)?;
        eprintln!("saved fixture to {}", path.display());
    }
    group::emit(&report, &rev, args.json, args.save.as_deref())
}

async fn run_eval(args: eval::EvalArgs) -> anyhow::Result<()> {
    let fixtures = eval::load_fixtures(&args.fixtures_dir)?;
    let agent_id: AgentId = args.agent.into();
    let deps = deps::real_deps();
    let cwd = std::env::current_dir()?;
    let rows = eval::run_eval_with_model(
        deps.agent.as_ref(),
        agent_id,
        args.model.clone(),
        &fixtures,
        &cwd,
    )
    .await;
    let summary = eval::print_table(&rows);
    if !summary.meets_targets() {
        anyhow::bail!(
            "grouping quality regressed below the §5.4 M1 targets \
             (first try {:.0}% < {:.0}%, or after repair {:.0}% < {:.0}%)",
            summary.first_try_pct(),
            eval::TARGET_FIRST_TRY_PCT,
            summary.after_repair_pct(),
            eval::TARGET_AFTER_REPAIR_PCT,
        );
    }
    Ok(())
}
