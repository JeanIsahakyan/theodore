//! Temporary stand-ins for `domain` functions that are still `todo!()` in
//! this worktree (`reading::newly_viewed`, `tasks::transition`,
//! `anchors::is_commentable`, `interdiff::classify`, `snooze::wakes`,
//! `findings::merge`).
//!
//! Each mirrors the exact contract documented in `docs/plan.md` for its
//! domain counterpart and is called from nowhere else. Once the `domain`
//! slice lands, delete this module and call the real function at each call
//! site — the signatures already match.

use std::collections::{BTreeMap, BTreeSet};

use theodore_domain::snooze::PrEvent;
use theodore_domain::{Finding, Hunk, HunkId, Revision, Side, SnoozeUntil, Task, TaskStatus};

/// Mirrors `domain::reading::newly_viewed`.
pub fn newly_viewed(
    rev: &Revision,
    before: &BTreeSet<HunkId>,
    after: &BTreeSet<HunkId>,
) -> Vec<String> {
    let mut out = Vec::new();
    for file in &rev.files {
        if file.hunks.is_empty() {
            continue;
        }
        let ids: Vec<&HunkId> = file.hunks.iter().map(|h| &h.id).collect();
        let was_all = ids.iter().all(|id| before.contains(*id));
        let now_all = ids.iter().all(|id| after.contains(*id));
        if now_all && !was_all {
            out.push(file.path.clone());
        }
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskEvent {
    Start,
    FixReady,
    Accept,
    Reject,
    Reopen,
}

/// Mirrors `domain::tasks::transition` for the statuses named in plan §4:
/// `todo -> progress -> review -> done`, reject sends it back to `todo`,
/// reopen sends `done` back to `todo`.
pub fn task_transition(task: &Task, event: TaskEvent) -> Result<TaskStatus, String> {
    use TaskStatus::*;
    match (task.status, event) {
        (Todo, TaskEvent::Start) => Ok(Progress),
        (Progress, TaskEvent::FixReady) => Ok(Review),
        (Review, TaskEvent::Accept) => Ok(Done),
        (Review, TaskEvent::Reject) => Ok(Todo),
        (Done, TaskEvent::Reopen) => Ok(Todo),
        (from, event) => Err(format!("cannot {event:?} a task in {from:?}")),
    }
}

/// Mirrors `domain::anchors::is_commentable`: the anchor's line falls inside
/// one of the revision's hunks on the matching path and side.
pub fn is_commentable(
    path: &str,
    side: Side,
    line: u32,
    start_line: Option<u32>,
    rev: &Revision,
) -> bool {
    let from = start_line.unwrap_or(line).min(line);
    let to = start_line.unwrap_or(line).max(line);
    rev.files
        .iter()
        .find(|f| f.path == path)
        .is_some_and(|f| f.hunks.iter().any(|h| hunk_covers(h, side, from, to)))
}

fn hunk_covers(hunk: &Hunk, side: Side, from: u32, to: u32) -> bool {
    hunk.lines.iter().any(|l| {
        let no = match side {
            Side::Old => l.old_no,
            Side::New => l.new_no,
        };
        no.is_some_and(|n| n >= from && n <= to)
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HunkChange {
    Unchanged,
    Changed { previous: usize },
    New,
}

/// Mirrors `domain::interdiff::classify`: hunk ids are content hashes
/// (`domain::anchors::hunk_id`), so an exact id match is unchanged; otherwise
/// fall back to an overlapping new-side range on the same path.
pub fn classify(old: &Revision, new: &Revision) -> BTreeMap<HunkId, HunkChange> {
    let old_ids: BTreeSet<&HunkId> = old.hunks().map(|h| &h.id).collect();
    let mut out = BTreeMap::new();
    for h in new.hunks() {
        if old_ids.contains(&h.id) {
            out.insert(h.id.clone(), HunkChange::Unchanged);
            continue;
        }
        let overlap = old.files.iter().find(|f| f.path == h.path).and_then(|f| {
            f.hunks.iter().position(|o| {
                o.new_start < h.new_start + h.new_lines && h.new_start < o.new_start + o.new_lines
            })
        });
        out.insert(
            h.id.clone(),
            match overlap {
                Some(idx) => HunkChange::Changed { previous: idx },
                None => HunkChange::New,
            },
        );
    }
    out
}

/// Mirrors `domain::snooze::wakes`.
pub fn wakes(until: &SnoozeUntil, event: &PrEvent) -> bool {
    match (until, event) {
        (SnoozeUntil::Time { at }, PrEvent::Tick(now)) => now >= at,
        (SnoozeUntil::NextPush, PrEvent::Pushed) => true,
        (SnoozeUntil::ChecksGreen, PrEvent::ChecksGreen) => true,
        _ => false,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeOutcome {
    New(Finding),
    MergedInto(Finding),
}

/// Mirrors `domain::findings::title_similarity`: normalized token overlap.
pub fn title_similarity(a: &str, b: &str) -> f32 {
    let ta: BTreeSet<String> = a.split_whitespace().map(str::to_lowercase).collect();
    let tb: BTreeSet<String> = b.split_whitespace().map(str::to_lowercase).collect();
    if ta.is_empty() || tb.is_empty() {
        return 0.0;
    }
    let inter = ta.intersection(&tb).count() as f32;
    let union = ta.union(&tb).count() as f32;
    inter / union
}

/// Mirrors `domain::findings::merge`: same file + overlapping lines (±2) +
/// similar title (>= 0.5) merge into one finding with the union of agents,
/// keeping the higher severity.
pub fn merge_findings(existing: &[Finding], incoming: Finding) -> MergeOutcome {
    for f in existing {
        if f.anchor.path != incoming.anchor.path {
            continue;
        }
        let close = f.anchor.line.abs_diff(incoming.anchor.line) <= 2;
        if close && title_similarity(&f.title, &incoming.title) >= 0.5 {
            let mut merged = f.clone();
            for a in &incoming.agents {
                if !merged.agents.contains(a) {
                    merged.agents.push(*a);
                }
            }
            if incoming.severity > merged.severity {
                merged.severity = incoming.severity;
            }
            return MergeOutcome::MergedInto(merged);
        }
    }
    MergeOutcome::New(incoming)
}
