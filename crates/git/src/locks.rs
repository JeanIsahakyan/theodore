//! One async lock per path, process-wide: a bare repo's refs and a
//! worktree's index are each written by one `git` at a time.
//!
//! Without it, two writers race on git's own lock files and the loser fails
//! outright — `cannot lock ref 'refs/heads/x': is at NEW but expected OLD`
//! (two `fetch +refs/heads/*` into one bare repo: the poller's push handler
//! and the UI's `get_revision`), or `index.lock: File exists` (two checkouts
//! into one worktree).
//!
//! ```text
//! poller  fetch ─┐                     ┌─▶ fetch ─▶ ok
//! UI      fetch ─┴─▶ lock(repo.git) ───┴─▶ (waits) ─▶ fetch ─▶ ok
//! ```
//!
//! Ordering, so two locks never deadlock: a worktree's lock is taken before
//! its bare repo's, never the other way round. Locks are not reentrant — an
//! op holding one calls only the `*_locked` helpers below it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

type Registry = Mutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>;

static LOCKS: LazyLock<Registry> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Held for as long as the path is being written.
#[must_use = "the lock is released as soon as the guard is dropped"]
pub(crate) struct PathGuard {
    _guard: OwnedMutexGuard<()>,
}

/// Waits for, then holds, `path`'s lock.
pub(crate) async fn lock(path: &Path) -> PathGuard {
    let mutex = {
        let mut map = LOCKS.lock().unwrap_or_else(|p| p.into_inner());
        // An entry only the map holds has no owner and no waiter (both keep
        // a clone of the `Arc`): safe to forget, so the map stays small.
        map.retain(|_, m| Arc::strong_count(m) > 1);
        map.entry(key_of(path)).or_default().clone()
    };
    PathGuard {
        _guard: mutex.lock_owned().await,
    }
}

/// One key per directory however it is spelled (`/var` vs `/private/var`
/// on macOS, a trailing `.`), including a repo that doesn't exist yet: the
/// clone that creates it and a fetch right after must share a lock.
fn key_of(path: &Path) -> PathBuf {
    if let Ok(p) = std::fs::canonicalize(path) {
        return p;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => std::fs::canonicalize(parent)
            .map(|p| p.join(name))
            .unwrap_or_else(|_| path.to_path_buf()),
        _ => path.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    /// Runs `n` tasks that each hold `lock(path_of(i))` for a moment and
    /// returns the most that were ever inside at once.
    async fn max_inside(n: usize, path_of: impl Fn(usize) -> PathBuf) -> usize {
        let inside = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for i in 0..n {
            let (inside, peak, path) = (inside.clone(), peak.clone(), path_of(i));
            tasks.push(tokio::spawn(async move {
                let _g = lock(&path).await;
                let now = inside.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(10)).await;
                inside.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for t in tasks {
            t.await.unwrap();
        }
        peak.load(Ordering::SeqCst)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn one_path_is_held_by_one_task_at_a_time() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("repo.git");
        std::fs::create_dir_all(&dir).unwrap();
        // Spelled two ways: the same directory, so the same lock.
        let alias = tmp.path().join(".").join("repo.git");
        let peak = max_inside(8, |i| {
            if i % 2 == 0 {
                dir.clone()
            } else {
                alias.clone()
            }
        })
        .await;
        assert_eq!(peak, 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn different_paths_do_not_wait_on_each_other() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let peak = max_inside(4, |i| root.join(format!("repo{i}.git"))).await;
        assert!(peak > 1, "peak {peak}");
    }

    #[test]
    fn a_repo_not_cloned_yet_keys_like_it_will_once_it_is() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("new.git");
        let before = key_of(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(before, key_of(&dir));
    }
}
