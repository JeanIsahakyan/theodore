//! `list_skills` (plan §8.4): skills from `~/.claude/skills`, the open PR's
//! own `.claude/skills`, and a few built-in review skills shipped as files
//! in `crates/app/skills/`. Claude discovers the first two on its own; the
//! built-ins and every other agent need the `SKILL.md` text inlined into
//! the prompt (`usecases::agents::skill_prompt`).

use std::path::Path;

use theodore_contract::{Ephemeral, SaveSkillRequest, SkillBody, SkillInfo, ToastLevel};
use theodore_domain::PrId;

use crate::core::Core;
use crate::error::{AppError, AppResult};

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
/// Handles the YAML shapes skill files actually use: plain and quoted
/// scalars, and block scalars (`>`, `>-`, `|`, `|-`) whose text sits on the
/// indented lines below the key.
fn front_matter(text: &str) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut description = None;
    let mut lines = text.lines().peekable();
    if lines.next().map(str::trim_end) != Some("---") {
        return (name, description);
    }
    while let Some(line) = lines.next() {
        if line.trim_end() == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.starts_with([' ', '\t']) {
            continue;
        }
        let value = value.trim();
        let value = if value.starts_with(['>', '|']) {
            let folded = value.starts_with('>');
            let mut parts = Vec::new();
            while let Some(next) = lines.peek() {
                let indented = next.starts_with([' ', '\t']) || next.trim().is_empty();
                if next.trim_end() == "---" || !indented {
                    break;
                }
                parts.push(next.trim());
                lines.next();
            }
            let sep = if folded { " " } else { "\n" };
            parts
                .into_iter()
                .filter(|p| !folded || !p.is_empty())
                .collect::<Vec<_>>()
                .join(sep)
                .trim()
                .to_string()
        } else {
            unquote(value).to_string()
        };
        match key.trim() {
            "name" => name = Some(value),
            "description" => description = Some(value),
            _ => {}
        }
    }
    (name, description)
}

fn unquote(v: &str) -> &str {
    for q in ['"', '\''] {
        if let Some(inner) = v.strip_prefix(q).and_then(|v| v.strip_suffix(q)) {
            return inner;
        }
    }
    v
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

pub(crate) fn builtin_content(id: &str) -> Option<&'static str> {
    BUILTINS.iter().find(|b| b.id == id).map(|b| b.content)
}

/// A skill id is one path component: letters, digits, `-`, `_`, `.`, not
/// starting with `.`. It is joined into filesystem paths, so anything else
/// (`/`, `..`) would escape the skills directory.
pub(crate) fn is_valid_skill_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && !id.starts_with('.')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn check_skill_id(id: &str) -> AppResult<()> {
    if is_valid_skill_id(id) {
        Ok(())
    } else {
        Err(AppError::Invalid(format!("invalid skill id {id:?}")))
    }
}

/// Loads a skill's full `SKILL.md` text, for inlining into a non-Claude
/// agent's prompt: built-ins first, then `claude_home`, then the PR
/// worktree's own `.claude/skills`.
pub(crate) fn resolve_skill_content(
    id: &str,
    worktree: &Path,
    claude_home: &Path,
) -> Option<String> {
    if let Some(c) = builtin_content(id) {
        return Some(c.to_string());
    }
    if !is_valid_skill_id(id) {
        return None;
    }
    if let Ok(s) = std::fs::read_to_string(claude_home.join(id).join("SKILL.md")) {
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

        out.extend(skills_in_dir(&self.0.deps.claude_home, "~/.claude/skills"));

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

    /// `SKILL.md` text for `id`, in precedence order: built-in (read-only),
    /// `~/.claude/skills`, then the open PR's own `.claude/skills`.
    pub async fn get_skill(&self, id: &str, pr: Option<PrId>) -> AppResult<SkillBody> {
        if let Some(content) = builtin_content(id) {
            return Ok(SkillBody {
                info: skill_info(id, content, "built-in"),
                body: content.to_string(),
                editable: false,
            });
        }
        check_skill_id(id)?;
        let path = self.0.deps.claude_home.join(id).join("SKILL.md");
        if let Ok(content) = tokio::fs::read_to_string(&path).await {
            return Ok(SkillBody {
                info: skill_info(id, &content, "~/.claude/skills"),
                body: content,
                editable: true,
            });
        }
        if let Some(pr) = pr {
            let worktree = self.worktree_of(&pr).await;
            let pr_ref = self.pr_ref(&pr).await;
            if let (Some(worktree), Some(pr_ref)) = (worktree, pr_ref) {
                let path = worktree.join(".claude/skills").join(id).join("SKILL.md");
                if let Ok(content) = tokio::fs::read_to_string(&path).await {
                    let source = format!("{} · .claude/skills", pr_ref.repo.slug());
                    return Ok(SkillBody {
                        info: skill_info(id, &content, &source),
                        body: content,
                        editable: true,
                    });
                }
            }
        }
        Err(AppError::NotFound(format!("skill {id}")))
    }

    /// Writes a user skill to `~/.claude/skills/<id>/SKILL.md`, or a repo
    /// skill into the PR worktree's own `.claude/skills/<id>/SKILL.md` —
    /// never committed or pushed; the toast makes that explicit since
    /// `SkillInfo` has no field for it.
    pub async fn save_skill(&self, req: SaveSkillRequest) -> AppResult<SkillInfo> {
        check_skill_id(&req.id)?;
        match req.scope.as_str() {
            "user" => {
                let dir = self.0.deps.claude_home.join(&req.id);
                tokio::fs::create_dir_all(&dir)
                    .await
                    .map_err(|e| AppError::Invalid(e.to_string()))?;
                tokio::fs::write(dir.join("SKILL.md"), &req.body)
                    .await
                    .map_err(|e| AppError::Invalid(e.to_string()))?;
                Ok(skill_info(&req.id, &req.body, "~/.claude/skills"))
            }
            "repo" => {
                let pr = req
                    .pr
                    .clone()
                    .ok_or_else(|| AppError::Invalid("a repo-scoped skill needs a pr".into()))?;
                let worktree = self
                    .worktree_of(&pr)
                    .await
                    .ok_or_else(|| AppError::Invalid("pr is not open".into()))?;
                let pr_ref = self
                    .pr_ref(&pr)
                    .await
                    .ok_or_else(|| AppError::NotFound(format!("pr {pr}")))?;
                let dir = worktree.join(".claude/skills").join(&req.id);
                tokio::fs::create_dir_all(&dir)
                    .await
                    .map_err(|e| AppError::Invalid(e.to_string()))?;
                tokio::fs::write(dir.join("SKILL.md"), &req.body)
                    .await
                    .map_err(|e| AppError::Invalid(e.to_string()))?;
                let source = format!("{} · .claude/skills", pr_ref.repo.slug());
                self.emit(Ephemeral::Toast {
                    level: ToastLevel::Info,
                    text: format!(
                        "saved to the {} worktree only — commit and push it yourself to share",
                        pr_ref.repo.slug()
                    ),
                });
                Ok(skill_info(&req.id, &req.body, &source))
            }
            other => Err(AppError::Invalid(format!("unknown skill scope {other}"))),
        }
    }
}

#[cfg(test)]
mod front_matter_tests {
    use super::front_matter;

    #[test]
    fn reads_plain_quoted_and_block_scalars() {
        let plain = "---\nname: bugs\ndescription: Find bugs\n---\nbody";
        assert_eq!(
            front_matter(plain),
            (Some("bugs".into()), Some("Find bugs".into()))
        );

        let quoted = "---\nname: 'x'\ndescription: \"Say: hi\"\n---\n";
        assert_eq!(
            front_matter(quoted),
            (Some("x".into()), Some("Say: hi".into()))
        );

        let folded = "---\nname: autopilot\ndescription: >-\n  Drives the review\n  end to end.\nmodel: opus\n---\n";
        assert_eq!(
            front_matter(folded),
            (
                Some("autopilot".into()),
                Some("Drives the review end to end.".into())
            )
        );

        let literal = "---\ndescription: |\n  line one\n  line two\n---\n";
        assert_eq!(front_matter(literal).1, Some("line one\nline two".into()));
    }
}

#[cfg(test)]
mod skill_id_tests {
    use super::is_valid_skill_id;

    #[test]
    fn rejects_path_escapes() {
        for bad in [
            "",
            "..",
            "../x",
            "a/b",
            "a\\b",
            ".hidden",
            "../../Library/LaunchAgents/x",
        ] {
            assert!(!is_valid_skill_id(bad), "{bad}");
        }
        for ok in ["bugs", "security-review", "my_skill.v2"] {
            assert!(is_valid_skill_id(ok), "{ok}");
        }
    }
}
