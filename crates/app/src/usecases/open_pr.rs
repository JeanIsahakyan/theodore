//! `open_pr` (plan §2.1): parse the URL, fetch the PR and its diff, cache
//! the revision, store the rows, and group it in the background.

use std::path::PathBuf;
use std::sync::Arc;

use theodore_contract::{Ephemeral, OpenPrRequest, OpenPrResponse, ToastLevel, models};
use theodore_domain::{AgentId, HostKind, PrDetail, PrId, PrRef, PrSummary, RepoRef, Revision};
use theodore_ports::{DiffOptions, Fetched, NewAction, SyncActionCode};

use crate::core::{Core, RevisionEntry};
use crate::error::{AppError, AppResult};

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
        if pr.0.starts_with("local:") {
            return self.ensure_open_local(pr).await;
        }
        let pr_ref = pr_ref_from_id(pr)?;
        self.open_ref(pr_ref).await.map(|_| ())
    }

    async fn open_ref(&self, pr_ref: PrRef) -> AppResult<OpenPrResponse> {
        let fetched = self.0.deps.host.get_pr(&pr_ref, None).await?;
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
        let pr_id = pr_ref.id();
        let head = detail.summary.head_sha.clone();

        self.load_repo_settings(&worktree_path, &pr_ref.repo).await;

        {
            self.0
                .current_head
                .write()
                .await
                .insert(pr_id.clone(), head.clone());
        }
        {
            self.0.revisions.write().await.insert(
                (pr_id.clone(), head.clone()),
                Arc::new(RevisionEntry {
                    revision: Arc::new(revision.clone()),
                    repo_path,
                    worktree_path: worktree_path.clone(),
                    pr_ref: pr_ref.clone(),
                }),
            );
        }

        self.apply_pr_detail(&detail).await?;
        self.refresh_stacks().await?;

        // Group in the background; the UI gets it as a `grouping` sync row.
        self.spawn_grouping(pr_id.clone(), head.clone(), revision, detail, worktree_path);

        Ok(OpenPrResponse { pr: pr_id, head })
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
        worktree: std::path::PathBuf,
    ) {
        let core = self.clone();
        tokio::spawn(async move {
            let store = core.0.deps.store.clone();
            let id = pr.0.clone();
            let stored = tokio::task::spawn_blocking(move || store.get(models::GROUPING, &id))
                .await
                .ok()
                .and_then(|r| r.ok())
                .flatten()
                .and_then(|r| {
                    let algo = theodore_domain::grouping::row_algo(&r.data);
                    serde_json::from_value::<theodore_domain::Grouping>(r.data)
                        .ok()
                        .map(|g| (g, algo))
                });
            // Reuse a grouping of this head, unless an older algorithm made it.
            if stored.is_some_and(|(g, algo)| {
                g.rev == head && algo >= theodore_domain::grouping::ALGO_VERSION
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
            let result = core
                .0
                .deps
                .grouper
                .group(&revision, &detail, &worktree, agent)
                .await;
            let error = match result {
                Ok(grouping) => match theodore_domain::grouping::to_row(&grouping) {
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
                },
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
        });
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
