//! Orchestration (plan §5.1): pre-pass → prompt → agent → validate → one
//! repair call → `repair_with_other` fallback. Large PRs run one chunk per
//! top-level directory, then a merge pass over the group summaries.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Instant;

use theodore_domain::grouping::{self, GroupingError};
use theodore_domain::{AgentId, Group, GroupId, Grouping, Hunk, HunkId, Revision, Usage};
use theodore_ports::{AgentEvent, AgentMode, AgentPort, AgentRequest};

use crate::prepass::{self, HiddenReason, PrePass};
use crate::prompt::{self, PromptBudget, PromptPart};
use crate::schema;

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
    pub model: Option<String>,
    pub budget: PromptBudget,
    /// Forwarded to `AgentRequest::stall_after_ms`.
    pub stall_after_ms: u64,
}

impl Default for GroupingOptions {
    fn default() -> Self {
        Self {
            agent: AgentId::Claude,
            model: None,
            budget: PromptBudget::default(),
            stall_after_ms: 90_000,
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
}

/// Run the full grouping pipeline against one revision.
pub async fn group_revision(
    agent: &dyn AgentPort,
    pr: &PrMeta,
    rev: &Revision,
    cwd: &Path,
    opts: &GroupingOptions,
) -> Result<GroupingReport, GroupingPipelineError> {
    let start = Instant::now();
    let prepass = prepass::run(rev);
    let chunks = prompt::build_prompts(pr, rev, &prepass, &opts.budget);

    let mut usage = Usage::default();
    let mut attempts: u32 = 0;
    let mut any_repair = false;
    let mut chunk_groupings: Vec<Grouping> = Vec::with_capacity(chunks.len());

    for chunk in &chunks {
        let sub_rev = sub_revision(rev, &chunk.hunk_ids);
        let (grouping, att, repaired, u) =
            run_chunk(agent, opts, cwd, &sub_rev, &chunk.prompt).await?;
        usage += u;
        attempts += att;
        any_repair |= repaired;
        chunk_groupings.push(grouping);
    }

    let mut groups: Vec<Group> = hidden_groups(&prepass, rev);

    if chunk_groupings.len() <= 1 {
        if let Some(g) = chunk_groupings.into_iter().next() {
            groups.extend(g.groups);
        }
    } else {
        let all: Vec<Group> = chunk_groupings.into_iter().flat_map(|g| g.groups).collect();
        attempts += 1;
        match merge_pass(agent, opts, cwd, pr, &all).await {
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
        title: "Lockfiles, generated and vendored files".into(),
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
    sub_rev: &Revision,
    prompt: &PromptPart,
) -> Result<(Grouping, u32, bool, Usage), GroupingPipelineError> {
    let mut usage = Usage::default();
    let (text, u) = call_agent(agent, opts, cwd, &prompt.system, &prompt.user).await?;
    usage += u;
    let grouping = schema::parse_grouping(&text, sub_rev.head.clone());

    let errors = match grouping::validate(sub_rev, &grouping) {
        Ok(()) => return Ok((grouping, 1, false, usage)),
        Err(errors) => errors,
    };
    let known: Vec<HunkId> = sub_rev.hunks().map(|h| h.id.clone()).collect();
    let repair = prompt::repair_prompt(&known, &text, &display_errors(&errors));
    let (text2, u2) = call_agent(agent, opts, cwd, &repair.system, &repair.user).await?;
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

/// Ask the agent for the final reading order across chunk group summaries.
/// Returns `None` on any failure (agent error, unparseable, incomplete) —
/// the caller falls back to the chunks' natural order, which is still a
/// valid (if less polished) grouping.
async fn merge_pass(
    agent: &dyn AgentPort,
    opts: &GroupingOptions,
    cwd: &Path,
    pr: &PrMeta,
    groups: &[Group],
) -> Option<Vec<GroupId>> {
    let prompt = prompt::merge_prompt(pr, groups);
    let (text, _usage) = call_agent(agent, opts, cwd, &prompt.system, &prompt.user)
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

pub(crate) async fn call_agent(
    agent: &dyn AgentPort,
    opts: &GroupingOptions,
    cwd: &Path,
    system: &str,
    prompt: &str,
) -> Result<(String, Usage), GroupingPipelineError> {
    let req = AgentRequest {
        agent: opts.agent,
        prompt: prompt.to_string(),
        system: Some(system.to_string()),
        cwd: cwd.to_path_buf(),
        mode: AgentMode::ReadOnly,
        mcp: None,
        model: opts.model.clone(),
        stall_after_ms: opts.stall_after_ms,
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
}
