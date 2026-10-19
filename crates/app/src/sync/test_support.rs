//! Test-only helpers shared by `sync`'s own test modules.
#![cfg(test)]

use std::sync::Arc;

use theodore_store::SqliteStore;

use crate::deps::Deps;
use crate::testkit::Fixtures;

/// `f.deps()` but with a real `SqliteStore` (in memory) in place of the
/// hand-rolled `FakeStore`. Needed by anything that depends on real sync
/// log semantics (monotonic ids, `at` timestamps, compaction) — `FakeStore`
/// doesn't implement those and just inherits the `Store` trait's no-op
/// defaults (`oldest_sync_id` -> `None`, `compact`/`compact_before` ->
/// `Ok(0)`), which would make a compaction-dependent test pass vacuously.
pub(crate) fn sqlite_deps(f: &Fixtures) -> (Deps, Arc<SqliteStore>) {
    let store = Arc::new(SqliteStore::open_in_memory().expect("in-memory sqlite"));
    let mut deps = f.deps();
    deps.store = store.clone();
    (deps, store)
}
