//! Incremental regroup after a push (plan §5.3). Unchanged hunks keep their
//! group automatically; only new and changed hunks are sent to the agent,
//! together with the existing groups, and it assigns them — existing group
//! ids stay stable.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::Path;

use serde::Deserialize;
use theodore_domain::interdiff::HunkChange;
use theodore_domain::{Group, GroupId, GroupKind, Grouping, HunkId, Revision, Usage, grouping};
use theodore_ports::AgentPort;

use crate::pipeline::{self, GroupingOptions, GroupingPipelineError, GroupingReport, PrMeta};

#[derive(Debug, Clone, Deserialize)]
struct RawAssignment {
    hunk: String,
    group: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RawNewGroup {
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    why: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    risk: Option<String>,
    #[serde(default)]
    check: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct RawIncremental {
    #[serde(default)]
    assignments: Vec<RawAssignment>,
    #[serde(default)]
    new_groups: Vec<RawNewGroup>,
}

fn kind_from_str(s: Option<&str>) -> GroupKind {
    match s {
        Some("skim") => GroupKind::Skim,
        Some("hidden") => GroupKind::Hidden,
        _ => GroupKind::Normal,
    }
}

/// Regroup `new_rev` given the previous grouping and a hunk classification
/// (`theodore_domain::interdiff::classify(old_rev, new_rev)`).
pub async fn regroup(
    agent: &dyn AgentPort,
    pr: &PrMeta,
    previous: &Grouping,
    new_rev: &Revision,
    changes: &BTreeMap<HunkId, HunkChange>,
    cwd: &Path,
    opts: &GroupingOptions,
) -> Result<GroupingReport, GroupingPipelineError> {
    let start = std::time::Instant::now();
    let all_ids: BTreeSet<HunkId> = new_rev.hunks().map(|h| h.id.clone()).collect();
    let unchanged: BTreeSet<HunkId> = all_ids
        .iter()
        .filter(|id| matches!(changes.get(id), Some(HunkChange::Unchanged)))
        .cloned()
        .collect();
    let to_place: Vec<HunkId> = all_ids.difference(&unchanged).cloned().collect();

    // Carry over existing groups, keeping only hunks that are still unchanged.
    let mut groups: Vec<Group> = previous
        .groups
        .iter()
        .map(|g| {
            let mut g = g.clone();
            g.hunks.retain(|h| unchanged.contains(h));
            let kept: BTreeSet<HunkId> = g.hunks.iter().cloned().collect();
            g.outliers.retain(|o| kept.contains(o));
            g
        })
        .collect();

    if to_place.is_empty() {
        let grouping = Grouping {
            rev: new_rev.head.clone(),
            groups: groups.into_iter().filter(|g| !g.hunks.is_empty()).collect(),
        };
        let (grouping, attempts) = finalize(new_rev, grouping, 0);
        return Ok(GroupingReport {
            grouping,
            attempts: attempts.max(1),
            valid_first_try: true,
            usage: Usage::default(),
            duration_ms: start.elapsed().as_millis() as u64,
        });
    }

    let prompt = build_prompt(pr, &groups, new_rev, &to_place);
    let (text, mut usage) = pipeline::call_agent(agent, opts, cwd, &prompt.0, &prompt.1).await?;
    let mut attempts = 1u32;
    let mut any_repair = false;

    let mut applied = apply(&groups, &to_place, parse_incremental(&text));
    if let Err(errors) = validate_hunks(new_rev, &applied) {
        any_repair = true;
        let repair_prompt = build_repair_prompt(&prompt.1, &text, &errors);
        let (text2, u2) = pipeline::call_agent(agent, opts, cwd, &prompt.0, &repair_prompt).await?;
        usage += u2;
        attempts += 1;
        applied = apply(&groups, &to_place, parse_incremental(&text2));
    }

    groups = applied;
    let grouping = Grouping {
        rev: new_rev.head.clone(),
        groups,
    };
    let (grouping, attempts) = finalize(new_rev, grouping, attempts);
    any_repair |= attempts > 2;

    Ok(GroupingReport {
        grouping,
        attempts: attempts.max(1),
        valid_first_try: !any_repair,
        usage,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

fn finalize(rev: &Revision, grouping: Grouping, attempts: u32) -> (Grouping, u32) {
    match grouping::validate(rev, &grouping) {
        Ok(()) => (grouping, attempts),
        Err(_) => (grouping::repair_with_other(rev, grouping), attempts + 1),
    }
}

fn validate_hunks(rev: &Revision, groups: &[Group]) -> Result<(), Vec<grouping::GroupingError>> {
    let g = Grouping {
        rev: rev.head.clone(),
        groups: groups.to_vec(),
    };
    grouping::validate(rev, &g)
}

fn parse_incremental(text: &str) -> RawIncremental {
    crate::parse::extract_json(text)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn apply(existing: &[Group], to_place: &[HunkId], raw: RawIncremental) -> Vec<Group> {
    let mut by_id: BTreeMap<GroupId, Group> = existing
        .iter()
        .cloned()
        .map(|g| (g.id.clone(), g))
        .collect();
    let order: Vec<GroupId> = existing.iter().map(|g| g.id.clone()).collect();
    let mut new_order: Vec<GroupId> = order.clone();

    for ng in raw.new_groups {
        let id = GroupId::new(ng.id);
        if !by_id.contains_key(&id) {
            by_id.insert(
                id.clone(),
                Group {
                    id: id.clone(),
                    title: ng.title,
                    why: ng.why,
                    kind: kind_from_str(ng.kind.as_deref()),
                    risk: ng.risk,
                    check: ng.check,
                    hunks: vec![],
                    outliers: vec![],
                },
            );
            new_order.push(id);
        }
    }

    let placeable: BTreeSet<&HunkId> = to_place.iter().collect();
    let mut placed: BTreeSet<HunkId> = BTreeSet::new();
    for a in raw.assignments {
        let hid = HunkId::new(a.hunk);
        if !placeable.contains(&hid) || placed.contains(&hid) {
            continue;
        }
        let gid = GroupId::new(a.group);
        if let Some(g) = by_id.get_mut(&gid) {
            g.hunks.push(hid.clone());
            placed.insert(hid);
        }
    }

    // Anything not placed by the agent falls through to validation →
    // `repair_with_other`, which sweeps it into "Other".
    new_order
        .into_iter()
        .filter_map(|id| by_id.remove(&id))
        .filter(|g| !g.hunks.is_empty())
        .collect()
}

fn group_summary(g: &Group) -> String {
    format!(
        "{} — \"{}\" ({:?}, {} hunks)",
        g.id,
        g.title,
        g.kind,
        g.hunks.len()
    )
}

fn build_prompt(
    pr: &PrMeta,
    groups: &[Group],
    rev: &Revision,
    to_place: &[HunkId],
) -> (String, String) {
    let system = "A pull request was pushed to. Below are its existing review \
groups (unchanged hunks already stay where they were) and the hunks that are \
new or changed. Assign each listed hunk to the existing group it fits best, \
or declare a new group for ones that fit nowhere. Do not move any hunk that \
is not listed.\n\n\
Respond with JSON only: {\"assignments\": [{\"hunk\": \"id\", \"group\": \"id\"}], \
\"new_groups\": [{\"id\": \"...\", \"title\": \"...\", \"why\": \"...\", \"kind\": \"normal\"|\"skim\"|\"hidden\"}]}"
        .to_string();

    let mut user = String::new();
    let _ = writeln!(user, "# PR\nTitle: {}", pr.title);
    let _ = writeln!(user, "\n# Existing groups");
    for g in groups {
        let _ = writeln!(user, "- {}", group_summary(g));
    }
    let _ = writeln!(user, "\n# New / changed hunks to place");
    let wanted: BTreeSet<&HunkId> = to_place.iter().collect();
    for file in &rev.files {
        for hunk in &file.hunks {
            if !wanted.contains(&hunk.id) {
                continue;
            }
            let _ = writeln!(
                user,
                "\n## hunk {} — {} ({})",
                hunk.id, file.path, hunk.header
            );
            for l in &hunk.lines {
                let sign = match l.kind {
                    theodore_domain::LineKind::Add => '+',
                    theodore_domain::LineKind::Del => '-',
                    theodore_domain::LineKind::Ctx => ' ',
                };
                let _ = writeln!(user, "{sign}{}", l.text);
            }
        }
    }
    (system, user)
}

fn build_repair_prompt(
    previous_user: &str,
    previous_answer: &str,
    errors: &[grouping::GroupingError],
) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "Your previous answer was invalid. Problems:");
    for e in errors {
        let _ = writeln!(out, "- {e}");
    }
    let _ = writeln!(out, "\nOriginal request:\n{previous_user}");
    let _ = writeln!(out, "\nYour previous answer:\n{previous_answer}");
    let _ = writeln!(
        out,
        "\nReturn corrected JSON only, same schema, fixing exactly these problems."
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::FakeAgentPort;
    use theodore_domain::{DiffLine, FileDiff, FileStatus, Hunk, LineKind, Sha};

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

    fn rev(hunk_ids: &[&str]) -> Revision {
        Revision {
            base: Sha::new("base"),
            head: Sha::new("head2"),
            files: vec![FileDiff {
                path: "src/a.ts".into(),
                old_path: None,
                status: FileStatus::Modified,
                similarity: None,
                old_mode: None,
                new_mode: None,
                flags: vec![],
                additions: 0,
                deletions: 0,
                hunks: hunk_ids.iter().map(|id| mk_hunk(id)).collect(),
            }],
        }
    }

    fn previous_grouping() -> Grouping {
        Grouping {
            rev: Sha::new("head1"),
            groups: vec![Group {
                id: GroupId::new("g1"),
                title: "Original".into(),
                why: "w".into(),
                kind: GroupKind::Normal,
                risk: None,
                check: vec![],
                hunks: vec![HunkId::new("h1"), HunkId::new("h2")],
                outliers: vec![],
            }],
        }
    }

    #[tokio::test]
    async fn unchanged_only_skips_the_agent_entirely() {
        let agent = FakeAgentPort::new(Vec::<String>::new());
        let new_rev = rev(&["h1", "h2"]);
        let mut changes = BTreeMap::new();
        changes.insert(HunkId::new("h1"), HunkChange::Unchanged);
        changes.insert(HunkId::new("h2"), HunkChange::Unchanged);

        let report = regroup(
            &agent,
            &PrMeta::default(),
            &previous_grouping(),
            &new_rev,
            &changes,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();

        assert!(report.valid_first_try);
        assert_eq!(agent.calls_made(), 0);
        assert!(grouping::validate(&new_rev, &report.grouping).is_ok());
        assert_eq!(report.grouping.groups[0].id, GroupId::new("g1"));
    }

    #[tokio::test]
    async fn new_hunk_is_assigned_by_the_agent() {
        let agent = FakeAgentPort::new([
            r#"{"assignments": [{"hunk": "h3", "group": "g1"}], "new_groups": []}"#,
        ]);
        let new_rev = rev(&["h1", "h2", "h3"]);
        let mut changes = BTreeMap::new();
        changes.insert(HunkId::new("h1"), HunkChange::Unchanged);
        changes.insert(HunkId::new("h2"), HunkChange::Unchanged);
        changes.insert(HunkId::new("h3"), HunkChange::New);

        let report = regroup(
            &agent,
            &PrMeta::default(),
            &previous_grouping(),
            &new_rev,
            &changes,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();

        assert!(report.valid_first_try);
        assert_eq!(agent.calls_made(), 1);
        let g1 = report
            .grouping
            .groups
            .iter()
            .find(|g| g.id == GroupId::new("g1"))
            .unwrap();
        assert!(g1.hunks.contains(&HunkId::new("h3")));
        assert!(grouping::validate(&new_rev, &report.grouping).is_ok());
    }

    #[tokio::test]
    async fn changed_hunk_dropped_from_old_group_and_reassigned() {
        // h2's content changed, so its new id is h2b; the agent proposes a
        // brand new group for it instead of reusing g1.
        let agent = FakeAgentPort::new([r#"{"assignments": [{"hunk": "h2b", "group": "g2"}],
                "new_groups": [{"id": "g2", "title": "Follow-up", "why": "w", "kind": "normal"}]}"#]);
        let new_rev = rev(&["h1", "h2b"]);
        let mut changes = BTreeMap::new();
        changes.insert(HunkId::new("h1"), HunkChange::Unchanged);
        changes.insert(
            HunkId::new("h2b"),
            HunkChange::Changed {
                previous: HunkId::new("h2"),
            },
        );

        let report = regroup(
            &agent,
            &PrMeta::default(),
            &previous_grouping(),
            &new_rev,
            &changes,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();

        assert!(grouping::validate(&new_rev, &report.grouping).is_ok());
        let g1 = report
            .grouping
            .groups
            .iter()
            .find(|g| g.id == GroupId::new("g1"))
            .unwrap();
        assert_eq!(g1.hunks, vec![HunkId::new("h1")]);
        let g2 = report
            .grouping
            .groups
            .iter()
            .find(|g| g.id == GroupId::new("g2"))
            .unwrap();
        assert!(g2.hunks.contains(&HunkId::new("h2b")));
    }

    #[tokio::test]
    async fn unplaced_hunk_falls_back_to_other() {
        let agent = FakeAgentPort::new([
            r#"{"assignments": [], "new_groups": []}"#,
            r#"{"assignments": [], "new_groups": []}"#,
        ]);
        let new_rev = rev(&["h1", "h2", "h3"]);
        let mut changes = BTreeMap::new();
        changes.insert(HunkId::new("h1"), HunkChange::Unchanged);
        changes.insert(HunkId::new("h2"), HunkChange::Unchanged);
        changes.insert(HunkId::new("h3"), HunkChange::New);

        let report = regroup(
            &agent,
            &PrMeta::default(),
            &previous_grouping(),
            &new_rev,
            &changes,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();

        assert!(!report.valid_first_try);
        assert!(grouping::validate(&new_rev, &report.grouping).is_ok());
        let other = report
            .grouping
            .groups
            .iter()
            .find(|g| g.id == GroupId::new("other"))
            .expect("h3 should land in Other");
        assert!(other.hunks.contains(&HunkId::new("h3")));
    }
}
