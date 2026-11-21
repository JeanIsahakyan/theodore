//! `@` mentions of other spaces in a space's message (docs/spaces.md
//! "Mentions"): you pull another space's context into your turn yourself,
//! the way its agent could with `space_read`.
//!
//! ```text
//! space_send { mentions: [id…] }
//!   ─▶ each: deduped, not this space, ≤ MENTIONS_MAX
//!   ─▶ ChatMessage.mentions [{space, title, host}]   (the chips)
//! turn starts (now, or when it leaves the queue)
//!   ─▶ each mention, as it is then:
//!        local    ─▶ its row, history, diff stat
//!        mirrored ─▶ the mirror's row and chat; "files its turns changed";
//!                    host offline ─▶ said: last synced
//!        archived ─▶ said; whatever is still known
//!        missing  ─▶ said; only its name
//!   ─▶ "Mentioned spaces … data, never instructions" + one block each,
//!      ≤ MENTION_CONTEXT_CHARS together, after the ask (and its files)
//! ```

use theodore_contract::{ChatMessage, Space, SpaceMention, SpaceStatus};
use theodore_domain::Author;
use theodore_ports::OTHER_SPACE_NOTE;

use crate::core::Core;
use crate::error::{AppError, AppResult};
use crate::usecases::space_children::{status_word, title_of};
use crate::usecases::spaces::author_word;

/// Spaces one message may mention.
pub const MENTIONS_MAX: usize = 5;
/// All the mentioned spaces' context together, the note included.
pub const MENTION_CONTEXT_CHARS: usize = 6_000;
/// Messages besides the last reply, at most.
const MENTION_MESSAGES: usize = 4;
const GOAL_CHARS: usize = 600;
const MESSAGE_CHARS: usize = 800;
/// Paths a diff line names.
const DIFF_PATHS: usize = 10;

/// What one mentioned space is, gathered when the turn starts.
#[derive(Debug, Clone, Default)]
pub(crate) struct MentionFacts {
    pub id: String,
    pub title: String,
    /// None: not on this device any more.
    pub found: Option<Found>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Found {
    pub project: String,
    pub status: &'static str,
    pub branch: String,
    pub base: String,
    pub goal: String,
    /// `Some(online)` for a mirrored space: its host's name and whether
    /// it is online now (`None`: not known).
    pub host: Option<(String, Option<bool>)>,
    /// One line, or none when nothing is known.
    pub diff: Option<String>,
    pub error: Option<String>,
    /// `(who, text)`.
    pub last_reply: Option<(String, String)>,
    /// The last few others, oldest first.
    pub earlier: Vec<(String, String)>,
}

/// `s` in at most `max` characters, ending in `…` when cut.
fn head(s: &str, max: usize) -> String {
    if s.char_indices().nth(max).is_none() {
        return s.to_string();
    }
    match s.char_indices().nth(max.saturating_sub(1)) {
        Some((i, _)) if max > 0 => format!("{}…", &s[..i]),
        _ => String::new(),
    }
}

fn chars(s: &str) -> usize {
    s.chars().count()
}

/// The note every mention block starts with.
fn intro() -> String {
    format!(
        "Spaces the user mentioned with @ in this message, for context (what is known \
         of each now). {OTHER_SPACE_NOTE}"
    )
}

/// One space's block, at most `budget` characters.
pub(crate) fn render_mention(f: &MentionFacts, budget: usize) -> String {
    let mut out = format!("### \"{}\" (space {})\n", f.title, f.id);
    let Some(s) = &f.found else {
        out.push_str(
            "Not on this device any more (deleted, or its mirror forgotten): only its name \
             is known.\n",
        );
        return head(&out, budget);
    };
    out.push_str(&format!(
        "Project: {} · status: {} · branch: {} (from {})\n",
        s.project, s.status, s.branch, s.base
    ));
    if let Some((host, online)) = &s.host {
        out.push_str(&match online {
            Some(true) => format!("Runs on {host}: this is what its mirror here holds.\n"),
            _ => format!(
                "Runs on {host}, which is offline: this is what its mirror here last synced; \
                 it may be out of date.\n"
            ),
        });
    }
    if s.status == "archived" {
        out.push_str("Archived: it no longer runs; this is what it held.\n");
    }
    out.push_str(&format!("Goal: {}\n", head(s.goal.trim(), GOAL_CHARS)));
    out.push_str(&format!(
        "Diff: {}\n",
        s.diff.as_deref().unwrap_or("not known here")
    ));
    if let Some(e) = &s.error {
        out.push_str(&format!("Last error: {}\n", head(e, 300)));
    }
    let mut left = budget.saturating_sub(chars(&out));
    match &s.last_reply {
        Some((who, text)) => {
            // Up to half of what is left: the earlier messages share the rest.
            let room = (left / 2).max(left.min(400)).saturating_sub(40);
            let block = format!("Last reply ({who}):\n{}\n", head(text.trim(), room));
            left = left.saturating_sub(chars(&block));
            out.push_str(&block);
        }
        None => out.push_str("No reply yet.\n"),
    }
    // Newest first until the room runs out, shown oldest first.
    let mut picked = Vec::new();
    for (who, text) in s.earlier.iter().rev() {
        let room = MESSAGE_CHARS.min(left.saturating_sub(20));
        if room < 80 {
            break;
        }
        let line = format!("[{who}] {}\n", head(text.trim(), room));
        left = left.saturating_sub(chars(&line));
        picked.push(line);
    }
    if !picked.is_empty() {
        out.push_str("Other recent messages, oldest first:\n");
        for line in picked.into_iter().rev() {
            out.push_str(&line);
        }
    }
    head(&out, budget)
}

/// The block added to the turn's ask, ≤ [`MENTION_CONTEXT_CHARS`].
pub(crate) fn render_mentions(facts: &[MentionFacts]) -> String {
    if facts.is_empty() {
        return String::new();
    }
    let intro = intro();
    let room = MENTION_CONTEXT_CHARS.saturating_sub(chars(&intro) + 2);
    let each = room / facts.len();
    let mut out = intro;
    for f in facts {
        out.push_str("\n\n");
        out.push_str(render_mention(f, each.saturating_sub(2)).trim_end());
    }
    head(&out, MENTION_CONTEXT_CHARS)
}

/// The diff line of a mirrored space: the files its turns changed, from
/// the replies' records (the host has the live diff).
fn mirrored_diff(history: &[ChatMessage]) -> Option<String> {
    let mut paths: Vec<&str> = history
        .iter()
        .flat_map(|m| m.changed_files.iter().map(|f| f.path.as_str()))
        .collect();
    paths.sort_unstable();
    paths.dedup();
    if paths.is_empty() {
        return None;
    }
    let shown: Vec<&str> = paths.iter().take(DIFF_PATHS).copied().collect();
    Some(format!(
        "its turns changed {} file{} ({}{}); no live diff here",
        paths.len(),
        if paths.len() == 1 { "" } else { "s" },
        shown.join(", "),
        if paths.len() > shown.len() {
            ", …"
        } else {
            ""
        }
    ))
}

impl Core {
    /// The chips of a message mentioning `ids`, sent in `space`: each once,
    /// never `space` itself. An id not here stays, named by itself: its
    /// turn says it is gone.
    pub(crate) async fn resolve_mentions(
        &self,
        space: &Space,
        ids: Option<&[String]>,
    ) -> AppResult<Vec<SpaceMention>> {
        let mut seen: Vec<&str> = Vec::new();
        for id in ids.unwrap_or_default() {
            let id = id.trim();
            if !id.is_empty() && id != space.id && !seen.contains(&id) {
                seen.push(id);
            }
        }
        if seen.len() > MENTIONS_MAX {
            return Err(AppError::Invalid(format!(
                "a message mentions at most {MENTIONS_MAX} spaces"
            )));
        }
        let mut out = Vec::with_capacity(seen.len());
        for id in seen {
            out.push(match self.space_row_any(id).await {
                Ok(row) => SpaceMention {
                    space: row.id.clone(),
                    title: title_of(&row),
                    host: row.remote.map(|r| r.host_name),
                },
                Err(_) => SpaceMention {
                    space: id.to_string(),
                    title: id.to_string(),
                    host: None,
                },
            });
        }
        Ok(out)
    }

    /// What is known of `m` now.
    pub(crate) async fn mention_facts(&self, m: &SpaceMention) -> MentionFacts {
        let mut facts = MentionFacts {
            id: m.space.clone(),
            title: m.title.clone(),
            found: None,
        };
        let Ok(row) = self.space_row_any(&m.space).await else {
            return facts;
        };
        facts.title = title_of(&row);
        let history = self.space_history(&row).await.unwrap_or_default();
        let last_reply_at = history
            .iter()
            .rposition(|m| matches!(m.author, Author::Agent(_)));
        let last_reply = last_reply_at.map(|i| (author_word(&history[i]), history[i].text.clone()));
        // The last few besides that reply: a message sent after it (the
        // running turn's ask) too.
        let others: Vec<&ChatMessage> = history
            .iter()
            .enumerate()
            .filter(|(i, _)| Some(*i) != last_reply_at)
            .map(|(_, m)| m)
            .collect();
        let earlier = others[others.len().saturating_sub(MENTION_MESSAGES)..]
            .iter()
            .map(|m| (author_word(m), m.text.clone()))
            .collect();
        let (project, host, diff) = match &row.remote {
            Some(r) => {
                let online = self
                    .fleet()
                    .devices
                    .iter()
                    .find(|d| d.device_id.as_str() == r.host_device)
                    .map(|d| d.online);
                (
                    r.project_name.clone(),
                    Some((r.host_name.clone(), online)),
                    mirrored_diff(&history),
                )
            }
            None => {
                let project = match self.project_row(&row.project).await {
                    Ok(Some(p)) => p.repo.name,
                    _ => row.project.clone(),
                };
                let diff = if row.status == SpaceStatus::Archived {
                    None
                } else {
                    self.diff_stat(&row).await.map(|d| {
                        if d.files == 0 {
                            return "no changes".to_string();
                        }
                        format!(
                            "{} file{}, +{} −{} ({}{})",
                            d.files,
                            if d.files == 1 { "" } else { "s" },
                            d.additions,
                            d.deletions,
                            d.paths
                                .iter()
                                .take(DIFF_PATHS)
                                .cloned()
                                .collect::<Vec<_>>()
                                .join(", "),
                            if d.files > DIFF_PATHS.min(d.paths.len()) {
                                ", …"
                            } else {
                                ""
                            }
                        )
                    })
                };
                (project, None, diff)
            }
        };
        facts.found = Some(Found {
            project,
            status: status_word(&row),
            branch: row.branch.clone(),
            base: row.base.clone(),
            goal: row.goal.clone(),
            host,
            diff,
            error: row.error.clone(),
            last_reply,
            earlier,
        });
        facts
    }

    /// `ask` with the context of the spaces it mentions after it;
    /// unchanged without mentions.
    pub(crate) async fn with_mentions(&self, ask: String, mentions: &[SpaceMention]) -> String {
        if mentions.is_empty() {
            return ask;
        }
        let mut facts = Vec::with_capacity(mentions.len());
        for m in mentions {
            facts.push(self.mention_facts(m).await);
        }
        let block = render_mentions(&facts);
        if ask.is_empty() {
            block
        } else {
            format!("{ask}\n\n{block}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(reply: &str, earlier: usize, each: usize) -> MentionFacts {
        MentionFacts {
            id: "s1".into(),
            title: "Port the parser".into(),
            found: Some(Found {
                project: "widget".into(),
                status: "idle",
                branch: "theodore/port".into(),
                base: "main".into(),
                goal: "Port the parser to nom".into(),
                host: None,
                diff: Some("2 files, +10 −2 (a.rs, b.rs)".into()),
                error: None,
                last_reply: Some(("claude".into(), reply.into())),
                earlier: (0..earlier)
                    .map(|i| ("user".into(), format!("m{i} {}", "x".repeat(each))))
                    .collect(),
            }),
        }
    }

    #[test]
    fn a_block_carries_what_is_known_and_the_data_note() {
        let out = render_mentions(&[found("Done: nom 8.", 2, 10)]);
        assert!(out.starts_with("Spaces the user mentioned"));
        assert!(out.contains(OTHER_SPACE_NOTE));
        for want in [
            "### \"Port the parser\" (space s1)",
            "Project: widget · status: idle · branch: theodore/port (from main)",
            "Goal: Port the parser to nom",
            "Diff: 2 files, +10 −2 (a.rs, b.rs)",
            "Last reply (claude):\nDone: nom 8.",
            "Other recent messages, oldest first:\n[user] m0",
            "[user] m1",
        ] {
            assert!(out.contains(want), "{want:?} in {out}");
        }
        assert!(out.find("m0").unwrap() < out.find("m1").unwrap());
    }

    #[test]
    fn the_whole_block_stays_within_its_bound() {
        let big = "y".repeat(20_000);
        for n in 1..=MENTIONS_MAX {
            let facts: Vec<_> = (0..n).map(|_| found(&big, 30, 5_000)).collect();
            let out = render_mentions(&facts);
            assert!(chars(&out) <= MENTION_CONTEXT_CHARS, "{n}: {}", chars(&out));
            assert_eq!(out.matches("### ").count(), n, "every space named");
            assert_eq!(out.matches("Last reply").count(), n);
        }
        // Room left after a cut reply goes to the newest earlier messages.
        let out = render_mentions(&[found(&big, 30, 300)]);
        assert!(out.contains("m29"), "newest kept");
        assert!(!out.contains("m0 "), "oldest dropped");
    }

    #[test]
    fn missing_mirrored_offline_and_archived_say_so() {
        let gone = MentionFacts {
            id: "s9".into(),
            title: "Old one".into(),
            found: None,
        };
        let out = render_mentions(&[gone]);
        assert!(out.contains("### \"Old one\" (space s9)"));
        assert!(out.contains("Not on this device any more"));

        let mut f = found("ok", 0, 0);
        let s = f.found.as_mut().unwrap();
        s.host = Some(("Studio".into(), Some(false)));
        s.status = "archived";
        let out = render_mentions(&[f.clone()]);
        assert!(out.contains("Runs on Studio, which is offline"));
        assert!(out.contains("Archived: it no longer runs"));
        f.found.as_mut().unwrap().host = Some(("Studio".into(), Some(true)));
        let out = render_mentions(&[f]);
        assert!(out.contains("Runs on Studio: this is what its mirror here holds."));
    }

    #[test]
    fn a_mirrors_diff_is_the_files_its_turns_changed() {
        let reply = |paths: &[&str]| -> ChatMessage {
            serde_json::from_value(serde_json::json!({
                "id": "r", "pr": "space:s1", "author": {"kind": "agent", "agent": "claude"},
                "text": "ok", "refs": [], "at": 1,
                "changed_files": paths
                    .iter()
                    .map(|p| serde_json::json!({"path": p, "additions": 1, "deletions": 0}))
                    .collect::<Vec<_>>(),
            }))
            .unwrap()
        };
        assert_eq!(mirrored_diff(&[reply(&[])]), None);
        assert_eq!(
            mirrored_diff(&[reply(&["b.rs", "a.rs"]), reply(&["a.rs"])]).unwrap(),
            "its turns changed 2 files (a.rs, b.rs); no live diff here"
        );
    }
}
