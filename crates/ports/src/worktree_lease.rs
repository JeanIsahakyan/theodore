//! Worktree lease (plan "worktree locks"): held for the full duration of an
//! agent run so the periodic worktree GC sweep (`runtime::worktree_gc`)
//! never removes a worktree a run is actively using, even if the PR closes
//! or merges underneath it mid-run.
//!
//! `app` depends only on this trait; `runtime` implements it over
//! `WorktreeLocks` (a refcount `GitPort::gc_worktrees`'s keep-list unions
//! in). `NoopWorktreeLease` is wired in wherever nothing needs the
//! guarantee yet (tests, the CLI) so call sites never have to special-case
//! a missing lease.

use theodore_domain::PrRef;

/// Acquires a hold on `pr`'s worktree; dropping the returned guard releases
/// it. The guard is an opaque `Any` (not a named associated type) so this
/// trait stays object-safe behind `Arc<dyn WorktreeLease>` in `Deps`.
pub trait WorktreeLease: Send + Sync {
    fn acquire(&self, pr: PrRef) -> Box<dyn std::any::Any + Send>;
}

/// Holds nothing; its guard is a bare `()` with no `Drop` to run.
pub struct NoopWorktreeLease;

impl WorktreeLease for NoopWorktreeLease {
    fn acquire(&self, _pr: PrRef) -> Box<dyn std::any::Any + Send> {
        Box::new(())
    }
}
