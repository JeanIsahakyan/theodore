//! Spaces (docs/spaces.md): the stage before a pull request. A space is a
//! detached worktree of a project's cache with its checkpoints on
//! `refs/theodore/spaces/<id>`; each chat message runs one agent turn in
//! it, the turn ends in a checkpoint commit, and the branch review of
//! `base...checkpoint` (the `open_branch` plumbing) is the live diff and the
//! grouped Review.

use std::path::{Path, PathBuf};

use theodore_contract::{
    ChatMessage, CreateSpaceRequest, Ephemeral, OpenPrResponse, Project, Space, SpaceMode,
    SpaceReviewRequest, SpaceSendRequest, SpaceStatus, ToastLevel, models,
};
use theodore_domain::{AgentId, Author, PrId, PrRef, Usage};
use theodore_ports::{
    AgentEvent, AgentMode, AgentRequest, NewAction, SPACE_REF_PREFIX, SyncActionCode, space_ref,
};
use tokio_util::sync::CancellationToken;

use crate::core::{Core, RunHandle};
use crate::error::{AppError, AppResult};
use crate::usecases::projects::stable_hash_u32;

/// The `chat_message.pr` key a space's transcript is stored under.
pub fn space_chat_key(space: &str) -> PrId {
    PrId(format!("space:{space}"))
}

/// The per-space spend limit (USD); unset = no limit.
pub(crate) const SPACE_BUDGET_KEY: &str = "budget.per_space_usd";

/// Messages of history replayed into each turn (the CLIs are spawned fresh
/// per turn; docs/spaces.md §5 "Resume").
const HISTORY_MESSAGES: usize = 12;
/// Per replayed message.
const HISTORY_CHARS: usize = 2_000;

impl Core {
    pub async fn create_space(&self, req: CreateSpaceRequest) -> AppResult<Space> {
        let project = self
            .project_row(&req.project)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("project {}", req.project)))?;
        let base = req
            .base
            .clone()
            .or_else(|| project.default_branch.clone())
            .ok_or_else(|| {
                AppError::Invalid(format!("project {} has no default branch yet", project.id))
            })?;
        let name = match req.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            Some(n) => n.to_string(),
            None => slug(&req.goal),
        };
        let branch = match req.branch.clone() {
            Some(b) => b,
            None => {
                // Named after you on the host (docs/spaces.md §12); a local
                // folder, or a host we can't reach, gets `space/<slug>`.
                let login = match project.path {
                    Some(_) => None,
                    None => self
                        .0
                        .deps
                        .host
                        .viewer_for(project.repo.host)
                        .await
                        .ok()
                        .map(|p| p.login),
                };
                crate::usecases::ship::branch_for(login.as_deref(), &slug(&name))
            }
        };
        if !is_valid_branch(&branch) {
            return Err(AppError::Invalid(format!("bad branch name {branch:?}")));
        }
        let agent = match req.agent {
            Some(a) => a,
            None => {
                let configured = self
                    .setting_agent_scoped(
                        "agents.chat",
                        Some(&project.repo.slug()),
                        AgentId::Claude,
                    )
                    .await;
                self.effective_agent(configured).await
            }
        };

        let repo_path = self.ensure_project_cache(&project).await?;
        let base_sha = self.0.deps.git.resolve_ref(&repo_path, &base).await?;
        let id = new_space_id();
        let wt = self
            .0
            .deps
            .git
            .space_worktree(&repo_path, &id, &base_sha)
            .await?;

        let now = self.0.deps.clock.now();
        let space = Space {
            id: id.clone(),
            project: project.id.clone(),
            name,
            goal: req.goal.trim().to_string(),
            branch,
            base,
            base_sha,
            head_sha: wt.head,
            worktree: wt.path.display().to_string(),
            status: SpaceStatus::Idle,
            agent,
            model: req.model.clone(),
            mode: SpaceMode::Edit,
            review_pr: None,
            pr: None,
            usage: Usage::default(),
            turns: 0,
            run: None,
            error: None,
            shipped: None,
            done_at: None,
            created_at: now,
            updated_at: now,
        };
        self.apply(vec![NewAction {
            model: models::SPACE.into(),
            model_id: id.clone(),
            action: SyncActionCode::I,
            data: Some(to_json(&space)?),
        }])
        .await?;

        // The empty diff exists from the start, so the page has a review id.
        self.space_review(SpaceReviewRequest {
            space: id.clone(),
            group: false,
        })
        .await?;

        if !space.goal.is_empty() {
            self.space_send(SpaceSendRequest {
                space: id.clone(),
                text: space.goal.clone(),
                agent: None,
                model: None,
                mode: None,
            })
            .await?;
        }
        self.space_row(&id).await
    }

    /// Every space, or one project's; newest activity first.
    pub async fn list_spaces(&self, project: Option<String>) -> AppResult<Vec<Space>> {
        let store = self.0.deps.store.clone();
        let rows = tokio::task::spawn_blocking(move || store.all(models::SPACE))
            .await
            .map_err(AppError::join)??;
        let mut spaces: Vec<Space> = rows
            .into_iter()
            .filter_map(|r| serde_json::from_value(r.data).ok())
            .filter(|s: &Space| project.as_ref().is_none_or(|p| &s.project == p))
            .collect();
        spaces.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
        Ok(spaces)
    }

    /// Stores the message and starts one agent turn in the space's worktree.
    /// Returns the message id; the reply arrives as a `chat_message` row.
    pub async fn space_send(&self, req: SpaceSendRequest) -> AppResult<String> {
        let space = self.space_row(&req.space).await?;
        match space.status {
            SpaceStatus::Running => {
                return Err(AppError::Invalid(
                    "the agent is still working in this space".into(),
                ));
            }
            SpaceStatus::Archived => {
                return Err(AppError::Invalid("this space is archived".into()));
            }
            SpaceStatus::Idle | SpaceStatus::Failed => {}
        }
        let text = req.text.trim().to_string();
        if text.is_empty() {
            return Err(AppError::Invalid("empty message".into()));
        }
        let project = self.space_project(&space).await?;
        self.check_space_budget(&space, &project).await?;

        let agent = req.agent.unwrap_or(space.agent);
        let model = req.model.clone().or_else(|| space.model.clone());
        let mode = req.mode.unwrap_or(space.mode);

        // A worktree removed by hand comes back from the checkpoint ref.
        let repo_path = self.ensure_project_cache(&project).await?;
        let wt = self
            .0
            .deps
            .git
            .space_worktree(&repo_path, &space.id, &space.base_sha)
            .await?;

        let history = self.space_history(&space.id).await?;
        let key = space_chat_key(&space.id);
        let message_id = uuid::Uuid::new_v4().to_string();
        let now = self.0.deps.clock.now();
        let message = ChatMessage {
            id: message_id.clone(),
            pr: key.clone(),
            author: Author::Me,
            text: text.clone(),
            refs: vec![],
            usage: None,
            at: now,
            failed: None,
        };
        let run_id = format!("space:{}:{message_id}", space.id);
        self.apply(vec![
            NewAction {
                model: models::CHAT_MESSAGE.into(),
                model_id: message_id.clone(),
                action: SyncActionCode::I,
                data: Some(to_json(&message)?),
            },
            NewAction {
                model: models::SPACE.into(),
                model_id: space.id.clone(),
                action: SyncActionCode::C,
                data: Some(serde_json::json!({
                    "status": SpaceStatus::Running,
                    "run": run_id,
                    "agent": agent,
                    "model": model,
                    "mode": mode,
                    "error": null,
                    "updated_at": now,
                })),
            },
        ])
        .await?;

        let cancel = CancellationToken::new();
        self.0.runs.write().await.insert(
            run_id.clone(),
            RunHandle {
                cancel: cancel.clone(),
            },
        );
        let turn = Turn {
            run_id,
            space: space.clone(),
            agent,
            model,
            mode,
            prompt: turn_prompt(&history, &text),
            system: system_prompt(&space),
            cwd: wt.path,
            cancel,
        };
        let core = self.clone();
        tokio::spawn(async move { drive_turn(&core, turn).await });
        Ok(message_id)
    }

    /// Cancels the turn in flight; its edits are still checkpointed.
    pub async fn space_stop(&self, space: &str) -> AppResult<()> {
        let space = self.space_row(space).await?;
        if let Some(run) = &space.run
            && let Some(handle) = self.0.runs.write().await.remove(run)
        {
            handle.cancel.cancel();
        }
        Ok(())
    }

    /// Opens (or refreshes, after a new checkpoint) the branch review of
    /// `base_sha...checkpoint`; `group` also groups it by meaning.
    pub async fn space_review(&self, req: SpaceReviewRequest) -> AppResult<OpenPrResponse> {
        let space = self.space_row(&req.space).await?;
        let response = {
            let _guard = self.0.open_lock.lock().await;
            self.open_space_review(&space, req.group).await?
        };
        let pr_id = response.pr.clone();
        if space.review_pr.as_ref() != Some(&pr_id) {
            self.apply(vec![NewAction {
                model: models::SPACE.into(),
                model_id: space.id.clone(),
                action: SyncActionCode::C,
                data: Some(serde_json::json!({ "review_pr": pr_id })),
            }])
            .await?;
        }
        Ok(response)
    }

    /// Checkpoints uncommitted edits, removes the worktree and the review;
    /// the checkpoint ref and the transcript stay.
    pub async fn archive_space(&self, space: &str) -> AppResult<()> {
        let space = self.space_row(space).await?;
        if space.status == SpaceStatus::Running {
            return Err(AppError::Invalid(
                "stop the agent before archiving this space".into(),
            ));
        }
        if space.status == SpaceStatus::Archived {
            return Ok(());
        }
        let project = self.space_project(&space).await?;
        let repo_path = self.ensure_project_cache(&project).await?;
        if Path::new(&space.worktree).exists() {
            self.0
                .deps
                .git
                .space_checkpoint(
                    Path::new(&space.worktree),
                    &space.id,
                    &format!("{}: uncommitted changes at archive", space.name),
                )
                .await?;
        }
        self.0
            .deps
            .git
            .remove_space_worktree(&repo_path, &space.id)
            .await?;
        if let Some(review) = &space.review_pr {
            // Best-effort: a review that was never stored is already gone.
            let _ = self.close_branch_review(review).await;
        }
        self.apply(vec![NewAction {
            model: models::SPACE.into(),
            model_id: space.id.clone(),
            action: SyncActionCode::C,
            data: Some(serde_json::json!({
                "status": SpaceStatus::Archived,
                "review_pr": null,
                "updated_at": self.0.deps.clock.now(),
            })),
        }])
        .await?;
        Ok(())
    }

    /// Turns left `running` by a previous process can never finish
    /// (docs/spaces.md §7 "Crash recovery"). Their worktree keeps whatever
    /// the agent wrote; the next turn or archive checkpoints it.
    pub(crate) async fn fail_interrupted_spaces(&self) {
        let Ok(spaces) = self.list_spaces(None).await else {
            return;
        };
        let actions: Vec<NewAction> = spaces
            .into_iter()
            .filter(|s| s.status == SpaceStatus::Running)
            .map(|s| NewAction {
                model: models::SPACE.into(),
                model_id: s.id,
                action: SyncActionCode::C,
                data: Some(serde_json::json!({
                    "status": SpaceStatus::Failed,
                    "run": null,
                    "error": "interrupted: Theodore was closed",
                })),
            })
            .collect();
        let _ = self.apply(actions).await;
    }

    /// Reopens a space's branch review by its id (`ensure_open` after a
    /// restart, which already holds `open_lock`): the space knows its fork
    /// point and display names.
    pub(crate) async fn reopen_space_review(&self, pr: &PrId) -> AppResult<()> {
        let space = self
            .list_spaces(None)
            .await?
            .into_iter()
            .find(|s| s.review_pr.as_ref() == Some(pr))
            .ok_or_else(|| AppError::NotFound(format!("space of {pr}")))?;
        self.open_space_review(&space, true).await.map(|_| ())
    }

    /// The review of `base_sha...refs/theodore/spaces/<id>`. Caller holds
    /// `open_lock`.
    async fn open_space_review(&self, space: &Space, group: bool) -> AppResult<OpenPrResponse> {
        let project = self.space_project(space).await?;
        let repo_path = self.ensure_project_cache(&project).await?;
        let refname = space_ref(&space.id);
        let pr_ref = PrRef {
            repo: project.repo.clone(),
            number: stable_hash_u32(&refname) as u64,
            host_id: Some(refname.clone()),
        };
        let (mut detail, revision) = self
            .0
            .deps
            .git
            .describe_branch(
                &repo_path,
                &project.repo,
                pr_ref.number,
                &refname,
                space.base_sha.as_str(),
            )
            .await?;
        detail.summary.title = space.name.clone();
        detail.summary.head_ref = space.branch.clone();
        detail.summary.base_ref = space.base.clone();
        let head = detail.summary.head_sha.clone();
        let worktree = self.0.deps.git.worktree(&pr_ref, &head).await?;
        self.finish_open_with(pr_ref, detail, revision, repo_path, worktree.path, group)
            .await
    }

    pub(crate) async fn space_row(&self, id: &str) -> AppResult<Space> {
        let data = self
            .get_row(models::SPACE, id)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("space {id}")))?;
        serde_json::from_value(data).map_err(|e| AppError::Invalid(e.to_string()))
    }

    async fn space_project(&self, space: &Space) -> AppResult<Project> {
        self.project_row(&space.project)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("project {}", space.project)))
    }

    /// `budget.per_space_usd` (docs/spaces.md §12: its own budget, apart
    /// from the PR review runs' `budget.per_pr_usd`) against the space's
    /// summed turn usage.
    async fn check_space_budget(&self, space: &Space, project: &Project) -> AppResult<()> {
        let scope = project.repo.slug();
        let budget = self
            .setting_f64_scoped(SPACE_BUDGET_KEY, Some(&scope))
            .await;
        if let Some(budget) = budget
            && space.usage.usd >= budget
        {
            let text = format!(
                "space budget of ${budget:.2} reached (spent ${:.2})",
                space.usage.usd
            );
            self.emit(Ephemeral::Toast {
                level: ToastLevel::Error,
                text: text.clone(),
            });
            return Err(AppError::Invalid(text));
        }
        Ok(())
    }

    /// The transcript so far, oldest first, without failed placeholders.
    async fn space_history(&self, space: &str) -> AppResult<Vec<ChatMessage>> {
        let store = self.0.deps.store.clone();
        let key = space_chat_key(space).0;
        let rows =
            tokio::task::spawn_blocking(move || store.query(models::CHAT_MESSAGE, "pr", &key))
                .await
                .map_err(AppError::join)??;
        let mut messages: Vec<ChatMessage> = rows
            .into_iter()
            .filter_map(|r| serde_json::from_value(r.data).ok())
            .filter(|m: &ChatMessage| m.failed.is_none())
            .collect();
        messages.sort_by_key(|m| m.at);
        Ok(messages)
    }
}

struct Turn {
    run_id: String,
    space: Space,
    agent: AgentId,
    model: Option<String>,
    mode: SpaceMode,
    prompt: String,
    system: String,
    cwd: PathBuf,
    cancel: CancellationToken,
}

async fn drive_turn(core: &Core, turn: Turn) {
    let Turn {
        run_id,
        space,
        agent,
        model,
        mode,
        prompt,
        system,
        cwd,
        cancel,
    } = turn;
    let req = AgentRequest {
        agent,
        prompt,
        system: Some(system),
        cwd: cwd.clone(),
        mode: match mode {
            SpaceMode::Ask => AgentMode::ReadOnly,
            SpaceMode::Edit => AgentMode::Edit,
            SpaceMode::Run => AgentMode::Run,
        },
        mcp: None,
        model,
        stall_after_ms: core.stall_after_ms().await,
    };
    let mut text = String::new();
    let mut usage = Usage::default();
    let mut error = None;
    match core.0.deps.agents.run(req).await {
        Ok(mut run) => loop {
            tokio::select! {
                _ = cancel.cancelled() => { run.cancel.cancel(); break; }
                event = run.events.recv() => {
                    let Some(event) = event else { break };
                    match event {
                        AgentEvent::Text { text: t } => {
                            text.push_str(&t);
                            core.emit(Ephemeral::AgentDelta { run: run_id.clone(), agent, text: t });
                        }
                        AgentEvent::ToolCall { name, .. } => {
                            core.emit(Ephemeral::RunLog { run: run_id.clone(), agent, line: format!("tool: {name}") });
                        }
                        AgentEvent::Usage { usage: u } => usage += u,
                        AgentEvent::Stalled => {
                            core.emit(Ephemeral::RunStalled { run: run_id.clone(), agent });
                        }
                        AgentEvent::Done { final_text, usage: u } => {
                            if !final_text.is_empty() {
                                text = final_text;
                            }
                            usage += u;
                            break;
                        }
                        AgentEvent::Error { message, .. } => {
                            error = Some(message);
                            break;
                        }
                        AgentEvent::Thinking { .. } | AgentEvent::ToolResult { .. } => {}
                    }
                }
            }
        },
        Err(e) => error = Some(e.to_string()),
    }
    core.0.runs.write().await.remove(&run_id);
    let cancelled = cancel.is_cancelled();
    if cancelled && error.is_none() {
        error = Some("stopped".into());
    }

    // Whatever the agent wrote is kept, even on a failed or stopped turn.
    let turn_no = space.turns + 1;
    let suffix = if cancelled {
        " (stopped)"
    } else if error.is_some() {
        " (failed)"
    } else {
        ""
    };
    let checkpoint = core
        .0
        .deps
        .git
        .space_checkpoint(
            &cwd,
            &space.id,
            &format!("{}: turn {turn_no}{suffix}", space.name),
        )
        .await;
    let head = match checkpoint {
        Ok(head) => Some(head),
        Err(e) => {
            error.get_or_insert_with(|| format!("checkpoint failed: {e}"));
            None
        }
    };

    let key = space_chat_key(&space.id);
    let reply = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        pr: key,
        author: Author::Agent(agent),
        text: if error.is_some() { String::new() } else { text },
        refs: vec![],
        usage: Some(usage),
        at: core.0.deps.clock.now(),
        failed: error.clone(),
    };
    let mut total = space.usage;
    total += usage;
    let mut patch = serde_json::json!({
        "status": if error.is_some() && !cancelled { SpaceStatus::Failed } else { SpaceStatus::Idle },
        "run": null,
        "turns": turn_no,
        "usage": total,
        "error": if cancelled { None } else { error.clone() },
        "updated_at": core.0.deps.clock.now(),
    });
    if let Some(head) = &head {
        patch["head_sha"] = serde_json::json!(head);
    }
    let mut actions = Vec::new();
    if let Ok(data) = serde_json::to_value(&reply) {
        actions.push(NewAction {
            model: models::CHAT_MESSAGE.into(),
            model_id: reply.id.clone(),
            action: SyncActionCode::I,
            data: Some(data),
        });
    }
    actions.push(NewAction {
        model: models::SPACE.into(),
        model_id: space.id.clone(),
        action: SyncActionCode::C,
        data: Some(patch),
    });
    let _ = core.apply(actions).await;

    if head.is_some_and(|h| h != space.head_sha) {
        // The live diff follows the new checkpoint; grouping waits for Review.
        if let Err(e) = core
            .space_review(SpaceReviewRequest {
                space: space.id.clone(),
                group: false,
            })
            .await
        {
            core.emit(Ephemeral::Toast {
                level: ToastLevel::Warn,
                text: format!("{}: diff refresh failed: {e}", space.name),
            });
        }
    }
}

fn to_json<T: serde::Serialize>(v: &T) -> AppResult<serde_json::Value> {
    serde_json::to_value(v).map_err(|e| AppError::Invalid(e.to_string()))
}

/// 12 hex chars: short enough for a path, unique enough per machine.
fn new_space_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

/// `true` for a space review's `PrRef::host_id`.
pub(crate) fn is_space_ref(host_id: &str) -> bool {
    host_id.starts_with(SPACE_REF_PREFIX)
}

/// The first few words of `text`, lowercased and dash-joined:
/// "Retry the export on 429s!" → "retry-the-export-on-429s".
pub(crate) fn slug(text: &str) -> String {
    let words: Vec<String> = text
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .take(5)
        .map(|w| w.to_ascii_lowercase())
        .collect();
    let s = words.join("-");
    let s: String = s.chars().take(40).collect();
    let s = s.trim_end_matches('-').to_string();
    if s.is_empty() { "space".into() } else { s }
}

/// A conservative subset of `git check-ref-format --branch`.
pub(crate) fn is_valid_branch(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.starts_with(['-', '/', '.'])
        && !name.ends_with(['/', '.'])
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("//")
        && !name.contains("@{")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'))
}

fn system_prompt(space: &Space) -> String {
    format!(
        "You are working in a Theodore space: an isolated git worktree for one change.\n\
         Goal: {goal}\n\
         Base branch: {base}. The change will be shipped as branch {branch}.\n\
         Rules: work only inside the current directory. Do not push, do not switch or \
         create branches, do not rewrite history. Theodore commits your edits after every \
         turn, so you don't need to. End each turn with a short summary of what you changed \
         and anything left to do.",
        goal = if space.goal.is_empty() {
            &space.name
        } else {
            &space.goal
        },
        base = space.base,
        branch = space.branch,
    )
}

/// The new message, preceded by the recent transcript (each CLI run starts
/// fresh, so this is what carries the conversation across turns, crashes
/// and agent switches).
fn turn_prompt(history: &[ChatMessage], text: &str) -> String {
    let recent = &history[history.len().saturating_sub(HISTORY_MESSAGES)..];
    if recent.is_empty() {
        return text.to_string();
    }
    let mut out = String::from("Conversation so far:\n");
    for m in recent {
        let who = match m.author {
            Author::Me => "user".to_string(),
            Author::Agent(a) => a.as_str().to_string(),
        };
        let body: String = m.text.chars().take(HISTORY_CHARS).collect();
        out.push_str(&format!("\n[{who}]\n{body}\n"));
    }
    out.push_str(&format!("\n---\n\nNew message from the user:\n{text}"));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_takes_the_first_words() {
        assert_eq!(
            slug("Retry the export job on 429s with backoff"),
            "retry-the-export-job-on"
        );
        assert_eq!(slug("  Fix: login/redirect!! "), "fix-login-redirect");
        assert_eq!(slug("¿?"), "space");
    }

    #[test]
    fn branch_names_are_checked() {
        for ok in ["theo/fix-login", "feature/a.b_c", "x"] {
            assert!(is_valid_branch(ok), "{ok}");
        }
        for bad in [
            "", "-x", "/x", "x/", "a..b", "a//b", "a.lock", "a b", "a@{1}", "a~1",
        ] {
            assert!(!is_valid_branch(bad), "{bad:?}");
        }
    }

    #[test]
    fn space_refs_are_recognised() {
        assert!(is_space_ref(&space_ref("abc")));
        assert!(!is_space_ref("feature/x"));
    }

    fn msg(author: Author, text: &str, at: i64) -> ChatMessage {
        ChatMessage {
            id: at.to_string(),
            pr: space_chat_key("s"),
            author,
            text: text.into(),
            refs: vec![],
            usage: None,
            at,
            failed: None,
        }
    }

    #[test]
    fn the_first_turn_is_just_the_message() {
        assert_eq!(turn_prompt(&[], "do it"), "do it");
    }

    #[test]
    fn later_turns_replay_the_recent_transcript() {
        let history: Vec<_> = (0..20)
            .map(|i| msg(Author::Me, &format!("m{i}"), i))
            .chain([msg(Author::Agent(AgentId::Codex), "done", 99)])
            .collect();
        let p = turn_prompt(&history, "next");
        assert!(p.starts_with("Conversation so far:"));
        assert!(!p.contains("[user]\nm8\n"), "older messages are dropped");
        assert!(p.contains("[user]\nm19"));
        assert!(p.contains("[codex]\ndone"));
        assert!(p.ends_with("New message from the user:\nnext"));
    }
}
