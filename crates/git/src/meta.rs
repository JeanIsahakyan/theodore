//! Sidecar metadata recorded next to each managed worktree.
//!
//! The worktree directory name (`<host>-<owner>-<repo>-<n>`) isn't reversible
//! in general — an owner or repo name can itself contain `-`. `gc_worktrees`
//! needs to map a directory back to the `RepoRef` that owns it (to run
//! `git worktree remove` from the right bare repo), so each worktree gets a
//! small JSON sidecar instead of relying on name-splitting.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use theodore_domain::RepoRef;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct WorktreeMeta {
    pub repo: RepoRef,
    pub number: u64,
}

fn meta_path(meta_root: &Path, dirname: &str) -> PathBuf {
    meta_root.join(format!("{dirname}.json"))
}

pub(crate) fn write(meta_root: &Path, dirname: &str, meta: &WorktreeMeta) -> std::io::Result<()> {
    std::fs::create_dir_all(meta_root)?;
    let data = serde_json::to_vec_pretty(meta).unwrap_or_default();
    std::fs::write(meta_path(meta_root, dirname), data)
}

pub(crate) fn remove(meta_root: &Path, dirname: &str) {
    let _ = std::fs::remove_file(meta_path(meta_root, dirname));
}

/// Every `(dirname, meta)` pair with a readable sidecar under `meta_root`.
pub(crate) fn list(meta_root: &Path) -> Vec<(String, WorktreeMeta)> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(meta_root) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(data) = std::fs::read(&path) else {
            continue;
        };
        if let Ok(meta) = serde_json::from_slice::<WorktreeMeta>(&data) {
            out.push((stem.to_string(), meta));
        }
    }
    out
}
