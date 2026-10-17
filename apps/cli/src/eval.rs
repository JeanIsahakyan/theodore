//! `theodore eval`: replay saved PRs (fixture = revision JSON + PR meta)
//! through the grouping pipeline and print a quality/cost table.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Deserialize;
use theodore_domain::{AgentId, Revision, grouping};
use theodore_grouping::{GroupingOptions, PrMeta, group_revision};
use theodore_ports::AgentPort;

#[derive(Debug, Clone, Deserialize, Default)]
pub struct FixturePr {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub commits: Vec<String>,
}

impl From<FixturePr> for PrMeta {
    fn from(p: FixturePr) -> PrMeta {
        PrMeta {
            title: p.title,
            body: p.body,
            commits: p.commits,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Fixture {
    #[serde(default)]
    pub pr: FixturePr,
    pub revision: Revision,
}

#[derive(Debug, Clone, clap::Args)]
pub struct EvalArgs {
    /// Directory of `*.json` fixtures (see apps/cli/fixtures/).
    pub fixtures_dir: PathBuf,
    #[arg(long, value_enum, default_value = "claude")]
    pub agent: crate::group::AgentChoice,
}

/// Load every `*.json` fixture in `dir`, sorted by file name.
pub fn load_fixtures(dir: &Path) -> Result<Vec<(String, Fixture)>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).with_context(|| format!("reading {}", dir.display()))? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let text = std::fs::read_to_string(&path)?;
        let fixture: Fixture = serde_json::from_str(&text)
            .with_context(|| format!("parsing fixture {}", path.display()))?;
        let name = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        out.push((name, fixture));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    if out.is_empty() {
        anyhow::bail!("no *.json fixtures found in {}", dir.display());
    }
    Ok(out)
}

#[derive(Debug, Clone)]
pub struct EvalRow {
    pub name: String,
    pub valid_first_try: bool,
    pub valid_after_repair: bool,
    pub latency_ms: u64,
    pub usd: f64,
    pub groups: usize,
    pub error: Option<String>,
}

/// Run every fixture through the pipeline. Never fails outright — a single
/// fixture's agent error is recorded as a row, not a process failure.
pub async fn run_eval(
    agent: &dyn AgentPort,
    agent_id: AgentId,
    fixtures: &[(String, Fixture)],
    cwd: &Path,
) -> Vec<EvalRow> {
    let mut rows = Vec::with_capacity(fixtures.len());
    for (name, fx) in fixtures {
        let pr: PrMeta = fx.pr.clone().into();
        let opts = GroupingOptions {
            agent: agent_id,
            ..Default::default()
        };
        match group_revision(agent, &pr, &fx.revision, cwd, &opts).await {
            Ok(report) => {
                let valid_after_repair = grouping::validate(&fx.revision, &report.grouping).is_ok();
                rows.push(EvalRow {
                    name: name.clone(),
                    valid_first_try: report.valid_first_try,
                    valid_after_repair,
                    latency_ms: report.duration_ms,
                    usd: report.usage.usd,
                    groups: report.grouping.groups.len(),
                    error: None,
                });
            }
            Err(e) => rows.push(EvalRow {
                name: name.clone(),
                valid_first_try: false,
                valid_after_repair: false,
                latency_ms: 0,
                usd: 0.0,
                groups: 0,
                error: Some(e.to_string()),
            }),
        }
    }
    rows
}

pub fn print_table(rows: &[EvalRow]) {
    println!(
        "{:<20} {:>9} {:>10} {:>10} {:>8} {:>7}",
        "fixture", "1st-try", "repaired", "latency", "cost", "groups"
    );
    for r in rows {
        if let Some(err) = &r.error {
            println!("{:<20} ERROR: {err}", r.name);
            continue;
        }
        println!(
            "{:<20} {:>9} {:>10} {:>8}ms {:>7.4} {:>7}",
            r.name,
            if r.valid_first_try { "yes" } else { "no" },
            if r.valid_after_repair { "yes" } else { "no" },
            r.latency_ms,
            r.usd,
            r.groups,
        );
    }
    let total = rows.len().max(1);
    let first_try = rows.iter().filter(|r| r.valid_first_try).count();
    let repaired = rows.iter().filter(|r| r.valid_after_repair).count();
    println!(
        "\n{first_try}/{total} valid first try ({:.0}%), {repaired}/{total} valid after repair ({:.0}%)",
        100.0 * first_try as f64 / total as f64,
        100.0 * repaired as f64 / total as f64,
    );
}
