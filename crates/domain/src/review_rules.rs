//! The project config's `review:` rules (docs/config.md §1), as the parts
//! of the app that apply them see them: already merged across the layers,
//! `context` already resolved against the checkout.
//!
//! ```text
//! instructions, context ─▶ system_note ─▶ every agent run's system prompt
//! hide, skim            ─▶ grouping pre-pass (Hidden group, skim hints)
//! checklist             ─▶ apply_checklist, after grouping
//! ignore_findings       ─▶ ignores_finding, when a finding is added
//! hide, skim, checklist ─▶ grouping_hash, stored with the grouping
//! ```

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use crate::glob::glob_match;
use crate::model::{Grouping, HunkId, Revision};

/// Context files named in a prompt, at most.
pub const MAX_CONTEXT_FILES: usize = 20;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReviewRules {
    pub instructions: Option<String>,
    /// Repo-relative files the agent is told to read first (resolved,
    /// existing, at most [`MAX_CONTEXT_FILES`]).
    pub context: Vec<String>,
    pub hide: Vec<String>,
    pub skim: Vec<String>,
    /// `(glob, item)`, globs in sorted order, each glob's items as listed.
    pub checklist: Vec<(String, String)>,
    pub ignore_findings: Vec<String>,
}

fn any_match(globs: &[String], path: &str) -> bool {
    globs.iter().any(|g| glob_match(g, path))
}

impl ReviewRules {
    pub fn hides(&self, path: &str) -> bool {
        any_match(&self.hide, path)
    }

    pub fn skims(&self, path: &str) -> bool {
        any_match(&self.skim, path)
    }

    pub fn ignores_finding(&self, path: &str) -> bool {
        any_match(&self.ignore_findings, path)
    }

    /// Checklist items for a set of paths: config order, no duplicates.
    pub fn checklist_for<'a>(
        &self,
        paths: impl IntoIterator<Item = &'a str> + Clone,
    ) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for (glob, item) in &self.checklist {
            if out.contains(item) {
                continue;
            }
            if paths.clone().into_iter().any(|p| glob_match(glob, p)) {
                out.push(item.clone());
            }
        }
        out
    }

    /// Appends each group's checklist items (for the files it holds) to
    /// its "What to check" list, skipping items it already has.
    pub fn apply_checklist(&self, grouping: &mut Grouping, rev: &Revision) {
        if self.checklist.is_empty() {
            return;
        }
        let path_of: BTreeMap<&HunkId, &str> = rev
            .files
            .iter()
            .flat_map(|f| f.hunks.iter().map(move |h| (&h.id, f.path.as_str())))
            .collect();
        for group in &mut grouping.groups {
            let mut paths: Vec<&str> = group
                .hunks
                .iter()
                .filter_map(|h| path_of.get(h).copied())
                .collect();
            paths.sort_unstable();
            paths.dedup();
            for item in self.checklist_for(paths.iter().copied()) {
                if !group.check.contains(&item) {
                    group.check.push(item);
                }
            }
        }
    }

    /// A hash of what changes a grouping (`hide`, `skim`, `checklist`);
    /// `None` when none is set, so groupings made before the config (or
    /// without one) aren't redone.
    pub fn grouping_hash(&self) -> Option<String> {
        if self.hide.is_empty() && self.skim.is_empty() && self.checklist.is_empty() {
            return None;
        }
        let canonical = serde_json::json!({
            "hide": self.hide,
            "skim": self.skim,
            "checklist": self.checklist,
        });
        let mut h = Sha256::new();
        h.update(canonical.to_string().as_bytes());
        Some(hex::encode(h.finalize()))
    }

    /// The repo's instructions and context files, as a system prompt
    /// section; `None` when neither is set.
    pub fn system_note(&self) -> Option<String> {
        let instructions = self
            .instructions
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if instructions.is_none() && self.context.is_empty() {
            return None;
        }
        let mut out = String::from("## This repository's review config\n");
        if let Some(text) = instructions {
            out.push_str("\nInstructions from the repository:\n");
            out.push_str(text);
            out.push('\n');
        }
        if !self.context.is_empty() {
            out.push_str("\nRead these files first (paths relative to the repository root):\n");
            for path in self.context.iter().take(MAX_CONTEXT_FILES) {
                out.push_str("- ");
                out.push_str(path);
                out.push('\n');
            }
        }
        Some(out)
    }

    /// `system` with [`Self::system_note`] appended.
    pub fn with_system(&self, system: Option<String>) -> Option<String> {
        match (system, self.system_note()) {
            (s, None) => s,
            (None, Some(note)) => Some(note),
            (Some(s), Some(note)) => Some(format!("{s}\n\n{note}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{FileDiff, FileStatus, Group, GroupId, GroupKind, Hunk, Sha};

    fn hunk(id: &str) -> Hunk {
        Hunk {
            id: HunkId::new(id),
            path: String::new(),
            old_start: 1,
            old_lines: 1,
            new_start: 1,
            new_lines: 1,
            header: String::new(),
            lines: vec![],
        }
    }

    fn file(path: &str, hunks: &[&str]) -> FileDiff {
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
            hunks: hunks.iter().map(|h| hunk(h)).collect(),
        }
    }

    fn group(id: &str, hunks: &[&str], check: &[&str]) -> Group {
        Group {
            id: GroupId::new(id),
            title: id.into(),
            why: String::new(),
            kind: GroupKind::Normal,
            risk: None,
            check: check.iter().map(|s| s.to_string()).collect(),
            hunks: hunks.iter().map(|h| HunkId::new(*h)).collect(),
            outliers: vec![],
        }
    }

    #[test]
    fn checklist_items_go_to_the_groups_holding_matching_files() {
        let rev = Revision {
            base: Sha::new("b"),
            head: Sha::new("h"),
            files: vec![
                file("migrations/001.sql", &["m1"]),
                file("api/users.rs", &["a1", "a2"]),
                file("ui/app.tsx", &["u1"]),
            ],
        };
        let mut g = Grouping {
            rev: Sha::new("h"),
            groups: vec![
                group("db", &["m1", "a1"], &["Is there a down migration?"]),
                group("api", &["a2"], &[]),
                group("ui", &["u1"], &["existing"]),
            ],
        };
        let rules = ReviewRules {
            checklist: vec![
                ("api/**".into(), "Is the change versioned?".into()),
                ("api/**".into(), "Are the docs updated?".into()),
                ("migrations/**".into(), "Is there a down migration?".into()),
            ],
            ..ReviewRules::default()
        };
        rules.apply_checklist(&mut g, &rev);
        assert_eq!(
            g.groups[0].check,
            vec![
                "Is there a down migration?",
                "Is the change versioned?",
                "Are the docs updated?"
            ]
        );
        assert_eq!(
            g.groups[1].check,
            vec!["Is the change versioned?", "Are the docs updated?"]
        );
        assert_eq!(g.groups[2].check, vec!["existing"]);
        // Applying twice changes nothing.
        let once = g.clone();
        rules.apply_checklist(&mut g, &rev);
        assert_eq!(g, once);
    }

    #[test]
    fn the_grouping_hash_covers_only_what_changes_a_grouping() {
        let none = ReviewRules {
            instructions: Some("be nice".into()),
            context: vec!["README.md".into()],
            ignore_findings: vec!["vendor/**".into()],
            ..ReviewRules::default()
        };
        assert_eq!(none.grouping_hash(), None);
        let a = ReviewRules {
            hide: vec!["gen/**".into()],
            ..none.clone()
        };
        let b = ReviewRules {
            instructions: None,
            ..a.clone()
        };
        let c = ReviewRules {
            skim: vec!["*.snap".into()],
            ..a.clone()
        };
        assert!(a.grouping_hash().is_some());
        assert_eq!(a.grouping_hash(), b.grouping_hash());
        assert_ne!(a.grouping_hash(), c.grouping_hash());
    }

    #[test]
    fn the_system_note_names_instructions_and_context_files() {
        assert_eq!(ReviewRules::default().system_note(), None);
        assert_eq!(
            ReviewRules::default().with_system(Some("base".into())),
            Some("base".into())
        );
        let rules = ReviewRules {
            instructions: Some("Flag any new dependency.".into()),
            context: vec!["docs/architecture.md".into(), "AGENTS.md".into()],
            ..ReviewRules::default()
        };
        let s = rules.with_system(Some("base".into())).unwrap();
        assert!(s.starts_with("base\n\n"));
        assert!(s.contains("Flag any new dependency."));
        assert!(s.contains("Read these files first"));
        assert!(s.contains("- docs/architecture.md\n- AGENTS.md"));
    }

    #[test]
    fn globs_decide_hide_skim_and_ignored_findings() {
        let rules = ReviewRules {
            hide: vec!["gen/**".into()],
            skim: vec!["*.snap".into()],
            ignore_findings: vec!["vendor/**".into()],
            ..ReviewRules::default()
        };
        assert!(rules.hides("gen/a.ts") && !rules.hides("src/a.ts"));
        assert!(rules.skims("a/b.snap") && !rules.skims("a/b.rs"));
        assert!(rules.ignores_finding("vendor/x/y.go") && !rules.ignores_finding("src/y.go"));
    }
}
