//! `list_skills` (plan §8.4): skills from `~/.claude/skills`, the open PR's
//! own `.claude/skills`, and a few built-in review skills shipped as files
//! in `crates/app/skills/`. Claude discovers the first two on its own; the
//! built-ins and every other agent need the `SKILL.md` text inlined into
//! the prompt (`usecases::agents::skill_prompt`).

use std::path::{Path, PathBuf};

use theodore_contract::SkillInfo;
use theodore_domain::PrId;

use crate::core::Core;
use crate::error::AppResult;

struct Builtin {
    id: &'static str,
    content: &'static str,
}

const BUILTINS: &[Builtin] = &[
    Builtin {
        id: "bugs",
        content: include_str!("../../skills/bugs/SKILL.md"),
    },
    Builtin {
        id: "security",
        content: include_str!("../../skills/security/SKILL.md"),
    },
    Builtin {
        id: "tests",
        content: include_str!("../../skills/tests/SKILL.md"),
    },
];

/// Front matter `name`/`description` (`---\nname: ...\ndescription: ...\n---`).
fn front_matter(text: &str) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut description = None;
    let mut lines = text.lines();
    if lines.next() != Some("---") {
        return (name, description);
    }
    for line in lines {
        if line == "---" {
            break;
        }
        if let Some(v) = line.strip_prefix("name:") {
            name = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("description:") {
            description = Some(v.trim().to_string());
        }
    }
    (name, description)
}

fn skill_info(id: &str, content: &str, source: &str) -> SkillInfo {
    let (name, description) = front_matter(content);
    SkillInfo {
        id: id.to_string(),
        title: name.unwrap_or_else(|| id.to_string()),
        description: description.unwrap_or_default(),
        source: source.to_string(),
    }
}

/// Every `<root>/*/SKILL.md`.
fn skills_in_dir(root: &Path, source: &str) -> Vec<SkillInfo> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return out;
    };
    for entry in entries.flatten() {
        let Some(id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let path = entry.path().join("SKILL.md");
        if let Ok(content) = std::fs::read_to_string(&path) {
            out.push(skill_info(&id, &content, source));
        }
    }
    out
}

fn home_skills_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude/skills"))
}

pub(crate) fn builtin_content(id: &str) -> Option<&'static str> {
    BUILTINS.iter().find(|b| b.id == id).map(|b| b.content)
}

/// Loads a skill's full `SKILL.md` text, for inlining into a non-Claude
/// agent's prompt: built-ins first, then `~/.claude/skills`, then the PR
/// worktree's own `.claude/skills`.
pub(crate) fn resolve_skill_content(id: &str, worktree: &Path) -> Option<String> {
    if let Some(c) = builtin_content(id) {
        return Some(c.to_string());
    }
    if let Some(dir) = home_skills_dir()
        && let Ok(s) = std::fs::read_to_string(dir.join(id).join("SKILL.md"))
    {
        return Some(s);
    }
    std::fs::read_to_string(worktree.join(".claude/skills").join(id).join("SKILL.md")).ok()
}

impl Core {
    pub async fn list_skills(&self, pr: Option<PrId>) -> AppResult<Vec<SkillInfo>> {
        let mut out: Vec<SkillInfo> = BUILTINS
            .iter()
            .map(|b| skill_info(b.id, b.content, "built-in"))
            .collect();

        if let Some(dir) = home_skills_dir() {
            out.extend(skills_in_dir(&dir, "~/.claude/skills"));
        }

        if let Some(pr) = pr {
            let worktree = {
                let head = self.0.current_head.read().await.get(&pr).cloned();
                match head {
                    Some(head) => self
                        .0
                        .revisions
                        .read()
                        .await
                        .get(&(pr.clone(), head))
                        .map(|e| e.worktree_path.clone()),
                    None => None,
                }
            };
            if let (Some(worktree), Some(pr_ref)) = (worktree, self.pr_ref(&pr).await) {
                let source = format!("{} · .claude/skills", pr_ref.repo.slug());
                out.extend(skills_in_dir(&worktree.join(".claude/skills"), &source));
            }
        }

        Ok(out)
    }
}
