//! `open_pr` (plan §2.1): parse the URL, fetch the PR and its diff, cache
//! the revision, store the rows, and group it in the background.

use std::path::PathBuf;
use std::sync::Arc;

use theodore_contract::{Ephemeral, OpenPrRequest, OpenPrResponse, ToastLevel, models};
use theodore_domain::{AgentId, HostKind, PrDetail, PrId, PrRef, PrSummary, RepoRef, Revision};
use theodore_ports::{DiffOptions, Fetched, NewAction, SyncActionCode};
use tracing::Instrument as _;

use crate::core::{Core, RevisionEntry};
use crate::error::{AppError, AppResult};
use crate::usecases::review_config::ConfigBase;

impl Core {
    pub async fn open_pr(&self, req: OpenPrRequest) -> AppResult<OpenPrResponse> {
        let pr_ref = parse_pr_ref(&req.url)?;
        let _guard = self.0.open_lock.lock().await;
        let id = pr_ref.id();
        if let Some(head) = self.0.current_head.read().await.get(&id).cloned() {
            return Ok(OpenPrResponse { pr: id, head });
        }
        self.open_ref(pr_ref).await
    }

    /// Open `pr` if this session hasn't yet (a PR opened from the inbox or a
    /// restored tab arrives by id, not by URL). A `local:` id has no host
    /// behind it, so it's recovered from its stored `pr` row instead of
    /// being reparsed (plan "projects").
    pub async fn ensure_open(&self, pr: &PrId) -> AppResult<()> {
        if self.0.current_head.read().await.contains_key(pr) {
            return Ok(());
        }
        let _guard = self.0.open_lock.lock().await;
        if self.0.current_head.read().await.contains_key(pr) {
            return Ok(());
        }
        if pr.0.starts_with("local:") || self.is_branch_review(pr).await {
            return self.ensure_open_local(pr).await;
        }
        let pr_ref = pr_ref_from_id(pr)?;
        self.open_ref(pr_ref).await.map(|_| ())
    }

    /// A "Review branch" of a host project keeps its host in the id
    /// (`github:owner/repo#<branch hash>`) but has no PR on the host: its
    /// stored row carries the branch and no host URL. Reopening it must go
    /// through the local path, not the host (which answers 404).
    pub(crate) async fn is_branch_review(&self, pr: &PrId) -> bool {
        let Ok(Some(row)) = self.get_row(models::PR, &pr.0).await else {
            return false;
        };
        let url_empty = row
            .get("url")
            .and_then(|v| v.as_str())
            .is_none_or(str::is_empty);
        let branch = row
            .get("pr")
            .and_then(|p| p.get("host_id"))
            .and_then(|v| v.as_str())
            .is_some();
        url_empty && branch
    }

    async fn open_ref(&self, pr_ref: PrRef) -> AppResult<OpenPrResponse> {
        let fetched = self.0.deps.host.get_pr(&pr_ref, None).await;
        self.note_host(&fetched);
        let fetched = match fetched {
            Ok(f) => f,
            Err(e) if Self::is_connection_error(&e) => {
                return self.open_offline(&pr_ref, e).await;
            }
            Err(e) => return Err(e.into()),
        };
        let detail = match fetched {
            Fetched::Modified { value, .. } => value,
            Fetched::NotModified => {
                return Err(AppError::Invalid(
                    "host returned not-modified on a fresh fetch".into(),
                ));
            }
        };
        // The adapter fills in `host_id` and canonical owner/repo casing.
        let pr_ref = detail.summary.pr.clone();

        let repo_path = self.0.deps.git.ensure_repo(&pr_ref.repo).await?;
        let head = self.0.deps.git.fetch_pr(&pr_ref).await?;
        let worktree = self.0.deps.git.worktree(&pr_ref, &head).await?;
        let revision = self
            .0
            .deps
            .git
            .diff(&repo_path, &detail.base_sha, &head, &DiffOptions::default())
            .await?;

        self.finish_open(pr_ref, detail, revision, repo_path, worktree.path)
            .await
    }

    /// Opens a host PR from what an earlier open left behind, when the
    /// host can't be reached (offline, token rejected, rate-limited): the
    /// stored `pr_detail` and the commits already in the clone. No fetch,
    /// no host call; the poller refreshes it once the host answers again
    /// (a moved head goes through its push pipeline as usual).
    ///
    /// ```text
    /// get_pr ✗ (connection) ─▶ stored pr_detail? ─▶ clone has base+head? ─▶ worktree ─▶ diff ─▶ finish
    ///                               └─no──────────────────┴─no─▶ offline_not_cached (or the host error)
    /// ```
    async fn open_offline(
        &self,
        pr_ref: &PrRef,
        cause: theodore_ports::HostError,
    ) -> AppResult<OpenPrResponse> {
        let Some((detail, repo_path)) = self.local_copy(&pr_ref.id()).await? else {
            // A token or rate-limit problem is better said as is: the
            // banner names it, and "offline" would be wrong.
            return Err(match cause {
                theodore_ports::HostError::Network(_) => AppError::OfflineNotCached,
                other => other.into(),
            });
        };
        let pr_ref = detail.summary.pr.clone();
        let head = detail.summary.head_sha.clone();
        let worktree = self.0.deps.git.worktree(&pr_ref, &head).await?;
        let revision = self
            .0
            .deps
            .git
            .diff(&repo_path, &detail.base_sha, &head, &DiffOptions::default())
            .await?;
        tracing::info!(pr = %pr_ref.id().0, error.code = cause.code(), "pr opened from the local copy");
        // The stored rows are what this came from: writing them back would
        // only roll a newer inbox summary back to the detail's.
        self.finish_open_full(
            pr_ref,
            detail,
            revision,
            repo_path,
            worktree.path,
            true,
            false,
        )
        .await
    }

    /// The stored detail of `pr` and the clone, when its base and head
    /// commits are both already downloaded. Reads nothing off the network.
    async fn local_copy(&self, pr: &PrId) -> AppResult<Option<(PrDetail, PathBuf)>> {
        let detail = match self.load_pr_detail(pr).await {
            Ok(d) => d,
            Err(AppError::NotFound(_)) => return Ok(None),
            Err(e) => return Err(e),
        };
        let shas = [&detail.base_sha, &detail.summary.head_sha];
        let repo = &detail.summary.pr.repo;
        Ok(self
            .cached_repo_with(repo, &shas)
            .await
            .map(|path| (detail, path)))
    }

    /// The clone of `repo` if it's on disk and holds every commit in
    /// `shas`, `None` otherwise. No network.
    pub(crate) async fn cached_repo_with(
        &self,
        repo: &RepoRef,
        shas: &[&theodore_domain::Sha],
    ) -> Option<PathBuf> {
        let git = &self.0.deps.git;
        let path = git.cached_repo(repo).await.ok().flatten()?;
        for sha in shas {
            if !git.has_commit(&path, sha).await.unwrap_or(false) {
                return None;
            }
        }
        Some(path)
    }

    /// Caches the revision, writes the `pr`/`pr_detail` rows and kicks off
    /// grouping. Shared tail of `open_ref` (host PRs) and `open_local`
    /// (plan "projects" branch reviews) — everything up to here differs by
    /// where the detail and diff came from.
    pub(crate) async fn finish_open(
        &self,
        pr_ref: PrRef,
        detail: PrDetail,
        revision: Revision,
        repo_path: PathBuf,
        worktree_path: PathBuf,
    ) -> AppResult<OpenPrResponse> {
        self.finish_open_with(pr_ref, detail, revision, repo_path, worktree_path, true)
            .await
    }

    /// `finish_open`, with grouping optional: a space's live diff refreshes
    /// after every agent turn and is only grouped when it's reviewed.
    pub(crate) async fn finish_open_with(
        &self,
        pr_ref: PrRef,
        detail: PrDetail,
        revision: Revision,
        repo_path: PathBuf,
        worktree_path: PathBuf,
        group: bool,
    ) -> AppResult<OpenPrResponse> {
        self.finish_open_full(
            pr_ref,
            detail,
            revision,
            repo_path,
            worktree_path,
            group,
            true,
        )
        .await
    }

    /// `finish_open_with`, with writing the `pr`/`pr_detail` rows optional:
    /// an offline open (`open_offline`) read them from the store.
    #[allow(clippy::too_many_arguments)]
    async fn finish_open_full(
        &self,
        pr_ref: PrRef,
        detail: PrDetail,
        revision: Revision,
        repo_path: PathBuf,
        worktree_path: PathBuf,
        group: bool,
        write_rows: bool,
    ) -> AppResult<OpenPrResponse> {
        let pr_id = pr_ref.id();
        let head = detail.summary.head_sha.clone();

        let entry = Arc::new(RevisionEntry {
            revision: Arc::new(revision.clone()),
            repo_path,
            worktree_path,
            base: ConfigBase::of(&pr_ref, &detail),
            pr_ref: pr_ref.clone(),
        });
        self.load_repo_settings(entry.config_source()).await;

        {
            self.0
                .current_head
                .write()
                .await
                .insert(pr_id.clone(), head.clone());
        }
        {
            self.0
                .revisions
                .write()
                .await
                .insert((pr_id.clone(), head.clone()), entry.clone());
        }

        if write_rows {
            self.apply_pr_detail(&detail).await?;
            self.refresh_stacks().await?;
        }

        // Group in the background; the UI gets it as a `grouping` sync row.
        if group {
            let auto = AutoSkills {
                pr: pr_id.clone(),
                head: head.clone(),
                state: detail.summary.state,
                entry: entry.clone(),
            };
            let host = serde_json::to_value(pr_ref.repo.host)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default();
            tracing::info!(pr = %pr_id.0, files = revision.files.len(), "pr opened");
            theodore_telemetry::product(theodore_telemetry::ProductEvent::PrOpened { host });
            self.spawn_grouping(pr_id.clone(), head.clone(), revision, detail, entry);
            tokio::spawn(self.run_auto_skills(auto).in_current_span());
        }

        Ok(OpenPrResponse { pr: pr_id, head })
    }
}

/// What `run_auto_skills` needs about a PR just opened.
pub(crate) struct AutoSkills {
    pub pr: PrId,
    pub head: theodore_domain::Sha,
    pub state: theodore_domain::PrState,
    pub entry: Arc<RevisionEntry>,
}

impl Core {
    /// `review.auto_skills` (docs/config.md §1): each skill runs once, the
    /// first time a PR is opened at a head, through the normal skill run.
    /// Not for a merged or closed PR, and not when switched off
    /// (`set_auto_skills`).
    ///
    /// ```text
    /// open ─▶ open/draft? ─▶ kv auto_skills:<pr> == head? ─no─▶ store head ─▶ run_skill × n
    ///              └─no─▶ skip          └─yes─▶ skip (already ran at this head)
    /// ```
    ///
    /// Boxed: `run_skill` may open the PR, which spawns this again; the
    /// named `Send` future breaks that cycle for the compiler.
    pub(crate) fn run_auto_skills(
        &self,
        auto: AutoSkills,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'static>> {
        let core = self.clone();
        Box::pin(async move { core.auto_skills_now(auto).await })
    }

    async fn auto_skills_now(&self, auto: AutoSkills) {
        use theodore_domain::PrState;
        if !self.auto_skills_enabled() || !matches!(auto.state, PrState::Open | PrState::Draft) {
            return;
        }
        let skills = self.auto_skills_of(auto.entry.config_source()).await;
        if skills.is_empty() {
            return;
        }
        let key = format!("auto_skills:{}", auto.pr.0);
        let head = serde_json::json!(auto.head.as_str());
        {
            // Two opens of one head never both start the skills.
            let _guard = self.0.review_lock.lock().await;
            let store = self.0.deps.store.clone();
            let k = key.clone();
            let ran = tokio::task::spawn_blocking(move || store.kv_get(&k))
                .await
                .ok()
                .and_then(|r| r.ok())
                .flatten();
            if ran.as_ref() == Some(&head) {
                return;
            }
            let store = self.0.deps.store.clone();
            let _ = tokio::task::spawn_blocking(move || store.kv_set(&key, &head)).await;
        }
        for skill in skills {
            let req = theodore_contract::RunSkillRequest {
                pr: auto.pr.clone(),
                skill: skill.clone(),
                agents: vec![],
            };
            if let Err(e) = self.run_skill(req).await {
                self.emit(Ephemeral::Toast {
                    level: ToastLevel::Warn,
                    text: format!("auto skill {skill} didn't start: {e}"),
                });
            }
        }
    }
}

impl Core {
    /// Recomputes the PR-chain ("stack") indicator across every stored PR
    /// row (plan "Stack"): cheap — no extra host call, since same-repo PRs
    /// are already in the store from an inbox refresh or an open. Only
    /// patches the rows whose computed `StackInfo` actually changed.
    /// Called after every write that can add or remove a same-repo PR row
    /// (`open_pr`/`ensure_open`'s `finish_open`, `refresh_inbox`).
    pub(crate) async fn refresh_stacks(&self) -> AppResult<()> {
        let store = self.0.deps.store.clone();
        let rows = tokio::task::spawn_blocking(move || store.all(models::PR))
            .await
            .map_err(AppError::join)??;

        let mut summaries = Vec::with_capacity(rows.len());
        for row in rows {
            if let Ok(summary) = serde_json::from_value::<PrSummary>(row.data) {
                summaries.push((row.id, summary));
            }
        }
        let all: Vec<PrSummary> = summaries.iter().map(|(_, s)| s.clone()).collect();
        let computed = theodore_domain::stack::compute_stacks(&all);

        let actions: Vec<NewAction> = summaries
            .iter()
            .filter_map(|(id, summary)| {
                let next = computed.get(&summary.pr.id()).cloned();
                if next == summary.stack {
                    return None;
                }
                Some(NewAction {
                    model: models::PR.into(),
                    model_id: id.clone(),
                    action: SyncActionCode::C,
                    data: Some(serde_json::json!({ "stack": next })),
                })
            })
            .collect();

        self.apply(actions).await?;
        Ok(())
    }
}

impl Core {
    /// Group `revision` unless a grouping for this head is stored or one is
    /// already running. Emits `Ephemeral::Grouping` around the run.
    pub(crate) fn spawn_grouping(
        &self,
        pr: PrId,
        head: theodore_domain::Sha,
        revision: theodore_domain::Revision,
        detail: theodore_domain::PrDetail,
        entry: Arc<RevisionEntry>,
    ) {
        let core = self.clone();
        tokio::spawn(
            async move {
                let worktree = entry.worktree_path.clone();
                let store = core.0.deps.store.clone();
                let id = pr.0.clone();
                let stored = tokio::task::spawn_blocking(move || store.get(models::GROUPING, &id))
                    .await
                    .ok()
                    .and_then(|r| r.ok())
                    .flatten();
                let rules = core.review_rules_at(entry.config_source()).await;
                // Reuse a grouping of this head, unless an older algorithm or
                // other review rules (`hide`, `skim`, `checklist`) made it.
                if stored.is_some_and(|r| {
                    crate::usecases::grouping::row_is_current(
                        &r.data,
                        &head,
                        rules.grouping_hash().as_deref(),
                    )
                }) {
                    return;
                }
                {
                    let mut inflight = core
                        .0
                        .grouping_inflight
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    if !inflight.insert(pr.clone()) {
                        return;
                    }
                }
                core.emit(Ephemeral::Grouping {
                    pr: pr.clone(),
                    running: true,
                    error: None,
                });
                let repo_scope = detail.summary.pr.repo.slug();
                let configured = core
                    .setting_agent_scoped("agents.grouping", Some(&repo_scope), AgentId::Claude)
                    .await;
                let agent = core.effective_agent(configured).await;
                let mut ctx = core.grouping_context(&worktree, &revision).await;
                ctx.review = rules;
                let started = std::time::Instant::now();
                let result = core
                    .0
                    .deps
                    .grouper
                    .group(
                        &revision,
                        &detail,
                        &ctx,
                        &worktree,
                        crate::deps::GroupingAgent {
                            id: agent,
                            // Grouping never uses the user's MCP servers: starting
                            // them on every chunk would only slow it down.
                            user_mcp: false,
                        },
                    )
                    .instrument(tracing::info_span!(
                        "grouping",
                        pr = %pr.0,
                        agent = agent.as_str(),
                        incremental = false
                    ))
                    .await;
                if let Err(e) = &result {
                    let code = e.code();
                    tracing::warn!(
                        error.code = code,
                        pr = %pr.0,
                        agent = agent.as_str(),
                        duration_ms = started.elapsed().as_millis() as u64,
                        error = %e,
                        "grouping failed"
                    );
                    theodore_telemetry::product(theodore_telemetry::ProductEvent::GroupingFailed {
                        code: code.to_string(),
                    });
                }
                // The PR may have been closed while the agent worked (a branch
                // review's "Close review"): don't write an orphaned grouping back.
                let still_open = core.0.current_head.read().await.contains_key(&pr);
                let error = match result {
                    Ok(_) if !still_open => None,
                    Ok(grouping) => {
                        match crate::usecases::grouping::grouping_row(grouping, &revision, &ctx) {
                            Ok(data) => core
                                .apply(vec![NewAction {
                                    model: models::GROUPING.into(),
                                    model_id: pr.0.clone(),
                                    action: SyncActionCode::U,
                                    data: Some(data),
                                }])
                                .await
                                .err()
                                .map(|e| e.to_string()),
                            Err(e) => Some(e.to_string()),
                        }
                    }
                    Err(e) => Some(e.to_string()),
                };
                core.0
                    .grouping_inflight
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&pr);
                if let Some(e) = &error {
                    core.emit(Ephemeral::Toast {
                        level: ToastLevel::Error,
                        text: format!("grouping failed: {e}"),
                    });
                }
                core.emit(Ephemeral::Grouping {
                    pr,
                    running: false,
                    error,
                });
            }
            .in_current_span(),
        );
    }
}

/// `https://github.com/{owner}/{repo}/pull/{n}` or the `{owner}/{repo}#{n}`
/// shorthand (both GitHub-only for now; plan §6.1 adds hosts later).
/// Inverse of `PrRef::id`: `github:owner/repo#12`, `gitlab:group/sub/proj#3`.
pub fn pr_ref_from_id(id: &PrId) -> AppResult<PrRef> {
    let bad = || AppError::Invalid(format!("bad pr id {id}"));
    let (host, rest) = id.0.split_once(':').ok_or_else(bad)?;
    let (slug, n) = rest.rsplit_once('#').ok_or_else(bad)?;
    let (owner, name) = slug.rsplit_once('/').ok_or_else(bad)?;
    let host = match host {
        "github" => HostKind::Github,
        "gitlab" => HostKind::Gitlab,
        "bitbucket" => HostKind::Bitbucket,
        "local" => HostKind::Local,
        _ => return Err(bad()),
    };
    Ok(PrRef {
        repo: RepoRef {
            host,
            owner: owner.into(),
            name: name.into(),
        },
        number: n.parse().map_err(|_| bad())?,
        host_id: None,
    })
}

pub fn parse_pr_ref(input: &str) -> AppResult<PrRef> {
    let input = input.trim();
    if let Ok(url) = url::Url::parse(input) {
        if url.host_str() == Some("github.com") {
            let segments: Vec<&str> = url.path_segments().map(|c| c.collect()).unwrap_or_default();
            if let [owner, repo, "pull", n, ..] = segments.as_slice() {
                let number: u64 = n
                    .parse()
                    .map_err(|_| AppError::Invalid(format!("bad PR number in {input}")))?;
                return Ok(PrRef {
                    repo: RepoRef {
                        host: HostKind::Github,
                        owner: owner.to_string(),
                        name: repo.trim_end_matches(".git").to_string(),
                    },
                    number,
                    host_id: None,
                });
            }
        }
        if url.host_str() == Some("gitlab.com") {
            // gitlab.com/<namespace…>/<project>/-/merge_requests/<iid>
            let segments: Vec<&str> = url.path_segments().map(|c| c.collect()).unwrap_or_default();
            if let Some(dash) = segments.iter().position(|s| *s == "-")
                && segments.get(dash + 1) == Some(&"merge_requests")
                && dash >= 2
                && let Some(n) = segments.get(dash + 2)
            {
                let number: u64 = n
                    .parse()
                    .map_err(|_| AppError::Invalid(format!("bad MR number in {input}")))?;
                return Ok(PrRef {
                    repo: RepoRef {
                        host: HostKind::Gitlab,
                        owner: segments[..dash - 1].join("/"),
                        name: segments[dash - 1].to_string(),
                    },
                    number,
                    host_id: None,
                });
            }
        }
        if url.host_str() == Some("bitbucket.org") {
            // bitbucket.org/<workspace>/<repo>/pull-requests/<n>
            let segments: Vec<&str> = url.path_segments().map(|c| c.collect()).unwrap_or_default();
            if let [workspace, repo, "pull-requests", n, ..] = segments.as_slice() {
                let number: u64 = n
                    .parse()
                    .map_err(|_| AppError::Invalid(format!("bad PR number in {input}")))?;
                return Ok(PrRef {
                    repo: RepoRef {
                        host: HostKind::Bitbucket,
                        owner: workspace.to_string(),
                        name: repo.to_string(),
                    },
                    number,
                    host_id: None,
                });
            }
        }
        return Err(AppError::Invalid(format!("unsupported PR url: {input}")));
    }
    if let Some((slug, num)) = input.rsplit_once('#')
        && let Some((owner, repo)) = slug.split_once('/')
    {
        let number: u64 = num
            .parse()
            .map_err(|_| AppError::Invalid(format!("bad PR number in {input}")))?;
        return Ok(PrRef {
            repo: RepoRef {
                host: HostKind::Github,
                owner: owner.to_string(),
                name: repo.to_string(),
            },
            number,
            host_id: None,
        });
    }
    Err(AppError::Invalid(format!(
        "cannot parse PR reference: {input}"
    )))
}

#[cfg(test)]
mod parse_tests {
    use super::*;

    #[test]
    fn parses_gitlab_merge_request_urls() {
        let pr = parse_pr_ref("https://gitlab.com/group/sub/project/-/merge_requests/42").unwrap();
        assert_eq!(pr.repo.host, HostKind::Gitlab);
        assert_eq!(pr.repo.owner, "group/sub");
        assert_eq!(pr.repo.name, "project");
        assert_eq!(pr.number, 42);
    }

    #[test]
    fn parses_bitbucket_pull_request_urls() {
        let pr = parse_pr_ref("https://bitbucket.org/acme/widgets/pull-requests/42").unwrap();
        assert_eq!(pr.repo.host, HostKind::Bitbucket);
        assert_eq!(pr.repo.owner, "acme");
        assert_eq!(pr.repo.name, "widgets");
        assert_eq!(pr.number, 42);
    }

    #[test]
    fn pr_ids_round_trip() {
        for url in [
            "https://github.com/o/r/pull/7",
            "https://gitlab.com/g/s/p/-/merge_requests/3",
            "https://bitbucket.org/ws/repo/pull-requests/9",
        ] {
            let pr = parse_pr_ref(url).unwrap();
            assert_eq!(pr_ref_from_id(&pr.id()).unwrap(), pr);
        }
    }

    #[test]
    fn parses_github_pull_urls() {
        let pr = parse_pr_ref("https://github.com/o/r/pull/7").unwrap();
        assert_eq!((pr.repo.host, pr.number), (HostKind::Github, 7));
    }
}
