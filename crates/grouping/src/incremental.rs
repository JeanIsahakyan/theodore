//! Incremental regroup after a push (plan §5.3). Unchanged hunks keep their
//! group automatically; only new and changed hunks are sent to the agent,
//! together with the existing groups, and it assigns them — existing group
//! ids stay stable.
//!
//! ```text
//! new / changed hunk ─┬─ was in group G before the push ───────▶ suggest G
//!                     └─ G is the only group holding hunks of
//!                        the same file ────────────────────────▶ suggest G
//! agent ─▶ assignments + new groups
//!          ├─ a hunk it left out ─▶ its suggested group, if any
//!          └─ over the size target: a new one-hunk group joins the
//!             existing same-kind group it is strongly related to
//!             (relatedness graph, as in coarsening)
//! ```

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::path::Path;

use serde::Deserialize;
use theodore_domain::grouping::RepoContext;
use theodore_domain::interdiff::HunkChange;
use theodore_domain::{Group, GroupId, GroupKind, Grouping, HunkId, Revision, Usage, grouping};
use theodore_ports::AgentPort;

use crate::coarsen;
use crate::graph::RelGraph;
use crate::pipeline::{self, GroupingOptions, GroupingPipelineError, GroupingReport, PrMeta};
use crate::prepass;
use crate::schema::kind_from_str;
use crate::target;

/// A new one-hunk group joins an existing group only if at least this
/// related to it (`coarsen::relatedness`): the same file, an import of a
/// file few others import, a name defined in one and used in the other.
/// Rollout-only links (same edit, same new name) stay below it.
const STRONG_LINK: f64 = 1.0;
/// Files listed per existing group in the prompt.
const GROUP_FILES_SHOWN: usize = 6;

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

/// Where a hunk to place most likely belongs, and why.
#[derive(Debug, Clone, PartialEq)]
struct Suggestion {
    group: GroupId,
    reason: String,
}

/// Regroup `new_rev` given the previous grouping and a hunk classification
/// (`theodore_domain::interdiff::classify(old_rev, new_rev)`), from the
/// diff alone.
pub async fn regroup(
    agent: &dyn AgentPort,
    pr: &PrMeta,
    previous: &Grouping,
    new_rev: &Revision,
    changes: &BTreeMap<HunkId, HunkChange>,
    cwd: &Path,
    opts: &GroupingOptions,
) -> Result<GroupingReport, GroupingPipelineError> {
    regroup_with(
        agent,
        pr,
        previous,
        new_rev,
        changes,
        &RepoContext::default(),
        cwd,
        opts,
    )
    .await
}

/// [`regroup`] with repository context (head files, co-change history) for
/// the relatedness graph that suggests and tidies up placements.
#[allow(clippy::too_many_arguments)]
pub async fn regroup_with(
    agent: &dyn AgentPort,
    pr: &PrMeta,
    previous: &Grouping,
    new_rev: &Revision,
    changes: &BTreeMap<HunkId, HunkChange>,
    ctx: &RepoContext,
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

    let graph = RelGraph::build(new_rev, &prepass::run(new_rev), ctx);
    let suggestions = suggest(previous, &groups, &to_place, changes, &graph);

    let prompt = build_prompt(pr, &groups, new_rev, &to_place, &suggestions);
    let (text, mut usage) = pipeline::call_agent(agent, opts, cwd, &prompt.0, &prompt.1).await?;
    let mut attempts = 1u32;

    // Filling in a hunk the agent left out is a repair, even when no
    // repair call was needed.
    let (mut applied, filled) = apply(&groups, &to_place, parse_incremental(&text), &suggestions);
    let mut any_repair = filled > 0;
    if let Err(errors) = validate_hunks(new_rev, &applied) {
        any_repair = true;
        let repair_prompt = build_repair_prompt(&prompt.1, &text, &errors);
        let (text2, u2) = pipeline::call_agent(agent, opts, cwd, &prompt.0, &repair_prompt).await?;
        usage += u2;
        attempts += 1;
        (applied, _) = apply(&groups, &to_place, parse_incremental(&text2), &suggestions);
    }

    let existing: BTreeSet<GroupId> = previous.groups.iter().map(|g| g.id.clone()).collect();
    let cap = target_max(new_rev, &applied);
    groups = merge_fresh_singletons(applied, &existing, &graph, cap);
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

/// The group [`regroup`] would suggest for each new or changed hunk of
/// `new_rev` (whose relatedness graph is `graph`), without calling the
/// agent: for replaying a push offline.
pub fn suggested_groups(
    previous: &Grouping,
    new_rev: &Revision,
    changes: &BTreeMap<HunkId, HunkChange>,
    graph: &RelGraph,
) -> BTreeMap<HunkId, GroupId> {
    let unchanged: BTreeSet<&HunkId> = changes
        .iter()
        .filter(|(_, c)| matches!(c, HunkChange::Unchanged))
        .map(|(h, _)| h)
        .collect();
    let to_place: Vec<HunkId> = new_rev
        .hunks()
        .filter(|h| !unchanged.contains(&h.id))
        .map(|h| h.id.clone())
        .collect();
    let groups: Vec<Group> = previous
        .groups
        .iter()
        .map(|g| {
            let mut g = g.clone();
            g.hunks.retain(|h| unchanged.contains(h));
            g
        })
        .collect();
    suggest(previous, &groups, &to_place, changes, graph)
        .into_iter()
        .map(|(h, s)| (h, s.group))
        .collect()
}

/// A suggested group per hunk to place: the group a changed hunk was in
/// before the push, else the one existing group that already holds hunks
/// of the same file (none when two or more do).
///
/// Links to other files are deliberately not used here: replaying pushes
/// on the eval PRs (`theodore eval --graph-only --compare`), a strong
/// cross-file link named the group Claude chose for 3–100% of hunks
/// depending on the PR (3–16% on a refactor grouped by kind of change),
/// while "the only group holding the same file" did for 93–99%.
fn suggest(
    previous: &Grouping,
    groups: &[Group],
    to_place: &[HunkId],
    changes: &BTreeMap<HunkId, HunkChange>,
    graph: &RelGraph,
) -> BTreeMap<HunkId, Suggestion> {
    let was_in: BTreeMap<&HunkId, &GroupId> = previous
        .groups
        .iter()
        .flat_map(|g| g.hunks.iter().map(move |h| (h, &g.id)))
        .collect();
    let mut out = BTreeMap::new();
    for h in to_place {
        if let Some(HunkChange::Changed { previous: old }) = changes.get(h)
            && let Some(&gid) = was_in.get(old)
            && groups.iter().any(|g| &g.id == gid)
        {
            out.insert(
                h.clone(),
                Suggestion {
                    group: gid.clone(),
                    reason: "it was in this group before the push".into(),
                },
            );
            continue;
        }
        let Some(file) = graph.file_of(h) else {
            continue;
        };
        let holding: Vec<&Group> = groups
            .iter()
            .filter(|g| g.kind != GroupKind::Hidden)
            .filter(|g| g.hunks.iter().any(|x| graph.file_of(x) == Some(file)))
            .collect();
        if let [g] = holding.as_slice() {
            out.insert(
                h.clone(),
                Suggestion {
                    group: g.id.clone(),
                    reason: "same file as its hunks".into(),
                },
            );
        }
    }
    out
}

/// Apply the agent's answer; hunks it left out go to their suggested group
/// when they have one. Returns the groups and how many hunks were filled in
/// that way.
fn apply(
    existing: &[Group],
    to_place: &[HunkId],
    raw: RawIncremental,
    suggestions: &BTreeMap<HunkId, Suggestion>,
) -> (Vec<Group>, usize) {
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
    let mut filled = 0;
    for h in to_place {
        if placed.contains(h) {
            continue;
        }
        if let Some(s) = suggestions.get(h)
            && let Some(g) = by_id.get_mut(&s.group)
        {
            g.hunks.push(h.clone());
            filled += 1;
        }
    }

    // Anything still not placed falls through to validation →
    // `repair_with_other`, which sweeps it into "Other".
    let groups = new_order
        .into_iter()
        .filter_map(|id| by_id.remove(&id))
        .filter(|g| !g.hunks.is_empty())
        .collect();
    (groups, filled)
}

/// The coarsening rule, for groups the agent opened in this regroup: while
/// there are more groups than the PR's size-scaled target allows, a new
/// group holding a single hunk joins the existing same-kind group it is
/// most related to (same file, imports, shared names), if that link is
/// strong. Groups that existed before the push are never moved or split,
/// so their ids stay.
fn merge_fresh_singletons(
    mut groups: Vec<Group>,
    existing: &BTreeSet<GroupId>,
    graph: &RelGraph,
    target_max: usize,
) -> Vec<Group> {
    while groups.len() > target_max {
        let merge = groups.iter().enumerate().find_map(|(i, g)| {
            let fresh =
                !existing.contains(&g.id) && g.kind != GroupKind::Hidden && g.hunks.len() == 1;
            fresh
                .then(|| best_existing(&groups, i, existing, graph))
                .flatten()
                .map(|t| (i, t))
        });
        let Some((v, t)) = merge else { break };
        let absorbed = groups.remove(v);
        let t = if v < t { t - 1 } else { t };
        coarsen::merge_into(&mut groups[t], absorbed);
    }
    groups
}

/// The existing same-kind group most related to the single-hunk group at
/// `v`, if at least `STRONG_LINK`; ties go to the nearest.
fn best_existing(
    groups: &[Group],
    v: usize,
    existing: &BTreeSet<GroupId>,
    graph: &RelGraph,
) -> Option<usize> {
    let kind = groups[v].kind;
    groups
        .iter()
        .enumerate()
        .filter(|(i, g)| *i != v && existing.contains(&g.id) && g.kind == kind)
        .map(|(i, g)| (i, coarsen::relatedness(graph, &groups[v], g)))
        .filter(|(_, w)| *w >= STRONG_LINK)
        .max_by(|a, b| {
            a.1.total_cmp(&b.1)
                .then_with(|| b.0.abs_diff(v).cmp(&a.0.abs_diff(v)))
        })
        .map(|(i, _)| i)
}

/// Upper end of the size-scaled group target for `rev`, plus one for a
/// hidden group (as in the full pipeline).
fn target_max(rev: &Revision, groups: &[Group]) -> usize {
    let pre = prepass::run(rev);
    let visible = rev
        .files
        .iter()
        .filter(|f| !pre.is_hidden(&f.path))
        .map(|f| f.hunks.len())
        .sum();
    let hidden = groups.iter().any(|g| g.kind == GroupKind::Hidden);
    target::target_group_count(visible).1 + usize::from(hidden)
}

/// `id — "title" (kind, n hunks): a.ts, b.ts (+3 more)`.
fn group_summary(g: &Group, rev: &Revision) -> String {
    let ids: BTreeSet<&HunkId> = g.hunks.iter().collect();
    let files: Vec<&str> = rev
        .files
        .iter()
        .filter(|f| f.hunks.iter().any(|h| ids.contains(&h.id)))
        .map(|f| f.path.as_str())
        .collect();
    let mut out = format!(
        "{} — \"{}\" ({:?}, {} hunks)",
        g.id,
        g.title,
        g.kind,
        g.hunks.len()
    );
    if !files.is_empty() {
        let shown = files.len().min(GROUP_FILES_SHOWN);
        let _ = write!(out, ": {}", files[..shown].join(", "));
        if files.len() > shown {
            let _ = write!(out, " (+{} more)", files.len() - shown);
        }
    }
    out
}

fn build_prompt(
    pr: &PrMeta,
    groups: &[Group],
    rev: &Revision,
    to_place: &[HunkId],
    suggestions: &BTreeMap<HunkId, Suggestion>,
) -> (String, String) {
    let system = "A pull request was pushed to. Below are its existing review \
groups (unchanged hunks already stay where they were) and the hunks that are \
new or changed. Assign each listed hunk to the existing group it fits best, \
or declare a new group for ones that fit nowhere. Do not move any hunk that \
is not listed.\n\n\
Each existing group lists the files it holds. Some hunks carry a suggested \
group: where the hunk was before the push, or the only group holding other \
hunks of the same file. Use it unless the hunk's content clearly belongs \
elsewhere.\n\n\
Respond with JSON only: {\"assignments\": [{\"hunk\": \"id\", \"group\": \"id\"}], \
\"new_groups\": [{\"id\": \"...\", \"title\": \"...\", \"why\": \"...\", \"kind\": \"normal\"|\"skim\"|\"hidden\"}]}"
        .to_string();

    let mut user = String::new();
    let _ = writeln!(user, "# PR\nTitle: {}", pr.title);
    let _ = writeln!(user, "\n# Existing groups");
    for g in groups {
        let _ = writeln!(user, "- {}", group_summary(g, rev));
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
            if let Some(s) = suggestions.get(&hunk.id) {
                let _ = writeln!(user, "Suggested group: {} ({})", s.group, s.reason);
            }
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
    use theodore_domain::{DiffLine, FileDiff, FileStatus, GroupKind, Hunk, LineKind, Sha};

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
        // h3 sits in a file unrelated to g1's, so it has no suggestion to
        // fall back on (in g1's own file it would join g1).
        let mut new_rev = rev(&["h1", "h2"]);
        let mut other_file = new_rev.files[0].clone();
        other_file.path = "docs/unrelated.md".into();
        other_file.hunks = vec![mk_hunk("h3")];
        new_rev.files.push(other_file);
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

    // ---- graph-aware regroup: a revision, then a push ------------------

    fn code_file(path: &str, hunks: Vec<(&str, &[&str])>) -> FileDiff {
        FileDiff {
            path: path.into(),
            old_path: None,
            status: FileStatus::Modified,
            similarity: None,
            old_mode: None,
            new_mode: None,
            flags: vec![],
            additions: 0,
            deletions: 0,
            hunks: hunks
                .into_iter()
                .map(|(id, lines)| {
                    let mut h = mk_hunk(id);
                    h.path = path.into();
                    h.lines = lines.iter().map(|t| line(LineKind::Add, t)).collect();
                    h
                })
                .collect(),
        }
    }

    fn group(id: &str, kind: GroupKind, hunks: &[&str]) -> Group {
        Group {
            id: GroupId::new(id),
            title: id.into(),
            why: "w".into(),
            kind,
            risk: None,
            check: vec![],
            hunks: hunks.iter().map(|h| HunkId::new(*h)).collect(),
            outliers: vec![],
        }
    }

    const ROUTE: &[&str] = &[
        "import { billInvoice } from '../../core/billing/invoice-service';",
        "router.post('/invoices', (req) => billInvoice(req.body.id));",
    ];
    const SERVICE: &[&str] = &["export function billInvoice(id: string) {"];
    const SERVICE_MORE: &[&str] = &["export const invoiceRetries = 3;"];
    const RANK: &[&str] = &["export const rankBoost = 2;"];
    const SEARCH_V2: &[&str] = &[
        "import { rankBoost } from './rank';",
        "export const searchLimit = 20 * rankBoost;",
    ];
    const TEST: &[&str] = &[
        "import { billInvoice } from './invoice-service';",
        "test('bills', () => billInvoice('inv_1'));",
    ];
    const NOTES: &[&str] = &["Remember to water the plants."];

    /// The PR before the push: billing (route + service) and search
    /// (rank + index), one group each.
    fn before() -> Grouping {
        Grouping {
            rev: Sha::new("head1"),
            groups: vec![
                group("billing", GroupKind::Normal, &["r1", "s1"]),
                group("search", GroupKind::Normal, &["k1", "k2"]),
            ],
        }
    }

    /// After the push: a new hunk in the service, a new test of it, an
    /// unrelated note, and the search index hunk edited (`k2` → `k2b`).
    fn after() -> (Revision, BTreeMap<HunkId, HunkChange>) {
        let rev = Revision {
            base: Sha::new("base"),
            head: Sha::new("head2"),
            files: vec![
                code_file("api/routes/invoice.ts", vec![("r1", ROUTE)]),
                code_file(
                    "core/billing/invoice-service.ts",
                    vec![("s1", SERVICE), ("s2", SERVICE_MORE)],
                ),
                code_file("core/billing/invoice-service.test.ts", vec![("t1", TEST)]),
                code_file("web/src/search/rank.ts", vec![("k1", RANK)]),
                code_file("web/src/search/index.ts", vec![("k2b", SEARCH_V2)]),
                code_file("docs/notes.md", vec![("d1", NOTES)]),
            ],
        };
        let mut changes = BTreeMap::new();
        for id in ["r1", "s1", "k1"] {
            changes.insert(HunkId::new(id), HunkChange::Unchanged);
        }
        for id in ["s2", "t1", "d1"] {
            changes.insert(HunkId::new(id), HunkChange::New);
        }
        changes.insert(
            HunkId::new("k2b"),
            HunkChange::Changed {
                previous: HunkId::new("k2"),
            },
        );
        (rev, changes)
    }

    fn find<'g>(g: &'g Grouping, id: &str) -> Option<&'g Group> {
        g.groups.iter().find(|x| x.id == GroupId::new(id))
    }

    #[test]
    fn suggestions_come_from_the_previous_group_or_the_only_group_of_the_file() {
        let (rev, changes) = after();
        let graph = RelGraph::build(&rev, &prepass::run(&rev), &RepoContext::default());
        let carried: Vec<Group> = vec![
            group("billing", GroupKind::Normal, &["r1", "s1"]),
            group("search", GroupKind::Normal, &["k1"]),
        ];
        let to_place: Vec<HunkId> = ["d1", "k2b", "s2", "t1"].map(HunkId::new).to_vec();
        let s = suggest(&before(), &carried, &to_place, &changes, &graph);
        let group_of = |h: &str| s.get(&HunkId::new(h)).map(|s| s.group.as_str());
        assert_eq!(group_of("s2"), Some("billing"), "same file");
        assert_eq!(group_of("k2b"), Some("search"), "where it was before");
        // A new file is linked to billing (it tests the service), but links
        // to other files are not trusted for suggestions.
        assert_eq!(group_of("t1"), None);
        assert_eq!(group_of("d1"), None);
        assert_eq!(s[&HunkId::new("s2")].reason, "same file as its hunks");
        assert_eq!(
            s[&HunkId::new("k2b")].reason,
            "it was in this group before the push"
        );
        let public = suggested_groups(&before(), &rev, &changes, &graph);
        assert_eq!(public.len(), 2);
        assert_eq!(public[&HunkId::new("s2")], GroupId::new("billing"));
    }

    #[test]
    fn a_file_split_over_two_groups_gives_no_suggestion() {
        let (rev, _) = after();
        let graph = RelGraph::build(&rev, &prepass::run(&rev), &RepoContext::default());
        let carried = vec![
            group("billing", GroupKind::Normal, &["r1", "s1"]),
            group("retries", GroupKind::Normal, &["t1"]),
        ];
        let mut also_in_retries = carried.clone();
        also_in_retries[1].hunks.push(HunkId::new("s1"));
        let new = [HunkId::new("s2")];
        assert_eq!(
            suggest(&before(), &carried, &new, &BTreeMap::new(), &graph).len(),
            1
        );
        assert!(suggest(&before(), &also_in_retries, &new, &BTreeMap::new(), &graph).is_empty());
    }

    #[tokio::test]
    async fn the_prompt_lists_group_files_and_carries_the_suggestions() {
        let (rev, changes) = after();
        let agent = FakeAgentPort::new([r#"{"assignments": [
            {"hunk": "s2", "group": "billing"}, {"hunk": "t1", "group": "billing"},
            {"hunk": "k2b", "group": "search"}, {"hunk": "d1", "group": "notes"}],
            "new_groups": [{"id": "notes", "title": "Notes", "why": "w", "kind": "skim"}]}"#]);
        let report = regroup(
            &agent,
            &PrMeta::default(),
            &before(),
            &rev,
            &changes,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();
        assert!(report.valid_first_try);
        let req = &agent.requests()[0];
        assert!(req.system.as_deref().unwrap().contains("suggested group"));
        assert!(
            req.prompt.contains(
                "- billing — \"billing\" (Normal, 2 hunks): api/routes/invoice.ts, \
core/billing/invoice-service.ts"
            ),
            "{}",
            req.prompt
        );
        let after_hunk = |id: &str| {
            let at = req.prompt.find(&format!("## hunk {id} ")).unwrap();
            req.prompt[at..].lines().nth(1).unwrap_or("").to_string()
        };
        assert_eq!(
            after_hunk("s2"),
            "Suggested group: billing (same file as its hunks)"
        );
        assert_eq!(
            after_hunk("k2b"),
            "Suggested group: search (it was in this group before the push)"
        );
        assert!(!after_hunk("t1").starts_with("Suggested"));
        assert!(!after_hunk("d1").starts_with("Suggested"));
    }

    #[tokio::test]
    async fn a_hunk_the_agent_left_out_goes_to_its_suggestion_without_a_repair_call() {
        let (rev, changes) = after();
        // s2 is missing from the answer.
        let agent = FakeAgentPort::new([r#"{"assignments": [
            {"hunk": "t1", "group": "billing"}, {"hunk": "k2b", "group": "search"},
            {"hunk": "d1", "group": "search"}], "new_groups": []}"#]);
        let report = regroup(
            &agent,
            &PrMeta::default(),
            &before(),
            &rev,
            &changes,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(agent.calls_made(), 1);
        assert!(!report.valid_first_try, "filling in counts as a repair");
        assert!(grouping::validate(&rev, &report.grouping).is_ok());
        let billing = find(&report.grouping, "billing").unwrap();
        assert!(billing.hunks.contains(&HunkId::new("s2")));
        assert!(find(&report.grouping, "other").is_none());
    }

    /// 7 hunks: the target is 2–4 groups. The agent answers with five, three
    /// of them new one-hunk groups; the one strongly related to an existing
    /// group (the service follow-up, same file as `billing`'s service hunk)
    /// joins it, which meets the target, so the other two stay.
    #[tokio::test]
    async fn over_target_a_lone_new_hunk_joins_its_strongly_related_existing_group() {
        let (rev, changes) = after();
        let agent = FakeAgentPort::new([r#"{"assignments": [
            {"hunk": "s2", "group": "billing-retries"}, {"hunk": "t1", "group": "billing-tests"},
            {"hunk": "k2b", "group": "search"}, {"hunk": "d1", "group": "notes"}],
            "new_groups": [
              {"id": "billing-retries", "title": "Invoice retries", "why": "w", "kind": "normal"},
              {"id": "billing-tests", "title": "Billing tests", "why": "w", "kind": "normal"},
              {"id": "notes", "title": "Notes", "why": "w", "kind": "normal"}]}"#]);
        let report = regroup(
            &agent,
            &PrMeta::default(),
            &before(),
            &rev,
            &changes,
            Path::new("."),
            &GroupingOptions::default(),
        )
        .await
        .unwrap();
        assert!(report.valid_first_try);
        assert!(grouping::validate(&rev, &report.grouping).is_ok());
        let ids: Vec<&str> = report
            .grouping
            .groups
            .iter()
            .map(|g| g.id.as_str())
            .collect();
        assert_eq!(
            ids,
            vec!["billing", "search", "billing-tests", "notes"],
            "existing ids stay, in order"
        );
        let billing = find(&report.grouping, "billing").unwrap();
        assert_eq!(billing.hunks, ["r1", "s1", "s2"].map(HunkId::new).to_vec());
        assert!(billing.why.contains("Also includes: Invoice retries."));
    }

    #[test]
    fn within_target_new_groups_are_left_alone() {
        let (rev, _) = after();
        let graph = RelGraph::build(&rev, &prepass::run(&rev), &RepoContext::default());
        let existing: BTreeSet<GroupId> = ["billing", "search"].map(GroupId::new).into();
        let groups = vec![
            group("billing", GroupKind::Normal, &["r1", "s1", "t1"]),
            group("search", GroupKind::Normal, &["k1", "k2b", "d1"]),
            group("retries", GroupKind::Normal, &["s2"]),
        ];
        let out = merge_fresh_singletons(groups.clone(), &existing, &graph, 3);
        assert_eq!(out, groups);
        let out = merge_fresh_singletons(groups, &existing, &graph, 2);
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn fresh_singletons_merge_only_into_existing_same_kind_strongly_related_groups() {
        let (rev, _) = after();
        let graph = RelGraph::build(&rev, &prepass::run(&rev), &RepoContext::default());
        let existing: BTreeSet<GroupId> = ["billing", "search"].map(GroupId::new).into();
        let groups = vec![
            group("billing", GroupKind::Normal, &["r1", "s1"]),
            group("search", GroupKind::Normal, &["k1", "k2b"]),
            // A skim group is not merged into a normal one.
            group("retries", GroupKind::Skim, &["s2"]),
            // Unrelated to every existing group.
            group("notes", GroupKind::Normal, &["d1"]),
            // Two hunks: not a singleton.
            group("tests", GroupKind::Normal, &["t1", "t1b"]),
        ];
        let out = merge_fresh_singletons(groups.clone(), &existing, &graph, 1);
        assert_eq!(out, groups);
    }
}
