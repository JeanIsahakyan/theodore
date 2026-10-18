//! `open_pr` (plan §2.1): parse the URL, fetch the PR and its diff, cache
//! the revision, store the rows, and group it in the background.

use std::sync::Arc;

use theodore_contract::{Ephemeral, OpenPrRequest, OpenPrResponse, ToastLevel, models};
use theodore_domain::{HostKind, PrRef, RepoRef};
use theodore_ports::{DiffOptions, Fetched, NewAction, SyncActionCode};

use crate::core::{Core, RevisionEntry};
use crate::error::{AppError, AppResult};

impl Core {
    pub async fn open_pr(&self, req: OpenPrRequest) -> AppResult<OpenPrResponse> {
        let pr_ref = parse_pr_ref(&req.url)?;

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
        let pr_id = pr_ref.id();

        let repo_path = self.0.deps.git.ensure_repo(&pr_ref.repo).await?;
        let head = self.0.deps.git.fetch_pr(&pr_ref).await?;
        let worktree = self.0.deps.git.worktree(&pr_ref, &head).await?;
        let revision = self
            .0
            .deps
            .git
            .diff(&repo_path, &detail.base_sha, &head, &DiffOptions::default())
            .await?;

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
                    worktree_path: worktree.path.clone(),
                    pr_ref: pr_ref.clone(),
                }),
            );
        }

        let pr_s = pr_id.0.clone();
        let summary_data =
            serde_json::to_value(&detail.summary).map_err(|e| AppError::Invalid(e.to_string()))?;
        let detail_data =
            serde_json::to_value(&detail).map_err(|e| AppError::Invalid(e.to_string()))?;
        let actions = vec![
            NewAction {
                model: models::PR.into(),
                model_id: pr_s.clone(),
                action: SyncActionCode::U,
                data: Some(summary_data),
            },
            NewAction {
                model: models::PR_DETAIL.into(),
                model_id: pr_s,
                action: SyncActionCode::U,
                data: Some(detail_data),
            },
        ];
        self.apply(actions).await?;

        // Group in the background; the UI gets it as a `grouping` sync row.
        let core = self.clone();
        let worktree_path = worktree.path.clone();
        tokio::spawn(async move {
            match core
                .0
                .deps
                .grouper
                .group(&revision, &detail, &worktree_path)
                .await
            {
                Ok(grouping) => {
                    if let Ok(data) = serde_json::to_value(&grouping) {
                        let action = NewAction {
                            model: models::GROUPING.into(),
                            model_id: pr_id.0.clone(),
                            action: SyncActionCode::I,
                            data: Some(data),
                        };
                        let _ = core.apply(vec![action]).await;
                    }
                }
                Err(e) => core.emit(Ephemeral::Toast {
                    level: ToastLevel::Error,
                    text: format!("grouping failed: {e}"),
                }),
            }
        });

        Ok(OpenPrResponse {
            pr: pr_ref.id(),
            head,
        })
    }
}

/// `https://github.com/{owner}/{repo}/pull/{n}` or the `{owner}/{repo}#{n}`
/// shorthand (both GitHub-only for now; plan §6.1 adds hosts later).
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
