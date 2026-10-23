//! Orchestration (plan §5.1): pre-pass → relatedness graph → prompt →
//! agent → validate → one repair call → `repair_with_other` fallback.
//! Large PRs run one chunk per group of related files, then a merge pass
//! over the group summaries.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Instant;

use futures::stream::{self, StreamExt, TryStreamExt};
use theodore_domain::grouping::{self, GroupingError, RepoContext};
use theodore_domain::{AgentId, Group, GroupId, Grouping, Hunk, HunkId, Revision, Usage};
use theodore_ports::{AgentEvent, AgentMode, AgentPort, AgentRequest};

use crate::coarsen;
use crate::graph::RelGraph;
use crate::prepass::{self, HiddenReason, PrePass};
use crate::prompt::{self, PromptBudget, PromptPart};
use crate::schema;
use crate::target;

/// Chunk prompts run concurrently, capped at this many in flight at once —
/// enough to cut wall time on a large, multi-directory PR without hammering
/// the agent CLI with dozens of simultaneous processes.
const DEFAULT_CHUNK_CONCURRENCY: usize = 3;

/// Everything the prompt needs about the PR beyond the diff itself. Empty
/// when grouping a bare diff file with no host context.
#[derive(Debug, Clone, Default)]
pub struct PrMeta {
    pub title: String,
    pub body: String,
    /// Commit titles, oldest first.
    pub commits: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct GroupingOptions {
    pub agent: AgentId,
    /// Overrides the agent CLI's own default model (e.g. `"sonnet"`,
    /// `"haiku"`) — forwarded to `AgentRequest::model`. `None` keeps
    /// whatever the agent CLI defaults to.
    pub model: Option<String>,
    pub budget: PromptBudget,
    /// Forwarded to `AgentRequest::stall_after_ms`.
    pub stall_after_ms: u64,
    /// Max number of chunk prompts run concurrently, for large PRs split
    /// into several per-directory prompts (plan §5.2).
    pub chunk_concurrency: usize,
}

impl Default for GroupingOptions {
    fn default() -> Self {
        Self {
            agent: AgentId::Claude,
            model: None,
            budget: PromptBudget::default(),
            stall_after_ms: 90_000,
            chunk_concurrency: DEFAULT_CHUNK_CONCURRENCY,
        }
    }
}

#[derive(Debug, Clone)]
pub struct GroupingReport {
    pub grouping: Grouping,
    /// Total agent calls made (initial + repairs + merge pass).
    pub attempts: u32,
    /// No repair and no "Other" fallback was needed anywhere.
    pub valid_first_try: bool,
    pub usage: Usage,
    pub duration_ms: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum GroupingPipelineError {
    #[error("agent: {0}")]
    Agent(#[from] theodore_ports::AgentError),
    #[error("agent run ended without Done or Error")]
    NoDone,
    #[error("agent run failed: {0}")]
    AgentRun(String),
    /// `theodore_domain::interdiff::hunk_id` identifies a hunk by `(path,
    /// normalized added/deleted line text)` — deliberately not by line
    /// position, so the id survives context shifts across pushes (plan §4).
    /// That means two *different* physical hunks in the same file collide
    /// to one `HunkId` whenever a PR repeats a mechanically-identical
    /// one-line edit more than once in it — seen on real PRs (tokio#8587,
    /// rust-analyzer#23173: the same find/replace line applied at several
    /// call sites in one file). `grouping::validate`'s known-id set is a
    /// `BTreeSet<&HunkId>`, so it can't tell those apart either: without
    /// this check it would report "valid" while silently dropping every
    /// occurrence but one from the grouping. Caught here instead, before
    /// any agent call, rather than producing that misleadingly "valid"
    /// result.
    #[error(
        "revision has {} hunk id(s) shared by more than one physical hunk — \
         a mechanically-identical edit repeated in one file, which the \
         (path, content) hunk id can't distinguish (not a grouping bug): {}",
        .0.len(),
        display_ids(.0)
    )]
    DuplicateHunkIds(Vec<HunkId>),
}

fn display_ids(ids: &[HunkId]) -> String {
    ids.iter()
        .map(HunkId::as_str)
        .collect::<Vec<_>>()
        .join(", ")
}

/// Hunk ids that label more than one physical hunk in `rev`. Should always
/// be empty — `HunkId` is meant to be unique per physical hunk — but nothing
/// upstream of this pipeline currently guarantees it.
fn duplicate_hunk_ids(rev: &Revision) -> Vec<HunkId> {
    let mut counts: BTreeMap<&HunkId, u32> = BTreeMap::new();
    for h in rev.hunks() {
        *counts.entry(&h.id).or_default() += 1;
    }
    counts
        .into_iter()
        .filter(|(_, n)| *n > 1)
        .map(|(id, _)| id.clone())
        .collect()
}

/// Run the full grouping pipeline against one revision, from the diff alone.
pub async fn group_revision(
    agent: &dyn AgentPort,
    pr: &PrMeta,
    rev: &Revision,
    cwd: &Path,
    opts: &GroupingOptions,
) -> Result<GroupingReport, GroupingPipelineError> {
    group_revision_with(agent, pr, rev, &RepoContext::default(), cwd, opts).await
}

/// Run the full grouping pipeline against one revision, with whatever
/// repository context the caller has (head file contents, co-change
/// history) to sharpen the relatedness graph.
pub async fn group_revision_with(
    agent: &dyn AgentPort,
    pr: &PrMeta,
    rev: &Revision,
    ctx: &RepoContext,
    cwd: &Path,
    opts: &GroupingOptions,
) -> Result<GroupingReport, GroupingPipelineError> {
    let start = Instant::now();
    let dupes = duplicate_hunk_ids(rev);
    if !dupes.is_empty() {
        return Err(GroupingPipelineError::DuplicateHunkIds(dupes));
    }
    let prepass = prepass::run_with(rev, &ctx.review);
    let graph = RelGraph::build(rev, &prepass, ctx);
    let note = ctx.review.system_note();
    let note = note.as_deref();
    let chunks = prompt::build_prompts_with(pr, rev, &prepass, &graph, ctx, &opts.budget);
    let total_visible_hunks: usize = chunks.iter().map(|c| c.hunk_ids.len()).sum();

    // Run every chunk's agent call concurrently, capped at
    // `chunk_concurrency` in flight — `buffered` polls up to that many
    // futures at once but still yields results in the original chunk
    // order, so the rest of this function doesn't need to know it ran
    // concurrently at all. Chunks are consumed by value (not borrowed) so
    // each future owns its own data instead of tying its type to a
    // borrowed-iterator-item lifetime, which `rustc` otherwise rejects once
    // this `async fn` is itself boxed by a caller (`#[async_trait]` in
    // `crates/runtime`).
    let concurrency = opts.chunk_concurrency.max(1);
    let results: Vec<(Grouping, u32, bool, Usage)> =
        stream::iter(chunks.into_iter().map(|chunk| {
            let sub_rev = sub_revision(rev, &chunk.hunk_ids);
            async move { run_chunk(agent, opts, cwd, note, &sub_rev, &chunk.prompt).await }
        }))
        .buffered(concurrency)
        .try_collect()
        .await?;

    let mut usage = Usage::default();
    let mut attempts: u32 = 0;
    let mut any_repair = false;
    let mut chunk_groupings: Vec<Grouping> = Vec::with_capacity(results.len());
    for (grouping, att, repaired, u) in results {
        usage += u;
        attempts += att;
        any_repair |= repaired;
        chunk_groupings.push(grouping);
    }

    let mut groups: Vec<Group> = hidden_groups(&prepass, rev);
    let has_hidden_group = !groups.is_empty();

    if chunk_groupings.len() <= 1 {
        if let Some(g) = chunk_groupings.into_iter().next() {
            groups.extend(g.groups);
        }
    } else {
        let all: Vec<Group> = chunk_groupings.into_iter().flat_map(|g| g.groups).collect();
        attempts += 1;
        match merge_pass(agent, opts, cwd, note, pr, &all).await {
            Some(order) => {
                let mut by_id: BTreeMap<GroupId, Group> =
                    all.into_iter().map(|g| (g.id.clone(), g)).collect();
                for id in order {
                    if let Some(g) = by_id.remove(&id) {
                        groups.push(g);
                    }
                }
                groups.extend(by_id.into_values());
            }
            None => {
                any_repair = true;
                groups.extend(all);
            }
        }
    }

    // Coarser-groups goal: if the model (across however many chunks) still
    // produced more groups than this PR's size warrants, deterministically
    // merge the tiniest ones into their most related same-kind group. Free
    // (no agent call) and exact — it only moves hunks between groups that
    // already exist, so it can't break the partition invariant checked
    // just below.
    let (_, target_hi) = target::target_group_count(total_visible_hunks);
    let target_max = target_hi + usize::from(has_hidden_group);
    if groups.len() > target_max {
        groups = coarsen::merge_tiny_groups(rev, groups, target_max, &graph);
    }

    let grouping = Grouping {
        rev: rev.head.clone(),
        groups,
    };
    let (grouping, attempts) = match grouping::validate(rev, &grouping) {
        Ok(()) => (grouping, attempts),
        Err(_) => {
            any_repair = true;
            (grouping::repair_with_other(rev, grouping), attempts + 1)
        }
    };

    Ok(GroupingReport {
        grouping,
        attempts: attempts.max(1),
        valid_first_try: !any_repair,
        usage,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

/// A view of `rev` restricted to the given hunk ids, for per-chunk validation.
fn sub_revision(rev: &Revision, ids: &[HunkId]) -> Revision {
    let wanted: std::collections::BTreeSet<&HunkId> = ids.iter().collect();
    let files = rev
        .files
        .iter()
        .filter_map(|f| {
            let hunks: Vec<Hunk> = f
                .hunks
                .iter()
                .filter(|h| wanted.contains(&h.id))
                .cloned()
                .collect();
            if hunks.is_empty() {
                None
            } else {
                let mut f = f.clone();
                f.hunks = hunks;
                Some(f)
            }
        })
        .collect();
    Revision {
        base: rev.base.clone(),
        head: rev.head.clone(),
        files,
    }
}

fn hidden_groups(prepass: &PrePass, rev: &Revision) -> Vec<Group> {
    if prepass.hidden.is_empty() {
        return vec![];
    }
    let hunks: Vec<HunkId> = rev
        .files
        .iter()
        .filter(|f| prepass.is_hidden(&f.path))
        .flat_map(|f| f.hunks.iter().map(|h| h.id.clone()))
        .collect();
    if hunks.is_empty() {
        return vec![];
    }
    let mut reasons: Vec<&str> = prepass.hidden.values().map(HiddenReason::label).collect();
    reasons.sort_unstable();
    reasons.dedup();
    vec![Group {
        id: GroupId::new("hidden"),
        title: if reasons.iter().all(|r| *r == HiddenReason::Config.label()) {
            "Hidden by the repo's config".into()
        } else {
            "Lockfiles, generated and vendored files".into()
        },
        why: format!("Not reviewed in detail: {}.", reasons.join(", ")),
        kind: theodore_domain::GroupKind::Hidden,
        risk: None,
        check: vec![],
        hunks,
        outliers: vec![],
    }]
}

/// Run one chunk: initial call, one repair call on validation failure, then
/// `repair_with_other` as the final safety net.
async fn run_chunk(
    agent: &dyn AgentPort,
    opts: &GroupingOptions,
    cwd: &Path,
    note: Option<&str>,
    sub_rev: &Revision,
    prompt: &PromptPart,
) -> Result<(Grouping, u32, bool, Usage), GroupingPipelineError> {
    let mut usage = Usage::default();
    let (text, u) = call_agent(agent, opts, cwd, note, &prompt.system, &prompt.user).await?;
    usage += u;
    let grouping = schema::parse_grouping(&text, sub_rev.head.clone());

    let errors = match grouping::validate(sub_rev, &grouping) {
        Ok(()) => return Ok((grouping, 1, false, usage)),
        Err(errors) => errors,
    };
    debug_log_validation_failure(&errors, &text);
    let known: Vec<HunkId> = sub_rev.hunks().map(|h| h.id.clone()).collect();
    let repair = prompt::repair_prompt(&known, &text, &display_errors(&errors));
    let (text2, u2) = call_agent(agent, opts, cwd, note, &repair.system, &repair.user).await?;
    usage += u2;
    let grouping2 = schema::parse_grouping(&text2, sub_rev.head.clone());

    match grouping::validate(sub_rev, &grouping2) {
        Ok(()) => Ok((grouping2, 2, true, usage)),
        Err(_) => Ok((
            grouping::repair_with_other(sub_rev, grouping2),
            2,
            true,
            usage,
        )),
    }
}

fn display_errors(errors: &[GroupingError]) -> Vec<String> {
    errors.iter().map(|e| e.to_string()).collect()
}

/// Opt-in diagnostic for why a first attempt needed repair (set
/// `THEODORE_GROUPING_DEBUG=1`). Off by default: never fires in tests or
/// normal runs, so it adds no noise and no dependency on a logging crate.
fn debug_log_validation_failure(errors: &[GroupingError], raw_response: &str) {
    if std::env::var_os("THEODORE_GROUPING_DEBUG").is_none() {
        return;
    }
    eprintln!("[grouping] first attempt failed validation:");
    for e in errors {
        eprintln!("  - {e}");
    }
    eprintln!("[grouping] raw response:\n{raw_response}");
}

/// Ask the agent for the final reading order across chunk group summaries.
/// Returns `None` on any failure (agent error, unparseable, incomplete) —
/// the caller falls back to the chunks' natural order, which is still a
/// valid (if less polished) grouping.
async fn merge_pass(
    agent: &dyn AgentPort,
    opts: &GroupingOptions,
    cwd: &Path,
    note: Option<&str>,
    pr: &PrMeta,
    groups: &[Group],
) -> Option<Vec<GroupId>> {
    let prompt = prompt::merge_prompt(pr, groups);
    let (text, _usage) = call_agent(agent, opts, cwd, note, &prompt.system, &prompt.user)
        .await
        .ok()?;
    let value = crate::parse::extract_json(&text)?;
    let raw: prompt::RawOrder = serde_json::from_value(value).ok()?;
    let order = raw.into_ids();
    let known: std::collections::BTreeSet<&GroupId> = groups.iter().map(|g| &g.id).collect();
    if order.len() != known.len() || !order.iter().all(|id| known.contains(id)) {
        return None;
    }
    Some(order)
}

/// One agent call; `note` (the repo's review config,
/// `ReviewRules::system_note`) is appended to the system prompt.
pub(crate) async fn call_agent(
    agent: &dyn AgentPort,
    opts: &GroupingOptions,
    cwd: &Path,
    note: Option<&str>,
    system: &str,
    prompt: &str,
) -> Result<(String, Usage), GroupingPipelineError> {
    let system = match note {
        Some(note) => format!("{system}\n\n{note}"),
        None => system.to_string(),
    };
    let req = AgentRequest {
        agent: opts.agent,
        prompt: prompt.to_string(),
        system: Some(system),
        cwd: cwd.to_path_buf(),
        mode: AgentMode::ReadOnly,
        mcp: None,
        model: opts.model.clone(),
        stall_after_ms: opts.stall_after_ms,
        env: Vec::new(),
    };
    let mut run = agent.run(req).await?;
    let mut usage = Usage::default();
    loop {
        match run.events.recv().await {
            Some(AgentEvent::Usage { usage: u }) => usage += u,
            Some(AgentEvent::Done {
                final_text,
                usage: u,
            }) => {
                usage += u;
                return Ok((final_text, usage));
            }
            Some(AgentEvent::Error {
                message,
                stderr_tail,
            }) => {
                return Err(GroupingPipelineError::AgentRun(format!(
                    "{message}: {stderr_tail}"
                )));
            }
            Some(_) => continue,
            None => return Err(GroupingPipelineError::NoDone),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::FakeAgentPort;
    use theodore_domain::{DiffLine, FileDiff, FileStatus, LineKind, Sha};

    fn line(kind: LineKind, text: &str) -> DiffLine {
        DiffLine {
            kind,
            text: text.into(),
            old_no: None,
            new_no: None,
        }
    }

    fn mk_hunk(id: &str) -> Hunk {
        Hunk {
            id: HunkId::new(id),
            path: String::new(),
            old_start: 1,
            old_lines: 1,
            new_start: 1,
            new_lines: 1,
            header: String::new(),
            lines: vec![line(LineKind::Add, "x")],
        }
    }

    fn small_revision() -> Revision {
        Revision {
            base: Sha::new("base"),
            head: Sha::new("head"),
            files: vec![FileDiff {
                path: "src/a.ts".into(),
                old_path: None,
                status: FileStatus::Modified,
                similarity: None,
                old_mode: None,
                new_mode: None,
                flags: vec![],
                additions: 2,
                deletions: 0,
                hunks: vec![mk_hunk("h1"), mk_hunk("h2")],
            }],
        }
    }

    fn valid_json() -> &'static str {
        r#"{"groups": [{"id": "g1", "title": "Change", "why": "does a thing",
            "kind": "normal", "check": [], "hunks": ["h1", "h2"], "outliers": []}]}"#
    }

    fn file(path: &str, hunks: Vec<Hunk>) -> FileDiff {
        FileDiff {
            path: path.into(),
            old_path: None,
            status: FileStatus::Modified,
            similarity: None,
            old_mode: None,
            new_mode: None,
            flags: vec![],
            additions: 1,
            deletions: 0,
            hunks,
        }
    }

    /// Regression: two real PRs (tokio#8587, rust-analyzer#23173) each
    /// repeat a mechanically-identical one-line edit several times in the
    /// same file, which collides to the same `HunkId` under
    /// `theodore_domain::interdiff::hunk_id` (identity is `(path, content)`,
    /// not position, by design — plan §4). `grouping::validate`'s
    /// `BTreeSet<&HunkId>` can't tell the colliding hunks apart either, so
    /// it would have reported "valid" while quietly dropping all but one of
    /// them. The pipeline must refuse to run rather than produce that
    /// misleadingly "valid" result.
    #[tokio::test]
    async fn duplicate_hunk_ids_across_files_are_rejected_before_calling_the_agent() {
        let rev = Revision {
            base: Sha::new("base"),
            head: Sha::new("head"),
            files: vec![
                file("a.rs", vec![mk_hunk("dup")]),
                file("b.rs", vec![mk_hunk("dup")]),
                file("c.rs", vec![mk_hunk("unique")]),
            ],
        };
        let agent = FakeAgentPort::new([valid_json()]);
        let err = group_revision(
            &agent,
            &PrMeta::default(),
            &rev,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, GroupingPipelineError::DuplicateHunkIds(ref ids) if ids == &[HunkId::new("dup")])
        );
        assert_eq!(
            agent.calls_made(),
            0,
            "must not spend an agent call on bad input"
        );
    }

    #[test]
    fn duplicate_hunk_ids_is_empty_for_well_formed_input() {
        let rev = small_revision();
        assert!(duplicate_hunk_ids(&rev).is_empty());
    }

    #[tokio::test]
    async fn valid_first_try() {
        let agent = FakeAgentPort::new([valid_json()]);
        let rev = small_revision();
        let report = group_revision(
            &agent,
            &PrMeta::default(),
            &rev,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();
        assert!(report.valid_first_try);
        assert_eq!(report.attempts, 1);
        assert!(grouping::validate(&rev, &report.grouping).is_ok());
    }

    #[tokio::test]
    async fn invalid_then_repaired() {
        // first answer is missing h2 entirely.
        let bad = r#"{"groups": [{"id": "g1", "title": "Change", "why": "w",
            "kind": "normal", "hunks": ["h1"]}]}"#;
        let agent = FakeAgentPort::new([bad, valid_json()]);
        let rev = small_revision();
        let report = group_revision(
            &agent,
            &PrMeta::default(),
            &rev,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();
        assert!(!report.valid_first_try);
        assert_eq!(report.attempts, 2);
        assert!(grouping::validate(&rev, &report.grouping).is_ok());
        assert_eq!(agent.calls_made(), 2);
    }

    #[tokio::test]
    async fn garbage_falls_back_to_other() {
        let agent = FakeAgentPort::new(["I cannot help with that.", "still nothing useful here"]);
        let rev = small_revision();
        let report = group_revision(
            &agent,
            &PrMeta::default(),
            &rev,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();
        assert!(!report.valid_first_try);
        assert!(grouping::validate(&rev, &report.grouping).is_ok());
        let other = report
            .grouping
            .groups
            .iter()
            .find(|g| g.id == GroupId::new("other"));
        assert!(other.is_some());
        assert_eq!(
            other.unwrap().hunks.len(),
            2,
            "both hunks should land in the Other fallback group"
        );
    }

    #[tokio::test]
    async fn tolerates_fenced_json() {
        let fenced = format!(
            "Sure, here is the grouping:\n```json\n{}\n```",
            valid_json()
        );
        let agent = FakeAgentPort::new([fenced]);
        let rev = small_revision();
        let report = group_revision(
            &agent,
            &PrMeta::default(),
            &rev,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();
        assert!(report.valid_first_try);
        assert_eq!(report.attempts, 1);
    }

    #[tokio::test]
    async fn hidden_files_bypass_the_agent() {
        let mut rev = small_revision();
        rev.files.push(FileDiff {
            path: "pnpm-lock.yaml".into(),
            old_path: None,
            status: FileStatus::Modified,
            similarity: None,
            old_mode: None,
            new_mode: None,
            flags: vec![],
            additions: 1,
            deletions: 1,
            hunks: vec![mk_hunk("lock1")],
        });
        let agent = FakeAgentPort::new([valid_json()]);
        let report = group_revision(
            &agent,
            &PrMeta::default(),
            &rev,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();
        assert!(grouping::validate(&rev, &report.grouping).is_ok());
        // the lockfile hunk must be in the deterministic hidden group, and
        // the prompt sent to the agent must never mention it.
        let hidden = report
            .grouping
            .groups
            .iter()
            .find(|g| g.kind == theodore_domain::GroupKind::Hidden)
            .expect("hidden group present");
        assert!(hidden.hunks.contains(&HunkId::new("lock1")));
        let reqs = agent.requests();
        assert_eq!(reqs.len(), 1);
        assert!(!reqs[0].prompt.contains("lock1"));
    }

    #[tokio::test]
    async fn config_hide_skim_and_instructions_reach_the_pipeline() {
        let mut rev = small_revision();
        rev.files.push(file("gen/client.ts", vec![mk_hunk("gen1")]));
        let ctx = RepoContext {
            review: theodore_domain::review_rules::ReviewRules {
                instructions: Some("Flag any new dependency.".into()),
                context: vec!["docs/architecture.md".into()],
                hide: vec!["gen/**".into()],
                skim: vec!["src/a.ts".into()],
                ..Default::default()
            },
            ..RepoContext::default()
        };
        let agent = FakeAgentPort::new([valid_json()]);
        let report = group_revision_with(
            &agent,
            &PrMeta::default(),
            &rev,
            &ctx,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();
        assert!(grouping::validate(&rev, &report.grouping).is_ok());
        let hidden = report
            .grouping
            .groups
            .iter()
            .find(|g| g.kind == theodore_domain::GroupKind::Hidden)
            .expect("hidden group present");
        assert_eq!(hidden.hunks, vec![HunkId::new("gen1")]);
        assert_eq!(hidden.title, "Hidden by the repo's config");
        let reqs = agent.requests();
        assert_eq!(reqs.len(), 1);
        assert!(!reqs[0].prompt.contains("gen1"));
        assert!(
            reqs[0]
                .prompt
                .contains("skim candidate: marked skim in repo config")
        );
        let system = reqs[0].system.as_deref().unwrap();
        assert!(system.contains("Flag any new dependency."));
        assert!(system.contains("- docs/architecture.md"));
    }

    /// Speed goal: chunk prompts run concurrently (`buffered`), but the rest
    /// of the pipeline must see them in their original (alphabetical
    /// top-level-dir) order regardless. Pinned down via the natural-order
    /// fallback path: the merge-pass call is scripted to fail, so the final
    /// group order is exactly the chunk submission order.
    #[tokio::test]
    async fn chunk_concurrency_preserves_submission_order() {
        let rev = Revision {
            base: Sha::new("base"),
            head: Sha::new("head"),
            files: vec![
                file("a/one.ts", vec![mk_hunk("a1")]),
                file("b/two.ts", vec![mk_hunk("b1")]),
            ],
        };
        let tiny_budget = PromptBudget {
            max_chars: 10,
            ..PromptBudget::default()
        };
        let opts = GroupingOptions {
            budget: tiny_budget,
            ..GroupingOptions::default()
        };
        let a_response = r#"{"groups": [{"id": "ga", "title": "A", "why": "w",
            "kind": "normal", "hunks": ["a1"], "outliers": []}]}"#;
        let b_response = r#"{"groups": [{"id": "gb", "title": "B", "why": "w",
            "kind": "normal", "hunks": ["b1"], "outliers": []}]}"#;
        // The merge-pass call (3rd) is garbage, forcing the natural-order
        // fallback — exactly what pins the chunk order down for this test.
        let agent = FakeAgentPort::new([a_response, b_response, "not json"]);

        let report = group_revision(&agent, &PrMeta::default(), &rev, Path::new("."), &opts)
            .await
            .unwrap();

        assert!(grouping::validate(&rev, &report.grouping).is_ok());
        let ids: Vec<&str> = report
            .grouping
            .groups
            .iter()
            .map(|g| g.id.as_str())
            .collect();
        assert_eq!(ids, vec!["ga", "gb"]);
    }

    /// Coarser-groups goal: a real large PR (migratro#77-shaped) got one
    /// group per small, related file (`.env`, CI, docker, docs) that should
    /// have stayed with the change they supported. Simulate the same
    /// over-fragmentation on a small PR and check the deterministic
    /// post-pass brings it back down to the PR-size target without another
    /// agent call.
    #[tokio::test]
    async fn fragmented_response_is_coarsened_down_to_the_pr_size_target() {
        let rev = Revision {
            base: Sha::new("base"),
            head: Sha::new("head"),
            files: vec![
                file("a/one.rs", vec![mk_hunk("a1")]),
                file("a/two.rs", vec![mk_hunk("a2")]),
                file("a/three.rs", vec![mk_hunk("a3")]),
                file("b/one.rs", vec![mk_hunk("b1")]),
                file("b/two.rs", vec![mk_hunk("b2")]),
                file("b/three.rs", vec![mk_hunk("b3")]),
            ],
        };
        let fragmented = r#"{"groups": [
            {"id": "a1g", "title": "a1", "why": "w", "kind": "normal", "hunks": ["a1"], "outliers": []},
            {"id": "a2g", "title": "a2", "why": "w", "kind": "normal", "hunks": ["a2"], "outliers": []},
            {"id": "a3g", "title": "a3", "why": "w", "kind": "normal", "hunks": ["a3"], "outliers": []},
            {"id": "b1g", "title": "b1", "why": "w", "kind": "normal", "hunks": ["b1"], "outliers": []},
            {"id": "b2g", "title": "b2", "why": "w", "kind": "normal", "hunks": ["b2"], "outliers": []},
            {"id": "b3g", "title": "b3", "why": "w", "kind": "normal", "hunks": ["b3"], "outliers": []}
        ]}"#;
        let agent = FakeAgentPort::new([fragmented]);

        let report = group_revision(
            &agent,
            &PrMeta::default(),
            &rev,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();

        assert!(grouping::validate(&rev, &report.grouping).is_ok());
        assert!(
            report.grouping.groups.len() <= 4,
            "expected coarsening down to the 6-hunk PR's target (2-4), got {} groups",
            report.grouping.groups.len()
        );
        assert_eq!(
            agent.calls_made(),
            1,
            "coarsening is a deterministic post-pass, not another agent call"
        );
    }
}
