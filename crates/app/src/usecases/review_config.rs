//! The project config's `review:` section (docs/config.md §1), resolved for
//! one PR or space and handed to whatever applies it.
//!
//! ```text
//! global ─┐
//! repo   ─┼─▶ sha256(layers) ─▶ cached Merged ─▶ ReviewRules ─▶ grouping, prompts,
//! local  ─┘     (fresh read        (re-merged        │             findings, auto skills
//!                every time)        on change)       └─ context: resolved against the
//!                                                       PR's worktree
//! ```

use std::collections::HashMap;
use std::path::{Component, Path};
use std::sync::Arc;

use sha2::{Digest, Sha256};
use theodore_contract::models;
use theodore_domain::glob::{glob_match, is_glob};
use theodore_domain::review_rules::{MAX_CONTEXT_FILES, ReviewRules};
use theodore_domain::{PrId, RepoRef};

use crate::config::{self, LayerText, Merged, ReviewConfig};
use crate::core::Core;

/// Merged configs kept, by layer hash; more than this and the cache starts
/// over (a config edit leaves its old entry behind).
const CACHE_MAX: usize = 64;

/// Files looked at while expanding a `context` glob, at most.
const WALK_MAX_ENTRIES: usize = 20_000;

impl Core {
    /// The layers of the config a review of `repo` checked out at
    /// `worktree` runs with: a local folder project's own files (working
    /// copy and personal layer), whichever review of it is open; otherwise
    /// the global file and the repo's file at the PR's head.
    pub(crate) async fn pr_config_layers(&self, worktree: &Path, repo: &RepoRef) -> Vec<LayerText> {
        let store = self.0.deps.store.clone();
        let folder = tokio::task::spawn_blocking(move || store.all(models::PROJECT))
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|r| serde_json::from_value::<theodore_contract::Project>(r.data).ok())
            .find(|p| &p.repo == repo && p.path.is_some());
        match folder {
            Some(project) => self.project_layers(&project, None).await,
            None => config::read_layers(&self.0.deps.data_dir, Some(worktree), None).await,
        }
    }

    /// `config::merge`, reused while the layers' text is unchanged.
    pub(crate) fn merge_cached(&self, layers: &[LayerText]) -> Arc<Merged> {
        let key = layers_hash(layers);
        let mut cache = self
            .0
            .review_config
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if let Some(m) = cache.get(&key) {
            return m.clone();
        }
        let merged = Arc::new(config::merge(layers));
        if cache.len() >= CACHE_MAX {
            cache.clear();
        }
        cache.insert(key, merged.clone());
        merged
    }

    /// The review rules for `repo` checked out at `worktree`.
    pub(crate) async fn review_rules_at(&self, worktree: &Path, repo: &RepoRef) -> ReviewRules {
        let layers = self.pr_config_layers(worktree, repo).await;
        let merged = self.merge_cached(&layers);
        self.warn_config(&merged);
        rules_from(&merged.config.review, worktree).await
    }

    /// The review rules for an open PR, at its current head; the default
    /// (nothing set) when it isn't open.
    pub(crate) async fn review_rules_of(&self, pr: &PrId) -> ReviewRules {
        let entry = {
            let head = self.0.current_head.read().await.get(pr).cloned();
            match head {
                Some(head) => self
                    .0
                    .revisions
                    .read()
                    .await
                    .get(&(pr.clone(), head))
                    .cloned(),
                None => None,
            }
        };
        match entry {
            Some(e) => self.review_rules_at(&e.worktree_path, &e.pr_ref.repo).await,
            None => ReviewRules::default(),
        }
    }

    /// The configured `review.auto_skills` for an open PR.
    pub(crate) async fn auto_skills_of(&self, worktree: &Path, repo: &RepoRef) -> Vec<String> {
        let layers = self.pr_config_layers(worktree, repo).await;
        let merged = self.merge_cached(&layers);
        let mut out: Vec<String> = Vec::new();
        for s in &merged.config.review.auto_skills {
            let s = s.trim();
            if !s.is_empty() && !out.iter().any(|o| o == s) {
                out.push(s.to_string());
            }
        }
        out
    }

    /// Whether `review.auto_skills` runs at all (off in a sandbox replaying
    /// agents, unless its scenario turns it on).
    pub fn set_auto_skills(&self, on: bool) {
        self.0
            .auto_skills
            .store(on, std::sync::atomic::Ordering::SeqCst);
    }

    pub(crate) fn auto_skills_enabled(&self) -> bool {
        self.0.auto_skills.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// A new cache; `Inner` holds one.
pub(crate) fn new_cache() -> std::sync::Mutex<HashMap<String, Arc<Merged>>> {
    std::sync::Mutex::new(HashMap::new())
}

fn layers_hash(layers: &[LayerText]) -> String {
    let mut h = Sha256::new();
    for l in layers {
        h.update(format!("{:?}\0{}\0{}\0", l.layer, l.path.display(), l.legacy).as_bytes());
        match &l.text {
            Some(t) => {
                h.update(b"1");
                h.update(t.as_bytes());
            }
            None => h.update(b"0"),
        }
        h.update(b"\0");
    }
    hex::encode(h.finalize())
}

/// The typed `review:` section as rules, `context` resolved against `root`.
pub(crate) async fn rules_from(cfg: &ReviewConfig, root: &Path) -> ReviewRules {
    let root = root.to_path_buf();
    let entries = cfg.context.clone();
    let context = tokio::task::spawn_blocking(move || resolve_context(&root, &entries))
        .await
        .unwrap_or_default();
    ReviewRules {
        instructions: cfg
            .instructions
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        context,
        hide: clean(&cfg.hide),
        skim: clean(&cfg.skim),
        checklist: cfg
            .checklist
            .iter()
            .flat_map(|(glob, items)| {
                items
                    .items()
                    .into_iter()
                    .map(|i| i.trim().to_string())
                    .filter(|i| !i.is_empty())
                    .map(move |i| (glob.clone(), i))
            })
            .collect(),
        ignore_findings: clean(&cfg.ignore_findings),
    }
}

fn clean(globs: &[String]) -> Vec<String> {
    globs
        .iter()
        .map(|g| g.trim().to_string())
        .filter(|g| !g.is_empty())
        .collect()
}

/// `context` entries as existing repo paths: a plain path if it exists, a
/// glob expanded over the checkout (sorted); missing ones and paths
/// leaving the repo dropped with a debug note; at most
/// [`MAX_CONTEXT_FILES`].
pub(crate) fn resolve_context(root: &Path, entries: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut walked: Option<Vec<String>> = None;
    for entry in entries {
        if out.len() >= MAX_CONTEXT_FILES {
            break;
        }
        let entry = entry.trim().trim_start_matches("./");
        if entry.is_empty() {
            continue;
        }
        if !is_glob(entry) {
            let rel = entry.trim_end_matches('/');
            let inside = Path::new(rel)
                .components()
                .all(|c| matches!(c, Component::Normal(_)));
            if inside && root.join(rel).exists() {
                if !out.iter().any(|o| o == rel) {
                    out.push(rel.to_string());
                }
            } else {
                tracing::debug!("review.context: {entry} not found in {}", root.display());
            }
            continue;
        }
        let files = walked.get_or_insert_with(|| walk(root));
        let before = out.len();
        for f in files.iter() {
            if out.len() >= MAX_CONTEXT_FILES {
                break;
            }
            if glob_match(entry, f) && !out.contains(f) {
                out.push(f.clone());
            }
        }
        if out.len() == before {
            tracing::debug!(
                "review.context: {entry} matches nothing in {}",
                root.display()
            );
        }
    }
    out
}

/// Repo-relative files under `root`, sorted, without `.git`.
fn walk(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut seen = 0usize;
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in rd.flatten() {
            seen += 1;
            if seen > WALK_MAX_ENTRIES {
                out.sort();
                return out;
            }
            let path = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                if e.file_name() != ".git" {
                    stack.push(path);
                }
            } else if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_keeps_existing_paths_expands_globs_and_drops_the_rest() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("docs/adr")).unwrap();
        std::fs::write(root.join("docs/architecture.md"), "a").unwrap();
        std::fs::write(root.join("docs/adr/001.md"), "a").unwrap();
        std::fs::write(root.join("docs/adr/002.md"), "a").unwrap();
        std::fs::write(root.join("AGENTS.md"), "a").unwrap();
        let got = resolve_context(
            root,
            &[
                "docs/architecture.md".into(),
                "missing.md".into(),
                "../outside.md".into(),
                "docs/adr/*.md".into(),
                "AGENTS.md".into(),
                "AGENTS.md".into(),
            ],
        );
        assert_eq!(
            got,
            vec![
                "docs/architecture.md",
                "docs/adr/001.md",
                "docs/adr/002.md",
                "AGENTS.md"
            ]
        );
    }

    #[test]
    fn context_is_capped() {
        let tmp = tempfile::tempdir().unwrap();
        for i in 0..(MAX_CONTEXT_FILES + 5) {
            std::fs::write(tmp.path().join(format!("f{i:02}.md")), "a").unwrap();
        }
        let got = resolve_context(tmp.path(), &["*.md".into()]);
        assert_eq!(got.len(), MAX_CONTEXT_FILES);
        assert_eq!(got[0], "f00.md");
    }
}
