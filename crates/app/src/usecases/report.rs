//! Reports from a chat (docs/telemetry.md "Report from a chat"): a problem
//! report about one conversation — a space's chat or a PR's AI panel —
//! prefilled from it. One path for everyone:
//!
//! ```text
//! "Report this" / `/report …` ──▶ draft_report ─┐
//! agent ─▶ report_problem (MCP) ──▶ draft_report ┼─▶ stored (memory) ─▶ Ephemeral::ReportDraft
//!                                                │                      └─▶ the report window
//! window ─▶ preview_issue / submit_issue { context: id } ─▶ report_context(id): read now
//! ```
//!
//! A draft only names the chat, the message (or the agent's run) and the
//! scope; the conversation is read when the window previews or posts it,
//! so a turn still running when the agent drafted shows how it ended.
//! Nothing here sends anything: only `submit_issue` does, from the window.

use std::collections::VecDeque;

use theodore_contract::{
    ChatMessage, DraftReportRequest, Ephemeral, ReportDraft, ReportScope, Space, TurnStep, models,
};
use theodore_domain::{Author, PrId};
use theodore_telemetry::issue::{ChatContext, built_at};

use crate::core::Core;
use crate::error::{AppError, AppResult};
use crate::usecases::attachments::with_attachments;
use crate::usecases::skills::{expand_skill, space_skill_content};
use crate::usecases::telemetry::wire_str;

/// Drafts kept for the window (newest last); older ones expire.
const KEEP: usize = 16;
/// The title and description an agent may prefill.
const MAX_TITLE: usize = 256;
const MAX_DESCRIPTION: usize = 20_000;

#[derive(Debug, Clone)]
struct Stored {
    draft: ReportDraft,
    /// The message it is about, when one was named.
    message: Option<String>,
    /// The agent run that drafted it (`report_problem`).
    run: Option<String>,
}

/// Drafted chat reports, in memory only: a restart forgets them.
#[derive(Default)]
pub struct ReportDrafts {
    drafts: std::sync::Mutex<VecDeque<Stored>>,
    /// Agent runs that drafted one (newest last, as many as `CLAIMS`).
    claimed: std::sync::Mutex<VecDeque<String>>,
}

/// Agent runs remembered as having drafted: far more than ever run at once.
const CLAIMS: usize = 256;

impl ReportDrafts {
    fn put(&self, s: Stored) {
        let mut q = self.drafts.lock().unwrap_or_else(|p| p.into_inner());
        q.push_back(s);
        while q.len() > KEEP {
            q.pop_front();
        }
    }

    fn get(&self, id: &str) -> Option<Stored> {
        let q = self.drafts.lock().unwrap_or_else(|p| p.into_inner());
        q.iter().find(|s| s.draft.id == id).cloned()
    }

    /// Claims the agent run `run`'s one draft: `false` when it had it.
    fn claim(&self, run: &str) -> bool {
        let mut q = self.claimed.lock().unwrap_or_else(|p| p.into_inner());
        if q.iter().any(|r| r == run) {
            return false;
        }
        q.push_back(run.to_string());
        while q.len() > CLAIMS {
            q.pop_front();
        }
        true
    }
}

/// An agent's prefill as the form shows it: redacted like the
/// conversation, and (the description) with every mention, #ref and issue
/// link made inline code — a prompt-injected agent can't make the issue
/// leak a secret or ping anyone the user didn't see.
fn agent_prefill(title: String, description: String) -> (String, String) {
    let r = theodore_telemetry::issue::redactor();
    let title = r.text(&title).replace(['\r', '\n'], " ");
    let description = theodore_telemetry::issue::quiet(&r.text(&description));
    (title, description)
}

/// What a report says about its chat, read now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatReport {
    pub context: ChatContext,
    /// The agent run whose log lines go with it, when known.
    pub run: Option<String>,
}

/// The space a chat key names (`space:<id>`), if it is one.
fn space_of(chat: &PrId) -> Option<&str> {
    chat.0.strip_prefix("space:")
}

/// The message a run id ends with: `space:<space>:<message>` and
/// `ask:<message>` both start with your message's id at the end.
fn run_message(run: &str) -> Option<&str> {
    run.rsplit(':').next().filter(|m| !m.is_empty())
}

fn clip(s: Option<String>, max: usize) -> String {
    let s = s.unwrap_or_default();
    let s = s.trim();
    match s.char_indices().nth(max) {
        Some((i, _)) => s[..i].to_string(),
        None => s.to_string(),
    }
}

/// One line per tool call, as the chat shows it.
fn tool_lines(steps: &[TurnStep]) -> Vec<String> {
    steps
        .iter()
        .filter_map(|s| match s {
            TurnStep::Tool {
                name,
                target,
                ok,
                summary,
                ..
            } => {
                let mark = match ok {
                    Some(true) => "✓",
                    Some(false) => "✗",
                    None => "…",
                };
                let mut line = format!("{mark} {name}");
                if let Some(t) = target.as_deref().filter(|t| !t.is_empty()) {
                    line.push_str(&format!(" · {t}"));
                }
                if let Some(s) = summary.as_deref().filter(|s| !s.is_empty()) {
                    line.push_str(&format!(" — {s}"));
                }
                Some(line)
            }
            _ => None,
        })
        .collect()
}

fn seconds(ms: u64) -> String {
    if ms < 1000 {
        format!("{ms} ms")
    } else {
        format!("{:.1} s", ms as f64 / 1000.0)
    }
}

/// The conversation around the report's message.
struct Found {
    space: Option<Space>,
    /// Every stored message, oldest first (queued ones left out).
    messages: Vec<ChatMessage>,
    prompt: Option<ChatMessage>,
    reply: Option<ChatMessage>,
    /// The message the report is about: the reply, or your message.
    target: Option<ChatMessage>,
    run: Option<String>,
}

impl Core {
    /// Drafts a report about a chat and opens the report window on it
    /// (`Ephemeral::ReportDraft`). `run`: the agent run that drafted it
    /// (`report_problem`) — the report is about that run's turn, even
    /// before its reply exists. Nothing is sent.
    pub async fn draft_report(
        &self,
        req: DraftReportRequest,
        run: Option<String>,
    ) -> AppResult<ReportDraft> {
        // One report window per agent turn: an agent told to call it over
        // and over (a prompt injection in the repo) opens it once.
        if let Some(r) = &run
            && !self.0.report_drafts.claim(r)
        {
            return Err(AppError::Invalid(
                "a report from this turn is already waiting for the user; don't draft another"
                    .into(),
            ));
        }
        let space = match space_of(&req.chat) {
            Some(id) => Some(self.space_row(id).await?),
            None => None,
        };
        let messages = self.report_messages(&req.chat).await?;
        if let Some(m) = &req.message
            && !messages.iter().any(|x| &x.id == m)
        {
            return Err(AppError::NotFound(format!("message {m}")));
        }
        if space.is_none() && messages.is_empty() && run.is_none() {
            return Err(AppError::Invalid("nothing in this chat to report".into()));
        }
        // A space's whole is `space`, a PR's AI panel's is `review`.
        let scope = match (req.scope.unwrap_or(ReportScope::Turn), &space) {
            (ReportScope::Review, Some(_)) => ReportScope::Space,
            (ReportScope::Space, None) => ReportScope::Review,
            (s, _) => s,
        };
        let (title, description) = (
            clip(req.title, MAX_TITLE),
            clip(req.description, MAX_DESCRIPTION),
        );
        let (title, description) = match run {
            Some(_) => agent_prefill(title, description),
            None => (title, description),
        };
        let stored = Stored {
            draft: ReportDraft {
                id: uuid::Uuid::new_v4().simple().to_string(),
                chat: req.chat.clone(),
                scope,
                title,
                description,
                include_logs: req.include_logs.unwrap_or(true),
                about: String::new(),
                by_agent: run.is_some(),
            },
            message: req.message,
            run,
        };
        let found = self.find_turn(&stored, space, messages);
        let about = about_line(&stored.draft, &found);
        let draft = ReportDraft {
            about,
            ..stored.draft.clone()
        };
        self.0.report_drafts.put(Stored {
            draft: draft.clone(),
            ..stored
        });
        tracing::info!(
            scope = wire_str(&draft.scope),
            by_agent = draft.by_agent,
            "chat report drafted"
        );
        self.emit(Ephemeral::ReportDraft {
            draft: draft.clone(),
        });
        Ok(draft)
    }

    /// The draft `id` names, if it hasn't expired.
    pub fn report_draft(&self, id: &str) -> Option<ReportDraft> {
        self.0.report_drafts.get(id).map(|s| s.draft)
    }

    /// What the report `id` says about its chat, read now: where, the
    /// agent and its CLI, the turn's prompt as sent, the reply, its tool
    /// calls, the error and timings (as its scope allows), and the run
    /// whose logs go with it. Not redacted yet: the issue body does that.
    pub async fn report_context(&self, id: &str) -> AppResult<ChatReport> {
        let stored = self
            .0
            .report_drafts
            .get(id)
            .ok_or_else(|| AppError::NotFound("that report expired; draft it again".into()))?;
        let chat = &stored.draft.chat;
        let space = match space_of(chat) {
            Some(id) => Some(self.space_row(id).await?),
            None => None,
        };
        let messages = self.report_messages(chat).await?;
        let found = self.find_turn(&stored, space, messages);
        let context = self.chat_context(&stored, &found).await;
        Ok(ChatReport {
            context,
            run: found.run,
        })
    }

    async fn report_messages(&self, chat: &PrId) -> AppResult<Vec<ChatMessage>> {
        let store = self.0.deps.store.clone();
        let key = chat.0.clone();
        let rows =
            tokio::task::spawn_blocking(move || store.query(models::CHAT_MESSAGE, "pr", &key))
                .await
                .map_err(AppError::join)??;
        let mut messages: Vec<ChatMessage> = rows
            .into_iter()
            .filter_map(|r| serde_json::from_value(r.data).ok())
            .filter(|m: &ChatMessage| !crate::usecases::space_queue::is_queued(m))
            .collect();
        messages.sort_by_key(|m| m.at);
        Ok(messages)
    }

    fn find_turn(&self, s: &Stored, space: Option<Space>, messages: Vec<ChatMessage>) -> Found {
        let by_id = |id: &str| messages.iter().find(|m| m.id == id).cloned();
        let is_agent = |m: &ChatMessage| matches!(m.author, Author::Agent(_));
        let target = match (&s.message, &s.run) {
            (Some(m), _) => by_id(m),
            // The agent's own turn: its reply, once there is one, else the
            // message that started it.
            (None, Some(run)) => messages
                .iter()
                .find(|m| m.run.as_deref() == Some(run.as_str()))
                .cloned()
                .or_else(|| run_message(run).and_then(by_id)),
            (None, None) => messages.iter().rev().find(|m| is_agent(m)).cloned(),
        };
        let log = space
            .as_ref()
            .map(|sp| sp.turn_log.as_slice())
            .unwrap_or(&[]);
        let (prompt, reply) = match &target {
            Some(t) if is_agent(t) => {
                let prompt = log
                    .iter()
                    .find(|e| e.reply == t.id)
                    .and_then(|e| by_id(&e.message))
                    .or_else(|| t.run.as_deref().and_then(run_message).and_then(by_id))
                    .or_else(|| {
                        // An older AI panel reply: the question before it.
                        messages
                            .iter()
                            .rev()
                            .filter(|m| m.at <= t.at)
                            .find(|m| matches!(m.author, Author::Me))
                            .cloned()
                    });
                (prompt, Some(t.clone()))
            }
            Some(t) => {
                let reply = log
                    .iter()
                    .find(|e| e.message == t.id)
                    .and_then(|e| by_id(&e.reply))
                    .or_else(|| {
                        messages
                            .iter()
                            .find(|m| m.run.as_deref().and_then(run_message) == Some(&t.id))
                            .cloned()
                    });
                (Some(t.clone()), reply)
            }
            None => (None, None),
        };
        let run = reply
            .as_ref()
            .and_then(|r| r.run.clone())
            .or_else(|| s.run.clone())
            .or_else(|| {
                // Older rows: a space turn's run id is its message's.
                let (sp, p) = (space.as_ref()?, prompt.as_ref()?);
                Some(format!("space:{}:{}", sp.id, p.id))
            });
        Found {
            space,
            messages,
            prompt,
            reply,
            target,
            run,
        }
    }

    async fn chat_context(&self, s: &Stored, f: &Found) -> ChatContext {
        let scope = s.draft.scope;
        let agent = f
            .reply
            .as_ref()
            .and_then(|r| match r.author {
                Author::Agent(a) => Some(a),
                _ => None,
            })
            .or_else(|| f.space.as_ref().map(|sp| sp.agent));
        let mut rows: Vec<(String, String)> = Vec::new();
        let mut row = |k: &str, v: String| rows.push((k.to_string(), v));
        row("Where", where_line(f));
        row(
            "Scope",
            match scope {
                ReportScope::Message => "this message",
                ReportScope::Turn => "this turn",
                ReportScope::Space => "the space",
                ReportScope::Review => "the AI panel",
            }
            .into(),
        );
        row(
            "Drafted by",
            if s.draft.by_agent {
                "the agent (report_problem)"
            } else {
                "you"
            }
            .into(),
        );
        if let Some(a) = agent {
            let cli = self
                .0
                .deps
                .agents
                .detect()
                .await
                .into_iter()
                .find(|i| i.id == a)
                .map(|i| match (i.installed, i.version) {
                    (true, Some(v)) => format!("{} {v}", a.as_str()),
                    (true, None) => format!("{} (version unknown)", a.as_str()),
                    _ => format!("{} not found", a.as_str()),
                })
                .unwrap_or_else(|| a.as_str().to_string());
            row("Agent CLI", cli);
            let model = f
                .reply
                .as_ref()
                .and_then(|r| r.model.clone())
                .or_else(|| f.space.as_ref().and_then(|sp| sp.model.clone()))
                .unwrap_or_else(|| "the CLI's default".into());
            row("Model", model);
            let effort = self
                .setting_string(&format!("agents.{}.effort", a.as_str()), "")
                .await;
            row(
                "Effort",
                match effort.trim() {
                    "" => "default".into(),
                    e => e.to_string(),
                },
            );
        }
        row(
            "Mode",
            match &f.space {
                Some(sp) => format!("{} (the space's now)", wire_str(&sp.mode)),
                None => "ask (read-only)".into(),
            },
        );
        if let Some(sp) = &f.space {
            row("Space status", wire_str(&sp.status));
            if scope == ReportScope::Space
                && let Some(e) = &sp.error
            {
                row("Space error", e.clone());
            }
        }
        let status = match &f.reply {
            None if f.prompt.is_some() => "no reply yet (running)".to_string(),
            None => "no reply".to_string(),
            Some(r) => match r.failed.as_deref() {
                None => "answered".into(),
                Some("stopped") => "stopped".into(),
                Some("cancelled") => "cancelled".into(),
                Some(_) => "failed".into(),
            },
        };
        row("Status", status);
        if let Some(p) = &f.prompt {
            row("Sent", built_at(p.at));
        }
        if let Some(r) = &f.reply {
            let took = r
                .duration_ms
                .or_else(|| f.prompt.as_ref().map(|p| (r.at - p.at).max(0) as u64));
            if let Some(ms) = took {
                row("Took", seconds(ms));
            }
            if !r.changed_files.is_empty() {
                row("Files changed", r.changed_files.len().to_string());
            }
            let tools = tool_lines(&r.activity).len();
            if tools > 0 {
                row("Tool calls", tools.to_string());
            }
        }
        if let Some(run) = &f.run {
            row("Run", run.clone());
        }

        let whole = matches!(scope, ReportScope::Space | ReportScope::Review);
        let message_only = scope == ReportScope::Message;
        let target_is_reply = f
            .target
            .as_ref()
            .is_some_and(|t| matches!(t.author, Author::Agent(_)));
        let prompt = (!whole && !(message_only && target_is_reply))
            .then(|| f.prompt.as_ref().map(|p| self.prompt_as_sent(p, f)))
            .flatten();
        let reply = (!whole && !(message_only && !target_is_reply))
            .then_some(f.reply.as_ref())
            .flatten();
        ChatContext {
            about: about_line(&s.draft, f),
            rows,
            prompt,
            reply: reply
                .map(|r| r.text.clone())
                .filter(|t| !t.trim().is_empty()),
            tools: reply.map(|r| tool_lines(&r.activity)).unwrap_or_default(),
            error: reply
                .and_then(|r| r.failed.clone())
                .filter(|e| e != "stopped"),
        }
    }

    /// Your message as the agent got it: a `/skill` expanded, the attached
    /// files listed (their paths, not their contents).
    fn prompt_as_sent(&self, p: &ChatMessage, f: &Found) -> String {
        let text = match &f.space {
            Some(sp) => {
                let wt = std::path::Path::new(&sp.worktree);
                let home = &self.0.deps.claude_home;
                expand_skill(&p.text, |id| space_skill_content(id, wt, home))
                    .unwrap_or_else(|| p.text.clone())
            }
            None => p.text.clone(),
        };
        with_attachments(text, &p.attachments)
    }
}

/// `Space turn 3 of 5`, `AI panel reply 2 of 4`.
fn where_line(f: &Found) -> String {
    match &f.space {
        Some(sp) => {
            let log = &sp.turn_log;
            let n = f.reply.as_ref().and_then(|r| {
                log.iter()
                    .position(|e| e.reply == r.id)
                    .map(|i| (i + 1, log.len()))
            });
            match n {
                Some((i, total)) => format!("Space turn {i} of {total}"),
                None if f.reply.is_none() && f.prompt.is_some() => {
                    format!("Space turn {} (running)", log.len() + 1)
                }
                None => "Space".into(),
            }
        }
        None => {
            let replies: Vec<&ChatMessage> = f
                .messages
                .iter()
                .filter(|m| matches!(m.author, Author::Agent(_)))
                .collect();
            match f
                .reply
                .as_ref()
                .and_then(|r| replies.iter().position(|m| m.id == r.id))
            {
                Some(i) => format!("AI panel reply {} of {}", i + 1, replies.len()),
                None => "AI panel".into(),
            }
        }
    }
}

fn about_line(d: &ReportDraft, f: &Found) -> String {
    let place = match d.scope {
        ReportScope::Space => "Space".to_string(),
        ReportScope::Review => "AI panel".to_string(),
        _ => where_line(f),
    };
    let agent = f
        .reply
        .as_ref()
        .and_then(|r| match r.author {
            Author::Agent(a) => Some(a),
            _ => None,
        })
        .or_else(|| f.space.as_ref().map(|s| s.agent));
    match agent {
        Some(a) => format!("{place} · {}", a.as_str()),
        None => place,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_id_ends_with_its_message() {
        assert_eq!(run_message("space:s1:m-1"), Some("m-1"));
        assert_eq!(run_message("ask:q-2"), Some("q-2"));
        assert_eq!(run_message("ask:"), None);
    }

    #[test]
    fn tool_calls_read_as_one_line_each() {
        let steps = vec![
            TurnStep::Text {
                text: "hi".into(),
                parent: None,
            },
            TurnStep::Tool {
                name: "Bash".into(),
                target: Some("cargo test".into()),
                ok: Some(false),
                id: None,
                parent: None,
                detail: None,
                summary: Some("3 failed".into()),
                added: None,
                removed: None,
                background: false,
            },
        ];
        assert_eq!(tool_lines(&steps), ["✗ Bash · cargo test — 3 failed"]);
    }

    #[test]
    fn prefills_are_trimmed_and_capped() {
        assert_eq!(clip(Some("  t  ".into()), 10), "t");
        assert_eq!(clip(Some("é".repeat(300)), MAX_TITLE).chars().count(), 256);
        assert_eq!(clip(None, 10), "");
    }
}
